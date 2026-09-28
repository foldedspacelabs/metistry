---
"@metistry-apps/macos": minor
---

**Run detail is in the Mac app.** A run opened from Activity or a project's Recent Runs is one page drawn over the screen it came from: the working conversation from the session archive — the system prompt collapsed, the task, the replies, and each tool call where it happened with what it asked and what it got, a failed call open with its refusal — beside what the session fold proposed from it (waiting in Needs You), the run's model, time, tokens, cache and cost, a route record's decision, and the tool sequence with proportional durations. Past the archive's 30 days the page says the transcript expired and still shows the cost and every tool call. `ChatStore.session` now takes the route's `turn_id`.
