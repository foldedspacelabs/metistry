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

A Developer ID certificate turned out to be necessary but **not sufficient**.
Two more things had to be true, both in §3:

1. **The helper must be an app bundle.** TCC only keys a grant on a bundle
   identifier when the client *is* a bundle; a bare executable is keyed on
   its absolute path. Both helpers now build as minimal `.app` bundles.
2. **Hardened runtime needs the resource-access entitlement.** With
   `--options runtime` and no
   `com.apple.security.personal-information.calendars`, tccd never prompts —
   it denies in silence.

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

Both helpers already know how to prefer a Developer ID identity —
`packages/mcp-eventkit/scripts/build-helper.sh` and
`packages/mcp-apple-fm/scripts/build-helper.sh` run:

```sh
codesign --force --options runtime --timestamp \
  --identifier com.foldedspacelabs.metistry.eventkit \
  --sign "Developer ID Application: Matt Colf (TEAMID1234)" \
  helper/ek-helper.app
```

(`afm-helper` is the same shape, no `requires_tcc`, so ad-hoc was previously
"functionally fine"; sign it too now that a real identity exists, both
because a future DMG will want every shipped binary under one identity for
notarization, and because a consistent identity is one less thing to reason
about later.)

### Each helper is an app bundle, not a bare binary (2026-09-08)

Both build scripts produce a **minimal app bundle**, and this is load-bearing
for the EventKit helper:

```
packages/mcp-eventkit/helper/ek-helper.app/Contents/Info.plist
packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper
```

**What TCC actually keys a grant on.** The `access` table in `TCC.db` stores
`client`, `client_type` and `csreq`:

- **Bundled client** (`client_type` 0): `client` is the **CFBundleIdentifier**,
  and `csreq` is the signature's **designated requirement**. For a Developer
  ID identity the implicit DR is `identifier "…" and anchor apple generic and
  certificate leaf[subject.OU] = TEAMID` — identifier plus certificate chain,
  **no cdhash**. Quinn (Apple DTS) on the purpose of a DR: it "allows the
  system to know that version N+1 of the program is the 'same code' as version
  N" ([forums.developer.apple.com/forums/thread/710086](https://developer.apple.com/forums/thread/710086)).
  So a rebuild changes the cdhash and the grant still holds.
