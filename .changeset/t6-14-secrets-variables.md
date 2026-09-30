---
"@metistry-apps/macos": minor
---

Settings ▸ Secrets and Settings ▸ Variables replace their interim panes (T6-14, screen 19). Secrets lists this instance's named secrets from `GET /api/secrets` — name, who uses it, where it is sent, last used or *Expired* — and opens each to its Value (dots), Sent Only To and Who May Use It, with *Metistry's own* as a collapsed group. New Secret and Replace send the value to `metistry secrets set|replace` on stdin and clear it before the process starts; it is never an argument, never shown again and never printed. Delete runs `secrets remove`'s preview first and names what stops; a grant the CLI refuses reads on that grantee's row. Variables lists name · value · used in and writes through `metistry variables set|unset`; a key-shaped value is refused before it can reach a command line, with Store as Secret and no override.
