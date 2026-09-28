---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
---

**Pull requests, reviewed in Metistry and posted as you (T2-13, R6).** The
GitHub sync now raises a *pull request* request in Needs You for each open PR
waiting on your review — with its head SHA, its diff and its open review
threads — and clears it when your review lands on GitHub, the PR goes back to
draft, or it closes; a new push is a new question. An agent asks for the same
review with `requests_create` kind `pull_request` and the PR in `refs`, and
the two asks are one card. You answer through three new doors —
`POST /api/github/pulls/:owner/:repo/:number/review` and
`…/threads/:id/{reply,resolve}` — which post to GitHub as you, through the one
client holding your `github_write` secret, and only after checking that the
PR's head is still the one you were shown (`409 stale` otherwise, and nothing
is posted). The sync's own token stays read-only by construction: it can send
nothing but GETs and GraphQL queries. `metistry secrets sync --to env` delivers
`github_write` to the console when `secrets.yaml` names it; store it with
`metistry secrets set github_write --hosts api.github.com`. A sync is now
handed its Needs You switches (`syncs.<name>.raise`) by the runner.
