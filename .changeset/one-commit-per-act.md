---
"@metistry-apps/reconciler": minor
"@foldedspacelabs/metistry-mcp-brain": minor
---

**One commit per act (T10-1, plan §2.21).** The reconciler's committer keys each commit by the act that made it instead of by `(principal, group)` per flush window: an explicit `group`, else the intent's `turn`, else its `run`, else the write alone. A commit carries `Brain-Source: <principal>` plus `Metistry-Run: <runs.id>` and `Metistry-Turn: <turn id>` trailers where known; two acts of one principal on the same path in one window fold into one commit carrying both. The bridge's intent gains `turn` and `run` (ids only — anything else is `invalid_request`, so a body cannot forge a trailer). The sweep of out-of-band edits is one `user` commit per sweep whose subject names its files (*Edits from Obsidian: 3 notes*). `knowledge_write` now sends the reply's turn handle and its call's `runs.id` instead of a per-agent group, so two replies in one flush window are two commits.
