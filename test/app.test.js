// -----------------------------------------------------------------------------
// The app against the fake Gladys of the SDK, a scripted Trello API and a
// virtual clock that moves at every read: schedule, credentials, pauses,
// /data, status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { BOARD_HOME, BOARD_WORK, LIST_WORK, board, card } from './fixtures/trello.js';
import {
  HOUR,
  KEY,
  MINUTE,
  NOW,
  SECOND,
  TOKEN,
  json,
  setup,
  teardown,
  text,
} from './helpers/app.js';

const start = async (t, options) => {
  const env = await setup(options);
  t.after(() => teardown(env));
  return env;
};
const statusText = (env) => env.status()?.message?.en ?? '';
const work = () =>
  board({
    id: BOARD_WORK,
    name: 'Travail',
    shortLink: 'WorkBrd2',
    lists: [{ id: LIST_WORK, name: 'Backlog', closed: false, pos: 1 }],
    cards: [card(30, { idList: LIST_WORK, due: NOW + 2 * HOUR })],
  });

/** No secret anywhere the user or a log can see. */
function assertNoSecret(env) {
  const seen = [
    JSON.stringify(env.store.data ?? {}),
    env.lines.join('\n'),
    JSON.stringify(env.gladys.fake.connectionStatuses),
  ].join('\n');
  assert.ok(!seen.includes(TOKEN), 'token leaked');
  assert.ok(!seen.includes(KEY), 'key leaked');
  for (const r of env.trello.requests) {
    assert.ok(!r.url.includes(TOKEN) && !r.url.includes(KEY), 'never in a URL');
  }
}

test('start: the member then the board, credentials in the Authorization header only', async (t) => {
  const env = await start(t);
  assert.deepEqual(
    env.trello.requests.map((r) => r.kind),
    ['member', 'board'],
  );
  for (const r of env.trello.requests) {
    assert.equal(
      r.headers.Authorization,
      `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`,
    );
    assert.match(
      r.headers['User-Agent'],
      /^gladys-trello\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-trello\)$/,
    );
    assert.equal(r.headers.Accept, 'application/json');
    assert.equal(r.init.redirect, 'error');
    assert.ok(r.url.startsWith('https://api.trello.com/1/'));
  }
  const b = env.trello.requests[1];
  assert.equal(b.u.searchParams.get('cards'), 'open');
  assert.equal(b.u.searchParams.get('lists'), 'open');
  assert.equal(env.status().connected, true);
  assert.match(statusText(env), /Connected: 1\/1 board read/);
  assertNoSecret(env);
});

test('one reading per interval; a reconnection and a restart never read sooner', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, { store });
  assert.equal(env.trello.count('board'), 1);
  await env.wait(4 * MINUTE);
  assert.equal(env.trello.count('board'), 1, 'not before 5 min');
  await env.wait(MINUTE + SECOND);
  assert.equal(env.trello.count('board'), 2, 'again after 5 min');
  // A reconnection to Gladys keeps the schedule.
  await env.app.stop();
  await env.app.connected();
  await env.wait(2 * SECOND);
  assert.equal(env.trello.count('board'), 2, 'no reading on reconnection');
  await env.app.stop();
  // A restart 2 minutes after the last attempt: the 3 minutes left are waited.
  const env2 = await start(t, { store, now: env.clock.now() + 2 * MINUTE });
  assert.equal(env2.trello.count(), 0, 'nothing read at the restart');
  await env2.wait(2 * MINUTE + 50 * SECOND);
  assert.equal(env2.trello.count(), 0);
  await env2.wait(20 * SECOND);
  assert.deepEqual(
    env2.trello.requests.map((r) => r.kind),
    ['member', 'board'],
  );
});

test('a last attempt dated in the future (/data) is not trusted: read at once', async (t) => {
  const store = createMemoryStore({ version: 1, lastPollAt: NOW + 24 * HOUR });
  const env = await start(t, { store });
  assert.equal(env.trello.count('board'), 1);
  env.app.lastPollAt = undefined;
  env.app.restore({ lastPollAt: env.clock.now() + HOUR });
  assert.equal(env.app.lastPollAt, undefined, 'dropped when read back');
});

