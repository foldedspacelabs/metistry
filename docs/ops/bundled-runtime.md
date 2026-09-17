# The bundled runtime — `runtime/`

Everything a Mac needs to run Metistry that is not the product itself:
**Node**, **Postgres 17 + pgvector**, **git**, and **llama.cpp's
`llama-server`** — the no-install local model provider. It is built by
`ops/release/build-runtime-deps.sh`, shipped as its own release asset, and
unpacked at `<product-dir>/runtime/`. The decision is
`docs/product/desktop-app-plan.md` → "Bundled runtime" (ratified
2026-09-09): download, open, sign in to Claude, name the assistant, approve
two permissions. **Not required, ever: Docker, Homebrew, pnpm, Xcode, build
tools.**

`runtime/` is derived and gitignored. Invariant 1 holds: it is rebuildable
from the release, so it never needs backing up.

## The layout

```
runtime/
  manifest.json     versions, sha256 of every Mach-O, build date, what was disabled
  .release          the product version this pack came from
  node/
    bin/node, bin/npm -> …, bin/npx -> …
    lib/node_modules/npm
  postgres/
    bin/            postgres, initdb, pg_ctl, psql, createdb, pg_isready,
                    pg_dump, pg_restore, pg_config
    lib/            libpq and friends, plus the server's loadable modules
                    (vector.so among them)
    share/
      extension/    vector.control + vector--*.sql   (pgvector)
  git/
    bin/git, bin/git-shell, bin/scalar
    libexec/git-core/   the builtins, as SYMLINKS to `git`
    share/git-core/templates
  llamacpp/
    bin/llama-server    one static, Metal-enabled binary (~11 MB)
    LICENSE             llama.cpp's MIT licence, as shipped
```

`packages/cli/src/postgres.ts` resolves `<product>/runtime/postgres/bin` as
the **bundled** candidate, ahead of Homebrew and behind only an explicit
`METISTRY_PG_BIN` (`docs/ops/deployment-shapes.md`). The reconciler's plist
gets `runtime/git/bin` on the front of its `PATH`.
`packages/cli/src/local-models.ts` resolves
`<product>/runtime/llamacpp/bin/llama-server`, and `metistry up` turns it
into a supervisor child **only** when `.metistry/compute.yaml` names a provider with a
`serve:` block (`docs/ops/compute.md` → "Local models"). No `serve:` block,
no process: the binary ships whether or not anything uses it, exactly as
`git` does on a Mac with Xcode installed.

## Pinned in one place

`ops/release/runtime-versions.env` carries a version **and a sha256** for
each source tarball. The build refuses anything whose digest is not the pin,
and Node is additionally cross-checked against that release's own published
`SHASUMS256.txt`. Bumping a version means replacing both lines and saying
why in the PR.

| | pinned as | how it is obtained |
| --- | --- | --- |
| Node | `NODE_VERSION` / `NODE_SHA256` | the official `darwin-arm64` tarball; nothing is compiled |
| Postgres | `PG_VERSION` / `PG_SHA256` | built from source, relocatable |
| pgvector | `PGVECTOR_VERSION` / `PGVECTOR_SHA256` | built from source against `runtime/postgres`'s `pg_config` |
| git | `GIT_VERSION` / `GIT_SHA256` | built from source, `RUNTIME_PREFIX=1` |
| llama.cpp | `LLAMACPP_VERSION` / `LLAMACPP_SHA256` | built from source with CMake, Metal on, statically linked |

llama.cpp cuts **semver releases** (`v0.4.1`) alongside its nightly
`b<number>` tags. Pin a semver one: a nightly is a build, not a version, and
the release tag is what upstream tells you to set `LLAMA_BUILD_IS_DEV=OFF`
for.

Node's major must satisfy the root `package.json`'s `engines.node`, and
Postgres's major must equal `PG_MAJOR` in `packages/cli/src/postgres.ts` —
both are asserted by `packages/cli/test/runtime-deps.test.ts`.

## What the source builds give up

Nothing here installs a build dependency, and macOS ships no ICU headers,
readline or gettext outside Homebrew. So both builds are deliberately
minimal, and `manifest.json` records exactly what was left out:

**Postgres** — `--without-icu` (no ICU collations; `initdb` runs
`--locale=C`, which is what `metistry up` already asks for),
`--without-readline` (`psql` has no line editing or history — the console
and the migration runner talk to it over a socket, not a terminal),
`--disable-rpath` (the install names are rewritten instead, below), and no
OpenSSL (the launchd shape listens on loopback and a unix socket only). zlib
is linked, so `pg_dump -Fc` works.

**git** — `NO_GETTEXT=1` (English messages), `NO_TCLTK=1` (no `gitk` or
`git gui`), `NO_PERL=1` (no `git add -p`, `git svn`, `git send-email`),
`NO_PYTHON=1`. The reconciler uses plumbing and `commit`/`add`/`push`; none
of the above is on that path. `NO_INSTALL_HARDLINKS=1` makes the builtins
symlinks rather than hardlinks — a hardlinked builtin becomes a second full
copy the moment `codesign` rewrites the file.

