---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/assistant": patch
"@metistry-apps/console": patch
---

**Connections through the proxy: the lazy pair (T4-8b).** `/mcp` gains `connections_list` and `connections_call` — the one way an agent reaches the owner's connections (plan §2.6, C115). `connections_list` names the connections lent to the caller and the tools it may call without dialling anything; `connections_list { connection }` fetches those tools' own definitions on demand, so no upstream tool is ever on the eager surface. `connections_call` runs one through an injected `ConnectionsProxy` (the host's pooled client): secrets filled only at egress, the caller's bearer handed over solely so a call carrying it is refused, the answer redacted and sanitized. This release runs a connection's Reads set to Allow; Never and unlisted tools are "no such tool", Ask First and Changes things are refused with the reason. Every call — refusals included — is one `runs` row of kind `connection_call`, read back by the new route-only `connection_calls` named query.

Core: `Resource` gains `{kind: "connection", door, name, offered}` and `may()` decides it (`mayConnection`): the assistant reaches every connection; an agent needs the connection offered to agents **and** named in `scope.connections`; a crew needs that **and** the new `connections` tool group in `uses`. A miss hides as "no such connection" (new reason `connection_required`). `RULED_TOOLS` and `TOOL_PERMISSION_CELLS` carry the two tools. The eager count moves 26 → 28 with its reason beside `COUNT_ACKNOWLEDGED` in `ops/scripts/check-tool-surface.mjs`; the assistant's `BRAIN_TOOLS` follows the manifest.
