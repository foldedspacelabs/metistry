# Connectors — MCP gateways (Executor and the field) and a Metistry connector model (2026-09-22)

Research answering the owner's 2026-09-22 ask: *"I'd like you to do some
research on Executor, an MCP gateway service that appears to fit the shape of
something I've been discussing with the designer. That's the concept of
connectors in Metistry. A collection of registered MCP servers that Metistry
proxies, along with added safety controls, auditing, and approvals, and makes
available to agents for use. This solves a problem I have where I can't always
directly attach MCP servers to the agent compute themselves, but still want to
use information from them or perform actions through them."*

**Revised twice on 2026-09-22**: first against the designer's preview brief as
relayed, then **re-verified against `origin/design/round-0-plan-review`** once
the branch was pushed — `screen-09-resources.md`, `design-system-amendments.md`,
`review-00-plan.md` §7, `HANDOFF.md` and the drawn board. §6 records the
alignment. Five of this document's positions were changed by the design and
**four were withdrawn outright** (§6.7); everything the design did not touch is
unchanged. Sections carrying design deltas: §3.5, §4.1, §4.2, §4.5, §4.7,
§4.8, §4.10, §4.13, §5.2–§5.4.

Nothing here is built; this PR adds one document and no product code.

Sources are Executor's own repository — **shallow-cloned and read locally** at
`d27e6737` (2026-09-20), so its claims cite `path:line` in *that* tree and are
marked `executor:` to keep them apart from this repo's — plus its published
docs, the MCP specification, and the GitHub API for every licence and language
figure (all fetched 2026-09-22). Repo claims cite `file:line` at
`origin/main` `7ebc5ec`. Two token measurements in §3.2 were **run on this
machine** against real MCP servers, with the command and output shown, because
the whole exposure decision in §4.6 turns on them and an estimate would not
have settled it.

## The short version

1. **"Executor" is `UsefulSoftwareCo/executor`** — MIT, TypeScript, 3,956 ★,
   created 2026-02-07, last push **2026-09-22** (today). Author: Rhys
   Sullivan; `RhysSullivan/executor` 302-redirects to it, so the two names in
   circulation are one project. It is real, active, and close to the shape of
   the ask. **`executor.dev` is a Squarespace "coming soon" page and is
   unrelated** — the product is at `executor.sh`. Three other GitHub repos
   carry "executor" and "MCP" in one sentence; none is a gateway (§1.1).
2. **Executor is the right *shape* and the wrong *substrate*.** Integrations →
   connections → per-tool policies → one MCP endpoint is exactly the ask's
   sentence. But the whole product is an Effect-TS monorepo with its own
   storage layer, its own OAuth service, its own React console, its own
   identity model and a QuickJS sandbox — and it is **hostile to embedding**:
   there is no small library at the bottom to depend on. Its own `packages/`
   list is eight workspaces deep (`executor:README.md:186-206`). Metistry
   would be adopting a second product, not a dependency.
3. **The single most useful idea in Executor is its downstream client shape,
   and Metistry needs it for a reason Executor never had to face.** Executor's
   default surface is **not** N×upstream-tools: it registers a fixed handful
   of meta-tools — `integrations`, `search`, `invoke`, `execute`, `skills`,
   `resume` (`executor:packages/hosts/mcp/src/tool-server.ts:1300,1371,1456,2058,2073,2110`)
   — and its docs state the property outright: *"The tool list stays small as
   you add integrations. Input schemas are loaded only for matching search
   results"* (`executor:apps/docs/mcp-proxy.mdx`). That is PoC-17's `lazy`,
   arrived at independently.
4. **The token numbers make lazy non-optional for Metistry, and they are
   measured, not assumed.** mcp-brain's eager surface is **4,224 tokens**
   against the **5,000** ceiling (`packages/mcp-brain/manifest.yaml`,
   `ops/scripts/check-tool-surface.mjs:52,86`) — **776 tokens of headroom**. A
   real `tools/list` measured on this machine with the repo's own `chars/4`
   rule: `@modelcontextprotocol/server-filesystem` = 14 tools, **3,244
   tokens**; `@modelcontextprotocol/server-github` = 26 tools, **3,964
   tokens**. **One** typical connector, namespaced in eagerly, is **4.2× to
   5.1× the entire remaining budget** and would put the surface 49–64% past a
   line CI already fails on. Namespaced-eager `<connector>_<tool>` is not a
   design option; it is arithmetic (§3.2, §4.6).
5. **Executor's auditing is the gap Metistry must not inherit.** Its
   persistence layer is **eleven tables** and not one of them is an execution
   log (`executor:packages/core/sdk/src/core-schema.ts:131-435`:
   `integration, subject, connection, oauth_client, oauth_session, tool,
   definition, tool_policy, artifact, plugin_storage, blob`). What it offers
   instead is **opt-in OpenTelemetry tracing, off by default**
   (`executor:apps/docs/hosted/tracing.mdx`) — latency observability, not "who
   called what with which arguments and what came back". Metistry's `runs`
   ledger already *is* that, and a connector call needs **no migration at
   all**: `runs.kind` is plain `text` with no CHECK (`db/migrations/0001_init.sql:9-23`).
6. **Executor's approval story inverts exactly where Metistry needs it most.**
   Policies are `approve | require_approval | block`
   (`executor:packages/core/sdk/src/core-schema.ts:498`). But in the
   small-surface mode — the only one whose token cost Metistry could afford —
   the `invoke` tool's own description reads *"Your client handles approval
   for this call; workspace blocks remain enforced"*
   (`executor:packages/hosts/mcp/src/tool-server.ts:1458-1459`). Approval is
   **delegated to the MCP client**; only `block` is enforced at the gateway.
   For a product whose first principle is *enforce at the tool, never by
   prompting*, that is a disqualifying inversion — and it is also the one
   mistake the Metistry model must not copy.
7. **Metistry has every piece except the registry itself.** One `/mcp` door
   (`apps/console/src/server.ts:544`), one audited `wrap()`
   (`packages/mcp-brain/src/server.ts:264-308`), `may()` over a closed
   `Resource` union (`packages/core/src/access.ts:490-518,703`), a closed
   action enum and the six answers (`packages/core/src/actions.ts:34`,
   `docs/ops/reply-feedback.md:9-21`), preview-then-confirm already shipping
   in a bridge (`packages/mcp-eventkit/src/index.ts:33-48`), redaction
   (`packages/core/src/redact.ts:6-48`), a Keychain-only secret rule
   (`packages/cli/src/secrets.ts:1-18`), a hostname-allowlisted egress proxy
   (`packages/core/src/egress.ts:1-48`), and two registries-with-credentials
   to copy the shape of (compute providers, `packages/core/src/compute.ts:215-271`;
   instances). **What is missing is one thing and it is precisely the ask: an
   INBOUND registry of third-party MCP servers that Metistry proxies to its
   own agents.** `metistry connect` (`packages/cli/src/connect.ts:36`) is the
   opposite arrow and must not be confused with it (§4.1).
8. **Recommendation: build it, small, in three phases — and do not take
   Executor as a dependency or as a host.** The decision table is §5.1. The
   short form: the gateway *mechanics* are a few hundred lines (spawn a stdio
   child, `tools/list`, `tools/call`, filter by an allow-list); the
   *governance* is the expensive part and Metistry has already built all of
   it, to a standard Executor does not meet. Embedding Executor would mean
   taking a second console, a second identity model and a second audit story
   to get the cheap half. P1 is read-only stdio connectors behind a lazy
   `connectors_list`/`connectors_call` pair: genuinely small, and it answers
   the owner's stated problem ("still want to use information from them") on
   its own.
9. **The designer's round-E work (read at `origin/design/round-0-plan-review`)
   describes the same system and is ahead of this document on the interface.**
   C56 states the architecture more plainly than §4.14 does — *"it holds the
   credential and **mediates**: an agent asks Metistry, Metistry asks the
   server"* — and **Settings ▸ Resources** is already drawn: a
   `SERVER · KIND · TOOLS · GRANTED TO` list, a per-tool
   `TOOL · WHAT IT DOES · [On|Ask|Off]` table, and a permissions row marked
   **Through Metistry** whose Ask marker is **a clock**. Four of this
   document's positions were **withdrawn** against it (§6.7), the sharpest
   being that a deferred Ask *does* raise a Needs You row and that **C62
   remains open** — *"Either Settings becomes resizable or Resources is not a
   Settings pane."* Its own asks D9/D11/D12 land inside §4, and D12 names
   `runs` independently. The one genuinely unresolved design question is
   **D11 vs §4.8**: whether a per-tool grant lives on the agent or on the
   connector's manifest (§6.8(2)).

---

## 1. Executor

### 1.1 Identification — which "Executor"

The name is crowded. What a search for an MCP gateway called Executor turns up
(GitHub search + direct fetches, 2026-09-22):

| Candidate | What it actually is | MCP gateway? |
| --- | --- | --- |
| **`UsefulSoftwareCo/executor`** (`executor.sh`) | **MIT, TypeScript, 3,956 ★**, created 2026-02-07, pushed 2026-09-22. *"The missing integration layer for AI agents."* | **Yes — this is the one** |
| `RhysSullivan/executor` | The same repository. `gh api repos/RhysSullivan/executor` returns `UsefulSoftwareCo/executor` — a rename, not a fork | same project |
| `executor.dev` | A **Squarespace "We're under construction" page**. No product, no docs | no |
| `ntindle/executor-unraid` | An unofficial Unraid template that installs `ghcr.io/usefulsoftwareco/executor-selfhost` on port 4788. Useful only as the breadcrumb that identified the upstream | no (a packaging of the above) |
| `Firstmeridian/llm-sql-safety-executor-mcp` | A Python SQL-safety MCP server. Single-purpose | no |
| `IndexFlowing/AgentBridge` | A Rust "universal MCP gateway & agent runtime". 3 ★ — noted for completeness, not a candidate | nominally |
| `jcbbge/executor` | A 0 ★ fork of `RhysSullivan/executor` | same project |

There is no ambiguity worth hedging on: **Executor is
`UsefulSoftwareCo/executor`**, the MIT TypeScript project at `executor.sh`.
The only trap is `executor.dev`, which is a different, unlaunched thing; do
not let a search result send anyone there.

### 1.2 What it is

An integration layer that puts one MCP endpoint in front of many upstreams.
Its README states the thesis in one sentence: *"Add a tool once, give it
credentials once, set its policy once, and every agent shares it over MCP"*
(`executor:README.md:19-21`).

The model is three nouns (`executor:apps/docs/concepts/*.mdx`):

- **Integration** — *"something Executor connects to, defined by an MCP
  server, an OpenAPI spec, or a GraphQL endpoint."* It is a **catalog**, not a
  live connection.
- **Connection** — *"a configured instance of an integration. One integration
  can have many connections"* — the same API authenticated as two different
  accounts. Credentials live here.
- **Policy** — per-tool: *"Allow … Require approval … Block."* Defaults are
  derived from the spec: *"read-only `GET` operations on an OpenAPI spec are
  allowed by default, while writes can be set to require approval."*

That triple is a direct match for the ask's sentence, and it is the part worth
taking.

**Deployment.** Five packagings of one runtime (`executor:README.md:74-82`):
Executor Cloud (hosted, free tier), CLI (`npm i -g executor`, a durable
background service), a desktop app (Mac/Windows/Linux), Docker self-host
(`ghcr.io/usefulsoftwareco/executor-selfhost`, port 4788), and a Cloudflare
Worker. So: **hosted *and* self-hosted *and* OSS** — all three. Licence
**MIT** (`executor:LICENSE:1-3`, "Copyright (c) 2026 Rhys Sullivan").

**Pricing.** Cloud advertises a free tier (`executor:apps/docs/hosted/cloud.mdx`);
paid tiers are implied by an `autumn.config.ts` at the repo root but are not
documented in the tree. Self-hosting is free.

### 1.3 How servers are registered

Three routes, all writing the same `integration` + `connection` rows:

- **Web UI** — paste a URL; *"Executor detects the type, indexes the tools,
  and handles auth"* (`executor:README.md:113-115`).
- **CLI** — `executor call executor openapi addIntegration '{...}'`
  (`executor:README.md:117-125`) — i.e. registration is itself a tool call on
  a built-in `executor` integration. Elegant, and a reminder that Executor's
  own mutating surface is *open*: a config change is a tool call.
- **SDK** — `createExecutor({ plugins: [...] })` (`executor:README.md:143-155`).

Upstream kinds are a plugin system: `openapi`, `graphql`, `mcp`, `google`,
`microsoft`, plus secret providers (`executor:packages/plugins/`).

### 1.4 How it authenticates upstream

Per **connection**, not per integration, so one upstream can hold several
identities. Credential storage is pluggable — `1password`, `keychain`,
`encrypted-secrets`, `file-secrets`, `workos-vault`
(`executor:packages/plugins/`). Full OAuth is first-class: ~20 modules under
`executor:packages/core/sdk/src/oauth*.ts` (discovery, dynamic client
registration, session, garbage collection) plus `oauth_client` and
`oauth_session` tables.

