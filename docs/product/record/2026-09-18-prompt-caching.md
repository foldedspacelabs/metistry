- 2026-09-18 — **The same prompt costs a tenth the second time, and the bill
  says so.** Every turn re-sends the same system prompt and the same tool
  list; on a provider that can cache them, paying full price for that twice is
  just waste. The cloud template now ships with caching on, so the engine asks
  for it on every call without anybody configuring anything — and only on a
  provider that has actually said it supports it, because a setting sent to an
  endpoint that has never heard of it is noise, not thrift. What came back
  cached is recorded on the turn beside what was fresh, and priced at the
  cache's own cheaper rate, so the saving shows up in your own spend history
  rather than in a vendor's marketing: you can see how much of each turn was
  cached and what it cost. The total prompt size is still reported whole, so
  the cached share is extra detail rather than a number that makes two
  columns disagree. Anything more aggressive — hand-placing the cache
  boundaries for a few percent more — waits on a measurement over real turns,
  because a saving nobody measured is a claim.
