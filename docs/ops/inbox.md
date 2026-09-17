# The inbox — `Inbox/`

Captures live **inside the vault**, at `Inbox/` (ruled 2026-09-16; the
2026-09-17 layout ruling then moved the vault root itself to the instance
directory, so what was `Knowledge/Inbox/` is `Inbox/` at the instance root —
`docs/ops/instance-layout.md`). Obsidian's vault root is the instance
directory, so that is the only place it can see them, add to them and edit
them; and being in the instance repo means git carries them, so the inbox
survives `docker compose down -v` like everything else that matters
(invariant 1 — the inbox used to be the hole in it).

TitleCase, like everything at the vault root (CLAUDE.md casing). The
reconciler refuses a lowercase `inbox` at the tool, so it and `Inbox` cannot
both exist on a case-insensitive Mac and then fork in a Linux container.

## Every door

| Door | What it is |
| --- | --- |
| `POST /capture` | the share-sheet Shortcut, the PWA, any owner or agent token (`docs/ops/capture-shortcut.md`) |
| `/note …` in the console | the router's fast path: no model, instant ack (`docs/ops/console-api.md`) |
| `capture` on the brain bridge | any agent with a token — Claude Code, Cursor, Devin (`docs/ops/claude-code-plugin.md`, `docs/ops/cursor.md`) |
| `metistry import-sessions` | past sessions, as `kind: session` captures |
| the `devin-knowledge` collector | pulled wikis and notes |
| **Obsidian, an editor, `git pull`** | you, writing a file into the folder by hand |

The first five go through **one function** (`captureToInbox`), so a capture
is the same row whichever door it came through: a file in
`Inbox/`, and an `inbox` row carrying its sha256, mime, note and
the credential's `source_agent`. The last one is the new part, below.

## How a capture reaches the vault

Through the **reconciler's bridge**, like every other vault write. The
console (container or launchd job) holds no part of the instance repo — the
reconciler is its only holder and its only committer (D5, invariant 7) — so
`POST /capture` turns into `POST /vault/write` with
`expected_sha256: ""`: **must not exist**. A capture can therefore never
land on top of a file that is already there, whoever wrote it.

Each capture is committed on the next flush, principal `capture`, group
`capture` (so a burst is one commit).

**With no bridge configured** (`METISTRY_RECONCILER_URL` /
`METISTRY_BRIDGE_TOKEN_RECONCILER` unset) the console degrades to writing
files in `METISTRY_INBOX_DIR` — capture keeps working, because one silent
drop ends the trust (SHOULD-10) — but those files are not in the vault and
Obsidian will not see them. The recovery is a plain `mv` into
`<instance>/Inbox/`: the scan below picks them up.

## Files you write yourself are first-class

A note you add in Obsidian, an edit you make to a capture that is already
there, a file that arrives with a `git pull` — none of that goes through an
API, and all of it is triage material. The **reconcile loop** (every
`METISTRY_RECONCILE_INTERVAL_SEC`, default 300s) already walks the vault and
hashes every file, so it does this too:

| What it sees | What it does |
| --- | --- |
| a file with no `inbox` row | inserts one — `source: 'vault'`, sha256, mime by extension, the note's title (or first line) as its one-liner |
| a row whose file changed | new sha256; and back to `new` if it was already `classified` or `accepted`, so `inbox-drain` looks again — **a refinement is new information** |
| a row that was `rejected`, whose file changed | left rejected. You said no; editing a file is not an appeal |
| a row whose file is gone | `archived`. Never deleted: the history of what was captured is part of the record |
| an archived row whose file comes back | back to `new` (a `git revert`, an Obsidian restore) |

The counts land in the cycle's summary and its `runs` row:
`"inbox": {"added": 2, "changed": 1, "archived": 0}`.

Why there and not in a collector: the reconciler is already the one process
holding the working tree and the one that detects outside edits by content
hash. A separate `inbox-scan` collector would need either its own copy of
the repo (there is only one holder) or a new polling route plus a second
component writing these rows. This adds neither.

`inbox-drain` then classifies the `new` rows into proposals exactly as it
always has — it never moves or deletes a file.