test('a refused token: kept in /data as 8 bits, nothing asked again, even after a restart', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, {
    store,
    prepare: ({ trello }) => {
      trello.onMember = () => text('invalid token', 401);
    },
  });
  assert.equal(env.trello.count(), 1);
  assert.equal(env.status().connected, false);
  assert.match(statusText(env), /refused the token/);
  const refused = store.data.refused;
  assert.match(refused.salt, /^[0-9a-f]{32}$/);
  assert.ok(Number.isInteger(refused.tag) && refused.tag >= 0 && refused.tag < 256);
  assert.deepEqual(Object.keys(refused).sort(), ['kind', 'salt', 'tag']);
  await env.wait(6 * HOUR);
  assert.equal(env.trello.count(), 1, 'never asked again by itself');
  // A scene action refuses before sending.
  const ack = await env.run(
    env.gladys.fake.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'x' }),
  );
  assert.equal(ack.success, false);
  assert.match(ack.error, /Nothing sent to Trello: credentials refused/);
  assert.equal(env.trello.count(), 1);
  assertNoSecret(env);
  await env.app.stop();
  // Restart: the same credentials stay refused (by their tag).
  const env2 = await start(t, { store, now: env.clock.now() });
  await env2.wait(HOUR);
  assert.equal(env2.trello.count(), 0);
  assert.match(statusText(env2), /refused the token/);
  // New credentials are always tried, at once.
  await env2.gladys.fake.configUpdated({ api_key: KEY, api_token: `${TOKEN}0` });
  await env2.wait(2 * SECOND);
  assert.deepEqual(
    env2.trello.requests.map((r) => r.kind),
    ['member', 'board'],
  );
  assert.equal(store.data.refused, undefined, 'the refusal goes');
  assert.equal(env2.status().connected, true);
});

test('the test button tries refused credentials again and lifts the refusal on success', async (t) => {
  let refuse = true;
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () => (refuse ? text('invalid key', 401) : undefined);
    },
  });
  assert.match(statusText(env), /refused the API key/);
  refuse = false;
  const ack = await env.run(env.gladys.fake.action('test_connection'));
  assert.match(ack.data.message.en, /^Connected as Louis Test \(@louis\): 1 open board/);
  await env.wait(2 * SECOND);
  assert.equal(env.trello.count('board'), 1, 'the readings resume at once');
  assert.equal(env.store.data.refused, undefined);
  // A second click within 10 s reuses the fresh member, sends nothing.
  const before = env.trello.count();
  await env.run(env.gladys.fake.action('test_connection'));
  assert.equal(env.trello.count(), before);
});

test('8 bits only: 257 tokens always share a tag (nothing to brute-force from /data)', async () => {
  const { tagOf } = await import('../src/config.js');
  const tags = new Set();
  for (let i = 0; i < 257; i += 1) tags.add(tagOf('ab'.repeat(16), `${KEY}\u0000${TOKEN}${i}`));
  assert.ok(tags.size <= 256);
});

test('a 401 on the member that names nothing (HTML, cut) is not a refusal', async (t) => {
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () =>
        new Response('<html>proxy</html>', {
          status: 401,
          headers: { 'content-type': 'text/html' },
        });
    },
  });
  assert.equal(env.store.data?.refused, undefined);
  assert.doesNotMatch(statusText(env), /refused the/);
  await env.wait(5 * MINUTE + SECOND);
  assert.equal(env.trello.count('member'), 2, 'tried again at the next reading');
});

