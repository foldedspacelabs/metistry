---
"@foldedspacelabs/metistry-core": minor
---

**The secret fill at egress, and redaction on the way back (plan §2.14,
T4-2).** `guardedFetch(policy, fetch)` is the door every call carrying a
`{{ secret.name }}` goes through: a `fetch` that fills references from one
instance's store only for a destination on the secret's *Sent only to* list,
for a grantee the owner granted (Ask needs the call's approval), over https —
and refuses otherwise with an `EgressRefused` (`host_not_listed`,
`secret_in_url`, `secret_in_model_body`, `cleartext`, `not_granted`,
`needs_approval`, `missing_secret`, `malformed_reference`,
`uninspectable_body`, `bad_url`) before the Keychain is read or anything is
sent. A request carrying a secret is sent with `redirect: "manual"`. The
response body (streamed), its headers and any error come back through a
`SecretRedactor`, which replaces every known value — raw, JSON-escaped,
URL-encoded or base64 — with `***REDACTED secret.<name>***`.

Also: `planEgress` (the same checks, no store), `egressDestination`,
`recordSecretUse(db, runId, names)` (merges names into `runs.meta.secrets`,
which `secret_last_used` reads), `SecretRedactor` and `redactedSecret` in
`redact.ts`. `containsRedactedPlaceholder` now also recognises the named
marker.
