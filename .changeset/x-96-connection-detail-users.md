---
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/macos": minor
---

A connection's detail says who uses it and when it was last checked.
`GET /api/connections(/:name)` rows now list every user in `used_by` — the
agents and crews granted the connection beside its syncs, once it is offered
to agents — serve `last_checked` (the time and verdict of the newest check,
stamped by `metistry connections test` and `doctor` under the instance's
gitignored state directory) and, on an HTTP reach, `header_secrets` (each
header with the secret names it carries). Settings ▸ Connections draws all
three; `metistry connections show` prints the check and each header's secrets.
