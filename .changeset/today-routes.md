---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-core": minor
---

**Today's routes (T2-7).** `GET /api/today?date=` composes one day from four route-only named queries — `vault_tasks_query` under Today's preset (the open lines owed on or before the day, `due <= <date> or do <= <date>`, then the lines ticked on it; `#someday` lines leave the open list), `day_work` (waiting on you, blocked, due, overdue, closed on the day), `today_order` and `day_events` — plus the paths of the day's brief, standup and plan, `null` until written. `GET /api/vault-tasks?where=&order=&limit=&offset=` compiles any filter with `compileTaskFilter` over the whole vault and answers `400` with the parser's own refusal, naming the token, for anything outside the grammar. `PUT /api/today/order {date, task_keys}` replaces one day's drag order in one statement and refuses — `400`, naming them, nothing written — any key `GET /api/today` does not serve for that date. The day is `METISTRY_TZ`'s, never `TZ`'s (UTC when unset). All three are owner-only (`session · local_owner`); core's client-API table marks them served. `vault_tasks_query`'s `places` is now a number (it was a bigint string).
