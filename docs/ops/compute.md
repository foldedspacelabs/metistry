# Compute — `compute.yaml`

One file says where work runs, what may leave the machine to get there, and
what it may cost: **providers**, **assignments** and **budgets**. It lives in
the instance repo's `.metistry/`, next to `rules.yaml` and `deployment.yaml`.

A provider is **configuration, not a component** — there is no
`providers/<name>/manifest.yaml` to write. Invariant 5 ("everything is a
directory with a manifest") is met the way `deployment.yaml` meets it: by a
schema in `packages/core` (`src/compute.ts`) that the CLI, CI and the Mac app
all validate against. Adding a provider is one command, not a directory.

`.metistry/compute.yaml` is a **§4.7 protected path**. Where work runs is how the
system behaves, so only you change it (invariant 2): `metistry compute` and
the app write it through the reconciler as the `user` principal, the way
`.metistry/deployment.yaml`, `.metistry/identity.yaml` and `.metistry/metistry.lock` are written. The
assistant cannot write it at all.

## What is NOT wired yet

This page describes the file, the verbs over it, and — since PR 3 — the
engine that dials a provider. Deliberately still absent, each a named PR in
`docs/plan-refresh-2026-09-13.md` §4:

- **No app pane.** The Compute pane, and wizard step 7 becoming "Choose your
  compute", are PR 1a — deliberately split so the verb surface settles first.
  The *server* half is no longer missing: five of the verbs are console routes
  ("From the console", below), so the pane is a client to write rather than an
  API to design.
- **No bundled local server.** `llama-server` built into the runtime-deps
  pack is PR 2; LM Studio and Ollama work today as ordinary
  OpenAI-compatible providers.
- **No local discovery.** `compute models list` against a live `/v1/models`
  is PR 2.
- **No rubric score on a shadow run.** Shadow mode itself is here (below);
  what it records is a deterministic agreement measure. The rubric is
  `packages/eval`'s, on the owner's fixtures (§3.8), and the engine leaves a
  hook for it rather than inventing a second scorer.

Until you write `assignments:`, **there is no engine**: `metistry up` does not
start the assistant, `metistry doctor` reports `assistant: absent`, and
captures, tasks, search and the console all keep running while queued turns
wait (docs/ops/assistant-tools.md, "Running without an engine"). That is why
the seed's `seed/compute.yaml` ships entirely commented out — a seed that
assigned a model would spend somebody's money on an assumption.

## The file

```yaml
providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine                     # nothing leaves; no data policy, no cost
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }   # a NAME. The value is in the Keychain.
    zdr: true
    request: { provider: { order: [anthropic], allow_fallbacks: false } }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
    pricing: { anthropic/claude-sonnet-5: { in_per_m: 3, out_per_m: 15 } }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium, critical: true }
  tiers:
    fast:    { model: lmstudio/google/gemma-3n-e4b, effort: low }
    routine: { model: lmstudio/google/gemma-3n-e4b, effort: low }
    deep:    { model: openrouter/anthropic/claude-sonnet-5, effort: high }
  crews:
    researcher: { model: lmstudio/google/gemma-3n-e4b }
budgets:
  instance:  { daily_usd: 5, monthly_usd: 60, action: stop }
  providers: { openrouter: { monthly_usd: 20, action: stop } }
```

## The rules the schema enforces

Every one of them is a refusal that **names the field** that would permit it,
so a validation error tells you what to edit.

| Rule | Why |
| --- | --- |
| `model` is one `<provider>/<model-id>`; the provider must be declared in the same file | A reference says where it runs. The overlay replaces a file whole, so there is no other file it could mean. |
| Everything after the first `/` is the id, verbatim | LM Studio and OpenRouter ids contain slashes (`google/gemma-3n-e4b`). |
| No `/auto`, no list of fallbacks | The router is deterministic (invariant 4): no model decides which model runs. An auto-router hands that choice to the provider. |
| `auth.secret` is an UPPER_SNAKE_CASE **name** | A pasted `sk-…` cannot match it. The value lives in the login Keychain, never in the repo. |
| `locality: off_machine` requires `data_policy` | What may leave this machine is a declaration, not a default. It is the §4.18 target policy schema, reused. |
| A budget needs `daily_usd` or `monthly_usd` | An action with no limit never fires, so it is not a control. |
| Unknown keys are errors | A typo must fail loudly rather than silently do nothing. |
| `assignments.default` is required whenever `assignments:` exists | It is where every unnamed and unknown tier lands; half here and half in `rules.yaml` is the split "one read path into state" exists to prevent. |
| `shadow:` needs a `fraction`, belongs to `default`, and may not name the model already assigned | The rate is the spend, the engine reads the block in one place, and a shadow of the incumbent measures nothing while costing twice ("Shadow mode" below). |

`zdr: false` (or absent) on an `off_machine` provider is **a warning, never a
block** — informed choice.

`critical: true` may be set on any assignment, and the seed sets it on
`default` (OPEN-4, ruled 2026-09-17): under a budget's `critical_only` the
turn you are waiting on keeps being answered, while routines and delegation
stop. The mark travels with the **assignment**, not with the turn's
importance, so a tier or crew that falls back to `default` inherits it —
declare `tiers.routine` explicitly if the pause is meant to apply to it.

## Where it is read from — the D4 overlay

`METISTRY_COMPUTE_FILES`, colon-separated, default
`seed/compute.yaml:.metistry/compute.yaml`. The **last existing file wins, whole** —
there is no deep merge, so your instance's file always stands alone and is
always readable on its own. The same rule as `METISTRY_RULES_FILES`.

Both the console and the assistant **watch the file** and reload it without a
restart. The degradation is deliberate:

- an invalid file **at startup** throws and the service does not start
  (the same way a broken `rules.yaml` does);
- an invalid file **at reload** keeps the last good configuration and writes
  one `runs` warning row naming the file that broke — an editor's
  half-written save cannot take a running install's assignments away.

## The verbs

```sh
metistry compute show [--json]
metistry compute providers list [--json]
metistry compute providers add --from openrouter|lmstudio|ollama|llamaserver|applefm \
        [--name <n>] [--base-url <url>] [--secret <NAME>] [--skip-test]
metistry compute providers remove <name>
metistry compute providers test <name> [--complete]
metistry compute models list [--provider <name>] [--json]
metistry compute models install <provider>/<model> [--json]
metistry compute models load|unload <provider>/<model> [--ttl <seconds>] [--json]
metistry compute assign <default|<tier>|crew:<name>> <provider/model> [--effort low|medium|high]
metistry compute budget <instance|provider:<name>> [--daily <usd>] [--monthly <usd>] \
        --action allow|stop|critical_only
```

Every verb takes `--json` (the app's surface) and `--dry-run` (print the
plan, write nothing). Every write goes through the reconciler as `user`, and
the **result is validated before it is written** — an edit that would produce
a file the engine could not load is refused and the file is left untouched.
Hand-written comments, ordering and blocks the verbs do not cover survive
every edit, because the file is edited as a YAML document rather than
re-serialised.

A first run looks like this:

```sh
metistry compute providers add --from lmstudio          # a local server, no key
metistry compute models list --provider lmstudio        # what it will actually serve
metistry compute assign default lmstudio/google/gemma-3n-e4b
metistry compute assign deep lmstudio/google/gemma-3n-e4b --effort high
metistry compute budget instance --monthly 60 --action stop
metistry compute show
```

`assign default` comes first: it is where every unknown tier lands, so the
verbs refuse a tier or a crew until it exists.

### Secrets

`providers add` asks for the key **on stdin** and puts it in the login
Keychain. It is never an argument, never echoed, never written to the repo,
and no `--json` result or rendered line can carry one. Provider credentials
are **user scope** — the account with the provider is yours, not one
instance's, so every instance on this Mac shares it and
`metistry secrets purge` never touches it (`secrets.ts` `SECRET_SCOPES`).

`providers test` is a real `GET <base_url>/models` with that credential;
`--complete` adds a one-token `POST <base_url>/chat/completions` on an
assigned model, carrying the provider's own `request:` block — the only
thing that proves the key can buy a completion rather than just list a
catalogue.

### From the console

Five of the verbs above are also console routes, so compute is not Mac-only
and the Compute pane works from the phone (`docs/ops/console-api.md`
`/api/compute*`, `docs/product/app-ux-plan.md` §6 phase D):

| route | the verb it is |
| --- | --- |
| `GET /api/compute` | `compute show --json`, plus `spend` (both budget windows, from the `spend` named query) and `writable` |
| `GET /api/compute/models[?provider=]` | `compute models list --json` |
| `POST /api/compute/assign` `{tier\|crew, model, effort?}` | `compute assign` |
| `POST /api/compute/budget` `{scope, daily?, monthly?, action}` | `compute budget` |
| `POST /api/compute/providers/test` `{name, complete?}` | `compute providers test` |

They are the **same exported functions**, not a second implementation: the
same YAML-document edit, the same re-validation of the result before anything
is written, the same write through the reconciler as `user`. A refusal reads
identically on both doors because it *is* the same refusal.

**Two verbs are deliberately not there: `providers add` and `providers
remove`.** Adding a provider takes a key, and a key goes on stdin into the
login Keychain from the hand of the person at the machine — a *user*-scoped
credential shared by every instance on that Mac is not one instance's to
accept over HTTP. So **adding or removing a provider, and anything that takes
a secret, stays CLI/app-only.** `GET /api/compute` reports the secret's NAME
and whether an item of that name exists (`secret_present`), never a value;
where there is no login Keychain — a container — it reports the honest
`false`.

**They are owner-only configuration, not console "actions".** Invariant 10
closes the console's *action* surface: a closed, enumerated set, each entry a
door onto an existing audited service, a new one a product change
(`docs/ops/actions.md`). These routes are not on that list and must not be
added to it. `compute.yaml` says how the system behaves, so it is the `user`
principal's alone (invariant 2) — an agent bearer and a capture owner token
both get the canonical `403`, no `propose_action` kind reaches it, and no
autonomy level can.

**Writing needs a readable instance directory.** Every write opens
`<instance>/.metistry/compute.yaml` as a document, so the console must be able
to read it: the launchd/native shape can, the compose shape deliberately
cannot (D5 — the reconciler is the sole holder of the instance repo), and
there every route answers `503` naming `METISTRY_INSTANCE_DIR` while
`metistry compute` keeps working. If `METISTRY_COMPUTE_FILES` ends somewhere
other than that file the write is refused with both paths named, rather than
starting from a bare header and overwriting the real one.

## Templates

`seed/compute-templates/<name>.yaml` is one provider block each:

| template | what it is |
| --- | --- |
| `openrouter` | one key, most models; pins `provider: { order: [anthropic], allow_fallbacks: false }` so a router in front of a model does not become a second router |
| `lmstudio` | LM Studio's local server on port 1234 |
| `ollama` | Ollama's OpenAI-compatible surface on port 11434 |
| `llamaserver` | the **bundled** `llama-server` on port 7813 — Metistry starts it |
| `applefm` | **Apple Foundation Models**, through the `apple-fm` bridge on port 7810. Cost 0, and the weights are already resident for the OS — see below |

`--name` and `--base-url` rewrite the block on the way in, so a second
machine's Ollama is `--from ollama --name box --base-url http://10.0.0.4:11434/v1`.
Any OpenAI-compatible endpoint works without a template — write the block by
hand, or start from the nearest one. **One cloud template ships** (OPEN-7,
ruled 2026-09-17): OpenCode Zen and every other OpenAI-compatible cloud are
reached by writing the block — a base URL, a secret NAME, `data_policy`, and
`pricing:` when the response carries no cost (the commented example in
`seed/compute.yaml` is the shape) — rather than by a seeded file whose base URL,
prices and retention we would be promising to keep true. Copy `openrouter` only
if the provider really is ZDR: `zdr: true` is a claim, and claiming it removes
the C13 warning.

## The engine

One interface, `apps/assistant/src/engine.ts`, and a factory keyed on the
provider's `kind`. What a turn runs on is configuration, resolved to a
(provider, model, effort) triple **before** anything is called — the router
names a tier, `resolveTurn` resolves it, and no model is ever asked which
model should run (invariant 4).

| kind | engine | when |
| --- | --- | --- |
| `openai-compatible` | the in-house loop, `engine-openai.ts` | always — it is the only kind |

**One kind, one wire protocol** (C2). Claude arrives through OpenRouter like
any other cloud model; there is no second engine, and nothing in the product
brushes a vendor SDK. `kind` stays a field rather than being dropped because a
later one — a bundled `llama-server` with GBNF grammars, a native Messages
adapter — is then an additive change to an enum instead of a schema rewrite,
and because a file naming an unknown kind must fail loudly rather than be
treated as OpenAI-shaped.

There is no engine for a turn nothing assigns. Because an unknown tier
resolves to `assignments.default`, an install that assigns anything assigns
everything: write a `default` and every turn has somewhere to run. Write
nothing and the assistant is not started at all — a supported shape, reported
as `absent`, never as a failure.

**The loop**, about 300 lines over `fetch`, the MCP client and zod — no new
dependency (C4):

- **Tools** are the console's `/mcp` and nothing else (invariant 9). One
  `tools/list` per run, `tools/call` per call, the same bearer the SDK path
  presents — a crew gets its own per-run token and its `uses` allowlist.
- **`max_turns`**, and a graceful ending: when the cap, the per-run cost cap
  or the veto stops the loop, one more request goes out with `tool_choice:
  "none"` so the run answers instead of throwing. Which one stopped it is on
  the `runs` row as `meta.stopped`.
- **The no-progress veto** (Atomic ADOPT 4). A turn is *unproductive* when
  every tool call it made repeats a (name, arguments) already made in this
  run **and** comes back byte-identical. Three in a row adds one nudge; five
  ends tool use and asks for the answer. A call whose answer changed is
  productive however often it repeats.
- **Backoff** on 429 and 5xx, honouring `Retry-After`; a refused connection
  (the local server is still loading) retries on the same schedule. A 4xx
  that is not 429 is not retried — a bad request will be bad again.
- **Structured output** is `response_format: json_schema` *plus* a zod
  validation and ONE repair retry, because LM Studio warns sub-7B models may
  fail it and OpenRouter says some endpoints treat it as a hint. Two failures
  is a failure; it never returns unvalidated JSON.
- **Effort** becomes `reasoning: { effort }` off-machine and reasoning-off
  on-machine (PoC-16). Per-model reasoning style is a bake-off measurement,
  not an assumption.
- **Shadow mode**, for the sampled fraction `assignments.default.shadow`
  names: the same turn run again on a candidate with tools stubbed
  record-only, after the real answer is already delivered. See "Shadow mode".
- **The provider's `request:` block is merged verbatim** — except `model` and
  `messages`, which belong to the assignment. A `request:` that could repoint
  the call would hand the routing decision back to the file the router was
  supposed to obey.

**Sessions.** The SDK kept a transcript and gave us an id to resume; an
OpenAI-compatible endpoint has none, so the message array *is* the session
and lives in `assistant_sessions` (migration `0016`) under the same id
`sessions` uses. A task boundary rolls both tables at once, so a rolled
thread cannot be replayed. A session built against a different (provider,
model) is never resumed: re-assignment is exactly the moment a fresh session
is cheap.

**Cost lands on the row, not in an estimate.** Every call writes `provider`,
`model`, `tokens_in`, `tokens_out`, `cache_read_tokens`, `cache_write_tokens`
and `cost_usd` on `runs`, plus `meta.cost_source` saying where the number
came from:

| source | meaning |
| --- | --- |
| `provider` | the response's own `usage.cost` — OpenRouter always sends it, and it is the only number that knows your account's discounts |
| `pricing` | the provider's `pricing:` table, for clouds whose responses carry no cost |
| `local` | `locality: on_machine` is 0 by definition |
| `unknown` | nothing could price it: recorded as $0 **and said so**, never a guessed rate. `metistry doctor` and the weekly review read this |

## Budgets

Enforced **in the engine, before the call**, against the `spend` named query
(`seed/queries/spend.yaml` — invariant 3: one read path, and `cache_ttl: 0`,
because a budget that read a cached number would keep spending for the length
of the cache). A budget checked after the call is a report; checked before it
is a control.

```yaml
budgets:
  instance:  { daily_usd: 5, monthly_usd: 60, action: stop }
  providers: { openrouter: { monthly_usd: 20, action: stop } }
```

| `action` | at the limit |
| --- | --- |
| `allow` | record only — the call proceeds, and a `runs` row says the window is spent |
| `stop` (default) | the call is refused with `budget_exceeded`, nothing is bought, **and routines pause** |
| `critical_only` | only an assignment marked `critical: true` keeps running — the seed marks `assignments.default`, so interactive turns still get answers while routines and delegation stop (OPEN-4, ruled 2026-09-17) |

**At 80 %** of any window a warning `runs` row is written, once per calendar
window (so once today, again tomorrow; once this month for a monthly one).
**At 100 %** what happens depends on who asked:

- **a chat turn** is refused, and gets ONE more window *offered* as a Needs
  You item — a `decision` proposal plus an alert. It does not raise the
  budget and could not: `compute.yaml` is a protected path, so the limit
  moves by your hand (`metistry compute budget …`) or not at all. What the
  item buys is that you hear about it where you already read things, with the
  exact field in front of you.
- **a routine** does not start. `requires: { engine: true }` in a routine's
  manifest is the declaration that its run would enqueue a billable turn; the
  runner's preflight asks the same budget question first and records
  `blocked_config` instead of spending the window (C5 — a stopped engine
  behind a running scheduler just fills the queue with refusals).
- **a crew** fails with `budget_exceeded` and its work row parks as `blocked`
  with the reason. Retrying would re-run the check and land in the same place.

Every refusal names the field that would permit it, and the action that would
relax it. A budget that cannot be measured — `budgets:` set but the `spend`
query not loaded — **refuses**, because a control that silently cannot run is
worse than no control at all.

## Shadow mode

The bake-off's **stage 2** (`docs/plan-refresh-2026-09-13.md` §3.7): measure a
candidate model on your own real turns, before anything depends on it.

```yaml
assignments:
  default:
    model: openrouter/anthropic/claude-sonnet-5
    critical: true
    shadow: { model: llamaserver/qwen3.6-35b-a3b, fraction: 0.1 }
```

One turn in ten, **after** the real answer has been delivered and its session
saved, the same turn is run again on the candidate. Both transcripts and an
agreement number land on that turn's `runs` row. **The candidate's answer is
never shown to anyone** — it is not the turn's reply, it is not a session, and
there is no path from the column it lands in to the console or the phone.

| | |
| --- | --- |
| `model` | one pinned `<provider>/<model-id>` this file declares, like every other model reference. It may not be the model the assignment already uses — a shadow of the incumbent measures nothing and doubles what the turn costs, so the schema refuses it by name |
| `fraction` | 0..1, **required**. The rate *is* the spend: one turn in ten shadowed is one turn in ten paid for twice, and a default here would pick somebody's bill for them. `0` is a legal way to stage the block in with nothing running |
| where | `assignments.default` only. A block on a tier or a crew is refused with the field, rather than accepted and never read |

**Tools are stubbed record-only, by construction.** The shadow's tool surface
is the same *list* the real run saw, and calls against it are written down and
never performed:

- a call the real run made **identically** (same name, same arguments, byte
  for byte) is handed **the real run's own result**, so the candidate's next
  step is judged against the same facts rather than a fiction;
- anything else gets one fixed `(recorded, not executed: …)` string.

This is not a promise the model is asked to keep. The stub host is handed a
list of names and a map of strings and closes over nothing else — no MCP
client, no URL, no token — so there is no object in scope it *could* execute a
call against. A shadow of a turn that wrote to the vault does not write to the
vault twice.

**Agreement is cheap, deterministic, and says what it is.**
`shadow_agreement` is the mean of two numbers: whether the candidate made the
same tool calls **in the same order** (names only — a differently-phrased
search for the same step is agreement), and token Jaccard over the two final
answers. It needs no model, so it cannot drift, and the same row re-scored
next year gives the same number. It is **not** a quality score: that is
`packages/eval`'s rubric on the owner's fixtures, and stage 3's gate is both
("≥ the bar on the fixtures *and* two weeks of shadow agreement").

**The shadow is a turn, so it is budgeted like one.** Before it runs it asks
the same pre-call gate every turn asks — with the candidate's own provider and
`critical: false`. Under `stop` or `critical_only` the shadow simply does not
happen while the interactive turn it followed keeps its answer. Its spend is
its own `runs` row of kind `shadow`, carrying the provider that was actually
paid, so `spend` and every per-provider budget count it with no change to the
query; `runs.shadow_cost_usd` is the same number denormalised onto the turn
for the report.

**Nothing it does can cost you the turn.** The real answer exists before the
shadow starts. A candidate that is down, a credential this install has not
set, a model id that does not exist, a database write that fails — each lands
as a note on the row, never as a failed reply.

### Reading it back

```sh
metistry brain            # → queries_run shadow_agreement { runs: 200 }
curl -s "$CONSOLE/api/q/shadow_agreement?runs=200" -H "authorization: Bearer $TOKEN"
```

`seed/queries/shadow_agreement.yaml` (invariant 3's one read path) reports, per
candidate, mean agreement, how often the tool sequence matched, mean answer
similarity, what the shadowing cost and how many shadow runs failed — over the
last N **shadowed** turns, because the gate is stated in runs, not in dates.
The weekly review's System section carries one line per candidate, and omits
it entirely when nothing is being shadowed.

Columns are additive migration `0020` on `runs`: `shadow_provider`,
`shadow_model`, `shadow_transcript` (both transcripts and the measure, in one
jsonb), `shadow_agreement`, `shadow_cost_usd`. The transcripts live in
Postgres, which is derived (invariant 1) — a rebuild loses the trend line and
nothing else, and no transcript is ever committed to the product repo
(`docs/poc/poc18-bakeoff/README.md`).

## The non-ZDR warning

An `off_machine` provider without `zdr: true` writes one warning `runs` row
per (provider, model, day) and then **works**. Informed choice, never a block
(C13, the owner's ruling). The row is what makes it informed: the app's badge
and the weekly review both read it. Sending `data_collection: "deny"` by
default instead is OPEN-3 and is not built.

## The collaboration rule

Five rules, enforced by the shape of the system rather than by prompting
(C7):

1. **Engine is `provider.kind` from config.** A turn never runs on an engine
   its tier did not name, and there is no cross-kind fallback.
2. **No tool calls an engine.** There is no "run this on provider X" tool —
   invariant 9 by absence. The factory is called by the drain, never from
   inside a turn.
3. **A crew follows its own provider**, `assignments.crews.<name>`, not the
   assistant's. Crews never call each other: work moves as `work` rows and
   results come back as reports.
4. **Scoping work is collaboration; naming the worker is triggering it.** A
   turn may create *unassigned* work any agent can claim. A **directed**
   `agents_delegate` to a crew whose engine kind differs from the caller's is
   refused with `invalid_request` and a `runs` row naming the field
   (`assignments.crews.<name>`). With one provider kind in the schema today a
   valid `compute.yaml` cannot produce that mismatch — the guard is what
   makes the rule hold the day a second kind lands, rather than a thing
   someone has to remember to add then.
5. **Every provider's agents are peers at `/mcp`**, each with its own token
   and scope.
## Local models

Three local servers, **one protocol**: `GET <base_url>/v1/models` is how all
of them are discovered, and `POST /v1/chat/completions` is how all of them
will be called. Two of them are **peers** Metistry finds where they already
run; one is **bundled**, and is what is there when neither peer is.

| | port | Metistry's relationship to it | installing a model |
| --- | --- | --- | --- |
| **LM Studio** | 1234 | a peer — discovered, never started | `lms get <id>` (its own CLI) |
| **Ollama** | 11434 | a peer — discovered, never started | `POST /api/pull`, streamed |
| **`llama-server`** | 7813 | **bundled**: built from pinned source into `runtime/llamacpp/`, signed with Postgres and git, started by the supervisor | one HTTPS GET of a Hugging Face GGUF |
| **Apple Foundation Models** | 7810 | **the OS's**: served by the `apple-fm` bridge, which the supervisor already runs | nothing to install — the model belongs to Apple Intelligence |

### Discovery

```sh
metistry compute models list
```

lists every declared provider's live `/v1/models` **and** any of the four
local servers that is answering but that no provider dials:

```
lmstudio: http://127.0.0.1:1234/v1/models → 2 model(s)
  lmstudio/qwen/qwen3-coder-30b
  lmstudio/text-embedding-nomic-embed-text-v1.5

Ollama on http://127.0.0.1:11434/v1: not configured — `metistry compute providers add --from ollama`
  (ollama)/gemma3:4b
```

`metistry doctor` carries the same finding as four rows — `local:lmstudio`,
`local:ollama`, `local:llamaserver`, `local:applefm` — each `ok` with what it
has loaded, or `absent`. **Absent is never a failure.** A Mac with no local
model server is a supported install, so these rows can only add information.

Apple FM is the one local server that **authenticates**: it is a Metistry
bridge, and every bridge route takes the bearer. Discovery sends
`METISTRY_BRIDGE_TOKEN_APPLE_FM` (or the provider's own `auth.secret`, when
`compute.yaml` names a different one), because a probe that forgot it would
get a truthful 401 and report a running bridge as absent.

### Installing a model

```sh
metistry compute models install lmstudio/qwen/qwen3-coder-30b
metistry compute models install ollama/gemma3:4b
metistry compute models install llamaserver/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf
```

Each one is the server's own mechanism, spoken directly. For
`llamaserver` the reference is `<hf-owner>/<hf-repo>/<file>.gguf` — the file
name is on the repo's **Files** tab — and Metistry:

1. downloads `https://huggingface.co/<owner>/<repo>/resolve/main/<file>`
   into `<instance>/.metistry/state/models/<owner>/<repo>/`, streamed to disk;
2. checks it against the sha256 Hugging Face publishes (`X-Linked-Etag`).
   A mismatch **discards the download and writes nothing**;
3. writes `providers.<name>.serve.model_path` into `compute.yaml` as the
   `user`, through the reconciler, like every other write here.

`METISTRY_HF_TOKEN` is only needed for a gated or private repo; a 401/403
says so by name.

`load`/`unload` act for LM Studio (`lms load --ttl`) and are a **message**
for the other two, because neither has an addressable load: Ollama loads on
the first request and evicts after `keep_alive`, and the bundled
`llama-server` holds exactly the model `compute.yaml` names for as long as
it runs.

### `serve:` — the one server Metistry runs

```yaml
providers:
  llamaserver:
    kind: openai-compatible
    base_url: http://127.0.0.1:7813/v1
    locality: on_machine
    serve:
      runtime: llamaserver
      model_path: .metistry/state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf
      port: 7813
      extra_args: ["--ctx-size", "8192"]
```

`serve:` is **additive and optional**: a provider without it is exactly what
PR 1 shipped, a base URL somebody else is listening on. A provider *with* it
says "this one is mine to run", and `metistry up` renders a supervisor child
called `llamaserver` beside the console and the reconciler —
`metistry logs llamaserver`, `metistry restart llamaserver`, and a
`child:llamaserver` row in `doctor`.

What the schema refuses, and why:

- `serve.port` that `base_url` does not dial — a server Metistry starts must
  be reachable where it listens, and the port is otherwise stated twice.
- `serve:` on an `off_machine` provider — it is a statement about a process
  on this machine.
- a `runtime:` that is neither `llamaserver` nor `applefm` — LM Studio and
  Ollama are peers, not children. Metistry never claims another app's
  lifecycle.
- a `model_path` that is not a `.gguf`, or a `llamaserver` block with no
  `model_path` at all.

The **host is not configurable**: the child always binds `127.0.0.1`. A
config line that could put an unauthenticated completion endpoint on the
network would be exactly the kind of thing invariant 8 exists to prevent.

**Loopback alone is not enough, so `--cors-origins` is set too.**
`llama-server`'s default is `*`, which means any web page you happen to visit
can `fetch('http://127.0.0.1:7813/v1/…')` *and read the answer* — free use of
your local model, and a fingerprint of what you have loaded. Metistry starts
it with an origin value no browser can ever send, so the response is
unreadable cross-origin.

`extra_args` is passed verbatim **after** the flags Metistry sets (`--model`,
`--alias`, `--host`, `--port`, `--cors-origins`), and llama.cpp takes the
last occurrence of a flag — so it is also how you override one on purpose:

```yaml
      extra_args: ["--ctx-size", "8192", "--embeddings", "--pooling", "mean"]
```

`--embeddings` and `--pooling mean` go together: a causal model defaults to
pooling `none`, and `/v1/embeddings` refuses that with
`Pooling type 'none' is not OAI compatible`. Both flags or neither.

A missing binary or a missing GGUF is a **note, not a failure**: `up` says
which and carries on with one fewer provider, because bringing the whole
install down over a moved model file would be a far worse answer.

## Apple Foundation Models

The model macOS already keeps resident, as an ordinary provider.

```sh
metistry compute providers add --from applefm
```

```yaml
providers:
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
    auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM }
    serve:
      runtime: applefm
      port: 7810
```

Pin it as `applefm/foundation-model` — one provider, one model id.

**Why it is worth a provider block.** Cost 0 and ~0 extra resident memory:
the weights belong to Apple Intelligence and are in RAM for the operating
system whether Metistry runs or not (PoC-19 measured the bridge's own
footprint at 23 MB against 840 MB for an LM Studio serving a 4B GGUF). It is
the one local model that costs nothing to keep available — which is exactly
what an unattended collector needs.

**What it is for, and what it is not.** It is small: good at **reduction**
(classify, extract, tag), weak as a judge (PoC-15). Latency is ~270 ms for
plain text and ~500 ms for a three-field schema. Pin real work elsewhere.

### The surface

`GET /v1/models` and `POST /v1/chat/completions`, on the bridge's own
loopback listener, under **the same bearer as every other bridge route**.
Invariant 8 is why: the network is not a boundary, and a `/v1` that skipped
authentication because "it is only a local model" would be an
unauthenticated completion endpoint on loopback. The engine presents
`METISTRY_BRIDGE_TOKEN_APPLE_FM` exactly as it presents an OpenRouter key —
`metistry secrets sync --to env` is what puts it where the engine reads it.

`response_format: { type: json_schema, … }` is the point of the surface: the
caller's JSON Schema is translated per request into Apple's
`DynamicGenerationSchema` and enforced at generation time. Supported:
`object` with `properties`/`required`, `string` (with a string `enum`),
`integer`, `number`, `boolean`, `null` (macOS 26.4+), `array` with
`items`/`minItems`/`maxItems`, and `anyOf`.

**What it refuses, loudly, rather than degrading:**

| | |
| --- | --- |
| `$ref`, `$defs`, `oneOf`, `allOf`, `not`, `patternProperties` | `400 unsupported_schema` — silently dropping a constraint would make `strict: true` a lie |
| a schema or prompt that would not fit the 4096-token window | `400 context_length_exceeded`, **naming the field**, preflighted with the model's own tokenizer rather than discovered as a `500` mid-generation |
| `stream: true` | `400 stream_unsupported` — no SSE mapping is proven |
| `tools:` | `400 tools_unsupported` — out of scope for v1 |
| `n` other than 1 | `400 n_unsupported` |
| macOS older than the API a request needs | `503 not_available` |

`/v1` errors use OpenAI's envelope (`{error:{message,type,code}}`) because
their caller is an OpenAI client; `/check` and `/classify` keep Metistry's
(`{error:{code,message}}`).

**The window is small and the schema is charged to it.** 4096 tokens total,
and with the schema in the prompt each described field costs roughly 32 of
them — about 40 fields before latency alone rules it out. That is why the
preflight exists.

**Serial by design.** The bridge's Swift helper answers one generation at a
time: it reads a request, awaits it, and only then reads the next. Apple
Foundation Models is one shared system daemon, and a queue of one is the only
behaviour we can honestly describe. Concurrent callers see latency, never an
error.

**Parse the answer; never string-match it.** Apple's structured output does
not emit object keys in a stable order — PoC-19 measured twenty identical
generations coming back as twenty different byte strings and one value.
Anything that hashed, regexed or compared raw output would see differences
that are not there.

**Redaction moved, and did not vanish.** `/classify` scrubs the model's free
text before returning it; `/v1` cannot, because a provider surface has to
hand back exactly what the model said. The deterministic scrub now runs in
the caller — `completeJson()` applies it to every string leaf of the parsed
result, which covers every collector rather than one route.

### What a collector may call

A collector runs unattended, on a clock, with nobody reading the answer until
later, so it may never call a **billable** model. Since the refresh made the
free on-device tier an ordinary provider, that rule is mechanical rather than
something to remember:

```yaml
# collectors/inbox-drain/manifest.yaml
uses_model: applefm/foundation-model
```

One pinned `<provider>/<model-id>`, the same spelling `compute.yaml` uses —
a provider name alone would satisfy the cost rule but not invariant 4, since
"no model decides which model runs" is not met by naming a server and taking
whatever it lists first.

Two checks, on purpose:

- **CI** resolves the provider against `seed/compute-templates/<name>.yaml`
  and fails if it is not `locality: on_machine`
  (`apps/console/test/manifests.test.ts`). That catches the shipped default.
- **`completeJson()`** resolves the same name against the `compute.yaml`
  actually in force and **throws** before building a request. That catches
  the live one — an instance can rename a provider or repoint it after CI has
  run.

`locality: on_machine` is the whole condition: cost for an on-machine
provider is not a field anyone fills in, it is 0 by definition
(`cost_source: "local"`).

Everything else about the tier **degrades absent** — no such provider in
`compute.yaml`, no credential in the environment, a bridge that is not
running, an answer that is not the schema — and the deterministic
classification stands. `metistry doctor`'s `local:applefm` row and the
watchdog's `fm-tier-never-fires` probe are what make "configured but never
used" visible rather than silent.

> **Upgrading:** `inbox-drain` used to reach the bridge's own `/classify`
> route from `METISTRY_AFM_URL`. It now goes through the provider, so an
> install that wants the model tier back needs one command —
> `metistry compute providers add --from applefm` (add
> `--base-url http://host.docker.internal:7810/v1` in the container shape).
> Without it the drain is deterministic, which is a supported install, and
> `metistry doctor` says so.

### Embeddings

Knowledge search embeds through the same protocol —
`POST <root>/v1/embeddings` against `METISTRY_LOCAL_MODEL_URL`, defaulting
to the **first `on_machine` provider's `base_url`** in `compute.yaml` and, if
there is none, to a default Ollama. `METISTRY_OLLAMA_URL` still works as a
deprecated alias (with one startup warning) — details in
`docs/ops/knowledge-search.md`.

## Related

- `docs/plan-refresh-2026-09-13.md` — the decisions (C1–C18) and the PR order.
- `docs/research/2026-09-11-local-models-openrouter-opencode.md` — the
  research behind them, including what each vendor actually offers.
- `docs/ops/targets.md` — dispatching work to somewhere else entirely, which
  is a different thing from choosing which model answers a turn.
