# Remote access — how your phone reaches this Mac

Every install starts **loopback-only**: the console binds `127.0.0.1`, `init`
writes `METISTRY_ORIGIN=http://127.0.0.1:<port>`, and nothing outside this
Mac can open it. A phone needs an HTTPS origin with a stable name before it
can hold a passkey (`docs/ops/auth.md`, "Passkeys: origins"), so *Add a
Phone* refuses until one exists — naming **Settings ▸ Remote Access** on the
Mac and `metistry remote` in a terminal.

The owner picks **how** (plan §2.23, ruled 2026-09-30): a provider, chosen at
setup and changeable later, each made as close to *sign in, authorize, done*
as the provider allows. This page is the CLI half — the record, the verbs,
the adapter — and what every provider shares. Each provider's own page lands
with its ticket.

## The choices

In this order wherever they are listed. **None** is the default; **Tailscale —
Any browser (Funnel)** is the recommended path.

| Choice | Reachable from | TLS ends at — who can read traffic | Origin it yields | Cost | Ticket |
| --- | --- | --- | --- | --- | --- |
| **None** *(default)* | this Mac only | — | — (`METISTRY_ORIGIN` stays loopback) | $0 | **this one** |
| **Tailscale — Any browser (Funnel)** *(recommended)* | the internet; the phone needs no app | the Mac | `https://<node>.<tailnet>.ts.net` | $0 | **shipped** (X-106, below) |
| **Tailscale — Only my devices** | the owner's tailnet; the phone needs the Tailscale app | the Mac | same name | $0 | **shipped** (X-106, below) |
| **Metistry Relay** | the internet; no account anywhere | the Mac (the relay passes TLS through unopened) | `https://<id>.u.metistry.app` | $0 — 5 GB a month | X-115… |
| **Cloudflare Tunnel** | the internet | Cloudflare | `https://<name>.<owner's domain>` | $0 + a domain | X-108 |
| **zrok** | the internet | zrok's frontend | `https://<name>.share.zrok.io` | $0 (5 GB/day; a warning page unless a card is verified) | X-113 |
| **ngrok** | the internet | ngrok | `https://<dev-domain>.ngrok-free.dev` | $0 with a weekly warning page | X-109 |
| **Port forwarding** | the internet | the Mac | `https://<name>.dedyn.io[:port]` | $0; impossible behind CGNAT | X-110 |

`metistry remote --json` lists them with `available: true` on the ones this
release has an adapter for. Until a provider's ticket ships, `metistry remote
set <provider>` says so and changes nothing.

### None

Nothing is exposed. `METISTRY_ORIGIN` is the loopback origin alone, the
console's proxy listener answers for no host, and there is no PWA, no web
push and no capture Shortcut from the phone. *Add a Phone* refuses with
*"Your phone can't reach this Mac yet: Metistry only answers on this Mac.
Choose how your phone reaches it in Settings ▸ Remote Access."*

A **home-network-only mode is not offered**: a passkey needs HTTPS and a
stable name, which a LAN address lacks.

Doctor's row is one `ok` line — *"Remote access: none. Your phone can't reach
this Mac. Choose a way in Settings ▸ Remote Access."* — because an install
that exposes nothing is correct.

### Tailscale

Two modes of one provider (plan §2.23, X-106). **Funnel** — the default and
the recommended path — publishes `https://<node>.<tailnet>.ts.net` to the
internet through Tailscale's relays, which carry only ciphertext: TLS ends on
this Mac, and the phone needs **no app**. **Tailnet** (`--mode tailnet`,
`tailscale serve`) gives the same name to the owner's own devices only, each
running the Tailscale app; the Add a Phone sheet adds *"Your phone must be
signed in to the same Tailscale account."* Funnel listens on 443 (Tailscale
allows 443, 8443 and 10000), so the origin is a bare name.

```
metistry remote set tailscale [--mode funnel|tailnet] [--use-app|--bundled] [--no-browser] [--yes]
metistry remote authorize tailscale [--no-browser] [--timeout 300]
```

**The node — two sources, one switch.** The node that joins the tailnet is one
of:

| | the bundled node (`--bundled`) | the owner's app (`--use-app`) |
| --- | --- | --- |
| what runs | X-112's pack: upstream `tailscaled` + `tailscale`, built from a pinned tag, **unprivileged**, `--tun=userspace-networking`, `--port=0` (never the app's 41641) | the Tailscale app (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`) or a `tailscale` install, driven through its CLI |
| its state | the machine key in `<instance>/.metistry/state/tailscale/` (**0700**); its socket `state/run/tailscaled.sock`, beside Postgres's and the supervisor's, held to the same 103-byte limit | the app's own |
| its name | `metistry-<first 8 hex of instance_id>` — renaming the Mac changes nothing | the Mac's name — a rename changes the origin, and doctor says so |
| how it runs | its own launchd job, `com.foldedspacelabs.metistry[.<suffix>].tailscale` (KeepAlive, log `/tmp/metistry[-<suffix>]-tailscale.log`), written by `set` and removed by `off` — not a supervisor child, because it must run before `metistry up` ever has (the owner signs in through it first) and under both shapes | the app's |
| what the owner installs | nothing | the app, and its approvals in System Settings |

With neither flag, **the owner's app is preferred when it is running**, else the
bundled node; the choice is recorded as `settings.node_from`, and `status`
and `revoke` act on that node and never on the other. (Whether to offer the
bundled node at all was a pending owner question — §2.23 "Open for the owner"
1 — so both paths ship behind the switch; the default can move with the
ruling.) Both flags together are refused. On a platform without launchd the
bundled node is refused by name and `--use-app` is the way.

**What `set` does, in order** (the guided flow's steps 2–6):

1. **Funnel only: the X-111 gate.** `GET http://127.0.0.1:<proxy port>/health`
   must answer with the proxy listener's security headers
   (`Strict-Transport-Security` is the marker). A console that does not —
   an older release, or nothing listening — is refused before anything is
   fetched, started or opened: *"…isn't the hardened proxy listener — its
   answers carry none of the rate-limit headers Funnel waits on (plan §2.23,
   X-111). `metistry update` then `metistry up`, or choose `--mode
   tailnet`."* Tailnet mode is not gated; it is not on the internet.
2. **The node.** The pack is fetched if absent (`ensureRemotePack`; a
   checksum mismatch fails here, see "The tool packs"), the state directory is
   made 0700, the launchd job written and bootstrapped, and the node waited
   for on its socket. With the app: its CLI is found; nothing is installed.
3. **Sign in.** `tailscale up --json --timeout=10s [--hostname=metistry-…]`
   hands back Tailscale's own login URL; it is opened in the browser (printed
   with `--no-browser`) and **completion is read from `BackendState`**
   reaching `Running` — Metistry never sees a Tailscale credential, and
   nothing the owner types reaches this flow. A sign-in that does not finish
   in five minutes fails `set` (nothing written); `metistry remote authorize
   tailscale --timeout <s>` waits again. MagicDNS off (no `Self.DNSName`)
   is refused naming the admin console's DNS page.
4. **Approve, then expose.** `tailscale funnel --bg --https=443
   http://127.0.0.1:<proxy port>` (`serve` in tailnet mode). Each approval
   page Tailscale offers — *enable HTTPS*, *enable Funnel* — is surfaced as
   the one step, opened once, and the command retried every few seconds until
   the approval has landed (five minutes, then `set` fails naming the link).
   The handler is then read back from `funnel status --json`: it must forward
   `<name>:443` to the proxy port — anything else, the main port included,
   fails `set` before a record exists.
