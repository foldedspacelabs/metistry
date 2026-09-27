---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/routines": minor
---

**Live changes: `GET /api/events` is served.** Migration `0035_event_notify.sql` adds `metistry_notify()` and an `AFTER INSERT OR UPDATE` trigger on `runs`, `proposals`, `work`, `inbox`, `artifact_comments`, `outbound_messages` and `agents` that notifies `{table, op, id}` and nothing else (a no-op update is silent; an agent's heartbeat is throttled to one a minute). The console holds one `LISTEN`, gathers a burst for 250 ms, maps it to the catalogue's typed events and streams them as Server-Sent Events to the owner — a passkey session or the local owner token; an agent bearer and the capture token get the uniform `403`. Every payload passes a guard before it is numbered: exactly its type's fields, each an id, a name, a state or a count. `Last-Event-ID` replays exactly the missed events from a ring of the last 1,000 (or ten minutes), or sends `resync`; a dropped `LISTEN` reconnects by itself and sends `resync`; the credential is re-checked at every 20 s heartbeat; `METISTRY_EVENTS_MAX_STREAMS` (32) caps open streams with a `429`. `GET /api/identity` advertises `events` only while the route is served and the hub is wired.

The daily **Update Check** routine (`routines/update-check/`) asks the release feed for the newest release and, when it is newer than the running console, writes the row the console streams as `release.available {version}`; an unreachable feed is a `skipped:` row, never an alert. `@foldedspacelabs/metistry-core`: `GET /api/events` is `served` in the client API table.
