# Deployment shapes — `compose` and `launchd`

Where an install's services run. Same code, same `.env`
(`<instance>/state/.env` — `docs/ops/cli.md`), same
migrations, same `metistry` verbs; only the supervisor and the isolation
boundary differ. Set in `deployment.yaml` (plan §4.17, open decision 15
— resolved 2026-09-07).

|  | `compose` | `launchd` |
|---|---|---|
| db | `pgvector/pgvector:pg17` container | a user-space Postgres 17, `postgres -D`, a **child of the supervisor** |
| console | container, published on `127.0.0.1:8080` | a child of the supervisor, binds `127.0.0.1:8080` |
| assistant | container; the file passes through the provider key `compute.yaml` names | a child of the supervisor, **under `ops/sandbox/assistant.sb`** — and not a child at all without an engine (below) |
| reconciler | launchd job | a child of the supervisor |
| watchdog | launchd job | **it IS the supervisor** |
| launchd agents | reconciler, watchdog, the bridges | **one**: `com.foldedspacelabs.metistry`, plus a TCC helper each |
| needs | Docker Desktop / a container runtime | a Postgres install, nothing else |
| engine isolation | the container | the sandbox profile |
| where it is the answer | Linux, cloud, any multi-tenant host | macOS, and what the Mac app installs |

`compose` is the default and stays the default until an instance flips
it. Nothing about an existing install changes by upgrading past this.

## Status: `launchd` is trialled end to end (2026-09-10)

Run on the Studio against the **v0.4.0 release packs and the bundled
runtime**, on a scratch instance, with the production compose install left
running beside it the whole time (its own labels, its own ports, never
stopped). Open decision 15 is **proven**; no Docker was involved at any
point.

| | |
|---|---|
| product dir | `~/Library/Application Support/Metistry/product` — seeded from a bundle by `metistry runtime install` (`docs/ops/mac-app.md`) |
| instance | `~/Library/Application Support/Metistry/trial-instance`, `metistry init --channel release`, `shape: launchd` |
| namespace | `metistry up --namespace` → labels `com.foldedspacelabs.metistry.e5dbfa9c.*`, ports 8460-8464 |
| db | bundled Postgres 17.11 + pgvector 0.8.6, initdb'd under `<instance>/state/pg`, socket in `<instance>/state/run` |
| migrations | 13 applied under `pg_advisory_lock(1296389203)` by `metistry update` |
| node | the bundled `runtime/node/bin/node` 22.23.2 — every plist execs it |
| git | the bundled `runtime/git/bin` on the reconciler's PATH |
| doctor | **23 ok, 0 degraded, 0 failed, 2 absent — healthy** (the two absent are the TCC bridges, deliberately not enabled) |
| agents | five, at the time — one supervisor plus the TCC helpers since ("One background item, called Metistry" above) |
| console | `GET /health` → `200 {"ok":true}` on 8460, while production answered on 8080 |
| update | `metistry update --channel release --version 0.4.0` — a clean no-op round trip (`already running 0.4.0`, `runtime/ is already the 0.4.0 pack`, `0 applied, 13 total`), lock committed by the reconciler |
| sandbox | live probe with the plist's own parameters: vault read **denied**, write outside the state dir **denied**, write inside **allowed**, own console + db **allowed**, the production install's console and reconciler **denied** |

### What the trial fixed

Five defects, each of which could only have shown up by running it. All
five are fixed in the same PR, with tests:

1. **A space in the install path killed four jobs.** The reconciler,
   watchdog and TCC bridge plists build a `/bin/sh -c` string, and
   `~/Library/Application Support/…` — the app's default location for BOTH
   the product and an instance — split it: `/bin/sh:
   /Users/…/Library/Application: No such file or directory`. Those
   placeholders are single-quoted now, and `renderPlist` refuses a value
   containing a quote of its own.
2. **`.env` is RUN, not parsed, by those jobs.** `set -a; . <file>` means
   an unquoted value with a space in it is a command. `up` now refuses,
   naming the variables and line numbers, rather than installing four jobs
   that respawn forever. **Quote values in `<instance>/state/.env`.**