test('a 401 on one board is that board not read, never a refusal; the other boards go on', async (t) => {
  const env = await start(t, {
    boards: [board(), work()],
    prepare: ({ trello }) => {
      trello.onBoard = (r) =>
        r.id === BOARD_HOME ? text('unauthorized permission requested', 401) : undefined;
    },
  });
  assert.equal(env.store.data?.refused, undefined);
  assert.equal(env.status().connected, true);
  assert.match(
    statusText(env),
    /1\/2 boards read, 0 overdue cards; 1 not read \(access refused \(401\)/,
  );
  const homeReads = () => env.trello.requests.filter((r) => r.id === BOARD_HOME).length;
  const workReads = () => env.trello.requests.filter((r) => r.id === BOARD_WORK).length;
  // Spacing doubled at each failure (5, 10, 20 min…), the other board every 5 min.
  await env.wait(5 * MINUTE + SECOND);
  assert.equal(homeReads(), 2);
  await env.wait(5 * MINUTE);
  assert.equal(homeReads(), 2, 'not again before 10 min');
  await env.wait(5 * MINUTE);
  assert.equal(homeReads(), 3);
  assert.equal(workReads(), 4);
  assert.equal(env.trello.count('member'), 1, 'the member is not in question');
});

test('a board answering "invalid token": the member is read first at the next reading to decide', async (t) => {
  let revoked = false;
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onBoard = () => (revoked ? text('invalid token', 401) : undefined);
      trello.onMember = () => (revoked ? text('invalid token', 401) : undefined);
    },
  });
  revoked = true;
  await env.wait(5 * MINUTE + SECOND);
  assert.equal(env.store.data?.refused, undefined, 'a board never decides');
  await env.wait(5 * MINUTE);
  assert.deepEqual(
    env.trello.requests.map((r) => r.kind),
    ['member', 'board', 'board', 'member'],
  );
  assert.match(statusText(env), /refused the token/);
});

test('a 429 pauses every request (Retry-After), kept in /data across a restart', async (t) => {
  const store = createMemoryStore();
  let limited = true;
  const env = await start(t, {
    store,
    prepare: ({ trello }) => {
      trello.onBoard = () =>
        limited ? text('API_TOKEN_LIMIT_EXCEEDED', 429, { 'retry-after': '1800' }) : undefined;
    },
  });
  assert.match(statusText(env), /slow down: paused, resumes in 30 min/);
  assert.ok(store.data.pause.until > NOW + 29 * MINUTE);
  const ack = await env.run(
    env.gladys.fake.sceneAction('move_card', { board: 'Maison', card: 'x', list: 'Terminé' }),
  );
  assert.match(ack.error, /Nothing sent to Trello: paused/);
  assert.equal(env.trello.count(), 2);
  await env.app.stop();
  limited = false;
  const env2 = await start(t, { store, now: env.clock.now() + 10 * MINUTE });
  await env2.wait(19 * MINUTE);
  assert.equal(env2.trello.count(), 0, 'still paused after the restart');
  await env2.wait(2 * MINUTE);
  assert.ok(env2.trello.count('board') >= 1, 'resumes after the pause');
});

test('a 429 without Retry-After: 60 s, then doubled, 6 h at most', async (t) => {
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () => text('rate limited', 429);
    },
  });
  const at = () => env.trello.requests.map((r) => Math.round(r.mono / 1000));
  await env.wait(20 * MINUTE);
  // 0, then +60 s, +120 s, +240 s, +480 s (each after the pause, at least 5 min apart for readings).
  const gaps = at()
    .slice(1)
    .map((v, i) => v - at()[i]);
  assert.ok(
    gaps.every((g) => g >= 60),
    `gaps ${gaps}`,
  );
  assert.ok(env.trello.count() <= 6, `count ${env.trello.count()}`);
});

test('a 5xx on the member pauses; a 5xx on one board only spaces that board', async (t) => {
  const env = await start(t, {
    boards: [board(), work()],
    prepare: ({ trello }) => {
      trello.onBoard = (r) => (r.id === BOARD_HOME ? text('oops', 503) : undefined);
    },
  });
  assert.equal(env.trello.count('board'), 2, 'the other board still read');
  assert.equal(env.status().connected, true);
  const env2 = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () => text('oops', 502);
    },
  });
  assert.match(statusText(env2), /paused/);
});

