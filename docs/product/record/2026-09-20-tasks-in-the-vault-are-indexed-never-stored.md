- 2026-09-20 — **The tasks in your notes are indexed, never stored.** A todo
  you type as `- [ ] Call the dentist due friday` in any note is now readable
  state — due dates, priorities, who it is waiting on, how long it has been
  carried — without a single copy of it living anywhere but the line you
  typed. The database holds a projection of your markdown and nothing else:
  drop it entirely, let the walk run once, and every row comes back from the
  notes that produced it. That is what makes the checkbox on disk the record
  rather than a mirror of something else's opinion, and it is enforced by the
  shape of the schema rather than promised by a convention — there are two
  constraints deliberately absent from it, because a derived table that can
  refuse to be rebuilt is not derived. Reading it is one query, which is the
  same query the filter chips in the app, the `where:` line in your template
  and the plugin's suggester all turn into — one filter language with three
  faces instead of three that drift apart within a year. Everything it
  returns that names a path or quotes a line you wrote is reachable only
  through a door that checks who is asking; the one thing that travels freely
  is the count, and it is grouped so that a count can never carry a path.
