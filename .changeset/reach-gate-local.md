---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**The reach gate: minting an agent bearer is the owner on this Mac.** The
console reads reach `local` off the client API table and enforces it before
any handler runs: a `local` route admits the local owner token from a loopback
peer and nothing else, and a passkey session — even one from `127.0.0.1` — is
refused `403 local_only` with a message naming the route and the Mac app, and
audited. `POST /api/agents` and `POST /api/agents/:id/rotate` are now `local`:
a new credential is a boundary change. The local owner token from any other
peer is the uniform `401` it always was; the capture owner token and agent
bearers keep their uniform `403 forbidden`. `metistry connect` mints through
the local owner token and is unaffected; the legacy PWA's agent panel can no
longer register or rotate an agent.

`@foldedspacelabs/metistry-core` adds the `local_only` error code (`403`),
`isLocalRoute` and `localOnlyMessage`. The client API conformance test now
checks every row's reach for every credential kind.
