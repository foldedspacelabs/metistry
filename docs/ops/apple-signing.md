# Apple signing — Developer ID, TCC re-grant, notarization, Sparkle keys

> By-hand runbook for the owner on the Mac Studio. One time setup (steps
> 1–2, 5), then a recurring step whenever a helper is rebuilt with a new
> identity (step 3), and setup for a release pipeline that doesn't exist
> yet (steps 4–5 build the credentials the DMG workflow will consume —
> `docs/product/desktop-app-plan.md` "Distribution").

Why this exists: PoC-1/3/9 (`metistry-build-plan.md` §4.16) found that TCC
grants attach to a binary's exact signing identity, and an ad-hoc signature's
cdhash changes on every rebuild — so a granted EventKit helper silently loses
its Calendars/Reminders access the next time it's compiled. D3 (§4.3, §4.16)
is "Swift TCC bridges, stably signed": a **Developer ID Application**
certificate gives `ek-helper` and `afm-helper` an identity that survives
rebuilds and source edits.

## 1. Apple Developer Program membership

Individual ($99/yr) vs. organization, for Folded Space Labs:

- **Individual** lists *your personal legal name* as the entity. No D-U-N-S,
  no separate legal-entity paperwork — you enroll with your own Apple
  Account today.
- **Organization** requires FSL to be a recognized legal entity (not a DBA
  or trade name), a **D-U-N-S number** (free via Dun & Bradstreet, look up
  or request one at the enrollment flow), a work-domain email, a public
  website, and the enrolling person to hold binding legal authority for the
  org. ([developer.apple.com/help/account/membership/program-enrollment](https://developer.apple.com/help/account/membership/program-enrollment))

**Recommendation: enroll as an individual.** FSL has no other engineers, no
outside distribution obligation yet (the DMG plan is GitHub Releases, not the
Mac App Store), and the org path's only payoff — the seller name reading
"Folded Space Labs, Inc." instead of your name, and being able to add team
members later — isn't worth blocking the whole signing chain on a D-U-N-S
lookup and notarized paperwork. Converting an individual enrollment to an
organization later is Apple's documented path if FSL ever needs it (e.g. a
second signer, or App Store distribution).

**Done looks like:** signed in at
[developer.apple.com/account](https://developer.apple.com/account) with an
active ($99/yr paid) membership, and `xcrun altool --list-providers` or the
Xcode Accounts pane shows your Team ID.

## 2. Developer ID Application certificate

Steps, from Apple's certificate guide
([developer.apple.com/help/account/certificates/create-developer-id-certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)):

1. **Create the CSR** in Keychain Access on the Studio: *Keychain Access
   → Certificate Assistant → Request a Certificate From a Certificate
   Authority…* — enter your email, common name "Matt Colf", leave the CA
   email blank, select **Saved to disk**, save
   `~/Desktop/CertificateSigningRequest.certSigningRequest`.
2. **Request the certificate**: [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates)
   → **+** → under Software, **Developer ID** → **Developer ID
   Application** (sign the helper binaries) → Continue → upload the
   `.certSigningRequest` → Continue → **Download**.
   - If a `.pkg` installer is ever built (not currently planned — the DMG
     ships an `.app`), repeat for **Developer ID Installer** the same way.
   - Xcode's Accounts pane (*Xcode → Settings → Accounts → Manage
     Certificates → +*) does the same CSR-and-request round trip if you'd
     rather not touch Keychain Access directly.
3. **Install it**: double-click the downloaded `.cer` — it lands in the
   login keychain (`My Certificates`), paired automatically with the
   private key the CSR was generated from.
4. **Verify**:
   ```sh
   security find-identity -v -p codesigning
   ```
   Done looks like a line reading `"Developer ID Application: Matt Colf
   (TEAMID1234)"` with a `1)` valid count, not `0 valid identities found`.

## 3. Signing the Swift helpers

> **What the identity string is (learned 2026-09-08).** Use exactly what
> `security find-identity -v -p codesigning` prints for the *Developer ID
> Application* line — the organisation's legal name and Team ID, e.g.
> `Developer ID Application: Folded Space Labs LLC (QWWHT4S27V)`, never a
> personal name or a different team. If two Developer ID Application
> identities share that name (two certificates were issued), `codesign`
> refuses the name as ambiguous: pass the **SHA-1 hash** from that listing
> instead (`--sign A7FBCE6D…`). The *Developer ID Installer* certificate is
> not a code-signing identity and does not appear under `-p codesigning`;
> that is expected. Put the hash in `.env` as `METISTRY_SIGN_IDENTITY` so
> every rebuild picks the same certificate.
>
> **Run the first signing from an interactive Terminal.** codesign asks
> the keychain for the private key; the dialog must be answered *Always
> Allow* once. From a non-interactive shell (an agent, launchd) the request
> fails with `errSecInternalComponent` and the helper silently stays
> ad-hoc — check with `codesign -dv` (`Signature=adhoc` means it failed).


Both helpers already know how to prefer a Developer ID identity —
`packages/mcp-eventkit/scripts/build-helper.sh` and
`packages/mcp-apple-fm/scripts/build-helper.sh` run:

```sh
codesign --force --options runtime \
  --identifier com.foldedspacelabs.metistry.eventkit \
  --sign "Developer ID Application: Folded Space Labs LLC (QWWHT4S27V)" \
  helper/ek-helper
```

(`afm-helper` is the same shape, without `--identifier` — its bundle ID
comes from the binary's own `CFBundleIdentifier` via `-parse-as-library`, no
`requires_tcc`, so ad-hoc was previously "functionally fine"; sign it too now
that a real identity exists, both because a future DMG will want every
shipped binary under one identity for notarization, and because a
consistent identity is one less thing to reason about later.)

**Entitlements:** neither helper needs an entitlements file. Hardened
runtime (`--options runtime`) is on, but EventKit/Reminders access is
governed by TCC via the usage-description strings embedded in
`helper/Info.plist` (`NSCalendarsFullAccessUsageDescription`,
`NSRemindersFullAccessUsageDescription`) as an `__info_plist` linker
section — not by an entitlement, and neither helper is sandboxed (no
`com.apple.security.app-sandbox`). Don't add one; App Sandbox would block
the EventKit helper's non-sandboxed launchd-service shape for no benefit.

**The scripts already auto-detect a Developer ID identity** (`security
find-identity -v -p codesigning | grep "Developer ID Application"`) and fall
back to ad-hoc if none is found. This patch adds an explicit override so you
can pin a specific identity when more than one Developer ID cert is
installed, or force ad-hoc for a quick local iteration:

```sh
METISTRY_SIGN_IDENTITY="Developer ID Application: Folded Space Labs LLC (QWWHT4S27V)" \
  packages/mcp-eventkit/scripts/build-helper.sh
```

Unset (the default), behavior is unchanged: auto-detect, then ad-hoc. The
patch is in this PR (`scripts/build-helper.sh` in both packages).

**Rebuild and confirm the new identity:**

```sh
packages/mcp-eventkit/scripts/build-helper.sh
codesign -dv --verbose=2 packages/mcp-eventkit/helper/ek-helper 2>&1 | grep -E "Authority|Identifier"
packages/mcp-apple-fm/scripts/build-helper.sh
codesign -dv --verbose=2 packages/mcp-apple-fm/helper/afm-helper 2>&1 | grep -E "Authority|Identifier"
```

Done looks like `Authority=Developer ID Application: Folded Space Labs LLC (QWWHT4S27V)`
on both, not `Authority=(unavailable)` (ad-hoc, no `Authority` line).

**One-time TCC re-grant after the identity changes.** Changing `ek-helper`'s
signing identity is a new binary identity as far as TCC is concerned, so the
old Calendars/Reminders grant does not carry over — it must be re-requested
once, the same path documented in `docs/ops/reconciler.md`-adjacent
`ops/launchd/com.foldedspacelabs.metistry.eventkit-helper.plist`:

```sh
launchctl bootout gui/$(id -u)/com.foldedspacelabs.metistry.eventkit-helper 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.foldedspacelabs.metistry.eventkit-helper.plist
printf '{"id":1,"op":"request"}\n' | packages/mcp-eventkit/helper/ek-helper
```

Done looks like the macOS Calendars and Reminders consent dialogs appearing
(click Allow on both), then:

```sh
curl -s -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_EVENTKIT" http://127.0.0.1:7811/check
```

returning `ok` (not `degraded`/`denied`). `afm-helper` has `requires_tcc: []`
(`packages/mcp-apple-fm/manifest.yaml`) — Apple FM needs no TCC grant, so
re-signing it needs no re-grant step, just a restart of its launchd job:

```sh
launchctl kickstart -k gui/$(id -u)/com.foldedspacelabs.metistry.apple-fm
curl -s -H "Authorization: Bearer $METISTRY_BRIDGE_TOKEN_APPLE_FM" http://127.0.0.1:7810/check
```

## 4. Notarization (credentials only — the DMG pipeline is a separate PR)

Notarization needs its own App Store Connect API key, kept out of the repo
entirely.

1. **Create the key**: [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
   → Users and Access → Integrations → **Keys** → **+**, role
   **Developer**, download the `.p8` once (Apple won't re-serve it) and note
   the Key ID and Issuer ID shown next to it.
   - App-specific-password alternative (no App Store Connect access
     needed): [appleid.apple.com](https://appleid.apple.com) → Sign-In and
     Security → App-Specific Passwords → Generate. The API key is preferred
     for a CI workflow since it doesn't expire on a password reset.
2. **Store credentials in a local keychain profile** (never in `.env` or
   the repo):
   ```sh
   xcrun notarytool store-credentials "metistry-notary" \
     --key /path/to/AuthKey_XXXXXXXXXX.p8 \
     --key-id XXXXXXXXXX \
     --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
   (or the Apple ID + app-specific-password form:
   `--apple-id you@example.com --team-id QWWHT4S27V --password <app-specific>`).
   This writes into the Studio's login keychain under the profile name, not
   to a file. ([developer.apple.com/documentation/security/notarizing-macos-software-before-distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))
3. **Dry-run against a signed helper**, to prove the credentials work before
   any release workflow exists:
   ```sh
   ditto -c -k --keepParent packages/mcp-eventkit/helper/ek-helper /tmp/ek-helper.zip
   xcrun notarytool submit /tmp/ek-helper.zip --keychain-profile "metistry-notary" --wait
   ```
   A bare helper binary isn't the shipped artifact (that's the future DMG),
   so `stapler staple` on the zip itself will report it can't staple a
   non-bundle/non-disk-image — that's expected here; done looks like the
   submit step printing `status: Accepted`, which proves the credentials
   and the binary's signature are both valid. The real `stapler staple
   MyApp.app` / `stapler staple Metistry.dmg` step belongs to the DMG
   release workflow.

**Secrets the future release workflow needs** (as GitHub Actions secrets,
never committed): the Developer ID Application certificate exported as a
`.p12` (base64-encoded) plus its export password, and either the three
notarytool API-key values (`.p8` contents base64-encoded, Key ID, Issuer ID)
or the Apple ID + app-specific password + Team ID triple. Export the `.p12`
from Keychain Access (select the cert → right-click → Export) directly into
`gh secret set` — pipe it, don't save it to disk first:
```sh
security export -k login.keychain-db -t identities -f pkcs12 -P "<export-password>" -o /dev/stdout \
  | base64 | gh secret set METISTRY_DEVELOPER_ID_P12 --repo foldedspacelabs/metistry
```

## 5. Sparkle update-signing keys (EdDSA)

Future auto-update appcast signing (`docs/product/desktop-app-plan.md`
"Updates"). Sparkle's own tool generates the pair:

1. Download or build Sparkle's `generate_keys` tool (ships in the [Sparkle
   release](https://github.com/sparkle-project/Sparkle/releases)'s
   `bin/` directory), then:
   ```sh
   ./bin/generate_keys
   ```
   The **private key is written straight into the Studio's login
   Keychain** — Sparkle's docs are explicit that you don't need to touch it
   again, just keep the Mac (or the Keychain export below) safe.
   ([sparkle-project.org/documentation/#3-generate-keys-for-signing-updates](https://sparkle-project.org/documentation/#3-generate-keys-for-signing-updates))
2. The same command prints the **public key**, base64-encoded — that's what
   later goes into the SwiftUI app's `Info.plist` as `SUPublicEDKey`. Not a
   secret; it's fine committed once the app target exists.
3. **Export the private key for CI** only when the release workflow needs
   to sign appcasts outside this Mac (`generate_keys -x
   /tmp/sparkle-private-key.txt`, then `gh secret set
   METISTRY_SPARKLE_PRIVATE_KEY < /tmp/sparkle-private-key.txt` and `rm
   /tmp/sparkle-private-key.txt`) — skip this while signing happens on the
   Studio by hand.

## Checklist

- [ ] `security find-identity -v -p codesigning` shows a valid
      `"Developer ID Application: …"` identity.
- [ ] `ek-helper` and `afm-helper` rebuilt and `codesign -dv` on each shows
      `Authority=Developer ID Application: …` (not ad-hoc).
- [ ] EventKit TCC re-granted post-rebuild: `launchctl kickstart` +
      `{"op":"request"}` done, Calendars/Reminders consent clicked, and
      `curl … :7811/check` returns `ok`.
- [ ] Apple FM restarted post-rebuild and `curl … :7810/check` returns `ok`
      (no TCC grant needed — `requires_tcc: []`).
- [ ] `xcrun notarytool store-credentials "metistry-notary" …` stored, and
      the dry-run submit against a zipped signed helper returned `Accepted`.
- [ ] Sparkle `generate_keys` run once; public key noted for the future
      `Info.plist`.
- [ ] Release secrets recorded in the `foldedspacelabs/metistry` GitHub repo
      (names only, values never in the repo):
      `METISTRY_DEVELOPER_ID_P12`, `METISTRY_DEVELOPER_ID_P12_PASSWORD`,
      notary credentials (`METISTRY_NOTARY_KEY_P8` +
      `METISTRY_NOTARY_KEY_ID` + `METISTRY_NOTARY_ISSUER_ID`, or
      `METISTRY_APPLE_ID` + `METISTRY_APPLE_ID_PASSWORD` +
      `METISTRY_TEAM_ID`), `METISTRY_SPARKLE_PRIVATE_KEY` (only if signing
      moves off this Mac).
