# Claude Code Mods — can they enforce the agent brief, and are they a better door into Metistry? (2026-10-04)

Research answering the owner's 2026-10-04 ask: "Claude just released Mods, a new feature that lets developers add custom hooks into the Claude flow and user interface. We
should review and see if it's a good thing for us to use or not." Nothing is built; this PR adds one document and no product code.

Sources, **all fetched 2026-10-04** from `https://code.claude.com/docs/en/`: `plugins/mods/` pages `overview` (`ov`), `create` (`cr`), `reference` (`rf`), `interface` (`if`),
`events` (`ev`), `api` (`ap`), `test`, `troubleshoot` (`ts`), `admin` (`ad`), `gallery`; plus `hooks` (`hk`), `plugins/overview`, `plugins/org` (`org`), `plugins/host-marketplace`
(`hm`), `changelog` (`cl`); and the local `plugin-authoring` skill's engine-written `types/claude-code.d.ts` (`types:`). `§` is a page heading. **Nothing was run**: no mod was
written, loaded or validated; the sample mods and the `sandboxing` page were not read. Metistry claims cite `origin/main` `6fe300de`: `CLAUDE.md`, `docs/ops/{agent-brief,
claude-code-plugin,client-api,board,going-public}.md`, `ops/git-hooks/pre-push`, `.claude-plugin/marketplace.json`, `plugins/claude-code/`, `packages/cli/src/connect.ts`,
`packages/mcp-brain/README.md`, `docs/research/2026-09-30-hindsight-review.md`.

## 1. What Mods are

- **A plugin whose code runs inside Claude Code**: JS/TS functions ("hooks") registered by `register(on)`; three files (`plugin.json`, `hooks/hooks.json` with `modules`, `hooks/register.*`),
  no build step (`ov` §How a mod works; `cr` §Write a mod yourself). Settings hooks (shell, HTTP, prompt) are unchanged and not deprecated (`ad` §Know which controls still apply).
- **Released 2026-10-01 in v2.1.287** ("Added Claude Mods"); .288 (10-02) and .289 (10-03) each changed mods (`cl`). It was three days old at the fetch.
- **What a hook can hook**: tool calls (`tool.call` observe, rewrite, `{deny}` or `{result}`; `tool.check` allow/ask/deny), prompts (`prompt.submit` rewrite, add context or drop), commands,
  turns (`turn.step` can switch the model), session events, subagents (`agent.offer`; `agent.spawn` deny or choose model), `attribution.text`, `plugin.register` (refuse another mod), and
  every settings-hook event as `classic.<Event>` (`rf` §Events). `tool.call` fires for subagents' and MCP calls (`ev` §Guard or change a tool call) and carries `agentId` (`types:` L11774).
- **What a mod can call**: `$.fs`, `$.process.run/spawn` (argv, no shell), `$.http.fetch`, `$.model.complete`, `$.prompt.submit` (can send as the user), `$.session.send`, `$.store`, `$.clock`,
  `$.mcp.call`, `$.env`, `$.settings.read` (`rf` §Mods API methods). **Not sandboxed**: it acts as the user, reads secrets, and a process it starts escapes Claude Code's sandbox (`ov` §What a mod can reach).
- **What it can draw**: a pane (sidebar in a wide fullscreen terminal, else above the prompt), a band above the prompt, status line, toast, log line, and re-skins of Claude Code's own rows
  and question dialog — never the permission prompt. `Raster`/`Image` are terminal-only, `Svg` desktop-only; a pane opened unasked waits for 144 columns (`if` §Pick where to draw, §Open a pane; `rf` §Elements).
- **Distribution and reload**: a plugin installed from a marketplace (`/plugin install x@mkt`), `--plugin-dir` for one session with reload on save, `/reload-plugins`; installs are cached by `version`
  (`ov` §Install or update; `cr` §Share your mod). A repository can register a marketplace in committed `.claude/settings.json`, honoured after folder trust (`org` §Require plugins per repository).
  `claude plugin validate` lists the `hooks:` and `calls:` a module uses without running it; `claude plugin test` needs no session (`ad` §Review what a mod can do; `cr` §Test the mod).
