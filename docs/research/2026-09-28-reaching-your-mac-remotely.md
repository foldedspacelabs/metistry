# Reaching your Mac from your phone — the options, and an opt-in rendezvous relay (2026-09-28)

Research for `docs/product/design-build-plan.md`, *Remote access for the
phone*, which marks the website's step 1 (*Let your phone reach your Mac*)
BEING DESIGNED and names this file. The problem: an instance runs on the
owner's Mac behind home NAT, and the console binds `127.0.0.1:8080`
(`docs/ops/deployment-shapes.md`). The console PWA on the owner's phone has
to reach it from outside the house.

The owner's constraints, as given on 2026-09-28:

- Owners can already use Tailscale, router port forwarding, or a commercial
  tunnel. Document all of them.
- Folded Space Labs (FSL) would also like to offer an **opt-in** relay that
  any owner can turn on.
- Metistry is free, so the relay has to cost close to nothing to run: *"just
  make the connection for them, don't pay for the bandwidth."* Serverless, or
  close to serverless cost, is best.
- It stays **default-deny**.

Nothing here is built. This commit adds this one document and no product
code. Vendor facts come from vendor docs fetched on **2026-09-28** (see
Sources). Repo facts cite `file` at `00762c89`. Where a number is my
estimate rather than a published figure, the text says so.

## The short version

1. **Tailscale is the path to support and document now.** PoC-6 proved it end
   to end on 2026-08-27: `tailscale serve`, a Let's Encrypt certificate for
   `*.ts.net`, the Home Screen PWA, and web push. It costs $0. Content is end
   to end (WireGuard, with TLS on the Mac), and nothing on the Mac is open to
   the internet. The other options are documented as alternatives, each with
   its catch: port forwarding fails behind carrier-grade NAT (CGNAT) and
   exposes the console's unauthenticated surface; Cloudflare Tunnel and ngrok
   HTTPS endpoints decrypt at the vendor's edge; IPv6-direct is fragile.
2. **An FSL relay can meet the constraints if it only does rendezvous.** The
   phone and the Mac open a **WebRTC data channel** directly. FSL runs only the
   signalling, over WebSockets on **Cloudflare Workers + Durable Objects with
   hibernation**, plus a static shell at `<site>.metistry.app`. My estimate
   for that is about **$0/month at 100 owners** (free plan) and **about
   $6–16/month at 10,000 owners**. The AWS version (API Gateway WebSocket +
   Lambda + DynamoDB) comes to about **$345/month at 10,000**, because it bills
   every minute the Mac is connected.
3. **Signalling alone doesn't always connect.** Published direct-connection
   rates are about 70% for a large libp2p study, and 10–25% of WebRTC sessions
   need a relay by industry rules of thumb. Mobile carriers are the worst case:
   over 90% of cellular networks ran CGNAT in 2016. With no TURN server, some
   phone-on-cellular sessions **will fail**. v1 should refuse clearly and
   offer bring-your-own TURN. FSL-paid TURN stays a later option, with numbers
   (§4.4).
4. **The real cost is trust, not money.** With a data channel, the page's
   JavaScript comes from `metistry.app`, which FSL controls, so FSL enters the
   owner's trusted computing base. The relay itself can be made unable to read
   or tamper with traffic: signalling payloads encrypted end to end, and
   passkey challenges bound to the DTLS fingerprints. The code supplier can't
   be removed that way. It can only be shrunk to a small, versioned bootloader
   (§3.2). Tailscale doesn't carry this cost, which is one reason it stays the
   recommended path.
5. **Two existing gaps turned up and need fixes whichever path wins** (§1.5).
   (a) Every same-host proxy (`tailscale serve`, `cloudflared`, the ngrok
   agent, Caddy) connects from `127.0.0.1`. That makes the loopback-only
   `METISTRY_LOCAL_OWNER_TOKEN` replayable through the proxy, which
   `docs/ops/auth.md` says can't happen. (b) A multi-entry `METISTRY_ORIGIN`
   shares one rpID taken from the first entry, so a second origin on a
   different host can't complete a passkey ceremony.

## 1. What owners can use today

### 1.1 Tailscale — the supported path

**Setup.** Install Tailscale on the Mac and the iPhone, and sign in to the
same tailnet. In the admin console, enable MagicDNS and HTTPS certificates.
Then run `tailscale serve --bg 8080` on the Mac and set
`METISTRY_ORIGIN=https://<mac>.<tailnet>.ts.net`. Serve provisions and renews
the certificate itself. Tailscale runs Let's Encrypt DNS-01 against a `ts.net`
TXT record, so no port is opened.

- **Cost.** The Personal plan is "$0 Free forever", with up to 6 users and
  unlimited user devices (pricing page, checked 2026-09-28).
