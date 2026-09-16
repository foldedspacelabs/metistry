# Standing up a second Metistry instance

Checked here against a second Mac: M5 Pro, 64 GB, full admin, no cloud model credential yet,
LM Studio and the Devin, Cursor and OpenCode clients already installed. Follows the
second-instance-first order (`docs/plan-refresh-2026-09-13.md` §4b, W1–W7): the instance runs
with no model before it runs with one, local compute before cloud compute, Devin before the
tools whose fit is still open.

Every command below exists in `docs/ops/cli.md` or `packages/cli/src/main.ts`. `metistry` is
shorthand for `node packages/cli/dist/main.js`, run from the product checkout (step 1);
`npx @foldedspacelabs/metistry-cli` is the no-checkout form `init` alone also supports.

## 1. Install

**Not yet available: the signed DMG.** The Mac app is the intended installer
(`docs/ops/mac-app.md`) — its first-run wizard runs `metistry runtime install --from <bundle>`
for you. But the next release, v0.8.0, is the **first one carrying the compute changes this
guide depends on, and it has not been cut yet** (§4b W2). Until it exists, this Mac gets
`metistry` from a checkout:

```sh
git clone <the metistry product repo> ~/metistry && cd ~/metistry
pnpm install && pnpm -r build
brew install postgresql@17 pgvector     # a checkout never downloads the bundled runtime deps pack (docs/ops/bundled-runtime.md)
node packages/cli/dist/main.js --version
```

`--version` proves the build succeeded — there is no instance yet, so `doctor` has nothing to
check.

## 2. `metistry init`

```sh
node packages/cli/dist/main.js init ~/metistry-instance --name "<the assistant's name>"
```

Produces a private instance repo: `Knowledge/Inbox/` (captures, in the vault), `identity.yaml`
(the **only** place the assistant is named — CLAUDE.md: never in code, a path, or a table
name), `rules.yaml`, an entirely-commented-out `compute.yaml` copied from the seed (nothing
assigned yet, `docs/ops/compute.md`), and `metistry.lock`. It prints five `.env` lines — put
them in `~/metistry-instance/state/.env` (0600, gitignored) — and mints this instance's
`instance_id`. Point Obsidian's vault at `~/metistry-instance/Knowledge`.

