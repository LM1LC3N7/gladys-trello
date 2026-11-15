// -----------------------------------------------------------------------------
// The pure parts: configuration, HTTP reading, Trello answers, triggers,
// dates in time zones.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardRefs, normalizeConfig, timeZoneOf, validRefused } from '../src/config.js';
import { TrelloError, readBounded, request, retryAfterMs } from '../src/http.js';
import {
  clean,
  dueOf,
  findBoard,
  findCard,
  findList,
  parseBoard,
  parseMember,
} from '../src/trello.js';
import { dueEvents, moveEvents } from '../src/triggers.js';
import { formatDue } from '../src/widget.js';
import { BOARD_HOME, LIST_DONE, LIST_TODO, board, card, member } from './fixtures/trello.js';

const KEY = '0123456789abcdef0123456789abcdef';
const TOKEN = 'ATTA' + 'a1'.repeat(32);

test('configuration: credentials checked, numbers bounded, time zone validated', () => {
  const c = normalizeConfig({
    api_key: ` ${KEY} `,
    api_token: `token=${TOKEN}`,
    poll_minutes: '1',
    soon_hours: 500,
    time_zone: 'America/Montreal',
  });
  assert.equal(c.problem, undefined);
  assert.equal(c.key, KEY);
  assert.equal(c.token, TOKEN);
  assert.equal(c.pollMinutes, 2);
  assert.equal(c.soonHours, 168);
  assert.equal(c.timeZone, 'America/Montreal');
  assert.equal(normalizeConfig({ api_key: KEY }).problem, 'missing');
  assert.equal(normalizeConfig({ api_token: TOKEN }).problem, 'missing');
  assert.equal(normalizeConfig({ api_key: KEY.slice(1), api_token: TOKEN }).problem, 'bad_key');
  for (const bad of [`${TOKEN}\r\nX: y`, `${TOKEN} x`, 'short', 'é'.repeat(40)]) {
    const n = normalizeConfig({ api_key: KEY, api_token: bad });
    assert.equal(n.problem, 'bad_token', bad);
    assert.equal(n.token, '', 'a bad value is never kept');
  }
  const d = normalizeConfig({ api_key: KEY, api_token: TOKEN, poll_minutes: '', soon_hours: 'x' });
  assert.deepEqual([d.pollMinutes, d.soonHours, d.timeZone], [5, 24, 'Europe/Paris']);
  assert.equal(timeZoneOf('Mars/Olympus'), 'Europe/Paris');
  assert.equal(timeZoneOf('../etc/passwd'), 'Europe/Paris');
});

test('boards field: commas, duplicates, controls, 10 at most', () => {
  assert.deepEqual(boardRefs(' Maison ,maison, Travail\nPerso;\u0007x ').refs, [
    'Maison',
    'Travail',
    'Perso',
  ]);
  const many = boardRefs(Array.from({ length: 11 }, (_, i) => `B${i}`).join(','));
  assert.equal(many.refs.length, 10);
  assert.equal(many.tooMany, true);
});

test('a refusal read back from /data: strict', () => {
  const salt = 'ab'.repeat(16);
  assert.deepEqual(validRefused({ salt, tag: 7, kind: 'key' }), { salt, tag: 7, kind: 'key' });
  for (const bad of [{ salt, tag: 256 }, { salt: 'x', tag: 1 }, { salt, tag: 1.5 }, null, 'x']) {
    assert.equal(validRefused(bad), undefined);
  }
});

test('Retry-After: seconds or an HTTP date, anything else ignored', () => {
  const now = Date.parse('2026-11-15T14:00:00Z');
  assert.equal(retryAfterMs('120', now), 120_000);
  assert.equal(retryAfterMs('Sun, 15 Nov 2026 14:05:00 GMT', now), 300_000);
  for (const bad of ['-1', '1e9', '', undefined, 'soon', 'x'.repeat(100)]) {
    assert.equal(retryAfterMs(bad, now), undefined);
  }
});

test('readBounded: a body over the bound is cut while streaming', async () => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (pulled > 1000) controller.close();
    },
  });
  await assert.rejects(readBounded(new Response(stream), 256 * 1024), { code: 'too_large' });
  assert.ok(pulled < 10, `pulled ${pulled} chunks`);
  const declared = new Response('x', { headers: { 'content-length': '999999999' } });
  await assert.rejects(readBounded(declared, 1024), { code: 'too_large' });
});

