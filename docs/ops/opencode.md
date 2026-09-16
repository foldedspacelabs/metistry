# OpenCode as a Metistry surface

OpenCode mounts an instance's `/mcp` from a config file, so the read half needs
no product code beyond one verb: `metistry connect opencode` registers OpenCode
as an **external agent**, puts its bearer in the login Keychain, and merges one
entry into `~/.config/opencode/opencode.json`. After that OpenCode searches and
reads the vault under its grants, captures into the inbox, and takes unassigned
tasks — governed server-side, exactly like every other agent. The write half —
one note per finished session — is `plugins/opencode`, further down.

Everything on this page was checked against `opencode.ai/docs` and a running
OpenCode **1.18.30** on 2026-09-16; where the two disagreed, the running copy
won and the difference is noted.

## Connect

```sh
metistry connect opencode --instance ~/metistry-instance
```

What that does, in order:

1. `GET /api/agents`, then `POST /api/agents {"id":"opencode","display_name":"OpenCode","kind":"external"}`
   if there is no row yet — so a re-run is a no-op, not a second identity.
   The console returns the bearer **once**, at mint or rotate.
2. Stores it in the login Keychain as `metistry:METISTRY_AGENT_TOKEN_OPENCODE`
   under this instance's `instance_id` account (instance-scoped:
   `packages/cli/src/secrets.ts` `SECRET_SCOPES`). It is not printed and not
   written to any file.
