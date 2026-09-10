# Delegation mechanics

## The gate: does delegating pay at all?

Measured, on Anthropic's own benchmarks: an orchestrator that plans and hands
bulk work to cheaper workers cost **55% less** than the frontier model working
alone, scoring 3–7 points below its best — *but only on work larger than any
single context window.* On routine search work it paid as tail insurance (about
half the average cost, a third at the 90th percentile) and then **reversed on
the harder full set**. And:

> When the work is one dependent chain, or fits in a single context, the
> orchestrator pays for a plan, a handoff, and a merge that a single model gets
> for free. In every such case measured, the coordinator's model alone at lower
> effort came out ahead.

So the honest answer is often "don't delegate, drop your own effort instead."
Delegate when **all three** hold:

1. **Bulk** — three or more pieces that don't depend on each other's results.
2. **Context weight** — the pieces involve reading material the orchestrator
   would otherwise have to hold, and the useful residue is much smaller than
   the material. (Read 50 files, return 20 lines.)
3. **A clean contract** — you can state each subtask's input and output without
   handing over the whole conversation.

One dependent chain fails (1). A three-line edit fails (2). "Figure out what I
want" fails (3).

## Tier agents

If `scout` / `digest` / `implement` / `deep` resolve as agent types, use them —
they carry tuned `model` + `effort` + a restricted tool set. Check the
available-agents list in context; do not probe the filesystem for them.

| Agent | Model / effort | Tools | Use for |
|---|---|---|---|
| `scout` | haiku (no effort param) | Read, Glob, Grep, Bash | Locate, enumerate, exists-checks, mechanical sweeps |
| `digest` | sonnet / medium | Read, Glob, Grep, Bash, WebFetch | Read-heavy work returning a short digest; trace a flow; summarise a subsystem |
| `implement` | sonnet / xhigh | full edit + Bash | Bounded change against a written spec, self-verified with a test or typecheck |
| `deep` | opus / xhigh | full edit + Bash | Hard isolated subproblem, ambiguous design, security reasoning |

## Inline fallback (outside this repo)

The `Agent` tool takes a `model` override (`haiku`/`sonnet`/`opus`/`fable`) but
**no effort parameter** — effort exists only in agent-definition frontmatter.
Outside a checkout that ships the tier agents, you therefore control the model
but not the thinking depth, and the subagent runs at the harness default
(`xhigh`).

Compensate in the prompt, since you cannot compensate in config:

- Use `Explore` with `model: "haiku"` for scout work — it is already read-only
  and excerpt-oriented.
- Use `general-purpose` with an explicit model for everything else.
- Add a scope ceiling to the prompt: *"Do not explore beyond the files named
  below. Stop as soon as you can answer."* This is the only effort lever you
  have inline, and it recovers most of the difference on scout-shaped work.
- Never delegate a `max`-effort-shaped task inline. If correctness matters more
  than cost and there is no checker, do it in the orchestrator.

## Subagent prompt contract

Every delegated prompt states, in this order:

1. **The output contract, first and explicitly** — what to return and how long.
   "Return at most 15 lines: the file:line of each call site and one clause on
   what it does. No code blocks, no file contents, no preamble."
2. **The scope ceiling** — which paths or symbols are in bounds.
3. **The task.**
4. **What not to do** — most usefully, "do not fix anything you find; report it."

The output contract is the single highest-leverage line in the whole skill.
Output tokens cost 5× input, and a subagent's report is re-read by the
orchestrator on every subsequent turn — an unbounded report is billed
repeatedly, not once.

Other rules:

- **Never** tell a subagent to "read the codebase and report back" without a
  path list. That is how a delegation costs more than doing it yourself.
- Launch independent subagents in **one message** so they run concurrently.
- Ask for `file:line` references rather than quoted code. The orchestrator can
  read the two lines it actually needs.
- One subtask per agent. A subagent asked to do three things returns three
  times the tokens and gets the ordering wrong.
- Give a subagent the *conclusions* it needs, never the transcript. If you find
  yourself pasting conversation history into a prompt, the subtask is not
  separable — do it yourself.

## Reporting

At the end of a delegated run, tell the user in two or three lines: what ran at
which tier, and what the alternative would have been. They are paying for this;
the routing should be visible, not implicit.
