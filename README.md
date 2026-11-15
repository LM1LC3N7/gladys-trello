# Trello for Gladys Assistant

**Unofficial**, not affiliated with Atlassian (the makers of Trello). Never
tested with a real Trello account yet: the requests and the answer format come
from the official REST API reference (developer.atlassian.com/cloud/trello/rest,
read on 2026-11-15); the 401 and 400 texts in the tests are the real answers of
`api.trello.com`, the rest of the test answers is made up.

A Gladys Assistant external integration of type `provider`:

- It reads the boards you follow (named in the configuration, or every open
  board, 10 at most) through `https://api.trello.com/1` with the **API key of a
  Power-Up you create** and a **token** you generate for it (Authorization
  header, never in an address), every 5 minutes by default.
- Dashboard widget: the cards overdue and due soon, each opening its card.
- Scene triggers: **card due** (a card reached its due date) and **card moved**
  (a card went to another list).
- Scene actions: **create a card**, **move a card** to another list, **read the
  cards due** (counts and a text for a message).

Guides: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test, virtual clock, a scripted API, the fake Gladys
npm run lint && npm run format:check
node scripts/mutants.mjs # mutation check of the guards (use memcap)
```

Requires Gladys 5.1.0 or later (widgets and scene declarations). Licence:
Apache-2.0 (`LICENSE`); notices in `THIRD_PARTY_NOTICES.md`.
