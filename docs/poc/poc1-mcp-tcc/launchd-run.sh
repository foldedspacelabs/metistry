#!/bin/zsh
# PoC-1 scratch — full chain under launchd: claude -p -> node MCP server -> sqlite3 -> chat.db
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
cd /Users/example/Development/Metistry/.claude/worktrees/metistry-phase-0-poc-12cdbc
echo "=== start $(date) uid=$(id -u) ppid=$PPID ==="
exec claude -p "Call the list_recent_messages tool with limit 3 and report exactly what it returns, including any error text verbatim." \
  --mcp-config poc/poc1-mcp-tcc/mcp.json \
  --strict-mcp-config \
  --allowedTools "mcp__messages__list_recent_messages" \
  --model haiku \
  --output-format json
