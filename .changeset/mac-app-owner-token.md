---
"@metistry-apps/macos": minor
---

The Mac app signs in to the local console without a ceremony, and never holds
the token.

- **"Signed in as owner (local token)"** in the Status header, Settings →
  Connections and beside the console row in the menu bar, from one
  `metistry console whoami --json` per launch and per instance switch. Five
  states, each with the CLI's own words and, where there is one, the exact
  command: signed in · this CLI has no `console whoami` (update it) · no local
  owner token (`metistry secrets sync --to env`, then restart the console) ·
  the console did not answer · 401, with **which** of the loopback rule and a
  stale value is likelier for this install's deployment shape.
- **One client, and the authenticated half of it is the CLI.** The app does not
  read the login Keychain, does not open `<instance>/state/.env`, and sends no
  `Authorization` header anywhere — a test walks `apps/macos/sources` and
  asserts each of those rather than trusting a comment. The four HTTP routes it
  speaks are the console's public bootstrap ones and nothing else. It therefore
  cannot yet make any authenticated console call except `whoami`, and the doc
  says so: that is a CLI change first.
- **Wizard step 6 is optional and reframed** — "your Mac is signed in
  automatically; enrol a passkey only for browsers and your phone" — with the
  enrolment-code path kept intact for those, and the `ASAuthorization` probe
  moved out of the main flow to Settings → Advanced, where a diagnostic
  belongs. A successful whoami satisfies the step; so does an enrolled passkey,
  because it is the same door.
