# Agent virtual filesystems on macOS — fit and recommendation (2026-09-19)

Research answering the owner's 2026-09-19 ask: *"agent filesystem tools that
create virtual filesystems to enable agents to have access to the right
resources, and actual files, in a safe and audited way … I'm not sure if it's
a good fit for us or if it will even work on Mac OS."* Nothing here is built;
this PR adds one document and no product code.

Sources are the projects' own repos and docs (fetched 2026-09-19, URL and
date on every claim), Apple's headers and man pages read **locally** from
this Studio's installed SDKs, and four read-only probes plus one `sandbox-exec`
experiment run on this machine — real output below. Repo claims cite the file.
Where a source could not be retrieved, or where a project's docs decline to
name their own mechanism, it says so rather than filling the gap.

## The short version

1. **This repo already runs the shape the research recommends.**
   `ops/sandbox/assistant.sb` (171 lines) confines the engine under
   `/usr/bin/sandbox-exec`, deny-default, parameters computed in
   `packages/cli/src/sandbox.ts` (217 lines), misuse tests in
   `packages/cli/test/sandbox.test.ts` (257 lines). The owner's question is
   half-answered by the repo: process confinement exists, is tested, and is
   the shape the whole industry converged on. What it does **not** cover is
   every process that is not the engine.
2. **Both serious agent vendors use the same primitive on macOS, and neither
   ships a virtual filesystem.** Anthropic's `sandbox-runtime` ("`sandbox-exec`
   on macOS, `bubblewrap` on Linux") and OpenAI's Codex ("Expects
   `/usr/bin/sandbox-exec` to be present") generate Seatbelt profiles at run
   time. Zero of the surveyed agent products mount anything on macOS.
3. **Seatbelt subtracts; it cannot project.** Proven on this Mac (§2.2): a
   denied path returns `EPERM`, never `ENOENT`, and `stat` on it still reports
   existence and size. A Seatbelt-confined agent always learns that a forbidden
   path *is there*. "The agent sees only the granted areas, and nothing else
   exists" is a sentence only a virtual filesystem can make true.
4. **The agent-VFS field is Linux-first and mostly cloud-first.** The one
   serious project by adoption — Turso's AgentFS, 3,412 stars, MIT — is a
   SQLite-backed filesystem that mounts "with FUSE on Linux and NFS on macOS":
   on a Mac it is a loopback network mount, not a kernel filesystem. Everything
   with real audit and snapshot guarantees (gVisor, Firecracker, bubblewrap)
   is a Linux kernel story with no macOS analogue.
5. **A kextless virtual filesystem on macOS is now genuinely possible** —
   FSKit since macOS 15.4, and macFUSE 5.4.0's FSKit backend (released
   2026-09-07) "entirely in user space on macOS 26". Apple's own `exfat`,
   `msdos` and `ftp` filesystems on this Mac are already FSKit app extensions.
   The cost is not technical: **every one of them needs the owner to toggle the
   extension on by hand in System Settings**, plus a second signed bundle in
   the release.
6. **Endpoint Security — syscall-level audit — is out for this product.**
   Locally sourced: `es_new_client` requires `com.apple.developer.endpoint-security.client`
   (a restricted entitlement Apple grants by application), *and* Full Disk
   Access, *and* root. Three doors a self-distributed open-source app does not
   have keys to.
7. **The `container` premise in the ask is off by one step.** `container` is
   not part of macOS 26: it is a separate Apache-2.0 download from
   `apple/container` whose installer wants an administrator password to write
   to `/usr/local`. It is absent from this Mac running 26.4.
8. **Recommendation: mostly Later, one small thing Now, and a firm No to
   projection.** Now: generalise the existing profile generator to a **second**
   child. The actual gap is not where the ask guesses — collectors are modules
   inside the console, not processes (§3.2c) — it is the **reconciler**, the
   sole committer, the one process that holds the vault's working tree and runs
   git, and the one with no boundary at all. No: a FUSE/FSKit projection of the
   vault; it duplicates a boundary the console already enforces and would be the first
   thing in this product that requires the owner's hand in System Settings
   *to make an existing guarantee weaker-looking*.

---

## 1. The survey

Four families, because they answer different questions. Only family D is what
the ask calls a "virtual filesystem"; families A and B are what the projects
that *say* they do this usually turn out to be.

### A. Process confinement shipped by agent vendors

This is the family that matters, because it is the one with macOS support and
production users.

| Project | Mechanism | What it gives | Platform | Maturity | Licence |
| --- | --- | --- | --- | --- | --- |
| **Anthropic `sandbox-runtime` (`srt`)** | "`sandbox-exec` on macOS, `bubblewrap` on Linux"; Windows runs the child under a dedicated local account with a Windows Filtering Platform egress fence | read deny-then-allow, write allow-only, **domain-level** egress via an HTTP + SOCKS5 proxy the profile is the only route to, Unix-socket rules, live violation tail from the macOS sandbox log | macOS, Linux, Windows | 5,276 ★, last push 2026-09-19; self-described "Beta Research Preview" | Apache-2.0 |
| **Claude Code's Bash sandbox** | the same, in-product: "On macOS, there is nothing to install: sandboxing uses the built-in Seatbelt framework." Linux/WSL2 need `bubblewrap` + `socat` + an optional seccomp filter | `sandbox.filesystem` allow/deny read and write with narrower-rule-wins precedence, `network.allowedDomains`, credential deny/mask | macOS, Linux, WSL2; "Native Windows is not supported" | shipping | proprietary |
| **OpenAI Codex CLI** | macOS: "Expects `/usr/bin/sandbox-exec` to be present", profile in `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`, explicitly "inspired by Chrome's sandbox policy". Linux: bubblewrap is now "the default filesystem sandbox"; the older Landlock path survives only where it is exactly equivalent | writable roots with `.git` and `.codex` held read-only inside them; network on/off by policy | macOS, Linux, WSL2, Windows | 125,299 ★, last push 2026-09-19 | Apache-2.0 |
| `can1357/isobox` | "one capability model compiled to Seatbelt (macOS), gVisor (Linux), and AppContainer (Windows)" | one config, three back ends | cross-platform | 25 ★ — a demonstration, not a dependency | MIT |
| `nolabs-ai/langchain-nono` | "Landlock (Linux) and Seatbelt (macOS)" | sandbox back end for LangChain deep agents | macOS, Linux | 10 ★ | Apache-2.0 |
| `michaelneale/agent-seatbelt-sandbox` | Seatbelt | "using native macos sandboxing to stop data egress" | macOS | 66 ★ | none declared |

**The load-bearing observation for this whole document is in the first three
rows.** Two organisations with more agent-sandboxing budget than this project
will ever have, solving exactly the stated problem — give an agent the right
files, safely, auditably — both chose `sandbox-exec` on macOS and neither
mounts anything. That is a strong prior against building a virtual filesystem.

Two details from `srt` are worth stealing regardless of what else is decided:

- **The egress answer.** "macOS: The Seatbelt profile allows communication only
  to a specific localhost port. The proxies listen on this port, creating a
  controlled channel for all network access." This is the missing half of
  `ops/sandbox/assistant.sb`'s stated limit — *"`sandbox-exec` cannot express
  `openrouter.ai`. The profile allows loopback to the console and TLS
  outbound; the host list … is documentation today, not an enforced rule"*
  (`docs/ops/deployment-shapes.md`). The profile cannot name a host, but it
  **can** be narrowed to a single loopback port, and the thing listening there
  can name hosts all day. That closes the gap **without** App Sandbox and
  without waiting for the Mac app to host the process.
