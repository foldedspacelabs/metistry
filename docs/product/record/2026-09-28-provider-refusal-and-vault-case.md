- 2026-09-28 — **Running out of credits says so, once, where the owner looks.**
  The owner's 0.14.2 instance hit OpenRouter's `402 … requires more credits`:
  the turn was tried again, failed quietly as *that turn failed*, and nothing
  said what would fix it — while the ask behind it was the model's whole
  65,536-token window, not the answer's size. Now a provider that refuses the
  account (402, 401, 403) is never retried; it raises one Needs You report
  per provider and error class naming the top-up page and how many turns are
  waiting, pauses that provider (turns are held, not sent) until the report
  is dismissed or a turn gets through, and tries one held turn every ten
  minutes so a top-up is enough. Every call now asks for at most the tier's
  `max_output_tokens` (default 8192). The same report found a second silent
  failure: the instance's `Me/Profile.md` was invisible to a product that
  reads `Me/profile.md` exactly — the bridge now answers *Me/Profile.md
  exists*, and `metistry update` renames such files to the seed's spelling
  in two commits, touching nothing the seed does not ship. Safe to leave
  running because each is a code path with a test: rules and budgets still
  decide first, the pause only stops asking a provider that already said no,
  and a rename the reconciler cannot commit is put back.
