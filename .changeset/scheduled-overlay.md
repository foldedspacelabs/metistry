---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
"@metistry-apps/collectors": minor
"@metistry-apps/routines": patch
---

**The overlay: `scheduled.yaml` checked against the manifests, every field
resolved with its origin.** Routine and collector manifests gain
`display_name`, `config` (fields from a closed five kinds — text, path,
number, boolean, choice — each with a default of its kind), and, for a
collector, `needs_you` (its Needs You rules) and `presents_as`. Core's
`entryProblems` / `checkScheduled` check each entry against its manifest —
its section, its config keys and values, its raise rules — and the runner
HOLDS a component whose entry does not fit, rather than ignoring the change;
`resolveScheduled` resolves every routine and sync over manifest ⊕
`Me/profile.md` ⊕ `scheduled.yaml` into `Sourced` fields (*default* · *from
your profile* · *yours*) with the next run. The reconciler admits
`.metistry/scheduled.yaml` as the console's third protected door — and still
no other. Every collector moves to §2.5's closed shape (no shipped cron
string is left); Inbox Sort (`inbox-drain`, every 5 min) and Usage Rollup
(`claude-usage`, hourly) present as routines; GitHub declares
`review_requested` and `assigned`. Manifest errors now name a bad record key
by its rule rather than "Invalid key in record".
