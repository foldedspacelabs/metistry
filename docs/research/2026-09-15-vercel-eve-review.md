# Vercel Eve — how it configures agents, grants resources, shares state, and schedules (2026-09-15)

Prior-art review at the owner's ask: "a quick review of the vercel eve project
to see if there are lessons to be learned from how they configure and setup
agents … also for how they grant resources, share things between agents, handle
schedules, etc."

**Verdict.** Eve is the best-documented mainstream articulation of Metistry's
own "everything is a directory" instinct — and it is not a dependency or a
template for us. `eve` 0.55.0, Apache-2.0, beta under Vercel beta terms: it
pulls Nitro and the `@workflow/*` `5.0.0-beta` line, ships ~3 releases a day
(100+ commits in the last week), carries 854 open issues, and every default path
assumes AI Gateway, Vercel Sandbox, Vercel Connect, Vercel Cron and Vercel Blob.
Self-hosting is real but second-class. Six mechanisms are worth copying as ≤3-line
changes; the rest is multi-tenant SaaS machinery a single-human personal OS does
not need.

**Convergent validation worth naming.** Three contested Metistry choices appear
in Eve as independently-reached rules: a delegated child sees *nothing* of the
parent's history and the brief is the whole context transfer (§4.11); children
cannot delegate further (Eve's `agent` tool is root-only and declared subagents
never receive it — our `uses` refuses `agents_delegate`); and delegation is
explicitly not an approval boundary ("Do not rely on subagent delegation by
itself as an approval boundary"), which is invariant 2 restated by someone else.

---

## 1. What Eve is

A framework — not a product, not a template. `npx eve@latest init my-agent`
scaffolds; `eve build && eve start` serves a Nitro server; `eve deploy` puts it
on Vercel. "A filesystem-first framework for durable AI agents. Core agent
capabilities live in conventional locations." One root agent per app, assembled
from path-named slots under `agent/`: `agent.ts`, `instructions.md`, `tools/`,
`skills/`, `channels/`, `schedules/`, `connections/`, `memory/`, `hooks/`,
`sandbox/`, `subagents/`, `extensions/`. Created 2026-06-16; 5.1k stars, 543
forks, 255-commit lead author. `eve` declares two runtime deps (`nitro`,
`undici`) with `ai`, `braintrust`, `dd-trace`, `just-bash`, `microsandbox`,
`@opentelemetry/api` as peers — a small list over a large runtime.

## 2. Agent configuration

**Filesystem for structure, TypeScript for values.** The directory is the
manifest; there is no YAML agent manifest. `agent/agent.ts` calls
`defineAgent({ model, reasoning, compaction, limits, description, experimental })`
and may be omitted (Eve selects a default source pinned to
`openai/gpt-5.6-luna-fast`). `model` is a Gateway id or an AI SDK
`LanguageModel`; `reasoning` is `none|minimal|low|medium|high|xhigh`. `eve set
--model …` and the dev TUI's `/model` edit the source file — no runtime config
store, no UI-owned config.

**Eve derives a manifest instead of validating a hand-written one.** `eve build`
emits `.eve/discovery/agent-discovery-manifest.json` ("what eve found on disk"),
`diagnostics.json` ("authored-shape errors and warnings") and
`.eve/compile/compiled-agent-manifest.json` ("the serialized authored surface eve
loads at runtime"); `eve info [--json]` prints the resolved application,
discovered capabilities and routes. The inverse of invariant 5, and the more
ergonomic half of it.

**`defineDynamic({ events })`** lets a code resolver pick the model, connection
set, skill or subagent availability at `session.started`, `turn.started` or
`step.started` (precedence step > turn > session). Eve's own warning is the
argument against it: "prompt caches are per model, so every switch re-ingests
the conversation at uncached prices. Prefer `session.started`."

**Versioning and sharing.** Agents are source in git. Sharing is an
**extension** — an npm or workspace package contributing tools/channels/
connections/skills/schedules/subagents/instructions/hooks behind
`defineExtension({ config })` (a Standard Schema), mounted by the consumer and
namespaced (`crm__reviewer`) — or an **integration** in shadcn registry format
installed by `eve add`, which writes files into your project. An extension
"cannot declare agent configuration, instrumentation, memory, a sandbox, or
nested extensions." Environments are Vercel's, not Eve's.

**Skills** are `SKILL.md` progressive disclosure with a `description` as routing
hint, pulled in by a framework-owned `load_skill`; "loading a skill adds
instructions, never a new execution surface," and skills are scoped per agent.

## 3. Resource grants

**Grants are code and directory placement, enforced at the tool.** No grant
table, no per-agent scope document: what an agent can reach is exactly what is
authored or mounted under its own directory, and a declared subagent "inherits
nothing from the root's authored slots."

**Secrets.** One trust boundary, stated as a table: app runtime has
`process.env` and your Node code; the sandbox has neither. Tool `execute` runs
app-side, so "the model sees only `{ ok: true }`: the key never leaves the app
runtime." Connection tokens come from `getToken()` (called on every attempt;
optional `expiresAt` triggers proactive refresh) or OAuth, are "cached per step
and never serialized to durable state," and the model never sees a connection's
URL or credentials — it discovers tools via a built-in `connection_search` and
calls them as `<connection>__<tool>`. Authenticated egress *from* the sandbox is
credential brokering: headers injected at the sandbox firewall, secret never
inside.

**Integrations** are MCP (`defineMcpClientConnection`) or OpenAPI
(`defineOpenAPIConnection`) with `credentialOwner: "app" | "user"`. The
load-bearing rule: a user-scoped connection reached from a run with no end-user
principal — a schedule, a runtime token, `localDev()` — **fails** with
`reason: "principal_required"` rather than falling back to the app credential or
starting an OAuth flow nobody can complete. Interactive OAuth is Vercel Connect
or self-hosted `defineInteractiveAuthorization({ getToken, startAuthorization,
completeAuthorization })`, where Eve mints the callback URL and durably parks the
turn on a framework-owned webhook.

**Approvals** are per tool or per connection: `never() | once() | always()`, or a
policy over `{ toolName, toolInput, approvedTools, callId }` returning
`approved | denied | user-approval | not-applicable` with a reason. Default is
`never()`. Two details worth having: a separate `approval: { request, response }`
**response policy** decides whether *this* authenticated responder may approve
*this* call, and rejecting one "leaves the shared request pending so another
eligible responder can approve it"; and `once()` grants apply only after every
already-pending matching prompt resolves, so N in-flight calls are N decisions.

**Auth fails closed**: no matching `AuthFn` → 401, anonymous needs an explicit
`none()`, and the scaffold's `placeholderAuth()` keeps a half-configured app
closed in production. Channels must "verify signatures in constant time" and
"never trust body-supplied identity."

## 4. Sharing between agents

**Nothing is shared by default.** "A declared subagent inherits nothing from the
root's authored slots… `defineState` is never shared, for either kind. Each
child starts with fresh durable state." The exception is the root's built-in
`agent` tool, whose children are *copies* and so share its sandbox, tools,
connections and auth.

**Handoff is a tool call with one string.** Every subagent — local copy,
declared, extension-contributed, remote — lowers to the same model-visible
`{ message, agentId?, outputSchema? }`. "The parent packs `message` with
everything the child needs, since the child never sees the parent's history."

**Messaging and status.** A child parks after answering instead of terminating;
passing its `agentId` continues or *steers* it (Eve cancels the previous task
first). The mechanism worth stealing: whenever the set of parked children
changes, Eve **appends** a framework-injected `[Agents]` note carrying an
`<agents>` block listing each child's `agentId`, name and latest status —
appended only when the listing changes, "an append-only design that preserves
the provider prompt cache," with the system prompt telling the model the note is
injected by Eve, not written by the user.

**Completion batching.** Overlapping background work forms a cohort; successful
completions are held until every task in it settles, then delivered in one parent
turn — "partial completions do not invoke the parent model." No timer, no
config. Failures, input requests, authorization and cancellation bypass it.

**Audit.** The parent stream carries `subagent.called`/`subagent.completed` plus
interactive events proxied up from descendants so the root channel can prompt the
user; the child's own progress is a separate stream. `agent/hooks/` subscribe to
stream events *after* they are durably recorded — "handlers are observe-only.
They cannot inject model context." Memory is a slot per file with an eve-resolved
scope (`byPrincipal`) and swappable provider; recalled content "enters model
context as user-role messages attributed to the slot, never as system
instructions."

## 5. Schedules

One file per schedule under `agent/schedules/`, name path-derived, extensions
prefixing the name without changing the cron.
`defineSchedule({ cron, markdown | run })` — exactly one, enforced by the
compiler — and the markdown form may be a plain `.md` whose frontmatter takes
`cron` and nothing else.

- **Markdown = task mode**: fire-and-forget, output discarded, "cannot park to
  wait for a person or an OAuth sign-in."
- **Handler `run({ to, waitUntil, appAuth })`** has no channel of its own, so it
  picks a target with `to(channel, target).send(msg, { auth })`; it *can* park.
- **Conditional delivery needs no flag**: "eve tells the agent how to finish
  successfully without sending anything to the channel."
- **Principal**: markdown schedules run as `{ authenticator: "app", principalId:
  "eve:app", principalType: "runtime" }`; handlers must pass `appAuth`. Approval
  policies match those three fields to skip prompting automated turns.
- **Timezones**: 5-field cron, minute granularity, **UTC** on Vercel. `eve dev`
  never fires schedules; a dev-only `POST /eve/v1/dev/schedules/:id` fires one
  once through the production path.
- **Cost caps**: `limits.{maxInputTokensPerSession, maxOutputTokensPerSession,
  maxTokenCostUsdPerSession, sessionTimeoutMs}`, checked independently, enforced
  before the *next* model call (the crossing call finishes; usage arrives late).
- **Retries**: ≤3 fresh model-call attempts for classified transient provider
  failures, repeating only the current uncommitted call; otherwise Workflow's
  durable step retry from the last committed snapshot.
- **Failure surfacing is the platform's** — Vercel Observability → Cron Jobs and
  → Logs. Nothing framework-level aggregates failures, and **no missed-run
  semantics are documented**; Vercel Cron does not backfill, and on a custom
  HTTP-only host "the schedule definitions still compile, but they will not fire
  automatically."

**The reachability rule, the best idea here.** On hitting a usage limit Eve
branches on whether a human can be reached. An interactive session parks and
offers **Approve** ("grants a fresh window of each configured size") or **Stop**
("a user decision, not an error"). Sessions that cannot reach a human —
"task-mode runs such as schedules and delegated runs without input proxying" —
skip the prompt and fail the next model call with a named error,
`SESSION_TOKEN_LIMIT_REACHED` or `SESSION_TOKEN_COST_LIMIT_REACHED`.

**Quota inheritance.** A child "receives a share of the delegating parent's
remaining quota at dispatch time — the remainder in the current budget window
split evenly across the batch's local subagent calls — and a completed child's
usage counts against the parent's quota… An authored child limit applies only
when it is tighter than the parent's grant." Narrowing-only, on money.

## 6. Also notable

- **Sandboxing.** One sandbox per agent at `/workspace`;
  `defineSandbox({ backend, bootstrap, onSession, revalidationKey })`; backends
  Vercel microVM, Docker, microsandbox or custom; per-session network policy,
  changeable mid-turn (`setNetworkPolicy`, `"deny-all"`).
- **"Authored markdown is data."** "The code-capable engines (`---js` /
  `---javascript`, which would `eval()` the frontmatter body the moment the file
  is parsed) are disabled, so such a fence throws rather than running.
  Frontmatter has to parse to a plain YAML object."
