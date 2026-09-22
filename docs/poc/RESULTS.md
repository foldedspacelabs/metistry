# Phase 0 — results

Record findings here as each PoC completes. Be specific about what was observed,
not just whether it worked. A partial pass is more useful than a rounded-up pass.

**Status values:** `PASS` · `PARTIAL` · `FAIL` · `NOT RUN`

---

## PoC-1 — MCP tool call under `claude -p` with macOS TCC

**Gates:** the iMessage door, and headless operation generally.

| | |
|---|---|
| Status | PASS |
| Date | 2026-08-26 |

Environment note: run from a Claude Code session whose process tree is Claude.app
(desktop), not Terminal.app, on macOS 26.4 (25E246), claude CLI 2.1.241,
Homebrew node 22.23.1. Scratch code in `poc/poc1-mcp-tcc/` — a zero-dependency
stdio MCP server, an HTTP variant (`hserver.mjs`, port 7801, doubles as the
PoC-4 host bridge), and one-shot launchd plists.

**From an interactive Terminal:** (Claude.app context, sandbox disabled) —
completed in ~9.6s, no hang, no GUI prompt, `permission_denials: []`,
`is_error: false`. chat.db read denied (`authorization denied`) because the
Claude.app tree held no FDA at test time; denial surfaced as in-band tool error
text, not through any permission machinery.

**From a launchd-started process:** the case that matters, and the interesting
result. `claude -p` itself runs fine headless under launchd (ppid=1): account
auth, Haiku call, MCP server spawn all work. TCC behavior mapped empirically
(tccd logs are fully redacted on macOS 26, so attribution had to be tested,
not read). With FDA granted to node only
(`/opt/homebrew/Cellar/node@22/22.23.1/bin/node`) and to nothing else in any
chain:

| launchd job shape | Result |
|---|---|
| `sqlite3` alone reads chat.db | DENIED |
| `node` (granted) → `sqlite3` | **PASS** — real rows returned |
| `zsh` → `node` (granted) → `sqlite3`, zsh resident | **PASS** |
| `claude -p` →(stdio MCP)→ `node` (granted) → `sqlite3` | **DENIED** |
| `claude -p` →(HTTP)→ separate launchd `node` bridge (granted) → `sqlite3` | **PASS** — end-to-end, real messages summarized by the model |
| GUI session (ungranted Claude.app) → zsh → `node` (granted) → `sqlite3` | DENIED |

The rule, as far as these five points pin it down: **TCC attributes access to a
responsible process, and interposing a granted binary mid-chain does not
reliably transfer its grant.** Under a GUI app, the app's own grant governs the
whole tree (the granted node child did not help under ungranted Claude.app).
Under launchd jobs, the job's root binary is what matters — with the observed
exception that a zsh job root was transparent and the granted node child *did*
work there, while the claude CLI as job root was not transparent (its
stdio-spawned granted-node MCP server was still denied). The safe design rule:
**a TCC-bound bridge must be its own launchd service whose root binary holds
the grant** — that shape is unambiguous and passed every time; everything else
is relying on attribution subtleties that differ between launchd and GUI
contexts. A bridge running as its own service owns its identity, and the
client needs no grant at all.

**`permission_denials` contents:** `[]` in every run, pass or fail. TCC
denials are invisible to the Claude permission layer; they appear only as tool
error text. Doctor/watchdog checks must probe the actual read, not the
permission API.

**Did anything block, hang, or surface a GUI prompt?** No, never. FDA denials
are silent and instant. No prompt appeared in any launchd or interactive run.

**Implication for the plan:**
- The iMessage door is viable exactly as designed. §4.3's choice of
  `transport: http` + `runs_on: host` for the messages bridge is not just a
  preference — it is the *only* shape that works without granting FDA to the
  claude/agent binary itself.
- stdio transport for TCC-bound bridges is ruled out (or requires granting the
  agent binary, see next point). Non-TCC bridges are unaffected.
- Granting FDA to the claude binary is possible but the binary path is
  versioned (`~/.local/share/claude/versions/2.1.241`) and churns on every
  auto-update — the grant would silently rot. Same trap, milder, for Homebrew
  node: `brew upgrade node` moves the Cellar path and drops the grant.
