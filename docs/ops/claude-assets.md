# Claude Code assets in this repo

`.claude/skills/` and `.claude/agents/` are tracked. They are the source of
truth for the Claude Code skills and subagent definitions this project
maintains, and they are shared with every session on the machine rather than
kept to sessions started inside the checkout.

```bash
./ops/scripts/install-claude-assets.sh
```

That symlinks each skill directory into `~/.claude/skills/` and each agent
definition into `~/.claude/agents/` (or `$CLAUDE_CONFIG_DIR` if set). Symlinks,
not copies — `git pull` is the update path, and there is no second copy to
drift. The script is idempotent, refuses to replace anything that is not
already one of its own links, and `--uninstall` removes only what it made.
Restart running sessions to pick up changes.

It always resolves the **main** checkout, never a worktree under
`.claude/worktrees/`, so links made from a feature branch don't rot when that
worktree is removed. Run it from any worktree; it links the main one.

## What ships today

- **`token-efficient-agents`** (skill) — routes a large task across models and
  effort levels for the least token spend: picks the orchestrator's own model
  and effort, decides whether delegating pays at all, dispatches subagents at
  the cheapest tier that can do each subtask, and calls the moment to compact,
  clear, or start a fresh session (writing a handoff file first, which beats
  `/compact` on both fidelity and tokens). Its
  `references/model-routing.md` carries a dated model/price/effort table with a
  30-day staleness stamp; the skill refreshes it from the `claude-api` skill or
  Anthropic's docs when the stamp expires, so new model releases and effort
  changes reach it without a code change.
- **`scout` / `digest` / `implement` / `deep`** (agents) — the four tiers that
  skill dispatches to, each pinned to a model and (where the model supports it)
  an effort level. `effort` is only settable in agent frontmatter — the `Agent`
  tool takes a model override but no effort parameter — which is the whole
  reason these exist as files rather than inline prompts. Haiku 4.5 rejects
  `effort`, so `scout` sets none.

## Adding another

Drop it in `.claude/skills/<name>/SKILL.md` or `.claude/agents/<name>.md` and
re-run the installer. `SKILL.md` is an allowed uppercase filename in
`ops/scripts/check-path-case.sh`; everything else under `.claude/` is lowercase
like the rest of the repo.
