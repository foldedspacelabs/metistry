# Deployment shapes — `compose` and `launchd`

Where an install's services run. Same code, same `.env`
(`<instance>/.metistry/state/.env` — `docs/ops/cli.md`), same
migrations, same `metistry` verbs; only the supervisor and the isolation
boundary differ. Set in `.metistry/deployment.yaml` (plan §4.17, open decision 15
— resolved 2026-09-07).

|  | `compose` | `launchd` |
|---|---|---|
| db | `pgvector/pgvector:pg17` container | a user-space Postgres 17, `postgres -D`, a **child of the supervisor** |
| console | container, published on `127.0.0.1:8080` | a child of the supervisor, binds `127.0.0.1:8080` |
| assistant | container; the file passes through the provider key `compute.yaml` names | a child of the supervisor, **under `ops/sandbox/assistant.sb`** — and not a child at all without an engine (below) |
| reconciler | launchd job | a child of the supervisor, **under `ops/sandbox/reconciler.sb`** |
| watchdog | launchd job | **it IS the supervisor** |
| launchd agents | reconciler, watchdog, the bridges | **one**: `com.foldedspacelabs.metistry`, plus a TCC helper each |
| needs | Docker Desktop / a container runtime | a Postgres install, nothing else |
| engine isolation | the container | the sandbox profile |
| reconciler isolation | none (a host job either way) | **`ops/sandbox/reconciler.sb`** — the sole committer writes the instance repo and nothing else |
| egress | the container network | **one loopback CONNECT proxy** in the supervisor, with a hostname allowlist ("The egress door", below) |
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
| db | bundled Postgres 17.11 + pgvector 0.8.6, initdb'd under `<instance>/.metistry/state/pg`, socket in `<instance>/.metistry/state/run` |
| migrations | 13 applied under `pg_advisory_lock(1296389203)` by `metistry update` |
| node | the bundled `runtime/node/bin/node` 22.23.2 — every plist execs it |
| git | the bundled `runtime/git/bin` on the reconciler's PATH |
| doctor | **23 ok, 0 degraded, 0 failed, 2 absent — healthy** (the two absent are the TCC bridges, deliberately not enabled) |
| agents | five, at the time — one supervisor plus the TCC helpers since ("One background item, called Metistry" above) |
| console | `GET /health` → `200 {"ok":true}` on 8460, while production answered on 8080 |
| update | `metistry update --channel release --version 0.4.0` — a clean no-op round trip (`already running 0.4.0`, `runtime/ is already the 0.4.0 pack`, `0 applied, 13 total`), lock committed by the reconciler |
| sandbox | live probe with the plist's own parameters: vault read **denied**, write outside the state dir **denied**, write inside **allowed**, own console + db **allowed**, the production install's console and reconciler **denied** (the reconciler's own profile and the egress door came later — 2026-09-19, below) |

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
   that respawn forever. **Quote values in `<instance>/.metistry/state/.env`.**
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
   it is namespaced (`.metistry/state/ports.yaml`, below). `METISTRY_ASSISTANT_TOKEN`
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
`<instance>/.metistry/state/supervisor.json` and the launcher's `supervisor.env`, which
are exactly what the app's agent reads. `--register-via app` is the same
decision made explicitly, for the first install, before anything is loaded to
detect.

**Why launchd's answer and not a marker file.** A marker in
`.metistry/state/supervisor.json` (or anywhere else) is a second record of a fact launchd
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

### `<instance>/.metistry/state/supervisor.json`

Written by `metistry up`, mode 0600, and readable by a person:

```json
{
  "schema": 1,
  "label": "com.foldedspacelabs.metistry",
  "socket": "<instance>/.metistry/state/run/supervisor.sock",
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

`<instance>/.metistry/state/run/supervisor.sock`, mode 0600, one JSON object per line:

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

`metistry down` is that "no service named" stop plus a read-only confirmation
(`launchctl print` finds nothing, `docker compose ps` lists nothing), and is
what `metistry up` names as its counterpart. Under the compose shape it is
`docker compose stop`, never `docker compose down` and never `-v`: the
containers stay, and no volume is touched (`docs/ops/cli.md`, "Running:
`up`, `down`, and who owns the processes").

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

## `.metistry/deployment.yaml`

Instance config with the D4 overlay: the product ships the default in
`seed/deployment.yaml`, and an instance's own copy — same filename, in
`$METISTRY_INSTANCE_DIR/.metistry` — wins. New seeded defaults appear on
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

Parsing is strict. `shape: lauchd` is an error, not a silent compose — and
so is `keep_awake: true`, which is why the values are strings ("Keeping the
Mac awake" below). One consequence worth knowing before you downgrade: a
CLI that predates `keep_awake` refuses a file that carries it, with every
verb that loads deployment. Removing the one line by hand is the way back.

`METISTRY_DEPLOYMENT_SHAPE=launchd metistry up --dry-run` previews a
shape without editing anything; `up` and `doctor` both print which of
the two they read.

## Keeping the Mac awake

Metistry only works while the Mac is awake: a capture from your phone, a
scheduled collector and the assistant's queue all wait while it sleeps. So
`deployment.yaml` carries one more key, macOS only:

```yaml
shape: launchd
keep_awake: allow_sleep_on_battery   # never | allow_sleep_on_battery | always | always_lid_closed
```

| value | what it does |
| --- | --- |
| `never` | nothing is held; your own System Settings sleep timer decides. **This is what an install that has never been asked does** — the key is absent, and absent means `never`. |
| `allow_sleep_on_battery` | held while the Mac draws `'AC Power'`; released on `'Battery Power'` and on `'UPS Power'`. A UPS is a battery — an external one — and a desktop on one during an outage should be spending its runtime on shutting down cleanly. What `metistry init` offers first. |
| `always` | held on any power source. On a laptop away from a charger that costs battery; the Mac still sleeps at low battery, which the assertion is defined not to stop. |
| `always_lid_closed` | the same as `always`, **plus an administrator change you make yourself**. See below. Offered, never a default. |

**The same setting as switches (T4-20).** The Services pane shows it as a
switch with two sub-switches, and the file may say it that way too — the four
values stay valid, and each is exactly one of these:

```yaml
keep_awake: { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }
```

| key | means | when absent |
| --- | --- | --- |
| `enabled` | the switch; `false` holds nothing, whatever the two below say (they are remembered, not applied) | required — an object that does not say is an error |
| `sleep_on_battery` | `true` = released on battery and UPS (`allow_sleep_on_battery`); `false` = held on any power (`always`) | `true` — nothing keeps a laptop awake on battery unless asked |
| `sleep_lid_closed` | `true` = a closed lid sleeps; `false` = you want a closed Mac kept awake, which only the administrator setting below delivers | `true` — never a default |

`never` is `{ enabled: false }`; `allow_sleep_on_battery` is
`{ enabled: true }`; `always` is `{ enabled: true, sleep_on_battery: false }`;
`always_lid_closed` is `always` with `sleep_lid_closed: false`. The one
object no value names — the switch on, sleep on battery, the lid awake — is
held exactly as `allow_sleep_on_battery` (that is everything a process can
hold for it) and reported as that value with the lid half beside it. A CLI
that predates the object form refuses a file that carries it; writing one of
the four values back is the way down.

**Informed consent, not a default.** A power assertion *overrides* the
user's own sleep setting (`pmset(1)`: "processes may dynamically override
these power management settings by using I/O Kit power assertions"), so
taking one without being asked would take a machine-level behaviour from
somebody who never agreed to it. `seed/deployment.yaml` therefore does not
set the key; `metistry init` asks once, on a terminal, printing what each
choice costs, and writes the answer. `--keep-awake <value>` answers it
without a terminal, and a run with neither — a pipe, a script, the Mac
app's first run — asks nothing and writes nothing.

**What is held.** `caffeinate -i -w <supervisor pid>`, which is exactly
`IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep)` — the
same IOKit call, no privileges, no TCC grant, no `sudo`. Never `-d` (that
pins the display, which you did not ask for: **your screen still sleeps**)
and never `-s` (deprecated, and AC-only). `-w` is the safety: the assertion
is released when the watched pid exits, even under `SIGKILL`, so a killed
supervisor cannot leave an ownerless holder behind. We never write a `pmset`
setting — every `pmset` call in this design is a read — and we can neither
release nor take credit for another app's assertion: `IOPMAssertionRelease`
is scoped to the id its creator got back. A keep-awake app you already run
is unaffected, and so are we.

**The supervisor holds it, so the `launchd` shape holds it.** The assertion
is tied to the process whose lifetime is the install's, and under
`shape: compose` there is no supervisor: nothing is held, and `doctor` says
so rather than pretending. The setting is still recorded and still moves
with you when you migrate the shape.

**What no setting can do.** A closed lid always sleeps. The assertion's own
definition says so — "The system may still sleep for lid close, Apple menu,
low battery, or other sleep reasons" (`IOPMLib.h`) — and the state that
governs the lid is an `IOPMrootDomain` property, not an assertion. The only
user-space switch that changes it is `sudo pmset -a disablesleep 1`, which
is system-wide, persists in a root-owned plist, and `pmset(1)` says plainly:
"pmset must be run as root in order to modify any settings". Metistry will
not make an administrator change to your Mac. So `always_lid_closed` (or
`sleep_lid_closed: false`) is accepted and stored as asked, the assertion
behaves exactly as `always`, and every surface says the lid-closed half is
**not available on this Mac without an administrator change** — offered and
explained rather than faked (ruling 3, 2026-09-26). Choosing it prints the
dialog: the command (`sudo pmset -a disablesleep 1`), how to undo it
(`sudo pmset -a disablesleep 0`), and the warning — **not recommended**: it
applies to the whole Mac and every app, persists across restarts, can
overheat a laptop in a bag and run the battery flat; and because it stops
every sleep, not only the lid's, the Mac then does not sleep on battery
either, whatever `sleep_on_battery` says. You run it yourself, in Terminal,
as an administrator; Metistry never does. `metistry doctor` reads `pmset -g`
(a `SleepDisabled 1` line) and says whether it is in effect. (A lid-closed Mac stays
awake in closed-display mode, which is your own external power, display and
input setup; macOS decides that, not us.) Scheduled sleep, the Apple menu's
Sleep item, a thermal emergency and low battery all bypass the assertion by
design as well.

**`metistry doctor` reports one row, `keep-awake`, macOS only and
`degraded` at worst** — the install is running and correct even when a
promise about the machine is unmet, so it never fails a run:

| state | status |
| --- | --- |
| `never`, never asked (the key is absent) | `absent` — "not configured", with the verb that turns it on |
| `never`, set explicitly | `ok` — "keep_awake: never — your choice", no suggestion: an answer is configured |
| holding | `ok`, with the pid, since, and the power source. The pid is cross-checked against the **"Listed by owning process"** block of `pmset -g assertions` — never the summary block, which is a *level* (a maximum) and reads 1 while four processes hold it, and never a name, because under `caffeinate` the name is Apple's on every holder |
| released on battery under `allow_sleep_on_battery` | `ok` — this is the setting working, and it reads as success |
| configured, but nothing has written the state file, or its heartbeat is stale | `degraded` — the supervisor is not running, or has not restarted since the setting changed |
| the lid asked for (`always_lid_closed`, `sleep_lid_closed: false`), and `pmset -g` has no `SleepDisabled 1` | `degraded`, carrying the administrator sentence, how to undo it and the warning; `meta.lid_closed: "not in effect"` (`"unknown"` when `pmset -g` did not answer — never "off") |
| the lid asked for, and the administrator setting is in effect | `ok`; `meta.lid_closed: "in effect"` |
| `shape: compose` | `absent` — no supervisor to hold it |
| **the Mac slept anyway** | `degraded`, naming when and for how long, with the repair |

That last row is the honest one. The holder compares wall clocks between
its own 60-second ticks and writes what it sees to
`<instance>/.metistry/state/run/keep-awake.json`; a jump of three intervals
while it was holding means the machine was asleep under it — a closed lid,
a scheduled sleep, or another policy winning. Doctor then says so, and
offers `metistry deployment set-keep-awake always --yes` with its battery
cost stated — or, when the lid sub-switch is off, `--sleep-on-battery false`,
which holds on battery too without resetting the lid answer. A gap across a *restart* is deliberately **not** reported as
sleep: that is what `metistry stop`, a logout and a reboot all look like,
and a clean stop records itself so the gap after it is never misread.

The cost of all this is one `pmset -g ps` fork a minute and one small file
write, from a process that was already running a 60-second probe cycle.
(`pmset -g log` would name the sleep *reason*, and is not used: it cost
0.42s and 2.8MB on the Mac this was measured on, and had no Sleep-domain
entries to parse against.)

Changing it: `metistry deployment set-keep-awake <value> [--yes]`, or the
switches as flags — `--enabled`, `--sleep-on-battery`, `--sleep-lid-closed`,
each `true|false` (`docs/ops/cli.md`) — preview-then-confirm through the
reconciler, like `set-shape`. It takes
effect at the next `metistry up`, which renders `METISTRY_KEEP_AWAKE` into
the supervisor's environment; nothing already running changes underneath
you.

## A second instance on one Mac — `.metistry/state/ports.yaml`

launchd labels and ports used to be fixed, so only one instance could run
(`docs/product/desktop-app-plan.md`, "The limit that remains"). One file
lifts that:

```sh
metistry up --namespace --instance ~/some/other/instance
```

writes `<instance>/.metistry/state/ports.yaml` **once**:

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
namespaces an install; delete it (after `metistry down`) to go back to the
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
`METISTRY_CONSOLE_PORT` in `<instance>/.metistry/state/.env` still wins everywhere —
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
`down -v` — the volume is the rollback), writes `.metistry/deployment.yaml` through
the reconciler as `user`, runs `up`, restores **before any migration**
(the dump carries `schema_migrations`, so the next `metistry update`
applies none), compares every table's row count, and ends with doctor.
`metistry migrate-shape compose` is the documented rollback.

The two shapes keep their data in different places — a Docker volume
versus `<instance>/.metistry/state/pg` — so switching is a fresh database plus a
restore, not a move; that is why there is a verb rather than an edit.
Invariant 1 is what makes even a bad outcome survivable: git is the
record, Postgres is derived, and a rebuild costs trend lines rather than
knowledge. Decide about the durable set (`runs`, `sessions`, inbox Needs
You, `work` threads, artifact comments — open decision 13) before you
switch a live install without a dump.

By hand, if you ever need to: stop the old shape, edit
`$METISTRY_INSTANCE_DIR/.metistry/deployment.yaml`, `metistry up`, restore. That is
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

**What `up` does, once:** `initdb -D <instance>/.metistry/state/pg` with the
superuser password handed over in a file that the next step deletes
(never a command line — `ps` shows those), `--auth-local=trust` for the
operator's own socket connections and `--auth-host=scram-sha-256` for
everything over TCP (invariant 8: loopback is not a boundary). Then a
marker-delimited managed block in `postgresql.conf`:

```
# --- metistry (managed: metistry up rewrites this block) ---
listen_addresses = '127.0.0.1'
port = 5432
unix_socket_directories = '<instance>/.metistry/state/run'
# --- end metistry ---
```

Everything outside the markers — initdb's choices, anything you add — is
left alone, and re-running `up` rewrites only the block. An initialised
data directory is never re-initdb'd.

If `METISTRY_DB_PASSWORD` is unset, `up` generates one and appends it to
this install's `.env` — `<instance>/.metistry/state/.env` (gitignored, `0600`, never
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
| filesystem read | its own `dist/` + `node_modules/`, the node runtime, the state dir, tmp, system frameworks — plus **four files of the instance's config, granted by name**: `identity.yaml`, `assistant-prompt.md`, `rules.yaml`, `compute.yaml` (`-D CONFIG_IDENTITY=…`, computed by `up`). **Not** the vault, not `~/Documents`, not the rest of the instance repo. The four are literals rather than a grant on the directory holding them because that directory also holds the lock, the peer registry and Postgres' cluster — and on an instance that has not run `metistry migrate-layout` it IS the vault root. |
| filesystem write | the state dir and tmp. Nothing else. |
| exec | the node binary. No shell (invariant 9). |
| network out | the console and Postgres, on loopback, on **this instance's** ports, and TLS. Nothing else — a namespaced engine cannot reach another install's console. |
| state dir | `<instance>/.metistry/state/assistant`, which is also `HOME` — the engine's one writable directory (the launchd twin of the `assistant-home` volume). Sessions themselves live in Postgres. |

The parameters are computed in one place (`packages/cli/src/sandbox.ts`)
and the misuse tests in `packages/cli/test/sandbox.test.ts` confine a
throwaway node script with exactly those values, proving six things:
a `~/Documents`-style read fails, a write outside the state dir fails, a
write inside it succeeds, the console's port and Postgres' port both
connect while a third loopback port does not, and the four config files
above are readable **in both layouts** while a note sitting beside them is
not. Darwin-only; skipped on Linux CI.

`DB_TCP` is there because the launchd shape's Postgres is a loopback port
rather than a container the engine reached over the compose network: the
profile denies by default, so without it the engine dies at startup with
`EPERM connect 127.0.0.1:<port>`. It is the one port `up` put in the
managed conf block — not a range, and not "loopback".

**One honest limit, and one that has been closed.**

1. **`sandbox-exec(1)` is deprecated** — and functional; this profile is
   verified on macOS 26.4 and the shape has worked since 14. The migration
   path is App Sandbox entitlements once the Mac app hosts the process
   (`docs/product/desktop-app-plan.md`). This used to read as a pure
   upgrade and it is a **trade**: App Sandbox buys outbound filtering by
   host name and **costs** the per-spawn `-D` parameterisation every rule
   above depends on, because entitlements are baked into a bundle's
   signature and cannot say "this instance's console port, this instance's
   four config files" (`docs/research/2026-09-19-agent-virtual-filesystems.md`
   §2.4; `ops/sandbox/README.md` has the whole correction).
2. **~~Outbound is filtered by port, not by host name~~ — closed 2026-09-19.**
   `sandbox-exec` still cannot express "openrouter.ai". What changed is the
   other half of that sentence: it *can* be narrowed to one loopback port,
   and the thing listening there can name hosts all day ("The egress door",
   below). `(remote tcp "*:443")` is gone from the profile; the host list
   derived from `compute.yaml` is now enforced rather than documented.
   What was already enforced by construction is unchanged and still the
   stronger statement: the loop's only outbound call is
   `<base_url>/chat/completions` on the provider the turn was assigned
   (`apps/assistant/src/engine-openai.ts`), so the host check is a property
   of the code rather than of an environment variable a subprocess may
   ignore (R1).

Under the compose shape none of this applies — the container is the
boundary and the profile is not used.

## The reconciler's sandbox

The sole committer (D5) is confined too, since 2026-09-19. It is the process
that holds the instance repo's working tree and the only place git runs, and
until this it had ambient authority over the whole disk:
`docs/research/2026-09-19-agent-virtual-filesystems.md` §3.2(c) called it
"the best target in the repo", and this is that finding built.

| | |
|---|---|
| filesystem read | the product checkout (its own `dist/`, `node_modules/`, `seed/` — and its working directory), the node runtime, **a real git's installation prefix**, system frameworks, and `~/.gitconfig` **by name**. |
| filesystem write | **the instance repo — the vault, `.metistry/` and `.git/`** — and tmp. Nothing else: not `~/Documents`, not `~/.ssh`, not the product checkout, not another instance's vault. |
| exec | node, that git, and the askpass shim (below). **No shell.** |
| network out | the console, Postgres and the on-machine embedder on loopback, plus the egress proxy. |
| network in | exactly its own bridge port — `network-bind` **and** `network-inbound` on `RECONCILER_TCP` (below). |
| off switch | `METISTRY_RECONCILER_SANDBOX=0` renders `ops/sandbox/unconfined.sb` instead — a real file that says `(allow default)`, so "not confined" is legible in the plist, in `supervisor.json`, in `up --dry-run` and in doctor's `sandbox` row. |

**`/usr/bin/git` is not a git.** Measured on macOS 26.4: it links against
`/usr/lib/libxcselect.dylib` — it is the xcode-select shim, and under a
profile that grants exactly that literal it dies with `xcrun: error: unable
to load libxcrun (… file system sandbox blocked open())`. So `up` resolves a
**real** git by absolute path — the bundled `runtime/git` first, then a
non-shim git on PATH, then the Command Line Tools — and grants its whole
prefix (`bin/git`, `libexec/git-core/`'s 172 helpers, `share/git-core`'s
templates). On a Mac with none of those, `up` declines to confine the job and
says why: a reconciler that cannot run git is not a reconciler.

**Pushing while confined** works over HTTPS, and the path is worth knowing
because it is not the obvious one (`docs/ops/reconciler.md` has the table).
git executes *every* credential helper through `/bin/sh` — including the
built-in `osxkeychain` that `metistry connect-repo` configures — and there
is no shell here, so no helper can run. `GIT_ASKPASS` **can**: git execs it
directly, by absolute path, with no shell. So the token stays in the login
Keychain where `connect-repo` put it, the **supervisor** reads it there once
at spawn (it is unconfined, it is the parent, and the item is filed `-A` so
the read is promptless), and hands it to the child in its environment; a
`#!<node>` shim `up` generates prints it when git asks. The credential is
never in argv, never in `supervisor.json` and never on disk. `git.ts` adds
`-c credential.helper=` — git's documented reset — only when there is an
askpass, so an unconfined install keeps using the Keychain helper exactly as
before.

