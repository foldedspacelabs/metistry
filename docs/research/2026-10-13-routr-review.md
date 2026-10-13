# Routr — sizing and pacing coding agents across subscriptions, and what Metistry takes (2026-10-13)

Research answering the owner's 2026-10-13 ask: an old colleague "posted about using Jev to make decisions about routing to different compute models/agents and I think it's a good framework for what we talked about earlier. Please take a look and figure out what we can learn." The post is Chris Kirby's [routr — balanced orchestration across coding harnesses](https://chriskirby.net/routr-balanced-orchestration-across-coding-harnesses/) (2026-10-12). Its problem is the owner's. He had just hit his weekly Claude limit while this repository's coordinator ran subagents, and the post opens on "My, and likely your, weekly problem: controlling the burn", with subagents at "about 43% of the cost of sessions that used them".

Nothing here is built; this PR adds one document and no product code.

Sources, all fetched or read **2026-10-13**:

- the post, and the pages it links: [herdr.dev](https://herdr.dev/), TypeSafe's [System One concept page](https://docs.typesafe.ai/concepts/system-one) and Cloudflare's [Clef post](https://blog.cloudflare.com/clef-decision-models/) (2026-10-01);
- Claude Code's [statusline docs](https://code.claude.com/docs/en/statusline);
- a **shallow clone** of [sirkirby/routr](https://github.com/sirkirby/routr) at `37d9c81` (head of `main`, 2026-10-11, release v0.6.0), cited `rt:path:line`, with stars and dates from the GitHub API.

**Nothing was run**: no routr, no herdr, no TypeSafe or Clef call. Numbers from the post and from routr's evidence page are **his, unverified here**. Metistry claims cite `origin/main` `c33c9c08`.

## 1. What it is

1. **Who and what.** routr is Chris Kirby's MIT-licensed CLI (`rt:LICENSE:1-3`), plus two agent skills. An orchestrating agent asks it how demanding a piece of coding work is and which subscription has room, then launches a worker in another harness. It is JavaScript on Bun, about 5.9k lines of `src/` and 6.0k of tests, shipped as checksummed binaries (`rt:install.sh:17-20`).
2. **Maturity.** The repository was created 2026-09-20, and v0.6.0 came out 2026-10-11. It has 1 ★, 0 forks and 1 open issue (GitHub API), so it is weeks old with one maintainer.
3. **Harnesses.** The post names four: Claude Code, Codex, Cursor and Antigravity. The registry carries a fifth, Kiro (`rt:src/lib/harnesses.mjs:93-162`). Workers run in panes of **herdr**, an Apache-2.0 "agent runtime" from Herdr, Inc. that "reads every pane and marks each agent working, blocked or idle" (herdr.dev).
4. **Jev** is TypeSafe's first **System One** model. It returns typed answers — `noul` (yes/no), `choice` or `score` — with probabilities and a confidence, "rather than generated text". It is hosted at `POST /v1/systemone` (TypeSafe's concept page; `rt:src/lib/providers.mjs:49-62`), and routr pins `jev-1.13.0`.
   - routr can instead ask Cloudflare's **Clef** or **Clef Flash** on Workers AI, or, per its code, Clef Flash locally through Ollama (`rt:src/lib/providers.mjs:64-141`). Cloudflare says Clef's weights are Apache-2.0 on Hugging Face.
   - Metistry reviewed Jev on 2026-09-21 and declined it because it runs off the machine (`docs/research/2026-09-21-intent-classification-tier.md:44-48`, `:1296`).
5. **His ledger**, 2026-09-20 to 10-11, from the post:
   - 159 dispatches: Codex 87, Claude 45, Cursor 16, Antigravity 11. The projects add up to 146 (82 + 38 + 26), so 13 are unexplained.
   - "147 finished, done, and passing. 91 needed one round of corrections, and 40 needed two." Read literally, 131 of 159 needed rework; the post does not say whether those counts overlap.
   - The lead "went above routr's advice 34 times and below it 3 times".
   - Subagents were about 43% of the cost of sessions that used them, and 58% of subagent runs used Opus or Fable. His level evals are "n = 36, and most labels were written by the people building it".

## 2. The decision framework

**Three parties, kept apart** (`rt:docs/ranking.md:3-14`):

- a decision model reads the brief, and "knows nothing about your subscriptions";
- plain arithmetic ranks capacity, so "the same inputs always give the same answer";
- the orchestrating agent (the "lead", usually Opus) chooses the harness, model and effort.

| Step | What happens | Where |
| --- | --- | --- |
| **Brief** | The exact task file the worker will get. The lead's process rules go in a separate `--rules-file`: in 18 of 36 real tasks such text was 5–38% of the brief, "and it moved Jev's readings" | `rt:src/lib/launch.mjs:18-25`; `rt:skills/routr/references/orchestrator.md:21-26` |
| **Questions** | One request, each question answered independently (`rt:src/lib/questions.mjs:5`). There are 11 yes/no **facts** about what the brief states: names the location, leaves the approach open, cause unknown, cross-cutting, concurrency or data, hard to reverse; tiny, separable, needs the user; states how to check, standalone. Plus `high_blast_radius`, a `work_type` choice and a three-level `score`. The set is versioned (`r5`): "any wording change is a new VERSION and needs its measurement" | `rt:src/lib/questions.mjs:1-89` |
| **Calibration** | A fact reads yes at ≥ 0.8, no at ≤ 0.2, and "unclear" otherwise, which tells the lead to decide since it knows the codebase. A level is "sure" at the model's `sure_at` (0.8 for Jev). When torn it reports the more likely of the top two, and a tie goes lower. Confidence from non-TypeSafe models is recomputed on TypeSafe's formula | `rt:src/lib/advise.mjs:9-45`; `rt:src/lib/systemone.mjs:53-76` |
| **Level** | `basic`: "rote or well-specified". `standard`: "must find something out or choose an approach". `strong`: "a wrong or shallow result would be expensive and hard to notice". A high-risk reading adds "Do not go below standard" | `rt:src/lib/wording.mjs:6-10`; `rt:src/lib/advise.mjs:52-53` |
| **Worth a worker?** | `needs_user`: settle it with the user first. `tiny`: "do it yourself". `separable`: split it. Otherwise hand it out, because delegation that does not split "roughly doubles usage" | `rt:src/lib/advise.mjs:54-59`; `rt:skills/routr/references/orchestrator.md:11-15` |
| **Capacity** | For each window, what is left minus a **reserve that tapers** toward the reset ("unused capacity expires at the reset"); the tightest window counts. A subscription is excluded when the work is above its `hardest_work` level or it is turned off. A `metered` seat carries no number, "never a made-up quota". `use: normal` or `fallback` is the overflow mode | `rt:src/lib/pick.mjs:1-56`; `rt:src/lib/config.mjs:21-28` |
| **Usage readings** | Claude: the statusline's `rate_limits` (five-hour and seven-day), or `claude -p /usage`, "a local command … 0 turns, 0 cost" that takes 4–9 s. Codex: its app server. Antigravity and Kiro: their own `/usage`. An unreadable subscription gets the user's `assumed_headroom` (default 0.5), labelled assumed | `rt:src/lib/usage.mjs:64-81`, `:111-122`, `:185-198`; `rt:src/lib/config.mjs:25` |
| **Lead decides** | "Quality first", then efficiency and capacity among suitable options. Subagents: "never a model stronger than yourself", and "do not default to your own model". A level other than the advice is stated as `ROUTR: <advised> → <chosen> because <reason>` | `rt:src/lib/wording.mjs:47-49`; `rt:skills/routr/SKILL.md:93-123` |
| **Escalate** | `routr check` asks five closed questions of the worker's report: does it name a verification, cover the brief, admit gaps, read as a symptom patch, or go out of scope. "It never accepts work". The lead then runs its own check. Work that falls short goes back to the same worker, then a level up | `rt:src/lib/questions.mjs:91-112`; `rt:skills/routr/references/orchestrator.md:176-206` |
| **Fallback** | With no key, no network or a model error, routr answers with the configured `fallback_level` (default `standard`) and adds "judge the level yourself" | `rt:src/lib/config.mjs:11`; `rt:src/lib/commands.mjs:50-54` |
| **Ledger** | `routr record` appends one line per worker: the advice, a brief **hash** and length (never the text), the headroom seen, the choice, verdict, check, attempts and causes (`execution`, `brief`, `scope`, `review`, `launch`, `unknown`). `assess` reads it, and suggests nothing on fewer than 5 runs | `rt:src/lib/ledger.mjs:81-119`, `:139-223` |

**What he rejected.** His first prototype had "47 'lanes' (every model at every effort level), each with a capability score and a burn score, all tuned in a config file. I killed it". That quote is from the post; the prototype is not in the repository. It needed retuning at every model release. What replaced it: "**The questions are the product.**" routr names no model and knows no price (`rt:docs/ranking.md:137-143`).

**What his own evidence says about prediction:**

- Facts the brief *states* were decisive 63–88% of the time; estimates of what the work will take, only 22–43%. So routr asks only the first kind (`rt:docs/evidence.md:13`).
- A level derived by rule from the facts did no better than asking for the level directly: 52 against 54 of 68 (`:15`).
- On 5 real investigations, the top model clearly won 3 and "the level under-rated 1 of those 5". In his words: "This is why routr is built around judge-and-escalate rather than prediction" (`:17`).
- Jev read **high** on 68 short labelled briefs (28 of them written fixtures) and **low** on 36 real worker tasks (`:13`, `:16`).
- Jev's latency is stated three ways: about 300 ms (the post), about 130 ms (`:60`), and a 524 ms median (Cloudflare's table).

