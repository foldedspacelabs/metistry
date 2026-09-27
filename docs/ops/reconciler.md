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
Syncthing conflict copies are not indexed: each is raised once as a Needs You
`review` holding both versions — the note as it stands and the copy — which
clears itself when the copy is gone (C96, T2-9; `docs/ops/client-api.md`,
*Events become requests*).

The same walk keeps the **vault inbox** honest. `Inbox/` is where
captures live (`docs/ops/inbox.md`), and a file you put there yourself — in
Obsidian, in an editor, with a `git pull` — gets an `inbox` row like any
capture; an edit to one that is already there refreshes its hash and sends
it back to the drain; a deleted file archives its row. It lives here
because this is already the process that walks the tree and hashes it.

And the same walk indexes **the tasks in your notes** — see below.

## The task pass

Every `- [ ] …` line in the vault becomes a `vault_tasks` row, and every
`[[note#^mt-…]]` that names one becomes a `vault_task_refs` row
(`docs/product/daily-flow-spec.md` §1.5, migration `0024_vault_tasks.sql`).
Both tables are **derived in full**: drop the database, let one walk run,
and every row comes back from the markdown that produced it (invariant 1).
Neither is ever backed up and neither needs to be.

**Nothing is written back to a note.** The parser reads loosely — `due
friday`, `critical`, `@Jim`, and on read only, Dataview's `[due:: …]` and
the Tasks plugin's emoji — and the resolved values land beside the line, in
the index. The only hand that edits a task line is yours (§1.4, D3).

| | |
| --- | --- |
| **which notes** | every markdown note the knowledge walk sees, except `Templates/` (a template *describes* tasks, it does not hold them) and except a note whose frontmatter `source:` is somebody else's. A note with `source: user`, or with no `source:` at all, is yours. |
| **which notes are skipped, and why** | `Journal/Plan/…`, `Journal/Fold/…` and `Journal/Standup/…` are machine files with one writer each (§5.1). What they show is a generated list today and a transclusion once anchors exist — a **view**, never a second canonical line — so indexing them would double every todo they mention and re-date it to the day the plan was written. The test is the file's own `source:`, the same ownership vocabulary `knowledge_write` refuses on, so a plan you keep somewhere else is still indexed and a routine that writes somewhere new is still skipped, with nothing to keep in sync. |
| **identity** | the `^mt-…` block anchor when the line carries one — so the line keeps its identity when it moves to another note. Without one it is `h:<sha256 of the normalised text>:<ordinal among identical lines in that file>`: stable across a field edit, and deliberately not across a text edit. Change `due friday` to `due 2026-09-25` and it is the same task; re-type the words and it is a new one with a fresh ageing clock. |
| **when a row is re-derived** | when the note's bytes change (or when the table and the vault disagree, which is how a half-emptied table heals itself). Not on every cycle, and that is the point: `due friday` is resolved against the day the walk **read** the line, `parsed_on` records which day that was, and a row re-derived every five minutes would slide a Friday task onto the next Friday the moment that one passed. |
| **`first_seen_on`** | survives a re-walk, an edit that keeps the key, and a rename. It is the ageing clock and the only column that is not a pure projection of the current bytes — recoverable from git, and a rebuild that resets it loses a nudge, not a task. |
| **`done_on`** | the `done …` on the line when there is one. A `[x]` with no date is stamped the **first walk that saw it checked** and `done_on_observed` says so; that date never moves afterwards, and un-ticking the box clears it rather than leaving a lie. |
| **duplicates** | the same text open in two notes is two rows — markdown is the record — and the later-seen one carries `duplicate_of`. "Earlier" is `first_seen_on`, then path and key in byte order, so the pair resolves the same way on your Mac and in a Linux container. Closing either one settles the group. |
| **recurrence** | `- [ ] Water the plants every week` is a **rule**, never a task, and every open-task query excludes it. The instance your daily-note template materialises (`source template:recurring`) points back at the rule as `recur_parent`, and the rule's `recur_next` moves past each instance you **close** — past the closed ones only, so a rule whose instance is still open keeps falling due and the plan carries that one over instead of minting a second. |
| **`work.meta.blocked_by`** | read, never written (§3). A `work` row naming a human todo as `vault:<path>#^mt-…` gets a ref row of its own (`kind: blocked_by`, `from_path: work:<id>`), which is what lets the board and the plan say "waiting on you". It **surfaces and never gates**: `depends_on`, `DEPS_CLOSED` and claimability are untouched, so a typo in a note can never stall an agent. |

