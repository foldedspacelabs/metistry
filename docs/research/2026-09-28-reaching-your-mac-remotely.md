# Reaching your Mac from your phone — the owner's choice of provider (2026-09-28, revised 2026-09-30)

Research for `docs/product/design-build-plan.md` §2.23, *Remote access — the
owner's choice*. The problem: an instance runs on the owner's Mac behind home
NAT, and the console binds `127.0.0.1:8080` (`docs/ops/deployment-shapes.md`).
The console PWA on the owner's phone has to reach it, with a passkey, which
needs an HTTPS origin whose hostname never changes (it is the WebAuthn rpID).

**History.** The 2026-09-28 version of this file recommended Tailscale and
designed an opt-in FSL-run rendezvous relay. The owner read it and ruled on
2026-09-30:

> "I'm not sure I like any of the designs, to be honest. I don't want to pay to
> host a service that scales up in cost as user counts grow when I'm not
> charging anything for the app."
>
> "Maybe the better option is to just ask the user, at setup time, what they
> prefer and then support a number of options they can configure easily. None
> (local only, default option), Tailscale, Cloudflare tunnel, ngrok, and port
> forwarding."
>
> "I'd want to make it as easy as possible to set these things up... like they
> create an account with the service they want to use and then OAuth sign into
> it from Metistry and it gets configured and exposed automatically."

So this revision keeps the analysis of the options, what each provider can
see, and the two security gaps; drops the relay (recorded under §6,
*Considered and rejected*); and adds, per provider, how close Metistry can get
to *sign in, authorize, done* from the Mac app.

Nothing here is built. Vendor facts come from vendor docs fetched on
**2026-09-28** (the original analysis) and **2026-09-30** (§3, the automation
research); each is cited in Sources with its date. Repo facts cite files at
`0d5878c8`. Where a claim is my inference rather than a published statement,
the text says so, and §7 lists what must be checked hands-on before a ticket
relies on it.

## The short version

1. **Five choices, asked at setup, changeable in Settings.** None (default),
   Tailscale, Cloudflare Tunnel, ngrok, port forwarding. No FSL service sits in
   any of them, so nothing FSL pays for grows with the number of owners.
2. **No provider offers "Sign in with X" for a third-party app to configure
   the owner's account — except, newly, Cloudflare.** Tailscale's sign-in is its
   own app's (Metistry drives the rest, and the HTTPS enablement prompt is
   Tailscale's own one-click page). Cloudflare launched self-managed OAuth
   clients with PKCE in June 2026, so a real *Connect to Cloudflare* is
   plausible; until it is proven, `cloudflared tunnel login`'s browser flow is
   the fallback. ngrok has no OAuth or device flow: the best is *paste your
   authtoken*. Port forwarding needs no account but the most machinery.
3. **Who can read the traffic decides the order.** With Tailscale and port
   forwarding only the Mac terminates TLS. Cloudflare and ngrok terminate TLS
   at their edge and see cookies, passkey assertions and bodies in plaintext.
   Only Tailscale keeps the console's sign-in page off the public internet.
4. **Recommended order:** None and Tailscale first; then Cloudflare Tunnel,
   then ngrok; port forwarding last (§5).
5. **Two existing gaps block every choice but None** (§2): a same-host proxy
   makes the loopback-only local owner token remote, and a second
   `METISTRY_ORIGIN` entry cannot complete a passkey ceremony. Both are tickets
   that land before any provider.

| Provider | Closest to one-click | Hostname for `METISTRY_ORIGIN` | TLS ends at (who reads it) | Owner's cost | Needs |
| --- | --- | --- | --- | --- | --- |
| **None** | nothing to do | — (loopback only) | — | $0 | — |
| **Tailscale** | **near**: provider app signs in; Metistry runs `serve`; HTTPS enablement is one click on Tailscale's page | `https://<mac>.<tailnet>.ts.net` | **the Mac** | $0 | Tailscale app on Mac **and** iPhone |
| **Cloudflare Tunnel** | **near, if OAuth proves out**: *Connect to Cloudflare* (PKCE) → pick zone → done. Today: browser `cloudflared tunnel login` | `https://<name>.<owner's domain>` | **Cloudflare** | $0 + a domain (~$10/yr) | a domain on Cloudflare DNS |
| **ngrok** | **paste a token** (no OAuth/device flow) | `https://<dev-domain>.ngrok-free.dev` (free) | **ngrok** | $0 with a weekly warning page; $10/mo removes it | ngrok account |
| **Port forwarding** | **automatic when the router cooperates**; impossible behind CGNAT | `https://<name>.dedyn.io` (or the owner's domain) | **the Mac** | $0 | a router with PCP/NAT-PMP/UPnP and a public IPv4 |

## 1. The options, and what each one exposes

This section is the 2026-09-28 analysis, kept: what each path is, what it
costs, and who can see what.

### 1.1 Tailscale

**Shape.** Tailscale on the Mac and the iPhone, signed in to the same tailnet.
`tailscale serve` on the Mac proxies `https://<mac>.<tailnet>.ts.net` to the
console; Serve provisions and renews a Let's Encrypt certificate itself (DNS-01
against a `ts.net` record), so no port is opened. PoC-6 proved this end to end
on 2026-08-27: Serve, the certificate, the Home Screen PWA and web push
(`docs/poc/RESULTS.md`).

- **Security posture.** WireGuard end to end between devices; when a direct path
  fails, Tailscale's DERP relays carry encrypted packets at Tailscale's expense.
  The console is reachable only from devices on the tailnet — **nothing faces
  the internet**.