3. Merges into `~/.config/opencode/opencode.json` (0600, created if absent,
   **every other server and setting preserved**):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "metistry": {
      "type": "remote",
      "url": "http://127.0.0.1:8080/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:METISTRY_AGENT_TOKEN_OPENCODE}" }
    }
  }
}
```

OpenCode substitutes `{env:NAME}` when it reads a config file
(`opencode.ai/docs/config`, "Variables"), and it does so inside `mcp.*.headers`
— verified by pointing the entry at a server that logged what arrived: the
header came through as `Bearer <the value of the variable>`. That is why the
bearer never reaches disk.

### Which file, and why global

`~/.config/opencode/opencode.json` — or `$XDG_CONFIG_HOME/opencode/…` when that
variable is set, which is where OpenCode itself looks (`opencode debug paths`).
If an `opencode.jsonc` is already there, that is the file this verb merges into
instead: OpenCode loads `opencode.json` and then `opencode.jsonc`, so the
`.jsonc` has the last word, and splitting one `mcp` block across two files is
how a config becomes a mystery.

**Global, not per-project, on purpose.** OpenCode's own docs describe a project
`opencode.json` as "safe to be checked into Git" — and an entry naming this
instance's origin, in a repo somebody else clones, is a footgun. If you do want
one project pinned to the instance, copy the `mcp` block above into that
project's `opencode.json` by hand; project config wins over global, so the entry
is identical apart from where it lives.

A file this verb cannot parse is an error, never a clobber — including a
`.jsonc` that really does carry comments. The message prints the exact entry to
paste in by hand.

### Getting the variable into OpenCode

```sh
export METISTRY_AGENT_TOKEN_OPENCODE="$(security find-generic-password -a <instance_id> -s metistry:METISTRY_AGENT_TOKEN_OPENCODE -w)"
opencode          # started from that shell, so it inherits the variable
```

`metistry connect opencode` prints that line with your account filled in. The
same rule as Cursor's applies and for the same reason: `launchctl setenv` is
deliberately not the documented path — it would make the value visible to every
GUI app at once and pass it through `ps` on the way
(`packages/cli/src/keychain.ts`). Writing the bearer straight into
`opencode.json` is the other option this verb does not take; the `{env:…}` shape
exists precisely so it does not have to.

If OpenCode was already running, restart it: config is read at startup.

## What OpenCode can do

Everything an external principal gets at `/mcp`
(`packages/mcp-brain/manifest.yaml`) — the same table as `docs/ops/cursor.md`:
`knowledge_search`, `knowledge_read`, `knowledge_grep` and `knowledge_list`
under the grant tier; `capture` and `requests_create` for every registered
agent; `tasks_*` and `artifacts_*` by project membership; `queries_*` under the
separate `queries` grant. Drafts are excluded at every tier by a `WHERE` clause
no tool can skip.

**What it cannot do, whatever this verb writes:** `knowledge_write` and
`agents_delegate` are refused for an `external` principal at the bridge, not by
configuration. OpenCode proposes; the owner triages.

Tools cost context: OpenCode's own docs warn that every MCP server adds to it.
One Metistry server is a dozen-odd tools, which is the reason the bridge's tool
surface is measured in the product record rather than left to grow.

## Grants start default-deny, and how to widen them

A new row is `{tier: "none", areas: []}` — the column default in
`db/migrations/0007_agents.sql`. OpenCode can capture and raise requests
immediately and can read **nothing** until you say so:

```sh
metistry connect opencode --areas Knowledge/Areas/Engineering
```

`--areas a,b` sets `{tier: "areas", areas: [a, b]}`; the prefixes are TitleCase
`Knowledge/…` and the console validates them. `--project <slug>` adds project
membership, which is what scopes `tasks_*` and `artifacts_*`. Re-running with no
flags leaves grants exactly as you set them.

## Rotate, revoke, check

```sh
metistry connect opencode --rotate     # new bearer; the old one dies immediately
metistry connect --list                # each tool's row, bearer and config
opencode mcp list                      # OpenCode's own view: the server and whether it connected
```

Revocation (`POST /api/agents/opencode/revoke`) is permanent by design: the row
stays so old proposals keep their provenance, and the id cannot be re-minted.

**If `opencode mcp list` says `failed`:** the usual cause is the variable never
reaching the process, so the header goes out as `Bearer ` and the console
answers 401. Worth knowing before you debug the wrong end — on a 401 OpenCode
starts an OAuth discovery dance (`/.well-known/oauth-protected-resource`,
`POST /register`, …) against the origin. That noise in the console's log is a
symptom, not the problem; the console does not speak OAuth and does not need
to. Fix the token.

## A second instance on the same Mac

An instance namespaced with `metistry up --namespace` has its own console port
and its own 8-hex label suffix (`state/ports.yaml`). `connect` follows it: the
entry becomes `mcp.metistry-<suffix>` and the variable
`METISTRY_AGENT_TOKEN_OPENCODE_<SUFFIX>`, so two instances cannot overwrite each
other's entry or share one variable.

## Session capture

`plugins/opencode` is the OpenCode half of "a dev session lands in the inbox
whichever tool it happened in". One note per finished session, the same
`kind: "session"` frontmatter and the same `idempotency_key` the Claude Code and
Cursor plugins and `metistry import-sessions` compute — so the console dedupes
across all four doors and `inbox-drain` classifies them identically.

```sh
node plugins/opencode/install.mjs        # links into ~/.config/opencode/plugins/
export METISTRY_CAPTURE_ON_STOP=1        # the plugin is inert without this
```

Both lines go next to the `METISTRY_AGENT_TOKEN_OPENCODE` export above; the
plugin reads that same variable (an owner token is accepted as a fallback), so
capture needs no second secret. Restart OpenCode afterwards.

What gets linked is `~/.config/opencode/plugins/metistry.js` → the checkout's
`plugins/opencode/plugin.js`. Two verified details behind that sentence: the
loader takes `.js` and `.ts` and **not** `.mjs` (checked both ways), and a
symlink is fine because Bun resolves it to the real path before importing, so
the plugin's own relative import resolves inside the checkout — `git pull` is
then the whole update. `install.mjs` is idempotent, repoints a link left by a
checkout that has moved, refuses to overwrite a file it did not create, and
`--remove` takes it back out.

### When it fires — and the one case it cannot reach

OpenCode has **no session-end event**. `session.idle` is the one its docs point
at for "a session finished", and it fires every time the assistant stops
talking — so capturing on each would put a note in the inbox per turn. Instead
an idle arms a timer, another idle re-arms it, and the capture happens once the
session has been quiet for `METISTRY_OPENCODE_IDLE_MS` (default 90 s). Deleting
a session cancels a pending capture. The timer is unref'd, so it can never be
the reason OpenCode is still running.

**A one-shot `opencode run "…"` is not captured.** Measured, not assumed, on
1.18.30: the process exits 17 ms after `session.idle` on the success path and
about 100 ms on the error path, `beforeExit` never fires, and a plugin's event
hook is not awaited — one that slept 4 s inside the hook was cut off mid-sleep.
Nothing asynchronous can finish there, so no design of this plugin reaches it.
What *is* captured is every session whose process outlives it: the TUI, the
desktop app, and `opencode serve` / `opencode attach`. If headless runs ever
need to land, the honest shape is a sweep of OpenCode's own session storage
behind `metistry import-sessions`, not a faster plugin — and that is a decision,
not a patch.

### What the note records

Unlike the Cursor half, there is a real transcript to measure: OpenCode hands
the plugin its SDK client and `client.session.messages()` returns every message
with its parts. So the note carries turns (user and assistant), duration,
project and repo, models, cost, tokens, the OpenCode version, the agent, tools
with counts, files touched, the first prompt and the last response — the same
body the Claude Code plugin produces from a JSONL transcript. No model is
called: a transcript is foreign content, measured and never interpreted.

Two absences worth naming. `branch` is `null` — OpenCode sends none, and a
branch is never guessed. And files come only from the `filePath` that the
built-in `read`/`edit`/`write` tools take (confirmed against the running
server's own tool schemas) plus whatever an `apply_patch` reports; `glob` and
`grep` take a `path` that is a *directory*, which would turn "files touched"
into something else.

If the transcript cannot be read back at all, the note says so in a
`## Not captured` section — the same shape `plugins/cursor` uses — `turns` stays
`null` rather than being reported as zero, and the key becomes a pure function
of the session id so a retry is an exact no-op.

### The offline fallback

```sh
export METISTRY_CAPTURE_DIR="$HOME/metistry-instance/Knowledge/Inbox"
```

With that set, a session whose capture cannot reach the console is written there
instead of dropped (SHOULD-10: one silent drop ends the trust) — the same folder
`docs/ops/capture-shortcut.md` uses, and the same caveat applies: `inbox-drain`
does not sweep it yet, so those notes wait until it does.

## The types package

`@opencode-ai/plugin` gives a `Plugin` type for hook signatures. It is
**deliberately not a dependency of this repo**: the shapes are hand-typed in a
JSDoc block at the top of `plugins/opencode/plugin.js`, which is enough to read
and to check, and adding a package is the owner's call (CLAUDE.md). If it is
ever added it is dev-only, and nothing shipped changes.
