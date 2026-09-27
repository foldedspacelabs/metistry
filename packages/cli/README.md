# @foldedspacelabs/metistry-cli

The `metistry` command: `init` stamps a private **instance repo** from the
product's `seed/`; `connect-repo` points it at a private remote with
credentials the reconciler can push with unattended; `secrets` makes the
macOS login Keychain the canonical store for everything `.env` would
otherwise hold in the clear; `doctor` validates every component manifest in a
Metistry checkout and probes every bridge, service, container and launchd
job through the one `check()` contract they all implement; `up` brings a
checkout + `.env` to running (compose, launchd, doctor); `update` moves it
forward (pull, build, migrate under an advisory lock, restart what changed,
pin `metistry.lock`, doctor).

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
- `Knowledge/Inbox/` — where captures land, inside the vault so Obsidian
  sees them and git carries them (docs/ops/inbox.md)
- the tracked, empty config dirs `queries/` `agents/` `routines/`
  `extensions/` `instance-migrations/` — each with a `.gitkeep` so they
  survive a clone. They start empty on purpose: the D4 overlay reads the
  product's seeded defaults until a same-named file appears here.
- `README.md`, `.gitignore` (`state/`, `.obsidian/workspace*`,
  `Knowledge/Inbox/.large/`)
- `metistry.lock` pinning the product version (this package's version) and
  the creation date

`--name` writes the assistant's name into `identity.yaml` — the **only**
place the name lives (CLAUDE.md) — and moves `mention:` with it
(`"Athena"` → `"@athena"`). Without `--name` the seed's default stays.
Nothing else in the repo carries the name. There is no prompt; the command
is interactive-free by design so it works under any automation.

A non-empty directory is refused unless `--force` (which stamps around what
is there, overwriting files whose names collide).

It also mints an **`instance_id`** (a v4 UUID) into `identity.yaml`: this
directory's stable identity, and the login-Keychain account its own
secrets are filed under.

**Secrets are printed, never written.** On success the command prints the
lines to put in `<dir>/state/.env`, this instance's own environment:

```
METISTRY_INSTANCE_DIR=/Users/you/metistry-instance
METISTRY_BRIDGE_TOKEN_RECONCILER=<minted once, shown only here>
METISTRY_BRIDGE_TOKEN_RECONCILER_USER=<minted once, shown only here>
METISTRY_RECONCILER_URL=http://host.docker.internal:7812
```

Both reconciler tokens are minted with `core`'s `mintToken()` and appear in
no file. Rerunning `init` mints different ones — copy them when you see them.
They are not interchangeable: the `_USER` one is the owner class, the only
credential the vault bridge lets write a §4.7 protected path
(`docs/ops/auth.md`).

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

## `metistry connect-repo <url> [--instance <dir>] [--auth device|token|ssh] [--force]`

Sets `origin` on the instance repo (refusing to repoint an existing one
without `--force`), leaves a credential git can use with no human present,
verifies the remote with `ls-remote`, flushes the reconciler's commit
queue if one is running, and pushes the current branch once.

- `--auth device` (default for `https`) runs GitHub's
  device-authorization flow against the **public** OAuth App client id in
  `METISTRY_GITHUB_OAUTH_CLIENT_ID`: it prints a user code and
  `https://github.com/login/device`, polls (handling
  `authorization_pending` and `slow_down`), and stores the resulting
  token in the login Keychain as an internet password for the host —
  the item `git-credential-osxkeychain` looks for. The repo is configured
  to use that helper.
- `--auth token` reads a personal access token from **stdin** and stores
  it the same way. `--auth ssh` stores nothing: your key is the credential
  and `ls-remote` is the proof.
- On Linux the Keychain step is skipped and the `credential.helper store`
  equivalent is printed instead.

No token is printed, logged, written to `.env`, or put in the remote URL.
Every subprocess is an argument array — there is no shell.

## `metistry migrate-inbox [--instance <dir>] [--dry-run]`

Moves an instance created before 2026-09-16 onto the vault inbox
(`docs/ops/inbox.md`): `inbox/*` — or a second instance's lowercase
`Knowledge/inbox/`, renamed through a temp name because macOS is
case-insensitive — into `Knowledge/Inbox/`, `git mv` for what git tracks and
a plain move for what it does not; `inbox/` out of `.gitignore` and
`Knowledge/Inbox/.large/` in; `inbox.path` rows rewritten to
`Knowledge/Inbox/<file>`; one commit.

Idempotent (a second run reports "already on the vault inbox" and changes
nothing) and it restarts nothing — it prints the `metistry up` line and
stops. `--dry-run` prints the same plan and runs none of it.

## `metistry secrets sync|mint|list|purge`

```sh
metistry secrets sync --to keychain               # import .env's secret lines
metistry secrets sync --to env                    # regenerate them from the Keychain
metistry secrets mint METISTRY_ASSISTANT_TOKEN    # a new random token, into both
metistry secrets list                             # names and scopes, never values
metistry secrets purge --instance <dir> [--yes]   # delete one instance's items
```

Secret-shaped names are those ending `_TOKEN`, `_PASSWORD`, `_PRIVATE`,
`_SECRET`, `_KEY`, those carrying `_TOKEN_`/`_PASSWORD_`/`_SECRET_`
mid-name (`METISTRY_BRIDGE_TOKEN_<NAME>`); the names come from
`.env` and `.env.example`, including their commented-out declarations.
`--to env` rewrites only those lines, in place, `0600`, leaving every
comment and non-secret line byte-for-byte intact. Values reach `security`
on stdin, never in argv.

An item is `metistry:<VAR>` plus an **account**, and there is one: the
instance's `instance_id` (the per-user account `metistry` only while an
install has none yet). The shared per-user scope third-party credentials
once lived in is retired (plan §2.14): every `METISTRY_*_API_KEY`,
`METISTRY_DEVIN_API_KEY` and the AWS keys are owner-named secrets of each
instance now (`METISTRY_DEVIN_API_KEY` → `{{ secret.devin_api_key }}`),
`sync --to env` fills their lines from those and never reads the per-user
account, and `secrets migrate-scope` copies the old originals in (deleting
nothing; `metistry update` runs it). `purge` deletes one instance's items
only, preview-then-confirm; `purge-shared` removes a per-user original only
once every instance on the Mac has its copy.