- **Catches.** The phone needs the Tailscale app, an iOS VPN, and iOS runs one
  VPN with On Demand at a time — awkward beside a work VPN. Enabling HTTPS
  publishes machine names to Certificate Transparency: Tailscale says "Do not
  enable the HTTPS feature if any of your machine names contain sensitive
  information." Renaming the Mac changes its MagicDNS name, and with it the
  rpID.
- **Funnel is not needed for the phone.** Funnel publishes the node to the whole
  internet (TLS still ends on the Mac). It only helps a client that cannot join
  the tailnet; for the phone it adds exposure and nothing else.

### 1.2 Router port forwarding

**Shape.** Forward TCP 443 to the Mac, terminate TLS on the Mac, point a
dynamic-DNS name at the home address, and get a certificate over ACME
(HTTP-01 needs port 80; TLS-ALPN-01 uses 443; DNS-01 needs a DNS API and no
inbound port).

- **It often cannot work at all.** T-Mobile Home Internet, Verizon 5G Home and
  standard Starlink put IPv4 behind carrier-grade NAT (CGNAT): there is no
  public address for a forwarded port to reach.
- **Security posture: the weakest.** The console's unauthenticated surface — the
  login ceremony, `GET /api/identity`, `/health`, the static shell — faces every
  scanner, and the home IP sits in public DNS. Invariant 8 ("every request
  authenticates as if internet-exposed") was written for this, but it is still
  real exposure, plus a certificate, a mapping and a DNS name to keep alive.

### 1.3 Commercial tunnels

| | How | Cost | Who sees plaintext |
| --- | --- | --- | --- |
| **Cloudflare Tunnel** | `cloudflared` on the Mac dials out; a hostname on a Cloudflare-managed domain routes to it | free, unmetered; Access free to 50 users | **Cloudflare** — TLS terminates at the edge |
| **ngrok** | the agent dials out; a dev domain or a custom domain | free: 1 GB/month, 20k requests, a browser interstitial; Hobbyist $10/month removes it | **ngrok** for HTTPS endpoints; agent-side TLS (paid plans) is end to end but needs the owner's own certificate |

- **Passkeys and origin.** The public hostname becomes `METISTRY_ORIGIN`. That
  works only if it is stable: a reserved or custom domain, never a random URL,
  or every enrolled passkey breaks when the URL changes.
- **Both put the sign-in page on the public internet**, like port forwarding,
  but behind the vendor's edge (DDoS absorption, and Cloudflare Access as an
  optional gate).

### 1.4 IPv6 direct

About half of Google's users reach it over IPv6 (APNIC, April 2026), but home
gateways drop unsolicited inbound IPv6 by default, privacy addresses rotate, and
a phone on IPv4-only Wi-Fi cannot reach it. It is a variant of port forwarding
(a firewall pinhole instead of a mapping — UPnP IGDv2's
`WANIPv6FirewallControl` or PCP) and is not a separate choice; §3.5 uses it
where the router offers it.

## 2. Two gaps every proxy path exposes (blocking)

These were found on 2026-09-28 and stand unchanged. They are bugs against
`docs/ops/auth.md` whatever the owner chooses, and they land before any
provider (plan §2.23, X-103 and X-104).

**(a) Same-host proxies defeat the local-owner-token loopback rule.**
`apps/console/src/local-owner.ts` accepts `METISTRY_LOCAL_OWNER_TOKEN` when the
socket peer is loopback, and `auth.md` promises that a token that leaks "still
cannot be replayed from off the machine". But `tailscale serve`, `cloudflared`
and the ngrok agent all forward from `127.0.0.1`, and so would a TLS terminator
for port forwarding. Every request through them arrives with a loopback peer:
behind Serve, a leaked token works from any tailnet device; behind Cloudflare,
ngrok or port forwarding, from the internet — including the `local` routes that
mint agent bearers.

**Fix:** a second console listener for proxies only, on which a request is
remote by construction — the local owner token is never honoured, no `local`
route answers, and the `Host` header must be the configured remote host. Every
adapter points its provider there and never at the main port. `cloudflared`
and the ngrok agent can dial a Unix socket (`unix:/path`), which makes the
listener unreachable to anything that is not given the path; Tailscale's Serve
documents only `http://127.0.0.1:<port>` targets, so the listener is a loopback
TCP port too (§3.2).

**(b) A multi-origin `METISTRY_ORIGIN` has one rpID.** `rpFromOrigin` in
`apps/console/src/webauthn.ts` takes the rpID from the first entry only, so
`auth.md`'s own example pair, "a tailnet name and a public hostname", cannot
both work: a browser at `metis.example.com` refuses an rpID of
`mac.tailnet.ts.net`. `@simplewebauthn/server` 13 accepts `expectedRPID` as an
array (checked in the installed 13.3.3 typings). **Fix:** choose the rpID per
request origin when generating options, and verify against the list. Switching
provider changes the hostname, so this is also what lets an owner move from one
provider to another without breaking the Mac's own sign-in.

## 3. How close to "sign in, authorize, done", per provider

Every provider is an adapter behind one interface (plan §2.23): **detect**
(read-only), **configure** (idempotent; returns the origin), **status** (doctor
rows) and **revoke** (undo exactly what configure did). Below, for each: what
the owner does, what Metistry automates, the hostname, TLS, cost, the failures
Metistry detects and how it says them, and removal. Failure wording follows
the product's voice — reported state, each absence its own sentence naming the
fix.

