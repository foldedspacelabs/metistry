---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
---

Removed: the one-release compatibility shim for GitHub Issues and Devin dispatch
(T4-11), now that 0.16.0 has shipped. **Before updating, re-create both targets
as connections** — nothing carries over on its own. `METISTRY_GITHUB_TOKEN` and
`METISTRY_DEVIN_API_KEY` in the environment are no longer read (an env key alone
dispatches nothing and feeds no sync), and a `targets/` manifest other than the
crews' `local-crew` is refused at load: the product no longer ships
`targets/github-issues` or `targets/devin-sessions`, and an owner's
`.metistry/targets/` overlay or extension of one is skipped the same way. For a
key that lived only in `.env`, store it first: `metistry secrets set devin_api_key`
(or `github_write_token`) on stdin; for one the retired shared scope still holds,
`metistry secrets migrate-scope` copies `METISTRY_DEVIN_API_KEY` to `devin_api_key`.
Then `metistry secrets hosts …`, `metistry secrets grant … connection:<name> on`,
and `metistry connections add <name> --type agent --provider devin|github-issues
… --config org=org-…|repo=owner/repo` (docs/ops/connections.md, *Agent
connections*), `metistry secrets sync --to env`, and drop the old `.env` lines.
`metistry doctor` has a new *target keys* row naming a key still set, and its
*registries* row lists a refused `targets/` manifest, each with the verb; the
console logs the same at start. `METISTRY_GITHUB_TOKEN` still serves `metistry
update`'s Releases API calls.
