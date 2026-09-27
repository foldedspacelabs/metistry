---
"@foldedspacelabs/metistry-cli": patch
---

**Doctor describes a stopped schedule with the runner's numbers, once.** The schedule row put doctor's own `METISTRY_RUNNER_MAX_STREAK` beside the runner's skip-row sentence, so one line could say "reached METISTRY_RUNNER_MAX_STREAK (3) … (limit METISTRY_RUNNER_MAX_STREAK = 5)". The count and limit now come from the runner's skip row (its `streak` and `max_streak`), the last error is quoted on its own, and doctor's environment is only the fallback for rows written before that meta existed.
