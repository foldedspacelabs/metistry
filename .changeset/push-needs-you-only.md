---
"@metistry-apps/console": patch
---

Web push now carries Needs You only, and no text (screen 18 §6, X-32). The notifier used to push every `outbound_messages` row — replies, acks, briefs, alerts — with 160 characters of its text as `body`; it now pushes only a request that has come to need the owner (just raised, or its Later run out), as `{type, title, url}`: the request's word from core's closed type table, the fixed title "Needs You", and a link that opens that card (`/#/needs-you/<id>`, which the PWA now follows). A request's own title never leaves the console, `wirePayload` puts no other field on the wire, a meeting's rows push once, and a burst of more than three new cards is one push for the queue.