**llama.cpp** — `-DLLAMA_OPENSSL=OFF` (no HTTPS in the server: the CLI
downloads GGUFs itself), `-DGGML_OPENMP=OFF`, `-DLLAMA_BUILD_UI=OFF
-DLLAMA_USE_PREBUILT_UI=OFF`, and everything except the server target
(`--target llama-server`; no `llama-cli`, no `quantize`, no examples, no
tests).

Three of those four are **relocatability requirements, not preferences.**
`LLAMA_OPENSSL` and `GGML_OPENMP` each end in a `find_package()` that would
happily link `/opt/homebrew/opt/openssl@3` or `libomp` on a runner that
happens to have one — and a `runtime/` that needs Homebrew is not a bundled
runtime. The prebuilt web UI is an **unpinned Hugging Face download at build
time**, inside a build whose whole point is that every byte is pinned; the
Compute pane is the UX Metistry owns anyway. `otool -L` on the result lists
system frameworks and nothing else:

```
/System/Library/Frameworks/Accelerate.framework/…/Accelerate
/System/Library/Frameworks/Metal.framework/…/Metal
/System/Library/Frameworks/MetalKit.framework/…/MetalKit
/System/Library/Frameworks/Foundation.framework/…/Foundation
/System/Library/Frameworks/CoreFoundation.framework/…/CoreFoundation
/usr/lib/libSystem.B.dylib, /usr/lib/libc++.1.dylib, /usr/lib/libobjc.A.dylib
```

**The build number and commit are STATED, not discovered.** llama.cpp's
`build-info.cmake` runs `git rev-parse HEAD` in its source directory — and
with the default work dir (`<repo>/.runtime-build`) that is *Metistry's*
commit, stamped into `llama-server --version`. The script passes
`-DLLAMA_BUILD_COMMIT=v$LLAMACPP_VERSION -DLLAMA_BUILD_NUMBER=0
-DLLAMA_BUILD_IS_DEV=OFF`, so the binary reports
`version: 0.4.1 (build 0, commit v0.4.1)`.

**git is held at 2.54.x on purpose.** 2.55 added a Rust component
(`target/release/libgitcore.a`) whose build needs `cargo`, which this script
will not install and the macOS runner does not ship. Moving past it means
adding a Rust toolchain to the `runtime-deps` job first — a decision, not a
version bump.

## Relocatable, and proved so

A tree that only works where it was compiled is not a bundled runtime.

- **Postgres** already finds its own `share/` and `lib/` relative to
  `argv[0]`. What is not automatic is dynamic linking: `--disable-rpath`
  leaves absolute `$prefix/lib/...` install names, so the script rewrites
  every Mach-O with `install_name_tool` — each dylib's id becomes
  `@rpath/<name>`, each dependency inside the prefix becomes `@rpath/…`,
  and every binary gains an `@executable_path/../lib` (and matching
  `@loader_path`) rpath.
- **llama-server** is linked `-DBUILD_SHARED_LIBS=OFF`: nothing to relocate,
  nothing to `@rpath`, one file to sign. `GGML_METAL_EMBED_LIBRARY=ON` is the
  other half — without it the binary hunts for a `default.metallib` beside
  itself and a moved copy has no GPU. (`relocate()` and `strip_tree()` still
  run over the prefix, so flipping the flag back would be a flag change
  rather than a rewrite.)
- **git** is built `RUNTIME_PREFIX=1`, so it resolves its exec path,
  templates and system config from its own location (`_NSGetExecutablePath`
  on Darwin) rather than from a prefix baked in on the CI runner.
- **The build script proves both before it exits**: it copies `runtime/`
  somewhere else and, from the copy, runs `initdb`, `pg_ctl start`,
  `CREATE EXTENSION vector`, `pg_dump`, a `git init` + `add` + `commit`, and
  `llama-server --version` + `--list-devices`. The last one has to list an
  `MTL<n>` device (`MTL0: Apple M4 Max`): a CPU/BLAS-only list means the
  Metal backend did not register, which is a bundled model server that
  cannot use the GPU. A failure anywhere there fails the build.