- **Security posture.** WireGuard runs end to end between devices. When a
  direct path fails, Tailscale's DERP relays carry the encrypted packets, and
  Tailscale pays for that bandwidth. The console is reachable only from
  devices on the tailnet.
- **Catches.**
  - The phone needs the Tailscale app, which is an iOS VPN, and iOS runs one
    VPN at a time. That's awkward alongside a work VPN.
  - Enabling HTTPS publishes machine names to Certificate Transparency.
    Tailscale's own warning: "Do not enable the HTTPS feature if any of your
    machine names contain sensitive information."
  - PoC-6 hit the admin-console enablement step as a blocker, so the guide
    has to walk through it (`docs/poc/RESULTS.md`).
- **Passkeys and origin.** The origin is a stable HTTPS host, so the rpID is
  `<mac>.<tailnet>.ts.net`. Nothing changes in the console.
- **Funnel is not needed for the phone.** Funnel publishes the node to the
  whole internet through Tailscale relays. TLS still ends on the Mac:
  "Funnel relay servers do not decrypt the traffic". Ports are limited to
  443, 8443 and 10000, bandwidth is capped at an unpublished level, and
  Tailscale's docs say it is "available for all plans". Use it only for a
  client that can't join the tailnet (for example cloud Devin as an MCP
  client, `plan-refresh` §5). For the phone it adds internet exposure and no
  benefit.

### 1.2 Router port forwarding

**Setup.**

1. Forward TCP 443 (and 80, for an HTTP-01 challenge) on the router to the Mac.
2. Run a TLS-terminating reverse proxy on the Mac, such as Caddy, in front of
   `127.0.0.1:8080`.
3. Point a hostname at the home IP with dynamic DNS.
4. Get a certificate over ACME:
   - HTTP-01 "can only be done on port 80".
   - TLS-ALPN-01 uses 443.
   - DNS-01 needs no inbound port, but needs a DNS provider with an API.
5. Set `METISTRY_ORIGIN=https://metis.example.com`.

**Cost.** A domain, roughly $10–20/year. Free DDNS services exist.

**It often can't work at all.** T-Mobile Home Internet, Verizon 5G Home and
standard Starlink put IPv4 behind CGNAT, and "there is no public address for a
forwarded port to reach". AT&T Fiber, Xfinity and most cable ISPs usually give
a public IPv4.

**Security posture.** This is the weakest option.