## 3. What he got right

1. **Interpretable questions over a single label.** routr returns twelve yes/no readings an agent and a person can both check, "a FACT SHEET for the agent that asked, not a verdict" (`rt:src/lib/questions.mjs:2-4`), rather than one opaque class. Each question asks what the brief says. That is PoC-20's "ask what the text says" (`docs/ops/dynamic-router.md:171-174`), found independently.
2. **Capacity is a first-class, deterministic input**, kept apart from the model that reads the text. The tapering reserve was measured: "A flat reserve made a subscription look spent a day before its reset" (`rt:docs/evidence.md:35`). Counting the tightest window, and giving a metered seat no number, are both honest about what is unknown.
3. **The first question is whether to delegate at all.** That is the same gate as this repository's `token-efficient-agents` skill (`.claude/skills/token-efficient-agents/SKILL.md:46-53`), with numbers behind it.
4. **Workers are fresh sessions in their own worktree.** Each is briefed by a file whose hash is checked against the advice (`rt:src/lib/ledger.mjs:81-83`), and `cleanup` refuses a worktree with uncommitted changes (`rt:src/lib/cleanup.mjs:179`). Our agent brief has the same worktree rule (`docs/ops/agent-brief.md:10-13`).
5. **Overrides are labels.** The `ROUTR:` line, and the ledger's pairing of advised against chosen, record the lead's corrections for free. That is our "one free label" (`docs/ops/dynamic-router.md:444-446`). `levelReview` turns them into "TOO LOW?" and "TOO HIGH?" flags, at 5 runs or more only (`rt:src/lib/ledger.mjs:227-243`).
6. **Outcomes carry causes.** Rework is split into execution, brief, scope, review and launch, and the first-pass definition is strict (`rt:src/lib/ledger.mjs:98`, `:140-141`), so a worker is not blamed for a bad brief.
7. **Fallback to a configured level.** A failure never stalls the lead (`rt:src/lib/commands.mjs:50-54`). That is our "absent or failing, the rules' default".
8. **Candour.** Every claim in `docs/evidence.md` carries its n and who labelled it, and the guidance calls itself "not a measured guarantee" (`rt:skills/routr/SKILL.md:117`).