A connection need not be authenticated at all: *"public APIs and public MCP
servers can be connected with no credentials"*
(`executor:apps/docs/concepts/connections.mdx`).

For **stdio** upstreams, the child inherits a **short, closed** environment
safe-list — proxy variables and CA paths only, with the comment *"None of them
carries a credential. Deliberately short and closed"*
(`executor:packages/plugins/mcp/src/sdk/stdio-connector.ts:26-50`). Anything
else, an API key above all, is declared on the source config's `env`. This is a
good pattern and §4.4 borrows it.

### 1.5 How it exposes upstreams downstream — the client shape

**This is the most important section of §1.** The ask asks whether an agent
sees one MCP server with N×tools or a lazy catalog. Executor's answer is
**lazy, and it is the default** — which is notable, because most of the field
chose N×tools.

The endpoint is one streamable-HTTP URL (`http://127.0.0.1:4788/mcp`) or
`executor mcp` over stdio (`executor:README.md:87-96`). Two modes:

| Mode | Query string | Downstream tools registered | Upstream schemas |
| --- | --- | --- | --- |
| **codemode** (default) | — | `execute`, `skills`, `resume`, `integrations`, artifact tools | never listed; the model writes sandboxed JS that calls `tools["github.org.main.issues.create"](…)` |
| **passthrough** | `?mode=passthrough` | `integrations`, `skills`, `search`, `invoke` — **four** | loaded **only for search matches**, ≤20 per page |

Tool names are registered at
`executor:packages/hosts/mcp/src/tool-server.ts:1300,1371,1456,2058,2073,2110`.
The docs state the property Metistry needs: *"The tool list stays small as you
add integrations. Input schemas are loaded only for matching search results"*
(`executor:apps/docs/mcp-proxy.mdx`).

**Namespacing** is a four-segment dotted address
`<integration>.<owner>.<connection>.<tool>`, and policy patterns match against
it with segment wildcards (`executor:packages/core/sdk/src/policies.ts:68-90`).
`vercel.dns.*` is a subtree; `vercel.*.*.dns.create` wildcards owner and
connection. Worth copying the *idea* (a policy pattern is matched against a
structured address, not a flat name) if Metistry ever holds two credentials for
one upstream; §4.5 deliberately does not, yet.

### 1.6 Safety controls — and where they invert

| Control | Present? | Detail |
| --- | --- | --- |
| Per-tool allow / deny | **yes** | `ToolPolicyAction = "approve" \| "require_approval" \| "block"` (`executor:packages/core/sdk/src/core-schema.ts:498`) |
| Spec-derived defaults | **yes** | read-only `GET` allowed, writes gated |
| Owner precedence | **yes** | org ∧ user, *"the most restrictive matched action across owners, so a user preference cannot weaken an org guardrail"* (`executor:packages/core/sdk/src/policies.ts:6-9`) |
| Human-in-the-loop | **partial — see below** | `PendingApprovalStore`, single-use, 15-minute TTL (`executor:packages/core/sdk/src/pending-approval.ts:31-34,20-22`) |
| Argument constraints | **no** | policies match the tool *address*; arguments are schema-validated but not policy-constrained |
| Rate limits | **no** | no rate-limit module in the tree |
| Dry-run / preview | **no** | no preview-then-confirm equivalent |
| Sandboxed execution | **yes** | QuickJS / Deno subprocess / dynamic worker (`executor:README.md:196-197`); credentials never reach the agent |

**The inversion.** In passthrough mode — again, the only mode whose token cost
Metistry could afford — the `invoke` tool is described to the model as:

> "Call one connected integration tool using the exact ID and JSON input schema
> returned by search. May read or change external state. **Your client handles
> approval for this call**; workspace blocks remain enforced."
> — `executor:packages/hosts/mcp/src/tool-server.ts:1458-1459`

and the accompanying skill repeats it: *"Invoke can change external state; your
client handles approval for each call. Workspace block policies remain
enforced"* (`executor:packages/hosts/mcp/src/passthrough-tools.ts:29-32`).

So `require_approval` is **not enforced by the gateway** in that mode. It is
enforced by whatever MCP client happens to be connected — Claude Code's own
permission prompt, Cursor's, ChatGPT's. `block` is the only action that holds
server-side. Against CLAUDE.md's *"enforce at the tool, never by prompting …
If policy forbids something, the tool must be incapable of it"*, that is
disqualifying on its own, and it is the specific failure §4.7 and §4.10 are
designed to avoid: **a Metistry connector's `ask` mode must be a hard stop
inside the console, never an annotation the client may ignore.**

(In codemode, approval *is* server-side — the fiber suspends and `executor
resume --execution-id` continues it — but codemode is a general JS sandbox,
which is a much larger thing to admit than a tool call and would collide with
invariant 9.)

### 1.7 Auditing — the real gap

Executor has **no durable execution log**. Its schema is eleven tables
(`executor:packages/core/sdk/src/core-schema.ts:131-435`) — `integration`,
`subject`, `connection`, `oauth_client`, `oauth_session`, `tool`, `definition`,
`tool_policy`, `artifact`, `plugin_storage`, `blob` — and not one records a
call.

What exists instead:

- **OpenTelemetry traces**, opt-in and off by default: *"Export is off by
  default and stays off until you set an endpoint. With none set there is no
  exporter and no buffer, and nothing leaves the process"*
  (`executor:apps/docs/hosted/tracing.mdx`). This answers *"which part was
  slow"*, not *"what did it do"*.
- **Anonymous product analytics** — seven event types, exhaustively documented
  (`executor:TELEMETRY.md`), deliberately carrying **no** tool names,
  arguments, results, integration slugs or identity. Creditable transparency;
  useless as an audit trail, by design.

For Metistry this is the decisive asymmetry. `runs` already answers the audit
question for every other tool call, and §4.9 shows a connector call fits it
with **zero schema change**.

### 1.8 Secrets, data policy, multi-tenancy, latency

- **Secrets.** Never in the agent: *"A connection's credentials are stored by
  Executor and attached to the upstream call. The agent runs in a sandbox and
  never sees them"* (`executor:apps/docs/mcp-proxy.mdx`). Good, and the same
  rule §4.4 adopts. There is **no response-side secret redaction** — nothing
  scrubs an upstream reply that echoes a token back.
- **Data policy.** None. There is no notion of "this connector may not see
  personal areas", no on/off-machine locality flag, no analogue of Metistry's
  `data_policy { allow, deny_sources, max_brief_bytes }`
  (`targets/github-issues/manifest.yaml:34-45`). For a cloud-hosted gateway
  that is a meaningful absence.
- **Multi-tenant.** Yes, and it is structural: tables are `tenantExecutorTable`
  (catalog, shared) vs `ownedExecutorTable` (per-owner), with an `Owner = org |
  user` split and the org-wins-on-restriction rule in §1.6.
- **Latency.** Not measured here and not published. Structurally: one extra
  hop, plus per-tool-call JSON-schema validation at the boundary, plus — in
  codemode — a QuickJS sandbox boot. The stdio connection pool
  (`executor:packages/plugins/mcp/src/sdk/connection-pool.ts`) exists precisely
  to keep upstream process spawn off the hot path, which is a detail §4.3
  should copy.

### 1.9 Verdict

Executor is a well-built, actively developed, permissively licensed product
that has independently arrived at three ideas Metistry should take: **the
integration/connection/policy triple**, **the small-by-default downstream
surface**, and **the closed environment safe-list for stdio children**. It is
not a dependency Metistry can absorb, and it is not a host Metistry should
trust with its audit or its approvals. §5.1 does the arithmetic.

---

## 2. The field

One line each; licences and languages from the GitHub API, 2026-09-22.

| Project | Licence / language | What is distinctive |
| --- | --- | --- |
| **Executor** (`UsefulSoftwareCo/executor`) | **MIT / TypeScript**, 3,956 ★ | The subject of §1: integration→connection→policy, and the only one in this table whose **default** downstream surface is small (search/invoke or a code sandbox) rather than N×tools. |
| **Docker MCP Gateway / Toolkit** (`docker/mcp-gateway`) | MIT / **Go**, 1,579 ★ | Isolation is the product: each upstream runs *"in isolated Docker containers with restricted privileges, network access, and resource usage"*, with a curated signed catalog and credential injection at the proxy. The strongest sandbox story; the weakest fit for a Docker-free macOS shape. |
| **IBM ContextForge** (`IBM/mcp-context-forge`) | Apache-2.0 / **Python**, 4,515 ★ | The enterprise maximalist: gateway **+ registry + proxy** over MCP, A2A *and* REST/gRPC, with guardrails and a plugin framework. Closest in ambition to the ask; far past its scale, and Python (ruled out, CLAUDE.md "no Python anywhere"). |
| **Lasso MCP Gateway** (`lasso-security/mcp-gateway`) | MIT / **Python**, 390 ★ | Security-first plugin gateway — sensitive-data masking and prompt-injection screening on the wire. **Last pushed 2026-01-22**: eight months stale. Idea worth taking (scan the *response*, not just the request); code not worth depending on. |
| **MetaMCP** (`metatool-ai/metamcp`) | MIT / **TypeScript**, 2,684 ★ | Aggregator + middleware in one Docker image, with per-namespace endpoints and tool-level filtering middleware. The closest OSS shape to "a registry of MCP servers with a policy layer" that is also TypeScript — the one embed candidate worth a second look if §5.1 is ever revisited. |
| **mcp-proxy** (`sparfenyuk/mcp-proxy`) | MIT / **Python**, 2,761 ★ | Not a gateway: a **transport shim** between streamable-HTTP and stdio. Named here only to rule it out — it adds no policy, no audit, no registry. |
| **MCP Router** (`mcp-router/mcp-router`) | NOASSERTION / TypeScript, 2,149 ★ | **Dead.** Its own description: *"development, support and security updates ended 2026-09-18."* Four days ago. A useful reminder of what depending on a young gateway costs. |
| **Stacklok ToolHive** (`stacklok/toolhive`) | Apache-2.0 / **Go**, 2,206 ★ | Runs MCP servers as locked-down containers/Kubernetes workloads with secrets management and a CRD operator. Ops-plane sibling of Docker's; same Docker-shaped mismatch. |
| **Cloudflare** | proprietary, hosted | **Checked and could not be confirmed.** AI Gateway's own overview lists *"analytics, caching, rate limiting, and model fallback"* and does **not** mention MCP; the Cloudflare One docs index (`llms.txt`, 2026-09-22) returns exactly one MCP entry, *"Detect MCP traffic in Gateway logs"*. An "MCP Server Portals" feature has been discussed publicly but I could not find a live docs page for it today — **treat as unverified**, not as a capability. |
| **Composio** (`ComposioHQ/composio`) | MIT / **TypeScript**, 30,288 ★ | The managed-auth giant: 1,000+ toolkits, hosted OAuth per end-user, **tool search** as a first-class answer to surface bloat. The auth-at-scale reference; a hosted dependency and an identity model Metistry would not own. |
| **Arcade** (`ArcadeAI/arcade-mcp`) | MIT / **Python**, 1,032 ★ | Per-**end-user** authorization: the agent gets a tool call that pauses until *that user* has authorized *that* scope. The best articulation in the field of "the credential belongs to a person, not to the agent". Python. |
| **Anthropic connectors (claude.ai)** | proprietary, hosted | The consumer-facing precedent and the source of the owner's word. Remote MCP servers added by URL, *"typically go through an OAuth authentication process … and grant specific permissions"*; the user approves individual tool calls or chooses **"Allow always"**. Note the shape: **per-tool, remembered consent** — §4.10's auto-approve rules are the same idea bound to autonomy level instead of a checkbox. |
| **MCP spec — authorization** (2025-06-18) | spec | OAuth 2.1 + PKCE, RFC 9728 protected-resource metadata, RFC 8707 **resource indicators**. Two clauses bind §4.4 directly: *"MCP servers MUST validate that access tokens were issued specifically for them as the intended audience"* and *"If the MCP server makes requests to upstream APIs … **The MCP server MUST NOT pass through the token it received from the MCP client**."* An agent's Metistry bearer must never reach an upstream. |
| **MCP registry** (`modelcontextprotocol/registry`) | NOASSERTION / **Go**, 7,274 ★ | The community index of servers — discovery metadata, not a gateway. Relevant later as a *source* for `metistry connectors add <name>`, never as a trust boundary. |
| **Claude Code `claude mcp`** | proprietary client | The client-side view, and the thing Metistry already writes: `mcpServers.<name>` with `url` + `Authorization: Bearer ${env:VAR}` (`docs/ops/cli.md:525`, `packages/cli/src/connect.ts:372-374`). Its per-server config is exactly what the owner *cannot* set on a cloud engine — which is the problem statement (§4.14). |

