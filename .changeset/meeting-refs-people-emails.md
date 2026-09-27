---
"@metistry-apps/reconciler": minor
"@metistry-apps/console": minor
---

**Meeting refs and people emails (T1-10).** Migration `0029_meeting_refs.sql`
adds two derived tables, `vault_meeting_refs (event_id, path)` and
`people_emails (email, path)`. The reconciler's walk fills them from a meeting
note's frontmatter `event_id:` (notes under `Journal/Meetings/`, the user's
directory at the tool) and from a People page's `email:` (one address or a
list, trimmed, `mailto:` dropped, lowercased; only pages the user owns), and
rebuilds both whole every cycle. `POST /reconcile` reports `meeting_refs` and
`people_emails`. The new named query `people_by_email` (`expose: route`)
returns the one People page that claims an address, and nothing when none or
more than one does: an unmatched attendee never resolves to a page.
