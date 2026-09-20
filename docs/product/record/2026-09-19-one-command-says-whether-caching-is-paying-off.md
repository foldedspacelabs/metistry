- 2026-09-19 — **Prompt caching now reports on itself, in one command.**
  `metistry compute cache-report` reads the run ledger and says, per provider,
  model and tier, what fraction of each prompt was served from the cache
  rather than sent again — and what that was worth, netting the discount the
  reads earned against the premium the writes paid, so a prefix being rebuilt
  every turn shows up as a negative number instead of hiding inside a total.
  Caching is the single largest lever on what an assistant costs, and until
  now the only way to know whether it was working was to read a database by
  hand. It answers in a table with one verdict line under it, and it calls no
  model to do it: everything it reports was already recorded by the turns you
  already took. The reading it refuses to fake is the useful one — a provider
  that reported nothing about its cache is shown as silent rather than as a
  cache that missed, because the first is a wiring problem and the second is a
  prompt problem, and being sent to audit the wrong one costs an afternoon.
