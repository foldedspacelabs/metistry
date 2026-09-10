---
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-core": minor
---

Add `tasks_close` — the vocabulary fix deferred from the 2026-09-09 rename
(`docs/product/glossary.md` lists tasks' own verbs as `claim · renew ·
release · close`, but closing went through `tasks_update {status:
"closed"}`). `tasks_close` is a thin wrapper over the same `tasks.update`
host handler (`id`, optional `note`) — no new DB path. `tasks_update`
keeps `status: closed` working for compatibility; its description now
points callers at `tasks_close` for finishing a task in one call.
`tasks_close` joins the `tasks` crew tool group (`CREW_TOOL_GROUPS` in
core) alongside the other holder verbs, and the assistant's `BRAIN_TOOLS`
allowlist. The eager surface is now 23 tools, 18,369 chars ≈ 4.6k
definition tokens — still well under PoC-17's 5k-token lazy-discovery
line.
