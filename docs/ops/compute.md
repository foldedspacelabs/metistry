# Compute — `compute.yaml`

One file says where work runs, what may leave the machine to get there, and
what it may cost: **providers**, **assignments** and **budgets**. It lives in
the instance repo, next to `rules.yaml` and `deployment.yaml`.

A provider is **configuration, not a component** — there is no
`providers/<name>/manifest.yaml` to write. Invariant 5 ("everything is a
directory with a manifest") is met the way `deployment.yaml` meets it: by a
schema in `packages/core` (`src/compute.ts`) that the CLI, CI and the Mac app
all validate against. Adding a provider is one command, not a directory.

`compute.yaml` is a **§4.7 protected path**. Where work runs is how the
system behaves, so only you change it (invariant 2): `metistry compute` and
the app write it through the reconciler as the `user` principal, the way
`deployment.yaml`, `identity.yaml` and `metistry.lock` are written. The
assistant cannot write it at all.

## What is NOT wired yet

This page describes the file, the verbs over it, and — since PR 3 — the
engine that dials a provider. Deliberately still absent, each a named PR in
`docs/plan-refresh-2026-09-13.md` §4:

- **No app pane.** The Compute pane, and wizard step 7 becoming "Choose your
  compute", are PR 1a — deliberately split so the verb surface settles first.
- **No bundled local server.** `llama-server` built into the runtime-deps
  pack is PR 2; LM Studio and Ollama work today as ordinary
  OpenAI-compatible providers.
- **No local discovery.** `compute models list` against a live `/v1/models`
  is PR 2.
- **No shadow mode.** Running a `default` turn again on a candidate with
  tools stubbed, to compare, is the bake-off's stage 2.

Until you write `assignments:`, **`rules.yaml`'s `tiers:` block is still the
live map** and turns run on the Claude Agent SDK, exactly as before. That is
why the seed's `seed/compute.yaml` ships entirely commented out.

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
    data_policy: { allow: [Knowledge/Projects], deny_sources: [comms], max_brief_bytes: 65536 }
    pricing: { anthropic/claude-sonnet-5: { in_per_m: 3, out_per_m: 15 } }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium }
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

`zdr: false` (or absent) on an `off_machine` provider is **a warning, never a
block** — informed choice. `critical: true` may be set on an assignment; it
is recorded only, because what it may cover under `action: critical_only` is
still an open question (OPEN-4).

## Where it is read from — the D4 overlay

`METISTRY_COMPUTE_FILES`, colon-separated, default
`seed/compute.yaml:compute.yaml`. The **last existing file wins, whole** —
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
metistry compute providers add --from openrouter|zen|lmstudio|ollama|llamaserver \
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

## Templates

`seed/compute-templates/<name>.yaml` is one provider block each:

| template | what it is |
| --- | --- |
| `openrouter` | one key, most models; pins `provider: { order: [anthropic], allow_fallbacks: false }` so a router in front of a model does not become a second router |
| `zen` | OpenCode Zen; prices come from the `pricing:` table because the response carries no cost. Verify the base URL against its docs. |
| `lmstudio` | LM Studio's local server on port 1234 |
| `ollama` | Ollama's OpenAI-compatible surface on port 11434 |
| `llamaserver` | the **bundled** `llama-server` on port 7813 — the only one with a `serve:` block, because it is the only one Metistry runs itself |

`--name` and `--base-url` rewrite the block on the way in, so a second
machine's Ollama is `--from ollama --name box --base-url http://10.0.0.4:11434/v1`.
Any OpenAI-compatible endpoint works without a template — write the block by
hand, or start from the nearest one.

## The engine

One interface, `apps/assistant/src/engine.ts`, and a factory keyed on the
provider's `kind`. What a turn runs on is configuration, resolved to a
(provider, model, effort) triple **before** anything is called — the router
names a tier, `resolveTurn` resolves it, and no model is ever asked which
model should run (invariant 4).

| kind | engine | when |
| --- | --- | --- |
| `openai-compatible` | the in-house loop, `engine-openai.ts` | the tier or crew has an `assignments:` entry |
| `anthropic` | the Claude Agent SDK, `engine-sdk.ts` | nothing in `compute.yaml` assigns it |

`anthropic` is not a kind you can write in the file — it is the *absence* of
an assignment, and it leaves the product with the subscription scrub. Because
an unknown tier resolves to `assignments.default`, an install that assigns
anything assigns everything: write a `default` and no turn can reach the SDK
path, which is why the assistant then starts without an engine credential at
all.

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
| `critical_only` | only an assignment marked `critical: true` keeps running. What may carry that mark is still open (OPEN-4) — the flag is enforced, the policy is not decided |

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

### Discovery

```sh
metistry compute models list
```

lists every declared provider's live `/v1/models` **and** any of the three
local servers that is answering but that no provider dials:

```
lmstudio: http://127.0.0.1:1234/v1/models → 2 model(s)
  lmstudio/qwen/qwen3-coder-30b
  lmstudio/text-embedding-nomic-embed-text-v1.5

Ollama on http://127.0.0.1:11434/v1: not configured — `metistry compute providers add --from ollama`
  (ollama)/gemma3:4b
```

`metistry doctor` carries the same finding as three rows — `local:lmstudio`,
`local:ollama`, `local:llamaserver` — each `ok` with what it has loaded, or
`absent`. **Absent is never a failure.** A Mac with no local model server is
a supported install, so these rows can only add information.

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
   into `<instance>/state/models/<owner>/<repo>/`, streamed to disk;
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
      model_path: state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf
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
- a `runtime:` other than `llamaserver` — LM Studio and Ollama are peers, not
  children. Metistry never claims another app's lifecycle.
- a `model_path` that is not a `.gguf`.

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