- The console's unauthenticated surface faces every internet scanner. That
  surface is the login ceremony, `GET /api/identity`, `/health` and the static
  shell. Invariant 8 was written for this ("every request authenticates as if
  internet-exposed"), but it still means real exposure, plus the home IP in
  public DNS.
- The proxy, the certificate and the router config are three more things for
  the owner to maintain.

Document it with those warnings. Don't recommend it.

### 1.3 Commercial tunnels

| | How | Cost (checked 2026-09-28) | Who sees plaintext |
| --- | --- | --- | --- |
| **Cloudflare Tunnel** | `cloudflared` on the Mac dials out; a hostname on a Cloudflare-managed domain routes to it | free, unmetered; Zero Trust Access free up to 50 users | **Cloudflare.** TLS terminates at the edge; cookies, passkey assertions and bodies are plaintext there |
| **ngrok** | agent dials out; `https://…ngrok-free.app` or a custom domain | free: 1 GB/month, 20k requests, **an interstitial page on browser traffic**; Hobbyist $10/month removes it | **ngrok** for HTTPS endpoints ("All HTTPS endpoints terminate TLS at ngrok's cloud service"); a `tls://` endpoint with agent-side termination is end to end |
| **Tailscale Funnel** | §1.1 | free | **nobody** — TLS on the Mac |

- **Passkeys and origin.** The public hostname becomes `METISTRY_ORIGIN`.
  That works if it is stable: a reserved or custom domain, never a random
  free URL, or every enrolled passkey breaks when the URL changes.
- **ngrok free tier.** The interstitial page gets in the way of a Home Screen
  PWA's first load and of fetches without the skip header. Treat the free
  tier as unsuitable.
- **Other options.** Self-hosted frp, or a small VPS running Caddy and
  WireGuard, are equivalent in shape. The owner pays for the VPS and holds
  the keys.

### 1.4 IPv6 direct

About half of Google's users, and about 50% in the US, reach it over IPv6
(APNIC, April 2026). Mobile carriers are often IPv6-first. In principle the
phone can reach the Mac's global IPv6 address with no NAT in between. In
practice, four things get in the way:

- the console binds `127.0.0.1`, so a proxy is still needed;
- home gateways drop unsolicited inbound IPv6 by default, and some ISP
  gateways won't open it;
- privacy addresses and prefix changes rotate the address, so AAAA dynamic
  DNS is needed;
- a phone on IPv4-only Wi-Fi can't reach it at all.

TLS is the same as for port forwarding. Document it as an expert option only.

### 1.5 Two gaps these paths expose (report, not route around)

**(a) Same-host proxies defeat the local-owner-token loopback rule.**
`apps/console/src/local-owner.ts` accepts `METISTRY_LOCAL_OWNER_TOKEN` when
the socket peer is loopback, and `docs/ops/auth.md` promises that a token
that "*leaks* … still cannot be replayed from off the machine". But
`tailscale serve` "proxies requests to a web server running at
`http://127.0.0.1:3000`". `cloudflared`, the ngrok agent and a local Caddy do
the same. Every request those proxies forward arrives with a loopback peer.
Behind Serve, a leaked token works from any tailnet device. Behind Funnel,
Cloudflare Tunnel, ngrok or port forwarding plus Caddy, it works from the
internet, and that includes the `local` routes that mint agent bearers.

Passkey sessions aren't affected. The fix I'd propose: a second console
listener meant for proxies, where the local owner token is never honoured.
Either a separate port, or a Unix socket, whose empty `remoteAddress` already
fails closed in `peerAddressOf`. The phone guide would point every proxy at
that listener. This is a finding against `auth.md`, so it goes to the owner
rather than into a quiet patch.

**(b) A multi-origin `METISTRY_ORIGIN` has one rpID.** `rpFromOrigin` in
`apps/console/src/webauthn.ts` takes the rpID from the first entry only.
`auth.md`'s example pair, "a tailnet name and a public hostname", can't both
work: a browser at `metis.example.com` refuses an rpID of
`mac.tailnet.ts.net`. `@simplewebauthn/server` v13 already accepts
`expectedRPID` as an array (checked in the installed 13.3.3 typings). The
change is to choose the rpID per request origin when generating options, and
to verify against the list. The relay in §2 needs this in any case, because
its origin is a new host.

## 2. The opt-in FSL relay: rendezvous only

### 2.1 Shape

```
 iPhone PWA  ──wss──►  <site>.metistry.app  ◄──wss──  Mac (console)
 (shell from FSL)      Worker + Durable Object        dials out when the
                       (signalling only)              owner turns relay on
       ╲                                                ╱
        ╲═════ WebRTC data channel (DTLS, UDP, P2P) ═══╱
                 all API traffic; FSL sees none of it
```

1. **The Mac dials out.** With the relay on (`metistry remote relay on`, off
   by default), the console holds one WebSocket to its site's Durable Object.
   With the relay off, nothing connects.
2. **The phone loads the shell.** The PWA is installed from
   `https://<site>.metistry.app`: static files served by the same Worker.
   Workers' "requests to static assets are free and unlimited". A single
   wildcard DNS record and Universal SSL's first-level wildcard certificate
   cover every site, so there are **no per-owner DNS records or
   certificates**, and nothing per owner appears in Certificate Transparency
   logs.
3. **They connect.** The phone opens `wss://<site>.metistry.app/_signal`. The
   two peers exchange an offer, an answer and ICE candidates through the
   Durable Object, using public STUN (`stun.cloudflare.com:3478`, free). The
   data channel then connects directly. The relay's part ends there; the
   phone closes its WebSocket.

**Site identity.** The site is self-certifying: `site` is the base32 form of
128 bits of `SHA-256(site public key)`. The key is an Ed25519 key the Mac
generates and keeps in the Keychain.

- No sign-up and no FSL account. The Durable Object learns the public key on
  the Mac's first connection and verifies it against the id.
- The id is unguessable, and it is **not** `instance_id`, which
  `GET /api/identity` publishes to anyone.

### 2.2 Serverless signalling options

| | Cloudflare Workers + Durable Objects | AWS API Gateway WebSocket + Lambda + DynamoDB |
| --- | --- | --- |
| Always-on Mac socket | hibernating WebSocket: "Billable Duration (GB-s) charges do not accrue during hibernation"; ping/pong "does not interrupt hibernation" | billed per connection-minute ($0.25/M); **2-hour maximum connection, 10-minute idle timeout**, so the Mac reconnects and sends keepalives forever |
| Messages | incoming WebSocket messages billed at 20:1 as requests ($0.15/M over 1M included) | $1.00/M, metered in 32 KB units, sent and received |
| Per-site state | one Durable Object per site; SQLite rows for the site key and device keys | a DynamoDB table mapping site to connection ids ($0.625/M writes, $0.125/M reads) |
| Static shell | Workers static assets, free | S3 + CloudFront, separately priced |
| Operational catch | a code deploy "disconnects all WebSockets", so every Mac reconnects | Lambda on every routed message; cold starts on connect |

Cloudflare wins on shape. The dominant cost, "a Mac waiting to be called",
is nearly free while the socket hibernates. On AWS the same thing is metered
by the minute.

### 2.3 Will hole punching work? Data, and the honest answer

- **Tailscale, native code with every trick** (port mapping, and "birthday"
  probing across 256 ports): "over 90%" direct from basic techniques.
  Symmetric NAT is the hard case.
- **libp2p DCUtR, 4.4 M attempts across 85,000+ networks** (IMC 2026):
  **70% ± 7.1%** conditional success.
- **WebRTC rules of thumb** (BlogGeek, ExpressTURN): **10–25%** of sessions
  need TURN, and mobile networks are the most common offenders.
- **Cellular:** in 2016, "more than 90% of cellular networks" deployed CGNAT
  (Richter et al., IMC 2016). Many of those CGNATs use endpoint-dependent
  (symmetric) mapping.

**The pair that matters is phone-on-cellular to Mac-at-home.**

- If the phone is behind symmetric NAT and the home router filters by
  address and port (typical of Linux-based routers), both sides guess wrong
  ports and the punch fails.
- The browser side can't do Tailscale's multi-port birthday trick.
- The Mac side *can* help. It is native code, so it can ask the router for a
  port mapping (NAT-PMP, PCP or UPnP-IGD, which Tailscale also uses) and
  advertise a reachable candidate. With that, a symmetric-NAT phone connects.
- IPv6 on both ends helps too: no port translation, only a stateful firewall,
  which simultaneous open usually passes.
- Safari hides host candidates behind mDNS or drops them without a
  `getUserMedia` grant. That matters only on the LAN, and there the Mac's own
  host candidate carries the connection.

**Conclusion.** The rate for this specific pair is unknown and must be
measured (PoC R1). Plan for **somewhere between 70% and 95% direct**,
depending on carrier and router, and design the failure case properly.

### 2.4 When punching fails

| Option | FSL cost | Verdict |
| --- | --- | --- |
| **Refuse clearly** | $0 | v1 default. The PWA says what happened: "Your phone's network won't let it connect straight to your Mac. It will work on Wi-Fi, over Tailscale, or with a TURN server you add." |
| **Bring-your-own TURN** | $0 | v1. The owner pastes a TURN URL and credential into Settings. Cloudflare Realtime TURN on the owner's own account is **$0.05/GB, first 1,000 GB each month free** (shared with the SFU), so it's effectively free for one person. coturn on a VPS also works. TURN relays only DTLS-encrypted bytes. |
| **FSL-paid TURN** (Cloudflare) | my estimate: at 20% relayed and 2 MB per session, 10,000 owners is about 2.4 TB/month, so about $70 after the free 1,000 GB. Attachments make it unbounded. | Not v1: it breaks "don't pay for the bandwidth", and TURN credentials can be lifted and reused as a general relay. Revisit with PoC data and a per-site cap. |

### 2.5 The contrast: a TLS-passthrough SNI relay

FSL could run a TCP proxy that routes by SNI to a tunnel each Mac holds open.
The Mac would terminate TLS for `<site>.metistry.app` itself, with a
certificate from ACME DNS-01 through an FSL DNS API.

- **What it gets right.** Everything the data-channel design struggles with:
  it always connects, it is a normal HTTPS origin, the **Mac serves its own
  shell** (no FSL JavaScript), and cookies and passkeys work unchanged.
- **What it costs.** Every byte crosses FSL. It needs long-lived TCP, which
  means servers rather than Lambda. At 1 GB per owner per month, 10,000 owners
  is 10 TB of egress, about $900/month at AWS's $0.09/GB before compute (my
  estimate). It also puts per-owner names in Certificate Transparency logs.

