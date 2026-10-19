---
"@foldedspacelabs/metistry-cli": minor
---

X-133: `metistry connect claude-code` reads as well as writes. Besides the
plugin's capture variables it now registers the console's `/mcp` with Claude
Code at user scope (`claude mcp add --scope user`), the Authorization header
being `Bearer ${METISTRY_AGENT_TOKEN_CLAUDE_CODE}` — Claude Code expands the
variable, so the bearer never reaches a file or `ps`. Claude Code owns its
config file, so `connect` asks the tool rather than rewriting it; without
`claude` on the PATH it prints the add line instead. `connect --list` shows
both halves and `connect --remove claude-code` removes the entry (only if it
is the one `connect` wrote). Each tool is now one entry in a harness registry
(`HARNESSES`) that `connect`, `--list` and `--remove` are written against, and
every entry passes the same conformance test.
