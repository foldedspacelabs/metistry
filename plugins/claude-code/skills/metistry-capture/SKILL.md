---
name: metistry-capture
description: Push a decision, finding, or note from this session to the user's Metistry instance inbox (POST /capture). Use at natural moments — a design decision just got made, a non-obvious gotcha was found, a fact worth remembering surfaced — or when the user says "capture this", "note this for Metistry", "remember this decision".
argument-hint: [decision|finding|note] [title]
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/capture.mjs" *)
---

# Capture to Metistry

Metistry is the user's assistant/knowledge system. Nothing you send is
written into its knowledge: every capture lands as an **inbox proposal**
with provenance (source `claude-code`, this session's id, host, cwd, repo)
and is triaged by the user later. Keep captures rare and worth triaging.

## When

- A **decision** was made and the reasoning would otherwise live only in
  this chat (which option, why, what was rejected).
- A **finding** — a gotcha, a root cause, a number, a constraint — that
  someone will want next month.
- A **note** the user explicitly asks to capture.

Not for: progress updates (issue/PR state already flows in), code, or
anything the user has not seen in this conversation.

## How

Write a short title and a body of 2–10 lines in the user's voice, then run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/capture.mjs" --kind decision --title "<title>" --body "<body>"
```

`--kind` is one of `decision`, `finding`, `note`. Use `--body-file <path>`
or pipe stdin for longer bodies. Print the script's one-line result to the
user (`captured → inbox #<id>`).

If `$ARGUMENTS` is present it is `<kind> <title>`; draft the body from the
conversation and confirm the title before sending.

## Config (environment only)

`METISTRY_URL` (instance origin, e.g. `https://mac-studio.example.ts.net`)
and `METISTRY_OWNER_TOKEN` (an owner token minted on the instance — see
`docs/ops/capture-shortcut.md`). If either is missing the script exits 1
with a clear message; tell the user, do not retry. Never print, echo, or
paste the token; the script redacts it from its own output.
