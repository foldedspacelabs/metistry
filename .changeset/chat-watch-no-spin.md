---
"@metistry-apps/macos": patch
---

**The app no longer hangs while a Chat turn is working, and opening Activity, Needs You or Today no longer resizes the window.** Chat serialised its reads by looping until the tick in flight was cleared; awaiting a tick that had already finished returns without suspending, so the loop could spin on the main actor forever — the window stopped answering at 100 % CPU the first time the Chat screen saw a working turn, after a send, or whenever two reads overlapped. Each read now waits once for the one before it. Separately, Activity told the window it needed at least 1,117 pt of height (its chips wrapped a character per line at no width) — over 3,000 pt with the console unreachable — so opening it grew the window or slid its content off the top; Needs You (878–1,078 pt) and Today (1,127–1,841 pt) did the same. All three screens now leave the window's minimum to the shell.
