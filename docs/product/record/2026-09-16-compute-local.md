- 2026-09-16 — **A local model server in the box, and the one you already run
  works too.** llama.cpp's `llama-server` is built from pinned source into
  the runtime pack: one 11 MB Metal-enabled binary, signed like the bundled
  Postgres and git, verified from a moved copy, loopback-only by
  construction. LM Studio and Ollama stay first-class peers, discovered over
  the same `GET /v1/models` and reported by `doctor`; `metistry compute
  models list` volunteers a running-but-unconfigured server with the one
  command that wires it up. Every model download is checked against the
  digest Hugging Face publishes; absent is never a failure. The local half of
  the bake-off (PoC-18) now has a server to run on.
