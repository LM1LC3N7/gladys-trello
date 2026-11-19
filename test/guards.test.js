// -----------------------------------------------------------------------------
// The guards the review r1 found without a test: answers to replaced
// credentials, stale readings, a bounded stop, the request slot, pauses,
// own moves, widget cuts. Virtual clock, scripted Trello, fake Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { retryAfterMs } from '../src/http.js';
import { createMemoryStore } from '../src/store.js';
import {
  BOARD_HOME,
  BOARD_WORK,
  LIST_DOING,
  LIST_DONE,
  LIST_TODO,
  LIST_WORK,
  board,
  card,
} from './fixtures/trello.js';
import { HOUR, KEY, MINUTE, NOW, SECOND, TOKEN, setup, teardown, text } from './helpers/app.js';

const TOKEN2 = `ATTA${'0a1b2c3d4e5f'.repeat(5)}5678`;
const start = async (t, options) => {
  const env = await setup(options);
  t.after(() => teardown(env));
  return env;
};
const statusText = (env) => env.status()?.message?.en ?? '';
const home = (cards) => board({ cards });
const work = (cards = []) =>
  board({
    id: BOARD_WORK,
    name: 'Travail',
    shortLink: 'WorkBrd2',
    lists: [{ id: LIST_WORK, name: 'Backlog', closed: false, pos: 1 }],
    cards,
  });
/** A promise resolved by hand: a Trello answer held back. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
/** Resolves after `ms` on the virtual clock. */
const later = (clock, ms, value) =>
  new Promise((resolve) => clock.timers.setTimeout(() => resolve(value), ms));
const usesToken = (r, token) => r.headers.Authorization.includes(`oauth_token="${token}"`);

// --- I1: an answer to replaced credentials decides nothing ------------------------------

test('a 401 answered to the old credentials never refuses the new ones', async (t) => {
  const held = deferred();
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = (r) => (usesToken(r, TOKEN) ? held.promise : undefined);
    },
  });
  assert.equal(env.trello.count('member'), 1);
  await env.gladys.fake.configUpdated({ api_key: KEY, api_token: TOKEN2 });
  held.resolve(text('invalid token', 401));
  await env.wait(2 * SECOND);
  assert.equal(env.store.data?.refused, undefined);
  assert.equal(env.app.credentialsRefused(), false);
  const fresh = env.trello.requests.filter((r) => usesToken(r, TOKEN2));
  assert.deepEqual(
    fresh.map((r) => r.kind),
    ['member', 'board'],
  );
  assert.equal(env.status().connected, true);
});

test('a member or board answered to the old credentials is not kept for the new ones', async (t) => {
  const held = deferred();
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = (r) => (usesToken(r, TOKEN) ? held.promise : undefined);
    },
  });
  await env.gladys.fake.configUpdated({ api_key: KEY, api_token: TOKEN2 });
  held.resolve(undefined); // the default 200 member, for the old token
  await env.wait(2 * SECOND);
  assert.equal(
    env.trello.requests.filter((r) => usesToken(r, TOKEN2) && r.kind === 'member').length,
    1,
    'the member read again with the new token',
  );
  // A refused token answered to a board for the old credentials: nothing counted.
  const held2 = deferred();
  env.trello.onBoard = (r) => (usesToken(r, TOKEN2) ? held2.promise : undefined);
  await env.wait(5 * MINUTE);
  await env.gladys.fake.configUpdated({ api_key: KEY, api_token: TOKEN });
  held2.resolve(text('invalid token', 401));
  await env.wait(2 * SECOND);
  assert.equal(env.app.memberStale, false);
  assert.equal(env.app.credentialsRefused(), false);
});

// --- I2: stale readings decide nothing ---------------------------------------------------