**Listening takes two rules on macOS 26.** `network-bind` lets a socket take
an address; on macOS 26 (Darwin 25) `listen()` on it is then refused with
`EPERM` unless `network-inbound` names the same local address. 0.14.2 shipped
the bind rule alone, and the first install that found a real git — and so
chose confinement over `unconfined.sb` — crash-looped the reconciler on
`listen EPERM 127.0.0.1:7812`. Both rules are in `reconciler.sb` now, and
`ops/sandbox/bind.test.mjs` is the guard: for every profile it finds, every
parameterised `network-bind` must have its `network-inbound` twin, and a real
`sandbox-exec -f <profile> -D … node -e '<listen>'` must succeed on a free
high port in that parameter and be refused on a port the profile does not
name. It runs on a `macos-26` runner — CI's `sandbox-profiles` job whenever
`ops/sandbox/` or `sandbox.ts` changes, and the release's darwin runtime job
every time — because the behaviour is the OS's and no Linux run can see it.
The engine (`assistant.sb`) has a bind rule and deliberately no inbound one:
it opens no server, and the same test asserts it cannot.

**SSH remotes are the one shape confinement cannot serve.** `ssh` is not
exec-able, granting it would mean granting the sole committer `~/.ssh`, and
ssh's `ProxyCommand` runs through a shell so it could not reach the egress
proxy either. `up` warns when it sees one; use an HTTPS remote or the off
switch.

