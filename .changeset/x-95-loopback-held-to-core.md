---
"@metistry-apps/macos": patch
---

Fix: the Mac decides "loopback" with core's rule, in one place. A connection's
URL and an IMAP mailbox host were each judged by their own list — the URL list
also took any `*.localhost` name, and the mailbox list took any `127.`-prefixed
or bare `localhost` name but not `::1` — so the Connections pane could call a
destination safe over plain http or `plain` IMAP that the egress door treats as
cleartext. Both now use `EgressDestination.isLoopbackHost`, which is
`isLoopbackHost` in `packages/core/src/egress.ts`, and a test reads that
function so the two cannot drift.