test('request: the 401 reason read, sent or not told apart, never a secret in an error', async () => {
  const call = (fetchImpl) =>
    request('https://api.trello.com/1', 'GET', '/members/me', {
      key: KEY,
      token: TOKEN,
      limit: 1024,
      fetchImpl,
    });
  const answer = (body, status, headers) => async () => new Response(body, { status, headers });
  for (const [body, auth] of [
    ['invalid key', 'key'],
    ['invalid token', 'token'],
    ['expired token', 'token'],
    ['unauthorized permission requested', undefined],
    ['<html>', undefined],
  ]) {
    const err = await call(answer(body, 401)).catch((e) => e);
    assert.equal(err.code, 'unauthorized');
    assert.equal(err.auth, auth, body);
    assert.equal(err.sent, true);
  }
  const refused = await call(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }).catch((e) => e);
  assert.deepEqual([refused.code, refused.sent], ['network', false]);
  const reset = await call(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  }).catch((e) => e);
  assert.deepEqual([reset.code, reset.sent], ['network', 'unknown']);
  const timeout = await call(async () => {
    throw new DOMException('t', 'TimeoutError');
  }).catch((e) => e);
  assert.deepEqual([timeout.code, timeout.sent], ['timeout', 'unknown']);
  const limited = await call(answer('x', 429, { 'retry-after': '30' })).catch((e) => e);
  assert.deepEqual([limited.code, limited.retryAfter], ['rate_limited', 30_000]);
  const garbage = await call(answer('not json', 200)).catch((e) => e);
  assert.equal(garbage.code, 'invalid');
  for (const err of [refused, reset, timeout, limited, garbage]) {
    assert.ok(err instanceof TrelloError);
    assert.ok(!err.message.includes(TOKEN) && !err.message.includes(KEY));
  }
  const ok = await call(answer('{"id":"x"}', 200, { date: 'Sun, 15 Nov 2026 14:00:00 GMT' }));
  assert.deepEqual(ok, { body: { id: 'x' }, date: Date.parse('2026-11-15T14:00:00Z') });
});

test('Trello answers: the board asked or nothing, archived lists and odd cards left out', () => {
  const b = board({
    cards: [
      card(1, { due: Date.parse('2026-11-16T10:00:00Z') }),
      { ...card(2), idList: 'c'.repeat(24) }, // in an archived list
      { ...card(3), due: '16/11/2026' }, // unreadable due
      { ...card(4), closed: true },
      { ...card(5), id: '../x' },
      { ...card(6), name: 'A\u0000B\nC' },
    ],
  });
  b.lists.push({ id: 'c'.repeat(24), name: 'Archivée', closed: true });
  const snap = parseBoard(b, BOARD_HOME);
  assert.deepEqual([...snap.cards.keys()].length, 2);
  assert.equal(snap.cards.get(card(6).id).name, 'A B C');
  assert.equal(snap.lists.size, 3);
  assert.throws(() => parseBoard(b, 'b'.repeat(24)), { code: 'invalid' });
  assert.throws(() => parseBoard({ ...b, cards: 'x' }, BOARD_HOME), { code: 'invalid' });
  assert.throws(() => parseMember({ id: 'nope' }), { code: 'invalid' });
  assert.equal(parseMember(member([b])).boards[0].name, 'Maison');
  const many = board({ cards: Array.from({ length: 1001 }, (_, i) => card(i + 1)) });
  const cutSnap = parseBoard(many, BOARD_HOME);
  assert.equal(cutSnap.cut, true);
  assert.equal(cutSnap.cards.size, 1000);
  assert.equal(dueOf('2026-11-16T10:00:00.000Z'), Date.parse('2026-11-16T10:00:00Z'));
  assert.equal(dueOf('2026-11-16'), undefined, 'a date without a zone is not guessed');
  assert.equal(dueOf(null), null);
  assert.equal(clean('x'.repeat(300), 10), `${'x'.repeat(9)}…`);
});

