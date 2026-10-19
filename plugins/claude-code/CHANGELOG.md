# @metistry-apps/plugin-claude-code

## 0.17.2

No changes in this release.

## 0.17.1

No changes in this release.

## 0.17.0

### Minor Changes

- 97c741a: X-129: the plugins deliver the session-start briefing, on by default. The
  Claude Code plugin gains a `SessionStart` hook (`startup` and `clear`) that
  asks `GET /api/briefing` once per session with the agent bearer and injects the
  text as context; the OpenCode plugin does the same through
  `experimental.chat.system.transform`, asking once per session and adding the
  same text to every turn. Any failure injects nothing and never blocks the
  session; an opted-out agent is answered the empty briefing by the console, so
  nothing is injected; the bearer is only ever in the header. `metistry connect
  <tool> --briefing on|off` sets and clears the per-agent opt-out (kept in the
  agent's grants), `connect` and `connect --list` say what delivers it per
  harness (a `briefing` field on each registry entry; Cursor and Devin do not
  deliver it yet), and a grants write now carries the whole envelope, so
  `--areas` no longer drops an opt-out, `queries` or `connections`.

## 0.16.1

No changes in this release.

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

## 0.7.1

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.1

## 0.3.0

## 0.2.0

## 0.1.0
