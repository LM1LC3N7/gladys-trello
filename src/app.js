// -----------------------------------------------------------------------------
// The integration: the Trello boards followed (named in the configuration, or
// every open board, 10 at most) read every `poll_minutes`; the cards due and
// overdue on the dashboard and in the scenes; scene actions to create a card,
// move a card and read the cards due.
//
// When Trello is asked: one reading every `poll_minutes` (5 by default, 2 at
// least): the member and its boards once an hour (the credentials check),
// then one request per followed board (its open lists and cards). Never
// sooner: a restart waits for the rest of the interval (the time of the
// attempt is in /data BEFORE the reading), a reconnection to Gladys keeps the
// schedule. A scene action asks only what it needs (the board when it was not
// read, or read over a minute ago to match a card by name) and the write.
// One request in flight, 300 ms between two, 30 per 10 s at most (Trello
// allows 100 per token). A 429 pauses every request (Retry-After, 60 s to
// 6 h, kept in /data); a 5xx on the member too; a board that fails is read
// again after the interval doubled at each failure, 1 h at most, without
// stopping the others.
//
// The credentials: a 401 on /members/me whose text names the key or the token
// is a refusal, kept in /data as 8 bits of a salted hash; nothing is asked
// with them again until they change or the test button succeeds. A 401 on a
// board is that board not readable (never a refusal); when its text names the
// token, the member is read again at the next reading to decide.
//
// Clocks: gaps, budgets, back-offs, pauses and schedules run on the monotonic
// clock; the wall clock dates /data and decides when a card is due (its due
// date is an instant), shifted by the server clock when Trello's Date header
// is over a minute away from ours.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import {
  ACTION_FRESH,
  ACTION_HTTP_TIMEOUT,
  ACTION_QUEUE_WAIT,
  ANNOUNCED_KEEP,
  API_BASE,
  BOARD_BYTES,
  BOARD_QUERY,
  BOARD_RETRY_MAX,
  BUDGET_REQUESTS,
  BUDGET_WINDOW,
  CARD_BYTES,
  CARD_FIELDS,
  CARD_NAME_MAX,
  CONFIG_RETRY,
  CONFIG_RETRY_MAX,
  DESC_MAX,
  DUE_TICK,
  GET_ONLY,
  GLADYS_TIMEOUT,
  HTTP_TIMEOUT,
  LIST_TEXT_MAX,
  LOAD_TIMEOUT,
  MAX_ANNOUNCED,
  MAX_SLEEP,
  MEMBER_BYTES,
  MEMBER_QUERY,
  MEMBER_TTL,
  MIN_GAP,
  MINUTE,
  OWN_MOVE_TTL,
  PAUSE_MAX,
  PAUSE_MIN,
  POSITIONS,
  RECHECK_DELAY,
  SAVE_TIMEOUT,
  SECOND,
  SKEW_MAX,
  SKEW_MIN,
  STORE_RETRY,
  TEST_FRESH,
  TEST_GAP,
  WIDGET_CARDS,
} from './constants.js';
import { credentialsOf, normalizeConfig, tagOf, validRefused } from './config.js';
import { TrelloError, request } from './http.js';
import { T, reason } from './i18n.js';
import { findBoard, findCard, findList, parseBoard, parseCard, parseMember } from './trello.js';
import { dueEvents, moveEvents } from './triggers.js';
import { cardsWidget, dueCards, formatDue, messageWidget } from './widget.js';

