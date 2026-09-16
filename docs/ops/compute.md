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

This page describes a file and the verbs over it. Deliberately absent, and
each one is a named PR in `docs/plan-refresh-2026-09-13.md` §4:

- **Nothing dials a provider.** The engine that turns an assignment into a
  call is PR 3. Until it lands, an `assignments:` block changes the model
  string the console records and the assistant's tier map — not what
  actually answers a turn.
- **Nothing enforces a budget.** Budgets are recorded and validated; the
  check happens in the engine, before the call, against a `spend` query
  (PR 3). A budget you write today is a decision stored, not a control.
- **Nothing counts a token.** `runs.provider` / `runs.model` and the cost
  columns arrive with the engine.
- **No app pane.** The Compute pane, and wizard step 7 becoming "Choose your
  compute", are PR 1a — deliberately split so the verb surface settles first.
- **No bundled local server.** `llama-server` built into the runtime-deps
  pack is PR 2; LM Studio and Ollama work today as ordinary
  OpenAI-compatible providers.

Until you write `assignments:`, **`rules.yaml`'s `tiers:` block is still the
live map** and nothing about routing changes. That is why the seed's
`seed/compute.yaml` ships entirely commented out.

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
`extra_args` is passed verbatim after the flags Metistry sets (`--model`,
`--alias`, `--host`, `--port`), which is where `--ctx-size`, `--parallel` or
`--embeddings` go.

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
