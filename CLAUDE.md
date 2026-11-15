# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `provider` (Node.js 22+,
ESM, no build step, sandboxed Docker container, `@gladysassistant/integration-sdk`
0.16). It reads the Trello boards the user follows through the official REST
API (`api.trello.com/1`, the API key of a Power-Up and a token) and gives the
cards due and overdue to the dashboard (widget `cards`) and the scenes
(triggers `card_due`, `card_moved`; actions `create_card`, `move_card`,
`get_cards`). Unofficial, never tested with a real account.

## Commands

```bash
npm install
npm test                                  # node --test (or gi test)
npm run lint && npm run format:check
memcap node scripts/mutants.mjs           # mutation check, one mutant at a time
node scripts/cover.mjs cover.png          # regenerate the cover
```

## Architecture

```
index.js            SDK wiring only (src/handlers.js)
src/app.js          App: lifecycle, config, /data, schedule, request slot and
                    budget, refused credentials, pauses, board readings,
                    triggers, scene actions, widget, status, test button
src/trello.js       Trello answers read strictly, matching boards/lists/cards (pure)
src/triggers.js     "card due" and "card moved" events (pure)
src/widget.js       the widget content and the date formats (pure)
src/config.js       the form normalized, the refused credentials' 8-bit tag
src/http.js         the only network access (Authorization header, bounds, no redirect)
src/store.js        /data state file (missing vs unreadable, atomic write, 0600)
src/i18n.js         status, button, widget texts (en, fr)
src/constants.js    manifest keys, bounds, rhythm
```

## Module rules

- **Credentials**: the key and the token only in the `Authorization: OAuth
oauth_consumer_key="…", oauth_token="…"` header, never in a URL, a log, a
  status, /data or an error. A refusal is a 401 on `/members/me` whose text
  names the key or the token; a 401 elsewhere never is.
- **Never more than the interval**: one reading per `poll_minutes`; a restart
  waits the rest of it (`lastPollAt` in /data before the reading), a
  reconnection keeps the schedule.
- **Polite**: one request in flight, 300 ms gap, 30 per 10 s; 429 (and 5xx on
  the member) pause every request, kept in /data; a failing board is spaced
  alone.
- **Writes never retried**: a create or move without answer is `unconfirmed`,
  the board read back; `moved` only when the answer shows the new list.
- **No scene loop**: a move made through Gladys is in `ownMoves` before it
  leaves, consumed by the first reading that shows the card in that list.
- **Fresh readings only**: "card due" on readings <= 2 intervals + 1 min old,
  widget/actions/status <= max(3 intervals, 30 min); an answer to replaced
  credentials decides nothing; `stop()` returns within 3 s.
- **Keys are forever**: config, action, widget, trigger, field, variable and
  output keys are stored in user scenes and dashboards.
- Bilingual texts (en/fr), CHANGELOG `[Unreleased]`, versions by the Release
  workflow only. Tests never touch the network (`fetchImpl` injected); the
  widget content passes the SDK's `validateWidgetContent`.
