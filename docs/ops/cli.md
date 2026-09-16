# `metistry` — init, connect-repo, connect, secrets, console, doctor, up, update, service control

`packages/cli` (`@foldedspacelabs/metistry-cli`, plan §4.16: `init | doctor
| up | update`, plus the install verbs the Mac app drives — `connect-repo`,
`secrets`, `identity`, `version` and `deployment`,
`docs/product/desktop-app-plan.md` — and the per-service verbs its menu bar
drives: `restart | stop | start | logs`, below) is the operator's front door.
All of them are real.

| verb | what it does |
| --- | --- |
| `init <dir>` | create a private instance repo |
| `connect-repo <url>` | point the instance repo at a remote, mint credentials the reconciler can push with |
| `secrets sync\|mint\|list [--json]` | move secrets between the Keychain and `.env` |
| `connect <tool> [--rotate]` | give one external dev tool (Cursor, OpenCode, Devin, Claude Code) its own agent token and config |
| `connect --list [--json]` | which tools are connected: the row, the bearer, the config |
| `console whoami [--json]` | ask the console who it thinks you are, with this install's owner token |
| `identity [--json]` | the instance's identity.yaml (name, mention, voice, icon, instance_id) |
| `--version` / `version [--json]` | this CLI's version, the resolved product dir's, the lock's pin, and a release's runtime pack |
| `deployment [--json]` | the effective shape (D4 overlay) and the services it implies, with cheap running state |
| `deployment set-shape <compose\|launchd>` | write the instance's deployment.yaml through the reconciler, preview-then-confirm |
| `migrate-shape <launchd\|compose>` | move a LIVE install between the shapes, with its data: dump, stop, flip, up, restore, verify, doctor |
| `doctor` | validate every manifest and probe every bridge, service, container, launchd job |
| `up` | bring an install to running: containers/host jobs, then doctor |
| `update` | move an install forward: pull/build, migrate, restart what changed, pin, doctor |
| `restart [<service>…]` | `launchctl kickstart -k`, or `docker compose restart`, per service |
| `stop [<service>…]` | `launchctl bootout`, or `docker compose stop`, per service |
| `start [<service>…]` | `launchctl bootstrap` + `kickstart -k`, or `docker compose start`, per service |
| `logs <service>` | tail the job's (or supervisor child's) log file, or `docker compose logs` |
| `import-sessions` | summarise and post this machine's Claude Code sessions |

```sh
# from anywhere, no checkout needed for init
npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "Athena"

# inside a checkout after `pnpm -r build`
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js doctor --json
node packages/cli/dist/main.js up --dry-run        # what it would do, runs nothing
node packages/cli/dist/main.js up                  # containers + host jobs, then doctor
node packages/cli/dist/main.js update --dry-run
node packages/cli/dist/main.js update              # pull, build, migrate, restart, pin

# individual services — docs/ops/cli.md#service-control below
node packages/cli/dist/main.js restart apple-fm
node packages/cli/dist/main.js restart             # every service the current shape runs
node packages/cli/dist/main.js logs apple-fm --lines 5

# the instance repo's remote and the machine's secrets
node packages/cli/dist/main.js connect-repo https://github.com/you/metistry-instance.git
node packages/cli/dist/main.js secrets sync --to keychain
node packages/cli/dist/main.js secrets list
node packages/cli/dist/main.js secrets list --json

# one external dev tool at a time — docs/ops/cursor.md, docs/ops/opencode.md, docs/ops/devin.md
node packages/cli/dist/main.js connect cursor
node packages/cli/dist/main.js connect devin --rotate
node packages/cli/dist/main.js connect claude-code --areas Knowledge/Areas/Engineering
node packages/cli/dist/main.js connect --list

# what the app's Settings/Advanced panes and its first-run wizard read instead of parsing files themselves
node packages/cli/dist/main.js console whoami          # "signed in as owner" — docs/ops/auth.md
node packages/cli/dist/main.js console whoami --json
node packages/cli/dist/main.js identity --json
node packages/cli/dist/main.js --version
node packages/cli/dist/main.js deployment --json
node packages/cli/dist/main.js deployment set-shape launchd            # preview only
node packages/cli/dist/main.js deployment set-shape launchd --yes      # writes it
```

## `identity`, `version`, `deployment`, `console whoami`: what the app reads instead of the files

Five small, read-mostly verbs exist so the Mac app stops parsing
`identity.yaml`, `package.json` and the `secrets list` table itself
(`apps/macos/sources/kit/instance-files.swift`,
`apps/macos/sources/kit/secret-listing.swift`) — the same "a behaviour the
app needs is a CLI change first" rule as `doctor --json` and the
`restart|stop|start|logs` verbs above.

`metistry identity [--json] [--instance <dir>]` prints identity.yaml as the
CLI already understands it — `name`, `mention`, `voice`, `icon`,
`instance_id` — resolving `--instance`/`METISTRY_INSTANCE_DIR` like every
other instance verb. Read-only: identity.yaml is a §4.7 protected path, so
there is no field here to change it.

`metistry --version` / `metistry version [--json]` prints every version
number an install can be asked about, each only as far as it resolves:
this binary's own package version (always); when a product dir resolves,
that directory's OWN `package.json` version (the checkout root, or a
release's unpacked `current/` — which can differ from the running CLI's own
version); the instance's `metistry.lock` pin and channel; and, for a release
install, `metistry-runtime.json`'s version, commit and build time.

`metistry deployment [--json]` prints the effective shape (`deployment.yaml`'s
D4 overlay, same as `doctor`'s `deployment` row) and the services it
implies, each tagged with whether it is running — `launchctl print` /
`docker compose ps`, the same cheap, no-network probes `doctor` itself uses
for those rows, reused rather than reimplemented. It never runs the full
`doctor` (which also probes every bridge over HTTP).

`metistry deployment set-shape <compose|launchd> [--yes] [--force]` writes
the instance's `deployment.yaml`. It is a §4.7 protected path (invariant 2:
how the system behaves is a human change), so the write goes through the
reconciler as the `user` principal — exactly like `metistry.lock` and
`identity.yaml` (`protected-write.ts`) — with no reconciler configured
falling back to a direct write the same way those do. Preview-then-confirm:
without `--yes` nothing is written or POSTed, only planned; with it, applied.
It refuses when `db`/`console`/`assistant` (the services whose shape
actually depends on this file) are still running under the current shape,
because the data does not move between shapes on its own
(`docs/ops/deployment-shapes.md`) — the refusal says what `metistry stop`,
the shape change, then `metistry up` would do. `--force` writes anyway.
`reconciler`/`watchdog` being up is never a reason to refuse: they are host
jobs under either shape (invariant 6).

`metistry migrate-shape <launchd|compose> [--dry-run] [--namespace]` is the
verb for a LIVE install, and it is deliberately not a flag on `set-shape`.
`set-shape` writes one line of a config file and refuses while anything is
still running — that refusal is what stops someone flipping the shape out
from under a running Postgres, and a migration is exactly the operation
that has to run inside it. So `migrate-shape` owns the ordering and calls
`setDeploymentShape` for the file write, rather than reimplementing the
protected-write path.

Going to `launchd` it quiesces the writers, `pg_dump`s the live database
through the running `db` container to `<instance>/state/migrate/<ts>.dump`
and verifies it with `pg_restore --list` **before stopping anything**,
`docker compose stop`s (never `down -v` — the volume is the rollback),
writes the shape through the reconciler, runs `up` (initdb under
`<instance>/state/pg`, every host plist re-rendered against `current/`,
the bundled node and `<instance>/state/.env`), `pg_restore`s **before any
migration runs** — the dump carries `schema_migrations`, so the next
`metistry update` applies none — compares every table's exact row count
and fails by name if one lost rows, pins the two TCC bridge jobs at the
signed helper bundles a release does not ship, waits for the console and
the reconciler to answer, and ends with `doctor`.