test('matching: id, short link, link, name without case or accents, ambiguity said', () => {
  const snap = parseBoard(
    board({ cards: [card(1, { name: 'Réparer vélo' }), card(2, { name: 'Réparer volet' })] }),
    BOARD_HOME,
  );
  assert.equal(findCard(snap, 'reparer VELO').item.id, card(1).id);
  assert.equal(findCard(snap, 'vélo').item.id, card(1).id, 'the only one containing it');
  assert.equal(findCard(snap, 'réparer').error, 'ambiguous');
  assert.equal(findCard(snap, 'Crd00002').item.id, card(2).id);
  assert.equal(findCard(snap, 'https://trello.com/c/Crd00002/x').item.id, card(2).id);
  assert.equal(findCard(snap, 'https://trello.com/c/Zzz00009').error, 'unknown');
  assert.equal(findCard(snap, '  ').error, 'empty');
  assert.equal(findList(snap, 'TERMINE').item.id, LIST_DONE);
  assert.equal(findList(snap, 'term').error, 'unknown', 'a list is never matched by a part');
  const boards = parseMember(
    member([board(), board({ id: 'b'.repeat(24), name: 'maison ' })]),
  ).boards;
  assert.equal(findBoard(boards, 'Maison').error, 'ambiguous');
  assert.equal(findBoard(boards, 'HomeBrd1').item.id, BOARD_HOME);
});

test('card due: the grace window bounds, complete and undated cards never', () => {
  const now = Date.parse('2026-11-15T14:00:00Z');
  const grace = 6 * 60_000;
  const snap = parseBoard(
    board({
      cards: [
        card(1, { due: now }),
        card(2, { due: now - grace }),
        card(3, { due: now - grace + 1 }),
        card(4, { due: now + 1 }),
        card(5, { due: now - 1000, dueComplete: true }),
        card(6),
      ],
    }),
    BOARD_HOME,
  );
  const announced = new Map();
  const { events, marked } = dueEvents([snap], announced, now, grace);
  assert.deepEqual(
    events.map((e) => e.data.name),
    ['Card 3', 'Card 1'],
  );
  assert.deepEqual(marked.length, 3, 'card 2 marked without an event');
  for (const k of marked) announced.set(k, 0);
  assert.equal(dueEvents([snap], announced, now, grace).events.length, 0);
  // A due moved later is a new due (card 4 comes due too).
  snap.cards.get(card(1).id).due = now + 1000;
  assert.deepEqual(
    dueEvents([snap], announced, now + 2000, grace).events.map((e) => e.data.name),
    ['Card 4', 'Card 1'],
  );
});

test('card due: 20 events at most per tick, the others next time', () => {
  const now = Date.parse('2026-11-15T14:00:00Z');
  const snap = parseBoard(
    board({ cards: Array.from({ length: 25 }, (_, i) => card(i + 1, { due: now - i })) }),
    BOARD_HOME,
  );
  const announced = new Map();
  const first = dueEvents([snap], announced, now, 60_000);
  assert.equal(first.events.length, 20);
  for (const k of first.marked) announced.set(k, 0);
  assert.equal(dueEvents([snap], announced, now, 60_000).events.length, 5);
});

test('card moved: only between two readings, never an own move', () => {
  const a = parseBoard(board({ cards: [card(1), card(2)] }), BOARD_HOME);
  const b = parseBoard(
    board({ cards: [card(1, { idList: LIST_DONE }), card(2, { idList: LIST_DONE })] }),
    BOARD_HOME,
  );
  assert.equal(moveEvents(undefined, b, new Map(), 0).length, 0);
  const own = new Map([[card(2).id, { list: LIST_DONE, until: 100 }]]);
  assert.deepEqual(
    moveEvents(a, b, own, 50).map((e) => e.data.name),
    ['Card 1'],
  );
  assert.equal(moveEvents(a, b, own, 200).length, 2, 'an old own move is forgotten');
  assert.equal(moveEvents(b, b, new Map(), 0).length, 0);
  assert.ok(LIST_TODO);
});

test('dates in a time zone: west and east of UTC at midnight, and across a DST change', () => {
  const midnightUtc = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(formatDue(midnightUtc, 'America/Los_Angeles', 'iso'), '2026-11-15 16:00');
  assert.equal(formatDue(midnightUtc, 'Asia/Tokyo', 'iso'), '2026-11-16 09:00');
  assert.equal(formatDue(midnightUtc, 'Europe/Paris', 'fr'), '16/11/2026 01:00');
  // Paris leaves summer time on 25 October 2026 at 03:00 (01:00 UTC).
  assert.equal(
    formatDue(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Paris', 'iso'),
    '2026-10-25 02:30',
  );
  assert.equal(
    formatDue(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Paris', 'iso'),
    '2026-10-25 02:30',
  );
  assert.equal(formatDue(null, 'Europe/Paris', 'iso'), '');
});