## 4. What it gets wrong, or what Metistry must refuse

| Invariant or principle | routr | Metistry |
| --- | --- | --- |
| **Data leaving the Mac** | TypeSafe is the default provider (`rt:src/lib/providers.mjs:150`), so every brief's task text is POSTed to `api.typesafe.ai` (`rt:src/lib/commands.mjs:44`; `rt:src/lib/systemone.mjs:112-115`). The local option, Clef Flash through Ollama, gets 70–72 of 104 levels right against Jev's 82–83 and takes 5–7 s a brief (`rt:docs/evidence.md:51`, `:60`) | **Refuse.** Our planner is on-machine, and an off-machine scorer is refused at load and at the call (`docs/ops/dynamic-router.md:42`, `:584-585`). The 2026-09-21 research already declined Jev for this |
| **4 — rules always win** | The reserve and `hardest_work` only shape a candidate list. `launch` refuses only a subscription that is turned off (`rt:src/lib/launch.mjs:165`). "Respect … `hardest_work` and reserves" is a sentence addressed to the lead (`rt:skills/routr/SKILL.md:106-110`), and "routr advises; the orchestrator chooses" (`rt:docs/ranking.md:143`) | **Refuse the shape, keep the arithmetic.** In Metistry a limit is code that runs before the call: budgets are enforced in the engine (`docs/ops/compute.md:888-893`), and the policy "can never choose outside" its bounds |
| **Enforce at the tool; 9 — no shell** | Workers run with full permissions: `--dangerously-skip-permissions` (Claude Code); `--yolo --dangerously-bypass-hook-trust` (Codex), whose own comment says "every enabled hook, a repository's own .codex/hooks.json included, runs unreviewed"; `--yolo --trust` (Cursor); `--trust-tools=*` (Kiro) (`rt:src/lib/harnesses.mjs:95`, `:116-125`, `:134`, `:162`). "Never push" is a line in the worker guide (`rt:skills/routr/references/worker.md:9-10`) | **Refuse** for anything Metistry dispatches. Crews run with their own toolsets and a scoped, single-run credential (`docs/ops/crews.md:1`, `:8-11`). **Note for us:** our own brief's "Never the live instance" is also a sentence (`docs/ops/agent-brief.md:20-23`); MD-1 would make it a hook (`docs/research/2026-10-04-claude-code-mods-review.md:97`) |
| **C11 — no self-authored labels** | The level labels: 68 briefs labelled "by the builders", 28 of them written fixtures; 36 real tasks labelled by two model judges, with the maintainer settling the 16 they split. The questions were "worded and tuned on Jev, which favours it" (`rt:docs/evidence.md:13-16`, `:47`) | **Keep our bar:** the owner's labels, ≥ 50 per class, traps, D08 items, all pre-registered (`docs/ops/dynamic-router.md:485-520`) |
| **A limit that cannot be measured** | Usage "varies" by harness and "can lag under heavy burn" (the post). An unreadable subscription is assumed to have 0.5 headroom left (`rt:src/lib/config.mjs:25`) | **Keep ours: fail closed.** "A budget that cannot be measured … refuses" (`docs/ops/compute.md:949-951`) |
| **Loud configuration** | "Never throws": a broken file means defaults plus a note, and an invalid reserve becomes 0, which "holds nothing back" (`rt:src/lib/config.mjs:31`, `:63`; `rt:src/lib/wording.mjs:23`) | **Keep ours:** unknown keys are errors, and every refusal names the field (`docs/ops/compute.md:80`, `:93`) |
| **Who writes the record** | The ledger is the lead's own report, typed into `routr record` (`rt:skills/routr/references/orchestrator.md:208-220`) | **Keep ours:** the tool writes a `runs` row before the choice is served (`docs/ops/dynamic-router.md:348-350`) |
| **Supply chain** | Auto-update is on by default. It checks against a `SHA256SUMS` from the same release, which proves integrity, not authenticity (`rt:src/lib/config.mjs:16`; `rt:src/lib/update.mjs:1-4`, `:240-242`) | **Keep ours:** `metistry update` is explicit and pinned |