## The egress door

One HTTP **CONNECT** proxy, in the supervisor, bound to `127.0.0.1` on the
egress port (`7814` by default; the last slot of a namespaced instance's
port block). Both confined children's profiles allow that one port and no
other off-machine destination, so it is the only way out.

| | |
|---|---|
| allowlist | **derived**: every provider `base_url` host in this install's `compute.yaml`, every remote host in the instance repo's `.git/config`, and any non-loopback `METISTRY_*_URL`. Written into `supervisor.json` by `up`, read by the supervisor **before it spawns anything** — a child cannot widen it. |
| matching | exact host, exact port. No wildcards, no suffix rules: a bare entry means 443 and nothing else. |
| auth | `Proxy-Authorization: Basic <child>:<token>`, one 256-bit token per confined child, minted once and kept across `up` runs. Loopback is not a trust boundary (invariant 8), and the bearer is what puts a NAME on the audit row. |
| audit | every refusal is a `runs` row — `component: egress-proxy`, `kind: egress`, `meta: {host, port, reason, child}`. |
| interception | **none.** CONNECT only; a cleartext `GET http://…` gets a 405. The proxy learns a host name and a port and never a byte of the tunnel. |

The children reach it as `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` with
`NO_PROXY=localhost,127.0.0.1,::1`, plus **`NODE_USE_ENV_PROXY=1`** — which
is load-bearing and easy to miss: Node's global `fetch` ignores the proxy
variables without it (undici's `EnvHttpProxyAgent`, available since Node
22.15). git's environment in `apps/reconciler/src/git.ts` is a deliberate
allowlist, so it gets `METISTRY_GIT_HTTP_PROXY` and turns it into
`-c http.proxy=…`.

