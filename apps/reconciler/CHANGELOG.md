# @metistry-apps/reconciler

## 0.15.1

### Patch Changes

- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1

## 0.15.0

### Patch Changes

- f40d905: **A restart no longer leaves the reconciler's writes uncommitted (W3 checkpoint D1).** The commit queue lived in memory for its 30 s flush window and SIGTERM took node's default — exit at once — so `metistry update`, which writes `.metistry/metistry.lock` and `.metistry/secrets.yaml` and then restarts the supervisor, left both dirty for good (the sweep never takes `.metistry/`). Now: on SIGTERM/SIGINT the reconciler stops its intervals and listener, commits the queue through the ordinary flush (at most 8 s, inside the supervisor's 10 s grace), then exits; the queue is journalled at `.git/metistry-pending-commits.json` on every change, and at start the reconciler commits whatever a killed run left there, with the principal, message and trailers it was queued with — only paths it queued itself, each re-checked against the bridge's path rules and `user`-only for a protected path, so nothing becomes committable that was not already. `metistry update` also asks for the commit itself (`POST /flush`, the new `commit` step) after its last write and before the launchd env step, so the lock and secrets are in history when the update ends.
- eda799a: **`GET /vault/log` is narrowed to the owner (ruled 2026-09-27, X-6).** `GET /vault/show` has always refused a `.metistry/` (or other protected/non-vault) path for every bearer; `GET /vault/log` did not, so a path-scoped request for a protected path, or a whole-tree read that happened to include a commit touching one, handed its subject and provenance trailers to any caller — including whatever fronts an agent. `vault.log()` now takes the caller class: for anyone but the owner bearer, a protected `path` is `403 forbidden` and a whole-tree read silently drops any commit that touched one. `Artifacts/` is left out on purpose — the console's artifacts service resolves a version's commit through this same door with its own (non-owner) bearer, and was never the confidentiality boundary `.metistry/` is.
- Updated dependencies [4099fcb]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0

## 0.14.4

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.4

## 0.14.3

### Patch Changes

- dcd9384: **A product file spelled in another case is named, and renamed.** `GET /vault/read` for `Me/profile.md` when the file is `Me/Profile.md` answered `invalid_request`, and the runner logged *could not be read (invalid request)*. Reads stay case-exact, but that is now `404 not_found` with `{"hint": "Me/Profile.md exists — the product's name is Me/profile.md"}`, which the console's client and the runner's log line carry. `metistry update` gains a **vault case** step that renames every `seed/vault/` file the vault has under another case only to the seed's spelling — two renames through a temporary name, each its own commit, through the reconciler as `user` — and `metistry doctor`'s **vault case** row lists any it finds, with the fix.
- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1

## 0.14.0

### Minor Changes

- 23b963a: Events become requests (T2-9, C96). **A failed routine** raises one `report`
  per error signature, carrying when it last ran cleanly and when it failed and
  a *Try Again* act; it clears as `resolved_at_source` the next time the routine
  succeeds. **A missing secret** — a `requires.env` variable or the engine's
  `auth.secret` — raises one request of the new stored kind `secret_failure`
  (read as access) naming every component it stopped, cleared once the variable
  is set. **A sync conflict copy** is now a `review` holding both versions (the
  note as it stands and the copy, with their hashes) instead of a path-only
  report, and clears when the copy is gone. All three are core mirrors: one row
  per subject while it waits, and an answer is not asked again until what it was
  about has recovered. The runner takes `requests` (default `runnerRequests`
  over its own db; `null` raises none).
- ed7f5c2: **File history (T10-4): `GET /api/knowledge/history`, `GET /api/knowledge/version`,
  and the reconciler's `GET /vault/show`.** F-1's two frozen rows are served. History
  is a note's commits, newest first, followed across renames — each naming the file
  as it was called then, what the commit did to it, and the committer's
  `Brain-Source:`/`Metistry-Run:`/`Metistry-Turn:` trailers (T10-1) as provenance.
  Version is the note's bytes at one commit, from the bridge's new `GET /vault/show`
  (`git cat-file blob`, base64 on the bridge). Both are the owner's alone and notes
  only: a protected or non-vault path is refused at the console and again at the
  bridge, for either bearer, and a `sha` that is not 7–64 hex characters is refused
  at both before it can reach git's argv; a commit not on the vault's branch is
  `404`. `GET /vault/log` gains the trailers on every entry and, with a path,
  `path` and `change` — additive. Both fixtures are re-recorded from their contract
  shape (a superset of it).
- 0dd4ccb: **Meeting refs and people emails (T1-10).** Migration `0029_meeting_refs.sql`
  adds two derived tables, `vault_meeting_refs (event_id, path)` and
  `people_emails (email, path)`. The reconciler's walk fills them from a meeting
  note's frontmatter `event_id:` (notes under `Journal/Meetings/`, the user's
  directory at the tool) and from a People page's `email:` (one address or a
  list, trimmed, `mailto:` dropped, lowercased; only pages the user owns), and
  rebuilds both whole every cycle. `POST /reconcile` reports `meeting_refs` and
  `people_emails`. The new named query `people_by_email` (`expose: route`)
  returns the one People page that claims an address, and nothing when none or
  more than one does: an unmatched attendee never resolves to a page.
