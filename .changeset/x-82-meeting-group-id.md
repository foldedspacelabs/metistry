---
"@metistry-apps/macos": patch
---

The Mac's request rows decode `group_id`, and a meeting's notes and to-dos
that share one are a single card in the queue (`MeetingGroup.cards`): the
rows keep their own answers, but they are read as one meeting. A row with
no group (or a blank one) stays a card of its own.