3. **The assistant's sandbox had no rule for Postgres.** Under compose the
   engine reached the db over the container network; under launchd it is a
   loopback port and the profile denies by default, so the engine died at
   startup with `EPERM connect`. `DB_TCP` is a profile parameter now.
4. **`launchctl bootout` is asynchronous.** Bootstrapping the same label
   immediately after races launchd and fails `Bootstrap failed: 5:
   Input/output error`, which aborted `up` partway. It polls
   `launchctl print` until the job is gone.
5. **A namespaced instance's ports reached neither the dotenv-sourcing
   jobs nor `metistry update`.** The trial reconciler tried to bind 7812
   and died with EADDRINUSE against the production one; worse, `update`'s
   migration runner connected to 127.0.0.1:5432 and would have migrated
   the DEFAULT install's database.

And in the release pack itself: **`ops/sandbox/` was not shipped**, so
every pack up to v0.4.0 produces a launchd shape whose assistant job cannot
start at all. `pack-runtime.sh` carries it now and fails without it.

### And a live install can now move (2026-09-10)

`metistry migrate-shape launchd` moves an install that is already running
in one shape into the other, with its data — rehearsed on a scratch copy
of the Studio's production install, production's own database restored
into it, running beside the live one throughout. **exit 0; doctor 23 ok, 0
failed; every table's row count identical; `0 applied, 13 total`
migrations afterwards.** The runbook is
`docs/ops/migrate-compose-to-launchd.md`, and it found five more defects
of the same kind as the five above.

### What is still missing

Ranked, worst first. Numbers 5 and 6 are fixed; 9-12 are what the
migration rehearsal added.

1. **The TCC bridges cannot be namespaced.** the calendar helper's socket is
   a hardcoded `/tmp/metistry-eventkit.sock` in its plist, and TCC consent
   is per signed binary — so two instances share one helper and fight over
   one socket. The trial had to remove those three plists from its product
   dir to run safely beside a live install.
2. ~~**`deployment.yaml` cannot disable a bridge job.**~~ Fixed for the
   launchd shape (2026-09-10): a bridge is installed only when its
   `METISTRY_*_URL` is set. `services: {enabled: false}` is still not read by
   `up` for the other services.
3. **`doctor` reports one instance, not the Mac.** It reads
   `METISTRY_INSTANCE_DIR` and probes that install. The app's
   instance-switching UI will want per-instance rows.
4. ~~**`metistry init` does not emit everything the console needs.**~~ Fixed
   (2026-09-16): `init` now prints `METISTRY_ORIGIN` too — the console
   refuses to start without it in either shape — defaulting to
   `http://127.0.0.1:<console port>` for a loopback-only install (a
   tailnet hostname or an HTTPS reverse proxy replaces it once this
   instance is reachable off the machine; passkeys enrolled here bind to
   whichever origin is configured at enrolment time). `METISTRY_RECONCILER_URL`
   is shaped for the install `init` targets — launchd by default on
   macOS, `http://host.docker.internal:7812` still the default for
   `--shape compose` — on `127.0.0.1` with this instance's own ports once
   it is namespaced (`state/ports.yaml`, below). `METISTRY_ASSISTANT_TOKEN`
   was never a hard blocker: absent, the console still starts and only the
   internal agent is revoked (the assistant runs tool-less,
   `docs/ops/assistant-tools.md`).
5. **A release install with no `METISTRY_GITHUB_TOKEN` cannot resolve a
   release from a private repo.** `resolveRelease` falls back to the `gh`
   CLI on 401/403 but not on 404, and GitHub answers 404 for a private
   repo it will not admit exists. Moot once the repo is public; not moot
   today.
6. **The runtime pack carries no `.env.example`**, so `metistry secrets
   sync`'s example file is missing on a release install.
7. **A bridge's "not configured" remediation prints the manifest's default
   port** (`http://127.0.0.1:7811`) rather than this instance's namespaced
   one.
8. **`sandbox-exec` still filters outbound by port, not host name** — the
   pre-existing honest limit below, unchanged.
