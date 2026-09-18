---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
---

**The console grows the routes the app plan needs, so compute and knowledge
stop being Mac-only.** Nine new endpoints on the existing owner auth, the
existing error envelope and the existing `degrades: absent` rule, each with
its misuse tests (invariant 8).

`/api/compute*` is five of the `metistry compute` verbs over HTTP: `GET
/api/compute` (the `compute show --json` report, plus both budget windows
folded from the `spend` named query and a `writable` flag), `GET
/api/compute/models`, `POST /api/compute/assign`, `POST /api/compute/budget`,
`POST /api/compute/providers/test`. They call the **same exported functions
the CLI verbs call** — the same YAML-document edit so comments and
hand-written blocks survive, the same re-validation of the result before
anything is written, the same write through the reconciler as `user`
(invariant 2) — so a refusal reads identically on both doors because it is the
same refusal. `providers add` and `providers remove` are deliberately absent:
they take a key, and a key goes on stdin into the login Keychain, so adding or
removing a provider stays CLI/app-only and `secret_present` is the only thing
a secret contributes to a response. These are the owner's **configuration**,
not invariant-10 "actions" — `user` principal only, no `propose_action` kind,
no autonomy level that reaches them.

Two guards worth naming. The console refuses to write a `compute.yaml` it is
not reading: if the `METISTRY_COMPUTE_FILES` overlay ends somewhere other than
`<instance>/.metistry/compute.yaml`, the write is refused with both paths
named, because unguarded it would find nothing at the path it opens, start
from a bare header and deliver a four-line file over the real one. And the
whole surface degrades absent: the compose shape gives the console no instance
mount by design, so there every compute route answers 503 naming
`METISTRY_INSTANCE_DIR` while `metistry compute` keeps working.

`GET /api/knowledge/search` and `GET /api/knowledge/page` are the owner's read
path into their own vault — a thin proxy onto the reconciler's
`/vault/search` (three modes, snippets, and `degraded` reaching the client
rather than being swallowed) and `/vault/read`. The console has held a vault
reader and searcher since Phase 6 and wired them only into `mcp-brain`, so
knowledge was reachable by an agent over MCP and by nothing the owner holds.
The proxy also **narrows what the bridge serves**: `/vault/read` is confined
to the instance repo and stops there, because the protected-path writes go
through it, so the route adds core's `isVaultPath` and `.metistry/`,
`Artifacts/` and the root `CLAUDE.md` are not reachable as knowledge from any
client. A refusal answers 404, not 403, so "refused" and "absent" are
indistinguishable from outside. `GET /api/knowledge/pages` is deliberately not
here: the page list is derived state and belongs in a named query over
`knowledge_files`, which `seed/queries/` does not carry yet.

`GET /api/commands` is the composer's list, **generated** from the instance's
own `rules.yaml` and the agent registry — `/note`, the deep alias under
whatever name that instance gives it, `/model`, and one command per
`fast_path` rule whose pattern spells one unambiguously. A rule that is a
sentence rather than a command yields nothing, on purpose. Each entry carries
the tier it routes to and, for a fast path, the named query whose own
description is the menu's line. The PWA's static `COMMANDS` array — a
placeholder marked with an expiry since it was written — is deleted, and an
integration test routes every command the endpoint offers back through
`route()` so the menu and the router cannot drift.

`GET /api/runs/:id` is the activity feed's drill-down into a `runs:<id>` ref,
through a new `run_detail` named query: provider, model, token and cache
counts, cost, the tool calls the same reply made (joined exactly on
`meta.turn_id` or `meta.message_id`, never a time window) and the shadow
agreement measure where the turn was shadowed — the measure, not the two
transcripts.
