---
"@metistry-apps/console": minor
---

The PWA hears changes as they happen (T7-7, design-build-plan §2.20). One
`EventSource` on `GET /api/events` while signed in — only when `GET
/api/identity` lists the `events` capability — and the view on screen
refetches through its own route when an event names it: `needs_you.changed`
repaints the bell from the count it carries and refetches the Needs You list;
`message.new` and `turn.progress` the chat; `work.changed` the board, rooms and
Today; and so on through the catalogue (`web/live.js` `viewsFor`). A burst
refetches each view once, never under a field being typed in, and not behind a
hidden page. The browser's own reconnect resumes with `Last-Event-ID`; a stream
it gave up on reopens after a backoff and reloads what is visible, as `resync`
does. The chat, Activity, Board and count polls are now the fallback only:
their timers run while the stream is down and none runs while it is up. The
stream's state is on `<body data-stream>` for the offline band. Today gains
`refresh()` — the day and the rail again, without starting a new look.