Measured end to end on macOS 26.4: an allowlisted host returns 200 through
the door; a non-allowlisted one comes back `Request was cancelled` for
`fetch` and `fatal: … CONNECT tunnel failed, response 403` for git, with
`[egress] refused assistant → api.openai.com:443 (not-allowlisted)` in the
supervisor's log; and with the proxy variables removed the profile alone
refuses the direct connect.

The proxy is in the **supervisor** rather than the console because it is the
parent of both confined children (so the port and the allowlist are set
before either exists), because its lifetime is the install's, because it
already holds the invariant-3 pool the audit row needs, and because the
console's mutating surface is a closed enumerated set (invariant 10) that
should not grow a listener.

Under `compose` there is no proxy and no profile: the container is the
boundary.

## The secret fill: `{{ secret.name }}` at egress

The door above sees a host and a port and never a header, so it cannot fill
— or keep — a secret. That happens one step earlier, in the process making
the call, just before TLS: core's **`guardedFetch`**
(`packages/core/src/egress.ts`, plan §2.14, T4-2). It is a `fetch`, so it
goes wherever a caller already takes a fetch seam — a connection's client,
the MCP SDK's HTTP transport, a compute provider's chat client. The caller
writes the request with `{{ secret.name }}` still in it and gets back a
Response that is already redacted; the filled request never exists outside
the function. The proxy stays the second wall: the host must also be on the
install's allowlist to be dialled at all.

