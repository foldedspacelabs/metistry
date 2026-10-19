---
"@foldedspacelabs/metistry-mcp-brain": patch
---

Two captures racing one idempotency key could delete the file the surviving
row names. Capture file names are `<ms>-<name>`, so two attempts inside one
millisecond put the same path; the attempt that lost on the idempotency index
removed "its" file — the winner's — and the winner's row was left pointing at
nothing (Add to Today pressed twice at once: an empty `Inbox/`, about one run
in five under three concurrent presses on a fast database). The loser now
removes a file only when the winning row does not name it.
