# Cursor as a Metistry surface

Cursor mounts an instance's `/mcp` from a config file, so it needs no
product code beyond one verb: `metistry connect cursor` registers Cursor as
an **external agent**, puts its bearer in the login Keychain, and merges one
entry into `~/.cursor/mcp.json`. After that Cursor searches and reads the
vault under its grants, captures into the inbox, and takes unassigned tasks
— governed server-side, exactly like every other agent.

## Connect

```sh
metistry connect cursor --instance ~/metistry-instance
```

What that does, in order:

1. `GET /api/agents`, then `POST /api/agents {"id":"cursor","display_name":"Cursor","kind":"external"}`
   if there is no row yet — so a re-run is a no-op, not a second identity.
   The console returns the bearer **once**, at mint or rotate.
2. Stores it in the login Keychain as `metistry:METISTRY_AGENT_TOKEN_CURSOR`
   under this instance's `instance_id` account (instance-scoped:
   `packages/cli/src/secrets.ts` `SECRET_SCOPES`). It is not printed and not
   written to any file.
3. Merges into `~/.cursor/mcp.json` (0600, created if absent, **every other
   server preserved**):

```json
{
  "mcpServers": {
    "metistry": {
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer ${env:METISTRY_AGENT_TOKEN_CURSOR}" }
    }
  }
}
```

Cursor resolves `${env:NAME}` inside `url` and `headers`
(`docs/research/2026-09-15-devin-cursor-integration.md` §2a), which is why
the bearer never reaches disk.

### Getting the variable into Cursor

A GUI app inherits no shell, so the export has to be somewhere Cursor's
process can see. The supported path is one line in your shell profile plus
launching Cursor from that shell:

```sh
export METISTRY_AGENT_TOKEN_CURSOR="$(security find-generic-password -a <instance_id> -s metistry:METISTRY_AGENT_TOKEN_CURSOR -w)"
cursor .          # the CLI shim passes its environment to the app it launches
```

`metistry connect cursor` prints that line with your account filled in.

**`launchctl setenv` is deliberately not the documented path.** It would
make the variable visible to every GUI app at once, and its value would
arrive as a command-line argument — visible in `ps` to anything running as
you, which is the one rule `packages/cli/src/keychain.ts` exists to keep
(values travel on stdin, never in argv). Writing the bearer straight into
`mcp.json` is the other option this verb does not take: the file would then
be a second secret to rotate, and the `${env:…}` shape exists precisely so
it does not have to be.

If Cursor was already running, quit it and start it again from the shell —
the config is read at startup and the environment is inherited at launch.

## What Cursor can do

Everything an external principal gets at `/mcp`
(`packages/mcp-brain/manifest.yaml`):

