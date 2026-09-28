---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/console": minor
---

**Connections P2: Ask First and preview-then-confirm (T4-9).** `connection_call` joins the closed action kinds, held at `propose` at every level (`ACTION_KIND_CEILING`) — never `allow` — and raised only by the proxy, never by `propose_action` (`PROPOSABLE_ACTION_KINDS`). `connections_call` now follows the owner's per-tool policy: a Read at Allow runs at once; a Changes or Starts-an-agent tool at Allow answers a preview and a single-use `confirm_token` first (nothing dialled) and runs when the same arguments come back with it; Ask First raises an `action` of kind `connection_call` in Needs You. The confirm record is a digest pair on the preview's own `runs` row (no migration), redeemed by one atomic update, so a replayed, mismatched, foreign or expired token runs nothing. The console's Approve runs the payload the proxy previewed — never anything in the answer's body — through the pool with `approved: true`, and gives the token back only when the pool refused before dialling (C45). Hourly limits per caller per connection are counted from `runs` (`METISTRY_CONNECTION_CALLS_PER_HOUR`, `METISTRY_CONNECTION_ASKS_PER_HOUR`, `METISTRY_CONNECTION_CONFIRM_TTL_S`). `metistry agents autonomy` pads to the longest kind.
