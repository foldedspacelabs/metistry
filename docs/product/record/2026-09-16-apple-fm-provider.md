- 2026-09-16 — **The model the Mac already runs became a provider, and the
  first unattended job to use one cannot spend a cent.** Apple Foundation
  Models now answers `GET /v1/models` and `POST /v1/chat/completions` on the
  `apple-fm` bridge, under the same bearer as every other route: a JSON
  schema supplied at request time is enforced at generation time, usage comes
  from the model's own tokenizer, and a prompt or schema that would overrun
  the 4096-token window is refused with a `400` that names the field instead
  of failing halfway through. Cost 0, and ~23 MB resident against 840 MB for
  a comparable local GGUF server — the weights are already in RAM for the
  operating system. `inbox-drain` moved onto it and, in doing so, made
  "collectors never call a billable model" mechanical: the collector names
  one pinned model in its manifest, CI refuses a billable provider there, and
  the call itself throws rather than degrading quietly into spending.
