- 2026-09-16 — **You can see what each turn costs, and cap it before it is
  spent.** The engine now dials whichever provider `compute.yaml` assigns —
  any OpenAI-compatible endpoint, so a local model, OpenRouter or anything
  with a base URL — and writes the provider, the model, the tokens, the cache
  hits and the dollars onto every run. Where the number came from is recorded
  too: the provider's own charge, a published price list, zero because it ran
  on this machine, or *unknown*, which is shown as $0 and named rather than
  quietly guessed. On top of that ledger, a daily or monthly budget is checked
  **before** each call rather than reported after it: at 80% you get one
  warning per window, and at 100% the instance either records and carries on,
  stops, or keeps only the work you marked critical. A stop is not silent —
  chat offers you one more window with the exact line to edit, scheduled work
  simply does not start (so a paused engine cannot sit behind a scheduler
  filling the queue with refusals), and a helper agent's task parks with the
  reason. Three smaller things ride along, each of them a control rather than
  a suggestion: a run that keeps asking the same question and getting the same
  answer is stopped at five repeats and made to answer with what it has; a
  provider that does not promise zero data retention warns once a day and
  still works, because that is the owner's choice to make; and the assistant
  cannot hand work directly to a helper running on a different kind of engine,
  though it can always write the work down for anyone to pick up.
