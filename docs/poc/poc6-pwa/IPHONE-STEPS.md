# PoC-6 — iPhone steps

**URL:** `https://mac-studio.example.ts.net/`

---

## STEP 0 — BLOCKER: enable Serve + HTTPS on the tailnet (do this first, on the Mac)

`tailscale serve` and `tailscale cert` are **both disabled at the tailnet level** right now.
Nothing below works until this is turned on. This is an admin-console toggle, **not** a `sudo`
problem — no elevated command will fix it.

Exact errors captured:

```
$ /usr/local/bin/tailscale serve --bg 8093
Serve is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/serve?node=nmvFTd2KLM11CNTRL

$ /usr/local/bin/tailscale cert mac-studio.example.ts.net
HTTPS cert support is not enabled/configured for your tailnet.
```

Do this:

1. Open <https://login.tailscale.com/f/serve?node=nmvFTd2KLM11CNTRL> in a browser and approve.
2. If HTTPS certs are still off, enable **HTTPS Certificates** in the admin console under
   **DNS** → <https://login.tailscale.com/admin/dns>.
3. Back on the Mac, run (no sudo needed):

   ```sh
   /usr/local/bin/tailscale serve --bg 8093
   /usr/local/bin/tailscale serve status
   ```

   `serve status` should then show `https://mac-studio.example.ts.net/ → http://127.0.0.1:8093`.

4. Verify from the Mac before touching the iPhone:

   ```sh
   curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://mac-studio.example.ts.net/
   ```

   Expect `200 text/html; charset=utf-8`. The first request may take a few seconds while the
   Let's Encrypt cert is provisioned. A plain `curl` succeeding (no `-k`) is the proof that the
   cert is publicly valid — which is what iOS requires to register a service worker.

---

## STEP 1 — Open in Safari on the iPhone

Make sure the iPhone is on the tailnet (Tailscale app connected).

Open Safari and go to:

```
https://mac-studio.example.ts.net/
```

The page shows a badge reading **"Safari tab - install to Home Screen for push"**. That is expected.
Do **not** tap "Enable notifications" yet — in a plain Safari tab iOS does not expose the
Notification/Push APIs at all, and it will just log an error.

## STEP 2 — Add to Home Screen

1. Tap the **Share** button (square with an up arrow).
2. Scroll down, tap **Add to Home Screen**.
3. Confirm the name ("Metistry") and tap **Add**.

## STEP 3 — Open from the Home Screen icon

Close Safari. Tap the new **Metistry** icon on the Home Screen.

The badge at the top must now read **"standalone (installed) - push supported"**. If it still
says "Safari tab", you opened it from Safari rather than the Home Screen icon — go back and tap
the icon.

## STEP 4 — Enable notifications

1. Tap **Enable notifications**.
2. iOS shows the system permission prompt → tap **Allow**.

The status log should show, in order:
- `service worker ready, scope=https://mac-studio.example.ts.net/`
- `permission = granted`
- `VAPID public key (87 chars): BLy0gRyA-BPqPRrBs8nw...`
- `subscribed. endpoint host = web.push.apple.com`
- `POST /subscribe -> 200 {"ok":true,"action":"added","total":1}`

## STEP 5 — Test push with the app open

Tap **Send test push**.

Expect a notification banner reading **"Metistry PoC — Metistry PoC-6 push received"**.
The in-page log should show a `"status": 201` result for the `web.push.apple.com` endpoint.
(201 Created is the success code for the Apple push service.)

## STEP 6 — Test push with the app CLOSED (the real test)

This is the part that proves background push works.

1. On the iPhone, **fully swipe the Metistry app away** from the app switcher.
2. On the **Mac**, run:

   ```sh
   curl -X POST https://mac-studio.example.ts.net/push-test
   ```

   (equivalently `curl -X POST http://127.0.0.1:8093/push-test` from the Mac itself)

3. The iPhone should show the notification even with the app closed.
4. Tap the notification — it should open the Metistry app (`notificationclick` →
   `clients.openWindow('/')`).

---

## The push-trigger command

```sh
curl -X POST https://mac-studio.example.ts.net/push-test
```

It reads every stored subscription from `subscriptions.json`, builds a fresh ES256 VAPID JWT per
endpoint, and POSTs a payload-less push with `TTL: 60`. The JSON response lists each endpoint's
HTTP status.

Useful companions:

```sh
# what is currently subscribed
curl -s https://mac-studio.example.ts.net/subscriptions

# the VAPID public key the page uses
curl -s https://mac-studio.example.ts.net/vapid-public-key

# server log (includes the VAPID JWT header/claims shape, never the private key)
tail -f poc/poc6-pwa/server.log
```

---

## Interpreting push status codes

| Status | Meaning |
|---|---|
| `201` | Accepted by the push service. Success. |
| `400` | Malformed request — usually a bad `Authorization` header. |
| `401` / `403` | VAPID JWT rejected (bad signature, wrong `aud`, expired `exp`). |
| `404` / `410` | Subscription is dead. Re-run "Enable notifications" on the phone. |
| `0` + `error` | Never reached the push service (DNS/network). |

---

## iOS caveats baked into the page

- **iOS 16.4+ is required** for web push. Earlier versions have no `PushManager` at all.
- **Push only works when installed to the Home Screen.** In a normal Safari tab, iOS does not
  expose `Notification` or `PushManager`. The page detects this via `navigator.standalone` and
  shows a warning badge plus an explanatory note.
- **`Notification.requestPermission()` must be called from a user gesture** on iOS. It is wired to
  the button's click handler for this reason.
- **Payload-less push by design.** The push carries no encrypted body, so no RFC 8291 /
  `aes128gcm` encryption is needed — which is what keeps this PoC zero-dependency. The service
  worker shows a fixed notification string instead of rendering server-sent content.
- **`userVisibleOnly: true`** is mandatory — the subscription is rejected without it, and iOS
  requires that every push actually shows a notification.
- **Reinstalling the Home Screen app invalidates the subscription.** If you delete and re-add the
  icon, the old endpoint starts returning 410 and you must tap "Enable notifications" again.
- The endpoint host on iOS is `web.push.apple.com`.

---

## Restarting the server

It runs as a plain background `node` process (started with `nohup`, logging to `server.log`).
It does **not** survive a reboot. To restart:

```sh
cd /Users/example/Development/Metistry/.claude/worktrees/metistry-phase-0-poc-12cdbc/poc/poc6-pwa
nohup /opt/homebrew/bin/node server.mjs > server.log 2>&1 &
```

`tailscale serve --bg` config *is* persistent, so once Step 0 is done it should come back on its
own. Check with `tailscale serve status`; clear it with `tailscale serve reset`.
