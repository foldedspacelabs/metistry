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

## Pointing it at an instance repo

The reconciler needs exactly one path: `METISTRY_INSTANCE_DIR`, the working
tree of the instance repo (§4.16 — `Knowledge/`, `identity.yaml`, …). It is
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
watchdog):

```sh
pnpm -r build
sed "s|__REPO__|$PWD|g; s|__NODE__|$(which node)|g" ops/launchd/com.foldedspacelabs.metistry.reconciler.plist \
  > ~/Library/LaunchAgents/com.foldedspacelabs.metistry.reconciler.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.foldedspacelabs.metistry.reconciler.plist
curl -s -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER" http://127.0.0.1:7812/check
```

`check()` probes behaviour, not configuration: the repo is present, git
runs, `HEAD` is readable, `Knowledge/` lists, and it reports the commit
queue depth plus the last flush / push / reconcile. `degraded` with a
remediation string means "it runs but something needs your hand" (no
commits yet, `Knowledge/` missing, last push failed).

Restart the console (`docker compose up -d console`) so it picks up
`METISTRY_RECONCILER_URL`; `mcp-brain`'s `knowledge_read` then serves note
contents instead of `not_available`.

On Linux there is nothing TCC-bound here, so it runs as a container with
the instance repo on a volume: `docker build -f apps/reconciler/Dockerfile .`
and mount the repo at `/data/instance` (the image's default
`METISTRY_INSTANCE_DIR`).

## Creating an instance repo by hand (for now)

`metistry init` will stamp this from `seed/` later (§4.16). Until then:

```sh
mkdir ~/metistry-instance && cd ~/metistry-instance
git init -b main
mkdir -p Knowledge inbox
cp /path/to/metistry/seed/identity.yaml identity.yaml   # name your assistant here — nowhere else
cp /path/to/metistry/seed/Knowledge/now.md Knowledge/now.md
printf '.obsidian/\n.DS_Store\n' > .gitignore              # PoC-12: no .obsidian churn in git
git add -A && git commit -m "Instance created"
git remote add origin git@github.com:you/your-private-instance.git   # optional; push is best-effort
```

Point Obsidian at `Knowledge/` as the vault root, git at the repo root.

## The bridge

Every route requires `Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER`
(loopback is not a trust boundary — CRIT-9). Errors are the core envelope
`{ "error": { "code", "message" } }` with the usual status mapping
(401 unauthenticated, 403 forbidden, 404 not_found, 400 invalid_request,
409 conflict, 503 not_available).

| Route | What it does |
| --- | --- |
| `GET /check` | behavioural probe (frozen `check()` shape) |
| `GET /vault/read?path=` | `{path, content, sha256, bytes}` from the working tree |
| `GET /vault/list?prefix=&depth=` | files + dirs under a prefix (`.git`, `.obsidian` never listed) |
| `GET /vault/search?q=&limit=` | keyword search over **settled** notes — `status: draft` and conflict copies are excluded before matching |
| `GET /vault/log?path=&limit=` | `git log --follow` for a path (or the repo) |
| `GET /vault/diff?path=&from=&to=` | unified diff between revisions; `to` absent = the working tree |
| `POST /vault/write` | `{path, content \| content_base64, intent, expected_sha256?}` — compare-and-swap on the content hash |
| `POST /vault/delete` | `{path, intent, expected_sha256?}` |
| `POST /vault/rename` | `{from, to, intent}` — git-mv semantics; never clobbers |
| `POST /flush` | commit the queue now (the interval does this every `METISTRY_COMMIT_INTERVAL_SEC`) |
| `POST /reconcile` | run the index cycle now (the interval does this every `METISTRY_RECONCILE_INTERVAL_SEC`) |

**Intents.** Every mutation carries
`intent: { principal, message, group? }`. `principal` is a lowercase slug
the *caller* is trusted for (the console stamps it from the credential;
the engine's `brain-commit` passes `assistant`). It becomes the commit
author — `Metistry <principal>` (prefix from `METISTRY_GIT_AUTHOR_NAME`),
stamped server-side; a request cannot name an author. `group` batches
several writes into one commit; absent, the principal is the group.

**What the tool refuses, for everyone:** `..`, absolute paths, drive
letters, control characters, any `.git` segment, anything under
`instance-migrations/`, any symlink component, a case-mismatched prefix
(`knowledge/`, `Knowledge/areas/` when `Areas/` exists — macOS would
silently comply, a Linux container would fork the tree), and content over
`METISTRY_VAULT_MAX_BYTES`.

**What only the `user` principal may write (§4.7 protected paths):**
`identity.yaml`, `rules.yaml`, `sources.yaml`, `deployment.yaml`,
`metistry.lock`, `CLAUDE.md`, and everything under `queries/`, `agents/`,
`routines/`, `extensions/`. Every other principal gets a uniform `forbidden`.

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
| `METISTRY_DB_*` | as elsewhere | the index tables (`knowledge_files`, `knowledge_links`, `proposals`, `runs`) |

`METISTRY_RECONCILER_URL` is a *console* setting: how the container reaches
the bridge (`http://host.docker.internal:7812`, explicit host-gateway per
PoC-4).