5. **The public name.** Funnel only: *"Waiting for <name> to appear on the
   internet — this can take up to 10 minutes."* — public DNS polled until it
   resolves (Tailscale's own number).
6. Then `set`'s own wait for `GET <origin>/health` from this Mac, the
   protected write of the record, and the old provider's revoke — "Switching",
   below. (A first `set` reaches the console before `up` has rendered the
   new origin into `METISTRY_ORIGIN`; the proxy listener answers `421`,
   which is an answer — the tunnel reaches this Mac — and `metistry up` then
   admits the host.)

The record it writes:

```yaml
remote:
  provider: tailscale
  mode: funnel
  origin: https://metistry-a1b2c3d4.tail1234.ts.net
  settings:
    handler: "metistry-a1b2c3d4.tail1234.ts.net:443"
    node: "metistry-a1b2c3d4"
    node_from: "pack"            # or app
    upstream: "http://127.0.0.1:8081"
```

**Doctor rows** (kind `remote`, after the three shared rows), each a
sentence in the product's voice with the fix; the bundled node's rows carry
`metistry remote set tailscale` or `metistry remote authorize tailscale` as
their button:

| row | ok | otherwise |
| --- | --- | --- |
| `remote:tailscale:node` | the node's CLI answers and `BackendState` is not `Stopped`/`NoState` | `failed` — *"This Mac's Metistry node isn't running. Run `metistry remote set tailscale` to start it."* / app: *"Tailscale is installed but not connected. Open Tailscale and turn it on."* |
| `remote:tailscale:signed-in` | `Running` | `NeedsLogin` → `failed` *"This Mac's Metistry node isn't signed in to Tailscale. Sign in again (`metistry remote authorize tailscale`)."* (app: *"…Sign in from the Tailscale menu."*); `NeedsMachineAuth` → `degraded` *"…waiting for approval in your Tailscale admin console (Machines)."*; `Starting` → `degraded` |
| `remote:tailscale:state-dir` (bundled) | `state/tailscale/` exists, mode 700 | `failed`, naming the mode and `chmod 700` |
| `remote:tailscale:https` | MagicDNS names the node and the `https` capability is held | *"MagicDNS is off for your tailnet, so this Mac has no name. Turn it on in the Tailscale admin console, DNS page."* / *"HTTPS certificates are off for your tailnet. Open the link Tailscale gave to allow them…"* |
| `remote:tailscale:funnel` (funnel) | the `funnel` capability is held and `AllowFunnel[<name>:443]` is on | `failed`, naming the approval link or the policy file's `funnel` attribute |
| `remote:tailscale:handler` | the LIVE serve config forwards `<name>:443` to the proxy listener | **`failed` at the main port** with §2.23's sentence (*"tailscale is forwarding to the console's main port…"*); absent → *"Tailscale isn't forwarding to Metistry."*; a name that no longer matches the recorded origin → *"This Mac's Tailscale name changed from <old> to <new>. Phones added under the old name must be added again…"* |
| `remote:tailscale:public-name` (funnel) | the name resolves in public DNS from this Mac | `failed` — up to 10 minutes after Funnel is turned on |
| `remote:tailscale:key-expiry` | more than 14 days away, or disabled | `degraded` within 14 days (*"This Mac's Tailscale key expires on <date>…"*), `failed` once past |

The shared `proxy-listener` row reads the **record's** upstream; the
`handler` row reads the **live** config — so a handler someone re-pointed by
hand at the main port fails doctor even beside a record that says the proxy
port.

**Revoke** (`metistry remote off`, or a switch to another provider once its
origin answers). Bundled node: `tailscale serve reset` (the handler),
`tailscale logout` (the node key is revoked), the launchd job booted out and
its plist removed, the state directory removed; **left for the owner:** the
node's entry in the Tailscale admin console (Machines). Owner's app: only the
handler Metistry added is turned off (`tailscale funnel|serve --https=443
off`) — the app stays signed in and nothing is stopped; §2.23's "logs the node
out" is read as the bundled node's, since logging an owner out of their own
Tailscale would undo far more than `configure` created.

**What is not here.** No HTTP route: the verbs are the owner's hand, as for
every provider. No `Tailscale-User-*` header is read for identity anywhere
(Funnel carries none; the passkey stays the door). Streaming through Funnel
(`GET /api/events`) is R-6's hands-on check, not a test here.

## The record

The choice lives in the instance's `.metistry/deployment.yaml`, beside
`shape:`, `keep_awake:` and `vault:`:

```yaml
remote:
  provider: tailscale        # none | tailscale | relay | cloudflare | zrok | ngrok | port-forward
  mode: funnel               # where a provider has modes (Tailscale: funnel | tailnet)
  origin: https://mac.tail1234.ts.net
  settings:                  # non-secret, recorded by the adapter
    upstream: "http://127.0.0.1:8081"   # where it forwards to — the proxy listener, never the main port
    node: "metistry-abc123"
```

An absent block is `none`. **No credential is in this file** — each lives
where its provider's adapter says (the Keychain, a 0700 state directory). The
file is a §4.7 protected path, so the verb writes it the way `deployment
set-keep-awake` and `vault settings` write theirs: through the reconciler as
`user`, preview first, `--yes` to write. Core's schema is strict (an unknown
key, a `none` that claims an origin, an origin with a path are all refused),
and the instance's block wins **whole** over the seed's — a provider is one
decision, never a merge of keys.

