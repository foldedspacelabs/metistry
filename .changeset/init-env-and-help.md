---
"@foldedspacelabs/metistry-cli": patch
---

`metistry init` now prints `METISTRY_ORIGIN` — the console refuses to start
without it in either shape — and shapes `METISTRY_RECONCILER_URL` for the
install it targets (launchd by default on macOS, `--shape compose` for a
container install), on `127.0.0.1` with this instance's own ports once it
is namespaced (`state/ports.yaml`). Fixes `docs/ops/deployment-shapes.md`'s
"What is still missing" #4, surfaced by the second-instance guide.

The `--help` text for `metistry compute providers add --from` now lists
every template from `COMPUTE_TEMPLATES` instead of a hand-copied, and
stale, subset (`llamaserver` and `applefm` were missing).
