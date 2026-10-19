- 2026-10-19 — **Adding a phone is a QR code on the Mac, and the code dies
  when you close the sheet.** Settings ▸ Devices ▸ Add a Phone… (and the setup
  wizard's door step — one sheet, drawn once) mints a one-time, ten-minute
  enrolment code on this Mac with `metistry enroll` and draws it as a QR for
  the phone to scan, with the link beside it to copy; the sheet turns to
  *“iPhone” was added* by itself when the phone's passkey appears. Minting
  stays a CLI verb the app runs, never an HTTP route: shell access to the Mac
  is the root of trust for a first credential, so a console reachable from the
  internet still has no door that mints one. The sheet refuses in the CLI's
  own words when the phone could not possibly reach the Mac — a loopback
  origin, `http:`, an IP address, a name this Mac itself cannot open — and
  draws no QR for a refusal; closing it in any state cancels a code that is
  still live, so a QR left on screen or in a screenshot leads nowhere. The
  Devices pane lists each device as its passkey with its sessions, and
  **Remove** revokes the passkey and every session under it after a confirm
  naming the device, which is what the website's "remove it from Devices
  anytime" promised; **Sign Out Everywhere** keeps every passkey. The QR is
  CoreImage's, part of macOS, no dependency.