### 3.1 None (the default)

- **Owner does:** nothing. **Metistry does:** nothing; `METISTRY_ORIGIN` stays
  `http://127.0.0.1:<port>` as `init` wrote it.
- **What the phone can do:** nothing with this install. The console is not
  reachable from it, so there is no PWA, no web push (a subscription is made
  from the installed PWA) and no capture Shortcut. A "home network only"
  variant is not offered: a passkey needs HTTPS and a hostname, and a LAN
  address has neither a publicly trusted certificate nor a stable name (a
  `.local` name cannot get one). Tailscale is the answer for the home network
  too.
- **What still works:** the Mac app, and any browser on this Mac.
- **Doctor:** one `ok` row — *"Remote access: none. Your phone can't reach this
  Mac. Choose a way in Settings ▸ Remote Access."* `ok`, because None is a
  choice, not a fault.
- **Add a Phone** refuses with the loopback refusal, which now names Settings ▸
  Remote Access (plan §2.22).

### 3.2 Tailscale

**True OAuth?** No. Tailscale's OAuth clients use only the client-credentials
grant, for a tailnet's own automation; there is no three-legged flow for a
third-party app to act on a user's tailnet (checked 2026-09-30). The newer
*trust credentials* add federated workload identity, which is still
service-to-service. **But nothing needs it:** the provider's own app signs
the Mac in, and Metistry drives the local CLI for everything else.

- **Owner does:** installs Tailscale on the Mac (Standalone or App Store
  variant, or the open-source `tailscaled`) and on the iPhone, and signs in to
  both with the same account. If HTTPS certificates are off for the tailnet,
  clicks once to allow it (below).
- **Metistry automates:**
  1. **Detect.** `/Applications/Tailscale.app` (its CLI is
     `Contents/MacOS/Tailscale`, not on PATH by default) or a `tailscale` binary.
     `tailscale status --json` gives `BackendState` (`NoState`, `NeedsLogin`,
     `NeedsMachineAuth`, `Stopped`, `Starting`, `Running`), `AuthURL` while
     `NeedsLogin`, and `Self.DNSName` (the MagicDNS FQDN, trailing dot). The
     JSON is documented as "subject to change", so the adapter pins the fields
     it reads with a fixture test.
  2. **Sign in, if needed.** With the app installed but signed out, open the app
     (or the `AuthURL` the CLI reports; `tailscale up --qr` can render it).
     Metistry never sees the owner's credentials.
  3. **HTTPS.** Run `tailscale serve --bg` with the proxy listener as the
     target. If HTTPS is off for the tailnet, `tailscale serve` "provides an
     interactive web UI that prompts you to allow Tailscale to enable HTTPS on
     your behalf" — Metistry surfaces that link as the one step, and waits.
     MagicDNS must be on (it is the default for new tailnets; an empty
     `Self.DNSName` says it is off).
  4. **Origin.** `https://` + `Self.DNSName` without the dot.
- **Bundling:** the open-source client is BSD-3-Clause, and tsnet embeds
  Tailscale in a Go program — but Metistry is TypeScript and Swift, a bundled
  client still signs in through Tailscale's coordination server, and the iPhone
  needs the app anyway. **Find the owner's install; never bundle.**
- **Hostname:** `https://<mac>.<tailnet>.ts.net`. Stable unless the owner renames
  the Mac (MagicDNS follows the rename) or the tailnet name changes. The adapter
  records the name it configured and doctor fails when `Self.DNSName` no longer
  matches it.
- **TLS:** on the Mac. Tailscale relays only WireGuard ciphertext.
- **Cost:** $0. The Personal plan is "Free forever", "Up to 6 users",
  "Unlimited user devices" (pricing page, 2026-09-30).
- **Identity headers.** Serve adds `Tailscale-User-Login` and friends to tailnet
  traffic. **Metistry does not use them for auth** — the passkey stays the door
  (invariant 8) — but the proxy listener may log the login for the audit row.
- **Failures and wording** (doctor rows, kind `remote`):
  - not installed — *"Tailscale isn't installed on this Mac. Install it from
    tailscale.com or the App Store, then sign in."*
  - not running / `Stopped` — *"Tailscale is installed but not connected. Open
    Tailscale and turn it on."*
  - `NeedsLogin` / `NeedsMachineAuth` — *"This Mac isn't signed in to Tailscale.
    Sign in from the Tailscale menu."* (machine auth: *"…waiting for approval in
    your Tailscale admin console."*)
  - MagicDNS off — *"MagicDNS is off for your tailnet, so this Mac has no name.
    Turn it on in the Tailscale admin console, DNS page."*
  - HTTPS off — *"HTTPS certificates are off for your tailnet. Open the link
    Tailscale gave to allow them."*
  - serve absent or pointed elsewhere — *"Tailscale isn't forwarding to
    Metistry."* / *"…is forwarding to the console's main port."* — fixed by
    `metistry remote set tailscale`.
  - name changed — *"This Mac's Tailscale name changed from <old> to <new>.
    Phones added under the old name must be added again."*
  - node key expiry within 14 days (`degraded`) — *"This Mac's Tailscale key
    expires on <date>. Disable key expiry for it in the admin console, or sign in
    again before then."* (default expiry is 180 days).
  - **Not detectable from the Mac:** whether the iPhone is signed in to the same
    tailnet. The peer list shows an iPhone only once it is online; the Add a
    Phone sheet says *"Your phone must be signed in to the same Tailscale
    account."*