- **Platforms**: hooks run in the terminal, Desktop Code tab, VS Code chat, `claude -p`/SDK and cloud sessions; drawing only in the terminal and Desktop Code tab; nothing in WSL desktop sessions.
  Cursor, OpenCode and Devin are out of reach (`ov` §Where mods run).
- **Stability: early access.** "The events and methods can change between releases, so trust these files over any page" (`cr` §Get type definitions); the declarations open "EARLY ACCESS: this surface
  may change between releases without notice" (`types:` L4); no deprecation policy is published. **Unverified:** the engine wrote those types as 2.1.286, yet the docs say mods need 2.1.287 (`ov` §Turn mods on or off).
- **Fail-open by default**: a hook that throws, times out (10 s) or returns a bad shape is skipped; a guard needs a `.catch` returning `{deny}` (`ev` §Handle a hook that fails; `rf` §Limits). Three worker
  crashes unload **every** non-built-in mod for the session; `--safe-mode`, `--bare` and `disableAllHooks` switch installed mods off (`ts` §mods that run in the hooks worker are off; `ov` §Turn mods on or off).

## 2. Angle A — building Metistry

The brief's rules (`docs/ops/agent-brief.md` §Where you work, §How you finish) rest today on prose, a `pre-push` hook (`ops/git-hooks/pre-push`) and the `Main` ruleset (`docs/ops/going-public.md:181`); no
`.claude/settings.json` is in the tree, and the ports, Keychain and trailer rules live in the dispatch prompt, not the brief. **Settings hooks already cover every guard asked for**: `PreToolUse` takes a matcher,
can `deny` or rewrite input, exits 2 to block, and fires inside subagents with `agent_id` (`hk` §PreToolUse, §Exit Code 2, §Hooks in Subagents). A mod adds the screen, not the lock.

| Candidate | Settings hook / git hook today | Needs a mod | Verdict |
| --- | --- | --- | --- |
| Refuse Edit/Write outside the ticket's worktree (or in the main checkout) | **Yes**: `file_path` is structured, so the check is exact | no | **Take, as a hook** (MD-1) |
| Refuse `security` against the login Keychain; refuse ports 5432, 8080, 7810–7815 | Yes: `Bash` matcher or a `Bash(security *)` deny rule | no | **Take as a hook, call it a reminder**: it matches command text, which `sh -c`, `osascript` or a script evade; the docs say the same of a `git push` text match (`ev` §Approve or refuse). The boundary is the OS |
| Require the Fable commit trailer | Partly: a `Bash(git commit *)` text check is fragile (heredocs); a `commit-msg` git hook is exact and harness-independent | `attribution.text` could **write** the trailer rather than check it | **Take the `commit-msg` hook** (MD-1); **spike** the rewrite (MD-2) |
| Block pushes to `main` | Already: `pre-push` + the `Main` ruleset | `ev`'s `tool.check` example is text-only | **Skip**: done at git and the host |
| Merge queue / CI / wave status pane | No: settings hooks cannot draw | **Yes**: `/waves`, `$.clock.every` + `$.process.run` for `env -u GH_TOKEN gh pr list`, `$.fs.read` of `docs/product/tickets/waves.md` | **Pilot, read-only** (MD-3) |
| Subagent completions (branch, PR) as they land | `SubagentStop` hook can log | `turn.complete` carries `agentId` for a pane | **Fold into MD-3** |
| Pin a subagent's model from the ticket's `model:` | `.claude/agents/*.md` already pin per type | `agent.spawn`, but it must parse a dispatch prompt | **Skip**: converged, fragile |
| Cost band; hold risky commands with `$.ui.ask` | Custom status lines exist (`ov` §What a mod can do) | `$.session.usage()`, `ui.ask` | **Skip**: `ui.ask` rejects in an unattended run, so nobody answers (`ev` §Hold a tool call) |