9. **The runtime pack ships no built TCC helpers.** `pack-runtime.sh`
   copies each `mcp-<name>/helper`, but the `.app` bundles inside them are
   gitignored build output no release runner builds — so a release carries
   the Swift sources and nothing executable, and a release install's
   eventkit/apple-fm jobs have no helper to exec unless a git checkout on
   the same Mac built one. The pin (`packages/cli/src/tcc-pin.ts`) that
   points those two jobs at the already-granted bundles as a stopgap is
   applied by `up` on EVERY run, not only by `migrate-shape` — `up`
   re-renders the calendar plist and rewrites `supervisor.json` from
   scratch each time it installs the launchd shape (a plain `metistry up`,
   `update`, and the eight-agents-to-one-supervisor conversion all go
   through it), so if only `migrate-shape` pinned, the next `up` silently
   un-pinned both bridges. The real fix is still to build and sign the
   helpers in the `macos-app` job, which holds the certificate
   (`docs/ops/migrate-compose-to-launchd.md`, "The TCC helper bundles").
10. **`--namespace` does not namespace the docker compose project.**
    `docker-compose.yml` carries `name: metistry`, so under the compose
    shape a second install's `docker compose stop|up` acts on the first
    install's containers unless `COMPOSE_PROJECT_NAME` is set in its
    `.env`. `migrate-shape` refuses that combination; `up` does not.
11. **`applyPorts` and `portEnv` disagree about an explicit port.** The
    namespace block "fills only variables that are UNSET" for the process
    environment (`applyPorts`), but `portEnv` — rendered into the plists of
    the jobs that source `.env` — sets every port unconditionally. An
    explicit `METISTRY_DB_PORT` in `.env` and `--namespace` therefore mean
    two different things depending on which job is asking. Related:
    `docker compose` reads `.env` and knows nothing about `ports.yaml`, so
    a namespaced install under the compose shape must ALSO declare its
    ports in `.env` or it publishes the defaults.
12. **`protected-write.ts` probes the un-namespaced reconciler label.**
    `RECONCILER_LABEL` is the fixed `com.foldedspacelabs.metistry.reconciler`,
    so on a namespaced instance with no `METISTRY_RECONCILER_URL` the
    "is a reconciler running?" guard inspects a DIFFERENT install's job.
13. **`metistry console whoami` ignores the namespace.** With no
    `METISTRY_URL` set it talks to 127.0.0.1:8080 — which on a Mac with two
    installs is the other one's console.

## One background item, called Metistry (2026-09-10)

macOS shows one **background item** per launchd agent, and names it after the
agent's program. The five-agent launchd shape therefore introduced itself to
the user as five strangers — `sfltool dumpbtm` on the Studio's install said
`Executable Path: /bin/sh` for four of them, and System Settings said "sh",
"node", "postgres". That is not a product.

**Everything Metistry installs carries the Metistry name, and the core is ONE
background item.**

| label | what it is | what System Settings shows |
|---|---|---|
| `com.foldedspacelabs.metistry` | the supervisor: Postgres, the console, the reconciler, the assistant and any configured bridge as its children | **Metistry** |
| `com.foldedspacelabs.metistry.calendar` | the EventKit helper — TCC needs its own signed binary (invariant 6) | **Metistry Calendar Access** |

The Apple Intelligence helper is spawned by its bridge over stdio and is not a
launchd job at all; its bundle is named **Metistry Apple Intelligence** for the
Privacy pane. The helper bundles' **identifiers** are unchanged
(`com.foldedspacelabs.metistry.eventkit` / `.apple-fm`) — TCC keys a grant on
bundle id + certificate chain, so renaming one would cost every install its
consent. A launchd label is in neither, which is why `eventkit-helper` could
become `calendar`.

A namespaced install suffixes the **supervisor**, not each child:
`com.foldedspacelabs.metistry.e5dbfa9c`. One instance is one agent either way.

### Two registrars, and only ever one (2026-09-17)

The same agent can be installed two ways, and which one did it decides who can
switch it off:

