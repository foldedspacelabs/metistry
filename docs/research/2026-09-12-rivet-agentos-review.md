# Rivet agentOS review — what to take, what to leave (2026-09-12)

Owner prompt: [rivet-dev/agentos](https://github.com/rivet-dev/agentos) — "the
VM and virtual resource controls stood out, as well as the other Rivet
projects in the same org (workflows, tasks, agents, etc.)."

Everything below was read from the repo's own docs at `main`
(`docs/content/docs/*.mdx`) and the GitHub/npm APIs on 2026-09-12. Sources at
the end. Nothing was run locally.

## What agentOS is

A **library that gives one process a fleet of tiny sandboxed VMs**, Apache-2.0,
`@rivet-dev/agentos@0.2.19` (2026-09-02). Not a container, not a microVM:

> Runs inside your process: No microVMs to boot, no containers to pull, no
> nested virtualization. Warm VM creation takes single-digit milliseconds and
> each VM costs tens of megabytes. ([README][r-readme])

Three parts. Your app (the **client**, trusted) configures a VM. A **sidecar**
— a Rust binary; `crates/kernel`, `crates/vfs`, `crates/v8-runtime` — is the
trusted kernel: it owns the virtual filesystem, process table, socket table,
pipes, PTYs and the permission policy. The **executor** — a V8 isolate for
guest JS, WASM for compiled tools — is assumed hostile. Guest code makes POSIX
syscalls; every one is serviced by the sidecar, never by the host.

> **The security boundary is sidecar ↔ executor.** … **Configuration is not an
> attack surface.** ([security-model][r-sec])

**What "virtual" covers.** Filesystem (in-memory VFS; host bytes enter only via
`files`, `mounts` — read-only unless you opt out — or `nodeModules`), processes
(`child_process` spawns kernel-managed guest processes only), network (guest
`fetch`/`http`/raw sockets flow through the kernel socket table; egress denied
by default), DNS, pipes, PTYs, env, and time (high-resolution clocks are frozen
within a run and `SharedArrayBuffer` removed, as Spectre mitigation).

**How limits are enforced: language-level, not kernel-level.** No seccomp, no
namespaces, no hypervisor. Isolation is V8 isolate + WASM sandbox + a syscall
broker in Rust. Six permission scopes (`fs`, `network`, `childProcess`,
`process`, `env`, `binding`), each `"allow"`, `"deny"`, or `{ default, rules }`
with ordered patterns and per-operation verbs; last matching rule wins; a
denial is `EACCES` **before any host resource is touched**. The baseline merges
partially, so you name only what you change:

```ts
{ fs: "allow", childProcess: "allow", process: "allow", env: "allow",
  network: "deny" }   // the secure default; `{ network: "allow" }` merges over it
```

Resource caps are per-VM, operator-raisable and never guest-raisable:
processes, fds, sockets (256), VFS bytes, inodes, WASM fuel/memory/stack, V8
heap (128 MiB), JS CPU time (30 s), wall clock, Python timeout, bounded stdin
and event queues, and durable ACP collection caps.

**Persistence.** Actor-backed VMs write `/home/agentos`, the session catalog
and completed session history to a per-actor **SQLite** database over a Unix
socket; the sidecar reads and writes filesystem chunks directly. Adapters,
running processes, shells, cron definitions and in-flight deltas do not
survive. Sleep preserves, destroy deletes. The docs are blunt that this store
is "trusted plaintext": session env, MCP credentials, prompts and tool payloads
sit there unencrypted ([persistence][r-persist]).

**Tools/MCP.** There is no MCP surface of their own — I found no MCP doc page
and only a test fixture naming it. Tools reach the agent two ways: **bindings**
(host JS functions exposed inside the VM as named CLI commands; the guest sends
JSON and gets JSON, credentials never leave the host) and a **software
registry** of WASM-packaged binaries (git, ripgrep, jq, sqlite3, curl, vim,
coreutils). MCP arrives only because the shipped agents are ACP adapters
(Claude Code, Codex, OpenCode, Pi) that bring their own.

**Multi-agent.** Also bindings: one VM's agent runs `agentos-review submit
--code "$(cat api.ts)"`, the host handler writes the bytes into a second VM and
prompts it. VMs share no filesystem, so contents pass by value. Durability
across restarts is delegated to workflows.

**Observability.** A **limit registry**: every gauge and bounded queue
registers depth / high-water / capacity, emits a structured warning at ~80% of
capacity (once per crossing, re-armed on recovery) into both stderr and a
callback carrying `{ name, category, observed, capacity, fillPercent }`, and
fails with a typed error *naming the config field to raise*. Sidecar stdout is
the framed wire protocol; logs go to stderr only. And:

> A CI audit fails the build if any limit-shaped constant is not classified and
> — for operator-tunable ones — wired to a config field ([limits-obs][r-lim])

## The sibling repos

| repo | ★ | last push | licence | verdict |
| --- | --- | --- | --- | --- |
| `agentos` | 4.6k | 2026-09-10 | Apache-2.0 | read |
| `actors` (RivetKit) | 6.1k | 2026-09-11 | Apache-2.0 | read |
| `workflows` | 231 | 2026-09-09 | Apache-2.0 | read |
| `sandbox-agent` | 1.6k | 2026-06-19 | Apache-2.0 | skip (stale) |
| `rivetkit-swift` | 7 | 2026-09-11 | **none** | skip |
| `dynamic-apps` | 1.0k | 2026-09-09 | **none** | skip |

**actors** (`rivetkit@2.3.17`, Rust + TS) is the substrate everything else sits
on: long-running stateful processes with in-memory state, automatic SQLite
persistence, sleep/wake on a 30 s idle timeout, queues, scheduling, and
per-actor realtime connections. It is a genuine runtime, well maintained,
shipping releases weekly. It is also a *replacement* for the shape Metistry
already has (launchd + one supervisor + Postgres) and brings its own durable
store — an idea to understand, not a library to adopt.

**workflows** (`@rivet-dev/workflows@1.0.0`, 2026-08-31, TypeScript) is durable
replayable multi-step execution: an actor's `run` handler wrapped in
`workflow()`, where each `ctx.step()` is recorded, retried and resumed
independently. Small, clean, 1.0. It is a peer of RivetKit and cannot be used
without it — the package "re-exports RivetKit … RivetKit continues to own the
internal SQLite schema" ([workflows README][r-wf]). Idea, not dependency.

**sandbox-agent** ("Run Coding Agents in Sandboxes. Control Them Over HTTP") is
the closest sibling to Metistry's `targets/` dispatch, and is what agentOS
supersedes: no push since 2026-06-19, releases stalled at `v0.5.0-rc.3`
(2026-03-30).

**rivetkit-swift** is an actively pushed Swift client SDK with **no LICENSE
file** — 7 stars, no releases. Interesting only as evidence that Rivet is
courting native Mac/iOS clients. **dynamic-apps** ("deploy an AI-generated
backend for every user") is unlicensed and out of scope. `flue`, `codex` and
`pi-acp` are agent adapters that live better inside agentOS.

## Against Metistry

**(a) Confinement.** Different threat models, and it matters. agentOS confines
*untrusted code it expects to be hostile*, in-process, with a Rust kernel under
it. Metistry confines a *trusted-ish* engine and removes its capabilities
instead: no shell tool, no built-ins (`DISALLOWED` in `engine.ts`), one HTTP
MCP endpoint, plus `sandbox-exec` deny-default on the host. Metistry is
**stronger on the filesystem** — the engine cannot read the vault at all, not
even a read-only mount; knowledge arrives over HTTP (D5) — and stronger on
tool provenance, since every tool is a manifest a human wrote. agentOS is
**stronger on egress**: because all guest traffic crosses its socket table it
can allowlist by host, while `assistant.sb` filters by port and says so:

> sandbox-exec filters by port, not by hostname, so this reads as "outbound
> TLS" — the host allowlist itself is documentation … NOT enforced here, and
> not enforced anywhere else today. (`ops/sandbox/assistant.sb`)

That gap is portable to Mac-native with no container: put a **loopback CONNECT
proxy** in front, allow only `PROXY_TCP` in the profile, and enforce the
allowlist in ~100 lines of `node:net`. Also portable: their `{ default, rules }`
policy shape, which is the vocabulary `data_policy` will want when
`allow: [prefix]` stops being expressive enough.

**Contradiction to flag** (please rule): `assistant.sb`'s comment says the
allowlist "becomes enforceable by name" once the Mac app hosts the process
under App Sandbox. As far as I can establish, App Sandbox's network
entitlements (`network.client` / `network.server`) are all-or-nothing with no
per-host granularity — the promised enforcement does not exist at that layer,
which would make the proxy the actual path rather than a stopgap. I did not
verify this against Apple's current documentation; treat it as a claim to
check, not a finding.

**(b) Resource controls.** Metistry budgets **money before the call**
(`compute.yaml`, checked against the `spend` query, `action: allow|stop|
critical_only`). agentOS budgets **machine resources**, with three habits
Metistry lacks: warn at ~80% rather than only refuse at 100%; make every
refusal name the exact config field that would raise it; and audit in CI that
no limit-shaped constant exists that is not config-wired. All three are cheap
here, and are the same "enforce at the tool" instinct applied to limits.

**(c) Durable work.** Metistry's `work` rows with `FOR UPDATE SKIP LOCKED`,
leases, `attempts` and a `blocked` terminal state are simpler than replay and
already restart-safe. Their model buys mid-workflow resumption and costs a
second durable store plus a code-shape coupling they warn about themselves:
"Keep step names stable across code changes. Renaming a step breaks replay for
in-progress workflows" ([workflows][r-wfdoc]). For a solo maintainer that is a
worse trade than re-running a crew from the top. One convergence worth
recording: their rule is "create and close the session inside the step that
uses it — sessions are ephemeral and would not survive a replay", which is
exactly cost-research decision 3 (a crew run never resumes a session),
independently arrived at.

**(d) Lifecycle & multi-agent.** Their bindings are Metistry's mcp-brain: a
named host capability, credentials on the host, the agent sees inputs and
outputs only, gated per name by the `binding` scope the way a crew is gated by
`uses`. The convergence is strong enough to read as a check on the design.
Where they go further is a `binding`-scoped policy per VM; where Metistry goes
further is that the *brief* is policed (`checkBrief`, `scope ∩ allow`) — they
have no equivalent of a data policy on the work handed to a sub-agent. Their
sleep/wake (30 s idle → VM shutdown, lazy adapter restore) is a real capability
Metistry has no need for: one user, one always-on engine.

**(e) Observability.** `runs` rows (two-phase, cost, tokens, tools, component)
are richer per unit of work than their transcript, and are queryable by the
same named-query path as everything else. What they have and Metistry does not
is the *near-limit* signal — a structured, deduped "approaching capacity"
event, distinct from an alert that something already failed. The watchdog's
`hourlyCostUsd` runaway line is the closest thing, and it is a global
heuristic, not a per-budget one.

## Verdicts

**ADOPT** (each ≤3 lines; none needs a new dependency)

1. **Loopback egress allowlist.** A small CONNECT proxy on 127.0.0.1; the
   sandbox profile allows only that port instead of `*:443`; hosts come from
   `compute.yaml` providers + Anthropic. Turns invariant 8's "the network is
   not a boundary" from documentation into enforcement. *Unverified: that the
   Agent SDK's spawned CLI honours `HTTPS_PROXY`; check before scheduling.*
2. **Warn at 80% of every budget window.** Same `spend` query, one extra
   comparison, one deduped Needs You item before `action: stop` fires. Serves
   "enforce at the tool": a stop the user saw coming is a control, a surprise
   is an outage.
3. **Every refusal names the knob.** Budget stops, `checkBrief` violations and
   bridge errors already carry a reason; add the config field that would permit
   it (`budgets.instance.daily`, `data_policy.allow`). Serves invariant 8 — a
   boundary you can act on is a boundary you can test.
4. **CI audit for unwired limits.** A test that walks core's constants and
   fails on any cap-shaped literal not present in a manifest/config schema —
   the same instinct as the existing manifest validation. Serves invariant 5.
5. **stdout is the protocol.** Add a conformance test in `packages/core` that a
   stdio bridge emits nothing on stdout but framed protocol; logs go to stderr.
   Serves invariant 8's "misuse tests ship with the interface".

**BORROW-LATER**

6. **Silence-based liveness.** Their host declares a sidecar dead after 30 s
   with no inbound frames, heartbeat emitted from a dedicated thread, and
   deliberately gives individual requests no deadline because "an agent turn
   may legitimately run for many minutes". Metistry's `inflightRunMin` is the
   opposite bet and will eventually kill a long, legitimate turn. Worth
   revisiting when a turn first trips it — not before, since the fix costs a
   heartbeat column and the watchdog is deliberately hand-rolled.
7. **The `{ default, rules }` policy shape** for `data_policy` when prefixes
   stop being enough (ordered rules, last match wins, per-operation verbs).
8. **agentOS as a sandbox for untrusted code** — *if* Metistry ever grows a
   surface that runs code the user did not write (a generated collector, an
   "execute this snippet" tool). It would run Mac-native with no Docker: the
   sidecar is a prebuilt binary on npm
   (`@rivet-dev/agentos-sidecar-darwin-arm64@0.2.19`, `os: ["darwin"]`,
   `cpu: ["arm64"]`), spawned as a child over stdio, `AgentOs.create()` with no
   actors and no Rivet Cloud. Today Metistry runs no untrusted code, so the VM
   solves a problem it does not have.

**SKIP**

- **Depending on `@rivet-dev/agentos` now.** 0.2.x, and the docs open with "in
  beta and still undergoing security review". The darwin-arm64 sidecar unpacks
  to **132 MB**; the Mac app would have to ship, sign and notarize a
  third-party Rust binary it does not build, on top of the Node and TCC helpers
  it already signs. Dependency cost for one maintainer, for capability not
  currently needed.
- **RivetKit / Rivet Actors as the runtime.** It replaces launchd + the
  supervisor and brings a second durable store (per-actor SQLite) that Postgres
  already covers; conflicts with invariant 1 (git is the record, Postgres
  derived) and invariant 3 (one read path).
- **`@rivet-dev/workflows`.** Cannot be taken without RivetKit; replay
  semantics and step-name stability are a worse fit than SKIP LOCKED leases for
  work measured in single agent runs.
- **`sandbox-agent`, `rivetkit-swift`, `dynamic-apps`.** Stale, unlicensed, or
  both. `rivetkit-swift` having no LICENSE file makes it unusable regardless of
  merit.

## Decisions recorded

- The egress hole in `assistant.sb` is real and named in the file itself; the
  loopback proxy is proposed as its fix, pending the App Sandbox question
  above.
- Bindings ≡ mcp-brain, and "a sub-agent session is created and closed inside
  the unit of work" is now independently confirmed by a second system.
- Nothing here changes the plan: items 1–5 are small additions to existing
  mechanisms, and 6–8 are conditional.

## Sources

All fetched **2026-09-12**, from `main` (unpinned) unless noted.

- [r-readme] <https://github.com/rivet-dev/agentos> — README; Apache-2.0,
  4,618★, 385 commits, latest release `v0.2.19` (2026-09-02).
- [r-sec] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/security-model.mdx>
- [r-perm] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/permissions.mdx>
- [r-res] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/resource-limits.mdx>
- [r-lim] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/architecture/limits-and-observability.mdx>
- [r-persist] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/persistence.mdx>
- [r-wfdoc] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/workflows.mdx>
- [r-a2a] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/agent-to-agent.mdx>
- [r-emb] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/embedded.mdx>
- [r-vs] <https://github.com/rivet-dev/agentos/blob/main/docs/content/docs/versus-sandbox.mdx>
- [r-wf] <https://github.com/rivet-dev/workflows> — README, `v1.0.0`
  (2026-08-31).
- <https://github.com/rivet-dev/actors> — README, `rivetkit@2.3.17`.
- Stars, licences, pushed dates: GitHub API `orgs/rivet-dev/repos` and
  `repos/rivet-dev/{agentos,actors,workflows,sandbox-agent,rivetkit-swift}`.
- Package metadata: npm registry for `@rivet-dev/agentos`,
  `@rivet-dev/workflows`, `rivetkit`,
  `@rivet-dev/agentos-sidecar-darwin-arm64`.

Not fetched: the rendered docs at `agentos-sdk.dev` (the repo copies are the
same content), the `crates/` sources beyond their directory names, and the
`software` registry. No fetch failed.
