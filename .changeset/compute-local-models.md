---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": patch
"@metistry-apps/reconciler": patch
---

**Local models: discovery, install, and a `llama-server` in the box.** Three
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