**Adopt routr itself for this repository?** Not as shipped. It needs herdr, full-permission workers on the Mac that holds the live instance, and a TypeSafe key that every brief of this public repository would go through. Take the ideas instead (§5.3).

## 5. What to learn

### 5.1 The T9 complexity classifier

**Today.** The planner asks one closed three-class question (`simple | moderate | demanding`), scored by one token on `gemma4:e4b-it-qat`. Below `complexity.min_confidence` the feature is absent and the rules' default serves (`docs/ops/dynamic-router.md:146`, `:165-186`, `:311-316`). The feature set is closed, so a new feature is a product change (`:134-136`).

**Complement the label, do not replace it.** routr's own numbers say facts do not beat a direct level question (52 against 54 of 68), so `complexity` stays. What facts add is **a floor and a reason**: `high_blast_radius` raises the minimum, which is the cheap direction to be wrong in. In our vocabulary that means a few yes/no facts that are statements about the message, such as `consequential` (costly or hard to undo if wrong), `several_constraints` and `asks_one_thing`.

- Each fact is one `scoreChoiceOver` call with two options, computed only when a table row reads it (`:148-153`), and recorded as a probability, never as text.
- A row like `when: { consequential: true }` → `then: { operation: tools, tier: deep }`, placed before `by-complexity`, is a floor in today's first-match table.
- **The D08 class** — "terse, operational replanning under several constraints", which all five local arms missed (`:499-501`) — is where `several_constraints` might fire when the three-class label does not. That is a hypothesis for the eval, not a finding.

