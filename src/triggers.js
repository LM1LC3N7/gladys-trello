// -----------------------------------------------------------------------------
// The scene triggers, from the boards read (pure).
//
// "Card due": once per card and due instant, when the clock enters
// (now - grace, now] and the card is not marked complete. A due already past
// by more than the grace when it is first seen (the first reading, a board
// unread for a while, a restart) is marked announced without an event: never
// a stale event. The announced dues are kept in /data.
//
// "Card moved": a card in two successive readings of the same board whose list
// changed; the first reading fires nothing, and a move made through Gladys
// (`ownMoves`) fires nothing (no scene loop).
// -----------------------------------------------------------------------------

import { MAX_EVENTS, TRIGGER_DUE, TRIGGER_MOVED } from './constants.js';

export const dueKey = (card) => `${card.id}|${card.due}`;

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

export function dueData(board, card) {
  return {
    board: board.name,
    list: board.lists.get(card.idList) ?? null,
    name: card.name,
    due: iso(card.due),
    url: card.url || null,
    labels: card.labels || null,
  };
}

/**
 * `{ events, marked }`: the "card due" events (oldest due first, MAX_EVENTS
 * at most: the others wait for the next tick) and the keys to remember as
 * announced (the events' and the stale ones').
 */
export function dueEvents(boards, announced, now, grace) {
  const fresh = [];
  const marked = [];
  for (const board of boards) {
    for (const card of board.cards.values()) {
      if (card.due === null || card.dueComplete || card.due > now) continue;
      const key = dueKey(card);
      if (announced.has(key)) continue;
      if (card.due <= now - grace) marked.push(key);
      else fresh.push({ board, card, key });
    }
  }
  fresh.sort((a, b) => a.card.due - b.card.due || (a.key < b.key ? -1 : 1));
  const events = [];
  for (const { board, card, key } of fresh.slice(0, MAX_EVENTS)) {
    events.push({ key: TRIGGER_DUE, data: dueData(board, card) });
    marked.push(key);
  }
  return { events, marked };
}

/** The "card moved" events between two readings of one board (MAX_EVENTS at most). */
export function moveEvents(previous, next, ownMoves, mono) {
  if (!previous) return [];
  const events = [];
  for (const card of next.cards.values()) {
    const before = previous.cards.get(card.id);
    if (!before || before.idList === card.idList) continue;
    const own = ownMoves.get(card.id);
    if (own && own.list === card.idList && own.until > mono) continue;
    events.push({
      key: TRIGGER_MOVED,
      data: {
        board: next.name,
        list: next.lists.get(card.idList) ?? null,
        from_list: previous.lists.get(before.idList) ?? null,
        name: card.name,
        due: iso(card.due),
        url: card.url || null,
      },
    });
    if (events.length >= MAX_EVENTS) break;
  }
  return events;
}
