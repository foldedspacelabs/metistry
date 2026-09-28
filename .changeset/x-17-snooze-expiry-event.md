---
"@metistry-apps/console": patch
---

**A snooze ending is now an event (ruled at the W2 checkpoint, ruling 17, X-17).** `later` writes `snoozed_until` into the future, and that write already notified every subscriber like any other proposals change; but the moment the snooze itself *ends* is nothing but the clock passing `snoozed_until`, and no row is written for it — so the trigger `apps/console/src/events.ts` listens on had nothing to say, and the Mac only ever noticed on its own five-minute poll. The event feed now re-asks the pending, un-snoozed count on its own every `SNOOZE_POLL_MS` (30 s) and publishes `needs_you.changed` only when that count has actually moved since the last time either the poll or a trigger-driven batch said so — one event when a snooze expires, none before it and none duplicated behind a batch that already said the same count.
