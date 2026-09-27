# `metistry` — init, connect-repo, connect, secrets, console, doctor, up, down, update, service control

`packages/cli` (`@foldedspacelabs/metistry-cli`, plan §4.16: `init | doctor
| up | update`, plus the install verbs the Mac app drives — `connect-repo`,
`secrets`, `identity`, `version` and `deployment`,
`docs/product/desktop-app-plan.md` — and the per-service verbs its menu bar
drives: `restart | stop | start | logs`, below) is the operator's front door.
All of them are real.

| verb | what it does |
| --- | --- |
| `init <dir>` | create a private instance repo, asking once whether to keep this Mac awake (`--keep-awake <value>` answers it without a terminal) |
| `connect-repo <url>` | point the instance repo at a remote, mint credentials the reconciler can push with |
| `secrets sync\|mint\|list [--json]` | move secrets between the Keychain and `.env` |
| `secrets set\|replace\|remove\|hosts\|grant <name>` | owner-named secrets, per instance: the value on stdin into the Keychain, the policy into `.metistry/secrets.yaml` |
| `secrets list --named [--json]` | the owner-named secrets: names, hosts, grants, presence — never a value |
| `secrets retire-legacy-env [--yes]` | move what only the product checkout's `.env` still has into the instance's, then delete it |
| `connect <tool> [--rotate]` | give one external dev tool (Cursor, OpenCode, Devin, Claude Code) its own agent token and config |
| `connect --list [--json]` | which tools are connected: the row, the bearer, the config |
| `console whoami [--json]` | ask the console who it thinks you are, with this install's owner token |
| `console call <METHOD> <path> [--body @file\|-] [--idempotency-key <key>] [--json]` | one authenticated request against the console, as `whoami`'s same principal — the scripting seam |
| `console session --stdio` | `console call`, held open: one long-lived child answering JSON request lines on stdin — the Mac app's transport |
| `identity [--json]` | the instance's `.metistry/identity.yaml` (name, mention, voice, icon, instance_id) |
| `identity set [--name] [--mention] [--mark] [--dry-run] [--json]` | change the assistant's name, mention and mark through the protected write (M10); an invalid field is refused and nothing is written |
| `--version` / `version [--json]` | this CLI's version, the resolved product dir's, the lock's pin, and a release's runtime pack |
| `deployment [--json]` | the effective shape (D4 overlay) and the services it implies, with cheap running state |
| `deployment set-shape <compose\|launchd>` | write the instance's `.metistry/deployment.yaml` through the reconciler, preview-then-confirm |
| `deployment set-keep-awake [<never\|allow_sleep_on_battery\|always\|always_lid_closed>] [--enabled\|--sleep-on-battery\|--sleep-lid-closed true\|false]` | whether this install holds the Mac awake, on which power, and whether a closed lid should stay awake (macOS); the same protected write; the lid setting is stored and never applied — only an administrator's `pmset` delivers it |
| `vault settings [--push <after_commit\|manual\|<n>m\|<n>h>] [--pull <n>m\|<n>h] [--yes] [--json]` | the vault's git sync policy (M18): when the reconciler pushes and pulls; the same protected write |
| `vault rollback <commit> \| --to <date> \| --file <path> [--to <date>] [--include-config] \| --request <id>` | roll the vault back (M18): a Needs You request with the preview; Approve makes one new commit as `user`; configuration only with `--include-config` |
| `migrate-layout [--dry-run] [--json] [--allow-dirty]` | carry an instance from the legacy layout to the flat one: the directory becomes the vault, the machinery moves under `.metistry/`, stored paths lose `Knowledge/` |
| `migrate-inbox [--dry-run]` | move a pre-#156 `inbox/` into the vault inbox and rewrite `inbox.path` |
| `migrate-shape <launchd\|compose>` | move a LIVE install between the shapes, with its data: dump, stop, flip, up, restore, verify, doctor |
| `templates check [<file>]` | does the vault's `Templates/` read — every directive, with the line number Obsidian shows — before the next run reads it (a template change takes effect at the next run) |
| `doctor` | validate every manifest and probe every bridge, service, container, launchd job |
| `up` | bring an install to running: containers/host jobs, then doctor — and exit |
| `down` | stop every host job and container for this instance, then confirm nothing is left running |
| `update` | move an install forward: pull/build, migrate, restart what changed, pin, doctor |
| `restart [<service>…]` | `launchctl kickstart -k`, or `docker compose restart`, per service |
| `stop [<service>…]` | `launchctl bootout`, or `docker compose stop`, per service (`down` is all of them) |
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
node packages/cli/dist/main.js down                # stop all of it, then confirm; --dry-run, --json
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
node packages/cli/dist/main.js connect claude-code --areas Areas/Engineering
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

**`--json`, uniformly.** Every verb above that takes `--json` writes exactly
one JSON document to stdout and nothing else — a step's own notes, a
download's progress, "already in the Keychain" asides, every human line a
verb would otherwise print goes to stderr instead. This is enforced in each
verb's own case in `main.ts` (the step runner it hands to a module is a
stderr writer under `--json`, a stdout one without it), not left to a
"remember not to print there" convention. It closed off the Mac app's
Compute pane having to parse a trailing object out of a stream of prose
(`docs/ops/mac-app.md`); without `--json` the same notes print to stdout
inline, exactly as before.

## What it looks like

The presentation layer is `packages/cli/src/ui.ts` and its rules are
`docs/ops/cli-style.md`: colour only when stdout is a terminal that wants it
(`NO_COLOR`, `TERM=dumb`, `--no-color` and `--json` each turn it off;
`FORCE_COLOR` turns it on for a pipe that really is one), one icon and one
colour per status from a closed vocabulary, `[ok] [x] [!]` where the locale
is not UTF-8, secondary text dimmed, prose wrapped at the terminal width
clamped to [60, 100], and a spinner only on a TTY.

Two consequences worth knowing before editing a verb: **colour never reaches
a `--json` document** (`createUi({ json: true })` is the enforcement, not a
convention), and **the status word is always spelled out** beside its icon,
so nothing is distinguished by hue alone. Render functions take a `Ui` as
their last argument; `main()` configures the process's one from the flags.

## `identity`, `version`, `deployment`, `console whoami`: what the app reads instead of the files

Five small, read-mostly verbs exist so the Mac app stops parsing
`.metistry/identity.yaml`, `package.json` and the `secrets list` table itself
(`apps/macos/sources/kit/instance-files.swift`,
`apps/macos/sources/kit/secret-listing.swift`) — the same "a behaviour the
app needs is a CLI change first" rule as `doctor --json` and the
`restart|stop|start|logs` verbs above.

`metistry identity [--json] [--instance <dir>]` prints `.metistry/identity.yaml` as the
CLI already understands it — `name`, `mention`, `voice`, `icon`,
`instance_id` — resolving `--instance`/`METISTRY_INSTANCE_DIR` like every
other instance verb.

`metistry identity set [--name <name>] [--mention <@slug>] [--mark <glyph>]
[--dry-run] [--json] [--instance <dir>]` is the one way to change it (M10 —
the Settings pane's *The Assistant* fronts this verb). `.metistry/identity.yaml`
is a §4.7 protected path, so the write takes the same door as `metistry.lock`:
through the reconciler as `user`, with the owner bearer
(`protected-write.ts`), or straight to disk when no reconciler is configured.
The reconciler records every protected write it accepts as a `config_write`
run, so the change shows in Activity (`activity_feed`) whichever door made it.

- **The mark is `icon:`.** The design's *mark* (C123) is the file's existing
  `icon:` key; the key is not renamed, so `GET /api/identity`'s `icon` and
  every existing instance keep reading it.
- **Validated before anything is written**, and a refusal writes nothing (exit
  1): a name is one line, trimmed, at most 40 characters, with no `{{`/`}}`; a
  mention is `@` plus lowercase letters, digits and single hyphens (at most 41
  characters); a mark is exactly one character or emoji. The edited text is
  read back before it is sent — what was asked for landed, and `voice` and
  `instance_id` did not move.
- **The mention follows the name** when it was the one `init` derived from the
  old name (`Metis` → `@metis`); a mention set on its own stays until
  `--mention` moves it. A name that yields no mention (`李`) needs `--mention`.
- Only the lines that change are rewritten; comments and `voice: >` keep every
  byte. Setting what the file already says writes nothing.
- The console and the assistant read `identity.yaml` when they start:
  `metistry restart` shows the new identity.
- `--json` prints `{changes: [{field, from, to}], mention_followed_name,
  identity, delivery}`; progress goes to stderr.

`metistry --version` / `metistry version [--json]` prints every version
number an install can be asked about, each only as far as it resolves:
this binary's own package version (always); when a product dir resolves,
that directory's OWN `package.json` version (the checkout root, or a
release's unpacked `current/` — which can differ from the running CLI's own
version); the instance's `.metistry/metistry.lock` pin and channel; and, for a release
install, `metistry-runtime.json`'s version, commit and build time.

`metistry deployment [--json]` prints the effective shape (`.metistry/deployment.yaml`'s
D4 overlay, same as `doctor`'s `deployment` row) and the services it
implies, each tagged with whether it is running — `launchctl print` /
`docker compose ps`, the same cheap, no-network probes `doctor` itself uses
for those rows, reused rather than reimplemented. It never runs the full
`doctor` (which also probes every bridge over HTTP).

`metistry deployment set-shape <compose|launchd> [--yes] [--force]` writes
the instance's `.metistry/deployment.yaml`. It is a §4.7 protected path (invariant 2:
how the system behaves is a human change), so the write goes through the
reconciler as the `user` principal — exactly like `.metistry/metistry.lock` and
`.metistry/identity.yaml` (`protected-write.ts`) — with no reconciler configured
falling back to a direct write the same way those do. Preview-then-confirm:
without `--yes` nothing is written or POSTed, only planned; with it, applied.
It refuses when `db`/`console`/`assistant` (the services whose shape
actually depends on this file) are still running under the current shape,
because the data does not move between shapes on its own
(`docs/ops/deployment-shapes.md`) — the refusal says what `metistry stop`,
the shape change, then `metistry up` would do. `--force` writes anyway.
`reconciler`/`watchdog` being up is never a reason to refuse: they are host
jobs under either shape (invariant 6).

`metistry deployment set-keep-awake <never|allow_sleep_on_battery|always|always_lid_closed> [--yes]`
writes the same file, the same way — protected path, through the reconciler
as the `user` principal, preview without `--yes` — and prints what the
choice costs before it writes it. It does **not** refuse while services are
running: `set-shape` refuses because the data does not move between shapes
on its own, and changing the power policy moves nothing. It takes effect at
the next `metistry up`, which is what renders the value into the
supervisor's environment.

The four values, what each does and the one that cannot be delivered in
full are in `docs/ops/deployment-shapes.md`, "Keeping the Mac awake". Short
version: absent means `never` and nothing is held; `metistry init` asks the
question once, on a terminal, and writes your answer; `metistry doctor`
reports one `keep-awake` row, `degraded` at worst.

**The switches (T4-20).** The same setting is also the Services pane's
switch and its two sub-switches, and the verb takes them as flags, each
`true` or `false` and nothing else (a bare `--sleep-lid-closed` is refused,
never read as true):

```sh
metistry deployment set-keep-awake --enabled true --yes            # the switch
metistry deployment set-keep-awake --sleep-on-battery false --yes  # hold on battery too
metistry deployment set-keep-awake --sleep-lid-closed false        # preview: prints the lid dialog
metistry deployment set-keep-awake always --sleep-lid-closed false --yes
```

A value alone is written as itself (`keep_awake: always`), so a file that
only ever used the four values keeps reading that way. A flag changes only
the switch it names — over the value when one is given, else over the setting
already in effect — and writes the object form, one line, every key said:
`keep_awake: { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }`.
Naming neither a value nor a flag, a second value, or a value that is not
one of the four is a usage error (exit 2).

`--sleep-lid-closed false` (and `always_lid_closed`) is stored as asked, and
before it is, the verb prints the lid dialog: the administrator command
(`sudo pmset -a disablesleep 1`), how to undo it (`sudo pmset -a disablesleep 0`)
and why it is not recommended. **The verb runs neither** — no code path in
Metistry runs `pmset` with arguments that write, and a test sweeps the source
for one. `metistry doctor` reads `pmset -g` and reports whether the
administrator setting is in effect.

`metistry migrate-shape <launchd|compose> [--dry-run] [--namespace]` is the
verb for a LIVE install, and it is deliberately not a flag on `set-shape`.
`set-shape` writes one line of a config file and refuses while anything is
still running — that refusal is what stops someone flipping the shape out
from under a running Postgres, and a migration is exactly the operation
that has to run inside it. So `migrate-shape` owns the ordering and calls
`setDeploymentShape` for the file write, rather than reimplementing the
protected-write path.

Going to `launchd` it quiesces the writers, `pg_dump`s the live database
through the running `db` container to `<instance>/.metistry/state/migrate/<ts>.dump`
and verifies it with `pg_restore --list` **before stopping anything**,
`docker compose stop`s (never `down -v` — the volume is the rollback),
writes the shape through the reconciler, runs `up` (initdb under
`<instance>/.metistry/state/pg`, every host plist re-rendered against `current/`,
the bundled node and `<instance>/.metistry/state/.env`), `pg_restore`s **before any
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
`http://127.0.0.1:8080`. A namespaced instance (one with
`<instance>/.metistry/state/ports.yaml`, written by `metistry up --namespace`)
fills `METISTRY_CONSOLE_URL` with its own console port when nothing set it —
the same rule `doctor`, `connect` and `up` apply — so `whoami`, `call` and
`session` with `--instance <dir>` reach that instance's console and never the
default install's 8080. Every other verb that presents the owner token
(`agents`, `runs export`, `compute cache-report|route-report`, `connect`)
resolves it the same way. An explicit `METISTRY_CONSOLE_URL` in the environment
or `state/.env` still wins. The token comes from the environment
(`<instance>/.metistry/state/.env`) or the login Keychain — this instance's account
first, the per-user one behind it — and never reaches argv, stdout or an
error message. A 401 is one of exactly two things and the error names both:
a token the console was not started with, or a request that did not arrive
from this machine (under compose, the NAT question — `docs/ops/auth.md`).