- **The macOS/Linux asymmetry, admitted in Claude Code's own docs.** For
  credential masking: *"Linux and WSL2: sandboxed commands read a sentinel copy
  of the file … macOS: sandboxed commands can't read the listed file at all.
  Claude Code builds no sentinel copy and substitutes nothing on egress."*
  Linux can substitute a different view because it has bind mounts; macOS can
  only deny. This is the same limit as §2.2, met by someone else, in
  production, and conceded in their documentation.

### B. Linux OS primitives, and the tools over them

Listed for completeness and to say plainly: **none of this exists on macOS**,
and for Metistry it is reachable only inside a Linux guest (§2.7) or under the
`compose` shape, where the container is already the boundary.

| Project | Mechanism | What it gives | Platform | Maturity | Licence |
| --- | --- | --- | --- | --- | --- |
| **bubblewrap** | unprivileged user + mount namespaces; bind mounts compose an entirely new filesystem view | true **projection**: read-only binds, tmpfs overlays, a root the child cannot see past | Linux | 8,773 ★, the Flatpak substrate, push 2026-09-18 | LGPL-2.1 (`COPYING`) |
| **Landlock** | stackable LSM, unprivileged, per-thread rulesets | path-based allow rules, TCP/UDP connect and bind, IPC scoping, audit flags. "first introduced in Linux 5.13"; ABI 1–11 | Linux ≥ 5.13 | in-kernel | GPL-2.0 (kernel) |
| nsjail | namespaces + cgroups + rlimits + seccomp-bpf (Kafel) | fine-grained syscall policy | Linux | 4,116 ★ | Apache-2.0 |
| Firejail | namespaces + seccomp-bpf, setuid helper | per-application profiles | Linux | 7,653 ★ | GPL-2.0 |
| **gVisor** | a user-space kernel in Go: "intercepts application system calls and acts as the guest kernel, without the need for translation through virtualized hardware". Filesystem access is brokered by a separate **Gofer** process over 9P | the strongest syscall-level containment short of a VM, and a natural audit point | Linux (runsc/OCI) | 19,351 ★, push 2026-09-19 | Apache-2.0 |

Two facts here bear on the recommendation.

**Landlock is losing to bubblewrap for agent use, and the reason is instructive.**
Codex's own README: split filesystem policies "such as read-only or denied
carveouts under a broader writable root, automatically route through
bubblewrap. The legacy Landlock path is used only when the split filesystem
policy round-trips through the legacy `SandboxPolicy` model without changing
semantics." A pure allow-list LSM cannot express "writable, *except* this
subtree, *except* that child of it" — the shape every real grant model needs.
Seatbelt's SBPL **can** express it (it is an ordered rule language with
`deny`/`allow` and `require-all`), which is a point in macOS's favour that is
easy to miss.

**gVisor is the only thing in this survey that would give genuine syscall-level
audit**, and it is Linux-only by construction. There is no macOS equivalent
below Endpoint Security (§2.8), which this product cannot use.

### C. Hosted and VM sandboxes

The "Modal/E2B/Daytona-style" family from the ask. These are infrastructure
products: they answer "where does untrusted agent code run", not "what can an
agent on the owner's Mac see".

| Project | Mechanism | What it gives | Platform | Maturity | Licence |
| --- | --- | --- | --- | --- | --- |
| **E2B Runtime** | "Firecracker microVMs that resume from a snapshot". Memory served lazily via `userfaultfd`; root filesystem a "copy-on-write overlay over a read-only image" | pause/resume/fork of a whole machine — the strongest snapshot story in the survey | Linux hosts (cloud, or the single-machine `Embed` package) | 1,582 ★ on the runtime, 13,884 ★ on the SDK repo; push 2026-09-19 | Apache-2.0 |
| **Modal Sandboxes** | **not named in the public guide.** "secure containers for executing untrusted user or agent code" is as specific as it gets | volumes, filesystem snapshots, tunnels | Modal's cloud | commercial, mature | proprietary service |
| **Daytona** | "Secure and Elastic Infrastructure for Running AI-Generated Code" | elastic sandboxes for generated code | cloud | 71,746 ★ — by far the most-starred here; **GitHub reports no detected licence and `contents/LICENSE` is absent**, so treat licensing as unestablished | see previous cell |
| **Cloudflare Sandbox SDK** | containers behind Workers/Durable Objects; local development "Ensure Docker is running locally" | exec, file ops, background processes, exposed services from a Worker | Cloudflare's edge (+ Docker locally) | 1,133 ★, push 2026-09-19 | Apache-2.0 |
| microsandbox | "local-first microVM runtime and library" | microVM per session, on your own hardware | Linux (KVM) | 8,298 ★ | Apache-2.0 |
| **`apple/container`** | Linux containers as "lightweight virtual machines on a Mac", on Virtualization.framework, in Swift | a real Linux userland on Apple silicon, so every family-B primitive becomes reachable | **Apple silicon + macOS 26 only** | 50,067 ★, push 2026-09-18 | Apache-2.0 |

None of family C fits Metistry as stated. Invariant 7 is cloud-portable *by
construction*, not cloud-*hosted*; the whole strategy is a self-contained Mac
app distributed through GitHub Releases. Shipping a Firecracker or a Worker is
a different product. `apple/container` is the one row that could matter, and
§2.7 explains why it still does not.

### D. Actual virtual filesystems for agents

This is what the ask is literally about. The field is thin, young, and
Linux-shaped.

| Project | Mechanism | What it gives | Platform | Maturity | Licence |
| --- | --- | --- | --- | --- | --- |
| **Turso AgentFS** | a filesystem **inside a SQLite database**; the CLI can "Mount AgentFS on host filesystem with FUSE on Linux and NFS on macOS" | the survey's best audit and snapshot story, and it is not at syscall level — it is *inside the store*: "Every file operation, tool call, and state change is recorded in a SQLite database file. Query your agent's complete history with SQL"; snapshot is `cp agent.db snapshot.db`; a timeline of tool calls; TS/Python/Rust SDKs | Linux (FUSE), macOS (NFS loopback) | 3,412 ★, created 2025-10-24, last push 2026-06-03. **README: "This software is in BETA"** | MIT |
| `run-llama/agentfs-claude` | AgentFS + LlamaIndex Workflows, running Claude Code/Codex inside it | an integration, not a mechanism | follows AgentFS | 325 ★ | MIT |
| `coplane/localsandbox` | "Lightweight AgentFS sandbox that runs bash and python" | as above | as above | 158 ★ | none declared |
| `IceWhaleTech/ToolFS` | "A FUSE virtual filesystem for AI Agents, integrating memory, RAG & local data access with flexible MCP/tool chaining" | the closest thing to "MCP as a filesystem" | FUSE — Linux | 28 ★ | MIT |
| `neul-labs/agentvfs` | "execution boundary for AI agents" | userspace VFS in the agent's runtime | library-level | 4 ★ | MIT |
| in-runtime VFS shims (`asdtransport/openfs`, `FastAISandbox`, …) | a fake `fs` module inside the agent's own process | convenience, **not a boundary** — the process can still call the real syscalls | anywhere | ≤ 1 ★ | mixed |

**Two things to take from family D.**

First, **AgentFS's audit and snapshot properties come from SQLite, not from
the filesystem.** The mount is an export surface; the guarantees live in the
database. That matters here, because Metistry's equivalent guarantees already
live somewhere: git is the record (invariant 1), the reconciler is the sole
committer (D5), and `git log` is a better audit trail for a knowledge vault
than a SQLite table — it is the thing the owner can read, revert and push.
Adopting AgentFS would mean adopting a *second* record of truth beside git, in
direct tension with invariant 1.

Second, **the last row is the trap.** A large share of things calling
themselves an "agent virtual filesystem" are a `fs`-shaped object handed to the
model's tool loop inside the agent's own process. That is a prompt-level
control wearing a filesystem costume, and `CLAUDE.md`'s governing principle
rules on it directly: *"enforce at the tool, never by prompting … If policy
forbids something, the tool must be incapable of it."* An in-process VFS that
the process can bypass with `open(2)` is incapable of nothing.

