# Devin as a Metistry surface

Three surfaces, one of which exists today:

| # | surface | direction | status |
| --- | --- | --- | --- |
| 1 | **Devin as an external agent** at the console's `/mcp` | Devin → this instance | **now**, `metistry connect devin` |
| 2 | **Devin knowledge into the vault** (`collectors/devin-knowledge`) | Devin → inbox | **now**, W5 |
| 3 | **Devin as a compute target** (`targets/devin-sessions`) | this instance → Devin | W6, not built |

W5/W6 are `docs/plan-refresh-2026-09-13.md` §4b; both need a Devin `cog_`
credential, and an enterprise PAT policy is **disabled by default**, so check
that before promising either. Surface 1 is next; surface 2 is
"[Knowledge in](#knowledge-in)".

## Connect

Devin takes custom MCP servers on **HTTP (Streamable HTTP)** at personal,
organization or enterprise scope, and personal scope needs no admin
(`docs/research/2026-09-15-devin-cursor-integration.md` §1b). There is no
API to write that configuration, so this verb mints the credential and
prints the three fields you paste:

```sh
metistry connect devin --instance ~/metistry-instance
```

```
Devin → Customize → MCPs → Add server (personal scope):

  name         metistry
  transport    HTTP (Streamable HTTP)
  url          http://127.0.0.1:8080/mcp
  auth method  Auth Header
  header       Authorization: Bearer <shown once>
```

The bearer is shown **once** — the console returns an agent token only when
it mints or rotates one. Paste it now; if it is lost,
`metistry connect devin --rotate` issues another and invalidates the old one.
Nothing is stored in the Keychain for Devin, because there is no file on this
Mac for the token to be read into.

Devin's **Test listing tools** button is the check from the other side: it
spins up an isolated environment and does tool discovery, which is a free
conformance check against `core`'s wire contract.

## Exposure: what that URL has to be

`http://127.0.0.1:8080/mcp` is loopback. That is enough for a **Devin CLI
session running on this Mac**, and it is not reachable from **Devin's
cloud**.

The 2026-09-15 ruling (`docs/plan-refresh-2026-09-13.md` §4b, "Exposure") is
that no inbound exposure is assumed: cloud Devin as an MCP *client* needs a
per-instance inbound path — a tunnel with the console's own auth in front
(Tailscale Funnel and Cloudflare Tunnel are the candidates; the S6 internal
mesh is the long-term answer) — **and the owner has not chosen one**. Until
that is chosen, surface 1 is the local-CLI shape.

When an origin does exist, set `METISTRY_CONSOLE_URL` (or `METISTRY_URL`) in
`<instance>/state/.env` and re-run `metistry connect devin --rotate`: the
printed URL follows the environment, and the loopback warning disappears on
its own. The console's own auth is unchanged by a tunnel — an agent bearer is
required on every request, because the network is not a boundary
(invariant 8).

Usefully, Devin manages MCP access independently of its network policy: an
MCP server's address does **not** need to be in the network allowlist. Less
usefully, a mandatory **Security Profile** MCP allowlist can block this
outright, and that is an admin setting.

## What Devin can do

The same external-principal surface Cursor gets — see `docs/ops/cursor.md`
for the table. In short: `knowledge_search` / `knowledge_read` /
`knowledge_list` / `knowledge_grep` under its grant tier, `capture` into the
inbox, `requests_create` into Needs You, `tasks_*` and `artifacts_*` inside
its projects, `queries_*` with the `queries` grant.

`knowledge_write` and `agents_delegate` are refused for an `external`
principal at the bridge — not configured off, incapable. Everything Devin
returns arrives as a row for the owner to triage.

Grants start default-deny (`{tier: "none", areas: []}`):

```sh
metistry connect devin --areas Knowledge/Areas/Engineering --project second-instance
```

The **collaboration rule** (C7) holds here by absence: Devin is a non-Claude
agent, so it discovers *unassigned* work with `tasks_list` and takes it with
`tasks_claim`; a *directed* push to a named non-Claude agent is refused at
the console with a `runs` row. There is no tool to violate it with.

