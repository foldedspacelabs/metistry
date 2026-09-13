# SAM (Sovereign Agent Mesh) review — a mesh under `/mcp`, or beside it? (2026-09-13)

Owner prompt: [google/sam](https://github.com/google/sam) — "evaluate Google's
SAM agent mesh to see if it's a good fit for Metistry to expose tools, mcp
servers, or grow the network of Metistry resources over time … I'm wondering if
this is better than externally using the tailnet as it's a more complete
solution that's tailor made to allow agent communication across disparate
networks."

Read from the repo at `main` and the GitHub API on 2026-09-13. Sources at the
end. Nothing was run locally; no SAM binary was executed.

## What SAM is

A **peer-to-peer overlay network for agents, in Go**, Apache-2.0,
`v0.1.0-alpha.9` (2026-09-07). It does not compete with MCP or A2A — it is the
**transport and authorization layer underneath them**; MCP, A2A and
OpenAI-compatible inference are the three payload types it carries, addressed as
`mcp://<service>`, `a2a://<service>`, `inference://<service>`.

| Binary | Job |
| --- | --- |
| `sam-control-plane` | registry: enrollment, OIDC verification, Biscuit minting, roles/bindings policy, router coordination. Postgres or SQLite behind it. |
| `sam-router` | libp2p bootstrap + **circuit-relay v2** with an ACL; QUIC and WebSocket; the DHT. |
| `sam-node` | the per-machine daemon: libp2p host, discovery, and a **local MCP sidecar on `127.0.0.1:8080/mcp`**. |
| `sam-box` | one per agent *sandbox*: a CONNECT/connect-udp gateway enforcing egress policy. No mesh identity. |
| `sam-one` | all-in-one: control plane + router + storage, one binary, one public port. |

Plus `sam-console` (web UI), `sam-a2a-bridge`, and a Flutter mobile node —
**Android only; no `ios/` directory exists in the tree.**

**Provenance matters.** It sits in the `google` org, copyright Google LLC, but
the README ends: "This is not an officially supported Google product. This
project is not eligible for the Google Open Source Software Vulnerability
Rewards Program." ([README][s-readme]) `aojea` has 1256 of roughly 1500 commits,
`kaisoz` 158, then a long tail of single digits: one very good networking
engineer's project wearing a Google-org badge. Cadence is high (≥100 commits in
the last 30 days).

## Trust model

