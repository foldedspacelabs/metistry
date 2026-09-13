# Hermes Agent, part 2 — profiles, automation, skills, architecture, security

Fetched 2026-09-12 from `https://hermes-agent.nousresearch.com/docs/`; every
page HTTP 200, no fetch failed. Part 1
(`docs/research/2026-09-12-hermes-agent-review.md`, on the unmerged branch
`claude/research-hermes-agent`) covered the kanban board and `delegate_task`;
it is not repeated, nor are the five ADOPTs in
`docs/research/2026-09-12-rivet-agentos-review.md`. Repo facts (MIT,
Python-first, 42k open issues) and the dependency verdict are in part 1;
nothing below changes them.

What part 1 understated: Hermes is a far larger product — ~30 messaging
adapters, a desktop app, 70+ tools in 28 toolsets, four hook systems, a dozen
provider interfaces — and most of that is surface Metistry deliberately does
not have. Everything worth taking is in **scheduled-work failure handling**,
one delegation ergonomic and one compute-config fix.

---

## 1. Profiles and Bot Mode

**Hermes.** "A profile is a separate Hermes home directory" — its own
`config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron jobs,
state DB, gateway process and bot token ([profiles][p]); creating one mints a
shell alias and a launchd/systemd service. Bot Mode ([bot-mode][b]) is a
desktop UI over that primitive — "a Bot is a Hermes profile … no new
primitive to learn" — adding avatars, group rooms (2–6 bots, capped at 10
messages per send and 3 rounds) and `message_agent` for bot-to-bot DMs. Three
load-bearing details: **one writer per home, enforced** ("never point two
agent processes at the same profile …
each loads the other's writes into its system prompt at session start"),
backed by a **token lock** blocking a second gateway on the same bot token
"with a clear error naming the conflicting profile"; **OAuth shared, not
copied** — "a copy of one is not a second credential, it is the same
credential with two owners, and the first profile to refresh it revokes it
for every other copy"; and a profile carries a **`--description`** so the
kanban orchestrator "knows what it's good at".

**Metistry.** A Hermes profile ≈ a Metistry **instance**, not a persona:
`seed/identity.yaml` names the assistant once and
`apps/assistant/src/prompt.ts` templates it (D4 overlay via
`METISTRY_IDENTITY_FILES` / `METISTRY_PROMPT_FILES`), and
`docs/research/2026-09-11-multi-instance-and-offline-client.md` already
designs two instances on one phone keyed by `instance_id` behind a switcher.
The within-instance analogue of a named specialist is a **crew**
(`agents/<area>/<name>.md`: own model, tool groups, read `scope`),
deliberately memoryless — "the brief is the context transfer".

**Verdict. SKIP — per-context personas inside one instance:** two
personalities on one vault is exactly the two-writers failure Hermes warns
about, and a second instance is a stronger answer than a second `SOUL.md`.
**SKIP — per-channel behaviour:** Metistry gates per *principal*
(`docs/ops/auth.md`), and behaviour keyed to where a message arrived is a
prompt-level control, which "enforce at the tool" forbids. **ADOPT — crew
descriptions in the delegate tool** (§7.5). **Already have it —** OAuth
single-owner: there is no copy-the-refresh-token path to get wrong.

## 2. Automation

**Hermes** ([cron][c]). Jobs in `~/.hermes/cron/jobs.json`, ticked every 60 s
by the gateway under a `.tick.lock` file lock, `cron.max_parallel_jobs`
bounding concurrency, runs in a per-profile execution ledger. The valuable
parts are all failure and spend:

- **Preflight.** Before a run, Hermes validates the provider key, attached
  skills' env/commands/credential files, and the delivery target. On failure
  "`last_status` becomes `blocked_config`, ONE alert is delivered (it is not
  repeated every tick), and **no LLM call is made — a misconfigured job never
  spends tokens.** The next healthy run clears the blocked state."
- **`failure_streak` + review nudge.** At `cron.failure_nudge_threshold`
  (default 3) the failure message gains "failed N runs in a row" and offers
  fix / pause / remove. Delivery failures don't count; one-shots never nudge.
- **Failure incidents**, durable, "keyed by the job plus a normalized
  signature of the error text"; `ack <id>` silences that *signature* only —
  a different error mints a new incident and alerts again. Failure is split
  three ways: `last_error` (the agent failed), `last_delivery_error`
  (produced but never reached you ⇒ `last_status: delivery_failed`, "never a
  plain `ok`"), `last_fire_error` (the fire never reached the runner). Plus
  read-only **`hermes cron doctor`**, which "exits 1 when anything actionable
  is found".
- **Cost caps** are a per-job model and reasoning-effort pin, deliberately
  not exposed to the agent's own `cronjob` tool ("model configuration stays a
  user decision"); no dollar budget on scheduled work. **Runaway guard:**
  "cron-run sessions cannot recursively create more cron jobs", and approvals
  default to `cron_mode: deny` headless.

**Metistry.** `apps/console/src/runner.ts` is 59 lines: `tick()` reads
`max(ts)` per component from `runs`, skips if inside the interval, then
`startRun` → run → `finishRun({ok})` or `finishRun({ok:false, error})`. That
is the entire failure model. Failures surface only as *counts*
(`runs_summary.yaml`, the morning brief, the weekly review, one
`activity_feed` row per failed `collector_run`) — no streak, no dedupe, no
preflight — and `metistry doctor` (`packages/cli/src/doctor.ts`) validates
manifests and probes `check()` endpoints but never reads `runs`. So: **a
collector whose token expired fails every hour forever, contributes one
number to a tile, and nothing says "this has failed 168 times — fix it or
remove it".** Hermes is plainly stronger here.

**Verdict.** Four ADOPTs (§7.1–3, §7.6). **SKIP** the per-job effort pin:
`rules.yaml`'s `routine` tier is the same idea, and `compute.yaml` budgets
(compute note, "Cost controls") already exceed Hermes's caps — enforced
in-process before the call, `action: stop` pausing routines. **Already have
it, structurally**, on the recursion guard: `agents_delegate` requires
`principal.kind === "internal"` and a crew's
principal is `kind: crew`, so a crew cannot delegate, and no tool creates a
routine at all (routines are manifests on disk, invariant 5). Hermes needs a
mode flag where Metistry has a type.

## 3. Integrations

**Hermes.** ~30 adapters ([messaging][m]) — Telegram, Discord, Slack,
WhatsApp, Signal, SMS, Email, Matrix, Teams, IRC, ntfy, BlueBubbles and
Photon for iMessage, the Chinese platforms, Home Assistant — behind one
gateway process that also runs the cron scheduler. Auth is a five-step
ladder, **default deny** ([security][s]): per-platform allow-all →
DM-pairing approved list → per-platform allowlist
(`TELEGRAM_ALLOWED_USERS=…`) → global allowlist → global allow-all → deny.
**DM pairing** is the good part: an unknown DM gets an 8-char code from a
32-char unambiguous alphabet via `secrets.choice()`, 1 h TTL, 1 request per
user per 10 min, max 3 pending per platform, 5 failed approvals ⇒ 1 h
lockout, `chmod 0600`, codes never logged; the owner approves from the CLI.
Bot mode exposes bots to *each other* through `message_agent`, which
validates the target against the live roster, prefixes an unforgeable
attribution, and passes the message "as a real parameter (nothing
shell-interpreted)".

**Metistry.** Three authenticated doors (invariant 8, `docs/ops/auth.md`):
passkey session and loopback-only local owner token (both principal `user`),
host-minted owner token (`/capture`, `/message`, `/api/status`, named queries
— never management), agent token (`/capture` and `/mcp`, uniform 403
elsewhere), plus web push and the capture Shortcut. Bridges are npm packages
on core's wire contract with `check()` and preview-then-confirm on
destructive tools; targets carry a `data_policy` enforced by `checkBrief()`.

**Verdict. SKIP — messaging adapters, all of them:** each is an inbound door
that must authenticate as if internet-exposed and a third-party API to
maintain for one person; adding Telegram trades a passkey for a bot token.
**SKIP — DM pairing:** it solves "a stranger DMs the bot", which needs
unauthenticated ingress Metistry does not have. **BORROW-LATER —** the
lockout table if enrolment codes ever become remotely reachable.

## 4. Skills

**Hermes** ([skills][k]). `~/.hermes/skills/<name>/SKILL.md` with frontmatter
(`name`, `description`, `version`, `platforms`, `metadata.hermes.*`),
"compatible with the agentskills.io open standard", and three-level
**progressive disclosure** — `skills_list()` (~3k tokens) →
`skill_view(name)` → `skill_view(name, path)`. Every skill is also a slash
command. Conditional activation (`fallback_for_toolsets`, `requires_tools`,
`platforms: [macos]`) hides a skill when a better tool exists or the OS is
wrong. Three further mechanisms matter:

- **Skills carry capability, not just prose.** `scripts/` run through the
  terminal tool, and `required_environment_variables` /
  `required_credential_files` in frontmatter are auto-registered as sandbox
  passthrough (read-only bind mounts under Docker) **when the skill loads** —
  loading a skill widens the credential surface.
- **Trust is explicit; install is quarantined and hashed.** Project skills
  under `<repo>/.agents/skills/` are found but not loaded until `hermes
  skills trust`; third-party installs copy only `SKILL.md` and the files it
  references, scan them in quarantine, and record "the source URL, exact
  content hash, scanner version, findings, timestamp" in `.hub/lock.json`.

**Metistry.** Two things share the word. (a) The assistant's behaviour is
`seed/assistant-prompt.md` + `identity.yaml` through D4 overlays; its
capability is tools registered in `packages/mcp-brain` by principal grant —
no user-installable skill format, by design (invariant 9). (b)
`.claude/skills/` and `.claude/agents/` (`docs/ops/claude-assets.md`) are
Claude Code **developer** assets for building Metistry — not runtime skills.

**Verdict. SKIP — a skill format for the assistant:** frontmatter that
auto-registers credential passthrough is a capability grant wearing a
document's clothes, and under invariant 9 a markdown file must not be able to
widen the mutating surface. The clearest invariant conflict in the review.
**SKIP — the hub** (same reason, plus Python scanners as its trust
mechanism). **BORROW-LATER — quarantine + content hash + source URL in a lock
file**, the right shape for anything Metistry ever installs from a stranger;
extend `metistry.lock`. **BORROW-LATER — conditional activation**, once
hiding an unconfigured bridge's docs pays. Progressive disclosure itself is
what core's lazy tool discovery already does for tools.

## 5. Architecture

**Hermes** ([architecture][a]). Python. An `AIAgent` facade over a conversation
loop, prompt builder, provider resolution across three API modes, and a 70+
tool registry. Storage is **SQLite + FTS5** for sessions and state, plus JSON
(`cron/jobs.json`, pairing, `.hub/lock.json`) and markdown (memory, skills),
all under `~/.hermes/`, per profile. The long-lived process is the **gateway**
— messaging, sessions, cron, the kanban dispatcher — with CLI, ACP, batch
runner, API server and a Python library as other entry points, and terminal
work in one of seven backends (local, ssh, docker, singularity, modal, daytona,
vercel_sandbox). The plugin surface is a `register(ctx)` Python entry point
plus a dozen typed provider interfaces. Memory is deliberately tiny and
**bounded** (`MEMORY.md` 2,200 chars, `USER.md` 1,375, frozen into the prompt
at session start): an overflowing write "returns an error instead of silently
dropping entries".

**Verdict. SKIP** the process, storage and plugin models alike —
SQLite-as-truth conflicts with invariants 1 and 3, in-process Python plugins
with 5 and the one-way `apps/` → `packages/` arrow, against Metistry's
launchd-plus-supervisor shape (`packages/cli/src/supervisor.ts`,
`docs/ops/deployment-shapes.md`). **Where Hermes is stronger:** its plugin
*taxonomy* is better documented — one table naming which of twelve extension
points you want, which `docs/ops/` deserves once the bridge count justifies
it. **Worth recording:** bounded memory that errors rather than truncates is
the same instinct as `max_brief_bytes` in `checkBrief`.

## 6. Security

Eight named layers ([security][s]). What is genuinely instructive:

- **Hooks are classified by whether they decide.** `pre_tool_call` is a
  policy hook (`block` / `approve` / `modify`) and on exceeding
  `plugins.hook_callback_timeout` it **fails closed** — "the tool is blocked
  with a timeout message rather than proceeding without a policy decision" —
  while observer hooks fail open. Stating the fail-direction once, in the
  hook's type rather than per call site, is the best idea on the page.
- **Honest boundary labelling.** The write denylist is captioned
  "defense-in-depth, not a hard boundary … the terminal tool runs as the same
  OS user and can still `cat` or overwrite denied paths".

**Why the comparison is lopsided.** Nearly every Hermes layer exists to make
*a shell* survivable. Invariant 9 deletes the problem: no shell, no raw git,
and `ops/sandbox/assistant.sb` deny-default with one writable directory, one
executable and two loopback destinations. A blocklist `--yolo` cannot lift is
a weaker form of "the capability was never registered". Metistry also has
better auth (passkeys; a loopback rule read from the socket, never a header)
and `packages/core/src/redact.ts` redacts model *output* as well as input.
**Where Hermes is genuinely stronger:** the fail-direction rule; approval
history as an artifact under a hard rule (`hermes approvals suggest` mines
repeatedly-approved commands, but "destructive classes are never proposed …
`rm -rf build/` approved 100 times still never yields an `rm` entry"); and
SSRF as a named, fail-closed layer (RFC 1918, loopback, link-local, CGNAT
incl. Tailscale, cloud metadata, DNS
failure blocked, "redirect chains re-validated at each hop"). Metistry
exposes no model-supplied-URL fetch today (`mcp-brain` has none), so that
last is the checklist for the first web bridge rather than a gap. No security
ADOPT here beyond §7.4 that the Rivet note's egress proxy and
refusal-names-the-knob items don't cover; **BORROW-LATER** the fail-direction
rule as a `packages/core` conformance test the day Metistry grows a pluggable
policy callback, and the SSRF list verbatim for any future fetch tool.

---

## 7. Ranked ADOPT list

1. **Preflight before spend.** Before `tick()` starts a run, check the
   component's declared prerequisites (manifest-named env vars, its target's
   `check()`); on failure record `error = 'blocked_config: …'` and alert
   **once**, not every tick. *Invariant 5 — the manifest already declares
   what it needs.*
2. **One alert per (component, error signature), not one per tick.** A
   `failures_open` named query grouping `runs WHERE NOT ok` by component and
   a normalised leading slice of `error`, with an ack that silences that
   signature only — a different error alerts again. *Invariant 3.*
3. **A `schedules` section in `metistry doctor`.** Per schedulable manifest:
   last run's ok/error and whether it is overdue by >2× its interval; non-zero
   exit when actionable. *Invariant 5.* Reuses `loadSchedules()` and `runs`.
4. **`data_collection: "deny"` in the OpenRouter request body.** The compute
   note makes non-ZDR "a warning row, never a block"; Hermes sends the
   constraint so training-retaining providers are never selected. *Invariant
   8 — enforce at the tool, not in a badge.*
5. **Crew descriptions in `agents_delegate`.** `CrewDispatcher.names()` →
   `{name, description}` from the manifest, into the tool description, so the
   assistant picks right instead of learning by refusal. *Invariant 5.*
6. **`failure_streak` in the morning brief.** Consecutive failed runs per
   component; at 3, one line offering fix / pause / remove. Depends on 2, and
   like it serves invariant 3 — the count already exists; the action doesn't.

## 8. SKIP list

- **Messaging adapters and bot mode** — 30 inbound doors and 30 third-party
  APIs for one maintainer (invariant 8); app + push + Shortcut is shipped,
  and **DM pairing** needs an unauthenticated ingress Metistry lacks.
- **Per-context personas in one instance** — two writers on one vault.
- **A user-installable skill format and its hub** — frontmatter that
  auto-registers credential passthrough widens the tool surface from a
  document (invariant 9); the hub's trust mechanism is Python scanners.
- **In-process plugins** — Python `register(ctx)`, inverting `apps/` →
  `packages/`. **SQLite/JSON per-profile state** — invariants 1 and 3.
- **Per-job reasoning-effort pins** — `rules.yaml` tiers are the same idea.
  **`[SILENT]` suppression** — the brief deliberately always goes out.

## 9. Contradictions and open questions

- **None with `metistry-build-plan.md`** — every mechanism above either fits
  an invariant or is skipped for conflicting with one.
- **The compute note's non-ZDR posture is softer than its own principle.**
  "Warn, never block" is a prompt-shaped control in config's clothing; §7.4
  is the fix, and if the warning is meant to stay that is a decision.
- **`work.owner` semantics** (part 1 §9) is still open; untouched here. And
  **part 1 is unmerged** on `claude/research-hermes-agent` — if that branch
  is abandoned, §1's cross-reference dangles.

## 10. Could not verify

- **Nothing was installed or run.** Every claim is from the docs below; no
  Hermes source was read, and its own numbers (70+ tools, 28 toolsets, ~30
  adapters) are the docs' claims, not counted.
- **Whether Metistry records a delivery failure distinctly** — I did not
  trace what happens when a routine produces output and the push or Needs You
  write then fails. If that records `ok`, it is a seventh ADOPT.
- **Whether two engines can attach to one instance.** launchd labels and
  `state/ports.yaml` appear to prevent it, but I found no explicit
  single-writer guard (`packages/cli/src/lock.ts` is the *version* lock).
- **Not read:** the ~200 skill pages, the desktop/dashboard plugin SDKs, ACP
  internals, egress/iron-proxy, the secrets backends, most of `guides/`.

## Sources

All fetched **2026-09-12**, all HTTP 200; no fetch failed. Also read, not
linked: `features/{hooks,memory,tool-gateway,provider-routing}`, `plugins`.

[p]: https://hermes-agent.nousresearch.com/docs/user-guide/profiles
[b]: https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
[c]: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
[m]: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
[k]: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
[a]: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
[s]: https://hermes-agent.nousresearch.com/docs/user-guide/security
