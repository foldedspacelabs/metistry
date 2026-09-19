# The instance layout — the vault root is the instance root

Ruled 2026-09-17. An instance directory is the Obsidian vault: everything
that is not knowledge moves under one dot-folder, `.metistry/`, and
everything else — Journal, Areas, Me, `now.md`, Inbox, Artifacts — sits at
the root, TitleCase, exactly where Obsidian already opens it.

```
<instance>/
  .metistry/
    identity.yaml  rules.yaml  compute.yaml  deployment.yaml  metistry.lock
    agents/  routines/  queries/  extensions/  instance-migrations/
    state/            (gitignored: .env, models/, sockets, all runtime)
  .obsidian/          (workspace* gitignored)
  Inbox/              (was Knowledge/Inbox/)
  Journal/ Me/ now.md …   vault content, TitleCase, at the root
  Artifacts/          stays at the root, not indexed as knowledge
  CLAUDE.md           the assistant's operating instructions (was Knowledge/CLAUDE.md)
  README.md
```

## Why

**One directory to open.** Before this ruling an instance held a
`Knowledge/` vault, a dozen config files and directories, and `state/`, all
as siblings — a stranger opening the folder in Obsidian saw `identity.yaml`
and `rules.yaml` sitting next to their notes. Pointing Obsidian at the
instance directory itself, with everything that is not knowledge tucked
under one dot-folder, means Obsidian and Metistry agree on the root: there
is exactly one directory to open, one thing to point git at, one thing to
back up.

**Obsidian ignores dot-prefixed folders.** That is the whole mechanism —
`.metistry/` needs no vault-settings exclusion, no `.obsidianignore` entry,
nothing. It is invisible to Obsidian the same way `.git` and `.obsidian`
already are.

**Casing stays one boundary** (CLAUDE.md): vault-root content is TitleCase,
`.metistry/` and the product repo are lowercase. `CLAUDE.md` and `README.md`
are the two vault-root exceptions, both instructions rather than knowledge,
both left where a reader — human or assistant — expects to find them at a
glance.

## The protected rule

Protected paths — the ones only the user's hand may write (§4.7) — are
**everything under `.metistry/` except `.metistry/state/`, plus root
`CLAUDE.md` and root `README.md`.** `.metistry/state/` is excluded from the
protected set because nothing in it is configuration the assistant could
compromise by writing — it is gitignored runtime, not tracked at all — but
the reconciler still refuses to write there directly; it is not vault
content either.