## How the origin flows

`metistry up` **derives** `METISTRY_ORIGIN` from the record rather than
reading it from `.env` (`packages/cli/src/origins.ts`, `renderOrigins`):

- with a provider: **the remote origin first**, the loopback origin `init`
  wrote second — so `metistry enroll` and the Add a Phone QR, which mint for
  the first entry, use the remote origin with no change to their spec;
- with **None: the loopback origin alone**.

A non-loopback entry someone wrote into `.env` beside `remote: none` is
**not carried**: `up` says so in its plan, and doctor carries a `degraded`
`remote:origins` row with the same sentence — the console does not answer
for that origin, and **passkeys added at it no longer sign in**. There is no
supported way to serve such an origin by hand — a tunnel to the console's
main port is exactly the configuration the proxy listener closed, and it is
not honoured; remove the entry from `.env`, or run `metistry remote set
tailscale` (or another provider). That is deliberate: a
hand-written remote origin with a proxy pointed at the console's main port is
the configuration X-103 found unsafe — the main listener honours this Mac's
owner token for anything a tunnel carries. The record is the one way a remote
origin is configured, and `metistry remote set` is the one way to write it.
**This closes the manual `tailscale serve → 8080` gap**: a tunnel to the main
port is no longer a working configuration, and the provider adapters point
only at the proxy listener.

Under the `compose` shape the rendered value reaches `docker-compose.yml`'s
`${METISTRY_ORIGIN}` through the process environment `up` runs compose with,
which compose reads before `--env-file`; under `launchd` it is in the
console's job environment and `supervisor.json`, like every other
`METISTRY_*`.

**Changing provider strands the phones added under the old one**: a passkey
is bound to the host it was created on (`docs/ops/auth.md`). The preview says
so before anything changes; Devices marks each passkey whose host is no
longer configured.

## The proxy listener

