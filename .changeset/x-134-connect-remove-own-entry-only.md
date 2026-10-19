---
"@foldedspacelabs/metistry-cli": patch
---

X-134: `metistry connect --remove <tool>` takes away exactly the entry
`connect` wrote, for every tool in the harness registry. An entry under
`connect`'s own key whose Authorization header is not the one `connect` writes
(a hand-made server that happens to be called `metistry`, with its own bearer)
is left alone and reported as a `PROBLEM` line for Cursor and OpenCode too —
Claude Code's entry already refused that way. The row is still revoked and the
Keychain item still goes; the foreign header is never echoed.
