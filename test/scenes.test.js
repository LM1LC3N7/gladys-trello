// -----------------------------------------------------------------------------
// Scene triggers, scene actions and the widget against the fake Gladys and a
// scripted Trello API on a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
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
import { HOUR, MINUTE, NOW, SECOND, setup, teardown, text } from './helpers/app.js';

const start = async (t, options) => {
  const env = await setup(options);
  t.after(() => teardown(env));
  return env;
};
const home = (cards) => board({ cards });

test('card due: fired once when the clock reaches it, with its variables', async (t) => {
  const store = createMemoryStore();
  const env = await start(t, {
    store,
    boards: [
      home([card(1, { name: 'Payer le loyer', due: NOW + 30 * MINUTE, labels: ['Maison'] })]),
    ],
  });
  assert.equal(env.events().length, 0);
  await env.wait(29 * MINUTE);
  assert.equal(env.events().length, 0, 'not before its due');
  await env.wait(2 * MINUTE);
  const due = env.events('card_due');
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].data, {
    board: 'Maison',
    list: 'À faire',
    name: 'Payer le loyer',
    due: '2026-11-15T14:50:00.000Z',
    due_local: '2026-11-15 15:50',
    url: 'https://trello.com/c/Crd00001',
    labels: 'Maison',
  });
  // A crash right now (no clean stop): /data as it is at this instant.
  const crashed = structuredClone(store.data);
  const crashAt = env.clock.now();
  await env.wait(2 * HOUR);
  assert.equal(env.events('card_due').length, 1, 'once only');
  // A restart within the grace: remembered in /data, not fired again.
  await env.app.stop();
  const env2 = await start(t, {
    store: createMemoryStore(crashed),
    now: crashAt + MINUTE,
    boards: [home([card(1, { name: 'Payer le loyer', due: NOW + 30 * MINUTE })])],
  });
  await env2.wait(10 * MINUTE);
  assert.equal(env2.events().length, 0);
});

test('card due: a due already past when first read is not fired (stale), a fresh one is', async (t) => {
  const env = await start(t, {
    boards: [
      home([
        card(1, { due: NOW - 2 * HOUR }),
        card(2, { due: NOW - 2 * MINUTE }),
        card(3, { due: NOW - MINUTE, dueComplete: true }),
      ]),
    ],
  });
  await env.wait(2 * MINUTE);
  assert.deepEqual(
    env.events('card_due').map((e) => e.data.name),
    ['Card 2'],
  );
});

test('card due: the server clock (Date header) decides when ours is far off', async (t) => {
  const env = await start(t, {
    boards: [home([card(1, { due: NOW + 30 * MINUTE })])],
    prepare: ({ trello, clock }) => {
      trello.date = () => clock.now() + 20 * MINUTE;
    },
  });
  await env.wait(11 * MINUTE);
  assert.equal(env.events('card_due').length, 1, 'due for Trello 20 min earlier');
});

test('card moved: fired on a move seen between two readings, never on the first one', async (t) => {
  const b = home([card(1, { name: 'Courses' }), card(2)]);
  const env = await start(t, { boards: [b] });
  assert.equal(env.events().length, 0);
  b.cards[0].idList = LIST_DONE;
  await env.wait(5 * MINUTE + SECOND);
  assert.deepEqual(env.events('card_moved'), [
    {
      key: 'card_moved',
      data: {
        board: 'Maison',
        list: 'Terminé',
        from_list: 'À faire',
        name: 'Courses',
        due: null,
        due_local: null,
        url: 'https://trello.com/c/Crd00001',
      },
    },
  ]);
});

test('move a card: by name, confirmed by the answer, no "card moved" event (no loop)', async (t) => {
  const b = home([card(1, { name: 'Sortir les poubelles' }), card(2, { name: 'Arroser' })]);
  const env = await start(t, { boards: [b] });
  const ack = await env.run(
    env.gladys.fake.sceneAction('move_card', {
      board: 'maison',
      card: 'sortir les POUBELLES',
      list: 'Terminé',
    }),
  );
  assert.deepEqual(ack.data.outputs, {
    moved: true,
    result: 'moved',
    name: 'Sortir les poubelles',
    from_list: 'À faire',
    list: 'Terminé',
    url: 'https://trello.com/c/Crd00001',
  });
  const put = env.trello.requests.find((r) => r.kind === 'put');
  assert.deepEqual(put.body, { idList: LIST_DONE, pos: 'top' });
  await env.wait(15 * MINUTE);
  assert.equal(env.events('card_moved').length, 0);
});

