# @foldedspacelabs/metistry-cli

The `metistry` command: `init` stamps a private **instance repo** from the
product's `seed/`; `doctor` validates every component manifest in a
Metistry checkout and probes every bridge, service, container and launchd
job through the one `check()` contract they all implement. `up` and
`update` are documented stubs for now.

```sh
npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "Athena"
npx @foldedspacelabs/metistry-cli doctor --product-dir ~/src/metistry
```

Inside a checkout (`pnpm -r build` first) the same thing is
`node packages/cli/dist/main.js …`, or `pnpm --filter @foldedspacelabs/metistry-cli start -- …`.

## `metistry init <dir> [--name <assistant name>] [--force] [--product-dir <checkout>]`

Creates an instance repo — the private repo that holds everything the
product repo must never contain (plan §4.16) — exactly like the by-hand
bootstrap of 2026-09-06:

- `git init -b main`, one initial commit `Instance created` authored
  `Metistry <metistry@localhost>` (the same author the reconciler stamps)
- `Knowledge/` copied from `seed/Knowledge` (incl. `now.md`)
- `identity.yaml` and `rules.yaml` from seed
- `inbox/` (gitignored) and the tracked, empty config dirs `queries/`
  `agents/` `routines/` `extensions/` `instance-migrations/` — each with a
  `.gitkeep` so they survive a clone. They start empty on purpose: the D4
  overlay reads the product's seeded defaults until a same-named file
  appears here.
- `README.md`, `.gitignore` (`inbox/`, `.obsidian/workspace*`)
- `metistry.lock` pinning the product version (this package's version) and
  the creation date

`--name` writes the assistant's name into `identity.yaml` — the **only**
place the name lives (CLAUDE.md) — and moves `mention:` with it
(`"Athena"` → `"@athena"`). Without `--name` the seed's default stays.
Nothing else in the repo carries the name. There is no prompt; the command
is interactive-free by design so it works under any automation.

A non-empty directory is refused unless `--force` (which stamps around what
is there, overwriting files whose names collide).

**Secrets are printed, never written.** On success the command prints the
lines to add to the *product* checkout's `.env`:

```
METISTRY_INSTANCE_DIR=/Users/you/metistry-instance
METISTRY_BRIDGE_TOKEN_RECONCILER=<minted once, shown only here>
METISTRY_RECONCILER_URL=http://host.docker.internal:7812
```

The reconciler token is minted with `core`'s `mintToken()` and appears in
no file. Rerunning `init` mints a different one — copy it when you see it.

### Where `seed/` comes from

`init` needs the product's `seed/`; `doctor` needs a whole checkout (there
are no manifests to walk otherwise). Resolution order:

1. `--product-dir <checkout>`
2. `METISTRY_PRODUCT_DIR`
3. the checkout this package is installed inside (a `pnpm` workspace)
4. the current directory's enclosing checkout

When none of those is a checkout, `init` falls back to the copy of `seed/`
bundled into this package at build time (`files` in `package.json`), so
`npx … init` works on a machine with no checkout at all. `doctor` does not
fall back — it tells you to point it at a checkout.

## `metistry doctor [--json] [--product-dir <checkout>]`

Generic over manifests (invariant 5). It walks `collectors/`, `routines/`,
`packages/*/manifest.yaml`, `apps/*/manifest.yaml` and `targets/` in the
checkout, validates each against `core`'s `validateManifest`, and:

| what | how it is probed |
| --- | --- |
| `bridge` with `transport: http`, `service` with a `port` | `GET <url>/check` with the bearer; the bridge's own `status`/`remediation` ride through. URL/token come from the env conventions already in use: `METISTRY_AFM_URL` / `METISTRY_BRIDGE_TOKEN_APPLE_FM` (7810), `METISTRY_EK_URL` / `METISTRY_BRIDGE_TOKEN_EVENTKIT` (7811), `METISTRY_RECONCILER_URL` / `METISTRY_BRIDGE_TOKEN_RECONCILER` (7812); anything else follows `METISTRY_<NAME>_URL` / `METISTRY_BRIDGE_TOKEN_<NAME>`. `host.docker.internal` is rewritten to loopback (doctor runs on the host, like the watchdog). URL unset → `absent` with the variables to set. |
| `console` | `GET /health` must be 200; `GET /api/status` must answer 200 or 401 (a passkey session is required — 401 is the auth working). `METISTRY_CONSOLE_URL`, default `http://127.0.0.1:8080`. |
| `brain` | mounted at the console's `/mcp` (no port of its own): `/mcp` must answer 401 or 200. |
| other `service` / `collector` / `routine` / `agent` / `target` | manifest validity; a portless service's row points at its supervisor row (`launchd:…` or `compose:…`). |
| `db` | `SELECT 1` via `METISTRY_DB_*`; `migrations` compares `schema_migrations` rows with `db/migrations/*.sql` — pending files or a missing table are `degraded` with `pnpm db:migrate` as the fix. |
| `launchd:<label>` (macOS only) | `launchctl print gui/<uid>/<label>` for every plist in `ops/launchd`: `running` → ok; any other state → failed with the kickstart command; not bootstrapped → absent with the bootstrap command. |
| `compose:<service>` | `docker compose ps --all --format json` against the services in `docker-compose.yml`: running (+healthy) → ok; running but unhealthy/starting → degraded; exited → failed; no container → absent. No `docker` on PATH → one `absent` row; a daemon that will not answer → `failed`. |

`.env` is loaded from the checkout the way `ops/scripts/*.sh` do it: exported
for variables that are **unset**; anything already in the environment wins.

Output is a table — `name`, `kind`, `status` (`ok` | `degraded` | `failed` |
`absent`), latency in ms, remediation (blank when ok) — and a summary line.
**Exit code 0 when nothing is `failed`**; `degraded` and `absent` are
informational (a bridge that is not configured degrades absent by design).
`--json` prints `{ as_of, product_dir, ok, rows: CheckResult & { kind } }`.

## `metistry up` / `metistry update`

Stubs that print what they will do (pull the pinned release, migrate under
an advisory lock, start compose + launchd; move `metistry.lock`). Until they
exist: `pnpm -r build && docker compose up -d` and the launchd steps in
`docs/ops/reconciler.md`; `git pull && pnpm -r build && pnpm db:migrate`.

## No manifest for the CLI

`core`'s manifest schema admits `bridge | collector | agent | routine |
target | service`. A command-line tool is none of those — it holds no
process, schedule, or network surface for doctor to see — so this package
ships no `manifest.yaml` rather than inventing a type.

## Library use

```ts
import { doctor, renderTable, init } from "@foldedspacelabs/metistry-cli";
const report = await doctor({ productDir: "/path/to/checkout" }); // fetch/db/exec injectable
```

Dependencies: `@foldedspacelabs/metistry-core`, `yaml`, `pg` (all
pre-approved). Argument parsing is hand-rolled (`parseArgs` in `main.ts`).
