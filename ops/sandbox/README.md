# `ops/sandbox/` — host confinement profiles

Seatbelt (SBPL) profiles for the children the **`launchd` shape** runs on the
host. Under `compose` the container is the boundary and nothing here is used.

| File | Applies to | Written by |
| --- | --- | --- |
| `assistant.sb` | the engine (`apps/assistant`) — confined since PR #117 | `sandboxParams()` in `packages/cli/src/sandbox.ts` |
| `reconciler.sb` | **the sole committer** (`apps/reconciler`) — the only process that holds the vault's working tree and the only place git runs (D5) | `reconcilerSandboxParams()` in the same file |
| `unconfined.sb` | nothing, by default. `(allow default)` — the visible off switch for the reconciler (`METISTRY_RECONCILER_SANDBOX=0`) | — |

Each is applied by `metistry up`, which renders
`/usr/bin/sandbox-exec -f <profile> -D KEY=VALUE … <node> <main.js>` as the
job's **root process**, so every child inherits it —
`sandbox(7)`: *"New processes inherit the sandbox of their parent"*, and a
confined process cannot re-`sandbox-exec` itself looser (proven by a misuse
test). Parameters are computed in exactly one place so the tests confine a
probe with the same values the install runs with.

Misuse tests: `packages/cli/test/sandbox.test.ts` (engine),
`packages/cli/test/reconciler-sandbox.test.ts` (committer), and
`ops/sandbox/bind.test.mjs` — every profile listens where it binds and
nowhere else, run on a `macos-26` runner (`node --test 'ops/sandbox/*.test.mjs'`). Both launch a
real process under the real profile; both skip on Linux rather than silently
passing. Denials are visible with
`log stream --predicate 'sender == "Sandbox"'`.

## Egress is one door, not a port range

SBPL filters outbound by **port**, never by host name — it cannot express
`openrouter.ai`. It *can* be narrowed to a single loopback port, and the
thing listening there can name hosts all day. So both profiles now say

```scheme
(allow network-outbound (remote tcp (param "PROXY_TCP")))
```

and nothing else off the machine. `PROXY_TCP` is the supervisor's CONNECT
proxy (`packages/core/src/egress.ts`, `apps/watchdog/src/egress-proxy.ts`):
an allowlist derived from this install's `compute.yaml` providers and its
instance repo's git remotes, a bearer per child, a `runs` row per refusal,
and **no TLS interception** — CONNECT only, so it learns a host name and a
port and never a byte of the tunnel. The pattern is Anthropic's
`sandbox-runtime`'s ("the Seatbelt profile allows communication only to a
specific localhost port"); the pattern only — no dependency was added.

`assistant.sb` used to carry `(remote tcp "*:443")` with an honest note
saying the host list beside it was documentation rather than enforcement.
That is what this closed.

## A correction: App Sandbox is a TRADE, not a pure upgrade

Both `assistant.sb` and `docs/ops/deployment-shapes.md` used to say the
migration path is App Sandbox entitlements once the Mac app hosts these
processes, and read as though that were strictly better. Research
(`docs/research/2026-09-19-agent-virtual-filesystems.md` §2.4, from the
installed SDK) says what it also costs:

- **Entitlements are a property of a signed bundle, not of a spawn.** A
  parent cannot compute a profile per child from that child's grants. "This
  instance's console port, this instance's four config files by name, this
  instance's repo as the one writable tree" is precisely what Seatbelt's
  `-D KEY=VALUE` parameters express and what entitlements cannot.
- **Its file grants are user-intent-shaped** — Powerbox, security-scoped
  bookmarks — which does not map onto a grant a CLI verb computed.

It buys outbound filtering by host name; the loopback proxy above buys that
today, without it. So App Sandbox remains the long-term home for a signed
helper, and adopting it means finding a new answer for per-spawn grants.
That is a decision, not a tidy-up.

## `sandbox-exec` is deprecated and shipping

`man sandbox-exec` says DEPRECATED; `sandbox.h` deprecates `sandbox_init`
and the `kSBXProfile*` constants — in macOS 10.8, fourteen years ago. The
deprecated thing is the **C API and its named profiles**. The `-f`/`-p`
SBPL path is what Apple runs 510 of its own profiles through, what Chrome's
renderer sandbox uses, what Claude Code calls "the built-in Seatbelt
framework", and what Codex requires (`/usr/bin/sandbox-exec`). Verified here
on macOS 26.4; the same shape has worked since 14.

## Writing a rule

The things that cost time to learn, recorded so they cost nobody else any:

1. **Subpaths must be REAL paths.** `/tmp` is a symlink to `/private/tmp`;
   the kernel matches after resolution. `realPathish()` does this.
2. **`file-read-metadata` is global, deliberately.** node lstats every
   ancestor of its entry point and git stats its way to a repo root.
   Metadata is existence and size, never content — and narrowing it broke
   `cat`'s ability to `fstat` its own pipe without buying `ENOENT` instead
   of `EPERM`.
3. **The process's working directory must be inside a granted subpath**, or
   git dies with `fatal: Unable to read current working directory`.
4. **A listener needs `network-bind` AND `network-inbound`** on macOS 26:
   with the bind rule alone `listen()` is `EPERM` (the 0.14.2 reconciler
   crash-loop). `bind.test.mjs` fails a profile that has one without the
   other.
5. **git runs every credential helper through `/bin/sh`** — including the
   built-in `osxkeychain` inside `GIT_PREFIX` — so a profile with no shell
   has no helper. `GIT_ASKPASS` is exec'd *directly*, by absolute path, with
   no shell, and is therefore the way a confined process authenticates:
   `reconciler.sb` grants one generated shim by literal
   (`packages/cli/src/askpass.ts`).