## Two things about Devin's own settings

- **Training.** Devin's default is that your data *may* be used for model
  training; the opt-out is a paid-plan setting on the Data Controls page, and
  on the Teams plan **only an administrator can exercise it**. Anything Devin
  reads out of the vault through `/mcp` is subject to whichever side of that
  opt-out the account is on. Know which before granting areas.
- **Token classes.** Devin's own API keys are `cog_` (service-user or
  personal access token); legacy `apk_` keys are rejected by Devin's MCP
  server. None of that applies to the bearer *this* verb mints — that one is
  Metistry's, minted by `POST /api/agents`, and revocable here.

## Rotate, revoke, check

```sh
metistry connect devin --rotate     # new bearer, printed once; the old one dies immediately
metistry connect --list             # whether the row exists (Devin's own config is not visible from here)
curl -X POST http://127.0.0.1:8080/api/agents/devin/revoke \
  -H "Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN"
```

`--list` reports Devin's row honestly and says nothing about its config:
there is no file on this machine to read, so "connected" for Devin means
"the row exists and you pasted it". Revocation is permanent — the row stays
for provenance and the id cannot be re-minted.

## Knowledge in

`collectors/devin-knowledge` pulls Devin Knowledge notes and repository wiki
pages into the inbox as captures, and the evening fold
(`docs/ops/knowledge-fold.md`) organises them into the vault. This is the
"learn the repos and the process" half, and it is **outbound-only**: Metistry
calls Devin, so it needs no inbound path and nothing to do with the tunnel
question above.

Ruled a **collector**, not a bridge: the assistant mounts exactly one MCP
server (`brainOptions`' `strictMcpConfig`, invariant 9), so a first-party
DeepWiki bridge would have no caller inside Metistry. A collector is not the
assistant, so it may speak to a foreign server as an ordinary HTTP client.

### Configure

```sh
# <instance>/state/.env
METISTRY_DEVIN_API_KEY=cog_…      # service-user key or PAT; user-scoped in the Keychain
METISTRY_DEVIN_ORG_ID=org-…       # only for account-scoped tokens (see below)
METISTRY_DEVIN_REPOS=acme/api,acme/web   # optional: the wiki half
METISTRY_DEVIN_MAX_ITEMS=200      # cap per run
```

Then `metistry secrets sync --to keychain` and restart the console. With no
key the collector **degrades absent**: `run()` returns 0 without error and
`check()` reports `absent` with that remediation — captures, tasks, search and
every other collector carry on.

`METISTRY_DEVIN_API_KEY` is **user-scoped** in the Keychain
(`packages/cli/src/secrets.ts`), like `CLAUDE_CODE_OAUTH_TOKEN` and the AWS
keys: it is the person's own credential, shared by every instance on the Mac,
and `metistry secrets purge` must never take it.

`METISTRY_DEVIN_ORG_ID` is only needed when the token is account-scoped — an
enterprise service-user key, or any PAT. An org-scoped service-user key
resolves its own organization, which is what `check()`'s probe
(`GET /v3/self`) reports. Without either, `doctor`/`check()` says `degraded`
and names the variable rather than failing silently.

### Transports, and why each one

Chosen by what Devin documents, not by preference (all verified against
docs.devin.ai on 2026-09-15):

| what | how | why |
| --- | --- | --- |
| Knowledge notes | REST v3 `GET /v3/organizations/{org_id}/knowledge/notes`, `fetch` | a documented REST route exists, so no MCP client is needed |
| Repo wikis | MCP `https://mcp.devin.ai/mcp`, `read_wiki_contents` / `read_wiki_structure` | **there is no REST route** — the v3 `repositories/*` endpoints cover indexing status only |

> "The Devin MCP server is an authenticated service that provides access to
> both public and private repositories" — `/work-with-devin/devin-mcp`

Notes pagination is cursor-based: `first` (default 100, max 200) + `after`,
answering `{items, has_next_page, end_cursor, total?}`. `KnowledgeNoteResponse`
carries `note_id`, `name`, `body`, `trigger`, `folder_path`, `pinned_repo`,
`is_enabled`, `access_type` and `created_at` / `updated_at` as **integer**
epochs. There is no `updated_after` filter, so the watermark is applied
client-side.

`ask_question` is never called. It is AI-powered synthesis and it spends; a
collector never calls a model. If a question needs answering, that is a
dispatch (W6), not a collector.

### Schedule, watermark, and the 429 rule

`schedule: "@hourly"`. Devin publishes **no rate limits** — `429 Too Many
Requests` is in the status-code table and nothing else — so hourly is a
conservative guess, not a documented ceiling.

The watermark is `meta.since` on the collector's own `runs` row (plus
`since_iso`, so an operator can read it): Devin's raw `updated_at` integer,
which needs no guess about the unit. First run with no watermark = everything,
oldest first, capped at `METISTRY_DEVIN_MAX_ITEMS`; the next run resumes
where the batch stopped.

