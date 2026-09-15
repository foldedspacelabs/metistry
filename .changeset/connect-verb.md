---
"@foldedspacelabs/metistry-cli": minor
---

**`metistry connect <tool>`** — one verb that gives an external dev tool its
own way into an instance. `connect cursor` registers Cursor as an external
agent, keeps the bearer in the login Keychain, and merges one entry into
`~/.cursor/mcp.json` (0600, every other server preserved) that names the
token as `Bearer ${env:METISTRY_AGENT_TOKEN_CURSOR}` — so it never reaches
disk. `connect claude-code` mints the token
`docs/ops/claude-code-plugin.md` had you mint by hand and prints the
plugin's own `export` lines. `connect devin` prints the name, URL and
`Authorization` value to paste at Customize → MCPs, because Devin has no API
to write its config, plus the plain warning that a loopback URL is reachable
from a Devin CLI session on this Mac and not from Devin's cloud.

Idempotent — the agent id *is* the tool name, so a re-run finds the row the
last one made — and it never shows a secret it did not just mint: the console
returns a bearer only at mint or rotate, so an already-connected tool is told
its token is unchanged and `--rotate` is the only way to a new one. Grants
start default-deny (`{tier: "none", areas: []}`); `--areas` widens the read
tier, `--project` adds membership, and nothing here can grant
`knowledge_write` because an external principal cannot reach it at the bridge
at all. `connect --list [--json]` reports each tool's row, bearer and config.
New: `docs/ops/cursor.md`, `docs/ops/devin.md`.
