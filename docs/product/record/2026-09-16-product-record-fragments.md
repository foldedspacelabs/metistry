- 2026-09-16 — **The product record stops being a merge conflict.**
  `docs/product/record/` fragments — one file per PR, never an edit to
  `docs/product/PRODUCT.md` itself — are the changesets fix applied to the
  one file every product-significant PR used to append a line to, which made
  any two such PRs open at once conflict there by construction.
  `ops/scripts/fold-product-record.mjs` folds every fragment into
  `PRODUCT.md`, in filename order, as part of `release:version`, so the file
  only changes on a release branch; `--check` (wired into both
  `release.yml`'s `verify` job and the PR `ci.yml`) refuses a fragment that
  doesn't open `- 20`, and the fold is idempotent — no open fragments leaves
  `PRODUCT.md` untouched. This entry is itself the first fragment written
  under the new rule.