Two patterns across the table. **First**, everyone solved registration and
credentials; almost nobody solved *durable audit* — Executor has none, and the
container-based gateways log at the container boundary rather than per call.
**Second**, the field is splitting on the surface question: Docker, ToolHive,
MetaMCP and ContextForge expose N×tools and let the client drown; Executor,
Composio and Arcade have all moved to search-then-invoke. Metistry's 5,000-token
ceiling puts it firmly in the second camp before it writes a line.

---

## 3. What Metistry has today

### 3.1 The one MCP surface

There is exactly one MCP door and it is a mount, not a service:

- `apps/console/src/server.ts:544` — `if (url.pathname === "/mcp") return brain.handle(req, res);`
- `packages/mcp-brain/manifest.yaml` — `transport: http`, `port: 8080` with
  the note *"no bind of its own: mounted at the console's POST /mcp"*.

**Every tool call is wrapped.** `packages/mcp-brain/src/server.ts:264-308` is
the single choke point: it opens a two-phase `runs` row
(`startRun`/`finishRun`), lifts the `turn_id` correlation handle out of
`_meta`, resolves deprecated aliases, and — the part that matters here —
**checks the allow-list before the body runs**:

```ts
const admitted = may(principalOf(principal), "act", { kind: "toolset", name });
if (!admitted.ok) { … await finishRun(db, runId, { ok: false, error: admitted.code, meta }); … }
```

with the comment *"before the body, for every tool, on the same audited path
every other refusal takes"* (`:277-286`). A connector tool registered through
`reg()` (`:315-316`) inherits all of that for free. That is the single biggest
fact for sizing §4.

**Registration is one function** — `reg(name, description, inputSchema, body)`
— so adding `connectors_list` / `connectors_call` is two calls, not a
subsystem.

### 3.2 The token budget — and the measurement that settles §4.6

The rule is in the manifest schema (`packages/core/src/manifest.ts:44-46`):
`discovery` defaults to `eager`, and *"lazy is for bridges past >20 tools / >5k
definition tokens."* CI enforces it generically
(`ops/scripts/check-tool-surface.mjs:51-52`):

```js
export const MAX_EAGER_TOOLS = 20;
export const MAX_DEFINITION_TOKENS = 5000;
```

measured as `JSON.stringify(tools).length / 4` (`:124-127`) against the bridge's
own `toolSurface()` export (`packages/mcp-brain/src/surface.ts:39-58`).

Where brain sits **today**: 27 tools declared, 26 eager, **16,896 chars ≈
4,224 tokens** (`packages/mcp-brain/manifest.yaml`; the script's own note at
`:86` — *"the surface is 4,224 tokens against the >5,000 line"*). The 27th,
`propose_action`, is lazy-by-credential.

**Headroom: 776 tokens.** And the script is explicit that this is not an
invitation: *"The next tool after this one fails here again, and that is the
point"* (`:87`).

Now the measurement. Two real MCP servers, real `initialize` + `tools/list`
over stdio, counted with the repo's own rule:

```console
$ node measure.mjs npx -y @modelcontextprotocol/server-filesystem ./sandboxdir
{ "tools": 14, "chars": 12973, "tokens": 3244 }

$ node measure.mjs npx -y @modelcontextprotocol/server-github
{ "tools": 26, "chars": 15854, "tokens": 3964 }
```

| Surface | Tools | Definition tokens | vs. 776 remaining | Brain + this |
| --- | --- | --- | --- | --- |
| mcp-brain today (eager) | 26 | **4,224** | — | 4,224 (84% of cap) |
| `server-filesystem` | 14 | **3,244** | **4.2×** | 7,468 — **49% over** |
| `server-github` (npm) | 26 | **3,964** | **5.1×** | 8,188 — **64% over** |

Two caveats, both pushing the same way. The npm `server-github` is the
**archived reference** server; GitHub's official Go server exposes **24
toolsets** (`github/github-mcp-server`, MIT, 33,130 ★) and is very much larger
— so 3,964 is a *floor* for "the GitHub connector", not a typical case. And
the owner's stated use is *"a collection"* of connectors, plural: two modest
ones eagerly namespaced would roughly double brain's entire surface.

**Conclusion, and it is arithmetic rather than judgement: connectors cannot be
eager. Not "should not" — CI fails the build.**

### 3.3 The bridge contract in core

Everything a connector would need to conform to already exists as a contract
other bridges are held to:

| Piece | Where | Note |
| --- | --- | --- |
| Manifest shape | `packages/core/src/manifest.ts:38-69` | `transport`, `runs_on`, `requires_tcc`, `discovery`, `degrades`, `exposes[{name, description, destructive}]` |
| Auth header | `packages/core/src/auth.ts:8-33` | `parseBearer`, constant-time `tokenEquals`, `tokenHash`, `mintToken` |
| Error envelope | `packages/core/src/errors.ts:5-46` | closed `ErrorCode` union → `errorEnvelope()` → `statusFor()` |
| `check()` | `packages/core/src/check.ts:9-27` | `Checkable` + `checkResultSchema`; `metistry doctor` is generic because of it |
| Preview-then-confirm | `packages/mcp-eventkit/src/index.ts:33-48` | already shipping: a destructive call returns `{preview, confirm_token, expires_in_sec}`; the token **binds to the exact canonicalised payload** and is single-use (`:39-42`). This is the mechanism §4.10 reuses, not one it invents. |
| Secret redaction | `packages/core/src/redact.ts:6-48` | `REDACTED`, `redactSecrets()`, `scrubModelOutput()`, `containsRedactedPlaceholder()` |
| stdio conformance | `packages/core/src/stdio-conformance.ts` | the shared conformance suite Swift bridges are held to as well |

`destructive: true` in `exposes` (`manifest.ts:53`) is already the flag that
means preview-then-confirm — eventkit's `create_event` and `create_reminder`
carry it. A connector's per-tool `mode` (§4.5) is the same idea one notch
finer, and it **replaces** the flag rather than joining it: C61 forbids a
second "previews first" marker beside the state, so a connector manifest has
`mode: ask` and no `destructive:` (§4.2). The bridge manifest's own flag is
untouched — bridges are a different, first-party schema.

### 3.4 Grants, roles and scope

`may()` (`packages/core/src/access.ts:703`) decides everything, over a **closed
`Resource` union** (`:490-518`) — `tool`, `toolset`, `knowledge`, `query`,
`project`, `action`, `console`. Roles are `owner | assistant | agent | crew |
tool` (`:325`). A `Principal` carries `{id, role, scope, source}` where `Scope
= {tier, areas, queries, projects, autonomy}` (`:338-352`), and `GrantSource`
records *where* the grant came from — registry, environment, or a named
manifest (`:330`), now a real column (`db/migrations/0025_agent_role.sql`).

Crews declare capability as **groups**, not tool names
(`packages/core/src/manifest.ts:183-211`): `knowledge`, `requests`, `capture`,
`tasks`, `rooms`, `actions`, `artifacts`. And there is a **never-list**
(`:231`): `knowledge_write`, `agents_delegate`, `queries_list`, `queries_run`,
`request_access` — with the reasoning that a named query *"is not filtered by a
crew's scope/projects the way every other group here is, so handing it to a
crew would leak past the boundary `uses` is meant to hold"*. That sentence
applies word-for-word to a connector, and §4.8 takes it seriously.

### 3.5 Actions, autonomy and the six answers

The closed enum (`packages/core/src/actions.ts:34`):

```ts
export const ACTION_KINDS = ["dispatch", "task_update", "comment", "capture"] as const;
```

modes `deny | propose | allow` (`:38`), autonomy levels `observe | propose |
act_within_scope` (`:42`), with the level a **ceiling** over the per-kind entry.
`docs/ops/actions.md` states the design constraint that §4.7 has to answer to:

> "What is *not* on it is the point: no email, no message, no git, no shell, no
> grant. **Every kind is something the console can already do through an
> existing service with an existing audit row — an action adds a door, never a
> power.**"

The **six answers on the wire** (`docs/ops/reply-feedback.md:9-21`,
`docs/product/glossary.md:36-47`): Approve, Revise, Decline, Approve as Work,
Later, Skip — with `Later` a snooze that does not settle the row, and `Skip` a
decline that fires none of Decline's consequences.

**The design branch has since re-cut this to four on a card**, and every
approval section below follows it: `POST /api/proposals/batch` accepts only
`BATCH_DECISIONS = ["later", "skip", "deny"]`, so *"Four answers on a card,
three on a selection; the difference is not a simplification, it is the
endpoint's own list quoted back"* — Skip *"came off the card as a fifth button
and lives as a batch verb"*
(`screen-03-needs-you.md` §3, design branch). The wire is unchanged; the card
offers **Approve · Revise · Decline · Later**, plus Approve as Work where the
payload suggests one. §6.2 records that this contradicts `reply-feedback.md`
and two shipped SVGs, which still say six.

### 3.6 `metistry connect` — the OUTBOUND arrow

`packages/cli/src/connect.ts:36`:

```ts
export const CONNECT_TOOLS = ["claude-code", "cursor", "devin", "opencode"] as const;
```

This mints **one agent row and one token per external tool**, independently
revocable, and writes that tool's own MCP config — e.g. `~/.cursor/mcp.json` →
`mcpServers.metistry` = `{url, headers: {Authorization: "Bearer ${env:…}"}}`
(`:372-374`, `docs/ops/cli.md:525`).

**The arrow points outward: an external agent consumes Metistry's `/mcp`.**
Connectors are the exact opposite — Metistry consumes a third party's MCP and
re-serves it to its own agents. They are different enough that sharing a word
between them will cause a bug. §4.1.

### 3.7 The egress door

`packages/core/src/egress.ts:1-48` — a loopback HTTP CONNECT proxy on port
7814, an **exact-match hostname allowlist** (no wildcards, no suffix rules),
and **a bearer per confined child** because *"loopback is not a trust boundary
(invariant 8) and because the audit row for a refusal has to be able to say WHO
asked."* The Seatbelt profiles (`ops/sandbox/assistant.sb`, `reconciler.sb`)
deny every outbound destination except the console, Postgres and this port.

This is the ready-made answer to "a connector's stdio child will phone home".
§4.3 puts connector children behind it.

### 3.8 Registry patterns already in the product

Three things to copy rather than invent:

- **Compute providers** (`packages/core/src/compute.ts:215-271`) — the closest
  analogue: a named registry of third-party endpoints, each with
  `auth.secret` that is *"the NAME of a Keychain item, never a value"*
  (`:130-134`), a `locality: on_machine | off_machine` flag (`:218`), an
  optional `zdr` (`:225`), and a **required** `data_policy` for anything
  off-machine (`:419-423`): *"what may leave this machine is a declaration, not
  a default."* §4.11 lifts this wholesale.
- **Targets** (`targets/github-issues/manifest.yaml`) — `data_policy {allow,
  deny_sources, max_brief_bytes}`, enforced by the console's dispatch tool, not
  by prose.
- **Instances** (`docs/ops/instances.md:10-11`) — *"this is a **registry**
  feature, not a mesh one. So Metistry takes the registry and skips the mesh:
  no libp2p, no control [plane]"*, with S6 held at BORROW-LATER (`:139-149`).
  The disposition a connectors registry should inherit: a list and a
  credential, not a fabric.

**The Mac app already has the UI pattern**: Settings sections are a closed
Swift enum — `instance, services, connections, compute, secrets, updates,
advanced` (`apps/macos/sources/kit/settings-model.swift:54-74`), rendered by a
switch (`settings-view.swift:56-62`). A Connectors pane is one case plus one
view function.

**And `.metistry/connectors/` is already protected.** `isProtectedPath`
(`packages/core/src/instance-layout.ts:227-233`) returns true for *everything*
under `.metistry/` except `state/`. The reconciler would refuse an assistant
write to a connector manifest **today, with no new code** — invariant 2 holds
for free.

### 3.9 What is missing — precisely

Everything above is either the outbound direction, a first-party bridge this
repo builds and ships, or a registry of something that is not an MCP server.

**Missing: an inbound registry of third-party MCP servers that Metistry
proxies to its own agents.** Concretely, all of:

1. A place to declare one (`connectors/<name>/manifest.yaml`).
2. A client that speaks MCP *upstream* — Metistry is only ever a server today.
3. A supervised, sandboxed home for a stdio upstream process.
4. A policy layer between an agent's request and that upstream.
5. A lazy exposure shape that does not blow the 776-token budget.
6. A `connector_calls` read path and the Agents/System views over it.

Items 1, 4, 6 are largely assembly from parts that exist. Items 2, 3, 5 are the
genuinely new code, and they are small.

---

## 4. The Connectors model

### 4.1 The name — a three-way reconciliation

Four words are now in play for two things, and one of them is already a core
type.