test('move a card: by link; ambiguous or unknown names send nothing', async (t) => {
  const b = home([card(1, { name: 'Appeler maman' }), card(2, { name: 'Appeler papa' })]);
  const env = await start(t, { boards: [b] });
  const f = env.gladys.fake;
  const byLink = await env.run(
    f.sceneAction('move_card', {
      board: 'Maison',
      card: 'https://trello.com/c/Crd00002/appeler-papa',
      list: 'En cours',
    }),
  );
  assert.equal(byLink.data.outputs.moved, true);
  assert.equal(b.cards[1].idList, LIST_DOING);
  const ambiguous = await env.run(
    f.sceneAction('move_card', { board: 'Maison', card: 'appeler', list: 'Terminé' }),
  );
  assert.match(ambiguous.error, /^Nothing sent to Trello: several cards match "appeler"/);
  const unknown = await env.run(
    f.sceneAction('move_card', { board: 'Maison', card: 'Appeler maman', list: 'Nulle part' }),
  );
  assert.match(unknown.error, /no open list "Nulle part"/);
  const noBoard = await env.run(
    f.sceneAction('move_card', { board: 'Bureau', card: 'x', list: 'y' }),
  );
  assert.match(noBoard.error, /no open board "Bureau"/);
  assert.equal(env.trello.count('put'), 1);
});

test('move a card: already there, not applied, unconfirmed', async (t) => {
  const b = home([card(1, { name: 'A', idList: LIST_DONE }), card(2, { name: 'B' })]);
  const env = await start(t, { boards: [b] });
  const f = env.gladys.fake;
  const already = await env.run(
    f.sceneAction('move_card', { board: 'Maison', card: 'A', list: 'Terminé' }),
  );
  assert.equal(already.data.outputs.result, 'already');
  assert.equal(env.trello.count('put'), 0);
  // Trello answers with the card still in its list: not a success.
  env.trello.onPut = () => ({ ...b.cards[1] });
  const notApplied = await env.run(
    f.sceneAction('move_card', { board: 'Maison', card: 'B', list: 'Terminé' }),
  );
  assert.deepEqual(
    [notApplied.data.outputs.moved, notApplied.data.outputs.result],
    [false, 'not_applied'],
  );
  // Sent, no answer: neither success nor refusal, never sent again, the board read back.
  env.trello.onPut = (r) => {
    b.cards[1].idList = r.body.idList;
    return 'timeout';
  };
  const boards = env.trello.count('board');
  const unconfirmed = await env.run(
    f.sceneAction('move_card', { board: 'Maison', card: 'B', list: 'Terminé' }),
  );
  assert.deepEqual(
    [unconfirmed.success, unconfirmed.data.outputs.moved, unconfirmed.data.outputs.result],
    [true, false, 'unconfirmed'],
  );
  assert.equal(env.trello.count('put'), 2);
  await env.wait(6 * SECOND);
  assert.equal(env.trello.count('board'), boards + 1, 'read back');
  assert.equal(env.events('card_moved').length, 0, 'its own move fires nothing');
});