`metistry console call <METHOD> <path> [--body @<file>|-] [--idempotency-key <key>] [--json]`
is the scripting seam behind `whoami`: one authenticated request against the
console, as the same `user` principal, over the same loopback door. It
prints the response body — pretty-printed unless `--json`, which prints the
console's own bytes verbatim — and exits non-zero on a `>=400` answer,
naming the error envelope's `code` and `message` (and `field`, when the
body carries one) on stderr. With `--json`, the console's own body ALSO
prints on stdout for a `>=400` — so a `409` conflict's `reason`, `decision`
and the row itself (`docs/ops/console-api.md`'s `conflictBody`) survive the
trip rather than being dropped with the envelope; plain mode is unchanged,
the body stays off stdout on a failure. A body comes from a file
(`--body @request.json`) or stdin (`--body -`, so a value never sits in
shell history); GET needs neither. It refuses a non-loopback
`METISTRY_CONSOLE_URL`/`METISTRY_URL` outright — the local owner token is
minted for this machine only, and this verb will not carry it anywhere
else. `docs/ops/console-api.md` is the routes it can call; the app and
`docs/ops/second-instance.md` use it rather than a second HTTP client.

`--idempotency-key <key>` sends `Idempotency-Key` (`docs/ops/console-api.md`
— today only `POST /capture` reads it), checked against the same shape the
server enforces (trimmed, non-empty, at most 200 characters) before the
request ever goes out, so a bad key is this verb refusing rather than a
round trip finding out. A replay — the console's own `idempotency-replayed`
response header, which this verb prints no other trace of — folds
`"replayed": true` into the `--json` body; in plain mode it is a one-line
note on stderr instead, and the printed body is untouched.

```
$ metistry console call GET /api/whoami
{
  "principal": "user",
  "via": "local_owner_token",
  "management": true
}
$ metistry console call POST /api/instances --body @peer.json --json
{"action":"added","instances":[…]}
$ metistry console call POST /capture --body @note.json --idempotency-key retry-1 --json
{"id":42,"path":"Inbox/1757556000000-note.md","sha256":"…"}
$ metistry console call POST /capture --body @note.json --idempotency-key retry-1 --json   # retried
{"id":42,"path":"Inbox/1757556000000-note.md","sha256":"…","replayed":true}
```

`metistry console session --stdio` is `console call` held open, for a client
that makes many requests — the Mac app (`SessionConsoleCallTransport`,
`docs/ops/mac-app.md`). A one-shot `console call` is a whole process per
request: about **141 ms** median on a scratch instance (20 runs of `GET
/api/whoami`, 2026-09-26), almost all of it node starting and the token being
looked up. Through one session the same request is about **1.5 ms** median.

The console URL and the local owner token are resolved **once**, when the
session starts, and the same refusals apply before a single line is sent: no
token, or a non-loopback console, prints the reason on stderr and exits 1,
with nothing on stdout. Stdin is attached **before** that resolution, so a
client may write its first request the moment it spawns the process: the
line is held and answered once the target is known (through 0.12.0 it was
lost, and that call waited out its timeout). A refusal discards every held
line — none is sent anywhere, and the token is never printed.
After that nothing exits but EOF on stdin, and **the token is never printed**
— every line written is redacted against it, whatever the console sent back.

Each stdin line is one JSON object; each request gets **exactly one terminal
line** on stdout, matched by `id` (a string or an integer) — never by order,
because requests run concurrently:

| in | out |
| --- | --- |
| `{id, method, path, body?, idempotency_key?}` | `{id, status, body, replayed?}` — the console answered, any status; `body` is its JSON (or its text) |
| | `{id, error: {code, message}}` — no answer: `unreachable` (the console did not answer, or the stream broke), `invalid_request` (the line was refused here, before anything went out), `duplicate_id` (that id is still in flight) |
| `{id, method: "GET", path: "/api/events", stream: true, last_event_id?}` | `{id, event: {id, type, data}}` per Server-Sent Event, then `{id, ended: "cancelled" \| "closed"}` — or, if the console did not open a stream (a `401`, a `404` before it serves the route), an ordinary `{id, status, body}`. An `id:` with no `data:` — the cursor the console sends a fresh subscriber — arrives as `{id, event: {id}}`: nothing happened, but it is the id to resume from |
| `{id, cancel: true}` | ends that stream (its `ended` line is the answer); cancelling what already finished is not an error |

`body` is a JSON value, sent as `application/json`; `idempotency_key` is
checked exactly as `--idempotency-key` is; `last_event_id` rides as
`Last-Event-ID` so a resubscribe resumes (design-build-plan §2.20). Only `GET
/api/events` may be a stream. A path must be absolute on the console — the
session refuses one that would carry the token to another host. EOF ends
every open stream as `cancelled`, answers what is still in flight, and exits
0.

```
$ printf '%s\n' '{"id":1,"method":"GET","path":"/api/whoami"}' \
    '{"id":"b","method":"POST","path":"/api/proposals/999999","body":{"decision":"skip"}}' \
  | metistry console session --stdio
{"id":1,"status":200,"body":{"principal":"user","via":"local_owner_token","management":true,…}}
{"id":"b","status":404,"body":{"error":{"code":"not_found","message":"not found"}}}
```

Package-level detail (flags, resolution order, probe table) lives in
`packages/cli/README.md`; this page is the operator's runbook.

## Instance directories are self-contained

**An instance directory holds everything about that instance** (ratified
2026-09-09, `docs/product/desktop-app-plan.md`). Nothing about it persists
outside its directory except its Keychain items, filed under its own
`instance_id` (the retired shared scope's originals aside — `metistry
secrets migrate-scope`). So:

- **`.env` lives at `<instance>/.metistry/state/.env`**, not in the product
  checkout. It is gitignored by the seed and written `0600`.
- **`.metistry/identity.yaml` carries an `instance_id`** (a v4 UUID from `metistry
  init`). Instance-scoped Keychain items are filed under it as the account.
- `.metistry/state/` also holds the launchd shape's Postgres data
  (`.metistry/state/pg`) and the assistant's transcripts
  (`.metistry/state/assistant`).

Every verb takes **`--instance <dir>`** (the Mac app passes it), and
`--env-file <path>` overrides the dotenv file outright. Resolution order
for the environment:

1. `<instance>/.metistry/state/.env` — the instance named by `--instance`, else
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
`<instance>/.metistry/state/.env` and **leaves the old file in place** — a running
install keeps working. Delete the old one yourself once nothing reports a
variable missing. Then `metistry up` renders the launchd plists to source
the new path and points `docker compose` at it with `--env-file`.

**Only one instance runs at a time.** launchd labels and ports are fixed,
so several instance directories can exist and be switched between, but
bringing up a second while the first runs makes them fight. Concurrent
instances need label/port namespacing — a recorded follow-up.

## Creating an instance repo

`metistry init <dir>` replaces the by-hand bootstrap of 2026-09-06 and
produces the flat instance layout (ruled 2026-09-17;
`docs/ops/instance-layout.md`) — its own git repo on `main`, one commit
`Instance created` authored `Metistry <metistry@localhost>`:

```
<dir>/
  now.md                    from seed/ — the vault; brain-commit writes here
  Inbox/README.md           where captures land — in the vault, so Obsidian
                            sees them and git carries them (docs/ops/inbox.md)
  Journal/                  the user's own daily note, one writer per file
    Plan/ Fold/ Standup/    machine-owned, one routine per folder (§5.1)
    Meetings/               the user's own meeting notes
  Templates/                Daily/Meeting/Plan/Standup/Fold/Weekly.md — all
                            `source: user`, so the assistant may never
                            overwrite them (docs/product/daily-flow-spec.md §6.1)
  Me/                       profile.md + `Working Style.md`, honest
                            placeholders — Metistry discovers these, never
                            assumes them (§6.6)
  People/ Projects/         empty; you add a page the first time you need one
  .metistry/
    identity.yaml           the ONLY place the assistant is named (--name)
                            …and its instance_id: a v4 UUID minted once, the
                            Keychain account this instance's secrets file under
    rules.yaml              router rules, seeded default
    queries/ agents/ routines/ extensions/ instance-migrations/
                            tracked, empty (.gitkeep) — the D4 overlay reads
                            seed defaults until a same-named file lands here
    metistry.lock           product { version, commit, source } + updated_at +
                            migrations_applied; `metistry update` moves it
    state/                  gitignored — .env, Postgres data, assistant state
  README.md  .gitignore     (.metistry/state/, .obsidian/workspace*,
                            Inbox/.large/ — captures too big for git)
```

It refuses a non-empty directory unless `--force`, never prompts, and
**never writes a secret**. `--force` onto an already-stamped directory never
overwrites a file that is already there — the journal tree, the six
templates and `Me/` are stamped once, so a template you have since edited
in Obsidian survives a re-run; only a file genuinely missing gets filled in.

**Re-stamping is `init`-only: `metistry update` never re-stamps the
vault — with one narrow exception, seed templates the vault lacks.** §6.1
of the daily-flow spec ties the journal tree, `Templates/` and `Me/` to
`metistry init`, and vault content is invariant 2's territory, not a
product update's. But a template a release adds (`Templates/Brief.md`, which
the Morning Brief reads) would otherwise reach only fresh installs, and the
routine that reads it would skip every morning on an upgraded one (W2
checkpoint D1). So `update`'s **templates** step (Updating, below) copies
each `seed/vault/Templates/*.md` that is **absent** from the vault — never
one that is there, edited or not. Everything else — the journal tree, `Me/`,
`People/`, `Projects/` — an instance created before it existed gets by hand:
copy it out of `seed/vault/` in a current checkout into the instance
directory and commit it yourself, the same way you would add any other note.

What it prints at the end is the next step —
six lines for `<dir>/.metistry/state/.env`, this instance's own environment,
shaped for `--shape compose|launchd` (default: launchd on macOS, compose
elsewhere — `docs/ops/deployment-shapes.md`):

```
METISTRY_INSTANCE_DIR=<dir>
METISTRY_BRIDGE_TOKEN_RECONCILER=<minted once; shown only here>
METISTRY_BRIDGE_TOKEN_RECONCILER_USER=<minted once; shown only here>
METISTRY_RECONCILER_URL=http://127.0.0.1:7812              # --shape compose: http://host.docker.internal:7812
METISTRY_ORIGIN=http://127.0.0.1:8080
METISTRY_LOCAL_OWNER_TOKEN=<minted once; shown only here>
```

The two reconciler bearers are not interchangeable: the `_USER` one is the
only credential that may write a §4.7 protected path, and it is deliberately
kept out of the console's environment (`docs/ops/auth.md`, "The principal
comes from the credential"). `metistry up` and `metistry update` mint it for
an install that predates it.

`METISTRY_ORIGIN` is the console's canonical origin (`docs/ops/auth.md`)
— it refuses to start without one, in either shape. The default above is
right for a loopback-only install; once this instance is reachable off
the machine (a tailnet hostname, an HTTPS reverse proxy) that origin
replaces it, and any passkeys already enrolled must be re-enrolled, since
they bind to the origin they were enrolled against. `METISTRY_RECONCILER_URL`
and `METISTRY_ORIGIN`'s port both follow this instance's own ports once
it is namespaced (`.metistry/state/ports.yaml`, "A second instance on one Mac" in
`docs/ops/deployment-shapes.md`) — `--shape compose` never reads that
file, since `docker compose` doesn't either.

`METISTRY_LOCAL_OWNER_TOKEN` is the console's local owner door
(`docs/ops/auth.md`): presented from this machine it authenticates as the
`user` principal, which is how the Mac app and `metistry console whoami`
reach the console without a passkey ceremony.

Then `pnpm -r build && metistry up` — containers, every launchd job,
doctor (below). Add a private remote to the instance repo whenever you
like — `metistry connect-repo <url>`, the next section; the reconciler
pushes on the vault sync policy (`metistry vault settings`, below) and never blocks on it. Point Obsidian
at `<dir>` itself — the instance directory is the vault root.

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
   to end and the branch tracks. From here the reconciler pushes and
   pulls on the vault sync policy (`metistry vault settings`, next).

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

## When the vault syncs: `metistry vault settings`

The reconciler — the instance repo's sole committer — pushes the vault to its
remote and pulls from it on a policy the owner sets (plan §2.21, M18). The
policy is the `vault:` block of the instance's `.metistry/deployment.yaml`:

```yaml
vault:
  push: after_commit     # after_commit | manual | {every: 15m}
  pull:
    every: 5m            # fetch every N; there is no "never"
```

| `push` | what it does |
| --- | --- |
| `after_commit` (default) | push once a flush has made commits. A push that failed — or commits left from before a restart — is retried by the scheduler, no more often than every five minutes, and only while something is unpushed |
| `{every: N}` | push every N (1m…24h), when there is something to push |
| `manual` | never push on its own; you push from a terminal |

`pull` is always an interval (1m…24h, default 5m): a remote the reconciler never
fetches from is how an install diverges without noticing. A pull is the
reconciler's sync without the push — commit and sweep, fetch, integrate
(fast-forward, rebase only its own unpublished commits, else merge; never
forced) — and a conflict stops it, raises one Needs You report, and stops
scheduled pushes until a later pull integrates cleanly
(`docs/ops/reconciler.md`, "Sync with the remote").

```sh
metistry vault settings                               # the policy in force, and where each answer came from
metistry vault settings --json
metistry vault settings --push 15m                    # preview the new block
metistry vault settings --push after_commit --pull 10m --yes   # write it
metistry vault settings --push manual --yes
```

With no flag it prints the policy in force and where each key came from — the
instance's file, the product's `seed/deployment.yaml`, or the default. With
`--push` and/or `--pull` it previews the whole block (a key you do not name
keeps its current answer, and the file ends up stating both); `--yes` writes
it — the same §4.7 protected write as `deployment set-shape`, through the
reconciler as `user` with the owner bearer. Every other line of the file is
left byte for byte. The reconciler re-reads `deployment.yaml` when it changes,
so the new policy is in force within a few seconds, with no restart. `--push`
takes `after_commit`, `manual`, or an interval with or without `every`
(`15m`, `every:15m`); `--pull` takes an interval. Anything else is refused and
nothing is written.

**`METISTRY_PUSH_SCHEDULE`** — the variable this replaces (`@hourly`,
`@daily`, `never`, `<n>[s|m|h]`) — still overrides `push` for this release,
exactly as it used to behave. `vault settings`, `doctor`'s *vault sync* row and
the reconciler's log all say so while it is set. It is never written into the
file: remove the line from `.env`, `metistry restart reconciler`, and set the
policy here.

Where sync stands — branch, ahead and behind, last commit, last push and
pull, any conflict, the policy — is `GET /api/vault/status`
(`docs/ops/client-api.md`) and doctor's *vault sync* row.

## Rolling back: `metistry vault rollback`

History is preserved, always (plan §2.21, M18, T10-6). A rollback is a **new
commit** that puts files back, made by the reconciler as `user` — never a
reset, a rebase or a force — and undoing it is rolling back that commit.

```sh
metistry vault rollback 4c1d2e3f                         # undo one commit
metistry vault rollback --to 2026-09-26                   # the vault as that day left it
metistry vault rollback --file Areas/Health/sleep.md      # one file, before its last change
metistry vault rollback --file Areas/Health/sleep.md --to 2026-09-20
metistry vault rollback --to 2026-09-26 --include-config  # configuration too — waits, then makes it here
metistry vault rollback --request 62                      # resume an --include-config wait
```

**It never happens on the spot.** The verb asks the console
(`POST /api/vault/rollback`, reach `local`, with this Mac's local owner token)
for a preview — the commits it undoes, the files it puts back — and raises one
Needs You request carrying it. Nothing changes until you Approve it (the app,
or the phone); Approve makes the commit, pinned to the history the preview was
computed on and refused `stale` if the change is no longer the one you saw.
Revise and Decline change nothing. `--to <day>` is sent as the end of that
day on this Mac's clock; a full ISO timestamp is sent as given.

**Configuration is left as it is** — every `.metistry/` path, `CLAUDE.md`,
`README.md` — and the preview names what it left alone. The console's bearer
cannot revert configuration at all (the reconciler refuses it). With
`--include-config` the request says so, Approve in Needs You records your
answer and reverts nothing, and **this terminal** waits for it (up to 30
minutes; Ctrl-C stops waiting and `--request <id>` resumes) and then makes the
revert itself with the owner-class bearer
(`METISTRY_BRIDGE_TOKEN_RECONCILER_USER`) — the same protected-write door as
every other configuration change. `.metistry/state/` and
`.metistry/instance-migrations/` are never rolled back by anyone.

A rollback touches files only. Postgres is derived (invariant 1): the
reconciler re-walks what it changed, so the index, tasks and embeddings follow;
decisions, feedback and grants are not rolled back. An uncommitted edit in the
way, a later edit to the same lines, or an operation you have in progress in
the working tree refuses it — nothing is overwritten. `--json` prints the
result for a script.

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
metistry connect cursor --areas Areas/Engineering --project second-instance
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
TitleCase vault-root prefixes, `--project` adds membership. No flag grants
`knowledge_write`: an `external` principal cannot reach it at the bridge at
all, so "read-only by default" is true by construction rather than by
configuration. A re-run with no flags leaves grants exactly as they were.

**On an instance that has not run `metistry migrate-layout`,** prefix them
with `Knowledge/`: `--areas Knowledge/Areas/Engineering`. A grant is matched
as a path prefix against the rows the reconciler indexed, and on a legacy
instance the vault is `Knowledge/` — so `--areas Areas/Engineering` there
matches nothing and grants nothing, silently. `migrate-layout` moves the
vault to the instance root and rewrites those paths; after it has run, the
flat spelling above is the only one.

A namespaced instance (`metistry up --namespace`) follows its own
`.metistry/state/ports.yaml`: the console port in the URL, and the label suffix in both
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

A §4.7 protected path like `.metistry/compute.yaml`: every write goes through the
reconciler as the `user` principal, and an edit whose RESULT would not
validate is refused rather than written. The console serves the same file to
the Mac app and the phone at `GET /api/instances`.
`docs/ops/instances.md` is the whole story, including why `resources:` is
empty and what this deliberately is not.

## Your own units: `metistry extensions`

M15 (plan §2.7): the owner's own units in `.metistry/extensions/<name>/` — a
provider template, a connection type, a target, or a replacement manifest for
a product collector or routine — loaded through the same registries as the
product's:

```sh
metistry extensions list [--json]           # every one: loaded, overlay (and what it replaces), skipped or unclaimed, with why
metistry extensions add <dir> [--dry-run]   # copy one data-only directory in, if its registry would load it
metistry extensions remove <name> [--dry-run]   # delete it; on an overlay, Reset to Default
```

`add` copies one flat directory of `manifest.yaml` plus `.yaml`/`.yml`/`.md`/
`.txt` files and refuses anything that could run — a script, an executable, a
symbolic link, a subdirectory — then puts the unit through its kind's registry
beside the product's, and refuses a unit the registry would skip with the
registry's own reason (no `schema: 1`, a value outside a closed vocabulary, a
kind no registry takes, a collector naming no product collector). Nothing is
written on a refusal. `remove` deletes the directory; what referred to the unit
turns absent, naming it, and nothing else is deleted.

A §4.7 protected path: every write and delete goes through the reconciler as
the `user` principal, with the owner-class bearer. `list --json` is one JSON
document: `{ dir, exists, extensions: [{ name, path, type, status, reason?,
replaced? }] }`. `docs/ops/extensions.md` is the whole story; `metistry doctor`
carries the same facts in its *registries* row.

## Who is registered, and what they hold: `metistry agents list`

```sh
metistry agents list
metistry agents list --json
```

```
✓ Researcher  researcher   seen 2026-09-20
    scope  an agent · folders: Areas/Health, Areas/Ops · queries, projects: alpha, autonomy: propose
    from   the registry — the owner's own hand, durable
               Read                                                  Write
    ─────────  ────────────────────────────────────────────────────  ───────────────────────────────────
    Knowledge  Areas/Health, Areas/Ops (approved in Needs You · #4)  —
    Work       alpha                                                 Create, Update, Comment, Dispatch ⏱
    Artifacts  alpha                                                 Publish, Comment, Review
    Inbox      —                                                     Capture
    Queries    Named queries                                         —
    asked  Areas/Finance — answer it in Needs You (request #42)
⚠ Devin       devin        pending
    scope  an agent · titles · autonomy: observe
    from   the registry — the owner's own hand, durable
               Read         Write
    ─────────  ───────────  ───────
    Knowledge  Titles only  —
    Inbox      —            Capture
```

Every registered agent and what its credential holds, as one **triple** —
role · access · extras. The access word is the read tier said the one way
(`none` / `titles` / `folders`); the extras are everything that is not the
tier: the `queries` switch, the projects, a crew's `uses` toolset, the
autonomy level. `from` is where the scope came from — configuration for the
instance's own assistant, its manifest for a crew, the registry for
everything else ([auth.md](auth.md)).

**Read-only, and deliberately not a renderer.** It is a client of `GET
/api/agents`, which sends each row's scope already rendered by
`describeScope` in `core` — so this command prints the words the console's
Agents panel and the Needs You card print, and cannot drift into a fifth
vocabulary for one record. A grant is still the owner's hand: the two doors
that widen one are the console's Agents panel and answering an
`access_request` in Needs You, and nothing in this command writes.

An agent waiting on an answer shows what it asked for and which request to
answer. `--json` prints the rows as the console sent them, colour off.

**The permissions table** (T4-6) is each agent's `permissions` from `GET
/api/agents` — Resource × Read × Write, drawn by `describePermissions` in `core`,
which asks the same `may()` every door asks — printed in core's words
(`permissionRowText`): an empty cell is `—` and **anything not listed is not
granted**. `⏱` is an action the owner answers first; an area approved in Needs
You says so, with its request. The console's Agents panel and the Mac app print
the same strings, held to it by a test ([actors.md](actors.md)). A revoked row
draws no table: it holds nothing.

## A crew's definition: `metistry agents define`

```sh
metistry agents define scout                                   # where it is, what it runs on, its sha256
metistry agents define scout --model openrouter/anthropic/claude-sonnet-5 --effort medium
metistry agents define scout --prompt-file scout.md --if-sha256 "$SHA"
echo "You triage the inbox." | metistry agents define triage --area ops --model same_as_assistant --prompt-file -
metistry agents define researcher --model same_as_assistant    # a shipped crew: writes the instance's own copy
```

**M12** (§2.2 of the plan): a crew's definition is one file,
`.metistry/agents/<area>/<id>.md` — its frontmatter and its operating prompt —
and it says how an actor behaves, so it is a §4.7 protected path in **your hand
alone**. The assistant can never write it (A4), and the console only reads it
(`GET /api/agents/:id/definition`); this verb is the write, and the Mac app's
definition editor is a client of it.

- It edits what the editor edits: `--prompt-file` (the operating prompt; `-`
  reads stdin), `--model` and `--effort` (one dropdown, C128), and
  `--description`. **Every other line of the file is kept as it was**, comments
  included — `uses`, `scope`, `projects` and `autonomy` are what the crew may
  reach, and widening an actor is an edit to the file by hand, never a flag.
- `--model` is `<provider>/<model-id>` or `same_as_assistant` (the assistant's
  default tier, model and effort — never the router). The legacy `haiku |
  sonnet | opus` are still read, through `compute.yaml`'s `assignments.crews`,
  for one release; this verb never writes one ([actors.md](actors.md), *Crew
  compute*).
- A **shipped** crew (`seed/agents/<area>/<id>.md`) is the base an edit starts
  from, and the result is the instance's own copy, which then wins by name. A
  **new** crew needs `--area`, `--model` and `--prompt-file`, and starts holding
  no tools and no scope.
- The result is read the way the console reads it (core's
  `parseCrewDefinition`) **before** anything is written: an edit the console
  would refuse — an empty prompt, a model that is not one, a name that is not
  the filename — is refused here, whole, and nothing is written.
- `--if-sha256 <hex>` is the stale check: the hash `GET
  /api/agents/:id/definition` answered with. A file that changed since is
  refused (`stale: …`) rather than overwritten.
- `assistant` is refused: its definition is `identity.yaml` (`metistry identity
  set`), the root `CLAUDE.md` and `.metistry/assistant-prompt.md`.
- With no edit flags it is a read. It writes through the reconciler as `user`
  (the instance repo's sole committer), or directly when no reconciler is
  configured; the console re-reads crews every `METISTRY_CREWS_SYNC_S` (five
  minutes) and at its next start. `--dry-run` prints the plan; `--json` prints
  `{id, area, path, from, sha256_before, sha256, model, effort, changed}`.

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

`metistry compute` is this instance's `.metistry/compute.yaml` — which providers
exist, which model each tier and crew runs on, and what each may spend:

```sh
metistry compute providers add --from <template>   # the product's: openrouter, lmstudio, ollama, llamaserver, applefm
metistry compute providers set <name> [--enabled on|off] [--billing token|subscription] [--base-url <url>] [--secret <name>]
metistry compute models list [--provider <name>]
metistry compute models search [<query>] [--provider <name>]
metistry compute assign default lmstudio/google/gemma-3n-e4b
metistry compute unassign <tier|crew:<name>>
metistry compute budget instance --monthly 60 --action stop
metistry compute show [--json]
```

A §4.7 protected path like `.metistry/deployment.yaml`: every write goes through the
reconciler as the `user` principal, and an edit whose RESULT would not
validate is refused rather than written. `providers add` reads the API key
from stdin into **one of this instance's secrets** — the login Keychain under
the instance's own account, its name recorded in `secrets.yaml` sent only to
the provider's host (`secrets set`'s own code) — and writes
`auth.secret: "{{ secret.<name> }}"`, a reference; it never takes the key as an
argument (`--secret <name>` picks which secret; an UPPER_SNAKE name is refused
with the name it became). `secrets sync --to env` then delivers it to the
engine as `METISTRY_SECRET_<NAME>` — the engine reads its environment, never the
Keychain. Budgets are enforced in the engine, before the call — see
`docs/ops/compute.md`, which is the whole story including what is missing.

`providers set` is the provider's gear (M16 — the Mac's and the CLI's, never a
console route): its **switch** (`--enabled off` = neither searched nor
offered, and nothing may be assigned to it — switching off a provider an
assignment names is refused, naming the assignment), its `billing`
(`subscription` is a cloud plan whose window is its limit; refused on a local
server), its base URL, and which secret its key is. `models search` groups every
switched-on provider's catalogue by **model** through
`seed/model-identities.yaml` (overlaid by the instance's own
`.metistry/model-identities.yaml`, by key) — one row per model, one line per
place it runs, priced from the listing or `pricing:`, the cheapest of two or
more marked; an id the table cannot map stays its own row under its provider.
`unassign` removes a tier or a crew — the other half of editing the tiers the
dynamic router chooses from (Q1); `default` is reassigned, never removed.

`--from` names a **provider template** — a unit of the provider registry: the
product's `seed/compute-templates/<name>/` and your own in
`.metistry/extensions/` (`metistry extensions`, below). The names come from the
registry, never from a list in code: `providers add` with no `--from`, or with a
name that is not one, is a usage error (exit 2) that names every template in
force — and, when a unit of that name was skipped, why.

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
Face GGUF into `<instance>/.metistry/state/models/`, checked against the sha256
Hugging Face publishes and then written into `serve.model_path`. `load` and
`unload` act for LM Studio only — the other two have no addressable load and
say what actually governs their residency instead of reporting a success
nobody caused. `METISTRY_HF_TOKEN` is only needed for a gated repo.

A provider with a `serve:` block is one Metistry runs itself: `metistry up`
gives it a supervisor child called `llamaserver`, so `metistry logs
llamaserver` and `metistry restart llamaserver` work like any other service.
Details, and what the schema refuses, in `docs/ops/compute.md`.

### The two reads

```sh
metistry compute cache-report [--since 7d] [--json]
metistry compute route-report [--since 30d] [--json]
```

Neither writes, calls a model or dials a provider; both read one named query
through the console's generic door. `route-report` is where messages went —
the rules' baseline (note, fast path, override, the fall-through) and, below
its verdict, **the policy, in shadow**: the console's `runs` rows of kind
`route` (docs/ops/dynamic-router.md §6), with what a local policy would have
chosen beside what the rules served. Until a `policy:` block exists that
section says every consultation was `absent`; `--json` carries it as
`policy`. Details in `docs/ops/compute.md`.

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

**Values never travel in argv.** Every Keychain write is `security -i`
(its interactive mode) with the one command line — value included — on the
child's stdin, so the process's argv is `-i` and nothing else, and the value
never appears in `ps`. Each argument is double-quoted with `\` and `"`
escaped, the way the tool's own tokenizer reads it back; a value with a
newline or NUL is refused, and so is a line longer than the 4095 bytes
`security -i` reads whole (a longer one is split and its tail run as a
command). `secrets list` checks presence *without* `-w`, so there is no code
path in it that can read a value, let alone print one.

Until 0.14.x a write was `add-generic-password … -w` as the last option with
the value piped in. That reads the value with getpass(3), which opens the
terminal first and reads stdin only when there is none: every test and agent
session passed, and the owner's `metistry update` in Terminal printed
`password data for new item:`, waited on the keyboard with the value unread
in the pipe, and was killed by the exec timeout (exit 1, nothing on stderr).
getpass(3) also keeps only the first 128 characters, so a longer secret — an
OpenAI project key, an AWS session token — was stored truncated. A value
written that way is worth writing again (`metistry secrets replace <name>`,
or `sync --to keychain` for an install variable).

`--env-file <path>` targets a `.env` other than the resolved one, and
`--instance <dir>` says which instance this is. On Linux `secrets` refuses
and points at `chmod 600` on `.env` or your own secret manager.

### One account: the instance's

An item is `metistry:<VAR>` plus an **account**, and the account is what
keeps several instance directories on one Mac apart. Since the owner's
ruling Q3 (plan §2.14, "no bleed between instances") there is one:
**the instance's `instance_id`**, for every variable — `sync`, `mint`,
`list` and `purge` read and write nothing else. With no `instance_id` yet
(no instance directory configured, or one that has not run `sync`/`up`) an
install's own variables stay under the per-user account `metistry`
(override: `METISTRY_KEYCHAIN_ACCOUNT`) until one is minted.

`METISTRY_SIGN_IDENTITY` and `METISTRY_GITHUB_OAUTH_CLIENT_ID` are not
secrets; they stay plain `.env`/config values.

**The shared scope is retired.** Until T4-3 a table (`SECRET_SCOPES`) filed
third-party credentials under the per-user account, shared by every
instance on the Mac: every `METISTRY_*_API_KEY` (a compute provider key
named by `.metistry/compute.yaml`'s `auth.secret`), `METISTRY_DEVIN_API_KEY`,
`METISTRY_AWS_SECRET_ACCESS_KEY`, `METISTRY_AWS_SESSION_TOKEN`. Each of those
is now an **owner-named secret** of every instance that uses it, under its
lowercase name — `METISTRY_DEVIN_API_KEY` → `{{ secret.devin_api_key }}` —
and:

- `sync --to env` fills its `.env` line from that owner-named secret and
  **never reads the per-user account**. With no copy in this instance the
  line is left exactly as it is, and when an original is still under the
  per-user account (asked by presence, never for a value) it says so and
  names `metistry secrets migrate-scope`.
- `sync --to keychain` does not sweep it in from `.env`: its policy (where it
  may be sent, who may use it) is yours to write, so it names
  `metistry secrets set <name>` instead.
- `mint` refuses it — a credential another service issues is never a random
  string.
- `list` shows the secret it became, and whether its original is still in
  the shared scope. The older fallback — an instance-scoped value found only
  under the per-user account copied across by `sync` — is gone with the
  table.

`metistry compute providers add` stores a new provider key as one of this
instance's secrets (T4-18), and `compute.yaml` references it as
`{{ secret.<name> }}`. `sync --to env` **delivers** every secret compute.yaml's
providers reference as `METISTRY_SECRET_<NAME>` — from this instance's item and
no other, and no secret nothing references — which is how a key reaches the
engine without the engine touching the Keychain. For one release the engine
also reads the older `METISTRY_<NAME>` line T4-3 filled from the same secret,
so `migrate-scope`'s rewrite never cuts off a running engine.

It delivers the same way **every secret a sync-read connection lists** (T4-24)
— a connection whose type's provider is product code a sync reads, like
Linear's `linear_api_key` — so the console's sync can use it. Delivering it is
not sending it: the sync never puts the value on a request itself; core's
egress door fills `{{ secret.<name> }}` for a host on the secret's *Sent only
to* list, when the owner granted it to `connection:<name>`, or refuses
(`docs/ops/connections.md`, *A sync reading its connection*). An MCP
connection's secrets are never delivered: the pool fills them in the process
that dials. Run `sync --to env` again after adding such a connection, then
restart the console.

**`sync --to env` mints the generated ones.** A secret that exists in
neither the Keychain nor `.env` is normally reported ("not in the Keychain,
left as they are") — inventing a GitHub PAT would be nonsense. The
exception is `GENERATED_SECRETS` (`packages/cli/src/secrets.ts`): a secret
whose value means nothing outside this install, so minting one can never be
the wrong guess and nobody has to paste it anywhere. `metistry up`'s
generated `METISTRY_DB_PASSWORD` is the precedent; `METISTRY_LOCAL_OWNER_TOKEN`
(the console's) and `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` (the
reconciler's owner bearer) are the current list (`docs/ops/auth.md`).

**It adopts before it mints.** When one of them is missing from the
Keychain but `.env` already has a value, that value is the one the running
console or reconciler was started with, so `sync` copies it **into** the
Keychain and leaves the `.env` line byte-for-byte as it was — nothing a
running service holds changes. It mints only when neither store has one.
(Through 0.12.0 it minted over `.env`'s value, which rotated both tokens behind
the running services: every Mac app write then failed with `reconciler
refused … unauthenticated`, and every console call with `refused the owner
token (401)`. The cure for an install already in that state is `metistry
restart console` and `metistry restart reconciler`; `metistry doctor`'s
console row names the first.)

**A changed token is never silent.** Whenever the run changes the `.env`
value of a token a long-running service holds — a mint, or the Keychain's
value replacing a differing line — `sync` asks whether that service is up
(does its port answer at all) and says so, with the exact command:

```
$ metistry secrets sync --to env
minted METISTRY_LOCAL_OWNER_TOKEN — it was in neither the Keychain nor …/.metistry/state/.env:
  the console's local owner door — an install that predates it gets one here
RESTART NEEDED: the console is running with the previous METISTRY_LOCAL_OWNER_TOKEN and will
  refuse the new value until restarted — run `metistry restart console`
```

A service that is not running is told it reads the new value when it next
starts; one with no URL configured gets the command conditionally ("if the
reconciler is running …"). An adopted token needs nothing.

### Retiring the product checkout's `.env`: `secrets retire-legacy-env`

An instance's environment is `<instance>/.metistry/state/.env`. The product
checkout's own `.env` is still read **after** it, as a fallback, and every
command says so on stderr:

```
…/.env is still being read as a fallback and is deprecated — everything an install
needs is now in …/.metistry/state/.env. `metistry secrets retire-legacy-env` lists
what only it still has; `--yes` moves that and deletes it.
```

Deleting it by hand drops whatever only it had — and nothing said which names
those were. The verb does:

```sh
metistry secrets retire-legacy-env          # preview: names only, nothing written
metistry secrets retire-legacy-env --yes    # copy, then delete
```

- **Only in the old file** — copied into the instance's file, appended under
  one marker comment, quoted the way `.env` is read back. A line the
  instance's file already has is never touched.
- **In both, different values** — listed as shadowed: the instance's value
  already wins, and the old one is read by nothing. Not copied.
- **`METISTRY_INSTANCE_DIR`** — never copied: in the old file it is how a CLI
  started without the shim finds the instance, and the instance's own file
  never needs it.

Names only, in every line it prints — never a value. It needs no Keychain, so
it runs on Linux too. `--yes` deletes the old file only when everything it
alone had was copied, and it **keeps** it (exit 1, saying why) when:

- **a job still sources it.** `up` renders every job against the env file it
  resolved at the time, so an install that ran `up` before its `state/.env`
  existed has plists — or supervisor children — that `. '<product>/.env'` on
  every start. Run `metistry up` first; it renders them against
  `state/.env`. (It looks in `<instance>/.metistry/state/supervisor.json` and
  this product's plists in `~/Library/LaunchAgents`.)
- **it is how this CLI found the instance** — `METISTRY_INSTANCE_DIR` came from
  the old file and nowhere else. Run `metistry` through its shim
  (`<instance>/.metistry/state/cli/metistry`, which exports it) or export it.
- **a value cannot be written as a dotenv line** (a newline, or a single quote
  in a value that needs quoting) — it names it, to move by hand.

`metistry update` prints the same list on a `legacy .env:` line in its
secrets step — and never moves or deletes anything itself.

### `secrets purge --instance <dir>`

Deleting a test instance directory used to orphan its Keychain items.
`purge` deletes them, preview-then-confirm:

```
metistry secrets purge --instance ~/instances/test-two          # preview; deletes nothing
metistry secrets purge --instance ~/instances/test-two --yes    # deletes
```

It only ever touches that instance's own account, and refuses outright
when the directory has no `instance_id` or when its account somehow *is*
the per-user account. Shared-scope originals are listed as kept (`purge-shared` is theirs). The instance's
owner-named secrets (below) are deleted with the rest — their names come
from its `secrets.yaml`. It does not remove the directory itself.

## Owner-named secrets: `{{ secret.name }}`, per instance

The secrets connections, compute providers and manifests reference as
`{{ secret.name }}` (plan §2.14). A different store from the install's own
variables above, and the two never share a Keychain item:

| | the install's variables | owner-named secrets |
| --- | --- | --- |
| name | `METISTRY_<VAR>`, from `.env` / `.env.example` | lowercase snake_case, chosen by you: `github_write` |
| Keychain item | service `metistry:<VAR>` | service `metistry:secret:<name>` |
| account | the instance's id (the per-user account only while it has none) | **the instance's `instance_id`, always** — no user scope, no fallback |
| policy | none | `.metistry/secrets.yaml`: hosts, grants, expiry — never a value |
| verbs | `sync`, `mint`, `list`, `purge` | `set`, `replace`, `remove`, `hosts`, `grant`, `list --named` |

```sh
printf %s "$TOKEN" | metistry secrets set github_write --hosts api.github.com [--expires 2026-12-31]
printf %s "$NEW"   | metistry secrets replace github_write [--expires <date>]
metistry secrets hosts github_write                        # show *Sent only to*
metistry secrets hosts github_write api.github.com uploads.github.com   # replace the list
metistry secrets hosts github_write --clear                # sent nowhere
metistry secrets grant github_write connection:github on   # On · Ask · Off; unlisted = Off
metistry secrets grant github_write agent:devin ask
metistry secrets remove github_write                       # preview: what references it
metistry secrets remove github_write --yes
metistry secrets list --named [--json]
```

Every verb takes `--instance <dir>` (default: the resolved instance).

**Per instance only** (the owner's ruling Q3, 2026-09-26: "no bleed between
instances"). A value is filed under THIS instance's `instance_id` through
core's `InstanceSecrets`, which is bound to that one account and has no
method that takes another — so a second instance on the same Mac, even with
a copy of the first's `secrets.yaml`, finds the first's item absent, and its
`replace` and `remove` reach only its own. The Keychain itself does not
separate the accounts (every item is readable by the same macOS user); this
binding does, and `packages/core/test/secrets.test.ts` and
`packages/cli/test/secrets-named.test.ts` hold it. An instance with no
`instance_id` is refused, not filed somewhere shared.

**The value.** Read from stdin — never an argument, never a flag — stored
with `security add-generic-password -w` on the child's stdin, then read back:
a value the Keychain did not keep whole is removed and refused. Empty values
and values with a newline are refused. It is never printed, never written to
`secrets.yaml`, never in a result (`--json` prints names).

**The policy** goes into `.metistry/secrets.yaml`, a §4.7 protected path,
through the reconciler as you (the same protected write `metistry compute`
uses), edited as a YAML document so your comments survive, and the result
is validated before anything is written:

```yaml
secrets:
  github_write:
    hosts: [ api.github.com ]        # *Sent only to* — host or host:port, no scheme, no wildcard
    grants: { connection:github: on, agent:devin: ask }   # *Who may use it*
    expires: 2026-12-31              # where the service reports one
```

The schema is strict: a file carrying anything else — a `value:` field, a
string where a policy belongs — does not load, anywhere.

- `set` refuses a name the file already has (`replace` swaps the value);
  without `--hosts` the secret is filled in for no server until `hosts`
  names one (a local agent you grant it still gets it as `GITHUB_WRITE`).
- `replace` keeps the policy and clears an expiry recorded for the old
  value, unless `--expires` gives the new one.
- `remove` is preview-then-confirm: it names every file under `.metistry/`
  (state excluded) that references `{{ secret.<name> }}` — what stops
  working — and deletes nothing without `--yes`. The Keychain item goes
  first, then the line, so an interrupted remove leaves a line that reads
  `present: false` and a rerun finishes it.
- `list --named` prints the rows `GET /api/secrets` serves
  (`docs/ops/client-api.md`), from `security find-generic-password` without
  `-w` — presence only. `last_used` is always null here: it is derived state
  the console reads through its named query, and the CLI talks to no
  database.
- `--dry-run` touches neither the Keychain nor the file.

A reference is `{{ secret.name }}` anywhere a value is typed; `env:NAME` is
accepted for one release in a one-reference field (`auth.secret`). Core's
`fillSecretRefs` fills every reference or none — a missing name or a
malformed `{{ secret… }}` is a refusal naming it, never an empty string or
the literal braces sent to a server. Filling happens at egress, against the
host list, and a model never receives a value — core's `guardedFetch`
(docs/ops/deployment-shapes.md, "The secret fill").

**The M7 row and this CLI.** Plan §2.2's M7 names `metistry secrets
set|replace|remove|hosts|grant|migrate-scope|purge-shared`. The first five
are the verbs above; `migrate-scope` and `purge-shared` are the next
section. `sync|mint|list|purge` are not
in M7's list: they manage the install's own variables (`.env`, the bridge tokens, the owner door), and the Mac app's
first run drives `sync` and `mint`.

## Migrating the shared scope: `migrate-scope` and `purge-shared`

Plan §2.14's four steps, for the third-party credentials the retired shared
scope kept under the per-user account (above). `metistry update` runs the
migration on every update; the verb reruns it by hand:

```sh
metistry secrets migrate-scope [--dry-run] [--instance <dir>] [--json]
metistry secrets purge-shared [--yes] [--instance <dir>] [--json]
```

1. **Copy.** Every shared-scope variable this instance knows of — its
   `.env`, `.env.example`, the `auth.secret` names in `.metistry/compute.yaml`,
   `requires.env` in its own manifests under `.metistry/` — whose original is
   under the per-user account is **copied** into this instance's account as
   `metistry:secret:<name>` (`METISTRY_DEVIN_API_KEY` → `devin_api_key`), and
   the name is recorded in `secrets.yaml` through the reconciler as you, with
   no host and no grant until you give them (`secrets hosts`, `secrets
   grant`). **An item the instance already holds wins**: the original is not
   even read. Idempotent — a rerun copies nothing, writes no file and changes
   no item.
2. **Rewrite references.** `auth.secret` and `requires.env` become
   `{{ secret.<name> }}`, through the protected write, edited as YAML
   documents so your comments survive — **but only into a file that still
   validates with the reference in it**, judged by core's own schema for that
   file. `compute.yaml` reads `{{ secret.name }}` since T4-18, so its
   `auth.secret` is rewritten; a manifest's `requires.env` still takes an
   environment name, so that reference is left as it is and reported, and
   the release whose schema reads it there lets the next `metistry update`
   finish it. A reference to a secret the instance does not hold is never
   rewritten. A rewritten `{{ secret.openrouter_api_key }}` still counts its
   original (`METISTRY_OPENROUTER_API_KEY`) as this instance's, so a rerun
   keeps it and `purge-shared` can find it.
3. **Stop reading the per-user account** — `sync`, above.
4. **Leave the originals.** The migration has no code path that deletes a
   Keychain item (a test hands it a Keychain whose `delete` throws). It
   lists what it left.

```
$ metistry secrets migrate-scope --instance ~/instances/second
shared scope: account metistry → this instance's 11111111-2222-4333-8444-555555555555 (~/instances/second)
copied METISTRY_DEVIN_API_KEY → devin_api_key (metistry:secret:devin_api_key, account 11111111-…). The value is not printed.
copied METISTRY_OPENROUTER_API_KEY → openrouter_api_key (metistry:secret:openrouter_api_key, account 11111111-…). The value is not printed.
recording in secrets.yaml: devin_api_key, openrouter_api_key — sent to no host and granted to no one until you say (`metistry secrets hosts <name> <host>`, `metistry secrets grant`)
rewrote .metistry/compute.yaml providers.openrouter.auth.secret: METISTRY_OPENROUTER_API_KEY → {{ secret.openrouter_api_key }}
left in the shared scope — this migration deletes nothing: METISTRY_DEVIN_API_KEY, METISTRY_OPENROUTER_API_KEY. `metistry secrets purge-shared` removes an original once every instance on this Mac has its copy.
shared scope: copied for ~/instances/second.
```

The Keychain may ask once per original the first time — run it from
Terminal and allow it. An original it will not hand over is reported, left,
and makes the verb exit 1; nothing half-recorded is written. It refuses an
instance with no `instance_id`, a host with no login Keychain, and a
per-user account that *is* this instance's (`METISTRY_KEYCHAIN_ACCOUNT`).

**`metistry update` can never be failed by it.** A dry run asks the
Keychain nothing and prints the command; an instance with no id, a host
with no Keychain, a locked Keychain or a refused write is a note naming
`metistry secrets migrate-scope --instance <dir>` — and until you run it the
instance keeps working exactly as before, because its `.env` still carries
the values. (The `update` that installs this release runs the release it is
replacing — the migration runs on the next `update`, or when you run the verb,
which §3.4 asks of you once per instance anyway.)

**Doctor** has one `shared scope` row for an instance with an id, on a Mac,
from presence probes only (never a value, never a prompt), and never
`failed`: *degraded* with the exact `migrate-scope` command while an
original has no copy here; *degraded* with `purge-shared` once everything is
copied and originals remain; ok when none are left.

**`purge-shared`** removes an original from the per-user account only when
**every instance this Mac knows** has its own copy — this instance plus every
`METISTRY_INSTANCE_DIR` a Metistry LaunchAgent in `~/Library/LaunchAgents`
names (a directory that is gone is skipped and said so). An instance with no
`instance_id` holds no copy, so it keeps every original. Preview-then-
confirm: without `--yes` it deletes nothing and names, for each original it
keeps, the instances still without a copy. It refuses when an instance's id
is the per-user account itself, and deletes nothing but per-user originals.

```
$ metistry secrets purge-shared
shared scope: account metistry
instances this Mac knows: ~/instances/first (1111…), ~/instances/second (6666…)
1 original(s) every one of them has copied — removable: METISTRY_DEVIN_API_KEY
kept METISTRY_OPENROUTER_API_KEY: no copy yet in ~/instances/second — `metistry secrets migrate-scope --instance <dir>` there first

preview only. Nothing was deleted — rerun with --yes to delete the 1 original(s) above.
```

## Variables: `{{ variable.name }}`, plain values agents read

M14 (plan §2.2, §2.14): plain shared values in `.metistry/variables.yaml`,
referenced as `{{ variable.name }}` anywhere a value is typed — a connection
file, an agent's instructions.

```sh
metistry variables set team_name Platform [--dry-run]   # add or change one
metistry variables unset team_name [--dry-run]          # remove it, naming what still references it
metistry variables list [--json]                        # name, value, and where each is used
```

Every verb takes `--instance <dir>` (default: the resolved instance).

**Agents read them, so a variable is never a secret.** `set` refuses:

- a value that **looks like a key** — a provider prefix (`sk-`, `ghp_`,
  `lin_api_`, `AKIA…`, …), a JWT, a private key block, an `Authorization`
  value, a URL with a password or a token parameter, a long random-looking
  run — with *This looks like a key. Variables can be read by agents — Store as
  Secret: `metistry secrets set <name>`*;
- a value that **is one of this instance's secrets** — equal to one, or
  containing one of eight characters or more. The CLI reads this instance's
  secrets (the names in `secrets.yaml`, under its own `instance_id`) and
  compares in memory; the refusal names the secret, never the value. With no
  Keychain on the host there is nothing to compare, and only the shape check
  applies;
- a **secret's name** (`api_key`, `github_token`, `db_password`, `ssh_key`):
  redaction would blank its value anyway;
- a value holding `{{` or `}}` — a variable cannot template, so no
  `{{ secret.x }}` can ride in one to a later egress fill;
- a **schedule or a time** (ruling 2, K8) — by name (`standup_time`,
  `timezone`, `working_days`, `*_schedule`, `*_cron`) or by value (`09:15`,
  `09:00-17:30`, `0 8 * * 1-5`, `@daily`, `America/New_York`, `mon, tue`). A
  routine's timing is its own schedule (Scheduled); facts about you are
  `Me/profile.md`.

A value is one line of text, at most 1024 characters. Every refusal names the
variable and the reason, **never the value**, and nothing is written.

The file is a §4.7 protected path: every write goes through the reconciler as
the `user` principal, edited as a YAML document so your comments survive, and
the result is validated before anything is written:

```yaml
variables:
  team_name: Platform
  company: Acme          # your comments stay
```

The same checks run whenever the file is **read**, so a hand-edited file
carrying a key-shaped value does not load anywhere — `list`, `GET
/api/variables` and the resolver all refuse it, naming the variable. `list
--json` prints the rows `GET /api/variables` serves (`docs/ops/client-api.md`):
`{variables: [{name, value, read_by, used_in}]}`, where `used_in` is every file
under `.metistry/` (state excluded) that references the variable — or, for a
connection file, lists it under `variables:` — and `read_by` is who those
files stand for (`agent:<id>`, `connection:<name>`).

Core's `fillVariableRefs` fills every `{{ variable.name }}` or none — a
missing name or a malformed reference is a refusal naming it — in one pass,
leaving `{{ secret.x }}` for the egress fill.

## Connections: `metistry connections`

M13 (plan §2.2, §2.6): servers Metistry reaches for you, one file each in
`.metistry/connections/<name>.yaml` (`docs/ops/connections.md` is the whole
contract). This release dials **MCP servers**, by URL or by command.

```sh
metistry connections add github --type mcp \
    --env 'GITHUB_PERSONAL_ACCESS_TOKEN={{ secret.github_read }}' \
    -- npx -y @modelcontextprotocol/server-github         # dial once, list what it offers, write it
metistry connections add linear --type mcp --url https://mcp.linear.app/mcp \
    --auth bearer --secret linear_key                      # an HTTP server; the key by name
metistry connections list [--json]                        # every connection: status, reach, tools, used by
metistry connections show github [--json]                 # one, in full
metistry connections policy github                        # the tool table, by group
metistry connections policy github search_issues allow --group reads
metistry connections policy github delete_issue never
metistry connections policy github --offer on             # offer it to agents through Metistry
metistry connections set github --env 'LOG_LEVEL=warn' [--unset-env K] [--header K=V] [--unset-header K] [--url …] [-- <command…>]
metistry connections test github [--json]                 # dial it: does it answer, and does it still offer every listed tool?
metistry connections remove github [--dry-run]
```

Every verb takes `--instance <dir>` (default: the resolved instance); the
writing ones take `--dry-run`. `--env` and `--header` repeat. The command and
its arguments go after `--`.

**Names, never values.** A secret is written as `{{ secret.<name> }}` and a
variable as `{{ variable.<name> }}`; the file lists every name it uses under
`secrets:` / `variables:`, which `add` and `set` keep up to date. Refused,
before anything is written and without repeating the value:

- a value that **looks like a key** anywhere (an `--env` value, a header, an
  argument, the description) — *store it as a secret* (`metistry secrets
  set <name>`) and reference it;
- a `{{ secret.x }}` in a **URL** or its query (a URL lands in logs), on a
  **command line** or in a working directory (every process on the Mac can read
  another's argv) — a secret goes in a header or in `env:`;
- `--auth basic` and `--auth oauth` (they arrive with T4-10); this release sends
  none, a bearer (`--auth bearer --secret <name>`) or an API-key header (`--auth
  api_key --auth-header <Header> --secret <name>`);
- a name already taken; a provider (`--provider`) that no connection type
  installed provides.

**`add` dials once** — `initialize` and `tools/list`, through the same pool and
egress door the console uses, calling no tool — and writes nothing if the
server does not answer (`--no-discover` writes it without dialling). A secret
the dial needs must already be granted to `connection:<name>` — `metistry
secrets grant <secret> connection:<name> on` first, or add it with
`--no-discover`, grant, then `test`. The owner's defaults (Q15, 2026-09-26): a tool the connection type declares keeps
its group; one a custom server offers is filed under **Changes things**, because
a server's own *read-only* hint is a hint, not a control — `add` shows it and
`policy <name> <tool> allow --group reads` acts on it. Modes start at **Reads
Allow · Changes things Ask First · Starts an agent Ask First**, and **offer to
agents off**.

**`policy`** is the owner's per-tool policy, in the owner's words: `allow`,
`ask` (Ask First) or `never` (the file keeps `on | ask | off`). A tool that is
not listed is refused before anything is dialled, so listing one is how it
becomes callable; one not listed yet needs `--group reads|changes|starts_agent`
unless its connection type declares it, and a declared tool keeps its type's
group. `--offer on|off` is the switch that lets agents reach it through
Metistry (C115) — an agent also needs the connection granted to it
(`docs/ops/connections.md`, *The lazy pair*).

**`test`** is the connection's `check()`: `ok` (it answered and offers every
listed tool), `degraded` (a listed tool is gone), `absent` (the command is not
on this Mac, a secret has no item, a variable is unset, its connection type is
not installed), `failed` (the credential is refused at the door — not granted
to `connection:<name>`, or its host is not on the secret's *Sent only to* list —
or the server cannot be reached). It lists what the server offers that is not
listed, and what it marks read-only. `metistry doctor` runs the same check for
every connection (never `failed` there: a connection is someone else's
server, so its outage does not fail the install).

**`remove`** deletes the file. What referred to it — a sync in
`scheduled.yaml`, a secret's grant to `connection:<name>` — is named and left
as it is; it turns absent.

A command is started with **only the environment the file names** (plus the
SDK's six: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) — never this
process's — and a granted secret there is given to that command only. It is not
network-confined in this release (`docs/ops/connections.md`).

The file is a §4.7 protected path: every write goes through the reconciler as
the `user` principal, edited as a YAML document so your comments survive, and
judged exactly as the reader will before anything is written. `list --json`
prints the rows `GET /api/connections` serves; `show --json` the body of `GET
/api/connections/:name` (`docs/ops/client-api.md`).

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
/Users/you/src/metistry — shape launchd, 2026-09-19T09:14:02.118Z

bridge
  ✓ apple-fm  ok       920ms
  ✗ eventkit  failed     4ms
      → eventkit rejected the token (HTTP 401) — the METISTRY_BRIDGE_TOKEN_* in
        .env differs from the one the bridge was started with

service
  ✓ reconciler  ok        53ms
  ✓ console     ok         6ms

cli
  ○ cli on PATH  absent     0ms
      → `ln -s /Users/you/instance/.metistry/state/cli/metistry
        ~/.local/bin/metistry` (or add its directory to PATH)

db
  ✓ db          ok        16ms
  ✓ migrations  ok         3ms

launchd
  ✓ launchd:com.foldedspacelabs.metistry.reconciler  ok         4ms

container
  ✓ compose:console  ok         0ms

9 checks: 7 ok, 0 degraded, 1 failed, 1 absent — ✗ FAILED
```

One block per `kind`, the remediation — the reason a red row is read at all
— wrapped directly under its row rather than in a column that runs off the
screen, and the verdict last. Colour, and `[ok]`/`[x]`/`[!]` where the
terminal's locale is not UTF-8, come from `docs/ops/cli-style.md`;
`--json` is untouched by any of it.

One row per thing that can be wrong; every row is a `core` `CheckResult`
(`name`, `status`, `latency_ms`, `probe`, `remediation`, `meta`) plus a
`kind`, and — additively, T4-21 — an optional `action`. Statuses mean what
they mean everywhere else in the product:

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

**`action`** (T4-21, `packages/cli/src/doctor.ts`). The Mac app's Services
pane reads `doctor --json` and wants a button beside a red row, not a
sentence to re-derive one from — so a row that is not `ok`, and for which
doctor can name the fix without guessing, carries a structured `action`
next to its free-text `remediation`:

```json
{ "kind": "run_verb", "command": ["metistry", "up"], "label": "Run metistry up" }
{ "kind": "open_secrets", "label": "Add METISTRY_BRIDGE_TOKEN_EVENTKIT in Secrets" }
{ "kind": "open_system_settings", "label": "Open System Settings" }
```

`run_verb.command` is **argv, never a shell string** — the same contract
`ProcessCommandRunner` already holds every CLI verb to — and it never
carries `--yes`: a mutating verb's own preview-then-confirm still sits
between the button and the write, exactly as it would typed by hand. Doctor
only ever sets `action` from facts it already has (which env var is unset,
which state a supervisor child reports, which verb a migration needs) —
never by parsing its own `remediation` sentence, with the one narrow
exception of `open_system_settings`, which fires when a TCC bridge's own
`check()` names that pane in words (there is no verb that grants a Calendar
permission). Most rows carry no `action` at all — restart/stop/start/logs
per `kind` is the generic control every row already has (`docs/ops/mac-app.md`);
`action` exists only for the fixes that generic menu cannot express.

**Uptime, on every row that is a running process.** `meta.uptime_sec`:
`ps -o etimes=` for a launchd job (keyed off the pid `launchctl print`
already reported — no second process lookup), `docker compose ps`'s own
`Status` text parsed back into seconds for a container, and a supervisor
child's `uptimeMs` (already tracked, `apps/watchdog/src/supervisor.ts`)
divided down to match. Best-effort throughout, like every add-on fact in
this report: an unparseable `Status` or a `ps` that fails reports no
`uptime_sec` rather than failing the row.

**`instance layout`** is its own row, reported as `flat` or `legacy`:
`flat` when the vault root holds the vault and `.metistry/` holds
everything else (the 2026-09-17 layout, `docs/ops/instance-layout.md`),
`legacy` when `Knowledge/` and the protected files still sit side by side
at the instance root — the signal to run `metistry migrate-layout` above.
It is a status check, not a probe: no network, no bridge, just which
directories exist.

**The `app` row** (macOS, launchd shape). The installed Mac app's
`CFBundleShortVersionString` — from `--app-path`'s same lookup:
`METISTRY_APP_PATH`, `/Applications/Metistry.app`, `~/Applications/Metistry.app`
— against `.metistry/metistry.lock`'s version. `ok` when they match or the app
is ahead (Sparkle got there first); **`degraded` when the app is behind**,
with `metistry update` as the fix (and as the row's `run_verb` action) on a
release install, or Sparkle's Check for Updates… on a checkout, whose update
does not move the app. No app at all is `absent`: a Mac that drives the
product from the terminal is not broken. It reads a plist; nothing is
launched or opened.

**What is probed, generically.** Doctor knows no component by name. It
walks every `manifest.yaml` under `collectors/ routines/ packages/ apps/
targets/`, validates it with `core`'s schema, and for anything that
declares an http surface calls `GET /check` with the bearer from the same
`METISTRY_*_URL` / `METISTRY_BRIDGE_TOKEN_*` pairs the console container
and the watchdog use (`host.docker.internal` rewritten to loopback because
doctor runs on the host). The bridge's own `check()` — a *behavioral* probe
(apple-fm classifies a sentence; eventkit reads a calendar; the reconciler
reads `HEAD` and lists `.metistry/`) — is what decides `ok` vs `degraded`,
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

**The `registries` row** (plan §2.7). One row across every registry kind —
collectors, routines, targets, provider templates, connection types — loaded
exactly as the console and the CLI load them: the product's units, and, when
`METISTRY_INSTANCE_DIR` names the instance, its `.metistry/extensions/` (and the
older `.metistry/targets/`). `meta` carries the units per kind, every overlay
(an extension replacing a product unit — "doctor says so") and every skip with
its reason. A skip is `degraded`, never `failed`: the product runs without the
unit, and the remediation names the file and what is wrong with it (most often
a manifest without `schema: 1`). `metistry extensions list` is the same facts
for the extensions directory alone.

**The `vault sync` row** (plan §2.21). The reconciler's `GET /vault/status`
with its bearer: ahead and behind the remote, the last push, any conflict and
the sync policy in force — all in `meta` (with a one-line `summary`), so
`--json` answers "is my vault on GitHub" without a terminal. Never `failed`:
commits are safe locally whatever the remote does, and the reconciler's own
row already fails when it is down. `degraded` for a conflict (a pull could not
integrate — the paths are named), a failed push or pull (git's last line, any
URL credential masked), a `vault:` block that does not validate (the last good
policy keeps running), and `METISTRY_PUSH_SCHEDULE` still overriding `push`;
`absent` with no remote (`metistry connect-repo`) or no reconciler bridge
configured. The policy is `metistry vault settings`, above.

**The `schedules` rows.** Every collector and routine manifest also gets a
`kind: schedule` row read from the `runs` table: when it last ran, whether
that run succeeded, how many failures are open since its last success, when it
is next due, and whether the runner has stopped running it (a failure streak
at `METISTRY_RUNNER_MAX_STREAK`) or never started it (a declared prerequisite
missing). `failed` — and so exit 1 — is reserved for the states you have to
act on: given up on, blocked on configuration, or more than 2× its interval
with no run at all (for a time-of-day schedule, the widest gap of its week).
A component that has simply never run is `absent`, because a fresh install is
not broken — and so is one whose schedule the runner could not place
(`no_working_days`, `no_timezone`), with the runner's reason as its
remediation. `docs/ops/automation.md` has the whole failure model and the
`--json` shape; `docs/ops/scheduled.md` how the runner fires.

Add a component by adding a directory with a manifest; doctor covers it.
A new http bridge named `foo` on port 7820 is probed the moment
`METISTRY_FOO_URL` (and `METISTRY_BRIDGE_TOKEN_FOO`) exist in `.env`.

`.env` is read for variables that are unset — the `ops/scripts` convention
— from `<instance>/.metistry/state/.env` and then the checkout's deprecated one
("Instance directories are self-contained" above), so
`METISTRY_EK_URL=… metistry doctor` overrides a line in the file for one
run (handy for checking a token before writing it down).

## Service control

```sh
metistry restart [<service>…] [--json] [--dry-run]
metistry stop    [<service>…] [--json] [--dry-run]
metistry start   [<service>…] [--json] [--dry-run]
metistry logs <service> [--lines N] [--follow] [--dry-run]
metistry down [--json] [--dry-run]     # every service at once, then confirm
```

**This is what the Mac app's menu bar calls.** Restart/stop/start/show-logs
for one service — the app is a front end for the CLI, never a second
implementation of "how do I restart the reconciler": a behaviour the menu
bar needs is a CLI change first (the same rule `docs/ops/mac-app.md`
states for `doctor --json`).

No args = every service the current shape runs — read from `.metistry/deployment.yaml`
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
  socket, `<instance>/.metistry/state/run/supervisor.sock`. launchd has never heard of
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
`{service, action, ok, detail}`, for the app to render and nothing else — a
step's progress line goes to stderr instead of vanishing; without it the
output is the shared table (`docs/ops/cli-style.md`). A name that isn't a service this shape
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
`.metistry/state/.env` to *running*. It prints which dotenv file that is, renders it
into the plists as `__ENV_FILE__`, and hands it to `docker compose` as
`--env-file` (compose interpolates from its own `./.env` otherwise, which
is no longer the install's environment).

**What it starts is the same in every deployment shape; where depends on
`.metistry/deployment.yaml`** (`docs/ops/deployment-shapes.md`). The default is
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
`<instance>/.metistry/state/ports.yaml`, so a second instance can run beside the
first. Everything afterwards — `up`, `doctor`, `restart|stop|start`,
`logs`, `update` — reads that file; delete it (after `metistry stop`) to
return the instance to the fixed labels and ports.
`docs/ops/deployment-shapes.md` has the layout and the rules.

> **Quote `.metistry/state/.env` values that contain a space.** The reconciler,
> watchdog and TCC bridge jobs load that file with `set -a; . <file>`,
> which *runs* it, so `KEY=/Users/…/Application Support/…` is a command,
> not an assignment. `up` refuses with the offending variables and line
> numbers rather than installing jobs that respawn forever.

0. **Postgres (launchd shape only).** Find the binaries
   (`METISTRY_PG_BIN`, a bundled `runtime/postgres/bin`, Homebrew
   `postgresql@17`), `initdb` into `<instance>/.metistry/state/pg` once, write the
   managed block in `postgresql.conf`. A missing toolchain prints a
   `brew install` line and stops — `up` installs nothing itself.
1. **Containers.** `docker compose up -d --build` in the checkout — or,
   when the instance's `.metistry/metistry.lock` says `source: release`,
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
   become **children** in `<instance>/.metistry/state/supervisor.json` (0600), each
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
   env: /Users/you/instance/.metistry/state/.env
[dry-run] == compose
[dry-run] (cd /srv/metistry && docker compose --env-file /Users/you/instance/.metistry/state/.env up -d --build)
[dry-run] == launchd
[dry-run] write ~/Library/LaunchAgents/com.foldedspacelabs.metistry.watchdog.plist  (from ops/launchd/…, __REPO__=/srv/metistry, __NODE__=/opt/homebrew/bin/node, __ENV_FILE__=/Users/you/instance/.metistry/state/.env)
[dry-run] launchctl bootout gui/501/com.foldedspacelabs.metistry.watchdog   # ok if not loaded
[dry-run] launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.foldedspacelabs.metistry.watchdog.plist
[dry-run] launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.watchdog
…
[dry-run] == doctor
[dry-run] metistry doctor
```

### Where the time goes

`up` ends with a timing per `==` section and a total, because "why was that
slow?" is the first question anyone asks of it and an answer you have to know
to ask for is an answer nobody has:

```
== timings
   compose 0ms · postgres 312ms · launchd 3.9s · database 260ms · doctor 1.1s — total 5.6s
   running under launchd — `metistry down` stops it, `metistry logs <service> --follow` tails
```

Three of those numbers used to be larger for no reason a person benefited
from, and the fixes are worth knowing about because they shape what the
figures mean now:

- **The retire step asks launchd once.** `up` boots out the agents this shape
  no longer installs — under `launchd` that is eight pre-supervisor labels.
  It used to run a `bootout` and an `rm` for each, in series: sixteen
  subprocesses to discover an install that migrated months ago has none of
  them. One `launchctl list` now answers for all eight. A `launchctl list`
  that fails, and every `--dry-run`, still do the whole unconditional sweep:
  "could not ask" must mean "do the work", never "skip it".
- **Postgres is polled four times a second**, not once, with the same 15s
  ceiling. A server that answers in 300ms no longer costs a second.
- **doctor probes concurrently.** Its checks are independent — a bridge's
  HTTP probe knows nothing about `launchctl print`, which knows nothing about
  the database — so the closing table costs the *slowest* probe rather than
  the sum of all of them. No timeout was shortened to buy that: a
  slow-but-healthy bridge (a cold `apple-fm` helper answers its first
  `/check` in about a second) reported as down would be a worse table.

## Running: `up`, `down`, and who owns the processes

**The CLI is never the daemon.** `up` hands the processes to **launchd**
(or, under the compose shape, to **Docker**) and exits — that is the whole
point of a supervisor that survives a closed terminal, a logout and a
reboot. So:

```sh
metistry up      # start everything, run doctor, print, exit 0/1
metistry down    # stop everything, confirm it is stopped, exit 0
metistry doctor  # what is running right now, without changing anything
```

`metistry down` is `up`'s other half:

| shape | what `down` does |
| --- | --- |
| `launchd` | `launchctl bootout` of the supervisor's agent — which takes Postgres, the console, the reconciler, the assistant and the bridges with it — and of the TCC helpers' agents |
| `compose` | `docker compose stop` per container, plus `bootout` of the host agents |

Then it **looks**: `launchctl print` for each label (nothing found = gone) and
`docker compose ps --quiet` (empty = nothing running), and prints what it
found under a heading of its own — the claim and the check are two blocks,
never one. A job still loaded after its bootout is a non-zero exit, not a
cheerful "done".

```
service     action  ok      detail
──────────  ──────  ──────  ──────────
supervisor  stop    ✓ ok    booted out

1 service(s): 1 ok, 0 failed

confirmed by looking
  ✓ gone  com.foldedspacelabs.metistry  not loaded

1/1 confirmed stopped (shape launchd)
```

**`down` stops; it never deletes.** It is `docker compose stop`, *not*
`docker compose down`, and never `-v`. The opposite of "up" is "the processes
are not running", not "the install is gone": Postgres's volume is the derived
half of invariant 1, and a verb reached for daily must not be the one that
drops it. `metistry down` takes no service names — `metistry stop <service>`
is still the per-service verb.

**If the Mac app registered the background item**, `down` boots it out for
the rest of this login session and says so: the app starts it again at the
next login unless it is turned off in *Metistry.app › Settings › Services ›
"Run Metistry in the background"*. The CLI does not reach into another
application's `SMAppService` registration — that would make it a second
registrar for the one job (`docs/ops/deployment-shapes.md`, "Two
registrars").

**Logs live outside the CLI's lifetime too**: `/tmp/metistry-<service>.log`
under launchd (`metistry logs <service> --follow` tails it), `docker compose
logs` under compose.

### Linux hosts

There is no launchd, and this has not been run on a Linux host yet, so
`up` **prints** the equivalent systemd user units — one per plist,
`EnvironmentFile=<instance>/.metistry/state/.env`, `ExecStart=<node> <checkout>/…/dist/main.js`,
`Restart=always` — and writes nothing. Save each to
`~/.config/systemd/user/`, then `systemctl --user daemon-reload &&
systemctl --user enable --now <unit>`. Turning that into an installed
step is a follow-up once a Linux install exists to test it against; the
TCC-bound jobs (eventkit, apple-fm) have no Linux counterpart at all
(§4.17: absent, not broken). `update` on Linux likewise tells you which
units to restart rather than restarting them.

### Getting `metistry` on your PATH

A fresh release install has no `metistry` on `PATH` — there is no Homebrew
formula and no npm global, so nothing put it there. `up` (and `update`,
since a checkout that only ever runs that still needs one) writes a small
POSIX shim to `<instance>/.metistry/state/cli/metistry`: an executable
script that already knows this install's product dir and instance dir, and
at every invocation re-checks which of `current/` (a release) or the bare
product dir holds the CLI, and whether to run it with the bundled
`runtime/node/bin/node` or whatever `node` is on `PATH` — so a release
flip or a freshly bundled runtime needs no re-write. It is idempotent
(unchanged content is left alone) and mode `0755`; a symlink or a foreign
file already sitting at the path is left alone too, with a note, rather
than overwritten.

**`up` never puts it on PATH itself** — invariant 2, that is the operator's
own hand — it only prints the one line that would, as part of its normal
output:

```
   cli: /Users/you/instance/.metistry/state/cli/metistry — `ln -s /Users/you/instance/.metistry/state/cli/metistry ~/.local/bin/metistry` (or add its directory to PATH) runs `metistry` by name
```

Run that `ln -s` once (or add the directory to `PATH` yourself), and
`metistry doctor` — from anywhere — works. `metistry doctor`'s own `cli on
PATH` row says whether it is already reachable, and where, or hands back
the same line when it is not; it is informational (`ok`/`absent`), never a
finding that fails the exit code.

This is the same mechanism in every shape:

- **Release install.** The shim lives at
  `<instance>/.metistry/state/cli/metistry` and execs
  `<product>/runtime/node/bin/node <product>/current/packages/cli/dist/main.js`.
- **Checkout.** Same path, same shim; `current/` does not exist, so it
  falls back to `<product>/packages/cli/dist/main.js`, and to `node` on
  `PATH` when there is no bundled `runtime/`.
- **The Mac app.** `apps/macos`'s `RuntimeLocator` looks for a `metistry`
  in `~/.local/bin` and in the active instance's own
  `.metistry/state/cli` — the same two places above — in addition to the
  usual Homebrew/system bins and `PATH`, so the app finds an install even
  before anyone has run the `ln -s` line by hand (`docs/ops/mac-app.md`).

**Why `state/cli/`, not `state/bin/`.** Under `shape: launchd`,
`<instance>/.metistry/state/bin/Metistry` (capital M) is already the
supervisor's own program-identity symlink (§ above, "Host jobs (macOS)"),
and macOS's default APFS volume does not tell `metistry` and `Metistry`
apart in that directory — they would be the same directory entry. Rather
than have the cli shim quietly lose that race on the one shape that most
needs it (no Docker, so no other way to reach the console short of the
app), it lives in `state/cli/`, a sibling directory the supervisor's
symlink never touches. `writeCliShim` still checks before writing —
leaving a symlink, or a file that does not look like a shim this install
wrote, alone rather than overwritten — as a second line of defence, not
the fix itself.

## Updating

`metistry update [--skip-build] [--skip-migrate] [--dry-run]` moves an
install forward, in this order:

| step | git mode (the product is a checkout) | release mode (`.metistry/metistry.lock`: `source: release`, or `--channel release`) |
| --- | --- | --- |
| product | `git fetch` + `git pull --ff-only` — a diverged checkout stops the update (exit code git's) | resolve the release, download its runtime pack + `checksums.txt`, **verify the sha256**, unpack to `releases/<version>/`, point `current` at it (`docs/ops/releases.md`) |
| app | — (a checkout's app is Sparkle's or a local build's) | **macOS, launchd shape:** `Metistry-<version>.dmg` from the same release, sha256-verified the same way, swapped into `/Applications/Metistry.app` with the old one kept as `Metistry.app.previous` (below) |
| build | `pnpm install --frozen-lockfile` + `pnpm -r build` (`--skip-build` to reuse `dist/`) | no build — the pack is compiled output |
| migrations | `db/migrations/*.sql` not yet in `schema_migrations`, in filename order, one transaction each, under `pg_advisory_lock` (below); `--skip-migrate` leaves them to doctor to report | same, read from `current` |
| restart | `docker compose up -d --build`; `launchctl kickstart -k` for each host job whose code changed | `docker compose pull` + `up -d --no-build` in `current`, with the versioned ghcr images; same kickstart rule |
| lock | write `.metistry/metistry.lock` into the instance repo | same, pinned to the release actually installed |
| templates | copy each `seed/vault/Templates/*.md` the vault **lacks** — create-only, never over a file that is there (below) | same, from `current`'s seed |
| doctor | the verdict, as for `up` — run by the **updated** CLI (below) | same, against `current` |

**A legacy instance is refused past 0.8.x.** Before the product step —
before anything is fetched, built or migrated — `update` reads the instance
layout and stops if it is the pre-2026-09-17 shape (the vault in
`Knowledge/`, the config files at the instance root) and the version it
would pin is later than `0.8.x`, printing the `metistry migrate-layout`
lines to run. `--allow-legacy` pins it anyway. 0.8.x reads both layouts
(`docs/ops/instance-layout.md`, "Until the verb runs"); nothing past it has
been run against the old one, and compatibility nobody tests is not
compatibility.

Release-mode flags: `--version 0.2.0` installs a specific release instead
of the latest; `--rollback` flips `current` back to the previous release
without downloading anything (migrations are additive-first and are **not**
reverted); `--channel git|release` overrides the lock's `product.source`
for one run. `metistry init --channel release` writes `source: release` in
the first place. A checksum mismatch aborts before anything restarts and
leaves `current` and the lock untouched. Full runbook, layout and secrets:
**`docs/ops/releases.md`**.

**The rest of a release update runs on the release it installed.** The
`metistry` shim runs `current`'s CLI — the release an update is about to
*leave* — so every step after the switch used to run the old release's
code, and a fix to any of them landed one update late (0.14.1's fixes took
the owner three runs). Now, once `current` points at the new release, its
pack is verified and its bundled runtime unpacked (and the app step has
run), `update` re-executes the new release's own CLI:

```
node <product-dir>/current/packages/cli/dist/main.js update --continue-from=switched \
  <your flags> --channel=release --product-dir=<product-dir>
```

on the bundled runtime's `node`, with the same environment plus
`METISTRY_UPDATE_REEXEC=1`, streams its output and exits with its code. The
child skips the product step and runs build, migrations, restart, lock,
templates, secrets, the shim and doctor on the new code; its "what changed"
baseline is the release `current` pointed at before (`releases/.previous`).
Guards, each with a test (`update-reexec.test.ts`, `release.test.ts`):

- **Loop:** an update whose environment already has
  `METISTRY_UPDATE_REEXEC` never re-executes again.
- **Capability:** a release whose CLI predates this (no
  `packages/cli/dist/update-reexec.js`) is not handed to — it would ignore
  `--continue-from` and run a second full update. A downgrade onto one
  finishes on the running code, as before.
- **A new CLI that never starts** (a bad pack) is told apart from one that
  started and failed by a handshake file the child writes before its first
  step (`METISTRY_UPDATE_REEXEC_ACK`), not by guessing from the exit code.
  One that never started did nothing, so the running code finishes the
  update and says so loudly; the run ends exit 1 with the previous
  release's own `update --rollback`, by path — the shim runs the broken CLI
  too. One that started and failed is never re-run: its exit code is the
  answer.
- `--rollback` never hands over (the running code is the newer one), a
  git checkout is unchanged, and `--no-reexec` finishes on the running
  code — a debugging switch. `--dry-run` prints the hand-over as a step.

One run is enough from 0.14.2 on. The update *onto* 0.14.2 is still run by
the release before it, which does not hand over.

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
— compose's own cache decides whether anything rebuilds. In release mode
"before" is the release being left — hashed through `current` before the
switch — and "after" the one installed. (Through 0.14.0 the "before" was
taken again after the switch, so both hashes were of the new release and a
release-mode update never kickstarted anything for new code.)

**The owner bearer, and a mint that fails.** The restart step first makes
sure this install holds `METISTRY_BRIDGE_TOKEN_RECONCILER_USER`
(`docs/ops/auth.md`): already in the environment → nothing; in this
instance's Keychain item but not `.env` → copied into `.env`, nothing minted;
in neither → minted into both. Either of the last two restarts the
reconciler (the supervisor, under the launchd shape) so it reads it. When the
Keychain refuses the write, **the restart still runs**: every job whose code
changed is kickstarted on the tokens the install has, because leaving them on
the release just left — against the schema just migrated — is the worse
failure. The lock is a protected path the bridge refuses without the owner
bearer, so it is not attempted; the templates, secrets and shim steps still
run; and the run ends with what was not done and the commands, in order:

```
✗ not done — this update carried on without them; run these, in order:
  METISTRY_BRIDGE_TOKEN_RECONCILER_USER: not minted — security add-generic-password … failed (1): …
  .metistry/metistry.lock: not moved to 0.14.1 — it needs METISTRY_BRIDGE_TOKEN_RECONCILER_USER
    metistry secrets mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER
    metistry restart reconciler
    metistry update

✗ update incomplete — release 0.14.1, 10 migration(s) applied, 1 job(s) kickstarted, not done: …
```

Exit code 1 — decided there, at the end, not by stopping. (`metistry up`
still stops on a failed mint: it has not started anything yet.)

**The summary says how far the restart got.** `nothing kickstarted` means the
step ran and no job's code had changed. A run that stopped before the step
says `nothing restarted — the update stopped before its restart step`; one
that stopped inside it says `restart interrupted — kickstarted …; NOT
kickstarted (code changed): …`, naming each job still on the old code.

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

**Writing the lock.** `.metistry/metistry.lock` lives in the *instance* repo, and
the reconciler is that repo's sole committer (`docs/ops/reconciler.md`,
D5) — so `update` writes it as a bridge call, never as a file:
`POST $METISTRY_RECONCILER_URL/vault/write` with
`intent: { principal: "user", message: "metistry update → <version>" }`.
`.metistry/metistry.lock` is a §4.7 protected path; `user` is the one principal
allowed to write it, and the commit lands on the reconciler's next flush.
A bridge that is configured but not answering, or that refuses, fails
the update (exit 1) with the reason — the lock is then simply not moved;
rerun after fixing. When this run kickstarted the reconciler — or the supervisor it is a
child of — the write first waits for it to answer again (any HTTP answer on
`/check`; up to `METISTRY_RECONCILER_READY_TIMEOUT_MS`, default 60 s), because
`kickstart` returns before the restarted process listens: the lock POST that
followed at once was refused with "did not answer (fetch failed)" in the
0.12.0 → 0.14.x rehearsal. Only when **no** bridge is configured
(`METISTRY_RECONCILER_URL` unset) *and* `METISTRY_INSTANCE_DIR` is a
local directory does `update` write the file directly — and even then it
first checks that no reconciler launchd job is running, because a
running reconciler with no URL in `.env` is a misconfiguration to fix,
not to write around. (A reconciler installed later sweeps that direct
write into a `user` commit like any other out-of-band edit.) No instance
dir at all → nothing is written, and `update` says so.

**Seeding the templates the vault lacks.** After the lock, `update` lists
`seed/vault/Templates/*.md` and, for each one **absent** from the vault's
`Templates/`, writes it the same way it writes the lock: through the
reconciler as `user` when a bridge is configured — create-only
(`expected_sha256: ""`), so a file that appeared between the look and the
write is refused by the reconciler's compare-and-swap and kept — else
directly into a local vault. A file that is there is never read, compared or
rewritten: your templates are yours (invariant 2). Each copy is one log line
naming the file (`templates: seeded Templates/Brief.md — …`); a second run
finds nothing missing and copies nothing. A legacy-layout or absent instance
is a note, not a copy, and a refused write is named with the rerun — this
step never fails the update. A template you deleted on purpose comes back on
the next `update`; a routine you do not want is retired by its manifest's
`schedule`, not by removing its template. **Doctor** reads the other side: a
routine whose last run recorded `skipped:template_missing` is a degraded
schedule row naming the template and this fix.

**The closing doctor is the new code's.** The process running `update` is
the version the update is moving *away* from, so its doctor would validate
the new release's manifests with the old manifest schema — and an update
that changed the schema would end "updated, and doctor is not happy" (exit 1)
while a standalone `metistry doctor` is clean. So the closing doctor runs as
a child of the updated product's own CLI: `node
<run-dir>/packages/cli/dist/main.js doctor --json --product-dir <run-dir>`
(`<run-dir>` is the checkout, or `current` in release mode; `node` is the
bundled runtime's when there is one, as for the `metistry` shim), and its
report is the verdict — exit 0 when it is ok, 1 when not, exactly as
before. When there is no built CLI there, it cannot be spawned, or it
exits without printing a report, `update` falls back to its own in-process
doctor and says so on a `closing doctor:` line — that answer is the
pre-update code's, and a standalone `metistry doctor` afterwards is the
truth. In release mode the whole post-switch half now runs in the new
release's CLI (above), so this child doctor is that CLI starting its own
doctor — kept, because it is also what a git checkout's update relies on.

**Moving the Mac app with the release.** On a Mac whose shape is `launchd`,
release mode moves the app the owner actually looks at, not just the
product under it — right after the runtime pack, from the **same release**:

1. **Find it.** `--app-path <path>`, else `METISTRY_APP_PATH`, else
   `/Applications/Metistry.app`, else `~/Applications/Metistry.app`. A bundle
   there whose `CFBundleIdentifier` is not `com.foldedspacelabs.metistry` is
   left untouched; no bundle at all is a note (`--app-path` to a path that
   does not exist yet installs it there fresh). `--no-app` skips all of it.
2. **Already there?** The installed `CFBundleShortVersionString` equal to the
   release → `app already 0.14.0`, nothing downloaded. Newer than the release
   (Sparkle got there first) → left as it is; `update` never downgrades the app.
3. **Download and verify** `Metistry-<version>.dmg` against the release's
   `checksums.txt` — the same function the runtime pack goes through
   (`downloadVerified`, `release.ts`). A mismatch discards it; nothing is
   mounted.
4. **Mount read-only** — `hdiutil attach -nobrowse -readonly -noautoopen
   -mountpoint <private temp dir>` — and `ditto` the bundle to
   `.Metistry.app.incoming` **beside** the installed one (the same volume, so
   the swap is two renames). The copy is checked, not the image: bundle id,
   `CFBundleShortVersionString` == the release, and, when it is signed,
   `codesign --verify --deep --strict` **and** `spctl --assess --type execute`.
   An unsigned bundle (a local build with no Developer ID) is installed with
   the assessment skipped and a line saying so — but never over a signed one.
5. **Swap.** `Metistry.app` → `Metistry.app.previous` (one kept; the one
   before is removed), the new bundle into place. Detach, always.
6. **A running app** (a process whose executable is *this* bundle's) is told
   to quit and reopen. It is never quit for you unless you pass
   `--relaunch`, which sends it `SIGTERM`, waits for it to go and `open`s
   the new one.

It **never escalates**: when the folder is not writable by you (a standard
account's `/Applications`), the app is left alone and the exact sudo-free
alternative is printed — `metistry update --app-path
~/Applications/Metistry.app`, then drag the old one to the Trash in Finder.
And it **never fails the update**: the product has already moved, so every
refusal above is a note and a line in the summary (`app not updated (…)`),
not an exit code. `--rollback` swaps `Metistry.app.previous` back in the
same way, keeping the newer one as the previous, so a second rollback rolls
forward. Doctor's `app` row (below) says whether the app matches the lock.
Under the compose shape, on Linux and in git mode the app is not touched.

`--dry-run` prints the whole plan — including the migration step as one
line, the kickstarts annotated with the path each one depends on, and the
app's download and swap — and opens no db session, calls no bridge, runs
no doctor, downloads and mounts nothing.

## `.metistry/metistry.lock`

One shape, written by `init` and moved by `update`; YAML, in the instance
repo's `.metistry/`:

```yaml
# .metistry/metistry.lock — the product release this instance runs (plan §4.16).
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

## Moving to the flat layout: `metistry migrate-layout`

The 2026-09-17 ruling moves the vault root itself: the instance directory
becomes the Obsidian vault (so `Knowledge/` disappears and its contents —
`Inbox/`, `now.md`, `Areas/`, `CLAUDE.md` — sit at the instance root) and
everything that is not knowledge moves under `.metistry/`
(`docs/ops/instance-layout.md` has the full tree and the reasoning).

```sh
metistry migrate-layout --dry-run     # the whole plan, nothing run
metistry migrate-layout               # do it
metistry up                           # the verb restarts nothing itself
```

It refuses unless the layout is legacy; on an instance that is already flat
it says so and changes nothing. In order:

1. **preflight.** A git repo, a legacy layout, and a **clean git tree** —
   refused otherwise, because a `git mv` of the whole tree on top of
   uncommitted work is not a reviewable diff. `--allow-dirty` proceeds and
   carries the uncommitted paths through the move. If the supervisor or the
   reconciler job is running, the run **warns** and names it: the reconciler
   is the instance repo's sole committer (D5) and will otherwise sweep the
   migration into commits of its own halfway through, so stop it first
   (`metistry stop`). It is a warning and not a refusal because `launchctl`
   can say a label is running but not which instance directory it serves.
   Preflight also **lists any lowercase entry that will sit at the vault
   root** after the move. The vault root becomes the instance root, so a
   lowercase directory that was merely sitting beside the vault becomes vault
   content the reconciler walks, indexes and embeds — and vault content is
   TitleCase (CLAUDE.md's one casing boundary). Seeing that list before the
   commit is the point. `now.md` is excluded: the product ships it lowercase
   itself, and a warning that always fires is one nobody reads.
2. **`.metistry/`.** `git mv` for what git tracks, a plain move for what it
   does not, of `identity.yaml`, `rules.yaml`, `compute.yaml`,
   `deployment.yaml`, `instances.yaml`, `sources.yaml`,
   `assistant-prompt.md`, `metistry.lock`, and the `agents/`, `routines/`,
   `queries/`, `extensions/`, `instance-migrations/`, `targets/` and `eval/`
   directories — each only if it is there. Then the gitignored `state/`,
   which is a plain move because git never tracked it. (`eval/` is the
   bake-off's fixtures and transcripts, `docs/poc/poc18-bakeoff`: instance-repo
   content, not knowledge, so left at the root of a flat instance the
   reconciler would index a harvested transcript as a note.)
3. **`Inbox/`.** A pre-#156 root `inbox/` is normalised to `Inbox/` (through
   a temporary name: `git mv inbox Inbox` on a case-insensitive filesystem
   moves the directory inside itself) and merged with the vault's own inbox
   if both exist. A file present on both sides is a refusal, not a clobber.
4. **The vault.** Every entry of `Knowledge/` becomes a root entry —
   `Knowledge/CLAUDE.md` becomes the root `CLAUDE.md`, a `Knowledge/.obsidian/`
   comes up with it — and the emptied `Knowledge/` is removed. A name
   collision with something already at the root (a root `Journal/` and a
   `Knowledge/Journal/`) is **refused before anything moves**, naming both
   sides: the plan is built off the filesystem first, so a refused run leaves
   the instance exactly as it was.
5. **Manifests.** A crew's `scope:` and a target's `data_policy.allow:` are
   vault path prefixes that live in FILES, not in the database, and the
   console re-syncs the registry from `.metistry/agents/**` on an interval
   (`METISTRY_CREWS_SYNC_S`) — so a grant rewritten in step 7 and left stale
   in the manifest behind it is a migration that silently fails at the next
   sync. `Knowledge/<Area>` loses the prefix in every `*.md` crew manifest and
   every `manifest.yaml` under `.metistry/`. The edit is a **splice**, not a
   re-serialisation: `parseDocument` locates the entries, and only those
   scalars' own byte ranges are replaced, so aligned comments, flow-vs-block
   style, key order and the operating prompt below the frontmatter come back
   byte-identical. A **bare** `Knowledge` is left alone with a warning naming
   the file: it meant "the whole vault", the old schema admitted it
   (`^Knowledge(\/[A-Za-z0-9_.-]+)*$` — note the `*`), and the flat one has no
   spelling for it, because `knowledgePrefix` refuses a leading slash and a
   crew `scope` refuses the bare vault outright. Writing `/` there would
   produce a manifest that fails validation and revokes the crew's registry
   row; naming the areas you actually mean is the fix.
6. **`.gitignore`.** Rewritten to the flat layout's set (`.metistry/state/`,
   `.obsidian/workspace*`, `Inbox/.large/`); every line the instance added is
   kept.
7. **The database, in one transaction.** `Knowledge/` drops out of
   `knowledge_files.path`, `knowledge_links.from_path`/`to_path`,
   `embeddings.path`, `inbox.path` and `projects.area`; a bare capture
   filename (pre-2026-09-16) becomes `Inbox/<file>`; and in `agents.grants`
   the whole-vault sentinel `Knowledge/` becomes `/` (`VAULT_ROOT_AREA` —
   with the vault AT the root there is no name to say) while every
   `Knowledge/<area>` grant loses the prefix. One transaction, so the stored
   paths can never be half-migrated. **With no database configured** the
   rewrites are named and skipped, and the files still move: re-run with the
   install's environment to finish them. Three other path-shaped columns are
   deliberately left alone — `artifact_versions.path_prefix` and
   `artifact_comments.path` (`Artifacts/` was already at the instance root,
   and a comment's path is relative to its version) and `runs.meta`, which is
   the audit trail and is not edited to suit the present.
8. **`.metistry/state/.env`.** `METISTRY_*` values that spelled the old
   paths — `METISTRY_RULES_FILES`, `METISTRY_COMPUTE_FILES`,
   `METISTRY_INBOX_DIR`, `METISTRY_ASSISTANT_AREAS` — are rewritten in place;
   `METISTRY_INSTANCE_DIR` is what everything else is relative to and does
   not move. A bare relative directory (`METISTRY_TARGETS_DIRS=targets`) is
   **left alone with a warning** naming the flat spelling: the product
   checkout has directories by those names too, so rewriting it would be a
   guess. The launchd plists under `state/` are regenerated by `metistry up`,
   so the verb says so rather than editing generated files it does not own.
9. **One commit**, "Migrate to the flat instance layout (metistry
   migrate-layout)", by the same author `init` and `migrate-inbox` use.

`--dry-run` prints every move and every row count and touches nothing —
including the `git mv` / plain-move distinction, which it resolves by asking
git rather than guessing. `--json` prints the result (moves, per-table row
counts, `.env` changes, warnings) on stdout with the step log on stderr.
`--instance <dir>` picks the instance; without it, `METISTRY_INSTANCE_DIR`.

An instance that predates the 2026-09-16 inbox-in-vault ruling needs nothing
extra: `migrate-layout` carries a bare root `inbox/` up to `Inbox/` itself.
Running `metistry migrate-inbox` first is still fine and is the smaller,
more reviewable step if you want the two moves in two commits.

`metistry doctor` reports which layout an instance is on (`instance
layout: flat | legacy`), so a `legacy` reading is the signal to run this
verb — and the Mac app shows the same sentence in Status and in the wizard
when you point it at a legacy folder.

Obsidian: re-open the vault at the instance directory itself. `.metistry/`
is dot-prefixed, so Obsidian ignores it the way it already ignores `.git`.

## Maintenance

The cadence is plan §5 "Maintenance cadence"; the CLI is how the
operator-facing parts of it happen:

- **On every product change:** `metistry update` (or `update --dry-run`
  first). Pull, build, migrate, restart what changed, pin, doctor — one
  command, idempotent, safe to rerun.
- **After changing `.metistry/deployment.yaml`:** `metistry up`, having stopped
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
  `.metistry/metistry.lock`'s `migrations_applied` says which schema the dump was
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
parses `.metistry/identity.yaml`/`package.json`/the `secrets list` table itself
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
