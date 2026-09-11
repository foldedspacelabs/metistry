# One phone, two instances; backends that are not always there (2026-09-11)

> Research note answering two owner questions about the native iOS app
> (`docs/product/ios-app-plan.md`, planning-only). Nothing here is on the
> build path; it records what the console API must *not* foreclose.

## Summary

- An **instance** on the phone is `(origin, instance_id)` plus everything
  keyed by that pair: display name, passkey credential, session cookie,
  push registration, local store, outbox. Two instances are two of
  everything; nothing is shared unless the owner asks.
- Existing auth already maps to N instances with **zero server change**:
  passkeys are per-origin by construction, enrolment codes are minted per
  instance, and a host-minted owner token is per instance. The only new
  surface is a small **unauthenticated `GET /api/identity`** for the picker.
- Recommend a **per-instance switcher, not a unified inbox** — the design
  system's P5 (state is reported, never inferred) and the ten-destination
  map make a merged feed a lie when one backend is asleep.
- Push: long-term the **FSL-run relay → APNs** path the ios-app-plan already
  chose, one device token registered *per instance*; web push remains the
  PWA's channel. `apns-topic` is the app's bundle id, so it is the same for
  every instance; the instance is disambiguated in the payload, not the topic.
- Offline: the answer to a sleeping laptop is **queueing, not waking**. Only
  `capture` and 👍/👎 are safe to queue. Decisions, task claims and
  dispatch are not, because their meaning depends on server state at the
  moment of the answer. The console needs an `Idempotency-Key` contract on
  `POST /capture` and a `since` cursor on the feed before any of this is
  built.

## Q1 — one phone, two instances

### The client's instance model

On the phone an instance is a record:

| field | source | notes |
| --- | --- | --- |
| `origin` | typed or scanned at enrolment | the HTTPS origin, what passkeys bind to (`METISTRY_ORIGIN`, `docs/ops/auth.md`) |
| `instance_id` | `GET /api/identity` | the v4 UUID `metistry init` writes into `identity.yaml` (`docs/ops/cli.md`) |
| `name`, `icon` | `GET /api/identity` | the assistant's name is config, never code (`CLAUDE.md`) — the phone shows "Metis" for one and whatever the work instance is called for the other |
| passkey | Keychain, rpID = origin's host | one credential per instance; native `ASAuthorization` against the same RP ID (ios-app-plan) |
| session | `metistry_session` cookie, per origin | the `auth_sessions` row is a *device* session on that instance |
| owner token | Keychain item `metistry:<instance_id>:owner_token` | for the share extension, same as the Shortcut today (`docs/ops/capture-shortcut.md`) |
| push registration | per instance | see below |
| store + outbox | SwiftData/SQLite file per `instance_id` | see Q2 |

`instance_id` is the key, not `origin`: an origin can move (`METISTRY_ORIGIN`
already accepts a list for exactly this) and the phone must recognise the
same instance after the move.

### How existing auth maps to N instances

Nothing about the door changes. Passkeys are scoped to an RP ID, so a
credential enrolled at `metis.tail.example` cannot be presented to
`work.example`; the console already rejects an origin it does not expect with
a 401 that names both sides. Enrolment codes are minted on the instance
(`enroll.mjs`), so enrolling the phone against the work instance is the same
ceremony run again against a second origin. Host-minted `owner_tokens` are
rows in that instance's Postgres and reach only `/capture`, `/message`,
`/api/status` and named queries (CRIT-7) — the right credential class for a
share extension, and a lost phone leaks capture ability on two instances, not
control of either.

The local owner token (`METISTRY_LOCAL_OWNER_TOKEN`) never applies: it is
accepted only from a loopback peer, and the phone is never that.

The one addition: **`GET /api/identity`**, unauthenticated, returning
`{instance_id, name, icon, version, as_of}`. It is public metadata (anything
that can load the login page already sees the name) and it lets the picker
render a display name before sign-in and detect "this origin is an instance
you already have". It mirrors `metistry identity --json`, which the Mac app
already reads.

### Switching UX: picker, not unified inbox