**Cost.** Each fact a row reads costs one local call. The intent tier measured 155 ms p50 for one 15-way call (`docs/research/2026-09-21-intent-classification-tier.md:72`). Whether three yes/no calls run concurrently inside the 400 ms `timeout_ms` on one local server is **unmeasured**. A System One model answers every question in one pass, but the only local one, Clef Flash, takes 5–7 s a brief on an M4 Max (`rt:docs/evidence.md:60`). It is not a candidate for the composer path.

**The fixture bar (T9-3).** Facts need their own labels, and C11 still applies: they must be the owner's, per item, yes or no. Two findings in routr's evidence change how the bar should be read now, whatever happens to facts:

- **The kind of item changes the direction of error.** Jev read high on short labelled briefs and low on real worker tasks (`rt:docs/evidence.md:16`). The plan for Q-g agreed on 2026-10-04 (not yet in `docs/product/decisions-log.md:407`) draws fixtures from a non-Claude generator, with the owner spot-checking them. A generated set can pass a bar that real messages fail. So the report should **score generated and real items separately**, as routr reports its 36 real tasks on their own, and the D08 items should be the owner's real messages.
- **The model the wording was tuned on wins** (`:47`). Freeze the class descriptions before the run, which is already required (`docs/ops/dynamic-router.md:494-495`), and do not tune them on the generator's model.