It is Tailscale Funnel rebuilt at FSL's expense. It fails the cost
constraint, and owners who want this shape can use Funnel.

### 2.6 iOS: data channels and background behaviour

- RTCDataChannel is supported in iOS Safari from 11 onward (caniuse), and
  WebRTC reached WKWebView in iOS 14.3.
- Older reports of WebRTC breaking in *standalone* Home Screen mode were
  about `getUserMedia`, which a data channel doesn't need. It still has to be
  **verified on a current iOS in standalone mode** (PoC R1).
- **Backgrounding kills it.** iOS suspends a backgrounded web app and its
  sockets soon after the screen locks. Every return to the foreground means
  a new rendezvous: one signalling round trip, ICE and DTLS, my guess 1–3 s,
  to be measured.
- This fits `2026-09-11-multi-instance-and-offline-client.md` as written:
  three reachability states, an outbox for appends, and a `since` cursor on
  reconnect.
- The Home Screen app's storage has "their own counter of days of use". It
  isn't evicted after 7 days the way Safari tab storage can be, so a
  persisted device key survives.

## 3. Architectural consequences

### 3.1 Where the shell comes from

The data channel only exists once JavaScript is running, and that JavaScript
has to come from an HTTPS origin. The console can't serve it, because the
console isn't reachable yet. So `<site>.metistry.app` serves the shell. The
PWA's origin is therefore FSL's, not the owner's. That's new: every path in
§1 has the Mac, or a proxy on it, serving its own code.