On a macOS checkout like this one, `init` guesses the launchd shape by default (`--shape
compose` picks the container shape instead — `docs/ops/deployment-shapes.md`), so the printed
lines are already right for this Mac with no hand-editing: `METISTRY_RECONCILER_URL=http://127.0.0.1:7812`
and `METISTRY_ORIGIN=http://127.0.0.1:8080` — the console refuses to start without the latter.
(Previously `init` always printed the compose-shaped line and never emitted `METISTRY_ORIGIN`
at all — `docs/ops/deployment-shapes.md`'s own "What is still missing" #4, fixed 2026-09-16.)

## 3. `metistry up`, on the launchd shape

`init`'s guess above only decided what it printed; the instance's actual `deployment.yaml`
still defaults to `compose` until this sets it:

```sh
node packages/cli/dist/main.js deployment set-shape launchd --yes      # preview first without --yes
node packages/cli/dist/main.js up
```

`launchd` is the macOS shape: no Docker, a user-space Postgres under `state/pg`, and **one**
background item — `com.foldedspacelabs.metistry` — supervising Postgres, the console and the
reconciler as its children (`docs/ops/deployment-shapes.md`).

**With no engine assigned, this is what runs and what doesn't**
(`docs/ops/assistant-tools.md`, "Running without an engine"): captures, tasks, search, the
console and the reconciler's inbox scan all run; `node packages/cli/dist/main.js doctor` reports

```
assistant  service  absent   no assignments.default in compute.yaml — … fold turns wait
```

exit **0**, not a failure. `db`, `console`, `reconciler`, `supervisor:com.foldedspacelabs.metistry`
and `migrations` should read `ok`; the two TCC bridges (`eventkit`, `apple-fm`) read `absent`
because neither is configured — also healthy on a fresh instance.

## 4. Local compute — zero cloud, on purpose

`docs/ops/compute.md`. Either LM Studio (already installed):

```sh
node packages/cli/dist/main.js compute models list                       # LM Studio's own /v1/models, if a model is loaded there
node packages/cli/dist/main.js compute providers add --from lmstudio
node packages/cli/dist/main.js compute assign default lmstudio/<model-id>
node packages/cli/dist/main.js compute budget instance --monthly 60 --action stop
node packages/cli/dist/main.js up                                        # re-renders supervisor.json: the assistant child now exists
```

or the bundled `llama-server`, which Metistry runs itself:

```sh
node packages/cli/dist/main.js compute providers add --from llamaserver
node packages/cli/dist/main.js compute models install llamaserver/<hf-owner>/<hf-repo>/<file>.gguf
node packages/cli/dist/main.js compute assign default llamaserver/<hf-owner>/<hf-repo>/<file>.gguf
node packages/cli/dist/main.js up                                        # or: restart llamaserver
```

Neither template has an `auth.secret` — an on-machine provider needs no key, so
`assignments.default` alone satisfies `engineStatus` (`packages/core/src/compute.ts`), and
embeddings follow along automatically (`METISTRY_LOCAL_MODEL_URL` defaults to the first
`on_machine` provider's `base_url`, `docs/ops/knowledge-search.md`). **The privacy point:**
`locality: on_machine` means nothing leaves this Mac, there is no `data_policy` to write, and
cost is `$0` by definition (`cost_source: "local"`) — an absence of anywhere to bill, not a
budget under its limit.

`doctor` afterwards: `local:lmstudio` (or `local:llamaserver`) `ok`, and `assistant` flips
`absent` → `ok` — the second instance is thinking with zero cloud (§4b W7).

## 5. Later: a cloud provider

```sh
pbpaste | node packages/cli/dist/main.js compute providers add --from openrouter   # the key on stdin, never an argument
node packages/cli/dist/main.js compute assign deep openrouter/anthropic/claude-sonnet-5 --effort high
node packages/cli/dist/main.js secrets sync --to env                               # Keychain → state/.env, where the assistant's plist reads it
node packages/cli/dist/main.js up
```

The `openrouter` template ships `zdr: true` and pins the upstream (`provider.order:
[anthropic]`), so a router in front of a model never becomes a second router (invariant 4). An
`off_machine` provider without `zdr: true` still **works** — it writes one warning `runs` row
per (provider, model, day); informed choice, never a block (`docs/ops/compute.md`, "The
non-ZDR warning").

## 6. Connect the tools

One agent token per tool, minted and configured by one verb each (`docs/ops/cursor.md`,
`docs/ops/opencode.md`, `docs/ops/claude-code-plugin.md`, `docs/ops/devin.md`):

```sh
node packages/cli/dist/main.js connect cursor
node plugins/cursor/install.mjs           # the sessionEnd hook, for dev-session capture
export METISTRY_CAPTURE_ON_STOP=1
node packages/cli/dist/main.js connect opencode
node plugins/opencode/install.mjs
node packages/cli/dist/main.js connect claude-code   # mints the token, prints its export lines — does NOT install the plugin; which dev tool this instance settles on stays open (§4b)
node packages/cli/dist/main.js connect devin         # prints name/url/Authorization to paste at Devin → Customize → MCPs
node packages/cli/dist/main.js connect --list
```

`connect devin` prints `http://127.0.0.1:8080/mcp` — **loopback**: enough for a Devin CLI
session on this Mac, and reachable from none of Devin's cloud. That is the 2026-09-15 Exposure
ruling — no inbound path is assumed for this instance, so cloud Devin as an MCP *client* needs
a per-instance tunnel nobody has chosen yet, deferred until one is
(`docs/plan-refresh-2026-09-13.md` §4b, "Exposure").

There is no `doctor` row for an agent — it walks manifests, not the `agents` table. Check with
`connect --list` (each row `registered`, bearer and config path) and each tool's own view:
Cursor's MCP pane, `opencode mcp list`, Devin's **Test listing tools** button.

## 7. Devin knowledge-in

The pull half — Devin's notes and repo wikis land in the inbox as captures
(`docs/ops/devin.md`, "Knowledge in"):

```
# <instance>/state/.env
METISTRY_DEVIN_API_KEY=cog_…
METISTRY_DEVIN_ORG_ID=org-…
METISTRY_DEVIN_REPOS=org/repo-a,org/repo-b   # optional: the wiki half
```

```sh
node packages/cli/dist/main.js secrets sync --to keychain
node packages/cli/dist/main.js restart console
```

**The PAT-policy caveat:** an enterprise PAT policy is disabled by default at Devin — confirm
it is enabled for this key's organisation, or the key answers 401 and looks like a bad one.

`doctor` picks up the collector by its manifest: `devin-knowledge` reads `absent` (naming
`METISTRY_DEVIN_API_KEY`/`ORG_ID`) until both are set, then `ok` after its next `@hourly` run.

## 8. Devin as a target

The push half — a work row dispatched as a Devin session, the answer returned as a triaged
proposal (`docs/ops/devin.md`, "Dispatch out"). The product's manifest ships an **empty**
`allow` list (a third party whose default is "may train on your data"); widen it in this
instance's own overlay, never the product file (`docs/ops/targets.md`):

```
# <instance>/state/.env — METISTRY_DEVIN_ORG_ID: required for dispatch, not just knowledge-in
METISTRY_TARGETS_DIRS=targets:$METISTRY_INSTANCE_DIR/targets
METISTRY_DEVIN_ORG_ID=org-…
```

```yaml
# <instance>/targets/devin-sessions/manifest.yaml — the WHOLE file (D4: last one wins)
name: devin-sessions
type: target
transport: http
submit: { max_acu: 5 }
result: { via: report_queue, status_via: collectors/devin-sessions }
auth: env:METISTRY_DEVIN_API_KEY
cost: { per_run_estimate_usd: 0 }
data_policy:
  allow: [Knowledge/Projects]        # this instance's own areas
  deny_sources: [comms, devin]       # devin's own knowledge must not round-trip
  max_brief_bytes: 65536
```

`node packages/cli/dist/main.js restart console`, then a first knowledge-research dispatch — a
Board gesture; there is no CLI verb for dispatch itself, so the same call also works from a
script:

```sh
curl -s --cookie "$SESSION" -H 'content-type: application/json' \
  -d '{"target":"devin-sessions","purpose":"knowledge_research","max_acu":3,"brief":"…"}' \
  https://<origin>/api/tasks/<id>/dispatch
```

`doctor` walks `targets/` too: `devin-sessions` reads `absent` naming `METISTRY_DEVIN_ORG_ID`
until set, `ok` once the target's `check()` resolves.

## 9. The phone

No native app exists yet (an iOS target is "not started", `docs/ops/mac-app.md`; the offline
outbox `docs/research/2026-09-11-multi-instance-and-offline-client.md` designs for is
unbuilt). What is real: `GET /api/identity` (unauthenticated, `{instance_id, name, icon,
capabilities}`) is what any client — the future app, or the PWA today — uses to tell this
instance apart from the first one, keyed by `instance_id` since an origin can move. Once this
instance is reachable at some origin, the **first** instance's `metistry instances add
<origin>` records it in `instances.yaml` (`docs/ops/instances.md`); with no inbound path
chosen yet (step 6), use the console's PWA — "Add to Dock" in Safari — against whatever
reaches this Mac meanwhile.

## 10. Daily use

- **Feed** — the console web app's chronological timeline, polling every 10s.
- **Board** — a Kanban view over `work` (`docs/ops/board.md`): Backlog, Assigned, In Progress,
  Needs You, Done, Reported. A drag is offered only where the service would accept it.
- **Needs You** — five verbs; `l` (later — snoozes, never ends the item) and `s` (skip —
  settles it, nothing said) are the two batchable ones. **Approve as Work**, the sixth answer,
  appears on a `knowledge`/`report` proposal carrying `suggested_work`: one click decides the
  proposal and creates the `work` row (`docs/ops/reply-feedback.md`).
- **Rooms** — the comment thread on a `work` row, opened from a Board card that has one
  (`docs/ops/threads.md`).
- **The ledger:** `node packages/cli/dist/main.js runs export > runs.ndjson` — redacted
  NDJSON, each line carrying this `instance_id` and the qualified `agent:<name>@<instance_id>`
  form, so this ledger and the first instance's merge without colliding
  (`docs/ops/instances.md`).

## 11. Keeping it current

```sh
node packages/cli/dist/main.js update            # pull/build, migrate, restart what changed, pin, doctor
node packages/cli/dist/main.js migrate-inbox      # only if this instance predates 2026-09-16's Knowledge/Inbox/ layout — says so and changes nothing otherwise
node packages/cli/dist/main.js doctor             # weekly; a `degraded` row is a finding even at exit 0
```

## What is not there yet

- **A native iOS app** — step 9 is a placeholder for it.
- **Cloud Devin as an MCP client** — needs the inbound tunnel nobody has chosen (step 6); the
  local-CLI shape is what exists today.
- **The bake-off verdict** (`docs/plan-refresh-2026-09-13.md` §3) — which local model earns
  tier assignments beyond "it answers" is still running, on both machines.
- **v0.8.0 has not been cut** — this whole guide runs from a checkout (step 1) until it is.