Every check runs before the Keychain is read or a byte is sent, and each
refusal is an `EgressRefused` with a code, naming secrets and the host,
never a value:

| code | refused when |
|---|---|
| `host_not_listed` | a secret the request references — or already carries as a known value — does not list the exact destination in `hosts:` (host, plus `:port` when not 443; no suffix match, no trailing-dot or address spelling). A secret `secrets.yaml` does not describe is listed for nowhere. |
| `secret_in_url` | a reference, a known value in any encoding, or userinfo in the URL — URLs land in logs and histories |
| `secret_in_model_body` | `purpose: "model"` and a reference or known value in the body. The body is the model's context; the provider key goes in a header. |
| `cleartext` | a secret over plain http to anything but loopback |
| `not_granted` · `needs_approval` | the caller's grant (`connection:<name>` or `agent:<id>`) is Off, or Ask without the owner's approval of this call |
| `missing_secret` · `malformed_reference` | all or nothing: one missing item or one bad `{{ secret… }}` and nothing is filled or sent |
| `uninspectable_body` | a body the door cannot read (a stream, a Blob, FormData) |
| `bad_url` | not an http(s) URL |

A request that carries a secret is sent with `redirect: "manual"`: a 3xx
comes back to the caller, and following it is a new call through the door,
checked against the new host.

