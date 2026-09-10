# Deployment shapes — `compose` and `launchd`

Where an install's services run. Same code, same `.env`
(`<instance>/state/.env` — `docs/ops/cli.md`), same
migrations, same `metistry` verbs; only the supervisor and the isolation
boundary differ. Set in `deployment.yaml` (plan §4.17, open decision 15
— resolved 2026-09-07).

|  | `compose` | `launchd` |
|---|---|---|
| db | `pgvector/pgvector:pg17` container | a user-space Postgres 17, `postgres -D` as the launchd job |
| console | container, published on `127.0.0.1:8080` | launchd job, binds `127.0.0.1:8080` |
| assistant | container | launchd job **under `ops/sandbox/assistant.sb`** |
| reconciler | launchd job | launchd job |
| watchdog | launchd job | launchd job |
| needs | Docker Desktop / a container runtime | a Postgres install, nothing else |
| engine isolation | the container | the sandbox profile |
| where it is the answer | Linux, cloud, any multi-tenant host | macOS, and what the Mac app installs |

`compose` is the default and stays the default until an instance flips
it. Nothing about an existing install changes by upgrading past this.

## `deployment.yaml`

Instance config with the D4 overlay: the product ships the default in
`seed/deployment.yaml`, and an instance's own copy — same filename, in
`$METISTRY_INSTANCE_DIR` — wins. New seeded defaults appear on
`metistry update` without touching the user's copy.

```yaml
shape: launchd

services:
  db:
    shape: compose      # keep Postgres in a container under a launchd install
  assistant:
    enabled: false      # `up` does not start it; `doctor` does not fail on it
```

Both keys are optional per service; anything unlisted takes the
install-wide shape. `reconciler` and `watchdog` are host jobs in either
shape (invariant 6) — the reconciler holds the instance repo's working
tree, the watchdog must outlive what it watches.

Parsing is strict. `shape: lauchd` is an error, not a silent compose.

`METISTRY_DEPLOYMENT_SHAPE=launchd metistry up --dry-run` previews a
shape without editing anything; `up` and `doctor` both print which of
the two they read.

## Switching

```sh
# 1. take a dump — the data does NOT move with you
pg_dump ... > before.sql              # or ops/scripts/backup.sh

# 2. stop what is running in the old shape
docker compose down                   # compose → launchd
# or: launchctl bootout gui/$(id -u)/com.foldedspacelabs.metistry.{db,console,assistant}

# 3. flip the file
$EDITOR "$METISTRY_INSTANCE_DIR/deployment.yaml"

# 4. bring it up in the new one
metistry up --dry-run                 # read the plan first
metistry up
pnpm db:migrate                        # or metistry update

# 5. restore, if there was anything you wanted to keep
psql ... < before.sql
```

The two shapes keep their data in different places — a Docker volume
versus `<instance>/state/pg` — so switching is a fresh database plus a
restore, not a move. Invariant 1 is what makes that acceptable: git is
the record, Postgres is derived, and a rebuild costs trend lines rather
than knowledge. Decide about the durable set (`runs`, `sessions`, inbox
Needs You, `work` threads, artifact comments — open decision 13) before you
switch a live install without a dump.

## Postgres, without Docker

`metistry up` looks for a usable Postgres 17 in this order:

1. **`METISTRY_PG_BIN`** — a `bin/` directory. Always wins.
2. **`<product>/runtime/postgres/bin`** — the bundled runtime
   (`docs/ops/bundled-runtime.md`), which is what the Mac app ships inside
   `Metistry.app/Contents/Resources/metistry/`:

   ```
   runtime/postgres/
     bin/        postgres, initdb, psql, createdb, pg_isready,
                 pg_ctl, pg_dump, pg_restore, pg_config
     lib/        libpq and friends, install names rewritten to @rpath
     share/
       extension/    vector.control + vector--*.sql  (pgvector)
   ```

   `runtime/` is gitignored and built by
   `ops/release/build-runtime-deps.sh` — Postgres 17 + pgvector from
   source, relocatable, verified from a moved copy. All five of the
   binaries `up` and `doctor` call must be present for the directory to
   count.

   An install does not have to build it: in **release mode** on the
   launchd shape, `metistry up` downloads the release's
   `metistry-runtime-deps-<version>-darwin-arm64.tar.gz`, verifies its
   sha256 against `checksums.txt` and unpacks it here — but **only** when
   step 1 and step 3 have both come up empty. A git checkout never
   downloads one. `METISTRY_RUNTIME_DEPS=0` disables it entirely.
3. **Homebrew** — `/opt/homebrew/opt/postgresql@17/bin`, then
   `/usr/local/…`. pgvector installs its `vector.control` alongside.

Nothing is ever installed for you. A missing toolchain prints:

```
brew install postgresql@17 pgvector
```

and `up` stops. `pgvector` is checked separately: migration
`0001_init.sql` does `CREATE EXTENSION vector`, so its absence is
called out before the migration fails.

**What `up` does, once:** `initdb -D <instance>/state/pg` with the
superuser password handed over in a file that the next step deletes
(never a command line — `ps` shows those), `--auth-local=trust` for the
operator's own socket connections and `--auth-host=scram-sha-256` for
everything over TCP (invariant 8: loopback is not a boundary). Then a
marker-delimited managed block in `postgresql.conf`:

```
# --- metistry (managed: metistry up rewrites this block) ---
listen_addresses = '127.0.0.1'
port = 5432
unix_socket_directories = '<instance>/state/run'
# --- end metistry ---
```

