# Model and effort routing data

```yaml
last_verified: 2026-09-10
verified_by: claude-api skill (bundled 2.1.260), cached model table 2026-06-24
staleness_days: 30
```

If `last_verified` is more than `staleness_days` old, refresh before routing — see
[Refreshing](#refreshing) at the bottom. Do not route from memory; model IDs,
prices, and effort ranges have all changed within a single quarter before.

## Models

| Alias (Claude Code) | Model | $/MTok in | $/MTok out | Context | Effort levels |
|---|---|---|---|---|---|
| `fable` | Claude Fable 5.1 (`claude-fable-5-1`) | 10.00 | 50.00 | 1M | low–max (thinking always on) |
| `opus` | Claude Opus 5 (`claude-opus-5`) | 5.00 | 25.00 | 1M | low–max |
| `sonnet` | Claude Sonnet 5 (`claude-sonnet-5`) | 2.00 | 10.00 | 1M | low–max |
| `haiku` | Claude Haiku 4.5 (`claude-haiku-4-5`) | 1.00 | 5.00 | 200K | **none — `effort` is rejected** |

Output tokens cost 5× input on every tier, so *what a subagent writes back* is
the dominant lever, not what it reads. A subagent that reads 40K tokens and
returns 300 is cheap. One that returns a 4K-token transcript is not.

`fable` and `opus` are the same price ratio apart as `sonnet` and `haiku`: each
step down the table is roughly half. A four-way split across tiers is worth more
than any prompt-level micro-optimisation.

## Effort levels

`low` · `medium` · `high` · `xhigh` · `max`. Claude Code's default is `xhigh`.
Effort scales thinking depth *and* tool-call depth — lower effort means fewer,
more consolidated tool calls and less preamble, which is a token saving on both
sides of the ledger.

Set effort only in agent-definition frontmatter (`effort: medium`). The `Agent`
tool has no effort parameter — see [delegation.md](delegation.md) for the
inline fallback.

**Never set `effort` on a `haiku` agent.** Haiku 4.5 rejects it.

## Measured tradeoffs

These are Anthropic's published numbers, not estimates. They are what makes a
routing decision defensible rather than a guess.

| Workload | Finding |
|---|---|
| Research / knowledge work | Effort curve is nearly flat. `low` gives up 1–3 points for 33–50% off; `medium` matched the `xhigh` default's accuracy at 70–85% of its cost. Above `medium`, nothing measurable was bought. |
| Long-horizon coding | A real trade. Opus 5 at `medium` gave up ~2 points for half the cost; at `low`, ~8 points for a quarter. |
| Deep multi-subtopic research | Every effort step bought ~2.4 rubric points. No free cut on this curve — this is the one shape that justifies `max`. |
| Anything with a pass/fail checker (tests, validator, typecheck) | Run everything at `low`, re-run only the failures at default: ~93% pass for ~$0.70/task vs 91.7% for $1.39 running everything at default. Starting at `medium` gave ~94% for ~$0.95. |
| High-volume, checkable, short answers | Haiku 4.5 answered knowledge questions at ~1/10 of Opus 5's cost per question, at 63% vs 92% accuracy. Right for bulk with a checker; wrong for long agentic loops. |
| Most agent workloads | Start at Opus 5. On a coding benchmark it matched Fable 5 (91.7% vs 91.3%) at ~60% of the cost. |
| Deep research specifically | Fable 5 at `low` beat Sonnet 5 while costing ~10% less per task. Reach for `fable` at low effort before `opus` at high effort on genuinely open-ended research. |

The load-bearing generalisation: **a stronger model at lower effort often beats
a weaker model at high effort, and costs less.** Step effort down before
stepping the model down.

## Task shape → tier

| Task shape | Model | Effort |
|---|---|---|
| Locate files, enumerate matches, "does X exist", mechanical greps | `haiku` | n/a |
| Bulk extraction / classification with a checkable output shape | `haiku` | n/a |
| Read a lot, return a short digest; trace a call path; summarise a subsystem | `sonnet` | `medium` |
| Bounded implementation against a written spec, with a test or typecheck to verify | `sonnet` | `xhigh` |
| Ambiguous design work, a hard isolated bug, security-sensitive reasoning | `opus` | `xhigh` |
| Correctness matters more than cost and there is no checker | `opus` | `max` |
| Open-ended multi-subtopic research, long-horizon autonomous work | `fable` | `low`–`medium` |

## Related

`docs/research/2026-09-cost-optimization.md` in this repo reads the same
Anthropic sources and records the project's own rulings from them — notably
that tiers are `(model, effort)` pairs, and that prompt caching is a larger
lever than either. Nothing here should contradict it.

## Refreshing

Only when the stamp is stale. One pass, then update this file's table and stamp
in the same session:

1. Invoke the `claude-api` skill — its cached model table and
   `shared/cost-optimization.md` § 2.6–2.7 are the source for everything above.
2. If that skill is unavailable, `WebFetch` <https://platform.claude.com/en/docs/about-claude/pricing>
   and <https://platform.claude.com/en/docs/build-with-claude/extended-thinking>.

Refreshing costs a few thousand tokens once a month. Routing a month of sessions
onto a model that no longer exists costs more.
