# Cutting a release

Code flows downward as releases, never as git merges (plan §4.16). An
instance has no git relationship with upstream: it consumes *artifacts* —
a runtime pack, container images, npm packages — pinned by
`metistry.lock` and moved by `metistry update`. This page is how those
artifacts get made.

Everything is built by `.github/workflows/release.yml`, triggered by a
`v*` tag. There is no FSL-run server anywhere in the path
(`docs/product/desktop-app-plan.md`, strategy ratified 2026-09-07):
GitHub Releases is the distribution channel.

## One version for the whole product

Changesets in **fixed mode**: every publishable
`@foldedspacelabs/metistry-*` package and every private `@metistry-apps/*`
app carries the same number, and the root `package.json` version is the
product's `VERSION`. **`@metistry-apps/macos` is in that set** — its
`package.json` holds a name and a version and no JavaScript at all, and exists
so the Mac app is versioned with the product and gets its own `CHANGELOG.md`
line rather than being invisible to `changeset version`. That is what makes `metistry.lock`'s single
`product.version` a real coordinate — `0.2.0` names one runtime pack, one
set of images and one set of npm packages.

In the PR that makes the change:

```sh
pnpm changeset          # pick major/minor/patch; write the sentence a user reads
```

The release body is generated from those sentences (below), so write them
for a reader, not for a diff.

## The four steps

```sh
# 1. version — folds every changeset into the CHANGELOG.md files and bumps
#    every package plus the root package.json
pnpm release:version
git checkout -b release/0.2.0 && git commit -am "Release 0.2.0" && gh pr create

# 2. merge that PR to main

# 3. tag it
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0

# 4. watch it
gh run watch
```

The workflow refuses a tag whose number does not match `package.json` and
`packages/cli/package.json` (`node ops/scripts/sync-root-version.mjs
--check`), so a hand-made tag cannot produce a mislabelled release.

`release:version` also runs `ops/scripts/fold-product-record.mjs`, folding
every PR's fragment under `docs/product/record/` into `docs/product/PRODUCT.md`
and deleting them — the reason `PRODUCT.md` only changes on a release branch
rather than in every PR that touches it (`docs/product/record/README.md`).

## What a release contains

| asset | what it is |
| --- | --- |
| `metistry-runtime-<version>-darwin-arm64.tar.gz` | the built product, for an Apple-silicon Mac |
| `metistry-runtime-<version>-linux-x64.tar.gz` | the same, for a Linux host |
| `metistry-runtime-deps-<version>-darwin-arm64.tar.gz` | the **bundled runtime**: Node, Postgres 17 + pgvector, git — `docs/ops/bundled-runtime.md` |
| `Metistry-<version>.dmg` | the **Mac app**: the SwiftUI front end for the CLI, with both packs above embedded as `Contents/Resources/metistry/`, Developer ID signed with the hardened runtime, notarized and stapled — `docs/ops/mac-app.md` |
| `appcast.xml` | the EdDSA-signed **Sparkle feed** an installed app polls. `latest/download/appcast.xml` is the URL in the app's `Info.plist`, so it always resolves to the newest release |
| `checksums.txt` | `sha256sum` of every asset, the DMG and the appcast included; `metistry update` verifies the runtime packs against it |
| npm `@foldedspacelabs/metistry-*@<version>` | published via Trusted Publishing, with npm provenance (see below) |
| `ghcr.io/foldedspacelabs/metistry-{console,assistant,reconciler}:<version>` | the app images compose pulls — multi-arch (`linux/amd64` + `linux/arm64`, so Docker Desktop on Apple silicon pulls the native image) |

The **runtime pack** (`ops/release/pack-runtime.sh`) is the product as an
install runs it — no checkout, no `pnpm install`, no compile step. It
unpacks to a single `metistry-<version>/` directory holding:

- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `docker-compose.yml`, `README.md`, `LICENSE` — the shape `metistry
  doctor`/`up` identify a product directory by
- `seed/` (the instance defaults the D4 overlay reads through),
  `db/migrations/`, `ops/launchd/`, `ops/scripts/`, `ops/release/`,
  `targets/`
