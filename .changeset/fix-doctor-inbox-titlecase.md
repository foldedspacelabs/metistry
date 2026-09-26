---
"@foldedspacelabs/metistry-cli": patch
---

**`metistry doctor`'s inbox row no longer trips on a TitleCase `Inbox/`.** It
compared the legacy `<instance>/inbox/` path with `existsSync`, which a
case-insensitive APFS volume answers `true` for even when the only thing
there is the vault's own `Inbox/` — so every fresh macOS instance reported
`inbox degraded — pre-#156 layout`. The row now checks the directory's actual
on-disk spelling (the same exact-case lookup `metistry migrate-inbox` already
used) before reading it as the legacy layout.