- **Removal:** `tailscale serve --https=443 off` (or `serve reset` when Metistry
  owns the whole config) removes the handler it added. The Mac stays on the
  tailnet; logging out or removing the device is the owner's, and the pane says
  so.

### 3.3 Cloudflare Tunnel

**True OAuth?** **Possibly, as of June 2026.** Cloudflare announced
self-managed OAuth clients on 2026-06-03, open to all customers: an app "act[s]
on behalf of a user to access their Cloudflare account", with a consent screen
listing scopes. For desktop and CLI apps the documented flow is Authorization
Code with PKCE, and "Clients that use PKCE do not need a client secret". OAuth
scope names "correspond to Cloudflare API token permission names". A client
starts private; making it public needs a name, logo, URL, scopes and domain
verification, and "Setting a client's visibility to public is permanent."
**Unverified (§7):** whether a loopback redirect (`http://127.0.0.1:<port>/…`)
is allowed for a public client, and whether the tunnel and DNS permissions are
offered as scopes. If both hold, FSL registers **one public PKCE client** (no
secret, no FSL server, verified against `metistry.ai`) and Metistry runs the same
loopback sign-in it already runs for connections (`metistry connections
authorize`). That is the one place in this research where the owner's
*"OAuth sign into it from Metistry"* is literally available.

**Fallbacks, best first:**

1. `cloudflared tunnel login` — opens the browser, the owner picks the zone,
   and an account certificate (`cert.pem`) lands in `~/.cloudflared`. It
   "allows users to create, delete, and manage all tunnels for the account" and
   is valid for years — broad, so Metistry stores it in the Keychain, not on
   disk, after use. No token to paste.
2. A pasted API token with exactly: Account › Cloudflare Tunnel Edit, Zone › DNS
   Edit, Zone › Zone Read (permission group names to be re-checked against the
   permissions reference before the copy is written).

- **Owner does:** has a Cloudflare account with a domain on Cloudflare DNS
  (buying one through Cloudflare Registrar is at cost, about $10/year for
  `.com`); signs in once (OAuth or `tunnel login`); picks the hostname
  (default `metistry.<zone>`).
- **A domain is required.** A tunnel with a stable hostname needs a zone on
  Cloudflare DNS; partial (CNAME) setup is Business or Enterprise only. There
  is no free stable hostname without a domain.
- **Quick Tunnels are refused.** `trycloudflare.com` needs no account, but "The
  hostname changes each time you create a Quick Tunnel" — fatal for a passkey —
  and "Quick Tunnels do not support Server-Sent Events (SSE)", which breaks
  `GET /api/events`. The adapter refuses it by name rather than offering a
  phone that stops working on the next restart.
- **Metistry automates:** with the API (OAuth token or pasted token), create a
  **remotely-managed** tunnel (`POST /accounts/{id}/cfd_tunnel`,
  `config_src: cloudflare`, which returns the tunnel token), put its ingress
  (`<hostname>` → the proxy listener's Unix socket, `service: unix:/path`), and
  create the proxied CNAME `<hostname>` → `<uuid>.cfargotunnel.com`. Then run
  `cloudflared tunnel run --token` as a supervised launchd job with the token
  from the Keychain. With only `cert.pem`, the same steps as a locally-managed
  tunnel through the CLI.
- **`cloudflared` itself** is Apache-2.0, so it may be bundled; Homebrew
  (`brew install cloudflared`) is the other source. Whether Metistry downloads
  or bundles it is the owner's call (plan §2.23, open question 2).
- **Cloudflare Access** (optional, `--access`): free to 50 users, puts an
  identity check in front of the hostname. Two credible community reports need
  a hands-on test before Metistry offers it by default: the PWA's manifest is
  fetched without credentials and gets redirected to Access's login, and an
  expired `CF_Authorization` cookie can strand a standalone PWA on a cached
  shell. Offered off by default, labelled *extra sign-in in front of
  Metistry's*.
- **Hostname:** `https://<name>.<owner's domain>` — stable for as long as the
  owner keeps the domain.
- **TLS:** **Cloudflare** terminates at its edge and re-encrypts to the tunnel;
  it can read cookies, passkey assertions and bodies. No free end-to-end option
  exists for HTTP tunnels. The pane says so before the owner confirms.
- **Exposure:** the sign-in page is on the public internet behind Cloudflare's
  edge — X-111's hardening applies.
- **Cost:** $0 for the tunnel; the domain.
- **Failures and wording:**
  - no zone — *"Your Cloudflare account has no domain. Add one (or buy one in
    Cloudflare Registrar), then try again."*
  - not signed in / token revoked (401/403 from the API) — *"Metistry is no
    longer allowed into your Cloudflare account. Connect to Cloudflare again."*
  - `cloudflared` missing / job down — *"cloudflared isn't running. Run
    `metistry restart cloudflared`."*
  - tunnel status `inactive` / `down` / `degraded` (the API's tunnel status;
    enum to be re-checked) — *"The tunnel to Cloudflare is down."*
  - DNS record missing or not pointing at the tunnel — *"<hostname> doesn't point
    at this Mac's tunnel."* — fixed by `metistry remote set cloudflare`.
  - Access redirecting `/health` — *"Cloudflare Access is asking for a sign-in
    before Metistry's. Your phone will see two sign-ins."* (`degraded`, by
    design when `--access` is on).
- **Removal:** delete the tunnel (API `DELETE`, or `cloudflared tunnel delete`)
  and the CNAME Metistry created — the CLI does not reliably remove DNS records,
  so the adapter deletes the record by id; stop and remove the launchd job; drop
  the Keychain items. Revoking the OAuth grant or API token (and `cert.pem`'s
  access) is listed for the owner.

