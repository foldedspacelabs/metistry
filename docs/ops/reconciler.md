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

The same walk keeps the **vault inbox** honest. `Knowledge/Inbox/` is where
captures live (`docs/ops/inbox.md`), and a file you put there yourself — in
Obsidian, in an editor, with a `git pull` — gets an `inbox` row like any
capture; an edit to one that is already there refreshes its hash and sends
it back to the drain; a deleted file archives its row. It lives here
because this is already the process that walks the tree and hashes it.

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

## Creating an instance repo

`metistry init` stamps it from `seed/` (§4.16; `docs/ops/cli.md`):

```sh
npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "Athena"
# or, inside the checkout after pnpm -r build:
node packages/cli/dist/main.js init ~/metistry-instance --name "Athena"
```

That is the `git init -b main` + `Knowledge/` + `identity.yaml` (the only
place the assistant is named) + `rules.yaml` + config dirs + `.gitignore`
+ `metistry.lock` + one `Instance created` commit the 2026-09-06 bootstrap
did by hand. It ends by printing the three `.env` lines above — the
`METISTRY_BRIDGE_TOKEN_RECONCILER` it shows is minted once and written
nowhere, so copy it then. Add a private remote whenever you like —
`metistry connect-repo <url>` sets `origin`, leaves a credential this
service can push with unattended (macOS Keychain + the `osxkeychain`
helper), flushes this queue and pushes once (`docs/ops/cli.md`); push
from then on is best-effort on the schedule below.

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
| `GET /vault/read?path=` | `{path, content, sha256, bytes}` from the working tree; `&encoding=base64` returns `content_base64` instead (binary artifacts) |
| `GET /vault/list?prefix=&depth=` | files + dirs under a prefix (`.git`, `.obsidian` never listed) |
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
`instance-migrations/`, any symlink component, a case-mismatched prefix
(`knowledge/`, `Knowledge/areas/` when `Areas/` exists — macOS would
silently comply, a Linux container would fork the tree), and content over
`METISTRY_VAULT_MAX_BYTES`.

`Knowledge/Inbox/` is ordinary vault content, not a protected path:
listable and readable like the rest of `Knowledge/`, writable through this
bridge by the capture principal and the assistant alike.

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

Those edits are also **never overwritten**. Every caller's write is
compare-and-swap: captures go in with `expected_sha256: ""` (must not
exist), and `knowledge_write` sends a hash on every call — omitted means
create-only — so a note that changed under an agent comes back `409
conflict` rather than being replaced by bytes the agent never read
(`docs/ops/inbox.md`, `docs/ops/assistant-tools.md`).


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
| `METISTRY_LOCAL_MODEL_URL` | compute.yaml's first `on_machine` provider, else `http://127.0.0.1:11434/v1` | the local model server the embedder posts `/v1/embeddings` to (`METISTRY_OLLAMA_URL` is a deprecated alias) |
| `METISTRY_EMBED_MODEL` | `nomic-embed-text` | changing it requires a rebuild |
| `METISTRY_EMBED_DIM` | `768` | must match the model AND the `vector(768)` column |
| `METISTRY_EMBED_BATCH` | `16` | chunks per `/api/embed` request |
| `METISTRY_EMBED_MAX_FILES_PER_CYCLE` | `200` | the rest wait for the next cycle |
| `METISTRY_DB_*` | as elsewhere | the index tables (`knowledge_files`, `knowledge_links`, `embeddings`, `proposals`, `runs`) |

`METISTRY_RECONCILER_URL` is a *console* setting: how the container reaches
the bridge (`http://host.docker.internal:7812`, explicit host-gateway per
PoC-4).
