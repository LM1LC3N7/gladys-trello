// -----------------------------------------------------------------------------
// Trello answers read strictly (pure): every Trello field name lives here. An
// answer that does not look right is refused whole ('invalid'), never half
// read. Plus the matching of a board, a list or a card from what a user types.
// -----------------------------------------------------------------------------

import { MAX_CARDS, MAX_LISTS, MAX_MEMBER_BOARDS, NAME_MAX } from './constants.js';
import { TrelloError } from './http.js';

const ID = /^[0-9a-f]{24}$/;
const SHORT = /^[A-Za-z0-9]{8}$/;
const BOARD_URL = /^https:\/\/trello\.com\/b\/([A-Za-z0-9]{8})(?:[/?#].*)?$/;
const CARD_URL = /^https:\/\/trello\.com\/c\/([A-Za-z0-9]{8})(?:[/?#].*)?$/;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f]+/g;

const invalid = (what) =>
  new TrelloError('invalid', `Unexpected Trello answer (${what})`, { sent: 'unknown' });

/**
 * At most `max` UTF-16 units (what Gladys and Trello count), cut between two
 * characters (never half an emoji), "…" when cut.
 */
export function cutText(text, max) {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** A text from Trello: controls replaced by spaces, trimmed, cut at `max` characters. */
export function clean(value, max = NAME_MAX) {
  if (typeof value !== 'string') return '';
  const text = value
    .slice(0, max * 4)
    .replace(CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cutText(text, max);
}

/** For matching: accents and case ignored, spaces collapsed. */
export const normalize = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** A due date: an ISO instant with a zone, or null. Never a guess. */
export function dueOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(value))
    return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

const httpsTrello = (value) =>
  typeof value === 'string' && value.length <= 300 && /^https:\/\/trello\.com\//.test(value)
    ? value
    : '';

/** GET /members/me (with its open boards) -> `{ id, username, fullName, boards }`. */
export function parseMember(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !ID.test(body.id)) {
    throw invalid('member');
  }
  if (body.boards !== undefined && !Array.isArray(body.boards)) throw invalid('boards');
  const boards = [];
  for (const b of (body.boards ?? []).slice(0, MAX_MEMBER_BOARDS)) {
    if (!b || !ID.test(b.id) || b.closed === true) continue;
    boards.push({
      id: b.id,
      name: clean(b.name) || b.id,
      shortLink: SHORT.test(b.shortLink) ? b.shortLink : '',
      url: httpsTrello(b.url),
    });
  }
  return {
    id: body.id,
    username: clean(body.username, 100),
    fullName: clean(body.fullName, 100),
    boards,
  };
}

/** One card of an answer -> the card, or undefined when it does not read. */
export function parseCard(c, lists) {
  if (!c || typeof c !== 'object' || !ID.test(c.id) || !ID.test(c.idList)) return undefined;
  if (c.closed === true) return undefined;
  if (lists && !lists.has(c.idList)) return undefined; // in an archived list
  const due = dueOf(c.due);
  if (due === undefined) return undefined;
  const labels = Array.isArray(c.labels)
    ? c.labels
        .slice(0, 20)
        .map((l) => clean(l?.name, 50))
        .filter(Boolean)
    : [];
  return {
    id: c.id,
    name: clean(c.name) || '(…)',
    idList: c.idList,
    due,
    dueComplete: c.dueComplete === true,
    shortLink: SHORT.test(c.shortLink) ? c.shortLink : '',
    url: httpsTrello(c.shortUrl) || httpsTrello(c.url),
    labels: labels.join(', ').slice(0, 300),
  };
}

/**
 * GET /boards/{id} with its open lists and cards -> `{ id, name, shortLink,
 * url, lists: Map(id -> name), cards: Map(id -> card), cut }`. The answer must
 * be the board asked (identity checked before anything is used).
 */
export function parseBoard(body, expectedId) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.id !== expectedId) {
    throw invalid('board');
  }
  if (!Array.isArray(body.lists) || !Array.isArray(body.cards)) throw invalid('lists or cards');
  const lists = new Map();
  for (const l of body.lists.slice(0, MAX_LISTS)) {
    if (!l || !ID.test(l.id) || l.closed === true) continue;
    lists.set(l.id, clean(l.name) || l.id);
  }
  const cards = new Map();
  const cut = body.cards.length > MAX_CARDS;
  for (const raw of body.cards.slice(0, MAX_CARDS)) {
    const card = parseCard(raw, lists);
    if (card) cards.set(card.id, card);
  }
  return {
    id: body.id,
    name: clean(body.name) || body.id,
    shortLink: SHORT.test(body.shortLink) ? body.shortLink : '',
    url: httpsTrello(body.url),
    lists,
    cards,
    cut,
  };
}

/** Several matches by name: 'ambiguous'; none: 'unknown'. */
function pick(items, ref, { idOf, shortOf, urlPattern, nameOf, contains = false }) {
  const text = String(ref ?? '').trim();
  if (!text) return { error: 'empty' };
  const url = urlPattern ? urlPattern.exec(text) : null;
  const short = url ? url[1] : SHORT.test(text) ? text : undefined;
  for (const item of items) {
    if (idOf(item) === text) return { item };
    if (short && shortOf && shortOf(item) === short) return { item };
  }
  if (url) return { error: 'unknown' };
  const wanted = normalize(text);
  const equal = items.filter((item) => normalize(nameOf(item)) === wanted);
  if (equal.length === 1) return { item: equal[0] };
  if (equal.length > 1) return { error: 'ambiguous' };
  if (contains) {
    const near = items.filter((item) => normalize(nameOf(item)).includes(wanted));
    if (near.length === 1) return { item: near[0] };
    if (near.length > 1) return { error: 'ambiguous' };
  }
  return { error: 'unknown' };
}

/** A board of the member from its name, short link, link or id. */
export const findBoard = (boards, ref) =>
  pick(boards, ref, {
    idOf: (b) => b.id,
    shortOf: (b) => b.shortLink,
    urlPattern: BOARD_URL,
    nameOf: (b) => b.name,
  });

/** A list of a read board from its name or id -> `{ item: { id, name } }`. */
export const findList = (board, ref) =>
  pick(
    [...board.lists].map(([id, name]) => ({ id, name })),
    ref,
    { idOf: (l) => l.id, nameOf: (l) => l.name },
  );

/** A card of a read board from its link, short link, id or name (equal, else the only one containing it). */
export const findCard = (board, ref) =>
  pick([...board.cards.values()], ref, {
    idOf: (c) => c.id,
    shortOf: (c) => c.shortLink,
    urlPattern: CARD_URL,
    nameOf: (c) => c.name,
    contains: true,
  });

/** Overdue: a due passed, not marked complete. */
export const isOverdue = (card, now) => card.due !== null && !card.dueComplete && card.due <= now;
/** Due soon: within the next `soonMs`, not marked complete. */
export const isSoon = (card, now, soonMs) =>
  card.due !== null && !card.dueComplete && card.due > now && card.due <= now + soonMs;