- **Model routing: none.** No rules layer, no deterministic router — static
  config or a code resolver.
- **Evals are first-class**: `evals/**.eval.ts`, `defineEval({ test })`, one
  `evals.config.ts`, `t.succeeded()`/`t.calledTool()`/`t.check()`, LLM-as-judge
  (`judge: { model }`), Braintrust reporters, `mockModel()` for deterministic
  fixtures. "Evals exercise the same HTTP surface your users hit."
- **Name collisions fail the build**: "eve rejects static collisions at build
  time and active dynamic collisions at runtime rather than picking a winner."
- **Non-interactive install contract**: `eve add <item> --non-interactive` prints
  NDJSON and exits `0` done / `1` failed / `2` "setup needs an answer or an unmet
  prerequisite"; on `2` the final event carries `next.command`, and "never pass a
  secret in `--answer`."
- **CLI telemetry is on by default** (`eve telemetry disable`), with a documented
  collect/don't-collect list.

---

## 7. Comparison — the four axes

**Configuration.** Metistry is ahead where it counts: config is data
(`compute.yaml`, `agents/<area>/<name>.md`, `manifest.yaml`), CI-validated, in
protected paths the assistant cannot write. Eve's config is code, which cannot be
a protected-path grant boundary nor be schema-refused whole the way a crew
manifest is. Eve is ahead on *resolved-surface visibility*: one artifact saying
what it found, what it refused, what it will run.