- 406bacb: Resolve a conflict (T2-10, plan §2.11). `POST /api/knowledge/conflicts/resolve
  {path, keep, seen_sha}` is served: the owner keeps the note as it stands
  (`mine`) or takes the sync tool's copy (`theirs`), written as `user` through
  the reconciler's new `POST /vault/conflicts/resolve`, for a copy the index has
  in `conflict` and nothing else. `seen_sha` is the side being given up, as the
  review showed it; a mismatch, or a path not in conflict, is `409 stale` with
  the conflict as it stands (`null` when there is none). The side given up is
  committed before it is discarded, so history keeps it after the client's
  ten-second Undo (C136); a settle refused for any other reason is written on the
  conflict's review as `payload.error` (C45). The review clears at its source and
  the copy's index row goes at once. The reconcile sweep now commits the deletion
  of a conflict copy that history holds. Core gains `knowledgeConflictSource`
  (and its two constants), the conflict mirror's subject, which the console and
  the reconciler now share.
- 935901e: **Roll back (T10-6): `metistry vault rollback`, `POST /api/vault/rollback` and the
  reconciler's `POST /vault/revert`.** History is preserved, always: a rollback is ONE
  new commit, made as `user`, that undoes a commit (`git revert`), puts every path back
  as it was at a moment (`--to <date>`), or puts one file back (`--file`, before its
  last change or `--to` a moment) — computed off the working tree with `merge-tree`
  and a scratch index, applied by `merge --ff-only`, never a reset or a force. Undo is
  rolling back that commit. A re-walk and the push policy follow.
  
  Every rollback waits for Approve in Needs You. The route (F-1's frozen row, now
  served; reach `local`, so a passkey session is `403 local_only`) asks the reconciler
  for a preview and raises one request carrying it — the commits it undoes, the files
  it puts back; Approve runs the revert pinned to the previewed history and held to
  the previewed change set (`409 stale` otherwise). The reconciler refuses the revert
  for any principal but `user`, from either bearer. Configuration — every
  `.metistry/` path, `CLAUDE.md`, `README.md` — is left as it is and named
  (`skipped_config`) unless `include_config`, which a real revert admits only from the
  owner-class bearer: `metistry vault rollback --include-config` raises the request,
  waits for Approve and makes the change itself (`--request <id>` resumes the wait).
  `POST /api/proposals/:id` answers a rollback with `rolled_back`; its decision SELECT
  now carries `source` (additive, as T10-5's). `Git` takes an `indexFile` option (a
  scratch `GIT_INDEX_FILE`), and the committer a `holdHistory` hold.

### Patch Changes

- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [ac377ed]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0

## 0.13.0

### Minor Changes

