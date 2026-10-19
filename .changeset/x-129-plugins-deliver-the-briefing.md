---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/plugin-claude-code": minor
"@metistry-apps/plugin-opencode": minor
---

X-129: the plugins deliver the session-start briefing, on by default. The
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
