---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": patch
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-cli": patch
---

**One vocabulary, one renderer, and the owner is never refused their own
vault.** P3 and P4 of
`docs/research/2026-09-19-grants-and-access-simplified.md` §4, approved
2026-09-20. P4 carries the **owner-visible change** below; P3 changes what
refusals SAY, not what they decide.

**P3 — one wording per reason.** §2.5 found five dialects across fourteen
refusal sites. `REFUSAL` in `packages/core/src/access.ts` is now one sentence
per `reason`, built in one place: the shape is one per reason, the facts in it
are substituted. So `queries_list` and `queries_run` refuse in the same words,
`knowledge_write` and `agents_delegate` give the same "belongs to the instance
assistant alone" sentence, and a tier miss names the tier the tool needs and
the tier the credential holds — in the console's own words for them (`none` /
`titles` / `folders`).

Silence became a type rather than an accident at a call site: `tell: "hide"`
is the refusal deliberately identical to "there is nothing here", it carries
no `needs`, and `formatRefusal` drops its `reason` on the way out. Four things
hide — a row outside your projects, a route-only query, the console's uniform
403, and a knowledge path you may not even list (the 2026-09-19 boundary: an
area is named only for a page whose existence you can already see).

New in `core`: `describeScope(principal)` (the triple: role · access ·
extras), `formatRefusal(decision)` (the §3.2 envelope), `classify(path)`,
`notKnowledge(path)`, `TIER_LABEL`, `ROLE_LABEL`, `sourceLabel`,
`RULED_TOOLS`, `NO_SUCH_PAGE`, and `tell` on `Refusal`. **Removed**:
`scopeAsPrincipal` (the P0 seam P4 deletes — `/api/knowledge/*` takes the
principal now), and the three refusal-string constants it replaces
(`NOT_A_VAULT_PATH`, `NOT_KNOWLEDGE`, `ARTIFACTS_SIGNPOST`).

**P4 — the owner is refused nothing.** "The owner should always have access to
everything" (ruled 2026-09-19) is a short-circuit at the top of `may()`, with
no exception clause below it. Safe only because `classify()` splits what a
path IS from what anyone may do with it: `Artifacts/` and `.metistry/` are not
knowledge paths, so the rule never has to be weakened to keep an agent out of
the machinery.

Two owner-visible changes, and they are the two §2.6 found:

- **`GET /api/q/<name>` serves the owner a route-exposed query.** The filter
  `expose: route` protects is a filter on what an AGENT may see of the vault;
  the owner's scope is the whole vault. The capture owner token is NOT the
  owner and is refused byte for byte, which is the credential that rule was
  always about.
- **`GET /api/knowledge/page` and `/links` classify instead of refusing.** The
  owner's `Artifacts/` and `.metistry/` answer `400` with
  `reason: "not_knowledge"` and `needs.door` naming the route that has the
  bytes (`GET /api/artifacts`, or "the file itself"), where they used to
  answer `404`. **No door serves `.metistry/state/.env` as a page, and not one
  byte of it crosses here** — the classification is the whole answer.

**Agents gain nothing from P4.** Every agent, crew and assistant refusal is
byte-identical to what it answered before, which the golden file asserts entry
by entry: the four `changed` entries under P4 are all `who: "owner"`.

**Surfaces.** `metistry agents list` is new (P3 §2.10 — the CLI rendered
grants not at all). `GET /api/agents` carries each row's rendered `scope` and
`grant_source`; an `access_request` payload carries `current_scope`. The
console's Agents panel and Needs You card print what they are sent instead of
holding spellings of their own. Tool descriptions moved onto the same words
and got smaller: brain's definition tokens 4264 → 4255 against a >5000 budget.