Recommend a **top-level instance switcher** (a segmented control or a
long-press on the tab bar's active tab, the platform's own control per the
design system's "use the platform's control" rule), with every destination
scoped to the selected instance. Not a unified inbox with instance chips.

Reasons, from `docs/product/design-system.md`:

- **P5 — state is reported, never inferred.** A merged Needs You list whose
  work half is three hours stale, because the laptop is asleep, presents one
  list with two truth levels. Per-instance views can show "last synced 14:02
  · instance unreachable" honestly at the top of *that* instance's screens.
- **The ten destinations are the same on every platform.** An eleventh
  concept ("all instances") that exists only on the phone breaks the rule
  that nothing exists on one platform without a home on the others.

Chips still appear, but as the **presence chip for the selected instance**
(reachable / queued · 3 / asleep), not as a per-row provenance badge.
The share extension's "capture to: Personal | Work" choice is the one
cross-instance control.

### Push with two backends

`ios-app-plan.md` already made the call: the PWA's web push stays the
fallback and the native app goes through an **FSL-run (or self-run) relay to
APNs** with payload-free wake-and-fetch pings. Multi-instance confirms it:

- **One APNs identity, N registrations.** The `apns-topic` header is "your
  app's bundle ID" ([Apple][apns-send]), owned by the developer, not the
  instance. So both instances push to the same topic and the same device
  token; the phone registers that token with *each* instance's console
  (`POST /api/push/subscribe`, which is already session-bound and so already
  per instance), and the relay's ping carries `instance_id` so the app knows
  which store to refresh.
- **Background pushes are not a delivery channel.** Apple: the system
  "doesn't guarantee their delivery", "may throttle" them, and says not to
  send "more than two or three per hour"; the app gets 30 seconds on receipt
  ([Apple][apns-bg]). Thin payloads plus fetch-on-open is the honest design,
  which is what the plan already says.
- **Web push on iOS** requires the PWA to be added to the Home Screen and is
  not available inside Safari ([WebKit][webkit-push]); two Home Screen PWAs
  at two origins is workable today but is two icons, not one app.

### Data isolation on the phone

One store file per `instance_id`; one Keychain access group with items
namespaced by `instance_id`; one outbox per instance. Search is scoped to the
selected instance; "search all instances" is an explicit action only — the
work vault is under a different employer's rules, and blending by default is
a data-handling decision the owner never made. Deleting an
instance from the phone deletes its store, Keychain items, and outbox, and
calls `POST /api/devices/<id>/revoke` on the way out if reachable.

## Q2 — backends that are not always there

### Waking the laptop: no

Be direct: a Mac notebook with the lid closed and no external display,
keyboard and power is asleep, and Apple's guidance for closed-lid use is that
the Mac must be "connected to power and using an external keyboard and mouse"
([Apple][closed-lid]). "Wake for network access" lets a Mac "wake briefly so
users can access shared services" ([Apple][sleep-wake]) — it is a Bonjour
Sleep Proxy feature for LAN peers, not something a phone on a different
tailnet can trigger, and on a closed, unplugged notebook it does not apply.
Tailscale keeps the node *addressable*; it does not make a sleeping host
answer. The answer is queueing.

### Reachability: three states, not two

`NWPathMonitor` reports whether a usable path exists and its interface
type/cost; it does not say whether a particular host is reachable
([Apple][nwpath]). So the client tracks three states per instance:

1. **no network** — path unsatisfied; do nothing, wait for the path.
2. **network, instance unreachable** — path satisfied, `GET /api/identity`
   times out or the tailnet returns "no route" — the laptop is asleep.
   Back off exponentially (30 s, 1 m, 2 m … cap 15 m), reset on foreground.
3. **reachable** — drain the outbox.

Presence chip: "unreachable · 3 queued", never "offline" when the phone
itself is fine.

### Which actions are safe to queue

Test per action: *does the meaning of the request depend on server state at
the time it is finally delivered?*

| action | endpoint | safe to queue? | why |
| --- | --- | --- | --- |
| capture | `POST /capture` | **yes** | append-only; the note is the same note an hour later. Needs an idempotency key (below). SHOULD-10's capture-never-drops is the whole point. |
| 👍/👎 on a reply | `POST/DELETE /api/messages/:id/feedback` | **yes** | idempotent upsert on `(outbound_message_id)`; last write wins is the intended semantics. |
| chat message | `POST /message` | **no, by default** | the reply is the point; a message delivered three hours late into a moved-on thread is confusing. Offer "send when reachable" as an explicit choice, off by default. |
| decision / proposal answer | `POST /api/proposals/:id` | **no** | the server refuses any row not `pending`; a queued answer may land on a decided, expired, or superseded proposal. Show the queued answer as "pending · will apply if still open" only if the owner insists; default is to disable the controls when unreachable. |
| task claim / release | `tasks_claim` (lease, `SKIP LOCKED`, `docs/ops/crews.md`) | **no** | a claim is a lease against *now*; there is no meaning to a claim taken at 09:00 and delivered at 12:00. Never queue. |
| dispatch to a target | `POST /api/tasks/:id/dispatch` | **no** | outbound side effect with a data-policy check at dispatch time. |
| artifact review reply / resolve | artifact routes | **no** | compare-and-swap on the current version; a stale reply is a `409` by design. |

The rule is short: **queue appends, never queue claims or answers.**

### The outbox

Per instance, SQLite (or SwiftData over it), one table:
`(id, instance_id, kind, idempotency_key, payload, attachment_path,
created_at, attempts, next_attempt_at, last_error)`. FIFO per instance;
a failure holds the head (ordering matters for capture: two notes about
the same thing should arrive in the order written). Idempotency key is a
UUID minted at enqueue, stored *before* the first attempt, never
regenerated on retry.

Delivery windows on iOS are the real constraint:

- **Foreground / just-backgrounded**: `beginBackgroundTask` gives a finite
  budget and "if you don't call `endBackgroundTask` … the system kills the
  app" ([Apple][bgtask]). Enough to flush a few captures, not a reliable
  drain.
- **`BGAppRefreshTask`**: "the system decides the best time to launch" and
  grants "up to 30 seconds" ([Apple][bg-strategies]).
  `earliestBeginDate` means "it won't begin sooner"; "the system doesn't
  guarantee launching the task at the specified date" ([Apple][earliest]).
- **`BGProcessingTask`**: "can take minutes", with `requiresExternalPower`
  and `requiresNetworkConnectivity` as hints ([Apple][bgproc]) — typically
  overnight on the charger.
- **Background pushes** to trigger a drain: unreliable and rate-limited as
  above ([Apple][apns-bg]).
- **Background `URLSession`** is what Apple recommends for uploads that take
  time ([Apple][bg-strategies]); use it for capture attachments so an upload
  survives suspension.

Net: **no guaranteed wake**. The client drains opportunistically and the UI
says "queued", not "sending".

### Reconciliation when the backend returns

Server side, three things:

1. **`Idempotency-Key` on `POST /capture`** (and accepted on
   `/api/messages/:id/feedback`). Semantics: scoped to the presenting
   credential, retained ≥ 7 days, a replay returns the *original* response
   (same status, same `id`) — never a second row. `packages/artifacts`
   already does this for publish (`(author_principal, idempotency_key)`
   lookup, `409` on a stale CAS); `agents_delegate` and session import carry
   `idempotency_key` too. Capture should inherit the same contract rather
   than invent one: a `captures(principal, idempotency_key)` unique index and
   the stored response.
2. **`409` for state conflicts, `200` for replays.** A queued feedback that
   arrives after the message was deleted is `404`; a decision on a decided
   proposal is `409 already_decided` with the winning decision in the body,
   so the client can show what actually happened rather than "failed".
3. **A `since` cursor on the feed** — `GET /api/messages?since=<id>` and the
   same on proposals and `runs` — so a reconnect after hours is one bounded
   request per list, not a full repaint. The existing polled lists have no
   cursor; this is the cheapest server addition and it also helps the PWA.

Client side: on reachability, drain the outbox head-first, then pull each
list with its cursor, then repaint (a repaint, not a navigation). While
unreachable each queued row carries a "queued" badge, and editing a queued
capture edits the outbox row in place — nothing has been sent.

### Genuinely hard conflicts

- **A decision answered from two devices.** The server holds the truth: the
  first `POST /api/proposals/:id` to arrive wins, the second gets `409` with
  the winner. Which is "first" is delivery order, not wall-clock order — a
  phone answer queued at 09:00 loses to a Mac answer at 11:00. This is why
  decisions are not queued by default; if they ever are, the row must record
  `answered_at_client` so the loss is at least visible in the receipt.
- **A capture edited before it was ever sent.** Easy in the outbox (edit in
  place); hard if the *first* attempt actually reached the server but the
  response was lost. The idempotency key resolves it: the retry returns the
  original row's `id`, and the client then issues a normal edit against that
  `id`. Without the key this is a duplicate every time.
- **Token revoked while queued.** Drain gets `401`; the queue must *hold*,
  not drop — a revoked share-extension token is a re-enrol prompt, and the
  captures are still the owner's.

## Recommendations

1. **Model an instance on the phone as `(origin, instance_id)` with
   everything else keyed by `instance_id`**, and add an unauthenticated
   `GET /api/identity` to the console — because the origin can move and the
   picker needs a name before sign-in.
2. **Ship a per-instance switcher with an honest presence chip, not a
   unified inbox** — because P5 forbids presenting a stale backend's rows as
   current, and a merged list cannot say which half is stale.
3. **Define the `Idempotency-Key` contract on `POST /capture` and add `since`
   cursors to the polled lists now, before the app exists** — because they
   are the only server changes the offline design needs, they are small, and
   the PWA benefits today.
4. **Queue appends (capture, feedback) and never queue claims, decisions or
   dispatch** — because a lease or a decision is a statement about server
   state at delivery time, and the phone cannot know it.
5. **Do not build any wake-the-laptop path** — because a closed notebook does
   not wake for network and the tailnet only makes it addressable.

## Open questions

- Should a decision ever be queueable behind an explicit "answer when
  reachable" toggle, with `409` shown as the receipt when it loses — or is
  disabling the controls while unreachable the whole answer? (The owner's
  call; the honest default is to disable.)
- Whether `/api/identity` should be unauthenticated at all, given invariant
  8, or whether the picker can live with the name arriving after passkey
  sign-in.

## Sources

- [apns-send]: Apple, *Sending notification requests to APNs* —
  <https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns>
- [apns-bg]: Apple, *Pushing background updates to your app* —
  <https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app>
- [webkit-push]: WebKit, *Web Push for Web Apps on iOS and iPadOS* —
  <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
- [nwpath]: Apple, *NWPathMonitor* —
  <https://developer.apple.com/documentation/network/nwpathmonitor>
- [bg-strategies]: Apple, *Choosing background strategies for your app* —
  <https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app>
- [earliest]: Apple, *BGTaskRequest.earliestBeginDate* —
  <https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate>
- [bgproc]: Apple, *BGProcessingTaskRequest* —
  <https://developer.apple.com/documentation/backgroundtasks/bgprocessingtaskrequest>
- [bgtask]: Apple, *beginBackgroundTask(withName:expirationHandler:)* —
  <https://developer.apple.com/documentation/uikit/uiapplication/beginbackgroundtask(withname:expirationhandler:)>
- [closed-lid]: Apple, *Connect displays to your Mac* (closed-lid requirements) —
  <https://support.apple.com/en-us/102555>
- [sleep-wake]: Apple, *Set sleep and wake settings for your Mac* —
  <https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac>
- Repo: `docs/product/ios-app-plan.md`, `docs/product/desktop-app-plan.md`,
  `docs/product/design-system.md`, `docs/ops/auth.md`,
  `docs/ops/capture-shortcut.md`, `docs/ops/crews.md`,
  `docs/ops/reconciler.md`, `packages/artifacts/src/service.ts`,
  `apps/console/src/server.ts` (route list).
