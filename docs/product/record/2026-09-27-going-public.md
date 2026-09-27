- 2026-09-27 — **The repository is ready to be read by anyone.** Identifiers
  that belonged to one install (a tailnet host, a home directory, a personal
  domain, the owner's name in fixtures) became example values, and the
  owner's runbook (`docs/ops/going-public.md`) removes them from history too,
  rehearsed on a clone with every count at zero. The release path is locked
  down for outside contributors: CI runs read-only on `pull_request`, the
  signing and notarization secrets are readable only by the four jobs that
  declare the `release` environment and only after the owner approves the run,
  and only the owner can create a `v*` tag. Security reports go to GitHub's
  private vulnerability reporting (`SECURITY.md`). Positioning: invariant 8 —
  security that survives full code visibility — now has the code visible.
