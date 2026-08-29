# Metistry

**A personal AI operating system you own entirely** — a persistent assistant
plus a knowledge graph. Agents are disposable; your context is durable:
markdown in your git, operational state in your Postgres, in formats that
outlive any session, agent, or vendor. Apache-2.0.

- **Host it anywhere.** Services bind configured ports; network exposure is
  a routing layer *you* provide (tailnet, reverse proxy, cloud, Docker port
  maps). Local-first in ownership, not local-only in deployment. Apple-native
  capabilities (iMessage, Calendar/Reminders, on-device models) need a Mac in
  the picture; everything else runs wherever you put it.
- **Predictable cost.** Deterministic routing, sub-millisecond no-model fast
  paths, per-tier budgets enforced at the tool, free local model tiers where
  they measurably win.
- **Safety is structural.** Enforce-at-the-tool throughout: sole-writer
  vault, scoped default-deny access for other agents, server-side identity,
  audit logs, and a security model built to survive full code visibility
  (invariant 8).
- **Coordinates your other AI tools.** Any MCP-capable agent — any vendor —
  can capture knowledge to it, read what you've granted, and share a task
  list with atomic claims. The hub holds state; agents pull.

## Repos

**This is the product repo — code only.** Each install lives in its own
private *instance repo* (vault, `identity.yaml`, config, `metistry.lock`
release pin) created by `metistry init` and owned by whoever runs it. Code
flows to instances as versioned releases, never git merges; instance data
never flows anywhere. The assistant's name exists only in an instance's
`identity.yaml` (seed template in `seed/`).

## Where things are

- **`metistry-build-plan.md`** — the full design. Decisions, not suggestions.
- **`CLAUDE.md`** — conventions for building Metistry (not the assistant's
  own operating instructions).
- **`docs/poc/RESULTS.md`** — Phase 0 proof-of-concept evidence (16 PoCs).
- **`docs/research/`** — prior-art and landscape research behind the design.
- **`docs/product/PRODUCT.md`** — the living product record.
- **`docs/history/`** — superseded documents kept for the record.

## Status

**Phase 0 complete** (16 PoCs: 11 pass, 2 deferred, 2 informative fails, 1
split — see the outcomes table in plan §2). **Phase 1 (substrate) partially
built**: workspace, Postgres+pgvector compose, migration 0001, PR-flow
hooks. `packages/core` is specified and awaiting build go-ahead. Design
hardening in progress.
