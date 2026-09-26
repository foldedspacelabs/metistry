---
"@foldedspacelabs/metistry-core": minor
---

**The connection and extension model (§2.6, §2.7).** A `connection-type`
manifest joins `manifestSchema` — `provides` one of eight connection types,
config `fields` from a closed field-kind vocabulary, `capabilities` from each
type's closed vocabulary (`send` on mail is refused by name), tools by group,
and an `implementation`. An `oauth` field carries the OAuth client model: a
public `client_id`, PKCE required on a loopback redirect, `bring_your_own:
allowed`, https-only endpoints and declared scopes — and a `client_secret` is
refused. `connectionFileSchema` validates `.metistry/connections/<name>.yaml`
(secrets and variables by name only; a tool's mode defaults to Ask), and
`connectionIssues` joins a connection to its type. `Registry<Kind>`
(`loadRegistry`, `buildRegistry`, `manifestKind`) loads units from
directories, overlays an extension over a product unit by name, skips a unit
that fails with its reason, and requires `schema: 1`. Every manifest may now
carry `schema: 1`; any other value is refused with the version named.