test('credentials refused: the readings are dropped, no "card due" from them', async (t) => {
  let revoked = false;
  const env = await start(t, {
    boards: [home([card(1, { due: NOW + 10 * MINUTE })])],
    prepare: ({ trello }) => {
      trello.onBoard = () => (revoked ? text('invalid token', 401) : undefined);
      trello.onMember = () => (revoked ? text('invalid token', 401) : undefined);
    },
  });
  revoked = true;
  await env.wait(30 * MINUTE);
  assert.match(statusText(env), /refused the token/);
  assert.equal(env.events('card_due').length, 0);
  assert.equal(env.app.boards.size, 0);
});

test('a board failing for long: no "card due", the widget and the action say it is out of date', async (t) => {
  let failing = false;
  const env = await start(t, {
    config: { api_key: KEY, api_token: TOKEN, poll_minutes: 2 },
    boards: [home([card(1, { name: 'Appeler', due: NOW + 8 * MINUTE })])],
    prepare: ({ trello }) => {
      trello.onBoard = () => (failing ? text('oops', 500) : undefined);
    },
  });
  failing = true;
  await env.wait(12 * MINUTE);
  assert.equal(env.events('card_due').length, 0, 'never decided on a reading 12 min old');
  assert.equal(env.status().connected, false);
  assert.match(statusText(env), /^No board could be read \(1\): Trello server error; last reading/);
  await env.wait(20 * MINUTE);
  const widget = (await env.gladys.fake.widgetGet('cards', { language: 'fr' })).data.content;
  assert.match(
    widget.components[0].text,
    /données Trello périmées : dernière lecture il y a \d+ min/,
  );
  const ack = await env.gladys.fake.sceneAction('get_cards', {});
  assert.match(ack.error, /Trello data out of date: last reading \d+ min ago/);
  // Back: the due long past fires nothing, no move from before the failure.
  failing = false;
  env.trello.boards.get(BOARD_HOME).cards[0].idList = LIST_DONE;
  const reads = env.trello.count('board');
  await env.wait(2 * HOUR);
  assert.ok(env.trello.count('board') > reads, 'read again');
  assert.equal(env.events().length, 0);
  assert.equal(env.status().connected, true);
});

// --- I3: a bounded stop --------------------------------------------------------------------

test('stop: under 3 s with a request hung and a /data that never answers, nothing left', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, { store, boards: [home([card(1, { name: 'A' })])] });
  env.trello.onPut = () => 'hang';
  const action = env.gladys.fake.sceneAction('move_card', {
    board: 'Maison',
    card: 'A',
    list: 'Terminé',
  });
  await env.wait(SECOND);
  assert.equal(env.trello.count('put'), 1, 'the PUT is in flight');
  store.save = () => new Promise(() => {});
  const t0 = env.clock.elapsed;
  const stopped = await env.run(env.app.stop().then(() => env.clock.elapsed));
  assert.ok(stopped - t0 <= 3 * SECOND, `${stopped - t0} ms`);
  const ack = await action;
  assert.equal(ack.data.outputs.result, 'unconfirmed', 'aborted: maybe written');
  assert.equal(env.clock.pending, 0, 'no timer left right after stop');
  store.save = async () => {};
});

test('stop: an action waiting for the slot or the gap ends at once, no timer left', async (t) => {
  const env = await start(t, { boards: [home([card(1, { name: 'A' }), card(2, { name: 'B' })])] });
  env.trello.onPut = () => 'hang';
  const first = env.gladys.fake.sceneAction('move_card', {
    board: 'Maison',
    card: 'A',
    list: 'Terminé',
  });
  await env.wait(SECOND);
  const queued = env.gladys.fake.sceneAction('move_card', {
    board: 'Maison',
    card: 'B',
    list: 'Terminé',
  });
  await env.app.idle();
  await env.app.stop();
  assert.equal(env.clock.pending, 0, 'no timer left right after stop');
  const [a, b] = await Promise.all([first, queued]);
  assert.equal(a.data.outputs.result, 'unconfirmed');
  assert.match(b.error, /Nothing sent to Trello: integration stopping/);
  assert.equal(env.trello.count('put'), 1);
});