---

## 2. macOS reality

### 2.1 What this machine actually has (read-only probes, 2026-09-19)

```
$ sw_vers
ProductName:            macOS
ProductVersion:         26.4
BuildVersion:           25E246

$ which sandbox-exec
/usr/bin/sandbox-exec

$ ls /System/Library/Sandbox/Profiles | wc -l
     510

$ ls -d /System/Library/Frameworks/FSKit.framework
/System/Library/Frameworks/FSKit.framework

$ ls -d /System/Library/Frameworks/Virtualization.framework
/System/Library/Frameworks/Virtualization.framework

$ ls -d /System/Library/Frameworks/EndpointSecurity.framework
ls: /System/Library/Frameworks/EndpointSecurity.framework: No such file or directory

$ which container
container not found

$ kmutil showloaded --list-only | grep -i fuse   →  no match  (264 kexts loaded)
$ ls -d /Library/Frameworks/macFUSE.framework    →  No such file or directory
$ ls /Library/Filesystems                        →  NetFSPlugins   (nothing third-party)
```

Reading it:

- **`sandbox-exec` is present and Apple depends on it heavily.** 510 profiles
  ship in `/System/Library/Sandbox/Profiles`, including `application.sb`,
  `appsandbox-common.sb` and per-daemon profiles for hundreds of Apple
  services. The man page's `(DEPRECATED)` banner is about the *public API for
  third-party apps*, not about the facility.
- **No FUSE of any kind on this Mac** — no kext, no macFUSE framework, no
  `fuse-t`, no third-party bundle in `/Library/Filesystems`. Anything in
  family D would be a from-zero install on the owner's machine.
- **FSKit is present, and is already how Apple ships filesystems.**
  `/System/Library/Filesystems` lists `virtiofs.fs` among the built-ins, and
  the registered FSKit modules are ordinary app extensions:

```
$ pluginkit -m -p com.apple.fskit.fsmodule -v
  com.apple.fskit.ftp    /System/Library/ExtensionKit/Extensions/com.apple.fskit.ftp.appex
  com.apple.fskit.exfat  /System/Library/ExtensionKit/Extensions/com.apple.fskit.exfat.appex
  com.apple.fskit.msdos  /System/Library/ExtensionKit/Extensions/com.apple.fskit.msdos.appex
 (3 plug-ins)
```

  `ftp` being FSKit-backed is the interesting one: it proves the shipping OS
  already has a **network-backed, no-block-device** FSKit filesystem, which is
  precisely the shape a vault projection would need.

- **`systemextensionsctl list`** shows exactly one system extension on this
  Mac — Tailscale's network extension — with the note "Go to 'System Settings >
  General > Login Items & Extensions > Network Extensions' to modify". That
  is the same pane, and the same hand-toggle, an FSKit module would land in.

### 2.2 The experiment: what a Seatbelt profile can and cannot say

Run on this Mac, read-only, against a throwaway tree in the session scratchpad
shaped like a vault (`vault/Areas/ok.md` granted, `vault/Me/secret.md` not).
Profile: `(deny default)`, `(import "system.sb")`, exec and read on `/bin`,
`/usr/bin`, `/usr/lib`, `/System`, `(allow file-read-metadata)`, and
`(allow file-read* (subpath (param "GRANT")))` with `GRANT=…/vault/Areas`.

```
--- 1. granted subtree is readable ---
granted area note
--- 2. sibling inside the vault is NOT ---
cat: …/vault/Me/secret.md: Operation not permitted
--- 3. ls of the vault root ---
ls: …/vault: Operation not permitted
--- 4. stat of the denied file ---
…/vault/Me/secret.md size=16
--- 5. ls INSIDE the denied dir ---
ls: …/vault/Me: Operation not permitted
--- 6. can a sandboxed process re-sandbox itself LOOSER and escape? ---
sandbox-exec: sandbox_apply: Operation not permitted
--- 7. write anywhere? ---
touch: …/vault/Areas/new.md: Operation not permitted
```

Six findings, all of them load-bearing:

1. **A subtree grant works, exactly.** Line 1 vs line 2: one directory
   readable, its sibling not, with no code between the agent and the kernel.
2. **`EPERM`, never `ENOENT`.** Line 4 is the important one. `stat` on the
   denied file succeeded and returned its real size — because
   `file-read-metadata` was allowed globally, which `ops/sandbox/assistant.sb`
   also does, with the honest comment *"Metadata is existence and size, never
   content."* **Seatbelt hides contents; it does not hide existence.**
3. **Narrowing metadata costs more than it buys.** A second profile scoping
   `file-read-metadata` to `(path-ancestors (param "GRANT"))` still returned
   `Operation not permitted` (not `ENOENT`) for the denied file, *and* broke
   `cat` outright — `cat: stdout: Operation not permitted`, because it could
   no longer `fstat` its own pipe. There is no setting that converts Seatbelt
   into a namespace.
4. **The parent of a grant is not enumerable** (lines 3 and 5). An agent given
   `Areas/Engineering` cannot `ls` the vault root to discover what else is
   there. That is *better* than the projection story assumes, and it means the
   "existence leak" of finding 2 requires the agent to already know the path.
5. **Nesting cannot loosen — or tighten.** Line 6 is the misuse test that
   matters: a confined process running `sandbox-exec -p '(allow default)'`
   gets `sandbox_apply: Operation not permitted`. The same happens for a
   *tighter* nested profile, so the rule is simply "one profile per process
   tree, applied at the root, inherited by every child" — which matches
   `sandbox(7)`: *"New processes inherit the sandbox of their parent."* An
   agent cannot escape its own confinement by re-exec'ing itself.
6. **Write denial is absolute** (line 7), including inside a read-granted
   subtree. Read and write are separate rules, so a read-only projection of the
   vault is expressible as a profile, not only as a mount.

`sandbox(7)` also names the one structural hole, and it applies to every
mechanism in this document: *"Restrictions are generally enforced upon
acquisition of operating system resources only … if the application already has
a file descriptor opened for writing, it may use that file descriptor
regardless of restrictions."* Confine at spawn, never mid-flight.

### 2.3 The deprecation question, answered

`man sandbox-exec` on this Mac:

```
NAME
     sandbox-exec - execute within a sandbox (DEPRECATED)

DESCRIPTION
     The sandbox-exec command is DEPRECATED.  Developers who wish to sandbox
     an app should instead adopt the App Sandbox feature described in the App
     Sandbox Design Guide.
```

and `<SDK>/usr/include/sandbox.h`: `API_DEPRECATED("No longer supported",
macos(10.5, 10.8))` on `sandbox_init` and every `kSBXProfile*` constant.

Both statements are true and neither is the whole picture:

- The deprecated thing is the **C API and its handful of named profiles**
  (`kSBXProfileNoInternet` and friends) — deprecated since 10.8, fourteen
  years ago, and not what anyone uses.
- The `-f profile-file` / `-p profile-string` **SBPL path is what Apple itself
  runs 510 profiles through**, what Chrome's renderer sandbox uses (Codex's
  profile cites Chrome's `common.sb` and `renderer.sb` by source URL), what
  Claude Code calls "the built-in Seatbelt framework", and what this repo has
  been running the engine under since PR #117.
- The man page is dated **March 9 2017** and `sandbox(7)` **January 29 2010**.
  Nine and sixteen years of "deprecated and shipping".

`ops/sandbox/assistant.sb` already states the position correctly and this
research does not change it: *"a deliberate stopgap … verified on macOS 26.4;
the same profile shape has worked since 14"*. The one correction this survey
suggests is to the **migration path**: the profile and `docs/ops/deployment-shapes.md`
both say App Sandbox entitlements will close the host-allowlist gap. §2.4 says
why that is a bigger step than it reads, and §1.A says the gap can be closed
today with a loopback proxy instead.

