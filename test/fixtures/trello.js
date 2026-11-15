// -----------------------------------------------------------------------------
// Trello answers shaped after the REST API reference (developer.atlassian.com/
// cloud/trello/rest): GET /members/me with its boards, GET /boards/{id} with
// its lists and cards, a card. The 401 texts ("invalid key", "invalid token")
// and the 400 "invalid id" are the real answers of api.trello.com (2026-11-15).
// -----------------------------------------------------------------------------

/** A 24-hex Trello id from a small number and a prefix digit. */
export const hex = (n, prefix = 'a') => `${prefix}${String(n).padStart(23, '0')}`;

export const MEMBER_ID = hex(1, 'f');
export const BOARD_HOME = hex(10, 'b');
export const BOARD_WORK = hex(20, 'b');
export const LIST_TODO = hex(11, 'c');
export const LIST_DOING = hex(12, 'c');
export const LIST_DONE = hex(13, 'c');
export const LIST_WORK = hex(21, 'c');

export function card(
  n,
  { name, idList = LIST_TODO, due = null, dueComplete = false, labels } = {},
) {
  const shortLink = `Crd${String(n).padStart(5, '0')}`;
  return {
    id: hex(n, 'd'),
    name: name ?? `Card ${n}`,
    idList,
    due: due === null ? null : new Date(due).toISOString(),
    dueComplete,
    closed: false,
    shortLink,
    shortUrl: `https://trello.com/c/${shortLink}`,
    labels: (labels ?? []).map((l, i) => ({ id: hex(900 + i, 'e'), name: l, color: 'green' })),
  };
}

export function board({
  id = BOARD_HOME,
  name = 'Maison',
  shortLink = 'HomeBrd1',
  lists,
  cards = [],
} = {}) {
  return {
    id,
    name,
    shortLink,
    url: `https://trello.com/b/${shortLink}/maison`,
    closed: false,
    lists: lists ?? [
      { id: LIST_TODO, name: 'À faire', closed: false, pos: 1 },
      { id: LIST_DOING, name: 'En cours', closed: false, pos: 2 },
      { id: LIST_DONE, name: 'Terminé', closed: false, pos: 3 },
    ],
    cards,
  };
}

export function member(boards) {
  return {
    id: MEMBER_ID,
    username: 'louis',
    fullName: 'Louis Test',
    boards: boards.map((b) => ({
      id: b.id,
      name: b.name,
      shortLink: b.shortLink,
      url: b.url,
      closed: false,
    })),
  };
}