- 95fb504: The Defer door: `POST /api/vault-tasks/:task_key/schedule {do | someday, seen_text, path?}` writes one `do <date>` or one `someday` on one line of the owner's note through the vault bridge as `user`, with the note's hash — the English spelling `formatTaskLine` emits, never a Tasks-plugin glyph (K6). It is the Tick door's discipline throughout: the line found in the note by the walk's own key, `409 stale` with the line as it stands when the text moved or the line was ticked, dropped or already deferred so, refusals before any read for `.metistry/`, dot-directories and `Artifacts/`, and `Idempotency-Key` replays. A line whose day is a `⏳` or a Dataview `scheduled::` is refused rather than given a second day. Core gains `setTaskScheduled` (proved by re-parsing its own output), the `someday` token in the task grammar (`ParsedTaskLine.someday`, `SOMEDAY_TOKEN`) and a `someday` flag in the filter vocabulary; migration `0036_vault_tasks_someday.sql` adds the derived `vault_tasks.someday` column, which the reconciler's walk writes and `vault_tasks_query` filters and flags on.
- 3a1ff8c: **The assistant's identity is the owner's to change, and every protected write is on the record (T2-16).** `metistry identity set [--name] [--mention] [--mark] [--dry-run] [--json]` (M10) changes `.metistry/identity.yaml` through the protected write — the reconciler as `user`, with the owner bearer. Every field is validated before anything is read or sent (a one-line name of at most 40 characters with no `{{`/`}}`, an `@kebab` mention, a single-glyph mark), the edited text is read back before it goes, and a refusal writes nothing. Only the changed lines are rewritten, so comments and `voice: >` keep every byte. The mark is the file's existing `icon:` key; a new name brings its mention along when the mention was the one `init` derived. The reconciler now records every protected-path write, delete and rename it accepts as a finished `config_write` run (`meta {path, op, from?, caller, principal, message}`), whichever door made it, and `activity_feed` shows those rows in the `run` group with the principal as actor — so a rename appears in Activity. The fixture recorder seeds one, and `get-api-q-activity_feed.json` is re-recorded.
- f932415: **Integrate before pushing (T10-3, plan §2.21).** The scheduled push is no longer a bare `git push`: it flushes and sweeps, fetches, and integrates first — a fast-forward when only the remote moved; a rebase when every local-only commit is the reconciler's own never-published act (each keeps its author, date, message and trailers); otherwise a merge as `Metistry reconciler`, so the owner's commits keep their shas. The result is computed off the working tree with `git merge-tree --write-tree` and `git commit-tree` (git ≥ 2.38) and the tree moves in one refusing step (`merge --ff-only` / `reset --keep`), with bridge writes held for that step. A conflict — both sides changed the same lines, an uncommitted edit in the way, unrelated histories — pushes nothing and touches nothing, sets `vault.state = conflict` (`check()` degrades and names the paths) and raises one Needs You `report` per episode; the next clean sync clears it. While the owner has a merge or rebase in progress in the working tree the committer stages, commits and syncs nothing. Every sync act is a `runs` row of kind `vault_sync` (`meta.state` `pull` / `push` / `conflict`), an integrate that changed files is followed by a fresh reconcile walk, and `Committer.pull()` exists for the pull schedule. `git.ts` now refuses, before exec, every argv that forces or rewrites history (`--force*`, `-f`, `--hard`, `+`/`:` refspecs, non-`--keep` resets, non-`--ff-only` merges, `rebase`, `checkout`, `branch`, `stash`, `update-ref`, …).
- 739564d: **One commit per act (T10-1, plan §2.21).** The reconciler's committer keys each commit by the act that made it instead of by `(principal, group)` per flush window: an explicit `group`, else the intent's `turn`, else its `run`, else the write alone. A commit carries `Brain-Source: <principal>` plus `Metistry-Run: <runs.id>` and `Metistry-Turn: <turn id>` trailers where known; two acts of one principal on the same path in one window fold into one commit carrying both. The bridge's intent gains `turn` and `run` (ids only — anything else is `invalid_request`, so a body cannot forge a trailer). The sweep of out-of-band edits is one `user` commit per sweep whose subject names its files (*Edits from Obsidian: 3 notes*). `knowledge_write` now sends the reply's turn handle and its call's `runs.id` instead of a per-agent group, so two replies in one flush window are two commits.
- 36d484d: **A remote commit touching a protected path is refused at integrate and reported (owner's ruling 2026-09-26, "refuse and report").** Integrate-before-pushing (T10-3) integrated the whole fetched tree, so a commit on the vault remote that changed `.metistry/**`, the root `CLAUDE.md` or `README.md` fast-forwarded or merged straight into the instance's configuration — the remote was a write path into how the system behaves. Now, before anything is computed or moved, the fetched commits are diffed against the merge base (`git diff --name-only <base> <remote>`); if any path is protected from the remote (`isProtectedFromRemote`: the §4.7 set, plus all of `.metistry/` including the gitignored `state/`, which git would overwrite silently, and case-folded spellings such as `claude.md` that land on the protected file on macOS), nothing is integrated and nothing is pushed. The sync state becomes `conflict` with reason `protected_path_from_remote` naming the paths and the offending commits (bounded: 50 paths, 20 commits), the `vault_sync` runs row carries `meta.state: conflict` and the reason, and ONE Needs You `report` is raised per offending remote commit (keyed `vault-sync-protected:<sha>`, so retries and restarts add nothing). The fetch is refused whole — a vault note riding in the same push waits too. Local commits keep landing and are pushed once the owner reverts the change on the remote or takes it by hand in a terminal. Vault-only remote commits integrate as before.
- a927e61: **The overlay: `scheduled.yaml` checked against the manifests, every field
  resolved with its origin.** Routine and collector manifests gain
  `display_name`, `config` (fields from a closed five kinds — text, path,
  number, boolean, choice — each with a default of its kind), and, for a
  collector, `needs_you` (its Needs You rules) and `presents_as`. Core's
  `entryProblems` / `checkScheduled` check each entry against its manifest —
  its section, its config keys and values, its raise rules — and the runner
  HOLDS a component whose entry does not fit, rather than ignoring the change;
  `resolveScheduled` resolves every routine and sync over manifest ⊕
  `Me/profile.md` ⊕ `scheduled.yaml` into `Sourced` fields (*default* · *from
  your profile* · *yours*) with the next run. The reconciler admits
  `.metistry/scheduled.yaml` as the console's third protected door — and still
  no other. Every collector moves to §2.5's closed shape (no shipped cron
  string is left); Inbox Sort (`inbox-drain`, every 5 min) and Usage Rollup
  (`claude-usage`, hourly) present as routines; GitHub declares
  `review_requested` and `assigned`. Manifest errors now name a bad record key
  by its rule rather than "Invalid key in record".
- ec21783: **The section operation: one writer per region in the owner's daily note
  (plan §2.13, T2-6).** The reconciler serves `POST /vault/section {path,
  marker, body, principal, expected_outer_sha}`: it replaces the bytes between
  `<!-- metistry:day -->` and `<!-- /metistry:day -->` in `Journal/<date>.md`
  and nothing else, appending `## Today · Metistry` with the markers the first
  time. It refuses `section_missing` (409) unless the note has exactly one
  clean pair outside any code block or frontmatter — two pairs, a lone marker,
  a marker quoted in code, an annotated one — and `conflict` unless the bytes
  outside the region hash to `expected_outer_sha`. Its writers are enumerated
  (`morning-brief`, `user`) and bounded by the bearer as every mutation is;
  every other non-user write to the note is still refused by `writeAllowed`.
  Optional `run` / `turn` make the section part of its run's commit, so a
  Morning Brief's brief file and section are one commit (plan §2.21).
  
  `@foldedspacelabs/metistry-core` adds the grammar callers hash with —
  `scanNoteSection`, `writeNoteSection`, `NOTE_SECTIONS`,
  `sectionMissingMessage` — and the `section_missing` error code (`409`).
