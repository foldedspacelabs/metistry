---
"@metistry-apps/routines": patch
---

Ruling 15 (X-15): Run Now on Tomorrow's Plan no longer stays silent after the
23:00 run has already settled the date. Only the scheduled pass asks whether
an earlier non-close row already settled a target date — a close never asked,
and now Run Now doesn't either, so it always re-renders `Journal/Plan/<tomorrow>.md`
when the owner asks for it by hand, same as closing the day twice.
