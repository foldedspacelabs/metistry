---
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-connections": patch
---

`socketDestination` keeps its port (X-93). The `:443` collapse is an HTTPS convention, but the IMAP host guard and `describeConnection` shared it, so an IMAP server on 443 was spelled as the bare host and would have matched a secret's HTTPS *Sent only to* entry. A socket destination now always reads `host:port`; an HTTPS URL on 443 still collapses to the host.