### 2.4 App Sandbox — the supported API, and what it costs

App Sandbox is entitlement-based confinement applied to a **signed bundle** at
launch. It is the thing Apple's man page points at, and it is the right
long-term home for a Mac app. Two honest caveats before it is treated as the
answer:

- **It is a property of a bundle, not of a spawn.** A parent cannot compute a
  profile per child from that child's grants; entitlements are baked into the
  signature. Confining *the engine* with a fixed entitlement set is natural;
  confining *this external agent, to these areas, for this session* is not
  something entitlements express. Seatbelt's `-D KEY=VALUE` parameters are
  precisely what App Sandbox lacks — and are what
  `packages/cli/src/sandbox.ts` is built around.
- **Its file grants are user-intent-shaped.** Powerbox, security-scoped
  bookmarks, `com.apple.security.files.user-selected.read-only`. A grant model
  driven by `--areas Areas/Engineering` from a CLI verb does not map onto "the
  user picked this in an open panel" without the user picking it.

So App Sandbox closes the *host allowlist* gap (network entitlements can name
hosts) at the cost of the *dynamic grant* capability. That trade is worth
naming in the plan; it is currently written as a pure upgrade.

### 2.5 TCC

Unchanged by this research and mentioned only to place it: TCC gates
`~/Documents`, `~/Desktop`, `~/Downloads`, the camera, the microphone,
Contacts, Calendar and the rest, per-app, by user prompt. Invariant 6 already
says what to do about it — `runs_on: host` and Swift bridges for TCC-bound
components.

One TCC fact **does** bear on a projection, and it is a hard edge:
`sohonetlabs/testfs`, a shipping FSKit module, documents that mount points
under the privacy-protected directories fail — *"Avoid Desktop / Documents /
Downloads / iCloud Drive / Pictures / Movies / Music — macOS won't let `fskitd`
write to those, and the mount will fail with Operation not permitted."*
A projection of the vault therefore cannot be mounted anywhere the owner
naturally keeps things; it lands in `/tmp` or a bare subdirectory of `~`.

### 2.6 FSKit and macFUSE — a virtual filesystem *is* now possible without a kext

This is where the ask's premise turns out to be more right than expected, and
the finding deserves to survive the "no" recommendation.

**FSKit, from the installed SDK** (`MacOSX26.5.sdk/…/FSKit.framework/Headers`):

- `FSKitDefines.h`: `FSKIT_API_AVAILABILITY_V1` is `API_AVAILABLE(macos(15.4))`;
  V2 is `macos(26.0)`; V2_4 is `macos(26.4)`. **macOS 15.4 is the floor.**
- `FSFileSystem.h`: *"The current version of FSKit supports only
  `FSUnaryFileSystem`, not `FSFileSystem`."* One resource, one volume.
- `FSUnaryFileSystem.h`: you *"Implement your app extension by providing a
  subclass"* — so a module is an **app extension in an app bundle**, not a
  daemon and not a kext.
- `FSResource.h` is the decisive header. V1's resource is
  `FSBlockDeviceResource` — a disk partition — which is why V1 implementations
  attach a dummy disk image to mount something synthetic. **V2 (macOS 26.0)
  adds `FSPathURLResource`** — *"A URL in the system file space that represents
  the contents of a file system … `writable`: whether the file system supports
  writing"*, and it *"may be a security-scoped URL … FSKit transports it intact
  from a client application to your extension"* — **and `FSGenericURLResource`**,
  *"a completely abstract resource. The only reference to its contents is a
  single URL, the contents of which are arbitrary."*

`FSPathURLResource(url: vaultDir, writable: false)` is, almost word for word,
"a read-only projection of a directory, handed to a filesystem module, carrying
a security-scoped grant". Apple built the exact primitive shape (a) wants, and
shipped it in macOS 26.

**That it is buildable today, by a small team, is established by example.**
`sohonetlabs/testfs`: *"A read-only synthetic filesystem for macOS, built on
FSKit … Native Swift, no kernel extension, no `fuse-t` shim. macOS 15.4 or
later."* Distributed as a Developer ID–signed, notarized DMG with Sparkle
auto-update — the same distribution shape as Metistry's Mac app.

