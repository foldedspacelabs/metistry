---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/macos": minor
---

`metistry console session --stdio`: `console call` held open as one long-lived child. The local owner token is resolved once and never printed (every output line is redacted against it); a non-loopback console or a missing token is refused before a line is read. Each JSON request line gets exactly one terminal line matched by id; `stream: true` on `GET /api/events` writes `{id, event}` frames until `{id, cancel: true}`. The Mac app's `SessionConsoleCallTransport` runs every console request through it (~1.5 ms each instead of ~141 ms for a process per request), fails in-flight calls when the child dies and restarts it on the next call, and falls back to `console call` on a CLI that predates the verb. `ConsoleErrorEnvelope.details` now keeps a 409's `reason` and the row as it stands.
