# The evening fold

Every evening, the assistant turns the day's settled material into vault
pages: a dated journal note plus the entity pages it owns. Two moving parts —
a routine that **assembles** and an assistant turn that **writes** — because
routines never call a model (invariant 4) and there is exactly one writer
(§4.11).

The design is the memory-curator pattern from
`docs/research/2026-09-stash-review.md` §"Worth taking" item 1, with its three
rules kept as invariants.

## The three rules

1. **It reads only what is new since its last successful fold.** The anchor is
   the routine's own `runs` row: `component = 'knowledge-fold'`, `kind =
   'routine_run'`, `ok`, `meta.folded = true`. A pass that skips (too early,
   already folded, nothing new) writes no such row, so the window never slides
   past unread material. With no anchor at all — a fresh instance — the window
   is the last 7 days, not all of history.
2. **It writes only inside reserved paths.** The routine writes nothing to the
   vault. The assistant writes `Journal/Fold/<date>.md` — **never**
   `Journal/<date>.md`, which is the user's own daily note (daily-flow-spec
   §5.1; moved here in ticket P1-9, from the file's original path) — and the
   entity pages under `People/`, `Projects/`, `Resources/` that it owns, plus
   a one-line "last fold" note in `now.md`. `Me/`, the protected paths, and
   any note someone else owns are refused **at the tool**, not by the prompt
   (below).
3. **It never reads its own output.** By construction: every handle in the
   brief comes from a Postgres table, and the routine never opens the vault —
   so `Journal/*` and every page the fold wrote are unreachable as
   input. Items the fold itself produced (proposals, artifact versions or
   captures whose principal is `knowledge-fold`) are excluded in SQL too.

## What it reads

Since the anchor:

| source | what counts |
| --- | --- |
| `proposals` | decided `allow` or `accept_with_changes`, kind `knowledge`, `report`, `session`, `review` |
| `work` | rows that reached `status = 'closed'` |
| `artifact_versions` | versions published (with their artifact's project/slug) |
| `inbox` | captures of kind `session` (`metistry import-sessions`); captures live at `Inbox/` (`docs/ops/inbox.md`) |

Each becomes a **handle** — an id, a title, a one-line summary, sometimes a
path. Never content: the assistant fetches what it needs with `queries_run`,
`knowledge_read` and `artifacts_get`. The whole brief is capped at 4 KB; a busy
day drops from the largest group and says `…and N more`.

## What it enqueues

One row in `inbound_messages`, thread `fold`, `meta = {"kind": "fold",
"tier": "routine", "fresh_session": true, "source": "knowledge-fold",
"fold_path": "Journal/Fold/<date>.md", "fold_mode": "skeleton" | "fallback",
…}`, whose text begins `🌙 evening fold — <date>`. The assistant's drain picks
it up like any other message; the "Fold" section of `seed/assistant-prompt.md`
tells it what to do with it. Exactly one turn per fold — never one per item.

Two of those keys are cost controls (`docs/ops/assistant-tools.md`): `tier:
routine` runs the fold on the instance's cheap (model, effort) pair rather than
the chat default, and `fresh_session` means the fold never resumes the chat
thread's SDK session — a fold is its own task, and a task boundary is where
context is cheapest to drop.

## The fold's own file, rendered from `Templates/Fold.md`

`Journal/Fold/<date>.md` (§5.1) is rendered from `Templates/Fold.md` (§6.1) —
the one template where `{{ prose }}` is legal (D14), because `Journal/Fold/`
is the one place `ownershipRefusal` lets the assistant write under a source
that is not its own credential
(`packages/mcp-brain/src/knowledge-write.ts:262-268`). The routine does the
whole render itself: `date`, `requests`, `include` and every other directive
are filled by `renderTemplate` (`packages/core/src/template.ts`), and the
result — every `prose` slot still open, marked
`<!-- metistry:prose N -->` — rides on the SAME turn already described above,
as a fenced skeleton plus a numbered list of the prose prompts (and the
handle each one names, dates already resolved: `Journal/Fold/2026-09-19`, not
`{{ date offset: -1 }}`). The assistant's whole job in that turn is to
replace each numbered marker LINE with its answer and write the file back
verbatim otherwise — never to re-compose the parts the template already
rendered.

**When there is no template to render** (`Templates/Fold.md` missing from the
vault, or no vault reader wired into the routine yet — the two are
indistinguishable to `templateSkip`, and are treated the same way on
purpose): §6.4 would ordinarily mean "write nothing, record
`skipped: template_missing`". The fold's own file predates the template
(daily-flow-spec §13.2), so instead of losing a night's fold on an instance
that has not run `metistry init` since templates shipped, the routine falls
back to the pre-template instruction — write the note freeform, in your own
voice — at the SAME new path, with a visible note on the turn saying why
there is no skeleton. `runs.meta.fold_mode` and `inbound_messages.meta.fold_mode`
both say which of the two happened (`"skeleton"` or `"fallback"`), so it is a
fact you can query, not something to infer from the text.

The query store and the vault reader `Templates/Fold.md` (and any `include`
inside it) are read through are both **optional** on the routine's context —
absent, every query-backed or vault-backed directive renders its own §6.4
"not configured" note rather than failing the render. The console's runner
(`apps/console/src/runner.ts`'s `routineCapabilities`, called from
`apps/console/src/main.ts`) builds both, once, from the objects the process
already has for its own routes: the `QueryStore` as `ctx.queries`, and a
`TemplateReader` over the vault bridge client (`vaultReader`,
`routines/vault-reader.ts` — the same adapter `plan-tomorrow` builds from its
own `ctx.vault`) as `ctx.reader`. So on an instance with the reconciler
bridge configured and `Templates/Fold.md` stamped in the vault (`metistry
init`), the fold takes the skeleton path; the fallback above is what an
instance without either gets, not a permanent state of every install.

## Schedule (and why it is hourly)

`schedule: "@hourly"`, and the routine itself refuses to fold before **18:00
local** — the container's timezone is `METISTRY_TZ` — and refuses to fold twice
in one local day.

The gate has to live in the routine because the runner has no notion of time of
day; and the schedule has to be hourly *because* of the gate: the runner marks
a routine due from its last `routine_run` row, so an `@daily` routine that
skipped at 09:00 would be due again at 09:00 tomorrow and never reach the
evening. Hourly ticks plus two gates give one fold a night, retried each hour
until it lands. (This is the one deviation from the original spec, which said
`@daily`.)

## The guardrail at the tool

`knowledge_write` (`packages/mcp-brain/src/knowledge-write.ts`) refuses an
update to an existing note whose frontmatter `source` is neither the caller's
own id nor `knowledge-fold`:

```
forbidden: owned by user; propose instead
```

New notes are always allowed — **except under `Me/` or the user's own
journal** (`Journal/<date>.md`, `Journal/Meetings/**`), which are refused
whatever `source:` a new page would have had, because the check never even
reaches ownership: `core`'s `may()` refuses the PATH first, for every
principal but the user (`isUserOwnedPath`, docs/ops/assistant-tools.md "What
a write is" §3). `Me/` is discovered, never assumed (daily-flow-spec §6.6),
and this is that ruling made mechanical rather than left to the prompt below.
`Journal/Plan/`, `Journal/Fold/` and `Journal/Standup/` are each a routine's
own reserved subdirectory and are unaffected. `source` is stamped from the
credential and can never be claimed in an argument, so "notes I wrote" is a
fact, not an assertion — and ownership is judged from the note ALREADY ON
DISK, never from the incoming `content`, so a write cannot forge frontmatter
to claim a note it does not already own.

**A note with no `source:` in its frontmatter at all is the user's,
`USER_SOURCE`, not ownerless** (2026-09-19). That is exactly the shape of a
note you wrote by hand — Obsidian, an editor, another device, never carries
`source:` — and the original rule read its absence as "free to write",
which meant the fold's assistant turn could read a hand-written note and
re-emit it whole, unasked. The one exemption is `now.md` at the vault
root, by exact name: the assistant is required to keep writing it every
day (the morning brief, this routine's own "last fold" line), so an
instance whose seed predates this fix is not locked out of the one note it
cannot stop writing. `seed/vault/now.md` now ships with `source: assistant`
so a fresh instance never needs the exemption; it exists only for an
instance created before this change, and it stops mattering the moment
`now.md` is stamped once (every markdown write stamps `source`/`updated`,
so the very first write gives it real provenance).

When the deployment's vault read path is unavailable the write is
refused rather than waved through. Protected paths (`.metistry/identity.yaml`,
`.metistry/rules.yaml`, `.metistry/queries/`, `.metistry/agents/`, `.metistry/routines/`, …) are still refused behind
that, at the vault.

A refusal is not an error the fold retries: the assistant `report`s the change
it wanted to make and moves on, so it surfaces in your queue.

Behind ownership sits compare-and-swap, which is what actually protects an
edit *you* made: `knowledge_write` passes `expected_sha256` on every call
and an omitted one means create-only, so a page that changed under the fold
— you corrected it in Obsidian while the fold was thinking — is a
`conflict`, and the fold re-reads and redoes the edit instead of replacing
your version (`docs/ops/inbox.md`).

## Seeing what it did

- **The morning brief**, ⚙️ section: `• folded 6 item(s) into the vault last
  night (3 note(s) written)` — items from the fold's `runs` meta, notes from
  the `knowledge_write` tool calls that followed it.
- **The activity feed**: the fold turn appears like any other turn (thread
  `fold`), with its tool calls grouped under its `turn_id`.
- **The ledger**:

  ```sql
  SELECT ts, meta FROM runs
  WHERE component = 'knowledge-fold' AND kind = 'routine_run' AND ok
  ORDER BY ts DESC LIMIT 7;          -- counts, window, brief size, what was dropped
  SELECT ts, text FROM inbound_messages WHERE thread = 'fold' ORDER BY id DESC LIMIT 1;
  ```

- **The commits**: every page the fold writes is a commit by the assistant
  principal in the instance repo — `git log --oneline -- Journal`.

## Turning it off

Remove `knowledge-fold` from `routines/index.ts` (product change, a PR) — or,
without a rebuild, set the evening gate past the end of the day. The safest
instance-side switch is to revoke the assistant's write path
(`METISTRY_BRIDGE_TOKEN_RECONCILER` unset → `knowledge_write` answers
`not_available`), which stops the fold from writing while the routine keeps its
ledger. Nothing is lost either way: the material it folds stays in Postgres,
and the next enabled fold picks up from the last anchor.

## Deliberately not built

A model in the routine (invariant 4), a fold that reads the whole vault to
"reorganise" it, per-item turns, and any write outside the reserved paths.

Also: **moving a capture out of `Inbox/` to its home.** The fold
writes pages; it never files the inbox. `delete` and `rename` are not
exposed to the assistant at all, so a capture stays where it landed until
your hand moves it. When that lands it will be bridge write + delete with
compare-and-swap on both sides, so an edit made in Obsidian mid-fold wins
and the fold reports the conflict.