**On the way back** the `SecretRedactor` — which learned each value the
moment it was filled, or up front with `prime()` — replaces it in the
response body (streamed, holding back one form's length so a value split
across chunks is still caught), every response header, and any error (a new
`Error`, with no `cause` to carry the request). It knows the raw,
JSON-escaped, URL-encoded and base64 spellings. What a transcript shows is
`***REDACTED secret.<name>***` — the name, and deliberately not a
`{{ secret.name }}` the fill would expand again.

**Last used.** Each call that sent a secret reports its names to `onUse`;
the caller stamps them on its `runs` row with `recordSecretUse(db, runId,
names)`, which merges them into `meta.secrets` as a sorted set. The
`secret_last_used` named query reads that back for `GET /api/secrets`
(docs/ops/client-api.md).

`planEgress` runs the same checks with no store — what an Ask preview uses
to say "sends `github_write` to `api.github.com`" without touching the
Keychain.

**Not yet on a compute provider's chat client.** Since T4-18 a provider's
key is a `{{ secret.name }}`, but the engine sends the key it was delivered
(`METISTRY_SECRET_<NAME>`, docs/ops/compute.md "Secrets") rather than
filling it here: a provider key has no grantee in `secrets.yaml`'s
vocabulary, and the engine's sandbox does not read `secrets.yaml`. The
proxy above still refuses any host `compute.yaml` does not name.

