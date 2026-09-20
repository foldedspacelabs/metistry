# Reconciler — the instance repo's sole committer and vault bridge

`apps/reconciler` (plan §6 D5, ratified 2026-09-06) is the **only process
that holds the instance repo's working tree and the only place git runs.**
Everything else — the console, `mcp-brain`, the assistant engine, a
stranger's agent — reaches the vault over HTTP through its **vault bridge**
(§4.3 wire contract: per-caller bearer, uniform error envelope, `check()`).
Nothing shares a filesystem with it (invariant 7), no git credential ever
enters a container, and the engine keeps having no shell and no git
(invariant 9).

It also owns §4.13 change detection: the index in `knowledge_files` /
`knowledge_links` is rebuilt from the working tree by content hash (never
mtime — sync churns mtime), renames are recognised by hash, and Obsidian /
Syncthing conflict copies are flagged once as a `proposals` report instead
of being indexed.

The same walk keeps the **vault inbox** honest. `Inbox/` is where
captures live (`docs/ops/inbox.md`), and a file you put there yourself — in
Obsidian, in an editor, with a `git pull` — gets an `inbox` row like any
capture; an edit to one that is already there refreshes its hash and sends
it back to the drain; a deleted file archives its row. It lives here
because this is already the process that walks the tree and hashes it.

## Pointing it at an instance repo

The reconciler needs exactly one path: `METISTRY_INSTANCE_DIR`, the working
tree of the instance repo (§4.16 — the vault root, `.metistry/identity.yaml`,
…). It is
configured entirely from the product checkout's `.env`:

```sh
METISTRY_INSTANCE_DIR=/Users/you/metistry-instance   # the ONLY process that holds it
METISTRY_BRIDGE_TOKEN_RECONCILER=<mint one>           # every caller presents this
METISTRY_RECONCILER_URL=http://host.docker.internal:7812   # how the console container reaches it
```

Mint the token the same way as the other bridges:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then build and install the launchd job (macOS; the same template as the
watchdog). `metistry up` does this for every plist in `ops/launchd`
(`docs/ops/cli.md`); by hand it is:

```sh
pnpm -r build
sed "s|__REPO__|$PWD|g; s|__NODE__|$(which node)|g" ops/launchd/com.foldedspacelabs.metistry.reconciler.plist \
  > ~/Library/LaunchAgents/com.foldedspacelabs.metistry.reconciler.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.foldedspacelabs.metistry.reconciler.plist
curl -s -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER" http://127.0.0.1:7812/check
```

`check()` probes behaviour, not configuration: the repo is present, git
runs, `HEAD` is readable, `.metistry/` lists, and it reports the commit
queue depth plus the last flush / push / reconcile. `degraded` with a
remediation string means "it runs but something needs your hand" (no
commits yet, `.metistry/` missing, last push failed).

Restart the console (`docker compose up -d console`) so it picks up
`METISTRY_RECONCILER_URL`; `mcp-brain`'s `knowledge_read` then serves note
contents instead of `not_available`.

On Linux there is nothing TCC-bound here, so it runs as a container with
the instance repo on a volume: `docker build -f apps/reconciler/Dockerfile .`
and mount the repo at `/data/instance` (the image's default
`METISTRY_INSTANCE_DIR`).

## Creating an instance repo

`metistry init` stamps it from `seed/` (§4.16; `docs/ops/cli.md`):

```sh
npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "Athena"
# or, inside the checkout after pnpm -r build:
node packages/cli/dist/main.js init ~/metistry-instance --name "Athena"
```

That is the `git init -b main` + a starter vault (`Journal/`, `Areas/`,
`now.md`, …) + `.metistry/` (`identity.yaml` — the only place the assistant
is named — `rules.yaml`, config dirs, `metistry.lock`) + `.gitignore` + one
`Instance created` commit the 2026-09-06 bootstrap did by hand
(`docs/ops/instance-layout.md` has the full tree). It ends by printing the
three `.env` lines above — the `METISTRY_BRIDGE_TOKEN_RECONCILER` it shows
is minted once and written nowhere, so copy it then. Add a private remote
whenever you like — `metistry connect-repo <url>` sets `origin`, leaves a
credential this service can push with unattended (macOS Keychain; a
confined reconciler reads it through `GIT_ASKPASS` rather than the
`osxkeychain` helper — "Pushing while confined" below), flushes this queue
and pushes once
(`docs/ops/cli.md`); push from then on is best-effort on the schedule
below.