Every provider's agent connects to the console from `127.0.0.1`. On the
console's **main** listener that is indistinguishable from the Mac app, and
the loopback-only `METISTRY_LOCAL_OWNER_TOKEN` would be honoured for anything
arriving through the tunnel. So the console has a second listener **for
proxies only** (X-103; `docs/ops/auth.md`, "The proxy listener"): the Unix
socket `<instance>/.metistry/state/console-proxy.sock` (0600) and the
loopback TCP port `METISTRY_CONSOLE_PROXY_PORT` (the console port + 1, or a
namespaced block's slot). A request there is **remote by construction** —
the token is never honoured, no `local` route answers, and the `Host` must be
a remote host `METISTRY_ORIGIN` names.

An adapter's `configure` points the provider at one of these two and records
it as `settings.upstream`. **Doctor fails any provider whose upstream is the
main port**, by name: *"<provider> is forwarding to the console's main port,
which accepts this Mac's owner token. Run `metistry remote set <provider>`."*

## The verbs

These verbs are the **owner's hand only**: the CLI runs as the person at the
Mac, the assistant has no shell and no raw git (invariant 9) so it can never
run them, and this ticket adds **no HTTP route** — nothing the console serves
can change the record or reach a provider. The Mac app drives the same verbs
over the CLI transport (plan §2.2, M20).

Every verb takes `--instance <dir>` and `--json`; the writing ones preview
without `--yes` (`--dry-run` is the same preview, and wins over `--yes`).

| App | CLI |
| --- | --- |
| the pane's status | `metistry remote [status] [--json]` — the record, the origins it renders, the chooser, doctor's `remote` rows; exit 1 when a row fails |
| the guided flow, a provider picked | `metistry remote set <none\|tailscale\|relay\|cloudflare\|zrok\|ngrok\|port-forward> [provider flags] [--yes] [--timeout <seconds>]` |
| a provider's browser sign-in | `metistry remote authorize <tailscale\|cloudflare> [--no-browser] [--timeout 300]` |
| a pasted token | `metistry remote set zrok\|ngrok`, `metistry remote set cloudflare --token` — **on stdin**, or typed hidden at a prompt in a terminal; **never in argv** |
| Test | `metistry remote test [--json]` — the provider's own state, then `GET <origin>/health` from this Mac naming this instance |
| Turn Off | `metistry remote off [--yes]` — `set none`, with the old provider's revoke |

Provider flags: `tailscale [--mode funnel|tailnet] [--use-app|--bundled]
[--no-browser]`; `cloudflare
--hostname <name.domain> [--access] [--token]`; `zrok [--name <name>]`;
`ngrok [--domain <name>]`; `port-forward [--ddns desec|cloudflare]
[--hostname <name>] [--manual <external-port>]`.

**A token never arrives as an argument.** `--token` is a switch meaning
*read it from stdin*; a value given after it (`--token abc`, `--token=abc`)
or pasted after the provider's name is refused with exit 2 and **is not
echoed** — the refusal names the pipe and the prompt as the only ways in. The
reader is the one `secrets set` uses (`packages/cli/src/stdin-value.ts`).

### Switching — the one rule

`metistry remote set <provider> --yes` does, in this order:

1. **configure** the new provider (idempotent; a throw changes nothing and
   writes nothing — *"<provider> could not be set up (…) — nothing was written
   and <old> is still in place"*);
2. **wait** for the new origin to answer from this Mac — `GET
   <origin>/health`, and `/api/identity` naming this instance — up to
   `--timeout` (default 120 s). If it never does: nothing is written, the
   old provider is not revoked, and the message says to run `set` again once
   it is up;
3. **write** the record (the protected write);
4. **revoke** the old provider — undo exactly what its `configure` created,
   and name what only the owner can undo at the provider.

So the phone is never left with nothing mid-change. The preview (no `--yes`)
runs only the read-only `detect` and a dry `revoke`, and prints what each
step would do, what the old provider's revoke would undo and leave for the
owner, and the stranding warning.

It takes effect at `metistry up`, which renders `METISTRY_ORIGIN` from the
record and restarts the console.

### Doctor rows

Kind `remote`. **None** is one `ok` row. Every provider gets three shared rows
before its own:

| row | ok | otherwise |
| --- | --- | --- |
| `remote:<p>:tool` | the tool is here (the pack's version, or the owner's install) | `absent` — `metistry remote set <p>` fetches it |
| `remote:<p>:proxy-listener` | `settings.upstream` is the proxy port or the socket | **`failed`** at the main port (the sentence above); `failed` elsewhere; `degraded` when none was recorded |
| `remote:<p>:answers` | `GET <origin>/health` answers from this Mac and names this instance | `failed`, in the same words `metistry enroll` refuses with |

A record naming a provider this version has no adapter for is one `failed`
row: *"deployment.yaml names <p>, which this version of Metistry has no
adapter for — `metistry update` if a newer release has it, or `metistry
remote off`."*

## The adapter

One interface in `packages/cli/src/remote/provider.ts`, one module per
provider, the CLI the only implementation — the Mac app drives it over the
CLI transport (plan §2.2, M20) and never talks to a provider itself.

```ts
interface RemoteProvider {
  id: "none" | "tailscale" | "relay" | "cloudflare" | "zrok" | "ngrok" | "port-forward";
  detect(ctx): Promise<Detection>;                       // read-only: tool here, signed in, what configure would change
  configure(ctx, opts): Promise<Configured>;             // idempotent; expose the PROXY listener; writes nothing on failure
  status(ctx): Promise<RemoteRow[]>;                     // doctor rows, kind "remote", each with a remediation and, where it can, an action
  revoke(ctx): Promise<{ undone; left_for_owner }>;      // undo exactly what configure created
  authorize?(ctx, opts): Promise<{ signed_in; detail }>; // the provider's own browser sign-in, where one exists
}
```

The context carries the console's main port (never to be forwarded to), the
proxy port and socket, this instance's id, the record, `readToken` (stdin or
the hidden prompt), `dryRun` and `note`. The interface assumes nothing about
how a provider's tool runs — a bundled daemon, the owner's own app, in-process
code are each an adapter's business — and a credential never passes through
it as a value in a record or a return.

The registry (`remote/rows.ts`, `REMOTE_PROVIDERS_BUILT_IN`) holds the
adapters this release ships: **None** and **Tailscale** (`remote/tailscale.ts`, above).
Each later ticket adds its own.

## The tool packs

A provider's tool — `tailscaled` + `tailscale`, `cloudflared`, the zrok CLI
— is **bundled as a pack** (ruled 2026-09-30; X-112): one release asset per
tool, `metistry-remote-<tool>-<version>-darwin-arm64.tar.gz`, built from a
pinned version and sha256 in `ops/release/runtime-versions.env`, its licence
beside it, every Mach-O signed with the runtime pack's rule and checked for
the release identity. It lands at `<product>/runtime/remote/<tool>/` **only
when the owner picks that provider**; nothing is fetched at install, nothing
goes in the DMG, and `metistry update` moves forward only a pack that is
already there. The build, the layout and the verification are
`docs/ops/bundled-runtime.md`, "Provider tool packs".

The API an adapter uses is `packages/cli/src/remote/packs.ts`, and it is
the whole of it:

```ts
findRemotePack(productDir, tool): Promise<RemotePack | undefined>   // detect: read-only, never the network
ensureRemotePack(ctx, tool, { version?, target?, force? }): Promise<
  | { pack: RemotePack; fetched: boolean }
  | { pack: undefined; skipped: "dry-run" | "off-network" | "no-target" | "already" | "no-asset" | "downgrade"; reason: string }>
MANUAL_INSTALL[tool]                                                // the sentence for a pack that cannot be fetched

interface RemotePack {
  tool: "tailscale" | "cloudflared" | "zrok";
  dir: string;                 // <product>/runtime/remote/<tool>
  version: string;             // the TOOL's version — doctor's `tool present` row
  release: string | undefined; // the product release it came from
  binaries: string[];          // every Mach-O, relative: bin/tailscaled, bin/zrok (or bin/zrok2)
  signed: boolean;
  bin(relative: string): string | undefined;
}
```

`detect` asks `findRemotePack` and reports `from: "pack"` with the pack's
version (or the owner's own install, where the adapter looks for one).
`configure` asks `ensureRemotePack(ctx, tool)`: a pack already here is
returned without a fetch; a preview (`ctx.dryRun`) fetches nothing and says
so; otherwise the pack is resolved from the release, verified against
`checksums.txt` **and** its own manifest, and swapped in. **A corrupt
download throws**, so `configure` fails, the verb writes no record and
`runtime/remote/` is as it was. With `METISTRY_RUNTIME_DEPS=0` (or a release
that carries no pack) the result is `pack: undefined` with a reason that
already names `MANUAL_INSTALL[tool]` — the adapter refuses with that
sentence, so the owner is told what to install rather than left with a
silent absence.

A pack from an **older** release than the one installed is not moved
backwards (`skipped: "downgrade"`) unless forced; `metistry update` never
downgrades a pack either.

## Tests

`packages/cli/test/remote.test.ts`: a fresh install's `remote --json` says
`none` and doctor's row is `ok`; with None `METISTRY_ORIGIN` is loopback only
(a hand-written remote origin is dropped and reported); a token in argv is
refused and not echoed (`--token v`, `--token=v`, a stray positional); a
failed `configure` writes nothing; `set none` from a provider runs that
provider's revoke; a fake provider exercises the switch ordering — the old
one is revoked only after the new origin answers, and an origin that never
answers writes and revokes nothing; doctor fails a provider whose upstream is
the main console port, and passes the proxy port, the socket and a namespaced
block's slot. `packages/core/test/deployment.test.ts` holds the schema and
the whole-block overlay. `packages/cli/test/remote-packs.test.ts` (X-112):
a checksum mismatch and a tampered pack each leave `runtime/remote/`
byte-for-byte as it was; a downgrade is refused; `set none`, a preview and an
`update` with no pack fetch nothing; choosing a provider fetches exactly its
tool's pack through `configure`; `METISTRY_RUNTIME_DEPS=0` fetches nothing and
names the manual install.
`packages/cli/test/remote-tailscale.test.ts` (X-106): recorded `status --json`
and `funnel status --json` fixtures pin the fields read; each `BackendState`
maps to its row and sentence; a live handler at the main port fails doctor by
name; Funnel refuses to configure before X-111's headers answer on the proxy
listener (nothing fetched, started, opened or written); `--use-app` with no
app, both flags, a bad `--mode`, a non-launchd platform and an over-long
socket path are each refused before anything runs; a sign-in that never
finishes and an origin that never answers each write nothing and leave the
old provider in place; revoke leaves no handler, a logged-out node, no job
and no state; the node's state directory is 0700; the owner's-app path adds
no job and its revoke only turns the handler off.
