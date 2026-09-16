---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-cli": patch
---

**Three contract checks that hold at the tool rather than the reader.**

`@foldedspacelabs/metistry-core/test-env` is a new subpath export: a test
harness loads `METISTRY_DB_*` and `METISTRY_TEST_DB_NAME` from a dotenv file
and deletes every other `METISTRY_*` from the environment, and
`assertTestEnvIsolated()` fails a run the moment a path resolves outside
`os.tmpdir()`. A product checkout's `.env` is a RUNNING install's environment
— instance directory, reconciler URL, reconciler bridge token — so a test that
loaded the whole file and called a CLI verb was driving the live system, which
is how a `compute providers add` case committed into a real instance repo.
`docs/ops/testing.md` states the rule: tests never see the operator's instance.

`ops/scripts/audit-limits.mjs` (CI) fails on a limit-shaped constant under
`apps/**/src` or `packages/**/src` that is neither read from config nor
annotated `// limit: fixed — <reason>`. Two of the forty it found on main are
now operator-facing: `METISTRY_MAX_BODY_BYTES` (the console's request-body
cap) and `METISTRY_COMPOSE_TIMEOUT_MS` (how long `metistry up` waits on a cold
`--build`). The rest say why they are fixed.

`core`'s stdio conformance contract spawns a stdio component with a bare
environment and requires every line it writes to stdout to be a protocol
frame; logs go to stderr. It covers mcp-apple-fm's Swift helper, whose
protocol IS stdout, and fails the build if a `transport: stdio` bridge is ever
declared without a case.

And refusals on the console's owner surfaces now name the field that would
permit them — the dispatch body's parameters, the grant validator's message
(which `PUT /api/agents/<id>/grants` used to discard, so `metistry connect
<tool> --areas knowledge/…` answered a bare 400), the budget validator's, and
the two "not available" cases that now name the environment variables they
need. The door is untouched: a 401 takes no detail and an agent's 403 stays
the canonical "not granted" (invariant 8).