`POST /reconcile` returns the counts as `tasks: {files, rows, added,
removed, duplicates, warnings, refs}`, and each cycle records the same
numbers on its `runs` row.

**What it costs.** On a 400-note fixture carrying 4,000 task lines and 400
block-anchored references: a cold walk with every note dirty is 1,098 ms end
to end (≈3,600 task rows/sec) against 385 ms for the same vault with no task
lines in it; a quiet walk over it is 212 ms against 46 ms. The parse runs
over every note on every cycle and the writes do not, which is where the
difference between those two numbers lives.

Reading any of it is a **named query** — `vault_tasks_query`,
`vault_tasks_recurring`, `task_ageing` in `seed/queries/` — never a second
component with a connection string.

## Meetings and people

The same walk keeps two small maps Today resolves through (plan §2.9,
migration `0029_meeting_refs.sql`, ticket T1-10):

| Table | From | Which files |
| --- | --- | --- |
| `vault_meeting_refs (event_id, path)` | a meeting note's frontmatter `event_id:`, verbatim | notes under `Journal/Meetings/` (archived `<year>/<month>/` too) — a directory only you can write, so no agent can make a note that claims your meeting |
| `people_emails (email, path)` | a People page's frontmatter `email:` — one address or a list, trimmed, `mailto:` dropped, lowercased | pages under `People/` that are **yours** (no `source:`, or `source: user`); a page an agent created carries its own `source:` and never maps an address |

**Never guessed.** A row exists only because a file you wrote names the key
in a field of its own. Nothing is inferred from a filename, a title or a
display name, and an entry that is not plainly an address (`Jim <jim@x.com>`)
is dropped rather than repaired. `people_by_email` (`expose: route`) returns
the one page that claims an address — and nothing when no page does or when
two do — so an unmatched attendee is a plain name, never a wrong page.

Both are **derived in full** and rebuilt whole every cycle (they hold no
state to preserve): drop them, let one walk run, and they are exactly what
they were. `POST /reconcile` returns their sizes as `meeting_refs` and
`people_emails`.

## Pointing it at an instance repo

The reconciler needs exactly one path: `METISTRY_INSTANCE_DIR`, the working
tree of the instance repo (§4.16 — the vault root, `.metistry/identity.yaml`,
…). It is
configured entirely from the product checkout's `.env`:

```sh
METISTRY_INSTANCE_DIR=/Users/you/metistry-instance   # the ONLY process that holds it
METISTRY_BRIDGE_TOKEN_RECONCILER=<mint one>           # the console's bearer, and everything it fronts
METISTRY_BRIDGE_TOKEN_RECONCILER_USER=<mint another>  # the OWNER's: the only one that may write .metistry/
METISTRY_RECONCILER_URL=http://host.docker.internal:7812   # how the console container reaches it
```

The two bearers are the §4.7 boundary and are never the same value — see
"The principal comes from the credential" below, and docs/ops/auth.md.

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
queue depth plus the last flush / push / pull / reconcile, the vault's sync
state (`vault_sync`), and which bearers it holds
(`principal_from_credential`, `owner_bearer`). `degraded` with a
remediation string means "it runs but something needs your hand" (no owner
bearer, so no protected path is writable by anyone; no commits yet;
`.metistry/` missing; a sync stopped by a conflict, naming its paths; last
push failed).

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

Every route requires a bearer — `$METISTRY_BRIDGE_TOKEN_RECONCILER` for any
caller, `$METISTRY_BRIDGE_TOKEN_RECONCILER_USER` for the owner class (loopback
is not a trust boundary — CRIT-9). Which one you present decides what you may
write, not what you may read. Errors are the core envelope
`{ "error": { "code", "message" } }` with the usual status mapping
(401 unauthenticated, 403 forbidden, 404 not_found, 400 invalid_request,
409 conflict, 409 section_missing, 503 not_available).

