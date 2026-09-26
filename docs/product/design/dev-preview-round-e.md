> *Round E snapshot. Superseded names since: Resources → Connections (C114), Routines → Scheduled (C113). See HANDOFF.md.*

# Design → build, early preview

**Draft, 2026-09-22.** Round E is still in progress, so this is a preview rather
than a handoff: the shapes below are settled enough to plan against, and the list
at the end is explicitly *not yet decided*. Nothing here is a request to change
code today.

One framing note, because it changes how to read everything else. **The design is
being drawn against the product as it should be, not as the wire currently
serves.** Where a surface needs a value nothing returns, it is drawn anyway and
logged as a numbered contradiction (C-number) in `review-00-plan.md`. So a
"missing query" below is a design finding, not a bug report — and the intended
order is: the design settles, then the build adapts, then we reconcile.

---

## 1. What the interface now is, structurally

### 1.1 The navigation is eight rows

**Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents · Routines**, then
**Pinned**. Work's children are Board · Projects · Artifacts · Rooms.

Two changes from what the build has:

- **Routines is top-level** (C50). Scheduled compute is not a kind of agent, it is
  an assignment *of* one, and *"what is Metistry running for me every day"* is a
  daily question a child row would bury.
- **Resources is not a nav row.** It was briefly a ninth and moved to **Settings ▸
  Resources** (C57), because a connection is configured once and then read from the
  permissions tables that reference it.

`design-system.md` P6 — same rows, same order, same names on every platform —
survives; the count does not, for the second time. The standing rule is now that a
third break should move something out rather than add a row.

### 1.2 New screens, specced

| Screen | Spec | What it is |
| --- | --- | --- |
| Agents | `screen-07-agents.md` | Roster of everything that can act for the owner: locally defined agents (definition, permissions, schedule) and remotely connecting agents (permissions and project only — no definition, because we do not have their prompt) |
| Routines | `screen-08-routines.md` | Every scheduled run in one place, ordered by next run, with a deep link to the agent that runs it |
| Settings ▸ Resources | `screen-09-resources.md` | Proxied MCP servers; per-tool **On · Ask · Off** |
| Knowledge | `screen-10-knowledge.md` | **Rebuilt** — the nightly fold's prose, then what needs the owner's eye, then areas described rather than counted; collector status folded to one line |

**Metis itself does not appear on Agents.** It represents the user and is unscoped
because it *is* the user (C52) — so `ASSISTANT_DEFAULT_AREAS = [VAULT_ROOT_AREA]`
must not be rendered as a grant anywhere, because a grant implies it could be less.
The asking mechanism (`request_access`, `agent_grant_overrides`, migration 0023)
stays meaningful only for an operator who deliberately configured it narrower.

---

## 2. Rules that became system-wide, not per-screen

These are the ones most likely to affect code you have already written, because
each one showed up on three or four surfaces before it was named. They are written
up in `design-system-amendments.md`.

1. **A failed consequential operation leaves the request pending** (C45). An
   `action` that throws writes `payload.error` and the row stays pending — no
   retry, nothing half-applied. An access refusal does the same. This is a rule
   about how the product fails, and the UI is drawn to match it everywhere.
2. **Absence is the denial** (C58). A permissions table lists one row per resource
   with **Read** and **Write** columns, and *anything not listed is not granted*.
   There is no per-cell state control and no "Allow" affordance — the list of what
   an agent cannot do is infinite. The only state left is one glyph meaning *this
   verb waits for you*.
3. **The owner's choice is the whole control** (C61). A proxied tool has exactly
   three states — **On · Ask · Off** — and *Ask* **is** preview-then-confirm. No
   second "previews first" marker beside a tool the owner deliberately set to On.
   What a tool does belongs in its description.