| Word | Whose | Means | Problem |
| --- | --- | --- | --- |
| **connectors** | the owner | proxied third-party MCP servers | none — but it is not the designer's word |
| **Resources** | the designer (Settings ▸ Resources) | the same thing | **collides twice**, below |
| **Connections** | shipped | the Mac Settings pane holding console sign-in, the instance repo and a compute summary (`settings-model.swift:57,70`) | already a poorly-named pane; one letter from "Connectors" |
| `connect` | shipped | `metistry connect <tool>` — the **outbound** arrow (§3.6) | a verb, so it survives |

**"Resources" collides twice, and both collisions are load-bearing.**

1. **With this repo's own core type.** `packages/core/src/access.ts:490-518`
   already defines `export type Resource` — the closed union `may()` decides
   over (`tool`, `toolset`, `knowledge`, `query`, `project`, `action`,
   `console`) — and `:48` defines `ResourceClass = "knowledge" | "artifact" |
   "machinery" | "outside"`. "Resource" in this codebase means *any governed
   thing*. **On the real documents this turns out to be agreement, not
   collision**: C58 and HANDOFF §3 use "resource" in exactly that broad sense
   (*"one line per resource"*, of which a proxied server is *"one more
   resource row"*), and `screen-09-resources.md` §1 justifies the word by
   analogy — *"a **resource** in exactly the sense Knowledge already is: one
   thing, defined once, lent to several agents, routines and projects on
   different terms."* The two vocabularies mean the same thing. An earlier
   draft of this section called it a collision on the strength of a narrower
   summary; that was wrong and is withdrawn.
2. **With MCP itself — this one stands.** MCP's own primitives are **tools,
   resources and prompts**. A screen called Resources whose detail view
   governs which *tools* a proxied server may run reads, to anyone who knows
   the protocol, as the screen for MCP `resources` — and the audience for
   this screen is by construction someone who has heard of MCP servers. It is
   a real hazard and a small one; a subtitle naming servers rather than
   resources would discharge it.

**Recommendation, revised against the real documents.**

- **Accept Settings ▸ Resources as the user-facing name.** It is ratified
  (C57), drawn (`boards/resources.py`), and justified by the Knowledge
  analogy. The one residual risk is MCP's own `resources` primitive, above.
- **The screen is where a connection is DEFINED; the permissions table is
  where it is GRANTED** — two surfaces, by the screen's own ruling, not one.
  §4.13 follows this.
- **Internally the noun stays `connector`** — manifests, `metistry
  connectors`, `runs.kind = connector_call`. Note the code cannot reuse
  "resource" even though the concepts agree, because `Resource` is already
  taken by the `may()` union; the internal name has to differ for a
  mechanical reason rather than a conceptual one.
- **The shipped Settings ▸ Connections pane is superseded, not renamed.** The
  drawn section list is General · Compute · Knowledge · Resources ·
  Notifications · Advanced (`lib.py:3277`), against the shipped enum
  `instance · services · connections · compute · secrets · updates · advanced`
  (`settings-model.swift:54-74`). That is a whole re-cut of Settings and it is
  the designer's, not this document's. The earlier recommendation to rename
  Connections → This Mac is **withdrawn** — there is no Connections section in
  the new list at all.
- **Still worth doing:** stop using the bare noun "connection" for the
  *outbound* arrow and say **client** (`docs/ops/cli.md:525`, the `connect.ts`
  header). `metistry connect` keeps its name; a verb reads differently from a
  plural noun. This is the only naming change this document still asks for.

Rejected: *gateways* (infrastructure vocabulary the rest of the product
avoids) and *integrations* (Executor's word for the catalog half of a two-noun
model Metistry is deliberately collapsing to one).

### 4.2 The manifest

Invariant 5. `<instance>/.metistry/connectors/<name>/manifest.yaml`, lowercase
per the casing rule (it is under `.metistry/`, not the vault), validated by the
same zod union in `packages/core/src/manifest.ts` and by CI.

```yaml
name: github                     # lowercase kebab, the namespace for its tools
type: connector                  # a new member of the manifest union
description: Issues and pull requests on the repos this instance watches

upstream:
  transport: stdio               # stdio | http
  command: npx                   # stdio only
  args: ["-y", "@modelcontextprotocol/server-github"]
  # url: https://api.example.com/mcp      # http only
  # egress_allow: [api.githubcopilot.com] # http/stdio: hostnames added to the
  #                                       # egress allowlist for THIS child only

auth:
  # The NAME of a Keychain item, never a value — compute.ts:130-134's rule.
  secret: METISTRY_CONNECTOR_TOKEN_GITHUB
  # How the upstream receives it. `env` for stdio; `header` for http.
  via: env                       # env | header | oauth
  env_var: GITHUB_PERSONAL_ACCESS_TOKEN

locality: off_machine            # on_machine | off_machine (compute.ts:218)
data_policy:                     # REQUIRED when off_machine (compute.ts:419-423)
  deny_sources: [comms]
  max_arg_bytes: 8192

scope:
  roles: [assistant]             # which principal roles may see it at all
  crews: [research]              # plus named crews; empty = none
  # `uses: [connectors]` in a crew manifest is still required — two gates.

tools:                           # the allow-list. An upstream tool absent here
                                 # DOES NOT EXIST as far as any agent is
                                 # concerned — C58, "absence is the denial".
  - name: get_issue
    verb: read                   # read | write — which permissions COLUMN this
    mode: on                     #               tool rolls up into (§4.13)
  - name: search_issues
    verb: read
    mode: on
  - name: add_issue_comment
    verb: write
    mode: ask                    # DEFAULT for verb: write (C59)
    rate_limit: { per_hour: 20 }
  - name: create_issue
    verb: write
    mode: ask
  # everything else on this upstream: absent ⇒ never reachable

rate_limit: { per_hour: 200 }    # connector-wide ceiling
timeout_ms: 20000
```

**`mode` is `on | ask | off`** — the designer's three states (C61), and `ask`
**is** preview-then-confirm, with no separate flag saying so. It replaces the
`read | confirm | never` vocabulary an earlier draft of this document used;
the machinery is identical and the words are now the product's.

**`verb: read | write`** is what makes the permissions table possible: C58's
table has one row per resource with **Read and Write columns**, so every
admitted tool has to belong to one of them. Default it from the upstream's
`readOnlyHint` annotation when present, require it in the manifest when not —
never guess from the tool's name.

Deliberate absences. **No `discovery:` field** — connectors are lazy, always,
by §4.6; a field implies a choice the arithmetic does not leave open. **No
`destructive:` flag** — C61 forbids a second "previews first" marker, and
`mode: ask` already carries the whole meaning. **No credential value, ever** —
`auth.secret` is a Keychain item name and the manifest is a git-tracked file in
a protected path.

### 4.3 Where an upstream runs

**Both kinds run under the supervisor, on the host, as confined children —
never inside the console process and never inside the assistant's sandbox.**

- **stdio.** The supervisor spawns the command as a child
  (`childSpecSchema`, `packages/core/src/supervisor.ts:60`), with a Seatbelt
  profile in the `ops/sandbox/*.sb` family and `HTTP_PROXY`/`HTTPS_PROXY`
  pointing at the egress proxy with **its own bearer**
  (`packages/core/src/egress.ts:36-48`). The child's allowlist is exactly
  `upstream.egress_allow` — so a connector that is supposed to talk to GitHub
  cannot talk to anywhere else, enforced at the proxy rather than in the
  profile, which is the whole reason #230 exists. Environment: the closed
  safe-list pattern from `executor:packages/plugins/mcp/src/sdk/stdio-connector.ts:26-50`
  (proxy vars + CA paths) **plus** exactly the one variable `auth.env_var`
  names, injected from the Keychain at spawn and never written to `.env`.
- **http.** No child; the console's connector client dials the URL, through the
  egress proxy, with the credential attached as a header.

**Process lifetime.** One long-lived child per stdio connector, pooled, with
the upstream's `tools/list` cached and invalidated on `notifications/tools/list_changed`
— Executor's connection pool exists for exactly this reason and spawning `npx`
per call would make every connector call multi-second.

**A `runs_on: host` connector is not a portability violation** (invariant 7):
the manifest names a command and the supervisor resolves it; nothing hardcodes
a path. A connector whose command is missing reports `absent` through `check()`
like any other degraded component.

### 4.4 Auth and secrets

Three rules, two of them already law in this repo and one from the MCP spec.

1. **The credential is a Keychain item name in the manifest and a value only in
   the Keychain** — `packages/cli/src/secrets.ts:1-18` and
   `packages/core/src/compute.ts:130-134`. `metistry connectors add` mints or
   stores it; `metistry secrets list` shows the name and never the value.
   Names follow the existing convention (`METISTRY_CONNECTOR_TOKEN_<NAME>`
   ends in `_TOKEN`, so `SECRET_SUFFIXES` already classifies it).
2. **The agent never sees it.** Same rule Executor states
   (`executor:apps/docs/mcp-proxy.mdx`); here it is structural, because the
   agent's only reachable surface is `/mcp` and the credential is attached
   inside the console.
3. **The agent's own bearer is never forwarded upstream.** This is not a
   preference; the MCP authorization spec (2025-06-18) says *"the MCP server
   **MUST NOT** pass through the token it received from the MCP client"*, and
   naming the failure mode — confused deputy — in the code comment is worth
   the two lines.

**OAuth (P3).** Driven by the CLI or the Mac app, never by the assistant: the
console performs RFC 9728 discovery against the upstream, opens the system
browser for the OAuth 2.1 + PKCE flow with a `resource` parameter naming the
upstream, and stores the refresh token in the Keychain. The engine has no shell
and no browser (invariant 9); a flow that needs a human at a browser is
therefore a flow the assistant structurally cannot start, which is the correct
answer rather than an inconvenience.

### 4.5 The tool policy

The allow-list in §4.2 is the control, and it is an **allow**-list by
construction: an upstream tool that is not named does not appear in
`connectors_list`, is refused by `connectors_call`, and — the part that makes
it a control rather than a filter — the refusal happens **before** the upstream
is dialled, in the same `may()` call every other refusal takes.

| `mode` | Drawn as | What happens |
| --- | --- | --- |
| `on` | **On** | runs immediately — one `runs` row, response redacted, no human |
| `ask` | **Ask** (+ the one glyph, C58) | **preview-then-confirm**: the call returns `{preview, confirm_token, expires_in_sec}`, **nothing has happened upstream**, and a request lands in Needs You — or is deferred and reported, if nobody is there (§4.10) |
| `off` | *absent from the table* | not listed, and the call is refused naming the manifest |

**`on` is permitted for a write tool, and this reverses an earlier
recommendation in this document.** A previous draft argued that no write should
ever run without a human. C59 rules otherwise: *"a destructive tool DEFAULTS to
Ask, is not forbidden from On."* The brief is right and the earlier position was
paternalism dressed as safety — the owner who has watched a connector open the
same kind of issue forty times should be able to say so, and the control that
matters is that **the default is Ask and moving it to On is the owner's hand in
a protected file**, never a prompt and never an agent's request.

Per-tool `rate_limit` and a connector-wide ceiling are counted from `runs`
(`SELECT count(*) … WHERE kind='connector_call' AND ts > now() - interval '1 hour'`)
— no new table, and the limit is therefore auditable by the same query that
reports usage. A `mode: on` write tool is the case rate limits exist for.

**Argument constraints: recommended out of P1.** Executor has none and it shows
(§1.6); the temptation is a little expression language, and a little expression
language in a security control is how one gets a bypass. The honest P1 answer
is that `mode: ask` *is* the argument control — a human reads the preview — and
that a declarative constraint (`args.owner ∈ [foldedspacelabs]`) is a P2+
decision with its own misuse tests, per invariant 8's *"misuse tests ship with
the interface"*. Note that C59 admitting `on` for writes raises the value of
this later: `on` plus an argument constraint is a much better answer than `on`
alone.

### 4.6 Exposure to agents — lazy, because the numbers say so

§3.2 settles this. Namespaced-eager `<connector>_<tool>` costs 3,244–3,964
tokens per connector against **776** remaining, i.e. CI fails on the first
connector installed. Three candidate shapes:

| Shape | Eager cost | Verdict |
| --- | --- | --- |
| **A.** Namespaced eager `github_create_issue`, … | +3,244–3,964 **per connector** | **Impossible.** `check-tool-surface.mjs` fails the build. |
| **B.** A per-connector sub-mount (`/mcp/github`) | 0 on `/mcp`, but the engine must be configured per connector | **Rejected** — it re-creates the owner's original problem: a cloud engine cannot be handed a new endpoint per connector. §4.14. |
| **C.** One lazy pair — `connectors_list` + `connectors_call` | **~300–400 tokens, once, for any number of connectors** | **Recommended.** |

The C estimate is anchored, not guessed: `request_access` is one tool with one
parameter and cost **189 definition tokens** (`ops/scripts/check-tool-surface.mjs:83-86`).
`connectors_list` (one optional `connector` filter) and `connectors_call`
(`connector`, `tool`, `args`, `confirm_token?`) are comparable, so ~300–400 for
the pair — leaving ~380–480 tokens of headroom rather than being 3,200 over.
**This must be measured before P1 ships, by the existing `toolSurface()`
path**, and if the pair comes in over ~400 the descriptions get trimmed, not
the ceiling raised.

The shape:

- `connectors_list({connector?})` → for each connector the agent's principal
  may see: its name, description, and **allow-listed tool names with one-line
  descriptions and their `mode`** — but **not** input schemas. This is the
  index; it is a tool call, so it costs nothing until used, and its *result*
  is bounded by the manifest rather than by the upstream.
- `connectors_call({connector, tool, args, confirm_token?})` → the call.
  Returns `{schema}` as a structured error when `args` fail validation against
  the upstream's schema, which is how the model learns the shape without the
  schema ever riding in a definition.

This is PoC-17's `lazy` and Executor's `search`/`invoke` arriving at the same
place. The one deviation from Executor: **no free-text search**. A Metistry
install will hold a handful of connectors with a few dozen allow-listed tools
between them, which `connectors_list` returns in full; a ranked search over
that is machinery with nothing to rank.

**The count axis.** Two new tools takes brain from 26 to 28 eager.
`COUNT_ACKNOWLEDGED = { brain: 26 }` (`check-tool-surface.mjs:87`) would have
to move to 28 — deliberately, with the reasoning written into that constant the
way `request_access`'s was. That is the intended mechanism, not a workaround:
*"Recording it here rather than waiving it makes the next tool a DECISION"*
(`:60-63`). **It is also an owner decision** (§5.3), because the script's whole
design is that this number changes only when someone argues for it.

### 4.7 Is a connector call an action? — invariant 10

The ask says argue this, so: **both readings are defensible and the
recommendation is a new action kind, narrowly constructed.**

**The case against (`connector_call` is not an action).** `docs/ops/actions.md`
defines the enum's meaning as *"something the console can already do through an
existing service with an existing audit row — an action adds a door, never a
power."* Dispatch, task_update, comment and capture are all doors onto services
the owner's own click goes through. A connector call is **not** — it is a call
to a third-party system the console could not previously make at all. On this
reading, admitting `connector_call` empties the enum of meaning: its `args`
would have to be `{connector, tool, args: unknown}`, an open payload inside a
closed set, and the property that makes `actionSchema`
(`packages/core/src/actions.ts:97`) checkable is exactly that every kind's
arguments are closed.

**The case for.** Invariant 10's operative clause is *"a new action is a
**product change**, never a prompt or a config line."* That clause is satisfied
precisely: the kind `connector_call` ships once, in a release, in
`actions.ts`, with CI and misuse tests. What a *config line* can then do is
only **choose among tools the owner personally admitted** — because the
manifest lives under `.metistry/`, which `isProtectedPath` already makes the
user's hand (`instance-layout.ts:227-233`), enforced by the reconciler refusing
the write rather than by asking. The set of reachable (connector, tool) pairs
is closed and enumerated; it is enumerated **per install** rather than per
release. And the alternative is worse: if a connector call is not an action,
then `mode: ask` needs a *seventh request type* and a second approval
path beside the six answers, which fragments the one queue the whole product
funnels through.

**Recommendation: one new kind, `connector_call`, with its `args` schema closed
to `{connector: name, tool: name, args: record, confirm_token: string}` and a
hard rule that its effective mode can never be `allow` below
`act_within_scope`** — plus, unlike the other four, **no `allow` at any level
in P1–P2**, so every write is a human's Approve. Default in the autonomy table:
`deny` at every level, including `act_within_scope`. The owner widens it per
agent, by hand, exactly as `dispatch` already works.

Name the cost honestly: the enum's one-line description changes from "doors
onto existing services" to "doors onto existing services, plus one door onto
the connector service, whose reach is itself enumerated by the owner's hand."
That is a real weakening of a crisp sentence, and it is the load-bearing
judgement in this document. **It is the owner's call** (§5.3, and it is the
first thing to settle because §4.10 and the console routes both hang off it).

