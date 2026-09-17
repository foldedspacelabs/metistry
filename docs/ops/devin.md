# Devin as a Metistry surface

Three surfaces, one of which exists today:

| # | surface | direction | status |
| --- | --- | --- | --- |
| 1 | **Devin as an external agent** at the console's `/mcp` | Devin → this instance | **now**, `metistry connect devin` |
| 2 | **Devin knowledge into the vault** (`collectors/devin-knowledge`) | Devin → inbox | **now**, W5 |
| 3 | **Devin as a compute target** (`targets/devin-sessions`) | this instance → Devin | **now**, W6 — "[Dispatch out](#dispatch-out)" |

W5/W6 are `docs/plan-refresh-2026-09-13.md` §4b; both need a Devin `cog_`
credential, and an enterprise PAT policy is **disabled by default**, so check
that before promising either. Surface 2 is "[Knowledge in](#knowledge-in)" and
surface 3 is "[Dispatch out](#dispatch-out)"; together they are the round
trip — Devin's context arrives as captures, questions go out as sessions, and
the answers come back as proposals.

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
`<instance>/.metistry/state/.env` and re-run `metistry connect devin --rotate`: the
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
metistry connect devin --areas Areas/Engineering --project second-instance
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
# <instance>/.metistry/state/.env
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
(`packages/cli/src/secrets.ts`), like the compute provider keys and the AWS
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

## Dispatch out

`targets/devin-sessions` (W6). A work row goes out as a **Devin session**; the
answer comes back as a `report` proposal in Needs You. Outbound-only —
Metistry calls Devin and polls — so it needs no inbound path at all, which is
why it ships before the tunnel question above is settled.

```sh
# <instance>/.metistry/state/.env — the SAME key the collector uses, plus one new var
METISTRY_DEVIN_API_KEY=cog_…
METISTRY_DEVIN_ORG_ID=org-…    # REQUIRED for dispatch (see below)
METISTRY_DEVIN_SESSION_TIMEOUT_HOURS=24   # optional; when a session is given up on
```

`METISTRY_DEVIN_ORG_ID` is optional for `devin-knowledge` (an org-scoped key
resolves its own organization) and **required here**: a session is a spend,
and which organization it is charged to is not something to infer. Without it
the target's `check()` is `absent` and names the variable; dispatch is a
`409` carrying that check. Nothing is sent.

### The brief never leaves unchecked

The manifest's `data_policy` ships with an **empty `allow` list**. That is
deliberate: this is a third party whose default is "we may train on your
data", so the product default lets a brief cite *nothing* from the vault.
Widen it per instance in an overlay dir (`METISTRY_TARGETS_DIRS`, D4) to that
instance's own areas — never in the product file.

`deny_sources` is `[comms, devin]`. `comms` is §4.12. `devin` is the ruling
from "[Two safety points](#two-safety-points)": Devin's own knowledge, once
folded into the vault, must not be quietly re-exported to Devin as if it were
ours. Both are enforced by `checkBrief` before a byte is sent, and a refusal
is a `runs` row with `meta.violations` (`docs/ops/targets.md`).

### The knowledge-research brief kind

`POST /api/tasks/:id/dispatch` takes an optional `purpose`:

| purpose | what it asks for |
| --- | --- |
| `work` (default) | do the work described, then report on it |
| `knowledge_research` | answer the question; **do not open a pull request, push a branch, or modify any repository** — the whole output is the answer |

This is the "what does Devin know about X" path: a question the assistant
cannot answer is dispatched, and the answer arrives as something the owner
triages rather than as something a model asserted.

It is a **`purpose`, not a new `work.kind`**, because `packages/tasks` owns
exactly two claimable kinds (`task`, `review`) and `github-state` owns the
rest — a third would ripple through claiming, the fold and the reconciler for
no gain. The purpose lands on the dispatch `runs` row, on `work.meta.devin`,
and as a `metistry:purpose:<p>` tag on the Devin session. An unrecognised
purpose is a `400`, not a silent fallback to `work`.

