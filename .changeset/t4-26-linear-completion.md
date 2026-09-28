---
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
---

**Linear: completion both ways (T4-26).** `POST /api/trackers/:connection/issues/:key/complete` (owner reach) closes an issue in Linear: `completeIssue` reads it and, only if it is still open, sends one fixed mutation moving it to its team's first `completed` state — through the connection's egress door, the key filled for `api.linear.app` only; an issue already completed or canceled is answered as it stands (`changed: false`). `linearQuery` still refuses every mutation, so no caller can send another change. The owner's setting is the connection's `complete_issue` tool mode, which the `linear` connection type now declares (capability `complete`): Ask First (the default) — the client offers *Close <KEY> in Linear* after a tick; Allow — the client makes the call itself; Never — the door refuses `403 tool_off` and sends nothing. The door closes the issue's `work` row and resolves its `task` request at source, and writes no vault file. The other way, `GET /api/today` gains `tracker_closed`: the day's open lines whose `linear:` issue the tracker closed, for *Done in Linear* with a one-click Tick (named query `tracker_closed`, route-only) — the sync never writes the owner's note. The client-API row is served.