This is also what makes the inbox pass invariant 1's test. After `docker
compose down -v` the `inbox` table is empty; the first reconcile cycle
rebuilds a row for every file still in `Inbox/`, because the files
are in git. What does not come back is the triage *outcome* (everything
returns as `new`), which is the honest remainder of plan-review SHOULD-20 —
still open, and now the only part of the inbox that a rebuild loses.

## Nothing overwrites your edit

Two rules, both enforced at the tool rather than in a prompt:

- **Captures** are written with `expected_sha256: ""` — create only.
- **`knowledge_write`** (the assistant's entire write path into the vault)
  sends `expected_sha256` on *every* call. Omitting the argument means
  create-only, so an existing note answers `conflict` with its current hash
  instead of being overwritten blind; changing a note means
  `knowledge_read` first, and the assistant has therefore seen the exact
  bytes it is replacing (`docs/ops/assistant-tools.md`).

Behind both, the reconciler's own compare-and-swap is what actually decides:
a mismatch is `409 conflict`, never a retry-and-overwrite.

`Inbox/` is **not** a protected path. It is ordinary vault
content: readable and listable by the assistant like the rest of
the vault, writable through the bridge. The protected set
(`.metistry/identity.yaml`, `.metistry/rules.yaml`, `.metistry/queries/`, …)
is unchanged.

## Big files

`METISTRY_INBOX_MAX_TRACKED_BYTES` (default **5 MiB**) is the line between
"git carries this" and "git does not". Above it, a capture is written to
`Inbox/.large/` instead, which `metistry init` puts in the
instance's `.gitignore`.

The trade-off, stated plainly: a 40 MB screen recording in git history is
there forever and is pushed on every clone; the same file in `.large/` is
visible in Obsidian, readable by the assistant, backed up by whatever backs
up the machine — and **not** in the repo, so it does not survive a
re-clone. Nothing else about it differs: it gets an `inbox` row like any
other capture. Raise the threshold if you would rather carry them; set it to
`0` to never spill.

`.large/` is a dot-directory, so the reconciler's walk does not index it and
the scan above never archives its rows. No other archiving, rotation or
cleanup is built — deliberately.

One more ceiling: everything that crosses the bridge is capped by
`METISTRY_VAULT_MAX_BYTES` (default 2 MiB). A capture above it is refused
with `invalid_request`, which is *smaller* than the tracked-bytes default —
raise `METISTRY_VAULT_MAX_BYTES` on an instance that captures photos and
PDFs.

## Moving an existing instance

`metistry migrate-layout` is enough on its own, whichever ruling an instance
predates — it carries a bare root `inbox/` up to `Inbox/` as well as
everything else:

```sh
metistry migrate-layout --dry-run    # the whole plan, nothing run
metistry migrate-layout
metistry up                          # the verb restarts nothing itself
```

Two smaller, separately reviewable commits are also fine, if the instance
predates both rulings:

```sh
metistry migrate-inbox --dry-run     # bare inbox/ -> Knowledge/Inbox/ (2026-09-16 ruling)
metistry migrate-inbox
metistry migrate-layout --dry-run    # Knowledge/Inbox/ (and everything else) -> the flat layout (2026-09-17 ruling)
metistry migrate-layout
metistry up
```

`migrate-inbox` moves `inbox/*` into `Knowledge/Inbox/` (`git mv` for what
git tracks, a plain move for the rest — the old inbox was gitignored, so
most of it is untracked), drops `inbox/` from `.gitignore`, adds
`Knowledge/Inbox/.large/`, rewrites `inbox.path` rows to
`Knowledge/Inbox/<file>`, and commits. Idempotent: a second run reports
"already on the vault inbox" and changes nothing.

A second instance that had already moved its inbox to a **lowercase**
`Knowledge/inbox/` is detected by reading the real directory entry
(`existsSync` lies on a case-insensitive filesystem) and renamed through a
temporary name — `git mv Knowledge/inbox Knowledge/Inbox` on macOS moves the
directory inside itself.

`migrate-layout` is the newer, idempotent `git mv` verb that carries
`Knowledge/Inbox/` — or a bare root `inbox/`, in either casing — and every
other pre-ruling path up to the instance root, and everything that is not
knowledge down into `.metistry/`. It rewrites `inbox.path` the rest of the
way (`Knowledge/Inbox/<file>` and a pre-2026-09-16 bare filename both become
`Inbox/<file>`), refuses a file collision between two inboxes rather than
clobbering one, and commits once. `docs/ops/instance-layout.md` has the full
tree and the protected-path rule it preserves; `docs/ops/cli.md` has its
flags.

Obsidian needs no change beyond re-opening it at the instance directory:
the vault root is the instance root, and `Inbox/` is a folder in it.

## `inbox.path`

**Relative to the instance repo root** — `Inbox/<file>` — which is
what `db/migrations/0001_init.sql` always said the column held, and what it
actually holds from migration `0015` on (through the `Knowledge/Inbox/<file>`
intermediate form for instances migrated between the two rulings). Before the
first move the capture path stored a bare filename; `metistry migrate-inbox`
and `metistry migrate-layout` rewrite those rows in turn.

A partial unique index (`inbox_vault_path_uidx`, on paths under
`Inbox/`) makes "one row per inbox file" true at the database,
because two writers now reach that directory: the capture path and the
scan. Whoever writes second refines the row rather than duplicating it.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `METISTRY_INBOX_DIR` | `<instance>/Inbox` | the fallback directory when this console has no vault bridge |
| `METISTRY_INBOX_MAX_TRACKED_BYTES` | `5242880` | above this, a capture goes to `Inbox/.large/` |
| `METISTRY_RECONCILER_URL`, `METISTRY_BRIDGE_TOKEN_RECONCILER` | — | the bridge captures are written through (`docs/ops/reconciler.md`) |
| `METISTRY_VAULT_MAX_BYTES` | `2097152` | the bridge's own per-write cap |
| `METISTRY_RECONCILE_INTERVAL_SEC` | `300` | how often files you wrote yourself are noticed |

## Deliberately not built

- **Moving a capture to its home.** Triage produces a proposal; the fold
  writes pages. Nothing moves or deletes a file in the inbox — `delete` and
  `rename` are not exposed to the assistant at all, so filing a capture away
  is your hand, or a later PR that does it as bridge write + delete with
  compare-and-swap on both sides.
- **Archiving, rotation, or an inbox size budget** beyond the `.large/`
  threshold.
- **Watching the folder.** The reconcile interval is the latency; a capture
  through an API is indexed at once because it inserts its own row.