**Why a mod is the wrong lock.** (1) *Not final*: a mod's `tool.check` can approve a call that a `PreToolUse` hook outside managed settings blocked; deny rules bind mods only where the built-in guard loads
(managed settings, or a Team/Enterprise login); a repository cannot set `prependPlugins` (`ad` §Know what happens by default, §Install your organization's mods). **Unverified:** whether the owner's machine loads
that guard. (2) *Fail-open* (§1). (3) *The same text-match limit as a hook*, plus a plugin to maintain. (4) A guard an agent can edit is not a guard; `~/.claude` and `--plugin-dir` folders are protected paths
only in `default` and `acceptEdits` modes (`cr` §Ask Claude for a mod, §Change a mod with Claude).

**Cost and placement.** A guard is ~50 lines on an API its own types call early access, with three releases in three days: expect to re-read the changelog per release (`cl`). If one ships, keep it **out of the product
marketplace** (`.claude-plugin/marketplace.json` lists `metistry` for strangers): a second marketplace directory (say `ops/claude-mods/`) registered through committed `.claude/settings.json`
`extraKnownMarketplaces` with a relative `directory` source, which resolves against the **main checkout**, so a ticket's worktree cannot rewrite the guard that governs it (`org` §Require plugins per repository).
Plain hooks need no plugin. **Unverified:** whether a mod loads in a `claude -p` subagent the coordinator spawns as its own process (`ov` says hooks run in `claude -p`), and whether a `.claude/skills/<dir>/.claude-plugin`
plugin may carry a hooks module.

## 3. Angle B — the product

**Today.** `metistry connect` reaches four tools (`packages/cli/src/connect.ts:36`); for Claude Code it mints a capture bearer, and the `metistry` plugin adds a capture skill and an opt-in `SessionEnd` hook
(`docs/ops/claude-code-plugin.md` §3–§5). Reading knowledge is the MCP bridge (`packages/mcp-brain/README.md`: `knowledge_search`, `capture`, `requests_create`). There is no `SessionStart` hook, and the Hindsight
review left push-of-handles an open question (Q1, `2026-09-30-hindsight-review.md` §6).

**What a mod adds — for the owner's eyes, not the model's.** A pane or band draws to the terminal and never reaches the model unless the mod calls `prompt.submit` or `prompt.context` (`rf` §Prompts; `ap` §Start a turn
from a background job), so it sidesteps the injection risk the Hindsight review recorded: remembered text would be *shown*, not *injected*.

| Idea | What a mod gives that MCP and hooks do not | Needs from the product | Take? |
| --- | --- | --- | --- |
| Session-start briefing pane | A human-facing view at the prompt; a `SessionStart` settings hook can only add model context (`if` §Open a pane; `hk` §SessionStart) | a named query for the briefing, `expose`d to the capture owner token, which reaches `GET /api/q/:name` (`client-api.md:75-80`) | **Complement, later** |
| Capture-to-Inbox from the terminal | an `Input` in a pane and `$.http.fetch` POST `/capture` | nothing; the CLI and skill already do it | **Skip**: marginal |
| Needs You band | a live count above the prompt | `GET /api/needs-you/count` is owner-only (`client-api.md:281`); a counts-only named query like `board_projects` (`board.md`) is the missing door | **Door first, band optional**: the same query feeds a status-line script with no mod |

**Better, or a complement?** A complement, and a narrow one. The MCP bridge reaches four tools; a mod reaches one, on two surfaces. Needs You already has the Mac app, the Dock badge and push (`client-api.md:281, 681`),
so the mod's only unique value is attention *inside* the terminal. It could ship in the **existing** plugin: `hooks.json` "can also hold settings hooks" beside `modules` (`rf` §Files), so `plugins/claude-code` keeps its
`SessionEnd` hook. **Unverified:** how a Claude Code older than 2.1.287 treats `modules`.

**Risks.** (1) *Claude-Code-only and early-access*: a product feature on a surface its vendor says may change without notice, cached by `version` on a stranger's machine (`hm` §Release a new version). (2) *Invariant 9*
binds the assistant's engine, not the owner's Claude Code, but a shipped mod runs as the stranger, so it should hold itself to the same surface: declare only `ui.*`, `command.*`, `http.fetch`, `env.get` and `store`;
no `process`, `fs`, `prompt.submit`, `session.send`. `claude plugin validate` prints exactly that `calls:` list, a **testable boundary** (invariant 8; `ad` §Review what a mod can do): MD-4. (3) The bearer sits in the
session environment, as for the hook today, and a mod can read every variable: ship the minimum, never the local owner token. (4) Off the terminal and Desktop tab the drawing disappears (`ov` §Where mods run).

## 4. Recommendation

**Dev side: use hooks now, pilot mods for display only. Product side: wait.**

- *Enforcement belongs where it can be exact*: Edit/Write path checks and a `commit-msg` hook need no early-access API; Bash text-matching is a reminder however it is written. Mods add fail-open and churn. **MD-1 now.**
- *Display is the one thing only a mod does*: a read-only wave/PR/CI pane is cheap and low-regret. **Pilot** after a spike (MD-2) settles the unverified items.
- *Product: wait*: one surface, an API that moved three times in its first week, and the door a band needs (MD-5) is useful without it. Revisit after a release or two with no breaking mods change.

**Tickets** (proposed; none is in the plan):

1. **MD-1 · Dev guards as settings hooks and a `commit-msg` hook** · S — `.claude/settings.json` `PreToolUse` scripts under `ops/claude/` (Edit|Write outside the worktree or in the main checkout; `security`; the five ports;
   `git commit` without the trailer) plus `ops/git-hooks/commit-msg`; misuse tests feed hook JSON on stdin and expect exit 2; maps `agent-brief.md`, U3; its README says Bash rules are reminders.
2. **MD-2 · Spike: what a mod can do here** · S — a throwaway mod from a scratch directory via `--plugin-dir`; answers `attribution.text`, `agent.spawn` on a real dispatch, subagent-process loading, the `.claude/skills`
   question and the guard on the owner's machine; output is a note, not a merge.
3. **MD-3 · Wave/PR/CI pane for the coordinator** · M · after MD-2 — dev-only plugin in `ops/claude-mods/`; `/waves`, read-only, no `fs.write` or `prompt.submit`; maps `docs/product/tickets/waves.md`, `ops/scripts/tickets.mjs`.
4. **MD-4 · A `calls:` allowlist check for any mod we ship** · S — CI runs `claude plugin validate --json` and fails on a call outside the list; maps invariants 8, 9. **Asks first:** it puts the `claude` binary in the runner.
5. **MD-5 · A counts-only Needs You query for the capture owner token** · S — named query with an `expose`; misuse tests (401, 403, the uniform unknown-query answer); maps `client-api.md` §`expose:`, X-49 (no new tool).
6. **MD-6 · Pilot: an optional module in `plugins/claude-code`** · M · gated on MD-2, MD-4, MD-5 and the owner's go — briefing pane and Needs You band, text fallback off-terminal; maps HS-1, `claude-code-plugin.md`.

## 5. Open questions for the owner

1. **Where does the coordinator run — terminal or the Desktop Code tab?** Both draw; VS Code and WSL sessions do not. It decides whether MD-3 is worth anything.
2. **Are `.claude/settings.json` and `ops/claude/` human-change paths** (invariant 2)? A guard an agent can edit is not one, and the free tier has no code-owner rule, so it is convention plus review.
3. **Trailer: check or write?** A `commit-msg` check refuses; `attribution.text` (`rf` §Prompts) would make it right by construction but is early-access and unrun here.
4. **Does a Claude-Code-only, early-access surface belong in the product at all?** If not, MD-4 and MD-6 drop and MD-5 stands alone.
5. **Spike now?** MD-2 is a half-day for an agent; the owner only launches `claude --plugin-dir <scratch>` once, and nothing is installed.