**OIDC at the door, Biscuit on the wire.** `sam-node join <control-plane>`
authenticates against an OIDC provider (Dex in their deployments) or presents a
bootstrap token; the control plane verifies the JWT, turns its claims into
Datalog facts (`user`, `email`, `group`, `role`) and mints a
[Biscuit](https://www.biscuitsec.org/) signed with its Ed25519 key. The JWT never
touches the datapath again ([policy][s-policy]). The Biscuit is **bound to the
libp2p peer ID** (`check if client_peer_id($id), connection_peer_id($id)`) — per
*node*, so a stolen token cannot be replayed elsewhere.

**Per-agent identity is deliberately weaker.** An agent's facts ride as an
attenuation block appended to the node's token — "the residual trust, stated
plainly: an enrolled node asserts its own agents" ([agent-architecture
§3][s-arch]). A role's `allowed_agents` namespace grant bounds it; proof of
possession by the agent itself is an upgrade path, not built. **Revocation** has
visible rough edges: open issues [#390][s-i390] (revocation-cache keying) and
[#367][s-i367] (bootstrap nodes cannot recover after signing-key retirement).

**Policy is default-deny, two-layered.** The control plane holds roles
(`allowed_targets`, `allowed_agents`, `allowed_services`) and bindings, set by
`POST /policies` with an admin bearer; nodes hold an optional local
`attenuation:` block of raw Datalog, evaluated *before* baseline rules, that can
only narrow — the "autonomous local veto". Nothing is reachable until granted:
"all of its services … are completely locked down and inaccessible to other
peers" ([policy][s-policy]). **The granularity is the thing to notice:**

> The service is the unit of authorization — deliberately. Mesh policy does not
> filter individual MCP tools inside a service. ([policy §2][s-policy])

Two privilege tiers means two registered services (`mcp://db-reader`,
`mcp://db-writer`). SAM authorizes *names*, never tools.

## Control node, data plane, and how tools are exposed

`sam-control-plane` is a registry and a CA, not a proxy: **agent traffic does
not transit it**. Data flows peer-to-peer over libp2p, relayed by `sam-router`
when direct dialling fails, so it sees who exists, what roles they hold and
which services are registered — never prompts or payloads. Lose it and no node
enrolls and no policy changes, but existing nodes keep authorizing offline
against cached Biscuits and local attenuation: a good failure mode. Data plane:
QUIC + WebSocket, `AutoNATv2`, Kademlia DHT, circuit-relay v2 with a router-side
ACL refusing reservations from unauthenticated peers; discovery is **GossipSub**,
providers announcing routing keys (model IDs, tool names) on shared topics with
a 5-minute consumer interest TTL. NAT traversal is real and needs no public
endpoint *per node*, but it needs one publicly reachable router **and** a
control plane — `sam-one` collapses both into one binary on one port.

**The closed-laptop problem is untouched.** A `sam-node` on a sleeping Mac is a
peer that does not answer, and SAM has no wake path — what
`docs/research/2026-09-11-multi-instance-and-offline-client.md` already concluded
(O4). Swapping the tailnet for a mesh changes nothing about availability.

A node's `sam-node.yaml` registers services as a spawned stdio subprocess
(`command: [...]`) or as a **proxy to an already-running Streamable HTTP MCP
server** (`target_url: http://localhost:9001/mcp`) — the second form is exactly
how Metistry's console `/mcp` would be published: one YAML entry, no code change
([node-configuration][s-nodecfg]). Consumers then see a **local MCP server** on
their own node (`127.0.0.1:8080/mcp`, `X-Sam-Authentication: Bearer
$SAM_API_TOKEN`) with four tools — `discover_remote_services`,
`find_remote_tools`, `describe_remote_tool`, `call_remote_tool` — and discovery
of what exists at all runs through a grant-gated built-in catalog,
`system://sam.catalog` ([claude-code][s-cc]). SAM's pitch: *your agent talks to
one local MCP endpoint, and the mesh makes every other node's tools reachable
through it.* Metistry's: *your agent talks to one authenticated `/mcp`, and the
console makes every Metistry capability reachable through it.* The same sentence
at different layers.

## Host, observability, footprint, maturity

Static Go binaries (`CGO_ENABLED=0`) for linux/darwin/windows × amd64/arm64,
`curl | bash` installer, ghcr images, Helm charts for the control plane;
`sam-node run --daemonize` forks and writes PID/log/token under
`~/.config/sam-mesh`. **No macOS codesigning, notarization or launchd
integration anywhere in the repo** — packaging is our problem. Observability is
Prometheus metrics, a log buffer, the console UI and `sam-bench`; there is **no
centralised audit log** — the control plane's SQL store holds enrollment and
policy, not calls. Footprint: **143 Go modules** (libp2p and its
multiformats/DHT/pubsub constellation, `biscuit-go`, `go-oidc`, `a2a-go`, the
MCP Go SDK, `pgx`, `bbolt`, `modernc.org/sqlite`, Prometheus, cobra, zap), plus
an optional `sam-mcp-python` client SDK and Python examples.

Maturity: every release is `v0.1.0-alpha.x`; the ROADMAP puts the third-party
security audit in Phase 3, unstarted, and calls Alpha "Under Construction /
Ephemeral"; there is **no `SECURITY.md`**. The public testnets carry "no
guarantees, no uptime commitments, zero SLA" and using them "delegates identity
management to the testbed maintainers" ([README][s-readme]). Open issue
[#383][s-i383] reports the headline jurisdictional label gate is
"caller-supplied and fail open when omitted" — the flagship guarantee has a
known hole.

## Three architectures for exposing Metistry's tools

### A — today's plan: tailnet + `/mcp`

Reachability from the Tailscale tailnet the home gateway already runs, with a
node on the Studio. Identity and policy from the console: passkey sessions and
the loopback-bound `METISTRY_LOCAL_OWNER_TOKEN` for the owner; per-agent bearer
tokens (`agents` rows) for everything else, with `scope`, `projects`, `autonomy`
and tool *groups* checked server-side at the bridge and a uniform 403 outside
`/capture` and `/mcp` (`docs/ops/auth.md`). Off-machine work goes through
`dispatch()`, with the target manifest's `data_policy` enforced by
`checkBrief()` before a byte leaves (`docs/ops/targets.md`). Instances are
separate origins keyed by `instance_id`; `GET /api/identity` is the one
unauthenticated read.

- **Gives:** per-tool-group policy, per-agent revocation, one `runs` row per
  call, content-level data policy at dispatch, zero new components or credential
  classes, an identity system the owner already has.
- **Lacks:** cross-instance discovery, capability advertisement, an agent
  identity meaning anything to a second instance, NAT traversal of its own.

### B — SAM as the mesh, console as the single exposure node

`sam-node` on the Studio with `target_url` at the console's `/mcp`; `sam-one`
somewhere public (the gateway) as control plane and router; every other agent
joins the mesh and reaches Metistry through its own local node.

- **Gives:** real NAT traversal without a tailnet; gossip discovery and
  capability advertisement; peer-ID-bound node identity; attested labels; a local
  Datalog veto; a story for machines outside the owner's network.
- **Costs, concretely:**
  - **A Go daemon per node** — on macOS a third-party binary the Mac app must
    sign, notarize and supervise. `docs/ops/mac-app.md` requires Login Items to
    show "One background item, called Metistry", so `sam-node` becomes a
    supervisor child and the FSL identity signs code we do not maintain.
  - **A second identity system.** OIDC is mandatory for enrollment; the owner
    has passkeys and tokens, not an IdP. Adopting SAM means standing up Dex or
    Keycloak *and* holding Ed25519 root keys, for two machines.
  - **A control plane to host.** `sam-one` is one binary, but it is a public
    port, an admin token, a database and an upgrade path beside the console. The
    public testnet is not an option: its README says it delegates identity to
    its maintainers.
  - **A second policy language** — Datalog roles/bindings beside `grants`,
    `projects`, `autonomy` and `data_policy`. Two places answering "may this
    agent do that?" is the drift invariant 3 exists to prevent, one layer up.
  - **Coarser authorization, not finer.** SAM authorizes `mcp://metistry` whole;
    `/mcp` authorizes tool groups per agent. Publishing through SAM means
    exposing the entire surface to any granted peer, or splitting `/mcp` into N
    services to recover granularity we have — a downgrade in a zero-trust badge.
  - **Invariant 5 and 6 friction:** SAM services are entries in one YAML file,
    not directories with manifests, and a host-native Go daemon is neither
    "native only where macOS requires it" nor containerised.
  - **Alpha** — no audit, no `SECURITY.md`, a known fail-open in the label gate,
    one load-bearing contributor.

### C — hybrid: a SAM-shaped registry, transport stays tailnet + HTTPS

Borrow the ideas — a directory of instances, capability advertisement,
instance-qualified agent identity, approve-before-enroll — as console endpoints
and instance-repo config. No daemon, no control plane, no second credential.
**Gives** every discovery and naming benefit the owner is reaching for, for a
few endpoints and one YAML file. **Lacks** cryptographic network identity and
NAT traversal — both supplied by the tailnet, neither a Metistry bottleneck.

## Is the mesh redundant because "the network is not a boundary"?

Mostly yes — the owner's zero-trust instinct is right while still pointing the
other way. A mesh's two jobs are **reachability** and **identity**. Metistry
decided reachability is the user's routing layer (invariants 7/8), and identity
is proven per request at the application layer: every `/mcp` call presents a
bearer resolving to one `agents` row whose grants and projects are read
server-side and cannot be widened by anything in the brief. SAM would also
authenticate the *pipe* — real defence in depth, but against an attacker already
inside the tailnet, and against that attacker `/mcp` already answers 403.

| SAM adds | Real? | Worth a control plane? |
| --- | --- | --- |
| NAT traversal across disparate networks | yes | not while one tailnet covers every machine the owner owns |
| Cross-instance discovery + capability advertisement | yes — Metistry has none | **take the idea; the mesh is not needed to have it** |
| Cross-instance agent identity | yes — a token means nothing to a second instance | obtainable by naming (`agent@instance_id`), not crypto, at this scale |
| Zero trust at the network/identity layer | yes | duplicates the tailnet's own device identity |
| Audit centralisation | **no** — SAM has metrics, not an audit log; `runs` is stronger | no |
| Attested data-residency labels | yes, but fail-open today (#383) | `data_policy` answers our actual rule (comms never leaves) better |

Honest scoreboard: SAM's one uncontested win over A is **discovery and
capability advertisement across instances** — a registry feature, not a mesh one.

## Verdict

**SKIP** as a dependency; **BORROW-LATER** the registry ideas, five of which are
small enough to build now. **The threshold is a count of administrators, not of
agents.** `/mcp` + tailnet
holds as long as one person authorizes everything and every machine sits on one
tailnet. Revisit when any of these is true:

1. **Agents run on machines the owner does not control** — a collaborator's
   laptop, a customer's box.
2. **More than one administrator**, so authorization must be delegable and
   third-party-verifiable: Biscuit attenuation genuinely beats a server-side
   grant row when the grantor is not the server's owner.
3. **Instances that cannot share one tailnet** — different orgs or
   jurisdictions; then relays beat routing.
4. SAM reaches `v1.0.0` past its Phase 3 audit with more than one load-bearing
   contributor.

Two instances and a growing crew list on one tailnet meet none of these.

## ADOPT — five ideas for `/mcp`, ranked

1. **Capability advertisement on `GET /api/identity`** — a coarse `capabilities`
   block (tool *group* names, counts of queries/projects/crews, nothing
   schema-level) on the one unauthenticated read. `system://sam.catalog` minus
   the mesh: the phone switcher and a second instance can name what an instance
   offers before sign-in. Keep SAM's discipline that discovery is itself
   grantable — the full `tools/list` stays behind an agent token.
2. **Approve-before-enroll for remote agents.** SAM's `join` leaves an enrollment
   PENDING until an administrator approves. A `POST /api/agents/enroll` creating
   a pending row the owner approves in the console (or `metistry agents
   approve`) is what "grow the network of agents" actually needs, and keeps
   invariant 2 — the credential surface stays the user's hand.
3. **Instance-qualified agent identity, `agent:<name>@<instance_id>`**, in
   `runs`, reports and artifact authorship: the same logical crew on two
   instances becomes one name in the record with no shared credential — the
   naming half of SAM's portable identity, none of the crypto.
4. **`instances.yaml`, a named registry of peer instances** in the instance repo
   (protected path): `instance_id`, origin, label — consumed by the phone
   switcher (O1) and by `metistry doctor` as a reachability row. At this scale a
   registry is a file, not a service.
5. **A `runs` NDJSON export** (`metistry runs export --since`) so two instances'
   timelines merge for the owner. Weakest of the five — and note SAM does *not*
   have this; its missing audit log is what made the gap visible.

## SKIP, with reasons

- **libp2p transport / relays** — the tailnet covers every machine the owner
  owns, and neither wakes a closed laptop.
- **The control plane** — a public port, an admin token and a database, to
  authorize one person's two instances.
- **Biscuit + OIDC** — a second credential class beside passkeys and agent
  tokens; invariant 8 asks for boring primitives, not more of them. (Keep
  Biscuit in mind for the multi-administrator future.)
- **Datalog policy** — a second policy language beside `grants`/`data_policy`.
- **`sam-box` / CONNECT sandboxing** — invariant 9 means no shell to confine
  (but see below).
- **Attested labels** — they solve residency; our rule is provenance, and
  `checkBrief()` already enforces it on content.

## One finding outside the mesh question

SAM's agent-architecture doc is direct prior art for **R1** in the plan refresh
(the loopback CONNECT proxy for the engine's host allowlist) and it contradicts
R1's own stated assumption — R1 is marked "*unverified*: that a spawned CLI
honours `HTTPS_PROXY`":

> **Proxy environment variables** are honoured only by HTTP-aware clients. A
> harness that opens a raw socket … or anything speaking gRPC or Postgres simply
> escapes. … An agent that has to *agree* to be confined is not confined.
> ([agent-architecture §2][s-arch])

Their answer — a TUN device plus `CONNECT` carrying the *name*, DNS resolved on
the host so a nameless flow is refused — is far heavier than R1 needs, but the
finding stands: an `HTTPS_PROXY` allowlist is a convention, not a control, and
"enforce at the tool, never by prompting" applies to environment variables too.
R1 should be re-scoped as defence in depth for a cooperating client, or dropped.
A smaller convergence: SAM will not let a sandboxed agent touch `sam-node`'s own
API socket because "arriving on its Unix socket *is* the credential" — which is
`docs/ops/auth.md`'s loopback rule, reached independently.

## Contradictions with the plan and notes

- **`docs/plan-refresh-2026-09-13.md` is not on `main`** — it is PR #141, still
  open; this note read it from the `claude/plan-refresh-2026-09-13` branch. Any
  task citing it as a path on main will fail.
- **R1's confidence** — contradicted by SAM's own design rationale, above.
- **No-Python (ruled 2026-08-29)** — SAM ships `sam-mcp-python` and Python
  examples. Moot unless SAM is adopted, but it would reopen that conversation.
- **Ask-before-adding-a-dependency** — SAM is 143 Go modules and a third
  language runtime in a TypeScript + Swift product. Flagging, not acting.

## Sources (all fetched 2026-09-13)

All under <https://github.com/google/sam/blob/main/>:

- [s-readme]: `README.md` · [s-roadmap]: `ROADMAP.md` · [s-gomod]: `go.mod`
- [s-arch]: `site/content/docs/agent-architecture.md` · [s-policy]: `.../development/policy.md`
- [s-nodecfg]: `site/content/docs/user/node-configuration.md` · [s-gw]: `.../user/secure-gateway.md`
- [s-cc]: `site/content/docs/integrations/claude-code.md` · [s-quick]: `.../quickstart.md`
- [s-i383]/[s-i367]/[s-i390]: <https://github.com/google/sam/issues/383>, `/367`, `/390`
- Repo metadata, releases, contributor counts: `gh api repos/google/sam{,/releases,/contributors}`
