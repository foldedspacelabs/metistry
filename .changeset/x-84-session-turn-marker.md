---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/macos": minor
---

`POST /message` carries a session-turn marker (X-84, ruled 2026-10-04; screen 11 §4 *staying on this Mac*). The body takes an optional `capture_session` — the recorder's id of the recording a turn is asked inside — and the capture bar's Ask sets it on every turn sent while a recording runs. A marked turn is **held to the private tier**: the row carries `meta.capture_session`, the drain resolves it through core's `turnTier`, and `private` runs on an `on_machine` provider or the turn is refused with the command that fixes it — never answered on another tier, never shadowed. The marker is checked at the door: a value that is not a recorder id is `400`; a session whose recording the console has seen end (its transcript delivered) is `409` with `reason: "stale"`; an agent bearer is refused the route whole, field or no field, and no refusal writes a row. The route record of a marked turn names `private` and never consults the policy, `GET /api/messages` reads such a turn's `tier` as `private`, and every unmarked turn is routed exactly as before. The Mac's `ChatStore.send` takes `captureSession:`, a retried turn resends the marker it was written with, and the bar's Ask panel says *Staying on this Mac* only while a marker is being sent.
