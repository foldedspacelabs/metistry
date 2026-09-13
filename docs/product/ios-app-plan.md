# Native iOS app — planning document (2026-09-01)

> Status: **planning only** — post-Phase-6. Free and open source (strategy
> 2026-09-07); one SwiftUI codebase with the Mac app (`desktop-app-plan.md`).
> This captures the thinking early so the API and product decisions made
> now don't foreclose it. Nothing here is on the build path yet.

## Why native earns its place (beyond "richer UI")

The PWA is the primary interface and stays so (D2). Native adds exactly
the things a web app cannot reach, and each maps to an existing design
thread:

| Native capability | What it unlocks | Design thread it completes |
|---|---|---|
| **Share extension** | True share-sheet capture from any app, with an **offline queue** that replays to `POST /capture` | SHOULD-10's capture-never-drops, done properly |
| **APNs (real push)** | Reliable delivery + **actionable notifications** — allow/deny a proposal from the notification itself | The D10 soft-budget brief becomes one-tap triage |
| **On-phone Apple FM** | The same free classification tier the Mac runs, on-device — captures classified *before* upload, offline | The apple-fm bridge contract, second implementation |
| **HealthKit** | The phone is the health hub; the plan's HealthKit row says "no fallback" on Mac — **the iOS app IS the fallback** | Fills the §4.17 cannot-move table's only hard gap |
| **Widgets / Live Activities / App Intents (Siri)** | `/status` on the Lock Screen, brief as a widget, "Hey Siri, note…" | §4.1's "the fast mobile path isn't chat" |
| **Passkeys, native** | `ASAuthorization` against the same RP ID — the existing `passkeys`/`auth_sessions` rows work unchanged | §4.2 auth, zero server change |

## Architecture constraints (already ratified — the app must not bend them)

- **Same open API, no private endpoints** (plan "Later" section). Anything
  the app needs, the PWA gets too.
- **Owner-credential model unchanged**: native passkey sign-in → the same
  device sessions; the share extension carries an owner access token like
  the Shortcut does today.
- **Instance-pointed, not cloud-pointed**: the app talks to *your*
  instance's origin. Multi-instance (work/personal) = two configurations
  in one app.

## The one hard architectural problem: APNs for self-hosters

APNs sender credentials (.p8 key) belong to the **app developer** (FSL),
not to an instance. A self-hosted console cannot push to the app directly.
Options, roughly in order of appearance:

1. **FSL-run push relay**: instance → relay (payload-free "wake + fetch"
   pings, so no content transits FSL) → APNs. This is the first naturally
   *hosted* component in the product. With the premium plan dropped
   (2026-09-07) it becomes a **small free community service**: opaque
   pings are near-zero cost, the relay code lives in the repo, and the
   app accepts a custom relay URL so anyone with an Apple developer
   account can run their own. Privacy posture: token registry + opaque
   pings only. The Mac app on the host machine needs no relay at all
   (local notifications).
2. Web push stays as the fallback channel (already shipped) — the app can
   also receive nothing and poll on open.
3. Power users with their own Apple Developer account could run their own
   relay (keep the relay open-source).

This decision shapes pricing and the privacy story; it does NOT block
anything current — but the notification payload design (option 1's
wake-and-fetch) argues for keeping push payloads *thin* even in today's
web push, which we already do.

## Phasing sketch (when the time comes)

1. **Capture companion** — share extension + offline queue + capture box +
   APNs with actionable triage. Smallest thing that beats the PWA daily.
2. **Chat + status** — the door, native.
3. **HealthKit + widgets + App Intents** — the phone-only data and surfaces.
4. **On-phone FM tier** — classify at capture time, offline.

## Two instances, and a backend that is not always there (recorded 2026-09-13)

From `docs/research/2026-09-11-multi-instance-and-offline-client.md`, whose
recommendations the owner accepted; the server half already shipped (#132,
`docs/ops/console-api.md`). Recorded here so the app is not designed against a
different answer later:

- An **instance on the phone is `(origin, instance_id)`** — display name,
  passkey credential, session cookie, push registration, local store and outbox
  are all keyed by `instance_id`, because an origin can move. Two instances are
  two of everything; nothing is shared unless the owner asks. Existing auth
  needs no server change: passkeys are per-origin, enrolment codes are minted
  per instance, `apns-topic` is the bundle id and the instance is disambiguated
  in the payload.
- **A per-instance switcher, never a unified inbox** — a merged feed cannot say
  which half is stale, which the design system's "state is reported, never
  inferred" forbids. The presence chip reads "unreachable · 3 queued", never
  "offline".
- **Queue appends, never queue claims or answers.** `capture` and 👍/👎 queue
  in an outbox with a client-minted `Idempotency-Key`; **decision controls are
  disabled while the backend is unreachable** (owner's ruling), and task claims,
  dispatch and artifact replies are never queued — each is a statement about
  server state at delivery time.
- **No wake-the-laptop path is built.** A closed notebook does not wake for
  network; a tailnet only makes it addressable.

## Open questions (decide later, deliberately)

- App Store distribution vs TestFlight-first; FSL developer account setup.
- ~~Premium gating mechanism~~ — none; everything is free (2026-09-07).
  Distribution: iOS via TestFlight/App Store (Apple requires it); macOS
  via GitHub Releases with auto-update.
- SwiftUI codebase relationship to the Swift bridge toolchain (D3 made
  Swift a first-class language in the repo — the app extends that).
- Whether HealthKit data lands via `/capture` or a dedicated endpoint with
  `Me/`-grade protections (it is the most sensitive stream after comms).