// --- I4: the request slot, the readings, the pauses -----------------------------------------

test('"card due" is in /data before the event leaves (a hung Gladys never loses it)', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, { store, boards: [home([card(1, { due: NOW + 3 * MINUTE })])] });
  env.gladys.publishSceneEvent = () => new Promise(() => {});
  // The tick of 3:02 publishes (hung up to 20 s): looked at 8 s later.
  await env.wait(3 * MINUTE + 8 * SECOND);
  assert.equal(env.events().length, 0, 'the event is still hung');
  assert.ok(
    store.data.announced.some(([key]) => key.startsWith(card(1).id)),
    JSON.stringify(store.data.announced),
  );
});

test('an action queued behind a reading that gets a 429 sends nothing', async (t) => {
  const env = await start(t, { boards: [home([])] });
  env.trello.onBoard = () => later(env.clock, 2 * SECOND, text('slow down', 429));
  await env.wait(5 * MINUTE - SECOND); // setup already moved 2 s: the reading left at 5 min
  assert.equal(env.trello.count('board'), 2, 'the reading is in flight');
  // Called directly: it reaches the slot while the reading is still in flight.
  const err = await env.run(
    env.app.createCard({ board: 'Maison', list: 'À faire', name: 'x' }).catch((e) => e),
  );
  assert.match(err.message, /Nothing sent to Trello: paused/);
  assert.equal(env.trello.count('post'), 0);
});

test('scene actions take the slot before a reading waiting for it', async (t) => {
  const env = await start(t, { boards: [home([])] });
  let posts = 0;
  env.trello.onPost = () => (posts++ === 0 ? later(env.clock, 3 * SECOND) : undefined);
  const f = env.gladys.fake;
  await env.wait(5 * MINUTE - 3 * SECOND);
  const a = f.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'A' });
  await env.wait(2 * SECOND); // the reading of 5 min queues behind the slow POST
  const b = f.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'B' });
  await env.run(Promise.all([a, b]));
  await env.wait(2 * SECOND);
  const order = env.trello.requests.slice(2).map((r) => r.kind);
  assert.deepEqual(order, ['post', 'post', 'board']);
});

test('one reading at a time, and a reading stops at the first block', async (t) => {
  const env = await start(t, { boards: [home([]), work()] });
  const before = env.trello.count('board');
  const gen = env.app.generation;
  await env.run(Promise.all([env.app.cycle(gen), env.app.cycle(gen)]));
  assert.equal(env.trello.count('board') - before, 2, 'both boards once');
  env.trello.onBoard = (r) => (r.id === BOARD_HOME ? text('slow down', 429) : undefined);
  await env.wait(5 * MINUTE + SECOND);
  const last = env.trello.requests.slice(-1)[0];
  assert.equal(last.id, BOARD_HOME, 'the other board is not asked during the pause');
});

test('a 404 board: the member is read first at the next reading', async (t) => {
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onBoard = () => text('The requested resource was not found.', 404);
    },
  });
  await env.wait(5 * MINUTE + SECOND);
  assert.deepEqual(
    env.trello.requests.map((r) => r.kind),
    ['member', 'board', 'member', 'board'],
  );
});

test('a board no longer followed leaves memory', async (t) => {
  const env = await start(t, { boards: [home([]), work()] });
  assert.ok(env.app.boards.has(BOARD_HOME));
  await env.gladys.fake.configUpdated({ api_key: KEY, api_token: TOKEN, boards: 'Travail' });
  await env.wait(2 * SECOND);
  assert.equal(env.app.boards.has(BOARD_HOME), false);
});

