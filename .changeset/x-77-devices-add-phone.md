---
"@metistry-apps/macos": minor
---

Settings ▸ Devices and the Add a Phone sheet (plan §2.22, X-77). The ACCESS
group gains **Devices**: a device per passkey from `GET /api/devices` — label,
added, last seen, *This device*, its sessions — with **Remove** (the passkey
and every session under it, confirmed naming the device) and **Sign Out
Everywhere** (sessions only, passkeys kept, once per signed-in device with the
caller's own last), both `POST /api/devices/:id/revoke` told apart by scope.
**Add a Phone…** — the pane's primary button and the wizard's step 6, one
sheet drawn once — runs `metistry enroll --json` (M19) through the management
runner and draws the QR with CoreImage's `CIQRCodeGenerator` (no dependency):
Checking, Refused (the CLI's own words, no QR), Ready (the QR, the URL, Copy
Link, a countdown), Expired, Added (seen on `GET /api/devices`). Closing the
sheet in any state runs `enroll --cancel` for a code that is still live. Step
6 no longer shows the `enroll.mjs` command or takes a pasted code.