| registrar | how | what System Settings shows |
|---|---|---|
| **the Mac app** | `SMAppService.agent(plistName: "com.foldedspacelabs.metistry.plist")`, from the plist sealed inside `Metistry.app/Contents/Library/LaunchAgents` | one row, **Metistry**, with the agent nested under the app, attributed to Folded Space Labs, and a switch — mirrored by Settings → Services → "Run Metistry in the background" |
| **a terminal install** | `metistry up` renders the plist into `~/Library/LaunchAgents` and `launchctl bootstrap`s it | a background item **beside** the app, named after its program (`Metistry`, because of the symlink), with no switch anywhere but a terminal |

Both are supported and neither is going away — the terminal path is
first-class (docs/ops/mac-app.md). What must never happen is **both**: two
loaded jobs under one label is the same install running twice, and it is the
normal accident, because `metistry update` runs an `up` on every release and
somebody who installed with the app will eventually run one in a terminal.

**`metistry up` asks launchd, before it installs anything.** `launchctl print
gui/$UID/com.foldedspacelabs.metistry` names the job's plist and its resolved
program; if either is inside a `.app` bundle, the app owns it, and `up` does
not render, bootstrap or kickstart its own. It says so in one line, and
everything else it does is unchanged — including writing
`<instance>/state/supervisor.json` and the launcher's `supervisor.env`, which
are exactly what the app's agent reads. `--register-via app` is the same
decision made explicitly, for the first install, before anything is loaded to
detect.

**Why launchd's answer and not a marker file.** A marker in
`state/supervisor.json` (or anywhere else) is a second record of a fact launchd
already holds, and it goes stale the moment the app is dragged to the Trash or
the item switched off in System Settings — after which `up` would skip a
bootstrap on the strength of a registration that no longer exists, and the
install would simply not run. Live state cannot be stale, and the cost is one
read-only `launchctl print`. Where launchd reports nothing useful (no plist path
at all), the answer is `unknown`, which does **not** skip: the failure mode of
guessing wrong is a silent non-install, so the default is the behaviour that has
always worked.

`--dry-run` executes nothing, probe included, and prints a line saying that is
the one thing it could not look up.

**`metistry doctor` reports the owner** on the supervisor's row —
`meta.registrar` (`app` | `launchd`), `meta.registered_from`, and the same in
the probe text, which is what the Mac app's Services pane renders for a healthy
row.

### What the supervisor does

- **Ordered start.** Each child may declare a readiness probe; the next one
  waits for it. Postgres answers → console → reconciler → assistant. A probe
  that times out is a log line, not an abort: the rest still starts.
- **Per-child restart policy.** Exponential backoff from 1s to 60s, reset once
  a child has been up a minute. Five restarts inside two minutes and the child
  is reported `crash-looping` — retried at the ceiling rather than hammered,
  and named in `doctor` instead of scrolling past in a log.
- **Per-child logs**, at the same `/tmp/metistry-<service>.log` paths
  `metistry logs <service>` has always tailed.
- **Graceful stop.** SIGTERM, the child's grace period, then SIGKILL —
  children stopped in reverse start order.
- **The watchdog, unchanged.** The probes and the presence feed run in this
  same process; invariant 3's sole exception did not move.

### `<instance>/state/supervisor.json`

Written by `metistry up`, mode 0600, and readable by a person:

```json
{
  "schema": 1,
  "label": "com.foldedspacelabs.metistry",
  "socket": "<instance>/state/run/supervisor.sock",
  "token": "…",
  "env": { "METISTRY_DB_PASSWORD": "…", "…": "…" },
  "children": [
    { "name": "db", "argv": ["…/bin/postgres", "-D", "…"], "log": "/tmp/metistry-db.log",
      "ready": { "kind": "tcp", "port": 5432 } },
    { "name": "console", "argv": ["…/node", "…/apps/console/dist/main.js"], "env": { "…": "…" },
      "log": "/tmp/metistry-console.log", "ready": { "kind": "tcp", "port": 8080 } },
    { "name": "reconciler", "…": "…" },
    { "name": "assistant", "argv": ["/usr/bin/sandbox-exec", "-f", "…/assistant.sb", "…"], "…": "…" }
  ]
}
```

