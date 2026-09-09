# Stash review — lessons for Metistry (2026-09-09)

Owner prompt: [Fergana-Labs/stash](https://github.com/Fergana-Labs/stash) is a
more generalised approach to what Metistry does; look for architecture
and interface lessons, and for skills, collectors, and connections to
consider.

## What it is

"The one place your agents connect to all your data": an agent-native
workspace. MIT, ~332★, ~2.5k commits, Python backend + web app + CLI
(`stash`) + MCP server (~70 read/write tools) + REST + a virtual
filesystem shell + desktop and Chrome clients; self-hosted with compose
and prebuilt images, or their cloud. The pieces:

- **Session recording.** `stash signin` detects every coding agent on the
  machine (Claude Code, Cursor, Codex, OpenCode, Gemini CLI, …) and
  installs hooks that push *every transcript — prompts, tool calls,
  artifacts*; `import-history` back-fills past sessions. On by default,
  `stash stop` pauses.
- **Memory curator.** A nightly job "reads whatever is new since its last
  run — sessions, files, saves — and compiles it into linked pages:
  entities, concepts, and a running log. It writes only inside the
  reserved Memory folder, and never reads its own output."
- **Virtual filesystem.** Sessions, files, Memory, Skills and connected
  sources browsed as one tree: `stash vfs ls / | tree | find | rg`.
- **Skills** are folders with a `SKILL.md`; publish, fork, `install`,
  `follow`; installed skills auto-update at session start.
- **Connectors**: GitHub, Drive, Gmail, Slack, Notion, Linear, Jira, Asana,
  Granola, PostHog, X, Instagram, Obsidian vaults — Slack and Linear by
  webhook, the rest on a schedule.
- **A chat agent in the box** (Claude Code / Codex / opencode on a cloud
  VM) reachable from the app, Slack, or Telegram.

## Where it lines up with Metistry

| Stash | Metistry today |
| --- | --- |
| Hooks push transcripts | `plugins/claude-code`: a capture skill and an opt-in SessionEnd summary (#46) |
| Memory curator compiles new material into a linked wiki nightly | §4.11 "Metis folds reports into knowledge on the evening routine" — designed, not built |
| VFS over everything | vault bridge `list/read/search/log/diff`; `knowledge_search/read` over `/mcp` |
| Skills as folders, install/follow/auto-update | §4.4 skills as folders; no install/share verbs yet |
| Connectors, webhook or schedule | collectors, schedule only |
| ~70 MCP tools | 21 tools, eager discovery, PoC-17's line at 20 |
| Chat via Slack/Telegram | the web door only (D1) |

The framing difference is the lesson: Stash is *memory for agents*
(everything in, compile later); Metistry is *a persistal assistant with a
curated vault* (proposals in, the one writer folds). Their curator's
three rules are exactly the constraints our fold needs, arrived at the
hard way.

## Worth taking

1. **The memory curator's rules, applied to our evening fold.** Build the
   §4.11 fold as a real routine, **`knowledge-fold`**, with Stash's three
   constraints as invariants: reads only what is new since its last run
   (accepted proposals, reports, session summaries, artifacts); writes
   only inside reserved paths (`Knowledge/Journal/<date>.md` plus entity
   pages it owns under `Knowledge/People|Projects|Resources`, each
   stamped `source: knowledge-fold`); never reads its own output as
   input. Routines never call a model (invariant 4), so the routine
   assembles the handles and **enqueues one assistant turn** kind `fold`;
   the assistant (the one writer) composes the pages with `knowledge_write`
   under its grant, and anything touching `Me/` or a protected path goes
   through a proposal. This is the highest-value item in the review: it
   is what turns captures into a vault.
2. **Sessions as a capture source, summarised, opt-in.** Full-transcript
   recording is the wrong default for us (foreign content is untrusted;
   D1 dropped iMessage for less), but *summaries* of coding sessions are
   exactly the "what did we already try" context the fold wants. Two
   pieces: the existing SessionEnd hook, and a host-side
   **`metistry import-sessions`** verb that reads Claude Code's local
   transcripts (`~/.claude/projects/*/*.jsonl`, host only — the console
   container never sees a home directory), produces deterministic
   summaries (title, first prompt, repo, files touched, tools used,
   duration, cost) and posts them to `/capture` as kind `session` with
   provenance. No model; the fold gives them prose later.
3. **Filesystem semantics for agents.** `stash vfs rg` is a good interface:
   agents think in paths. Add `knowledge_list(prefix, depth)` and
   `knowledge_grep(pattern, prefix)` to `mcp-brain` (both gated by the
   same tiers; grep is the bridge's keyword search with a regex), and
   expose vault notes as **MCP resources** (`metistry://Knowledge/...`)
   so clients that browse resources can. Tool count rises to 23; the
   PoC-17 threshold is measured in definition tokens (#77 discussion),
   so measure before flipping discovery to lazy.
4. **Webhook ingress for collectors.** Their Slack/Linear split is right:
   some sources push. Add `POST /webhooks/<collector>` with a per-source
   shared secret (HMAC where the source signs) that enqueues a run for
   that collector; the collector stays a directory with a manifest
   (`ingress: webhook | schedule | both`). Small, and it unblocks the
   work-instance sources below.
5. **Candidate collectors, by likely value for this owner:** Granola or
   any meeting-notes app (meeting prep in the brief finally has content),
   Linear/Jira (work tasks into `work` next to GitHub issues), Slack
   (mentions only, never channels wholesale), Drive/Notion/Confluence
   (document sync with content-hash dedup, the AgentSwarms pattern),
   Gmail (a very high-value, very sensitive one — comms tier rules
   §4.12 apply). Each is a directory with a manifest; none is scheduled.
6. **Skills as installable units.** `metistry skills install <path|git>`
   and `follow` with auto-update at session start is the same shape as
   §4.4 plus a verb; do it when there are two skills worth sharing.

## Not taking

- Full-transcript capture on by default; a chat door over Slack/Telegram
  (D1's reasoning stands; push covers notification); the cloud-VM agent
  runtime; a Python backend; seventy tools on one endpoint.

## Decisions recorded

- Phase 6 gains `knowledge-fold` (routine + assistant turn) with the
  curator's three rules as invariants.
- CLI gains `import-sessions`; `/capture` kind `session`.
- `mcp-brain` gains `knowledge_list`, `knowledge_grep`, and vault notes as
  MCP resources; definition-token measurement before any lazy switch.
- Collectors gain webhook ingress; five candidate sources recorded.