- `packages/cli/test/runtime-deps.integration.test.ts` does the same thing
  again from the test suite, through the same `findPgToolchain` /
  `planPostgresBootstrap` code `metistry up` uses. It **skips** when
  `runtime/` has not been built (CI's Linux jobs, a fresh clone).

## Signing

Set `METISTRY_SIGN_IDENTITY` and every Mach-O in `runtime/` — found with
`file`, so a shell script in `bin/` is never touched — is signed:

```sh
codesign --force --options runtime --timestamp \
  --identifier com.foldedspacelabs.metistry.runtime.<name> \
  [--entitlements <what it came with, minus get-task-allow>] \
  --sign "$METISTRY_SIGN_IDENTITY" <file>
```

Stripping happens **before** signing, because stripping invalidates a
signature. Unset, signing is skipped with a notice and the build still
succeeds. A `codesign` that actually fails is a build failure; a missing
identity never is.

**Entitlements are carried over, minus `get-task-allow`.** Node's official
binary is signed with the hardened runtime plus `allow-jit`,
`allow-unsigned-executable-memory`, `disable-library-validation` and
friends — V8 cannot run without the first two — and with `get-task-allow`,
which notarization rejects. A hardened-runtime signature with no
entitlements produces a `node` that is killed at startup; `sign()` proves
the signed node still runs before the build goes on, and that
`get-task-allow` is gone. Postgres, git and `llama-server` carry no
entitlements and get none — **Metal needs none**: shader compilation goes
through the Metal compiler service, not through a JIT mapping the hardened
runtime would refuse.

**In CI the pack is signed** when the `APPLE_CERTIFICATE_P12` /
`APPLE_CERTIFICATE_PASSWORD` secrets are set (`.github/actions/apple-keychain`
imports the cert into a temporary keychain and pins the identity by hash —
the same setup the DMG job and the darwin runtime pack's TCC helpers use).
That is what a pack installed by `metistry update` — the launchd shape,
no app, no DMG — carries: Node, Postgres and git under Folded Space Labs,
so the supervisor's Login Item (`Metistry`, a symlink to the bundled
`node`) is attributed to us rather than to the Node.js Foundation. Without
the secrets — a fork — the pack is unsigned as before: Postgres and git
ad-hoc, Node under the Node.js Foundation's Developer ID. `tar` sets no
quarantine attribute, so Gatekeeper never assesses a pack `metistry up`
unpacks either way; the signature is about attribution and about what the
DMG embeds.

The DMG job re-signs **every** Mach-O it embeds regardless
(`ops/release/build-app.sh`): a file already under the same team, with the
hardened runtime and a secure timestamp, is kept; anything else is signed
with the same entitlements rule, then the whole bundle is audited before
the DMG is produced. That is the lesson of v0.4.0's `status: Invalid`: the
earlier rule only signed what had *no* signature, and ad-hoc counts as one.

## Building it

```sh
ops/release/build-runtime-deps.sh                 # -> ./runtime
ops/release/build-runtime-deps.sh /tmp/rt         # -> /tmp/rt
METISTRY_RUNTIME_WORK=/tmp/rt-work ops/release/build-runtime-deps.sh

# one component, built and proved from a moved copy, then stop — minutes
# instead of a Postgres-from-source compile. Assembles nothing, signs
# nothing, writes no manifest.
ops/release/build-runtime-deps.sh --only llamacpp
```

macOS arm64, Xcode Command Line Tools, **and `cmake`** (llama.cpp is a
CMake project; the macos-14 runner ships one, and a missing one is a refusal
with the two ways to get it, not a half-built pack). Downloads and
build trees live under `METISTRY_RUNTIME_WORK` (default
`<repo>/.runtime-build`); `…/cache/<component>-<version>` is what CI caches,
so only a versions bump pays for the compile again.

Nothing is installed into the system, into Homebrew, or anywhere outside
the output directory and the work directory.

## How an install gets it

The `runtime-deps (darwin-arm64)` job in `.github/workflows/release.yml`
runs the script and uploads
`metistry-runtime-deps-<version>-darwin-arm64.tar.gz` (plus a `.sha256`
sidecar); the `publish` job's `checksums.txt` covers it like every other
asset. The tarball's single top-level directory is `runtime/`, so it unpacks
with `tar -C <product-dir>`.

Two paths reach for it, both through the same verify-then-unpack code as the
product's runtime pack (`packages/cli/src/runtime-deps.ts`):

1. **`metistry update --channel release`** installs the deps pack right
   after the runtime pack, so a new Node, Postgres or git arrives with the
   release that needs it. `--rollback` leaves `runtime/` alone: it is a
   superset, not a downgrade.
2. **`metistry up` on the launchd shape**, in release mode, when
   `findPgToolchain` finds **nothing** — no `METISTRY_PG_BIN`, no bundled
   tree, no Homebrew. A git checkout never downloads one; that operator gets
   the `brew install postgresql@17 pgvector` remediation as before.

A checksum mismatch throws and leaves the existing `runtime/` exactly as it
was. A release with no deps pack (any Linux target, or a release cut before
this existed) is a note, not a failure.

`METISTRY_RUNTIME_DEPS=0` keeps both paths off the network entirely.

## What is NOT in here

- **The Claude Code CLI** — a collaborator, not a component: it reaches
  Metistry over `/mcp` with the plugin, installed by the person who wants it
  (`plugins/claude-code/`). Nothing in the product depends on it.
- **The Swift TCC helpers** (`ek-helper`, `afm-helper`) — they ship in the
  product runtime pack, Developer ID signed by their own build scripts.
- **Ollama** and **Tailscale** — optional, offered in-app, degrade absent.

## A Postgres major upgrade

The one update that needs a data migration step. Postgres 18 in a deps pack
would find a `.metistry/state/pg` initialised by 17 and refuse to start. Plan it as
its own `metistry update --pg-upgrade` when it first happens — never
silently. Until then `PG_VERSION` stays on 17.x and `PG_MAJOR` in
`packages/cli/src/postgres.ts` is the assertion that keeps it there.
