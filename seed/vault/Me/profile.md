---
source: user
# Me/profile.md — the machine-readable facts the daily-flow routines gate
# on: timezone, working days, working hours, capacity. Metistry discovers
# these from you; it never assumes them (owner ruling Q4), so every fact
# below starts unset. Uncomment and fill in what you want the routines to
# use, in Obsidian, whenever you're ready — the shape below is exact
# (`docs/product/daily-flow-spec.md` §6.6). When a routine runs is not a
# fact about you: it lives on the routine, under Scheduled
# (`.metistry/scheduled.yaml`) — a routine on your working days follows the
# list below until you set its days there.
#
# timezone: America/New_York
# working_days: [mon, tue, wed, thu, fri]
# working_hours: "09:00-17:30"
# daily_capacity_min: 240
# task_size_minutes: { s: 15, m: 45, l: 90 }
# today_cap: 3
---
# Working profile

The frontmatter above is empty on purpose. Metistry discovers these facts
from you — it never assumes a timezone, a working day, or how much of a
day you actually have — so a routine that runs on your working days, like
Tomorrow's Plan, does nothing until you fill them in, and says so rather
than guess (`skipped:no_working_days`).