**How an accepted answer reaches the vault.** Nothing new: the report is an
ordinary `proposals` row (`kind report`, `source_agent devin`, `trust
external`, `decision pending`). The owner decides it in Needs You; a proposal
decided `allow` or `accept_with_changes` is picked up by the evening fold as
a handle (`docs/ops/knowledge-fold.md`, "What it reads"), and the assistant
files it into the vault in that fold turn. The dispatch path writes no vault
page itself and never could.

### The collaboration rule, enforced rather than asked for

Devin is a non-Claude agent, so a *directed* push to it is the **owner's**
action or a routine's — never a Claude turn's. That is enforced twice, both
times by construction:

- `POST /api/tasks/:id/dispatch` is the `user` principal only. An owner token
  and an agent token both get `403`; an unknown bearer gets `401` (CRIT-7:
  dispatch is outbound and lives on the management surface).
- The assistant's own delegation tool, `agents_delegate`, dispatches
  `transport: local` crews and **nothing else** — `dispatch()` refuses a
  `local` target on the HTTP route and `dispatchCrew` has no path to an
  `http` target. There is no tool for a Claude turn to push to Devin with.

The other half of the rule — Devin *claiming* unassigned work through `/mcp`
— is "[What Devin can do](#what-devin-can-do)" above, and is unchanged.

### Budget: the ACU cap is the budget

Devin bills in ACUs, and `max_acu_limit` is a per-session ceiling. The
manifest's `submit.max_acu` (5) is the default; a dispatch may name its own
`max_acu`, which wins. It is written to the dispatch `runs` row at submit
time, and the ACUs Devin actually reports are written back onto that same row
when the session finishes, so per-target spend is still one query:

```sql
SELECT tool, count(*), sum((meta->>'acus_consumed')::numeric) AS acus
FROM runs WHERE kind = 'dispatch' AND ok GROUP BY 1;
```

`cost.per_run_estimate_usd` is `0` on purpose: the ACU-to-dollar rate is
per-contract, so inventing a number here would be worse than none.
**TODO(compute-budgets):** engine-side budgets are compute pivot PR 3
(`.metistry/compute.yaml`). When they land this stays the *target's* ceiling — the two
intersect, they do not replace each other — and nothing partial is
implemented here in the meantime.

### The return path: a poll, because there is no webhook

Devin's automations are **inbound only**; there is no "session finished"
event to a URL you own. So `result.status_via` is `collectors/devin-sessions`
(`schedule: "*/5 * * * *"`), which polls every work row still `in_progress`
with a `devin:` ref.

Ruled a collector rather than an in-process timer in the console: a poll is a
scheduled data pull with a cost, which is exactly what a collector is, and
making it one buys the manifest (invariant 5), a `runs` row per pass, the
watchdog's silent-collector probe and a generic `check()`. A `setInterval`
would be fewer lines and would have none of that. The only thing it would buy
is latency — minutes, on work that takes a Devin session tens of minutes.

| session `status` | verdict | what happens |
| --- | --- | --- |
| `exit` **with** `structured_output` | answered | `report` proposal (kind `finding`); work row **closed** |
| `exit` without it | failed | `report` proposal (kind `progress`) naming the miss; work row **blocked** |
| `error`, `suspended` | failed | report with the `status_detail` (`out_of_credits`, `inactivity`, …); work row **blocked** |
| `running` + `waiting_for_user` / `waiting_for_approval` | failed | report saying so; work row **blocked** — this return path does not answer sessions |
| `new`, `claimed`, `running`, `resuming` | pending | `work.meta.devin` records status, detail and ACUs so far; nothing else changes |
| any of the above past `METISTRY_DEVIN_SESSION_TIMEOUT_HOURS` | failed | timeout report; work row **blocked** |

A blocked row is visible and never claimable, which is the right shape for
"a person has to look at this". A `429` is backoff-and-stop, exactly as in
`devin-knowledge`: the pass ends, no verdict is invented, the next tick
re-polls. Report proposals are idempotent on
`devin-session:<session_id>[:failed]`, so a re-poll files nothing twice.