Everything outside the markers — initdb's choices, anything you add — is
left alone, and re-running `up` rewrites only the block. An initialised
data directory is never re-initdb'd.

If `METISTRY_DB_PASSWORD` is unset, `up` generates one and appends it to
this install's `.env` — `<instance>/state/.env` (gitignored, `0600`, never
printed, never committed), or the product checkout's while an install
predates that move (`docs/ops/cli.md`, "Instance directories are
self-contained").

**Socket path length.** A unix socket path over 103 bytes is silently
unusable, so a deeply nested instance directory fails here rather than
mysteriously later; `up` refuses with a clear message.

**Migrations are unchanged.** `ops/scripts/migrate.sh` and `metistry
update` take the same advisory lock and talk to `127.0.0.1:5432` in
either shape.

## The assistant's sandbox

The container was defence in depth behind invariant 9's allowlist. On
the host, `ops/sandbox/assistant.sb` is. The launchd job's root process
is `/usr/bin/sandbox-exec`, so every child — including the Agent SDK's
own CLI subprocess — inherits the confinement.

| | |
|---|---|
| filesystem read | its own `dist/` + `node_modules/`, the node runtime, the state dir, tmp, system frameworks. **Not** the vault, not `~/Documents`, not the instance repo. |
| filesystem write | the state dir and tmp. Nothing else. |
| exec | the node binary. No shell (invariant 9). |
| network out | the console on loopback, and TLS. Nothing else. |
| state dir | `<instance>/state/assistant`, which is also `HOME` — the SDK's session transcripts live there and survive restarts (the launchd twin of the `assistant-home` volume) |

The parameters are computed in one place (`packages/cli/src/sandbox.ts`)
and the misuse tests in `packages/cli/test/sandbox.test.ts` confine a
throwaway node script with exactly those values, proving four things:
a `~/Documents`-style read fails, a write outside the state dir fails, a
write inside it succeeds, and the console's port connects while any
other port does not. Darwin-only; skipped on Linux CI.

**Two honest limits.**

1. **Outbound is filtered by port, not by host name.** `sandbox-exec`
   cannot express "api.anthropic.com". The profile allows loopback to the
   console and TLS outbound; the Anthropic host list lives as data in
   `packages/cli/src/sandbox.ts` (`ANTHROPIC_HOSTS`:
   `api.anthropic.com`, `statsig.anthropic.com`, `console.anthropic.com`)
   and is documentation today — the variable name
   `METISTRY_ASSISTANT_ALLOWED_HOSTS` is reserved for when there is a
   layer that can enforce it. Read the profile as "the engine
   cannot reach your LAN's other services on their own ports", not as
   "the engine can only reach Anthropic".
2. **`sandbox-exec(1)` is deprecated** — and functional; this profile is
   verified on macOS 26.4 and the shape has worked since 14. The
   migration path is App Sandbox entitlements once the Mac app hosts the
   process (`docs/product/desktop-app-plan.md`): same deny-default
   posture, a supported API, and outbound filtering by name, which
   closes limit 1 at the same time.

Under the compose shape none of this applies — the container is the
boundary and the profile is not used.

## Secrets in plists

The console's and the assistant's environments are rendered into their
plists' `EnvironmentVariables` dict rather than sourced from `.env`
through `sh -c` — no shell, and nothing interpolated. That puts real
secrets in `~/Library/LaunchAgents`, which is `0755`, so `up` writes
those two plists `0600`. The other jobs (reconciler, watchdog, the TCC
bridges) still source a dotenv file themselves, through the plists'
`__ENV_FILE__` placeholder — `<instance>/state/.env`, because an instance
directory is self-contained.

The **reconciler's** dict is a third case, and carries no secret: when this
install has a bundled `runtime/git/bin`, `up` puts it on the front of that
job's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin` is all a launchd job gets, and
a clean Mac has no git until Xcode Command Line Tools are installed). It is
the only job that spawns git (D5), so it is the only one that gets the entry.

The two secret-bearing dicts are built differently on purpose:

- **console** — a passthrough of every `METISTRY_*` in `.env`, with the
  container-only values replaced (db on loopback, a real inbox directory
  instead of the named volume, a loopback bind). It is the component
  that talks to everything.
- **assistant** — an **allowlist**: the db, its own token, the brain URL,
  the model knobs. The GitHub write PAT, the AWS keys and the VAPID
  private key stay with the console; the engine reaches those through an
  allowlisted tool or not at all. The same allowlist is why a stray
  `ANTHROPIC_API_KEY` in the operator's shell cannot reach the engine and
  silently move billing off the subscription (PoC-4).

## Doctor

`doctor`'s first row is the shape and where it was read from, and every
remediation below it is written for that shape — `launchctl kickstart
-k gui/$(id -u)/com.foldedspacelabs.metistry.console` rather than
`docker compose up -d console`. The container runtime is consulted only
when some service actually runs in one, so a launchd install never
reports "docker not found" as a finding.

Logs, under launchd: `/tmp/metistry-{db,console,assistant,reconciler,watchdog}.log`.
Sandbox denials: `log stream --predicate 'sender == "Sandbox"'`.

## `metistry update` under either shape

`update` loads the same `deployment.yaml` and asks for **that shape's**
plist set, so on a launchd install `console`, `assistant` and `db` are
kickstarted along with the other host jobs when their code changes —
they do not keep running old code until the next `metistry up`. It also
skips `docker compose` entirely under `launchd`, the way `up` does; the
restart section says so in the plan. Postgres itself is untouched by an
update: the data directory and the managed conf block are `up`'s job.
