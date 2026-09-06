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
| `METISTRY_OWNER_TOKEN` | An owner token minted on the instance (below) |
| `METISTRY_CAPTURE_ON_STOP` | `1` enables the session-end summary hook. Default off. |

Mint a token on the instance host (it is capture-only — it cannot manage
devices or triage, so a leaked token leaks capture ability, not control):

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

### Session-end hook

`hooks/hooks.json` registers a `SessionEnd` hook that runs
`scripts/session-end.mjs`. It does nothing unless
`METISTRY_CAPTURE_ON_STOP=1`; when enabled it posts one
`session-summary` capture (turn count, first prompt, last response,
clipped) built from the session transcript. It **exits 0 on every path**
and writes at most one line to stderr — a capture door must never fail
the session it captures from. Claude Code gives `SessionEnd` hooks a
short budget; the hook's own network timeout is 8 s.

## Instance split — where captures land

Each Metistry instance is its own private repo with its own URL and its
own tokens (plan §4.16). The plugin has no notion of "which vault"; it
posts to whatever `METISTRY_URL` says. So a **work** Claude Code
configuration pointed at the work instance's URL and token can only land
work context in the work vault, and the personal configuration can only
land personal context in the personal vault. The boundary is the
environment the session inherits, not a setting inside the plugin —
keep the two profiles' variables apart (separate shells, separate
`settings.json` env blocks) and the IP boundary is mechanical.

## Test

```
METISTRY_TEST_DB_NAME=metistry_test_plugin pnpm --filter @metistry-apps/plugin-claude-code test
```

The tests spawn the real scripts against a local `node:http` stand-in for
the console and assert the request shape, the bearer header, provenance
in the note, token redaction, and the hook's failure-is-silent behavior.
No database is needed for this package; the variable only keeps the
repo-wide `pnpm test` off the shared scratch db.