**What the designer's brief adds, and why it does not change the
recommendation.** C56 says a proxied server is *"a row in the same permissions
table … and **no new primitive**."* Read literally that is an argument against
a fifth action kind. But the primitive C56 is refusing is a new *permissions*
primitive — a second grant model beside the table — and this proposal adds
none: a connector is a row, its provenance is Through Metistry, and `may()`
decides it over the union it already owns. On the wire, the alternative is
strictly *more* new machinery, not less: C59 requires that Ask *"raises a
request in Needs You"*, and the thing that makes a request's **Approve actually
do something** is the `action` kind (`docs/ops/actions.md`: *"An `action` is the
second kind whose Approve does something"*). Not adding an action kind
therefore means adding a **new request type** *and* a second execution path
beside the six answers — two new primitives to avoid one. So the brief's
instinct and this recommendation agree; only the word "primitive" differs.
Still the owner's ruling.

### 4.8 Scope — who may see a connector

Two gates, both existing:

1. **The connector's own `scope`** (§4.2) — `roles` and `crews`. Resolved into
   the `may()` decision as a new `Resource` variant `{kind: "connector", name}`
   on the closed union (`access.ts:490-518`), so a scope miss is refused at the
   same door, with the same `Refusal`, as everything else.
2. **The crew's `uses`** — a new group `connectors: ["connectors_list",
   "connectors_call"]` in `CREW_TOOL_GROUPS` (`manifest.ts:183-211`). Its own
   group, for the reason `rooms` and `actions` are theirs: *"acting is a new
   power, so a crew gains it only when the user edits the manifest, never by a
   release."*

A crew therefore needs **both** `uses: [connectors]` and its name in a
connector's `scope.crews`. Belt and braces, and cheap: the first is a release-
proof capability gate, the second is per-connector.

**C52 simplifies `scope.roles`.** The brief rules that the assistant *"never
appears on Agents … it IS the user, unscoped."* If the assistant is unscoped,
then `scope.roles: [assistant]` is not a narrowing at all — it reads "the owner
may use this", which is true of every connector the owner installed. So
`scope.roles` earns its place only for the roles that *are* scoped: `crew`,
`agent` (external, enrolled via `metistry connect`) and `tool`. Recommend
dropping `assistant` from the vocabulary of that field entirely and defaulting
it to the empty list — **every connector is reachable by the assistant, and by
nobody else until the owner names them.** That is both simpler and the safer
default, and it falls out of the brief rather than being added to it.

Note the warning in `CREW_NEVER_TOOLS` (`manifest.ts:219-231`): `queries_run`
is forbidden to crews because a named query *"is not filtered by a crew's
scope/projects the way every other group here is."* A connector has the same
property — its reach is the upstream's, not the vault's. The two-gate design
is the answer, and if it proves insufficient the honest next step is putting
`connectors_*` on the never-list and reaching connectors only through the
assistant.

### 4.9 Auditing

**Zero schema change.** `runs.kind` is `text NOT NULL` with no CHECK
(`db/migrations/0001_init.sql:9-23`), and the existing `wrap()` already writes
a two-phase row for every tool call. A connector call writes:

| Column | Value |
| --- | --- |
| `component` | the calling principal's id (`wrap()`'s existing behaviour) |
| `kind` | `connector_call` |
| `tool` | `<connector>.<upstream_tool>` |
| `ok` / `error` | outcome, or the refusal code |
| `duration_ms` | the upstream round-trip |
| `meta` | `{connector, upstream_tool, mode, args: <redacted+summarised>, turn_id, principal_role, proposal_id?, bytes_out, bytes_in}` |

Arguments go through the existing `summarizeArgs` and `redactSecrets`
(`redact.ts:12`) before they are stored — an argument is as likely to carry a
token as a response is.

**Refusals are rows too.** `wrap()` already writes the refusal with its reason
(`server.ts:288-293`). "It tried to call a connector tool it does not hold" is
therefore answerable from the ledger on day one, which is the property
Executor's design cannot offer at all.

**One named query**, `connector_calls` (invariant 3 — `packages/queries` is the
only thing that talks to Postgres), seeded under `seed/queries/` beside
`runs_export` and `run_detail`, parameterised by connector, principal, since,
and ok. The console's Agents and System views read it through the same
route-backed path everything else does. `metistry connectors list` shows call
counts from the same query rather than computing its own.

### 4.10 Approvals — pause when interactive, defer when unattended

A `mode: ask` call is **two round trips and one human**, reusing eventkit's
shipped mechanism (`packages/mcp-eventkit/src/index.ts:33-48`) rather than
inventing one:

1. The agent calls `connectors_call` without `confirm_token`. The console
   resolves the upstream tool, validates `args` against its schema, **does not
   dial the upstream**, and returns `{preview, confirm_token, expires_in_sec}`.
   A `runs` row records the preview with `ok: true, meta.mode: "preview"`.
2. It simultaneously raises an `action` proposal of kind `connector_call` in
   **Needs You**, carrying the human-readable preview and the connector,
   tool and redacted arguments.
3. The owner answers with **the same four answers a card carries** —
   Approve · Revise · Decline · Later (`screen-09-resources.md` §4: *"answered
   with the four answers every request takes"*). Approve runs it (through
   the connector service, as the deciding principal, with `source_agent`
   recorded as `on_behalf_of`, exactly as `docs/ops/actions.md` already
   specifies); Revise keeps the reason and settles without running; Decline and
   Skip settle; **Later** snoozes and the row returns.
4. On Approve the console calls the upstream with the **server-held** resolved
   call — Executor's own hard-won lesson is worth copying verbatim: the
   approved payload is *"the SERVER-BUILT emission — never the string the
   iframe sent … an iframe cannot widen its own grant between pause and
   resume"* (`executor:packages/core/sdk/src/pending-approval.ts:37-43`). The
   `confirm_token` binds to the **canonicalised payload** and is single-use
   (eventkit `:39-42`), so a replayed or mutated confirm is a `conflict`.

The confirm token's TTL should be human-scale — eventkit's `CONFIRM_TTL_MS` and
Executor's 15 minutes agree — and expiry is safe by construction because
nothing has run.

**A failed call leaves the request pending (C45).** If the upstream throws,
times out or 500s after Approve, the console writes `payload.error` and **the
row stays pending** — no retry, nothing half-applied. This is not new
behaviour: `docs/ops/actions.md` already rules it for every action kind (*"A
failure writes `payload.error` and leaves the row pending: one action is one
service call, so nothing is half-applied"*), and a connector call inherits it
by being an action kind. A scope or policy refusal does the same. Worth stating
because an upstream is far likelier to fail than a local service is, so the
rule that was an edge case for `task_update` is the common path here — and it
is another reason a connector call should be one upstream call, never a
sequence.

**Defer-and-report, when nobody is there (C59).** *"Ask means pause when
interactive, defer when unattended … a routine at 6:02 AM has nobody to ask, so
the run finishes without that step and reports what it skipped."* This is the
one requirement the pre-brief design did not have, and it is a real behaviour
change rather than a rendering one:

- `connectors_call` resolves an **interactive** bit from the run's origin, not
  from the principal's role — the same credential answers a user's message at
  11 AM and a routine at 6:02 AM. The honest source is how the turn was
  started (a user-facing turn vs a scheduled routine or collector run); it
  should ride in the call's `_meta` beside `turn_id` (`turn-id.ts`) rather
  than becoming a tool parameter, for exactly the reasons that field moved
  there.
- **Unattended + `mode: ask` ⇒ skip, and say so.** Not an error, not a block,
  not a request nobody asked for. `connectors_call` returns a distinct outcome
  — `{skipped: true, reason: "waits_for_you", connector, tool}` — the `runs`
  row records `meta.mode: "ask", meta.outcome: "deferred"`, and the run's
  report carries the skipped list so the routine's output says what it could
  not do. A refusal would make the routine look broken; a silent omission
  would be worse than either.
- **A Needs You row IS raised, and this corrects an earlier draft.** This
  document first recommended raising nothing, on the grounds that a request
  arriving hours after the run finished has no live context. `screen-09-resources.md`
  §4 settles it the other way and is right: *"The output carries* I would have
  commented on PROJ-412 — that needs your approval*, **and the request lands in
  Needs You**. Nothing blocks, nothing is half-applied, and the fact is reported
  rather than silently dropped."* Both things happen — the run's output names
  the skipped step, and the request queues — because the alternative drops a
  decision the owner would have made. The deferred row is an ordinary request
  and `Later` already handles the case where it has gone stale.

**Auto-approve rules.** With C59 admitting `mode: on` for writes, standing
consent is already expressible *in the manifest*, by the owner's hand, per
tool — which is the right place for it and makes a separate auto-approve
mechanism unnecessary. So: none, in any phase. The autonomy table still gates
whether an agent may raise a `connector_call` at all (§4.7); what happens once
it does is the manifest's answer, not a second table's.

### 4.11 Redaction, and what may leave the machine

**Responses are redacted on the way back**, not only arguments on the way out.
`scrubModelOutput` and `redactSecrets` (`redact.ts:6-48`) run over every
upstream response before it reaches the agent. Executor does not do this and
the omission is worth not repeating: an upstream that echoes a webhook secret
or an `Authorization` header into an error message is an ordinary event.

**`locality` and `data_policy`** are lifted from compute
(`compute.ts:218,419-423`) with the same rule: `off_machine` **requires** a
`data_policy`, because *"what may leave this machine is a declaration, not a
default."* For a connector the relevant fields are `deny_sources` (a call whose
arguments carry comms-derived provenance is refused) and `max_arg_bytes`. A
`locality: on_machine` connector — a local filesystem or SQLite server — needs
none.

### 4.12 Health

`check()` per connector (`packages/core/src/check.ts:9-27`): dial the upstream,
`initialize`, `tools/list`, and compare the result against the manifest's
allow-list. Three useful verdicts fall out for free — `ok`, `degraded` (the
upstream dropped a tool the manifest names — a real and under-appreciated
failure mode), `absent` (command missing or credential unset). `metistry
doctor` picks it up generically, exactly as it does for bridges and collectors,
because that is what the `Checkable` interface is for.

### 4.13 CLI, console, app

**CLI** (`docs/ops/cli-style.md` conventions):

```
metistry connectors add <name> --stdio "npx -y @scope/server" [--secret VAR]
metistry connectors add <name> --url https://… [--oauth]
metistry connectors list                       # name, transport, tools, health, calls/24h
metistry connectors test <name>                # check() + tools/list diff vs the manifest
metistry connectors policy <name>              # print the allow-list and modes
metistry connectors remove <name>
```

`add` **scaffolds the manifest with every tool at `mode: off`** and prints
the upstream's tool list for the owner to promote by hand. Opt-in rather than
opt-out: a connector installed and forgotten is inert, and the owner's editor
is the only thing that promotes a tool. `policy` prints; it never writes — the
manifest is a protected path, so editing it is the owner's hand by design, and
a CLI verb that wrote it would be a second door onto a file invariant 2 says
has one.

**Console.** Read-only routes (`GET /api/connectors`, `GET
/api/connectors/:name`) plus exactly the closed action set — which, per §4.7,
is `connector_call` and nothing else. **No route creates, edits or deletes a
connector**: that is a file in a protected path and stays the owner's hand
(invariant 10 — *"a new action is a product change"*).

**Mac app — rewritten against the drawn screen (`screen-09-resources.md`,
`boards/resources.py`, `boards/lib.py:3189-3283`).** There are **two** surfaces,
and the screen's own sentence is why: *"Defining it belongs in one place;
granting it belongs in the permissions table of whatever is being granted.
Those are two different questions."*

**(1) Settings ▸ Resources — where a connection is defined.** Its own window,
not a pane in the main one (`lib.py:3255` `settingswindow`), reached from a
section list drawn as General · Compute · Knowledge · **Resources** ·
Notifications · Advanced (`lib.py:3277`). The list is
`SERVER · KIND · TOOLS · GRANTED TO` with a leading state dot
(`lib.py:3194-3196`), and **Granted To is the column that earns the screen** —
it answers *who can reach my work Jira*, with **"Nobody yet"** a real value
because *"a connected server that nothing uses is a credential sitting there
for no reason."* One connection shows four facts — Endpoint, **Credential:
*Held by Metistry — never handed to an agent***, **Reachable From: *This
machine only***, Last Checked (a time **and how many tools were discovered**) —
which are *"the security model stated as facts on the object rather than as
reassurance in a paragraph."*

**(2) The tool table — `TOOL · WHAT IT DOES · [On|Ask|Off]`**
(`lib.py:3232-3252`), one segmented three-state control per tool, **drawn in
weight and fill, never in colour** (amendments §1.1: *"A permission is not a
moral position"*). The drawn example is the read/write split made concrete:
`search_issues` On, `get_issue` On, `add_comment` Ask, `transition_issue` Ask,
`delete_issue` **Off**. The legend is the spec for §4.5's three modes,
verbatim: **On** *"runs when an agent calls it — no preview, because you chose
it"*; **Ask** *"shows what it would do, then waits for you in Needs You"*;
**Off** *"refused at the proxy, and not offered to the agent at all"*. And the
list is *"what the server said it has, the last time it was asked — a fact with
a timestamp, not a configuration"*, which is §4.12's `check()` output rendered.

**(3) The permissions table — where it is granted.** `Resource × Read ×
Write`, one line per resource, on a local agent, a connected agent and a
routine alike (C58, HANDOFF §3). **A proxied server is one more resource row,
marked *Through Metistry*** — the provenance value, confirmed
(`design-system-amendments.md` §3.2). **Absence is the denial**: no
Allow/Never control, and *"Edit sits on the section"* rather than in a cell.
The rollup this document reconstructed is right and the glyph is named: *"the
same three states are read off absence and one glyph — **listed is On, listed
with the clock is Ask, absent is Off**"* (`lib.py:3206-3208`). So the Ask
marker is a **clock**, and the states are set on Resources and only *read* in
the matrix — which this document previously had backwards.

**The rollup's information loss is deliberate, not an oversight.** A cell
cannot say *which* of a server's read tools waits. The screen accepts that
because *"the vocabulary is one thing seen from two sides"*, and D11 asks the
wire for **per-tool grants** *"held beside the agent's other permissions rather
than in a second place, so the matrix renders it as one more row"* — i.e. the
truth lives per tool and the cell is a summary of it. This document previously
carried the loss as an open question; it is answered and retired.

**Health** reuses the shipped `.ok / .degraded / .absent / .failed` roles
(`settings-view.swift:242-254`), and the screen adds the rule this document had
open: **an expired token is `degraded`, not `failed`** — *"the connection is
configured correctly and a fact about the world changed."* `failed` means
*"could not reach the server at all, with the error verbatim"*; `absent` means
*"configured by environment but the variable is unset — the variable named, not
spent."* Empty copy: *"No servers connected."* + *Metistry can reach servers
your agents cannot, and lend them*.

**C62 is open, and this document previously argued it closed — wrongly.** The
earlier draft said the fork dissolved because connectors need no separate
table. They do have one, and it is in Settings: *"Settings is a fixed,
non-resizable window and Resources now lives in it … a table of tool names,
descriptions and a three-state control does not survive
`accessibilityExtraExtraExtraLarge` in a window that cannot grow. **Either
Settings becomes resizable or Resources is not a Settings pane**"* (C62,
against `apps/macos/sources/kit/settings-view.swift:47`). That is a live fork
with a product consequence and it is **not** this document's to close; §5.4(b)
now carries it.

**Adding one** stays a wizard: paste a command or URL → test → store the
credential → the app writes the scaffold with **every tool at `off`** and opens
it in the owner's editor. "Reveal in Finder" is the editing affordance; there
is no in-app policy editor, by C58 and by invariant 2.

### 4.14 The problem the proxy actually solves

The owner's sentence — *"I can't always directly attach MCP servers to the
agent compute themselves"* — is the design's whole justification, and it is
worth being exact about the mechanics, because the answer is counter-intuitive.

The assistant's engine is an OpenAI-compatible chat completion on whatever
provider `compute.yaml` assigns — OpenRouter, say. **The engine has no MCP
client, no shell and no network reach of its own** (invariant 9). What actually
happens on every turn today:

1. `apps/assistant` builds the request, including tool definitions, and sends
   it to the provider over the egress proxy.
2. The provider's model emits a **tool-call intent** — a name and a JSON blob.
   It executes nothing.
3. `apps/assistant` receives that intent and dials **Metistry's own `/mcp`**,
   on this machine, with a local credential.
4. `wrap()` runs, `may()` decides, the body executes, a `runs` row is written,
   and the result goes back into the next message.

**So a cloud engine never reaches a local stdio connector — and never needs
to.** The tool call comes back to this machine, and the console executes the
upstream here, locally, with a credential that never left the Keychain. The
model contributed a string. The provider sees the connector's *tool
definitions* and *results* (which is exactly what `data_policy` and redaction
are for) and never sees the connector, the credential, or the machine.

That is the proxy's point, and it is why this works where attaching an MCP
server to the compute could not: **the one surface the engine can reach is
`/mcp`, so extending `/mcp` is the only way to extend what the assistant can
do.** It is also why §4.6's option B (a sub-mount per connector) is wrong —
it would require configuring the engine per connector, which is the capability
the owner just said he does not have.

The corollary is that **a connector is reachable by any principal that can
reach `/mcp`** — including external agents enrolled via `metistry connect`
(Cursor, Devin). §4.8's two gates are what stop that from being automatic, and
the P1 default should be `scope.roles: [assistant]` with external agents
excluded until the owner names one.

---

## 5. Decisions

### 5.1 Build vs embed vs hosted

| | **Build our own** | **Embed an OSS gateway** | **Use Executor hosted** |
| --- | --- | --- | --- |
| Candidate | — | Executor (MIT/TS) or MetaMCP (MIT/TS) | Executor Cloud |
| Invariant 3 (one read path) | **holds** — `connector_calls` named query | **breaks** — a second datastore (SQLite/Postgres) nothing in `packages/queries` can see | **breaks** — the record is off-machine |
| Invariant 5 (manifest) | **holds** — `connectors/<name>/manifest.yaml` | conflicts — config lives in the gateway's own tables, not a manifest | conflicts |
| Invariant 8 (survives code visibility) | holds | holds | **weakens** — credentials for every upstream held by a third party |
| Invariant 9 (allowlisted surface) | holds — one more `/mcp` tool pair | holds | holds |
| Invariant 10 (closed mutating surface) | holds, with the §4.7 caveat argued | **breaks** — Executor registers integrations *via a tool call* (`executor:README.md:117-125`), i.e. its config surface is open to the agent | **breaks** |
| Approvals enforced at the tool | **yes** — preview-then-confirm + Needs You | **no** in the affordable mode — *"Your client handles approval"* (§1.6) | **no**, same |
| Durable audit | `runs`, **no migration** | none — OTel traces only (§1.7) | none |
| Data policy / locality | reuses compute's | absent | absent |
| Dependency cost | one internal module | **a second product**: Effect-TS, its own storage/ORM, OAuth service, React console, QuickJS. "Ask before adding a dependency" is not close on this one | a vendor, a network dependency, and the second-instance story fails on it |
| Offline / Docker-free macOS | fine | Docker for MetaMCP; Executor's CLI is Node but drags the whole tree | **fails** — needs the internet to call a local tool |
| Effort | **moderate** (below) | high (integration + reconciling two governance models) | low upfront, unbounded later |

**Recommendation: build.** The reasoning in one line: *the gateway mechanics
are the cheap half and Metistry has already built the expensive half to a
higher standard than either alternative.* Spawning a child, `tools/list`,
`tools/call`, an allow-list and a cache is a few hundred lines. Audit, grants,
approvals, redaction, secrets, egress, doctor and a UI language are the
expensive half, they exist, and adopting Executor means running a second,
weaker copy of each beside them.

Executor stays valuable as **prior art**, and §4 cites it where it is right:
the small default surface, the server-built approved payload, the closed stdio
environment safe-list.

### 5.2 Effort and phases

| Phase | Scope | New code | Rough size |
| --- | --- | --- | --- |
| **P1** | **Read-only stdio connectors.** `type: connector` in the manifest union; a `packages/connectors` upstream MCP client with a pooled stdio child under the supervisor + egress; the allow-list with `mode: on \| off` (reads only); `connectors_list`/`connectors_call` on `/mcp`; `runs` rows + the `connector_calls` query; `check()` → doctor; `metistry connectors add\|list\|test\|policy\|remove`; scope gate + crew `uses` group | manifest schema, connectors package, 2 brain tools, 1 seed query, 1 CLI module | **moderate** — one focused PR chain; the client is the only genuinely new thing |
| **P2** | **`mode: ask` + approvals.** Preview-then-confirm on the connector path; the `connector_call` action kind (pending §4.7's ruling); Needs You rendering with the card's four answers; **the C59 defer-and-report path for unattended runs** and the `interactive` bit in `_meta` it needs; **C45's failed-call-leaves-pending on the connector path**; `mode: on` for writes plus per-tool and per-connector rate limits from `runs`; response-side redaction hardening; misuse tests (invariant 8) | actions enum + schema, console action route, proposal payload, routine report, app/console rendering | **moderate**, and it is where the design risk sits |
| **P3** | **HTTP/SSE upstreams + OAuth + the permissions row.** RFC 9728 discovery, OAuth 2.1 + PKCE with `resource`, refresh in the Keychain; `locality`/`data_policy` enforcement; **the permissions-table row with Read/Write columns, the one glyph and Through Metistry provenance (C56/C58)**; the naming reconciliation in §4.1 | OAuth client, HTTP transport, SwiftUI rows | **larger**, and the phase the designer owns |

P1 is worth shipping alone: it answers *"still want to use information from
them"* completely, and it takes no position on the §4.7 question, which means
it can ship while that is still being argued. **The brief did not move the
phase boundaries** — C58/C61 are P3 rendering, C59 and C45 are P2 behaviour,
and P1's read-only shape needs neither. It did move work *into* P2 (the
defer-and-report path is new), which is also the phase that was already the
riskiest.

### 5.3 What needs the owner

1. **The §4.7 ruling** — is `connector_call` a fifth action kind? Everything in
   P2 hangs off it, and it is a considered weakening of invariant 10's crispest
   sentence. **Settle first.**
2. **`COUNT_ACKNOWLEDGED = { brain: 26 }` → 28** (§4.6). By that script's own
   design the number moves only when someone argues for it; two lazy tools that
   buy an unbounded number of upstream tools is the argument, and it is the
   owner's to accept.
3. **D11 vs §4.8 — where a per-tool grant lives** (§6.8(2)). The design wants
   it on the agent, beside its other permissions; §4.8 puts the allow-list in
   the connector's manifest, which is what makes invariant 2 hold for free.
   One fact, two homes. **Owner and designer together**, and it is the item
   most likely to change P1's shape.
4. **Whether external agents (Cursor, Devin) may ever hold `connectors_*`.**
   §4.14's corollary. Recommended P1 default: no. Note C52 narrows this:
   with the assistant unscoped, `scope` is *only* ever about crews and
   external agents (§4.8).
5. **The naming leftover** (§4.1). Settings ▸ Resources is ratified and this
   document's objections to it are withdrawn (§6.7). The one change still
   asked for is small: stop calling the *outbound* arrow a "connection" and
   say **client** (`docs/ops/cli.md:525`). Separately, `docs/ops/reply-feedback.md`
   and `docs/product/glossary.md` say "six answers" where the card now offers
   four (§6.6) — a docs fix somebody owns.
6. **Adding `@modelcontextprotocol/sdk` as a *client*.** It is already
   pre-approved in CLAUDE.md and already a dependency, so this is a
   notification rather than a request — but it is used only as a server today
   and the client half brings `StdioClientTransport` and `cross-spawn` with it.

### 5.4 Open questions

Six, re-cut twice. Four earlier questions were **answered** rather than
carried: rate-limit refusal vs queue and the registry's file layout became
recommendations in §4.5 and §4.2; the Read/Write rollup's information loss is
deliberate and sourced (§6.3); whether a deferred Ask raises a Needs You row is
settled — it does (§4.10). `check()`'s degraded-vs-failed question is answered
too: an expired token is **degraded** (§4.13). Their places are taken by C62 and
D13, which the design branch left open.

- **(a) Does a connector's reach need a vault-side scope at all?** §4.8 gates
  *who may call* a connector but says nothing about what a connector's
  *results* may touch. A crew scoped to `Areas/` that can call a GitHub
  connector reads GitHub regardless of its vault scope. That may be correct —
  the two are different resources — but it is the closest thing here to the
  `queries_run` leak the never-list was written for.
- **(b) C62 — resizable Settings, or Resources out of Settings?** Still open on
  the design branch and not this document's to close: *"a table of tool names,
  descriptions and a three-state control does not survive
  `accessibilityExtraExtraExtraLarge` in a window that cannot grow"*
  (`settings-view.swift:47`). A resizable Settings window is a Mac-app change
  with consequences past this feature. §6.5.
- **(c) D13 — can a resource be granted to a project or a team?** The
  designer's own fourth ask: *"a scoping axis nothing currently drawn has."*
  §4.8 grants to roles and crews; projects already exist as a scope dimension
  (`Scope.projects`), so the wire is closer to this than the drawings are.
- **(d) Where does the `interactive` bit come from?** §4.10 needs to know
  whether anyone is there, and the same credential answers a user at 11 AM and
  a routine at 6:02 AM — so it cannot come from the principal. Proposed: the
  run's origin, in `_meta` beside `turn_id`. Needs confirming against how
  routines actually dispatch turns.
- **(e) Are connector results knowledge?** If an agent calls `get_issue`, does
  the result get captured, folded, embedded? P1 says no — a result is a tool
  response and lives only in the turn. The alternative (connector results as a
  capture source) is a much bigger product question about provenance.
- **(f) One credential per connector, or per principal?** Arcade's per-end-user
  model (§2) is the more correct one for a multi-person future and is
  materially more machinery. P1 assumes one credential per connector, which is
  right for a single-owner install and wrong for a second instance with
  delegated agents. C56's *"the agent never holds the credential"* settles the
  storage question but not the identity one.

---

## 6. Designer brief alignment (round E, verified against the branch)

**Re-verified 2026-09-22 against `origin/design/round-0-plan-review`.** An
earlier revision of this section worked from the rules as relayed, because the
branch did not yet exist on the remote; that caveat is discharged and every
"unverified" mark below has been replaced with what the documents say. **Three
of this document's positions were wrong and are corrected in place** (§6.5,
§6.7, and §4.10's deferred-row recommendation); one reconstruction was right
and is now sourced (§6.3).

### 6.0 What was read

`git fetch origin` now resolves the branch. Read in full:
`docs/product/design/screen-09-resources.md`, `design-system-amendments.md`,
`review-00-plan.md` §7 (C45–C68), `HANDOFF.md`, `boards/resources.py`, and
`boards/lib.py:3189-3283` — the drawn components (`resourcelist`, `tristate`,
`toolrow2`, `toolblock`, `settingswindow`, `settingsnav`). `boards/resources.py`
is Python and was read, not run.

**One staleness to know about.** `resources.py`'s own FOUND panel still says
*"the nav is nine rows … Resources"*, while its `win()` already renders
`settingswindow` and C57 and `HANDOFF.md` §3 both put Resources **in Settings**.
The board was moved and its rationale panel was not. The `.md`, C57 and HANDOFF
agree with each other and are newer; §6 follows them.

### 6.1 The headline is unchanged, and stronger

The designer reached the ask's architecture independently and states it more
plainly than §4.14 does: *"Metistry can reach servers a remote agent cannot — a
work network, something behind a VPN, something IP-allowlisted. So it holds the
credential and **mediates**: an agent asks Metistry, Metistry asks the server.
The agent never sees the token."* And the sentence the whole screen exists to
make true: **"The credential never moves."**

The screen also reaches §4.2's structural conclusion by a different route:
*"`CLAUDE.md` requires every bridge to do **lazy tool discovery**,
**preview-then-confirm on destructive tools**, and **secret redaction by
default**. A proxied MCP server conforming to that contract inherits the
behaviour this screen would otherwise have to invent — which is the argument for
treating a proxied server as **a bridge, not a new species**."* §4.2 proposes
`type: connector` as a new member of the manifest union; the screen's argument
is that it should be as close to `type: bridge` as the schema allows. Both
agree the *contract* is the bridge contract. Whether they are one `type` or two
is a schema question §5.3 should carry — see §6.8(1).

### 6.2 Rule-by-rule, verified

| Rule | Status | What the documents actually say |
| --- | --- | --- |
| **C61** — On · Ask · Off | **confirmed, and drawn** | A segmented control per tool (`lib.py:3223-3231` `tristate`), selected segment by **fill and weight, never colour** (amendments §1.1). Legend verbatim in §4.13. The deleted second marker was real: *"An earlier draft marked destructive tools* Previews first *alongside the setting, which said two things at once and quietly overrode a deliberate **On**."* |
| **C58** — absence is the denial | **confirmed** | *"One line per resource"*, **Read and Write as columns**, *"anything not listed is not granted"*, *"one glyph marks a verb that asks first, and **Edit sits on the section**"* (HANDOFF §3). |
| **C56** — Through Metistry | **confirmed, value exact** | `design-system-amendments.md` §3.2 gives the provenance table; *"reached through a proxy | **Through Metistry**"*. HANDOFF §3: *"A proxied MCP server is one more resource row, marked Through Metistry; the server itself is defined on Resources."* |
| **C59** — pause vs defer | **confirmed, and one correction to this document** | The run *"finishes without it and says so"* — **and the request still lands in Needs You**. §4.10 previously recommended raising nothing; corrected. |
| **C45** — failed leaves pending | **confirmed** | Amendments §2.4, verbatim as §4.10 already had it. Adds: *"a screen must not draw a refusal as a decision."* |
| **C57** — the nav, and where Resources went | **new to this document** | Eight rows. *"**Resources was briefly a ninth and moved to Settings** … the test it failed is whether the owner goes there often, and a connection is configured once and then read from the permissions tables that grant it."* This is the real reason for the placement — §6.5. |
| **C62** — the fixed window | **still OPEN, and this document was wrong** | §6.5. |
| **C52** — the assistant is unscoped | **confirmed** | Amendments §5. §4.8's simplification stands. |
| **C53** — Allow · Ask First · Never | **resolved, not a drift** | These are the **renamed wire enums** `allow` / `propose` / `deny` (amendments §4). On · Ask · Off is the **proxied tool control**. Different objects, as §4.5 guessed. This document's "C53 vs C61" question is retired. |
| **four answers vs six** | **a real contradiction, reported** | §6.6. |
| **D9 · D11 · D12 · D13** | **new to this document** | The screen's own developer requests, §6.4. |

### 6.3 The rollup — this document's reconstruction was right, and the glyph is a clock

`screen-09-resources.md` §3.2, verbatim: *"In an agent's or a routine's
permissions matrix the same three states are read off absence and one glyph —
**listed is On, listed with the clock is Ask, absent is Off** — so the
vocabulary is one thing seen from two sides."*

So: cell absent = not granted; listed = On; listed **with a clock** = Ask. That
is exactly the three-state rollup §4.13 reconstructed, and the marker is named.
Two things the reconstruction had backwards, now fixed in §4.13:

- **The states are *set* on Resources and only *read* in the matrix.** This
  document implied the reverse.
- **The information loss is deliberate.** D11 asks for *"a **per-tool** grant,
  held beside the agent's other permissions rather than in a second place, so
  the matrix renders it as one more row"* — the truth lives per tool, the cell
  summarises it. This document's open question about the loss is retired.

How a per-server grant splits read from act is therefore answered twice over,
and C56's clause is the reason both exist: *"reading the owner's own vault is
not the same risk as acting in a system other people watch, so a per-server
grant cannot be one switch."* At the matrix it splits into **Read and Write
columns**; at the resource it splits into **per-tool** states — *"Nobody who
clicks* grant Jira *means* including `delete_issue`*. A server-level switch is
the shape that produces that mistake, so there isn't one."*

### 6.4 D9–D13 — the screen's own asks, against §4

The screen ends with four developer requests. All four land inside this
document's model, which is the strongest evidence the two are describing one
thing:

| Ask | §4 |
| --- | --- |
| **D9** — *"a registry of proxied servers: endpoint, credential reference, discovered tools with a discovery timestamp"* | §4.2's manifest, plus a discovery cache (§4.3) and `check()` (§4.12). The **timestamp** is new: §4.12 should record *when* the tool list was last read, because the screen renders *"4 minutes ago · 14 tools discovered"*. |
| **D11** — *"a **per-tool** grant, held beside an agent's other permissions rather than in a second place"* | §4.8's two gates need re-checking against this: the design wants per-tool grants **on the agent**, while §4.8 puts the allow-list **on the connector** with a `scope` naming principals. Those are two different places for one fact. §6.8(2). |
| **D12** — *"a proxy audit line … which is exactly what `runs` exists to record"* | **§4.9 exactly**, including the table. Independent agreement. |
| **D13** — *"whether a resource can be granted to a **project** or a team rather than an agent. The owner raised it; it is a scoping axis nothing currently drawn has"* | New. §5.4(f) is adjacent but not the same question. Added to §5.4. |

### 6.5 C62 is open, and this document argued it closed — wrongly

The earlier revision said the fixed-window fork *"largely dissolves"*, on the
reasoning that C56 makes connectors rows in an existing table so no new table
needs placing. That was wrong in both halves. There **is** a screen — Settings ▸
Resources, *"its own window, not a pane in the main one"* — and C62 is live:

> **"Settings is a fixed, non-resizable window and Resources now lives in it.**
> … putting a proxied server's tool table there makes it concrete — a table of
> tool names, descriptions and a three-state control does not survive
> `accessibilityExtraExtraExtraLarge` in a window that cannot grow. **Either
> Settings becomes resizable or Resources is not a Settings pane.**"
> — C62, against `apps/macos/sources/kit/settings-view.swift:47`

And the placement's real reason is C57's frequency test, not layout: Resources
was a ninth nav row and moved *"because a connection is configured once and
then read from the permissions tables that grant it."* So the fork is between
two things both already ruled — the window is fixed, and Resources belongs in
it — which is why it is open rather than merely undecided. It has a product
consequence (a resizable Settings window is a Mac-app change) and it is the
owner's and the designer's, not this document's. §5.4(b) now carries it.

### 6.6 Four answers or six — a contradiction to report, not resolve

`screen-09-resources.md` §4 says an Ask call is *"a request in Needs You,
answered with **the four answers** every request takes."* The shipped repo says
six (`docs/ops/reply-feedback.md:9-21`, `docs/product/glossary.md:36-47`), and
two shipped SVGs on the same branch still say six (`mac-needs-you.svg`,
`iphone-triage.svg`: *"six answers, fixed order"*).

It is not a mistake. `screen-03-needs-you.md` §3 settles it from the endpoint:
`POST /api/proposals/batch` takes `BATCH_DECISIONS = ["later", "skip", "deny"]`
and refuses the rest, so *"Four answers on a card, three on a selection; the
difference is not a simplification, it is the endpoint's own list quoted
back"*, and Skip *"came off the card as a fifth button and lives as a batch
verb."* Card = Approve · Revise · Decline · Later, plus Approve as Work where
the payload suggests one.

So the **wire** still has six decisions and the **card** offers four. §3.5 and
§4.10 now say this. What needs settling is the documentation, not the design:
`docs/ops/reply-feedback.md` and `docs/product/glossary.md` both say "six
answers" without qualification, and the two SVGs are round-D artefacts. Flagged
per CLAUDE.md rather than quietly harmonised.

### 6.7 What this document withdraws

Stated plainly, because a research document that quietly drops its own
arguments is worse than one that never made them:

1. **The "Resources collides with core's `Resource`" objection is withdrawn.**
   The design uses "resource" in the same broad sense core does (*"one line per
   resource"*; *"a resource in exactly the sense Knowledge already is"*). They
   agree. Only the MCP-primitive hazard survives, and it is minor (§4.1).
2. **"Rename Settings ▸ Connections → This Mac" is withdrawn.** The drawn
   Settings has no Connections section: General · Compute · Knowledge ·
   Resources · Notifications · Advanced (`lib.py:3277`). Settings is being
   re-cut wholesale and that is the designer's to do.
3. **"A deferred Ask raises no Needs You row" is withdrawn** — the screen rules
   the opposite and is right (§4.10).
4. **"C62 largely dissolves" is withdrawn** (§6.5).

### 6.8 What remains open

1. **Bridge or new species?** The screen argues a proxied server *is* a bridge
   (§6.1); §4.2 proposes `type: connector`. One `type` with a flag, or two?
   A schema decision, and it decides whether `check-tool-surface.mjs` and the
   bridge conformance suite pick connectors up for free.
2. **D11 vs §4.8 — where does a per-tool grant live?** The design wants it
   *on the agent*, beside its other permissions. §4.8 puts the allow-list *on
   the connector*, with `scope` naming principals. One fact, two homes; the
   design's is probably right (it makes the matrix render from one source) but
   it moves the allow-list out of the protected manifest, which is what made
   invariant 2 hold for free (§3.8). **This is the most consequential
   unresolved item.**
3. **C62** — resizable Settings, or Resources out of Settings (§6.5).
4. **D13** — granting a resource to a project or a team (§5.4).
5. **The discovery timestamp** the screen renders (*"4 minutes ago · 14 tools
   discovered"*) has no wire; `check()` is the nearest thing (§6.4, D9).
6. **Four answers vs six in the shipped docs** (§6.6) — a documentation fix,
   not a design question.

---

## Sources

**Local, verbatim (this machine, 2026-09-22).** Two stdio MCP servers, real
`initialize` + `tools/list`, counted with `JSON.stringify(tools).length / 4` —
the same rule as `ops/scripts/check-tool-surface.mjs:124-127`:

- `npx -y @modelcontextprotocol/server-filesystem <dir>` → 14 tools, 12,973
  chars, **3,244 tokens**.
- `npx -y @modelcontextprotocol/server-github` → 26 tools, 15,854 chars,
  **3,964 tokens**.

**Executor** — shallow clone read locally at `d27e6737` (2026-09-20);
repository metadata from the GitHub API 2026-09-22 (MIT, TypeScript, 3,956 ★,
created 2026-02-07, pushed 2026-09-22). <https://github.com/UsefulSoftwareCo/executor>,
<https://executor.sh>

- `README.md:19-21,74-82,87-96,113-125,143-155,186-206,196-197` — the thesis,
  the five packagings, `add-mcp`, integration registration, the SDK, the
  monorepo layout, the execution runtimes.
- `LICENSE:1-3` — MIT, "Copyright (c) 2026 Rhys Sullivan".
- `apps/docs/concepts/{integrations,connections,policies}.mdx` — the three
  nouns; `"Allow … Require approval … Block"`; spec-derived defaults.
- `apps/docs/mcp-proxy.mdx` — *"The tool list stays small as you add
  integrations"*; *"credentials never reach it"*; `?mode=passthrough`.
- `apps/docs/hosted/{cloud,tracing}.mdx` — free tier; OTLP export *"off by
  default"*.
- `TELEMETRY.md` — the exhaustive seven-event table and the "never sent" list.
- `packages/hosts/mcp/src/tool-server.ts:1300,1371,1456,1458-1459,2058,2073,2110`
  — the registered tool names and `invoke`'s *"Your client handles approval"*.
- `packages/hosts/mcp/src/passthrough-tools.ts:1-24,27-32` — the sandbox call
  grammar and the passthrough instructions.
- `packages/core/sdk/src/core-schema.ts:131-435,498` — the eleven tables;
  `ToolPolicyAction`.
- `packages/core/sdk/src/policies.ts:1-9,68-90` — owner precedence; the dotted
  address grammar.
- `packages/core/sdk/src/pending-approval.ts:1-22,31-34,37-43` — the durable
  single-use approval and the server-built payload.
- `packages/plugins/mcp/src/sdk/stdio-connector.ts:17-50` — the closed
  environment safe-list.
- `packagesets/plugins/` listing and `packages/plugins/mcp/src/sdk/connection-pool.ts`
  — the plugin set and the upstream connection pool.

**The field** — GitHub API, 2026-09-22 (licence / language / ★ / last push):
`docker/mcp-gateway` MIT/Go/1,579; `IBM/mcp-context-forge` Apache-2.0/Python/4,515;
`lasso-security/mcp-gateway` MIT/Python/390 (last push 2026-01-22);
`metatool-ai/metamcp` MIT/TypeScript/2,684; `sparfenyuk/mcp-proxy`
MIT/Python/2,761; `mcp-router/mcp-router` NOASSERTION/TypeScript/2,149
(*"support … ended 2026-09-18"*); `stacklok/toolhive` Apache-2.0/Go/2,206;
`ComposioHQ/composio` MIT/TypeScript/30,288; `ArcadeAI/arcade-mcp`
MIT/Python/1,032; `modelcontextprotocol/registry` NOASSERTION/Go/7,274;
`github/github-mcp-server` MIT/Go/33,130 (24 toolsets, no dynamic discovery);
`modelcontextprotocol/servers` NOASSERTION/TypeScript/90,551.

- Docker MCP Gateway — <https://docs.docker.com/ai/mcp-gateway/> (2026-09-22):
  *"isolated Docker containers with restricted privileges, network access, and
  resource usage"*; *"built-in logging and call-tracing"*.
- Cloudflare — <https://developers.cloudflare.com/ai-gateway/> (2026-09-22):
  *"analytics, caching, rate limiting, and model fallback"*, **no MCP
  mention**; `https://developers.cloudflare.com/cloudflare-one/llms.txt`
  returns one MCP entry, *"Detect MCP traffic in Gateway logs"*. Both
  `.../ai-gateway/usage/mcp/` and
  `.../cloudflare-one/access-controls/mcp-server-portals/` returned **404**. An
  MCP Server Portals product could not be verified today and is not claimed.
