- 2026-10-18 — **An Ask inside a recording stays on the Mac, enforced at the
  door.** Screen 11's capture bar promised *staying on this Mac* for a question
  asked while a meeting is recorded, and until now the panel could not say it
  honestly: `POST /message` had no way to tell the router a turn belonged to a
  session. It now carries `capture_session`, the recorder's id, and a marked
  turn is held to the private tier the same way a transcript's own turns are —
  core's `turnTier` puts `private` over whatever the rules or the composer's
  picker chose, and `private` resolves on an on-machine provider or refuses the
  turn with the command that fixes it, never falling back to a tier or a shadow
  that could leave the Mac. The marker can only make a turn more private: the
  console checks it is a recorder id and that the recording has not ended, an
  agent bearer is refused with the route whole, and the route record and the
  thread both name the tier the turn actually ran on. No new route, no prompt:
  the bar sets one field, and the tool does the rest.
