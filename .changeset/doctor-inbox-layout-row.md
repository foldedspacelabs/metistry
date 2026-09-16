---
"@foldedspacelabs/metistry-cli": patch
---

`metistry doctor` gained an `inbox` row: it flags an instance still carrying
the pre-#156 layout — a non-empty `<instance>/inbox/` or a `.gitignore` that
still lists `inbox/` — with the remediation `metistry migrate-inbox
--dry-run` (`docs/ops/inbox.md`). Degraded, never failed: the fallback path
still works, it just is not the vault.
