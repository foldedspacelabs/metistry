# Metistry — development conventions

**This file governs building Metistry.** It is not Metis's operating
instructions — those live at the instance's own root `CLAUDE.md` and are
written later, once the interaction has been felt rather than guessed at.
Don't confuse the two.

Read `metistry-build-plan.md` for the design. This file covers how to work in
the repo.

## Naming

- **Metistry** — the project. Repo and CLI command; npm packages are
  `@foldedspacelabs/metistry-<name>` (the org scope is shared with other
  projects, so every package carries the `metistry-` prefix — ruled
  2026-08-30).
- **Metis** — the assistant. Lives **only** in `identity.yaml`.

The assistant's name must never appear in a path, table name, env var, package
name, class, or function. Internally everything is `assistant_*`; prompts
template the name from config. This is what makes a second instance and any fork
a clone rather than a rewrite. Treat a hardcoded "Metis" as a bug.

## Casing

One boundary:

- The instance's vault root — everything in `<instance>/` except `.metistry/`
  (`Journal/`, `Areas/`, `Me/`, `now.md`, …) — **TitleCase**. Obsidian renders
  these names to the user (ruled 2026-09-17: the instance directory is the
  vault; `.metistry/` holds everything that isn't knowledge).
- `<instance>/.metistry/` and the product repo — **lowercase**. Code and
  tooling reference it, and `apps/` and `packages/` are pnpm conventions.

macOS is case-insensitive; Linux containers are not. `areas/` in one file and
`Areas/` in another works here and breaks in a container. CI runs on Linux and
checks this.

## Invariants

These are decisions, not preferences. Raise it with me before violating one.
Numbering matches the plan §1 (synced 2026-08-29 — they had drifted).

1. **Git is the record; Postgres is derived.** `docker compose down -v`, rebuild
   from the repo, run collectors once → back in business minus historical trend
   lines. Anything that fails that test needs backing up; nothing else does.
   (An honest restatement of the durable set is open decision D6.)
2. **Shared responsibility, enforced at the tool.** The assistant commits
   freely to `Knowledge/`; anything defining how the system behaves is a
   human change (product = PRs; instance protected paths = the user's hand).
3. **One read path into state.** Named queries — YAML in the instance's
   `queries/`, executed only by `packages/queries` (parameterized driver).
   No component talks to Postgres directly (sole exception: the watchdog's
   liveness probes).
4. **Routing is bounded by rules and always audited.** Rules the owner writes
   decide what may run — which tiers and models, what a request may cost, and
   every hard limit — and they always win: commands, overrides and budgets come
   first. Inside those bounds a local policy may choose the operations and the
   tier for a request; it can never choose outside them, every choice is
   recorded with its reasons, and with the policy absent or failing every
   request takes the rules' default.
5. **Everything is a directory with a manifest.** Bridges, collectors, agents,
   routines, targets, services. CI validates.
6. **Native only where macOS requires it.** `runs_on: host` for TCC-bound
   components; everything else containerises. TCC bridges are **Swift**,
   stably signed (D3).
7. **Cloud-portable by construction.** No absolute paths, config from
   environment, nothing assumes a shared filesystem.
8. **Security survives full code visibility, and the network is not a
   boundary.** Kerckhoffs throughout; boring primitives; every boundary
   testable — misuse tests ship with the interface; every request
   authenticates as if internet-exposed.
9. **The engine has no shell and no raw git.** `brain-commit` plus
   allowlisted bridges are the assistant's entire mutating/outbound surface.
10. **The console's mutating surface is closed.** A closed, enumerated set of
    actions, each a door onto an existing audited service; a new action is a
    product change, never a prompt or a config line (ruled 2026-09-17).

And the principle over all of them: **enforce at the tool, never by
prompting.** "Be careful with X" in a prompt is not a control. If policy
forbids something, the tool must be incapable of it.

## Packages

Every bridge is a published npm package usable by a stranger.

- **The dependency arrow points one way.** `apps/` → `packages/`, never the
  reverse. No package imports project config, Postgres, or the vault.
- **`npx @foldedspacelabs/metistry-mcp-<name>` must work** for someone who has never heard
  of Metistry. Config via env vars, MCP over stdio or HTTP.
- Every bridge and collector exports `check()` so `metistry doctor` is generic.
- Every bridge conforms to `core`'s **wire-level contract** (manifest shape,
  auth header, error envelope, `check()` JSON): TypeScript bridges inherit the
  implementation — lazy tool discovery, preview-then-confirm on destructive
  tools, secret redaction by default — and Swift TCC bridges implement the
  spec, held to it by the same conformance tests.
- Preview-then-confirm on destructive tools binds every bridge; a proxied
  connection tool's Allow · Ask First · Never is the owner's per-tool policy and defaults
  to Ask.

## Stack

TypeScript, pnpm workspaces, changesets. Postgres + pgvector in Docker. Node for
the console. One OpenAI-compatible engine for Metis, on whichever provider
`compute.yaml` assigns (ruled 2026-09-11). Swift for TCC bridges. **Collectors
are TypeScript** — no Python anywhere in the product (ruled 2026-08-29; Phase
0's stack had already gone zero-Python). **Exempt (ruled 2026-09-22):** design
tooling under `docs/product/design/` and PoC scripts under `docs/poc/` — the
ruling was about development itself, and nothing in `apps/` or `packages/`
may import or invoke them.

**Migrations are additive-first.** New columns and tables, not rewrites;
destructive migrations need an explicit decision and a rollback note in the
PR. `metistry update` must be able to run them idempotently under an
advisory lock.

Ask before adding a dependency. This is a system maintained by one person over
years; every dependency is a future maintenance obligation. **Pre-approved**
(no per-PR debate): `@modelcontextprotocol/sdk`, `pg`, `zod`, `yaml`,
`chokidar`, `web-push`,
`@simplewebauthn/server` + `@simplewebauthn/browser` (passkeys — never
hand-roll WebAuthn), and dev tooling (`typescript`, `vitest`,
`changesets`). **Deliberately hand-rolled**
(PoC-proven, do not add a framework for these): migrations (plain SQL + a
tiny runner), the router (rules over regex), launchd plists, the watchdog.
Anything else: ask first.

## Working style

- **Don't build ahead of the plan.** Phase 0 gates Phase 1. If you find yourself
  scaffolding something three phases out, stop.
- **Show real output.** Actual command results over summaries, especially for
  PoCs.
- **Report contradictions, don't route around them.** If a finding conflicts
  with `metistry-build-plan.md`, say so and let me decide. Don't edit the plan.
- **Ask before committing.** And never commit to `main` directly once branch
  protection exists.
- **Small commits with real messages.** One logical change each. This repo is
  meant to be reviewable a year from now.
- **Feed the product record.** When a change has product significance — a
  goal sharpened, a benefit proven with numbers, a safety mechanism shipped
  — add a fragment file under
  `docs/product/record/` (one per PR; folded into `PRODUCT.md` at release by
  `ops/scripts/fold-product-record.mjs`) in the same PR. Launch material gets
  written from that record later, not reconstructed.
