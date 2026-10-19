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
| **Tailscale — Any browser (Funnel)** *(recommended)* | the internet; the phone needs no app | the Mac | `https://<node>.<tailnet>.ts.net` | $0 | X-106 |
| **Tailscale — Only my devices** | the owner's tailnet; the phone needs the Tailscale app | the Mac | same name | $0 | X-106 |
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
**not carried**, and `up` says so in its plan. That is deliberate: a
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

Provider flags: `tailscale [--mode funnel|tailnet] [--use-app]`; `cloudflare
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
adapters this release ships: **None**. Each later ticket adds its own.

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
the whole-block overlay.