test('pauses: doubled without Retry-After, capped at 6 h when read back from /data', async (t) => {
  const env = await start(t, {
    config: { api_key: KEY, api_token: TOKEN, poll_minutes: 2 },
    prepare: ({ trello }) => {
      trello.onMember = () => text('slow down', 429);
    },
  });
  await env.wait(20 * MINUTE);
  const at = env.trello.requests.map((r) => r.mono);
  const gaps = at.slice(1).map((v, i) => Math.round((v - at[i]) / SECOND));
  // 60 s and 120 s pauses hide behind the 2-min interval; then 240 s, 480 s.
  assert.ok(gaps[2] >= 240 && gaps[3] >= 480, `gaps ${gaps}`);
  const store = createMemoryStore({ version: 1, pause: { until: NOW + 48 * HOUR, step: 3 } });
  const env2 = await start(t, { store });
  await env2.wait(5 * HOUR + 50 * MINUTE);
  assert.equal(env2.trello.count(), 0);
  await env2.wait(15 * MINUTE);
  assert.ok(env2.trello.count('board') >= 1, 'resumes after 6 h at most');
  assert.equal(retryAfterMs('Sun, 15 Nov 2026 13:00:00 GMT', NOW), 0, 'a past date is 0');
});

test('the server clock: ignored under a minute, bounded to 12 h', async (t) => {
  const env = await start(t);
  env.app.noteDate(env.app.now() + 30 * SECOND);
  assert.equal(env.app.skew, 0);
  env.app.noteDate(env.app.now() + 20 * HOUR);
  assert.ok(Math.abs(env.app.skew - 12 * HOUR) < SECOND);
  env.app.noteDate(env.app.now() - 20 * HOUR);
  assert.ok(Math.abs(env.app.skew + 12 * HOUR) < SECOND);
});

test('the test button: one request per 10 s at most when it fails', async (t) => {
  const env = await start(t, { boards: [home([])] });
  env.trello.onMember = () => 'refused';
  await env.wait(MINUTE);
  const f = env.gladys.fake;
  const first = await env.run(f.action('test_connection'));
  assert.match(first.data.message.en, /^Test failed/);
  const second = await env.run(f.action('test_connection'));
  assert.match(second.data.message.en, /Tested a few seconds ago/);
  assert.equal(env.trello.count('member'), 2);
});

test('create a card: a list created since the reading is found (board read once more)', async (t) => {
  const b = home([]);
  const env = await start(t, { boards: [b] });
  b.lists.push({ id: 'c00000000000000000000099', name: 'Idées', closed: false, pos: 4 });
  await env.wait(2 * MINUTE);
  const reads = env.trello.count('board');
  const ack = await env.run(
    env.gladys.fake.sceneAction('create_card', { board: 'Maison', list: 'Idées', name: 'x' }),
  );
  assert.equal(ack.data.outputs.created, true);
  assert.equal(env.trello.count('board'), reads + 1);
});

test('create a card: an answer with the card in another list is not "created"', async (t) => {
  const env = await start(t, { boards: [home([])] });
  env.trello.onPost = () => ({ ...card(77), idList: LIST_DOING });
  const ack = await env.run(
    env.gladys.fake.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'x' }),
  );
  assert.deepEqual([ack.data.outputs.created, ack.data.outputs.result], [false, 'unconfirmed']);
});

test('a scene action request is bounded to 10 s', async (t) => {
  const env = await start(t, { boards: [home([card(1, { name: 'A' })])] });
  env.trello.onPut = () => 'hang';
  const t0 = env.clock.elapsed;
  const ack = await env.run(
    env.gladys.fake.sceneAction('move_card', { board: 'Maison', card: 'A', list: 'Terminé' }),
  );
  assert.equal(ack.data.outputs.result, 'unconfirmed');
  assert.ok(env.clock.elapsed - t0 <= 11 * SECOND, `${env.clock.elapsed - t0} ms`);
});

// --- Moves -----------------------------------------------------------------------------------

