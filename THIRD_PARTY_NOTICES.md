# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). Its
code is its own: no third-party code is copied or ported.

## Trello REST API (service)

At run time the integration calls the official Trello REST API,
`https://api.trello.com/1` (the member and its boards, a board with its lists
and cards, a card created or moved), with the API key of a Power-Up the user
creates and the token the user generates for it. Using the API means accepting
the Atlassian Developer Terms (<https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/>)
and the Trello terms of the account. "Trello" and "Atlassian" are names of their
owner, used here only to say which service is called; no logo is used.

The boards, lists and cards are the user's own data: read for the dashboard and
the scenes inside Gladys, never shipped in this repository nor in the Docker
image (the test fixtures are made up).

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK.
