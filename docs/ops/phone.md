# Add your phone

Once Metistry is running on your Mac, your iPhone can use it too, as a web app
on your Home Screen. It is the same instance, so everything stays in sync. The
phone gets **its own passkey** — it signs in with Face ID — and you can remove
it from your Mac at any time.

Adding a phone takes two things: a way for the phone to reach your Mac, and a
few minutes with the phone in your hand.

## Before you start

**Your phone has to be able to open your Mac's address.** Every install begins
answering on **this Mac only**, so a phone cannot open it yet — and a home-network
address would not help, because a passkey needs an `https://` address with a
name (not `http://`, not a bare IP address). You choose how the phone reaches
the Mac once, in **Settings ▸ Remote Access** (`metistry remote` in a terminal);
[Remote access](remote-access.md) lists the choices, what each one costs and who
can see the traffic. Until you have chosen, Add a Phone says so and draws no
code, rather than showing a QR code that leads nowhere.

You also need an iPhone with iOS 16.4 or later (Apple's requirement for
notifications from a Home Screen app), and the Camera.

## Add a phone

1. **On your Mac**, open Settings, then Devices, and choose **Add a Phone…**.
   Metistry first checks that your phone could reach the Mac (more on that
   below), then shows a QR code, the link under it, and a countdown.
2. **Scan the code with your iPhone's Camera** and open the link in **Safari**.
   Metistry takes the one-time code out of the address bar the moment the page
   loads, so it is not left in Safari's history.
3. **Name the device and create its passkey.** The page is called *Enroll This
   Device*; the name is filled in for you ("iPhone") and you can change it.
   Choose **Enroll This Device**, and confirm with Face ID (or Touch ID, or your
   passcode). The passkey is created in Safari, *before* you install anything.
4. **Add it to your Home Screen.** Metistry then shows the three steps: tap
   Share in Safari's toolbar, choose **Add to Home Screen**, then **Add**.
   Safari has no install button, and notifications only work from the Home
   Screen app.
5. **Open Metistry from your Home Screen** and choose **Sign In with Passkey**.
   Face ID signs you in with the passkey from step 3 — it is a sign-in, not a
   second set-up.

On your Mac the sheet turns to *"iPhone" was added*, using the name you gave it,
and the phone appears in Settings ▸ Devices.

A few things worth knowing:

- **The code works once, for ten minutes.** The sheet counts down; when time runs
  out it says *This code expired* — choose **Make a New Code**.
- **Closing the sheet kills the code at once**, and so does **Make a New Code**
  for the old one. A QR code left on screen, or in a screenshot, is dead as soon
  as you are done with it.
- **Notifications are asked about later, not now.** The first time something
  needs you, Metistry asks whether to send a notification. Nothing is asked
  during set-up.
- **A phone that cannot scan** can use **Copy Link** under the QR code: send the
  link to the phone yourself and open it in Safari.
- **In a terminal**, `metistry enroll` prints the same link (and the same
  refusals), and `metistry enroll --cancel <code id>` ends a code early. See
  [The CLI](cli.md).

## When Add a Phone says no

Add a Phone checks the address your phone will open *before* it makes a code. A
refusal means nothing was made, and no code exists. Each one names the address
(`METISTRY_ORIGIN`, its first entry) and ends by pointing at Settings ▸ Remote
Access on your Mac and `metistry remote` in a terminal; the sheet's **Learn How**
button opens this guide.

