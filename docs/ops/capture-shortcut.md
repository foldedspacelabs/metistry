# Share-sheet capture Shortcut (iOS) + macOS Quick Action

Capture from any app → `POST /capture`, with the **local-file fallback**
(SHOULD-10: one silent drop ends the trust). Until the native iOS app's
share extension exists, this Shortcut *is* the share sheet.

## 1. Mint an owner access token (on the Studio)

```bash
docker compose exec -e METISTRY_ORIGIN=https://<your-origin> console node scripts/enroll.mjs --owner-token "iphone-shortcut"
```

Store it once in the Shortcut (step 3). It is an **owner token**: capture
and messages only — it cannot manage devices or answer requests (CRIT-7), so a
lost phone leaks capture ability, not control. Revoke from the Studio:
`UPDATE owner_tokens SET revoked_at = now() WHERE label = 'iphone-shortcut'`.
(An **agent token** — minted in the console's *agents* tab — also works on
`/capture`, and only there: the inbox row records which agent sent it.)

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

`inbox-drain` should also sweep `~/Library/Mobile Documents/com~apple~CloudDocs/Metistry Inbox/`
(the `local-mac` profile only) — filed as the collector's next
increment; until then, offline captures wait in that folder.