test('card moved: 20 events at most per reading', async (t) => {
  const b = home(Array.from({ length: 25 }, (_, i) => card(i + 1)));
  const env = await start(t, { boards: [b] });
  for (const c of b.cards) c.idList = LIST_DONE;
  await env.wait(5 * MINUTE + SECOND);
  assert.equal(env.events('card_moved').length, 20);
});

test('own moves: a real move elsewhere fires; once seen in its list, a real move back there fires', async (t) => {
  const b = home([card(1, { name: 'Payer' })]);
  const env = await start(t, { boards: [b] });
  const f = env.gladys.fake;
  await env.run(f.sceneAction('move_card', { board: 'Maison', card: 'Payer', list: 'Terminé' }));
  // The user moves it on to "En cours" before the next reading: that move fires.
  b.cards[0].idList = LIST_DOING;
  await env.wait(5 * MINUTE + SECOND);
  assert.deepEqual(
    env.events('card_moved').map((e) => e.data.list),
    ['En cours'],
  );
  // Module moves it to "Terminé" again; seen there; the user moves it out and back.
  await env.wait(MINUTE);
  await env.run(f.sceneAction('move_card', { board: 'Maison', card: 'Payer', list: 'Terminé' }));
  await env.wait(5 * MINUTE);
  b.cards[0].idList = LIST_TODO;
  await env.wait(5 * MINUTE);
  b.cards[0].idList = LIST_DONE;
  await env.wait(5 * MINUTE);
  assert.deepEqual(
    env.events('card_moved').map((e) => e.data.list),
    ['En cours', 'À faire', 'Terminé'],
  );
});

// --- Widget and configuration -----------------------------------------------------------------

test('widget: long names and emoji cut within the core limits, never half a character', async (t) => {
  const long = 'Tableau '.repeat(20);
  const env = await start(t, {
    boards: [
      board({
        name: long,
        lists: [{ id: LIST_TODO, name: 'Liste '.repeat(20), closed: false }],
        cards: [
          card(1, { name: `${'a'.repeat(59)}😀 suite`, due: NOW - HOUR }),
          card(2, { name: '😀'.repeat(60), due: NOW + HOUR }),
        ],
      }),
    ],
  });
  const content = (await env.gladys.fake.widgetGet('cards', { language: 'fr' })).data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  for (const item of content.components.find((c) => c.type === 'card-list').items) {
    assert.ok(item.title.length <= 60 && item.subtitle.length <= 60);
    assert.doesNotMatch(item.title, /[\ud800-\udbff](?![\udc00-\udfff])/, 'no lone surrogate');
    assert.match(item.subtitle, / · Liste/, 'the list stays readable');
  }
});

test('an unknown time zone is said in the status', async (t) => {
  const env = await start(t, {
    config: { api_key: KEY, api_token: TOKEN, time_zone: 'Mars/Base' },
  });
  assert.match(statusText(env), /time zone not known: dates shown in Europe\/Paris/);
});

test('a 429 with Retry-After: 0 still pauses 60 s', async (t) => {
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onBoard = () => text('slow down', 429, { 'retry-after': '0' });
    },
  });
  assert.ok(env.app.pause.due - env.clock.elapsed >= 55 * SECOND);
});

test('stop: an action sleeping in the 300 ms gap ends at once, no timer left', async (t) => {
  const env = await start(t, { boards: [home([card(1, { name: 'A' })])] });
  await env.wait(MINUTE);
  const first = env.app.createCard({ board: 'Maison', list: 'À faire', name: 'x' });
  await env.app.idle();
  const second = env.app.createCard({ board: 'Maison', list: 'À faire', name: 'y' });
  await env.app.idle();
  assert.equal(env.trello.count('post'), 1, 'the second waits for the gap');
  await env.app.stop();
  assert.equal(env.clock.pending, 0, 'no timer left right after stop');
  assert.equal((await first).created, true);
  await assert.rejects(second, /Nothing sent to Trello: integration stopping/);
});

