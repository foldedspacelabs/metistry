---
"@metistry-apps/macos": patch
---

Needs You shows a recording's notes and to-dos as one card. The Mac's request
rows decode `group_id`; rows that share one are a single "meeting" line in the
list and one meeting card (Accept All, Decline All, each with its own receipt)
in the detail. Selection, the bulk verbs and the page limit still count the
requests inside it, and a row with no group stays a card of its own.