4. **Ask means pause when interactive, defer when unattended** (C59). A tool set to
   *Ask* raises a request in Needs You (web push; `apps/console/src/push.ts`
   already maps `alert` to "Needs You"). But a routine at 6:02 AM has nobody to
   ask: **the run finishes without that step and reports what it skipped.**
   Blocking for hours and failing the whole run are both wrong. Also: a
   destructive tool **defaults** to *Ask*; it is not forbidden from being *On*.
5. **Contrast is mechanical, and three separate mistakes were found by measuring**
   (C49, C54, C63):
   - `border` divides · `border-control` outlines a control · **a mark that
     carries meaning takes an ink token, never a border token.** `border-strong`
     measures 1.60–2.08:1 and can never carry a mark despite its name.
   - When two marks must be told apart, use the **weight** channel, not two inks —
     the agent hue and the neutral ink separate at only 14.3 ΔE in dark mode.
   - **Never dim a strong ink with opacity**; take a dimmer ink at full opacity. A
     read-only mark at `opacity: 0.55` composites to 1.86:1 with every token
     chosen correctly.
6. **Three colour channels that never borrow from each other.** Hue = *what kind of
   thing*; weight/fill = *how much it matters*; tint = *something is wrong*. If a
   new state needs a colour, it comes from the channel that matches its meaning.

---

## 3. What the design needs from the wire

Ordered by how much they unblock, with the C-number for the full write-up. Each is
a read, except where noted.

### 3.1 Knowledge

1. **The newest fold, served as data** (C65). `routines/knowledge-fold/run.ts`
   already writes `Journal/Fold/<date>.md` from `Templates/Fold.md`, in the
   assistant's voice, as its own commit — and no query returns it. It is now the
   top of the Knowledge screen. Needed: the newest fold's **body** and its
   **outgoing wikilinks** (the links double as *what the fold named last night*,
   which is the relevance signal on the Areas list).
2. **Drafts, for the owner only** (C66). `knowledge_pages` drops `status: draft`
   using the same `WHERE` clause `mcp-brain` applies. The exclusion is right for
   agents and wrong for the owner, who is the only person who can settle a draft.
   Needed: a drafts read for the owner, or an owner flag on the existing query.
   Good news: the decision row already exists —
   `db/migrations/0002_review_decisions.sql` has `kind: draft_settle`, and its own
   comment notes that `status: draft` frontmatter marks the same row. **The design
   shows one pending item in two places on purpose:** Needs You asks yes/no,
   Knowledge gives it reading width and an *Edit First* button. Answering either
   answers both.
3. **One written line per area** (C68). The Areas list describes each area in a
   sentence — *"Sleep, labs, and the protein blend"*. A file count is available and
   is not an answer. The fold routine already writes prose, so this is plausibly the
   same routine writing one line per area index.
4. **A per-collector last-ok time** (C1 → C48 → C64). *Is this current* is now four
   rounds old. `agent_presence` has no collector notion; `activity_feed` takes
   `collector_run` only `WHERE ok = false`, so a **healthy** collector is invisible
   in both. Until this exists, the `stale` state cannot be drawn on real data on any
   surface. Two requirements when it lands: the age **annotates** the row and never
   replaces the value, and a **failed** source carries *two* timestamps — *last
   succeeded 2 days ago · token expired*, never *failed 2 hours ago*, which invites
   the reader to think the data is two hours old.

### 3.2 Agents and actions

5. **`effectiveActions` should return the reason, not just the mode** (C46, C47).
   `packages/core/src/actions.ts` resolves the effective table and drops whether a
   value was **defaulted** (`ACTION_DEFAULTS`) or **clamped** (`LEVEL_CEILING`).
   Three surfaces recompute it to tell the owner which they are looking at, and
   clamped is the one case where the owner's own setting is being overridden. Also:
   the console has no notion of the effective table at all, so a console rendering
   `agents.autonomy.actions` would disagree with `metistry agents autonomy` — and
   the console would be wrong.