It refuses, with the old shape still up and nothing changed, when the
product tree has no bundled `runtime/`, no `ops/sandbox/assistant.sb` (a
pack older than v0.6.0 — the assistant's launchd job could not start), no
`pg_dump`/`pg_restore`/pgvector, no running `db` container, or when the
instance is namespaced while its docker compose project is not.

`metistry migrate-shape compose` is the rollback: bootout the three
launchd jobs, write the shape back, `docker compose up -d`. The compose
volume still holds the database as it was at the cutover, and anything
written under `launchd` since is NOT copied back — the verb prints the
`pg_dump` command for it.

**The runbook is `docs/ops/migrate-compose-to-launchd.md`**: prerequisites,
what to watch, rollback, and when it is safe to `docker compose down -v`.

`metistry console whoami [--json]` asks the running console who it thinks
you are, presenting this install's `METISTRY_LOCAL_OWNER_TOKEN`
(`docs/ops/auth.md`): the principal, how it was proved, and whether that
credential reaches the management surface. This is what the app calls to
render "signed in as owner" without a passkey ceremony, and what an
operator runs to prove the local door works before blaming the app.

```
$ metistry console whoami
console    http://127.0.0.1:8080
principal  user
via        local_owner_token
management yes
origin     https://your-hostname.example
```

The URL comes from `METISTRY_CONSOLE_URL`, then `METISTRY_URL`, then
`http://127.0.0.1:8080`. The token comes from the environment
(`<instance>/state/.env`) or the login Keychain — this instance's account
first, the per-user one behind it — and never reaches argv, stdout or an
error message. A 401 is one of exactly two things and the error names both:
a token the console was not started with, or a request that did not arrive
from this machine (under compose, the NAT question — `docs/ops/auth.md`).

Package-level detail (flags, resolution order, probe table) lives in
`packages/cli/README.md`; this page is the operator's runbook.

## Instance directories are self-contained

**An instance directory holds everything about that instance** (ratified
2026-09-09, `docs/product/desktop-app-plan.md`). Nothing about it persists
outside its directory except per-user secrets in the login Keychain. So:

- **`.env` lives at `<instance>/state/.env`**, not in the product
  checkout. It is gitignored by the seed and written `0600`.
- **`identity.yaml` carries an `instance_id`** (a v4 UUID from `metistry
  init`). Instance-scoped Keychain items are filed under it as the account.
- `state/` also holds the launchd shape's Postgres data (`state/pg`) and
  the assistant's transcripts (`state/assistant`).

Every verb takes **`--instance <dir>`** (the Mac app passes it), and
`--env-file <path>` overrides the dotenv file outright. Resolution order
for the environment:

1. `<instance>/state/.env` — the instance named by `--instance`, else
   `METISTRY_INSTANCE_DIR`.
2. the product checkout's `.env` — **deprecated**, still read, and the
   place a terminal install may keep declaring `METISTRY_INSTANCE_DIR`
   (it is parsed for that pointer *before* either file is applied, so the
   instance's own values always win).

Nothing already set in the environment is overwritten by either file.
A deprecation line goes to **stderr** whenever the checkout's `.env` is
read, so `doctor --json` stays machine-readable.

**Migrating an existing install: one command.**

```sh
metistry secrets sync --to env      # or: … --instance <dir>
```

It carries every line of the checkout's `.env` into
`<instance>/state/.env` and **leaves the old file in place** — a running
install keeps working. Delete the old one yourself once nothing reports a
variable missing. Then `metistry up` renders the launchd plists to source
the new path and points `docker compose` at it with `--env-file`.

**Only one instance runs at a time.** launchd labels and ports are fixed,
so several instance directories can exist and be switched between, but
bringing up a second while the first runs makes them fight. Concurrent
instances need label/port namespacing — a recorded follow-up.

## Creating an instance repo

`metistry init <dir>` replaces the by-hand bootstrap of 2026-09-06 and
produces the same tree — its own git repo on `main`, one commit `Instance
created` authored `Metistry <metistry@localhost>`:

```
<dir>/
  Knowledge/now.md          from seed/Knowledge — the vault; brain-commit writes here
  identity.yaml             the ONLY place the assistant is named (--name)
  rules.yaml                router rules, seeded default
  identity.yaml             …and its instance_id: a v4 UUID minted once, the
                            Keychain account this instance's secrets file under
  Knowledge/Inbox/README.md where captures land — in the vault, so Obsidian
                            sees them and git carries them (docs/ops/inbox.md)
  state/                    gitignored — .env, Postgres data, assistant state
  queries/ agents/ routines/ extensions/ instance-migrations/
                            tracked, empty (.gitkeep) — the D4 overlay reads
                            seed defaults until a same-named file lands here
  metistry.lock             product { version, commit, source } + updated_at +
                            migrations_applied; `metistry update` moves it
  README.md  .gitignore     (state/, .obsidian/workspace*,
                            Knowledge/Inbox/.large/ — captures too big for git)
```

It refuses a non-empty directory unless `--force`, never prompts, and
**never writes a secret**. What it prints at the end is the next step —
five lines for `<dir>/state/.env`, this instance's own environment,
shaped for `--shape compose|launchd` (default: launchd on macOS, compose
elsewhere — `docs/ops/deployment-shapes.md`):

```
METISTRY_INSTANCE_DIR=<dir>
METISTRY_BRIDGE_TOKEN_RECONCILER=<minted once; shown only here>
METISTRY_RECONCILER_URL=http://127.0.0.1:7812              # --shape compose: http://host.docker.internal:7812
METISTRY_ORIGIN=http://127.0.0.1:8080
METISTRY_LOCAL_OWNER_TOKEN=<minted once; shown only here>
```

`METISTRY_ORIGIN` is the console's canonical origin (`docs/ops/auth.md`)
— it refuses to start without one, in either shape. The default above is
right for a loopback-only install; once this instance is reachable off
the machine (a tailnet hostname, an HTTPS reverse proxy) that origin
replaces it, and any passkeys already enrolled must be re-enrolled, since
they bind to the origin they were enrolled against. `METISTRY_RECONCILER_URL`
and `METISTRY_ORIGIN`'s port both follow this instance's own ports once
it is namespaced (`state/ports.yaml`, "A second instance on one Mac" in
`docs/ops/deployment-shapes.md`) — `--shape compose` never reads that
file, since `docker compose` doesn't either.

`METISTRY_LOCAL_OWNER_TOKEN` is the console's local owner door
(`docs/ops/auth.md`): presented from this machine it authenticates as the
`user` principal, which is how the Mac app and `metistry console whoami`
reach the console without a passkey ceremony.

Then `pnpm -r build && metistry up` — containers, every launchd job,
doctor (below). Add a private remote to the instance repo whenever you
like — `metistry connect-repo <url>`, the next section; the reconciler
pushes on `METISTRY_PUSH_SCHEDULE` and never blocks on it. Point Obsidian
at `<dir>/Knowledge` as the vault root.

`init` finds `seed/` in the checkout it runs from (`--product-dir`,
`METISTRY_PRODUCT_DIR`, the workspace it is installed in, or the current
directory's enclosing checkout — in that order) and otherwise uses the copy
bundled in the npm package, so a stranger's `npx … init` works without a
checkout.

## Connecting the instance repo to a remote

`metistry connect-repo <url>` points the instance repo at your private
remote and leaves credentials the **reconciler** can push with
unattended — which is the whole difficulty. A push that runs from
launchd at 03:00 cannot answer a password prompt, so the token has to be
somewhere git finds by itself, and nowhere else.

```sh
metistry connect-repo https://github.com/you/metistry-instance.git                 # --auth device (default)
metistry connect-repo https://github.com/you/metistry-instance.git --auth token   # PAT on stdin
metistry connect-repo git@github.com:you/metistry-instance.git --auth ssh         # your key is the credential
metistry connect-repo <url> --instance ~/metistry-instance --force                # repoint an existing origin
```

The instance repo comes from `--instance`, else `METISTRY_INSTANCE_DIR`
(read from the checkout's `.env` like every other variable). In order:

1. **`origin`.** Refuses to repoint an existing `origin` without
   `--force` — silently moving an instance to a different repository is
   how a vault goes missing.
2. **Credentials**, before the reachability check (a private repo answers
   nothing without them). For an `https` remote on macOS:
   `credential.helper=osxkeychain` is set **at the repo level**, and the
   token is written into the login Keychain as an internet password for
   the host (`security add-internet-password -r htps`) — exactly the item
   `git-credential-osxkeychain` looks for.
   - `--auth device` runs GitHub's **device-authorization flow**: it
     prints a user code and `https://github.com/login/device`, then polls
     (honouring `authorization_pending` and `slow_down`) until you
     approve in any browser, on any machine. Needs
     `METISTRY_GITHUB_OAUTH_CLIENT_ID` — see below.
   - `--auth token` reads a PAT (scope `repo`) from **stdin**, so it is
     never in argv, never in shell history:
     `pbpaste | metistry connect-repo <url> --auth token`.
   - `--auth ssh` writes no credential; `ls-remote` in step 3 is the
     check that your key or agent works.
3. **`ls-remote origin`** — reachability, proven rather than assumed.
4. **`POST /flush`** to the reconciler when `METISTRY_RECONCILER_URL` +
   `METISTRY_BRIDGE_TOKEN_RECONCILER` are set, so the sole committer
   lands its queue before anyone else touches the tree (D5). A reconciler
   that is not running is not an error.
5. **`push -u origin <branch>`** — one push, so the remote is proven end
   to end and the branch tracks. From here the reconciler pushes on
   `METISTRY_PUSH_SCHEDULE` (`docs/ops/reconciler.md`).

Every git and `security` call is an argument array through `execFile` —
no shell anywhere, so no part of a URL is ever interpreted.

**The token is never printed, never written to `.env`, never put in the
remote URL or `.git/config`.** The tests assert that negatively: they
scan every line of output and every argument of every subprocess for the
token.

### The OAuth App you must register (one-time, by the owner)

`--auth device` uses a GitHub **OAuth App** with device flow enabled. The
product ships Folded Space Labs' app as the default (client id
`Ov23lid9DItZlts5e5GV`), so nothing needs registering: the id is public by
design — a device-flow app has no client secret — and it grants the app
nothing; you approve the `repo` scope on your own account, and the token
lands only in your Keychain. To use your own app instead, register one
(GitHub → Settings → Developer settings → OAuth Apps, tick **Enable Device
Flow**) and set `METISTRY_GITHUB_OAUTH_CLIENT_ID` in `.env`. `--auth token`
and `--auth ssh` work unchanged.

### The Keychain trade-off, on the record

The credential item is written with `security -A` (any application on
this login may read it). The alternative — trusting one binary by path —
is invalidated by every Xcode or Homebrew git update, which would turn
the reconciler's 03:00 push into a silent failure behind a GUI prompt
nobody is there to click. The item is still gated by the login keychain
being unlocked, and anyone running as this user already holds `.env`.

### Linux

There is no Keychain. `connect-repo` skips it and prints the equivalent:
point `credential.helper` at `store --file ~/.git-credentials` and put
the token in that file, `chmod 600`. Everything else (origin,
`ls-remote`, flush, push) is identical.

## Connecting an external dev tool: `metistry connect <tool>`

`metistry connect <cursor|opencode|devin|claude-code>` is the other `connect` — not
the instance repo's remote, but one **external agent** per dev tool at the
console's `/mcp` (plan refresh 2026-09-13 §4b W3). One row per tool, one
bearer per tool, independently revocable: adopting a second tool is minting
a token and running one command, and dropping one is revoking its row.

```sh
metistry connect cursor                     # ~/.cursor/mcp.json + the Keychain
metistry connect opencode                   # ~/.config/opencode/opencode.json + the Keychain
metistry connect devin                      # prints the fields to paste (no API to write them)
metistry connect claude-code                # mints the plugin's token, prints its env lines
metistry connect cursor --rotate            # a replacement bearer; the old one dies at once
metistry connect cursor --areas Knowledge/Areas/Engineering --project second-instance
metistry connect devin --remote             # enrols PENDING: its token works once you let it in
metistry connect --list [--json]
```

The verb is idempotent because the agent id **is** the tool name: a re-run
finds the row the last one made. The console returns a bearer exactly once,
at mint or rotate, so an already-registered tool is told its token is
unchanged rather than shown a secret — `--rotate` is the only way to see a
new one.

One delivery per tool, chosen by what the tool can read:

| tool | what is written | where the bearer goes |
| --- | --- | --- |
| `cursor` | `~/.cursor/mcp.json` → `mcpServers.metistry` (`url` + `headers`, 0600, other servers preserved) | the login Keychain; the file names it as `Bearer ${env:METISTRY_AGENT_TOKEN_CURSOR}` |
| `opencode` | `~/.config/opencode/opencode.json` → `mcp.metistry` (`type: "remote"` + `headers`, 0600, other servers preserved; an existing `opencode.jsonc` is the file written, since OpenCode loads it last) | the login Keychain; the file names it as `Bearer {env:METISTRY_AGENT_TOKEN_OPENCODE}` |
| `claude-code` | nothing — the plugin reads its environment | the login Keychain, with the `export` lines printed |
| `devin` | nothing — MCP servers are registered in a web form | printed once, for pasting |

Because a bearer that cannot be stored would have to be rotated to be
recovered, `connect cursor`, `connect opencode` and `connect claude-code`
refuse on a host with no Keychain **before** minting anything. `connect devin` works anywhere.

Grants are the console's and start default-deny (`{tier: "none", areas: []}`
— `db/migrations/0007_agents.sql`): `--areas` widens the read tier to those
TitleCase `Knowledge/` prefixes, `--project` adds membership. No flag grants
`knowledge_write`: an `external` principal cannot reach it at the bridge at
all, so "read-only by default" is true by construction rather than by
configuration. A re-run with no flags leaves grants exactly as they were.

A namespaced instance (`metistry up --namespace`) follows its own
`state/ports.yaml`: the console port in the URL, and the label suffix in both
the config key (`mcpServers.metistry-<suffix>`) and the variable name
(`METISTRY_AGENT_TOKEN_CURSOR_<SUFFIX>`), so two instances on one Mac cannot
overwrite each other's entry.

### `--remote`: a tool that will call from off this machine

A loopback tool is already on the Mac whose Keychain holds its bearer, so
there is nothing more to prove and `connect` enrols it immediately. A tool
that will present its token **from somewhere else** enrols `--remote`, and
then:

- the row starts **pending**: `/mcp` and `/capture` answer the same uniform
  401 an unknown token gets, so the bearer is inert;
- a **Needs You** item appears with two buttons, `approve` and `deny`
  (`deny` revokes the row);
- `metistry connect --list` shows the tool as `pending` rather than
  `registered`, and `POST /api/agents/<id>/approve` is the same answer from
  the console side.

`--remote` is decided at enrolment and refused on a row that already exists:
promoting a row the owner already let in would be a widening dressed as a
flag. Approval is not a grant — a row let in still holds its default-deny
read tier. `docs/ops/console-api.md` has the wire detail.

`docs/ops/cursor.md`, `docs/ops/opencode.md` and `docs/ops/devin.md` are the
per-tool pages —
including what each tool can then do through `/mcp`, how to widen a grant,
and (for Devin) why a cloud session needs an inbound path this install does
not have yet.

## Knowing other instances: `metistry instances`

The peer registry — which *other* instances this one knows about, in the
instance repo's `instances.yaml`:

```sh
metistry instances add https://second.example.com   # asks it who it is, then records it
metistry instances list [--json]
metistry instances refresh                          # re-ask every recorded origin
metistry instances remove <instance_id|name>
```

`add` reads the origin's own `GET /api/identity` — the one unauthenticated
read a console has — and records its `instance_id`, display name and the
coarse capabilities it advertises. No credential is involved, and an origin
that will not say who it is is refused rather than guessed at. Rows are
keyed by `instance_id`, never by origin, because an origin can move;
`refresh` leaves an unreachable peer exactly as it was (a closed laptop is
not a departed instance) and refuses to repoint a row whose origin now
answers as somebody else.

A §4.7 protected path like `compute.yaml`: every write goes through the
reconciler as the `user` principal, and an edit whose RESULT would not
validate is refused rather than written. The console serves the same file to
the Mac app and the phone at `GET /api/instances`.
`docs/ops/instances.md` is the whole story, including why `resources:` is
empty and what this deliberately is not.

## How much room an agent has: `metistry agents autonomy`

```sh
metistry agents autonomy researcher                       # show the effective table
metistry agents autonomy researcher --level act_within_scope --deny dispatch
metistry agents autonomy researcher --allow comment,capture --json
```

What one agent may do with an **action** — `dispatch`, `task_update`,
`comment`, `capture` ([actions.md](actions.md)). `--level` sets the ceiling
(`observe | propose | act_within_scope`); `--allow` / `--propose` / `--deny`
set one kind each and may repeat or take a comma-separated list. With no flags
it prints what is stored and what that resolves to.

The command is a **client of `PUT /api/agents/:id/autonomy`**, not a second
implementation: it reads the record, merges your flags onto it (so setting one
kind never erases the §4.21 narrowing beside it) and sends it back with this
install's `METISTRY_LOCAL_OWNER_TOKEN`, which never reaches argv or stdout. It
is one of exactly two doors a **widening** may come through — the console's own
form is the other — and any raise it makes prints, lands in `runs` as
`agent_admin` / `autonomy_widened`, and puts one alert in Needs You. A record
that changed underneath answers `409` and is not retried.

## Exporting the audit ledger: `metistry runs export`

```sh
metistry runs export > runs.ndjson
metistry runs export --since '2026-09-01T00:00:00Z' --component reconciler
metistry runs export --since "$(tail -1 runs.ndjson | jq -r .cursor)" >> runs.ndjson
```

Every `runs` row as NDJSON on stdout, oldest first, with `core`'s redaction
already applied and each line carrying this instance's `instance_id` and —
where the row names an agent — the qualified `agent:<name>@<instance_id>`
form, so two instances' ledgers merge without colliding
(`docs/ops/instances.md`).

Each line carries its own `cursor`; the last one is what `--since` takes to
resume, and a bare timestamp works too. `--until` bounds the far end,
`--component` filters, `--limit` stops early. The summary goes to **stderr**
so stdout stays pipeable; `--json-lines` is the explicit spelling of the
default and changes nothing.

It goes through the console (`GET /api/runs/export`, the `user` principal)
and never straight to Postgres — one read path into state (invariant 3). A
stream that stops mid-line is reported as an **error**, never as a short
export: an audit export that is quietly incomplete is worse than one that
failed, and the message names the cursor to resume from.

## Choosing compute: `metistry compute`

`metistry compute` is this instance's `compute.yaml` — which providers
exist, which model each tier and crew runs on, and what each may spend:

```sh
metistry compute providers add --from openrouter|zen|lmstudio|ollama|llamaserver
metistry compute models list [--provider <name>]
metistry compute assign default lmstudio/google/gemma-3n-e4b
metistry compute budget instance --monthly 60 --action stop
metistry compute show [--json]
```

A §4.7 protected path like `deployment.yaml`: every write goes through the
reconciler as the `user` principal, and an edit whose RESULT would not
validate is refused rather than written. `providers add` reads the API key
from stdin into the login Keychain (user scope) and never takes it as an
argument. Nothing dials a provider or enforces a budget yet — see
`docs/ops/compute.md`, which is the whole story including what is missing.

### Local models

`models list` is live `/v1/models` against every declared provider **and** a
scan of the three local servers Metistry knows — LM Studio (1234), Ollama
(11434) and the bundled `llama-server` (7813). One that is answering but
that nothing dials is reported with the command that would wire it up, and
`metistry doctor` carries the same finding as `local:lmstudio`,
`local:ollama` and `local:llamaserver` rows. **Absent is never a failure.**

```sh
metistry compute models install lmstudio/qwen/qwen3-coder-30b
metistry compute models install ollama/gemma3:4b
metistry compute models install llamaserver/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf
metistry compute models load|unload lmstudio/qwen/qwen3-coder-30b [--ttl 3600]
```

Each is the server's own mechanism: `lms get` for LM Studio, `POST
/api/pull` for Ollama, and for `llama-server` one HTTPS GET of a Hugging
Face GGUF into `<instance>/state/models/`, checked against the sha256
Hugging Face publishes and then written into `serve.model_path`. `load` and
`unload` act for LM Studio only — the other two have no addressable load and
say what actually governs their residency instead of reporting a success
nobody caused. `METISTRY_HF_TOKEN` is only needed for a gated repo.

A provider with a `serve:` block is one Metistry runs itself: `metistry up`
gives it a supervisor child called `llamaserver`, so `metistry logs
llamaserver` and `metistry restart llamaserver` work like any other service.
Details, and what the schema refuses, in `docs/ops/compute.md`.

## Secrets: the Keychain is the store, `.env` is generated

`metistry secrets` makes the macOS login Keychain the canonical home of
every secret this install holds, under the service name
`metistry:<VAR>`; `.env` becomes a file generated from it rather than one
edited by hand (`docs/product/desktop-app-plan.md`, first-run step 4).

```sh
metistry secrets sync --to keychain               # import .env's secret lines into the Keychain
metistry secrets sync --to env                    # regenerate .env's secret lines from the Keychain
metistry secrets mint METISTRY_ASSISTANT_TOKEN    # a new random token, into both
metistry secrets list                             # names, scopes and where each lives — never a value
metistry secrets purge --instance <dir> [--yes]   # delete one instance's Keychain items
```

`--from` says the same thing from the other end (`--from env` ==
`--to keychain`); one of them is required, because guessing the direction
of a secret copy is how a Keychain gets overwritten with placeholders.

**What counts as a secret** is the name: anything ending `_TOKEN`,
`_PASSWORD`, `_PRIVATE`, `_SECRET` or `_KEY`; anything carrying `_TOKEN_`,
`_PASSWORD_` or `_SECRET_` mid-name (the per-bridge variables are
`METISTRY_BRIDGE_TOKEN_<NAME>`). So `METISTRY_VAPID_PRIVATE` is one and
`METISTRY_VAPID_PUBLIC` is not; `METISTRY_AWS_SECRET_ACCESS_KEY` is one
and `METISTRY_AWS_ACCESS_KEY_ID` is not. The names themselves come from
your `.env` plus `.env.example`, including the commented-out
declarations — that is where a not-yet-set variable is documented.

**`--to env` rewrites in place.** Only the lines that assign a secret
variable change; every comment, blank line, ordering and non-secret
assignment survives byte-for-byte (a test asserts exactly that), because
`.env` also carries hand-written configuration this command must not own.
A commented declaration (`# METISTRY_GITHUB_TOKEN=`) is uncommented in
place; a secret the file never named is appended under one marker
comment. The file is written `0600`.

**Values never travel in argv.** `security ... -w` given as the last
option prompts, and the prompt reads stdin when there is no tty, so the
value goes down the child's stdin and never appears in `ps`. `secrets
list` checks presence *without* `-w`, so there is no code path in it that
can read a value, let alone print one.

`--env-file <path>` targets a `.env` other than the resolved one, and
`--instance <dir>` says which instance this is. On Linux `secrets` refuses
and points at `chmod 600` on `.env` or your own secret manager.

### Two scopes: the instance's, and yours

An item is `metistry:<VAR>` plus an **account**, and the account is what
keeps several instance directories on one Mac apart. One table —
`SECRET_SCOPES` in `packages/cli/src/secrets.ts` — decides which account a
name belongs under, so `sync`, `mint`, `list`, `purge` and the Mac app
cannot disagree:

| scope | account | which variables |
| --- | --- | --- |
| **instance** | the instance's `instance_id` | `METISTRY_DB_PASSWORD`, `METISTRY_LOCAL_OWNER_TOKEN`, every `METISTRY_BRIDGE_TOKEN_*`, `METISTRY_ASSISTANT_TOKEN`, `METISTRY_VAPID_*`, `METISTRY_GITHUB_*` — **and anything not listed**, because self-containment is the rule |
| **user** | `metistry` (override: `METISTRY_KEYCHAIN_ACCOUNT`) | every `METISTRY_*_API_KEY` (a compute provider credential named by `compute.yaml`'s `auth.secret` — your account with that provider, shared by every instance on this Mac), `METISTRY_DEVIN_API_KEY`, `METISTRY_AWS_SECRET_ACCESS_KEY`, `METISTRY_AWS_SESSION_TOKEN` (your AWS account, not this instance's) |

`METISTRY_SIGN_IDENTITY` and `METISTRY_GITHUB_OAUTH_CLIENT_ID` are not
secrets; they stay plain `.env`/config values.

**`sync --to env` migrates as it goes.** It looks in the instance's
account first, then the user account as a fallback — and an instance-scoped
value found only under the user account is **copied** to the instance's,
with a line saying which. The old item is never deleted, so rolling back to
an older CLI still finds it. `secrets list` shows `scope` (where a name
belongs) beside `keychain` (the account an item was actually found under),
so `instance / user` reads "not migrated yet".

With no `instance_id` available — no instance directory configured, or one
created before 2026-09-09 that has not run `sync`/`up` yet — every secret
stays under the user account exactly as before.

**`sync --to env` mints the generated ones.** A secret that exists in
neither the Keychain nor `.env` is normally reported ("not in the Keychain,
left as they are") — inventing a GitHub PAT would be nonsense. The
exception is `GENERATED_SECRETS` (`packages/cli/src/secrets.ts`): a secret
whose value means nothing outside this install, so minting one can never be
the wrong guess and nobody has to paste it anywhere. `metistry up`'s
generated `METISTRY_DB_PASSWORD` is the precedent; `METISTRY_LOCAL_OWNER_TOKEN`
(`docs/ops/auth.md`) is the current list. An install that predates the
variable gains one on the next sync — restart the console for it to take
effect:

```
$ metistry secrets sync --to env
minted METISTRY_LOCAL_OWNER_TOKEN — it was in neither the Keychain nor …/state/.env:
  the console's local owner door — an install that predates it gets one here
restart the console for a freshly minted secret to take effect (`metistry restart console`).
```

### `secrets purge --instance <dir>`

Deleting a test instance directory used to orphan its Keychain items.
`purge` deletes them, preview-then-confirm:

```
metistry secrets purge --instance ~/instances/test-two          # preview; deletes nothing
metistry secrets purge --instance ~/instances/test-two --yes    # deletes
```

It only ever touches that instance's own account, and refuses outright
when the directory has no `instance_id` or when its account somehow *is*
the per-user account. User-scoped names are listed as kept. It does not
remove the directory itself.

## Importing Claude Code sessions

```
metistry import-sessions [--since <date>] [--project <path>] [--limit N] [--dry-run]
```

Summarises this machine's Claude Code sessions and posts each one to
`POST /capture` as `kind: session`, where `inbox-drain` classifies it and
Needs You lists it (stash review 2026-09-09, item 2). Opt-in — nothing
runs it for you — and **summaries only, never transcripts**: full-transcript
capture is the thing that review declined.

**Host only.** It reads `~/.claude/projects/`, which the console container
has no access to; there is no containerised path for this verb.

**Deterministic.** No model is called. The summary is measured from the
transcript: session id, project path and repo, branch, start/end and
duration, user- and assistant-turn counts, first prompt (clipped to 300
chars), last assistant message (500), files touched (paths out of
`Read`/`Edit`/`Write`/notebook tool inputs, deduped, capped at 40), tool
names with call counts, models, token totals, and cost *if* the transcript
carries one. Thinking blocks and tool output never travel.

**The layout it relies on** (confirmed on this Mac against Claude Code
2.1.251, 2026-09-09):

```
~/.claude/projects/<cwd with every "/" and "." replaced by "-">/<session uuid>.jsonl
```

one JSON object per line, appended live. Fields read — all optional, all
guarded: `type` (`user` / `assistant`; everything else ignored),
`timestamp`, `cwd`, `gitBranch`, `version`, `sessionId`, `isSidechain`
(subagent turns are not the owner's turns), `isMeta`, and `message` with
`role` / `model` / `usage` / `content` blocks (`text`, `tool_use`). A
half-written last line is skipped, not fatal. These files carry **no cost
field** on this machine, so `cost` is usually absent. The directory name is
a lossy encoding (`-` for both `/` and `.`), so the cwd comes from the
records and the decoded name is only a fallback.

**Idempotency, twice over.** A ledger at
`~/.metistry/imported-sessions.json` (0600) keyed by session id + transcript
mtime makes a second run a no-op; a session that has since grown is
re-imported as a new summary. Every note also carries an
`idempotency_key` in its frontmatter — derived from the transcript's state,
not the clock — so the server can dedupe across this verb and the Claude
Code plugin's `SessionEnd` hook, which computes the same key for the same
session (`docs/ops/claude-code-plugin.md`).

**The frontmatter both doors emit:**

```yaml
kind: "session"
source: "claude-code"
title: "Claude Code session — <repo> — <YYYY-MM-DD>"
session_id: "…"
project: "/Users/…/demo"
repo: "demo"
branch: "claude/…"
started: "2026-09-08T10:00:00.000Z"
ended: "2026-09-08T10:37:00.000Z"
turns: 2
host: "studio"
captured_at: "2026-09-09T00:00:00.000Z"
idempotency_key: "claude-code:<session id>:<16 hex>"
```

**The other doors emit it too**, with their own `source` and the same key
formula, so the console dedupes across all of them and `inbox-drain`
classifies them identically: `plugins/claude-code` (`SessionEnd`),
`plugins/cursor` (`sessionEnd` — `docs/ops/cursor.md`) and `plugins/opencode`
(`session.idle`, with the quiet window and the one case it cannot reach —
`docs/ops/opencode.md`).

**Credentials.** `METISTRY_URL` and `METISTRY_OWNER_TOKEN` come from the
environment (the checkout's `.env` is loaded first), else from the login
Keychain (`metistry:METISTRY_URL`, `metistry:METISTRY_OWNER_TOKEN`).
Neither is printed, and every error line is redacted before it is written.
`--dry-run` needs no credentials at all and reaches no network: it prints
each note it would post, then a count.

Posts run two at a time. The command exits non-zero only on a hard
failure — nothing got through when something should have, or the ledger
could not be written — so a single unreachable capture among many does not
fail the run.

## Reading a doctor report

```
name                                              kind       status  ms   remediation
------------------------------------------------  ---------  ------  ---  -----------
apple-fm                                          bridge     ok      920
eventkit                                          bridge     failed  4    eventkit rejected the token (HTTP 401) — the METISTRY_BRIDGE_TOKEN_* in .env differs …
reconciler                                        service    ok      53
console                                           service    ok      6
db                                                db         ok      16
migrations                                        db         ok      3
launchd:com.foldedspacelabs.metistry.reconciler   launchd    ok      4
compose:console                                   container  ok      0
…
24 checks: 23 ok, 0 degraded, 1 failed, 0 absent — FAILED (/Users/you/src/metistry)
```

One row per thing that can be wrong; every row is a `core` `CheckResult`
(`name`, `status`, `latency_ms`, `probe`, `remediation`, `meta`) plus a
`kind`. Statuses mean what they mean everywhere else in the product:

| status | meaning | exit code |
| --- | --- | --- |
| `ok` | validated / answered / running | |
| `degraded` | runs, but needs a hand — the remediation says what (a bridge lost a TCC grant, migrations pending, a container still starting) | still 0 |
| `absent` | not configured or not installed: a bridge with no URL in `.env`, a launchd job never bootstrapped, no docker on this machine | still 0 |
| `failed` | down, wrong token, exited, invalid manifest | **1** |

`degraded` and `absent` do not fail the run because "degrades absent" is
how optional bridges are designed to behave (a Linux box has no apple-fm).
Something you rely on that shows `absent` is still a finding — read the
column, not just the exit code.

**What is probed, generically.** Doctor knows no component by name. It
walks every `manifest.yaml` under `collectors/ routines/ packages/ apps/
targets/`, validates it with `core`'s schema, and for anything that
declares an http surface calls `GET /check` with the bearer from the same
`METISTRY_*_URL` / `METISTRY_BRIDGE_TOKEN_*` pairs the console container
and the watchdog use (`host.docker.internal` rewritten to loopback because
doctor runs on the host). The bridge's own `check()` — a *behavioral* probe
(apple-fm classifies a sentence; eventkit reads a calendar; the reconciler
reads `HEAD` and lists `Knowledge/`) — is what decides `ok` vs `degraded`,
and its remediation string is what you see. The console's `/health` and
`/api/status` are hit directly, and with `METISTRY_LOCAL_OWNER_TOKEN` in the
environment `/api/status` is a real **authenticated** read through the same
door the Mac app uses (`docs/ops/auth.md`) — `meta.authenticated` says which
it was. A refused token *degrades* that row (the console is up and serving)
and names both causes: a `.env` the console was not started with, or a
request that did not arrive from this machine. Without the token, `401` is
still correct and still passes — a passkey session is required. Then the db
(`SELECT 1`, and `schema_migrations` vs `db/migrations/*.sql`), the launchd
jobs behind every plist in `ops/launchd` (macOS), and `docker compose ps`
against the services in `docker-compose.yml`.

**The `schedules` rows.** Every collector and routine manifest also gets a
`kind: schedule` row read from the `runs` table: when it last ran, whether
that run succeeded, how many failures are open since its last success, when it
is next due, and whether the runner has stopped running it (a failure streak
at `METISTRY_RUNNER_MAX_STREAK`) or never started it (a declared prerequisite
missing). `failed` — and so exit 1 — is reserved for the states you have to
act on: given up on, blocked on configuration, or more than 2× its interval
with no run at all. A component that has simply never run is `absent`, because
a fresh install is not broken. `docs/ops/automation.md` has the whole failure
model and the `--json` shape.

Add a component by adding a directory with a manifest; doctor covers it.
A new http bridge named `foo` on port 7820 is probed the moment
`METISTRY_FOO_URL` (and `METISTRY_BRIDGE_TOKEN_FOO`) exist in `.env`.

`.env` is read for variables that are unset — the `ops/scripts` convention
— from `<instance>/state/.env` and then the checkout's deprecated one
("Instance directories are self-contained" above), so
`METISTRY_EK_URL=… metistry doctor` overrides a line in the file for one
run (handy for checking a token before writing it down).

## Service control

```sh
metistry restart [<service>…] [--json] [--dry-run]
metistry stop    [<service>…] [--json] [--dry-run]
metistry start   [<service>…] [--json] [--dry-run]
metistry logs <service> [--lines N] [--follow] [--dry-run]
```

**This is what the Mac app's menu bar calls.** Restart/stop/start/show-logs
for one service — the app is a front end for the CLI, never a second
implementation of "how do I restart the reconciler": a behaviour the menu
bar needs is a CLI change first (the same rule `docs/ops/mac-app.md`
states for `doctor --json`).

No args = every service the current shape runs — read from `deployment.yaml`
exactly the way `up` reads it (`runDirFor`, the instance's D4 overlay), and
split into host jobs vs. containers using the same functions `up` and
`doctor` already call (`loadPlistTemplates`, `composeServiceNames`) rather
than a second table that could drift from theirs:

- **launchd agents** (the supervisor, the TCC helpers) — `restart`:
  `launchctl kickstart -k gui/<uid>/<label>`. `stop`: `launchctl bootout`
  of that label (tolerated if it was already not loaded — the desired end
  state is reached either way). `start`: `launchctl bootstrap` of the plist
  `up` already installed (tolerated if it is already bootstrapped) followed
  by `kickstart -k`, so it ends up running regardless of the job's prior
  state.
- **the supervisor's children** (`db`, `console`, `reconciler`,
  `assistant`, a configured bridge) — one line on the supervisor's control
  socket, `<instance>/state/run/supervisor.sock`. launchd has never heard of
  these processes, so launchctl cannot address them; the answer carries the
  state the request produced (`console restart → running (pid 80650)`).
  With **no service named**, only the agents are acted on and the children
  follow them: booting out the supervisor takes its children down with it,
  and bootstrapping it starts them in order.
- **compose shape / containers** — `docker compose restart|stop|start
  <name>`.

Every named service is acted on even when an earlier one fails — this is a
"try everything, report what happened" command, unlike `up`'s
stop-at-first-failure plan. `--json` prints one object per service,
`{service, action, ok, detail}`, for the app to render; without it the
output is a table like `doctor`'s. A name that isn't a service this shape
runs fails the whole command (exit 2) with the list of known ones — it
never guesses which subprocess a name might mean. `--dry-run` prints the
exact command per service and runs nothing, the same seam `up --dry-run`
uses (`StepRunner`).

`metistry logs <service>` tails the last 200 lines by default (`--lines N`
to change it, `--follow` to stream): under the launchd shape, the log file
the plist's `StandardOutPath`/`StandardErrorPath` already point at (parsed
from the template the way `workingDirectory` is — no separate
`/tmp/metistry-<service>.log` convention to keep in sync by hand), for an
agent and for a supervisor child alike, because a child's log path IS the
one its plist named; under compose, `docker compose logs <name>`.
`metistry logs supervisor` is the one to read when a child will not start:
it carries every start, exit, backoff and crash-loop line.

On a platform with no launchd (anything but macOS) a host job's name is
simply not a known service — the command refuses rather than pretending
`launchctl` exists there (`docs/ops/deployment-shapes.md`, "Linux hosts").

## Seeding a product directory from an app bundle

```sh
metistry runtime install --from /Applications/Metistry.app [--to <dir>] [--force] [--dry-run]
```

A signed `Metistry.app`'s `Contents/Resources/metistry/` is a **seed**, not
a product directory: the bundle cannot be written to, and `metistry update
--channel release` must write `releases/<version>/`, flip `current` and
unpack a new `runtime/`. This copies the seed to
`~/Library/Application Support/Metistry/product/` (or `--to`), and every
plist `metistry up` writes points there — so an app install and a checkout
install update through exactly the same code
(`docs/product/desktop-app-plan.md`, `docs/ops/mac-app.md`).

`--from` takes the `.app` or the `Resources/metistry` inside it.
Idempotent: the seed's own `releases/<v>/metistry-runtime.json` and
`runtime/manifest.json` are read and cross-checked against its `current`
symlink **before anything is copied**, their sha256s go into
`.metistry-install.json` beside `current`, and a second run with the same
seed does nothing. A bundle whose manifest disagrees with `current`, or
that carries no `packages/cli/dist/main.js`, is refused rather than
half-installed.

## Bringing an install up

`metistry up [--no-compose] [--no-launchd] [--namespace] [--dry-run] [--instance <dir>]`
takes a product checkout plus an instance with a filled-in
`state/.env` to *running*. It prints which dotenv file that is, renders it
into the plists as `__ENV_FILE__`, and hands it to `docker compose` as
`--env-file` (compose interpolates from its own `./.env` otherwise, which
is no longer the install's environment).

**What it starts is the same in every deployment shape; where depends on
`deployment.yaml`** (`docs/ops/deployment-shapes.md`). The default is
`compose` and the steps below describe it. Under `shape: launchd` there
is no docker at all: `up` prepares a user-space Postgres (step 0), then
installs **one launchd agent** — `com.foldedspacelabs.metistry`, the
supervisor — which runs Postgres, the console, the reconciler, the assistant
and any configured bridge as its children (step 2), then creates the
database, then doctor. macOS shows one background item per agent, named
after its program, so one agent is one item called **Metistry**. The TCC
helpers keep an agent each, because a grant attaches to the binary that
asks. `doctor` reports the shape as its first row, a row per child, and
writes every remediation for the shape.

An install that predates the supervisor is migrated in passing: `up` boots
out the old per-service agents once and deletes their plists before
installing the supervisor, so nothing runs twice.

**`--namespace`** allocates this instance its own launchd label suffix
(from `instance_id`) and an 8-port block, recorded **once** in
`<instance>/state/ports.yaml`, so a second instance can run beside the
first. Everything afterwards — `up`, `doctor`, `restart|stop|start`,
`logs`, `update` — reads that file; delete it (after `metistry stop`) to
return the instance to the fixed labels and ports.
`docs/ops/deployment-shapes.md` has the layout and the rules.

> **Quote `state/.env` values that contain a space.** The reconciler,
> watchdog and TCC bridge jobs load that file with `set -a; . <file>`,
> which *runs* it, so `KEY=/Users/…/Application Support/…` is a command,
> not an assignment. `up` refuses with the offending variables and line
> numbers rather than installing jobs that respawn forever.

0. **Postgres (launchd shape only).** Find the binaries
   (`METISTRY_PG_BIN`, a bundled `runtime/postgres/bin`, Homebrew
   `postgresql@17`), `initdb` into `<instance>/state/pg` once, write the
   managed block in `postgresql.conf`. A missing toolchain prints a
   `brew install` line and stops — `up` installs nothing itself.
1. **Containers.** `docker compose up -d --build` in the checkout — or,
   when the instance's `metistry.lock` says `source: release`,
   `docker compose pull` then `up -d --no-build` (a release install never
   builds; plan §4.16).
2. **Host jobs (macOS).** Every `ops/launchd/*.plist` is a template with
   two placeholders. `up` renders `__REPO__` → the checkout and `__NODE__`
   → the first `node` on `PATH` (the `$(which node)` symlink, deliberately
   not the realpath under `Cellar/…` that a `brew upgrade` deletes — the
   Phase 0 versioned-path lesson) into `~/Library/LaunchAgents/`, then per
   job: `launchctl bootout` (tolerated when not loaded), `bootstrap`,
   `kickstart -k`. This is exactly the by-hand recipe in each plist's
   comment, so a job installed by hand is simply re-rendered in place.
   Under the launchd shape the same templates are rendered the same way,
   but only the supervisor's and the TCC helpers' become agents: the rest
   become **children** in `<instance>/state/supervisor.json` (0600), each
   with the argv, working directory, environment and log path its plist
   named. `console` and `assistant` carry their whole environment in a dict
   rendered from `.env` (no shell, nothing interpolated), and the
   `assistant`'s root process is still `sandbox-exec` running
   `ops/sandbox/assistant.sb`. A bridge becomes a child only when this
   install has opted into it — its `METISTRY_*_URL` is set — so an install
   with no calendar bridge starts no job that could only fail.

   **`--register-via app`** does everything above except install the
   supervisor's own agent: the Mac app registers the copy inside its bundle
   through `SMAppService.agent(plistName:)`, which is what nests it under
   the app in Login Items. `up` writes the three paths that agent needs to
   `~/Library/Application Support/Metistry/supervisor.env`
   (`docs/ops/mac-app.md`).
3. **Doctor.** Its verdict is `up`'s exit code — `0` when nothing is
   `failed`. A step that fails stops the plan (nothing after it runs),
   doctor still runs for the diagnosis, and the failing command's exit
   code is kept.

Every subprocess is an argument array through the CLI's one exec seam —
no shell, nothing interpolated from `.env`. `--dry-run` prints each
command (and each file it would write) and runs **nothing**, doctor
included; it is the same code path with execution turned off, so what it
prints is what a real run does.

```
   env: /Users/you/instance/state/.env
[dry-run] == compose
[dry-run] (cd /srv/metistry && docker compose --env-file /Users/you/instance/state/.env up -d --build)
[dry-run] == launchd
[dry-run] write ~/Library/LaunchAgents/com.foldedspacelabs.metistry.watchdog.plist  (from ops/launchd/…, __REPO__=/srv/metistry, __NODE__=/opt/homebrew/bin/node, __ENV_FILE__=/Users/you/instance/state/.env)
[dry-run] launchctl bootout gui/501/com.foldedspacelabs.metistry.watchdog   # ok if not loaded
[dry-run] launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.foldedspacelabs.metistry.watchdog.plist
[dry-run] launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.watchdog
…
[dry-run] == doctor
[dry-run] metistry doctor
```

### Linux hosts

There is no launchd, and this has not been run on a Linux host yet, so
`up` **prints** the equivalent systemd user units — one per plist,
`EnvironmentFile=<instance>/state/.env`, `ExecStart=<node> <checkout>/…/dist/main.js`,
`Restart=always` — and writes nothing. Save each to
`~/.config/systemd/user/`, then `systemctl --user daemon-reload &&
systemctl --user enable --now <unit>`. Turning that into an installed
step is a follow-up once a Linux install exists to test it against; the
TCC-bound jobs (eventkit, apple-fm) have no Linux counterpart at all
(§4.17: absent, not broken). `update` on Linux likewise tells you which
units to restart rather than restarting them.

## Updating

`metistry update [--skip-build] [--skip-migrate] [--dry-run]` moves an
install forward, in this order:

| step | git mode (the product is a checkout) | release mode (`metistry.lock`: `source: release`, or `--channel release`) |
| --- | --- | --- |
| product | `git fetch` + `git pull --ff-only` — a diverged checkout stops the update (exit code git's) | resolve the release, download its runtime pack + `checksums.txt`, **verify the sha256**, unpack to `releases/<version>/`, point `current` at it (`docs/ops/releases.md`) |
| build | `pnpm install --frozen-lockfile` + `pnpm -r build` (`--skip-build` to reuse `dist/`) | no build — the pack is compiled output |
| migrations | `db/migrations/*.sql` not yet in `schema_migrations`, in filename order, one transaction each, under `pg_advisory_lock` (below); `--skip-migrate` leaves them to doctor to report | same, read from `current` |
| restart | `docker compose up -d --build`; `launchctl kickstart -k` for each host job whose code changed | `docker compose pull` + `up -d --no-build` in `current`, with the versioned ghcr images; same kickstart rule |
| lock | write `metistry.lock` into the instance repo | same, pinned to the release actually installed |
| doctor | the verdict, as for `up` | same, against `current` |

Release-mode flags: `--version 0.2.0` installs a specific release instead
of the latest; `--rollback` flips `current` back to the previous release
without downloading anything (migrations are additive-first and are **not**
reverted); `--channel git|release` overrides the lock's `product.source`
for one run. `metistry init --channel release` writes `source: release` in
the first place. A checksum mismatch aborts before anything restarts and
leaves `current` and the lock untouched. Full runbook, layout and secrets:
**`docs/ops/releases.md`**.

Resolving a release needs to read GitHub's Releases API; on a **private**
repo, `METISTRY_GITHUB_TOKEN` must be a fine-grained PAT with **Contents:
read** on that repo — Issues/Pull requests/Metadata (what the github-state
collector needs) is not enough, and a token missing it gets a 403 that
looks like rate limiting but isn't (the error message says which one it
is, using `x-ratelimit-remaining`). Without that scope, `metistry update`
falls back to the `gh` CLI automatically when it is on PATH and logged in
(`gh auth login`) — `gh`'s own credential is independent of
`METISTRY_GITHUB_TOKEN`, so it can resolve and download the release even
when the PAT cannot.

Downloading an asset is a separate call from resolving the release, and on
a private repo it needs a separate fix: a release's `browser_download_url`
only works with a browser session, so it 404s for a token even when
resolving the release worked fine. With `METISTRY_GITHUB_TOKEN` configured,
`metistry update` downloads every asset (the runtime pack, the runtime-deps
pack, and their shared `checksums.txt`) through the authenticated API
instead — `GET /repos/<repo>/releases/assets/<id>` with
`Accept: application/octet-stream` — following the redirect to GitHub's
signed, short-lived S3 URL without resending the token. With no token
configured (a public repo), `browser_download_url` is used directly. Either
path falls back to `gh release download` on a 404, the same way an
unauthorised *resolve* already does.

**What "changed" means.** Before the build, `update` hashes the code each
launchd job executes — read from the plist itself (`__REPO__/<path>` in
`ProgramArguments`): `apps/watchdog/dist` for the watchdog,
`apps/reconciler/dist` for the reconciler, `packages/mcp-*/dist` for the
node bridges, the bare binary for the EventKit helper. After the build it
hashes again and kickstarts only the jobs whose digest moved. A change to
a `src/` file that produced no `dist/` change restarts nothing; a rebuilt
helper binary restarts the helper. Containers are always `up -d --build`
— compose's own cache decides whether anything rebuilds.

**Migrations under the advisory lock.** The runner is
`ops/scripts/migrate.sh` ported to the CLI, and the two share one
constant: `pg_advisory_lock(1296389203)` (`MIGRATION_LOCK_KEY` in
`packages/cli/src/migrate.ts`, `LOCK_KEY` in the script; a test greps
both). Whoever holds the lock creates `schema_migrations` if needed,
applies what is pending — each file plus its `INSERT` in one
transaction — and unlocks; a concurrent runner (a second `update`, or
`pnpm db:migrate` at the same moment) blocks on the lock, then finds every
file recorded and applies nothing. A failing file is rolled back whole,
records no row, stops the run (nothing after it is applied, `update`
exits 1 before touching the containers), and the lock is released with
the session. `migrate.sh` stays the zero-dependency path and now runs the
whole sequence in **one** psql session (advisory locks are
session-scoped) — `\gset`/`\if` per file, `ON_ERROR_STOP` ending the
session on error.

**Writing the lock.** `metistry.lock` lives in the *instance* repo, and
the reconciler is that repo's sole committer (`docs/ops/reconciler.md`,
D5) — so `update` writes it as a bridge call, never as a file:
`POST $METISTRY_RECONCILER_URL/vault/write` with
`intent: { principal: "user", message: "metistry update → <version>" }`.
`metistry.lock` is a §4.7 protected path; `user` is the one principal
allowed to write it, and the commit lands on the reconciler's next flush.
A bridge that is configured but not answering, or that refuses, fails
the update (exit 1) with the reason — the lock is then simply not moved;
rerun after fixing. Only when **no** bridge is configured
(`METISTRY_RECONCILER_URL` unset) *and* `METISTRY_INSTANCE_DIR` is a
local directory does `update` write the file directly — and even then it
first checks that no reconciler launchd job is running, because a
running reconciler with no URL in `.env` is a misconfiguration to fix,
not to write around. (A reconciler installed later sweeps that direct
write into a `user` commit like any other out-of-band edit.) No instance
dir at all → nothing is written, and `update` says so.

`--dry-run` prints the whole plan — including the migration step as one
line and the kickstarts annotated with the path each one depends on —
and opens no db session, calls no bridge, runs no doctor.

## `metistry.lock`

One shape, written by `init` and moved by `update`; YAML, in the instance
repo's root:

```yaml
# metistry.lock — the product release this instance runs (plan §4.16).
# `metistry update` moves the pin; edit by hand only to roll back.
product:
  version: "0.0.1"          # the cli package's version — the release this instance runs
  commit: "83eea07…"        # product commit at the time of writing ("unknown" without a checkout)
  source: git               # git = a checkout `update` fast-forwards; release = pinned published artifacts
updated_at: "2026-09-07T15:00:00.000Z"
migrations_applied:         # every db/migrations file in schema_migrations when this was written
  - "0001_init.sql"
  - "0002_review_decisions.sql"
```

`init` writes `migrations_applied: []` (there is no database yet) and the
checkout's `HEAD` when run from inside one. `product.source` is what
switches `up`/`update` between building from the checkout and pulling a
release; it is `git` until releases exist. The parser is strict — a
malformed lock is an error, not a guess — with one exception: the shape
an earlier `metistry init` wrote (`version:` + `created:`) is read as a
`git` pin and rewritten in the current shape on the next `update`.

## Moving the inbox into the vault: `metistry migrate-inbox`

An instance created before 2026-09-16 keeps its captures in a gitignored
`<instance>/inbox/`, where Obsidian cannot see them and git does not carry
them. One verb moves it (`docs/ops/inbox.md` has the why):

```sh
metistry migrate-inbox --dry-run     # the whole plan, nothing run
metistry migrate-inbox               # do it
metistry up                          # the verb restarts nothing itself
```

It moves `inbox/*` into `Knowledge/Inbox/` — `git mv` for what git tracks,
a plain move for the rest, since the old inbox was ignored — drops `inbox/`
from `.gitignore`, adds `Knowledge/Inbox/.large/` (captures too big for git),
rewrites `inbox.path` rows to `Knowledge/Inbox/<file>`, and commits once in
the instance repo. It is idempotent: a second run reports "already on the
vault inbox" and changes nothing.

A second instance that already moved its inbox to a **lowercase**
`Knowledge/inbox/` is detected by reading the real directory entry — on a
case-insensitive Mac `existsSync("Knowledge/Inbox")` answers true for it —
and renamed through a temporary name, because `git mv Knowledge/inbox
Knowledge/Inbox` would otherwise move the directory inside itself.

`--instance <dir>` picks the instance; without it, `METISTRY_INSTANCE_DIR`.
Obsidian needs no change: the vault root is still `Knowledge/`.

## Maintenance

The cadence is plan §5 "Maintenance cadence"; the CLI is how the
operator-facing parts of it happen:

- **On every product change:** `metistry update` (or `update --dry-run`
  first). Pull, build, migrate, restart what changed, pin, doctor — one
  command, idempotent, safe to rerun.
- **After changing `deployment.yaml`:** `metistry up`, having stopped
  what the old shape was running and taken a dump — the data does not
  move between shapes (`docs/ops/deployment-shapes.md`).
- **After a reboot, a Docker restart, or a `brew upgrade node`:**
  `metistry up`. It re-renders the launchd jobs (the node path is the
  stable symlink, so a node upgrade usually needs nothing — but `up` is
  the fix when it does), restarts what is not running, and reports.
- **Weekly:** `metistry doctor` alongside the review routine; a `degraded`
  row is a finding even at exit 0 (a bridge lost a TCC grant, a push
  failed, migrations pending because someone ran `git pull` without
  `update`). The two deliberately use different silence thresholds: the
  watchdog's `silent-collector` probe pages at `METISTRY_WATCHDOG_SILENCE_FACTOR`
  (default 3×) a component's own manifest interval so it catches a stall
  fast, while the weekly review's System section flags anything quiet for
  a flat 7 days, matching its own weekly cadence.
- **Quarterly:** the restore test (`ops/scripts/restore-test.sh`) —
  `metistry.lock`'s `migrations_applied` says which schema the dump was
  taken under.
- **On drift:** if `up --dry-run` shows a plist that differs from what
  is installed, or `doctor` shows `absent` for a job you rely on, the
  checkout and the machine have drifted — `up` reconciles them.

## Not yet

`metistry enroll` (§4.2 passkey enrollment from the host) and `metistry
create <bridge|collector|…>` (§5 extension scaffolds) are not started.
`connect-repo --auth device` has been exercised only against an injected
fetch: the live GitHub round trip waits on the OAuth App being
registered.
Release mode is complete end to end (`docs/ops/releases.md`) but has not
yet consumed a real published release — the first `v*` tag is its first
live run. The CLI ships no `manifest.yaml`: `core`'s schema has no type
for a command-line tool and inventing one is worse than the gap.

**These verbs have a second caller now.** The Mac app (`apps/macos`,
`docs/ops/mac-app.md`) drives `init`, `connect-repo --auth device`,
`secrets sync`, `up` and `doctor --json` as its first-run flow and its
Status panel, and is expected to move onto `secrets list --json`,
`identity --json`, `version --json`, `deployment --json` and
`deployment set-shape` for the Settings pane and wizard code that today
parses `identity.yaml`/`package.json`/the `secrets list` table itself
(`apps/macos/sources/kit/instance-files.swift`,
`apps/macos/sources/kit/secret-listing.swift`) — the same commands, with
`--product-dir` always passed
explicitly because a GUI process has no useful working directory. It is a
front end, never a second implementation: a behaviour the app needs is a
CLI change first. Two things that matter when editing them: `doctor --json`
is a wire contract the app decodes (a renamed field breaks a panel, and
`apps/macos/tests/kit/doctor-report-tests.swift` is the misuse test that
says so), and `connect-repo --auth device` prints its device code as
`Open <uri> and enter this code:   <code>` — the app parses that line to
show the code as a card, and falls back to the raw log if the wording
changes.
