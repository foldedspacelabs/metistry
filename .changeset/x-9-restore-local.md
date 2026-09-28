---
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/console": patch
---

**Restore is the Mac's (X-9, ruling 7).** `POST /api/knowledge/restore`'s reach
narrows from `owner` to `local`: only the local owner token — the Metistry Mac
app, or the `metistry` command line, on the Mac the console runs on — can raise
a restore request now. A passkey session, even from the Mac's own PWA, is
refused `403 local_only` before the route runs; the capture token and every
agent bearer meet their usual uniform `forbidden` earlier still. §2.3 already
drew "—" for restore on the phone; this closes the gap §2.1's table left open.
Nothing about what the door does — one Needs You request, never a write —
changes.
