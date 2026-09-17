# PoC-18 setup — the providers, in order (2026-09-17)

Everything below runs on the Studio by the owner's hand: provider keys go
in on stdin, `compute.yaml` is a protected path, and `metistry update`
mutates production. Nothing here is scriptable by an agent on purpose.

## 0. Update to v0.8.0

The compute verbs, the bundled `llama-server` and `packages/eval` all ship in
0.8.0; the Studio runs 0.7.0 until updated.

```sh
metistry update
metistry doctor
```

`doctor` should show `local:llamaserver: absent` (nothing served yet) and the
assistant `absent (no engine credential)` until step 1.

## 1. The bar — Sonnet via OpenRouter

```sh
metistry compute providers add --from openrouter          # key on stdin, Keychain, user scope
metistry compute providers test openrouter --complete
metistry compute assign default openrouter/anthropic/claude-sonnet-5
metistry compute assign deep openrouter/anthropic/claude-sonnet-5 --effort high
metistry compute budget instance --monthly 60 --action stop
```

The seeded `default` assignment is `critical: true` (ruled 2026-09-17), so a
tripped `critical_only` budget keeps interactive turns answering.

## 2. The local candidates — shortlist accepted 2026-09-17

See `docs/research/2026-09-17-bakeoff-candidate-survey.md` for the lanes.
File names are on each repo's **Files** tab; verify the exact name before
installing (the survey's sizes are from those pages on 2026-09-17).

| lane | reference (`<owner>/<repo>/<file>`) | ≈ size |
|---|---|---|
| lead (dense) | `lmstudio-community/Qwen3.8-27B-GGUF/…Q4_K_M.gguf` | 17 GB |
| usability control (MoE) | `lmstudio-community/Qwen3.6-35B-A3B-GGUF/…Q4_K_M.gguf` | 21 GB |
| third family | `unsloth/GLM-4.7-Flash-GGUF/…Q4_K_XL.gguf` | 18 GB |
| optional | `ggml-org/…Nemotron-3.5-Lightning-30B-A3B…Q4_0.gguf` | 19 GB |

```sh
metistry compute providers add --from llamaserver
metistry compute models install llamaserver/<owner>/<repo>/<file>.gguf   # one at a time; ~75 GB for all four
metistry compute models list --provider llamaserver
```

Survey gotchas the server flags must carry: Qwen3.8 needs `--jinja` and a
current llama.cpp (the bundled build is pinned; check
`ops/release/build-runtime-deps.sh` if a template error appears);
GLM-4.7-Flash needs `--repeat-penalty 1.0`. Put those in the provider's
`serve.args` in `compute.yaml`.

Optional peers for the server axis (§3.4): `providers add --from lmstudio`
and `--from ollama` with the same files loaded — Ollama does not run the
Qwen3.5-class GGUFs, so its row is expected to be partial.

## 3. Fixtures

`<instance>/eval/fixtures-harvest.jsonl` holds verbatim raw material
harvested from the Studio's history, one candidate per line with
`draft: true`. Turn ~10 per axis into fixtures in the owner's own words
(README "Authoring fixtures"), then:

```sh
pnpm --filter @foldedspacelabs/metistry-eval validate <fixtures.jsonl>
```

## 4. Stage 0, then the rest

Stage 0 is the bar run (README "Running"). Transcripts are committed to the
instance repo, never here (ruled 2026-09-17).