**And the cost is documented by the same project**, in its own install
instructions: *"The first time, a banner asks you to enable the FSKit
extension — click Open System Settings…, then toggle TestFS on under General →
Login Items & Extensions → File System Extensions."* Plus: run as the normal
user, **not** `sudo` (*"`fskitd` checks the caller's audit token uid against the
dev node's owner"*), and stay out of the TCC-protected directories (§2.5).

**macFUSE** has moved the same way. macFUSE 5.4.0, released **2026-09-07**,
ships an `FSModule` (FSKit) backend alongside the kernel backend; the project
page says the FSKit path runs *"entirely in user space on macOS 26"* and that
users no longer need to *"reboot into recovery mode to enable support for the
macFUSE kernel extension."* **Its licence is the blocker, not its mechanism:**
macFUSE is BSD-3-clause **plus a fourth clause** — *"Redistributions in binary
form, bundled with commercial software, are not allowed without specific prior
written permission. This includes the automated download or installation or
both of the binary form in the context of commercial software."* Metistry is
fully open source with no premium or hosted tier, so "commercial software" is
arguably inapplicable; "arguably" is not a licence review, and GitHub's
licence detector returns `NOASSERTION`. Flagged as an open question, not a
conclusion.

**`fuse-t`** (1,597 ★) is the third path: *"a kext-less implementation of FUSE
for macOS that uses NFS v4 local server instead of a kernel extension … SMB3
protocol support … FSKit for macOS 26+"*. Its licence is explicitly
*"Free for non-commercial use"* with *"For commercial use or/and bundling with
commercial software the software vendor has to obtain a commercial license"* —
the same question, sharper. This is also the mechanism behind Turso AgentFS's
macOS story ("NFS on macOS"): **a loopback NFS server that macOS mounts as a
network volume.** Worth knowing that this path needs no framework at all — a
localhost NFS or SMB server plus `mount_nfs` is a projection, using only
built-ins.

### 2.7 Virtualization.framework, virtiofs, and `apple/container`

`Virtualization.framework` is present on this Mac and needs no kext and no
root — the entitlement (`com.apple.security.virtualization`) is one a Developer
ID app can request. `virtiofs.fs` is in `/System/Library/Filesystems`, so
directory sharing into a Linux guest is a built-in.

**The correction to the ask:** `container` is *not* shipped in macOS 26.
`apple/container`'s README: *"You need a Mac with Apple silicon … `container`
is supported on macOS 26 … Download the latest signed installer package …
Enter your administrator password when prompted, to give the installer
permission to place the installed files under `/usr/local`."* Confirmed here:
`which container` → not found, on 26.4.

So the Linux-guest route means: Apple silicon only, macOS 26 only, an
administrator password, a second background service (`container system start`),
and a VM's worth of RAM — in exchange for every family-B primitive. Against
decision #15, which exists specifically to get this product **off** a
Docker-shaped dependency and which is recorded as *proven* in
`docs/ops/deployment-shapes.md`, that is a step backwards wearing Apple's logo.

### 2.8 Endpoint Security — the audit answer, and why it is closed

The ask asks about syscall-level audit. On macOS that means Endpoint Security,
and the local headers close the question. From
`<Xcode SDK>/usr/include/EndpointSecurity/`:

- `ESClient.h`, on `es_new_client`: *"Callers are required to be entitled with
  `com.apple.developer.endpoint-security.client`."*
- and, a few lines later: *"The only supported way to check if an application
  is properly TCC authorized for Full Disk Access is to call `es_new_client`
  and handling `ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED`."*
- `ESTypes.h` enumerates the three refusals precisely: `ERR_NOT_ENTITLED`
  ("The caller is not properly entitled to connect"), `ERR_NOT_PERMITTED`
  ("lacks Transparency, Consent, and Control (TCC) approval from the user"),
  `ERR_NOT_PRIVILEGED` ("The caller is not running as root").

Three doors: a **restricted entitlement Apple grants by application**, a Full
Disk Access grant from the owner, and root. `EndpointSecurity(7)` adds that a
real ES client is normally *a system extension* with its own `Info.plist` keys
and an XPC mach service. That is an enterprise-security-vendor shape. It is
not available to a self-distributed open-source app, and pursuing it would
contradict invariant 8's premise that security survives full code visibility —
ES's whole distribution model is gated on Apple's private judgement of the
vendor.

**Conclusion: syscall-level audit is not reachable on macOS for this product.
Tool-level audit is what there is.** Which, as §3 argues, is the level at
which this product's audit is actually meaningful.

### 2.9 What a notarized, self-contained Mac app can use — the summary table

No kext, no root, no MDM, distributed by GitHub Releases.

| Primitive | Usable? | What it costs the owner | Fit |
| --- | --- | --- | --- |
| **`sandbox-exec` + SBPL profile** | **yes, today** | nothing: no prompt, no approval, no privilege | **in use** (`ops/sandbox/assistant.sb`) |
| Loopback proxy + a one-port Seatbelt rule | **yes, today** | nothing | closes the named egress gap without App Sandbox |
| App Sandbox entitlements | yes, on a bundled helper | nothing, but grants become user-intent-shaped | the engine's long-term home; **not** per-spawn grants (§2.4) |
| TCC-bound reads (Documents, etc.) | yes, with a prompt | one approval per surface | invariant 6's existing rule |
| **FSKit module (15.4+ / 26.0+ for URL resources)** | **yes** | **a hand-toggle in System Settings → General → Login Items & Extensions → File System Extensions**, per install | possible; §3 argues it is not warranted |
| Loopback NFS/SMB server + `mount_nfs` | yes | nothing, if self-hosted | the no-framework projection; niche |
| macFUSE (FSKit backend, 5.4.0) | technically yes on macOS 26 | an extra install + toggle | **licence clause 4** is the obstacle |
| `fuse-t` | technically yes | an extra install | explicitly non-commercial-only licence |
| macFUSE **kext** backend | effectively no | reduced-security reboot on Apple silicon | ruled out |
| Virtualization.framework VM + virtiofs | yes | a VM's memory; a large amount of new code | large; reintroduces what #15 removed |
| `apple/container` | yes, as a prerequisite | **admin password**, Apple silicon, macOS 26, a second service | contradicts decision #15 |
| **Endpoint Security** | **no** | restricted entitlement + FDA + root | closed (§2.8) |

---

## 3. Fit for Metistry

### 3.1 What is already mediated, and by what

The owner's framing is right and worth restating precisely, because it is what
most of the survey duplicates:

- **The engine has no shell and no raw git** (invariant 9). `brain-commit`
  plus allowlisted bridges are its entire mutating and outbound surface.
- **The reconciler is the sole committer** (D5). Nothing else writes the vault.
- **Knowledge never reaches the engine through the filesystem.** From
  `docs/ops/assistant-tools.md`: *"knowledge reaches the engine through the
  brain bridge over HTTP or not at all (D5)"* — and the profile enforces it,
  granting exactly four config files **by literal path** and refusing the
  directory that holds them, with a misuse test proving a note beside them is
  denied.
- **External agents already have scoped, revocable, default-deny access.**
  `metistry connect <cursor|opencode|devin|claude-code>`: one row and one
  bearer per tool, independently revocable; *"Grants are the console's and
  start default-deny (`{tier: "none", areas: []}`)"*; `--areas` widens reads to
  TitleCase vault-root prefixes; **"No flag grants `knowledge_write`: an
  `external` principal cannot reach it at the bridge at all, so 'read-only by
  default' is true by construction rather than by configuration"**; `--remote`
  rows start inert behind a Needs You approval (`docs/ops/cli.md` §*Connecting
  an external dev tool*).
- **The console's mutating surface is a closed enumerated set** (invariant 10).
- **Under `compose`, the container is already the boundary**; under `launchd`,
  `assistant.sb` is.

That is a per-principal, default-deny, area-scoped, revocable, audited grant
model. A filesystem projection would re-implement about 80% of it, one layer
lower, with worse revocation (a mount is not a bearer token) and no principal
identity (a filesystem cannot tell Cursor from Devin).

### 3.2 What a virtual filesystem would genuinely ADD

Four candidates from the ask. Honest verdicts.

**(a) External agents that need real file paths.** Real, but small and
shrinking. Cursor, Devin, Claude Code and OpenCode all speak MCP, and
`metistry connect` already points them at `/mcp` with a scoped bearer. The
residual case is a tool that *only* reads files — and for that case, a
projection is a large amount of machinery for a tool that has not appeared yet.
**Verdict: speculative.** Revisit if a specific tool arrives that cannot speak
MCP; name it in the PR that proposes the mount.

**(b) Sandboxed code-mode scripts.** The parallel research doc
`docs/research/2026-09-19-code-mode-mcp.md` **is not in the repo at the time of
writing** — not on `main`, and no open PR carries it (checked 2026-09-19), so
this section cannot cite it and does not pretend to. What can be said from this
side: OpenAI's Codex has shipped `code-mode`, `code-mode-host`,
`code-mode-runtime` and `code-mode-protocol` crates, so the pattern is real and
in production somewhere. If Metistry ever runs generated code, **that** is the
case with a genuine appetite for confinement — and it is a `sandbox-exec`
case, not a mount case: the script needs a writable scratch directory and
nothing else, which is a profile, not a filesystem. **Verdict: the strongest
future driver, and it still points at shape (b).** This document should be
re-read against the code-mode doc when that lands.

**(c) Running other components at least privilege.** **This is the real gap,
and it is the one thing in this document that is true today** — but not where
the ask guesses, and the correction matters.

**Collectors and routines are not separate processes.** `collectors/index.ts`
opens: *"Collector registry, consumed by the console's routine runner"*, and
the six collectors are imported modules, not children. They inherit the
console's authority because they *are* the console. Confining them
individually is not a profile question at all; it would be an in-process
question, which §1.D rules is not a boundary.

What *is* a separate, unconfined host process, from `supervisor.json`'s
`children` (`docs/ops/deployment-shapes.md`) and the four manifests:

| Child | `runs_on` | Confined today? | Verdict as a target |
| --- | --- | --- | --- |
| `assistant` | host | **yes** — `sandbox-exec -f assistant.sb` | done |
| **`reconciler`** | `host` | **no** | **the best target in the repo.** Its manifest: *"Sole committer of the instance repo + the vault bridge (D5) … The only process that holds the working tree and the only place git runs."* A profile turns D5's scope from a design intention into something the kernel enforces |
| **`mcp-apple-fm`** | `host`, **`requires_tcc: []`** | no | the cleanest *small* target: a host bridge child, two tools, on-device models, **no TCC entanglement** |
| `mcp-eventkit` | `host`, `requires_tcc: [calendars, reminders]` | no | **exclude.** Its own manifest says *"its own launchd service is its own responsible process (PoC-1)"*, and `supervisor.ts` says *"a TCC grant attaches to the binary that asks (invariant 6)"*. Interposing `sandbox-exec` changes which binary asks. Not to be attempted without a TCC experiment of its own |
| `console` | container-shaped, a child under `launchd` | no | **defer.** It holds the DB pool, `/mcp`, the routine runner, every collector and the whole grant model. Confining it is a design decision, not an experiment |
| `db` (Postgres) | host | no | out of scope |

None of this needs a mount. It needs the existing generator to take a
component's shape as input instead of only the engine's.
**Verdict: genuinely additive, cheap, and shape (b) — on the reconciler and
the non-TCC host bridges, not on collectors.**

**(d) Syscall-level audit instead of tool-level.** Not reachable (§2.8), and on
reflection not wanted. Metistry's audit unit is *a commit by the reconciler
with a reason*, not *an `openat(2)`*. Invariant 1 makes git the record; a
syscall log would be a second, unreviewable record that the owner cannot read,
revert or push — and would sit in exactly the tension with invariant 1 that
AgentFS's SQLite store does (§1.D). **Verdict: no.**

### 3.3 Shape (a) or shape (b), judged by the invariants

The ask poses this precisely: a read-only scoped **projection** exported to an
agent's sandbox, or the agent's own process run under a **profile** that allows
only the granted areas.

| | (a) projection — FUSE / FSKit / virtiofs | (b) confinement — Seatbelt profile from grants |
| --- | --- | --- |
| Where policy lives | in a filesystem server the product writes and must keep correct on every path, symlink, `..`, rename and xattr | in an SBPL profile the **kernel** evaluates |
| "Enforce at the tool" | the mount *is* a tool, but a large new one whose bugs are silent widenings | the tool is `/usr/bin/sandbox-exec`, already present, already trusted by Apple, Chrome, Claude Code and Codex |
| Invariant 8 — misuse tests ship with the interface | testable, but the surface is the whole POSIX API: every test is a sample of an infinite space | **the misuse tests already exist and already pass** (`packages/cli/test/sandbox.test.ts` launches a probe under the *real* profile with the *real* parameters and proves five denials) |
| Invariant 6 — native only where macOS requires it | forces Swift + an app extension + a second signed bundle | no native code at all; the existing parameters are computed in TypeScript |
| Owner's hand | **a System Settings toggle, per install** (§2.6) | none — no prompt, no approval, no privilege |
| Invariant 7 — cloud-portable | a macOS-only mount with no Linux twin that behaves identically | profile on darwin, container under `compose`, and the *same* grant model computes both |
| Hides existence of non-granted paths | **yes** — its one real advantage (§2.2 finding 2) | no: `EPERM`, and `stat` still leaks size |
| Failure mode | mount fails → agent sees an empty or stale tree and proceeds confidently | profile fails → process refuses to start, loudly |
| Revocation | unmount, and hope nothing holds a descriptor | revoke the bearer; the next spawn gets a new profile |

**Shape (b) wins on every criterion this repo has written down**, and loses on
one it has not: hiding existence. And finding 4 of §2.2 blunts even that — the
parent directory of a grant is not enumerable, so the existence leak needs the
agent to already know the exact path. For a knowledge vault whose top-level
names are `Journal/`, `Areas/`, `Me/` — guessable anyway — learning that
`Me/` exists and is forbidden is not a meaningful disclosure. Learning what is
*in* it would be, and Seatbelt prevents that absolutely.

There is also a plainer argument. `CLAUDE.md`: *"enforce at the tool, never by
prompting … the tool must be incapable of it."* A Seatbelt profile makes the
process **incapable** — the kernel refuses. A projection makes the process
*unable to find* things, which is a weaker claim, and one that depends on a
filesystem server this project would maintain alone, for years, with one
person. Every path-handling bug in it is a silent widening. That is precisely
the dependency calculus `CLAUDE.md` asks to apply before adding anything.

---

## 4. Recommendation

### 4.1 Now / Later / No

| | Item | Why |
| --- | --- | --- |
| **Now (S/M)** | **Generalise the profile generator to a second child: `ops/sandbox/reconciler.sb`.** `packages/cli/src/sandbox.ts` already computes parameters, renders argv as an array (never a shell string), and is proven by misuse tests. Make the inputs come from a component's shape instead of only the engine's. | §3.2(c): the reconciler is the sole committer and the only place git runs, and nothing stops it touching the rest of the disk. 645 lines of the answer are already in the repo. |
| **Now (XS)** | **Correct the migration-path sentence** in `ops/sandbox/assistant.sb` and `docs/ops/deployment-shapes.md` §*Two honest limits*: App Sandbox buys host-name egress but **costs** per-spawn parameterised grants (§2.4). Today it reads as a pure upgrade. | A contradiction found by this research; one paragraph. |
| **Later (M)** | **Close the egress hole with a loopback proxy**, `srt`-style: narrow the profile's `(remote tcp "*:443")` to one loopback port and put a host-checking proxy on it. Turns `engineHosts` from documentation into enforcement. | Requires a decision about a new always-on loopback listener; not this PR's call. |
| **Later (S)** | **Re-read this document against the code-mode research** when it lands. If Metistry ever runs generated code, that is the case with real appetite for confinement — and §3.2(b) argues it still points at shape (b). | The doc is not in the repo yet; this is the honest dependency. |
| **No** | **A FUSE/macFUSE/`fuse-t` projection of the vault.** | Licence clause 4 (macFUSE) / explicitly non-commercial (`fuse-t`); an extra install; and it duplicates the console's grant model (§3.1). |
| **No** | **Adopting an agent-FS runtime (AgentFS et al.) as the store.** | Its audit and snapshot guarantees live in SQLite, which would be a second record of truth beside git — invariant 1. BETA, by its own README. |
| **No** | **`apple/container` / a Linux guest as a dependency.** | Admin password, Apple silicon + macOS 26 only, a second background service; reintroduces exactly what decision #15 removed. |
| **No** | **Endpoint Security for syscall audit.** | Restricted entitlement + FDA + root (§2.8). Unreachable, and the wrong audit unit (§3.2(d)). |
| **Not yet** | **An FSKit projection of the vault.** Genuinely buildable (§2.6) and the only thing that hides existence. Parked until a named external tool needs real paths and cannot speak MCP. | It costs a System Settings toggle per install, a second signed bundle, and a Swift filesystem this project maintains alone. No current requirement justifies that. |

### 4.2 The smallest experiment worth running

**One profile for the reconciler, and the misuse tests that prove it.** Roughly
one focused day, most of it tests.

| Piece | Where | Size |
| --- | --- | --- |
| `ops/sandbox/reconciler.sb` — deny-default; `(import "system.sb")`; read `PRODUCT_DIR` + `NODE_PREFIX`; **read+write exactly `INSTANCE_DIR`** and `TMP_DIR`; exec only `NODE_BIN`, the node prefix and `GIT_BIN`; outbound `CONSOLE_TCP`, `DB_TCP` and TLS (the git remote) | `ops/sandbox/` | ~80 lines, much of it the same base as `assistant.sb` |
| `reconcilerSandboxParams()` beside `sandboxParams()`, reusing `realPathish`, `nodePrefixFor`, `tmpDirOf` unchanged | `packages/cli/src/sandbox.ts` | ~45 lines |
| Wire it where the engine is wired — `packages/cli/src/up.ts:275` (`plistValuesFor`, `case "assistant"`) is the existing call site and gains a `case "reconciler"` | `packages/cli/src/up.ts` | ~20 lines |
| **Misuse tests, the same method as the existing ones**: launch a probe under the real profile with the real parameters and prove it *cannot* read or write `~/Documents`-shaped paths outside the instance directory, *cannot* exec a shell, *can* write inside the instance directory, and *can* reach the console | `packages/cli/test/sandbox.test.ts` or a sibling | ~100 lines |
| A `docs/product/record/` fragment — a safety mechanism shipped, which `CLAUDE.md` asks for | `docs/product/record/` | ~15 lines |

**Why this one.** It needs no decision from the owner, no new dependency, no
native code, no migration, and no prompt on any Mac. It makes D5 —
*the sole committer* — a thing the kernel enforces rather than a thing the
design intends, which is `CLAUDE.md`'s governing principle applied to the one
process that holds the vault's working tree. And it proves the generator can
serve a second shape, which is the prerequisite for every "Later" row.

**Two things to settle inside the experiment rather than before it.**

1. **How git is exec'd.** `apps/reconciler/src/git.ts` calls
   `execFile("git", …)` — resolved from `PATH`, so the profile needs a literal.
   On this Mac `/usr/bin/git` is a real universal Mach-O (`git version 2.50.1
   (Apple Git-155)`), not a shell shim, so one `(allow process-exec* (literal
   "/usr/bin/git"))` may be the whole answer — but `xcrun --find git` resolves
   to `/Applications/Xcode.app/…/usr/bin/git`, and on a Mac with neither Xcode
   nor the Command Line Tools `/usr/bin/git` behaves differently again.
   **Unverified under a profile; the experiment's first assertion.**
2. **Git's own subprocesses.** `git push` over HTTPS runs a credential helper
   and may exec `ssh`. A profile that allows only `node` and `git` will find
   this the hard way, which is precisely what a misuse test is for.

**The even smaller warm-up, if one is wanted:** `mcp-apple-fm`. A host bridge
child, two tools, `requires_tcc: []`, and a profile that is almost entirely
`assistant.sb`'s base with one port. It proves the generalisation with less to
get wrong — and less to gain.

**Deliberately not in the experiment:** any mount; any new listener; any Swift;
any change to `assistant.sb`'s own rules; **`mcp-eventkit`** (the TCC
responsible-process risk, §3.2(c)); **the console** (its surface is a design
decision, not an experiment); and any grant plumbing from `--areas` into a
profile (that belongs with the external-agent case, if it ever arrives).

