# The bundled runtime — `runtime/`

Everything a Mac needs to run Metistry that is not the product itself:
**Node**, **Postgres 17 + pgvector**, and **git**. It is built by
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
```

`packages/cli/src/postgres.ts` resolves `<product>/runtime/postgres/bin` as
the **bundled** candidate, ahead of Homebrew and behind only an explicit
`METISTRY_PG_BIN` (`docs/ops/deployment-shapes.md`). The reconciler's plist
gets `runtime/git/bin` on the front of its `PATH`.

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
- **git** is built `RUNTIME_PREFIX=1`, so it resolves its exec path,
  templates and system config from its own location (`_NSGetExecutablePath`
  on Darwin) rather than from a prefix baked in on the CI runner.
- **The build script proves both before it exits**: it copies `runtime/`
  somewhere else and, from the copy, runs `initdb`, `pg_ctl start`,
  `CREATE EXTENSION vector`, `pg_dump`, and a `git init` + `add` + `commit`.
  A failure there fails the build.
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
  --sign "$METISTRY_SIGN_IDENTITY" <file>
```

Stripping happens **before** signing, because stripping invalidates a
signature. Unset, signing is skipped with a notice and the build still
succeeds — CI has no Developer ID yet, and the DMG job will
(`docs/ops/apple-signing.md`). A `codesign` that actually fails is a build
failure; a missing identity never is.

## Building it

```sh
ops/release/build-runtime-deps.sh                 # -> ./runtime
ops/release/build-runtime-deps.sh /tmp/rt         # -> /tmp/rt
METISTRY_RUNTIME_WORK=/tmp/rt-work ops/release/build-runtime-deps.sh
```

macOS arm64, Xcode Command Line Tools, and nothing else. Downloads and
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

- **The Claude Code CLI** — it arrives with the Agent SDK package, inside
  the product's own `node_modules`.
- **The Swift TCC helpers** (`ek-helper`, `afm-helper`) — they ship in the
  product runtime pack, Developer ID signed by their own build scripts.
- **Ollama** and **Tailscale** — optional, offered in-app, degrade absent.

## A Postgres major upgrade

The one update that needs a data migration step. Postgres 18 in a deps pack
would find a `state/pg` initialised by 17 and refuse to start. Plan it as
its own `metistry update --pg-upgrade` when it first happens — never
silently. Until then `PG_VERSION` stays on 17.x and `PG_MAJOR` in
`packages/cli/src/postgres.ts` is the assertion that keeps it there.
