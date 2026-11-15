// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Trello API and a virtual
// clock (each read moves it 1 µs).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../../src/app.js';
import { API_BASE } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { BOARD_HOME, board, member } from '../fixtures/trello.js';
import { testClock } from './clock.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Sunday 15 November 2026, 14:20 UTC. */
export const NOW = Date.parse('2026-11-15T14:20:00Z');
export const KEY = '0123456789abcdef0123456789abcdef';
export const TOKEN = `ATTA${'9f8e7d6c5b4a'.repeat(5)}1234`;

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
export const text = (body, status, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });

/**
 * The Trello API: `boards` (Map id -> board fixture, edited live), and the
 * hooks `onMember`, `onBoard`, `onPost`, `onPut` (request) that may return a
 * Response, a body, 'timeout', 'reset' or undefined (the default answer).
 */
export function createTrello(clock) {
  const trello = {
    requests: [],
    boards: new Map([[BOARD_HOME, board()]]),
    onMember: undefined,
    onBoard: undefined,
    onPost: undefined,
    onPut: undefined,
    date: undefined,
    latency: 0,
    count: (kind) => trello.requests.filter((r) => !kind || r.kind === kind).length,
  };
  trello.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/1/, '');
    const method = init.method ?? 'GET';
    const boardMatch = /^\/boards\/([0-9a-f]{24})$/.exec(path);
    const cardMatch = /^\/cards\/([0-9a-f]{24})$/.exec(path);
    const kind =
      method === 'GET' && path === '/members/me'
        ? 'member'
        : method === 'GET' && boardMatch
          ? 'board'
          : method === 'POST' && path === '/cards'
            ? 'post'
            : method === 'PUT' && cardMatch
              ? 'put'
              : 'other';
    const request = {
      url: String(url),
      u,
      kind,
      method,
      headers: init.headers ?? {},
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
      id: boardMatch?.[1] ?? cardMatch?.[1],
      at: clock.now(),
      mono: clock.elapsed,
    };
    trello.requests.push(request);
    if (!String(url).startsWith(API_BASE)) return text('nope', 404);
    const hook = {
      member: trello.onMember,
      board: trello.onBoard,
      post: trello.onPost,
      put: trello.onPut,
    }[kind];
    // Latency on the virtual clock; an abort (the app's deadline) ends the wait.
    const signal = init.signal;
    const pause = (ms) =>
      new Promise((resolve, reject) => {
        const h = clock.timers.setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clock.timers.clearTimeout(h);
          reject(signal.reason);
        });
      });
    if (trello.latency) await pause(trello.latency);
    let out = hook ? await hook(request) : undefined;
    if (out === 'hang') out = await pause(10 * HOUR).then(() => 'timeout');
    if (out === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (out === 'refused') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (out === 'reset') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    if (out instanceof Response) return out;
    const headers = trello.date ? { date: new Date(trello.date()).toUTCString() } : {};
    if (out !== undefined) return json(out, 200, headers);
    if (kind === 'member') return json(member([...trello.boards.values()]), 200, headers);
    if (kind === 'board') {
      const b = trello.boards.get(request.id);
      return b ? json(b, 200, headers) : text('invalid id', 400);
    }
    if (kind === 'post') {
      for (const b of trello.boards.values()) {
        if (!b.lists.some((l) => l.id === request.body.idList)) continue;
        const n = 5000 + trello.count('post');
        const shortLink = `New${String(n).padStart(5, '0')}`;
        const created = {
          id: `d${String(n).padStart(23, '0')}`,
          name: request.body.name,
          idList: request.body.idList,
          due: request.body.due ?? null,
          dueComplete: false,
          closed: false,
          shortLink,
          shortUrl: `https://trello.com/c/${shortLink}`,
          labels: [],
        };
        b.cards.push(created);
        return json(created, 200, headers);
      }
      return text('invalid value for idList', 400);
    }
    if (kind === 'put') {
      for (const b of trello.boards.values()) {
        const c = b.cards.find((x) => x.id === request.id);
        if (!c) continue;
        if (request.body.idList) c.idList = request.body.idList;
        return json(c, 200, headers);
      }
      return text('The requested resource was not found.', 404);
    }
    return text('nope', 404);
  };
  return trello;
}

export async function setup({
  store = createMemoryStore(),
  now = NOW,
  config = { api_key: KEY, api_token: TOKEN },
  start = true,
  clock = testClock({ start: now }),
  boards,
  prepare,
} = {}) {
  const gladys = createFakeGladys({ selector: 'trello', config });
  const trello = createTrello(clock);
  if (boards) trello.boards = new Map(boards.map((b) => [b.id, b]));
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const logger = { info: log, warn: log, error: log, debug: log };
  const app = new App({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: trello.fetch,
  });
  registerHandlers(gladys, app, logger);
  // A storm of requests (a broken back-off) fails the test at once, never hangs it.
  clock.between = async () => {
    if (trello.requests.length > 2000) throw new Error('request storm: over 2,000 requests');
    await app.idle();
  };
  const wait = async (ms) => {
    await app.idle();
    await clock.advance(ms);
    await app.idle();
  };
  /** Runs a command of Gladys while the virtual clock moves (100 ms steps, 60 s at most). */
  const run = async (promise) => {
    let done = false;
    const settled = Promise.resolve(promise).finally(() => {
      done = true;
    });
    for (let i = 0; i < 600 && !done; i += 1) await wait(100);
    if (!done) throw new Error('command still pending after 60 s of virtual time');
    return settled;
  };
  if (prepare) await prepare({ gladys, trello, app, clock });
  if (start) {
    await gladys.connect();
    await wait(0);
    await wait(2 * SECOND);
  }
  const status = () => gladys.fake.connectionStatus;
  const events = (key) => gladys.fake.sceneEvents.filter((e) => !key || e.key === key);
  return { app, gladys, clock, store, trello, wait, run, lines, status, events, logger };
}

/** Stops the app and lets everything settle (t.after). */
export async function teardown(env) {
  // The clock moves meanwhile: a stop bounded on the virtual timers ends.
  await env.run(env.app.stop());
  await env.app.idle();
}
