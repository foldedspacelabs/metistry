# @foldedspacelabs/metistry-cli

## 0.7.1

### Patch Changes

- 8679831: The Mac app DMG builds again: the bundled supervisor launcher lives in
  `Contents/Resources/` rather than `Contents/MacOS/`, where codesign demands
  a nested signature a shell script cannot carry (v0.7.0's DMG job failed
  sealing the app on it).
- b2b272a: `metistry up` now pins the calendar and apple-fm TCC bridge jobs at their
  signed helper bundles on every run, not only `migrate-shape`. A release
  carries no built helper `.app` (`pack-runtime.sh` ships the sources, not
  the gitignored build output), so a release install's `up` used to
  re-render the calendar plist and rewrite `supervisor.json` pointing at a
  bundle the release does not have — silently un-pinning both bridges the
  next time `up` ran after `migrate-shape launchd` had pinned them. The pin
  (`TCC_HELPERS`, `pinTccHelpers`, `pinSupervisorChild`) moved to its own
  module, `packages/cli/src/tcc-pin.ts`, so `up` can call it right after
  writing the calendar plist and `supervisor.json` and before bootstrapping
  either — no extra kickstart. `migrate-shape` keeps calling it too, after
  its own restore, idempotently.
- @foldedspacelabs/metistry-core@0.7.1

## 0.7.0

### Minor Changes

- cf3aa96: Move a LIVE install between the two deployment shapes, with its data, in one
  reversible verb — `docs/ops/migrate-compose-to-launchd.md` is the runbook.
  
  - **`metistry migrate-shape launchd`** quiesces the console and the assistant,
    `pg_dump`s the live database through the running `db` container to
    `<instance>/state/migrate/<ts>.dump` and **verifies it with `pg_restore
    --list` before stopping anything**, `docker compose stop`s (never `down -v`
    — the containers and the volume are the rollback), writes `deployment.yaml`
    through the reconciler as the `user` principal, runs `up`, `pg_restore`s
    **before any migration runs** (the dump carries `schema_migrations`, so the
    next `metistry update` applies none), compares every table's exact row count
    and fails by name if one lost rows, and ends with `doctor` — after waiting
    for the console and the reconciler to answer, so the verdict is not a race.
    `--dry-run` prints the whole plan and runs nothing.
  - **`metistry migrate-shape compose`** is the documented rollback. The compose
    volume still holds the database as it was at the cutover; anything written
    under `launchd` since is not copied back, and the verb prints the `pg_dump`
    command for it.
  - **Four refusals, all while the old shape is still running and nothing has
    changed**: no bundled `runtime/`; no `ops/sandbox/assistant.sb` in the
    product tree (any pack before v0.6.0 — the assistant's launchd job could not
    start at all); no `pg_dump`/`pg_restore`/pgvector; and a namespaced instance
    whose docker compose project is not namespaced, which would have stopped
    ANOTHER install's containers.
  - **The TCC bridges keep their grant.** A runtime pack ships no built
    `ek-helper.app`/`afm-helper.app`, so the migration pins those two jobs at the
    Developer-ID-signed bundles that already hold the Calendars/Reminders grant —
    same bundle id and certificate chain, so the same TCC designated requirement
    and no re-grant. Shipping prebuilt signed helpers in the pack is the recorded
    follow-up.
  - **Five defects the rehearsal found**, each of which passed a green test suite
    first: a row-count query using `query_to_xml`, which the bundled Postgres
    (built without libxml) cannot execute; rows written into the gap between the
    dump and the stop; a bridge plist re-render that dropped a namespaced
    instance's ports and sent it looking for the default install's; a hand-rolled
    `bootout`/`bootstrap` that hit the same asynchronous-teardown race PR #117
    fixed for `up`; and a closing `doctor` that raced the jobs it had just
    kickstarted.