## Secrets in plists

The console's and the assistant's environments are rendered into their
plists' `EnvironmentVariables` dict rather than sourced from `.env`
through `sh -c` — no shell, and nothing interpolated. That puts real
secrets in `~/Library/LaunchAgents`, which is `0755`, so `up` writes
those two plists `0600`. The other jobs (reconciler, watchdog, the TCC
bridges) still source a dotenv file themselves, through the plists'
`__ENV_FILE__` placeholder — `<instance>/.metistry/state/.env`, because an instance
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

On macOS it also adds a `keep-awake` row — this install's power policy and
whether anything is actually holding the assertion right now ("Keeping the
Mac awake" above). It is never `failed`.

Logs, under launchd: `/tmp/metistry-{supervisor,db,console,assistant,reconciler}.log`,
or `/tmp/metistry-<suffix>-<service>.log` on a namespaced instance.
Sandbox denials: `log stream --predicate 'sender == "Sandbox"'`.

## `metistry update` under either shape

`update` loads the same `.metistry/deployment.yaml` and asks for **that shape's**
plist set. On a launchd install that is the supervisor, and its entry tracks
its CHILDREN's code as well as its own: when a console build changes, the
supervisor is kickstarted and every child comes back on the new code. Blunter
than restarting the one child that moved, and it is what "they do not keep
running old code until the next `metistry up`" actually requires — launchd
cannot kickstart a child. It also
skips `docker compose` entirely under `launchd`, the way `up` does; the
restart section says so in the plan. Postgres itself is untouched by an
update: the data directory and the managed conf block are `up`'s job.