test('create a card: in the list, due computed, never sent twice', async (t) => {
  const b = home([]);
  const env = await start(t, { boards: [b] });
  const f = env.gladys.fake;
  const ack = await env.run(
    f.sceneAction('create_card', {
      board: 'Maison',
      list: 'a faire',
      name: '  Changer\nle filtre  ',
      description: 'Ligne 1\nLigne 2',
      due_in_minutes: 90,
      position: 'top',
    }),
  );
  assert.equal(ack.data.outputs.created, true);
  assert.equal(ack.data.outputs.list, 'À faire');
  const post = env.trello.requests.find((r) => r.kind === 'post');
  assert.equal(post.body.idList, LIST_TODO);
  assert.equal(post.body.name, 'Changer le filtre');
  assert.equal(post.body.desc, 'Ligne 1\nLigne 2');
  assert.equal(post.body.pos, 'top');
  assert.ok(Math.abs(Date.parse(post.body.due) - (env.clock.now() + 90 * MINUTE)) < 5 * SECOND);
  assert.ok(!post.url.includes('Changer'), 'user text in the body, never in the URL');
  // Sent without an answer: "unconfirmed", not sent again.
  env.trello.onPost = () => 'reset';
  const lost = await env.run(
    f.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'Encore' }),
  );
  assert.deepEqual([lost.data.outputs.created, lost.data.outputs.result], [false, 'unconfirmed']);
  assert.equal(env.trello.count('post'), 2);
  // Not reachable at all (connection refused): nothing sent, said so.
  env.trello.onPost = () => 'refused';
  const down = await env.run(
    f.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'Encore' }),
  );
  assert.match(down.error, /^Nothing sent to Trello: Trello unreachable/);
  // Refused by Trello (400).
  env.trello.onPost = () => text('invalid value for name', 400);
  const bad = await env.run(
    f.sceneAction('create_card', { board: 'Maison', list: 'À faire', name: 'x' }),
  );
  assert.match(bad.error, /^Trello refused the request/);
  // Bad due delay: refused before anything leaves.
  const posts = env.trello.count('post');
  const badDue = await env.run(
    f.sceneAction('create_card', {
      board: 'Maison',
      list: 'À faire',
      name: 'x',
      due_in_minutes: 1.5,
    }),
  );
  assert.match(badDue.error, /whole number of minutes/);
  assert.equal(env.trello.count('post'), posts);
});

test('a scene action answers within its deadline when Trello hangs', async (t) => {
  const env = await start(t, { boards: [home([card(1, { name: 'A' })])] });
  env.trello.onPut = () => 'hang';
  const t0 = env.clock.elapsed;
  const ack = await env.run(
    env.gladys.fake.sceneAction('move_card', { board: 'Maison', card: 'A', list: 'Terminé' }),
  );
  assert.equal(ack.data.outputs.result, 'unconfirmed');
  assert.ok(env.clock.elapsed - t0 < 25 * SECOND, `${env.clock.elapsed - t0} ms`);
});

test('a scene on 5 cards with a slow Trello (700 ms): the 5 actions done', async (t) => {
  const b = home([1, 2, 3, 4, 5].map((n) => card(n, { name: `T${n}` })));
  const env = await start(t, { boards: [b] });
  env.trello.latency = 700;
  const acks = await env.run(
    Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        env.gladys.fake.sceneAction('move_card', {
          board: 'Maison',
          card: `T${n}`,
          list: 'Terminé',
        }),
      ),
    ),
  );
  assert.deepEqual(
    acks.map((a) => a.data?.outputs?.moved),
    [true, true, true, true, true],
  );
  assert.ok(b.cards.every((c) => c.idList === LIST_DONE));
  // One request in flight, 300 ms apart at least.
  const puts = env.trello.requests.filter((r) => r.kind === 'put').map((r) => r.mono);
  for (let i = 1; i < puts.length; i += 1) assert.ok(puts[i] - puts[i - 1] >= 300);
});

test('a burst of actions: 30 requests per 10 s at most, the rest refused before sending', async (t) => {
  const b = home(Array.from({ length: 40 }, (_, i) => card(i + 1, { name: `C${i + 1}` })));
  const env = await start(t, { boards: [b] });
  const acks = await env.run(
    Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        env.gladys.fake.sceneAction('move_card', {
          board: 'Maison',
          card: `C${i + 1}`,
          list: 'Terminé',
        }),
      ),
    ),
  );
  const times = env.trello.requests.map((r) => r.mono);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= 300, '300 ms between two requests');
  }
  for (let i = 30; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 30] >= 10 * SECOND, 'over 30 in 10 s');
  }
  assert.ok(acks.some((a) => a.success === false && /Nothing sent/.test(a.error)));
});