6. **The four action kinds are verbs on domain models** (C53). `dispatch`,
   `task_update`, `comment`, `capture` are drawn as **Model · Action · May**, not as
   four flat strings — and `comment` is one kind reaching **two** models, since
   `commentArgs` takes either `work_id` or `artifact_id` + `version_id`, exactly one.
   User-facing words: **On · Ask · Off** (C93, 2026-09-23; this preview first said Allow · Ask First · Never).
7. **Proxied external MCP servers need a model** (C56). Metistry holds the
   credential for a server a remote agent cannot reach, and mediates. Structurally
   that is a row in the same permissions table with one new provenance value —
   *Through Metistry* — and no new primitive. Two constraints: the agent never holds
   the credential, so that table is the only control; and a per-server grant cannot
   be a single switch, because reading the owner's vault and acting in a system
   other people watch are not the same risk.

### 3.3 Routines

8. **A routine needs a display name separate from its directory name** (C55).
   `routines/<name>/manifest.yaml` has `name` and nothing else, so what the owner
   reads on a schedule they check every morning is a slug. Agents already separate
   `id` from `display_name`; the id stays the stable handle. The design lets the
   owner rename a routine in place.
9. **A routine's task definition is additive on the agent's prompt.** The detail
   view shows two layers: **DEFINITION** (inherited from the agent, read-only here)
   and **TASK** (the routine's own, editable, appended). A routine may also grant
   **more** permission than the agent has by default, scoped to that run.
10. **Run history needs the full session, not just the result** (owner request). The
    owner must be able to open a past run and read the agent's prompt and output to
    debug it. `seed/queries/run_detail.yaml` is closer to this than anything else
    and is currently drawn nowhere.

### 3.4 One state to ratify

11. **`partial` — path known, metadata not** (C28). Four rounds without an
    instance; it now has two. `knowledge_files.status = 'conflict'` is a file the
    reconciler could not settle, *so its title and mtime are not facts yet*. That is
    not `failed` (nothing broke), not `absent` (the file is there), not `stale` (not
    about age). Recommendation: ratify it as the fifth state, with the rule that
    such a row says **why** the value is missing rather than showing a blank or the
    filename dressed up as a title.

---

## 4. Not decided — do not build to these yet

- **Where Chat lives** (C60). If Metis is the owner's own reach and everything else
  on the nav is something it delegates to, Chat may not be a peer of Work and
  Knowledge at all — a persistent pane or rail rather than a destination. Raised as
  a direction, not a decision. It would take a row off the sidebar and change what
  the others mean.
- **How an *Ask* approval is delivered.** Push notification, an in-app dialog, or
  Needs You alone — and what it looks like when the run is unattended (the *defer
  and report* behaviour in §2.4 is settled; the delivery is not).
- **Granting a resource to a project or team rather than to an agent** (D13). Open.
- **Motion** (C16). One amendment is drawn with alternatives and unruled; until it
  is, there is no animation in the product.
- **Whether Settings can hold Resources at all** (C62, with C5). Settings is a
  fixed, non-resizable window (`apps/macos/sources/kit/settings-view.swift:47`), and
  a table of tool names, descriptions and a three-state control does not survive
  `accessibilityExtraExtraExtraLarge` in a window that cannot grow. **Either
  Settings becomes resizable or Resources is not a Settings pane** — this one is a
  real fork and it is worth an early opinion from your side.

---

## 5. Where to read the detail

- `HANDOFF.md` — start here; it names what is ratified and what is still open.
- `design-system-amendments.md` — the positive rules from rounds C–E, which is the
  shortest path to *what changed in the system*.
- `review-00-plan.md` §7 — all 68 contradictions with file-and-line evidence.
- `screen-07-agents.md`, `screen-08-routines.md`, `screen-09-resources.md`,
  `screen-10-knowledge.md` — one screen each; written to be read one at a time.
- The canvas (`Metistry brand — round A`, version 40) — every screen drawn in light
  and dark, with the reasoning panels beside each render.