**The FSKit feasibility spike the ask also suggests** is a *separate*, larger
thing — `FSPathURLResource` on macOS 26 (§2.6), an app extension, a
Developer ID bundle and a System Settings toggle — and §4.1 parks it. If the
owner wants it anyway, `sohonetlabs/testfs` is a working, notarized, Swift
reference implementation to read first, and the honest estimate is **days, not
hours**, plus a permanent second bundle in the release.

### 4.3 Dependencies

**None required by the recommendation.** `/usr/bin/sandbox-exec` is an OS
facility the repo already invokes by absolute path.

Two that would need the owner's ruling if a "Later" row is taken up, per
`CLAUDE.md`'s ask-first rule:

- `@anthropic-ai/sandbox-runtime` (Apache-2.0) — not recommended as a runtime
  dependency: this repo's generator is smaller, already tested, and already
  shaped to this product's grants. Recommended as a **reference** for the
  loopback-proxy pattern and its SBPL idioms.
- Any HTTP/SOCKS proxy library for the egress row. Probably hand-rollable —
  `CLAUDE.md` already lists the router, migrations and the watchdog as
  deliberately hand-rolled, and a one-host CONNECT allowlist is in that class.

---

## 5. Contradictions with the plan, and open questions

**Contradictions** (reported, not edited — no plan file is touched by this PR):