| Route | What it does |
| --- | --- |
| `GET /check` | behavioural probe (frozen `check()` shape) |
| `GET /vault/read?path=` | `{path, content, sha256, bytes}` from the working tree; `&encoding=base64` returns `content_base64` instead (binary artifacts) |
| `GET /vault/list?prefix=&depth=` | files + dirs under a prefix (`.git`, `.obsidian`, `.metistry` never listed) |
| `GET /vault/search?q=&limit=&mode=` | search over **settled** notes — `status: draft` and conflict copies are excluded before matching. `mode` is `keyword`, `semantic` or `hybrid`; omitted, it is `hybrid` once embeddings exist and `keyword` before that (docs/ops/knowledge-search.md) |
| `GET /vault/log?path=&limit=` | `git log --follow` for a path (or the repo), newest first: `{sha, author, date, subject, source, runs, turns}` per commit — the last three are the `Brain-Source:`/`Metistry-Run:`/`Metistry-Turn:` trailers, provenance never authority. With a path, each entry adds `path` (the file's name at that commit, the old one across a rename) and `change` (`added`, `modified`, `deleted`, `renamed`, …) |
| `GET /vault/show?path=&sha=` | one **note** at one commit (§2.21, T10-4): `{path, sha, author, date, subject, source, runs, turns, content_base64, sha256, bytes}`. Read-only, for either bearer. Refused before git runs: a protected or non-vault path (`403` — `.metistry/`, `Artifacts/`, dot-paths, the root `CLAUDE.md`/`README.md`), and a `sha` that is not 7–64 hex characters (`400`). A commit that is not HEAD or an ancestor of it, or a path that is not a regular file at it, is `404`; a blob over the write cap is `400`. Bytes come from `git cat-file blob`, so no textconv driver can rewrite them. A restore (T10-5) is built on this and `POST /vault/write`, nothing else: the console reads the version here when it raises the Needs You request and again at Approve, then writes those bytes back as `user` with `expected_sha256` set to the file as the request showed it — a **new** commit, *Restore <path> to <date>*; the bridge has no revert, reset or checkout for it to call |
| `GET /vault/diff?path=&from=&to=` | unified diff between revisions; `to` absent = the working tree |
| `POST /vault/write` | `{path, content \| content_base64, intent, expected_sha256?}` — compare-and-swap on the content hash |
| `POST /vault/delete` | `{path, intent, expected_sha256?}` |
| `POST /vault/rename` | `{from, to, intent}` — git-mv semantics; never clobbers |
| `POST /vault/section` | `{path, marker, body, principal, expected_outer_sha, run?, turn?}` — replace the bytes between a section's markers in the owner's daily note and nothing else ("The section operation" below) |
| `POST /vault/revert` | roll back (§2.21, T10-6): `{intent: {principal: "user", message}, commit \| to \| file [+ to], include_config?, dry_run?, head?, expect?}` — one NEW commit that undoes a commit, restores every changed path to a moment, or puts one file back ("Roll back" below). `dry_run` previews (`200`), otherwise `201` with the new `sha` |
| `POST /flush` | commit the queue now (the interval does this every `METISTRY_COMMIT_INTERVAL_SEC`; the artifacts module calls it after every publish so one version is one commit) |
| `POST /reconcile` | run the index cycle now (the interval does this every `METISTRY_RECONCILE_INTERVAL_SEC`); the summary carries `inbox: {added, changed, archived}` |
| `POST /embeddings/rebuild` | forget every vector and re-embed the vault under the configured model (§6 decision 8's deterministic rebuild) |
| `GET /embeddings/status` | what is stored: model, dim, row count, how many notes are behind, whether a rebuild is required |

**Intents.** Every mutation carries
`intent: { principal, message, group?, turn?, run? }`. `principal` is a lowercase slug —
**attribution**, not authority. It becomes the commit author,
`Metistry <principal>` (prefix from `METISTRY_GIT_AUTHOR_NAME`), stamped
server-side; a request has never been able to name an author, and since
2026-09-20 it cannot name its own authority either (below). The console
stamps it from ITS credential; the engine's `brain-commit` passes
`assistant`. `turn` (the reply's turn handle) and `run` (a `runs.id`,
string or integer) say which **act** the write belongs to — see "The
committer" below; each must match `[A-Za-z0-9_-]{1,64}`, because it
becomes a trailer line and anything else would let a body forge one
(`invalid_request`). `group` batches several writes into one commit
explicitly (an artifact version); absent, the turn is the act, then the
run, then the write alone.

**What the tool refuses, for everyone:** `..`, absolute paths, drive
letters, control characters, any `.git` segment, anything under
`.metistry/instance-migrations/`, any symlink component, a case-mismatched
prefix (`areas/` when `Areas/` exists — macOS would silently comply, a
Linux container would fork the tree), and content over
`METISTRY_VAULT_MAX_BYTES`.

`Inbox/` is ordinary vault content, not a protected path:
listable and readable like the rest of the vault, writable through this
bridge by the capture principal and the assistant alike.

**What only the owner may write (§4.7 protected paths):** everything under
`.metistry/` except `.metistry/state/` — `.metistry/identity.yaml`,
`.metistry/rules.yaml`, `.metistry/sources.yaml`,
`.metistry/deployment.yaml`, `.metistry/metistry.lock`, and everything
under `.metistry/queries/`, `.metistry/agents/`, `.metistry/routines/`,
`.metistry/extensions/` — plus root `CLAUDE.md` and `README.md`. Anything
else gets a uniform `forbidden`.

**The principal comes from the credential** (ruled 2026-09-20; the rule and
its table live in docs/ops/auth.md). Two things are read per mutation, and
only one of them is in the body:

| Bearer | Caller class | May claim | Protected paths |
| --- | --- | --- | --- |
| `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` | `owner` (the CLI) | `user` only | all |
| `METISTRY_BRIDGE_TOKEN_RECONCILER` | `console` (and all it fronts) | any principal | `.metistry/assistant-prompt.md` and `.metistry/compute.yaml` only — the two owner-authenticated doors the console ships (§4.10 self-modification; the Compute pane's assign/budget) |

A body claiming more than its bearer allows is `forbidden` — never downgraded
— and the refusal is a `runs` row with the caller class on it. With
`METISTRY_BRIDGE_TOKEN_RECONCILER_USER` unset, **no** caller may write a
protected path and `check()` is `degraded` with the command that mints one.

**Every accepted protected write is on the record too** (T2-16). A write,
delete or rename of a protected path that the bridge accepts leaves a
finished `runs` row — `component=reconciler, kind=config_write`, `tool`
`vault_write|vault_delete|vault_rename`, `meta {path, op, from?, caller,
principal, message}`, one row per protected side of a rename — so Activity
(`activity_feed`, group `run`, the principal as actor) shows the change
whichever door made it: `metistry identity set`, `metistry update`, the
Compute pane, the prompt overlay. `meta.path` is what the live stream's
`config.changed {file}` carries (§2.20). A refusal keeps its `auth` row and
gets no `config_write`; a row that cannot be written never fails the write.
A hand edit swept in as an out-of-band change is not a bridge write and is
not recorded here — git has it.

**Compare-and-swap.** Send `expected_sha256` (from a prior read) to refuse
a write over content you have not seen (`409 conflict`); the empty string
means "must not exist yet". Omit it to overwrite unconditionally.

**Visibility vs. commit latency.** A write lands on the working tree
atomically and is readable by the next request; the commit happens on the
next flush. Readers never wait on git.

### The section operation — one writer per region

`Journal/<date>.md` is the owner's note, and no principal but `user` may
write, delete or rename it (`writeAllowed`, above — unchanged). Metistry
keeps exactly one **region** of it, between two marker lines (plan §2.13,
C102):

```markdown
## Today · Metistry

<!-- metistry:day -->
…the section: written whole by each writer…
<!-- /metistry:day -->
```

`POST /vault/section` is the only way into that region, and it cannot touch
anything outside it:

```sh
curl -s -X POST -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER" \
  -H 'content-type: application/json' http://127.0.0.1:7812/vault/section \
  -d '{"path":"Journal/2026-09-26.md","marker":"day","principal":"morning-brief",
       "body":"- Plan: [[Journal/Plan/2026-09-26]]\n- 9:00 Standup",
       "expected_outer_sha":"<sha256 of the note outside the section>"}'
# 200 {"path":"Journal/2026-09-26.md","section":"day","sha256":"…","bytes":412,
#      "outer_sha256":"…","appended":false,"queued":true}
```

| | |
| --- | --- |
| **where** | `Journal/YYYY-MM-DD.md` for a real calendar day — not `Journal/Plan/`, a meeting note or anything else (`400`). The note must exist (`404`): the section never creates the owner's note, whose template is theirs to apply. |
| **who** | the section's writers and nobody else: `morning-brief` (7:00 AM, model-free) and `user` (Close the Day) — `SECTION_WRITERS` in `apps/reconciler/src/paths.ts`. `principal` is attribution bounded by the bearer exactly as `intent.principal` is: the console's bearer may claim either, the owner's bearer only `user`. Anyone else — `assistant`, an agent, another routine — is `403`, recorded in `runs` like every refused mutation. |
| **the markers** | `<!-- metistry:day -->` and `<!-- /metistry:day -->`, each alone on its own line, exactly as written, **once**, outside any code block and outside the frontmatter. Anything else that looks like a marker anywhere in the note — a second pair, a lone one, one quoted in a code block, an annotated or indented or mis-cased one — is `409 section_missing` with a sentence naming what and on which line, and **nothing is written**. The bridge never guesses where the owner's text ends. |
| **the first write** | a note with no marker at all gets `## Today · Metistry` and the pair appended at its end (`"appended": true`); the owner's bytes are an untouched prefix. Two exceptions are `section_missing` instead: the heading is there without its markers (they were deleted — not a first write), or the note ends inside an unclosed code block (the section would be code). |
| **`expected_outer_sha`** | required. SHA-256 of every byte of the note **except** the region — the bytes before it and after it, concatenated, marker lines included. With no section yet it is simply the file's hash, `GET /vault/read`'s `sha256`. A mismatch is `409 conflict`: the owner edited outside the section since you read it, so read again. An edit **inside** the region does not change it — the region is the writer's to replace. |
| **`body`** | the whole new region, UTF-8; a trailing newline is added if missing so the closer stays on its own line. A body containing either marker, or one that would hide the closer (an unclosed code fence), is `400`. |
| **the commit** | one intent in the writer's name — `Metistry morning-brief`, `update the day section of Journal/2026-09-26.md` — through the committer like any write. Optional `run` / `turn` are the act keys every write takes ("One commit per act" below): the Morning Brief passes its run, so its brief file and the section are one commit with a `Metistry-Run:` trailer. |

**Computing the outer hash.** Don't reimplement the grammar: read the note
(`GET /vault/read?path=…&encoding=base64`) and pass the bytes to
`scanNoteSection(bytes, "day")` from `@foldedspacelabs/metistry-core` — its
`outerSha256` is exactly what the bridge checks, and its `state: "missing"`
tells you, before any request, that the write would be refused and why. The
bridge runs the same function (`writeNoteSection`), then re-scans its own
output and refuses anything that moved a byte outside the region; the file is
re-read just before the rename, so an owner's edit landing mid-write is a
`409 conflict`, not an overwrite.

## The committer

**One commit per act** (plan §2.21): a write, an agent turn, a routine run,
or a sweep is one commit, so `git log` reads as the list of things that
happened rather than a list of flush windows:

```
$ git log --reverse --format='%an: %s'
Metistry assistant: Morning brief
Metistry user: Edits from Obsidian: Alpha, Beta
Metistry assistant: Note from chat
```

The queue flushes every `METISTRY_COMMIT_INTERVAL_SEC` (default 30), and
each intent's act is decided when it is queued, first match wins:

| The intent carries | The act | So |
| --- | --- | --- |
| `group` | that group | a caller batching its own writes — an artifact version is one commit |
| `turn` | the turn | every note one agent reply writes is one commit, and two replies in one window are two. A host is built per reply, so a routine run's writes are one turn too |
| `run` | the run | a `runs` row with no turn around it |
| none | the write itself | two writes, two commits |

Acts are never mixed across principals. Two acts of **one** principal that
touched the same path in one window fold into one commit carrying both
messages and both sets of trailers: the working tree only holds the last
bytes, and committing them under the first act's message while the second
commits nothing would misattribute the edit.

Each commit is staged with `git add -A -- <the act's paths>` so nothing
else rides along. The message is the act's first intent as the subject,
the rest as bullets, then the trailers — provenance for reading history,
never an authorization signal:

```
Morning brief

- now: briefed

Brain-Source: assistant
Metistry-Run: 101
Metistry-Run: 102
Metistry-Turn: turn-a
```

`Brain-Source: <principal>` is always there (§4.7); `Metistry-Run:` (one
per distinct `runs.id`) and `Metistry-Turn:` where known.
`git log --format='%(trailers:key=Metistry-Turn,valueonly)'` joins a
commit back to `runs.meta.turn_id` and the activity feed. `knowledge_write`
sends the reply's turn and its own call's `runs` row, never a group.

A failed commit is unstaged and retried on later flushes; all-or-nothing
per commit. **Push and pull run on the vault sync policy** — the `vault:`
block of `.metistry/deployment.yaml`, set with `metistry vault settings`
(`docs/ops/cli.md`; plan §2.21): push `after_commit` (the default: once a
flush has made commits; commits still unpushed are retried every five
minutes), `{every: N}` (when something is unpushed), or `manual`; pull
`{every: N}` (default 5m, no "never"). Each is the committer's sync — commit
and sweep, fetch, integrate whatever the remote has first ("Sync with the
remote" below), and for a push then push — so this is only WHEN. The
reconciler re-reads the file when it changes — no restart — and keeps the
last good policy if an edit stops validating. Only with a remote, never
blocking anything; while a conflict stands nothing is pushed on the
schedule, and the pull keeps integrating until it is clean. A failed push or
a stopped sync shows up in `check()` as `degraded`. `METISTRY_PUSH_SCHEDULE`
still overrides `push` for this release, and the reconciler logs that it
does at start.

The committer records every push, pull that brought something in, and
conflict as a `runs` row of `kind = vault_sync`; the schedule adds `commit`,
one row per flush that made commits — so `meta.state` ∈ `commit | push |
pull | conflict`, and the console turns each into a `vault.sync` event
(§2.20). `GET /vault/status` (either bearer) answers branch, remote, ahead
and behind (as of the last fetch), the last commit (with its `Brain-Source`
principal), the last push that went out or failed and the last pull (both
since the reconciler started), the conflict that stopped the last integrate
or unmerged paths the owner left, and the policy in force; the console
serves it to the owner as `GET /api/vault/status`.

### Roll back

`POST /vault/revert` is the whole of rollback (§2.21, T10-6), and history is
preserved, always: the answer is a NEW commit, made as `user`
(`Metistry user`, `Brain-Source: user`), never a reset or a rewrite — git.ts
refuses those argvs for every caller. Three targets: `{commit}` is `git
revert` of that commit (a merge is reverted against its first parent; the
vault's first commit is refused); `{to}` puts every path that changed since
the last commit at that moment back as it was (`YYYY-MM-DD` is the end of
that day in the reconciler's time zone — the CLI sends the owner's own end of
day as a timestamp); `{file}` puts one file back as it was before its last
change, or `{file, to}` as of a moment. Undo is `{commit: <the rollback's
sha>}`.

The result is computed off the working tree — `git merge-tree --write-tree`
over scaffold commits, a scratch `GIT_INDEX_FILE` for the one tree edit,
`commit-tree` — and applied by `merge --ff-only`, holding the committer's
queue (pending acts are committed first; no write lands meanwhile). An
uncommitted edit to a file it changes, an operation the owner has in
progress, or a three-way conflict is `409`, and nothing moves. `head` pins
the history a preview was computed on: the same change is replayed on top of
whatever landed since, and `expect` — `{files, reverts, skipped_config}` as
the preview answered — makes it `409 stale` unless the change set is still
the one approved. After the commit the changed files are re-walked and the
push policy runs, as after any flush.

Refused at the tool, each audited as a `runs` row of `kind = auth`: any
`intent.principal` but `user`, from either bearer (`403`); `include_config`
on a real revert from anything but the owner-class bearer (`403` — a dry run
may name configuration, it changes nothing). Without `include_config` every
`.metistry/` path, the root `CLAUDE.md` and `README.md` (case-folded, as the
remote check reads them) is left as it is and listed in `skipped_config`; a
rollback that would change nothing else is `400`. `.metistry/state/` and
`.metistry/instance-migrations/` are never reverted by anyone. Configuration
a rollback does change is recorded as a `config_write` run, like any other
protected write.

**Edits made outside the bridge** — Obsidian on your phone, a text editor
on the Mac — are swept by the reconcile loop into one `user` commit per
sweep, because the reconciler is the only thing that can commit them
(PoC-12: "edit on iPhone → commits cleanly"). The subject names the files
— up to two by name, more by count (*Edits from Obsidian: 3 notes*) — and
the body lists every path. Paths with a pending bridge intent belong to
that intent; conflict copies are flagged, not committed. Turn the sweep
off with `METISTRY_COMMIT_EXTERNAL_EDITS=false`.

Those edits are also **never overwritten**. Every caller's write is
compare-and-swap: captures go in with `expected_sha256: ""` (must not
exist), and `knowledge_write` sends a hash on every call — omitted means
create-only — so a note that changed under an agent comes back `409
conflict` rather than being replaced by bytes the agent never read
(`docs/ops/inbox.md`, `docs/ops/assistant-tools.md`).


## Sync with the remote

**You may commit and push at any time** — from another clone, on GitHub,
in a terminal in this very working tree (plan §2.21, T10-3). Until
2026-09-26 the scheduled push was a bare `git push` with no fetch, so the
first push from anywhere else made every later one fail as
non-fast-forward, forever. Now every push is a sync, in this order:

1. **Commit and sweep first.** The queue is flushed and edits made outside
   the bridge are swept into their `user` commit (unless
   `METISTRY_COMMIT_EXTERNAL_EDITS=false`), so an Obsidian edit merges as a
   commit instead of blocking as a dirty file.
2. **Fetch** `refs/heads/<branch>` from the remote (`origin`, else the
   first) — through the same egress door and askpass shim as the push when
   confined.
3. **Integrate** (`apps/reconciler/src/integrate.ts`):

   | The remote has… | Local has… | So |
   | --- | --- | --- |
   | nothing new | anything | push if there is something to push |
   | new commits | nothing unpushed | **fast-forward** |
   | new commits | only the reconciler's own acts — single-parent, never published | **rebase** them onto the remote: history stays one line of acts, each keeping its author, date, message and trailers |
   | new commits | anything else — your commit made in this working tree, an act that was already pushed, a merge | **merge**, as `Metistry reconciler` with `Brain-Source: reconciler`: your commits keep their shas |

   "Ours" is the identity the committer stamps (`<prefix> <principal>` at
   `METISTRY_GIT_AUTHOR_EMAIL`, author and committer both). "Published"
   is anything the remote-tracking ref reached before this fetch — so an
   act the remote once had and has since lost (you force-pushed over it)
   is merged back, never replayed: the reconciler never drops a commit it
   has. Revert, don't force-push, to take something out.

4. **Push** — a plain `branch:branch` fast-forward. If the remote moved
   between the fetch and the push, git rejects it and the sync goes round
   again (three rounds at most, then the next schedule).
5. **Re-walk.** An integrate that changed files is followed by a reconcile
   walk that *starts after it* (never one already reading the old tree), so
   the index, tasks and embeddings catch up and `vault.reconciled` follows.

**Nothing is computed in the working tree.** The merge, and each rebased
act, is built with `git merge-tree --write-tree` and `git commit-tree` —
plumbing that writes objects and touches neither the index nor a file —
so a conflict is known before anything moves and there is never a rebase
or merge to abort. The tree then moves in **one** git command that refuses
rather than overwrite a local change: `merge --ff-only` for a
fast-forward or a merge commit, `reset --keep` for a rebase. While it runs,
bridge writes wait (and it waits for the ones in flight), so a write can
never land between git's "is this file clean?" and git's write. Needs git
2.38 or later (`merge-tree --write-tree`); the rebase deliberately avoids
2.40's `--merge-base`, because a Debian-based image may carry 2.39.

**A conflict stops, never guesses.** When both sides changed the same
lines, when an edit nobody has committed is in the way (a `.metistry/`
file is never swept — it is your hand), or when the remote shares no
history with the vault:

- nothing is pushed and nothing in the working tree is touched;
- `vault.state` is `conflict` — `check()` is `degraded` and names the
  paths, `meta.vault_sync` carries both sides;
- **one** Needs You `report` is raised (`kind: vault_conflict`): the
  paths, and for each the latest commit on either side. One per
  *episode* — its key is the commit where the two histories last agreed,
  which does not move while the conflict stands, so the scheduled pulls
  that retry it (and a restart) add nothing, and a report you dismissed stays dismissed;
- writes keep committing locally.

Resolve it in a terminal in the instance directory (`git pull`, fix,
commit) or make the note match the remote's in Obsidian; the next sync
that integrates cleanly clears `vault.state`.

**The remote cannot change configuration** (ruling 2026-09-26, "refuse and
report"). Before anything else in step 3, the fetched commits are diffed
against the merge base (`git diff --name-only <base> <remote>`). If any path
is protected from the remote — the §4.7 set (`paths.ts`
`isProtectedFromRemote`): **all** of `.metistry/` (including `state/`,
which is gitignored and which git would overwrite silently), the root
`CLAUDE.md` and `README.md`, the legacy machinery roots, and any
case-folded spelling of them (`claude.md`, `.Metistry/…` — on macOS that
*is* the protected file once checked out) — then:

- nothing is integrated and nothing is pushed, **even the vault notes in
  the same fetch**: the fetch is refused whole, because integrating the
  rest would be a merge nobody wrote;
- `vault.state` is `conflict` with reason `protected_path_from_remote`,
  naming the paths (at most 50) and the offending commits (at most 20);
  the `vault_sync` runs row carries `meta.state: conflict`, the reason,
  the paths and the commit shas;
- **one** Needs You `report` per offending remote commit (key
  `vault-sync-protected:<sha>`) — the commit, its author and subject, the
  protected paths it changed. The hourly retries and a restart add
  nothing; a later offending commit is a report of its own;
- local writes keep committing, and wait to be pushed.

To resume, either **undo it on the remote** — `git revert <sha>` in a
clone and push; the net change from the merge base then touches nothing
protected, and the next sync integrates the rest and pushes what was
held — or **take it by hand** in a terminal in the instance directory
(`git pull`, read the diff, commit if a merge is needed): once it is in
the local history the merge base has moved past it, and the next sync is
clean. Dismiss the reports once done. A vault-only remote commit
integrates exactly as the table above says.

**Your operation in progress is yours.** While the working tree has a
merge, rebase, cherry-pick, revert or bisect in progress (git's own
`MERGE_HEAD`, `rebase-merge/`, …), the committer stages nothing, commits
nothing and syncs nothing — staging a path mid-merge would mark your
conflict resolved with whatever is on disk. Bridge writes still land and
queue; the queue commits when you finish.

**Every sync act is on the record**: a `runs` row, `component
reconciler`, `kind vault_sync`, `meta.state` `pull` (commits came in, or
the fetch failed), `push` or `conflict` — the source of the `vault.sync`
event (plan §2.20). A sync with nothing to do writes nothing.

**What git may never be asked to do.** `git.ts` refuses, before anything
is exec'd, any argv that forces or rewrites (`refusedGitArgs`): `--force*`
and `-f`, `--hard`, `--mirror`, a `+` or `:` refspec on push or fetch,
`push --delete`/`--prune`/`--all`, a `reset` that moves the branch other
than `--keep`, a `merge` that is not `--ff-only`, and `rebase`,
`checkout`, `switch`, `restore`, `branch`, `stash`, `update-ref`,
`reflog`, `gc`, `prune`, `clean`, `filter-branch`, `replace` outright.
`apps/reconciler/test/sync.test.ts` records every argv the committer runs
across its scenarios and checks the same list.

`push()` and `pull()` — fetch and integrate without pushing — are the
two scheduled acts; WHEN each runs is the vault sync policy
(`deployment.yaml`'s `vault:` block, `metistry vault settings`), above.

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
`osxkeychain`. The same file runs the sync's whole argv confined: a fetch
through the tunnel after someone else pushed, `merge-tree`, `commit-tree`,
`merge --ff-only` and the push that follows.

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
| `METISTRY_BRIDGE_TOKEN_RECONCILER` | — (required) | the bearer any caller presents (caller class `console`) |
| `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` | — (fail closed when unset) | the OWNER class's bearer: the only credential that may write a §4.7 protected path. Minted by `metistry init` / `up` / `update` / `secrets sync --to env`, never given to the console (docs/ops/auth.md). Equal to the one above = refused at startup |
| `METISTRY_RECONCILER_HOST` | `127.0.0.1` | bind address (loopback by default, invariant 8) |
| `METISTRY_RECONCILER_PORT` | `7812` | |
| `METISTRY_COMMIT_INTERVAL_SEC` | `30` | queue flush cadence |
| `METISTRY_RECONCILE_INTERVAL_SEC` | `300` | index cycle cadence |
| `METISTRY_PUSH_SCHEDULE` | unset | **deprecated, this release only**: overrides the vault policy's `push` — `@hourly` / `@daily` / `never` / `<n>[s\|m\|h]`. Set the policy with `metistry vault settings` instead |
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
| `METISTRY_DB_*` | as elsewhere | the index tables (`knowledge_files`, `knowledge_links`, `embeddings`, `vault_tasks`, `vault_task_refs`, `vault_meeting_refs`, `people_emails`, `proposals`, `runs`) |
| `METISTRY_TZ` | unset (then `TZ`, then UTC) | the zone `due friday` and `do monday` resolve against, recorded per row as `parsed_on` |
| `METISTRY_GIT_HTTP_PROXY` | set by `metistry up` when this install confines the reconciler | the supervisor's egress proxy, passed to git as `-c http.proxy=…` |
| `METISTRY_GIT_ASKPASS` | set by `metistry up` when this install confines the reconciler | the askpass shim's path. Its presence is also what turns on `-c credential.helper=` — the two move together |
| `METISTRY_GIT_ASKPASS_USER` / `_TOKEN` | injected by the **supervisor** at spawn, from the login Keychain | the push credential. Never written to disk, never in argv, never in `supervisor.json` |
| `METISTRY_RECONCILER_SANDBOX` | `1` | `0` runs the job under `ops/sandbox/unconfined.sb` instead — see "Confinement" |

`METISTRY_RECONCILER_URL` is a *console* setting: how the container reaches
the bridge (`http://host.docker.internal:7812`, explicit host-gateway per
PoC-4).
