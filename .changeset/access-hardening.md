---
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/console": minor
---

Access hardening (T2-2). **Revise on an access request can only grant less**
(C40): `accept_with_changes {area}` is refused with a `400` unless the area is
the one asked for or a folder under it, and the refusal writes nothing — no
grant, no override, no `payload.error`; it carries `asked`. **The answer
carries the prior tier** (C41): `granted.prior_tier` on the response and on
`payload.granted`. **The escalation ceiling leaves a record** (C42):
`request_access`'s third ask after two declines writes a `runs` row of kind
`access_ceiling` (exported as `ACCESS_CEILING_KIND`, with `AccessCeilingMeta`),
and `GET /api/agents` lists them as `access_ceilings`, grouped per (agent,
area), until the agent holds the area or is revoked.