| tool | gate |
| --- | --- |
| `knowledge_search` | grant tier: `index` sees titles, `areas` sees the granted prefixes; `none` is told "not granted" |
| `knowledge_read`, `knowledge_grep` | tier `areas` only, inside the granted prefixes |
| `knowledge_list` | tier `index` browses, tier `areas` is restricted to its prefixes |
| `capture` | every registered agent — lands as an inbox proposal with `source_agent: cursor` |
| `requests_create` | every registered agent — raises a finding into Needs You |
| `tasks_*`, `artifacts_*` | its project membership (`--project`) |
| `queries_list`, `queries_run` | the separate `queries` grant (invariant 3's read path) |

Drafts are excluded at every tier, by a `WHERE` clause no tool can skip.

**What it cannot do, whatever this verb writes:** `knowledge_write` and
`agents_delegate` are refused for an `external` principal at the bridge, not
by configuration — there is no flag here that grants them, because tool
availability follows the principal **kind**
(`packages/mcp-brain/src/knowledge-write.ts`,
`packages/mcp-brain/src/crew-tools.ts`). Cursor proposes; the owner triages.
That is the same rule the Claude Code plugin lives under.

## Grants start default-deny, and how to widen them

A new row is `{tier: "none", areas: []}` — the column default in
`db/migrations/0007_agents.sql`. Cursor can capture and raise requests
immediately and can read **nothing** until you say so:

```sh
# contents, but only under the prefixes you name
metistry connect cursor --areas Areas/Engineering

# or titles across the whole vault and no contents at all, through the
# console's own route (the local owner token, from this machine)
curl -X PUT http://127.0.0.1:8080/api/agents/cursor/grants \
  -H "Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN" \
  -d '{"tier":"index","areas":[]}'
```

`--areas a,b` sets `{tier: "areas", areas: [a, b]}`; the prefixes are
TitleCase vault-root prefixes and the console validates them (a lowercase
first segment is refused — CLAUDE.md's casing boundary). `--project <slug>`
adds project membership, which is what scopes `tasks_*` and `artifacts_*`.
Neither flag can widen past a read tier: writes never exceed reads.

Running `metistry connect cursor` again with no flags **leaves grants
exactly as you set them** — it is not a verb that quietly narrows a tool you
had widened.

## Rotate, revoke, check

```sh
metistry connect cursor --rotate      # new bearer; the old one dies immediately
metistry connect --list               # each tool's row, bearer and config
curl -X POST http://127.0.0.1:8080/api/agents/cursor/revoke \
  -H "Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN"
```

Revocation is permanent by design: the row stays so old proposals keep their
provenance, and the id cannot be re-minted — `metistry connect cursor`
refuses rather than pretending to reconnect it.

Without `--rotate`, an already-registered tool is told its token is
unchanged. The console returns a bearer only when it mints or rotates one,
so a lost token is a `--rotate` away and nothing else.

In Cursor, the MCP pane is the check that it worked: the server appears with
its tool list. If it appears with none, the variable did not reach the
process (see above). A 401 at the door is the console refusing the bearer —
`metistry connect --list` says whether the row is still registered.

## A second instance on the same Mac

An instance namespaced with `metistry up --namespace` has its own console
port and its own 8-hex label suffix (`.metistry/state/ports.yaml`). `connect` follows
it: the entry becomes `mcpServers.metistry-<suffix>` and the variable
`METISTRY_AGENT_TOKEN_CURSOR_<SUFFIX>`, so two instances cannot overwrite
each other's entry or share one variable. An un-namespaced install keeps the
plain `metistry` / `METISTRY_AGENT_TOKEN_CURSOR` pair.

Instance separation is the same mechanism as everywhere else: a Cursor
window pointed at one instance can only reach that instance's vault
(plan §4.16).

## Session capture

`plugins/cursor` is the Cursor half of "a dev session lands in the inbox
whichever tool it happened in". One `sessionEnd` hook, one note per finished
session, the same `kind: "session"` frontmatter and the same
`idempotency_key` the Claude Code plugin and `metistry import-sessions`
compute — so the console dedupes across all three doors and `inbox-drain`
classifies them identically.

```sh
node plugins/cursor/install.mjs          # merges into ~/.cursor/hooks.json
export METISTRY_CAPTURE_ON_STOP=1        # the hook is inert without this
```

Both lines go next to the `METISTRY_AGENT_TOKEN_CURSOR` export above; the
hook reads that same variable (an owner token is accepted as a fallback), so
capture needs no second secret. Restart Cursor from that shell afterwards —
the config is read at startup. `install.mjs` is idempotent, preserves every
other hook in the file, replaces an entry left by a checkout that has moved,
and `--remove` takes it back out. What it writes is Cursor's native shape,
verified against `cursor.com/docs/hooks`:

```json
{
  "version": 1,
  "hooks": { "sessionEnd": [{ "command": "<checkout>/plugins/cursor/hooks/session-end.mjs", "timeout": 10 }] }
}
```

**The seam for this verb.** `metistry connect cursor` does not install the
hook today. When it does, it is one call and no new logic — the plugin owns
its own installation:

```
node <plugin dir>/install.mjs --json   → { file, state, command, entry, event, enabled_by }
```

### What the note records, and what is missing

The payload gives the session id, the workspace root (there is no `cwd` at
session end), `duration_ms`, `reason`, `final_status`, `is_background_agent`,
`error_message`, the model and the Cursor version. All of that is in the
note.

**There is no content summary — no turn counts, prompts, tools or files
touched.** `sessionEnd` carries none of it, and the *format* of the file at
`transcript_path` is undocumented: `cursor.com/docs/hooks` says only "Path to
the main conversation transcript file (null if transcripts disabled)". A
format is never guessed here, so the file is not read at all, and each note
carries a short `## Not captured` section saying so rather than leaving you to
wonder why a Cursor session reads thinner than a Claude Code one (whose
transcript layout *is* confirmed — JSONL, documented in
`packages/core/src/session-summary.ts`). If Cursor documents the format, that
section disappears on its own and nothing else about the note changes.

One consequence worth knowing: `started` and `ended` are `null`, because
Cursor sends a duration and no timestamps and the wall clock cannot go in
`ended` without changing the `idempotency_key` on every invocation. The wall
clock is `captured_at`; the duration is a fact in the body. The key is
therefore a pure function of the session id, which is what makes a retry
after the offline fallback below an exact no-op.

### The offline fallback

```sh
export METISTRY_CAPTURE_DIR="$HOME/metistry-instance/Inbox"   # or any folder; the vault inbox is picked up by the reconciler (docs/ops/inbox.md)
```

With that set, a session whose capture cannot reach the console is written
there instead of dropped (SHOULD-10: one silent drop ends the trust) — the
same folder `docs/ops/capture-shortcut.md` uses, and the same caveat applies:
`inbox-drain` does not sweep it yet, so those notes wait until it does. The
hook exits 0 either way; it can never fail or block the session it is
capturing from.

### If you already run the Claude Code plugin

With "Include third-party Plugins, Skills, and other configs" enabled, Cursor
reads `~/.claude/settings.json` and maps `SessionEnd` → `sessionEnd`
(`docs/reference/third-party-hooks`; it must also be enabled for your
account). So that hook may already fire inside Cursor — and it captures
nothing, because it tries to parse a Claude Code transcript and finds
something else. That is a silent no-op, not a failure, and it is written down
here so nobody debugs it twice. `plugins/cursor` is the reason you do not
need it to work.
