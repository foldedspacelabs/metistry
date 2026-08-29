# Metistry — development conventions

**This file governs building Metistry.** It is not Metis's operating
instructions — those live at `Knowledge/CLAUDE.md` and are written later, once
the interaction has been felt rather than guessed at. Don't confuse the two.

Read `BUILD-PLAN.md` for the design. This file covers how to work in the repo.

## Naming

- **Metistry** — the project. Repo, npm scope `@foldedspacelabs/*`, CLI command.
- **Metis** — the assistant. Lives **only** in `identity.yaml`.

The assistant's name must never appear in a path, table name, env var, package
name, class, or function. Internally everything is `assistant_*`; prompts
template the name from config. This is what makes the work instance and any fork
a clone rather than a rewrite. Treat a hardcoded "Metis" as a bug.

## Casing

One boundary:

- `Knowledge/` and everything inside it — **TitleCase**. Obsidian renders these
  names to the user.
- Everything else — **lowercase**. Code and tooling reference it, and `apps/`
  and `packages/` are pnpm conventions.

macOS is case-insensitive; Linux containers are not. `knowledge/Areas` in one
file and `Knowledge/areas` in another works here and breaks in a container. CI
runs on Linux and checks this.

## Invariants

These are decisions, not preferences. Raise it with me before violating one.

1. **Git is the record; Postgres is derived.** `docker compose down -v`, rebuild
   from the repo, run collectors once → back in business minus historical trend
   lines. Anything that fails that test needs backing up; nothing else does.
2. **One read path into state.** Named queries in `router/queries/`. No component
   talks to Postgres directly.
3. **The router is deterministic.** No model decides which model to use.
4. **Everything is a directory with a manifest.** Bridges, collectors, agents,
   routines. CI validates.
5. **Native only where macOS requires it.** `runs_on: host` for TCC-bound
   components; everything else containerises.
6. **Cloud-portable by construction.** No absolute paths, config from
   environment, nothing assumes a shared filesystem.
7. **Enforce at the tool, never by prompting.** "Be careful with X" in a prompt
   is not a control. If policy forbids something, the tool must be incapable of
   it.

## Packages

Every bridge is a published npm package usable by a stranger.

- **The dependency arrow points one way.** `apps/` → `packages/`, never the
  reverse. No package imports project config, Postgres, or the vault.
- **`npx @foldedspacelabs/mcp-<name>` must work** for someone who has never heard
  of Metistry. Config via env vars, MCP over stdio or HTTP.
- Every bridge and collector exports `check()` so `metistry doctor` is generic.
- Every bridge inherits from `core`: lazy tool discovery, preview-then-confirm on
  destructive tools, secret redaction by default.

## Stack

TypeScript, pnpm workspaces, changesets. Postgres + pgvector in Docker. Node for
the console. Claude Agent SDK for Metis.

Ask before adding a dependency. This is a system maintained by one person over
years; every dependency is a future maintenance obligation.

## Working style

- **Don't build ahead of the plan.** Phase 0 gates Phase 1. If you find yourself
  scaffolding something three phases out, stop.
- **Show real output.** Actual command results over summaries, especially for
  PoCs.
- **Report contradictions, don't route around them.** If a finding conflicts with
  `BUILD-PLAN.md`, say so and let me decide. Don't edit the plan.
- **Ask before committing.** And never commit to `main` directly once branch
  protection exists.
- **Small commits with real messages.** One logical change each. This repo is
  meant to be reviewable a year from now.
- **Feed the product record.** When a change has product significance — a
  goal sharpened, a benefit proven with numbers, a safety mechanism shipped,
  a premium candidate identified — add a line to `docs/product/PRODUCT.md`
  in the same PR. Launch material gets written from that record later, not
  reconstructed.