**Grants.** Eve has no grant model; placement *is* the grant. Metistry's
server-side `{tier, areas, queries}` attached to a token hash — "never asserted
by the agent, never carried in a request" — is strictly stronger and is what W3's
per-tool tokens need. Eve's remaining grant machinery (`byPrincipal` scope,
per-caller resolvers, `forwardPrincipal`, multi-tenant approvals) is SaaS
plumbing: one human means one principal, so it is not a gap.

**Sharing.** Converges on §4.11 independently, and adds two mechanisms we lack:
the append-only `<agents>` status note, and cohort batching.

**Schedules.** Metistry's runner is *ahead* on missed runs — gating on
`max(ts) FROM runs` means a missed interval fires next tick, catch-up by
construction, which Eve does not document at all. Eve is ahead on budget
semantics and the one-of compile check. Neither aggregates failures.

## 8. Ranked ADOPT (all ≤ 3 lines, no new dependency)

1. **Budget refusal branches on reachability.** In PR 3's budget check, a turn
   with a live human yields a `decision` row offering one more window or stop; an
   unattended turn (routine, crew, dispatched brief) fails at once with a named
   error. Serves C5 + R3; the grant is a `runs` row, never a write to the
   protected `compute.yaml`.
2. **A crew's budget is a share of the dispatcher's remaining window.**
   `apps/assistant/src/crew.ts:108` passes
   `maxBudgetUsd: input.crew.budget_usd_per_run` — a per-run cap independent of
   any window, so N crews can outspend the daily budget. Make it
   `min(manifest, dispatcher's remaining)` and count crew spend back against the
   dispatcher. Serves C5/C12 and invariant 2; narrowing-only, like `autonomy`.
