---
"@foldedspacelabs/metistry-cli": patch
---

Fix: a bare `metistry doctor` (no `--product-dir`, no `METISTRY_PRODUCT_DIR`)
from an installed CLI resolves the release install it runs from — the product
dir holding `releases/` and `current` — instead of a development checkout
beside it or around it. Doctor reads that release's `current` and says so:
the table's first line names `release <version> (read from <dir>)`, and
`doctor --json` carries a `product` object (`kind`, `version`, `install_dir`,
`read_dir`). A checkout is labelled `checkout`.