### 3.4 ngrok

**True OAuth?** **No.** The agent's only credential commands are `ngrok config
add-authtoken` and `add-api-key`; there is no `ngrok login`, no device flow, and
no OAuth app for third parties to obtain an authtoken (CLI reference, 2026-09-30).
The best available is **paste your authtoken**: Metistry opens
`dashboard.ngrok.com/get-started/your-authtoken`, the owner copies one string,
and Metistry reads it from stdin (hidden) into the Keychain — never argv.

- **Owner does:** creates an ngrok account; pastes the authtoken; on a paid
  plan, optionally names a custom domain.
- **Metistry automates:** reads the account's **dev domain** — every account
  gets one, assigned at sign-up, and it "stays fixed across agent restarts" —
  and starts the agent against the proxy listener's Unix socket
  (`unix:///path`), supervised. Reading the domain through the API
  (`GET /reserved_domains`) needs an API key, which is a separate credential;
  without one, the adapter asks the owner to paste the domain shown on the
  dashboard's Domains page (inference: the agent's own output also reports the
  URL once online).
- **The agent is closed-source**, and ngrok's terms require written consent to
  redistribute it to users with their own accounts, so Metistry **cannot bundle
  it**: the owner installs it (`brew install ngrok`) or Metistry uses the
  `@ngrok/ngrok` SDK, a native Node addon — a dependency (U5) for the owner to
  approve.
- **Free-plan interstitial.** ngrok "shows an interstitial page in front of all
  HTML browser traffic on the free tier"; clicking *Visit* sets a cookie that
  suppresses it for 7 days. The skip header (`ngrok-skip-browser-warning`)
  cannot be set on a top-level navigation or an `EventSource`, and Traffic
  Policy may not add it on free accounts. So on the free plan the owner's
  Home Screen app shows ngrok's warning page about once a week before
  Metistry. Whether the PWA survives that cleanly (the cookie in a standalone
  app's storage, `GET /api/events` before the cookie exists) is **unverified
  (§7)**. Hobbyist ($10/month) removes it.
- **Hostname:** `https://<dev-domain>.ngrok-free.dev` (ngrok's docs show both
  `ngrok-free.app` and `ngrok-free.dev` bases; the adapter reads whatever the
  account has). Stable. A custom domain needs Pay-as-you-go ($20/month).
- **TLS:** **ngrok** — "All HTTPS endpoints terminate TLS at ngrok's cloud
  service". Agent-side termination (end to end) exists on Hobbyist and above,
  but the owner then supplies the certificate, which is port forwarding's ACME
  problem again; not offered.
- **Exposure:** the sign-in page is on the public internet — X-111 applies.
  Traffic Policy can add OAuth, basic auth or IP restrictions in front (plan
  gating per action unverified); not offered in v1.
- **Cost:** free — 1 GB/month, 20,000 HTTP requests/month, 3 agents, 1 dev
  domain — with the interstitial; Hobbyist $10/month (5 GB) without it.
- **Failures and wording:**
  - `ERR_NGROK_105` (malformed) / `ERR_NGROK_107` (revoked or reset) — *"ngrok
    didn't accept the authtoken. Copy it again from your ngrok dashboard."*
  - `ERR_NGROK_334` (endpoint already online) — *"<domain> is already in use by
    another ngrok agent. Stop it, then try again."*
  - agent missing / down — *"The ngrok agent isn't running. Run `metistry
    restart ngrok`."*
  - a monthly quota reached (its own `ERR_NGROK_*` codes) — *"Your ngrok plan's
    monthly limit is used up. Your phone can't reach this Mac until it resets
    or you upgrade."*
- **Removal:** stop and remove the agent's job; delete the authtoken from the
  Keychain. Resetting the token and releasing a custom domain are the owner's,
  in the dashboard; the dev domain is the account's and is not released.

### 3.5 Port forwarding

**True OAuth?** Not applicable — no account, except the DDNS provider's token.
Closest to one-click **when the router cooperates**: Metistry asks the router,
names the result, and stops honestly when it cannot work.

- **Owner does:** chooses a dynamic-DNS name (default: a free deSEC name under
  `dedyn.io`, created with an email and a pasted token; or a subdomain of a
  domain on Cloudflare, reusing §3.3's sign-in), and allows UPnP/NAT-PMP on the
  router if it is off — or forwards the port by hand (`--manual`).
- **Metistry automates:**
  1. **Mapping.** PCP (RFC 6887), then NAT-PMP (RFC 6886), then UPnP-IGD.
     Renew before expiry (NAT-PMP recommends 7200 s leases; PCP renews at about
     half to five-eighths of the lifetime). A PCP client "MUST be written
     assuming it may never be assigned the external port it suggests", so the
     origin carries whatever external port the router grants
     (`https://name.dedyn.io:51443` is a valid origin and rpID host). macOS's
     own `DNSServiceNATPortMappingCreate` is in the headers but has not worked
     since Monterey — Metistry needs its own client.
  2. **CGNAT and double-NAT detection — refuse by name.** The router's reported
     external address is in `100.64.0.0/10` (RFC 6598) or RFC 1918 space, or
     differs from the address the DDNS provider records on update (an outside view
     Metistry already talks to — no extra service; inference: most DDNS update
     endpoints take the caller's address when none is given). Then: *"Your internet
     provider shares one public address among many customers (carrier-grade
     NAT), so nothing outside can reach this Mac. Port forwarding can't work
     here; choose Tailscale or a tunnel."* On IPv6, a pinhole through UPnP
     IGDv2's `WANIPv6FirewallControl` or PCP is tried before refusing.
  3. **DNS.** Keep the A/AAAA record at the mapped address, updating on change.
  4. **Certificate.** ACME DNS-01 through the DDNS provider's API (no port 80
     needed; deSEC and Cloudflare have full TXT APIs; DuckDNS allows a single
     TXT record per account; No-IP's free plan has no TXT records; Dynu's free
     TXT needs a 30-day-old hostname). Renew on ARI's window (RFC 9773).
     Let's Encrypt is shortening lifetimes (45-day certificates opt-in from
     May 2026, default by February 2028), so renewal is routine, not rare.
  5. **Serve TLS** on the mapped port in front of the proxy listener.
