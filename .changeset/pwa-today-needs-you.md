---
"@metistry-apps/console": minor
---

The PWA's Today and Needs You (T7-3a, screen 18 §2–§3), each in its own
module (`web/today.js`, `web/needs-you.js`, sharing `web/lib.js`) instead of
inside `app.js`. **Today** is one column in the Mac's order: the Morning Brief
(or its folded line) with the Standup collapsed and Copy Standup, Next Up from
30 minutes before a meeting, then the spine — past items folded above a Now
rule, meetings at their time, the day's tasks and work in the owner's order in
the gap before the next one — and the rail last: Agents and Since You Last
Looked. It reads `GET /api/today` (T2-7) and writes only through the Tick and
Defer doors, with the line's text as seen and an `Idempotency-Key`; a `409
stale` shows the line as it stands. The interim last-24h tiles and review list
leave Today. **Needs You** draws each request with its type's own answers from
`request` — the primary, Revise, Decline outlined in the neutral surface
(never red; the inline `#7a3b3b` is gone), then Later; Select switches to a
compact list where swipe right approves and swipe left declines, and a card
with Before and after opens instead of swiping; questions step one at a time
with Send Answers; from 600px the list pushes the card, side by side at 900px.