- 37f0ed2: **The vault's sync policy and status (T10-2, plan §2.21).** `deployment.yaml` gains a `vault:` block — `push: after_commit | manual | {every: N}`, `pull: {every: N}` (1m…24h; no pull "never"), default after_commit and 5m — merged per key over the D4 overlay (core's `vault-sync.ts`). The reconciler schedules the committer's sync (T10-3) on it and re-reads the file when it changes: after_commit pushes after a flush that made commits and retries only what is unpushed, every N pushes on the interval when something is unpushed, manual never pushes; pull integrates every N; a standing conflict stops scheduled pushes. The committer already records push, pull and conflict; the schedule adds `commit` — one `vault_sync` run per flush that made commits, `meta.state = commit` — so `vault.sync` fires for all four states. The bridge serves `GET /vault/status`; the console serves it to the owner as `GET /api/vault/status`, strictly parsed. `metistry vault settings [--push …] [--pull …] [--yes]` shows and writes the policy (M18, a protected write through the reconciler as `user`), and doctor gains a *vault sync* row (ahead, behind, last push, conflict). `METISTRY_PUSH_SCHEDULE` still overrides `push` for this release, and says so everywhere it applies; `.env.example` no longer sets it.

### Patch Changes

- Updated dependencies [152022a]
- Updated dependencies [942372e]
- Updated dependencies [95fb504]
- Updated dependencies [df37d39]
- Updated dependencies [3d2e818]
- Updated dependencies [4451f77]
- Updated dependencies [3a1ff8c]
- Updated dependencies [6592f91]
- Updated dependencies [bf33ee1]
- Updated dependencies [bd29463]
- Updated dependencies [9ac7949]
- Updated dependencies [3f9d719]
- Updated dependencies [4cba65a]
- Updated dependencies [be25ade]
- Updated dependencies [c38dc4e]
- Updated dependencies [a927e61]
- Updated dependencies [06c854e]
- Updated dependencies [ec21783]
- Updated dependencies [a1f1113]
- Updated dependencies [24a9ddb]
- Updated dependencies [8c9dde6]
- Updated dependencies [8217e01]
- Updated dependencies [37f0ed2]
- Updated dependencies [5e8f8d1]
  - @foldedspacelabs/metistry-core@0.13.0

## 0.12.0

### Patch Changes

- 1edc2f7: **`Me/` and the user's own journal are refused at the tool for every non-user principal — new pages included.** `knowledge_write`'s ownership rule only ever ran against a note that already existed, so a brand-new page under `Me/` or the user's own `Journal/<date>.md` went straight through the default bare-vault grant every instance ships with — `Me/` is discovered, never assumed, and the daily journal is the user's alone (daily-flow-spec §5.1, §6.6). `core`'s `may()` now refuses the PATH itself, ahead of ownership, on both the `knowledge_write` tool and the reconciler's bridge (`writeAllowed`) — the second check exists because a routine's own commit (`plan-tomorrow`, the fold's routine half) reaches the vault directly and never asks `may()` at all. `Journal/Plan/`, `Journal/Fold/` and `Journal/Standup/` are each a routine's own reserved subdirectory and are unaffected. The seed vault also gains `Resources/README.md`, matching `People/` and `Projects/` — `seed/assistant-prompt.md` already told the fold to create entity pages there.
- Updated dependencies [2080ce5]
- Updated dependencies [7bf6db6]
- Updated dependencies [ac8a137]
- Updated dependencies [c69abc3]
- Updated dependencies [aafc41a]
- Updated dependencies [1edc2f7]
- Updated dependencies [56be405]
- Updated dependencies [d930fba]
- Updated dependencies [73977f8]
- Updated dependencies [a8ccdfc]
- Updated dependencies [87fc443]
  - @foldedspacelabs/metistry-core@0.12.0

## 0.11.0

### Minor Changes