- **Dependencies (U5).** NAT-PMP and PCP are small UDP protocols and can be
  hand-rolled; UPnP (SSDP + SOAP) and ACME are not small. The candidates:
  `@achingbrain/nat-port-mapper` (UPnP + NAT-PMP, no PCP), `acme-client`, or
  Caddy as an external binary with a DNS plugin. The owner's call.
- **Hostname:** `https://<name>.dedyn.io[:port]` or a subdomain of the owner's
  domain. Stable while the DDNS account lives.
- **TLS:** **the Mac**. Nobody in the path reads the traffic.
- **Exposure — the hardening it needs (X-111).** The console's sign-in surface
  faces every scanner, the hostname is in Certificate Transparency logs the
  moment the certificate is issued, and the home IP is in public DNS. Required
  before this ships: per-client rate limits on every unauthenticated route
  (the login and enrolment ceremonies, `/api/identity`), a global ceiling, the
  `Host` check, security headers (HSTS without preload, CSP,
  `X-Content-Type-Options`, `Referrer-Policy`, frame denial) on the proxy
  listener, no unauthenticated mutating route (already true — invariant 10),
  and an audit row per refused burst. UPnP-created mappings are sometimes
  invisible in the router's own UI, so the pane shows the mapping Metistry holds
  and doctor reports it. Canada's Cyber Centre advises disabling UPnP on
  perimeter devices; the pane does not ask the owner to turn it on without
  saying that.
- **Cost:** $0 with a free DDNS name.
- **Failures and wording:**
  - no PCP/NAT-PMP/UPnP responder — *"Your router didn't answer a request to open
    a port. Turn on UPnP or NAT-PMP, or forward TCP <port> to this Mac
    yourself."*
  - mapping refused — *"Your router refused to open a port for this Mac."*
  - CGNAT / double NAT — as above.
  - external address changed and the DNS update failed — *"Your home address
    changed and <name> still points at the old one."*
  - certificate expiring within 10 days or renewal failed — *"The certificate for
    <name> expires on <date> and couldn't be renewed: <provider's reason>."*
  - **reachable from outside: unknown.** Testing the public name from inside the
    LAN depends on hairpin NAT and can falsely pass or fail; there is no
    trustworthy local check. Doctor says *"Not checked from outside this
    network. Open <origin> on your phone with Wi-Fi off to confirm."* — never
    `ok` on a guess.
- **Removal:** delete the mapping (lifetime 0 for NAT-PMP/PCP;
  `DeletePortMapping` for UPnP), stop serving, delete the TXT/A records Metistry
  created, drop the Keychain items. Releasing the DDNS name is the owner's.

## 4. The common shape

- **The record.** `.metistry/deployment.yaml` `remote:` — provider, origin, and
  non-secret settings (tunnel id, hostname) — written through the protected
  write, like keep-awake. Credentials (OAuth refresh token, API token,
  authtoken, DDNS token, ACME account key, `cert.pem`) live in the login
  Keychain. Tailscale's live in Tailscale.
- **The origin.** The environment renderer puts the remote origin first in
  `METISTRY_ORIGIN` and keeps the loopback origin second, so `metistry enroll`
  (which mints for the first entry) and the Add a Phone QR pick it up unchanged,
  and the Mac's own browser keeps working. With §2(b) fixed, each origin gets
  its own rpID.
- **Switching.** Configure the new provider, wait for its origin to answer,
  then revoke the old one. Passkeys created for the old hostname stop working
  — unavoidable, since the rpID is the hostname — and Devices marks them.
- **Supervision.** `cloudflared`, the ngrok agent and the port-forward renewer
  are supervised jobs under the launchd shape (`metistry restart <service>`
  works on them). Under `shape: compose` the proxy listener is a second
  published port; the provider's agent still runs on the host.