1. **"App Sandbox is the migration path" is written as a pure upgrade** in both
   `ops/sandbox/assistant.sb` and `docs/ops/deployment-shapes.md` §*Two honest
   limits* item 2. It buys host-name egress filtering and **costs** the
   per-spawn `-D` parameterisation the current design depends on (§2.4). Both
   places should say so.
2. **The egress hole has a cheaper fix than the one recorded.**
   `deployment-shapes.md` says name-level enforcement "arrives with App
   Sandbox". Anthropic's own runtime does it on macOS today with a single
   loopback port plus a proxy (§1.A). The recorded plan is not wrong, but it
   is not the only path and currently reads as if it were.
3. **`ops/sandbox/` holds one profile for a supervisor with five children.**
   `docs/ops/deployment-shapes.md` lists the assistant as the confined child;
   the reconciler and the two host bridges have ambient authority, and the
   reconciler is the process that holds the vault's working tree and runs git.
   Not a contradiction between documents — a gap between what invariant 8
   promises ("every boundary testable") and what has a boundary at all.
4. **The ask's `container`-in-macOS-26 premise** is incorrect (§2.7); worth
   correcting wherever it has been written down, because it changes the cost of
   the Linux-guest option from "already there" to "admin password".
5. **Invariant 3 names one exception; there appear to be three holders.**
   `CLAUDE.md`: *"No component talks to Postgres directly (sole exception: the
   watchdog's liveness probes)."* `ops/sandbox/assistant.sb` already documents
   a second — *"the engine holds its own pool (the invariant-3 exception it
   shares with the watchdog)"* — and `apps/reconciler/src/main.ts:35`
   constructs a third (`new pg.Pool`). Found incidentally while sizing the
   reconciler profile's `DB_TCP` rule, so it is offered as an observation, not
   a finding: the reconciler writes derived index rows rather than serving
   reads, and invariant 3 is written about the **read** path, so this may be
   intended and merely unstated. Either way the invariant's parenthesis is now
   narrower than the code. Reported, not edited.

**Open questions for the owner:**

- **(a) Is the reconciler profile the right Now?** It is the one real gap this
  research found, but it is adjacent to the ask rather than an answer to it.
  Confirm it is wanted before it is built, or park the whole document. The
  sub-question, if yes: **reconciler** (high value, medium care) or
  **`mcp-apple-fm`** (low value, low risk) first?
- **(b) The egress proxy.** Worth a new always-on loopback listener to turn
  `engineHosts` from documentation into enforcement? It is the difference
  between "the engine cannot reach your LAN" and "the engine can only reach its
  provider" — a real strengthening, and a new moving part in a system
  maintained by one person.
- **(c) FSKit: park, or spike?** Recommendation is park (§4.1). If the answer
  is spike, the deciding question is whether the owner accepts **a System
  Settings toggle in the first-run flow, forever, on every install** — this
  product has zero of those today, and that is a property worth protecting.
- **(d) macFUSE's licence clause 4.** *"Redistributions in binary form, bundled
  with commercial software, are not allowed … This includes the automated
  download or installation."* Metistry is fully open source with no paid tier,
  so it is probably inapplicable — but "probably" is the owner's risk to accept,
  and it is moot unless (c) says spike **and** says macFUSE rather than
  first-party FSKit.
- **(e) Does the existence leak matter?** §2.2 finding 2: under a Seatbelt
  profile, `stat` on a denied vault path returns its real size. §3.3 argues
  this is not meaningful for a vault whose top-level names are already
  guessable. If the owner disagrees, that single fact is the entire case for
  a projection, and (c) changes answer.
- **(f) Re-read after code-mode.** `docs/research/2026-09-19-code-mode-mcp.md`
  is not in the repo yet. If it lands and proposes running generated code,
  §3.2(b) is the section to revisit — the conclusion is expected to hold, but
  it was reached without reading it.

---

## Sources

**Local, verbatim (this Studio, macOS 26.4 build 25E246, 2026-09-19).**
Read-only; the only thing executed was `sandbox-exec` against a throwaway tree
in the session scratchpad.

- `man sandbox-exec` (dated March 9 2017) — the `(DEPRECATED)` banner and the
  `-f` / `-p` / `-D` options.
- `man 7 sandbox` (dated January 29 2010) — "New processes inherit the sandbox
  of their parent"; "Restrictions are generally enforced upon acquisition of
  operating system resources only … if the application already has a file
  descriptor opened for writing, it may use that file descriptor regardless of
  restrictions."
- `MacOSX26.5.sdk/usr/include/sandbox.h` —
  `API_DEPRECATED("No longer supported", macos(10.5, 10.8))` on `sandbox_init`
  and the `kSBXProfile*` constants.
