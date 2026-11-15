// -----------------------------------------------------------------------------
// Fixed values of the integration: the Trello REST API, the manifest keys, the
// bounds of what is read and the rhythm of the requests. Times in milliseconds.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const USER_AGENT = `gladys-trello/${VERSION} (+https://github.com/LM1LC3N7/gladys-trello)`;

/** The only host ever asked: the official Trello REST API. */
export const API_BASE = 'https://api.trello.com/1';

// Configuration keys (manifest config_schema): stored by Gladys, never renamed.
export const CONFIG_KEY = 'api_key';
export const CONFIG_TOKEN = 'api_token';
export const CONFIG_BOARDS = 'boards';
export const CONFIG_POLL = 'poll_minutes';
export const CONFIG_SOON = 'soon_hours';
export const CONFIG_TZ = 'time_zone';
/** The time zone of the texts (widget, lists): Trello dates are instants, shown in this zone. */
export const DEFAULT_TZ = 'Europe/Paris';

export const DEFAULTS = { poll_minutes: 5, soon_hours: 24 };
export const BOUNDS = { poll_minutes: [2, 60], soon_hours: [1, 168] };

// Manifest keys: stored in scenes and dashboards, never renamed.
export const ACTION_TEST = 'test_connection';
export const WIDGET_CARDS = 'cards';
export const TRIGGER_DUE = 'card_due';
export const TRIGGER_MOVED = 'card_moved';
export const SCENE_CREATE = 'create_card';
export const SCENE_MOVE = 'move_card';
export const SCENE_GET = 'get_cards';
export const POSITIONS = ['top', 'bottom'];
export const GET_ONLY = ['due', 'overdue', 'soon'];

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Boards followed at most (all open boards when the field is empty: the first 10 by name). */
export const MAX_BOARDS = 10;
/** Cards kept per board; past it the board is "cut" (said in the status). */
export const MAX_CARDS = 1000;
/** Lists kept per board, boards kept from the member answer. */
export const MAX_LISTS = 200;
export const MAX_MEMBER_BOARDS = 1000;
export const NAME_MAX = 200;
export const DESC_MAX = 4000;
export const CARD_NAME_MAX = 500;
/** Answers: bounded in size (a board with its cards, the member with its boards, one card). */
export const BOARD_BYTES = 4 * 1024 * 1024;
export const MEMBER_BYTES = 1024 * 1024;
export const CARD_BYTES = 256 * 1024;
/** An error body is read up to this (Trello answers "invalid token" in plain text). */
export const ERROR_BYTES = 2048;

/** Background requests: bounded in time. */
export const HTTP_TIMEOUT = 15 * SECOND;
/** A scene action: its request and its wait for the request in flight (manifest gives 30 s). */
export const ACTION_HTTP_TIMEOUT = 10 * SECOND;
export const ACTION_QUEUE_WAIT = 12 * SECOND;
/**
 * Trello allows 100 requests per 10 s per token and 300 per API key. The module
 * keeps far below: one request in flight, 300 ms between two, 30 per 10 s.
 */
export const MIN_GAP = 300;
export const BUDGET_WINDOW = 10 * SECOND;
export const BUDGET_REQUESTS = 30;
/** The member and its boards (the credentials check) are read again every hour. */
export const MEMBER_TTL = HOUR;
/** A scene action re-reads a board older than this before matching a card by name. */
export const ACTION_FRESH = MINUTE;
/** The test button reuses a member read younger than this; one click per 10 s at most. */
export const TEST_FRESH = 30 * SECOND;
export const TEST_GAP = 10 * SECOND;
/** A write sent without answer: the board is read again this much later. */
export const RECHECK_DELAY = 5 * SECOND;
/** A move made through Gladys fires no "card moved" for this long. */
export const OWN_MOVE_TTL = 30 * MINUTE;
/** A board that failed: read again after the interval doubled at each failure, 1 h at most. */
export const BOARD_RETRY_MAX = HOUR;
/** A pause after a 429 (or a 5xx on the member): Retry-After or 60 s doubled, 60 s to 6 h. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The local "card due" check: every minute, no request. */
export const DUE_TICK = MINUTE;
/** Events of one kind published at most per reading or tick. */
export const MAX_EVENTS = 20;
/** Dues remembered as announced (in /data), and for how long after the due. */
export const MAX_ANNOUNCED = 2000;
export const ANNOUNCED_KEEP = 3 * DAY;
/** A server clock this far from ours (Date header) shifts the due checks; bounded. */
export const SKEW_MIN = MINUTE;
export const SKEW_MAX = 12 * HOUR;
/** The widget: list items at most (the core takes 8). */
export const WIDGET_ITEMS = 8;
export const LIST_TEXT_MAX = 2000;

/** A reading older than max(3 intervals, this) is not decided on (triggers, widget, actions). */
export const STALE_MIN = 30 * MINUTE;
/** stop() returns within this (Docker gives 10 s after SIGTERM). */
export const STOP_BUDGET = 3 * SECOND;

/** /data: one small JSON file. */
export const MAX_STATE_BYTES = 1024 * 1024;
export const STORE_RETRY = 10 * SECOND;
export const LOAD_TIMEOUT = 10 * SECOND;
export const SAVE_TIMEOUT = 10 * SECOND;
export const CONFIG_RETRY = 10 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
export const GLADYS_TIMEOUT = 20 * SECOND;
/** A timer never sleeps longer (the monotonic clock is checked again on waking). */
export const MAX_SLEEP = HOUR;

/** Fields asked to Trello: nothing else is read. */
export const MEMBER_QUERY = {
  fields: 'id,username,fullName',
  boards: 'open',
  board_fields: 'name,shortLink,url,closed',
};
export const BOARD_QUERY = {
  fields: 'name,shortLink,url,closed',
  lists: 'open',
  list_fields: 'name,closed,pos',
  cards: 'open',
  card_fields: 'name,idList,due,dueComplete,closed,shortLink,shortUrl,labels',
};
export const CARD_FIELDS = 'name,idList,due,dueComplete,closed,shortLink,shortUrl,labels';