- f6c0eee: **One background item, and it is called Metistry.** macOS shows one background
  item per launchd agent, named after its program, so the launchd shape used to
  introduce itself in System Settings as "postgres", "node", "node", "node" —
  `sfltool dumpbtm` said `Executable Path: /bin/sh` four times over. Under that
  shape the core is now a single agent, `com.foldedspacelabs.metistry`, whose
  program is a symlink named `Metistry`.
  
  - **The watchdog grew into the supervisor.** It runs Postgres, the console, the
    reconciler, the assistant (still rooted at `sandbox-exec`, same profile, same
    parameters — proved live: a vault read denied, a write outside the state dir
    denied, a write inside allowed, its own console and db allowed, another
    install's console and reconciler denied) and any configured bridge as its
    children, with ordered start behind a readiness probe (Postgres answers →
    console → the rest), per-child exponential backoff, crash-loop detection that
    is *reported* rather than hammered, per-child logs at the same
    `/tmp/metistry-<service>.log` paths, and SIGTERM-then-SIGKILL in reverse
    order. Its probes and presence feed are unchanged and in the same process —
    invariant 3's sole exception did not move.
  - **`metistry restart|stop|start <service>`** reaches those children over a
    0600 unix socket in the instance's state dir, because launchctl cannot
    address a process launchd has never heard of; launchctl stays for the
    supervisor and the TCC helpers. Requests are authenticated with a token
    anyway (invariant 8), and the misuse tests ship with the interface. `doctor`
    asks the supervisor for a row per child.
  - **Everything macOS shows carries the Metistry name.** The EventKit helper's
    agent is `com.foldedspacelabs.metistry.calendar` and its bundle is displayed
    as "Metistry Calendar Access"; the Apple FM helper's is "Metistry Apple
    Intelligence". Their **bundle identifiers and signing identifiers are
    untouched** — TCC keys a grant on bundle id plus certificate chain, so no
    install has to consent again.
  - **A running install migrates in place.** `metistry up` boots out the
    pre-supervisor agents once and deletes their plists before installing the
    supervisor, so nothing runs twice; `migrate-shape launchd` produces the new
    set directly. The compose shape is untouched apart from that one rename.
  - **A bridge is installed only when it is configured** (its `METISTRY_*_URL` is
    set) — the signal `doctor` already read, and the end of "`up` installs every
    plist in `ops/launchd` regardless".
  - **`metistry up --register-via app`** leaves the one agent to the Mac app,
    which registers the copy embedded in its bundle through
    `SMAppService.agent(plistName:)` — what nests it under the app in Login Items
    instead of listing it beside.

### Patch Changes

- fc55edc: Fix a `migrate-shape` defect that took production down on 2026-09-10: the
  rollback (`metistry migrate-shape compose`) did not wait for the `launchctl
  bootout` of `db`/`console`/`assistant` to actually finish, nor for the
  bundled Postgres to let go of its port, before calling `docker compose up` —
  which lost that race with `ports are not available … address already in
  use` and exited 1 with the install completely down (no launchd jobs, no
  compose containers).
  
  - Both directions now wait properly: the rollback reuses `up`'s
    wait-for-label-gone helper after each `bootout`, then polls `pg_isready`
    until the bundled Postgres stops answering, before touching compose.
  - Both directions now compensate a failed `up`: the rollback restores the
    launchd jobs it just booted out (bootstrap + kickstart the plists still on
    disk) and flips `deployment.yaml` back to `launchd`; the forward migration
    brings the compose stack back up and flips `deployment.yaml` back to
    `compose`. Either failing now leaves the install exactly as it was, never
    with nothing running.
  - A second forward run after a rollback now works: a leftover
    `<instance>/state/pg` (from the earlier restore) is moved aside to
    `state/pg.<ts>.stale` — never deleted — before `up`, so `initdb` runs fresh
    and `pg_restore --exit-on-error` lands in an empty schema.
  - `docs/ops/migrate-compose-to-launchd.md` documents the `.stale` directory
    and adds a "what a failed rollback looks like and how to recover" section
    with the exact by-hand recovery command.
- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0

## 0.6.0

### Minor Changes

- 4afd5eb: Four small verbs so the Mac app can stop parsing files itself and front the
  CLI instead (docs/ops/cli.md, docs/product/desktop-app-plan.md):
  
  - `metistry identity [--json]` — identity.yaml as the CLI understands it
    (name, mention, voice, icon, instance_id), resolving `--instance`/
    `METISTRY_INSTANCE_DIR` like every other instance verb. Read-only.
  - `metistry --version` / `metistry version [--json]` — this binary's own
    package version (always); the resolved product dir's own package.json
    version; the instance's `metistry.lock` pin + channel; and, for a release
    install, `metistry-runtime.json`'s version, commit and build time. Each
    field is reported only as far as it resolves.
  - `metistry secrets list --json` — the same rows the table shows (name,
    scope, keychain account found under, set/unset), values never.
  - `metistry deployment [--json]` — the effective shape (deployment.yaml's D4
    overlay) and the services it implies, each tagged with its running state
    via the same cheap `launchctl print`/`docker compose ps` checks `doctor`
    itself uses (never the full `doctor`, which also probes bridges over
    HTTP).
  - `metistry deployment set-shape <compose|launchd> [--yes] [--force]` —
    writes the instance's deployment.yaml through the reconciler as the `user`
    principal, exactly like `metistry.lock`/`identity.yaml` (a §4.7 protected
    path). Preview-then-confirm: without `--yes` nothing is written; refuses
    while `db`/`console`/`assistant` are still running under the current
    shape unless `--force` (the data does not move between shapes on its
    own) — `reconciler`/`watchdog` running is never a reason to refuse, since
    they are host jobs under either shape.
- 410dcce: The console's **local owner token** (`docs/ops/auth.md`), so the Mac app and
  the CLI authenticate to a console on this machine without a passkey
  ceremony — they are the same package, on the same filesystem, running as the
  same person.
  
  - `Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN` yields the `user` principal,
    the same one a passkey session yields, through the same `isUser()`
    predicate — but **only** when the connection's peer address is loopback.
    The decision comes from the socket; `X-Forwarded-For`, `Forwarded`,
    `X-Real-IP` and `Host` are never read. From anywhere else it is a 401
    byte-identical to an unknown token's, plus a `runs` audit line naming the
    address. Constant-time comparison; misuse tests ship with it.
  - Compose NATs a host-loopback connection to the bridge gateway, so
    `METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is told: the compose
    file sets the sentinel `docker-gateway`, resolved at startup from the
    container's own default route. The gateway address only — a sibling
    container is still remote. Unset (launchd) = plain loopback.
  - `GET /api/whoami` → `{principal, via, management, origin, as_of}`.
  - `POST /auth/logout` and `/api/push/*` stay passkey-session-only: they act
    on a device session row. A host-minted `owner_tokens` row (the capture
    Shortcut) is unchanged — capture-only, any address.
  - `METISTRY_ORIGIN` may be a comma-separated list (`expectedOrigin` takes an
    array in @simplewebauthn v13); the first entry stays canonical. An origin
    mismatch, which used to escape as HTTP 500, is a 401 naming expected vs
    presented.
  
  CLI: `METISTRY_LOCAL_OWNER_TOKEN` joins `SECRET_SCOPES` as instance-scoped;
  `metistry init` mints it into the `.env` lines it prints; `secrets sync --to
  env` mints one for an install that predates it (`GENERATED_SECRETS`, the
  same "generated, so minting cannot be the wrong guess" rule as `up`'s DB
  password); `metistry console whoami [--json]` prints the principal — what
  the app calls to show "signed in as owner"; and `metistry doctor`'s console
  row now presents the token, so `api_status` is a real authenticated read
  (a refused token degrades rather than fails).
- 0281c41: Prove the Docker-free macOS shape (decision 15), and settle where a bundled
  install's writable product dir lives.
  
  - **`metistry runtime install --from <Metistry.app> [--to <dir>]`** — a signed
    bundle's `Contents/Resources/metistry/` is a SEED; the product dir is a
    writable copy of it at `~/Library/Application Support/Metistry/product/`, so
    `metistry update --channel release` works on an app install exactly as it
    does on a checkout. Idempotent, verified against the pack's own
    `metistry-runtime.json` and `runtime/manifest.json`, whose sha256s land in
    `.metistry-install.json`.
  - **`metistry up --namespace`** — a second instance can run on one Mac. One
    file, `<instance>/state/ports.yaml`, allocated once, carries this instance's
    launchd label suffix and an 8-port block; `up`, `doctor`,
    `restart|stop|start`, `logs` and `update` all read it.
  - **The launchd jobs exec the bundled Node** when the install has one, rather
    than whatever `$(which node)` found.
  - **Five fixes the live trial found**: a space in the install path broke every
    `sh -c` job (the app's default location has one); `up` now refuses a
    `state/.env` whose values `sh` would misread; the assistant's sandbox gained
    a rule for Postgres, without which the engine could never start under this
    shape; `up` waits out `launchctl bootout`'s asynchronous teardown instead of
    racing it; and a namespaced instance's ports now reach the dotenv-sourcing
    jobs and `metistry update`'s migration runner — which would otherwise have
    migrated the default install's database.
  - The release runtime pack now ships `ops/sandbox/`, without which the launchd
    shape's assistant job cannot start at all.

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Minor Changes

- 1ca8337: An instance directory is self-contained: `.env` moves to
  `<instance>/state/.env`, `identity.yaml` carries a minted `instance_id`, and
  Keychain items are scoped per instance.
  
  - `--instance <dir>` and `--env-file <path>` on every verb. The environment is
    read from `<instance>/state/.env` first, then the product checkout's `.env` —
    deprecated, still read (with a notice on stderr), and still where a terminal
    install may declare `METISTRY_INSTANCE_DIR`.
  - `metistry secrets sync --to env` performs the move: every line of the old
    file is carried over and the old file is left in place.
  - `SECRET_SCOPES` (secrets.ts) is the one table saying whether a secret is
    filed under the instance's `instance_id` or the per-user account.
    Instance-scoped values found only under the user account are copied across,
    never deleted. `secrets list` gains a scope column.
  - New `metistry secrets purge --instance <dir> [--yes]`: preview-then-confirm
    deletion of one instance's Keychain items, incapable of touching user-scoped
    ones.
  - The `sh -c` launchd plists gain an `__ENV_FILE__` placeholder and
    `docker compose` is invoked with `--env-file`, so both read the instance's
    file rather than the checkout's.
- 99473d3: `metistry restart|stop|start [<service>…]` and `metistry logs <service>
  [--lines N] [--follow]` — the CLI can now act on individual services in
  either deployment shape (launchctl kickstart/bootout/bootstrap on the
  launchd shape, `docker compose restart|stop|start|logs` on the compose
  shape), reusing `up`'s own knowledge of which services are host jobs vs.
  containers rather than a second table. No args = every service the current
  shape runs; `--json` on `restart`/`stop`/`start` prints
  `[{service, action, ok, detail}, …]` for the Mac app's menu bar, which now
  calls these verbs instead of shelling out to launchctl/docker itself. An
  unknown service name fails with the list of known ones.

### Patch Changes

- e23df1b: The Mac app gets Settings, a first-launch wizard, and a menu bar worth
  opening. Settings lives in the `Settings` scene (⌘, and the app menu) with
  six panes, and every value on them is a front for a file the CLI owns — the
  app persists three pointers (active instance, recents, a developer runtime
  override) and no configuration, asserted by a test over its whole defaults
  domain. The product-directory preference is gone: a shipped app's product is
  the runtime inside its own bundle. The wizard replaces the "First run" tab
  group with a sheet over the same seven steps, Back/Continue/Skip, every
  choice stating what it gets you and what it costs. The menu bar groups
  components by doctor's own `kind` with Restart/Stop/Start/View Log per
  component and Restart All/Stop All above them, refreshing on open and every
  30s while open. The lifecycle verbs (`restart`, `stop`, `start`, `logs`) land
  separately; until they do the app says "this CLI has no `restart` verb yet —
  update it" rather than reporting a failed restart.
- a6b82f1: The Mac app DMG notarizes: `build-app.sh` re-signs every Mach-O it embeds
  from the runtime packs under the Developer ID (hardened runtime, timestamp,
  `get-task-allow` stripped from Node's entitlements) and audits the bundle
  before packaging; `notarize.sh` reads Apple's status instead of trusting
  `notarytool`'s exit code, and prints the submission log when it is not
  Accepted. Signing retries through Apple's timestamp-server flakes.
- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- 6b8b214: `metistry update --channel release` now pins `metistry.lock`'s
  `product.commit` to the commit the installed runtime pack was actually
  built from, read from that pack's own `metistry-runtime.json` — release
  mode never does a git pull, so there was no HEAD to read, and the lock
  previously kept whatever commit the prior release had pinned even after a
  version bump. A pack built before this field shipped (0.3.0, 0.3.1) falls
  back to the prior lock's commit rather than fabricating one.
- 3d36953: The Mac app ships as a release asset. A signed, notarized `Metistry-<version>.dmg`
  and an EdDSA-signed `appcast.xml` now come with every release, so the app can be
  downloaded from GitHub Releases and update itself from there. Inside it: a Status
  panel that is `metistry doctor` at a glance with a menu-bar glyph for the worst
  fault, and a first-run flow that walks the install — locate the runtime, create
  the instance, connect a GitHub repo by device flow, sync secrets to the Keychain,
  bring the services up — showing the exact `metistry` command before it runs each
  one. Nothing in the app talks to Postgres or git: it runs the same CLI the
  terminal does.
- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0

## 0.3.1

### Patch Changes

- 588e69a: Release images are built for `linux/amd64` and `linux/arm64`. v0.3.0's
  `ghcr.io/foldedspacelabs/metistry-*` images were amd64-only, so `metistry
  update --channel release` on an Apple-silicon Mac failed at `docker compose
  pull` with "no matching manifest for linux/arm64/v8". The Dockerfiles' build
  stage now runs natively on the CI host (`--platform=$BUILDPLATFORM`; the
  compiled output is pure JS) and only the runtime stage is per-architecture.
- 9a2a90f: `metistry update --channel release` downloads release assets (the runtime
  pack, the runtime-deps pack, `checksums.txt`) through GitHub's authenticated
  asset API when `METISTRY_GITHUB_TOKEN` is set — the one path that reads a
  private repo's assets with a token; `browser_download_url` 404s there. The
  302 to the signed S3 URL is followed without resending the token. A 404 on
  download falls back to `gh release download`, as an unauthorised resolve
  already did.
- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Minor Changes

- 1e4eaae: The runtime ships with the product. A release now carries
  `metistry-runtime-deps-<version>-darwin-arm64.tar.gz` — Node, a relocatable
  Postgres 17 + pgvector built from source, and a minimal git — built by
  `ops/release/build-runtime-deps.sh` with every version and source sha256
  pinned in one file, and verified from a *moved* copy of the tree before it is
  packed. `metistry update --channel release` installs it alongside the runtime
  pack, and `metistry up` on the launchd shape fetches it when no Postgres
  exists anywhere; both go through the same checksums.txt verification as the
  product pack, and `METISTRY_RUNTIME_DEPS=0` keeps them off the network.
  `METISTRY_PG_BIN` resolution finds `runtime/postgres/bin` as before, and the
  reconciler's launchd job gets `runtime/git/bin` on the front of its PATH — so
  a clean Mac needs neither Homebrew nor Xcode Command Line Tools.
- 92dd868: Session summaries as a capture source (stash review item 2). `core` gains a
  deterministic Claude Code transcript summariser — turns, duration, files
  touched, tools with counts, models, first prompt and last response, both
  clipped — plus the `kind: session` note it renders and a content-derived
  `idempotency_key`. `cli` gains `metistry import-sessions [--since] [--project]
  [--limit] [--dry-run]`, which posts those summaries to `/capture` from the
  host, skipping anything a ledger at `~/.metistry/imported-sessions.json`
  already sent. No model is called on either side, and a transcript is never
  posted — only its summary.
- Knowledge fold (the evening turn that turns accepted items into Journal and entity pages), `import-sessions` and `kind: session` captures, `knowledge_list`/`knowledge_grep` and vault notes as MCP resources under one scope helper, the simplified vocabulary (22 primary tools with call-time aliases; Approve / Revise / Decline; Auto / Supervised), cost discipline ((model, effort) tiers, session roll at task boundaries, cache read/write metrics and a prompt lint), the bundled runtime build (Node, Postgres 17 + pgvector, git — signed), TCC helpers as signed app bundles whose grants survive rebuilds, Sparkle tooling pinned, npm Trusted Publishing, and the GitHub OAuth App shipped as the default for `connect-repo`.

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

## 0.2.0

### Minor Changes

- fe1f062: Two install verbs, terminal-first (the Mac app will drive the same ones):
  `metistry connect-repo <url>` sets the instance repo's origin, obtains a
  git credential the reconciler can push with unattended (GitHub device
  flow, a PAT on stdin, or an ssh key) into the macOS login Keychain,
  verifies with `ls-remote`, flushes the reconciler's queue and pushes; and
  `metistry secrets sync|mint|list` makes the login Keychain the canonical
  store (`metistry:<VAR>`) with `.env` generated from it. No secret reaches
  argv, output, or `.git/config`.
- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).
- d381a45: Release pipeline: a `v*` tag now builds the product's versioned artifacts on
  GitHub Releases — a runtime pack per os-arch, npm packages with provenance,
  container images, and `checksums.txt`. `metistry update` gains a release mode
  that resolves a release, verifies its sha256 before unpacking, switches a
  `current` symlink and keeps the previous release for `--rollback`;
  `metistry init --channel release` writes that mode into `metistry.lock`.

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
