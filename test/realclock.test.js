// -----------------------------------------------------------------------------
// The real clock (performance.now, setTimeout) sped up 60 times and a real
// local HTTP server: the boards are read once per interval (2 min here), never
// sooner, the credentials go in the Authorization header, a scene action is
// answered, and nothing leaves after stop. Wide margins: a timer is late under
// load, never early.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { API_BASE } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { LIST_DONE, board, card, member } from './fixtures/trello.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

const MINUTE = 60_000;
const KEY = '0123456789abcdef0123456789abcdef';
const TOKEN = `ATTA${'c3'.repeat(32)}`;

test('real clock: one reading every 2 min, a move answered, nothing after stop', async (t) => {
  const clock = realClock({ speed: 60 });
  const b = board({ cards: [card(1, { name: 'Vaisselle' })] });
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: u.pathname, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (u.pathname === '/1/members/me') return res.end(JSON.stringify(member([b])));
      if (req.method === 'PUT') {
        b.cards[0].idList = JSON.parse(body).idList;
        return res.end(JSON.stringify(b.cards[0]));
      }
      res.end(JSON.stringify(b));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/1`;
  const gladys = createFakeGladys({
    selector: 'trello',
    config: { api_key: KEY, api_token: TOKEN, poll_minutes: 2 },
  });
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: (url, init) => fetch(String(url).replace(API_BASE, base), init),
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const spy = spyOn(app, 'cycle', clock);
  gladys.onSceneAction('move_card', (fields) => app.moveCard(fields));
  await gladys.connect();
  await app.connected();
  const gaps = await measurePeriod(spy, {
    count: 3,
    period: 2 * MINUTE,
    max: 2 * 2 * MINUTE,
    timeoutMs: 30_000,
  });
  assert.equal(gaps.length, 2);
  const boards = () => requests.filter((r) => r.path.startsWith('/1/boards/')).length;
  const deadline = performance.now() + 10_000;
  while (boards() < 3 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(boards(), 3, 'one reading per period');
  assert.equal(requests.filter((r) => r.path === '/1/members/me').length, 1, 'member hourly');
  assert.equal(requests[0].auth, `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`);
  const ack = await gladys.fake.sceneAction('move_card', {
    board: 'Maison',
    card: 'vaisselle',
    list: 'Terminé',
  });
  assert.equal(ack.data.outputs.moved, true);
  assert.equal(b.cards[0].idList, LIST_DONE);
  await app.stop();
  const count = requests.length;
  const timers = clock.timersSet;
  await clock.sleep(10 * MINUTE);
  assert.equal(requests.length, count, 'no request after stop');
  assert.equal(clock.timersSet, timers, 'no timer after stop');
});
