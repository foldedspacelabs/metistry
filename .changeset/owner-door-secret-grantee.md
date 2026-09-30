---
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-cli": patch
---

An owner-door secret (`github_write`) now refuses a `connection:` or `agent:` grant at the tool, not just by convention: `secrets.yaml`'s own schema refuses a hand-written grant naming the fix, `metistry secrets grant` refuses writing one, and `secretGrant` itself reads Off for one no matter what a file says — so a misconfigured or pre-existing `secrets.yaml` can never hand the owner's GitHub PAT to a connection's or an agent's environment. `docs/ops/cli.md` drops its "no connection or agent is granted it" claim (a fact of today's config) in favor of the enforced one.