### The structured-output contract

`structured_output_required` defaults to **true** at Devin, so a dispatch
that sent no schema would be asking for an unvalidated blob. Every dispatch
sends this Draft-7 schema, and the adapter refuses to submit if it ever stops
being valid Draft 7, self-contained or under 64 KB:

```json
{ "answer": "…markdown, self-contained…",
  "sources": ["acme/api/.github/workflows/release.yml"],
  "confidence": "high | medium | low",
  "open_questions": ["…"] }
```

The report body is that answer, then `## Sources`, `## Open questions` and a
`## Provenance` block carrying the session URL, the status, the confidence,
the ACUs used against the cap, and the task the brief came from.

### Verified against docs.devin.ai (2026-09-15)

| what | detail |
| --- | --- |
| create | `POST /v3/organizations/{org_id}/sessions`, `SessionCreateRequest` — **`prompt` is the only required field**; `title`, `tags`, `max_acu_limit`, `structured_output_schema`, `structured_output_required` are the ones used |
| answer | `SessionResponse` — `session_id`, `url`, `status`, `org_id`, `created_at`, `updated_at`, `acus_consumed`, `pull_requests` are required fields |
| get | `GET /v3/organizations/{org_id}/sessions/{devin_id}` → the same `SessionResponse` |
| status | `new` / `claimed` / `running` / `exit` / `error` / `suspended` / `resuming` |
| detail | `status_detail`: `working`, `waiting_for_user`, `waiting_for_approval`, `finished`, `inactivity`, `user_request`, `usage_limit_exceeded`, `out_of_credits`, `out_of_quota`, `no_quota_allocation`, `payment_declined`, `org_usage_limit_exceeded`, `user_usage_limit_exceeded`, `total_session_limit_exceeded`, `error` — "Only populated on get/list endpoints" |
| where the answer is | `structured_output` is a field on the **session object**, not on a message: "Validated structured output from the session. Only populated on get/list endpoints." |
| schema limits | "JSON Schema (Draft 7) for validating structured output. Max 64KB. Must be self-contained (no external `$ref`)." |

**Idempotency: there is none, and that is now verified.** PR #143 could not
confirm whether v3 takes an `Idempotency-Key`. It does not: the v3 OpenAPI
document declares **no header parameters at all**, on any route, and unlike
v1's `CreateSessionParams` there is no `idempotent` boolean on
`SessionCreateRequest` either. So the guard is ours — the work row's
`external_ref` is bound under the partial unique index in the same statement
that dispatches, so a row can hold exactly one session, and every session
carries a `metistry:task:<id>` tag so a duplicate is findable from Devin's
side too.

### Verifying

```sh
# absent until both vars are set; ok once GET /v3/self answers
curl -s --cookie "$SESSION" https://<origin>/api/targets | jq '.targets[] | select(.name=="devin-sessions")'

# ask Devin something (session cookie only — an owner token is 403)
curl -s --cookie "$SESSION" -H 'content-type: application/json' \
  -d '{"target":"devin-sessions","purpose":"knowledge_research","max_acu":3,
       "brief":"Which pipeline deploys the payments service, and where is it defined?"}' \
  https://<origin>/api/tasks/12/dispatch

# the answer, once the poller has seen the session finish
psql ... -c "SELECT id, payload->>'title' FROM proposals WHERE source_agent='devin' AND decision='pending'"
```

## Coming

- **Reverse knowledge sync** (vault → Devin Knowledge) is possible and ships
  nowhere; see "[The reverse direction is not built, on
  purpose](#the-reverse-direction-is-not-built-on-purpose)".
- **Cursor as a second compute target** reuses the `http` transport this
  target introduced; its Cloud Agent API has the same missing-webhook
  problem, so it inherits the same poll-collector shape
  (`docs/research/2026-09-15-devin-cursor-integration.md` §7).
