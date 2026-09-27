# Product record fragments

`docs/product/PRODUCT.md`'s "Feed the product record" rule (`CLAUDE.md`) used
to have every PR append a bullet to the end of that one file — so any two PRs
open at once conflicted there, every time, on purpose-built content neither
author could resolve blind. Changesets solves the same problem for
`CHANGELOG.md` by having each PR add its own file instead of editing a shared
one; this directory does the same thing for the product record.

**The rule:** a PR with product significance — a goal sharpened, a benefit
proven with numbers, a safety mechanism shipped — adds exactly one file here,
never edits `PRODUCT.md` directly:

```
docs/product/record/<YYYY-MM-DD>-<slug>.md
```

containing exactly the bullet it would have appended, starting `- <date> — `.
Write it the way an entry already in `PRODUCT.md` reads (see its tail) — a
bold opening clause, then the mechanism and why it's safe to leave running.

**The fold:** `ops/scripts/fold-product-record.mjs` sorts every fragment
(except this README) by filename — the date prefix orders it, the slug
breaks ties — appends each one's trimmed content to the end of `PRODUCT.md`
(one blank line between entries), and deletes the folded fragments. It runs
as part of `pnpm release:version`, so `PRODUCT.md` only changes on a release
branch, never in two PRs at once. `--check` (wired into CI) fails if a
fragment doesn't start with `- 20` — a malformed fragment is caught before it
reaches a release rather than folded silently.

**Why not just `.gitattributes` `merge=union`?** The repo root sets it on
`PRODUCT.md` as a safety net for a local merge, but GitHub's PR-merge UI does
not honor `.gitattributes` merge drivers — a same-file conflict there still
blocks the merge button. Fragments avoid the conflict outright instead of
relying on a merge strategy the actual merge path doesn't run.
