# 2026-09-16 — local models: no install, no second app, no telemetry

*Fragment for `docs/product/PRODUCT.md`. Written in the same PR as the
change, so the launch material is assembled from a record rather than
reconstructed. Fold into PRODUCT.md when the compute arc is complete.*

## The goal this sharpens

**"Predictable cost"** and **"your context outlives any vendor"** both had a
gap: the cheapest, most private compute — a model running on your own Mac —
was the one that asked most of the user. Install LM Studio, or install
Ollama, learn its model catalogue, pull the right quant, hope Metistry finds
it. That is three decisions before the first free token.

## What shipped

**A local model server in the box.** llama.cpp's `llama-server` is now built
from pinned source into Metistry's runtime pack — one 11 MB Metal-enabled
binary, signed under the same Developer ID as the bundled Postgres and git,
verified from a moved copy before the build is allowed to finish. Download
Metistry, and a local model provider is already there. Nothing else to
install; no second app in the Dock.

**LM Studio and Ollama stay first-class, as peers.** Anyone who already runs
one keeps it: Metistry discovers it over the same `GET /v1/models` it uses
for every other provider, reports it in `doctor`, and installs models
through that server's own mechanism (`lms get`, `POST /api/pull`). Metistry
never claims another app's lifecycle, and a user is never asked to migrate
off something that already works.

**Discovery that volunteers.** `metistry compute models list` reports a local
server that is *running but unconfigured*, with the single command that
wires it up. The common failure of local-first AI products — "I had Ollama
open the whole time and it never noticed" — is a design choice, not an
accident, and this is the other choice.

## The benefit, in one line

*A local model with nothing to install, and the one you already run works
too.*

## Safety mechanisms worth naming publicly

- **The bundled server binds loopback, and that is not configurable.** No
  configuration path can put an unauthenticated completion endpoint on a
  network.
- **Every model download is checked against the digest Hugging Face
  publishes** before it is written; a mismatch is discarded and nothing is
  recorded.
- **Absent is never a failure.** A Mac with no local server is a fully
  supported install; `doctor` stays green and merely says what it found.
- **The build is hermetic.** The bundled server is compiled with OpenSSL,
  OpenMP and the upstream prebuilt web UI turned OFF — the first two because
  a runtime that needs Homebrew is not a bundled runtime, the third because
  it is an unpinned download inside a build whose whole premise is that every
  byte is pinned.

## What this unlocks next

The local half of the model bake-off (PoC-18) now has a server to run on,
and the same `/v1/embeddings` route the knowledge index uses: embeddings are
no longer tied to one vendor's private API, so which server embeds is a URL.
The Compute pane in the Mac app — pull a model, see RAM headroom, load and
unload — is the surface this CLI work was shaped for.

## Careful claim

Nothing here yet *chooses* a local model for a turn; the engine that dials a
provider is the next change. The honest claim today is "local models are
discoverable, installable and served" — not "Metistry runs on your Mac for
free."