Point Obsidian at the instance directory itself as the vault root — the
same directory git treats as the repo root. `.metistry/` is a dot-folder,
so Obsidian ignores it without any configuration.

## The bridge

Every route requires `Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER`
(loopback is not a trust boundary — CRIT-9). Errors are the core envelope
`{ "error": { "code", "message" } }` with the usual status mapping
(401 unauthenticated, 403 forbidden, 404 not_found, 400 invalid_request,
409 conflict, 503 not_available).

| Route | What it does |
| --- | --- |
| `GET /check` | behavioural probe (frozen `check()` shape) |
| `GET /vault/read?path=` | `{path, content, sha256, bytes}` from the working tree; `&encoding=base64` returns `content_base64` instead (binary artifacts) |
| `GET /vault/list?prefix=&depth=` | files + dirs under a prefix (`.git`, `.obsidian`, `.metistry` never listed) |
| `GET /vault/search?q=&limit=&mode=` | search over **settled** notes — `status: draft` and conflict copies are excluded before matching. `mode` is `keyword`, `semantic` or `hybrid`; omitted, it is `hybrid` once embeddings exist and `keyword` before that (docs/ops/knowledge-search.md) |
| `GET /vault/log?path=&limit=` | `git log --follow` for a path (or the repo) |
| `GET /vault/diff?path=&from=&to=` | unified diff between revisions; `to` absent = the working tree |
| `POST /vault/write` | `{path, content \| content_base64, intent, expected_sha256?}` — compare-and-swap on the content hash |
| `POST /vault/delete` | `{path, intent, expected_sha256?}` |
| `POST /vault/rename` | `{from, to, intent}` — git-mv semantics; never clobbers |
| `POST /flush` | commit the queue now (the interval does this every `METISTRY_COMMIT_INTERVAL_SEC`; the artifacts module calls it after every publish so one version is one commit) |
| `POST /reconcile` | run the index cycle now (the interval does this every `METISTRY_RECONCILE_INTERVAL_SEC`); the summary carries `inbox: {added, changed, archived}` |
| `POST /embeddings/rebuild` | forget every vector and re-embed the vault under the configured model (§6 decision 8's deterministic rebuild) |
| `GET /embeddings/status` | what is stored: model, dim, row count, how many notes are behind, whether a rebuild is required |

**Intents.** Every mutation carries
`intent: { principal, message, group? }`. `principal` is a lowercase slug
the *caller* is trusted for (the console stamps it from the credential;
the engine's `brain-commit` passes `assistant`). It becomes the commit
author — `Metistry <principal>` (prefix from `METISTRY_GIT_AUTHOR_NAME`),
stamped server-side; a request cannot name an author. `group` batches
several writes into one commit; absent, the principal is the group.

**What the tool refuses, for everyone:** `..`, absolute paths, drive
letters, control characters, any `.git` segment, anything under
`.metistry/instance-migrations/`, any symlink component, a case-mismatched
prefix (`areas/` when `Areas/` exists — macOS would silently comply, a
Linux container would fork the tree), and content over
`METISTRY_VAULT_MAX_BYTES`.

`Inbox/` is ordinary vault content, not a protected path:
listable and readable like the rest of the vault, writable through this
bridge by the capture principal and the assistant alike.

**What only the `user` principal may write (§4.7 protected paths):**
everything under `.metistry/` except `.metistry/state/` —
`.metistry/identity.yaml`, `.metistry/rules.yaml`, `.metistry/sources.yaml`,
`.metistry/deployment.yaml`, `.metistry/metistry.lock`, and everything
under `.metistry/queries/`, `.metistry/agents/`, `.metistry/routines/`,
`.metistry/extensions/` — plus root `CLAUDE.md` and `README.md`. Every
other principal gets a uniform `forbidden`.

**Compare-and-swap.** Send `expected_sha256` (from a prior read) to refuse
a write over content you have not seen (`409 conflict`); the empty string
means "must not exist yet". Omit it to overwrite unconditionally.

**Visibility vs. commit latency.** A write lands on the working tree
atomically and is readable by the next request; the commit happens on the
next flush. Readers never wait on git.

## The committer

The queue flushes every `METISTRY_COMMIT_INTERVAL_SEC` (default 30):
one commit per `(principal, group)`, staged with `git add -A -- <touched
paths>` so nothing else rides along, message from the intents (first as
subject, the rest as bullets), a `Brain-Source: <principal>` trailer
(§4.7 — provenance for reading history, never an authorization signal).
A failed commit is unstaged and retried on later flushes; all-or-nothing
per commit. Push runs on `METISTRY_PUSH_SCHEDULE` (`@hourly` default) only
if a remote exists and never blocks anything; a failed push shows up in
`check()` as `degraded`.

**Edits made outside the bridge** — Obsidian on your phone, a text editor
on the Mac — are swept by the reconcile loop into one `user` commit
(`group: sync`), because the reconciler is the only thing that can commit
them (PoC-12: "edit on iPhone → commits cleanly"). Paths with a pending
bridge intent belong to that intent; conflict copies are flagged, not
committed. Turn the sweep off with `METISTRY_COMMIT_EXTERNAL_EDITS=false`.

Those edits are also **never overwritten**. Every caller's write is
compare-and-swap: captures go in with `expected_sha256: ""` (must not
exist), and `knowledge_write` sends a hash on every call — omitted means
create-only — so a note that changed under an agent comes back `409
conflict` rather than being replaced by bytes the agent never read
(`docs/ops/inbox.md`, `docs/ops/assistant-tools.md`).


## Confinement (the `launchd` shape)

Since 2026-09-19 the sole committer runs under a Seatbelt profile,
`ops/sandbox/reconciler.sb`, applied by `metistry up` as the job's root
process — so git, and all 172 of its own helper binaries, inherit it. D5
stops being a design intention and becomes something the kernel enforces.

| | |
| --- | --- |
| **writes** | the instance repo (the vault, `.metistry/`, `.git/`) and the temp dir. **Nothing else** — not `~/Documents`, not `~/.ssh`, not the product checkout, not another instance's vault. |
| **reads** | the product checkout, the node runtime, a real git's installation prefix, system frameworks, and `~/.gitconfig` **by name**. |
| **execs** | node, that git, and the askpass shim `up` generates. **No shell.** |
| **dials** | the console, Postgres and the on-machine embedder on loopback, plus the supervisor's egress proxy — the one route off this machine. |
| **binds** | its own bridge port, and no other. |

`metistry up` prints the profile it will use (and `--dry-run` prints it
without installing anything); `metistry doctor` carries a `sandbox` row
naming every confined child and the profile each one actually runs under,
read back out of `supervisor.json`'s argv.

**`/usr/bin/git` is not a git.** It links against `libxcselect.dylib` — it is
the xcode-select shim, and under a profile it dies trying to open
`/Applications/Xcode.app/…/libxcrun.dylib`. So `up` resolves a **real** git
by absolute path: the bundled `runtime/git` first
(`docs/ops/bundled-runtime.md`), then a non-shim git on PATH, then
`/Library/Developer/CommandLineTools/usr/bin/git`. On a Mac with none of
them `up` declines to confine the job and says so — a reconciler that cannot
run git is not a reconciler.

### Pushing while confined

**HTTPS push works.** The path is `GIT_ASKPASS`, and it exists because of a
measurement: git executes *every* credential helper through `/bin/sh` —
including the built-in `osxkeychain` that `metistry connect-repo`
configures — and this profile has no shell, so a confined push used to die
before it began:

```
fatal: cannot exec 'git credential-osxkeychain get': Operation not permitted
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

Granting `/bin/sh` would not even have been enough (macOS's `/bin/sh`
re-execs `/bin/bash`), and granting the sole committer a shell is the thing
the profile exists to prevent. But **`GIT_ASKPASS` is exec'd directly, by
absolute path, with no shell** — the exec allowlist is its only gate. So:

| | |
| --- | --- |
| **where the token lives** | unchanged: the login Keychain, where `metistry connect-repo` put it. No token in `.env`, none in a URL, none in `.git/config`. |
| **who reads it** | the **supervisor**, once, at spawn. It is unconfined and it is the parent. The read is promptless because `connect-repo` files the item with `-A` — a trade already made and documented in `packages/cli/src/keychain.ts`, because per-binary trust is invalidated by every git update and would turn an unattended push into a GUI prompt nobody is there to click. |
| **how it reaches git** | the child's environment, as `METISTRY_GIT_ASKPASS_{USER,TOKEN}`, and then a `#!<node>` shim `up` generates at `<instance>/.metistry/state/bin/git-askpass` which prints one of those two and can do nothing else. **Never in argv** — `ps` shows argv to every process on the Mac, and a push runs every hour. |
| **what `up` records** | `supervisor.json` gains `gitCredentials: [{ child: "reconciler", host: "<your remote's host>" }]` — which item to fetch, never what it holds. |
| **the helper** | reset for this job with `-c credential.helper=` (git's documented reset), so the repo's `osxkeychain` line cannot fail first. An **unconfined** install is untouched and keeps using the Keychain helper exactly as before. |

Proven end to end by `packages/cli/test/reconciler-push.test.ts`: a real
push to a real bare repository over real HTTPS, through the CONNECT tunnel,
under `sandbox-exec` — and the same push, without the reset, failing on
`osxkeychain`.

If the supervisor finds no keychain item it says so in its log and the child
starts anyway; the push then fails with `could not read Username`, and
`metistry connect-repo <url>` files one.

**SSH remotes are still unsupported while confined.** `/usr/bin/ssh` is not
exec-able under the profile. Allowing it would mean granting the process
that holds the vault's working tree read access to `~/.ssh` — the owner's
private keys — and ssh's `ProxyCommand` runs through a shell, so it could
not reach the egress proxy either. Use an HTTPS remote, or the off switch:
`METISTRY_RECONCILER_SANDBOX=0` in `<instance>/.metistry/state/.env`, then
`metistry up`. The job then runs under `ops/sandbox/unconfined.sb`
(`(allow default)`), and doctor's `sandbox` row says so. `up` warns when it
sees an SSH remote.

**HTTP(S) goes through the egress door.** The profile denies every outbound
destination but the supervisor's loopback CONNECT proxy, whose allowlist is
derived from this repo's own remotes (`docs/ops/deployment-shapes.md`, "The
egress door"). `up` sets `METISTRY_GIT_HTTP_PROXY`, and `git.ts` turns it
into `-c http.proxy=…` — explicitly, because this process builds a minimal
environment per git call and would not otherwise pass `HTTPS_PROXY` through.
A remote the allowlist does not name comes back as:

```
fatal: unable to access 'https://elsewhere.test/r.git/': CONNECT tunnel failed, response 403
```

…and with no proxy configured at all, the profile itself refuses:

```
fatal: unable to access 'https://github.com/…': Failed to connect to github.com port 443 after 1 ms: Couldn't connect to server
```

An `http://` remote cannot work at all: the proxy speaks CONNECT only, and
`connect-repo` already refuses one for the older reason that a credential
would cross the network in clear text.

Under the `compose` shape none of this applies — there is no profile and no
proxy.

## Embeddings (Phase 6)

Every reconcile cycle also brings the vault's **vectors** up to date, in
the same process that owns the index — one component reads the working
tree, so the chunk text and the content hash cannot disagree.

A note is *behind* when `knowledge_files.embedded_hash` is not its current
`content_hash`, or `embedded_model` is not the configured model. The cycle
embeds behind notes (up to `METISTRY_EMBED_MAX_FILES_PER_CYCLE`), and sets
the marker only after every chunk of that note is stored — so an
interrupted cycle retries exactly that note next time instead of leaving a
note half-indexed.

- drafts (`status: draft`) and sync-conflict copies are never embedded, and
  lose any vectors they had;
- a **rename** re-keys the rows (same bytes, no embedder call at all);
- a delete removes them.

**It degrades, always.** Ollama being down is not an outage: the cycle
finishes, the index is correct and complete, `GET /check` reports
`degraded` with `ollama serve` / `ollama pull`, search falls back to
keyword, and the notes catch up on a later cycle. Nothing fails.

`POST /reconcile` returns the counts (`embeddings: {files, chunks, reused,
deleted, pending, degraded}`), and each cycle is one `runs` row carrying
the same numbers.

Setup, modes, and what "deterministic rebuild" means:
**docs/ops/knowledge-search.md**.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `METISTRY_INSTANCE_DIR` | — (required) | instance repo working tree |
| `METISTRY_BRIDGE_TOKEN_RECONCILER` | — (required) | bearer callers present |
| `METISTRY_RECONCILER_HOST` | `127.0.0.1` | bind address (loopback by default, invariant 8) |
| `METISTRY_RECONCILER_PORT` | `7812` | |
| `METISTRY_COMMIT_INTERVAL_SEC` | `30` | queue flush cadence |
| `METISTRY_RECONCILE_INTERVAL_SEC` | `300` | index cycle cadence |
| `METISTRY_PUSH_SCHEDULE` | `@hourly` | `@hourly` / `@daily` / `never` / `<n>[s\|m\|h]` |
| `METISTRY_GIT_AUTHOR_NAME` | `Metistry` | author-name prefix (`<prefix> <principal>`) |
| `METISTRY_GIT_AUTHOR_EMAIL` | `metistry@localhost` | |
| `METISTRY_VAULT_MAX_BYTES` | `2097152` | per-write size cap |
| `METISTRY_COMMIT_EXTERNAL_EDITS` | `true` | sweep out-of-band edits into `user` commits |
| `METISTRY_EMBED_ENABLED` | `true` | `false` turns embedding off entirely; search stays keyword |
| `METISTRY_LOCAL_MODEL_URL` | `.metistry/compute.yaml`'s first `on_machine` provider, else `http://127.0.0.1:11434/v1` | the local model server the embedder posts `/v1/embeddings` to (`METISTRY_OLLAMA_URL` is a deprecated alias) |
| `METISTRY_EMBED_MODEL` | `nomic-embed-text` | changing it requires a rebuild |
| `METISTRY_EMBED_DIM` | `768` | must match the model AND the `vector(768)` column |
| `METISTRY_EMBED_BATCH` | `16` | chunks per `/api/embed` request |
| `METISTRY_EMBED_MAX_FILES_PER_CYCLE` | `200` | the rest wait for the next cycle |
| `METISTRY_DB_*` | as elsewhere | the index tables (`knowledge_files`, `knowledge_links`, `embeddings`, `proposals`, `runs`) |
| `METISTRY_GIT_HTTP_PROXY` | set by `metistry up` when this install confines the reconciler | the supervisor's egress proxy, passed to git as `-c http.proxy=…` |
| `METISTRY_GIT_ASKPASS` | set by `metistry up` when this install confines the reconciler | the askpass shim's path. Its presence is also what turns on `-c credential.helper=` — the two move together |
| `METISTRY_GIT_ASKPASS_USER` / `_TOKEN` | injected by the **supervisor** at spawn, from the login Keychain | the push credential. Never written to disk, never in argv, never in `supervisor.json` |
| `METISTRY_RECONCILER_SANDBOX` | `1` | `0` runs the job under `ops/sandbox/unconfined.sb` instead — see "Confinement" |

`METISTRY_RECONCILER_URL` is a *console* setting: how the container reaches
the bridge (`http://host.docker.internal:7812`, explicit host-gateway per
PoC-4).
