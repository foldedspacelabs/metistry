# Knowledge search — keyword, semantic, hybrid

Phase 6. Keyword recall has served the vault since Phase 2 and does not go
away; semantic ranking is added beside it, over embeddings the reconciler
builds as it reconciles.

Everything here degrades. With no embedder running, every search still
answers — in keyword, saying so — and every note is still indexed,
committed and readable. Semantic search is a better ranking, never a
prerequisite.

## Setting up the embedder

The embedder is **any local model server's `POST /v1/embeddings`** with
`nomic-embed-text` (768 dimensions) — §6 decision 8, validated by PoC-5.
Nothing leaves the machine.

One protocol, three servers (`docs/ops/compute.md` → "Local models"): LM
Studio, Ollama, or the `llama-server` Metistry bundles. Whichever you
already run:

```sh
metistry compute models list                 # what is answering on this Mac
metistry compute providers add --from ollama # …or lmstudio, or llamaserver
metistry compute models install ollama/nomic-embed-text
```

Confirm it answers:

```sh
curl -s http://127.0.0.1:11434/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"nomic-embed-text","input":["probe"]}' | head -c 80
```

The reconciler and the console both read the same variables, and **they must
agree** — a query embedded by a different model than the notes is nonsense
that still returns rows:

| Variable | Default |
| --- | --- |
| `METISTRY_LOCAL_MODEL_URL` | the **first `on_machine` provider's `base_url`** in `.metistry/compute.yaml`, else `http://127.0.0.1:11434/v1` |
| `METISTRY_EMBED_MODEL` | `nomic-embed-text` |
| `METISTRY_EMBED_DIM` | `768` |

It is an **API root** — the thing `/embeddings` and `/models` hang off — so
`http://127.0.0.1:1234/v1`, not `http://127.0.0.1:1234`.

`METISTRY_EMBED_ENABLED=false` turns the whole thing off; search stays
keyword and no vectors are written.

### `METISTRY_OLLAMA_URL` is deprecated

It still works. It is read when `METISTRY_LOCAL_MODEL_URL` is unset, a bare
host is mapped onto its `/v1` root (`http://127.0.0.1:11434` →
`http://127.0.0.1:11434/v1`), and the console and the reconciler each log one
line at startup saying so. Rename it when convenient; nothing breaks on the
day you do.

Why it moved: the old name and the old wire (`/api/embed`) made **Ollama the
only server that could ever embed**. `/v1/embeddings` is served by all three,
so which one embeds is now a URL rather than a rewrite (C18).

## The three modes

| Mode | Ranking | Good at |
| --- | --- | --- |
| `keyword` | case-insensitive substring, alphabetical | exact names, ids, quoted phrases, "what did I call that file" |
| `semantic` | cosine over chunk embeddings (pgvector `<=>`) | the question you can only phrase in your own words |
| `hybrid` | reciprocal-rank fusion of both | the default, and the right answer nearly always |

Omit the mode and you get **hybrid once embeddings exist for the
configured model, and keyword before that** — so a fresh install behaves
exactly as it did in Phase 2, and improves the moment the first cycle
finishes.

Fusion is *rank*-based on purpose. A substring hit has no magnitude and a
cosine similarity is not a probability, so the two scores cannot be added.
Rank is the only thing both lists honestly have:
`score = Σ 1/(60 + rank)`, rank 1-based, over each list a note appears in.

Every hit carries a `score`, and the response carries the `mode` that
actually ran plus a `degraded` note when that is not the mode asked for
(embedder down, nothing embedded yet, no embedder configured). An explicit
`mode=semantic` never fails and never returns an empty list because the
embedder is missing — it answers in keyword and tells you.

### Over the vault bridge

```sh
curl -s -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER" \
  "http://127.0.0.1:7812/vault/search?q=easing+off+before+a+race&mode=semantic&limit=5"
```

Hits are `{path, title, description, snippet, score, source}` — `source`
is `keyword`, `semantic` or `both`, the honest provenance of a fused
result. Drafts and sync-conflict copies are excluded in SQL, in every
mode.

### For agents (`knowledge_search`)

The MCP tool takes the same `mode`. **It changes the order of results,
never which notes a grant lets an agent see:** the area-prefix filter and
the not-a-draft filter are inside the vector query, not applied to its
output, so the closest chunk in the vault stays invisible to an agent
whose grant does not cover it. An `index` grant still gets titles and
one-line descriptions only — semantic ranking is not a content read path.

