---
"@metistry-apps/collectors": patch
---

X-26: the Linear sync's read of the rows that left the owner's list is ordered by
`external_ref`, so the ids it looks up in Linear and the order it closes rows and
writes receipts no longer depend on Postgres's physical row order (the root cause
of the `linear.integration` "closed or given to someone else" flake).