### 3.2 Trust: FSL now supplies code

**What changes.** Whoever controls the `metistry.app` Worker, DNS or
Cloudflare account can ship JavaScript that runs with the owner's session,
and can read or change anything the PWA can. HTTPS "does not prove that the
code the site serves matches what its developers published" (WEBCAT).

Mitigations, strongest last:

1. **Open-source, reproducible builds of the shell.** The build output is
   published with each release, so anyone can compare hashes. This detects
   tampering. It doesn't prevent it.
2. **Versioned, immutable paths.** `/v/<version>/…` never changes once
   published, and a site only loads the version its own Mac reports. This
   also solves **version skew**: owners update at their own pace, so one
   "current" shell can't match every console.
3. **A thin bootloader with hashes that come from the Mac.** The only mutable
   file is a small bootloader (a few hundred lines) and its service worker.
   Once the channel is up, it asks the Mac for the version and the SRI hashes
   of that version's assets. The Mac ships those same files, so it knows the
   hashes. The bootloader then loads `/v/<version>/app.js` with
   `integrity=<hash from the Mac>`. It could instead take the bundle bytes
   over the channel and run them from a `blob:` URL, at the cost of a looser
   CSP.

   After this, FSL can't swap the application code without the Mac's
   hashes disagreeing. **The bootloader stays FSL-trusted.** No web-platform
   mechanism on iOS pins it: a service worker can't refuse its own update,
   and WEBCAT is a Firefox-extension alpha. Meta's Code Verify is similar.

Say it plainly in the product: *with the relay on, you trust FSL's
bootloader; with Tailscale, you don't.* That's an honest reason for Tailscale
to stay the recommendation.

### 3.3 Passkeys and rpID

Use one rpID per site, `<site>.metistry.app` (the full host), so each owner's
passkeys are scoped to their own site.

- This needs fix §1.5(b): the console accepts `https://<site>.metistry.app`
  as an origin with its own rpID, next to any tailnet origin.
- Enrolment runs the existing Add a Phone flow (§2.22 of the design-build
  plan) against the relay origin. Add a Phone's refusal table needs a
  *relay on* case: the origin is not loopback, and reachability is proved by
  the Mac's live signalling socket, not by `GET <origin>/health`.
- **Recommended: add `metistry.app` to the Public Suffix List** (private
  section, like `github.io`). Sites then can't share cookies or claim
  `metistry.app` as an rpID. The apex only redirects, so nothing is lost.
  Inclusion is slow and hard to undo, so decide early.

### 3.4 Keeping the relay out of the channel

A signalling server can swap DTLS fingerprints and sit in the middle.
RFC 8827 §9.1 names this attack, and §6.5 names out-of-band fingerprint
verification as a mitigation. Two measures:

- **End-to-end-encrypted signalling payloads.** The key comes from pairing,
  delivered in the enrolment QR's URL fragment, which is never sent to a
  server. The Durable Object routes opaque blobs and never sees SDP, ICE
  candidates or LAN addresses.
- **Channel-bound passkey login.** The Mac sends a nonce over the channel.
  The PWA calls `navigator.credentials.get` with
  `challenge = H(nonce ‖ phone_fp ‖ mac_fp)`, using the fingerprints it
  negotiated. The Mac verifies against the fingerprints *it* negotiated
  (`expectedChallenge` may be a function in `@simplewebauthn/server`
  13.3.3). If anything terminated DTLS in the middle, the two views differ
  and login fails. The attacker can't forge the assertion.

**The session is bound to the phone's DTLS certificate.** An `RTCCertificate`
generated once and kept in IndexedDB has a non-extractable key. The Mac binds
the session row to its fingerprint, so there is no bearer in JavaScript to
steal, which comes close to what an `HttpOnly` cookie gives today.
Reconnecting with the same certificate resumes the session without Face ID.
Whether Safari persists an `RTCCertificate` in a standalone PWA is unverified
(PoC R2). If it doesn't, the fallback is Face ID on every reconnect.

### 3.5 Mapping the HTTP API onto a data channel