- Hardening note: FDA-on-node is broad (any node script under a shell/launchd
  root becomes FDA-capable). Phase 2 should consider compiling the messages
  bridge to a dedicated standalone binary so the grant attaches to one
  purpose-built executable. The plan already anticipates this ("small native
  helper").
- One operational footgun found: `launchctl submit` respawns quick-exit jobs
  in a loop. Production launchd services should be proper plists with
  explicit `KeepAlive` semantics.

---

## PoC-2 — iMessage attachments

**Gates:** rich media through the iMessage door. Share sheet is the fallback.

| | |
|---|---|
| Status | PARTIAL |
| Date | 2026-08-26 |

Scratch in `poc/poc2-attachments/`. Queries ran as one-shot launchd node jobs
(this session's own tree still lacked FDA pending the Claude.app restart).

**Attachment paths resolve and are readable by the service account?**
Yes — *when the file exists*. Every present file stat'd and read cleanly from
the node/launchd context (PNG, JPEG, HEIC, PDF, MOV all verified by magic
bytes). But existence is the problem. Over the most recent 200 attachment rows:

| mime class | present | missing (ENOENT) | NULL filename |
|---|---|---|---|
| image | 16 | **132** | 19 |
| video | 1 | 4 | 0 |
| application (pdf) | 1 | 0 | 0 |
| text (vcard) | 0 | 1 | 0 |
| null (plugin payloads etc.) | 21 | 4 | 1 |

**~89% of recent image attachments are not on local disk** — the chat.db row
exists, the bytes don't. This is iCloud Messages offloading. Even 4-day-old
images from active conversations were already absent. Two present files were
also smaller on disk than `total_bytes` (locally optimized copies). Whether a
bridge reading promptly on receipt would catch the file before offload was not
tested — worth checking in Phase 2 if it matters.

**Can Metis actually read one end-to-end (path → session → description)?**
Yes — PASS, and in the production shape: `claude -p` (haiku, no FDA) → HTTP
bridge `get_attachment` tool → node (FDA) reads the HEIC → bridge converts via
`sips` to jpeg ≤1024px (zero-dependency; necessary because the API does not
accept HEIC) → returned as an MCP image content block → model described the
photo accurately. `is_error: false`, ~9.5s total.

**Implication:** the plan asked whether iMessage is "the whole door or just the
text door." Answer: **the text door, plus an opportunistic media door.** The
pipeline works end-to-end whenever bytes are local, but for images that is the
minority case on this Mac. The ingest must treat a missing attachment as a
normal state (keep the reference, degrade gracefully), and the share sheet
(PoC-7) is confirmed as the canonical rich-media capture path — which the plan
already wanted anyway. Possible mitigation to discuss: the Messages/iCloud
storage settings on this Mac (keep originals / don't optimize), a user-level
setting change, not an engineering fix.

---

## PoC-3 — Apple Foundation Models, headless

**Gates:** the free classification tier. Fallback is Haiku — cheap, not free.

| | |
|---|---|
| Status | PASS |
| Date | 2026-08-26 |

Run by a subagent; scratch, binaries, and full run logs in `poc/poc3-afm/`.
Swift 6.3.3 / Xcode 26.6. Availability: `available`, 23 languages, assets
already downloaded. **Language note:** the plan's "Python SDK" does not exist
and looks structurally closed — FoundationModels.framework ships no ObjC
headers at all (Swift-only, `@Generable` is a Swift macro), so PyObjC has
nothing to bind. The PoC used Swift directly; the recommendation is a compiled
Swift helper that the MCP bridge shells out to.

**Works without an active GUI session?** Yes, for a LaunchAgent in `gui/501`
(the shape the plan uses): 50/50 items, zero errors, empty stderr, no XPC or
GUI-session complaints — and with greedy sampling the launchd run was
**byte-identical** to the interactive run. Untested gaps: a root LaunchDaemon
(no sudo without prompting), and behavior at the login window / logged-out —
plausibly does not work there since Apple Intelligence is per-user. Worth one
follow-up if the Mac Studio ever runs without a logged-in user.

**Throughput (items/sec over 50 samples):** **2.2/sec sequential** (0.44s/item
steady, ~0.9s first call — model lives in a resident system daemon, so warmup
and client memory (~11 MB) are near-nil). Launchd within 0.5% of interactive.
This clears the plan's ~1/sec viability bar with 2x headroom, and it is a
floor (no batching/concurrency tried).

**Extraction quality on real phrasing:** on 50 synthetic inbox lines (21 true
actions): greedy sampling flagged 17 actions, **all 17 defensible — 100%
precision, 76% recall**, fully deterministic across runs. Default sampling
added one false positive (turned a calendar event into a task). Given the
plan's precision-over-recall bar, greedy is the right config. The recall
misses are systematic, not random: the `link` category swallows `has_action`
(URLs with explicit "need to check X" intent never got flagged), and lexical
cues dominate ("grocery:" prefix flagged, identical intent without the prefix
missed). Fix for the real bridge: decouple action detection from category
(two passes, or make `link` a boolean field). Guided generation (`@Generable`)
had zero schema violations across 200 generations.

**Implication:** the free classification tier is real — faster and better
than assumed, at zero marginal cost. Two hard constraints for the bridge
design: **context window is 4096 tokens** and a reused session died at item
18/50 (`exceededContextWindowSize`), so a **fresh `LanguageModelSession` per
item is mandatory** (cost: negligible); and the binding is Swift-only, so
`mcp-apple-fm` becomes a thin MCP wrapper around a compiled Swift helper —
which conveniently matches the "dedicated native binary" pattern PoC-1's
grant-rot finding already argues for.

---

## PoC-4 — Container → host MCP bridge

**Gates:** the container/native split, and decision #9 (Metis in Docker or
native).

| | |
|---|---|
| Status | PASS (all three legs) |
| Date | 2026-08-28 |

Run by a subagent against the live PoC-1 bridge; scratch in
`poc/poc4-container/`. Docker Desktop 4.88.1 (engine 29.7.2, linux/arm64 VM).

**COMPLETED 2026-08-28** with a real `claude setup-token` credential
(subscription billing), all three legs now PASS end to end:

1. **Auth** — container `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN` (the
   `sk-ant-oat…` token, passed via `--env-file`) authenticated and replied
   `container-ok`. Decided auth path (setup-token, stay on subscription)
   works. Guardrail confirmed: `ANTHROPIC_API_KEY` must NOT be set in the
   container or it silently overrides onto API billing (documented precedence).
2. **End-to-end** — container `claude -p` → `--mcp-config` HTTP →
   `host.docker.internal:7801` bridge → chat.db returned real message
   timestamps (matching the test photo), `is_error:false`, `denials:[]`, no
   message text leaked.
3. **Session survival** — created a session by UUID, `docker restart`, then
   `--resume <uuid>` recalled its codeword (`PERSIMMON-42`) verbatim.
   Transcripts persist via the mounted volume `-v home:/root`. The plan's
   invariant "session state reconstructable, transcript is a cache" holds in
   the container shape.

Networking used the **explicit** `--add-host=host.docker.internal:host-gateway`
(not Docker-Desktop implicit DNS), per decision 6 — so the config is
Linux-portable. Operational note for Phase 2 compose: mint the token with
`claude setup-token` on the host, inject via env/secret (never bake into the
image), and the watchdog should track the ~1-year token expiry (no documented
auto-refresh) and warn ahead of time — a model-free check, PoC-11's domain.

**`host.docker.internal` reachable from the container?** Yes — PASS with zero
configuration, including for a service bound to 127.0.0.1 only (Docker
Desktop's userland proxy makes loopback reachable). Full MCP JSON-RPC
lifecycle from inside a container (initialize → tools/list → tools/call
touching the real chat.db) worked with no protocol or proxy issues. Caveat for
the `cloud` profile: this trick is Docker-Desktop-specific; plain Linux Docker
needs `--add-host=host.docker.internal:host-gateway` or equivalent.

**End-to-end: Metis container → host bridge → Messages?** Blocked on auth, and
that is the finding: on macOS, Claude Code stores its OAuth session in the
**Keychain** (`Claude Code-credentials` item) — `~/.claude/.credentials.json`
does not exist on this host, so there is nothing to bind-mount into a Linux
container. A fresh `claude -p` in a node:22 container (CLI installs fine, 3s)
returns `Not logged in`. The network path is proven (step 3); only the
credential provisioning inside the container is unresolved. Options for the
planning conversation: `ANTHROPIC_API_KEY` env (changes billing model),
`claude setup-token` → long-lived token in env (one interactive step, stays on
subscription), or a host-side auth proxy.

**Session state survives `docker compose restart`?** Container-restart variant
untested (needs working in-container auth). The underlying mechanism was
verified on the host instead: a session created by a **launchd-started**
`claude -p` (PoC-1) was resumed by UUID from a different process context
(desktop-app session) and accurately recalled its own earlier tool results.
Transcripts are plain files under `~/.claude`, keyed by cwd — a volume mount
persists them by the same mechanism. Residual risk low; formally unverified.

**Recommendation on Docker vs native (decision #9): DOCKER.** Every leg now
passes — networking, protocol, auth on subscription, and state survival across
restart. No engineering risk remains; the plan's container/native split
stands, and containerized Metis is validated end to end. Only follow-through
items are operational (token injection + expiry tracking in Phase 2).

---

## PoC-2 addendum — attachment presence by message age (2026-08-26)

Bucketing the last 2000 image attachments by message age (via launchd node):

```
1-3d   n=   1 present=   1 rate=100.0%
3-7d   n=   8 present=   1 rate=12.5%
1-4w   n=  30 present=   8 rate=26.7%
1-3mo  n= 171 present=  21 rate=12.3%
>3mo   n= 988 present= 108 rate=10.9%
```

No images <24h old existed at measurement time, so the fresh end is thin —
but the cliff between 1-3d and 3-7d says offload happens within days.

**Fresh-end confirmed 2026-08-27:** the user texted themselves a photo and it
was on disk at full size, readable, within a minute of receipt (as were
same-day images from hours earlier). Read-before-offload is viable: the
bridge copies attachments at detection time and the decided design
(recent-only, let iCloud optimize the store) holds.
Supports the decided design: the bridge copies new images into the inbox flow
promptly on detection (hours, not days); the Phase 2 timing PoC should catch a
genuinely fresh image (<1h) to confirm immediate availability.

## PoC-4 addendum — explicit container networking, no Desktop magic (2026-08-26)

Per decision 6, verified the Linux-portable explicit configuration works on
this host: `--add-host=bridge-host:host-gateway` with the bridge URL supplied
via environment (`BRIDGE_URL=http://bridge-host:<port>/...`) reached a
loopback-bound host service from a container, as did an explicitly-mapped
`host.docker.internal`. Production rule: compose files declare
`extra_hosts: ["host.docker.internal:host-gateway"]` (or a neutral name) and
all bridge URLs come from env — never rely on Docker Desktop's implicit DNS.

## PoC-5 — pgvector retrieval on notes

| | |
|---|---|
| Status | PASS on mechanics; quality bar DEFERRED (no real corpus yet, by decision) |
| Date | 2026-08-27 |

Run by a subagent in the reduced scope the user chose (new vault from
scratch → no real notes to judge against). Synthetic 120-note PARA-style
corpus with deliberate near-neighbor pairs; Ollama `nomic-embed-text` (768d,
local) + the running `poc8-pg` pgvector container. All in `poc/poc5-pgvector/`.

- **Pipeline:** heading-aware chunking → sha256 → batched `/api/embed` →
  COPY-format load (content never string-interpolated into SQL). 120 notes →
  244 chunks. `model` and `dim` stored per row (reversibility requirement).
- **Speed:** ~125 chunks/sec embed, ~1030 rows/sec insert. Full re-embed of a
  hypothetical 5000-chunk corpus ≈ **45 s** — the "choice is reversible"
  story holds with huge margin. Query: ~21 ms embed + ~23 ms search warm p50.
- **Rebuild script** written and verified deterministic (identical content-
  hash digest across runs) — the plan's requirement that it exist alongside
  the first embed run is met.
- **Smoke test:** 10/10 top-3 on natural-phrasing queries — labeled
  explicitly as "the pipe isn't broken," NOT quality evidence. One instructive
  near-miss inside a hit: an informal person-note outranked the authoritative
  project-constraints note on the same decision — a concrete preview of the
  authority-discrimination problem the real quality bar must handle.
- Build notes for Phase 6: HNSW build 48 ms at this scale but re-measure at
  real scale; batch-16 embed calls worked unoptimized; don't over-invest in
  chunking until real long documents demand it.

**The plan's actual PoC-5 question — retrieval quality on the user's own
writing — remains open by design** until the new vault accumulates content.
Consistent with Phase 6 being deliberately last.

## PoC-11 — watchdog independence

| | |
|---|---|
| Status | PASS |
| Date | 2026-08-28 |

Three probes with zero model / zero Anthropic dependency, plus an out-of-band
iMessage self-send via osascript — the whole "told Metis is broken by
something that isn't Metis" path has no model and no Anthropic call anywhere.

- **Probes:** Claude credential presence via Keychain existence check (no
  value read), Docker daemon liveness via `docker info`, collector staleness
  via marker-file mtime. All correct (STALE fired on a backdated marker).
- **Send, interactive (Terminal):** `SEND: ok`, message delivered, after the
  user approved a one-time "Terminal wants to control Messages" Automation
  prompt.
- **Send, headless (launchd job):** `SEND: ok`, message delivered — but it
  raised its **own** Automation prompt (attributed to the launchd job, not
  Terminal). Same responsible-process rule as PoC-1/9 on a third TCC
  subsystem (Apple Events): the grant is per-responsible-binary, so the
  production watchdog binary needs its Automation grant established once. A
  purely unattended first run can't self-raise that UI — pre-seed it.

**Bonus finding (launchd minimal environment):** the headless run reported
`docker:DOWN` while Docker was in fact up — the launchd job's PATH
(`/usr/bin:/bin:...`) doesn't include Docker Desktop's CLI, so `docker info`
was "command not found," not a real outage. Watchdog probes must use absolute
binary paths (or set PATH explicitly); otherwise a launchd watchdog
false-alarms. Exactly the class of bug a watchdog exists to avoid, caught
here.

Note: the sending code (osascript → Messages) is blocked by this session's
own auto-mode classifier, correctly — an agent should not send messages on
the user's behalf. The user ran both send legs; findings above are from those
runs.

## PoC-6 — Tailscale + PWA + web push on iOS

| | |
|---|---|
| Status | PARTIAL (Mac side PASS + third-party-validated; blocked on tailnet setting, then iPhone steps) |
| Date | 2026-08-26 |

Zero-dep PWA + push server built and running (`poc/poc6-pwa/`, 127.0.0.1:8093,
nohup PID 92565): manifest, service worker, icons, VAPID ES256 via node
webcrypto, payload-less push (no RFC8291 encryption needed for the PoC),
subscribe/dedupe/push-test endpoints all self-tested green. Strongest
evidence: a payload-less push sent to a real push origin (FCM) with a bogus
token returned **410 Gone** — the third-party service accepted our VAPID JWT
and rejected only the fake token. Signature independently verified (64-byte
raw r||s, 12h exp, origin-only aud).

**Blocker (user action):** `tailscale serve` and HTTPS certs are disabled at
the tailnet level — not a local/sudo issue. Enable at the URL tailscale
printed (login.tailscale.com/f/serve?node=…, plus HTTPS Certificates under
admin/dns), then `/usr/local/bin/tailscale serve --bg 8093` as the normal
user. Target URL: `https://mac-studio.tailee85c6.ts.net/`. iPhone protocol in
`poc/poc6-pwa/IPHONE-STEPS.md` (iOS 16.4+, Home-Screen install required for
push — the page self-diagnoses standalone vs tab mode). Note `serve --bg`
does not exit on the not-enabled error; it polls forever.

**COMPLETED 2026-08-27: PASS end to end.** User enabled Serve + certs at the
tailnet level; `tailscale serve --bg 8093` proxied cleanly; PWA installed to
the iPhone Home Screen over `https://mac-studio.tailee85c6.ts.net/`
(standalone mode detected, push supported); subscription landed on
`web.push.apple.com`. First pushes failed `403 BadJwtToken` — root cause:
**Apple rejects a VAPID `sub` contact of `mailto:...@example.invalid`**
(FCM had accepted the identical JWT; Apple validates the contact URI).
Changed to `mailto:metistry@mattcolf.dev` → **201 Created**, notification
delivered to the phone including with the app closed, triggered from the Mac.
Build note: the production console's VAPID subject must be a real contact on
a real domain. (Debug detour recorded honestly: a pkill pattern that didn't
match the process cmdline made a server restart a no-op, muddying one test
round — match by port, not path.) Remaining polish someday: a real app icon.

## PoC-10 — camera snapshot via RTSP

| | |
|---|---|
| Status | DEFERRED (2026-08-27, user decision) |

The cameras are HomeKit-only; no RTSP exposure exists to test against. The
plan's camera path (§2 PoC-10: RTSP on the LAN) has no applicable hardware
today, consistent with §6.10's "video analysis dropped for now."

## PoC-12 — Obsidian Sync alongside git

| | |
|---|---|
| Status | DEFERRED (2026-08-27, user decision) |

No Obsidian Sync subscription yet. Decision made in-session: the project gets
a **new knowledge vault built from scratch** (the existing iCloud "Knowledge
Vault" stays separate). PoC-12's corruption-safety protocol runs once Sync
exists and the `brain/` repo layout is real — reasonable to slide toward
Phase 6.

## PoC-7 — capture, HTTP first

| | |
|---|---|
| Status | PASS (HTTP path; iOS share-sheet leg deferred to user test) |
| Date | 2026-08-26 |

Zero-dep node server (`poc/poc7-capture/`), Bearer auth, multipart + JSON.
All five surfaces landed in `inbox/` with metadata sidecars: JPEG, JSON URL
capture, synthetic .vcf, hand-built PDF, and a **25 MB random binary —
byte-identical sha256** (the multipart parser stays Buffer-based throughout;
any string round-trip would have corrupted it). Auth negative tests 401 as
expected. The iOS share-sheet → HTTP leg needs the user's phone and a
reachable endpoint; mechanics identical, deferred.

## PoC-8 — router fast path, end to end

| | |
|---|---|
| Status | PASS |
| Date | 2026-08-26 |

`pgvector/pg17` container (left running: `poc8-pg`, 127.0.0.1:5433), `work`
table with 25 synthetic rows, named query resolved from a file, `GET
/api/q/open_work` with param validation, TTL cache, `as_of` freshness stamp.

- Cache-hit warm: **p50 0.59 ms** (~350x under the bar)
- Cache-bypassed (psql subprocess per request): **p50 23.8 ms / p95 28.7 ms**
  — still 8x under the 200 ms bar, but 99.9% of it is per-request TCP+auth
  handshake (query itself: 0.03 ms). Real console must use a persistent pg
  connection/pool, which drops warm latency to low single-digit ms and
  removes the psql dependency.

Build notes captured for Phase 4: `psql -c` has no safe param binding (real
driver needed, or strict-typed substitution only); product named queries
should be YAML as planned (JSON here was a zero-dep constraint only).

## PoC-9 — EventKit writes (Calendar + Reminders)

| | |
|---|---|
| Status | PASS — full CRUD on both stores under launchd |
| Date | 2026-08-28 |

Scratch staged in `poc/poc9-eventkit/`. Both stores authorized (Calendars and
Reminders granted at the machine, unlocked) and full CRUD **PASSED under
launchd**: Calendar create/read/query/update/delete against the iCloud source,
and Reminders create/read/update/complete/delete, with cleanup. iPhone sync
confirmed by the user (the "PoC-9 sync check" reminder appeared and was
deleted). No stray calendars or launchd jobs left behind.

**Status reads are themselves responsible-process-bound** — a real trap for
`doctor`. The process that just received a grant can still read
`notDetermined`, and a status check run in the Claude.app shell tree reads
`notDetermined` permanently regardless of the real grant. `grant.sh`'s tail
"still not granted" was this false-negative, not a failed grant. A TCC bridge's
health check must run *in the granted binary's own context* or it will report a
working grant as missing.

Findings already established:

1. **The responsible-process rule reproduced on a second TCC subsystem.**
   From the Claude.app shell tree, `requestFullAccessToEvents` returned
   `granted=false` instantly with no prompt and no recorded decision —
   because the usage-description strings must exist on the *responsible*
   process's Info.plist, and Claude.app has none. Under launchd (binary =
   its own responsible process, plist embedded) the prompt genuinely renders.
2. **Bare-CLI consent mechanics solved:** embed Info.plist via `-sectcreate
   __TEXT __info_plist` + ad-hoc `codesign` with an explicit identifier.
   Traps recorded: keep the plist out of the binary's directory (codesign
   auto-bundles otherwise), and ad-hoc identity = cdhash, so **any source
   edit silently drops the TCC grant** — Phase 2 needs a stable signing
   identity for native helpers (third grant-rot variant found).
3. **Unauthorized EventKit fails silently** — empty `sources`, zero
   calendars, no error raised. `metistry doctor` must probe for non-empty
   sources, the exact analogue of PoC-1's invisible TCC denials.
4. `destructive: true` preview-confirm remains untested (bridge-contract
   behavior, Phase 1 `core`).

## PoC-13 — comms reduction quality

| | |
|---|---|
| Status | FAIL (extraction quality, as configured) — plumbing PASS |
| Date | 2026-08-26 |

Run by a subagent over the 200 most recent real Messages (privacy rules held:
pipeline fully local, report body-free). Full artifacts in `poc/poc13-comms/`.

**Blocking prerequisite discovered and solved:** `message.text` is dead —
**99.3% of the last 1000 messages have NULL text**; the content lives in
`attributedBody` (typedstream). A ~30-line zero-dep decoder was written and
validated exactly (82/82 against rows carrying both fields). Any Messages
bridge MUST decode attributedBody; reading `text` sees nothing.

**Throughput:** 1.2 items/sec — a real nightly volume (~17 msgs/day observed)
takes ~14s; 300 items ≈ 4 min. Non-issue. One `GenerationError.Refusal`
guardrail trip in 200 (pipeline needs an explicit unclassified bucket, not
silent drops).

**Precision: fails the bar.** 116/200 flagged (58%); ~30% row-level precision
optimistic ceiling, ~20% on distinct tasks (massive duplication — one action
string 22×). Failure patterns: OTP/2FA texts → ~45 FPs ("Keep secret" as a
task); posted bank transactions misread as outstanding obligations (no
past/future tense discrimination — the dangerous one); marketing CTAs
promoted to todos; pleasantries as tasks; `date_ref`/`entity` confabulated on
116/116 with urgency=high on 84% (no signal). Recall shape is inverted from
useful: eagerly flags short automated text, **missed the single
highest-stakes human item in the corpus** (a long outgoing message working
through a job offer with an explicit ask).

**Identified levers (untested):** deterministic prefilter dropping automated/
short-code traffic (removes ~55 FPs; the plan already prescribes this in
§4.11 "Volume" — validated as necessary, not sufficient: human-message flag
rate is still 46%); optional schema fields so the model can decline
(fabricated date_ref as rejection signal); tense discrimination; dedupe.
Whether those reach a usable precision is unknown — do not build the comms
ingest on the current extraction step.

**Privacy finding that must shape §4.11:** the "structured row is body-free /
low-sensitivity" assumption is **unsound without mechanical output
redaction**. Despite explicit prompt instructions, the model copied a live
6-digit verification code verbatim into an action field; 7 more rows carry
4-digit runs, one a phone number, 80/200 an identifying capitalized token
(names of family/clinics/pets). Prompt-level rules were ignored — consistent
with the plan's own principle: enforce at the tool. Stage-2 output needs a
deterministic redaction pass (digit-run scrubbing, NER-ish token filtering)
before it can be treated as low-sensitivity. (Also: `poc/poc13-comms/
stage2.jsonl` on disk currently contains that copied OTP — likely expired,
but the user may want to delete or scrub the file.)

**Mail correction:** earlier this session I reported Mail unused — wrong (a
depth-capped listing). `~/Library/Mail` holds ~72k .emlx files from the last
3 months. **No IMAP credentials needed**: the mail corpus is a local-file
parsing problem, and it is two orders of magnitude larger than Messages.

## PoC-14 — local classifier pre-stage for input segmentation (user proposal)

| | |
|---|---|
| Status | FAIL — judgment untrustworthy; keep invariant 4 as written |
| Date | 2026-08-27 |

Run by a subagent: 40 hand-labeled fixtures across 6 classes, two prompt
configs, two passes each (160 AFM generations), mechanical verbatim-substring
checks, greedy sampling. Fully deterministic across passes — every failure is
stable, not noise. Artifacts in `poc/poc14-classifier/`.

**The critical metric failed:** over-split rate on must-not-split inputs was
42–54%; multi-clause single requests (e.g. "plan the trip to portland:
flights, hotel, and a dinner spot") were kept intact **0/8 under both
prompts** — the model splits on lexical cues (colon, comma, dash, "and"),
not semantic independence, even when the prompt quotes the exact
counter-examples. Acting only on confident, mechanically-clean *split*
verdicts still corrupts a single request ~1 time in 3.

**Worst failure class — and it passes every automated gate:** quoted/
forwarded content promoted to user intent. "fwd from mom: pick up the cake
and call the caterer — just filing this, dont do anything with it" became a
`task_request` for the errands with the user's explicit don't-act demoted to
a note. A pasted OTP text yielded a `command` segment ("Reply STOP"). One
run confabulated an ask the user never wrote (caught only by the
verbatim-substring check — that check is load-bearing).

**Model-asserted booleans are anti-signal:** `needs_session_context` fired
either never (v1) or on exactly the wrong items with 0/4 precision AND 0/4
recall (v2); `depends_on_other_segment` was noise (1 true positive vs 14
false positives). Generalizes PoC-13's confabulation finding: never use a
model-asserted flag as a safety gate. Latency also missed the target:
1.2–2.2s per input, every one of 160 generations over 1s.

**Disposition:** invariant 4 stands. The only defensible remnant is far
smaller than the proposal: a split *suggestion* surfaced for user
confirmation (never acted on silently), behind a deterministic pre-filter
that skips any input containing quotes, colon-introduced pastes,
forward markers, URLs, or non-first-person text. Multi-intent handling
stays where the plan put it — Metis decomposes with session context.
Five failure classes for the router to guard against regardless are
enumerated in the agent artifacts (`score*.txt`).

## PoC-15 — complexity-tier scorer (invariant 4 evaluation)

| | |
|---|---|
| Status | SPLIT: Apple FM FAIL · Haiku PASS-with-caveats · decision deferred to a confirmatory eval |
| Date | 2026-08-28 |

Evaluates the user-proposed amendment to invariant 4: a model scoring input
complexity to pick among user-configured tiers (cheap/standard/deep). 48
hand-labeled fixtures, length decorrelated from tier (r = −0.05), with
long-but-cheap and short-but-deep traps. Run by a subagent; artifacts in
`poc/poc15-complexity/`. Distinct from PoC-14 (segmentation): one constrained
label, graceful failure mode — and the results differ accordingly.

**Apple FM: REJECT as scorer.** Its `cheap` class functionally does not exist
(0/16 across two greedy runs; a re-prompt recovered 3/16 while doubling
deep-misses). All 6 long-but-cheap traps failed in all four runs — including
one verdict whose stated reason correctly identified the trap and then
labeled it wrong anyway. Plus a deterministic guardrail refusal on "remind me
at 5 to move the car." 100% run-to-run reproducible, 90% prompt-fragile:
reproducibility is not correctness.

**Haiku: passes the quality bar.** 91.7% accuracy, deep-miss 1/16, overspend
0/16, and the only scorer beating surface features both ways (6/6 long-cheap,
5/6 short-deep). Baselines for contrast: always-standard mis-serves 15/16
high-stakes asks; a length heuristic sends 7/16 deep items to cheap —
actively inverted on what matters.

**The pre-registered cost criterion was ill-posed and is corrected here:** a
*perfect oracle* costs +190% vs always-standard, because finding deep items
means paying for deep. Always-standard is not a cost baseline; it is a
quality floor. The honest framing at a realistic message mix: Haiku routing
costs ~$3.60/1000 turns more than always-standard and rescues ~88 badly-
served high-stakes turns — ~4¢ per rescued turn — while saving 83% vs the
quality-matched always-deep. Scoring cost itself (~$1/1000) is noise.

**Caveats that block a final verdict:** the Haiku measurement ran through
`claude -p` (a full agent harness — one fixture's "verdict" was actually a
tool-auth complaint; latency numbers are harness artifacts; production shape
is a bare no-tools API call, unmeasured); fixtures and rubric shared an
author; and 16 deep items cannot resolve a 10% miss threshold (1 miss = 6.2%,
2 = 12.5%).

**Disposition:** invariant 4 stands for now; defensible interim is
default-standard + explicit user escalation. Amendment proceeds only if a
confirmatory eval passes: bare Messages-API Haiku (no tools), fixtures
authored independently of the rubric, ≥50 deep items. Either way the
invariant's protections are preserved by construction — the scorer only
selects among user-configured tiers under tool-enforced budgets, deterministic
rules take precedence, and every verdict logs to `runs` (plan §4.17.D).

## PoC-16 — local models as tier scorer

| | |
|---|---|
| Status | PASS — a local model beats the Haiku baseline on every quality axis |
| Date | 2026-08-28 |

Follow-on to PoC-15 at the user's direction: can a locally-run model (Ollama,
OpenAI-compatible endpoint, bare API call — no harness contamination) replace
billable Haiku as the complexity scorer? Six arms on the identical PoC-15
fixtures, temp 0, strict json_schema. Hardware: M4 Max, 64 GB. Artifacts in
`poc/poc16-local-scorer/` (analyzer imports PoC-15's `evaluate()` so metrics
are identical by construction).

**Winner: `gemma4:e4b-it-qat`** (7.5B MatFormer, ~4B active, 6.1 GB download,
6.3 GB resident): **97.9% accuracy vs Haiku's 91.7%**, deep-miss 1/16 (tie),
overspend 0/16 (tie), traps **6/6 + 6/6** (beats Haiku's 5/6 short-deep),
100% deterministic across three runs, zero parse failures, **warm p95 667 ms**
(4.5× inside the 3 s bar), $0/verdict. Cold load 5.7 s if evicted (mitigate
with `keep_alive`). Also passing: `gemma4:12b` and `qwen3.6:35b-a3b` (the MoE
— 35B knowledge at 909 ms mean; kept as the named fallback, though removed
from disk). `qwen3.6:27b` missed only the latency bar by 5%.

Findings beyond the headline:

1. **The "sub-4B fails like Apple FM" hypothesis was falsified — calibration,
   not size, is the variable.** Granite 8B (bigger than the winner) failed in
   the mirror image of AFM: AFM's cheap class collapsed to zero, Granite's
   over-fired (7/16 deep-misses). Both miscalibrated, opposite directions.
2. **Reasoning hurts this task, measured:** identical weights with thinking
   enabled cost 9× latency, *lowered* accuracy (95.8% vs 97.9%), and broke a
   long-cheap trap by deliberating its way into "potential legal
   implications." The scorer should run with reasoning suppressed.
3. **A label dispute worth carrying into the confirmatory eval:** all five
   competent local arms missed the same single deep item (D08, terse
   operational replanning) with near-identical reasons, while every local
   model got the item Haiku missed (D04). Non-overlapping blind spots —
   either the D08 label is contestable or local models under-rate terse
   multi-constraint replanning. To be resolved by independent labeling, not
   assumed.
4. Ollama 0.33 harness notes: `/v1` ignores native `think` but honors
   `reasoning_effort: "none"`; strict `json_schema` worked everywhere (retry
   logic never fired); `maxLength` inside a schema breaks generation.

**Disposition unchanged from PoC-15:** the fixtures are still author-aligned
with only 16 deep items — 97.9% here is not 97.9% in production. The
invariant-4 amendment still waits on the independent confirmatory eval
(fixtures authored blind, ≥50 deep items, D08-class items adjudicated), now
with `gemma4:e4b` as the candidate scorer instead of Haiku: if it passes, the
scorer is free, local, private, and adds ~0.7 s ahead of a 5–10 s turn.
Cleanup done: losers removed, 186 Gi free, `nomic-embed-text` untouched.

## PoC-17 — lazy tool discovery spike (Phase 1 gate)

| | |
|---|---|
| Status | SPLIT — the mechanism works at the Haiku tier; the economics inverted on a small bridge |
| Date | 2026-08-30 |

The Phase 1 spike plan §4.3 requires before `core` freezes its discovery
interface: one toy bridge (40 tools, 8 domains, minimal hand-rolled MCP
stdio server — spike only), `eager` (all 40 exposed) vs `lazy`
(`tool_index` / `execute` / `batch` meta-tools), 5 scripted tasks each at
the Haiku tier via `claude -p`, correctness scored from the server's own
call log. Artifacts in `docs/poc/poc17-lazy-discovery/`.

**Result: 10/10 correct.** Haiku drives the meta-tool indirection with zero
confusion — every lazy task called `tool_index` first, then executed
exactly the right underlying tool(s), including the two-tool task (T5).
The reliability question the plan flagged as its largest untested claim is
answered: **the indirection works at the cheap tier.**

**But lazy lost on every cost axis in this harness:**

| avg over 5 tasks | eager | lazy | delta |
|---|---|---|---|
| correct | 5/5 | 5/5 | — |
| turns | 3.2 | 4.2 | **+1 (the discovery round-trip)** |
| cumulative prompt tokens | 108.0k | 144.6k | **+34%** |
| output tokens | 435 | 614 | +41% |
| wall time | 8.7 s | 11.1 s | **+2.4 s** |

Why: this bridge's 40 tool definitions are *small* (~1.5k tokens total), and
`tool_index` returns essentially the same list as content — so lazy saved
nothing on definitions while paying a full extra turn (which re-sends the
whole context) on every task. Prompt caching absorbed most of the per-turn
cost in both modes (uncached input: ~30 vs ~40 tokens), which further
shrinks what lazy can save inside a cached session.

**Interpretation — when lazy pays.** The plan's ~21k-token measurement came
from real-world bridges with verbose schemas across many mounted servers.
Lazy wins only when (a) full definitions are large relative to the index,
and (b) most mounted tools go unused in a typical turn. For a small or
frequently-used bridge, lazy is strictly worse: +1 turn, +2.4 s, more
tokens.

**Recommendation for `core` (needs owner sign-off — plan §4.3 leans the
other way):** keep the `discovery: lazy|eager` field and freeze the three
meta-tool names as designed, but **default to `eager`** and reserve `lazy`
for bridges whose exposed surface is genuinely large (rule of thumb: >20
tools or >5k tokens of definitions). The per-bridge measurement is cheap
(tokens of definitions is a static count at manifest-validation time — CI
could even warn when an eager bridge crosses the threshold).

Caveats: n=5 tasks; toy definitions are leaner than real ones; whether
Haiku used `batch` vs sequential `execute` on T5 was not instrumented;
single-shot tasks — a long chatty session changes the amortization (the
definitions ride every turn in eager, but caching largely neutralizes
that too).

## PoC-19 — Apple FM behind an OpenAI-compatible `/v1` (runtime JSON schemas)

**Gates:** compute PR 4 — whether Apple FM becomes a normal
`kind: openai-compatible` provider at cost 0, or stays a special case.

| | |
|---|---|
| Status | PASS |
| Date | 2026-09-16 |

Scratch server, harness and full run logs in `docs/poc/poc19-apple-fm-v1/`.
macOS 26.4 (25E246), Swift 6.3.3 / Xcode 26.6. Run in a worktree on port
7841 as a plain process; the Studio's production `apple-fm` bridge on
`:7810` was not touched.

**Does Foundation Models accept a schema built at runtime?** **Yes —
`DynamicGenerationSchema`.** Apple's own doc JSON calls it "the dynamic
counterpart to the generation schema type that you use to construct schemas
at runtime" (macOS 26.0+), and the installed SDK's `.swiftinterface` has
the line that settles it: `GenerationSchema.init(root: DynamicGenerationSchema,
dependencies: [DynamicGenerationSchema]) throws` — which produces exactly
the `GenerationSchema` that `session.respond(to:schema:)` already takes.
**No `@Generable` type is involved anywhere on that path.** The
compiled-shapes fallback this PoC was allowed to settle for was never
needed. The research note's **option (b) is confirmed; option (a)'s special
`kind: apple-fm` stays rejected.**

**The surface works.** A single-file `swiftc` server (the shipped helper's
build shape) serves `GET /v1/models` → `apple/foundation-model` and
`POST /v1/chat/completions` with `response_format: {type: json_schema}`,
translating the caller's JSON Schema per request. Objects, string `enum`s,
arrays with `minItems`/`maxItems`, nested objects inside arrays and `anyOf`
unions of object subschemas all translate — a discriminated union assembled
at request time is something `/classify` could never express.

**20 requests × 3 shapes, end-to-end client latency:**

| case | ok | schema-valid | p50 | p95 |
|---|---|---|---|---|
| plain text, no schema | 20/20 | n/a | **268 ms** | 309 ms |
| 3-field classification schema | 20/20 | **20/20** | **497 ms** | 516 ms |
| nested schema, two arrays | 20/20 | **20/20** | **1464 ms** | 1626 ms |

**Zero schema violations in 40 structured generations**, matching PoC-3's
result for compiled types. Cold start is a non-event (first call 0.33 s —
the model is a resident system daemon). Same three prompts through LM
Studio's `google/gemma-4-e4b` on `:1234` for a like-for-like line: 124 /
348 / 1510 ms p50 — faster on short work, level on the nested case, 13.5 s
on its first (loading) request, and non-deterministic at its defaults. The
difference that decides routing is residency: 22.7 MB for the Apple FM
server (weights already in RAM for the OS) against 842 MB RSS for the GGUF
backend, RSS understating the mmapped weights.

**Four things PR 4 has to get right, each found the hard way:**

1. **Key order out of `GeneratedContent.jsonString` is not stable.** Across
   20 identical nested requests: 20 distinct byte strings, **1 distinct
   value**. Greedy sampling is deterministic in the way that matters, but
   any consumer that hashes, regexes or string-compares model output will
   see phantom differences. Parse, never match.
2. **The schema is charged to the 4096-token window.** With
   `includeSchemaInPrompt` the schema sits inside it, ~32 tokens per
   described field. Measured ceiling on one flat object: 80 fields works
   (2604 prompt tokens, 16.9 s), 160 fails with `exceededContextWindowSize`
   ("5342 tokens … maximum allowed context size of 4096"). Practical limit
   is ~40 fields on latency alone. `tokenCount(for: schema)` makes this
   checkable *before* the call — a `400` instead of a `500`.
3. **Refuse what you cannot translate.** `$ref`, `$defs`, `oneOf`, `allOf`,
   `not`, `patternProperties` have no `DynamicGenerationSchema` equivalent.
   Dropping them silently would make the provider lie about `strict: true`;
   the PoC returns `400 unsupported_schema` naming the offending keyword.
4. **`usage` can be real, and cost is genuinely 0.**
   `SystemLanguageModel.tokenCount(for:)` (macOS 26.4+) has overloads for
   prompt, instructions, tools, schema and transcript entries. Apple exposes
   no per-response usage object, so this is the honest substitute: three
   round-trips, 39–57 ms — ~16% of a plain-text call, ~4% of a nested one.
   Worth a flag for callers who do not want it.

PoC-3's rules survive unchanged: **fresh `LanguageModelSession` per
request** (the window is per session) and Swift-only (invariant 6).

**Not verified:** concurrency (the server is deliberately serial, so the
latencies carry no queueing noise — what Foundation Models does under
parallel sessions is an open PR 4 decision); streaming onto SSE; tool
calling; any of `core`'s wire contract (auth, manifest, `check()`) since
this is a bare loopback process, not a bridge; output *quality* (latency
and conformance only — PoC-3 and PoC-15/16 own that question); multi-turn
`messages` beyond one system + one user; and any Mac other than this one —
`DynamicGenerationSchema` is annotated macOS 26.0 but `.null`, `tokenCount`
and `representNilExplicitlyInGeneratedContent` are 26.4-only, so the
`#available` guards the PoC carries are untested on 26.0–26.3.

## PoC-20 — a fast local intent tier for inputs (phase 0: the router's baseline)

**Gates:** everything after it. Phase 0's number decides whether PoC-20
phases 1–3 get built at all, or whether the answer is more `fast_path`
regexes.

| | |
|---|---|
| Status | **NOT RUN** — phase 0 is run by the owner |
| Date | — |

Design and candidate measurements:
**`docs/research/2026-09-21-intent-classification-tier.md`** (2026-09-21;
recommendations approved 2026-09-22). Its §2 latency figures were taken on
this Mac against the local servers already running; its accuracy columns are
explicitly illustrative, because C11 forbids Claude-authored labels and
§4.4 says where the real fixtures come from.

**Phase 0 is a measurement and an exit rule, and it needs the instance's
database** — which the research deliberately did not touch (§5.3). The
tooling for it ships; the run is the owner's:

```
metistry compute route-report [--since 30d] [--json]
```

One named query (`seed/queries/route_report.yaml`, invariant 3) over
`inbound_messages.meta.route`: the share of real messages that took `note`,
`fast_path`, an `override`, or fell through to the `default` tier, and — among
the fall-throughs — the distribution of length and of first word. Counts
only, no message text, so it is safe on the generic query door.
`docs/ops/compute.md`, "The router's baseline", says what to read in it.

**The exit rule, from §5.2, printed as the verdict:** *fall-through under
~40 % ⇒ stop and write `fast_path` rules instead — an extra regex is free,
auditable and self-documenting in the command menu. Over it ⇒ phase 1
(answer-token scoring through the existing compute layer, no new dependency)
is worth building.*

**What the phases are, so the number has somewhere to land** (§5.2): phase 1
is `scoreChoice()` beside `completeJson()` in `collectors/compute-client.ts`,
wired to capture's fall-through branch first; phase 2 is the JSON-schema arm
and the `rules.yaml` `when:` vocabulary, which needs the §3.2 invariant-4
ruling; phase 3 is embeddings over the `nomic-embed-text` vectors the vault
already stores, unlocked by the fixture harvest. **No external candidate is
recommended at any phase** — Nimble is unlicensed, Jev is off-machine, and
Laya is Python with no HTTP surface (§2).

Write the result up here when it has been run: the number, the window it was
taken over, and which side of ~40 % it landed.

## Contradictions with BUILD-PLAN.md

Anything a finding invalidates. Note it here; don't edit the plan.

1. **§2 PoC-3 / §4.15 "Python SDK" for Apple FM — invalidated.** There is no
   Python SDK and no plausible PyObjC route (Swift-only framework, no ObjC
   headers). The `mcp-apple-fm` package becomes a thin wrapper shelling out to
   a compiled Swift helper. Also: 4096-token context, fresh session per item
   mandatory — fine for classification, rules out long-document work on AFM.
2. **§4.3 `transport: http` for TCC-bound bridges is a requirement, not a
   default.** A stdio MCP server spawned by the agent inherits the agent
   binary's TCC identity and is denied even when the server binary itself
   holds FDA. (Non-TCC bridges are unaffected; stdio stays fine there.)
3. **§2 PoC-2's implicit assumption that attachment files are on disk —
   mostly false for images.** ~89% of recent image attachments are iCloud-
   offloaded with no headless recall API. iMessage is the text door plus an
   opportunistic media door; share-sheet capture (PoC-7) is the real media
   path. Plan already leans that way; this hardens it.
4. **§4.11 stage-1/2 assumptions revised by PoC-13:** (a) `message.text` is
   effectively empty on this OS — attributedBody decoding is a hard
   prerequisite for the Messages bridge (decoder exists, validated); (b) mail
   ingest needs no IMAP — the local Mail store is present and large; (c) the
   "structured row contains no message body ⇒ low sensitivity" premise is
   unsound without a mechanical redaction pass on model output (a live OTP
   was copied into a structured field despite prompt instructions); (d)
   extraction precision as configured (~30%) fails the plan's own bar —
   §4.11's "build this last" is now backed by data, and the ingest should
   not be built until the prefilter+schema levers are re-tested.
5. **Not a contradiction, a trap the plan should note:** TCC grants attach to
   versioned binary paths. Homebrew node moves on upgrade;
   `~/.local/share/claude/versions/<v>` churns on every auto-update. Any
   FDA-holding bridge should be a stable-path compiled binary.

## Questions for the next planning conversation

**Decided 2026-08-26 (in session):**
1. *Auth:* stay on subscription. Metis runs in a container (wanted for egress/
   resource control); evaluate `claude setup-token` (likely starting point)
   vs a host-side auth proxy for getting the subscription credential into it.
   API key only if hard-blocked later.
2. *Attachments:* do NOT keep originals (storage). Requirement narrows to
   **recent** messages only: bridge must read/copy new images into the inbox
   flow before iCloud optimizes them away; older ones may expire. Phase 2
   bridge PoC must verify read-before-offload timing.
3. *Binaries:* stable-path compiled binaries for the native tier. Confirmed.
4. *Login window:* stay logged-in-user (gui/501 LaunchAgents) for now;
   service-based approaches later if ever needed.
5. *Gateway (`mattcolf.dev`):* only for exposing services (incl. MCP) beyond
   the local host — register there only if cloud agents/internet need it;
   otherwise host networking within the container setup.
6. *Docker networking:* no Docker-Desktop magic — explicit configuration
   (e.g. `extra_hosts: host-gateway`, config-driven bridge URLs) so it works
   on plain Linux too. No hardcoding.
7. *Meta-requirement (restated):* everything must be repeatable and hostable
   elsewhere — a stranger clones the repo and installs via configuration and
   setup scripts, never hand-config or environment assumptions.

1. **Containerized Metis auth — RESOLVED 2026-08-28.** `claude setup-token`
   → `CLAUDE_CODE_OAUTH_TOKEN` env, stays on subscription, validated end to
   end (see PoC-4). Container must never set `ANTHROPIC_API_KEY` (overrides
   onto API billing). Phase 2: inject via secret, watchdog tracks ~1yr expiry.
2. **Messages storage settings:** would you flip "keep originals / don't
   optimize" for Messages on this Mac to improve attachment availability, or
   accept the share sheet as the only reliable media path? Also worth testing
   in Phase 2: whether a bridge reading immediately on receipt catches files
   before offload.
3. **Bridge binary strategy:** compile the messages bridge (and the AFM
   helper) as dedicated stable-path binaries so FDA grants are narrow and
   don't rot? PoC-1 and PoC-3 findings both point this way.
4. **Login-window behavior:** AFM (and probably TCC grants) validated only
   for a logged-in `gui/501` LaunchAgent. If the Mac Studio is ever expected
   to serve while logged out / after reboot-to-login-window, that needs one
   follow-up test and possibly auto-login policy.
5. **Home gateway (`mattcolf.dev` + tailnet, being built in a parallel
   session):** the user intends it as the exposure path for local services,
   likely including MCP bridges for the future `cloud` profile — overlaps
   §4.16's satellite-node story and PoC-6's `tailscale serve`. Decide how the
   console/bridges register with it, and require real auth on any
   TCC-privileged bridge before it is proxied anywhere.
6. **Proposed (2026-08-27, user idea): a local "classifier" pre-stage.** A
   small on-device agent parsing user input, detecting commands, and
   splitting multi-intent messages before the router dispatches parts.
   Conflicts with invariant 4 as written ("no model decides which model") —
   adopting it is a deliberate plan amendment. Candidate shape that preserves
   the invariant's purpose: deterministic tiers run first untouched; AFM
   classifier only on fall-through, emitting *hints* (annotate, don't gate),
   every verdict logged to `runs`, fail-open to Metis, never rewrites or
   drops text. Feasibility is bracketed by PoC-3 (tight-schema classification:
   excellent) vs PoC-13 (open-ended intent judgment: poor); a ~1h "PoC-14"
   segmentation test on the existing AFM harness would settle which shape
   this is. Also note the latency inversion: fast path is ~24ms, an AFM pass
   ~500ms — the classifier must never sit in front of deterministic matching.
   **RESOLVED same day: PoC-14 ran and FAILED (see its section). Invariant 4
   stays as written; the idea survives only as a confirm-with-user split
   suggestion, if at all.**
7. **Docker on Linux:** `host.docker.internal` is Docker-Desktop magic; the
   `cloud` profile needs `--add-host=host.docker.internal:host-gateway` or
   config-driven bridge URLs (the plan's "no absolute paths / config from
   env" rule should cover this — just don't hardcode the hostname).
