---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
---

Removed: the one-release compatibility shim for GitHub Issues and Devin dispatch
(T4-11), now that 0.16.0 has shipped. `METISTRY_GITHUB_TOKEN` and
`METISTRY_DEVIN_API_KEY` in the environment are no longer read — an env key
alone dispatches nothing and feeds no sync — and a `targets/` manifest other
than the crews' `local-crew` is refused at load (the product's `targets/`
no longer ships `github-issues` or `devin-sessions`; the owner's
`.metistry/targets/` overlays and extensions of them are skipped the same way).
GitHub Issues and Devin are agent connections: `metistry connections add
<name> --type agent --provider github-issues|devin …` (docs/ops/connections.md,
*Agent connections*). `metistry doctor` has a new *target keys* row naming a
key still set and the verb that replaces it, and its *registries* row lists a
refused `targets/` manifest with the same verb; the console logs both at start.
`METISTRY_GITHUB_TOKEN` still serves `metistry update`'s Releases API calls.