**Transport.** The shell's API client gets a second transport behind the
same interface:

- **One reliable, ordered channel for request/response.** Frames carry
  `{id, method, path, headers, body}`, and the response is chunked.
- **A second channel for `GET /api/events`**, so the live stream isn't held
  up behind a large upload.
- **Messages at 64 KB or smaller.** 64 KB is the default when SDP doesn't
  negotiate `max-message-size` (MDN). Uploads use `bufferedAmountLowThreshold`
  for backpressure.
- **No service worker involvement.** Service workers have no WebRTC, so the
  transport lives in the page.

**The console terminates the channel itself**, in-process, as a transport
and not as a forwarder to `127.0.0.1:8080`. Otherwise every relayed request
would look loopback, which is gap §1.5(a) again. Channel requests:

- carry no cookies and are authenticated by the bound session;
- are never `local` reach, so the local owner token never applies;
- carry the site origin for any origin check.

**Container limit.** WebRTC needs a new dependency: `node-datachannel`
(libdatachannel) or the pure-TypeScript `werift`. CLAUDE.md says to ask
first. Under `shape: compose`, UDP from a container adds Docker's NAT layer.
**Support the relay on the launchd shape only**, at least at first.

### 3.6 Push notifications

**Web push needs no FSL relay.** The console already sends outbound to the
browser push service: PoC-6 got `201` from `web.push.apple.com`. The payload
is encrypted to the subscription's keys, so Apple can't read it. A PWA at
`<site>.metistry.app` subscribes with the Mac's VAPID key, fetched over the
channel, and the Mac pushes directly.

Tapping a notification opens the PWA and starts a new rendezvous. The
payload-free APNs relay in `docs/product/ios-app-plan.md` is still only for
the future native app.

## 4. What the relay sees, how it stays default-deny, what it costs

### 4.1 What it can see

**Visible (metadata):**

- the site id;
- the public IP of the Mac and of the phone (they are WebSocket peers);
- connect and disconnect times, session counts, message sizes and timing;
- user agents;
- the fact that a given IP loaded a given site's shell.

**Not visible:** API traffic, SDP, ICE candidates (so not LAN addresses),
passkey assertions, and anything else in the vault.

Cloudflare, as the processor, sees the same metadata. Relay logs should be
aggregate only and short-lived (proposed: 24 hours). The published privacy
policy (`docs/product/website/privacy-policy.md`) has to cover all of this
before launch.

### 4.2 Default-deny, layer by layer

1. **Opt-in per instance.** It is off by default, turned on from the Mac, and
   with it off there is no socket at all.
2. **Signalling needs pairing first, so strangers never reach the Mac's
   candidates.** The Durable Object forwards a phone's message only if the
   phone presents an **admission** the Mac vouched for:
   - a short-lived ticket signed by the site key, carried in the enrolment QR;
   - after enrolment, a passkey assertion the Durable Object checks against
     credential public keys the Mac registered;
   - after that, a Mac-signed token renewed over the channel and kept in the
     PWA's own storage (a Home Screen app doesn't share Safari's storage, so
     the passkey step covers its first launch).

   Revoking a device on the Mac removes its keys from the Durable Object.
3. **The Mac checks again.** It answers an offer only after its own
   admission check, and the passkey login inside the channel is the console's
   ordinary door. Invariant 8 holds end to end.
4. **No enumeration.** A 128-bit site id, one byte-identical refusal for
   "unknown site", "Mac offline" and "bad admission", and no listing
   endpoint.
5. **Rate limits.** Per IP on connect, and per site on session starts
   (proposed 10/min). SDP-sized frames only (under 16 KB). A daily per-site
   message cap (proposed 2,000).

Compared with §1.2–§1.4, the Mac here has **no inbound surface at all**: not
even the login page is reachable by a stranger. It is more default-deny than
Funnel or port forwarding.

### 4.3 Abuse

- **Bandwidth.** There's no bandwidth to abuse: no TURN, and a message-size
  cap.
- **A free signalling service for other apps.** Possible: anyone can mint a
  site key. The per-site caps bound the cost to cents.
- **Phishing.** Low value. `<site>.metistry.app` serves only FSL's shell, so
  there's no owner-controlled content. The worst case is someone pointing a
  victim at an attacker's own Mac.
- **Takedown.** Revoke by site id at the Worker.

### 4.4 Cost model (my estimates, prices checked 2026-09-28)

**Assumptions, per owner per month:**

- the Mac is connected 24/7;
- 20 PWA opens a day, 600 sessions a month;
- about 12 signalling messages per session;
- about 60 Mac reconnects (deploys, network changes).

**Cloudflare**, per owner:

- about 1,020 Durable Object requests (660 connects + 360 message-equivalents
  at 20:1);
- about 660 Worker requests;
- about 12 GB-s of duration (awake only while handling a message).

| | 100 owners | 10,000 owners |
| --- | --- | --- |
| **Cloudflare** (Workers + DO + static) | fits the **Free** plan (100k DO requests a day; about 3.4k used). **$0**, or $5 on Paid for headroom | $5 Paid + about $1.40 in DO requests (10.2 M against 1 M included) + $0 duration (120k GB-s of 400k) = **about $6.40**. Even at 10× the duration, **about $16** |
| **AWS** (API GW + Lambda + DDB) | about $3.50 | connection minutes $108 + keepalives $48 + session messages $144 + Lambda/DDB about $45 = **about $345** |
| FSL-paid TURN (not proposed) | about $0 (under 1,000 GB) | about $70+, unbounded with attachments |

**Recommendation: Cloudflare.** The one thing Cloudflare is structurally
worse at is that deploys drop every socket, and the Mac just reconnects
(with jitter).

## 5. Recommendation

### 5.1 Document now

- **The phone guide** (`docs/ops/phone.md`, X-79) covers four paths.
  - **Tailscale Serve** is the recommended path: steps, the admin-console
    enablement PoC-6 tripped on, the Certificate Transparency note, and
    `METISTRY_ORIGIN`.
  - **Cloudflare Tunnel** and **port forwarding** are alternatives, each
    with its row from §1.3 or its warning from §1.2 stated plainly.
  - **IPv6** and **ngrok** get a paragraph each.
  - **Funnel** is explicitly not needed for the phone.
- **Fix §1.5(a) before the guide ships.** It tells owners to put a proxy in
  front of the console, and that proxy makes the local owner token remote.
- **Fix §1.5(b)** with per-origin rpIDs.

### 5.2 Relay, in phases

**Phase R0 — PoCs. No product code, and no ticket until the owner accepts
this research.**

- **R1: an iOS Home Screen PWA to a Mac, over a data channel, with serverless
  signalling.** A throwaway Worker + Durable Object and a Node peer on the
  Mac.
  - Networks to cover: home Wi-Fi on the same LAN; cellular on at least
    T-Mobile, Verizon and AT&T; with and without IPv6; with and without a
    NAT-PMP/UPnP mapping on the Mac's router.
  - Record: success rate, the selected candidate-pair types, time to first
    byte, and reconnect time after lock and unlock.
  - Confirm that standalone mode works on current iOS.
  - **Gate: at least 85% direct on cellular** with port mapping available.
    Below that, the refusal case is too common to ship without FSL TURN, and
    the owner decides.
- **R2: RTCCertificate persistence and a channel-bound passkey in a
  standalone PWA** (§3.4).
- **R3: cost.** One Mac connected to a hibernating Durable Object for 7 days,
  then read Cloudflare's billed usage against §4.4.
- **R4: web push** from a `<site>.metistry.app` PWA using the Mac's VAPID key.

**Phase R1 — fixes and plumbing.** Per-origin rpIDs, the proxy listener, the
in-console channel transport (behind the dependency decision), and the
versioned shell with a bootloader.

**Phase R2 — alpha.** `metistry remote relay on`, the launchd shape only, no
TURN, BYO TURN in Settings, and FSL's own instances first.

**Phase R3 — public opt-in.** Privacy policy updated, PSL entry live, and a
status page.

### 5.3 Decisions for the owner

1. Is **§1.5(a)** a bug to fix now, and does the separate proxy listener work
   for you?
2. **Signalling vendor:** Cloudflare (recommended) or AWS.
3. **Shell trust model:** FSL serves the whole app; a bootloader with
   Mac-supplied SRI (recommended); or a bootloader with the Mac serving the
   bundle.
4. **Fallback when punching fails:** refuse plus BYO TURN (recommended), or a
   capped FSL TURN.
5. **The WebRTC dependency** for the Mac: `node-datachannel` or `werift`.
6. Whether to submit `metistry.app` to the **PSL**.
7. **Launchd shape only** for the relay?
8. **The success-rate gate** in R1: is 85% the right number?

### 5.4 Website copy

The metistry.ai Download page marks step 1 BEING DESIGNED. Once §5.1 ships,
it can drop the marker and say what is true:

> **Let your phone reach your Mac.** Metistry answers only on your Mac to
> start with. The simplest way to use it from anywhere is Tailscale: free,
> private, and nothing opened to the internet. Our guide walks you through it,
> along with other options like Cloudflare Tunnel or your router.

Don't mention the relay until Phase R2 is committed. If it ships, one line
can be added: *"Or switch on the Metistry relay in Settings — it introduces
your phone to your Mac and never carries your data."*

