# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Trello boards through the official REST API (`api.trello.com/1`), with the API
  key of a Power-Up and a token (Authorization header only): the boards named in
  the configuration, or every open board (10 at most), read every 5 minutes by
  default (2 to 60), the member and its boards once an hour.
- Dashboard widget "Trello cards due": tiles overdue / due soon, the cards with
  their board, list and due date, each opening its card.
- Scene triggers "Trello card due" (once per card and due date, never for a due
  already past by more than the interval and a minute when first read, never
  on a reading older than two intervals and a minute) and "Trello card moved" (not for the moves made
  through Gladys).
- Scene actions "Create a Trello card" (never sent twice; "unconfirmed" when
  Trello does not answer), "Move a Trello card" (by link or name; "moved" only
  when Trello answers with the card in the new list) and "Read the Trello cards
  due".
- Test button: the account, its open boards, the boards followed, the cards
  overdue and due soon.
- Pacing: one request in flight, 300 ms between two, 30 per 10 s at most; a 429
  pauses every request (Retry-After, 60 s to 6 h, kept in /data); a board that
  fails is read again later without stopping the others.
- Refused credentials (a 401 on the member naming the key or the token) kept in
  /data as 8 bits of a salted hash: nothing more is asked until they change or
  the test button succeeds. An answer to credentials replaced meanwhile decides
  nothing.
- Readings older than 3 intervals (30 min at least) are not shown: the widget,
  "Read the Trello cards due" and the status say the data is out of date.
- `stop()` returns within 3 s: the request in flight is aborted, the last save
  bounded.
