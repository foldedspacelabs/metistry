---
source: user
# Me/profile.md — the machine-readable facts the daily-flow routines gate
# on: timezone, working days, capacity, standup timing. Metistry discovers
# these from you; it never assumes them (owner ruling Q4), so every fact
# below starts unset. Uncomment and fill in what you want the routines to
# use, in Obsidian, whenever you're ready — the shape below is exact
# (`docs/product/daily-flow-spec.md` §6.6).
#
# timezone: America/New_York
# working_days: [mon, tue, wed, thu, fri]
# working_hours: "09:00-17:30"
# daily_capacity_min: 240
# standup_days: [mon, tue, wed, thu, fri]
# standup_time: "09:15"
# task_size_minutes: { s: 15, m: 45, l: 90 }
# today_cap: 3
---
# Working profile

The frontmatter above is empty on purpose. Metistry discovers these facts
from you — it never assumes a timezone, a working day, or how much of a
day you actually have — so `plan-tomorrow` and `standup-draft` do nothing
until you fill them in, and say so rather than guess (`metistry doctor`
reports the gap as `absent: Me/profile.md has no working_days`).
