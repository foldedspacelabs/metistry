---
"@foldedspacelabs/metistry-cli": patch
---

**A new owner bearer restarts only the reconciler, and a slow reconciler defers the lock instead of failing the update.** On the owner's 0.14.1 run, `update` minted the owner bearer and then kickstarted the launchd shape's SUPERVISOR agent for it, taking the console, the reconciler and both bridges down mid-update. It now restarts only the reconciler — the one service that reads that bearer — through the supervisor's control socket (`supervisor restart reconciler`, the path `metistry restart reconciler` takes), and never the supervisor's agent. The lock write's wait for a restarted reconciler is now up to 180 s (`METISTRY_RECONCILER_READY_TIMEOUT_MS`), polling from every 0.5 s backing off to every 5 s; a reconciler that still has not answered defers the lock — not tried, the rest of the update still runs, exit 1 with `metistry update` to finish it — where it used to try a write that could only fail and fail the whole update.
