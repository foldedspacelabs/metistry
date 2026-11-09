# Context Mode — context saving for coding agents, and what a Metistry context mode would be (2026-10-04)

Research answering the owner's 2026-10-04 ask: a review of
[Context Mode](https://context-mode.com/docs), which, in the owner's words,
"seems like a complementary tool with a feature set that might be worth
incorporating into Metistry. Using Metistry's stored knowledge and session
history to reduce context usage for agents and coding sessions could be a
banner feature, so let's see what we can learn from this project and whether
any of the ideas are worth adopting ourselves." It also takes up what the
owner asked for after the Hindsight review: to "evaluate a push mechanism so
agents are informed of key information up front and discovery need is
reduced" (that review's open question 1,
`docs/research/2026-09-30-hindsight-review.md:240-241`).

Nothing here is built; this PR adds one document and no product code.

Sources, all fetched or read **2026-10-04**. "Context Mode" is two products
under one name, and they are sourced differently:

- **The Engine** — the open part — is read from a **shallow clone** of
  [mksglu/context-mode](https://github.com/mksglu/context-mode) at `a83c201`
  (head of `main`, 2026-10-04 13:48 UTC; `package.json` version 1.0.169). Its
  claims cite `path:line` in that tree, marked `cm:`.
- **The Gateway** — the hosted product the owner's link documents — is closed.
  Every Gateway claim comes from its docs, cited by page: `/docs`,
  `quick-start`, `how-saving-works`, `prompt-caching`, `context-limit`,
  `recall`, `memory`, `search`, `session-resume`, `skills`, `cage`, `reply`,
  `benchmarks`, `plans-and-limits`, `faq`, `landscape`, plus the home page.
  **None of it can be checked against code.**

Stars, forks, issues and dates come from the GitHub API. **Nothing was run**:
nothing installed, no account, no request through the Gateway. Metistry claims
cite `origin/main` `6fe300de`.

## 1. What it is, in five lines

1. **Two products and a dashboard.** The **Engine**: an MCP server (11 `ctx_*` tools) plus agent hooks, packaged as a plugin for 17 coding tools plus OpenClaw, keeping everything in local SQLite (`cm:README.md:36-48`, `:1371-1400`). The **Gateway**: a hosted proxy on Cloudflare that the agent's model-API base URL points at, for Claude Code and Codex only (docs: `/docs`, `quick-start`). **Insight**: hosted team analytics fed by Engine events (home page; `cm:src/server.ts:4814-4840`).
2. **Who**: copyright Mert Koseoglu (`cm:LICENSE:3`); the docs name MKSF LTD, London, as the company. The repository is on a personal GitHub account.
3. **Licence**: the Engine is **Elastic License 2.0**, source-available rather than open source: "You may not provide the software to third parties as a hosted or managed service" (`cm:LICENSE:18`); the GitHub API reports `NOASSERTION`. The Gateway is proprietary, with no source.
4. **Pricing**: the Engine is free. Gateway plans: Free (2,000 requests, given once), Pro (50,000 a month), Team (50,000 per seat, pooled, at least two seats), Enterprise (dedicated or "your Cloudflare account"), and 25,000-request packs. The plans page shows **no prices**; they appear in the console, so they are **unverified** here. You bring your own provider credentials ("we do not resell tokens"), and when requests run out the features pause and requests go straight to the provider (docs: `plans-and-limits`, `faq`).
5. **Maturity**: the repository was created 2026-02-23 and has 25,381 ★, 1,815 forks and 325 open issues; `src/` holds about 41.6k lines of TypeScript and `hooks/` about 10.7k lines of unbundled JavaScript, and the project claims 644k users (`cm:stats.json`; their counter). The Gateway's benchmark runs are dated 2026-09-29 to 2026-10-04 (docs: `benchmarks`). I found no launch date, but it reads as weeks old.

## 2. How it works

### 2.1 The Engine — hooks and a sandbox beside the agent, not in its path

**What it attaches to.** The Claude Code plugin registers six hook types:
PreToolUse on `Bash`, `WebFetch`, `Read`, `Grep`, `Agent` and every `mcp__`
tool; PostToolUse on most tools; UserPromptSubmit; PreCompact; SessionStart;
and Stop (`cm:hooks/hooks.json:4-100`). It also registers the MCP server. It
is not a proxy, and it never sees the model API.

| Mechanism | What it does | Where |
| --- | --- | --- |
| **Routing block, pushed** | Every SessionStart injects `<context_window_protection>`, about 7.2 KB of template (≈1.8k tokens by chars/4), telling the model to use `ctx_*` instead of raw tools | `cm:hooks/routing-block.mjs:16-95`; `cm:hooks/sessionstart.mjs:166` |
| **Routing, enforced** | **WebFetch** is denied and the model is pointed at `ctx_fetch_and_index`. **`curl`/`wget`** is rewritten into an `echo` that tells the model to use `ctx_execute`. **Read** and **Grep** get a once-per-session nudge, repeated on every Read of a file over 50 KB. **Subagent prompts** get the routing block added | `cm:hooks/core/routing.mjs:874-890`, `:766-780`, `:848-872`, `:892-900` |
| **The "sandbox"** | `ctx_execute` runs code in 12 languages in a subprocess, and only stdout enters the context. The child inherits the parent's environment minus an injection denylist, keeps the real `HOME`, and has full network. That makes it a **context** boundary, not a security boundary, and the README says so | `cm:src/executor.ts:573-690`; `cm:README.md:1176-1184`, `:1573-1575` |
| **Intent filter** | Output over 5,000 bytes with an `intent` is indexed, and only matching sections come back. Over 100 KB it is indexed and a pointer comes back | `cm:src/server.ts:1979-1980`, `:1883-1923` |
| **Knowledge base** | SQLite FTS5 with Porter and trigram tokenizers, fused by **RRF with K = 60** (our constant, `packages/mcp-brain/src/knowledge.ts:156`). Then proximity reranking and Levenshtein correction. Searches are throttled per window | `cm:src/store.ts:1244-1251`, `:1359-1380`; `cm:src/server.ts:2441-2470` |
| **Session continuity** | PostToolUse turns each call into about 24 kinds of event in SQLite. PreCompact builds a snapshot. SessionStart (after compact or resume) injects a `<session_knowledge>` guide covering last request, pending tasks, decisions, files, unresolved errors and more, plus a `<session_state>` block capped at 500 tokens | `cm:src/session/extract.ts`; `cm:hooks/session-directive.mjs:274-499`; `cm:hooks/auto-injection.mjs:1-102` |
| **State** | `~/.claude/context-mode` (or `CONTEXT_MODE_DIR`): `sessions/` and `content/`. Content is cleaned after 14 days, sessions after 7 | `cm:README.md:1213-1225`, `:1596-1600`; `cm:src/session/db.ts:1696-1705` |

**Two places where the README and the code disagree** (read, not run):

- The README describes the compaction snapshot as a "priority-tiered XML snapshot (≤2 KB)" (`cm:README.md:1294`). The builder says `maxBytes` is "KEPT for backward compat but IGNORED" and assembles "ALL non-empty sections — no priority dropping, no byte budget" (`cm:src/session/snapshot.ts:30`, `:470`).
- The README says a fresh session deletes previous session data "immediately" (`cm:README.md:41`). The startup hook keeps sessions for 7 days (`cm:hooks/sessionstart.mjs:306`), and `ctx_search` with `sort: "timeline"` searches prior sessions (`cm:src/search/unified.ts:142`).

**How it measures savings.** Tokens are bytes ÷ 4 (`cm:src/server.ts:1041`).
"Bytes avoided" is partly counterfactual: each redirected `curl` books 8,192
bytes, each WebFetch 16,384, and a large Read its file size, whatever would
actually have come back (`cm:hooks/core/routing.mjs:777-779`, `:886-889`,
`:853-860`). The lifetime "tokens saved" also counts bytes the hooks *stored*
— event data and snapshots — as savings (`cm:src/session/analytics.ts:1034`,
`:1384-1386`). Their own ADR-0004 records that the per-conversation bar once
said 56% where strict compression said 95%, and fixes that bar only
(`cm:docs/adr/0004-stats-strict-compression-formula.md:41-51`, `:80-85`). The
routing block it pushes every session is not booked as a cost; I found no
reference to it in `analytics.ts`, by search. `BENCHMARK.md` gives byte
ratios on 21 fixtures, with no task success and no provider token counts.

**What it costs.** No extra model calls. A redirect costs one turn, because
the model's call is denied or echoed and it retries through `ctx_*`. Without
hooks, the README puts compliance with its instruction files at "~60%"
(`cm:README.md:864`, `:1392`; their number).

**What leaves the machine.** The README says "Nothing leaves your machine. No
telemetry" (`cm:README.md:1524`). Read against the code, that holds by
default, with three exceptions:

- an **opt-in forwarder** that POSTs every session event to
  `${platform_url}/events` whenever `~/.context-mode/platform.json` holds a
  `ctxm_` key. It applies eight regexes for redaction, clips fields to 200
  characters and identifies the project by its git remote
  (`cm:hooks/platform-bridge.mjs:1-5`, `:105-125`, `:225-310`);
- an npm version check at startup (`cm:src/server.ts:779-800`);
- `ctx_upgrade` (§4).

### 2.2 The Gateway — a hosted proxy in the provider path (docs only)

**What it intercepts.** The installer writes
`ANTHROPIC_BASE_URL=https://gateway.context-mode.com` and
`ANTHROPIC_CUSTOM_HEADERS: x-cm-device-key: cmdk_…` into
`~/.claude/settings.json`, and a `model_provider` into `~/.codex/config.toml`.
It strips its own header and forwards the provider credential (docs:
`quick-start`, `faq`). Every prompt, file read and tool result passes through
it.

| Lever | What the model sees instead | Page |
| --- | --- | --- |
| **Output folding** | Fifteen filters on shell and search output: passing tests collapse to counts and failures stay; library stack frames collapse; repeated lines get counts; JSON arrays over 20 items keep the first 3, the last 1 and a count. Results under 1,024 characters pass through unchanged, and a fold applies only if it saves ≥768 characters **and** ≥10% | `how-saving-works` |
| **Current-turn cap** | A result over 24,576 characters becomes its first 4,096 and last 2,048 characters plus an archive id (`context-mode-toolcap-…`), readable through `context-mode-search {docid, offset}` | `how-saving-works` |
| **Schema slimming** | Tool descriptions of 1,500 bytes or more are cut to about 420 characters, plus a pointer to `context-mode-tool-schema`. Claude Code only | `how-saving-works` |
| **Cache stability** | "A tool result is changed only the first time it passes", as a pure function of its text. Claude Code's system prompt is split at its first per-session heading, skill and agent lists move into tool descriptions, and WebFetch results get their own 5-minute marks | `prompt-caching` |
| **Context limit** | At 89%, long replies and old tool output move to the archive. At the limit, turns are archived in fixed steps (150k on a 1M window), and the last 8 messages stay. Claude Code threads are held at 850k or less once past 600k | `context-limit` |
| **Recall** | System prompt and tools, then a memory block, then **an index of archived work** (one line per tool call or reply, with ids), then the recent messages. Up to 3 pointer lines are added to a user message that matches the archive: "content never added, only references and age" | `recall` |
| **Memory** | Bi-temporal facts. Llama 3.3 70B on Cloudflare Workers AI extracts at most 5 facts per turn; rules observe commits, PRs and edits; there is a `context-mode-remember` tool. **Pushed**: up to 8 standing facts in the cached header and up to 5 relevant ones on the first turn, under "Your current message overrides every fact". This costs **534–548 uncached tokens** on the first request. English and Turkish only | `memory` |
| **Skills** | A catalog imported from GitHub repositories. At most one skill per turn is auto-loaded by matching the message against each skill's name and description | `skills` |
| **Cage** | Tool calls are checked against 22 capabilities and 5 rule types, with no regexes or wildcards. A blocked call is "rewritten into an echo". The decision log omits command text. Their advice: "Keep your agent's sandbox on" | `cage` |
| **Thinking in Code** | `run-code` executes JavaScript in a Cloudflare Worker: "Your agent never sees the call, so its permission rules and hooks do not apply to it." `run-local`: "The gateway turns the call into your agent's own shell call" | `how-saving-works` |
| **Session resume** | Keeps the latest 200 messages, plus a Workers AI summary of older ones. Resuming takes `curl -fsSL https://<host>/cm-resume.mjs -o /tmp/cm-resume.mjs && node /tmp/cm-resume.mjs … --handoff 'scope=…&t=…'`, and "anyone who has the command can read that conversation" for 15 minutes | `session-resume` |

**Where the data lives**: on Cloudflare, one Durable Object per account.
Prompts have "no automatic expiry yet"; operations rows are kept 30 days and
the savings ledger 90. There is no on-premises build, no SSO, and no one-click
export or deletion (docs: `faq`, `search`).

**How it measures — the right method.** Each task is run twice, direct and
through the Gateway, priced at list on the token counts the provider
returned, with a 95% t-interval over 8–20 pairs. Plans were committed before
the runs, and they state what was excluded. Results:

- 168 short-task pairs, 155 of them cheaper: $28.28 → $23.16 (≈18%), with
  equal success rates;
- one long Opus 5.5 session on a 1M window, 65.5% cheaper ($7.20 → $2.49,
  4 pairs);
- Recall on a 200K window: 37.6% cheaper, and 9 of 10 early-detail answers
  right against 4 of 10 direct (docs: `benchmarks`, `recall`).

They ran these themselves and the code is closed, so **they cannot be
reproduced here**. Latency is never stated.

## 3. What they get right

1. **The problem, split correctly.** Two costs, *definitions* and *intermediate results*, and the second is where the money is when tool output is large. This is the same split `docs/research/2026-09-19-code-mode-mcp.md` §1 makes. Their Engine README puts a number on each source ("A Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB", `cm:README.md:34`).
2. **Measure on provider tokens, paired.** The Gateway's A/B has the shape of PoC-17's eager-against-lazy comparison (`docs/research/2026-08-tool-discovery.md:5`), and it is honest about pairs, intervals and exclusions. It is the method to borrow. The Engine's byte ratios are the counter-example.
3. **Transform once, as a pure function.** Folding only on first pass, splitting the system prompt at its volatile point and **trimming in large fixed steps** all exist to keep the prefix byte-stable, because "each trim changes the start of the request, and the provider then bills the whole start again at the cache write price" (docs: `context-limit`). This is the same prefix discipline as our cost research (`docs/research/2026-09-cost-optimization.md:11-12`, `:80`).
4. **Pointers, not payloads.** Archive ids, `docid` read-back, an index line per archived tool call, and pointer lines that carry "references and age" rather than content. This is the "handles only" shape Hindsight's open question 1 proposed for us.
5. **Hooks over instructions, said plainly**: "Instruction files guide the model via prompt instructions but cannot block anything" (`cm:README.md:1404`). Their #852 fix confines `ctx_execute_file` to the project root *in the tool*, because the host's approval prompt "cannot inspect the tool's input params" (`cm:README.md:1561`). That is enforce-at-the-tool, learned the hard way.
6. **Deterministic, content-aware folds with stated thresholds.** Failing tests stay and passing ones become a count; a fold must save ≥768 characters and ≥10% or it is not applied. These are rules a reviewer can check, not a summariser.
7. **Memory hygiene worth copying in spirit**: facts carry valid-time *and* learned-time, the user's current message wins, there are six scope classes (about you, toolkit, codebase, task, session, environment), retracting keeps history, and "Nothing is deleted by an agent" (docs: `memory`).
8. **Fetch hardening**: only http and https, and metadata and link-local ranges refused at connect time against DNS rebinding (`cm:README.md:1577-1594`; `cm:src/server.ts:2845-2915`).
9. **Candour.** Every docs page ends with its limits, and ADR-0004 publishes their own inflated metric along with the fix.

## 4. What it gets wrong, or what Metistry should refuse

| Invariant or principle | Context Mode | Metistry: refuse · adapt · keep |
| --- | --- | --- |
| **Enforce at the tool** (the principle over all) | User deny rules **fail open** when the security module fails to load ("preserve fail-open", `cm:hooks/core/routing.mjs:395-440`). Routing on hook-less clients is prose at "~60%". `ctx_upgrade` tells the model "You MUST run the returned command" (`cm:src/server.ts:4283-4286`). Memory's guard is a sentence: "Your current message overrides every fact" | **Keep ours: fail closed.** `connect` refuses on a host with no Keychain before minting anything (`docs/ops/cli.md:842-843`), and a check that cannot run is an error, because "a check that quietly degrades … is not a check" (`ops/scripts/check-tool-surface.mjs:27-29`). |
| **No shell, no raw git** (9) | `ctx_execute` is arbitrary code with the parent's environment and network. "Credential passthrough" to `gh`, `aws`, `kubectl` is sold as a feature (`cm:README.md:1182`). The Gateway's `run-local` *creates* shell calls, and `run-code` runs outside the agent's permission system | **Refuse.** The owner's reach reading of 9 admits only a sandbox that reaches the same audited functions under the same principal (code-mode research, rulings 2026-09-19, `:672-700`). Code mode stays *later*. |
| **The provider path is part of your trusted base** (8, Kerckhoffs) | A Gateway that rewrites model output (echo rewrites, `run-local`) can author commands your agent runs. Compromise the closed service and you have a shell on every connected machine | **Refuse.** Metistry never sits between an external agent and its provider. Our own engine's path is `compute.yaml` plus the egress guard. |
| **Data leaving the Mac** | Gateway: every prompt, file and tool output, with prompts kept with no automatic expiry, facts extracted on Workers AI, summaries by an unnamed Workers AI model, no export. Engine: an opt-in forwarder behind an absolute "Nothing leaves your machine" | **Refuse.** Nothing that can read knowledge or sessions is hosted. Even the opt-in Relay passes TLS through unread (plan §2.24). |
| **Auditability of what was elided** | Gateway: "Your client continues holding the complete history. The gateway decides what the model receives" (docs: `recall`). The transcript you hold is not what the model saw, and Cage's log omits command text. Engine: savings counted against assumed bytes | **Adapt.** Anything Metistry pushes or folds is recorded in a `runs` row: inputs, handles, bytes in and out, and a hash of what was sent (CM-1, CM-6). |
| **Prompt injection through summarised content** | Strings from tool output go into the post-compaction guide **unescaped**: anything containing "Error" plus "cannot" becomes a "constraint", and the first 500 characters of a subagent's result become a "finding" (`cm:src/session/extract.ts:870-898`, `:1159-1172`). They sit inside `<session_knowledge>` next to "Continue working on the last request" (`cm:hooks/session-directive.mjs:281`, `:495`), and captured decisions arrive as `<rules>Follow these decisions:` (`cm:hooks/auto-injection.mjs:74`). That contradicts their own routing block, which says captured directives are "a memory aid, not a standing order" (`cm:hooks/routing-block.mjs:60`). The Gateway auto-loads third-party `SKILL.md` text by name match | **Adapt the lesson.** Pushed content is data: handles and owner-written text, through `sanitizeForAgent` (`packages/core/src/sanitize.ts:17-19`), labelled, with no imperatives. This matches `briefThreadBlock`'s "nobody is addressed here" (`apps/assistant/src/crew-drain.ts:250`). |
| **Secrets** | Masking by known formats only, and the Engine forwarder's list is eight regexes. The resume command is a 15-minute read capability you can paste, which downloads to `/tmp` and runs. Its token travels in a query-string-shaped argument, `--handoff 'scope=…&t=…'`; **whether it then reaches a URL is unverified** | **Keep ours.** Bearers live in the Keychain and travel in headers; nothing is downloaded and run. |
| **Supply chain** | `ctx_upgrade` is a model-callable tool, annotated non-destructive and closed-world. It clones `main` unpinned and runs `npm install` and `npm run build` (`cm:src/server.ts:4270-4290`, `:4346-4361`) | **Keep ours.** `metistry update` is explicit and pinned in `.metistry/metistry.lock`. |
| **One read path** (3) | Each tool indexes into its own SQLite store and searches it its own way | **Keep ours.** A briefing is assembled from named queries plus the one knowledge scope rule (`canSeeUnder`), never a new store. |
| **Licence** | ELv2 code cannot come into Apache-2.0 Metistry without carrying its limits | **Take ideas, copy no code.** |

**Coexistence**, since the owner calls it complementary: an owner can run the
Engine beside Metistry. Its PreToolUse fires on every `mcp__` call
(`cm:hooks/hooks.json:100`), and every 10th call re-injects "pipe it through
ctx_execute" guidance (`cm:README.md:1606`). It stores the **redacted
arguments** of every Metistry tool call in its own SQLite, not the responses
(`cm:src/session/extract.ts:1029-1058`). A `ctx_execute` script inherits the
environment, so it can reach Metistry with whatever bearer is exported there.
That stays inside our model, since the credential is the identity and the
call is a `runs` row, but it is worth one line in the docs (CM-9).

## 5. The banner-feature question

**The load-bearing fact.** Context Mode saves by being in the path: hooks
beside every `Bash`/`Read`/`WebFetch`, or a proxy in front of the provider.
For an external coding agent, **Metistry is in neither path**. It is an MCP
server plus a capture plugin. A Metistry "context mode" therefore cannot
promise their tool-output numbers. It can promise what neither Context Mode
product has locally:

- the owner's knowledge *across* sessions, tools and months, owner-approved;
- the sessions of every coding tool already captured (Claude Code, Cursor,
  OpenCode, `import-sessions`) and folded each evening;
- grants per agent, and audit on every call.

The Engine's memory is per-tool and lasts days. The Gateway sells
cross-session memory hosted. **The banner: your coding agents start out
knowing what you know — local, cited, scoped to their grant, with no proxy.**

### 5.1 The pieces, and what is built

| Piece | Built | Missing |
| --- | --- | --- |
| **Knowledge to brief from** | Vault index with one-line descriptions, links, `Journal/Fold/` notes; one scope rule (`canSeeUnder`); drafts invisible (`packages/mcp-brain/README.md:36-48`) | The keyword arm cannot see note bodies (`knowledge.ts:206-217`; HS-2) |
| **Session history** | SessionEnd capture from three tools, plus back-fill, with the same deterministic summary: repo, cwd, files, tools, tokens, cost, first prompt, last reply (`docs/ops/claude-code-plugin.md:68-78`; `packages/core/src/session-summary.ts:42-68`). The fold already reads them as its `sessions` group (`routines/knowledge-fold/run.ts:369-385`) | **The return path**: nothing serves them back to the next session (CM-4) |
| **Repo → project** | Session notes carry `repo` and `cwd`; projects are slugs (`docs/ops/projects.md`) | A mapping the owner writes (CM-3) |
| **A push channel** | Tool-result nudges: deterministic, on every result, "a pull-only agent has no other attention channel" (`packages/mcp-brain/README.md:50-59`, `src/nudge.ts:1-5`). Crew briefs: budgeted, sanitized, labelled (`apps/assistant/src/crew-drain.ts:242-260`) | A session-start channel for external agents (CM-1, CM-2). The MCP `instructions` field is unused (`packages/mcp-brain/src/server.ts:289`) |
| **Read wiring** | `connect claude-code` wires capture only (`packages/cli/src/connect.ts:58`, `:570`) | HS-1 |
| **Lazy discovery** | Eager by default with thresholds in core (`metistry-build-plan.md:1095-1112`); a ratchet at 4,597 of 4,600 tokens (`packages/mcp-brain/test/brain.test.ts:127`); a lazy pair for connections; `propose_action` lazy by credential (`packages/mcp-brain/manifest.yaml:9`) | X-49's build (lazy, answered 2026-10-04), measured per client (below) |
| **Tool-output folding** | `queries_run` caps at 200 rows; `knowledge_grep` at 50 files and 200 hits; upstream tool descriptions clipped to 2,048 characters (`packages/connections/src/pool.ts:653`) | **`connections_call` returns upstream answers whole** (`packages/mcp-brain/src/connections-tools.ts:285`; no size cap found by search). This is the one tool-output path Metistry *does* own (CM-6) |
| **Measurement** | Session tokens and cost per coding session; `claude_usage_daily` with cache hit rate; `packages/eval` | A cache split in the session summary, which today sums fresh, write and read input (`session-summary.ts:162`); the paired A/B (CM-5); HS-8 |

**Push, shaped.** The owner's push mechanism should be a **briefing**:
assembled by the console with no model (invariant 4), from named queries under
the caller's grant, about 1,200 tokens at most, and made of **handles and
owner-written text**. That means paths, titles, one-line descriptions, dates,
the project page's own summary, open tasks in the project, and the last few
sessions in this repository by date and files. It must contain no synthesized
prose and no imperatives. It should arrive through an opt-in SessionStart hook
in the plugins, which know the cwd and the repository, and be written to a
`runs` row by hash. The same briefing could front the assistant's own chat
sessions, which today carry no memory at all
(`docs/research/2026-09-21-agent-memory-lessons.md` §3.2, open question 5).
That is a separate ruling; this document proposes it for external agents
only.

Delivery differs by client:

- **Claude Code**: a SessionStart hook, as the Engine does
  (`cm:hooks/sessionstart.mjs:166`, `:461`). Claude Code also renders a
  server's MCP `instructions`, which I observed in the session that wrote
  this document.
- **OpenCode**: through its experimental system transform, as the Engine
  does (`cm:README.md:500-502`).
- **Cursor**: `sessionStart` is "rejected by Cursor's validator" according
  to the Engine's README (`cm:README.md:1346`); unverified here.
- **Devin**: no Metistry plugin, only an MCP registration pasted into a web
  form (`docs/ops/cli.md:818`); whether it surfaces `instructions` is
  unverified.

**Lazy discovery, per client.** The Engine's routing block carries an optional
bootstrap for deferred tools, because "Claude Code surfaces ctx_* as DEFERRED
tools" (`cm:hooks/routing-block.mjs:25`; `cm:hooks/core/routing.mjs:900`), and
the Gateway installer turns on `ENABLE_TOOL_SEARCH`. So in Claude Code, our
4,597-token surface may not be paid up front at all. The owner answered W3
question 26 (`docs/product/decisions-log.md:317-318`) on 2026-10-04 with
"lazy tool discovery". That answer is not yet transcribed into the plan. One
consequence follows. If the brain goes lazy behind `tool_index`/`execute`
while Claude Code already defers our tools, an agent pays **two** discovery
hops, and PoC-17 priced one at +34% cumulative prompt tokens. X-49 should
measure per client and lean on the client's own deferral where it exists
(CM-7).

### 5.2 A rough estimate, with the method

**This is a model, not a measurement.** Prices are relative to one fresh
input token: a cache read 0.1×, a write 1.25×
(`docs/research/2026-09-cost-optimization.md:11-12`), and output 5× (the
current Anthropic list ratio; an assumption). These are the assumptions, and
none is measured here:

| Parameter | Value |
| --- | --- |
| Prefix at session start | 30k tokens |
| Discovery when an agent needs vault knowledge | one `knowledge_search` (default 20 hits, `server.ts:571`, ~700 tokens), two `knowledge_read` (~1,500 each) and one `tasks_list` (~300): ≈4,000 result tokens over 4 extra turns, ~100 output tokens per call |
| Turns carried after discovery | 40 |
| Briefing | 1,200 tokens over 44 turns |

| Term (input-token equivalents) | Discovery today | Pushed briefing |
| --- | --- | --- |
| Results written to cache | 4,000 × 1.25 = 5,000 | 1,200 × 1.25 = 1,500 |
| Extra round trips re-reading the prefix | 4 × 0.1 × ~32,000 = 12,800 | 0 |
| Carried for the rest of the session | 4,000 × 0.1 × 40 = 16,000 | 1,200 × 0.1 × 44 = 5,280 |
| Output for the calls | 4 × 100 × 5 = 2,000 | 0 |
| **Total** | **≈ 35,800** | **≈ 6,800** |

What this means:

- When a briefing fully replaces discovery, it saves **≈ 29k equivalents,
  ≈ 80% of discovery's cost**.
- When the session never needed the vault, it costs ≈ 6.8k. **It breaks even
  if about 1 session in 5 would have searched.**
- Against a whole 44-turn session (context growing from 30k to 120k, ≈550k
  equivalents), the saving is **≈ 5%**.

So the banner is **fewer turns and the right knowledge up front**, not a
headline percentage. The Gateway's measured 15–29% on short tasks comes from
the path we are not in.

**The bigger lever is CM-6.** The same model applied to one 58.9 KB upstream
answer (the Engine's own "GitHub Issues (20)" fixture, `cm:README.md:1464`):
≈14.7k tokens folded to ≈1.5k saves 13.2k × 1.25 + 13.2k × 0.1 × 40 ≈
**69k equivalents per occurrence**, less one read-back turn when the agent
needs what was folded. That is more than two sessions of briefing.

**A third lever, in our own engine.** `trimHistory` drops messages from the
front on every save once a session passes 60 messages or 120,000 characters
(`apps/assistant/src/sessions.ts:40-62`, `:107`). By the Gateway's own
reasoning, every turn past the cap then changes the prefix after the system
prompt. Each such turn re-bills ≈30k tokens of history at the write price
instead of the read price, ≈34k equivalents. How often sessions reach the cap
is **unmeasured**, since task boundaries roll sooner. `claude_usage_daily`'s
`cache_hit_rate` is the instrument. Trimming in steps, and leaving an index
line per dropped turn in place of nothing, is Recall's shape applied to T3-9's
archive (CM-8).

### 5.3 Risks

- **Push is the injection surface.** Whatever is pushed is read before the
  owner types. So it must be handles and owner text only, sanitized, labelled
  as reference, with no "follow" or "continue". The Engine's
  `<rules>Follow these decisions:` is the counter-example (§4).
- **Grant leakage.** A briefing must never name a path the caller cannot
  read. Titles are content too: `index` tier sees titles, and `none` must get
  an empty briefing. This is CM-1's first misuse test.
- **Staleness.** Carry `as_of` and each note's `sha256`, so the agent can
  re-read rather than trust.
- **Paying for nothing.** Sessions that never needed the vault pay the
  briefing. So it is opt-in per agent and gated on CM-5's numbers.
- **Cache churn.** Assemble once per session start and never change it
  mid-session.
- **Unapproved material.** Captured sessions sit in `Inbox/`, not Knowledge.
  Serving them back is the owner's call (Q3).

## 6. Take, adapt, refuse — tickets and questions

| Metistry component | Context Mode | Take · adapt · refuse |
| --- | --- | --- |
| **Claude Code, OpenCode, Cursor plugins** (`plugins/`) | SessionStart injection; six hook types | **Adapt**: one opt-in SessionStart hook that delivers a briefing of handles (CM-2), mirroring `METISTRY_CAPTURE_ON_STOP`. No PreToolUse interception. |
| **`mcp-brain` knowledge reads** | Archive ids and `docid` read-back; FTS5 Porter plus trigram, fused by RRF | **Adapt**: the briefing reuses `canSeeUnder` (CM-1). Body search is HS-2's, and a trigram arm is a footnote to it, not a new ticket. |
| **The eager surface** (X-49, ruled lazy 2026-10-04) | Schema slimming; Claude Code defers MCP tools | **Adapt X-49**: measure per client and avoid stacking our lazy hop on a client's own deferral (CM-7). Our descriptions are already short, so slimming buys nothing. |
| **The connections proxy** (`connections_call`, T4-8b/T4-9) | Fold, cap, archive, read-back | **Adapt** (CM-6). This is the one result path we own. |
| **`knowledge-fold` and session captures** | Recall's index, the Engine's session guide | **Take the return path** (CM-4). The guide's section list (pending, decisions, files, unresolved) is a good shape for handles. |
| **`packages/core/src/session-summary.ts`** | The Gateway's paired A/B on provider tokens | **Take the method** (CM-5). |
| **Projects** | Memory's "codebase" scope; project identity from the git remote (`cm:hooks/platform-bridge.mjs:113-125`) | **Adapt** (CM-3). |
| **The assistant's session history** (`apps/assistant/src/sessions.ts`) | Trim in fixed steps; an index instead of nothing | **Adapt** (CM-8). |
| **The engine** (invariant 9) | `ctx_execute`; `run-code` and `run-local` | **Refuse.** Code mode stays *later* (2026-09-19 rulings). |
| **External agents' provider path** | A base-URL gateway that rewrites output | **Refuse.** No proxy, hosted or local. |
| **`metistry update`** | `ctx_upgrade` from unpinned `main` | **Keep ours.** |
| **`docs/product/website-brief.md:576`** | not named | Name Context Mode, sourced, under the page's rule (CM-9). |

**Tickets** (proposed; none is in the plan):

1. **CM-1 · A session-start briefing, handles only** · M · deps CM-3, HS-1 — the console assembles, with no model, from named queries and `canSeeUnder` under the caller's grant: the project page's own summary and links, open tasks in the project, the latest `Journal/Fold/` lines naming it, and CM-4's sessions. The budget is set by the owner (default ≈1,200 tokens by chars/4). Every string passes `sanitizeForAgent`, wrapped in a labelled block that addresses nobody. One `runs` row per briefing carries the handles and a hash of what was sent. Served as a read for external principals; whether as a route or behind `queries_run` is the first design choice, because named queries do not apply knowledge tiers by themselves. Misuse tests: a `none` grant gets an empty briefing, and an `index` grant gets titles from its tier only. Maps Hindsight Q1, plan §2.10, `briefThreadBlock`, invariants 3 and 4; X candidate.
2. **CM-2 · Plugins deliver it at session start** · S · deps CM-1 — an opt-in `SessionStart` hook in `plugins/claude-code`, inert unless `METISTRY_BRIEF_ON_START=1`, that sends cwd and repository and emits the briefing as context. OpenCode gets the same through its system transform. Cursor and Devin are documented as unsupported until verified. Failure exits 0 and injects nothing. Each harness's delivery is one entry in the harness registry the owner asked to "build for growth" (Hindsight rulings, 2026-10-04). Maps `docs/ops/claude-code-plugin.md`, HS-1, HS-7.
3. **CM-3 · A repository maps to a project page** · S — `repos:` frontmatter on `Projects/<slug>.md` that the owner writes, so it is git-durable (invariant 1) and editable in Obsidian. The reconciler fills a derived column (additive migration), with a named query `project_for_repo {remote}` and remote normalization in the Engine's shape. Maps plan §2.9, `docs/ops/projects.md`; X candidate.
4. **CM-4 · Last time in this repository** · S · after Q3 — a named query `recent_sessions {repo, days}` over captured `kind: session` rows: date, tool, files, turns, and the owner's first prompt clipped. **Never the agent's last reply**: it is agent-written, so it stays a handle. Maps `knowledge-fold`'s `sessions` group, X-70, `session-summary.ts`.
5. **CM-5 · Measure it before default-on** · M · deps HS-8 — the session summary and its frontmatter carry the input split (fresh, cache write, cache read). A paired A/B in the Gateway's shape — same task, with and without CM-2, provider tokens at list price, pairs and interval reported — plus a seeded-vault fixture in `packages/eval` asking whether the agent answered a repository-knowledge question without a discovery call. Gates CM-2's default. Maps the cost research's measurement rows, HS-8.
6. **CM-6 · `connections_call` folds large answers** · M — after redaction, a deterministic fold applied once, as a pure function of the text: JSON arrays over N items become the first k, the last 1 and a count; repeated lines become counts; anything else gets a head-and-tail byte cap. The full answer goes to a derived, short-lived table keyed by the run, readable only by the same principal. Read-back is an optional `page` on `connections_call` or a named query; **no new tool** (X-49). `runs.meta` records bytes in, bytes out and the handle. The owner can turn folding off per connection. Maps plan §2.6, T4-8b/T4-9, invariant 8; X candidate.
7. **CM-7 · Lazy discovery, per client** · S · with X-49 — PoC-17's rerun (2026-09-19 ruling 3) and `check-tool-surface.mjs` record what each connected client actually pays, with Claude Code's own deferral as one column. Where a client already defers MCP tools, the brain should not put a second `tool_index` hop in front of them. Test: no client pays two discovery turns to reach one brain tool. Maps X-49, W3 question 26.
8. **CM-8 · History trims in steps and leaves an index** · S · after OPEN-6's cache measurement — past the cap, `trimHistory` drops to a low-water mark (for example half the cap) instead of one message at a time. The dropped span becomes one line per turn, a handle into `session_archive` (T3-9), within a byte budget, so the prefix stays stable between steps. Maps `apps/assistant/src/sessions.ts:40-62`, T3-9, the cost research's "prune at task boundaries" row.
9. **CM-9 · Context Mode in the website brief and a coexistence note** · S — add one row to the brief's comparison table. What it does well: deterministic folds that are stable for caching, and paired A/B measurement. Where we differ: no proxy and no hosted path, and the owner's knowledge is the record. Add a short `docs/ops` note on running the Engine beside Metistry (what it stores about our calls, its opt-in forwarder). Both are sourced to this document.

**Open questions for the owner.**

1. **What may a briefing contain?** You asked for push; this asks *what*. Options: handles only (paths, titles, descriptions, dates, counts); handles plus owner-written text (`source: user` pages, the project page's summary); or also the assistant's fold lines as prose. I recommend the middle option: assistant-written text appears only as handles.
2. **Default on, or opt-in per agent?** Options: a grant field set at `connect --brief`; a per-tool environment switch, as capture has; or on for every agent with a read grant. I recommend opt-in per agent, with the default reconsidered after CM-5.
3. **May captured sessions be served back before they are approved?** They are your sessions, but they sit in `Inbox/`, not Knowledge. Options: only to the agent that captured them; to agents in the same project; or only once folded.
4. **Should Metistry fold what an upstream connection returns?** CM-6 changes what an agent sees from a connection. Options: on above a threshold with read-back; your choice per connection, beside Allow · Ask First · Never; or never, leaving it to the client.

## Sources

- Context Mode Engine, `main` at `a83c201` (2026-10-04): <https://github.com/mksglu/context-mode> — `README.md`, `LICENSE`, `BENCHMARK.md`, `package.json`, `stats.json`; `hooks/{hooks.json,sessionstart.mjs,routing-block.mjs,session-directive.mjs,auto-injection.mjs,platform-bridge.mjs,core/routing.mjs}`; `src/{server.ts,executor.ts,store.ts,session/{extract,snapshot,analytics,db}.ts,search/{unified,auto-memory}.ts}`; `docs/adr/0004-stats-strict-compression-formula.md`. GitHub API `repos/mksglu/context-mode` (fetched 2026-10-04).
- Context Mode docs, fetched 2026-10-04: <https://context-mode.com/docs> and `/docs/{quick-start,how-saving-works,prompt-caching,context-limit,recall,memory,search,session-resume,skills,cage,reply,benchmarks,plans-and-limits,faq,landscape}`; home page <https://context-mode.com/>.
- Metistry at `origin/main` `6fe300de`: `CLAUDE.md` invariants 1, 3, 4, 8, 9; `metistry-build-plan.md:1095-1112`; `docs/product/design-build-plan.md` T3-9, T3-10, X-49, X-70, §2.6, §2.10; `docs/product/tickets/waves.md`; `packages/mcp-brain/{README.md,manifest.yaml,src/{server,knowledge,nudge,connections-tools}.ts,test/brain.test.ts}`; `packages/connections/src/pool.ts`; `packages/core/src/{session-summary,sanitize}.ts`; `packages/cli/src/connect.ts`; `plugins/claude-code/hooks/hooks.json`; `routines/{knowledge-fold,session-fold}/run.ts`; `apps/assistant/src/{sessions,crew-drain,engine-openai}.ts`; `ops/scripts/check-tool-surface.mjs`; `docs/ops/{cli,claude-code-plugin,projects,assistant-tools}.md`; `docs/research/{2026-08-tool-discovery,2026-09-19-code-mode-mcp,2026-09-21-agent-memory-lessons,2026-09-cost-optimization,2026-09-30-hindsight-review}.md`; `docs/product/website-brief.md:576`.
