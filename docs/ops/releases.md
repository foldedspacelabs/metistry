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
product's `VERSION`. That is what makes `metistry.lock`'s single
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

## What a release contains

| asset | what it is |
| --- | --- |
| `metistry-runtime-<version>-darwin-arm64.tar.gz` | the built product, for an Apple-silicon Mac |
| `metistry-runtime-<version>-linux-x64.tar.gz` | the same, for a Linux host |
| `checksums.txt` | `sha256sum` of every asset; `metistry update` verifies against it |
| npm `@foldedspacelabs/metistry-*@<version>` | published with provenance |
| `ghcr.io/foldedspacelabs/metistry-{console,assistant,reconciler}:<version>` | the app images compose pulls |

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
  PWA) and the Swift TCC helper binaries under
  `packages/mcp-*/helper/` when the pack was built on macOS
- `collectors/` and `routines/` with their per-directory manifests
- `node_modules/` — production dependencies only, which is why the pack
  is per os-arch
- `metistry-runtime.json` — version, target, build time

Left out on purpose: `src/`, tests, tsconfigs, Dockerfiles, `.git`. A
release is compiled output. `metistry update` never builds in release
mode, and `docker compose` only ever pulls.

The macOS app DMG is **not** built here — there is no app yet. The
`macos-app` and `appcast` jobs exist as disabled, documented stubs so the
shape of the work and the secrets it needs are on the record.

## Release notes

`ops/release/changelog.mjs` builds the release body from the
`CHANGELOG.md` files `changeset version` wrote: it takes each package's
section for this version, drops the fixed-mode `Updated dependencies`
churn and the commit-hash prefixes, deduplicates (one changeset touching
six packages reads as one line), and appends the packages, images and
assets. No second hand-written account to drift.

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
   pruned,
4. runs `db/migrations` from `current` under the advisory lock,
5. `docker compose pull && up -d --no-build` in `current`, with
   `METISTRY_CONSOLE_IMAGE` / `METISTRY_ASSISTANT_IMAGE` set to the
   versioned ghcr images,
6. kickstarts the launchd jobs whose code changed, writes `metistry.lock`
   through the reconciler, and runs `doctor`.

Because everything after the switch runs against `current`, going back is
a symlink flip:

```sh
metistry update --rollback
```

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
anonymous rate limit.

`--dry-run` in release mode reaches nothing — no GitHub call, no
download — so the version it prints is `<latest>`, the request rather
than a resolved tag.

## Secrets

Repo secrets, set in GitHub → Settings → Secrets → Actions. None of them
are in the repo, and none reach a build log.

| secret | used by | needed for |
| --- | --- | --- |
| `NPM_TOKEN` | `npm` job | publishing `@foldedspacelabs/metistry-*`. **Absent → the job says so and exits 0**; the rest of the release still happens (a fork does not own the scope) |
| `GITHUB_TOKEN` (automatic) | `images`, `publish` | pushing to ghcr.io and creating the release. Nothing to set; a fork whose `packages: write` is unavailable logs a notice and skips the image, rather than failing the release |
| `SPARKLE_PRIVATE_KEY` | `appcast` (stub) | the EdDSA key Sparkle's `sign_update` signs the DMG with. **Never** in the repo or an artifact. `ops/release/appcast.mjs` refuses to emit an unsigned feed |
| `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD` | `macos-app` (stub) | the Developer ID Application certificate, imported into a temporary keychain |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | `macos-app` (stub) | `xcrun notarytool submit --wait`, then `stapler staple` |

The Developer ID certificate is also what fixes the ad-hoc-signed TCC
helpers (D3: TCC bridges must be *stably* signed, or every rebuild
re-prompts for permission).

## The macOS app (not built yet)

`macos-app` is a stub with the sequence written down: import the cert →
`xcodebuild archive` with the hardened runtime, embedding the runtime pack
as `Metistry.app/Contents/Resources/metistry/` → DMG → codesign →
notarize → staple → upload. It is `if: false` until there is an app to
build.

## Auto-update (not wired yet)

`appcast` is the other stub. `ops/release/appcast.mjs` is real and tested
today: given the DMG's url, size and an EdDSA signature it renders the
Sparkle feed. Called without a signature it emits a loud placeholder and
exits non-zero, so a misconfigured secret fails the job instead of
publishing a feed the app would reject.

## Verifying a release by hand

```sh
gh release download v0.2.0 -p 'metistry-runtime-*' -p checksums.txt
shasum -a 256 -c checksums.txt --ignore-missing
tar -tzf metistry-runtime-0.2.0-darwin-arm64.tar.gz | head
```
