- 2026-09-19 — **An agent that is boxed in can now ask, and only you can
  answer.** A scoped agent could already be told that a page exists and
  refused its contents; what it could not do was say which folder it needed.
  It can now: one tool, `request_access`, which takes a folder and a reason
  and writes a single request into Needs You. It grants nothing — it is a
  row in your queue, beside everything else that needs you, and you answer it
  with the same three words you answer everything with. Approve widens the
  agent's grant by exactly the folder it asked for; Revise widens it by a
  narrower one you choose instead; Decline moves nothing at all. The widening
  runs through the identical code path, the identical validation and the
  identical audit row as editing that agent's grants by hand in the Agents
  panel — which is what makes this a second door onto your own decision
  rather than a new power the queue quietly acquired. The safety that matters
  is what the asking tool cannot do: it cannot name a folder the grants form
  would refuse (the machinery, the artifacts, a traversal, a lowercase path,
  the whole vault), it cannot ask twice while you have not answered, it
  cannot ask on behalf of anyone but itself, and it cannot answer itself —
  triage is your session and nothing else reaches it. A revoked agent's
  pending asks are declined along with its token. The assistant is deliberately
  refused this tool: its scope is a line in your configuration file, and a
  grant that reverts on restart would be a promise the system could not keep.