- **Non-bundle executable** (`client_type` 1): `client` is the **absolute
  path**. An embedded `__info_plist`'s `CFBundleIdentifier` is *not* used as
  the TCC client key — `codesign` only uses it to derive a default signing
  identifier, i.e. it shapes the `csreq`, never the `client`. A path-keyed
  client also never appears in the Privacy pane, cannot be reset with
  `tccutil` (which takes bundle IDs), and loses its grant if the checkout
  moves. ([forums.developer.apple.com/forums/thread/697278](https://developer.apple.com/forums/thread/697278),
  [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements))

`LSUIElement` / `LSBackgroundOnly` are **Launch Services** keys, read from a
bundle's `Contents/Info.plist`; Launch Services never processes a bare
executable, so they are inert in an embedded `__info_plist`
([Launch Services Keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html)).
The bundle gives us `LSUIElement` for real — no Dock icon.

**Sign the bundle, not the inner binary.** `codesign` seals
`Contents/Info.plist` into the signature, which is what ties the bundle ID to
the identity. No `--deep` — there is nothing nested. The launchd plist's
`ProgramArguments` points at `…/ek-helper.app/Contents/MacOS/ek-helper`;
launchd runs bundle executables fine, and the job's root binary is still the
signed helper (PoC-1). The socket protocol and the Node client are unchanged.

**The bundles are build output and are never tracked** — `.gitignore` has
`packages/mcp-*/helper/*-helper.app/`. (The bare binary used to be committed
by accident; it is not any more.) Run the build script on any fresh checkout
before bootstrapping the launchd job.

### Entitlements — the EventKit helper needs one (correction, 2026-09-08)

This doc used to say "neither helper needs an entitlements file." That was
wrong, and it cost us a debugging session. Under hardened runtime
(`--options runtime`, which we want), tccd refuses to even *prompt* for
Calendars without the matching **resource-access entitlement**. Straight from
`log show --predicate 'process == "tccd"'` while the helper asked:

```
Prompting policy for hardened runtime; service: kTCCServiceCalendar requires
entitlement com.apple.security.personal-information.calendars but it is
missing for accessing={… ek-helper.app/Contents/MacOS/ek-helper}
```

There is no dialog and no error — EventKit's completion handler just hands
back `false`. So `packages/mcp-eventkit/helper/ek-helper.entitlements` carries:

```xml
<key>com.apple.security.personal-information.calendars</key><true/>
```

Reminders rides on the same entitlement; there is no separate
hardened-runtime entitlement for `kTCCServiceReminders`. `afm-helper` needs
none — it touches no TCC-protected resource.

`codesign` passes the entitlements file to AMFI, whose XML parser **rejects
comments**, so the build script runs it through `plutil -convert xml1` into a
temp file before signing. That keeps the *why* in the checked-in file instead
of leaving a bare four-line plist nobody can explain a year from now.

This is a hardened-runtime entitlement, **not the App Sandbox**.
`com.apple.security.app-sandbox` stays absent — it would block the EventKit
helper's non-sandboxed launchd-service shape for no benefit. The usage
strings in `helper/Info.plist` (`NSCalendarsFullAccessUsageDescription`,
`NSRemindersFullAccessUsageDescription`) are still required too: the
entitlement decides whether macOS *may* prompt, the usage string is what the
prompt *says*. You need both.

**The scripts auto-detect a Developer ID identity by its SHA-1 hash** —
the first column of `security find-identity -v -p codesigning`, not the
quoted display name — and fall back to ad-hoc if none is found. The hash
matters (learned 2026-09-09): after a renewal or a second import the
keychain holds two valid Developer ID Application certs with byte-identical
names, and `codesign -s "<name>"` refuses with
`ambiguous (matches "…" and "…" in login.keychain-db)`. A hash is unique by
construction, so `codesign -s <hash>` always picks exactly one; the scripts
print both the hash and the name they chose (`signed: A7FB… (Developer ID
Application: …)`). `ops/release/build-app.sh` selects the same way.

Two rules inside that auto-detection, because this Studio builds for two
Apple teams (FSL, and a personal team that still owns another app):

- duplicates of **one** name (the same team, imported twice or renewed) are
  fine — the first hash wins; same team means the same certificate chain
  and so the same TCC designated requirement;
- certs for **different** teams are never guessed at — the script stops,
  lists them, and asks for `METISTRY_SIGN_IDENTITY`. Today the personal
  team holds only Apple Development / Apple Distribution certs here (not
  Developer ID Application), so the filter already excludes it; the rule is
  for the day a personal Developer ID cert lands in the same keychain.

There is an explicit override so you can pin a specific identity — a name
or a hash, `codesign -s` takes either — or force ad-hoc for a quick local
iteration:

```sh
METISTRY_SIGN_IDENTITY=A7FBCE6DFD83EA75E3F72BC7E3C4895713779BED \
  packages/mcp-eventkit/scripts/build-helper.sh
```

(The Studio's `.env` pins the hash for exactly this reason. Re-signing a
helper under the same identity and bundle id keeps its TCC grant — the
Developer ID designated requirement is identifier + certificate chain, with
no cdhash — so a rebuild after this change needed no re-grant; verified with
`launchctl kickstart -k` and the bridge's `/check` reporting full access.)

Unset (the default), behavior is unchanged: auto-detect, then ad-hoc. The
patch is in this PR (`scripts/build-helper.sh` in both packages).

**Rebuild and confirm the new identity:**

```sh
packages/mcp-eventkit/scripts/build-helper.sh
codesign -dv --verbose=2 packages/mcp-eventkit/helper/ek-helper.app 2>&1 | grep -E "Authority|Identifier|Format"
packages/mcp-apple-fm/scripts/build-helper.sh
codesign -dv --verbose=2 packages/mcp-apple-fm/helper/afm-helper.app 2>&1 | grep -E "Authority|Identifier|Format"
```

Done looks like `Authority=Developer ID Application: Matt Colf (TEAMID1234)`
and `Format=app bundle with Mach-O thin (arm64)` on both — not
`Authority=(unavailable)` (ad-hoc, no `Authority` line) and not
`Format=Mach-O thin` (a bare binary — path-keyed in TCC, see above).

**One-time TCC re-grant when the CLIENT IDENTITY changes.** The client
identity is the bundle ID plus the signing identity; changing either (moving
off ad-hoc, changing the certificate, or — as here — moving from a bare
binary to a bundle) means TCC sees a new client and the old
Calendars/Reminders grant does not carry over. It must be re-requested once:

```sh
launchctl bootout gui/$(id -u)/com.foldedspacelabs.metistry.calendar 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.foldedspacelabs.metistry.calendar.plist
launchctl kickstart -k gui/$(id -u)/com.foldedspacelabs.metistry.calendar
printf '{"id":1,"op":"request"}\n' | nc -U /tmp/metistry-eventkit.sock
```

(Ask the *running job* over its socket — don't run the binary by hand from a
terminal, or the terminal becomes the responsible process and the grant lands
on the wrong client.) Done looks like the macOS Calendars and Reminders
consent dialogs appearing (click Allow on both), then:

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

> **Secure timestamp (learned 2026-09-08).** Notarization rejects a
> signature without a trusted timestamp ("does not include a secure
> timestamp"). Both helper build scripts now pass `--timestamp` when
> signing with a real identity; it needs network access to Apple's
> timestamp server at sign time. Re-run the two build scripts after
> pulling this change, then resubmit.

## 4. Notarization (credentials only — the DMG pipeline is a separate PR)

Notarization needs its own App Store Connect API key, kept out of the repo
entirely.

Notarization here always means the App Store Connect API key
(`xcrun notarytool --key --key-id --issuer`) — never an Apple ID +
app-specific password. The API key doesn't expire on a password reset,
which matters once it's a CI credential rather than a by-hand one.

1. **Create the key**: [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
   → Users and Access → Integrations → **Keys** → **+**, role
   **Developer**, download the `.p8` once (Apple won't re-serve it) and note
   the Key ID and Issuer ID shown next to it.
2. **Store credentials in a local keychain profile** (never in `.env` or
   the repo):
   ```sh
   xcrun notarytool store-credentials "metistry-notary" \
     --key /path/to/AuthKey_XXXXXXXXXX.p8 \
     --key-id XXXXXXXXXX \
     --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
   This writes into the Studio's login keychain under the profile name, not
   to a file. ([developer.apple.com/documentation/security/notarizing-macos-software-before-distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))
3. **Dry-run against a signed helper**, to prove the credentials work before
   any release workflow exists:
   ```sh
   ditto -c -k --keepParent packages/mcp-eventkit/helper/ek-helper.app /tmp/ek-helper.zip
   xcrun notarytool submit /tmp/ek-helper.zip --keychain-profile "metistry-notary" --wait
   ```
   The helper bundle is not the shipped artifact (that is the future DMG),
   so `stapler staple` on the zip itself will report it cannot staple a
   zip — that is expected here; done looks like the
   submit step printing `status: Accepted`, which proves the credentials
   and the binary's signature are both valid. The real `stapler staple
   MyApp.app` / `stapler staple Metistry.dmg` step belongs to the DMG
   release workflow.

**Secrets the future release workflow needs** (as GitHub Actions secrets,
never committed): the Developer ID Application certificate exported as
`APPLE_CERTIFICATE_P12` (base64-encoded) plus `APPLE_CERTIFICATE_PASSWORD`
(its export password), `APPLE_TEAM_ID`, and the three notarytool API-key
values — `APPLE_API_KEY_P8` (the `.p8` contents, base64-encoded),
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`. Export the `.p12` from Keychain
Access (select the cert → right-click → Export) directly into
`gh secret set` — pipe it, don't save it to disk first:
```sh
security export -k login.keychain-db -t identities -f pkcs12 -P "<export-password>" -o /dev/stdout \
  | base64 | gh secret set APPLE_CERTIFICATE_P12 --repo foldedspacelabs/metistry
```
The `.p8` has to touch disk once (Apple only serves it at creation time),
so set its secret straight from that file and then delete it — it should
never persist anywhere but Keychain Access's own record and the GitHub
secret:
```sh
base64 < AuthKey_XXXXXXXXXX.p8 | gh secret set APPLE_API_KEY_P8 --repo foldedspacelabs/metistry
rm -f AuthKey_XXXXXXXXXX.p8
```
Same rule for any `.p12` that does land on disk (a re-export, a backup
copy) — delete it once the secret is set. And if a `GH_TOKEN` is set in
your shell (e.g. a fine-grained PAT used for something else), it shadows
`gh`'s own keyring login and `gh secret set` 404s instead of prompting you
to log in — run `env -u GH_TOKEN gh secret set …` for these and any other
`gh` admin command.

## 5. Sparkle update-signing keys (EdDSA)

Future auto-update appcast signing (`docs/product/desktop-app-plan.md`
"Updates"). The Homebrew cask `sparkle` is **disabled** (fails Gatekeeper,
2026-09-01), so get the CLI tools with the pinned-download-plus-checksum
script instead — the same pattern `ops/release/build-runtime-deps.sh` uses
for Node/Postgres/git:

```sh
bash ops/release/fetch-sparkle-tools.sh
```

This downloads the `Sparkle-<version>.tar.xz` release archive
([github.com/sparkle-project/Sparkle/releases](https://github.com/sparkle-project/Sparkle/releases)),
refuses it if the sha256 doesn't match the pin in
`ops/release/runtime-versions.env` (`SPARKLE_VERSION` / `SPARKLE_SHA256`),
and extracts `bin/generate_keys`, `bin/sign_update`, `bin/generate_appcast`
to `ops/release/.tools/sparkle/bin/` (gitignored, not Homebrew, no sudo).
Idempotent — re-running with the same pin is a no-op. To bump the version:
change those two lines in `runtime-versions.env` (get the sha256 by
downloading the new archive once and `shasum -a 256`, same as every other
pin in that file), then re-run the script. CI runs the same script in the
`appcast` job (`.github/workflows/release.yml`) so it is one line to
un-stub once the DMG job exists.

1. Generate the key pair:
   ```sh
   ops/release/.tools/sparkle/bin/generate_keys
   ```
   The **private key is written straight into the Studio's login
   Keychain** — Sparkle's docs are explicit that you don't need to touch it
   again, just keep the Mac (or the Keychain export below) safe.
   ([sparkle-project.org/documentation/#3-generate-keys-for-signing-updates](https://sparkle-project.org/documentation/#3-generate-keys-for-signing-updates))
2. The same command prints the **public key**, base64-encoded. That goes
   into the SwiftUI app's `Info.plist` as `SUPublicEDKey` once the app
   target exists — not a secret, fine committed there. It is also recorded
   as the `SPARKLE_PUBLIC_ED_KEY` repo secret so CI never has to read it
   back out of the Xcode project:
   ```sh
   gh secret set SPARKLE_PUBLIC_ED_KEY --repo foldedspacelabs/metistry <<< "<public key from generate_keys>"
   ```
3. **Export the private key for CI** only when the release workflow needs
   to sign appcasts outside this Mac:
   ```sh
   ops/release/.tools/sparkle/bin/generate_keys -x /tmp/sparkle-private-key.txt
   gh secret set SPARKLE_PRIVATE_KEY --repo foldedspacelabs/metistry < /tmp/sparkle-private-key.txt
   rm /tmp/sparkle-private-key.txt
   ```
   Skip this while signing happens on the Studio by hand — and delete the
   exported file the moment the secret is set; the Keychain copy is the
   one that should persist.

The Sparkle **framework** itself (linked into the SwiftUI app, not this
CLI) is added later via Swift Package Manager —
`https://github.com/sparkle-project/Sparkle`, pinned to a major version —
when the Xcode project exists. Not Homebrew either.

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
      (names only, values never in the repo): `APPLE_CERTIFICATE_P12` +
      `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, the notary API key
      (`APPLE_API_KEY_P8` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`),
      `SPARKLE_PRIVATE_KEY` and `SPARKLE_PUBLIC_ED_KEY` (only if signing
      moves off this Mac). Every `.p12`/`.p8` export used to set one of
      these is deleted from disk right after `gh secret set` — see §4.
