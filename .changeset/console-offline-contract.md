---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-mcp-brain": minor
---

The console's API contract for a client that is not always connected
(`docs/ops/console-api.md`, from the 2026-09-11 research note): a public
`GET /api/identity` (`instance_id`, `name`, `icon`, `version` — read from
`identity.yaml` through `METISTRY_IDENTITY_FILES`, 503 when absent) so a
phone can name an instance before sign-in and recognise it after its origin
moves; an `Idempotency-Key` header on `POST /capture`, scoped to the
credential class, that returns the original row on replay — one file, one
inbox row even when attempts race (migration `0014`, unique index on the
inbox row) — with `Idempotency-Replayed: true`; `409 conflict` carrying the
winning decision when a proposal was already settled (unknown stays `404`);
and opaque `since` cursors on `GET /api/messages` and `GET /api/proposals`
(`cursor`, `more`), where a rating moves a message and a decision moves a
proposal, so a reconnect after hours is one bounded pull per list. The
plain lists are unchanged.
