---
"@foldedspacelabs/metistry-cli": patch
---

`metistry up` is faster, says where its time went, and has a counterpart.

Four steps were costing wall-clock seconds nobody benefited from. The retire
step ran a `launchctl bootout` and an `rm` for each of eight pre-supervisor
labels, in series, on every run — one `launchctl list` now answers for all
eight, with the old unconditional sweep kept as the fallback for a dry run or
a probe that fails. Postgres readiness is polled every 250ms rather than
every second, keeping the same 15s ceiling. Doctor's probes are independent
and now run concurrently, so the closing table costs the slowest probe rather
than the sum of all of them (no timeout was shortened: a slow-but-healthy
bridge reported as down would be a worse table). `up` ends with a figure per
`==` section plus the total, and one line naming who owns the processes it
started — launchd or compose, never the CLI.

New verb: `metistry down [--json] [--dry-run]` stops every host job and every
container this instance runs and then confirms it by looking — `launchctl
print` finding nothing, `docker compose ps` listing nothing. It is `docker
compose stop`, never `down` and never `-v`: no container is removed and no
volume is touched. `stop [<service>…]` remains the per-service verb. When the
Mac app registered the background item, `down` stops it for this login
session and says the app will start it again at the next one — it does not
reach into another application's `SMAppService` registration.
