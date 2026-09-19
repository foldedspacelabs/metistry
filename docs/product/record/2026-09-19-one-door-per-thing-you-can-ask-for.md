- 2026-09-19 — **One door per thing you can ask for, and it is the door that
  checks who is asking.** The list of your notes is answered by one endpoint,
  and that endpoint filters it: it hands back only the parts of your vault the
  credential making the request is allowed to see. There was a second way to
  the same list — a general-purpose "run this query by name" address the
  dashboards use — and it did no filtering, because it cannot: it does not
  know that one of the columns it is passing along is a path into your notes.
  Nothing had gone wrong, but the shape was wrong, and one credential made
  that concrete: the small token you put in a phone shortcut so it can send a
  note in is not allowed to browse your vault, and could have listed every
  page in it by name. That is now closed, and closed in the way the system
  prefers: the query file itself says which door serves it, so the rule lives
  beside the thing it governs, travels with it into your own install, and
  cannot quietly disagree with a list kept somewhere in the software. The
  refusal is also deliberately dull — asking the general address for a
  restricted query gets exactly the answer you get for a query that does not
  exist, so nobody can map what is behind the wall by knocking on it. And the
  filter on the surviving door no longer assumes it is you: it reads what the
  credential is allowed to see and narrows to that, which is what makes it
  safe to ever hand a narrower one out.
