# TODO

## Before announcing

- [x] Review r1 (high): I1-I4 and M1-M6 fixed; M7 documented (see Decisions).
- [x] Review r2: R2-1 fixed, missing guard tests added.
- [ ] Review r3.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.
- [ ] Store field not set in the manifest: `keywords` (Trello, kanban, cartes,
      tâches, échéance, to-do, projet, Power-Up).

## To watch

- [ ] Never tried with a real Trello account: the endpoints (`/1/members/me`
      with `boards=open`, `/1/boards/{id}` with `lists=open&cards=open` and the
      `card_fields`, `POST /1/cards`, `PUT /1/cards/{id}` with a JSON body), the
      `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"` header and
      the card fields (`due`, `dueComplete`, `shortUrl`, `labels`) come from the
      REST API reference read on 2026-11-15. Checked for real without an
      account: the header is parsed (a made-up key answers 401 "invalid key"),
      a request without credentials answers 400 "invalid token", a bad id 400
      "invalid id".
- [ ] A board over 1,000 open cards is cut (said in the status); a nested
      `cards=open` read may also be limited by Trello itself on huge boards.
- [ ] The 401 texts: "invalid key" and "invalid token" are real; "expired
      token" and "token revoked" are assumed from the docs. Any other 401 on
      `/members/me` is "unreadable", tried again, never a refusal.
- [ ] Trello publishes 100 requests per 10 s per token and 300 per key; the
      module stays at 30 per 10 s and about (1 + boards) requests per reading.

## Decisions

- Review r1, M7: the "card moved" events beyond 20 in one reading are not sent
  (the next reading compares with the new list); said in the docs. Keeping them
  for later would need a queue of past moves, not worth it for v1.
- Equivalent mutants (not killed): `isOverdue` `<=` vs `<` (equality never
  reached with a moving clock), the badge cut at 16 (11 characters at most),
  the generation check of a waiter while `stop()` empties the queue (the queue
  emptying is the guard, tested), and the credentials set on an unreadable
  answer (an error without credentials is already taken as the current ones;
  kept so the error says which credentials it is about).
- Review r2: an error is about replaced credentials only when it carries the
  credentials of its request and they differ from the current ones (a refusal
  before sending or an unreadable answer is about the current ones).
- Freshness: "card due" decides on readings at most 2 intervals + 1 min old;
  the widget, "Read the Trello cards due" and the status on readings at most
  max(3 intervals, 30 min) old, then say the data is out of date. A refusal
  drops every reading.
- An answer to credentials replaced while it was in flight decides nothing
  (each request carries the credentials it used).
- `stop()` returns within 3 s: the request in flight aborted, the jobs and the
  last save bounded to 1.5 s each.

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- `type: provider` (no device), `gladys_version: ">=5.1.0"` (widgets and scene
  declarations), no `countries` (Trello is used everywhere), category
  `services`.
- Credentials in the Authorization header Trello documents, never in a URL
  (Trello also takes `key`/`token` query parameters: never used).
- The card due checks run on the wall clock (a due date is an instant), shifted
  by the server clock when Trello's `Date` header is over a minute away;
  everything else (gaps, budget, pauses, back-offs, schedule) on the monotonic
  clock.
- A 5xx on `/members/me` pauses every request like a 429; a 5xx on one board
  only spaces that board (doubled up to 1 h), so one broken board never stops
  the others.
- "Card due" dues are remembered in /data (3 days), so a restart never fires a
  due twice; a due already past by more than the grace (interval + 1 min) when
  first seen fires nothing.
- No "card added" trigger and no "mark complete" action in v1 (kept small);
  scene matching is equality on the board and list names (core rule).
- Writes are never retried automatically: a create or a move sent without an
  answer is "unconfirmed" and the board is read back 5 s later.
- Dates in texts use a configured IANA time zone (Europe/Paris by default): the
  Trello API gives instants and Gladys does not pass the house time zone to an
  integration.
- The widget icon is the generic Feather `columns`, never a Trello logo.
- `.github/workflows/ci.yml`: `timeout-minutes: 30` on the jobs (a hung test
  never holds a runner for 6 h).
- [ ] r3 cosmétique : déplacer le commentaire « An answer to credentials replaced meanwhile » de replaced() vers outdated() (src/app.js).
