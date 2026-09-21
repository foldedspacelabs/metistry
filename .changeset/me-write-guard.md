---
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-mcp-brain": patch
"@metistry-apps/reconciler": patch
"@foldedspacelabs/metistry-cli": patch
---

**`Me/` and the user's own journal are refused at the tool for every non-user principal — new pages included.** `knowledge_write`'s ownership rule only ever ran against a note that already existed, so a brand-new page under `Me/` or the user's own `Journal/<date>.md` went straight through the default bare-vault grant every instance ships with — `Me/` is discovered, never assumed, and the daily journal is the user's alone (daily-flow-spec §5.1, §6.6). `core`'s `may()` now refuses the PATH itself, ahead of ownership, on both the `knowledge_write` tool and the reconciler's bridge (`writeAllowed`) — the second check exists because a routine's own commit (`plan-tomorrow`, the fold's routine half) reaches the vault directly and never asks `may()` at all. `Journal/Plan/`, `Journal/Fold/` and `Journal/Standup/` are each a routine's own reserved subdirectory and are unaffected. The seed vault also gains `Resources/README.md`, matching `People/` and `Projects/` — `seed/assistant-prompt.md` already told the fold to create entity pages there.