- `MacOSX26.5.sdk/…/FSKit.framework/Headers/` — `FSKitDefines.h`
  (V1 = `macos(15.4)`, V2 = `macos(26.0)`, V2_4 = `macos(26.4)`);
  `FSFileSystem.h` ("The current version of FSKit supports only
  `FSUnaryFileSystem`"); `FSUnaryFileSystem.h` ("Implement your app extension
  by providing a subclass"); `FSResource.h` (`FSBlockDeviceResource`,
  `FSPathURLResource`, `FSGenericURLResource`, and the entitlement note on
  opening `/dev/disk2s1`).
- `<Xcode SDK>/usr/include/EndpointSecurity/ESClient.h` ("Callers are required
  to be entitled with `com.apple.developer.endpoint-security.client`"; the Full
  Disk Access paragraph) and `ESTypes.h` (`ERR_NOT_ENTITLED`,
  `ERR_NOT_PERMITTED`, `ERR_NOT_PRIVILEGED`); `man 7 EndpointSecurity`.
- Probes: `sw_vers`; `which sandbox-exec`; `ls /System/Library/Sandbox/Profiles`
  (510); `ls -d /System/Library/Frameworks/{FSKit,Virtualization,EndpointSecurity}.framework`;
  `which container`; `kmutil showloaded --list-only | grep -i fuse` (no match,
  264 kexts); `ls -d /Library/Frameworks/macFUSE.framework`;
  `ls /Library/Filesystems`; `ls /System/Library/Filesystems`;
  `pluginkit -m -p com.apple.fskit.fsmodule -v`; `systemextensionsctl list`.
- The `sandbox-exec` experiment in §2.2 — output verbatim.

**Fetched 2026-09-19.**

- Anthropic, *Configure the sandboxed Bash tool* — Seatbelt on macOS;
  bubblewrap + socat + optional seccomp on Linux/WSL2; `sandbox.filesystem`
  allow/deny precedence; the credential-mask macOS/Linux asymmetry.
  <https://code.claude.com/docs/en/sandboxing>
  (redirected from `https://docs.claude.com/en/docs/claude-code/sandboxing`)
- Anthropic, *Beyond Permission Prompts* (published 2025-10-20) — "Linux
  bubblewrap", "MacOS seatbelt", the unix-domain-socket proxy.
  <https://www.anthropic.com/engineering/claude-code-sandboxing>
- `anthropics/sandbox-runtime` (Apache-2.0, 5,276 ★, push 2026-09-19) —
  README: the three platform mechanisms, the dual isolation model, the macOS
  "specific localhost port" proxy channel, the MCP-server sandboxing example.
  <https://github.com/anthropics/sandbox-runtime>
- `openai/codex` (Apache-2.0, 125,299 ★, push 2026-09-19) —
  `codex-rs/core/README.md` ("Expects `/usr/bin/sandbox-exec` to be present";
  the Landlock→bubblewrap routing rule); `codex-rs/linux-sandbox/README.md`;
  `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` (the Chrome citation and
  `(deny default)`); the `code-mode*` crates in `codex-rs/`.
  <https://github.com/openai/codex>
  (`docs/sandbox.md` only forwards to `developers.openai.com/codex/security`,
  which redirects to `learn.chatgpt.com/docs/security` — **that page does not
  cover CLI sandboxing**, so every Codex claim here is sourced from the repo.)
- `tursodatabase/agentfs` (MIT, 3,412 ★, created 2025-10-24, push 2026-06-03) —
  "FUSE on Linux and NFS on macOS"; the auditability/reproducibility/portability
  claims; "This software is in BETA".
  <https://github.com/tursodatabase/agentfs>
- `containers/bubblewrap` (LGPL-2.1 per `COPYING`, 8,773 ★);
  `google/nsjail` (Apache-2.0, 4,116 ★); `netblue30/firejail` (GPL-2.0,
  7,653 ★); `google/gvisor` (Apache-2.0, 19,351 ★).
- Linux kernel, *Landlock: unprivileged access control* — "first introduced in
  Linux 5.13"; ABI 1–11; the stated limitations (no filesystem-topology
  changes; 16-layer ruleset limit).
  <https://docs.kernel.org/userspace-api/landlock.html>
- gVisor documentation — "intercepts application system calls and acts as the
  guest kernel"; Sentry / Gofer / 9P.  <https://gvisor.dev/docs/>
- `e2b-dev/runtime` (Apache-2.0, 1,582 ★) — "Firecracker microVMs that resume
  from a snapshot"; `userfaultfd`; copy-on-write overlay.
  <https://github.com/e2b-dev/runtime>
- Modal, *Sandboxes* — **the mechanism is not named on the page**; volumes,
  filesystem snapshots, tunnels are.  <https://modal.com/docs/guide/sandbox>
- `cloudflare/sandbox-sdk` (Apache-2.0 per `LICENSE`, 1,133 ★) — containers
  behind Workers; Docker required locally.
- `daytonaio/daytona` (71,746 ★) — **no licence detected by GitHub and no
  `LICENSE` at the repository root**; licensing unestablished here.
- `apple/container` (Apache-2.0, 50,067 ★) — "supported on macOS 26"; Apple
  silicon required; installer needs an administrator password for `/usr/local`.
  <https://github.com/apple/container>
- macFUSE — the FSKit backend "entirely in user space on macOS 26"; 5.4.0
  released 2026-09-07; `LICENSE.txt` clause 4 on bundling with commercial
  software.  <https://macfuse.github.io/> and
  <https://github.com/macfuse/macfuse>
- `macos-fuse-t/fuse-t` (1,597 ★) — "kext-less … uses NFS v4 local server
  instead of a kernel extension"; SMB3; "FSKit for macOS 26+"; `License.txt`
  ("Free for non-commercial use" / commercial licence required for bundling).
- `sohonetlabs/testfs` — a shipping synthetic read-only FSKit filesystem:
  "Native Swift, no kernel extension, no `fuse-t` shim. macOS 15.4 or later";
  the System Settings enablement step; the "not `sudo`" rule; the TCC-protected
  mountpoint failure.  <https://github.com/sohonetlabs/testfs>
- Also surveyed, cited once each in §1: `run-llama/agentfs-claude`,
  `coplane/localsandbox`, `IceWhaleTech/ToolFS`, `neul-labs/agentvfs`,
  `can1357/isobox`, `nolabs-ai/langchain-nono`,
  `michaelneale/agent-seatbelt-sandbox`, `debox-network/FSKitBridge`,
  `Mearman/cascade`, `superradcompany/microsandbox`.
- **Not retrieved:** Apple's FSKit and App Sandbox documentation pages render
  client-side and returned title-only to the fetcher. Every FSKit claim here is
  sourced from the installed SDK headers instead, which is stronger.

**Repo.** `ops/sandbox/assistant.sb`; `packages/cli/src/sandbox.ts`;
`packages/cli/test/sandbox.test.ts`; `packages/cli/src/up.ts` (`plistValuesFor`,
the `assistant` case at l. 275 — the only child that gets a profile);
`packages/core/src/supervisor.ts`; `collectors/index.ts` (the registry
consumed by the console's routine runner); `apps/reconciler/manifest.yaml`,
`apps/reconciler/src/main.ts`, `apps/reconciler/src/git.ts`;
`apps/console/manifest.yaml`; `packages/mcp-brain/manifest.yaml`;
`packages/mcp-eventkit/manifest.yaml`; `packages/mcp-apple-fm/manifest.yaml`;
`docs/ops/deployment-shapes.md`;
`docs/ops/assistant-tools.md`; `docs/ops/cli.md`;
`docs/ops/migrate-compose-to-launchd.md`;
`docs/research/2026-09-15-devin-cursor-integration.md`;
`docs/product/desktop-app-plan.md`; `docs/product/PRODUCT.md`;
`docs/plan-refresh-2026-09-13.md`.
