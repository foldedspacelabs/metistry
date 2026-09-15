---
"@metistry-apps/collectors": minor
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-cli": patch
---

**`collectors/devin-knowledge`** — Devin (Cognition) knowledge and repo wikis
into the inbox as captures, so the evening fold organises them into the vault.
Set `METISTRY_DEVIN_API_KEY` (a `cog_` service-user key or personal access
token) in `<instance>/state/.env`, run `metistry secrets sync --to keychain`,
and hourly the collector pulls every Knowledge note changed since its last run
plus — when `METISTRY_DEVIN_REPOS` lists repos — the DeepWiki pages for them.
One capture per item, `source: devin`, frontmatter carrying `devin_id`, title,
folder, repo, trigger and the source timestamp, then the text unchanged.

Transports follow what Devin documents: Knowledge notes over REST v3
(`GET /v3/organizations/{org_id}/knowledge/notes`, cursor pagination) with
plain `fetch`, and repo wikis over `https://mcp.devin.ai/mcp` because **no
REST route for wiki content exists** — the v3 `repositories/*` endpoints cover
indexing status only.

Safe to leave running: every capture is idempotent on
`(collector:devin-knowledge, <kind>:<devin_id>:<version>)`, so a re-run inserts
nothing and an edited item lands exactly once more; a `429` is
backoff-and-stop, not a failed run, with the watermark held so nothing is
skipped; and with no key the collector degrades **absent** — `run()` returns 0
and `check()` names the variable and the command rather than failing. It is
outbound-only, so it needs no inbound exposure. `METISTRY_DEVIN_API_KEY` is
**user-scoped** in the Keychain, like the AWS credentials: it is the person's
own key, shared by every instance on the Mac, and `secrets purge` never takes
it. `docs/ops/devin.md` has the configuration, the verified endpoint details,
and the two provenance points that need the owner's ruling (`deny_sources`,
and that captures are stored verbatim because no capture door redacts).
