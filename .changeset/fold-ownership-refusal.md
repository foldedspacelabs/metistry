---
"@foldedspacelabs/metistry-mcp-brain": minor
---

`knowledge_write` now enforces ownership as well as authorship: an update to
an existing markdown note whose frontmatter `source` is neither the caller's
own id nor `knowledge-fold` is refused (`forbidden: owned by <source>; propose
instead`). New notes are unaffected, and `source` is still stamped from the
credential rather than the argument, so "notes I wrote" stays a fact rather
than a claim. Hosts pass their vault reader as the new optional fifth argument
to `writeKnowledge` (the brain server wires `cfg.readKnowledge` through
automatically); when a read fails the write is refused rather than waved
through. `ownershipRefusal` and `frontmatterSource` are exported.
