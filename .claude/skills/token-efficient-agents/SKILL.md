---
name: token-efficient-agents
description: Route a large, multi-part task across models and effort levels for the least token spend — pick the orchestrator's own model and effort, decide whether delegating pays at all, dispatch subagents at the cheapest tier that can do each subtask, and call the moment to compact, clear, or start a fresh session. Use when a task is big enough to need a plan and several independent pieces (a migration, an audit, a multi-file refactor, a research sweep), when the user asks to run something cheaply or efficiently or with subagents, or when they ask whether to clear, compact, or start over.
user-invocable: true
---

# Token-efficient orchestration

Read [references/model-routing.md](references/model-routing.md) now. It carries
the model table, effort levels, and the measured cost/quality tradeoffs every
decision below rests on. Route from that file, never from memory — model IDs,
prices, and effort ranges have all changed inside a single quarter.

If its `last_verified` stamp is older than `staleness_days`, refresh it first
per that file's Refreshing section, then continue. Otherwise do not touch the
network.

## 1. Classify the task

Answer four questions before planning anything:

- **Shape** — one dependent chain, or genuinely independent pieces?
- **Bulk** — how many pieces, and do they fit in one context together?
- **Checker** — is there a test, typecheck, validator, or diff that says
  pass/fail? A checker changes the whole economics (see the re-run-failures row
  in the routing table).
- **Cost of error** — recoverable, or not?

## 2. Route yourself

Recommend the orchestrator's own model and effort against the task-shape table.
State it in one line — current setting, recommendation, why:

> This is coordination over independent pieces with a typecheck as the checker
> — Sonnet at `medium` is the right seat for it; you're on Opus at `xhigh`.
> Switch with `/model`, or say continue and I'll proceed here.

Then **stop and wait**. A session cannot change its own model or effort
mid-flight, so this is a recommendation, not an action. If the user says
continue, proceed on the current setting and keep your own reasoning minimal —
push the work down to cheap subagents instead.

Skip this step entirely when the current setting already matches. Do not
narrate a non-recommendation.

## 3. Decide whether to delegate

Apply the three-part gate in [references/delegation.md](references/delegation.md).

If the gate fails — one dependent chain, or the whole thing fits in one context
— **say so and do the work yourself at lower effort.** That is the measured
cheaper answer, not a cop-out. Delegation that doesn't clear the gate pays for
a plan, a handoff and a merge that a single model gets for free.

## 4. Plan the split

Write the subtask list before spawning anything. For each: the tier from the
task-shape table, the scope ceiling, and the output contract. Show the user the
plan as a short table (subtask / tier / why) — the routing should be visible,
since they are paying for it.

Prefer fewer, larger subtasks. Each spawn costs a fresh system prompt and a
report the orchestrator re-reads on every later turn.

## 5. Dispatch

Use the tier agents (`scout`, `digest`, `implement`, `deep`) when they appear in
the available-agents list. When they don't — any checkout that doesn't ship
them — fall back to inline `Agent` calls with a `model` override and a scope
ceiling in the prompt, per the delegation reference. Effort is not settable
inline; the prompt has to carry that weight.

Launch independent subagents in a single message so they run concurrently.

Every prompt leads with its output contract. This is the highest-leverage line
in the skill: output tokens cost 5× input, and a subagent's report is re-read on
every subsequent orchestrator turn, so an unbounded report is billed repeatedly.

## 6. Merge and report

Integrate the digests. Close with two or three lines: what ran at which tier,
and what the naive alternative would have been. If you declined to delegate,
say that too — a skill that only ever fans out is not a routing skill.

## 7. Call the context boundary

A phase just ended. That is the cheapest moment in the whole run to shed
context, and the most expensive moment to keep it: everything still in the
transcript is re-billed on every remaining turn, and the detail that earned its
place during a phase rarely earns it after.

Recommend one of three and **wait** — `/compact` and `/clear` are the user's
commands, and clearing is not reversible. Say which, and why, in a line or two.

| Situation | Recommend |
|---|---|
| The next phase builds on this one's conclusions, and the conclusions are short | **Write a handoff, then `/clear`** |
| The next phase needs continuity you can't write down in a page | **`/compact`** |
| The next task is genuinely unrelated to this one | **`/clear`** |
| The working directory, repo, or worktree changes | **New session** |
| The transcript is mostly a record of approaches that didn't work | **Write a handoff, then `/clear`** — never `/compact` |

**The handoff is the technique.** Before clearing, write the live state to a
short file — decisions made, what's done, what's next, the three file paths that
matter. Then `/clear` and open with that file. It beats `/compact` on fidelity
*and* on tokens: you choose what survives instead of paying a summarisation
pass over everything and accepting what it kept.

Prefer `/compact` over letting auto-compact fire. A compaction you call at a
boundary summarises spent detail; one that fires mid-task summarises the thing
you are in the middle of.

Never `/compact` a transcript whose bulk is failed attempts. The summary carries
the failures forward faithfully and at length, which is the opposite of what you
want — the next session should start from what you learned, in one paragraph,
not from a transcript of how you learned it.

Signals to raise this outside a delegated run, unprompted:

- Subagent digests are merged and the raw exploration behind them is dead weight.
- A long debugging tangent just resolved — the resolution is three lines, the
  tangent is not.
- Something large got read into context for one question that has been answered.
- The user is about to start a task with no relationship to the last one.

Raise it once, briefly. If they say keep going, keep going and don't ask again
until the next boundary.

## Cache discipline

Prompt caching is a bigger lever than model or effort selection — 2.7–5.3× on
agent loops — and an orchestrated run is exactly the shape that benefits.
Cache reads cost a tenth of input; a break costs a rewrite. So:

- **Change effort at most once, at step 2, before any work.** Changing it
  mid-run invalidates the cache for everything after it and destroys the saving
  the change was meant to buy.
- **Prune at task boundaries, not mid-task** — step 7. Measured: 89% cache
  reads on the turns after a boundary prune, against mid-task editing, which
  breaks the cache from the edit point on and saves nothing.
- Each subagent starts a fresh context. That is a feature — it is why bulk
  reading belongs in a subagent rather than in the orchestrator's own history,
  where it is re-billed every turn.

## Standing rules

- **Cheapest tier that can actually do the subtask.** Not the cheapest tier.
  A haiku scout that misses half the call sites costs a re-run plus the wrong
  answer.
- **Effort down before model down.** A stronger model at lower effort routinely
  beats a weaker model at high effort, and costs less.
- **Never set `effort` on a haiku agent** — Haiku 4.5 rejects the parameter.
- **Never paste conversation history into a subagent prompt.** If a subtask
  needs the transcript, it isn't separable; do it yourself.
- **Recommend context boundaries; never take them.** Say when to compact,
  clear, or start fresh, then wait. Losing context the user still wanted is
  worse than carrying it a phase too long.
- **Report honestly.** If a subagent came back thin or wrong, say so and
  re-run at the next tier up. Don't paper over it with your own guesses.