- Anthropic connectors —
  <https://support.claude.com/en/articles/11175166-about-custom-connectors-via-remote-mcp-servers>
  (2026-09-22): OAuth per connector, per-tool approval or *"Allow always"*,
  one custom connector on free plans, public-internet reachability.
- MCP authorization spec, 2025-06-18 —
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
  (2026-09-22): OAuth 2.1 + PKCE; RFC 9728 protected-resource metadata; RFC
  8707 resource indicators (*"MUST be included in both authorization requests
  and token requests"*); *"MCP servers MUST validate that access tokens were
  issued specifically for them as the intended audience"*; *"The MCP server
  MUST NOT pass through the token it received from the MCP client"*; the
  confused-deputy section.
- `executor.dev` (2026-09-22) — a Squarespace "under construction" page;
  unrelated to the subject.

**The designer's round-E work**, read at **`origin/design/round-0-plan-review`**
(fetched 2026-09-22, after an earlier revision of this document recorded the
branch as absent — it had not been pushed yet).

- `docs/product/design/screen-09-resources.md` — the whole screen: *"The
  credential never moves"*; the `SERVER · KIND · TOOLS · GRANTED TO` list and
  *"Nobody yet"*; the four connection facts; §3.2's three states, the
  *"listed with the clock is Ask"* rollup and *"per tool, not per server"*;
  §4's *"the four answers every request takes"*, the 6:02 AM Morning Digest,
  *"the run finishes without it and says so"*; §5's five states; §7's
  **D9 / D11 / D12 / D13**.
- `design-system-amendments.md` — §1.1 (*"A permission is not a moral
  position"* — permissions in weight, never colour); §2.4 (C45, verbatim);
  §3.1 (C58, *Resource × Read × Write*); §3.2 (the provenance table and
  ***Through Metistry***); §3.4 (C61); §3.5 (C59); §4 (the enum renames —
  `allow`/`propose`/`deny` → **Allow / Ask First / Never**); §5 (C52, C57).
- `review-00-plan.md` §7 — C45, C50, C52, C53, C56, C57, C58, C59, C61, C62,
  quoted where load-bearing. C62 is quoted in full in §6.5.
- `HANDOFF.md` §3 — *"Permissions are one table, everywhere they appear … A
  proxied MCP server is one more resource row, marked Through Metistry; the
  server itself is defined on Resources"*; the eight-row nav; §5's board index
  (*"Settings ▸ Resources … done — the connections, one connection, three
  states per tool"*).
- `boards/resources.py` — the drawn board (Python; read, not run). Its `win()`
  renders `settingswindow`; its FOUND panel is stale on the nav (§6.0).
- `boards/lib.py:3189-3283` — `resourcelist` (the list's grid and column
  heads), `tristate` (the segmented On/Ask/Off control), `toolrow2`,
  `toolblock` (the `TOOL · WHAT IT DOES` grid, the five example tools and the
  three-state legend), `settingswindow`, `settingsnav` (General · Compute ·
  Knowledge · Resources · Notifications · Advanced).
- `screen-03-needs-you.md` §3 — `BATCH_DECISIONS`, and *"Four answers on a
  card, three on a selection"* (§6.6). `mac-needs-you.svg` and
  `iphone-triage.svg` on the same branch still say six.

**Repo, read at `origin/main` `7ebc5ec`** — `CLAUDE.md` (invariants 1, 2, 3, 5,
7, 8, 9, 10, "enforce at the tool", the dependency rule, the packages
contract); `apps/console/src/server.ts:544`;
`packages/mcp-brain/src/server.ts:259-330`; `packages/mcp-brain/src/surface.ts:28-58`;
`packages/mcp-brain/manifest.yaml`; `ops/scripts/check-tool-surface.mjs:1-33,51-52,60-87,124-127`;
`packages/core/src/manifest.ts:12-69,183-241,262-330`;
`packages/core/src/access.ts:322-352,485-518,703,792-861`;
`packages/core/src/actions.ts:34-49,97-112,145-219`;
`packages/core/src/{auth,check,errors,redact}.ts`;
`packages/core/src/egress.ts:1-48`; `packages/core/src/compute.ts:107-134,205-271,292-322,419-423`;
`packages/core/src/instance-layout.ts:35-67,187,207-233`;
`packages/core/src/supervisor.ts:25-134`;
`packages/mcp-eventkit/{manifest.yaml,src/index.ts:1-48}`;
`packages/mcp-apple-fm/manifest.yaml`; `packages/cli/src/connect.ts:1-45,296-321,356-401`;
`packages/cli/src/secrets.ts:1-35`; `targets/github-issues/manifest.yaml`;
`db/migrations/0001_init.sql:9-25`, `0025_agent_role.sql`;
`seed/queries/{runs_export,run_detail}.yaml`;
`apps/macos/sources/kit/settings-model.swift:54-86`,
`settings-view.swift:43-62,242-254,282-320`;
`docs/ops/{actions,reply-feedback,cli,cursor,instances,targets}.md`;
`docs/product/{glossary,design-brief}.md`;
`docs/research/2026-08-tool-discovery.md:118-132`;
`docs/research/2026-09-19-grants-and-access-simplified.md`;
`ops/sandbox/{assistant,reconciler}.sb`.