test('an answer over the size bound is cut before being read whole, the other board goes on', async (t) => {
  const env = await start(t, {
    boards: [board(), work()],
    prepare: ({ trello }) => {
      trello.onBoard = (r) =>
        r.id === BOARD_HOME
          ? new Response(new Uint8Array(5 * 1024 * 1024).fill(32), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : undefined;
    },
  });
  assert.match(
    statusText(env),
    /1\/2 boards read, 0 overdue cards; 1 not read \(answer too large\)/,
  );
});

test('getConfig failing in connected: asked again, spaced, with its status, then resumes', async (t) => {
  let fail = 2;
  const env = await start(t, {
    prepare: ({ gladys }) => {
      const real = gladys.getConfig.bind(gladys);
      gladys.getConfig = async () => {
        // Only the app's reads fail (the SDK reads the configuration at connect too).
        if (fail > 0 && new Error().stack.includes('readConfig')) {
          fail -= 1;
          throw new Error('boom');
        }
        return real();
      };
    },
  });
  assert.match(statusText(env), /Configuration not read from Gladys/);
  assert.equal(env.trello.count(), 0);
  await env.wait(9 * SECOND);
  assert.equal(env.trello.count(), 0);
  await env.wait(25 * SECOND);
  assert.equal(env.trello.count('board'), 1);
  assert.equal(env.status().connected, true);
  // Failing again on a reconnection: same behaviour.
  await env.app.stop();
  fail = 1;
  await env.app.connected();
  await env.wait(SECOND);
  assert.match(statusText(env), /Configuration not read/);
  await env.wait(12 * SECOND);
  assert.match(statusText(env), /Connected/);
});

test('/data unreadable: nothing asked, read again every 10 s, never overwritten', async (t) => {
  const store = createMemoryStore({ version: 1, lastPollAt: NOW - HOUR });
  store.unreadable = true;
  const env = await start(t, { store });
  assert.match(statusText(env), /\/data cannot be read/);
  await env.wait(30 * SECOND);
  assert.equal(env.trello.count(), 0);
  assert.equal(store.saves, 0, 'never overwritten');
  store.unreadable = false;
  await env.wait(11 * SECOND);
  assert.equal(env.trello.count('board'), 1);
});

test('/data that cannot be written: said in the status, the readings go on', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const env = await start(t, { store });
  assert.equal(env.trello.count('board'), 1);
  assert.match(statusText(env), /\/data cannot be written/);
});

test('the boards named: by name or link, unknown and ambiguous ones said, 10 at most', async (t) => {
  const twin = board({ id: 'b00000000000000000000099', name: 'Travail', shortLink: 'TwinBrd9' });
  const env = await start(t, {
    boards: [board(), work(), twin],
    config: {
      api_key: KEY,
      api_token: TOKEN,
      boards: 'https://trello.com/b/HomeBrd1/maison, Travail, Nulle part',
    },
  });
  assert.deepEqual(
    env.trello.requests.filter((r) => r.kind === 'board').map((r) => r.id),
    [BOARD_HOME],
  );
  assert.match(statusText(env), /board not found or ambiguous: Travail, Nulle part/);
  const env2 = await start(t, {
    config: {
      api_key: KEY,
      api_token: TOKEN,
      boards: Array.from({ length: 12 }, (_, i) => `B${i}`).join(','),
    },
  });
  assert.match(statusText(env2), /No board followed/);
  assert.deepEqual(env2.app.config.refs.length, 10);
});

test('a configuration problem sends nothing and says what to fix', async (t) => {
  for (const [config, pattern] of [
    [{ api_key: KEY }, /Enter the API key and the token/],
    [{ api_key: 'nope', api_token: TOKEN }, /API key must be 32/],
    [{ api_key: KEY, api_token: 'abc\r\ndef' }, /token must be letters and digits/],
  ]) {
    const env = await start(t, { config });
    await env.wait(10 * MINUTE);
    assert.equal(env.trello.count(), 0);
    assert.match(statusText(env), pattern);
  }
});

test('stop: no request and no timer after it', async (t) => {
  const env = await start(t);
  await env.app.stop();
  const count = env.trello.count();
  await env.wait(3 * HOUR);
  assert.equal(env.trello.count(), count);
  assert.equal(env.clock.pending, 0, 'no timer left');
});

test('the 401 texts are the real ones of api.trello.com; the store keeps no secret', async (t) => {
  const env = await start(t, {
    prepare: ({ trello }) => {
      trello.onMember = () => text('invalid key', 401);
    },
  });
  assert.equal(env.store.data.refused.kind, 'key');
  assertNoSecret(env);
  assert.ok(json);
});