A `429` is **backoff-and-stop, not a failed run**: the partial listing is
discarded, the watermark does not move, `run()` returns what it had, and the
wiki half is skipped. The next hourly tick re-lists from the same point.

### What lands in the inbox

One capture per note, and one per wiki page, `source: "devin"`, mime
`text/markdown`, frontmatter then the source text unchanged:

```yaml
---
source: "devin"
kind: "knowledge"            # or "wiki"
devin_id: "note_abc123"      # wiki: "owner/repo#3"
title: "Deploy runbook"
folder: "/Engineering"       # knowledge only
repo: "acme/api"             # pinned_repo, or the wiki's repo
trigger: "when deploying"    # knowledge only
updated_at: "2026-09-14T10:02:00.000Z"   # knowledge only — see below
content_sha256: "…"          # wiki only — see below
captured_at: "2026-09-15T12:00:00.000Z"
---
```

`idempotency: {principal: "collector:devin-knowledge", key: "<kind>:<devin_id>:<version>"}`,
so a re-run is a no-op and a changed item lands **once per version**. For a
note the version is `updated_at`; for a wiki page it is the content digest,
because the wiki tools return neither a page id nor a timestamp — which is
also why a wiki capture carries `content_sha256` instead of `updated_at`
rather than inventing one.

`source_agent` is **NULL**. Identity comes from the credential, and this
credential is the owner's own Devin key, not an agent's bearer — so
`inbox-drain` proposes these at `user` trust. The content is foreign, and if
that should read `external` it is a rule in `inbox-drain` keyed on `source`,
not something this collector may decide.

### Two safety points

- **Nothing is redacted, deliberately.** Redaction is core's job at a
  boundary (`redactSecrets`, §4.3), and today `captureToInbox` does **not**
  apply it — every capture door stores bytes verbatim, including the owner's
  own. So a Devin note with a secret in its body lands verbatim in the inbox.
  That is the existing contract, stated here so nobody assumes otherwise.
- **`source: devin` is a new provenance class**, and it is exactly what
  `checkBrief`'s `deny_sources` scanner keys on (§4.18.B). Once these notes
  are folded into the vault they are citable in a brief to any target whose
  `allow` list covers their area. Add `devin` to `deny_sources` on outbound
  targets unless re-export is wanted.

### The reverse direction is not built, on purpose

Vault → Devin Knowledge is possible (`POST/PUT …/knowledge/notes`,
`devin_knowledge_manage`) and ships **nowhere**. Invariant 9: an outbound
mutation needs an allowlisted bridge with preview-then-confirm, and this one
would push the owner's own notes into a third-party cloud whose default is
"we may train on your data".

## Coming

- **W6 — dispatch out.** `targets/devin-sessions` with a `transport: http`
  dispatcher, `max_acu_limit` from the budget, a `structured_output_schema`
  for the report, and **polling** for completion (Devin has no outbound
  completion webhook). Outbound-only, so it needs no inbound path at all —
  which is why it is the half of this that can ship before the tunnel
  question is settled.
