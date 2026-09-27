---
"@metistry-apps/console": minor
---

The PWA reads F-5's request type table (X-5). `GET /api/proposals` now carries
`request` on every row — core's `describeRequest`: type, word, body, answers,
decisions — additively, beside the stored columns. The PWA draws the word it
is served and its local `REQUEST_TYPE` / `TYPE_LABEL` copies are gone, so a
kind the table does not know reads as a report rather than its stored kind.
Skip is bulk-only (K2): no row offers it; it stays on the selection bar and
its `s` shortcut.
