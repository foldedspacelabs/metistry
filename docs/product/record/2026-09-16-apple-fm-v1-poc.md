- 2026-09-16 — **Apple's on-device model can be driven by whatever shape the
  caller asks for, which makes a free provider a real one.** The open question
  was whether Foundation Models only answers in shapes compiled into the
  binary; it does not — `DynamicGenerationSchema` builds a schema per request,
  so Apple Intelligence can serve an ordinary `/v1/chat/completions` with
  `response_format: json_schema` and appear in `compute.yaml` as just another
  provider at cost 0. Measured on a Mac Studio (PoC-19): **60 of 60 requests
  succeeded and 40 of 40 structured responses validated against the schema the
  caller sent**, at 268 ms for plain text, 497 ms for a three-field
  classification and 1.46 s for a nested shape with arrays — competitive with a
  4-billion-parameter local model that costs 842 MB of resident memory, against
  22.7 MB here because the weights are already in the operating system. Two
  limits are now numbers rather than guesses: the schema is charged to a
  4096-token window (~32 tokens per described field, ~40 fields before latency
  decides it for you) and identical runs return identical *values* in
  non-identical key order, so anything downstream parses rather than
  string-matches. Both are checkable before the call, which is where a refusal
  belongs.
