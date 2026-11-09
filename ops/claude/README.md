# ops/claude — guards for agent sessions

Three scripts that back the rules in `docs/ops/agent-brief.md` with something a
tool enforces, wired by the committed `.claude/settings.json` (two `PreToolUse`
hooks) and `ops/git-hooks/commit-msg`. No Claude Code mod, no early-access API —
settings hooks and a git hook only. Ruled 2026-10-04 (research
`docs/research/2026-10-04-claude-code-mods-review.md` §2, §4 MD-1).

**These paths are human-change paths** (`.claude/settings.json`, `ops/claude/`,
`ops/git-hooks/`): a guard an agent can edit is not a guard. They change by a PR
the owner reviews; an agent PR that touches them stays open for the owner.

| Guard | Fires on | Refuses | How firm |
| --- | --- | --- | --- |
| `guard-path.mjs` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | any path in the main checkout, or outside `../metistry-*` and the session scratch directory (`<tmp>/claude-<uid>/`); `..` and symlinks resolved first | **Exact** for these tools: `file_path` is structured input. Does **not** cover a Bash `sed -i` or redirect |
| `guard-bash.mjs` | `Bash` | `security` without an explicit non-login keychain file, `launchctl`, `caffeinate`, `pmset`, and `5432`, `8080`, `7810`–`7815` as host:port, `-p`/`--port`, or `…PORT=` | **A reminder, not a control.** It matches command text; `sh -c "$(…)"`, a script, `osascript`, or a variable evades it. The boundary is the OS |
| `ops/git-hooks/commit-msg` | `git commit` in an agent session | a message without `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` | Exact on the finished message. Detection of "agent session" is `CLAUDECODE=1`, which Claude Code exports into every shell it runs (subagents and `claude -p` children too) and the owner's terminal does not have; `unset CLAUDECODE` defeats it |

A refusal is exit 2 (the Claude hooks; stderr goes to the model) or exit 1 (git).
Malformed hook input is refused too. Every hook also fires inside subagents.

## Worktree rule, precisely

Allowed writes: inside a sibling of the main checkout named `metistry-*` (the
brief's `../metistry-<id>`), and inside `<tmp>/claude-<uid>/` (the session
scratchpad, for a PR body and the like). The main checkout is found from the
git common dir of the hook's `cwd`. It cannot tell *your* worktree from another
ticket's `metistry-*` sibling, nor a research worktree: any `../metistry-*` is
allowed.

## Owner bypass

- **Claude hooks:** `METISTRY_GUARD_ALLOW=1` in the **session's environment**.
  Put it in `.claude/settings.local.json` (`"env": {"METISTRY_GUARD_ALLOW": "1"}`,
  gitignored) of the checkout where you work as owner/coordinator — otherwise
  the main checkout is read-only for any session started there. Text inside a
  command (`METISTRY_GUARD_ALLOW=1 launchctl …`) does not count; a hook sees the
  harness's environment, not the command's.
- **`commit-msg`:** `METISTRY_ALLOW_NO_TRAILER=1 git commit …` for one commit;
  `METISTRY_REQUIRE_TRAILER=1` demands the trailer from everyone;
  `METISTRY_TRAILER='…'` changes the required line when the model version moves.
  Merge commits are never checked.

## Installing

- `.claude/settings.json` is read from the project directory: nothing to install.
  It reaches a session when the branch containing it is merged to `main` (a
  session in a worktree reads its own copy).
- `commit-msg` lives in the shared git dir, like `pre-push`:
  `pnpm hooks:install` (`ops/scripts/install-git-hooks.sh`) copies every file in
  `ops/git-hooks/` there once for all worktrees. **Re-run it after this merges**,
  and after any change to a hook — the installed file is a copy.

Tests: `node --test ops/scripts/test/claude-guards.test.mjs` feeds each script
fixture input as a child process (and a real `git commit` through the installed hook).
