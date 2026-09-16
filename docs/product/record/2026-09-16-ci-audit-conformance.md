- 2026-09-16 — **Three ways the system can no longer quietly drift, plus the
  one that already bit.** A test harness that loaded the product checkout's
  `.env` was handing CLI verbs a running install's reconciler URL and bridge
  token, so a `compute providers add` case whose `--instance` was a temp
  directory committed into the operator's real instance repo;
  `@foldedspacelabs/metistry-core/test-env` now allowlists
  `METISTRY_DB_*` and deletes the rest, pins `METISTRY_PRODUCT_DIR` at a
  sandbox, and fails any test whose verb resolves a path outside
  `os.tmpdir()` — proved by running the whole CLI suite with the operator's
  environment simulated. Alongside it, `ops/scripts/audit-limits.mjs` fails
  CI on a cap that lives only as a literal (forty on main; two became
  `METISTRY_MAX_BODY_BYTES` and `METISTRY_COMPOSE_TIMEOUT_MS`, thirty-eight
  now say why they are fixed), a `packages/core` conformance test requires a
  stdio component to put nothing but protocol frames on stdout, and every
  refusal on the console's owner surfaces names the field that would permit
  it — while the door stays uniform, because a 401 that explains itself is an
  oracle.