test('read the cards due: counts, list, filters, from the last reading (no request)', async (t) => {
  const env = await start(t, {
    boards: [
      home([
        card(1, { name: 'En retard', due: NOW - 3 * HOUR }),
        card(2, { name: 'Bientôt', due: NOW + 3 * HOUR, idList: LIST_DOING }),
        card(3, { name: 'Plus tard', due: NOW + 3 * 24 * HOUR }),
        card(4, { name: 'Fait', due: NOW - HOUR, dueComplete: true }),
      ]),
      board({
        id: BOARD_WORK,
        name: 'Travail',
        shortLink: 'WorkBrd2',
        lists: [{ id: LIST_WORK, name: 'Backlog' }],
        cards: [card(9, { name: 'Rapport', idList: LIST_WORK, due: NOW + HOUR })],
      }),
    ],
  });
  const before = env.trello.count();
  const f = env.gladys.fake;
  const all = (await f.sceneAction('get_cards', {})).data.outputs;
  assert.equal(all.count, 3);
  assert.equal(all.overdue_count, 1);
  assert.equal(all.soon_count, 2);
  assert.equal(all.next_name, 'En retard');
  assert.equal(all.next_due, '2026-11-15 12:20');
  assert.equal(
    all.list,
    [
      '• En retard (Maison / À faire) — 2026-11-15 12:20',
      '• Rapport (Travail / Backlog) — 2026-11-15 16:20',
      '• Bientôt (Maison / En cours) — 2026-11-15 18:20',
    ].join('\n'),
  );
  const soonHome = (await f.sceneAction('get_cards', { board: 'Maison', only: 'soon' })).data
    .outputs;
  assert.equal(soonHome.count, 1);
  const doing = (await f.sceneAction('get_cards', { board: 'Maison', list: 'en cours' })).data
    .outputs;
  assert.equal(doing.count, 1);
  assert.equal(env.trello.count(), before);
});

test('the widget: tiles and cards valid for the core, in French and English', async (t) => {
  const env = await start(t, {
    boards: [
      home([
        card(1, { name: 'En retard', due: NOW - 3 * HOUR }),
        card(2, { name: 'Bientôt', due: NOW + 3 * HOUR }),
        card(3, { name: 'Sans échéance' }),
      ]),
    ],
  });
  for (const language of ['fr', 'en']) {
    const content = (await env.gladys.fake.widgetGet('cards', { language })).data.content;
    assert.deepEqual(validateWidgetContent(content), []);
    const list = content.components.find((c) => c.type === 'card-list');
    assert.deepEqual(
      list.items.map((i) => i.title),
      ['En retard', 'Bientôt'],
    );
    assert.equal(list.items[1].badge.text, '18:20');
    assert.equal(list.items[0].links[0].url, 'https://trello.com/c/Crd00001');
  }
  const other = (await env.gladys.fake.widgetGet('cards', { settings: { board: 'Bureau' } })).data
    .content;
  assert.deepEqual(validateWidgetContent(other), []);
  assert.match(other.components[0].text, /board not found/);
  const empty = await start(t, { boards: [home([])] });
  const none = (await empty.gladys.fake.widgetGet('cards', { language: 'fr' })).data.content;
  assert.deepEqual(validateWidgetContent(none), []);
  assert.match(none.components[2].text, /Aucune carte en retard/);
});

test('a board read: the widget is nudged when what it shows changes', async (t) => {
  const b = home([card(1, { due: NOW + HOUR })]);
  const env = await start(t, { boards: [b] });
  const nudges = env.gladys.fake.widgetRefreshes.length;
  await env.wait(5 * MINUTE + SECOND);
  assert.equal(env.gladys.fake.widgetRefreshes.length, nudges, 'nothing changed');
  b.cards[0].name = 'Renommée';
  await env.wait(5 * MINUTE);
  assert.equal(env.gladys.fake.widgetRefreshes.length, nudges + 1);
  assert.ok(BOARD_HOME);
});