- **The Mac app** drives every step through the CLI transport (§2.2): the
  wizard's question and Settings ▸ Remote Access are views over `metistry
  remote`.

## 5. Recommended order, and why

1. **The two fixes** (§2) — bugs whatever the owner picks, and every provider
   needs them.
2. **None + Tailscale.** None is every install's default and nearly free to
   build. Tailscale is the only choice where nothing faces the internet *and*
   only the Mac sees plaintext; its own apps do the sign-in (Metistry holds no
   credential); its HTTPS enablement is a one-click page of Tailscale's; PoC-6
   proved the whole path. It is also the home-network answer.
3. **Cloudflare Tunnel, then ngrok.** Both put the sign-in page on the internet
   and both decrypt at the vendor, so both wait on X-111. Cloudflare first: no
   interstitial, a browser sign-in (and possibly real OAuth) instead of a pasted
   token, and `cloudflared` may be bundled. ngrok second: token paste only, a
   closed agent Metistry cannot bundle, and a free plan whose weekly warning
   page may not suit a Home Screen app.
4. **Port forwarding last.** The most code (mapping, DDNS, ACME, renewal), the
   most exposure (the home address in public DNS, the console's TLS facing
   scanners), dependencies to approve, and it simply cannot work behind CGNAT —
   a growing share of home connections (fixed-wireless and satellite).

## 6. Considered and rejected

**An FSL-run rendezvous relay** (the 2026-09-28 design, in PR #456's first
version). The phone and the Mac would open a WebRTC data channel directly, with
FSL running only signalling on Cloudflare Workers + Durable Objects
(hibernating WebSockets) and serving the PWA shell from `<site>.metistry.app`.
Estimated at about $0/month for 100 owners and $6–16/month for 10,000 (AWS:
about $345/month at 10,000). It had real costs besides money: FSL would supply
the code the phone runs (a bootloader with Mac-supplied SRI could shrink but not
remove that trust), 5–30% of phone-on-cellular sessions would fail without a
TURN relay, it needed a WebRTC dependency, and iOS would force a new
rendezvous on every return to the foreground.

**Rejected by the owner, 2026-09-30:** it is an FSL-run service whose cost
grows with the number of users, for an app that charges nothing. The same
reason rules out its cousin, a TLS-passthrough SNI relay (Funnel rebuilt at
FSL's expense, about $900/month of egress at 10,000 owners by my estimate), and
FSL-paid TURN.

**Quick Tunnels** (`trycloudflare.com`) and any random-URL tunnel: the hostname
changes on every run, which breaks every passkey; Cloudflare's also lack SSE.

**Bundling a VPN client** (tsnet or the Tailscale CLI inside Metistry.app): Go
only, still signs in through Tailscale's servers, and the iPhone needs the app
regardless.

## 7. To verify hands-on before the tickets rely on it

1. **Cloudflare OAuth:** register a private PKCE client; confirm a loopback
   redirect is accepted and that tunnel and DNS permissions are grantable
   scopes (`GET /client/v4/oauth/scopes`). Then decide public vs `tunnel login`.
2. **Cloudflare Access + PWA:** manifest fetch, cookie expiry in standalone
   mode, and a passkey ceremony behind Access, on a real iPhone.
3. **ngrok free plan + PWA:** the interstitial on first launch of a Home Screen
   app, the 7-day cookie in standalone storage, and `GET /api/events`.
4. **Tailscale:** the exact output of `tailscale serve` when HTTPS is off (so
   the adapter can surface the link without scraping prose — prefer a status
   field if one exists), and `serve` behaviour when the node key expires.
5. **Port forwarding:** PCP/NAT-PMP/UPnP support on the owner's router and one
   CGNAT line (T-Mobile Home Internet or Starlink) to confirm the refusal.

## 8. Website copy

The metistry.ai Download page marks step 1 BEING DESIGNED. Once None and
Tailscale ship, it can say what is true:

> **Let your phone reach your Mac.** Metistry answers only on your Mac until you
> choose a way in. When you set it up, pick how your phone should reach it —
> Tailscale (free and private), a Cloudflare or ngrok tunnel, or your router —
> and Metistry configures it for you. You can change it later in Settings.

Name only the providers that have shipped at the time.

## Sources

**Fetched 2026-09-30** (§3):

- Tailscale:
  - CLI reference (`up`, `status --json`, `logout`) — <https://tailscale.com/docs/reference/tailscale-cli>, <https://tailscale.com/docs/reference/tailscale-cli/up>
  - `serve` reference — <https://tailscale.com/docs/reference/tailscale-cli/serve>
  - Serve FAQ (HTTPS prompt, identity headers) — <https://tailscale.com/kb/1312/serve>
  - macOS variants — <https://tailscale.com/docs/concepts/macos-variants>
  - `ipnstate` (`BackendState`, `AuthURL`, `DNSName`) — <https://pkg.go.dev/tailscale.com/ipn/ipnstate>
  - OAuth clients — <https://tailscale.com/docs/features/oauth-clients>
  - Trust credentials — <https://tailscale.com/docs/reference/trust-credentials>
  - HTTPS certificates — <https://tailscale.com/docs/how-to/set-up-https-certificates>
  - MagicDNS — <https://tailscale.com/kb/1081/magicdns>
  - Key expiry — <https://tailscale.com/docs/features/access-control/key-expiry>
  - tsnet — <https://tailscale.com/kb/1244/tsnet>
  - Licence — <https://github.com/tailscale/tailscale/blob/main/LICENSE>
  - Pricing — <https://tailscale.com/pricing>
  - CLI path inside the app bundle — <https://github.com/tailscale/tailscale/issues/3805>
- Cloudflare:
  - Self-managed OAuth clients (changelog, 2026-06-03) — <https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/>
  - OAuth — <https://developers.cloudflare.com/fundamentals/oauth/>
  - Create an OAuth client (PKCE, public visibility) — <https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/>
  - Locally-managed tunnel and `tunnel login` — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/>
  - `cert.pem` scope — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/tunnel-permissions/>
  - Remotely-managed tunnel via API — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/>
  - Tunnel API create/delete — <https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create>, <https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/delete/>
  - API token permissions — <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
  - Partial (CNAME) setup — <https://developers.cloudflare.com/dns/zone-setups/partial-setup/setup/>
  - Registrar — <https://www.cloudflare.com/application-services/solutions/low-cost-domain-names/>
  - Quick Tunnels — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>
  - Ingress to a Unix socket — <https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/>
  - Access cookie — <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/>
  - Access policies (Bypass) — <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/>
  - TLS at the edge — <https://developers.cloudflare.com/cloudflare-one/traffic-policies/http-policies/tls-decryption/>
  - `cloudflared` (Apache-2.0) — <https://github.com/cloudflare/cloudflared>, <https://formulae.brew.sh/formula/cloudflared>
  - Zero Trust plans — <https://www.cloudflare.com/plans/zero-trust-services/>
- ngrok:
  - Agent CLI — <https://ngrok.com/docs/agent/cli>, <https://ngrok.com/docs/agent>
  - Free plan limits and the interstitial — <https://ngrok.com/docs/pricing-limits/free-plan-limits>
  - Pricing — <https://ngrok.com/pricing>
  - TLS termination — <https://ngrok.com/docs/universal-gateway/tls-termination>, <https://ngrok.com/docs/universal-gateway/tls>
  - Reserved domains API — <https://ngrok.com/docs/api-reference/reserveddomains/get>
  - Errors — <https://ngrok.com/docs/errors/err_ngrok_105>, <https://ngrok.com/docs/errors/err_ngrok_107>, <https://ngrok.com/docs/errors/err_ngrok_334>
  - Terms (agent redistribution) — <https://ngrok.com/tos>
  - Node SDK — <https://ngrok.com/docs/using-ngrok-with/node-js/>
  - Traffic Policy OAuth — <https://ngrok.com/docs/traffic-policy/actions/oauth>
- Port forwarding:
  - NAT-PMP — <https://www.rfc-editor.org/rfc/rfc6886.html>
  - PCP — <https://www.rfc-editor.org/rfc/rfc6887.html>
  - Shared address space (CGNAT) — <https://www.rfc-editor.org/rfc/rfc6598>
  - UPnP IGDv2 IPv6 firewall control — <https://upnp.org/specs/gw/UPnP-gw-WANIPv6FirewallControl-v1-Service.pdf>
  - Canadian Centre for Cyber Security on UPnP — <https://www.cyber.gc.ca/en/guidance/universal-plug-play-itsap00008>
  - macOS port-mapping API broken — <https://lapcatsoftware.com/articles/portmapping.html>, <https://developer.apple.com/forums/thread/733662>
  - `@achingbrain/nat-port-mapper` — <https://www.npmjs.com/package/@achingbrain/nat-port-mapper>
  - `acme-client` — <https://www.npmjs.com/package/acme-client>
  - Let's Encrypt lifetimes and ARI — <https://letsencrypt.org/2025/01/16/6-day-and-ip-certs>, <https://letsencrypt.org/2025/09/16/ari-rfc>, <https://letsencrypt.org/2026/03/17/acme-renewal-information-ari>
  - Let's Encrypt rate limits — <https://letsencrypt.org/2025/01/30/scaling-rate-limits>
  - deSEC ACME DNS-01 — <https://github.com/rs22/acme-dns-01-desec>
  - DuckDNS single TXT record — <https://community.letsencrypt.org/t/automatically-renew-on-duckdns-via-dns-01/151503>
  - Dynu TXT records — <https://www.dynu.com/Resources/DNS-Records>
  - No-IP free limits — <https://www.noip.com/support/knowledgebase/free-enhanced-limitations>
  - CGNAT on T-Mobile Home Internet — <https://localtonet.com/blog/T-Mobile-Home-Internet-and-Port-Forwarding>
  - Double-NAT detection — <https://natchecker.com/blog/how-to-check-double-nat>
  - UPnP mappings missing from router UIs — <https://community.ui.com/questions/Where-do-I-find-the-UPnP-mapping-list/b633f7bd-83e6-4261-8b51-2d9411957181>

**Fetched 2026-09-28** (§1, §6):

- Tailscale Funnel — <https://tailscale.com/kb/1223/funnel>; enabling HTTPS (CT warning) — <https://tailscale.com/kb/1153/enabling-https>
- Let's Encrypt challenge types — <https://letsencrypt.org/docs/challenge-types/>
- CGNAT on Starlink — <https://www.hostifi.com/blog/cgnat-on-starlink-explained>
- IPv6 at 50% — <https://blog.apnic.net/2026/04/28/google-hits-50-ipv6/>
- Cloudflare Tunnel — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/>
- The relay's cost and NAT-traversal inputs (§6): Durable Objects pricing — <https://developers.cloudflare.com/durable-objects/platform/pricing/>; WebSocket hibernation — <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>; Workers pricing — <https://developers.cloudflare.com/workers/platform/pricing/>; API Gateway pricing — <https://aws.amazon.com/api-gateway/pricing/>; DCUtR, IMC 2026 — <https://arxiv.org/abs/2604.12484>; Richter et al., IMC 2016 — <https://arxiv.org/abs/1605.05606>; RFC 8827 — <https://www.rfc-editor.org/rfc/rfc8827.html>

**Repo (`0d5878c8`):** `apps/console/src/local-owner.ts`,
`apps/console/src/webauthn.ts`, `apps/console/src/main.ts`
(`METISTRY_CONSOLE_HOST`), `docs/ops/auth.md`, `docs/ops/cli.md`,
`docs/ops/deployment-shapes.md`, `docs/poc/RESULTS.md` (PoC-6),
`docs/product/design-build-plan.md` (§2.22, §2.23).
