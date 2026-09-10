---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
---

The console's **local owner token** (`docs/ops/auth.md`), so the Mac app and
the CLI authenticate to a console on this machine without a passkey
ceremony — they are the same package, on the same filesystem, running as the
same person.

- `Authorization: Bearer $METISTRY_OWNER_TOKEN` yields the `user` principal,
  the same one a passkey session yields, through the same `isUser()`
  predicate — but **only** when the connection's peer address is loopback.
  The decision comes from the socket; `X-Forwarded-For`, `Forwarded`,
  `X-Real-IP` and `Host` are never read. From anywhere else it is a 401
  byte-identical to an unknown token's, plus a `runs` audit line naming the
  address. Constant-time comparison; misuse tests ship with it.
- Compose NATs a host-loopback connection to the bridge gateway, so
  `METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is told: the compose
  file sets the sentinel `docker-gateway`, resolved at startup from the
  container's own default route. The gateway address only — a sibling
  container is still remote. Unset (launchd) = plain loopback.
- `GET /api/whoami` → `{principal, via, management, origin, as_of}`.
- `POST /auth/logout` and `/api/push/*` stay passkey-session-only: they act
  on a device session row. A host-minted `owner_tokens` row (the capture
  Shortcut) is unchanged — capture-only, any address.
- `METISTRY_ORIGIN` may be a comma-separated list (`expectedOrigin` takes an
  array in @simplewebauthn v13); the first entry stays canonical. An origin
  mismatch, which used to escape as HTTP 500, is a 401 naming expected vs
  presented.

CLI: `METISTRY_OWNER_TOKEN` joins `SECRET_SCOPES` as instance-scoped;
`metistry init` mints it into the `.env` lines it prints; `secrets sync --to
env` mints one for an install that predates it (`GENERATED_SECRETS`, the
same "generated, so minting cannot be the wrong guess" rule as `up`'s DB
password); `metistry console whoami [--json]` prints the principal — what
the app calls to show "signed in as owner"; and `metistry doctor`'s console
row now presents the token, so `api_status` is a real authenticated read
(a refused token degrades rather than fails).
