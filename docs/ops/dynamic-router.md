# The dynamic router — rules outside, a policy inside

The owner's ask (design round 0, Q1): the assistant chooses the operations and the
compute a request needs, simply for the owner and efficiently in tokens and
money. Tiers stay, in Advanced.

This page is the whole spec for the four tickets that build it — T9-1 (decisions,
in shadow), T9-2 (the policy), T9-3 (the confirmatory eval), T9-4 (wire the
composer). It was frozen by F-8 from `docs/product/design-build-plan.md` §2.8. A
T9 ticket reads this page and nothing else; where this page and the plan
disagree, the plan wins and the disagreement is a bug to report.

**The shape.** The owner's rules come first and are deterministic — today's
router, unchanged. Only where they leave a message on the default tier does a
local, cheap policy get a say, and even then it picks from closed lists the
owner wrote, inside limits the owner set, and every choice goes on the record
with its reasons. With no policy configured, or a policy that fails, or a choice
outside the bounds, the message takes the route it takes today.

## The invariant

Ratified by the owner on 2026-09-26 (plan §4 Q1). F-0 lands it in `CLAUDE.md` and
`metistry-build-plan.md` §1; this page quotes it and does not change it:

> **4. Routing is bounded by rules and always audited.** Rules the owner writes
> decide what may run — which tiers and models, what a request may cost, and
> every hard limit — and they always win: commands, overrides and budgets come
> first. Inside those bounds a local policy may choose the operations and the tier
> for a request; it can never choose outside them, every choice is recorded with
> its reasons, and with the policy absent or failing every request takes the
> rules' default.

Each clause has one mechanism and one test. T9-4's
`apps/console/test/invariant4.test.ts` has one `describe` per row, in this order,
named with the clause:

| Clause | Mechanism | Test |
| --- | --- | --- |
| rules decide which tiers and models | `policy.tiers`, a subset of `tiers:`; a tier resolves to its model exactly as the drain resolves it today; the policy never names a model (§1) | every decision over a generated feature space names a tier in `policy.tiers` or the rules' default |
| rules decide what a request may cost, and every hard limit | `policy.caps` (tool calls, tokens, cost), enforced in the engine (§1, §6) | a served policy turn stops at each cap; a row above a cap is refused at load |
| commands, overrides and budgets come first | the policy is consulted only on the fall-through (§1); the budget guard runs unchanged, and a policy tier it refuses falls back to the rules' default (§5) | `/note`, `/model`, `/deep`, a `fast_path` match and the picker are served identically with any policy; a budget refusal of a policy tier serves the default |
| a local policy may choose the operations and the tier | the table in `rules.yaml` over the features, one closed operation vocabulary; any model it consults is on-machine (§2–§4) | an off-machine scorer is refused at load and at the call |
| it can never choose outside them | load-time validation, then the bounds check at run time (§4, §5) | no output outside the allow-list, whatever the planner returns |
| every choice is recorded with its reasons | one `runs` row, kind `route`, per message; at serve, written before the message is (§6) | a policy choice whose row cannot be written is not served |
| absent or failing, the rules' default | every failure mode maps to the default (§5) | absent, timeout, throw, garbage: the served route is byte-identical to today's |

## The flow

```
POST /message
 │
 ├─ 1. THE RULES — today's route(), unchanged
 │      /note ─────────────────────────────▶ note        ┐ served as today;
 │      a fast_path match ─────────────────▶ fast_path   ┘ the policy is not consulted
 │      /model <tier>, /deep, the picker ──▶ override    — served as today; the policy is
 │                                                          consulted AFTER the 202, as a
 │                                                          counterfactual, for the record
 │      nothing matched ───────────────────▶ default     — the fall-through: go on
 │
 ├─ 2. THE FEATURES — cheap ones always; a model one only if the table reads it
 ├─ 3. THE TABLE — first matching row → {operation, tier, tool_calls}
 ├─ 4. THE BOUNDS — allow-list, caps, the session, the registries; or the rules' default
 ├─ 5. THE RECORD — one runs row, kind route
 └─ 6. policy.mode: shadow → the served route is still the rules' default
       policy.mode: serve  → the policy's choice is the route (T9-4)
                               └─ drain → engine: tool set, tool-call budget, caps,
                                  budget guard (a refusal falls back to the default, once)
```

## 1. The rules

These are the owner's, they are deterministic, and they run first. Nothing in this
section is new except the last three rows. The policy cannot change any of them.

