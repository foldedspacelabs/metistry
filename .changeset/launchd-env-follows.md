---
"@foldedspacelabs/metistry-cli": patch
---

**The launchd jobs follow `.env`, and doctor says when they do not.** The supervisor's plist and `supervisor.json` embed `.env` as `metistry up` rendered it, so a token or key that `secrets sync --to env`, `secrets mint`, `secrets migrate-scope`, `secrets retire-legacy-env --yes` or `update` wrote afterwards reached nothing — bridges 401'd the watchdog and the console, and a provider key never reached the supervisor. Each of those verbs now compares the installed jobs with `.env` (names only, hashed) and, when they differ, runs `metistry up --no-compose` to re-render them and restart the supervisor, or prints `metistry up` when it cannot. Doctor adds a `launchd env` row (degraded, with the drifted names), and its `assistant` row under the launchd shape now reports the supervisor's running child — "not started" when there is none — instead of `ok` whenever compute.yaml named an engine.
