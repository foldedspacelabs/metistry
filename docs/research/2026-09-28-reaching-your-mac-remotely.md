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

A second ruling the same day: *"Yes, let's add those. If there are things we
can do to make it easier on the user, let's do that as well. That includes
bundling/installing the cloudflared, tailscale tunnel app, etc."* — Tailscale
**Funnel** becomes the recommended path, **zrok** is added, and Metistry may
**bundle or install provider tools** (§3.6, §3.7, §3.8).

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

1. **Seven choices, asked at setup, changeable in Settings.** None (default),
   Tailscale (Funnel or tailnet), Metistry Relay, Cloudflare Tunnel, zrok,
   ngrok, port forwarding. Only the Metistry Relay is FSL's — opt-in, on one
   flat-priced Lightsail box, with per-host and global caps so FSL's bill does
   not grow with owners (§3.9).
2. **Recommended: Tailscale Funnel, on a node Metistry bundles.** Funnel makes
   the Mac's `ts.net` name a public HTTPS site while TLS still ends on the Mac —
   Tailscale's relays "do not decrypt the traffic" — so the phone needs **no
   Tailscale app or VPN**. A bundled, unprivileged `tailscaled` (BSD-3) removes
   the Mac app too. The owner's steps: Tailscale's sign-in page and up to two
   one-click approvals (HTTPS, Funnel).
3. **No provider offers "Sign in with X" to configure the owner's account —
   except, newly, Cloudflare** (PKCE clients, June 2026, to be proven). zrok and
   ngrok are *paste a token*; Tailscale's own login page needs no credential in
   Metistry.
4. **Who can read the traffic:** the Mac alone with Tailscale (both modes) and
   port forwarding, and with the Metistry Relay (TLS passes through it); the
   vendor with Cloudflare, zrok and ngrok. Only tailnet mode
   keeps the sign-in page off the public internet.
5. **Recommended order:** the fixes → None + Tailscale (Funnel, tailnet) with
   the tool packs and the guided flow → Metistry Relay → Cloudflare Tunnel →
   zrok → ngrok → port forwarding (§5).
6. **Two existing gaps block every choice but None** (§2), and every
   internet-facing choice — Funnel included — also waits on rate limits and
   headers.

