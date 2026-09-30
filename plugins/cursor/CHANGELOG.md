# @metistry-apps/plugin-cursor

## 0.16.0

No changes in this release.

## 0.15.1

No changes in this release.

## 0.15.0

No changes in this release.

## 0.14.4

No changes in this release.

## 0.14.3

No changes in this release.

## 0.14.2

No changes in this release.

## 0.14.1

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.1

## 0.9.0

## 0.8.1

## 0.8.0

### Minor Changes

- 9cd7717: **`plugins/cursor` — Cursor sessions capture themselves into the inbox.** A
  `sessionEnd` hook, dependency-free `.mjs`, inert unless
  `METISTRY_CAPTURE_ON_STOP=1`, that POSTs one `kind: "session"` note per
  finished session to `/capture`. Same frontmatter and the same
  `idempotency_key` formula as the Claude Code plugin and
  `metistry import-sessions`, so the console dedupes across all three doors and
  `inbox-drain` needed no change. It reads the bearer
  `metistry connect cursor` already puts in the Keychain
  (`METISTRY_AGENT_TOKEN_CURSOR`), exits 0 on every path, and with
  `METISTRY_CAPTURE_DIR` set writes the note to disk rather than dropping it
  when the console is unreachable (SHOULD-10).
  
  `install.mjs` merges the hook into `~/.cursor/hooks.json` in Cursor's native
  shape (`version: 1`, `hooks.sessionEnd: [{ command, timeout }]`), preserving
  every other hook, idempotent, `--remove` to undo, `--json` as the seam
  `metistry connect cursor` will call.
  
  Said plainly rather than guessed at: the note carries **no content summary**.
  Cursor's `sessionEnd` payload has no prompts or turn counts, and the format of
  the file at `transcript_path` is undocumented — so it is not read, and each
  note carries a `## Not captured` section explaining the gap. What it does
  record is the session id, workspace, repo, duration, model, Cursor version and
  how the session ended. `started`/`ended` stay null (Cursor sends a duration
  and no timestamps), which makes the key a pure function of the session id and
  a retry an exact no-op.
