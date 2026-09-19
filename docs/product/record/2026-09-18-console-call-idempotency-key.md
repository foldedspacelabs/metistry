- 2026-09-18 — **A retry from the Mac app no longer risks a second note.**
  `metistry console call` — the app's entire authenticated door onto the
  console — could not set a request header, so `POST /capture`'s
  `Idempotency-Key` was reachable from a curl command and nowhere else. The
  verb now takes `--idempotency-key <key>`, checked to the server's own shape
  before the request ever goes out, and folds a replay (the console's own
  `idempotency-replayed` header, which the verb otherwise prints no trace of)
  into `--json` output or a one-line stderr note. `MetistryKit`'s transport
  carries the same optional key through to the CLI invocation, so a future
  capture route on `ConsoleAPI` inherits the safety rather than needing its
  own.