`--instance <dir>` says which instance; `--env-file` targets a `.env`
other than `<instance>/state/.env`.

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

`.env` is loaded the way `ops/scripts/*.sh` do it: exported for variables
that are **unset**; anything already in the environment wins. It is read
from `<instance>/state/.env` first (`--instance`, else
`METISTRY_INSTANCE_DIR`) and then the product checkout's — deprecated but
still read, and still the place a terminal install may declare
`METISTRY_INSTANCE_DIR`, which is parsed out before either file is applied.

Output is a table — `name`, `kind`, `status` (`ok` | `degraded` | `failed` |
`absent`), latency in ms, remediation (blank when ok) — and a summary line.
**Exit code 0 when nothing is `failed`**; `degraded` and `absent` are
informational (a bridge that is not configured degrades absent by design).
`--json` prints `{ as_of, product_dir, ok, rows: CheckResult & { kind } }`.

## `metistry up [--no-compose] [--no-launchd] [--dry-run] [--product-dir <checkout>]`

Checkout + `.env` → running. `docker compose up -d --build` (or `pull` +
`up -d --no-build` when the instance's `metistry.lock` says
`source: release`); every `ops/launchd/*.plist` rendered (`__REPO__` → the
checkout, `__NODE__` → the first `node` on PATH, symlink unresolved) into
`~/Library/LaunchAgents/` and `bootout` / `bootstrap` / `kickstart -k`
(macOS — on Linux the equivalent systemd user units are printed, not
written); then `doctor`, whose verdict is the exit code. A failing step
stops the plan, doctor still runs, the step's exit code is kept.
`--dry-run` prints every command and file write and runs nothing.

## `metistry update [--skip-build] [--skip-migrate] [--dry-run] [--product-dir <checkout>]`

`git fetch` + `git pull --ff-only` (or `docker compose pull` and a printed
npm install in release mode) → `pnpm install --frozen-lockfile` +
`pnpm -r build` → `db/migrations/*.sql` not in `schema_migrations`, in
order, one transaction each, under `pg_advisory_lock(1296389203)` — the
same key `ops/scripts/migrate.sh` takes, so the two can never interleave
→ `docker compose up -d --build` + `launchctl kickstart -k` for each host
job whose executed code (`apps/<svc>/dist`, read from its plist) hashed
differently after the build → `metistry.lock` written into the instance
repo through the reconciler bridge (`POST /vault/write`, principal `user`,
message `metistry update → <version>`), or directly only when no bridge is
configured and no reconciler job is running → `doctor`.

`metistry.lock` shape (`lock.ts`; `init` writes the same):
`product: { version, commit, source: git | release }`, `updated_at`,
`migrations_applied: [...]`. Runbook detail — what "changed" means, the
lock-write rules, Linux — is in `docs/ops/cli.md`.

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
