# The doors — who a request is allowed to be

Two doors authenticate in this system, and this file is both: the **console's**
(below) and the **vault bridge's** ("The principal comes from the credential",
further down). Every request authenticates at each, as if internet-exposed
(invariant 8: the network is not a boundary).

The console authenticates **every** request. There are two credential
*classes*, structurally distinct (review CRIT-7), and inside the owner class
one *principal*.

| Credential | Presented as | Principal | Reaches |
| --- | --- | --- | --- |
| Passkey session | `Cookie: metistry_session=…` | `user` | everything |
| **Local owner token** | `Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN`, from this machine | `user` | everything except the two session-bound endpoints below |
| Host-minted owner token | `Authorization: Bearer …` (an `owner_tokens` row) | `owner_token` | `/capture`, `/message`, `/api/status`, named queries — never management |
| Agent token | `Authorization: Bearer …` (an `agents` row) | that agent | `/capture` and the mcp-brain mount at `/mcp`; a uniform 403 everywhere else |

A passkey session and the local owner token are the **same principal**, in
the same code path — `isUser()` in `apps/console/src/server.ts` is the one
predicate the owner surface is gated on, so the two cannot drift apart.

## The local owner token

`METISTRY_LOCAL_OWNER_TOKEN` is an instance-scoped secret. `metistry init` mints
it; `metistry secrets sync --to env` mints one for an install that predates
it; the login Keychain is its home (`metistry:METISTRY_LOCAL_OWNER_TOKEN`, under
the instance's `instance_id`), and `<instance>/.metistry/state/.env` — 0600, generated
from the Keychain — is how it reaches the console's environment.

**Why it exists.** The Mac app is the same package as the CLI, on the same
machine, running as the same person, with that person's filesystem access.
Asking it to perform a WebAuthn ceremony against a local origin is theatre:
anything that could impersonate it could also read the passkey's own
storage. Remote clients — a browser, the phone, anything not on this
machine — are a different question, and they keep registering passkeys
exactly as before. Nothing about passkey enrollment or login changed.

**The rule.** The token is accepted only when the **connection's peer
address** is loopback: `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. That
decision is made from the socket and nothing else. `X-Forwarded-For`,
`Forwarded`, `X-Real-IP` and `Host` are written by the caller, so reading
any of them would hand the rule to the attacker; there is no configuration
that turns one of them on, and the misuse tests assert it
(`apps/console/test/local-owner.test.ts`).

**From anywhere else** the response is a 401 byte-identical to the one an
unknown token gets — no oracle telling a prober that it holds the right
secret — and the refusal is written to `runs` as
`kind=auth, tool=owner_token_remote` with the address that presented it.
That row is the only place the refusal is visible.

**Not weaker than a passkey on the same machine.** Possession of the token
means "I can read this user's login Keychain, or the 0600 `.env` generated
from it". On macOS that is the logged-in user — the same claim a platform
passkey makes. The Keychain is the boundary, and it is the boundary either
way. What the loopback rule adds is that a token which *leaks* — into a
log, a screenshot, a synced dotfile — still cannot be replayed from off the
machine.

**What it may not do.** Two endpoints act on a device *session row* and so
need one: `POST /auth/logout` and `/api/push/*` (a push subscription is
bound to the device that made it). The local owner token gets a 403 there.
Everything else the owner surface offers — devices, agents, projects,
proposals, artifacts, targets, dispatch — it may do.

## The compose caveat

Under `shape: compose` the console runs in a container and the port is
published as `127.0.0.1:${METISTRY_CONSOLE_PORT}:8080`. Docker NATs that
host-loopback connection, so the peer address the console sees is the
bridge **gateway** — `172.17.0.1`, `192.168.112.1`, whatever the project's
network was allocated — never `127.0.0.1`.

`METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is *told* about that,
and `docker-compose.yml` is the only place that sets it:

```yaml
METISTRY_TRUSTED_LOOPBACK_PROXY: ${METISTRY_TRUSTED_LOOPBACK_PROXY:-docker-gateway}
```

`docker-gateway` is a sentinel meaning "my own default gateway", resolved
once at startup from `/proc/net/route`. It is deliberately **not** the
compose subnet: the gateway is the only address the published-port NAT can
present, so a sibling container — the assistant, say — holds an address in
that subnet and is still remote. Proven on 2026-09-10 against a container
on its own network (`subnet 192.168.176.0/20 gateway 192.168.176.1`):

```
the host, through the published loopback port  HTTP 200
a SIBLING container on the same network        HTTP 401
```

Unset — the launchd shape, and any console nothing configured — means plain
loopback, which is the fail-closed direction; the same container with the
variable emptied answers 401 to the host. An explicit address or IPv4 CIDR
is also accepted, for a shape neither of those covers. `0.0.0.0/0` is
refused rather than honoured.

## Checking it

```
$ metistry console whoami
console    http://127.0.0.1:8080
principal  user
via        local_owner_token
management yes
origin     https://your-hostname.example
```

`--json` gives the same fields for the app. A 401 here is one of exactly
two things, and the error says so: the `METISTRY_LOCAL_OWNER_TOKEN` in this
environment is not the one the console was *started* with (`metistry
secrets sync --to env`, then `metistry restart console`), or the request did
not reach it from this machine (the compose caveat above).

`metistry doctor`'s console row presents the token too, so `api_status` is a
real authenticated read rather than "the 401 had the right shape". A
refused token degrades that row — the console is up and serving — rather
than failing it.

## What the Mac app codes against

```
GET /api/whoami
Authorization: Bearer <METISTRY_LOCAL_OWNER_TOKEN>

200 {"principal":"user","via":"local_owner_token","management":true,
     "origin":"https://…","as_of":"2026-09-10T15:42:22.406Z"}
401 {"error":{"code":"unauthenticated","message":"authentication required"}}
```

`via` is `passkey_session` for a cookie, `owner_token` for a host-minted
capture token (which answers `principal: "owner_token"`, `management:
false`). The app should call the CLI (`metistry console whoami --json`)
rather than reading `.env` itself — the CLI is the one place that knows
where the token lives (docs/product/desktop-app-plan.md: the app is a front
end for the CLI, never a second implementation).

`GET /api/identity` is the one unauthenticated read — instance id, name,
icon, version, nothing the login page does not show — for a phone to name
an instance before sign-in (`docs/ops/console-api.md`).

## The principal comes from the credential

*The vault bridge — `apps/reconciler` (docs/ops/reconciler.md). Ruled
2026-09-20.*

Every mutation through the bridge carries
`intent: { principal, message, group? }`, and `principal` decides §4.7:
`writeAllowed` admits `.metistry/**`, `CLAUDE.md` and `README.md` for the
`user` principal alone. But `intent` is a field in a **request body**, and a
body is written by whoever is calling. With one shared bearer, every holder of
`METISTRY_BRIDGE_TOKEN_RECONCILER` could write `"principal": "user"` and
rewrite `rules.yaml`, an agent definition, a named query, `metistry.lock` or
the assistant's own instructions.

Nothing did. That is not the same sentence as nothing can, and invariant 2 —
"anything defining how the system behaves is a human change" — is worth only
the stronger sentence.

**The rule.** The bearer says what a caller IS; the body says whose name the
commit is in, and never more than the bearer allows.

| Credential | Caller class | May claim | May write a §4.7 protected path |
| --- | --- | --- | --- |
| `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` | `owner` | `user`, and nothing else | **all of them** |
| `METISTRY_BRIDGE_TOKEN_RECONCILER` | `console` | any principal | **only** `.metistry/assistant-prompt.md` and `.metistry/compute.yaml` |
| anything else | — | 401, byte-identical for both | — |

The table is `CALLER_AUTHORITY` in `apps/reconciler/src/paths.ts`, read on
every write, delete and rename. A body that exceeds its credential is
`403 forbidden` in the uniform envelope — **never** silently downgraded to a
principal it did not ask for — and every refusal is a `runs` row
(`component=reconciler, kind=auth`) carrying the caller class, the claimed
principal and the path.

**Who holds which.**

- **`owner`** — `packages/cli`'s protected-path writer, and only it:
  `metistry update` (the lock), `metistry deployment set-shape` /
  `set-keep-awake`, `metistry compute`, `metistry instance` (minting
  `instance_id` into `identity.yaml`). The CLI may hold it because the CLI
  *is* the person: it runs as them and reads their login Keychain and their
  0600 `.env`. The Mac app reaches these the way it always has, by running
  the CLI (`metistry deployment set-shape --yes`), so nothing about the app
  changes.
- **`console`** — the console process and everything it fronts: captures
  (`principal: capture`), artifacts (the author's principal), `mcp-brain`'s
  `knowledge_write` (the agent's own id, stamped from the agent's credential),
  routines, and the Compute pane. It writes as `user` for the owner's own
  click, because it IS the multiplexer — and that claim now buys nothing
  beyond the two paths below. The console's compute routes call the same
  `writeProtected` the CLI does (one implementation, `packages/cli`), which
  presents whichever bearer its process holds; the bridge, not the helper, is
  what decides the answer.
- **The assistant** holds neither. It reaches the vault through `mcp-brain` on
  the console, whose `knowledge_write` refuses a protected path before the
  bridge ever sees it (a second statement of the same rule, at the tool the
  assistant actually holds).

**The two enumerated exceptions**, which are the two owner-authenticated
doors the console already ships (invariant 10: a closed, enumerated set, each
one a product change to add):

- `.metistry/assistant-prompt.md` — §4.10 self-modification. The owner allows
  an `improvement` proposal in triage and the console appends the suggested
  section to the prompt overlay as `user`
  (`apps/console/src/prompt-overlay.ts`).
- `.metistry/compute.yaml` — the Compute pane's two writes, `POST
  /api/compute/assign` and `/budget`, gated on the `user` principal and
  calling the same function `metistry compute` calls
  (`apps/console/src/compute-routes.ts`). Without it the phone could see what
  a turn cost and could not move it to a cheaper model, which is the gap that
  route exists to close.

Both are named in the bridge's table rather than left to the console's
restraint, which is the point: `identity.yaml`, `rules.yaml`,
`deployment.yaml`, `metistry.lock`, `queries/`, `agents/`, `routines/`,
`targets/`, `extensions/`, `CLAUDE.md` and `README.md` are refused no matter
what the console asks for or claims to be. Moving either door to the CLI
shrinks the list; nothing grows it without a product change landing in that
table.

**The console never gets the owner bearer.** `consoleEnv`'s `CONSOLE_ENV_DENY`
(`packages/cli/src/deployment.ts`) removes it by name from the otherwise
wholesale `METISTRY_*` passthrough that becomes the console's launchd
environment and the supervisor's, and `docker-compose.yml` never listed it. A
misuse test asserts both.

### Minting it, and what an existing install does

`metistry init` mints both bearers into the new instance's `.env`. For an
install that predates the split, three things mint the missing one, and all
three are idempotent:

- **`metistry up`** — before it renders any job, so the reconciler it
  (re)starts is holding it.
- **`metistry update`** — at the top of its restart step, for the same
  reason, and it kickstarts the reconciler itself if nothing else in the run
  did. This is why an update needs no instructions: the owner runs the verb
  they were going to run.
- **`metistry secrets sync --to env`** — it is in `GENERATED_SECRETS`, like
  `METISTRY_LOCAL_OWNER_TOKEN`. Follow it with `metistry restart reconciler`.

On macOS it lands in the login Keychain and in `.env`; elsewhere `.env` is the
store, as it is for every secret.

**Until it exists, the bridge fails closed**: *no* caller may write a
protected path, `metistry doctor`'s `reconciler` row is `degraded` with the
command that fixes it, and the CLI refuses before it makes a call rather than
falling back to the shared bearer. Rotation is `metistry secrets mint
METISTRY_BRIDGE_TOKEN_RECONCILER_USER` followed by `metistry restart
reconciler` — the environment is the record, so the old value stops working
the moment the job restarts.

## Passkeys: origins

`METISTRY_ORIGIN` is the canonical HTTPS origin passkeys bind to. It may be
a **comma-separated list** when one install is loaded under more than one
origin (a tailnet name and a public hostname, say) — `@simplewebauthn`
v13's `expectedOrigin` takes an array. The **first** entry stays canonical:
it is the rpID's source, what enrolled passkeys record, and the base
relative URLs resolve against.

An origin the console does not expect no longer surfaces as HTTP 500. The
ceremony answers 401 with a reason naming both sides:

```json
{"error":{"code":"unauthenticated","message":"origin mismatch: this console
 expects https://metis.example, the browser presented https://elsewhere.example
 — set METISTRY_ORIGIN to the origin you actually load"}}
```

Both origins are already known to the caller (it presented its own) and to
anyone who can load the login page, so nothing leaks; what it buys is that a
misconfigured install stops looking like a broken one.

## Rotating and revoking

- **The local owner token:** `metistry secrets mint METISTRY_LOCAL_OWNER_TOKEN`
  (Keychain + `.env`), then `metistry restart console`. The old value stops
  working the moment the console restarts — there is no revocation list
  because there is no row: the environment *is* the record.
  Note that `secrets sync --to env` will mint one again if it finds none —
  turning the local door *off* permanently means removing the variable from
  the console's environment (unset it in `docker-compose.yml` or the job's
  plist), not clearing the `.env` line.
- **A passkey session:** the devices tab, or `POST /api/devices/<id>/revoke`.
- **A host-minted owner token** (the capture Shortcut,
  `docs/ops/capture-shortcut.md`): `UPDATE owner_tokens SET revoked_at =
  now() WHERE label = '…'`.
- **An agent token:** the agents tab, or `POST /api/agents/<id>/revoke`.
- **The vault bridge's owner bearer:** `metistry secrets mint
  METISTRY_BRIDGE_TOKEN_RECONCILER_USER`, then `metistry restart reconciler`.
  Same story as the local owner token: no revocation list, because the
  environment is the record.
