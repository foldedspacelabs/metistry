---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/console": minor
"@metistry-apps/routines": patch
---

Ruling 8 (X-10): **a report is acknowledged, and an agent reads back its answer.**
A report that names no act is now answered **Acknowledge** beside Dismiss
(`decision: "acknowledge"`, stored `acknowledged` — core's `ACKNOWLEDGED`,
`ACKNOWLEDGE_ANSWER`); it carries no words and fires nothing, and
knowledge-fold reads an acknowledged report the way it reads an approved note.
A report that names its act (an event's Try Again, Raise) keeps it. And a
`requests_create` replay — the same `idempotency_key`, or the same title
within 24 hours — now returns `answer` beside the existing id: core's
`readBackOf` reading of where the owner's answer stands (`pending`,
`answered` with each question's answer, `acknowledged`, `revised` or
`declined` with the owner's words, `dismissed`, `expired`, `closed`).
mcp-brain's `readBack` keys the lookup and the read on the calling agent
alone, so another agent's request is never found. No tool was added.
