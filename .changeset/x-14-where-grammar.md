---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": patch
---

**The `where:` grammar reaches Slipping and Owed (ruling 14, X-14).**
`compileTaskFilter` gains three things, each compiling to fixed bind params
of `vault_tasks_query` and never to SQL text:

- **A carry count.** `carried` followed by an operator is a whole number of
  days carried past the day owed (`carried >= 3`, `carried <= 2`,
  `carried = 4`) → `carried_eq` / `carried_min` / `carried_max`; `carried`
  alone stays the flag. A bound that would land on "not filtering" is
  refused (`carried = 0` points at `not carried`; `carried >= 0` is every
  line). `order: carried` sorts by it.
- **`names_person`**, a flag: the line names a person who is not the owner
  (`assigned` set and not `me`) — the rows `assigned_to_me` does not hold.
  Rows carry it in `row_flags`.
- **`not <flag>`**, for every flag, as one `not_<flag>` boolean each: a
  negation chooses a closed param and never carries a value. `not` before a
  field, `not not`, a bare `not`, an unknown word after it, and a flag with
  its own negation are refused.

`TASK_FILTER_FIELDS` gains `carried`, `TASK_FILTER_FLAGS` gains
`names_person`, `TASK_FILTER_PARAM_SPEC` gains the thirteen params, and a
parsed flag clause now carries `negated`. The console names All's saved
views as `SAVED_TASK_VIEWS`: Slipping is
`carried >= 3 or overdue or names_person`, Owed is
`names_person and not waiting`, Waiting on Others is `waiting`.
