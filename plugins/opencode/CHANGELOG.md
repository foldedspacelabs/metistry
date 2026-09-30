# @metistry-apps/plugin-opencode

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

- ca9f424: **OpenCode joins the instance: `metistry connect opencode` for reading,
  `plugins/opencode` for writing.** The verb registers OpenCode as an external
  agent, files its bearer in the login Keychain, and merges one entry into
  `~/.config/opencode/opencode.json` — `mcp.metistry`, `type: "remote"`, 0600,
  every other server and setting preserved. The bearer is **not** in the file:
  OpenCode substitutes `{env:METISTRY_AGENT_TOKEN_OPENCODE}` inside the header,
  verified against a running OpenCode 1.18.30 by pointing the entry at a server
  that logged what arrived. Global config rather than project, because OpenCode's
  own docs call a project `opencode.json` "safe to be checked into Git"; an
  existing `opencode.jsonc` is the file written instead, since OpenCode loads it
  last. `--list` gains the row.
  
  `plugins/opencode` is the capture half: a `session.idle` hook, inert unless
  `METISTRY_CAPTURE_ON_STOP=1`, that POSTs one `kind: "session"` note per finished
  session with the same frontmatter and the same `idempotency_key` formula as the
  Claude Code and Cursor plugins, so the console dedupes across all four doors and
  `inbox-drain` needed no change. Because OpenCode hands a plugin its SDK client,
  the note is a full summary — turns, duration, models, cost, tokens, tools with
  counts, files touched, first prompt, last response — not the thin one Cursor's
  payload allows. `install.mjs` links it into `~/.config/opencode/plugins/`
  idempotently and `--remove` takes it back out.
  
  Two things said plainly rather than guessed at. OpenCode has no session-end
  event — `session.idle` fires after every assistant turn — so an idle arms a
  quiet window (`METISTRY_OPENCODE_IDLE_MS`, default 90 s) and a further idle
  re-arms it; one note per finished session, not one per turn. And a one-shot
  `opencode run "…"` is **not** captured: measured on 1.18.30, the process exits
  17 ms after `session.idle` (100 ms on the error path), `beforeExit` never fires,
  and an event hook's promise is not awaited — a plugin that slept 4 s in the hook
  was cut off mid-sleep. TUI, desktop app and `opencode serve` sessions are
  captured; the docs say so instead of leaving anyone to debug it.
  
  `@opencode-ai/plugin` was **not** added: the hook shapes are hand-typed from the
  docs in a JSDoc block, and the types package stays a decision for later.