3. **An append-only `[Agents]`-style note for open delegated work.** When the set
   of the assistant's open `work` rows changes, append one framework-authored
   note listing `(agent id, work id, status)` instead of re-rendering state each
   turn — append-only precisely to keep the prompt prefix cacheable. Serves
   A1/A2, informs OPEN-6.
4. **`metistry connect <tool> --non-interactive`.** NDJSON events, exit `2` for
   "needs your hand", final event carrying the resume command — exactly W3's
   Devin case, where no API can write the MCP entry and we can only print
   instructions. Serves W3 and invariant 2: the human step becomes a scriptable
   status code, not a paragraph.
5. **Every resolved component reports the path it won from.** `CrewLoad.sources`
   records per-*dir* readability (`disk|vault|absent`), not which dir a given crew
   came from; targets and queries have no equivalent, and `grep -r source_path`
   finds nothing. Put the winning file path on the resolved manifest and show it
   in `metistry doctor`. Serves invariant 5 + D4 — a silent overlay override is
   the D4 failure mode.
6. **"Frontmatter is data" as a misuse test.** One test asserting that crew /
   component frontmatter which is not a plain YAML object — a code-fence engine,
   a tag, a scalar — is refused whole. Serves invariant 8 ("misuse tests ship
   with the interface"); folds into G4.

## 9. BORROW-LATER

- **Cohort batching of completions** — hold crew results until every open sibling
  settles, then deliver in one turn; "partial completions do not invoke the
  parent model" is a real token saving. Revisit when parallel `agents_delegate`
  is common enough to measure; today it is a state machine for a rare case.
- **A `metistry info --json` resolved-surface artifact** (Eve's compiled manifest
  + diagnostics) — useful for support and the Mac app, but a new artifact to
  version. After ADOPT 5 proves the cheap half.
- **Per-step credential resolution with `expiresAt`** — finer than PR 3's
  per-run scoped credential; pays once a bridge holds a short-TTL token.
- **`<peer>__<resource>` qualified names for S4's registry**, URL never in the
  model-visible description (Eve's `connection_search` shape). Wait for S4;
  scope is OPEN-7.

## 10. SKIP

- **Eve as a dependency** — beta terms, ~3 releases/day, 854 open issues, Nitro
  + `@workflow/*` `5.0.0-beta` underneath: unabsorbable for one maintainer, and
  C4 already ruled ~300 hand-rolled lines over the alternative.
- **Eve as a template** — invariant 5: the hand-written CI-validated manifest is
  the grant boundary; `defineAgent` in TypeScript cannot be one.
- **`defineDynamic` model resolution** — assignments are `compute.yaml` config
  (C1, §2.4) and `step.started` re-resolution is what our schema refuses
  alongside `/auto`. Eve's note on uncached re-ingestion supports us, not them.
- **Vercel Connect / hosted OAuth** — hosted-cloud assumption; the
  Keychain-scoped provider secret (C6) and `auth: env:VAR` on targets are the
  local answer.
- **Sandbox + credential brokering** — invariant 9 removes the shell from the
  engine, so there is nothing to sandbox: Eve solving a problem we deleted.
- **Per-caller/multi-tenant grants, `byPrincipal` memory, `forwardPrincipal`,
  approval-response policies** — one human, one principal. Already have it, or no
  gap.
- **AI Gateway as the model path** — C2's one `openai-compatible` engine over
  OpenRouter covers it without a second broker.
- **`eve add` registry installs writing files into the project** — invariant 2
  makes a network-sourced file writer a non-starter; `metistry connect` writes the
  *tool's* config, not ours.
- **CLI telemetry** — on by default is the wrong default for this product.

## 11. Contradictions and corrections

- **No contradiction with `metistry-build-plan.md` or the 2026-09-13 refresh.**
  Every ADOPT is enforcement inside an existing invariant; the plan is not edited
  here.
- **One correction to a prior note.** `2026-09-12-hermes-agent-review-2.md`
  called schedule health "the one place a competitor is plainly ahead." Eve is
  not ahead: no failure aggregation, no missed-run catch-up, and it defers to a
  platform dashboard. H4–H7 keep their value but lose that framing.
- **Unverified.** Eve's docs are the only evidence: nothing was installed or run,
  so every behavioural claim is documented behaviour, not measured. The dependency
  read is from `packages/eve/package.json` alone — the transitive weight of
  `nitro` and the `@workflow/*` line was not resolved. Whether the compiled
  manifest is stable enough to imitate, and how Eve's sandbox behaves off Vercel,
  are unexamined.

## 12. Sources

Fetched 2026-09-15 via `gh api` / `curl` on `raw.githubusercontent.com` at
`vercel/eve@main` (repo `updated_at` 2026-09-15T04:33:38Z; latest release
`eve@0.55.0`, 2026-09-14T23:57:21Z; Apache-2.0). **No fetch failed.**

- https://github.com/vercel/eve — `README.md`, `LICENSE`, releases, commits
- `docs/` on that repo: `agent-config.md`, `schedules.mdx`,
  `subagents/index.mdx`, `connections/overview.mdx`, `concepts/security-model.md`,
  `tools/human-in-the-loop.md`, `skills.mdx`, `memory/overview.mdx`,
  `extensions.md`, `install-integrations.mdx`, `sandbox.mdx`, `guides/hooks.md`,
  `guides/remote-agents.md`, `guides/deployment/self-hosting.md`,
  `evals/overview.mdx`, `reference/cli.md`, `reference/telemetry.md`
- https://github.com/vercel/eve/blob/main/packages/eve/package.json

Metistry side: `CLAUDE.md`, `docs/plan-refresh-2026-09-13.md` (§1, §4, §4b),
`docs/ops/crews.md`, `docs/ops/targets.md`, `docs/ops/assistant-tools.md`,
`apps/console/src/agents.ts`, `apps/console/src/crews.ts`,
`apps/console/src/runner.ts`, `apps/assistant/src/crew.ts`.
