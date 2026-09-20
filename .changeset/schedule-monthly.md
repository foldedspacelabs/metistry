---
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/console": patch
---

**`@monthly` is runnable.** The manifest schema's cron regex already admitted
it, but `scheduleToSeconds` did not — a manifest declaring `@monthly` would
validate, pass CI, and then throw the first time the runner tried to schedule
it. It is now 30 days, the same fixed-interval approximation `@weekly`
already makes (this is an interval scheduler, not a calendar one).

**An unparseable schedule no longer takes the runner down.** The console's
`loadSchedules` had no error handling at all: one manifest it could not read,
validate, or schedule threw out of the function and stopped every OTHER
collector and routine from starting too. It now skips that one component and
logs why (naming the manifest file to fix), so a single bad manifest —
shipped or instance-authored — costs one component, not the console.