Each child's argv still comes from `ops/launchd/*.plist` — those templates are
still the record of how a service is started, and `up` renders them through the
same `renderPlist` as before, then turns the rendered plist into a child spec.
Everything the 2026-09-10 trial and the migration rehearsal fixed there (the
single-quoting, the refusal to leave a placeholder behind) is still in the
path, and a child runs byte-for-byte the command its agent used to.

**A child's environment is the spec's, whole.** The supervisor's own is never
inherited — which is what keeps the assistant's allowlist an allowlist: a
stray `ANTHROPIC_API_KEY` in the operator's shell reaches the engine through
neither the plist dict before nor this now (PoC-4). What a plist with no dict
used to get implicitly (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME`,
`TMPDIR`) is written into the spec explicitly.

### The control socket

`<instance>/state/run/supervisor.sock`, mode 0600, one JSON object per line:

```
{"op":"status","token":"…"}                     → {"ok":true,"children":[…]}
{"op":"restart","token":"…","service":"console"}
{"op":"stop","token":"…","service":"assistant"}
{"op":"start","token":"…","service":"assistant"}
```

`metistry restart|stop|start <service>` uses it for the supervisor's children,
because launchctl cannot address a process launchd has never heard of;
launchctl stays for the supervisor itself and for the TCC helpers. With no
service named, the agents are acted on and the children follow them — booting
out the supervisor takes its children down with it, and bootstrapping it
starts them in order.

The socket is in the instance's own state directory and is 0600, and the
request is **still authenticated** with the token from `supervisor.json`
(constant-time; a refusal says only `unauthorized`). Invariant 8: a boundary
is tested, and "it cannot be reached" is not an authentication story. There is
deliberately no "stop everything" op — that is `launchctl bootout` of one
label, which launchd already does properly.

`doctor` asks the supervisor for `status` and prints a row per child
(`child:console`, with its state, pid, restart count and log path), because
`launchctl print` cannot see them.

### Migrating an install that predates it

`metistry up` boots out the pre-supervisor agents once — `db`, `console`,
`assistant`, `reconciler`, `watchdog`, `eventkit`, `apple-fm`,
`eventkit-helper` — and deletes their plists before installing the supervisor,
so nothing is left running twice. It is unconditional and tolerant: booting
out a label that is not loaded is the cheapest possible no-op, and an `up`
that only cleaned up when it noticed would leave a job running on the one Mac
where the notice failed. Under the compose shape only `eventkit-helper` is
retired (it was renamed `calendar`); nothing else about that shape changes.

`metistry migrate-shape launchd` produces the new set directly.

### The assistant is a child only when there is an engine

Same rule as the bridges, for the one component that needs a model. An engine
is two things (`compute.yaml`, docs/ops/compute.md): an `assignments.default`,
and the key the provider it names declares in `providers.<name>.auth.secret`.
With either missing, `up` leaves the assistant out of `supervisor.json` (it
hard-requires both and could only crash-loop), prints `assistant: absent — …`
naming the half that is missing and the command that fixes it, and `doctor`
reports the row `absent` rather than failed. Both come from ONE seam in
`packages/core/src/compute.ts` (`engineStatus`), which the routine runner's
preflight reads too — so nothing can disagree about whether there is a model.
An assignment appearing later needs nothing but another `up`: the config is
rewritten whole, so the child comes back. Everything model-free runs meanwhile;
the fold's turns wait (docs/ops/assistant-tools.md, "Running without an
engine"). **Both shapes run engine-less**: `docker-compose.yml` passes the
provider key through when it is set and never requires it.

### Bridges are installed only when configured

A bridge's `METISTRY_*_URL` is how an operator opts in, and doctor already
reads it that way ("not configured — degrades …"). Now `up` reads it too: with
no `METISTRY_EK_URL` this install has no calendar bridge, so neither the
bridge child nor the `calendar` agent is installed at all, rather than a job
that can only crash-loop. That closes "What is still missing" #2 for the
launchd shape.

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

## A second instance on one Mac — `state/ports.yaml`

launchd labels and ports used to be fixed, so only one instance could run
(`docs/product/desktop-app-plan.md`, "The limit that remains"). One file
lifts that:

```sh
metistry up --namespace --instance ~/some/other/instance
```

writes `<instance>/state/ports.yaml` **once**:

```yaml
schema: 1
instance_id: "e5dbfa9c-…"
label_suffix: "e5dbfa9c"
base: 8460
ports:
  console: 8460
  db: 8461
  reconciler: 8462
  eventkit: 8463
  apple-fm: 8464
```

From then on the file is the record and nothing probes again — a running
instance must never see its own ports as taken. Its presence is what
namespaces an install; delete it (after `metistry stop`) to go back to the
fixed labels and ports.

| | default install | namespaced |
|---|---|---|
| label | `com.foldedspacelabs.metistry.console` | `com.foldedspacelabs.metistry.e5dbfa9c.console` |
| plist | `~/Library/LaunchAgents/<label>.plist` | same, under the new label |
| log | `/tmp/metistry-console.log` | `/tmp/metistry-e5dbfa9c-console.log` |
| ports | 8080 / 5432 / 7812 / 7811 / 7810 | one 8-wide block in **8300-8999** |

The suffix is the first 8 hex of `instance_id` and goes BETWEEN the prefix
and the service, so the service is still the label's last component. The
base is derived from `instance_id` (deterministic) and stepped past a block
that is actually in use, once, at allocation. None of the default ports is
inside 8300-8999, so a namespaced instance cannot collide with an
un-namespaced one.

**The block fills only variables that are UNSET.** An explicit
`METISTRY_CONSOLE_PORT` in `<instance>/state/.env` still wins everywhere —
that is the one rule under which the jobs whose environment `up` renders
into a plist and the jobs that source `.env` themselves cannot disagree.
`up` renders the block into the sourcing jobs' plists for the same reason:
they never read `ports.yaml`, and without it the reconciler binds 7812.

A bridge's `METISTRY_*_URL` is deliberately **not** filled from the block:
that variable is how an operator opts into a bridge, and unset means
doctor reports `absent` ("not configured — degrades …"), which is a
healthy install without a calendar bridge.

`doctor`'s first row names the namespace, and every remediation below it
uses the label and log path this instance's jobs actually carry.

## Switching

```sh
metistry migrate-shape launchd --dry-run   # read the plan; runs nothing
metistry migrate-shape launchd             # one verb, with the data
```

**`docs/ops/migrate-compose-to-launchd.md` is the runbook** — the
prerequisites, what to watch, the rollback, and when it is safe to
`docker compose down -v`. In short, `migrate-shape launchd` quiesces the
writers, dumps the live database through the running container and
verifies the dump before stopping anything, `docker compose stop`s (never
`down -v` — the volume is the rollback), writes `deployment.yaml` through
the reconciler as `user`, runs `up`, restores **before any migration**
(the dump carries `schema_migrations`, so the next `metistry update`
applies none), compares every table's row count, and ends with doctor.
`metistry migrate-shape compose` is the documented rollback.

The two shapes keep their data in different places — a Docker volume
versus `<instance>/state/pg` — so switching is a fresh database plus a
restore, not a move; that is why there is a verb rather than an edit.
Invariant 1 is what makes even a bad outcome survivable: git is the
record, Postgres is derived, and a rebuild costs trend lines rather than
knowledge. Decide about the durable set (`runs`, `sessions`, inbox Needs
You, `work` threads, artifact comments — open decision 13) before you
switch a live install without a dump.

By hand, if you ever need to: stop the old shape, edit
`$METISTRY_INSTANCE_DIR/deployment.yaml`, `metistry up`, restore. That is
what the verb does, in the order that turns out to matter.

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
the host, `ops/sandbox/assistant.sb` is. The engine's root process is
`/usr/bin/sandbox-exec`, so every child inherits the confinement. That is unchanged by the
supervisor: the supervisor spawns exactly the argv the plist used to name,
`sandbox-exec` first and every `-D` parameter identical, and the misuse tests
confine a probe with those same values.

| | |
|---|---|
| filesystem read | its own `dist/` + `node_modules/`, the node runtime, the state dir, tmp, system frameworks. **Not** the vault, not `~/Documents`, not the instance repo. |
| filesystem write | the state dir and tmp. Nothing else. |
| exec | the node binary. No shell (invariant 9). |
| network out | the console and Postgres, on loopback, on **this instance's** ports, and TLS. Nothing else — a namespaced engine cannot reach another install's console. |
| state dir | `<instance>/state/assistant`, which is also `HOME` — the engine's one writable directory (the launchd twin of the `assistant-home` volume). Sessions themselves live in Postgres. |

The parameters are computed in one place (`packages/cli/src/sandbox.ts`)
and the misuse tests in `packages/cli/test/sandbox.test.ts` confine a
throwaway node script with exactly those values, proving five things:
a `~/Documents`-style read fails, a write outside the state dir fails, a
write inside it succeeds, and the console's port and Postgres' port both
connect while a third loopback port does not. Darwin-only; skipped on
Linux CI.

`DB_TCP` is there because the launchd shape's Postgres is a loopback port
rather than a container the engine reached over the compose network: the
profile denies by default, so without it the engine dies at startup with
`EPERM connect 127.0.0.1:<port>`. It is the one port `up` put in the
managed conf block — not a range, and not "loopback".

**Two honest limits.**

1. **Outbound is filtered by port, not by host name.** `sandbox-exec`
   cannot express "openrouter.ai". The profile allows loopback to the
   console and TLS outbound; the host list is DERIVED from this install's
   own `compute.yaml` — every provider's `base_url` hostname and nothing
   else (`engineHosts` in `packages/cli/src/sandbox.ts`) — and is
   documentation today, not an enforced rule. The variable name
   `METISTRY_ASSISTANT_ALLOWED_HOSTS` is reserved for when there is a layer
   that can enforce it. Read the profile as "the engine cannot reach your
   LAN's other services on their own ports", not as "the engine can only
   reach its provider". What *is* enforced by construction is narrower and
   more useful: the loop's only outbound call is
   `<base_url>/chat/completions` on the provider the turn was assigned
   (`apps/assistant/src/engine-openai.ts`), so the host check is a property
   of the code rather than of an environment variable a subprocess may
   ignore (R1).
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
  the model knobs, and exactly the provider secrets this install's
  `compute.yaml` NAMES (`assistantEnvKeys`). The GitHub write PAT, the AWS
  keys and the VAPID private key stay with the console; the engine reaches
  those through an allowlisted tool or not at all. The same allowlist is why
  a provider key in the operator's shell that this file does not name cannot
  reach the engine and buy tokens on somebody else's account.

## Doctor

`doctor`'s first row is the shape and where it was read from, and every
remediation below it is written for that shape — `metistry restart console`
(the supervisor's child) or `launchctl kickstart -k
gui/$(id -u)/com.foldedspacelabs.metistry` (its one agent) rather than
`docker compose up -d console`. The container runtime is consulted only
when some service actually runs in one, so a launchd install never
reports "docker not found" as a finding.

Under the launchd shape doctor adds a `supervisor:<label>` row — the answer
to one `status` call on the control socket — and a `child:<name>` row for each
child, with its state, pid, restart count and log path. `launchctl print`
cannot see those processes, so without this doctor would be blind to
everything except the agent itself.

Logs, under launchd: `/tmp/metistry-{supervisor,db,console,assistant,reconciler}.log`,
or `/tmp/metistry-<suffix>-<service>.log` on a namespaced instance.
Sandbox denials: `log stream --predicate 'sender == "Sandbox"'`.

## `metistry update` under either shape

`update` loads the same `deployment.yaml` and asks for **that shape's**
plist set. On a launchd install that is the supervisor, and its entry tracks
its CHILDREN's code as well as its own: when a console build changes, the
supervisor is kickstarted and every child comes back on the new code. Blunter
than restarting the one child that moved, and it is what "they do not keep
running old code until the next `metistry up`" actually requires — launchd
cannot kickstart a child. It also
skips `docker compose` entirely under `launchd`, the way `up` does; the
restart section says so in the plan. Postgres itself is untouched by an
update: the data directory and the managed conf block are `up`'s job.