| What it says | What it means | The fix |
| --- | --- | --- |
| *Your phone can't reach this Mac yet: Metistry only answers on this Mac.* | The address is the Mac's own (`127.0.0.1`, `localhost`). This is where **every** install starts. | Choose how your phone reaches the Mac: Settings ▸ Remote Access, or `metistry remote set`. See [Remote access](remote-access.md). |
| *A passkey needs HTTPS.* | The address begins `http://`. A passkey will not be created on an unencrypted page. | Set the address to the `https://` one your phone will open. The remote-access choices give you one. |
| *A passkey needs a name, not an IP address.* | The address is a bare number such as `https://192.168.1.20`. A passkey is tied to a name. | Set the address to a hostname your phone can open. |
| *`<address>` doesn't answer from this Mac, so your phone won't reach it either.* | The Mac asked its own address whether it is there — and nothing answered within five seconds, or the address belongs to a different Metistry. The refusal prints which probe failed. | Open Settings ▸ Remote Access: it shows what your provider reports (for example, a tunnel that is not running). `metistry remote test` runs the same check from a terminal. |
| *METISTRY_ORIGIN is not set* / *is not a URL* | The install has no usable address. | Choose a remote-access option, or set `METISTRY_ORIGIN` to the `https://` address your phone will open ([Passkeys: origins](auth.md#passkeys-origins)). |

If the sheet says it *could not mint a code*, the Mac's command-line tools did not
answer (for example, the database is not running). Run `metistry doctor`.

**"Your phone must be able to open `<host>`."** This line sits under every
QR code, and it is a plain request: the Mac can prove a phone *cannot* reach an
address, but not that it *can*. A name that only your Mac resolves — or a
private network name when the phone is not on that network — passes every check
and still fails on the phone. If Safari shows its own "can't open the page" or
"server not found" error after you scan, that is what happened: the phone cannot
reach that name. Fix the way in (for a private-network choice, the phone needs
that network's app installed and signed in), then make a new code.

## When the phone says no

| The phone says | What to do |
| --- | --- |
| *This link has expired or was already used. Make a new one on your Mac.* | Codes work once and for ten minutes. Choose **Make a New Code** on the Mac and scan again. |
| *This device couldn't be enrolled. The link may have expired — make a new one on your Mac.* | The same. A code that expired between the scan and Face ID is the usual cause. |
| *No passkey was used. Try again when you're ready.* | You dismissed the Face ID prompt. Choose the button again. |
| *Can't reach Metistry. Check the connection and try again.* | The phone lost its connection to your Mac's address. Check the phone's network and that the Mac is awake and Metistry is running. |
| *Sign-in didn't work. Try again.* | Try once more. If it keeps failing, the passkey may have been made for a different address — see below — or the device was removed; add the phone again. |

**Changing how your phone reaches the Mac changes its address, and a passkey
signs in only at the address it was made for.** Phones added under the old
address will not sign in under the new one. Remove them in Settings ▸ Devices
and add them again; [Passkeys: origins](auth.md#passkeys-origins) has the detail.

## Your devices, and removing one

Settings ▸ Devices on your Mac lists every phone and browser with a passkey:
its name, when it was added and when it was last seen. This Mac is not in the
list — it signs in on its own, without a passkey. The phone's own Settings
shows the same list, with *This device* on its row.

- **Remove** a device when it is lost, sold or replaced. Metistry asks first,
  naming the device. Removing revokes its passkey, ends every session under it
  and stops its notifications, so it can never sign in again; a removed phone
  is added again as a new device, with a new passkey. A removed passkey is
  refused the same way an unknown one is, so nothing tells a thief which
  devices exist. You can delete the leftover passkey from the phone too, in
  Settings ▸ Passwords.
- **Sign Out Everywhere** signs every device out but keeps its passkey: each one
  signs in again with Face ID. Use it when you are not sure which device to
  remove.

Every device added or removed is recorded as an `auth` run, with the code's
id and never the code. To do either from a terminal:

```bash
metistry console call GET /api/devices
metistry console call POST /api/devices/<id>/revoke
```

## Going further

- **Reaching the Mac from outside the home** — choosing a way in, what each
  costs, and who can read the traffic: [Remote access](remote-access.md).
- **How the passkey, the one-time code and the origin fit together:**
  [Auth](auth.md).
- **Sending notes from the phone's share sheet** without the web app:
  [Capture Shortcut](capture-shortcut.md).
