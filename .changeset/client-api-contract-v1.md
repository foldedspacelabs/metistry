---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**The client API, version 1 — one contract for every client, as data and as a
document.** `@foldedspacelabs/metistry-core` exports the route table
(`CLIENT_API`: method, path, reach, principals, idempotency, `409` reasons,
cursor, and whether it is served yet — 120 rows: every route the console
serves, and every route §2.1 of the design plan freezes ahead of its ticket) with `matchRoute`, `servedRoute` and `noRouteMessage`; the live-changes
catalogue (`EVENT_CATALOGUE`, the payload types in `EventPayloads`, every
event's reach `owner`); `API_VERSION` and the `Metistry-API-Version` header
name; and `events` joins the `CAPABILITIES` vocabulary.

The console answers `api_version: 1` in `GET /health` and `GET /api/identity`
and the version header on every response. It reads the table before it
dispatches anything to the owner: a route the table does not list as served is
a `404` that names the routes beside it, so a handler cannot become an
undocumented door and a route frozen ahead of its ticket stays unserved until
it lands. `docs/ops/client-api.md` is the contract in words (it replaces
`docs/ops/console-api.md`, now a pointer); a conformance test holds the table
to the server — every served row reaches a handler, nothing unlisted is
served, each row admits exactly the credentials it records — and a document
test holds the table to the document line for line.