| Provider | Closest to one-click | Tool: bundled / installed / pasted | Hostname | TLS ends at (who reads it) | Owner's cost |
| --- | --- | --- | --- | --- | --- |
| **None** | nothing to do | — | — (loopback) | — | $0 |
| **Tailscale — Funnel** *(recommended)* | **near**: Tailscale's login page; one-click *allow HTTPS* and *allow Funnel*; no app on the phone | **bundled** userspace `tailscaled` (or the owner's app) | `https://metistry-<instance>.<tailnet>.ts.net` | **the Mac** | $0 |
| **Tailscale — tailnet** | as Funnel, plus the Tailscale app on the iPhone | **bundled** (or the owner's app) | same | **the Mac** | $0 |
| **Metistry Relay** | **one click**: turn it on; no account | **bundled** relay client; a relay token from registration | `https://<id>.u.metistry.app` | **the Mac** (TLS passes through unopened) | $0 — 5 GB a month |
| **Cloudflare Tunnel** | **near, if OAuth proves out**; else browser `tunnel login` | **bundled** `cloudflared`; OAuth / cert / token | `https://<name>.<owner's domain>` | **Cloudflare** | $0 + a domain |
| **zrok** | **paste a token** once | **bundled** zrok CLI; account token pasted | `https://<name>.share.zrok.io` | **zrok** (NetFoundry) | $0, 5 GB/day; warning page unless a card is verified |
| **ngrok** | **paste a token** | owner-installed agent, or the SDK (owner's call); authtoken pasted | `https://<dev-domain>.ngrok-free.dev` | **ngrok** | $0 with a weekly warning page; $10/mo removes it |
| **Port forwarding** | automatic when the router cooperates; impossible behind CGNAT | in-process (dependencies open); DDNS token pasted | `https://<name>.dedyn.io[:port]` | **the Mac** | $0 |

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
- **Funnel** publishes the node to the whole internet through Tailscale's
  relays while TLS still ends on the Mac. The 2026-09-28 version called it
  unnecessary for the phone; the owner's follow-up ruling makes it the
  recommended mode, because it removes the phone's app and VPN — the biggest
  friction of plain Tailscale — at the cost of putting the sign-in page on the
  internet (§3.2).

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
| **zrok** | the zrok CLI dials out over OpenZiti; a reserved name under `share.zrok.io` | free: 5 GB/day, a browser interstitial unless a card is verified | **zrok** (NetFoundry) at its public frontend |
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

The steps below were written for the owner's own Tailscale app — the
`--use-app` path. The recommended path since the follow-up ruling is a bundled
node in Funnel mode (*Funnel* and *The node*, below); the detection, failures
and removal carry over, with the node's own login URL in place of the app.

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
- **Bundling:** superseded by the follow-up ruling — see *The node*, below:
  Metistry bundles an unprivileged `tailscaled` and keeps this app path as
  `--use-app`.
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

#### Funnel — the recommended mode (checked 2026-09-30)

- **TLS stays on the Mac.** "Funnel relay servers do not decrypt the traffic
  between public devices and your device"; the node "terminates the TLS
  connection". Funnel traffic carries **no** `Tailscale-User-*` identity headers.
- **Limits.** Ports 443, 8443 and 10000 only; "non-configurable bandwidth
  limits" (no figure published); "available for all plans".
- **Requirements.** MagicDNS, HTTPS certificates, and a `funnel` node attribute
  in the tailnet policy file. Running the command "triggers a web interface that
  prompts you to approve enabling Funnel" — the flow's one-click step, beside the
  HTTPS one. A new tailnet's default policy is reported to grant `funnel` to
  `autogroup:member` (secondary source; §7).
- **Propagation.** "Public DNS records can take up to 10 minutes to show up."
- **Status.** `tailscale funnel status --json` reports the handlers.
- **The phone** opens `https://<node>.<tailnet>.ts.net` in Safari, with no app.
- **Exposure.** Like Cloudflare, zrok and ngrok, the sign-in page faces the
  internet, so Funnel waits on the same hardening (plan X-111). Serve and Funnel
  cannot share a port.
- **Streaming.** No official word on SSE or idle timeouts through Funnel; an
  upstream issue reports Serve dropping WebSockets every 10–40 s
  (tailscale/tailscale#18827). `GET /api/events` must be tested (§7).

#### The node: bundled `tailscaled`, the owner's app, or tsnet

| | Bundled `tailscaled` (recommended) | The owner's Tailscale app | A tsnet helper |
| --- | --- | --- | --- |
| What runs | upstream `tailscaled` + `tailscale`, built from a pinned tag, `--tun=userspace-networking`, own `--statedir`/`--socket`, unprivileged, supervised | the App Store or Standalone app (a system or network extension the owner approves in System Settings; no silent path without MDM) | an FSL-written Go program embedding `tailscale.com/tsnet` (`ListenFunnel` exists) |
| Owner installs | nothing | the app, plus approvals | nothing |
| Name | `metistry-<instance>` — survives a Mac rename | the Mac's name — changes on rename | as bundled |
| FSL code | none (packaging only) | none | Go, a new language in the product |
| What the owner loses | the app's menu and MagicDNS **on the Mac** (the node is Metistry's alone) | — | as bundled |
| Unverified | unprivileged userspace mode with Funnel on macOS is from secondary sources (§7) | — | no official guidance for desktop embedding |

Userspace mode needs no root and no system extension; it is the mode
Tailscale's container images use, and incoming Serve/Funnel connections are
handled by its netstack. A Mac already running the Tailscale app gets a second
node on the same tailnet, which is harmless. **Recommendation:** bundle the
node, keep `--use-app` for owners who prefer their app; the tsnet helper is not
worth adding Go for. Licence: BSD-3-Clause.

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

### 3.4 zrok (added 2026-09-30)

**True OAuth?** **No.** `zrok enable <token>` with the account token from the
web console; zrok's OAuth is for *visitors* to a share (Google, GitHub), not
for signing the CLI in.

- **Owner does:** signs up at zrok.io (no card); pastes the account token once.
  Optionally verifies a card (no charge) to remove the warning page.
- **Metistry automates:** with its bundled CLI, `enable` into
  `.metistry/state/zrok/`; a reserved **name** in the `public` namespace; a
  headless public share to the proxy listener (zrok's proxy backend takes an
  HTTP URL, so the loopback proxy port), supervised. zrok's own *agent* mode can
  carry shares too; Metistry's supervisor is enough.
- **v2.** zrok 2.0 renamed the binary to `zrok2` (and `~/.zrok` to `~/.zrok2`)
  so v1 and v2 can coexist, and replaced reserved shares with namespaces and
  names: `zrok2 create name -n public <name>`, then `zrok2 share public <target>
  -n public:<name>`. The v1 line still ships. (Two CHANGELOG reads; §7.)
- **Hostname:** `https://<name>.share.zrok.io`, stable across runs. Custom
  domains need a paid myzrok.io plan.
- **TLS:** **zrok's public frontend** (NetFoundry) terminates TLS and can read
  the traffic. Private shares are end to end but need zrok on the visitor's
  device — no use to a phone browser.
- **Warning page:** shown on the free plan to browsers (a `User-Agent` starting
  `Mozilla/5.0`) on first visit, resetting weekly; `skip_zrok_interstitial`
  skips it for clients that can set headers (a Safari navigation cannot). The
  pricing page: "No Interstitials with Verified Credit Card".
- **Cost:** free — "5 Daily GB" (rolling 24 h), 25 environments, 50 shares, no
  card. Paid options are through NetFoundry sales.
- **Tooling:** the Go CLI (Apache-2.0) from GitHub releases or Homebrew; a Go
  SDK; `@openziti/zrok` on npm (last published before v2; internals unverified).
  **Bundle the CLI.** Whether the macOS binaries are notarized is unverified —
  Metistry re-signs them anyway.
- **Self-hosting:** a controller and public frontend on the owner's own host
  (wildcard DNS and certificate) — an option for owners who run their own; not
  automated.
- **Failures and wording:** 401 `enableUnauthorized` — *"zrok didn't accept the
  account token. Copy it again from zrok.io."*; name taken — *"<name> is taken on
  zrok. Choose another."*; the daily limit — *"Your zrok plan's daily limit is
  used up. Your phone can't reach this Mac until it resets."* Hosted-service 500s
  and 429s are reported: retry with backoff, and clean up idempotently.
- **Removal:** stop the share, delete the name, `disable` the environment.

### 3.5 ngrok

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
- **The agent is closed-source**, and ngrok's terms let a developer distribute
  it to "customers who maintain their own accounts with ngrok" only "subject to
  ngrok's prior written consent", so Metistry **cannot bundle it**: the owner
  installs it (`brew install ngrok`, or ngrok's zip). The alternative is the
  `@ngrok/ngrok` SDK (MIT or Apache-2.0, a native Rust addon; authtoken only;
  forwards to `unix:` sockets) or `ngrok-go` — a dependency (U5), and whether
  the consent clause reaches an embedded SDK is unverified (§7).
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

### 3.6 Port forwarding

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

### 3.7 Bundling and installing provider tools (ruled allowed 2026-09-30)

Metistry already ships a pinned, signed runtime pack (`docs/ops/bundled-runtime.md`):
each component pinned by version **and sha256**, every Mach-O signed with FSL's
Developer ID and the hardened runtime in CI, fetched and unpacked by
`runtime-deps.ts`'s verify-then-unpack code, moved forward by `metistry update`.
Provider tools ride the same channel as **one pack per tool, fetched only when
the owner picks that provider** — nothing extra in the DMG.

| Tool | Licence | Source for the pack | Notes |
| --- | --- | --- | --- |
| `tailscaled` + `tailscale` | BSD-3-Clause | built from a pinned upstream tag | Go; arm64 Go binaries are ad-hoc linker-signed, re-signed by FSL |
| `cloudflared` | Apache-2.0 | the official `darwin-arm64` release binary (SHA-256 published per release) | upstream notarization was attempted and reverted in early 2026, so the binary is likely only ad-hoc signed — FSL re-signs it; releases land every one to two weeks; the token goes in by `TUNNEL_TOKEN` or `--token-file`, never argv |
| zrok CLI | Apache-2.0 | the official release binary | signing unverified; FSL re-signs |
| ngrok agent | proprietary | **not bundled** | the owner's install, or the SDK (owner's call) |
| port forwarding | — | in-process code | NAT-PMP/PCP/UPnP and ACME: dependencies still open |

A tool unpacked by `tar` from the CLI carries no quarantine attribute, so
Gatekeeper does not assess it; the FSL signature is for attribution and for a
later DMG that embeds it. The Tailscale *app*, if an owner wants it instead,
cannot be installed silently: its extension and VPN configuration need the
owner's approval in System Settings — so the bundled node is the ease win.

### 3.8 The guided flow, and proving the phone can reach the Mac

The wizard's *Set Up Remote Access*: choose (Funnel recommended) → fetch the
pack → open the provider's sign-up or sign-in page and **detect completion**
(`BackendState` = `Running`, the OAuth callback, a token that enables) → show the
provider's own one-click approvals → expose → check → only then Add a Phone.

**Reachability without an FSL or third-party probe.** Three signals, in
increasing strength:

1. **The provider's own status** — `tailscale funnel status`, the tunnel's
   connections, the zrok share, the ngrok endpoint. Says the provider is
   carrying it, not that the internet reaches it.
2. **`GET <origin>/health` from the Mac**, returning this instance's
   `instance_id`. Through Cloudflare, zrok and ngrok this goes out to the edge
   and back, a real public path. Through Funnel it is real when the Mac
   resolves the name publicly, but a Mac running the Tailscale app with
   MagicDNS reaches it over the tailnet instead; through port forwarding it
   depends on hairpin NAT. So it is reported as *"answers from this Mac"*.
3. **The phone itself.** The Add a Phone QR is the test: when the phone opens
   the link, its `POST /auth/enroll/start` arrives through the proxy listener,
   and the console stamps the code (`opened_at`, `opened_via`). The sheet shows
   *Opened on your phone* — proof from outside, over the phone's real network,
   with no service in between (plan X-114).

### 3.9 Metistry Relay — opt-in, capped, on AWS (ruled 2026-09-30)

A third ruling the same day asked for one FSL-hosted provider after Funnel, for
owners who will not make a Tailscale account, on terms that keep FSL's bill
flat: **AWS only**, a **per-host bandwidth limit** as the cost guard, and
`metistry.app` on the **Public Suffix List** with abuse controls. It replaces
§6's "rejected" framing **for this capped variant only**; the WebRTC rendezvous,
an uncapped SNI relay and FSL-paid TURN stay rejected. Plan §2.24 is the spec.

**Shape.**

```
 iPhone (Safari) ──TLS for <id>.u.metistry.app──► Lightsail relay ──same TLS, unopened──► Mac
                                                (SNI → tunnel)       (tunnel dialled OUT by the Mac;
                                                                      the Mac terminates TLS)
```

- **Data plane:** one Lightsail Linux instance with a static IP running an
  SNI-routing **TLS-passthrough** relay — frp's `https` vhost mode, or HAProxy
  `ssl_preread` plus a reverse-tunnel client (the PoC decides). It never
  decrypts. The Mac's bundled client holds the tunnel outbound, so CGNAT does
  not matter, and the Mac serves TLS itself with its own Let's Encrypt
  certificate for `<id>.u.metistry.app`. The phone needs nothing.
- **Control plane:** API Gateway HTTP API + Lambda + DynamoDB in FSL's account,
  in CDK: opt-in registration (an opaque `<id>`, a revocable relay token),
  per-id usage, revoke and a kill switch, and an ACME DNS-01 helper that writes
  only `_acme-challenge.<id>.u.metistry.app` in the Route 53 zone `metistry.app`
  for the authenticated id. `*.u.metistry.app` points at the relay's static IP;
  the apex and `www` keep redirecting to metistry.ai.

**Lightsail's numbers** (pricing page, checked 2026-09-30): Linux bundles at
**$5 (1 TB transfer), $7 (2 TB), $12 (3 TB)**; "Static IP address … Included in
all Lightsail plans"; "Both inbound and outbound data transfer count towards
your data transfer allowance"; excess outbound is **$0.09/GB** in US regions.
A relayed byte enters and leaves the box, so it **counts twice**: the $7
bundle's 2 TB carries about **1 TB relayed**.

**Cost guards.** (1) A per-host monthly cap, default 5 GB relayed, after which
the relay refuses new sessions for that id until the month resets — said in the
product as *"This Mac has used its 5 GB relay allowance for September; it resets
on 1 October. Tailscale Funnel has no allowance."* (2) A per-host throttle of
about 2 Mbps. (3) A global monthly cap at ~90% of relayed capacity, **≈ 0.9 TB**
on the 2 TB plan, so the bill stays at $7. (4) An AWS Budgets alert at $10 and an
optional stop Lambda. (5) Per-day registration limits.

**Capacity** (my estimate, to be measured): at ~200 MB relayed per owner per
month, 0.9 TB carries **≈ 4,500 owners** per $7 box. A heavy owner hits the
5 GB cap long before the box fills — 180 owners at their cap would fill it,
which is what the global cap is for. Growth is a deliberate step ($12/3 TB, or a
second instance), never automatic overage.

**Owner names under `u.`, and the Public Suffix List.** Owner hostnames are
`<id>.u.metistry.app`, so FSL's own names (`metistry.app`, the planned
`auth.metistry.app`) never share a parent with an owner's. Let's Encrypt allows
"up to 50 certificates … per registered domain … every 7 days" and uses the PSL
to decide what a registered domain is (rate-limits page, checked 2026-09-30).
The PSL entry is for **`u.metistry.app`**: with it listed, the registered domain
of `<id>.u.metistry.app` is that name itself, so **each owner gets their own 50
a week — the limit is still lifted** — and owners' cookies and passkey rpIDs are
isolated from each other. Without the entry every owner's certificate counts
against `metistry.app`'s 50 a week. Inclusion is permanent and takes weeks, so
registrations are capped at about 40 a week until it lands.

**Disclosure without a banner.** The relay cannot inject a "this is user
content" banner — it never sees the plaintext, which is the point. Instead, a
plain page at `https://metistry.app` (and `u.metistry.app`) says that names under
`u.metistry.app` are run by individual Metistry owners on their own Macs, not by
Folded Space Labs, with an abuse report link. Today the apex 301s to
metistry.ai; changing that is a follow-up for the metistry-website infra when
the relay ships.

**What FSL sees:** SNI hostnames (opaque ids), IP addresses, timing and volume —
never content. Each id's certificate appears in Certificate Transparency logs,
which is why the id is opaque and never `instance_id`.

**Trade-offs.** A single instance is a single point of failure (snapshots, a
scripted rebuild). FSL operates a service and an abuse contact. **CloudFront's
flat-rate plans** were considered and rejected: CloudFront must terminate TLS,
so FSL would see the traffic. Other hosts were not considered: the owner ruled
AWS only.

**PoC first.** One $7 box and two FSL instances for a month: relayed bytes per
owner, SSE (`GET /api/events`) held open through the relay, reconnect after the
Mac sleeps, and the throttle's effect on the PWA — before the relay is offered
to anyone else.

## 4. The common shape

- **The record.** `.metistry/deployment.yaml` `remote:` — provider, origin, and
  non-secret settings (tunnel id, hostname) — written through the protected
  write, like keep-awake. Credentials (OAuth refresh token, API token,
  authtoken, DDNS token, ACME account key, `cert.pem`) live in the login
  Keychain. The bundled Tailscale node keeps its machine key in its own state
  directory (0700); the owner's app keeps its own.
- **The origin.** The environment renderer puts the remote origin first in
  `METISTRY_ORIGIN` and keeps the loopback origin second, so `metistry enroll`
  (which mints for the first entry) and the Add a Phone QR pick it up unchanged,
  and the Mac's own browser keeps working. With §2(b) fixed, each origin gets
  its own rpID.
- **Switching.** Configure the new provider, wait for its origin to answer,
  then revoke the old one. Passkeys created for the old hostname stop working
  — unavoidable, since the rpID is the hostname — and Devices marks them.
- **Supervision.** The Tailscale node, `cloudflared`, the zrok share, the ngrok
  forwarder and the port-forward renewer
  are supervised jobs under the launchd shape (`metistry restart <service>`
  works on them). Under `shape: compose` the proxy listener is a second
  published port; the provider's agent still runs on the host.
- **The Mac app** drives every step through the CLI transport (§2.2): the
  wizard's question and Settings ▸ Remote Access are views over `metistry
  remote`.

## 5. Recommended order, and why

1. **The two fixes and the hardening** (§2; plan X-103, X-104, X-111) — the
   gaps are bugs whatever the owner picks, and the recommended default is
   public.
2. **None + Tailscale (Funnel and tailnet)**, with the tool packs, the guided
   flow and *Opened on your phone*. Funnel removes the phone's app and VPN while
   TLS stays on the Mac; the bundled node removes the Mac app; PoC-6 proved the
   Serve path; the owner's only steps are Tailscale's own.
3. **Metistry Relay** (§3.9) — for owners who won't make a Tailscale account:
   no account, and the relay cannot read the traffic. After Funnel because
   Funnel costs FSL nothing and needs no FSL service, while the relay is capped,
   operated, and gated on its PoC and the PSL entry.
4. **Cloudflare Tunnel** — no warning page, the owner's own domain, a browser
   sign-in (possibly real OAuth), a bundleable agent; but the domain is a
   prerequisite and Cloudflare reads the traffic.
5. **zrok** — open source, bundleable, self-hostable, 5 GB a day free, and a
   warning page removable by verifying a card; ahead of ngrok on everything but
   maturity (hosted-service 500s and 429s are reported).
6. **ngrok** — a pasted token, a closed agent Metistry cannot bundle, 1 GB a
   month free, and a warning page only a paid plan removes.
7. **Port forwarding last** — the most code, the most exposure (the home address
   in public DNS), dependencies to approve, and impossible behind CGNAT.

The owner's suggested order is kept as is; nothing in the research argues for
moving zrok ahead of Cloudflare: Cloudflare's lack of a warning page matters
more to a Home Screen app than zrok's no-domain convenience.

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
reason rules out an **uncapped** TLS-passthrough SNI relay (about $900/month of
egress at 10,000 owners by my estimate) and FSL-paid TURN. A later ruling the
same day accepts a **capped** SNI relay on a flat-priced Lightsail bundle — §3.9,
the Metistry Relay — because its caps keep FSL's bill fixed.

**Relay sub-paths with one shared certificate** (`metistry.app/user/<id>`,
asked by the owner and rejected 2026-09-30). Three reasons, each sufficient:

1. **The relay would have to decrypt.** The path is inside the TLS stream; only
   the SNI hostname is visible to a passthrough relay. Routing by path means FSL
   terminates TLS and can read every owner's traffic, session cookies included —
   the end-to-end property §3.9 exists for is gone. Keeping TLS on the Macs
   instead would mean **one certificate's private key on every Mac**: any owner
   could impersonate `metistry.app` and intercept others, and once a key is known
   to be compromised the CA must revoke the certificate within 24 hours (the
   CA/Browser Forum Baseline Requirements' key-compromise rule, §4.9.1.1 — stated
   from secondary sources checked 2026-09-30, not quoted from the BR text), which
   would take every owner down at once.
2. **One origin isolates nothing.** Every owner would share cookies, storage,
   service workers and script. A page served from one owner's Mac could make
   same-origin requests to `/user/<victim>/api/...` carrying the victim's session;
   every passkey would share the rpID `metistry.app`; and iOS Home Screen apps on
   one origin share storage.
3. **A wildcard certificate on the relay** has the decryption problem of (1).

Per-owner names under `u.metistry.app`, each with the Mac's own certificate, are
the design (§3.9).

**Quick Tunnels** (`trycloudflare.com`) and any random-URL tunnel: the hostname
changes on every run, which breaks every passkey; Cloudflare's also lack SSE.

*Bundling a VPN client* was listed here on the first revision; the follow-up
ruling reverses that — with Funnel the iPhone needs no app, and a bundled
userspace node needs no Mac app (§3.2). Only the tsnet *helper* variant stays
unrecommended (it adds FSL-written Go).

## 7. To verify hands-on before the tickets rely on it

Numbered as plan §2.23's R-list.

1. **R-1 Cloudflare OAuth:** register a private PKCE client; confirm a loopback
   redirect is accepted and that tunnel and DNS permissions are grantable
   scopes (`GET /client/v4/oauth/scopes`). Then decide public vs `tunnel login`.
2. **R-2 Cloudflare Access + PWA:** manifest fetch, cookie expiry in standalone
   mode, and a passkey ceremony behind Access, on a real iPhone.
3. **R-3 ngrok:** the free warning page on a Home Screen app's first launch, its
   7-day cookie in standalone storage, and `GET /api/events`; whether ngrok's
   consent clause covers an SDK embedded for users with their own accounts;
   whether SDK sessions count as agents on the free plan.
4. **R-4 Port forwarding:** PCP/NAT-PMP/UPnP on the owner's router and one CGNAT
   line (T-Mobile Home Internet or Starlink) to confirm the refusal.
5. **R-5 zrok:** the `zrok2` binary and v2 commands; SSE through a public share;
   the warning page on a Home Screen app; whether the release binaries are signed.
6. **R-6 Tailscale node and Funnel:** upstream `tailscaled` built for macOS and
   run unprivileged with `--tun=userspace-networking`, serving Funnel to the
   proxy port, beside an installed Tailscale app; the exact output when Funnel
   or HTTPS is not yet allowed (prefer a status field over scraping prose);
   whether a new tailnet's default policy grants `funnel`; `GET /api/events` held
   open through Funnel; node key expiry's effect on Funnel; pack sizes.
7. **R-7 Metistry Relay PoC:** relayed bytes per owner per month, SSE through
   the relay, reconnect after sleep, the throttle's effect, and the relay
   component (frp vs HAProxy + a tunnel client).
8. **Signing:** `codesign -dv` on each upstream binary before the first pack, and
   that the re-signed `cloudflared`, `tailscaled` and zrok run under the hardened
   runtime with no entitlements.

## 8. Website copy

The metistry.ai Download page marks step 1 BEING DESIGNED. Once None and
Tailscale ship, it can say what is true:

> **Let your phone reach your Mac.** Metistry answers only on your Mac until you
> choose a way in. When you set it up, Metistry recommends Tailscale Funnel —
> free, encrypted all the way to your Mac, and nothing to install on your phone
> — and sets it up for you; Cloudflare, zrok, ngrok or your router work too. You
> can change it later in Settings.

Name only the providers that have shipped at the time.

## Sources

**Fetched 2026-09-30, Metistry Relay** (§3.9):

- Lightsail pricing (bundles, static IP, both directions count, overage) — <https://aws.amazon.com/lightsail/pricing/>
- Let's Encrypt rate limits (50 per registered domain per 7 days; the PSL) — <https://letsencrypt.org/docs/rate-limits/>
- Public Suffix List guidelines (private-section requests) — <https://github.com/publicsuffix/list/wiki/Guidelines>
- CA/Browser Forum Baseline Requirements (§4.9.1.1, key-compromise revocation within 24 hours; the fetched page did not include §4.9) — <https://cabforum.org/working-groups/server/baseline-requirements/requirements/>; secondary summaries — <https://www.digicert.com/blog/a-guide-to-tls-certificate-revocations>, <https://www.ssl.com/faqs/compromised-private-keys/>

**Fetched 2026-09-30, follow-up** (§3.2 Funnel and the node, §3.4 zrok, §3.5, §3.7):

- Tailscale Funnel — <https://tailscale.com/kb/1223/funnel>; Funnel CLI — <https://tailscale.com/docs/reference/tailscale-cli/funnel>; Serve (identity headers absent on Funnel; one port per Serve or Funnel) — <https://tailscale.com/docs/features/tailscale-serve>
- tsnet (`ListenFunnel`, login fallback) — <https://pkg.go.dev/tailscale.com/tsnet>, <https://tailscale.com/docs/features/tsnet>, examples — <https://github.com/tailscale/tailscale/tree/main/tsnet/example>
- Userspace networking — <https://tailscale.com/kb/1112/userspace-networking>; unprivileged `tailscaled` on macOS (secondary) — <https://dev.to/devlog/running-tailscale-without-sudo-the-userspace-networking-trade-offs-nobody-mentions-16a3>
- macOS variants and the standalone `.pkg` — <https://tailscale.com/kb/1065/macos-variants>; system-extension approvals — <https://tailscale.com/docs/concepts/macos-sysext>
- Serve WebSocket drops — <https://github.com/tailscale/tailscale/issues/18827>
- zrok pricing — <https://zrok.io/pricing/>; CHANGELOG (v2: `zrok2`, names) — <https://github.com/openziti/zrok/blob/main/CHANGELOG.md>; releases — <https://github.com/openziti/zrok/releases>; names and namespaces — <https://netfoundry.io/docs/zrok/concepts/namespaces/>; public shares — <https://netfoundry.io/docs/zrok/concepts/sharing-public/>; v1→v2 migration — <https://netfoundry.io/docs/zrok/how-tos/migration/migrate-v1-to-v2/>; agent — <https://netfoundry.io/docs/zrok/1.0/guides/agent/>; custom domains — <https://netfoundry.io/docs/zrok/myzrok/custom-domains/>; the interstitial — <https://blog.openziti.io/zrok-is-growing-up>, <https://github.com/openziti/zrok/issues/777>; TLS at the frontend — <https://openziti.discourse.group/t/e2e-tls-termination/4611>; Node SDK — <https://www.npmjs.com/package/@openziti/zrok>
- cloudflared releases and checksums — <https://github.com/cloudflare/cloudflared/releases>; licence — <https://github.com/cloudflare/cloudflared/blob/HEAD/LICENSE>; reverted notarization (secondary: a CI run) — <https://github.com/cloudflare/cloudflared/actions/runs/21210897471>; run parameters (`TUNNEL_TOKEN`, `--token-file`) — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/>
- ngrok JavaScript SDK (MIT/Apache-2.0) — <https://github.com/ngrok/ngrok-javascript>; `forward()` — <https://ngrok.github.io/ngrok-javascript/functions/forward.html>; ngrok-go — <https://pkg.go.dev/golang.ngrok.com/ngrok/v2>; terms (agent redistribution) — <https://ngrok.com/tos>; macOS download — <https://ngrok.com/download/mac-os>
- Apple: embedding a helper tool — <https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app>; placing content in a bundle — <https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle>; quarantine — <https://developer.apple.com/forums/thread/683551>

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
