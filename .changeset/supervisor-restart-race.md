---
"@metistry-apps/watchdog": patch
---

**A restarted supervisor no longer declares a child crash-looping because the previous one still held its port.** For 30 s after the supervisor starts, a child that exits early having logged `EADDRINUSE`, `listen EPERM` or "Address already in use" is retried every 500 ms and not counted toward the crash-loop threshold; every other exit, and any exit after the window, is counted as before. The supervisor also logs "[assistant] not started — …" when `supervisor.json` has no assistant child.