## Sources

All fetched 2026-09-28.

- Tailscale:
  - Funnel — <https://tailscale.com/kb/1223/funnel>
  - Serve — <https://tailscale.com/kb/1312/serve>
  - Enabling HTTPS (CT warning) — <https://tailscale.com/kb/1153/enabling-https>
  - Pricing — <https://tailscale.com/pricing>
  - *How NAT traversal works* — <https://tailscale.com/blog/how-nat-traversal-works>
- Let's Encrypt, challenge types — <https://letsencrypt.org/docs/challenge-types/>
- CGNAT on home ISPs:
  - <https://www.compareinternet.com/blog/t-mobile-home-internet-port-forwarding/>
  - <https://www.hostifi.com/blog/cgnat-on-starlink-explained>
- IPv6 at 50% — APNIC blog, <https://blog.apnic.net/2026/04/28/google-hits-50-ipv6/>
- Cloudflare:
  - Tunnel — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/>
  - Zero Trust plans — <https://www.cloudflare.com/plans/zero-trust-services/>
  - What Cloudflare sees in a tunnel — <https://pluggie.io/blog/cloudflare-tunnel-tls-privacy>
- ngrok:
  - Pricing — <https://ngrok.com/pricing>
  - TLS termination — <https://ngrok.com/docs/universal-gateway/tls-termination/>
  - Free-plan interstitial — <https://ngrok.com/docs/pricing-limits/free-plan-limits>
- Cloudflare Realtime:
  - TURN — <https://developers.cloudflare.com/realtime/turn/>
  - TURN FAQ — <https://developers.cloudflare.com/realtime/turn/faq/>
  - Pricing — <https://developers.cloudflare.com/realtime/pricing/>
  - Free STUN at `stun.cloudflare.com` — <https://developers.cloudflare.com/realtime/turn/generate-credentials/>
- Cloudflare Durable Objects:
  - Pricing — <https://developers.cloudflare.com/durable-objects/platform/pricing/>
  - WebSockets and hibernation — <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Cloudflare Workers:
  - Pricing — <https://developers.cloudflare.com/workers/platform/pricing/>
  - Static assets billing — <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
  - Universal SSL — <https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/>
- AWS:
  - API Gateway pricing — <https://aws.amazon.com/api-gateway/pricing/>
  - WebSocket quotas — <https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html>
  - DynamoDB on-demand pricing — <https://aws.amazon.com/dynamodb/pricing/on-demand/>
- NAT traversal data:
  - DCUtR, IMC 2026 — <https://arxiv.org/abs/2604.12484>
  - Richter et al., IMC 2016 — <https://arxiv.org/abs/1605.05606>
  - BlogGeek on TURN — <https://bloggeek.me/webrtcglossary/turn/>
  - ExpressTURN on mobile — <https://www.expressturn.com/blog/webrtc-calls-fail-on-mobile-networks>
- WebRTC on iOS and in browsers:
  - caniuse RTCDataChannel — <https://caniuse.com/mdn-api_rtcdatachannel>
  - WebRTC in WKWebView (iOS 14.3) — <https://blog.bitsrc.io/ios-14-3-brings-webrtc-to-wkwebview-closing-gap-on-ios-accessibility-90a83fa6bda2>
  - webrtcHacks Safari guide (2018) — <https://webrtchacks.com/guide-to-safari-webrtc/>
  - WebKit data-channel ICE filtering test — <https://github.com/WebKit/webkit/blob/main/LayoutTests/webrtc/datachannel/filter-ice-candidate.html>
  - iOS PWA background sockets — <https://developer.apple.com/forums/thread/716118>
  - MDN data channels — <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels>
  - WebKit 7-day cap and Home Screen apps — <https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/>
- RFC 8827, WebRTC security architecture — <https://www.rfc-editor.org/rfc/rfc8827.html>
- WEBCAT — <https://freedom.press/tech/news/introducing-webcat-web-based-code-assurance-and-transparency/>
- Repo (`00762c89`):
  - `apps/console/src/local-owner.ts`
  - `apps/console/src/webauthn.ts`
  - `apps/console/src/push.ts`
  - `apps/console/src/http-util.ts`
  - `docs/ops/auth.md`
  - `docs/ops/deployment-shapes.md`
  - `docs/ops/client-api.md`
  - `docs/poc/RESULTS.md` (PoC-6)
  - `docs/plan-refresh-2026-09-13.md`
  - `docs/product/ios-app-plan.md`
  - `docs/product/design-build-plan.md` (§2.22, *Remote access for the phone*)
  - `docs/research/2026-09-11-multi-instance-and-offline-client.md`
