---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-core": minor
---

**Instances can name each other, and an agent can be named across them** —
the five registry ideas worth borrowing from Google's SAM agent mesh
(`docs/research/2026-09-13-google-sam-review.md`), built as endpoints and a
config file rather than as a mesh: no Go daemon, no control plane, no second
credential class, no second policy language.

- **Capability advertisement.** `GET /api/identity` — the one
  unauthenticated read — now carries `capabilities`: coarse tool *group*
  names (`artifacts`, `capture`, `dispatch`, `knowledge`, `queries`,
  `tasks`), derived from what the console actually has wired, so a phone
  switcher or a peer can name what an instance offers before sign-in. Never
  a tool name, never a count, never an origin; the full `tools/list` stays
  behind an agent token at `/mcp`.
- **Approve-before-enroll.** An agent created with `remote: true` starts
  **pending**: its token is minted (the console shows one exactly once) and
  authenticates nothing — `/mcp` and `/capture` answer the same uniform 401
  an unknown token gets, `last_seen_at` is not even bumped — until the owner
  approves it from the Needs You queue or with
  `POST /api/agents/<id>/approve`. `metistry connect <tool> --remote` sets
  the flag; loopback tools stay immediate. Denying revokes.
- **Instance-qualified agent identity.** `agent:<name>@<instance_id>` in
  `packages/core` (`qualifyAgentId`), minted at the boundaries an id
  actually crosses. Storage keeps the bare name; nothing is rewritten.
- **A peer registry.** `instances.yaml` in the instance repo — a §4.7
  protected path — with `metistry instances list|add <origin>|remove|refresh`.
  `add` asks that origin who it is and records what it answers; rows are
  keyed by `instance_id`, because an origin can move. `GET /api/instances`
  serves it to the app and the phone.
- **A `runs` audit export.** `metistry runs export [--since] [--until]
  [--component]` streams the ledger as NDJSON through
  `GET /api/runs/export`, so two instances' timelines merge. Redacted,
  resumable by the cursor on every line, and never a truncated export that
  looks complete.

New: `docs/ops/instances.md`; `docs/ops/console-api.md` and
`docs/ops/cli.md` grew the sections. Migration `0017_agent_enrollment.sql`
is additive and defaults to today's behaviour.