- every workspace package's `package.json`, `manifest.yaml` and `dist/`
  — `apps/*`, `packages/*`, `plugins/*` — plus `apps/console/web` (the
  PWA) and the Swift TCC helper bundles under
  `packages/mcp-*/helper/` when the pack was built on macOS — built and
  signed by the darwin `runtime` job under the Developer ID when the
  signing secrets are set (ad-hoc otherwise), so `metistry up` on a release
  install pins its bridges at helpers that keep a checkout's TCC grant
- `collectors/` and `routines/` with their per-directory manifests
- `node_modules/` — production dependencies only, which is why the pack
  is per os-arch
- `metistry-runtime.json` — version, target, build time, and the commit it
  was built from (`metistry update` reads this into `metistry.lock`'s
  `product.commit` on the release channel, since there is no git pull to
  read a HEAD from; a pack built before this field shipped falls back to
  the lock's prior commit rather than fabricating one)

Left out on purpose: `src/`, tests, tsconfigs, Dockerfiles, `.git`. A
release is compiled output. `metistry update` never builds in release
mode, and `docker compose` only ever pulls.

Before it is tarred, the staged pack's **own** doctor validates the pack's
own manifests — `ops/release/check-pack-manifests.mjs`, importing the
packed `packages/cli/dist/doctor.js` with the packed `node_modules` — and a
single invalid manifest, or a `collectors/` or `routines/` that contributed
none, fails the job. CI runs the same script on the built checkout. (A
0.12.0 → 0.14.0 upgrade printed `schedule: expected string, received
object` for every collector and routine; the 0.14.0 pack validates all 26.
Those rows were 0.12.0's CLI — the one that ran the update — reading 0.14.0's
manifests with its own schema. An update is started by the release before
it; from 0.14.2 on it hands everything after the switch to the release it
installed: `docs/ops/cli.md`, "The rest of a release update runs on the
release it installed".)

The **bundled runtime** (`ops/release/build-runtime-deps.sh`, the
`runtime-deps (darwin-arm64)` job) is the other half of "no build tools on
the user's machine": Node, a relocatable Postgres 17 + pgvector built from
source, and a minimal git, every version and source digest pinned in
`ops/release/runtime-versions.env`. The job verifies the tree from a *moved*
copy before packing it, signs every Mach-O when `APPLE_SIGN_IDENTITY` is
set, and caches the Postgres/git compiles on that versions file so a later
run is a few minutes rather than fifteen. Its tarball holds a single
top-level `runtime/`, which is why `metistry update` unpacks it with
`tar -C <product-dir>`. Full account: `docs/ops/bundled-runtime.md`.

The **DMG** (`ops/release/build-app.sh`, the `macos-app` job) is the Mac
app with both packs above unpacked inside it as
`Contents/Resources/metistry/{releases/<version>,current,runtime}` — the
same layout `metistry update` produces in release mode, so the app's
runtime locator and the CLI agree about where everything is. The job
imports the Developer ID certificate into a temporary keychain, signs,
notarizes with the App Store Connect API key and staples. Full account:
`docs/ops/mac-app.md`.

## Release notes

`ops/release/changelog.mjs` builds the release body from the
`CHANGELOG.md` files `changeset version` wrote. The bullets come from
`packages/cli/CHANGELOG.md`'s `## <version>` section — the CLI is the
product-level package, and fixed mode means every package's section for
that version is identical anyway, so there is nothing to merge in the
normal case. If that section is missing or blank (the CLI carries no
changeset for this release), it falls back to every package's section,
deduplicated (one changeset touching six packages reads as one line).
Either way the fixed-mode `Updated dependencies` churn and the
commit-hash prefixes are dropped, and the packages, images and assets are
appended. No second hand-written account to drift.

This is also why the release PR (`pnpm release:version`) must land before
the tag: it is what writes the `## <version>` section the notes read.

## Consuming a release: `metistry update`

An install is in release mode when its `metistry.lock` says `source:
release` — written by `metistry init --channel release`, or forced for one
run with `--channel release`.

```
<product-dir>/
  releases/0.2.0/     this release, unpacked
  releases/0.1.0/     the previous one, kept for rollback
  releases/.previous  what `current` pointed at before the last switch
  current -> releases/0.2.0
```

`metistry update` then:

1. resolves the latest release from GitHub (`--version 0.2.0` pins one),
2. downloads its runtime pack **and `checksums.txt`**, and verifies the
   sha256. A mismatch aborts with the two digests and leaves `current`
   exactly where it was — nothing is unpacked, nothing restarts, the lock
   is not moved,
3. unpacks to `releases/<version>/` and points `current` at it
   (a relative symlink swapped through `rename`, so there is no window
   where `current` is missing); older releases beyond the previous one are
   pruned, and the release's **bundled runtime** is verified and unpacked
   the same way into `<product-dir>/runtime/` — beside `releases/`, not
   inside one, so a version flip never orphans the Postgres the plists
   point at (`METISTRY_RUNTIME_DEPS=0` skips it; `--rollback` leaves it
   alone),
4. on a Mac under the launchd shape, moves the **Mac app** to the same
   release: `Metistry-<version>.dmg`, verified against the same
   `checksums.txt` by the same code, mounted read-only, its bundle id,
   version and signature (codesign + Gatekeeper, when signed) checked, and
   swapped into `/Applications/Metistry.app` with the old one kept as
   `Metistry.app.previous` — never with sudo, never killing a running app
   without `--relaunch`, never failing the update (`--no-app` skips it,
   `--app-path` points it elsewhere; `docs/ops/cli.md`, "Moving the Mac app
   with the release"),
5. **hands the rest to the release it just installed**: the process
   running `update` is the release being left, so it re-executes
   `current/packages/cli/dist/main.js update --continue-from=switched` on
   the bundled `node`, with the same flags and environment, and exits with
   its code — every step below runs on the new code. A new CLI that cannot
   start is survived loudly (the old code finishes, exit 1, with the way
   back); a release that predates the hand-over, `--rollback` and
   `--no-reexec` finish on the running code (`docs/ops/cli.md`, "The rest
   of a release update runs on the release it installed"). **One run is
   enough from 0.14.2 on**; the update onto 0.14.2 is still 0.14.1's,
6. runs `db/migrations` from `current` under the advisory lock,
7. `docker compose pull && up -d --no-build` in `current`, with
   `METISTRY_CONSOLE_IMAGE` / `METISTRY_ASSISTANT_IMAGE` set to the
   versioned ghcr images,
8. kickstarts the launchd jobs whose code changed, writes `metistry.lock`
   through the reconciler, copies each `seed/vault/Templates/*.md` the vault
   **lacks** (create-only — a template that is there is never touched;
   `docs/ops/cli.md`, "Seeding the templates the vault lacks"), and runs
   `doctor`.

Because everything after the switch runs against `current`, going back is
a symlink flip:

```sh
metistry update --rollback
```

On a launchd Mac the rollback also swaps `Metistry.app.previous` back in
(and keeps the newer app as the previous), so the front end goes back with
the product it drives.

**Migrations are not reverted.** They are additive-first by rule
(`CLAUDE.md`), so a schema slightly ahead of the code is the expected
state after a rollback, not a fault. A migration that could not survive
that is a destructive migration, which needs an explicit decision and a
rollback note in its PR.

Point `METISTRY_PRODUCT_DIR` at the *product dir* (the one holding
`releases/` and `current`), not at `current` itself — `update` needs to
see both to switch between them.

Set `METISTRY_RELEASE_REPO` to consume a fork's releases, and
`METISTRY_IMAGE_PREFIX` to pull its images. `METISTRY_GITHUB_TOKEN` (the
read-only PAT the github-state collector already uses) lifts GitHub's
anonymous rate limit — and for a fork kept **private** it is the only way to
see releases at all, but only if the fine-grained PAT carries **Contents:
read**; Issues/Pull requests/Metadata is not enough and gets a 403 the CLI
reports separately from an exhausted rate limit. Missing that scope,
`metistry update` falls back to the `gh` CLI (resolve and download both)
when it is on PATH and logged in.

`--dry-run` in release mode reaches nothing — no GitHub call, no
download — so the version it prints is `<latest>`, the request rather
than a resolved tag.

### Knowing there is one — the daily Update Check

The console runs `routines/update-check` every day at 06:00 (its Scheduled
default; the owner can move it): it asks the same
`releases/latest` endpoint (the same `METISTRY_RELEASE_REPO`,
`METISTRY_GITHUB_API` and `METISTRY_GITHUB_TOKEN`) and compares the answer
with the console's own version. A newer release writes one `runs` row
(`component = 'update-check'`, `meta.release_available`), which every open
client hears as `release.available {version}` (`docs/ops/client-api.md`, "Live
changes"); an equal or older one is silent; a feed that does not answer is a
`skipped:<reason>` row and never an alert. It installs nothing — updating is
still `metistry update`, by hand.

## Secrets

The signing secrets — `APPLE_*` and `SPARKLE_PRIVATE_KEY` — live in the
**`release` environment** (GitHub → Settings → Environments → `release`),
whose required reviewer is the owner. Only the four jobs that sign or
notarize (`runtime`, `runtime-deps`, `macos-app`, `appcast`) declare
`environment: release`, so only they can read those secrets, and each waits
for the owner's approval on the run. None of them are in the repo, and none
reach a build log. (Repo-level secrets of the same names also still work, for
a fork that has not made the environment.)

| secret | used by | needed for |
| --- | --- | --- |
| `GITHUB_TOKEN` (automatic) | `images`, `publish` | pushing to ghcr.io and creating the release. Nothing to set; a fork whose `packages: write` is unavailable logs a notice and skips the image, rather than failing the release |
| `SPARKLE_PRIVATE_KEY` | `appcast` | the EdDSA key Sparkle's `sign_update` signs the DMG with. **Never** in the repo or an artifact; it reaches `sign_update` on stdin so it never touches disk. `ops/release/appcast.mjs` refuses to emit an unsigned feed. Absent → the job skips with a notice and no appcast is published |
| `SPARKLE_PUBLIC_ED_KEY` | — | the matching public key. Not sensitive, and it **is** committed: `SUPublicEDKey` in `apps/macos/resources/Info.plist` and `SPARKLE_PUBLIC_ED_KEY` in `ops/release/runtime-versions.env`, which a test asserts are the same string. The secret is redundant now; harmless to leave set |
| `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD` | `macos-app` | the Developer ID Application certificate, imported into a temporary keychain; `METISTRY_SIGN_IDENTITY` is then derived from it as the identity's **SHA-1 hash**, not its display name (two valid certs for one team have identical names and `codesign -s` fails with "ambiguous"). Absent → the job skips with a notice |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8` | `macos-app` | notarization via the App Store Connect API key (`xcrun notarytool submit --key --key-id --issuer --wait`, then `stapler staple`) — **not** an Apple ID + app-specific password. Absent → the DMG is signed but not notarized, and the run says so |
| `APPLE_TEAM_ID` | — | unused. It was for the `xcodebuild archive` in the old stub; there is no Xcode project |

The Developer ID certificate is also what fixes the ad-hoc-signed TCC
helpers (D3: TCC bridges must be *stably* signed, or every rebuild
re-prompts for permission).

Setting these with `gh secret set`: delete the `.p12` and `AuthKey_*.p8`
from disk right after upload — never let the export outlive the
`gh secret set` call (`docs/ops/apple-signing.md` §4 has the exact
commands). And if a `GH_TOKEN` is set in your shell (a fine-grained PAT
for something else), it shadows your `gh auth login` keyring session and
`gh secret set` 404s instead of asking you to log in — run
`env -u GH_TOKEN gh secret set …` for this and any other `gh` admin
operation.
## Publishing to npm: Trusted Publishing, no token

The `npm` job authenticates with npm's **Trusted Publishing** (OIDC): GitHub
issues the job a short-lived identity token (`permissions: id-token: write`),
npm exchanges it for a publish token scoped to that one run, and nothing
long-lived is ever stored as a secret. This needs npm CLI ≥ 11.5.1 and
Node ≥ 22.14 — the job pins Node with a `>=22.14.0` range and installs the
latest npm explicitly, since the npm bundled with Node itself is older.

**Bootstrap, once per package.** Trusted Publishing can only be *configured*
for a package that already exists on npm, so the first version of each new
`@foldedspacelabs/metistry-*` package has to be published by hand before any
of this applies to it:

```sh
# from the built package's directory (or: pnpm -r publish --access public --no-git-checks)
npm login                       # short-lived, granular token — see below
npm publish --access public
```

Then, on npmjs.com, for that package: **Settings → Trusted publishing → Add
a trusted publisher → GitHub Actions**, with:

- Organization or user: `foldedspacelabs`
- Repository: `metistry`
- Workflow filename: `release.yml`
- Environment: (leave blank unless a `npm` job environment is added later)

Once every package in the list below is configured this way, `release.yml`
publishes all of them with no further owner action. Do this once for the
org, too: **npmjs.com → org settings → Publishing access → "Require two-factor
authentication and disallow tokens"** — the point of Trusted Publishing is
that long-lived tokens stop being a way in at all. Then revoke the bootstrap
token from Account → Access Tokens; it was only ever needed to get each
package's first version onto the registry.

**Packages to bootstrap** (every `packages/*/package.json` with a public
name — none in this repo are private):

- `@foldedspacelabs/metistry-artifacts`
- `@foldedspacelabs/metistry-cli`
- `@foldedspacelabs/metistry-core`
- `@foldedspacelabs/metistry-mcp-apple-fm`
- `@foldedspacelabs/metistry-mcp-brain`
- `@foldedspacelabs/metistry-mcp-eventkit`
- `@foldedspacelabs/metistry-queries`
- `@foldedspacelabs/metistry-tasks`

**Provenance.** npm provenance attests that a package was built by a
specific public CI run. `release.yml` passes `--provenance` when
`github.event.repository.private == false`, which holds for this public
repository; npm does not generate provenance for a private repository, so a
private fork's publish silently omits it rather than failing.

Until a package is configured, or on a fork that doesn't own the
`foldedspacelabs` scope, npm answers the publish with a 404/403; the job
logs an `::notice::` naming the package and continues rather than failing
the release.

## The macOS app

`macos-app` (macos-14) runs `ops/release/build-app.sh` against the runtime
pack and runtime-deps pack this same run produced — the app never rebuilds
the product, so the DMG and `metistry update` ship the same bytes. There is
**no Xcode project**: SwiftPM compiles, and the bundle is assembled by
hand, the way the Swift TCC helpers are.

Then `ops/release/notarize.sh` submits, waits, staples and validates. Both
scripts run identically on the Studio, which is what makes a release
reproducible by hand — `docs/ops/mac-app.md`.

`APPLE_TEAM_ID` is **not** used by this path. It belonged to the
`xcodebuild archive` the old stub imagined (`DEVELOPMENT_TEAM=`); with no
Xcode project, the signing identity carries the team and `notarytool`
authenticates with the API key. The secret can stay set — nothing reads it.

## Auto-update

`appcast` signs the DMG with Sparkle's `sign_update` (from the pinned,
checksum-verified tools `ops/release/fetch-sparkle-tools.sh` fetches) and
renders the feed through `ops/release/appcast.mjs`. Called without a
signature that script emits a loud placeholder and exits non-zero, so a
misconfigured secret fails the job instead of publishing a feed every
installed app would reject.

**Sparkle and `metistry update` install the same DMG.** Either can move the
app, and neither undoes the other: `update` never downgrades an app Sparkle
already moved past the release it installs, and is a no-op (`app already
x.y.z`) when they agree. Doctor's `app` row reads the app's version against
`metistry.lock`.

One item per feed, not `generate_appcast`: that tool walks a directory of
past updates, and these updates live on GitHub Releases as one DMG per tag.
The app polls `releases/latest/download/appcast.xml`, which GitHub always
resolves to the newest release, so a single-item feed is the whole story.

**Both jobs skip cleanly** when their secrets are absent — a `::notice::`
and a release that still carries every other asset, exactly as the `images`
job behaves on a fork without `packages:write`.

## Verifying a release by hand

```sh
gh release download v0.2.0 -p 'metistry-runtime-*' -p checksums.txt
shasum -a 256 -c checksums.txt --ignore-missing
tar -tzf metistry-runtime-0.2.0-darwin-arm64.tar.gz | head
```

And the app, which Gatekeeper will answer for once it is stapled:

```sh
gh release download v0.2.0 -p 'Metistry-*.dmg' -p appcast.xml -p checksums.txt
shasum -a 256 -c checksums.txt --ignore-missing
xcrun stapler validate Metistry-0.2.0.dmg
spctl --assess --type open --context context:primary-signature -v Metistry-0.2.0.dmg
```