## Chunking

Heading-aware: notes split on markdown headings first (headings inside
fenced code are not headings), then paragraphs are packed to ~500 tokens
with a ~50-token overlap, and each chunk is prefixed with its heading
breadcrumb (`Sleep > Protocol`) so a chunk retrieved alone still says
where it came from. A paragraph longer than a whole chunk is hard-split,
keeping the overlap.

Chunking is a pure function of the note's bytes: same content, same
chunks, same indices, same hashes.

## What "deterministic rebuild" means

The model choice stays reversible (§6 decision 8), and that promise rests
on two things:

1. **Every row carries its own `model` and `dim`.** Vectors from a
   superseded model are identifiable, not anonymous numbers.
2. **Re-embedding is reproducible.** Because chunking is deterministic and
   the content hash is the chunk's, a rebuild over unchanged content
   produces byte-identical `content_hash` values in the same chunk order.
   Only the vectors are recomputed. The test suite asserts exactly this,
   against the real model.

So a rebuild is a *replacement*, not a migration you have to trust:

```sh
curl -s -X POST -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER" \
  http://127.0.0.1:7812/embeddings/rebuild
```

It deletes every vector, clears the per-note markers, and re-embeds the
whole vault from the working tree under the currently configured model.
PoC-5 measured ~125 chunks/sec, so a 5,000-chunk vault is about 45
seconds — the cost of changing your mind.

### When you must rebuild

- **You changed `METISTRY_EMBED_MODEL`.** Stored rows and the configured
  model disagree; `GET /check` says `degraded` and names both, and
  `GET /embeddings/status` shows `rebuild_required: true`. Until you
  rebuild, semantic search sees only rows matching the configured model.
- **You changed `METISTRY_EMBED_DIM`, or the model's dimension is not
  768.** The `embeddings.embedding` column is `vector(768)` — pgvector
  indexes need a fixed dimension — so a different dimension is a migration
  *and* a rebuild, in that order.

You do **not** need a rebuild for ordinary drift. Edited, renamed,
deleted and newly added notes are handled by the reconcile cycle, and a
cycle interrupted by an embedder outage retries only the notes it did not
finish.

## Checking on it

```sh
curl -s -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_RECONCILER" \
  http://127.0.0.1:7812/embeddings/status
```

```json
{ "model": "nomic-embed-text", "dim": 768, "rows": 412, "behind": 0,
  "stored": [{ "model": "nomic-embed-text", "dim": 768, "rows": 412 }],
  "rebuild_required": false, "last": { "files": 0, "chunks": 0, "…": 0 },
  "degraded": null }
```

- `behind` above zero for more than a couple of cycles means the embedder
  is not keeping up (or is down — check `degraded`).
- `GET /check` folds the same information into the bridge's health, so
  `metistry doctor` reports a stalled embedder with its remediation.
- Each cycle writes one `runs` row (`component: reconciler`) whose `meta`
  carries the embedding counts, so the history is queryable.

## Notes and limits

- Semantic search returns **one row per note** — the best-matching chunk
  speaks for it — so a long note cannot flood the results with its own
  chunks.
- The console's named queries do not SEARCH: `seed/queries/knowledge_pages.yaml`
  lists the index (`GET /api/knowledge/pages` — a page list is derived state,
  so invariant 3 sends it there), and a vector parameter still has no clean
  binding in the named-query driver, so nothing in `seed/queries/` ranks.
  Semantic search reaches agents through `knowledge_search`, the owner's own
  clients through **`GET /api/knowledge/search`** — a thin proxy onto
  `/vault/search` in a caller-chosen mode, carrying `degraded` through rather
  than swallowing it (`docs/ops/console-api.md`) — and operators through the
  vault bridge directly.
- **The console's proxy narrows what the bridge serves.** `/vault/read` is
  confined to the instance repo and nothing more, because the protected-path
  writes (`metistry update`, `metistry compute`) go through it; `GET
  /api/knowledge/page` adds core's `isVaultPath`, so `.metistry/`,
  `Artifacts/` and the root `CLAUDE.md` are not reachable as "knowledge" from
  any client. The same predicate the indexer's walk and `mcp-brain`'s
  `validKnowledgePath` use, so the three cannot drift.
- PoC-5's open question — retrieval *quality* on a real corpus of your own
  writing — is still open by design. The mechanics are proven; the
  judgement waits for a year of notes.
