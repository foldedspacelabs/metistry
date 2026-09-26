"""One set of sample data for every board (amendments §8.4, 2026-09-23).

Developers copy board data as acceptance data, so a board that disagrees with
itself ships a bug. Literals move in here as boards change; a number drawn on
more than one board belongs here first.
"""
F=dict(
    day="Tuesday 22 September",          # the day every screen is drawn on
    needs_you=10,                         # the sidebar row's count (C110), the list header, Today's rail
    standup="9:15 AM",
    one_on_one="9:30–10:00 AM",          # 1:1 with Jim Fallon, every other Tuesday
    design_review="11:00–11:45 AM",      # 4 people, in person; moved from 1:00 PM
    vendor_sync="1:00–1:30 PM",          # what calendar help proposes moving to 11:45 AM
    vendor_review="1:00–1:42 PM",        # the recorded meeting, 42 min; jots at 1:02, 1:20, 1:38 PM
    spend_today=1.84,                     # Usage; projects (1.52) + Metis (0.31) + other (0.01)
    brief_file="Journal/Brief/2026-09-22.md",
    plan_file="Journal/Plan/2026-09-23.md",
    daily_note="Journal/2026-09-22.md",     # the owner's note; Metistry writes only its fenced section (C102)
    meeting_note="Journal/Meetings/2026-09-22-vendor-review.md",
)