test('a board answering "invalid token": the other boards wait for the member check', async (t) => {
  const env = await start(t, { boards: [home([]), work()] });
  env.trello.onBoard = (r) => (r.id === BOARD_HOME ? text('invalid token', 401) : undefined);
  const before = env.trello.requests.length;
  await env.wait(5 * MINUTE + SECOND);
  assert.deepEqual(
    env.trello.requests.slice(before).map((r) => r.id ?? r.kind),
    [BOARD_HOME],
  );
});

test('the status is sent once per change, not at every reading', async (t) => {
  const env = await start(t);
  const sent = env.gladys.fake.connectionStatuses.length;
  await env.wait(20 * MINUTE);
  assert.equal(env.gladys.fake.connectionStatuses.length, sent);
});

test('answers to replaced credentials: no refusal, no pause', async (t) => {
  const env = await start(t);
  await env.app.refuse('token', 'other\u0000credentials');
  assert.equal(env.app.refused, undefined, 'never the credentials held now');
  const held = deferred();
  env.trello.onMember = (r) => (usesToken(r, TOKEN) ? held.promise : undefined);
  await env.wait(HOUR);
  await env.gladys.fake.configUpdated({ api_key: KEY, api_token: TOKEN2 });
  held.resolve(text('oops', 503));
  await env.wait(2 * SECOND);
  assert.equal(env.app.pause, undefined, 'a 5xx to the old token pauses nothing');
  assert.ok(env.trello.requests.some((r) => usesToken(r, TOKEN2) && r.kind === 'board'));
});

// --- Review r2 -------------------------------------------------------------------------------

test('an unreadable board among two: the other read, the bad one spaced and said', async (t) => {
  const env = await start(t, {
    boards: [home([]), work()],
    prepare: ({ trello }) => {
      trello.onBoard = (r) => (r.id === BOARD_HOME ? { ...work(), id: 'b'.repeat(24) } : undefined);
    },
  });
  const reads = (id) => env.trello.requests.filter((r) => r.id === id).length;
  await env.wait(10 * MINUTE + SECOND);
  assert.equal(reads(BOARD_WORK), 3, 'the other board at every reading');
  assert.equal(reads(BOARD_HOME), 2, 'the unreadable one spaced (5 then 10 min)');
  assert.match(
    statusText(env),
    /1\/2 boards read, 0 overdue cards; 1 not read \(unreadable answer\)/,
  );
});

test('an unreadable member: "unreadable answer", never "replaced credentials"', async (t) => {
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () => ({ username: 'no id' });
    },
  });
  assert.equal(env.app.memberError, 'invalid');
  assert.match(statusText(env), /^Trello not read: unreadable answer/);
});

test('the test button during a pause says the pause, fresh member or not', async (t) => {
  const fresh = await start(t, {
    prepare: ({ trello }) => {
      trello.onBoard = () => text('slow down', 429, { 'retry-after': '600' });
    },
  });
  const now = await fresh.run(fresh.gladys.fake.action('test_connection'));
  assert.match(now.data.message.en, /^Test failed: paused/);
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () => text('slow down', 429, { 'retry-after': '1800' });
    },
  });
  await env.wait(MINUTE);
  const ack = await env.run(env.gladys.fake.action('test_connection'));
  assert.match(ack.data.message.en, /^Test failed: paused after a Trello slow-down request/);
});

test('the widget keeps a reading 30 min even with a 2-min interval, then says out of date', async (t) => {
  let failing = false;
  const env = await start(t, {
    config: { api_key: KEY, api_token: TOKEN, poll_minutes: 2 },
    boards: [home([card(1, { name: 'Appeler', due: NOW - HOUR })])],
    prepare: ({ trello }) => {
      trello.onBoard = () => (failing ? text('oops', 500) : undefined);
    },
  });
  failing = true;
  await env.wait(25 * MINUTE);
  const kept = (await env.gladys.fake.widgetGet('cards', {})).data.content;
  assert.ok(
    kept.components.some((c) => c.type === 'card-list'),
    'still shown at 25 min',
  );
  await env.wait(10 * MINUTE);
  const old = (await env.gladys.fake.widgetGet('cards', {})).data.content;
  assert.match(old.components[0].text, /Trello data out of date/);
});

