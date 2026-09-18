---
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-cli": patch
"@foldedspacelabs/metistry-mcp-brain": patch
"@metistry-apps/console": patch
"@metistry-apps/reconciler": patch
---

**An instance that has not run `metistry migrate-layout` is read again.**
`db/migrations/0021` recorded that "a legacy instance keeps working unchanged
until the verb runs". Verified against a clone of a real pre-ruling instance,
it did not: #193 moved every path to `.metistry/` and every reader spelled the
new one, so `metistry compute show` reported no providers while the instance's
`compute.yaml` declared one, `metistry identity` exited 1 on an instance whose
`identity.yaml` was right there, `metistry version` omitted the pin, `doctor`
read `shape compose` off a `deployment.yaml` it never opened and probed the
wrong half of the install, `metistry secrets`/`console`/`connect` could not
find `state/.env` at all — which on a launchd install means every rendered
plist's `__ENV_FILE__` points at a file that does not exist — and `up` would
have `initdb`'d a second, empty Postgres cluster at `.metistry/state/pg`
beside the live one.

Two of the breaks were safety, not convenience. The §4.7 protected set became
the `.metistry/` PLACE, which took the legacy machinery at the instance root
out of it: on a legacy instance the assistant could write `identity.yaml`,
`rules.yaml`, `metistry.lock`, `queries/` and `instance-migrations/` through
`brain-commit` (invariant 2). And the knowledge walk, which now starts at the
instance root, indexed those same files plus every byte of the gitignored
`state/` — a Postgres cluster included — as notes.

`resolveInstanceLayout(instanceDir)` in core is the fix: one `detectLayout`
read, then the right relative-path table (`LEGACY_INSTANCE_LAYOUT` mirrors
`INSTANCE_LAYOUT` key for key), with `instanceFile()` / `instanceStatePath()`
as the reader's one-line call. Every reader goes through it — identity,
rules, compute, deployment, the lock, the peer registry, `.env`, the Postgres
data and socket dirs, the supervisor's config/socket/bin, `ports.yaml`, the
models dir, the assistant's state dir, `doctor`'s compute overlay, the
console's identity/peers/inbox, and the reconciler's inbox prefix (whose SQL
predicate must match migration 0015's partial index on a legacy instance, not
0021's). Writers are untouched: `instancePath`/`metistryPath` still spell the
flat layout, because there is one layout to write and two to read.
`isProtectedPath` and `isVaultPath` cover the legacy root names
unconditionally — they receive a path and no instance directory, and the set
is strictly safer on a flat instance, which has no business holding lowercase
machinery at its root.

`metistry update` now **refuses** to pin a version past 0.8.x onto a legacy
instance, before it fetches, builds or migrates anything, printing the
`migrate-layout` line to run; `--allow-legacy` overrides. Regression tests run
one fixture in both shapes through the same readers, so a reader that resolves
only one of them fails.
