---
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/routines": patch
---

**`metistry update` seeds the templates the vault lacks (W2 checkpoint D1).** A template a release adds (`Templates/Brief.md`) reached only a fresh `init`, so an upgraded vault's Morning Brief skipped every morning with `skipped:template_missing` and doctor stayed ok. `update` now has a **templates** step after the lock: each `seed/vault/Templates/*.md` absent from the vault is copied — through the reconciler as `user`, create-only (`expected_sha256: ""`), else directly — and a file that is there is never touched; a second run copies nothing. `writeProtected` gains `createOnly`. Doctor's schedule row for a routine whose last run recorded `skipped:template_missing` is degraded, names the template and offers `metistry update`. The Morning Brief raises one `report` request for a missing template, as it does for an unreadable one, deduped per template while one is pending.
