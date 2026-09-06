# Claude Code plugin — capture from any session

`plugins/claude-code/` is the `metistry` Claude Code plugin (plan §4.11,
"External agents"): a skill that pushes decisions/findings/notes to
`POST /capture`, and an opt-in `SessionEnd` hook that posts a session
summary. Full usage is in `plugins/claude-code/README.md`; this page is
the operator's checklist.

## 1. Mint a capture token per machine/profile

On the Studio, one owner token per place the plugin runs — label them so
revocation is surgical:

```bash
docker compose exec -e METISTRY_ORIGIN=https://<origin> console node scripts/enroll.mjs --owner-token "claude-code mbp personal"
```

Owner tokens are capture + messages only (CRIT-7); they cannot reach
management endpoints. Revoke:

```sql
UPDATE owner_tokens SET revoked_at = now() WHERE label = 'claude-code mbp personal';
```

## 2. Configure the session's environment

```bash
export METISTRY_URL=https://<origin>
export METISTRY_OWNER_TOKEN=<token>
# optional, default off:
export METISTRY_CAPTURE_ON_STOP=1
```

Or per Claude Code profile in `~/.claude/settings.json` under `env`.
Nothing is read from files in the repo; the plugin ships no config.

**Instance split.** A work Claude Code profile gets the *work* instance's
URL and a token minted *there*; the personal profile gets the personal
pair. The plugin cannot route to more than one instance, so work context
can only land in the work vault (§4.11, §4.16).

## 3. Install

```
/plugin marketplace add foldedspacelabs/metistry
/plugin install metistry@metistry
```

or `claude --plugin-dir <checkout>/plugins/claude-code` while developing.
Validate a checkout with `claude plugin validate plugins/claude-code`.

## 4. What lands where

Every capture is a `POST /capture` JSON body `{ note, filename }`:
file in the inbox dir, row in `inbox` (`source = 'http'`), a `runs` row
(`component: console, kind: capture`). Provenance is in the note's
frontmatter (`source: "claude-code"`, `session_id`, `host`, `repo`,
`cwd`, `captured_at`, `kind`), so triage and the morning brief can weight
by origin. Filenames are `claude-code-<kind>-<UTC stamp>.md`.

## 5. Failure modes

- Missing env / unreachable instance: the **skill** exits 1 with a
  redacted one-line reason (Claude reports it; nothing retried). The
  **hook** exits 0 with one stderr line — it never blocks or fails the
  session.
- The token never appears in output; both scripts pass every message
  through a redactor before printing.
- `SessionEnd` hooks share a short time budget in Claude Code; the hook
  caps its own request at 8 s. A slow tailnet path means the summary is
  simply dropped, with the stderr line as the only trace.
