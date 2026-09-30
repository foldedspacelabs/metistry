---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-cli": minor
---

T4-15: Mail over IMAP. A fourth reach class, `imap` (host, port 993, TLS —
plain only to loopback — username and the app password's secret name; a mail
submission port is refused), and `planSocketEgress`, the host guard for a
secret sent over a socket rather than HTTP: the exact `host:port` on its *Sent
only to* list, TLS, granted, before anything is dialled. The `imap` connection
type and Gmail (`gmail-mail`, pinned to `imap.gmail.com:993`; 2-Step
Verification and an app password) over a hand-rolled IMAP4rev1 client (no
dependency) whose commands are a closed set with fixed shapes — so no code
path can send, move, flag or delete mail. `read` is headers only (EXAMINE,
BODY.PEEK of fixed fields), stamped `source: comms` and sanitised; `draft`
previews, then APPENDs to the `\Drafts` mailbox only when the digest matches.
`check()` signs in, lists folders, finds Drafts and examines INBOX.
`metistry connections add` takes `--imap host[:port] --username --secret
[--plain]`.
