# Devin as a Metistry surface

Three surfaces, one of which exists today:

| # | surface | direction | status |
| --- | --- | --- | --- |
| 1 | **Devin as an external agent** at the console's `/mcp` | Devin → this instance | **now**, `metistry connect devin` |
| 2 | **Devin knowledge into the vault** (`collectors/devin-knowledge`) | Devin → inbox | W5, not built |
| 3 | **Devin as a compute target** (`targets/devin-sessions`) | this instance → Devin | W6, not built |

W5/W6 are `docs/plan-refresh-2026-09-13.md` §4b; both need the owner's Devin
PAT, and an enterprise PAT policy is **disabled by default**, so check that
before promising either. What follows is surface 1.

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

## Coming

- **W5 — knowledge in.** A TypeScript collector pulling Devin Knowledge notes
  and repository wiki pages into the inbox as captures with
  `source: devin` provenance, so the fold organises them. Ruled a
  **collector**, not a bridge: the assistant mounts exactly one MCP server,
  so a first-party DeepWiki bridge would have no caller inside Metistry.
- **W6 — dispatch out.** `targets/devin-sessions` with a `transport: http`
  dispatcher, `max_acu_limit` from the budget, a `structured_output_schema`
  for the report, and **polling** for completion (Devin has no outbound
  completion webhook). Outbound-only, so it needs no inbound path at all —
  which is why it is the half of this that can ship before the tunnel
  question is settled.
