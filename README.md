# Metistry

**A personal AI operating system you own entirely** — a persistent assistant
plus a knowledge vault. Agents are disposable; your context is durable:
markdown in your own git repository, operational state in a Postgres on your
own Mac, in formats that outlive any session, agent or vendor. Open source
under Apache-2.0, with no service operated by the maintainer anywhere in the
path.

- **Safety is structural.** Every rule is enforced at the tool, never by
  prompting: a closed set of mutating actions, scoped default-deny access for
  other agents, preview-then-confirm on anything destructive, and an audit
  trail for every routing choice. The security model is built to survive
  full code visibility — this repository is the proof.
- **Predictable cost.** Rules you write decide which models and tiers may run
  and what a request may cost; budgets and hard limits are enforced, and
  sub-millisecond no-model fast paths answer what needs no model at all.
- **Your compute, your choice.** One OpenAI-compatible engine runs on
  whichever provider `compute.yaml` assigns — a cloud provider with your key,
  or a local model (LM Studio, Ollama, Apple's on-device model).
- **Coordinates your other AI tools.** Any MCP-capable agent — Cursor, Claude
  Code, OpenCode, Devin — gets its own token through one MCP door: it can
  capture into the vault, read what you grant, and share a task list with the
  assistant.

The name is a nod, not an acronym. The oldest stories keep a particular seat
beside a ruler for the counselor — whose gift was never knowing everything,
but turning what's known into what to *do*: distilling noise into counsel,
ordering the day, marshaling the helpers. That craft is what this system is
built around. Hence: metistry.

## Status — 0.14.0

Pre-1.0 and used daily by its maintainer. The approved build plan
(`docs/product/design-build-plan.md`) runs in waves; **W0–W2 are done**.

**Built and shipping:**

- **The Mac app** — a signed, notarized DMG with automatic updates (Sparkle).
  It installs and runs everything: the bundled runtime (Node, Postgres with
  pgvector, git), one background item, a menu bar, a Status window and
  Settings (instance, services, connections, compute, secrets, updates). Its
  daily screens so far: **Today** (the brief, Next Up, Close the Day, the
  day's spine), **Chat**, **Activity**, **Needs You**, the **Usage** popover
  and the **capture** composer.
- **The web app (PWA)** — the client for the phone and any other computer:
  Today, chat, Needs You, the board and push notifications you can answer,
  enrolled with a passkey.
- **The `metistry` CLI** — `init`, `up`, `update`, `doctor`, `connect`,
  `secrets`, `compute` and the rest (`docs/ops/cli.md`); every step the app
  takes is a CLI verb, so the terminal path is first-class and identical.
- **Routines** — the Morning Brief, the Standup, Close the Day, the evening
  knowledge fold, Tomorrow's Plan and the weekly review, on a scheduler.
- **Connections** — MCP servers with a per-tool On · Ask · Off policy, and
  `metistry connect cursor | claude-code | opencode | devin` for your other
  tools. Collectors for GitHub, Linear, Apple Calendar and Reminders (through
  a signed Swift bridge), Devin, and spend.

**Not built yet** (scheduled in waves W3–W5): the Mac app's Work, Knowledge,
Agents and Scheduled screens (their sidebar rows say so and offer the web
app); attachments and audio in the Mac app's capture; calendars beyond Apple
Calendar (ICS, CalDAV, Google), IMAP mail, OAuth connections, meeting
recording, and offline mode in the web app. There is no iOS app and no
hosted version — Metistry is free software you run yourself.

## Install

**The Mac app** (Apple silicon, macOS 14 or later): download
`Metistry-<version>.dmg` from
[GitHub Releases](https://github.com/foldedspacelabs/metistry/releases),
open it and drag the app to Applications. The first run copies the bundled
runtime, creates your instance and asks you to name your assistant, connects
a GitHub repository of your own (keep it private — it holds your vault) by
device flow, and sets up compute. Updates arrive in the app.

**From a checkout** (Node 22 or later and pnpm; the path for development and
for hosts without the app):

```sh
git clone https://github.com/foldedspacelabs/metistry.git && cd metistry
pnpm install && pnpm -r build
node packages/cli/dist/main.js init ~/metistry-instance --name "<assistant name>"
node packages/cli/dist/main.js up
```

`init` also runs with no checkout at all, as
`npx @foldedspacelabs/metistry-cli init`. `metistry doctor` says what is
running and what is not configured yet; `docs/ops/second-instance.md` is a
complete terminal walk-through, local compute and connected tools included.

Then open the instance directory in Obsidian — it is the vault — and install
the web app on your phone from the console's address.

## How it is put together

- **Product and instance are separate repositories.** This is the product
  repo — code only. Each install lives in its own *instance repo* (the vault,
  `identity.yaml`, configuration, a release pin), created by `metistry init`
  and owned by whoever runs it. Code flows to instances as versioned
  releases, never as git merges; instance data never flows anywhere.
- **Git is the record; Postgres is derived.** Delete the database, rebuild,
  run the collectors once, and you are back minus historical trend lines.
- **The assistant's name lives only in `identity.yaml`.** Code says
  `assistant`; a second instance or a fork is a clone, not a rewrite.
- **Every bridge is a package a stranger can use.**
  `npx @foldedspacelabs/metistry-mcp-eventkit` (Calendar and Reminders),
  `…-mcp-apple-fm` (Apple's on-device model), `…-mcp-brain` (the vault) and the
  libraries under `packages/` work without the rest of Metistry.

| directory | what it holds |
| --- | --- |
| `apps/` | the console (API, web app, MCP door), the assistant, the reconciler, the watchdog, and the Mac app (`apps/macos`, SwiftUI) |
| `packages/` | the CLI, `core`, named queries, tasks, connections, artifacts and the MCP bridges — published to npm |
| `collectors/`, `routines/` | the data collectors and the scheduled routines |
| `db/migrations/` | additive-first SQL migrations |
| `seed/` | what `metistry init` gives a new instance: config, queries, vault templates |
| `ops/` | release, packaging, CI and development scripts |

## Where to read next

- **`docs/product/glossary.md`** — the vocabulary; read it first.
- **`metistry-build-plan.md`** — the design and its invariants.
- **`docs/product/design-build-plan.md`** — the approved build plan and its
  waves; tickets under `docs/product/tickets/`.
- **`docs/ops/`** — how each part works and is operated: `cli.md`,
  `mac-app.md`, `compute.md`, `connections.md`, `releases.md`, `testing.md`.
- **`docs/product/PRODUCT.md`** — the living product record.
- **`docs/poc/RESULTS.md`** and **`docs/research/`** — the proof-of-concept
  evidence and research behind the design.
- **`CONTRIBUTING.md`** and **`SECURITY.md`** — how to contribute and how to
  report a vulnerability.
