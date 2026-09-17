# metistry — Cursor session capture

A Cursor `sessionEnd` hook that writes one note per finished session into a
Metistry instance's inbox. Dependency-free Node 22+; no build step, nothing to
publish, nothing to install but one entry in `~/.cursor/hooks.json`.

It is the Cursor half of "dev sessions land in the inbox whichever tool is
used" — the Claude Code plugin (`plugins/claude-code`) is the other half, and
`metistry import-sessions` back-fills. All three emit the same `kind: "session"`
frontmatter and compute the same `idempotency_key`, so the console dedupes
across them.

## Install

```sh
node plugins/cursor/install.mjs          # merges into ~/.cursor/hooks.json
export METISTRY_URL=http://127.0.0.1:8080
export METISTRY_AGENT_TOKEN_CURSOR=…     # `metistry connect cursor` puts this in the Keychain
export METISTRY_CAPTURE_ON_STOP=1        # the hook is inert without this
cursor .                                 # a GUI app inherits no shell; launch it from one
```

`install.mjs` is idempotent, preserves every other hook in the file, replaces
an entry left behind by a checkout that has moved, and `--remove` takes it back
out. `--json` prints `{ file, state, command, … }` — that is the seam
`metistry connect cursor` calls; see `docs/ops/cursor.md`.

The hook writes Cursor's native shape (`cursor.com/docs/hooks`):

```json
{
  "version": 1,
  "hooks": { "sessionEnd": [{ "command": "<checkout>/plugins/cursor/hooks/session-end.mjs", "timeout": 10 }] }
}
```

## Configuration

| variable | required | what |
| --- | --- | --- |
| `METISTRY_URL` | yes | the instance's origin; `POST {url}/capture` is the only call |
| `METISTRY_AGENT_TOKEN_CURSOR` | yes | Cursor's own agent bearer (`metistry connect cursor`). `METISTRY_OWNER_TOKEN` is accepted as a fallback |
| `METISTRY_CAPTURE_ON_STOP` | yes | `1` enables the hook. Anything else and it does nothing at all |
| `METISTRY_CAPTURE_DIR` | no | where a note goes when the console cannot be reached (SHOULD-10: one silent drop ends the trust). A leading `~/` is expanded. Point it at your instance's `Inbox/` — the instance directory IS the vault (docs/ops/instance-layout.md) — and the reconciler picks the file up on its next scan (docs/ops/inbox.md) |

Nothing is read from a file. If the instance is namespaced
(`METISTRY_AGENT_TOKEN_CURSOR_<SUFFIX>`), export that value *into*
`METISTRY_AGENT_TOKEN_CURSOR` for the hook.

## What the note contains — and what it cannot

Cursor's `sessionEnd` input is `session_id`, `reason`, `duration_ms`,
`is_background_agent`, `final_status` and `error_message`, plus the fields every
hook receives: `conversation_id`, `model`, `model_id`, `cursor_version`,
`workspace_roots`, `user_email` and `transcript_path`. The note records the
first group and the useful part of the second — id, workspace, repo, duration,
model, Cursor version, how the session ended:

```
---
kind: "session"
source: "cursor"
title: "Cursor session — demo — 2026-09-15"
session_id: "3f2b9c10-…"
project: "/Users/example/Development/demo"
repo: "demo"
branch: null
started: null
ended: null
turns: null
host: "studio"
captured_at: "2026-09-15T12:00:00.000Z"
idempotency_key: "cursor:3f2b9c10-…:0123456789abcdef"
---
```

**There is no content summary, and that is deliberate.** The payload carries no
prompts, no turn counts and no tool calls, and the *format* of the file at
`transcript_path` is undocumented — `cursor.com/docs/hooks` says only "Path to
the main conversation transcript file (null if transcripts disabled)". A format
is never guessed here, so the file is not read and the note says so in a
`## Not captured` section rather than leaving you to wonder. Compare the Claude
Code plugin, whose transcript layout *is* confirmed (JSONL, documented in
`packages/core/src/session-summary.ts`): it reports turns, tools with counts,
files touched, the first prompt and the last response.

`started`/`ended` are null because Cursor sends a duration and no timestamps,
and putting the wall clock in `ended` would change the `idempotency_key` on
every invocation. The wall clock is `captured_at`; the duration is a fact in the
body. The upshot is a key that is a pure function of the session id — so a
retry after the local-file fallback is an exact no-op server-side.

If Cursor documents the transcript format, this is where it lands: a
`summarizeTranscript` beside `summarizeSessionEnd`, the same `## Not captured`
section disappearing on its own.

## Failure is silent, by contract

The hook exits 0 on every path and prints at most one redacted line to stderr.
`sessionEnd` is fire-and-forget in Cursor ("The response is logged but not
used") and this hook prints no JSON, so there is nothing it can block. The
request is capped at 8 s; a slow path means the summary goes to
`METISTRY_CAPTURE_DIR` if one is set and is dropped with one stderr line if not.
The token never appears in output — every message passes through a redactor.

## If you already run the Claude Code plugin

Cursor can load `~/.claude/settings.json` hooks and maps `SessionEnd` →
`sessionEnd` (Settings → Rules, Skills, Subagents → "Include third-party
Plugins, Skills, and other configs"; it must also be enabled for your account).
So that hook may already fire inside Cursor — and it captures nothing, because
it tries to parse a Claude Code transcript and finds something else. That is a
silent no-op, not a failure. This plugin is the reason you do not need it to
work.

## Tests

```sh
pnpm --filter @metistry-apps/plugin-cursor test
```

`test/session-parity.test.ts` renders a real summary through this plugin and
through `packages/core/src/session-summary.ts` and fails the build if a byte
differs — the plugin ships as `.mjs` a stranger runs out of a checkout, so it
cannot import a built workspace package, and the logic therefore lives twice.
Edit `scripts/lib.mjs` and `packages/core/src/session-summary.ts` together. The
Claude Code plugin is held to the same anchor, which locks the two plugins to
each other without either importing the other.
