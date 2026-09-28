# Share-sheet capture Shortcut (iOS) + macOS Quick Action

Capture from any app → `POST /capture`, with the **local-file fallback**
(SHOULD-10: one silent drop ends the trust). Until the native iOS app's
share extension exists, this Shortcut *is* the share sheet.

What lands: a file in `Inbox/` — inside the vault, so it shows up
in Obsidian on every device and git carries it — plus its triage row.
Anything over `METISTRY_INBOX_MAX_TRACKED_BYTES` (5 MiB: a screen
recording, a big PDF) goes to `Inbox/.large/`, which git does not
carry. `docs/ops/inbox.md`.

## 1. Mint an owner access token (on the Studio)

```bash
docker compose exec -e METISTRY_ORIGIN=https://<your-origin> console node scripts/enroll.mjs --owner-token "iphone-shortcut"
```

Store it once in the Shortcut (step 3). The live-capture bridge takes one
of its own the same way — mint a second, labelled `live-capture`, and set it
as `METISTRY_LIVE_CAPTURE_INBOX_TOKEN` (`packages/mcp-live-capture/README.md`)
— so revoking one never silences the other. It is an **owner token**: capture
and messages only — it cannot manage devices or answer requests (CRIT-7), so a
lost phone leaks capture ability, not control. Revoke from the Studio:
`UPDATE owner_tokens SET revoked_at = now() WHERE label = 'iphone-shortcut'`.
(An **agent token** — minted in the console's *agents* tab — also works on
`/capture`, and only there: the inbox row records which agent sent it.)
A client that retries — the native app's outbox, a script — sends an
`Idempotency-Key` so a retry returns the first row instead of a duplicate
(`docs/ops/console-api.md`). The Shortcut sends none and is unchanged.

## 2. Build the Shortcut ("Capture to Metistry")

Shortcuts app → + → name it → **Show in Share Sheet** ON, accepts:
Text, URLs, Images, PDFs, Files.

Actions, in order:

1. **Receive** `Shortcut Input` from Share Sheet (fallback: *Ask For Text*)
2. **If** `Shortcut Input` *has any value* — else branch: *Ask For Text*
   ("note…") → set as input
3. **Text** (private): your owner token → `Token`
4. **Get Details of Files** → *Name* → `Filename` (for images/files)
5. **Get Contents of URL**
   - URL: `https://<your-origin>/capture`
   - Method: **POST**
   - Headers: `Authorization: Bearer <Token>`,
     `X-Metistry-Filename: <Filename>`
   - Request Body: **File** → `Shortcut Input`
     (for plain text: JSON body `{"note": <Shortcut Input>}` with
     header `Content-Type: application/json`)
6. **If** the previous action errored (wrap 5 in *Try/Otherwise* via the
   "Get Dictionary Value → id" check failing):
   - **Save File** `Shortcut Input` to **iCloud Drive/Metistry Inbox/**
     (ask where: OFF) — the local fallback; the Mac ingests it on wake
   - **Show Notification**: "saved offline — will sync"
7. else **Show Notification**: "captured → inbox #`id`"

Add to Home Screen / Action Button / "Hey Siri, capture to Metistry" for
dictation capture.

## 3. macOS Quick Action

Shortcuts on macOS: same Shortcut, **Use as Quick Action** → Services
menu + Finder. Or an Automator "Run Shell Script" calling `curl` with
the same headers.

## 4. Mac side of the fallback

Offline captures wait in that iCloud folder. The cheapest way to ingest them
now that the inbox is in the vault: move the files into
`<instance>/Inbox/`. The reconciler's scan notices anything that
appears there by content hash and files a triage row for it, exactly as if
it had come through `POST /capture` (`docs/ops/inbox.md`). An automatic
sweep of the iCloud folder is still unbuilt.
