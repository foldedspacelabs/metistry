---
"@metistry-apps/reconciler": patch
---

**`GET /vault/log` is narrowed to the owner (ruled 2026-09-27, X-6).** `GET /vault/show` has always refused a `.metistry/` (or other protected/non-vault) path for every bearer; `GET /vault/log` did not, so a path-scoped request for a protected path, or a whole-tree read that happened to include a commit touching one, handed its subject and provenance trailers to any caller — including whatever fronts an agent. `vault.log()` now takes the caller class: for anyone but the owner bearer, a protected `path` is `403 forbidden` and a whole-tree read silently drops any commit that touched one. `Artifacts/` is left out on purpose — the console's artifacts service resolves a version's commit through this same door with its own (non-owner) bearer, and was never the confidentiality boundary `.metistry/` is.