| # | Rule | Where it lives | What it serves | Policy |
| --- | --- | --- | --- | --- |
| R1 | `/note <text>` | `apps/console/src/router.ts` `route()` | `note` — the inbox, no model | not consulted |
| R2 | `/model <tier> <text>`, where `<tier>` is a key of `tiers:` | `route()` | `model`, `routed_by: override` | counterfactual only |
| R3 | `/<commands.deep_alias> <text>` (`/deep`) | `route()` | `model` on `deep`, `routed_by: override` | counterfactual only |
| R4 | a `fast_path:` regex matches | `route()`, `rules.yaml` `fast_path:` | `fast_path` — a named query, no model | not consulted |
| R5 | the composer's picker (`tier` on `POST /message`) | `route()` | `model`, `routed_by: override` | counterfactual only |
| R6 | nothing above matched | `route()` | `model` on `default`, `routed_by: rule` — **the fall-through** | **consulted** |
| R7 | budgets | `compute.yaml` `budgets:`, the engine's guard (`apps/assistant/src/budgets.ts`) | checked before every call, on whatever tier was served | cannot see or move them |
| R8 | **the allow-list** | `rules.yaml` `policy.tiers` (new), a subset of `tiers:` | — | may name only these tiers |
| R9 | **the caps** | `rules.yaml` `policy.caps` (new) | — | may grant only within these |
| R10 | **the session** | the thread's active session (`sessions`, `assistant_sessions`) | — | may not move an active session to another model |

**Out of the router's reach entirely:** machine-enqueued turns (the fold and
routines write `meta.tier` straight into `inbound_messages`), crew runs, and the
capture door (whose intent tier is already ruled on and needs nothing here).