test('stop: under 3 s while Gladys does not answer an event', async (t) => {
  const env = await start(t, { boards: [home([card(1, { due: NOW + 3 * MINUTE })])] });
  env.gladys.publishSceneEvent = () => new Promise(() => {});
  await env.wait(3 * MINUTE + 5 * SECOND);
  const t0 = env.clock.elapsed;
  const stopped = await env.run(env.app.stop().then(() => env.clock.elapsed));
  assert.ok(stopped - t0 <= 3 * SECOND, `${stopped - t0} ms`);
});

test('the status says the readings are out of date', async (t) => {
  const env = await start(t);
  env.app.boards.get(BOARD_HOME).readMono -= 40 * MINUTE;
  await env.app.publishStatus();
  assert.match(statusText(env), /Trello data out of date: last reading 40 min ago/);
});

test('a reading that fails during an action is "nothing sent", never "refused by Trello"', async (t) => {
  const env = await start(t, { boards: [home([card(1, { name: 'A' })])] });
  await env.wait(2 * MINUTE);
  env.trello.onBoard = () => text('oops', 500);
  const ack = await env.run(
    env.gladys.fake.sceneAction('move_card', { board: 'Maison', card: 'A', list: 'Terminé' }),
  );
  assert.match(ack.error, /^Nothing sent to Trello: Trello server error/);
  assert.equal(env.trello.count('put'), 0);
});

test('an action whose board answer comes after stop: "integration stopping"', async (t) => {
  const env = await start(t, { boards: [home([card(1, { name: 'A' })])] });
  await env.wait(2 * MINUTE);
  const held = deferred();
  env.trello.onBoard = () => held.promise; // ignores the abort, answers later
  const action = env.app.moveCard({ board: 'Maison', card: 'A', list: 'Terminé' }).catch((e) => e);
  await env.app.idle();
  await env.app.stop();
  held.resolve(undefined);
  const err = await action;
  assert.match(err.message, /Nothing sent to Trello: integration stopping/);
});

test('stop with a request in flight and one queued: the slot is not leaked after a reconnection', async (t) => {
  const env = await start(t, { boards: [home([])] });
  const held = deferred();
  env.trello.onPost = () => held.promise;
  const first = env.app.createCard({ board: 'Maison', list: 'À faire', name: 'a' }).catch((e) => e);
  await env.app.idle();
  const queued = env.app
    .createCard({ board: 'Maison', list: 'À faire', name: 'b' })
    .catch((e) => e);
  await env.app.idle();
  await env.run(env.app.stop());
  held.resolve(undefined);
  env.trello.onPost = undefined;
  await Promise.all([first, queued]);
  await env.app.connected();
  await env.wait(2 * SECOND);
  const later = await env.run(
    env.app.createCard({ board: 'Maison', list: 'À faire', name: 'later' }).catch((e) => e),
  );
  assert.equal(later.created, true, String(later.message ?? ''));
  assert.equal(env.app.busy, false);
});

test('replaced credentials: only an error carrying other credentials than the current ones', async (t) => {
  const { TrelloError } = await import('../src/http.js');
  const env = await start(t);
  const current = `${KEY}\u0000${TOKEN}`;
  const err = (creds) => Object.assign(new TrelloError('paused', 'x', { sent: false }), { creds });
  assert.equal(env.app.replaced(err(undefined)), false, 'refused before sending: the current ones');
  assert.equal(env.app.replaced(err(current)), false);
  assert.equal(env.app.replaced(err(`${KEY}\u0000${TOKEN2}`)), true);
});
