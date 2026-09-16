# metistry — OpenCode session capture

An OpenCode plugin that writes one note per finished session into a Metistry
instance's inbox. Dependency-free Node 22+ / Bun; no build step, nothing to
publish, and the install is a symlink into OpenCode's plugin directory.

It is the OpenCode part of "dev sessions land in the inbox whichever tool is
used" — `plugins/claude-code` and `plugins/cursor` are the others, and
`metistry import-sessions` back-fills. All of them emit the same
`kind: "session"` frontmatter and compute the same `idempotency_key`, so the
console dedupes across them.

## Install

```sh
node plugins/opencode/install.mjs        # links into ~/.config/opencode/plugins/
export METISTRY_URL=http://127.0.0.1:8080
export METISTRY_AGENT_TOKEN_OPENCODE=…   # `metistry connect opencode` puts this in the Keychain
export METISTRY_CAPTURE_ON_STOP=1        # the plugin is inert without this
opencode                                 # start it from that shell
```

`install.mjs` is idempotent, touches exactly one name in a directory full of
other people's plugins, repoints a link left behind by a checkout that has
moved, refuses to overwrite a file it did not create, and `--remove` takes it
back out. `--json` prints `{ file, state, target, … }`, the seam
`metistry connect opencode` can call; see `docs/ops/opencode.md`.

What it links, and why the file is `.js` when everything else here is `.mjs`:
OpenCode loads `.js` and `.ts` from `~/.config/opencode/plugins/` (global) and
`.opencode/plugins/` (project) and does **not** load `.mjs` — checked both ways
against OpenCode 1.18.30 on 2026-09-16. A symlink is fine: Bun resolves it to
the real path before importing, so the plugin's own `./scripts/lib.mjs` import
resolves inside the checkout and `git pull` is the whole update.

## Configuration

| variable | required | what |
| --- | --- | --- |
| `METISTRY_URL` | yes | the instance's origin; `POST {url}/capture` is the only call |
| `METISTRY_AGENT_TOKEN_OPENCODE` | yes | OpenCode's own agent bearer (`metistry connect opencode`). `METISTRY_OWNER_TOKEN` is accepted as a fallback |
| `METISTRY_CAPTURE_ON_STOP` | yes | `1` enables the plugin. Anything else and it does nothing at all |
| `METISTRY_OPENCODE_IDLE_MS` | no | the quiet window that stands in for the session-end event OpenCode does not have; default `90000` |
| `METISTRY_CAPTURE_DIR` | no | where a note goes when the console cannot be reached (SHOULD-10: one silent drop ends the trust). A leading `~/` is expanded. Point it at your instance's `Knowledge/Inbox` and the reconciler picks the file up on its next scan (docs/ops/inbox.md) |

Nothing is read from a file. If the instance is namespaced
(`METISTRY_AGENT_TOKEN_OPENCODE_<SUFFIX>`), export that value *into*
`METISTRY_AGENT_TOKEN_OPENCODE` for the plugin.

## When it fires

OpenCode has no session-end event. `session.idle` — the one the docs point at
for "a session finished" — fires every time the assistant stops talking, so
capturing on each would put a note in the inbox per turn. Instead an idle arms
a timer, a further idle re-arms it, and the capture happens once the session
has actually gone quiet for `METISTRY_OPENCODE_IDLE_MS`. A session deleted
while a capture is pending cancels it. The timer is unref'd: a capture is never
the reason OpenCode is still open.

**A one-shot `opencode run "…"` is not captured, and the reason is measured
rather than assumed.** On OpenCode 1.18.30 the process exits 17 ms after
`session.idle` on the success path and ~100 ms on the error path; `beforeExit`
never fires, and an event hook's promise is not awaited (a plugin that slept
4 s in the hook was cut off mid-sleep). Nothing asynchronous can finish there.
So this plugin captures the sessions whose process outlives them — the TUI, the
desktop app, `opencode serve` / `opencode attach` — and says so rather than
letting you wonder where the note went.

## What the note contains

OpenCode hands a plugin its SDK client, so unlike the Cursor half there is a
real transcript to measure: `client.session.messages()` gives every message and
part. No model is called — a transcript is foreign content, so it is measured,
never interpreted.

```
---
kind: "session"
source: "opencode"
title: "OpenCode session — demo — 2026-09-16"
session_id: "ses_f553f618…"
project: "/Users/example/Development/demo"
repo: "demo"
branch: null
started: "2026-09-16T15:05:51.325Z"
ended: "2026-09-16T15:05:57.107Z"
turns: 1
host: "studio"
captured_at: "2026-09-16T15:06:00.140Z"
idempotency_key: "opencode:ses_f553f618…:a2e04941474825b8"
---
```

…and in the body: turns (user and assistant), duration, project, models, cost,
tokens, the OpenCode version, the agent, tools with counts, files touched, the
first prompt and the last response. Files come from the `filePath` the built-in
`read`/`edit`/`write` tools take and from what an `apply_patch` reports;
`glob`'s and `grep`'s `path` is a *directory* argument and is deliberately not
read. `branch` is null — OpenCode sends none and a branch is never guessed.

If the transcript cannot be read back (a client that errors, a message list
that is not one), the note carries a `## Not captured` section saying exactly
that, `turns` stays `null` rather than being reported as zero, and the key
becomes a pure function of the session id so a retry is an exact no-op.

## Failure is silent, by contract

Nothing is ever thrown at OpenCode, every path resolves, and nothing goes to
stdout — the TUI owns it; the plugin reports through `client.app.log`, which is
what OpenCode's docs ask for. The request is capped at 8 s; a slow path means
the summary goes to `METISTRY_CAPTURE_DIR` if one is set and is dropped with one
log line if not. The token never appears in output — every message passes
through a redactor.

## Tests

```sh
pnpm --filter @metistry-apps/plugin-opencode test
```

`test/fixtures/opencode-session.json` is a **real** session, recorded from a
running OpenCode 1.18.30 (`GET /session/{id}/message` and `GET /session/{id}`)
with the paths rewritten — so the shapes the tests assert are the ones OpenCode
actually sends.

`test/session-parity.test.ts` renders a real summary through this plugin and
through `packages/core/src/session-summary.ts` and fails the build if a byte
differs — the plugin ships as plain JS a stranger runs out of a checkout, so it
cannot import a built workspace package, and the note-rendering logic therefore
lives twice. Edit `scripts/lib.mjs` and `packages/core/src/session-summary.ts`
together. The other two plugins are held to the same anchor, which locks all
three to each other without any of them importing another.

## Dependencies

None, on purpose. `@opencode-ai/plugin` (OpenCode's own types package) would be
a dev-only dependency and is deliberately **not** added: the hook shapes this
plugin relies on are hand-typed from the docs in a JSDoc block at the top of
`plugin.js`, which is enough to read and to check. Adding it is a decision for
the owner, not for a PR (CLAUDE.md, "Ask before adding a dependency").
