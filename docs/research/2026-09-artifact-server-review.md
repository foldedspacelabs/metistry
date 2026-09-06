# Artifact Server review — what to borrow, what to leave (2026-09-06)

Review of [plannotator/artifact-server](https://github.com/plannotator/artifact-server)
(site: artifactserver.com) as inspiration for Metistry's multi-agent
feature set and for the composable-architecture question. Companion to
`2026-08-agent-coordination.md`; propagated into the build plan as §4.20
(composable modules) and §4.21 (artifacts), plus Phase 5/6 items.

## What it is

An open-source (AGPL-3.0), self-hostable server where people and agents
publish, version, review, comment on, and share artifacts (HTML, images,
video, directories). Built with Effect on TypeScript; SQLite+disk locally,
Postgres+S3/Cloudflare D1+R2/Kubernetes remotely. Three adapters over one
application core: HTTP, MCP (`POST /mcp`), and a CLI. Roughly 27 ADRs and
~35 specs in `project/spec/`, with a conformance ledger tying every
requirement to evidence.

The feature set that overlaps our plan:

| Feature | Their shape |
| --- | --- |
| Versioned artifacts | Every save is an immutable version inside a project; `expectedCurrentVersionId` compare-and-swap on publish; idempotency keys everywhere |
| Comments | Threads on an exact version (optionally a path + opaque anchor), one-level replies, `open`/`resolved`; author denormalized at write time (`principalKind: human\|service`, `authorizedByPrincipalId`) |
| Agent dispatch | A human selects threads, picks a *registered agent*, sends one **bundle**; the agent claims it under a 5-minute lease, replies + resolves; `addressed` is *inferred* from resolution, never reported |
| Presence | Registry is liveness only (upsert on a stable connection key, the claim long-poll is the heartbeat, stale rows reaped); dispatch rows are the durable thing |
| Delivery evidence | `native` / `channel` / `mailbox` tiers — the UI must not dress a weak tier as a strong one |
| Kanban | Project-scoped `kanban_cards` table (ADR 0024) — first-class records, not an artifact, because an artifact write is an immutable version |
| Linked artifacts | A file that stays on disk; owner sees live bytes, everyone else sees a captured snapshot (ADR 0023) |
| Tool-result nudges | Server appends one terse "N bundles queued — call `dispatch_inbox`" block to every MCP tool result for mailbox-tier agents (design, not shipped) |
| Security | One `Principal` from every credential (ADR 0002); untrusted artifact bytes served from an **isolated wildcard content origin**, never the application origin; private content via single-use bootstrap → 15-minute version-scoped cookie |

## Where it agrees with what we already decided

Most of this is convergent evidence, not new direction:

- **One application core, thin adapters** (their ADR 0016) = our invariant 3
  (one read path) generalized to writes. HTTP, MCP, and CLI must not become
  three products. We already do this for reads; §4.20 makes it the rule for
  the mutating surface too.
- **Atomic claim + lease + heartbeat, pull not push, handles not payloads,
  server-side identity** — identical to §4.19's primitives, arrived at
  independently (their ADR 0021 + bridge protocol). The convergence across
  Beads, Claude Code Agent Teams, and now this is strong enough to stop
  researching and build §4.19 as written.
- **"An agent's message can never carry user authority"** — their comment
  author carries `principalKind` and `authorizedByPrincipalId`; ours labels
  agent-sourced rows everywhere they surface. Same rule.
- **Kanban as records, not a versioned document** — exactly the reasoning
  behind `work` being a Postgres table while knowledge lives in git.
- **Local owner mode with no login ceremony, private team mode with real
  identity** (ADR 0025) mirrors our host-as-root-of-trust passkey design
  and the hosted-tier plan; they also say plainly that a tailnet is
  *ingress, not authorization* — our invariant 8 in their words.

## What to borrow

1. **Artifacts as a first-class record type (§4.21).** Agents (Metis,
   crews, external sessions) produce plans, mockups, reports, and HTML
   pages that today have nowhere to live except a chat reply or a vault
   note. An artifact is *the reviewable output of agent work*; the brief,
   a design doc, a dashboard snapshot, a PR review. Our version is cheaper
   than theirs because **git already gives us immutable versions**: an
   artifact is a directory under the instance repo, each version is a
   commit, and Postgres holds only the index (invariant 1 satisfied, no
   object store to build). What we take from them is the *contract*:
   stable-vs-exact-version links, compare-and-swap publish, idempotent
   commit, and the review link handed back first.
2. **Comment threads on an exact version, with dispatch-to-agent.** This is
   the missing half of our proposal loop: today feedback flows
   *user → proposal decision → agent inbox*; comments let the user annotate
   the artifact itself and send a **bundle** to the agent that made it. The
   bundle/lease/`addressed`-is-inferred lifecycle drops straight onto §4.19's
   `work.claim`/`heartbeat` machinery: a dispatch *is* a `work` row of kind
   `review` whose payload is thread handles.
3. **The delivery-evidence ladder.** Our agents span the same three tiers
   (Metis in-process = native; a Claude Code session with the plugin =
   channel; a plain MCP client = mailbox). The status page must show which
   it is. Cheap, honest, and prevents the "queued" ≠ "working" confusion
   their spec calls out.
4. **Tool-result nudges** for mailbox-tier agents. Pull-only MCP has no
   push channel; appending one line ("2 items in your inbox — call
   `inbox.claim`") to every `mcp-brain` tool result is how the hub gets
   attention without steering. Deterministic, server-side, zero model
   involvement — fits invariant 4 and the enforce-at-the-tool principle.
5. **Bundle rendering + Unicode sanitization.** Comment text lands inside an
   agent's context. Strip bidi overrides and zero-width characters at the
   render boundary; never start a rendered message with `/`. Belongs in
   `core` next to redaction.
6. **Isolated origin for untrusted HTML.** Rendering agent-authored HTML on
   the console origin is XSS against the passkey session. We already
   output-encode agent text (CRIT-7); artifacts that *are* HTML need a
   stronger boundary. Two candidates for open decision #14: a second
   hostname on the tailnet (their model — strongest, but a second cert and
   route per install) or a `sandbox` iframe without `allow-same-origin`
   plus a strict CSP (an opaque origin; one hostname; weaker against
   framing tricks). Decide before any HTML artifact renders in the PWA.
7. **The conformance ledger habit.** Every requirement ID maps to a test or
   evidence file. We have misuse tests per interface (invariant 8); a
   ledger is the index over them. Low cost, adopt when the CLI lands.

## What not to borrow

- **The code.** AGPL-3.0 is incompatible with our Apache-2.0 product repo.
  Inspiration and contract shapes only; nothing copied.
- **Effect as the application framework.** Their ADR 0001 builds the whole
  core on Effect (services, layers, `Redacted`). We hand-roll (§7) and
  have ~5 pre-approved deps; a framework of that weight is the maintenance
  obligation CLAUDE.md warns about.
- **An object store and staged-upload API.** Solved by git + the instance
  repo for artifacts of our size. If a 200 MB video artifact ever matters,
  that's a `POST /capture`-style upload into `inbox/`, not S3.
- **WorkOS/OIDC/MCP OAuth.** Passkeys + per-agent bearer tokens (§4.11) are
  the decided single-user model; the hosted tier revisits identity later.
- **Multi-target deployment matrix** (Cloudflare, Helm, Pulumi ×2). Docker
  compose on one host is v1; invariant 7 keeps the door open without
  shipping five installers.
- **Comments as a separate product from the proposal queue.** Theirs has no
  triage budget; ours does (D10). Comment threads feed the same
  `proposals`/inbox flow rather than a fourth notification surface.

## Composability — the question the review actually raises

Artifact Server is usable by a stranger through three adapters because
*one* application layer owns policy and every adapter is thin. Metistry's
packages rule (`npx @foldedspacelabs/metistry-mcp-<name>` must work cold)
already applies this to bridges. The gap: the *state-holding* pieces —
task ledger, knowledge store, artifact store, proposal queue — are
currently console internals, not modules. §4.20 fixes that by naming the
modules, what each exposes, and the shared contracts that make them one
system when composed. Deliberately **not** a microservice split: modules
are packages with a data contract, deployed inside the console container
by default.

## Integration option: Artifact Server as a *target*

Because it speaks MCP with a stable tool surface, Artifact Server also
qualifies as a §4.18 compute/collaboration target for someone who already
runs one (a work team, say): `type: target, transport: mcp`, publishing a
brief or report there instead of into the instance repo. Zero adapter code
on our side — the MCP-first discipline paying off. Not planned; noted so
the option isn't rediscovered.