**The allow-list names tiers, never models.** A tier is a (model, effort) pair
(core's `tiers.ts`, cost research decision 2), so choosing a tier *is* choosing its
effort; the policy has no separate effort knob, because a second knob would split a
pair the product deliberately keeps whole. A tier resolves to its provider and
model exactly as the drain resolves it today — `compute.yaml` `assignments.tiers`,
then `assignments.default` (core's `resolveAssignment`). The policy's output has no
field that could hold a model name.

**The caps** bound every turn the policy serves:

| Cap | Counts | Enforced |
| --- | --- | --- |
| `tool_calls` | tool calls the turn makes, refused ones included | in the engine's loop: past it, the loop asks once more with tools off and answers, as `max_turns` already does |
| `tokens` | prompt + completion tokens over the turn's whole loop | checked between the loop's requests; past it, the same closing request |
| `cost_usd` | what the turn has cost so far | checked between requests, exactly as a crew's `budget_usd_per_run` is (`spec.maxCostUsd`) |

A cap is checked between requests, so the request that crosses it completes and
the closing request (tools off) follows; that is the existing crew behaviour, and
this page says so rather than promising a pre-call estimate nobody computes.
Turns the rules serve (R1–R6) keep today's limits — `max_turns` and budgets — so
adding a `policy:` block changes nothing about them.

**The session rule** exists because of a property of the store, not a preference:
a session whose (provider, model) differs from the turn's is **not resumed**
(`apps/assistant/src/sessions.ts` — "replaying a Claude transcript into a local
model … produces a turn neither model would have written"). A policy that moved a
thread to another model mid-session would silently drop the conversation, and no
single-message eval can see that loss. So while a thread has an active session,
the policy may choose only a tier that resolves to that session's (provider,
model) — which still leaves it every operation and every effort-only variant.
Anything else is out of bounds and takes the rules' default (`bounded_by:
session`). A new thread, or one whose session rolled at a task boundary, is free.
Rejected: letting the policy switch models and measuring the damage in shadow — the
damage is lost context, which the shadow's agreement measure cannot see either.

## 2. The features

The facts the table reads. The set is closed; a feature not listed here is a
product change. **No feature carries the message text**, and none reaches the
record as text.

| Feature | Type | Computed from | Absent when |
| --- | --- | --- | --- |
| `words` | integer ≥ 0 | whitespace-separated words of the trimmed text — the same count `route_report` buckets | never |
| `attachments` | integer ≥ 0 | attachments on the `POST /message` body. **Always 0 today**: the route takes none; the feature is defined so a client-API addition is one line | never |
| `thread_turns` | integer ≥ 0 | turns in the thread's active session (`sessions.turns`), 0 with none — the context the model will carry | the features query failed |
| `recent_failures` | integer 0–5 | of this thread's last five `turn` runs, how many ended `ok = false` or with `meta.stopped` set (`max_turns`, `veto`, `max_budget`) | the features query failed |
| `reask` | boolean | the thread's previous inbound message arrived ≤ 30 minutes earlier and its word set overlaps this one's at Jaccard ≥ 0.5 (lower-cased runs of letters and digits, tokens under two characters dropped) | the features query failed |
| `intent` | an intent from `packages/core/src/intent.ts`, or `unsure` | PoC-20's scorer on the model `compute.yaml` `assignments.intent` names; a verdict below the owner's threshold (`rules.yaml` `intent:`, `intentThreshold()`) **is** `unsure` | no row reads it; no `assignments.intent`; the guard refused the text; the call failed or ran past the timeout |
| `complexity` | `simple` \| `moderate` \| `demanding` | the planner (below) on the same local scorer; a verdict below `policy.complexity.min_confidence` is absent | as `intent` |

The first five cost one named query and some arithmetic; they are computed on every
consultation and always recorded. `intent` and `complexity` cost a local model
call each; **they are computed only when some row reads them**, determined once at
load from the table, and the two calls run concurrently. Shadow and serve follow the
same rule, because a shadow that computed what serve does not would report
decisions serve can never make.

**The thread features come from one named query**, `seed/queries/route_features.yaml`
(new; `expose: route` — it serves the router, not the generic door, and
`queries_run` honours `expose` the same way), with params `thread` (text) and
`exclude_id` (int: the message's own id in shadow, 0 at serve, so a message is
never compared with itself), returning one row: `session_active`,
`session_turns`, `session_provider`, `session_model`, `recent_failures`, and the
previous inbound message's `ts` and text for the `reask` comparison. The text is
compared in the console and never leaves it; only the boolean is recorded.
Invariant 3: the router does not query Postgres itself.

**The planner** is the "local planner model [that] may supply a feature" of plan
§2.8. It supplies `complexity`, and the table maps complexity to a tier — that
mapping *is* the clamp. It asks the one-token closed-choice question the intent
tier already asks (`packages/core/src/choice.ts`, `scoreChoiceOver`), on the same
model, with the same off-machine refusal at load and at the call:

- the classes are a closed enum in `packages/core` (`COMPLEXITY`, beside
  `INTENTS`), each with a description that is a statement about the text in the
  present tense — never an instruction and never a destination (PoC-20's Laya
  lesson 1: ask what the message says, not what to do about it). Starting wording,
  T9-2's to tune with the harness's phrasings before T9-3 freezes it:
  `simple` — "it asks for one small thing: a fact, a short reply, a lookup, a quick
  change"; `moderate` — "it asks for a piece of work with a few steps: reading,
  gathering, or writing something of moderate length"; `demanding` — "it asks for
  careful judgement: weighing options, planning around several constraints, or
  getting something consequential right";
- reasoning suppressed, temperature 0, one scored token (PoC-16: thinking cost 9×
  latency and *lowered* accuracy on exactly this task);
- the names map to PoC-15's labels — `simple` = cheap, `moderate` = standard,
  `demanding` = deep — so PoC-15/16's fixtures and analyser carry over. They are
  not tier names on purpose: `tier: { demanding: deep }` reads as a decision,
  `tier: { deep: deep }` as a typo.

Rejected: a planner that names one of the instance's tiers. Every instance's tier
menu differs, so its prompt would differ per instance and no eval would transfer;
a fixed three-class question is one prompt, one eval, and the owner's table does
the translation. Rejected: a separate `assignments.planner` line — it would name
the same local model twice and give the off-machine refusal two places to live.
The one scorer answers two questions.

`scoreChoice` lives in `collectors/compute-client.ts` today and the console cannot
import from `collectors/`. If the console needs it, it moves to `packages/core`
with its off-machine refusal intact; it is not copied.

## 3. The operation vocabulary

Closed, in code: `ROUTE_OPERATIONS` in `packages/core/src/router-policy.ts`. A new
operation is a product change, never a config line (invariant 10's rule, applied).

| Operation | What the turn does | Tool surface the engine will execute |
| --- | --- | --- |
| `answer` | a model turn that answers from the conversation alone | none — the request goes out with `tool_choice: "none"` |
| `fast_path:<query>` | no model: the console runs the named query and formats it, exactly as an R4 match does | — |
| `retrieve:knowledge` | a model turn that may read the vault | `knowledge_search`, `knowledge_read`, `knowledge_list`, `knowledge_grep` (core's `CREW_TOOL_GROUPS.knowledge`) |
| `retrieve:queries` | a model turn that may run named queries | `queries_list`, `queries_run` |
| `delegate:<crew>` | a model turn that hands a brief to one crew | `agents_delegate`, with its `crew` argument pinned to `<crew>`, plus the four knowledge tools to write the brief from |
| `tools` | today's turn | the assistant's whole surface — what every fall-through gets today |

**Every operation is a subset of `tools`, and `tools` is the rules' default.** An
operation narrows what a turn may do; none widens what the assistant may do, and
none reaches a tool the assistant's principal does not already hold (invariant 9).

**Narrowed at the tool, not in the prompt.** The engine's per-turn host is handed
the operation's allow-list; a call outside it is not executed — the host returns
one fixed refusal string and counts the call toward `tool_calls`. For
`delegate:<crew>`, a call naming another crew is refused the same way. Nothing is
added to the prompt to ask the model to stay inside the list.

**The tool definitions sent stay the same for every operation.** Tools come before
the messages in the prompt, so a turn that sent a different set would break the
cached prefix for the whole session (`apps/assistant/src/tools.ts`: "a mid-run
change of surface would break the cached prompt prefix"). The saving an operation
buys is the tool loop it does not run, not the definitions it does not send.
Rejected: sending only the operation's tools — it saves roughly 4k definition
tokens a turn and costs a full cache rewrite each time the operation changes
within a thread.

**Registries are checked at decision time.** `<query>` in `fast_path:<query>` must
be a query some `fast_path:` rule already names, so the policy can reach no query
the owner's rules could not (checked at load, both in `rules.yaml`), and it must be
loaded (checked at run time). `<crew>` must be a crew whose manifest the console has
loaded now (checked at run time — the registry is a different file). A miss takes
the rules' default (`bounded_by: crew_registry` or `queries`).

## 4. The policy table — `rules.yaml` `policy:`

`.metistry/rules.yaml` is a protected path, the owner's hand (invariant 2). The
block is optional and absent means off — the shipped behaviour and a supported
install. The seed ships it commented out, beside the `intent:` block.

```yaml
policy:
  mode: shadow               # shadow | serve. serve is refused at load until T9-4.
  tiers: [fast, default, deep]   # the allow-list, cheapest first; each a key of tiers:
  timeout_ms: 400            # the whole consultation; past it, the rules' default
  caps:                      # every turn the policy serves; no defaults
    tool_calls: 12
    tokens: 150000
    cost_usd: 0.50
  complexity:
    min_confidence: 0.70     # fit it (T9-3's --fit); do not guess it
  table:                     # first match wins; no match = the rules' default
    - id: status
      when: { intent: [status_open_work, task_list], words: { max: 15 } }
      then: { operation: "fast_path:open_work" }
    - id: small-talk
      when: { intent: smalltalk }
      then: { operation: answer, tier: fast }
    - id: the-record
      when: { intent: knowledge_search }
      then: { operation: "retrieve:knowledge", tier: default, tool_calls: 4 }
    - id: struggling
      when: { reask: true }
      then: { operation: tools, tier: deep }
    - id: by-complexity
      when: { complexity: [simple, moderate, demanding] }
      then: { operation: tools, tier: { simple: fast, moderate: default, demanding: deep } }
```

The numbers above are illustrations, not defaults: `caps` and
`complexity.min_confidence` have none, for the reason `intent.min_confidence` has
none — a number nobody chose is not a limit.

**Fields.**

| Field | Rules |
| --- | --- |
| `mode` | `shadow` (default) or `serve`. `serve` is refused at load, naming T9-4, until T9-4's build lifts it |
| `tiers` | non-empty, unique, each a key of `tiers:`; **ordered cheapest first** — the order is what "a higher tier" means in the report and the eval |
| `timeout_ms` | integer, 50–2000, default 400 (the intent research's p95 bar for the composer path). One deadline for steps 2–4 |
| `caps.tool_calls` · `caps.tokens` · `caps.cost_usd` | all three required: integer ≥ 0, integer > 0, number > 0 |
| `complexity.min_confidence` | in [0, 1]; required when any row reads `complexity` |
| `table[].id` | required, unique, lowercase kebab-case — it is how the record names the rule that decided |
| `table[].when` | keys from §2 only, all ANDed; absent or `{}` matches every message. `intent`, `complexity`: one name or a list, from the closed enums. `words`, `attachments`, `thread_turns`, `recent_failures`: `{ min?, max? }`, inclusive integers, at least one. `reask`: a boolean |
| `table[].then.operation` | one of §3, spelled exactly |
| `table[].then.tier` | a name in `policy.tiers`, or a map from **all three** complexity classes to names in `policy.tiers`. Required for every operation except `fast_path:*`, which may not carry one |
| `table[].then.tool_calls` | integer 0 ≤ n ≤ `caps.tool_calls`; default `caps.tool_calls`; not allowed on `answer` or `fast_path:*` |

**Refused at load**, in the same parse that already refuses an uncompilable
`fast_path` regex, each naming the field: an unknown key anywhere; a tier outside
`tiers:` or outside `policy.tiers`; an operation outside the vocabulary; a
`fast_path:<query>` no `fast_path:` rule names; a `tool_calls` above the cap; a
tier map missing a class; a row reading `intent` while `rules.yaml` has no `intent:`
block (both files have to agree before a verdict moves anything, as they do at the
capture door); a row reading `complexity` with no `complexity.min_confidence`;
`mode: serve` before T9-4.

**Evaluation** is pure and lives in `packages/core/src/router-policy.ts` —
`decide(policy, features) → Decision`, no I/O. Rows are tried in order. A condition
on an absent feature is false, never true, so a scorer that is down makes its rows
skip rather than misfire; the next rows still apply. The first row whose every
condition holds decides; a tier map is looked up with the `complexity` feature, and
a row with a tier map does not match while `complexity` is absent. If no row
matches, the outcome is `no_match` and the rules' default is served. `route()`
itself is not touched.

## 5. Bounds and failures

Every outcome the consultation can have, and what is served. "Default" means the
rules' default: `tools` on the `default` tier, with today's limits.

| Outcome | When | Served | `ok` | `bounded_by` |
| --- | --- | --- | --- | --- |
| `not_consulted` | R1 or R4 decided | the rule's route | true | the rule: `command:note` or `fast_path:<query>` |
| `counterfactual` | R2, R3 or R5 decided | the override | true | `override` |
| `absent` | no `policy:` block | default | true | — |
| `chosen` | a row matched and passed the bounds | shadow: default · serve: the row | true | — |
| `no_match` | no row matched | default | true | — |
| `out_of_bounds` | the row's tier resolves to a model other than the active session's; its crew or query is not loaded | default | true | `session`, `crew_registry` or `queries` |
| `timeout` | the consultation ran past `timeout_ms` | default | false | `timeout` |
| `failed` | anything threw, or the features query failed | default | false | `failed` |

A model feature that is unavailable is **not** a failed consultation: it is an
absent feature (§4), recorded under `features.<name>.outcome` with the scorer's
reason (`guarded`, `unavailable`, `below_threshold`).

**Budgets, after the decision.** The drain's guard runs on the served tier exactly
as it does today. If it refuses a tier the *policy* chose, the drain re-resolves
the turn once to the rules' default and asks the guard again — so under
`critical_only`, where `assignments.default` is `critical: true`, the owner's turn
is answered exactly as it would be today, not refused because the policy picked a
non-critical tier. That fallback is recorded on the turn's own `runs` row as
`meta.route_fallback: { from, reason: "budget" }`. It never lands anywhere other
than today's route, and it never retries twice.

**A recording failure is a failure.** At serve, the route row is written before the
message is; if it cannot be written, the policy's choice is not served and the
message takes the default. No choice is served that is not on the record.

## 6. The record

### The `runs` row, kind `route`

One per `POST /message` that ran with a ruleset loaded — including `note` and
`fast_path`, so the report has one source. No migration: `runs.kind` has no CHECK,
and everything else is an existing column or `meta` (plan §2.9).

| Column | Value |
| --- | --- |
| `component` | `console` |
| `kind` | `route` |
| `tool` | the served route's derived kind: `note`, `fast_path`, `override`, `default` or `policy` — the words `route_report` already uses, plus `policy` |
| `provider`, `model` | NULL. A route row buys nothing; the planner's provenance is in `meta`, so no per-provider report counts it as a call |
| `ok` | the policy answered — **not** that it was right (§5) |
| `error` | the reason, when `ok` is false |
| `duration_ms` | the consultation's wall time |
| `started_at`, `finished_at` | two-phase: started at the rules' decision, finished when the consultation ends, so a hung scorer is visible in flight |

```jsonc
// runs.meta for kind = route — v1
{
  "v": 1,
  "message_id": 4812,
  "thread": "default",
  "phase": "shadow",                       // shadow | serve
  "rules": { "served": "default", "default_tier": "default" },   // what the rules alone would do
  "served": { "kind": "model", "tier": "default", "operation": "tools", "routed_by": "rule" },
  "features": {
    "words": 9, "attachments": 0, "thread_turns": 14, "recent_failures": 0, "reask": false,
    "intent": { "outcome": "scored", "intent": "knowledge_search", "confidence": 0.91, "threshold": 0.8,
                "provider": "ollama", "model": "gemma4:e4b-it-qat", "latency_ms": 171 },
    "complexity": { "outcome": "below_threshold", "class": "moderate", "confidence": 0.55 }
  },
  "policy": {
    "outcome": "chosen",
    "row": "the-record",
    "chosen": { "operation": "retrieve:knowledge", "tier": "default", "tool_calls": 4 },
    "bounded_by": [],
    "session": { "active": true, "provider": "openrouter", "model": "anthropic/claude-sonnet-5" }
  },
  "agrees": false                          // chosen = served, on operation and tier
}
```

**Never in the row:** the message text, `meta.route.text` (which carries a copy),
the previous message the `reask` check read, a vault path. The row is readable in
Run detail, so it holds counts, names from the owner's own vocabulary, and the
scorers' numbers — the same fence `route_report` keeps. An intent distribution, if
recorded, keeps only entries above 0.001, as the capture door's does.

**Shadow does not wait.** In `shadow` mode the rules' route is written to
`inbound_messages` and the 202 is sent first; the consultation and its row happen
afterwards. Its timeout is the same `timeout_ms`, so shadow measures what serve
would have done, latency included.

### `inbound_messages.meta.route` at serve (T9-4)

Shadow leaves it byte-identical. At serve, a policy-served message carries the
existing `Route` shape with `routed_by: "policy"` and three additive fields:

```ts
| { kind: "model"; tier; model; effort; text; routed_by: "rule" | "override" | "policy";
    operation?: RouteOperation; tool_calls?: number; policy_row?: string }
| { kind: "fast_path"; query; routed_by: "rule" | "policy"; policy_row?: string }
```

The drain reads `operation` and `tool_calls` from the row but reads the **caps from
its own copy of `rules.yaml`** (it already loads the file for `tiers:`), and takes
the smaller of the two. A row cannot grant itself more than the owner's file
allows. The thread's tier chip (`GET /api/messages`, `meta.route.tier`) already
shows the owner which tier answered each message.

### `route-report` (T9-1 extends it)

`seed/queries/route_report.yaml` keeps every row it has — the four kinds, the tiers,
the rules, the fall-through lengths and first words — and T9-1 adds a fifth kind,
`policy`, which reads 0 until T9-4. New row kinds, each emitted for every label
even when zero, each carrying its `denominator`, none carrying text:

| Row kind | Labels | Over |
| --- | --- | --- |
| `policy_outcome` | the eight outcomes of §5 | consultations |
| `policy_row` | each `table[].id` that decided, plus `(no match)` | `chosen` + `no_match` |
| `policy_operation` | each operation chosen | `chosen` |
| `policy_tier` | `<served tier> → <chosen tier>` pairs — the disagreement matrix | `chosen` |
| `policy_bounded_by` | each `bounded_by` value | consultations |
| `policy_override` | `agrees` / `disagrees`: on counterfactuals, did the policy pick the tier the owner picked | `counterfactual` |
| `policy_latency` | `p50`, `p95` of `duration_ms` | consultations that finished |
| `policy_shadow` | per chosen tier: mean `shadow_agreement` of the stage-2 shadow runs on those messages (joined by `message_id`) | shadowed turns |
| `policy_miss` *(meaningful from T9-4)* | policy-served turns followed in the same thread within 10 minutes by an override to a higher tier in `policy.tiers`, or by a `reask` | policy-served turns |

The owner's override is the one free label the product gets: a `/deep` the policy
would not have chosen is a deep-miss the owner caught by hand, and
`policy_override` is its rate. `metistry compute route-report` renders the new
rows, and a section with fewer than 30 consultations says "widen `--since`", as
the fall-through section already does.

## 7. Rollout — shadow, the eval, serve

The owner accepted the bar on 2026-09-26 (plan §4 Q2): **two weeks of shadow, then
PoC-15's eval**. Serve is not merged before both.

### 7.1 Shadow (T9-1, then T9-2)

T9-1 writes the route row on every message, with the cheap features and `policy:
{ outcome: "absent" }` — the table does not exist yet. T9-2 adds the table,
evaluates it in shadow on every fall-through and every override, and fills in the
model features its rows read. From T9-2's merge the two weeks can start.

**The stage-2 shadow machinery measures the other half.** A route row says what the
policy *would* have chosen; it cannot say whether the answer would have been as
good. `compute.yaml`'s existing `assignments.default.shadow` does: pointed at the
model of the tier under test, it re-runs a fraction of real default turns on that
model, tools stubbed record-only, and writes `shadow_agreement` on the turn's row.
`route_report`'s `policy_shadow` rows join the two by `message_id`: "on the turns
the policy would have sent to `fast`, the `fast` model agreed 0.82". No schema
change and no new mechanism. The limit, stated: one candidate model at a time, so
the owner points `shadow.model` at the tier whose decisions they want to test.
Rejected: a per-turn candidate chosen by the policy — it needs a new `shadow:` form
in `compute.yaml`, and it would scatter one candidate's agreement across every
tier, which `shadow_agreement`'s per-candidate report cannot read.

**Shadow counts when** the policy has been consulted, in `mode: shadow`, on at least
fourteen consecutive days. `route-report` is what the owner reads at the end of it.

### 7.2 The confirmatory eval (T9-3)

PoC-15's disposition, verbatim: the amendment "proceeds only if a confirmatory eval
passes: … fixtures authored independently of the rubric, ≥50 deep items". PoC-16
named the candidate (`gemma4:e4b-it-qat`, local, $0) and added "D08-class items
adjudicated". This is that eval, run on the planner as it will serve.

**Fixtures — the owner's, never the product's.** `<instance>/.metistry/eval/complexity.jsonl`,
one message per line: `text`, `label` (`simple` | `moderate` | `demanding`),
optional `accept` (the other classes an ambiguous item may take, PoC-15's `accept`
list), `trap` (`none` | `long_simple` | `short_demanding`), `id`. The example file
the product ships is empty, as `intents.example.jsonl` is: C11 forbids
Claude-authored labels, and a fixture written by the bar marks its own homework.

- **≥ 50 `demanding` items**, and at least 50 of each other class.
- **Authored independently of the rubric**: the owner labels from the class names
  alone, *before* reading §2's descriptions, and the descriptions are frozen before
  the scored run.
- **Traps**: at least 10% of `simple` items long (> 40 words) and 10% of
  `demanding` items short (≤ 8 words); length must not predict the label (|r| < 0.2;
  PoC-15's was −0.05).
- **D08-class items** — terse, operational replanning under several constraints,
  where all five competent PoC-16 local arms missed the label — are at least five of the
  `demanding` items, and each is labelled by the owner before it is scored.

**The scorer** is the served call byte for byte: `scoreChoiceOver`, the same prompt
builder, the same model, the same server wire; no harness around it (PoC-15's
Haiku numbers were discounted for exactly that). The harness runs offline against
recorded responses in its tests.

**The bar, pre-registered** — PoC-15/16's own numbers, carried over and stated as
rates now that the deep class is large enough to resolve them. T9-3's report quotes
this table before any result, and a number changed after a run voids the run.

| | Bar | From |
| --- | --- | --- |
| accuracy (accept-aware) | ≥ 85% | PoC-16 pre-registered |
| **deep-miss** — `demanding` items classed below `demanding` | **≤ 10%** of `demanding` items | PoC-15's miss threshold ("16 deep items cannot resolve a 10% miss threshold"); PoC-16's ≤ 1/16 is the same line at n = 16 |
| long-simple traps classed `simple` | ≥ 83% | PoC-16's ≥ 5/6 |
| short-demanding traps classed `demanding` | ≥ 83% | PoC-16's ≥ 5/6 |
| determinism | 100% identical across two temperature-0 runs | PoC-16 |
| unscored items (`unavailable`) on a warm server | 0 | PoC-16's parse-fail = 0 |
| warm latency | p95 ≤ the `policy.timeout_ms` the owner will serve with | the runtime deadline; PoC-16's ceiling was 3000 ms |

`--fit` sweeps `complexity.min_confidence` and prints the value that meets the
deep-miss and accuracy rows together, counting a below-threshold item as served on
the default tier — the threshold is an output of the eval, not an input, as it is
for intents.

**Cost is reported, not gated** — PoC-15 found its own pre-registered cost criterion
ill-posed: finding deep items means paying for deep, so routing is a quality
purchase, and always-default is a quality floor rather than a cost baseline. The
report prints, at the owner's real message mix from the two weeks of shadow
(`route-report --json`): $/1000 turns for today's router, for the policy, and for
always-the-top-of-`policy.tiers`; and the cost per rescued turn (a `demanding` item
today serves on `default` that the policy serves higher). Each tier's per-turn cost
is its observed mean over the window; a tier with fewer than 20 served turns is
priced at the default tier's mean tokens and its own `pricing:` rate, and says so.
Budgets remain the cost control at run time.

**The report** is one page the owner can read: the bar table with each row's result
and PASS/FAIL, every deep-miss verbatim with its confidence, the confusion matrix,
the fitted threshold, the cost table, and the two weeks' `route-report` policy rows.
The owner runs it — the fixtures and the local server are the instance's, and no
agent touches the live instance.

### 7.3 Serve (T9-4)

Merged only after T9-3's report clears the bar and the owner accepts it. It lifts
the load-time refusal of `mode: serve`, and for `serve`:

- the consultation runs **before** the message is written, inside `timeout_ms`, and
  its row is written first (§5);
- a `chosen` decision becomes the route: `fast_path:<query>` is answered by the
  console as an R4 match is; every other operation goes to the drain with
  `operation` and `tool_calls` on the route;
- the drain builds the turn from it — the operation's tool allow-list, the smaller
  of the row's and the file's `tool_calls`, the file's `tokens` and `cost_usd` caps —
  and the engine enforces all four (§1, §3); the budget fallback (§5) lives in the
  drain;
- overrides stay counterfactual, after the 202. An install stays in `shadow` until
  its owner writes `serve`.

## 8. The tickets

| Ticket | Builds | Files named by the ticket | Files it will also need | Tests (**bold** = the ticket's own) |
| --- | --- | --- | --- | --- |
| T9-1 · W1 | the route row on every message; the cheap features; `route_features.yaml`; `route_report`'s `policy` kind and the new row kinds; the CLI rendering | `apps/console/src/router.ts`, `seed/queries/route_report.yaml` | `apps/console/src/server.ts` (the call site), `seed/queries/route_features.yaml`, `packages/cli/src/compute.ts`, `docs/ops/compute.md`, `docs/ops/cli.md` (U7) | **the served route, the 202 body and the reply are byte-identical to today's, with a stub policy that answers, throws, or never resolves**; the row carries no message text; every new label is emitted at zero |
| T9-2 · W2 | `policy:` schema and load-time refusals; `COMPLEXITY`; `ROUTE_OPERATIONS`; `decide()`; the planner and intent calls under one deadline; the bounds; shadow evaluation | `packages/core/src/router-policy.ts`, `apps/console/src/router.ts` | `packages/core/src/index.ts`, `seed/rules.yaml` (the commented block), `scoreChoice` into `packages/core` if the console needs it, a changeset | **no output outside the allow-list, over a generated feature space and arbitrary scorer answers; a failure or a timeout takes the default**; every §4 refusal names its field |
| T9-3 · W3 | `metistry-eval complexity` with `--fit` and the report; the empty example file | `packages/eval/` | a changeset | the harness runs offline against recorded fixtures |
| T9-4 · W4 | `mode: serve`; the `Route` fields; the drain's turn from the route and its budget fallback; the engine's tool allow-list, `tool_calls` and `tokens` caps | `apps/console/src/router.ts`, `apps/console/test/invariant4.test.ts` | `apps/console/src/server.ts`, `apps/assistant/src/drain.ts`, `apps/assistant/src/engine.ts` (`TurnSpec`), `apps/assistant/src/engine-openai.ts`, `collectors/test/invariant4.test.ts` (its "composer door is not wired" block retires by ruling), a product-record fragment, changesets | one `describe` per clause of the invariant (the table at the top) |

**A trap for T9-2.** `collectors/test/invariant4.test.ts` slices `router.ts` from
`export function route(` to the end of the file and fails on any mention of
`intent`, and asserts `Route` has exactly three kinds. Both stay true through T9-2
if the policy code sits outside `route()`'s tail — in `router-policy.ts`, or above
`route()`. T9-4 retires that block, because the ruling it waited for has been given.

**No new door, so no new misuse tests beyond the tickets' own.** The route row is
read through the existing generic query door, whose 401/403 tests already cover
`route_report`; `route_features` is `expose: route` and has no door at all.

## 9. What this does not do

- **No model names a model.** The policy names a tier from a list the owner wrote;
  the tier resolves to its model as it always has.
- **No billable call on the routing path.** Every scorer the policy consults is
  on-machine, refused at load and at the call otherwise.
- **No migration, no dependency, no new route or action.**
- **No reach over machine turns, crews or the capture door.**
- **No mid-session model switch** (§1, the session rule).
- **No prompt as a control.** Every narrowing in §3 is the engine refusing to
  execute; every bound in §5 is code with a test.

## Related

- `docs/product/design-build-plan.md` §2.8, §3.3 (T9), §4 Q1–Q2 — the source.
- `docs/ops/compute.md` — assignments, budgets, shadow mode, the intent tier,
  `route-report`.
- `docs/research/2026-09-21-intent-classification-tier.md` §3.2 (P1–P3), §4.3,
  §4.4 — the audit's properties and the shape of a pre-registered bar.
- `docs/poc/RESULTS.md` §PoC-15, §PoC-16 — the eval this page's bar comes from.
- `docs/ops/crews.md` — what `delegate:<crew>` hands work to.