- baf33c2: The vault bridge takes the principal from the credential, never from the
  request body.
  
  **The hole.** Every mutation through the reconciler's bridge carries
  `intent: { principal, … }`, and `principal` was the whole of the §4.7 check:
  `writeAllowed` admitted `.metistry/**`, `CLAUDE.md` and `README.md` for
  `principal: user` and refused everyone else. But `intent` is a field in a
  **request body**, and one shared bearer — `METISTRY_BRIDGE_TOKEN_RECONCILER` —
  reached that check. Any holder of it (the console, which terminates the
  network and multiplexes every agent on the install; anything that ever read
  the console's environment) could write `"principal": "user"` and rewrite
  `rules.yaml`, an agent definition, a named query, `metistry.lock` or the
  assistant's own instructions. Nothing did. Invariant 2 is worth only the
  stronger sentence (owner's ruling, 2026-09-20).
  
  **The wire change.** The bridge now derives a caller CLASS from the bearer and
  reads the body's `principal` as attribution inside what that class may claim
  (`CALLER_AUTHORITY`, `apps/reconciler/src/paths.ts`):
  
  | Bearer | Class | May claim | Protected paths |
  | --- | --- | --- | --- |
  | `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` (new) | `owner` | `user` only | all |
  | `METISTRY_BRIDGE_TOKEN_RECONCILER` | `console` | any principal | `.metistry/assistant-prompt.md` and `.metistry/compute.yaml` only |
  
  A body that exceeds its bearer is `403 forbidden` in the uniform envelope —
  never silently downgraded — and every refused mutation is a `runs` row
  (`component=reconciler, kind=auth`) carrying the caller class, the claimed
  principal and the path. Reads are unchanged: which bearer you hold decides
  what you may write, not what you may see. `check()` gains
  `meta.principal_from_credential` and `meta.owner_bearer`.
  
  The two protected paths left to the console are the two owner-authenticated
  doors it already ships: §4.10's self-modification overlay, which the owner
  allows in triage (`prompt-overlay.ts`), and `compute.yaml`, which the Compute
  pane's `assign`/`budget` write through the same function `metistry compute`
  calls (`compute-routes.ts`). Both are enumerated at the bridge rather than
  left to the console's restraint, so `identity.yaml`, `rules.yaml`,
  `deployment.yaml`, `metistry.lock`, `queries/`, `agents/`, `routines/`,
  `targets/`, `extensions/`, `CLAUDE.md` and `README.md` are refused whatever
  it asks for.
  
  **The new bearer.** `metistry init` mints it; `metistry up` and `metistry
  update` mint it for an install that has none — before they restart the
  reconciler, and `update` kickstarts the reconciler itself if nothing else in
  the run did — and `metistry secrets sync --to env` mints it as a
  `GENERATED_SECRETS` name. It is kept out of the console's environment by name
  (`CONSOLE_ENV_DENY` in the otherwise wholesale `METISTRY_*` passthrough
  `consoleEnv` builds), and `docker-compose.yml` never listed it. `writeProtected` presents whichever
  bearer its process holds and lets the bridge decide — the CLI's is the owner's,
  the console's is not — so a caller cannot widen itself by choosing a variable
  name. With no owner bearer configured anywhere, no caller may write a
  protected path at all, `metistry doctor`'s `reconciler` row is `degraded` with
  the command that mints one, and a 403 from the CLI names that cause.
- 579662f: The sole committer runs confined, and every confined child's egress passes
  one allowlisting door.
  
  **`ops/sandbox/reconciler.sb`.** Under the `launchd` shape the reconciler —
  the only process that holds the instance repo's working tree and the only
  place git runs (D5) — now runs under a Seatbelt profile, as the job's root
  process, so git and all 172 of its helpers inherit it. It writes the
  instance repo and tmp and nothing else; reads the product checkout, the node
  runtime, a real git's prefix and `~/.gitconfig` by name; execs node and that
  git and **no shell**; dials the console, Postgres, the on-machine embedder
  and the egress proxy, and binds only its own bridge port. D5 was a design
  intention; it is now a kernel rule. `metistry up` (and `--dry-run`) prints
  the profile each child will run under, and `metistry doctor` gains a
  `sandbox` row that reads the answer back out of `supervisor.json`'s argv.
  `METISTRY_RECONCILER_SANDBOX=0` swaps in `ops/sandbox/unconfined.sb`, a real
  file that says `(allow default)`, so "not confined" is never invisible.
  
  **`/usr/bin/git` is not a git** — it links against `libxcselect.dylib` and
  is the xcode-select shim, which dies under a profile. `up` resolves a real
  git by absolute path (bundled runtime, then a non-shim git on `PATH`, then
  the Command Line Tools) and declines to confine the job when it finds none.
  
  **The egress door.** `sandbox-exec` filters outbound by port and cannot name
  a host, so `assistant.sb` carried `(remote tcp "*:443")` with an honest note
  that its host list was documentation rather than enforcement. Both profiles
  now allow exactly one loopback port, and a CONNECT proxy in the supervisor
  listens there: an allowlist derived from this install's `compute.yaml`
  providers and its instance repo's git remotes, exact host and port matching
  (no wildcards), a 256-bit bearer per child so a refusal can name who asked,
  a `runs` row per refusal, and no TLS interception whatsoever — CONNECT only,
  so it learns a host name and never a byte of the tunnel. Children reach it
  through `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`; git reaches it through
  `METISTRY_GIT_HTTP_PROXY` → `-c http.proxy`. `supervisor.json` gains an
  `egress` block, read before any child is spawned, so no child can widen it.
  
  **Pushing still works, through `GIT_ASKPASS`.** git executes every
  credential helper through `/bin/sh` — including the built-in `osxkeychain`
  that `metistry connect-repo` configures — and this profile has no shell, so
  a confined push would have died on the helper. `GIT_ASKPASS` is exec'd
  directly, by absolute path, with no shell, so: the token stays in the login
  Keychain where `connect-repo` put it, the **supervisor** reads it there once
  at spawn (unconfined, the parent, and the item is filed `-A` so there is no
  prompt), and hands it to the child in its environment; a `#!<node>` shim
  `up` generates prints it when git asks and can do nothing else. The
  credential is never in argv, never in `supervisor.json`, never on disk.
  `git.ts` adds `-c credential.helper=` — git's documented reset — only when
  there is an askpass, so an unconfined install is untouched. Proven by a real
  push to a real bare repository over real HTTPS through the CONNECT tunnel,
  under `sandbox-exec`.
  
  **SSH remotes stay unsupported while confined**, and `up` still warns:
  `ssh` is not exec-able, granting it would mean granting the sole committer
  `~/.ssh`, and ssh's `ProxyCommand` runs through a shell so it could not
  reach the egress proxy either. Use an HTTPS remote or the off switch.
- 9a9d7a8: **Every todo in your vault is findable within a reconcile.** The reconciler's
  existing walk now fills `vault_tasks` and `vault_task_refs`
  (`docs/product/daily-flow-spec.md` §1.5, ticket P1-4): one row per `- [ ] …`
  line you typed, one row per `[[note#^mt-…]]` that names one. No new process,
  no second watcher, no second holder of the repo — this is already the pass
  that walks the tree and hashes it.
  
  **Derived in full, and it writes nothing back.** Drop the database, let one
  walk run, and every row returns from the markdown that produced it. The
  parser reads loosely — `due friday`, `critical`, `@Jim`, and on read only
  Dataview's `[due:: …]` and the Tasks plugin's emoji — and the resolved
  values land beside your line rather than in it. The only hand that edits a
  task line is yours.
  
  **The identity degrades honestly.** A line carrying an `^mt-…` anchor keeps
  it wherever it moves; a line without one is keyed by its text and its
  ordinal among identical lines in that file, so editing `due friday` to
  `due 2026-09-25` leaves the task alone and re-typing the words starts a new
  one with a fresh ageing clock. `first_seen_on` survives a re-walk, a field
  edit and a rename.
  
  A row is re-derived when the note's bytes change, which is a correctness
  property and not an optimisation: `due friday` is resolved against the day
  the walk *read* it, `parsed_on` records which day that was, and a row
  re-derived every five minutes would slide a Friday task onto the next Friday
  as soon as that one passed. A `[x]` with no date on it is stamped the first
  walk that saw it checked and never re-stamped; un-ticking it clears the
  stamp rather than leaving a lie.
  
  **A view is never a second task.** `Journal/Plan/…`, `Journal/Fold/…` and
  `Journal/Standup/…` render your todos and hold none of them — decided by the
  file's own `source:` frontmatter, the same ownership vocabulary
  `knowledge_write` already refuses on, so a plan you keep elsewhere is still
  indexed and a routine that writes somewhere new is still skipped. Their
  transclusions still become references, which is the whole reason the second
  table exists. `Templates/` is excluded for the same reason in reverse: a
  template describes tasks and has none.
  
  **And a `work` row that waits on you surfaces without ever gating.** A
  `meta.blocked_by` naming a human todo becomes a reference row of its own;
  `depends_on`, `DEPS_CLOSED` and claimability are untouched, so a typo in a
  note can never stall an agent. `work` is read here and never written.
  
  On a 400-note fixture holding 4,000 task lines: a cold walk with every note
  dirty costs 1,098 ms end to end against 385 ms for the same vault with no
  task lines in it, and a quiet walk 212 ms against 46 ms.

### Patch Changes

- Updated dependencies [4a778f9]
- Updated dependencies [4f43f9c]
- Updated dependencies [9c9da4a]
- Updated dependencies [1bf5c76]
- Updated dependencies [b6586de]
- Updated dependencies [579662f]
- Updated dependencies [57ceb02]
- Updated dependencies [45b64df]
- Updated dependencies [9ec30d5]
- Updated dependencies [7f9ceb7]
- Updated dependencies [23cc47f]
  - @foldedspacelabs/metistry-core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.9.1

## 0.9.0

### Minor Changes

- f57b3b0: **The instance directory is the Obsidian vault.** Open the folder `metistry
  init` made and your notes are right there — `Journal/`, `Me/`, `Inbox/`,
  `now.md` — with nothing of the machinery in the way. Everything that is not
  knowledge moved into `.metistry/`: identity, rules, compute, the config
  directories, the lock, and the derived `state/` that holds Postgres, the
  `.env` and downloaded models. Obsidian ignores dot-prefixed folders, which is
  the whole reason for the dot — the vault root and the install's own files can
  finally be the same directory without one of them cluttering the other.
  
  Vault paths lose their prefix with it: a note is `Areas/Fsl/Drey.md`, a
  capture is `Inbox/…`, and a read grant covering everything is spelled `/`.
  
  **The protected set became a place rather than a list.** Anything under
  `.metistry/` is the user's hand alone — except `.metistry/state/`, which is
  derived and nobody's record — plus the root `CLAUDE.md` and `README.md`.
  That is one rule the reconciler enforces at the tool, instead of seven
  filenames each component had to remember. Neither those two root files nor
  `Artifacts/` are indexed as knowledge: your instructions and your bundles are
  yours to read, not search results.
  
  This ships the layout for NEW instances. An existing instance keeps working
  unchanged and `metistry doctor` now says which shape it is in; the verb that
  moves one is the next change.

### Patch Changes

- c1f512e: **The assistant now uses your `identity.yaml` on the launchd shape, instead
  of the seed identity that ships with the product.** Every `*_FILES` overlay
  default resolved its instance half relative to the process's working
  directory, and every launchd job's working directory is the product
  checkout — so `.metistry/identity.yaml`, `rules.yaml` and `compute.yaml`
  named the product's own directory, found nothing, and the engine ran on the
  seed. `METISTRY_INSTANCE_DIR` was not in the engine's environment allowlist
  either, so it could not have resolved them itself.
  
  Fixed at the root: `metistry up` puts `METISTRY_INSTANCE_DIR` and
  `METISTRY_SEED_DIR` in every child's environment (the plists' env dicts and
  the supervisor's child specs alike), and core's `overlayFiles` resolves every
  default against the instance directory through `resolveInstanceLayout` — so
  it finds the file whether the instance has run `metistry migrate-layout` or
  not. The assistant, the console and the reconciler all read their overlays
  through it, which also means the console's router and the engine can no
  longer disagree about which `rules.yaml` is in force.
  
  The engine **refuses to start** when neither `METISTRY_INSTANCE_DIR` nor
  `METISTRY_IDENTITY_FILES` is set, rather than answering under the seed's
  name. `ops/sandbox/assistant.sb` grants read on the four config files by
  name (never on the directory holding them, which on an unmigrated instance
  is the vault root), so the reads the overlay now performs are permitted and
  nothing else in the instance is.
  
  Also: `metistry update --version <x.y.z>` was ignored — `version` was listed
  as a boolean flag, so the value never arrived and the latest release was
  installed instead. And in git mode `update` wrote the **pre-pull** version
  into `metistry.lock`; the version is now read from the checkout after the
  pull, so a run that fast-forwards onto a new release pins that release.
- 76f82a2: **An instance that has not run `metistry migrate-layout` is read again.**
  `db/migrations/0021` recorded that "a legacy instance keeps working unchanged
  until the verb runs". Verified against a clone of a real pre-ruling instance,
  it did not: #193 moved every path to `.metistry/` and every reader spelled the
  new one, so `metistry compute show` reported no providers while the instance's
  `compute.yaml` declared one, `metistry identity` exited 1 on an instance whose
  `identity.yaml` was right there, `metistry version` omitted the pin, `doctor`
  read `shape compose` off a `deployment.yaml` it never opened and probed the
  wrong half of the install, `metistry secrets`/`console`/`connect` could not
  find `state/.env` at all — which on a launchd install means every rendered
  plist's `__ENV_FILE__` points at a file that does not exist — and `up` would
  have `initdb`'d a second, empty Postgres cluster at `.metistry/state/pg`
  beside the live one.
  
  Two of the breaks were safety, not convenience. The §4.7 protected set became
  the `.metistry/` PLACE, which took the legacy machinery at the instance root
  out of it: on a legacy instance the assistant could write `identity.yaml`,
  `rules.yaml`, `metistry.lock`, `queries/` and `instance-migrations/` through
  `brain-commit` (invariant 2). And the knowledge walk, which now starts at the
  instance root, indexed those same files plus every byte of the gitignored
  `state/` — a Postgres cluster included — as notes.
  
  `resolveInstanceLayout(instanceDir)` in core is the fix: one `detectLayout`
  read, then the right relative-path table (`LEGACY_INSTANCE_LAYOUT` mirrors
  `INSTANCE_LAYOUT` key for key), with `instanceFile()` / `instanceStatePath()`
  as the reader's one-line call. Every reader goes through it — identity,
  rules, compute, deployment, the lock, the peer registry, `.env`, the Postgres
  data and socket dirs, the supervisor's config/socket/bin, `ports.yaml`, the
  models dir, the assistant's state dir, `doctor`'s compute overlay, the
  console's identity/peers/inbox, and the reconciler's inbox prefix (whose SQL
  predicate must match migration 0015's partial index on a legacy instance, not
  0021's). Writers are untouched: `instancePath`/`metistryPath` still spell the
  flat layout, because there is one layout to write and two to read.
  `isProtectedPath` and `isVaultPath` cover the legacy root names
  unconditionally — they receive a path and no instance directory, and the set
  is strictly safer on a flat instance, which has no business holding lowercase
  machinery at its root.
  
  `metistry update` now **refuses** to pin a version past 0.8.x onto a legacy
  instance, before it fetches, builds or migrates anything, printing the
  `migrate-layout` line to run; `--allow-legacy` overrides. Regression tests run
  one fixture in both shapes through the same readers, so a reader that resolves
  only one of them fails.
- c2c1916: **Defence in depth on `GET /vault/read`: the bridge itself now refuses machinery paths, not just the console sitting in front of it.** `confine()` only ever checked that a path stayed inside the repo, so `.metistry/state/.env`, `.metistry/compute.yaml`, `.obsidian/workspace.json` and the root `CLAUDE.md`/`README.md` all passed through and were served, at 200, to any caller holding the reconciler's bearer token — the console's `/api/knowledge/*` (#197) narrowed to vault content with core's `isVaultPath`, but that narrowing lived only on one door onto this bridge. A caller that goes straight to the reconciler now gets the same uniform `not_found` these paths get everywhere else knowledge is read. `Artifacts/**` is the one deliberate exception: it is binary content `packages/artifacts`'s `ArtifactsService` reads and writes through this exact endpoint, not vault knowledge, so it stays readable. `GET /vault/search`'s hits are now filtered through the same predicate too, belt-and-suspenders on a path that was already structurally vault-only.
- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1

## 0.8.0

### Minor Changes

- cde0691: **The inbox moved inside the vault, and human edits became first-class.**
  Captures live at `Knowledge/Inbox/` — Obsidian's vault root is `Knowledge/`,
  so that is the only place it can see them, add to them and edit them — and
  they are tracked, so git carries them: the inbox used to be the one thing a
  `docker compose down -v` rebuild could not bring back (invariant 1).
  `docs/ops/inbox.md`.
  
  - **One sink, every door.** `POST /capture`, the `/note` fast path, the
    bridge's `capture` tool and the collectors all write through the
    reconciler's vault bridge with `expected_sha256: ""` — must not exist — so
    a capture can never land on a file someone already wrote. The console still
    holds no part of the instance repo (D5, invariant 7), and each capture is a
    commit. With no bridge configured it degrades to a plain directory: capture
    keeps working, and moving those files into `Knowledge/Inbox/` later is
    enough for the scan below to pick them up.
  - **Files you write yourself are indexed.** The reconcile loop already walks
    the vault by content hash, so it now also reconciles `Knowledge/Inbox/`: a
    note you added in Obsidian gets a triage row, an edit to a capture
    refreshes its hash and — if it had already been classified or accepted —
    sends it back to `inbox-drain`, because a refinement is new information. A
    `rejected` row stays rejected; a deleted file archives its row rather than
    losing it; the file coming back re-opens it. No new watcher, no new
    component talking to Postgres (invariant 3).
  - **`knowledge_write` can no longer overwrite a note it has not seen.**
    Omitting `expected_sha256` used to mean "unconditional", which meant an
    edit *you* made to a page the assistant owns could vanish with no conflict
    and no trace but the commit. It now means create-only: an existing note
    answers `conflict` with the current hash, so changing a note requires
    `knowledge_read` first. Misuse test ships with it.
  - **Big captures.** Above `METISTRY_INBOX_MAX_TRACKED_BYTES` (5 MiB) a
    capture goes to `Knowledge/Inbox/.large/`, which the instance gitignores:
    Obsidian still sees a 40 MB screen recording, the repo does not carry it.
  - **`metistry migrate-inbox`** moves an existing instance — files (`git mv`
    for what git tracks), `.gitignore`, and `inbox.path` rows to the
    repo-relative form `db/migrations/0001_init.sql` always documented — with
    `--dry-run`, idempotent, restarting nothing. A second instance that already
    moved its inbox to a lowercase `Knowledge/inbox/` is renamed through a temp
    name, because macOS is case-insensitive and `git mv` would otherwise move
    the directory inside itself.
  
  Migration `0015_inbox_in_vault.sql` is additive: a partial unique index makes
  "one row per inbox file" true at the database, since the capture path and the
  scan both reach that directory now.

### Patch Changes

- 75c7547: **Local models: discovery, install, and a `llama-server` in the box.** Three
  local model servers, one protocol. LM Studio and Ollama are **peers** —
  discovered over `GET /v1/models` wherever they already run, never started by
  Metistry — and llama.cpp's `llama-server` is now **bundled**: built from
  pinned source into the runtime pack with Metal on, signed alongside Postgres
  and git, so a Mac with neither peer installed still has a local model
  provider and nothing to download first.
  
  `metistry compute models list` is live `/v1/models` against every declared
  provider **plus** a scan of the three known local ports, so a server that is
  running but that nothing dials is reported with the one command that would
  wire it up rather than silently omitted. `metistry doctor` carries the same
  finding as `local:lmstudio`, `local:ollama` and `local:llamaserver` rows —
  each `ok` with what it has loaded, or `absent`. **Absent is never a
  failure:** a Mac with no local server is a supported install and these rows
  can only add information.
  
  `metistry compute models install <provider>/<model>` speaks each server's own
  mechanism: `lms get` for LM Studio, streamed `POST /api/pull` for Ollama,
  and for `llama-server` one plain HTTPS GET of a Hugging Face GGUF into
  `<instance>/state/models/`, checked against the sha256 Hugging Face publishes
  before anything is written and then recorded as `serve.model_path`. `load`
  and `unload` act for LM Studio and are an honest message for the other two,
  which have no addressable load. No new dependency: a GGUF is one file behind
  one URL.
  
  `compute.yaml` gains an **additive, optional** `serve: { runtime, model_path,
  port, extra_args }` block. A provider without it is exactly what shipped
  before. A provider with it is one Metistry runs itself, as an optional
  supervisor child called `llamaserver` — `metistry logs llamaserver`,
  `metistry restart llamaserver`, a `child:llamaserver` doctor row. The host is
  hard-coded to loopback, the port must be the one `base_url` already dials,
  and a missing binary or GGUF is a note rather than a failed `up`.
  
  **Embeddings move to `/v1/embeddings`.** Knowledge search used Ollama's
  native `/api/embed`, which made Ollama the only server that could ever embed;
  it now posts the OpenAI-compatible route at `METISTRY_LOCAL_MODEL_URL`,
  defaulting to the first `on_machine` provider's `base_url` in `compute.yaml`.
  `METISTRY_OLLAMA_URL` keeps working as a deprecated alias — a bare host is
  mapped onto its `/v1` root — with one startup warning naming the new
  variable. `METISTRY_EMBED_MODEL` and `METISTRY_EMBED_DIM` are unchanged, so
  no re-embed is required.
  
  Docs: `docs/ops/compute.md` gains "Local models"; `docs/ops/bundled-runtime.md`,
  `docs/ops/cli.md`, `docs/ops/knowledge-search.md` updated.
- Updated dependencies [6aa64c2]
- Updated dependencies [26ffe39]
- Updated dependencies [70f6580]
- Updated dependencies [e48ea1e]
- Updated dependencies [ae0f9db]
- Updated dependencies [b99d4ad]
- Updated dependencies [75c7547]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
  - @foldedspacelabs/metistry-core@0.8.0

## 0.7.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

## 0.2.0

### Minor Changes

- 4774e08: Phase 6 — embeddings on reconcile, and semantic search behind the same
  grants.
  
  The reconciler embeds settled notes as it reconciles (local Ollama
  `nomic-embed-text`, model and dim per row) and gains
  `POST /embeddings/rebuild`. `GET /vault/search` and mcp-brain's
  `knowledge_search` take `mode=keyword|semantic|hybrid`, defaulting to
  hybrid once vectors exist and keyword before that. Every mode keeps the
  grant tier and the draft exclusion in SQL. With no embedder running,
  search still answers in keyword and the index is unaffected.
  
  Migration 0012 adds `knowledge_files.embedded_hash` / `embedded_model`
  (additive, derived).

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