Everything else — the whole vault root outside `.metistry/`, `CLAUDE.md`
and `README.md` — is free: the assistant commits there without ceremony,
through `brain-commit` (invariant 9's one write path).

This is a straightforward relocation of the pre-ruling split
(`docs/plan-refresh...` and metistry-build-plan.md §4.7), not a new rule —
`identity.yaml`, `rules.yaml`, `queries/`, `agents/`, `routines/`,
`extensions/`, `instance-migrations/` were already protected; they simply
now share one enclosing directory instead of sitting at the instance root
next to the vault.

## What is gitignored

Only `.metistry/state/` and Obsidian's own workspace files
(`.obsidian/workspace*`). Everything else under `.metistry/` — `identity.yaml`,
`rules.yaml`, `compute.yaml`, `deployment.yaml`, `metistry.lock`, and the
`agents/`, `routines/`, `queries/`, `extensions/`, `instance-migrations/`
directories — is tracked: it is config, not runtime, and belongs in the
instance repo's history like everything else invariant 1 depends on.
`.metistry/state/` holds `.env`, Postgres data, model weights and sockets —
exactly what `docker compose down -v` should be able to lose.

**`.metistry/state/bin/Metistry`** (capital M, **launchd shape only**) is
the supervisor's program-identity symlink to this install's node
(`supervisorBinPath`), written by `metistry up`, never by hand, so System
Settings shows the background item as "Metistry" rather than "node".

**`.metistry/state/cli/metistry`** is the CLI shim
(`packages/cli/src/cli-shim.ts`), written by `metistry up`/`metistry
update`, never by hand: a POSIX script that already knows this install's
product dir and instance dir, so `metistry <verb>` works without either
resolved for it. `up` never puts it on `PATH` itself (invariant 2) —
`docs/ops/cli.md`, "Getting `metistry` on your PATH", has the one-liner it
prints instead. It is fine to lose either file the same way as the rest of
`state/`: rerunning the verb that wrote it regenerates it.

**Why two directories and not one.** macOS's default APFS volume is
case-insensitive, so `bin/metistry` and `bin/Metistry` would be the SAME
directory entry there — writing the cli shim into `state/bin/` under the
launchd shape would collide with the supervisor's own symlink. `state/cli/`
is a sibling directory the supervisor's symlink never touches, which
removes the collision outright rather than working around it.
`writeCliShim` still checks what is actually sitting at its path before
writing — a symlink, or a file that does not look like a shim this install
wrote, is left alone with a note — as a second line of defence, not the
fix itself.

## Migrating an existing instance

`metistry migrate-layout` carries an instance from the legacy layout to the
flat one:

```sh
metistry migrate-layout --dry-run     # every move and every row count, nothing run
metistry migrate-layout               # do it
metistry up                           # the verb restarts nothing itself
```

`git mv` for what git tracks and a plain move for what it does not; the
plan is read off the filesystem BEFORE anything moves, so a name collision
between `Knowledge/` and the instance root (a root `Journal/` and a
`Knowledge/Journal/`) is refused with both sides named and the tree
untouched. The database half is one transaction: `Knowledge/` drops out of
`knowledge_files`, `knowledge_links`, `embeddings`, `inbox` and
`projects.area`, and the whole-vault grant sentinel becomes `/`
(`VAULT_ROOT_AREA`). Crew `scope:` and target `data_policy.allow:` entries
are rewritten in the manifest FILES in the same run — the console re-syncs
the registry from `.metistry/agents/**` on an interval, so a grant migrated
in the database and left stale in the manifest behind it would be undone by
the next sync. That edit is a byte-range splice, so comments and formatting
come back untouched. A pre-2026-09-17 `<instance>/eval/` moves to
`.metistry/eval/` with the rest: bake-off fixtures and transcripts are
instance-repo content, not knowledge. It ends in one commit, and it restarts
nothing.

It refuses a dirty git tree (`--allow-dirty` overrides) and warns if the
supervisor or reconciler job is running — the reconciler is the instance
repo's sole committer, so stop it first. `docs/ops/cli.md` has the step
list, the flags, and what is deliberately NOT rewritten.

`metistry doctor` reports which layout an instance is on (`instance layout:
flat | legacy`), so a `legacy` reading is the signal to run it, and the Mac
app shows the same sentence in Status and in the first-run wizard. An
instance that predates the 2026-09-16 inbox-in-vault ruling needs nothing
extra — `migrate-layout` carries a bare root `inbox/` up to `Inbox/` itself
— though running `metistry migrate-inbox` first is still fine, and is the
smaller step if you want the two moves in two commits
(`docs/ops/inbox.md`).

New instances need none of this: `metistry init` writes the flat layout
from the start.

## Until the verb runs

**A legacy instance keeps working on the 0.8.x line and nothing past it.**
Every reader resolves the shape it is actually looking at — core's
`resolveInstanceLayout(instanceDir)`, one `detectLayout` read and a string
join after it — so `identity.yaml`, `rules.yaml`, `compute.yaml`,
`deployment.yaml`, `metistry.lock`, `instances.yaml`, `state/.env`,
`state/pg/`, `state/ports.yaml` and `Knowledge/Inbox/` are all found where a
not-yet-migrated instance keeps them. The protected set (§4.7) and the
knowledge walk cover the legacy machinery at the instance root
unconditionally: on a legacy instance `identity.yaml` and `queries/` are the
user's hand exactly as `.metistry/` is, and neither they nor the gitignored
`state/` are indexed as notes. Writers are unchanged — `metistry init`
stamps the flat layout and `migrate-layout` moves onto it; there is one
layout to write and two to read.

`metistry update` **refuses** to pin a version past 0.8.x onto a legacy
instance, before it fetches anything, printing the `migrate-layout` line to
run; `--allow-legacy` pins it anyway. That refusal is the guarantee's other
half: compatibility that nothing tests past the line it was written for is
not compatibility.

## The legacy layout, for reference

Before this ruling, an instance repo looked like this:

```
<instance>/
  Knowledge/              the live Obsidian vault (incl. now.md, Inbox/)
  identity.yaml  rules.yaml  compute.yaml  deployment.yaml  metistry.lock
  queries/  agents/  routines/  extensions/  instance-migrations/
  state/                  gitignored — .env, Postgres data, assistant state
  CLAUDE.md               the assistant's operating instructions
  README.md  .gitignore
```

Obsidian pointed at `Knowledge/` as the vault root, git at the repo root —
so a stranger opening the repo root in Finder, or a fresh clone's directory
listing, saw the vault as one folder among a dozen config files rather than
as the thing the whole directory is for. That asymmetry between where git
looks and where Obsidian looks is what the flat layout above resolves.
