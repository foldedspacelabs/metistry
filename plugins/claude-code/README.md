# `metistry` — Claude Code plugin

The zero-effort external-capture door (plan §4.11). From any Claude Code
session, push a decision, finding, or note into a Metistry instance's
inbox. Optionally, post a short summary when a session ends.

Nothing here writes knowledge. Every capture is an **inbox proposal** with
provenance (`source: claude-code`, session id, host, cwd, repo); the user
triages it like any other capture. Foreign content proposes; it never
writes.

## Install

From this repo's marketplace:

```
/plugin marketplace add foldedspacelabs/metistry
/plugin install metistry@metistry
```

Or straight from a checkout, for development:

```
claude --plugin-dir /path/to/metistry/plugins/claude-code
```

Requires Node 22+ on `PATH` (the scripts use global `fetch`; no
dependencies).

## Configure — environment only

Nothing is read from files; there is nowhere to accidentally commit a
token.

| Variable | Meaning |
| --- | --- |
| `METISTRY_URL` | The instance origin, e.g. `https://mac-studio.example.ts.net` |
| `METISTRY_OWNER_TOKEN` | A bearer for `/capture`: an **agent token** (recommended) or a host-minted owner token (below). The variable name predates the agent registry; either class works. This is deliberately a *different* secret from the console's local owner token (`METISTRY_LOCAL_OWNER_TOKEN`, `docs/ops/auth.md`): that one reaches the full management surface (devices, agents, projects), so handing it to a capture client would be a privilege escalation — keep the two variables, and the two secrets, apart. |
| `METISTRY_CAPTURE_ON_STOP` | `1` enables the session-end summary hook. Default off. |

**Recommended: an agent token from the registry.** Register the session
as an agent on the instance (owner session, `POST /api/agents`) and use
the token it returns once. Captures then carry the agent's id as
`source_agent` and land as `external`-trust proposals — the user can see
*which* agent said what, revoke or rotate that one credential without
touching anything else, and grant it project membership or a knowledge
read tier later. The same token also mounts the instance's `mcp-brain`
surface in Claude Code. `metistry connect claude-code` registers it (and
mints the token); by hand it is `claude mcp add --scope user --transport http
metistry https://<origin>/mcp --header 'Authorization: Bearer
${METISTRY_AGENT_TOKEN_CLAUDE_CODE}'` — single-quoted, so Claude Code expands
the variable when it starts and the token is never written to a file. It
adds `report`, the shared task list, and scoped knowledge search to the
session — see `packages/mcp-brain/README.md`.

The older alternative is an owner token minted on the instance host (also
capture-only — it cannot manage devices or triage — but captures made
with it are attributed to the owner, not to an agent):

```
docker compose exec -e METISTRY_ORIGIN=https://<origin> console node scripts/enroll.mjs --owner-token "claude-code laptop"
```

Put the two variables in the shell profile Claude Code inherits (or in
`env` under `~/.claude/settings.json`). The token is redacted from
everything the plugin prints.

## Use

The `metistry-capture` skill loads on its own when a decision or finding
surfaces, or on request:

```
/metistry:metistry-capture decision Use SessionEnd, not Stop, for the summary hook
```

It runs `skills/metistry-capture/scripts/capture.mjs`, which POSTs
`{ note, filename }` as JSON to `${METISTRY_URL}/capture` with
`Authorization: Bearer …` and prints `captured → inbox #<id>`.

The note is markdown with a frontmatter block carrying provenance:

```
---
source: "claude-code"
kind: "decision"
title: "…"
session_id: "…"
host: "…"
repo: "…"
cwd: "…"
captured_at: "2026-09-06T…Z"
---
```

### Session-start briefing

`hooks/hooks.json` also registers a `SessionStart` hook (`startup` and `clear`)
that runs `scripts/session-start.mjs`: it asks the instance's
`GET /api/briefing?repo=…&remote=…` once, with the agent bearer
(`METISTRY_AGENT_TOKEN_CLAUDE_CODE`, else `METISTRY_OWNER_TOKEN`), and injects
the answer as session context — the project page, open tasks and recent
sessions for the checkout, as handles plus your own text, under the agent's
read grant. **On by default; opt out per agent** with
`metistry connect claude-code --briefing off` (stored on the console with the
agent's grants, so an opted-out agent is simply served nothing).
`METISTRY_BRIEFING=off` silences it for one profile. It runs once per session,
**exits 0 on every path**, and injects nothing when the instance is
unreachable, refuses, or has nothing to say. `docs/ops/claude-code-plugin.md`
§5 has the details.

### Session-end hook

`hooks/hooks.json` registers a `SessionEnd` hook that runs
`scripts/session-end.mjs`. It does nothing unless
`METISTRY_CAPTURE_ON_STOP=1`; when enabled it posts one `kind: session`
capture built deterministically from the session transcript — turn counts,
duration, tools with call counts, files touched, first prompt and last
response (both clipped), models. No model is called and the transcript
itself is never posted. The frontmatter, `idempotency_key` included, is the
same shape `metistry import-sessions` sends, so the two doors dedupe
against each other (`docs/ops/cli.md`). It **exits 0 on every path**
and writes at most one line to stderr — a capture door must never fail
the session it captures from. Claude Code gives `SessionEnd` hooks a
short budget; the hook's own network timeout is 8 s.

## Instance split — where captures land

Each Metistry instance is its own private repo with its own URL and its
own tokens (plan §4.16). The plugin has no notion of "which vault"; it
posts to whatever `METISTRY_URL` says. So a Claude Code configuration
pointed at the second instance's URL and token can only land context in the
second instance's vault, and one pointed at the first instance can only land
it in the first. The boundary is the environment the session inherits, not a
setting inside the plugin — keep the two profiles' variables apart (separate
shells, separate `settings.json` env blocks) and the separation is mechanical.

## Test

```
METISTRY_TEST_DB_NAME=metistry_test_plugin pnpm --filter @metistry-apps/plugin-claude-code test
```

The tests spawn the real scripts against a local `node:http` stand-in for
the console and assert the request shape, the bearer header, provenance
in the note, token redaction, and the hook's failure-is-silent behavior.
No database is needed for this package; the variable only keeps the
repo-wide `pnpm test` off the shared scratch db.
