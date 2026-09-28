---
"@foldedspacelabs/metistry-mcp-eventkit": minor
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-core": patch
---

**Move a meeting (T2-12).** The eventkit bridge gains `move_event` (`POST /events/move`): preview-then-confirm like create, the preview naming the event, the new time and everyone else in it; the confirm moves this occurrence only, bound to the move and to the event as previewed (`409` when its times or people changed). A confirm for an event with anyone else in it must also carry the owner-door token (`METISTRY_OWNER_DOOR_TOKEN_EVENTKIT`, header `Metistry-Owner-Door`), so the assistant's own confirm of such a move is refused at the bridge; an event on a read-only calendar never moves. The Swift helper gains `get_event` and `move_event` — rebuild it (`pnpm --filter @foldedspacelabs/metistry-mcp-eventkit build:helper`). The console serves `POST /api/calendar/events/:id/move` — owner only, presenting the owner-door token on a confirm and nothing else in the process holding it — in the shape MetistryKit's recorded fixture holds (`preview: {event_id, title, from, to, attendees}`, `moved`), plus a `warning` that is null for an event that is the owner's alone, and asks the calendar sync to run after a move. Core's client-API row flips to served.
