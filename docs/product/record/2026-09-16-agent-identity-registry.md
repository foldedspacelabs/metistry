- 2026-09-16 — **A second instance can be named, described and let in —
  without a mesh.** Evaluating Google's SAM agent mesh produced a SKIP on the
  dependency (a Go daemon per node, an OIDC provider, a public control plane
  and a second policy language, to authorize one person's two instances) and
  five registry ideas small enough to build: `GET /api/identity` now
  advertises coarse tool *groups* so a phone or a peer can name what an
  instance offers before sign-in — never a tool name or a count, with the
  full tool list still behind a token; an agent enrolled `--remote` holds a
  token that authenticates **nothing** until the owner approves it, refused
  indistinguishably from an unknown token, which puts the credential surface
  in the user's hand by construction rather than by policy; agent identity
  gains the portable `agent:<name>@<instance_id>` form at the boundaries it
  crosses; `instances.yaml` makes the peer list a protected file rather than
  a service; and `metistry runs export` streams the audit ledger as redacted
  NDJSON so two instances' timelines merge. The honest headline is the
  proportion: the one thing a mesh would have added that Metistry lacked was
  discovery, and discovery turned out to cost a few endpoints and one YAML
  file.