**T9-4 (#466) is unchanged, and should not wait for facts.** Facts come after serve (RT-4, RT-5), and adding them needs the owner to amend the closed feature set.

### 5.2 Subscription headroom as a routing input

**What exists.**

- `billing: subscription` marks a plan "whose own window is its limit" (`docs/ops/compute.md:425-429`). T4-19 made a dollar limit on one a schema refusal, so its limit line carries only `calls_today` and `calls_this_month`, and the limit is "enforced by the provider" (`packages/core/src/budget.ts:256-263`, `:282-288`, `:381`).
- **The `claude-usage` collector does not read Claude usage or limits.** It rolls the assistant's own `runs` turns into daily tokens and cost, and "Nothing here names a plan or a login" (`collectors/claude-usage/run.ts:1-11`, `:31-41`).
- No Metistry component reads a five-hour or seven-day window. The build plan's monthly "check token spend by tier against your subscription headroom" is a chore done by hand (`metistry-build-plan.md:2521`).

**Whose burn it was.** The owner's week went to Claude Code — this repository's coordinator and its agents — not to the assistant's engine, which runs on whatever `compute.yaml` assigns. So §5.2 protects an install whose assistant runs on a subscription plan, and §5.3 is what protects the owner's week. Which provider the owner's instance assigns is **unverified**; this review did not read it.

**A shape under invariant 4: a rule, not a policy feature.** The policy "cannot see or move" budgets (R7, `docs/ops/dynamic-router.md:83`). The router never sees machine turns or crews either (`:88-90`), and that is exactly the work that burns a week unattended. So headroom belongs beside the budget guard in `compute.yaml`, not in `rules.yaml`'s `policy:`:

```yaml
budgets:
  providers:
    plan: { reserve: 0.25, action: critical_only }   # today refused for a subscription (T4-19)
```

- **The arithmetic is routr's.** Usable is the tightest window's share left, minus `reserve × (time to reset ÷ window length)` (`rt:src/lib/pick.mjs:36-41`). It is deterministic and testable.
- **The action is ours.** `critical_only` already means "interactive turns still get answers while routines and delegation stop" (`docs/ops/compute.md:906`). That is what a reserve is for: routr holds it back "so the orchestrator and anything you run outside routr still have room" (`rt:src/lib/wording.mjs:20-25`). Routines meet it at preflight (`blocked_config`), crews park as `blocked`, and one Needs You report goes out per window.
- **The readings are the hard part.** Claude Code's statusline JSON carries `rate_limits.five_hour` and `seven_day`, with `used_percentage` and `resets_at`, "only for claude.ai Pro and Max subscribers" (statusline docs, verified 2026-10-13); routr also reads `claude -p /usage`. Other subscription providers have no common source, and whether their response headers carry one is **unverified** per provider. Each reading would be a `runs` row with its source and `as_of`, read by one named query (invariant 3). A reserve with no fresh reading takes the action: it fails closed.
- **No overflow list.** routr's `use: fallback` sends overflow to another account, but `compute.yaml` has "no list of fallbacks" (`docs/ops/compute.md:87`). A named overflow tier would be a new rule, and that is the owner's call (Q1).

### 5.3 This repository's coordination

**What exists.** A coordinator (Claude Code, on Fable) dispatches one agent per ticket into its own worktree (`docs/ops/agent-brief.md:10-13`). The model comes from the ticket: S tickets already run on Sonnet (95 of the 259 entries in `docs/product/tickets/waves.md`), M on Opus, and L on Opus high (via `deep`). A Sonnet review agent, reporting in 10 lines or fewer, gates each merge. The coordinator's notes record that on 2026-09-27 all 17 running agents stopped mid-ticket on the owner's usage limit (429).

What routr's level, headroom and ledger would mean here, most valuable first:

1. **Read headroom before every batch.** Before dispatching, read the seven-day window, either with `claude -p /usage` (routr's measured method) or from a statusline snapshot. Apply the owner's reserve with routr's taper, and cap concurrent agents by it. At the reserve, dispatch nothing new, let running agents finish, and tell the owner. The 2026-09-27 stop is the case this prevents.
2. **Set effort as well as model.** "Opus, default effort" tickets go out through the `Agent` tool, which takes no effort, and Claude Code's default effort is `xhigh` (`.claude/skills/token-efficient-agents/references/model-routing.md:32`, `:37-40`). The same file says Opus at `medium` "gave up ~2 points for half the cost" on long-horizon coding (`:51`). What effort an inline Opus agent actually runs at is **unverified**. routr's lesson is that leads overshoot: left alone, its lead "went above the advice on 5 of 7 briefs and set effort to high every time" (`rt:docs/evidence.md:34`).
3. **Start at the ticket's tier, and go up only on a fact.** The facts that justify it are a failed review round, CI still red after one fix, or a U10 stop. Record each one the way routr's `ROUTR: advised → chosen because …` line does (`rt:skills/routr/references/worker.md:41`).
4. **Keep an outcomes ledger.** One record per ticket: model, effort, review rounds, CI-fix rounds, coordinator corrections, routr's six causes, 429 interruptions and wall time. Take it from GitHub and the review verdicts rather than from the agent's own report, and read it at each wave checkpoint. After a wave it answers what the post answers for its author: where the week went, and which tiers needed rework.
5. **The review agent answers routr's five report questions** (`rt:src/lib/questions.mjs:95-107`) as its ten lines. The answers are closed, comparable across tickets and countable in the ledger.

## 6. Take, adapt, refuse — tickets and questions

| Metistry component | routr | Take · adapt · refuse |
| --- | --- | --- |
| **Complexity planner** (T9-2, `router-policy.ts`) | Yes/no facts beside a level; a risk floor | **Adapt**: the eval first (RT-4), then features (RT-5) |
| **`metistry-eval complexity`** (T9-3) | Real tasks scored apart from written ones | **Take** (RT-4) |
| **Composer serve** (T9-4, #466) | Fallback to a configured level | **Keep ours.** No change, and no waiting on this |
| **Budgets** (T4-19; `packages/core/src/budget.ts`, `apps/assistant/src/budgets.ts`) | Tapering reserve, tightest window, metered means unknown | **Adapt**, as a rule enforced before the call (RT-1) |
| **Usage readings** (`claude-usage`, the Claude Code plugin) | Statusline `rate_limits`, `claude -p /usage` | **Adapt** (RT-2) |
| **Session summaries** (`packages/core/src/session-summary.ts`) | "Subagents ≈ 43% of cost" | **Take the measurement** (RT-3) |
| **Agent dispatch and crews** (`apps/console/src/dispatch.ts`) | Full-permission workers, bounds that only advise | **Refuse** |
| **Decision model** | Jev, hosted | **Refuse**, as on 2026-09-21. A local Clef Flash could at most join a bake-off; at 5–7 s a brief it is too slow for the composer path |
| **This repository's coordinator** (`docs/ops/agent-brief.md`, `.claude/`) | Level, headroom, ledger, report checks | **Adapt** (RT-6 to RT-8). Any `.claude/` change stays open for the owner |

**Tickets** (proposed; none is in the plan):

1. **RT-1 · A subscription has a reserve** · M · deps RT-2 — `budgets.providers.<name>: { reserve, action }` becomes legal on a `billing: subscription` provider; a dollar field stays refused. Before every call, the engine's guard computes usable headroom from RT-2's latest readings, with routr's taper and tightest window; at zero or below, the action applies exactly as it does today. A reserve with no reading newer than an age the owner sets (no default) takes the action. Tests: the arithmetic over recorded windows; a stale reading stops a routine; a `critical` turn passes; the policy cannot read it. Maps T4-19, plan §2.8 R7 and `docs/ops/compute.md` *Budgets*; an X candidate.
2. **RT-2 · Subscription windows are read and recorded** · M — each provider gets a closed list of reading sources: `claude-code-statusline` to start, and response headers only where a provider documents them. The Claude Code plugin gains an opt-in statusline script, inert unless `METISTRY_USAGE_FROM_STATUSLINE=1`, that sends the windows (never text) with the capture token. Each reading lands as a `runs` row of kind `usage`, read by one named query, and the new door ships its U2 misuse tests. Readings show beside the provider in Spending limits, with the 80% warning budgets already have (`packages/core/src/budget.ts:34`), so the owner sees his Claude Code week even where nothing enforces it. Maps `collectors/claude-usage`, `plugins/claude-code` and T4-19's `WindowLimit`; an X candidate.
3. **RT-3 · A session summary splits tokens by model and by subagent** · S — the summary sums every assistant message into one input and one output figure (`packages/core/src/session-summary.ts:162-163`). Split them by model and by `isSidechain`, and add the fresh and cache split that CM-5 asks for. First confirm whether current Claude Code writes subagent turns into the session file or into separate files (**unverified**); a summary that misses them undercounts the expensive part. It gives the owner routr's 43% figure for his own sessions. Maps CM-5 and X-70.
4. **RT-4 · The complexity eval scores facts, and scores real items apart** · M · after Q-g's run — `metistry-eval complexity` reports generated and real items in separate sections against the same bar. It accepts optional per-item fact labels from the owner (`facts: { consequential: true, … }`), and for each fact reports the decisive rate (p ≥ 0.8 or ≤ 0.2), the accuracy, and how many D08 and deep-miss items a fact floor would have caught. No change to the serve path. Maps T9-3 and `docs/ops/dynamic-router.md` §7.2.
5. **RT-5 · Facts are policy features** · M · after RT-4 and Q3 — amend §2's closed feature set with a closed `FACTS` enum in core, beside `COMPLEXITY`, and one `when:` key per fact. Each fact is one `scoreChoiceOver` call, made only when a row reads it, within `scorerTimeoutMs`, and recorded as a probability. `route-report` gains `policy_fact` rows. Tests: T9-2's, over the wider feature space. Maps plan §2.8 (an amendment), T9-2 and T9-4.
6. **RT-6 · The coordinator reads headroom before a batch** · S · process — the dispatch step reads the seven-day window, applies the owner's reserve with the taper, caps concurrent agents, and stops dispatching at the reserve with a one-line report. It lives in the coordinator's dispatch template and `docs/ops/agent-brief.md`.
7. **RT-7 · A ticket outcomes ledger** · S · process — one line per ticket, in each wave's housekeeping PR, with the §5.3 fields, taken from the PR's commits and review verdicts. The review agent's ten lines become routr's five report questions plus a verdict. It is summarised at each checkpoint, with no suggestion for a tier until it has 5 tickets.
8. **RT-8 · Tier agents carry an explicit effort** · S · owner's hand — first verify what effort an inline `Agent` with `model: opus` runs at. Then add tier agents for Opus at `medium` and at `high` beside `deep` (Opus at `xhigh`), so a ticket's "Run as" maps to a definition with its effort in frontmatter.

**Open questions for the owner.**

1. **Should a subscription provider take a reserve?** Today the schema refuses any limit on one. The options are a reserve with `critical_only` (routines and crews pause, your chat continues), a reserve plus one named overflow tier (new ground beside "no list of fallbacks"), or none. I recommend the first.
2. **Where may a usage reading come from, and what happens when none arrives?** The options are the plugin's statusline (opt-in), a scheduled host task running `claude -p /usage`, or provider headers. I recommend the statusline, failing closed only where you set a reserve.
3. **Facts: measure them on the Q-g fixtures as part of that run, or after serve?** Per-fact labels add owner time, though binary labels may be quicker than class labels (unmeasured). I recommend scoring real and generated items apart now, and leaving facts until after serve.
4. **For this repository:** what weekly reserve and agent cap should the coordinator respect, and where should the outcomes ledger live? And should wave dispatch stay on Fable or move to Opus, as the routing table in our own skill would suggest for coordination?

## Sources

- routr, `main` at `37d9c81` (2026-10-11, v0.6.0): <https://github.com/sirkirby/routr>. Files read: `LICENSE`, `install.sh`, `package.json`; `src/lib/{questions,advise,wording,pick,config,usage,statusline,systemone,providers,ledger,launch,harnesses,commands,cleanup,update}.mjs`; `docs/{ranking,evidence,telemetry}.md`; `skills/routr/{SKILL.md,references/{orchestrator,worker}.md}`. GitHub API `repos/sirkirby/routr` and its releases (fetched 2026-10-13).
- The post, <https://chriskirby.net/routr-balanced-orchestration-across-coding-harnesses/>, and the pages it links: <https://herdr.dev/>, <https://docs.typesafe.ai/concepts/system-one>, <https://blog.cloudflare.com/clef-decision-models/>. Also <https://code.claude.com/docs/en/statusline>. All fetched 2026-10-13.
- Metistry at `origin/main` `c33c9c08`: `CLAUDE.md` invariants 2, 3, 4 and 9, and the principle over them; `docs/ops/{dynamic-router,compute,agent-brief,crews,connections}.md`; `docs/product/tickets/{waves.md,t9/t9-3.md,t9/t9-4.md,t4/t4-19.md,t4/t4-11.md}`; `docs/product/design-build-plan.md` §2.8, §3.3; `docs/product/decisions-log.md:407`; `metistry-build-plan.md:2521`; `packages/core/src/{budget,session-summary}.ts`; `apps/assistant/src/budgets.ts`; `apps/console/src/dispatch.ts`; `collectors/claude-usage/{manifest.yaml,run.ts}`; `seed/queries/claude_usage_daily.yaml`; `.claude/skills/token-efficient-agents/{SKILL.md,references/model-routing.md}`; `.claude/agents/*.md`; `docs/research/{2026-09-21-intent-classification-tier,2026-09-cost-optimization,2026-10-04-claude-code-mods-review}.md`.
