---
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/console": patch
---

**One filter vocabulary, one query — and now literally one object.** The
parser that reads `where: "due <= today or overdue"` and the query it compiles
into were built in parallel and agreed on almost none of their names:
`due_from` against `due_on_or_before`, `combine` against `match_any`, a
comma-separated `flags` string against seven booleans, `sort1` against
`order_1`. Every one of those is a hard `unknown param` the first time a
template renders, because the query runner refuses an undeclared parameter
rather than ignoring it — so the failure would have landed on an evening plan
rather than in a test.

`seed/queries/vault_tasks_query.yaml` now declares exactly
`TASK_FILTER_PARAM_SPEC`, and a test asserts the two are equal field for
field, so neither side can move without the other. There is no longer a
third copy of the shape anywhere: the manifest is a transcription of the
parser's own published declaration, and the parser is canonical because it is
the half three consumers import and typecheck against.

`TaskFilterParams` gains the four **context** params the query needs and a
`where:` line can never reach — `today` (the day *overdue* and *carried* are
measured against, resolved where the timezone is known rather than in SQL),
`me` (your own person page, for *assigned to me*), `path_prefix` (the
caller's scope) and `offset` — so the contract is one object rather than two
that can disagree. `path_prefix` and `status` **scope**: `or` widens the
predicate, never the scope, so no filter anyone writes can reach a ticked
line or a path outside what the caller was allowed to see.

Three meanings were pinned while the two halves were reconciled, because they
had been described two ways: *recurring* is an **instance** of a rule, never
the rule line (a rule is not a task, and no row here can be one); *carried* is
"it was owed on an earlier day", which is the number the app's chip shows,
while how long a line has been **sitting** is its own separate column; and
every nullable field compares under an explicit "no" rather than a NULL, so
asking for `size l` can never quietly return every task with no size at all.