const realTimers = { setTimeout, clearTimeout };
const ANNOUNCED = /^[0-9a-f]{24}\|\d{1,15}$/;
const ID = /^[0-9a-f]{24}$/;
const STATUS_MAX = 480;

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// eslint-disable-next-line no-control-regex
const descOf = (value) => String(value ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');

export class App {
  constructor({
    gladys,
    logger = console,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = realTimers,
    store,
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = randomBytes,
    base = API_BASE,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.base = base;

    /** The normalized configuration (config.js) once read from Gladys. */
    this.config = undefined;
    this.pendingConfig = undefined;
    /** `{ id, username, fullName, boards, mono }` of the last member reading. */
    this.member = undefined;
    this.memberError = undefined;
    /** A board answered that the token is in question: the member is read first. */
    this.memberStale = false;
    /** board id -> { snap, readMono, failures, retryMono, error }. */
    this.boards = new Map();
    /** `{ salt, tag, kind }` of refused credentials (/data), and them (memory only). */
    this.refused = undefined;
    this.refusedCreds = undefined;
    /** `{ until (wall), due (mono), step }` after a 429 or a 5xx on the member. */
    this.pause = undefined;
    this.pauseStep = 0;
    /** Wall time of the last reading's attempt (/data), monotonic time of the next one. */
    this.lastPollAt = undefined;
    this.nextPollMono = undefined;
    /** "card|due" -> due: the dues already announced (/data). */
    this.announced = new Map();
    /** card id -> { list, until (mono) }: moves made through Gladys (no "card moved"). */
    this.ownMoves = new Map();
    /** Server clock minus ours, when over a minute (Date header). */
    this.skew = 0;
    /** Requests: one in flight; waiters (scene actions first); monotonic times. */
    this.busy = false;
    this.waiters = [];
    this.requestTimes = [];
    this.requestMono = undefined;
    this.testMono = undefined;
    this.cycling = undefined;
    this.cycleMono = undefined;
    this.signature = '';

    this.loaded = false;
    this.loading = undefined;
    this.running = false;
    this.generation = 0;
    this.pollTimer = undefined;
    this.dueTimer = undefined;
    this.storeTimer = undefined;
    this.configTimer = undefined;
    this.recheckTimer = undefined;
    this.configFailures = 0;
    this.configRetryAt = undefined;
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.statusJob = Promise.resolve();
    this.saving = undefined;
    this.dataError = undefined;
    this.jobs = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every connection: /data once, the configuration read again, the schedule kept. */
  async connected() {
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.lastStatus = undefined;
    await this.loading?.catch(() => {});
    if (gen !== this.generation) return;
    if (!this.loaded) {
      this.publishStatus(false, T.starting);
      await this.load(gen);
      if (gen !== this.generation || !this.loaded) return;
    }
    this.configFailures = 0;
    await this.readConfig(gen);
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    for (const wake of [...this.sleeps]) wake();
    for (const waiter of this.waiters.splice(0)) waiter(false);
    await Promise.allSettled([...this.jobs]);
    if (this.loaded) await this.save();
  }

  clearTimers() {
    for (const name of ['pollTimer', 'dueTimer', 'storeTimer', 'configTimer', 'recheckTimer']) {
      if (this[name]) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
  }

  /** Every pending piece of work (tests). */
  async idle() {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (i >= 5 && this.jobs.size === 0 && !this.loading) break;
    }
    await this.statusJob;
  }

  /** Tracks a background job (stop waits for it); never throws. */
  track(promise) {
    const job = Promise.resolve(promise).catch((err) =>
      this.logger.error(
        `Job failed (${err?.name ?? 'Error'}: ${String(err?.message).slice(0, 200)})`,
      ),
    );
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job));
    return job;
  }

  /** Waits `ms` on the injected timers; ends at once when the app stops (resolves false). */
  sleep(ms, gen) {
    if (gen !== this.generation || !this.running) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve(gen === this.generation && this.running);
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  /** A Gladys promise bounded in time (a Gladys read that hangs is a failure). */
  bounded(promise, ms = GLADYS_TIMEOUT) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, late]).finally(() => this.timers.clearTimeout(timer));
  }

  // --- Configuration -----------------------------------------------------------------

  /** Reads the configuration from Gladys; a failure is retried for ever, spaced. */
  async readConfig(gen) {
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await this.bounded(Promise.resolve().then(() => this.gladys.getConfig()));
    } catch (err) {
      if (gen !== this.generation || !this.running) return;
      this.configFailures += 1;
      const wait = Math.min(CONFIG_RETRY * 2 ** (this.configFailures - 1), CONFIG_RETRY_MAX);
      this.logger.warn(
        `Configuration not read (${err?.name ?? 'Error'}): asked again in ${wait / 1000} s`,
      );
      this.configRetryAt = this.monotonic() + wait;
      this.publishStatus();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.track(this.readConfig(gen));
      }, wait);
      return;
    }
    if (gen !== this.generation || !this.running) return;
    this.configFailures = 0;
    this.configRetryAt = undefined;
    await this.configure(raw);
  }

  /** The configuration saved by the admin (or read at a connection). */
  async configure(raw) {
    if (!this.loaded) {
      this.pendingConfig = raw;
      return;
    }
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.config = next;
    const credsChanged = previous !== undefined && credentialsOf(previous) !== credentialsOf(next);
    const refsChanged =
      previous !== undefined && JSON.stringify(previous.refs) !== JSON.stringify(next.refs);
    if (credsChanged) {
      // New credentials are always tried: the refusal and the account of the old ones go.
      this.member = undefined;
      this.memberError = undefined;
      this.boards.clear();
      if (this.refused && !this.credentialsRefused()) {
        this.refused = undefined;
        this.refusedCreds = undefined;
        await this.save();
      }
    }
    if (previous === undefined) {
      // The first configuration of this process: the rest of the interval since
      // the last attempt (in /data) is waited, never sooner.
      if (this.nextPollMono === undefined) {
        const now = this.now();
        const since =
          this.lastPollAt !== undefined && this.lastPollAt <= now
            ? now - this.lastPollAt
            : Infinity;
        this.nextPollMono = this.monotonic() + Math.max(0, this.interval() - since);
      }
    } else if (credsChanged || refsChanged) {
      // A real change is read at once (the 300 ms gap still applies).
      this.nextPollMono = this.monotonic();
    }
    this.publishStatus();
    this.schedule(this.generation);
    this.scheduleDue(this.generation);
  }

  interval() {
    return (this.config?.pollMinutes ?? 5) * MINUTE;
  }

  /** The credentials held are the refused ones (exactly in memory, by their tag after a restart). */
  credentialsRefused() {
    if (!this.refused || !this.config || this.config.problem) return false;
    const creds = credentialsOf(this.config);
    if (this.refusedCreds !== undefined) return creds === this.refusedCreds;
    return tagOf(this.refused.salt, creds) === this.refused.tag;
  }

  async refuse(kind) {
    const salt = this.random(16).toString('hex');
    const creds = credentialsOf(this.config);
    this.refused = { salt, tag: tagOf(salt, creds), kind };
    this.refusedCreds = creds;
    this.logger.warn(`Trello refused the ${kind}: nothing asked until it changes`);
    await this.save();
    this.publishStatus();
  }

  /** Everything needed to ask: /data read, valid credentials not refused. */
  ready() {
    return (
      this.running &&
      this.loaded &&
      this.config !== undefined &&
      !this.config.problem &&
      !this.credentialsRefused()
    );
  }

  // --- /data -------------------------------------------------------------------------

  /** Reads /data once (bounded); unreadable: read again every 10 s, nothing asked meanwhile. */
  async load(gen) {
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.storeTimer = undefined;
    this.loading = (async () => {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve({ status: 'unreadable' }), LOAD_TIMEOUT);
      });
      const read = Promise.resolve()
        .then(() => this.store.load())
        .catch(() => ({ status: 'unreadable' }));
      const result = await Promise.race([read, late]).finally(() =>
        this.timers.clearTimeout(timer),
      );
      if (gen !== this.generation || !this.running) return;
      if (result.status === 'unreadable') {
        this.logger.warn('/data unreadable: read again in 10 s');
        this.publishStatus(false, T.storeUnreadable);
        // The next read waits for this one to end (one read at a time).
        const retry = () => {
          if (gen !== this.generation || !this.running) return;
          this.storeTimer = this.timers.setTimeout(() => {
            this.storeTimer = undefined;
            if (gen !== this.generation || !this.running) return;
            this.track(
              this.load(gen).then(() =>
                gen === this.generation && this.loaded ? this.readConfig(gen) : undefined,
              ),
            );
          }, STORE_RETRY);
        };
        read.finally(retry);
        return;
      }
      if (result.status === 'ok') this.restore(result.data);
      this.loaded = true;
    })().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
    if (this.loaded && this.pendingConfig !== undefined) {
      const raw = this.pendingConfig;
      this.pendingConfig = undefined;
      await this.configure(raw);
    }
  }

  /** The state of /data, each part checked; a part that does not read is dropped. */
  restore(data) {
    const now = this.now();
    const mono = this.monotonic();
    this.refused = validRefused(data.refused);
    const pause = data.pause;
    if (pause && Number.isFinite(pause.until) && pause.until > now) {
      // A pause past its maximum is capped: its rest counts on the monotonic clock.
      const left = Math.min(pause.until - now, PAUSE_MAX);
      this.pause = { until: now + left, due: mono + left };
    }
    if (pause && Number.isInteger(pause.step) && pause.step >= 0 && pause.step < 20) {
      this.pauseStep = pause.step;
    }
    // A date in the future is not ours to trust (a clock set back): ignored.
    if (Number.isFinite(data.lastPollAt) && data.lastPollAt > 0 && data.lastPollAt <= now) {
      this.lastPollAt = data.lastPollAt;
    }
    if (Array.isArray(data.announced)) {
      for (const entry of data.announced.slice(0, MAX_ANNOUNCED)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !ANNOUNCED.test(entry[0]))
          continue;
        const due = Number(entry[0].split('|')[1]);
        if (due > now - ANNOUNCED_KEEP && due <= now + ANNOUNCED_KEEP)
          this.announced.set(entry[0], due);
      }
    }
  }

  stateToSave() {
    return {
      version: 1,
      refused: this.refused,
      pause: { until: this.pause?.until ?? 0, step: this.pauseStep },
      lastPollAt: this.lastPollAt,
      announced: [...this.announced.keys()].slice(-MAX_ANNOUNCED).map((key) => [key]),
    };
  }

  /**
   * One write at a time, bounded in time: a write that hangs counts as a
   * failed one (the data stays in memory). Never throws. True when written.
   */
  async save() {
    if (this.saving) {
      await Promise.race([
        this.saving,
        new Promise((r) => {
          const t = this.timers.setTimeout(r, SAVE_TIMEOUT);
          this.saving?.then(() => this.timers.clearTimeout(t));
        }),
      ]);
      if (this.saving) {
        this.dataError = 'timeout';
        return false;
      }
    }
    let timer;
    const job = Promise.resolve().then(() => this.store.save(this.stateToSave()));
    const done = job.then(
      () => {},
      () => {},
    );
    this.saving = done;
    done.then(() => {
      if (this.saving === done) this.saving = undefined;
    });
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), SAVE_TIMEOUT);
    });
    try {
      const result = await Promise.race([job.then(() => 'ok'), late]);
      this.dataError = result === 'ok' ? undefined : 'timeout';
    } catch (err) {
      this.logger.warn(`Could not write /data: ${err?.code ?? 'error'}`);
      this.dataError = 'write';
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (this.dataError === 'timeout') this.logger.warn('Writing /data takes too long');
    return this.dataError === undefined;
  }

  // --- Requests to Trello -------------------------------------------------------------

  /** Takes the request slot; scene actions go before the readings. False: not given in time. */
  acquire(gen, { first = false, waitMax = Infinity } = {}) {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let timer;
      const waiter = (given) => {
        if (timer) this.timers.clearTimeout(timer);
        resolve(given && gen === this.generation && this.running);
      };
      if (first) this.waiters.unshift(waiter);
      else this.waiters.push(waiter);
      if (Number.isFinite(waitMax)) {
        timer = this.timers.setTimeout(() => {
          timer = undefined;
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, waitMax);
      }
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) next(true);
    else this.busy = false;
  }

  /** Why nothing may be asked now (a TrelloError code), or undefined. */
  blocked(gen, { allowRefused = false } = {}) {
    if (gen !== this.generation || !this.running) return 'stopped';
    if (!this.loaded || !this.config || this.config.problem) return 'not_ready';
    if (!allowRefused && this.credentialsRefused()) return 'refused';
    if (this.pause && this.pause.due > this.monotonic()) return 'paused';
    return undefined;
  }

  startPause(retryAfter) {
    const now = this.now();
    const wait =
      retryAfter !== undefined
        ? Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, retryAfter))
        : Math.min(PAUSE_MAX, PAUSE_MIN * 2 ** this.pauseStep);
    this.pauseStep = Math.min(this.pauseStep + 1, 19);
    this.pause = { until: now + wait, due: this.monotonic() + wait };
    this.logger.warn(`Trello asked to slow down: paused ${Math.round(wait / 1000)} s`);
  }

  /**
   * One request to Trello, in its slot, after the gap and within the budget.
   * `action`: a scene action or the test button (goes first, bounded waits,
   * `deadline` on the monotonic clock). Returns `{ body, date }`.
   */
  async ask(
    gen,
    method,
    path,
    { query, json, limit, action = false, deadline, allowRefused } = {},
  ) {
    const fail = (code) =>
      new TrelloError(code, `Nothing sent to Trello (${code})`, { sent: false });
    const left = () => (deadline === undefined ? Infinity : deadline - this.monotonic());
    let code = this.blocked(gen, { allowRefused });
    if (code) throw fail(code);
    const given = await this.acquire(gen, {
      first: action,
      waitMax: action ? Math.max(0, Math.min(ACTION_QUEUE_WAIT, left() - 2 * SECOND)) : Infinity,
    });
    if (!given) throw fail(gen === this.generation && this.running ? 'busy' : 'stopped');
    try {
      // Checked again in the slot: a pause or a refusal may have started meanwhile.
      code = this.blocked(gen, { allowRefused });
      if (code) throw fail(code);
      const mono = this.monotonic();
      let wait = this.requestMono === undefined ? 0 : this.requestMono + MIN_GAP - mono;
      this.requestTimes = this.requestTimes.filter((t) => t > mono - BUDGET_WINDOW);
      if (this.requestTimes.length >= BUDGET_REQUESTS) {
        wait = Math.max(wait, this.requestTimes[0] + BUDGET_WINDOW - mono);
      }
      if (wait > 0) {
        if (action && wait > Math.min(2 * SECOND, left() - 2 * SECOND)) throw fail('budget');
        if (!(await this.sleep(wait, gen))) throw fail('stopped');
        code = this.blocked(gen, { allowRefused });
        if (code) throw fail(code);
      }
      const timeout = action ? Math.min(ACTION_HTTP_TIMEOUT, left() - SECOND) : undefined;
      if (timeout !== undefined && timeout < SECOND) throw fail('deadline');
      this.requestMono = this.monotonic();
      this.requestTimes.push(this.requestMono);
      // The whole exchange bounded on the injected timers (the body included).
      const controller = new AbortController();
      const timer = this.timers.setTimeout(
        () => controller.abort(new DOMException('Trello did not answer in time', 'TimeoutError')),
        timeout ?? HTTP_TIMEOUT,
      );
      try {
        const answer = await request(this.base, method, path, {
          query,
          json,
          key: this.config.key,
          token: this.config.token,
          limit,
          signal: controller.signal,
          fetchImpl: this.fetchImpl,
          now: this.now,
        });
        this.noteDate(answer.date);
        return answer;
      } catch (err) {
        if (err instanceof TrelloError && err.code === 'rate_limited') {
          this.startPause(err.retryAfter);
          await this.save();
        }
        throw err;
      } finally {
        this.timers.clearTimeout(timer);
      }
    } finally {
      this.release();
    }
  }

  /** The server clock (Date header): a gap over a minute shifts the due checks, bounded. */
  noteDate(date) {
    if (date === undefined) return;
    const gap = date - this.now();
    this.skew = Math.abs(gap) >= SKEW_MIN ? Math.max(-SKEW_MAX, Math.min(SKEW_MAX, gap)) : 0;
  }

  /** "Now" for the due checks: our wall clock, shifted by the server's when far. */
  dueNow() {
    return this.now() + this.skew;
  }

  // --- Readings ------------------------------------------------------------------------

  /** GET /members/me with its open boards: the credentials check. */
  async readMember(gen, options = {}) {
    try {
      const { body } = await this.ask(gen, 'GET', '/members/me', {
        query: MEMBER_QUERY,
        limit: MEMBER_BYTES,
        ...options,
      });
      const member = parseMember(body);
      if (gen !== this.generation) return undefined;
      this.member = { ...member, mono: this.monotonic() };
      this.memberError = undefined;
      this.memberStale = false;
      this.pauseStep = 0;
      if (this.refused) {
        // Accepted (the test button): the refusal goes.
        this.refused = undefined;
        this.refusedCreds = undefined;
        await this.save();
      }
      return this.member;
    } catch (err) {
      if (gen !== this.generation) throw err;
      if (err instanceof TrelloError && err.code === 'unauthorized' && err.auth) {
        await this.refuse(err.auth);
      } else if (err instanceof TrelloError && err.code === 'server') {
        this.startPause(err.retryAfter);
        await this.save();
      }
      if (err instanceof TrelloError && err.sent !== false) this.memberError = err.code;
      throw err;
    }
  }

  /**
   * The boards followed: `[{ ref, id, name, error }]`, from the member's open
   * boards (every one when the field is empty: the first 10 by name).
   */
  followed() {
    if (!this.member || !this.config) return [];
    if (this.config.refs.length === 0) {
      return [...this.member.boards]
        .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
        .slice(0, 10)
        .map((b) => ({ ref: b.name, id: b.id, name: b.name }));
    }
    const seen = new Set();
    return this.config.refs.map((ref) => {
      const { item, error } = findBoard(this.member.boards, ref);
      if (!item || seen.has(item.id)) return { ref, error: error ?? 'duplicate' };
      seen.add(item.id);
      return { ref, id: item.id, name: item.name };
    });
  }

  boardState(id) {
    let state = this.boards.get(id);
    if (!state) {
      state = { snap: undefined, readMono: undefined, failures: 0, retryMono: 0, error: undefined };
      this.boards.set(id, state);
    }
    return state;
  }

  /** GET /boards/{id} with its open lists and cards; "card moved" fired from the difference. */
  async readBoard(gen, id, options = {}) {
    const state = this.boardState(id);
    try {
      const { body } = await this.ask(gen, 'GET', `/boards/${id}`, {
        query: BOARD_QUERY,
        limit: BOARD_BYTES,
        ...options,
      });
      const snap = parseBoard(body, id);
      if (gen !== this.generation) return undefined;
      const previous = state.snap;
      state.snap = snap;
      state.readMono = this.monotonic();
      state.failures = 0;
      state.retryMono = 0;
      state.error = undefined;
      this.pauseStep = 0;
      for (const [card, own] of this.ownMoves) {
        if (own.until <= state.readMono) this.ownMoves.delete(card);
      }
      const events = moveEvents(previous, snap, this.ownMoves, state.readMono);
      this.track(this.publishEvents(gen, events));
      return snap;
    } catch (err) {
      if (gen !== this.generation || !(err instanceof TrelloError) || err.sent === false) throw err;
      state.failures += 1;
      state.error = err.code;
      // Read again after the interval doubled at each failure, an hour at most,
      // counted from the start of the reading (a scene action: from now).
      const from = options.action ? this.monotonic() : (this.cycleMono ?? this.monotonic());
      state.retryMono =
        from + Math.min(BOARD_RETRY_MAX, this.interval() * 2 ** (state.failures - 1));
      // The token in question, or the board gone: the member is read first next time.
      if ((err.code === 'unauthorized' && err.auth) || err.code === 'not_found') {
        this.memberStale = true;
      }
      throw err;
    }
  }

  /** Schedules the next reading on the monotonic clock (a timer sleeps an hour at most). */
  schedule(gen) {
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (gen !== this.generation || !this.running || this.nextPollMono === undefined) return;
    let due = this.nextPollMono;
    if (this.pause && this.pause.due > due) due = this.pause.due;
    const wait = Math.max(0, due - this.monotonic());
    this.pollTimer = this.timers.setTimeout(
      () => {
        this.pollTimer = undefined;
        if (gen !== this.generation || !this.running) return;
        const target = Math.max(this.nextPollMono, this.pause?.due ?? 0);
        if (target > this.monotonic()) {
          this.schedule(gen);
          return;
        }
        this.track(this.cycle(gen));
      },
      Math.min(wait, MAX_SLEEP),
    );
  }

  /** One reading: the member when due, then each followed board due. */
  async cycle(gen) {
    if (this.cycling) return this.cycling;
    this.cycling = (async () => {
      if (!this.ready()) {
        // Nothing to ask (refused, not configured): the next look in an interval.
        this.nextPollMono = this.monotonic() + this.interval();
        this.publishStatus();
        return;
      }
      if (this.pause && this.pause.due > this.monotonic()) {
        this.schedule(gen);
        return;
      }
      const mono = this.monotonic();
      this.cycleMono = mono;
      this.nextPollMono = mono + this.interval();
      // The attempt is in /data before the reading: a restart never reads sooner.
      this.lastPollAt = this.now();
      await this.save();
      if (gen !== this.generation) return;
      try {
        if (!this.member || this.memberStale || mono - this.member.mono >= MEMBER_TTL) {
          await this.readMember(gen);
        }
        for (const board of this.followed()) {
          if (!board.id) continue;
          const state = this.boardState(board.id);
          if (state.retryMono > this.monotonic()) continue;
          try {
            await this.readBoard(gen, board.id);
          } catch (err) {
            if (!(err instanceof TrelloError) || err.sent === false) throw err;
            this.logger.warn(`Board ${board.id} not read (${err.code})`);
          }
          if (this.blocked(gen) || this.memberStale) break;
        }
      } catch (err) {
        if (gen === this.generation) {
          this.logger.warn(`Reading stopped (${err?.code ?? err?.name ?? 'Error'})`);
        }
      }
      if (gen !== this.generation) return;
      this.forgetBoards();
      await this.checkDue(gen);
      this.nudge();
      this.publishStatus();
    })().finally(() => {
      this.cycling = undefined;
      this.schedule(gen);
    });
    return this.cycling;
  }

  /** Boards no longer followed leave memory (their cards fire nothing more). */
  forgetBoards() {
    if (!this.member) return;
    const wanted = new Set(
      this.followed()
        .map((b) => b.id)
        .filter(Boolean),
    );
    for (const id of [...this.boards.keys()]) if (!wanted.has(id)) this.boards.delete(id);
  }

  /** The boards read, followed ones only. */
  readBoards() {
    const out = [];
    for (const b of this.followed()) {
      const snap = b.id ? this.boards.get(b.id)?.snap : undefined;
      if (snap) out.push(snap);
    }
    return out;
  }

  /** A board read again shortly after a write sent without answer. */
  recheck(gen, id) {
    if (this.recheckTimer) return;
    this.recheckTimer = this.timers.setTimeout(() => {
      this.recheckTimer = undefined;
      if (gen !== this.generation || !this.ready()) return;
      this.track(
        this.readBoard(gen, id)
          .then(() => this.checkDue(gen))
          .then(() => this.nudge())
          .catch((err) => this.logger.warn(`Board read back failed (${err?.code ?? 'Error'})`)),
      );
    }, RECHECK_DELAY);
  }

  /** What the widget shows changed: a nudge (the core limits it to 1 per 10 s). */
  nudge() {
    const now = this.dueNow();
    const soon = (this.config?.soonHours ?? 24) * 3_600_000;
    const signature = JSON.stringify(
      dueCards(this.readBoards(), now, soon).map(({ card, overdue }) => [
        card.id,
        card.name,
        card.due,
        card.idList,
        overdue,
      ]),
    );
    if (signature === this.signature) return;
    this.signature = signature;
    try {
      this.gladys.requestWidgetRefresh(WIDGET_CARDS);
    } catch {
      // A nudge is best effort.
    }
  }

  // --- Scene triggers ---------------------------------------------------------------------

  async publishEvents(gen, events) {
    for (const event of events) {
      if (gen !== this.generation || !this.running) return;
      // The due as read in the configured zone, next to the ISO instant.
      event.data.due_local = event.data.due
        ? formatDue(Date.parse(event.data.due), this.config?.timeZone ?? 'UTC', 'iso')
        : null;
      try {
        await this.bounded(
          Promise.resolve().then(() => this.gladys.publishSceneEvent(event.key, event.data)),
        );
      } catch (err) {
        this.logger.warn(`Scene event ${event.key} not published (${err?.name ?? 'Error'})`);
      }
    }
  }

  /** The minute tick: the dues the clock just crossed. No request. */
  scheduleDue(gen) {
    if (this.dueTimer || gen !== this.generation || !this.running) return;
    this.dueTimer = this.timers.setTimeout(() => {
      this.dueTimer = undefined;
      if (gen !== this.generation || !this.running) return;
      this.track(
        this.checkDue(gen).finally(() => {
          this.nudge();
          this.scheduleDue(gen);
        }),
      );
    }, DUE_TICK);
  }

  async checkDue(gen) {
    if (gen !== this.generation || !this.running || !this.config) return;
    const now = this.dueNow();
    const grace = this.interval() + DUE_TICK;
    const { events, marked } = dueEvents(this.readBoards(), this.announced, now, grace);
    for (const key of marked) this.announced.set(key, Number(key.split('|')[1]));
    let pruned = false;
    for (const [key, due] of this.announced) {
      if (due <= now - ANNOUNCED_KEEP) {
        this.announced.delete(key);
        pruned = true;
      }
    }
    while (this.announced.size > MAX_ANNOUNCED) {
      this.announced.delete(this.announced.keys().next().value);
      pruned = true;
    }
    // Remembered before the events leave: a restart never fires them twice.
    if (marked.length > 0 || pruned) await this.save();
    await this.publishEvents(gen, events);
  }

  // --- Status ---------------------------------------------------------------------------

  statusNow() {
    const mono = this.monotonic();
    if (!this.loaded) return [false, T.storeUnreadable];
    if (this.configRetryAt !== undefined) return [false, T.configUnread(this.configRetryAt - mono)];
    if (!this.config) return [false, T.starting];
    if (this.config.problem === 'missing') return [false, T.missing];
    if (this.config.problem === 'bad_key') return [false, T.badKey];
    if (this.config.problem === 'bad_token') return [false, T.badToken];
    if (this.credentialsRefused()) return [false, T.refused(this.refused.kind)];
    if (this.pause && this.pause.due > mono) return [false, T.paused(this.pause.due - mono)];
    if (!this.member) {
      return this.memberError ? [false, T.unreachable(this.memberError)] : [true, T.waitingFirst];
    }
    const followed = this.followed();
    const ids = followed.filter((b) => b.id);
    const notes = [];
    const unknown = followed.filter((b) => !b.id).map((b) => b.ref);
    if (unknown.length) notes.push(T.unknownBoards(cut(unknown.join(', '), 120)));
    if (this.config.tooMany) notes.push(T.tooMany);
    if (ids.length === 0) return [false, T.noBoard];
    const states = ids.map((b) => this.boards.get(b.id));
    const read = states.filter((s) => s?.snap && !s.error).length;
    if (states.some((s) => s?.snap?.cut)) notes.push(T.cut);
    if (this.dataError) notes.push(T.dataError);
    const errors = states.filter((s) => s?.error).map((s) => s.error);
    if (read === 0 && errors.length > 0 && !states.some((s) => s?.snap)) {
      return [false, this.withNotes(T.allFailed(ids.length, errors[0]), notes)];
    }
    if (read === 0 && errors.length === 0 && !states.some((s) => s?.snap)) {
      return [true, this.withNotes(T.waitingFirst, notes)];
    }
    const overdue = dueCards(this.readBoards(), this.dueNow(), 0).filter((c) => c.overdue).length;
    if (errors.length > 0) {
      notes.unshift({
        en: `${errors.length} not read (${reason(errors[0]).en})`,
        fr: `${errors.length} non lu(s) (${reason(errors[0]).fr})`,
      });
    }
    return [read > 0, this.withNotes(T.ok(read, ids.length, overdue), notes)];
  }

  withNotes(text, notes) {
    if (notes.length === 0) return text;
    return {
      en: cut(`${text.en}; ${notes.map((n) => n.en).join('; ')}`, STATUS_MAX),
      fr: cut(`${text.fr} ; ${notes.map((n) => n.fr).join(' ; ')}`, STATUS_MAX),
    };
  }

  /** The connection status (deduplicated, one call at a time, bounded). */
  publishStatus(connected, message) {
    if (connected === undefined) [connected, message] = this.statusNow();
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return this.statusJob;
    this.lastStatus = key;
    const gen = this.generation;
    this.statusJob = this.statusJob.then(async () => {
      if (gen !== this.generation) return;
      try {
        await this.bounded(
          Promise.resolve().then(() => this.gladys.setConnectionStatus(connected, message)),
          5 * SECOND,
        );
      } catch (err) {
        this.logger.warn(`Status not sent (${err?.name ?? 'Error'})`);
        if (this.lastStatus === key) this.lastStatus = undefined;
      }
    });
    return this.statusJob;
  }

  // --- Test button ------------------------------------------------------------------------

  async testConnection() {
    const gen = this.generation;
    if (!this.loaded) return T.storeUnreadable;
    if (!this.config) return T.starting;
    if (this.config.problem) {
      return this.config.problem === 'missing'
        ? T.missing
        : this.config.problem === 'bad_key'
          ? T.badKey
          : T.badToken;
    }
    const mono = this.monotonic();
    const fresh =
      this.member &&
      !this.memberStale &&
      mono - this.member.mono < TEST_FRESH &&
      !this.credentialsRefused();
    if (!fresh) {
      if (this.testMono !== undefined && mono - this.testMono < TEST_GAP) return T.testTooSoon;
      this.testMono = mono;
      const wasRefused = this.credentialsRefused();
      try {
        await this.readMember(gen, {
          action: true,
          deadline: mono + 25 * SECOND,
          allowRefused: true,
        });
      } catch (err) {
        this.publishStatus();
        if (this.credentialsRefused()) return T.refused(this.refused.kind);
        return T.testFailed(err instanceof TrelloError ? err.code : 'network');
      }
      if (wasRefused && gen === this.generation) {
        // Accepted again: the readings resume at once.
        this.nextPollMono = this.monotonic();
        this.schedule(gen);
      }
    }
    this.publishStatus();
    const m = this.member;
    const who = m.fullName ? `${m.fullName} (@${m.username})` : `@${m.username}`;
    const followed = this.followed()
      .filter((b) => b.id)
      .map((b) => b.name);
    const now = this.dueNow();
    const cards = dueCards(this.readBoards(), now, this.config.soonHours * 3_600_000);
    const overdue = cards.filter((c) => c.overdue).length;
    const text = T.testOk(
      who,
      m.boards.length,
      cut(followed.join(', '), 200),
      overdue,
      cards.length - overdue,
      this.config.soonHours,
    );
    return { en: cut(text.en, 480), fr: cut(text.fr, 480) };
  }

  // --- Scene actions ----------------------------------------------------------------------

  /** Nothing can be sent: the reason in a thrown error (the scene logs it, goes on). */
  nothingSent(why) {
    return new Error(T.nothingSent(why));
  }

  errorOf(err) {
    if (!(err instanceof TrelloError)) return err;
    if (err.sent === false) return this.nothingSent(reason(err.code).en);
    return new Error(T.refusedByTrello(reason(err.code).en));
  }

  requireReady(gen) {
    const code = this.blocked(gen);
    if (code) throw this.nothingSent(reason(code).en);
  }

  /** The member's board named `ref` (the member read first when never read). */
  async boardFor(gen, ref, deadline) {
    if (!this.member) {
      try {
        await this.readMember(gen, { action: true, deadline });
      } catch (err) {
        throw this.errorOf(err);
      }
      if (!this.member) throw this.nothingSent(reason('stopped').en);
    }
    const { item, error } = findBoard(this.member.boards, ref);
    if (!item) throw this.nothingSent(T.boardNotFound(String(ref ?? '').slice(0, 100), error));
    return item;
  }

  /** The board read (again when older than `maxAge`). */
  async snapFor(gen, id, deadline, maxAge = Infinity) {
    const state = this.boards.get(id);
    if (state?.snap && this.monotonic() - state.readMono < maxAge) return state.snap;
    try {
      return await this.readBoard(gen, id, { action: true, deadline });
    } catch (err) {
      throw this.errorOf(err);
    }
  }

  /** Adds or updates a card in a board read (no "card moved" for a change made here). */
  applyCard(boardId, card) {
    const snap = this.boards.get(boardId)?.snap;
    if (!snap || !snap.lists.has(card.idList)) return;
    snap.cards.set(card.id, card);
  }

  /** POST /cards: a new card at the top or the bottom of a list. Never sent twice. */
  async createCard(fields = {}) {
    const gen = this.generation;
    const deadline = this.monotonic() + 25 * SECOND;
    this.requireReady(gen);
    const name = cut(descOf(fields.name).replace(/\s+/g, ' ').trim(), CARD_NAME_MAX);
    if (!name) throw this.nothingSent(T.emptyName);
    const desc = cut(descOf(fields.description).trim(), DESC_MAX);
    const rawDue = fields.due_in_minutes;
    let minutes = 0;
    if (rawDue !== undefined && rawDue !== null && rawDue !== '') {
      minutes = typeof rawDue === 'number' ? rawDue : Number(String(rawDue).trim());
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 525_600) {
        throw this.nothingSent(T.badDue);
      }
    }
    const pos = POSITIONS.includes(fields.position) ? fields.position : 'bottom';
    const board = await this.boardFor(gen, fields.board, deadline);
    let snap = await this.snapFor(gen, board.id, deadline);
    let found = findList(snap, fields.list);
    if (
      !found.item &&
      found.error === 'unknown' &&
      this.monotonic() - this.boards.get(board.id).readMono >= ACTION_FRESH
    ) {
      // A list created since the last reading: the board read again once.
      snap = await this.snapFor(gen, board.id, deadline, 0);
      found = findList(snap, fields.list);
    }
    if (!found.item)
      throw this.nothingSent(T.listNotFound(String(fields.list ?? '').slice(0, 100), found.error));
    const list = found.item;
    const json = { idList: list.id, name, pos };
    if (desc) json.desc = desc;
    if (minutes > 0) json.due = new Date(this.dueNow() + minutes * MINUTE).toISOString();
    let answer;
    try {
      answer = await this.ask(gen, 'POST', '/cards', {
        query: { fields: CARD_FIELDS },
        json,
        limit: CARD_BYTES,
        action: true,
        deadline,
      });
    } catch (err) {
      if (err instanceof TrelloError && (err.sent === 'unknown' || err.code === 'server')) {
        // May have been created: never sent again, the board read back shortly.
        this.logger.warn(`Card creation sent without confirmation (${err.code})`);
        this.recheck(gen, board.id);
        return {
          created: false,
          result: 'unconfirmed',
          id: null,
          url: null,
          name,
          board: board.name,
          list: list.name,
        };
      }
      throw this.errorOf(err);
    }
    const card = parseCard(answer.body, null);
    if (!card || card.idList !== list.id) {
      this.recheck(gen, board.id);
      return {
        created: false,
        result: 'unconfirmed',
        id: null,
        url: null,
        name,
        board: board.name,
        list: list.name,
      };
    }
    this.applyCard(board.id, card);
    this.nudge();
    return {
      created: true,
      result: 'created',
      id: card.id,
      url: card.url || null,
      name: card.name,
      board: board.name,
      list: list.name,
    };
  }

  /** PUT /cards/{id}: the card moved to another list of its board. */
  async moveCard(fields = {}) {
    const gen = this.generation;
    const deadline = this.monotonic() + 25 * SECOND;
    this.requireReady(gen);
    const pos = POSITIONS.includes(fields.position) ? fields.position : 'top';
    const board = await this.boardFor(gen, fields.board, deadline);
    // A card matched by name on a fresh reading (a minute at most).
    const snap = await this.snapFor(gen, board.id, deadline, ACTION_FRESH);
    const foundCard = findCard(snap, fields.card);
    if (!foundCard.item) {
      throw this.nothingSent(
        T.cardNotFound(String(fields.card ?? '').slice(0, 100), foundCard.error),
      );
    }
    const foundList = findList(snap, fields.list);
    if (!foundList.item) {
      throw this.nothingSent(
        T.listNotFound(String(fields.list ?? '').slice(0, 100), foundList.error),
      );
    }
    const card = foundCard.item;
    const list = foundList.item;
    const from = snap.lists.get(card.idList) ?? null;
    const out = (moved, result) => ({
      moved,
      result,
      name: card.name,
      from_list: from,
      list: list.name,
      url: card.url || null,
    });
    if (card.idList === list.id) return out(true, 'already');
    if (!ID.test(card.id)) throw this.nothingSent(T.cardNotFound('?', 'unknown'));
    // Known before it leaves: a reading in between fires no "card moved".
    const own = { list: list.id, until: this.monotonic() + OWN_MOVE_TTL };
    this.ownMoves.set(card.id, own);
    let answer;
    try {
      answer = await this.ask(gen, 'PUT', `/cards/${card.id}`, {
        query: { fields: CARD_FIELDS },
        json: { idList: list.id, pos },
        limit: CARD_BYTES,
        action: true,
        deadline,
      });
    } catch (err) {
      if (err instanceof TrelloError && (err.sent === 'unknown' || err.code === 'server')) {
        this.logger.warn(`Card move sent without confirmation (${err.code})`);
        this.recheck(gen, board.id);
        return out(false, 'unconfirmed');
      }
      if (this.ownMoves.get(card.id) === own) this.ownMoves.delete(card.id);
      throw this.errorOf(err);
    }
    const moved = parseCard(answer.body, null);
    if (!moved || moved.id !== card.id) {
      this.recheck(gen, board.id);
      return out(false, 'unconfirmed');
    }
    if (moved.idList !== list.id) {
      if (this.ownMoves.get(card.id) === own) this.ownMoves.delete(card.id);
      return out(false, 'not_applied');
    }
    this.applyCard(board.id, moved);
    this.nudge();
    return out(true, 'moved');
  }

  /** The cards overdue and due soon, from the last readings (no request). */
  async getCards(fields = {}) {
    const gen = this.generation;
    this.requireReady(gen);
    let boards = this.readBoards();
    if (boards.length === 0) throw this.nothingSent(T.notRead);
    let listId;
    if (fields.board) {
      const { item, error } = findBoard(boards, fields.board);
      if (!item) throw this.nothingSent(T.boardNotFound(String(fields.board).slice(0, 100), error));
      boards = [item];
      if (fields.list) {
        const found = findList(item, fields.list);
        if (!found.item)
          throw this.nothingSent(T.listNotFound(String(fields.list).slice(0, 100), found.error));
        listId = found.item.id;
      }
    }
    const only = GET_ONLY.includes(fields.only) ? fields.only : 'due';
    const now = this.dueNow();
    let cards = dueCards(boards, now, this.config.soonHours * 3_600_000, { list: listId });
    const overdueCount = cards.filter((c) => c.overdue).length;
    const soonCount = cards.length - overdueCount;
    if (only === 'overdue') cards = cards.filter((c) => c.overdue);
    if (only === 'soon') cards = cards.filter((c) => !c.overdue);
    // Scene outputs carry no language: dates as 2026-11-15 18:00 in the configured zone.
    const lang = 'iso';
    const lines = [];
    let length = 0;
    for (const { board, card } of cards) {
      const line = `• ${card.name} (${board.name} / ${board.lists.get(card.idList) ?? ''}) — ${formatDue(card.due, this.config.timeZone, lang)}`;
      if (length + line.length + 1 > LIST_TEXT_MAX - 2) {
        lines.push('…');
        break;
      }
      lines.push(line);
      length += line.length + 1;
    }
    const next = cards[0]?.card;
    return {
      count: cards.length,
      overdue_count: overdueCount,
      soon_count: soonCount,
      list: lines.join('\n'),
      next_name: next ? next.name : '',
      next_due: next ? formatDue(next.due, this.config.timeZone, lang) : '',
    };
  }

  // --- Widget -----------------------------------------------------------------------------

  async getWidget({ settings = {}, language = 'en' } = {}) {
    const lang = language === 'fr' ? 'fr' : 'en';
    if (!this.config || this.config.problem)
      return messageWidget(this.config ? T.missing : T.starting, lang);
    if (this.credentialsRefused()) return messageWidget(T.refused(this.refused.kind), lang);
    let boards = this.readBoards();
    if (boards.length === 0) return messageWidget(T.widgetNotRead, lang);
    if (typeof settings.board === 'string' && settings.board.trim()) {
      const { item } = findBoard(boards, settings.board);
      boards = item ? [item] : [];
      if (!item) return messageWidget(T.unknownBoards(settings.board.slice(0, 100)), lang);
    }
    return cardsWidget({
      boards,
      now: this.dueNow(),
      soonHours: this.config.soonHours,
      timeZone: this.config.timeZone,
      language: lang,
    });
  }
}
