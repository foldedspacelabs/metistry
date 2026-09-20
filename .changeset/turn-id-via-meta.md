---
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/assistant": patch
---

**A wire change: `turn_id` is out of all 25 tool schemas and rides in the
call's `_meta`.** The correlation handle that groups one reply's tool calls in
the activity feed was merged into every tool's `inputSchema` — 3,774 chars ≈
**944 definition tokens, 19% of the entire advertised surface**, for a field
that is not a parameter and is "never trusted for anything else". Measured on
this checkout: the eager surface goes **19,914 chars / ~4,979 tokens →
16,140 / ~4,035**, and the credential-gated 26-tool surface 20,972 / ~5,243 →
17,047 / ~4,262, so it no longer crosses the >5k line that gates
`discovery: lazy` at all. No capability was removed and no description
changed (`docs/research/2026-09-19-code-mode-mcp.md` §2.4, ruled 2026-09-19).

**Where it went.** `_meta` on `tools/call`, the MCP spec's own carrier for
request metadata, under `com.foldedspacelabs.metistry/turn_id`
(`packages/mcp-brain/src/turn-id.ts`, exported as `TURN_ID_META_KEY`). The
assistant's tool host mints one per host — i.e. one per reply — and sends it
on every call. That also moves the handle from the model's hands into the
client's: the seed prompt used to ask the assistant to invent an id and pass
it faithfully on every call, which was a convention, not a control.

**Compatibility, one release.** A client still sending `turn_id` inside
`arguments` keeps correlating exactly as before: the bridge lifts it into
`_meta` at the door, beside the deprecated-name rewriter, before any schema
sees it. Tolerated, advertised nowhere. Two behaviour changes worth knowing:
a malformed handle is now **dropped rather than failing the call** (a join key
is not a control), and `turn_id` no longer appears in any `tools/list`, so a
client that discovers arguments from the schema will stop sending it.
