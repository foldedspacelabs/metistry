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
| Passkey session | `Cookie: metistry_session=…` | `user` | everything except the `local` routes — minting an agent bearer — which answer `403 local_only` ([client-api.md](client-api.md), "The `local` gate") |
| **Local owner token** | `Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN`, from this machine | `user` | everything except the two session-bound endpoints below |
| Host-minted owner token | `Authorization: Bearer …` (an `owner_tokens` row) | `owner_token` | `/capture`, `/message`, `/api/status`, named queries — never management |
| Agent token | `Authorization: Bearer …` (an `agents` row) | that agent | `/capture` and the mcp-brain mount at `/mcp`; a uniform 403 everywhere else |
| Crew run token | `Authorization: Bearer …` (an `agents` row, `kind = 'crew'`) | that crew | the same, narrowed to the tool groups its manifest names ([crews.md](crews.md)) |

A passkey session and the local owner token are the **same principal**, in
the same code path — `isUser()` in `apps/console/src/server.ts` is the one
predicate the owner surface is gated on, so the two cannot drift apart. The
one place they differ is **reach**, not principal: a route the client API
table files under `local` is the owner on this Mac, and only the local owner
token proves that (F-13).

## One decision function

Every door in this table asks **one function** whether a request may pass:
`may(principal, verb, resource)` in `packages/core/src/access.ts`. The
console maps a credential onto its `Principal` (`principalOf` in
`server.ts`), `mcp-brain` maps an agent bearer onto the same shape
(`packages/mcp-brain/src/principal.ts`), and neither a route handler nor a
tool body compares a `kind` or a `tier` of its own — a misuse test greps the
bridge's source to keep it that way
(`packages/mcp-brain/test/may-surface.test.ts`).

**The owner is refused nothing.** `may()` short-circuits to `ok` for the
`owner` role on every door, for every verb, with no exception clause below
it — the owner's own sentence, made arithmetic. What makes that safe is that
a resource is CLASSIFIED before it is judged: `classify(path)` answers
`knowledge | artifact | machinery | outside`, and `Artifacts/` and
`.metistry/` are not knowledge paths, so "the owner has everything" never
has to be weakened to keep an agent out of the machinery. A knowledge door
handed one of them answers with the classification — what it is, and
`needs.door` naming the door that does have it — never a 403, and never a
404 pretending it is not there. `classify(p) === "knowledge"` is
`isVaultPath(p)` by construction, so the indexer's rule did not change; it
was given a name.

That is the rule with no exceptions, and it does have one consequence worth
being plain about: a door that is not the right door still does not serve
you. `.metistry/state/.env` is machinery, no door serves it as a page, and
asking the knowledge door for it gets the classification and not one byte.
It is the file itself, 0600, on the machine that is yours.

Where the grants themselves live has not moved: registry rows for external
agents, the environment for the instance's own assistant, the manifest for a
crew. Which of the three a row came from is now recorded ON the row
(`agents.grant_source`, migration 0025) rather than re-derived from its kind
in three files. `may()` decides; it never writes, and every widening still
goes through the console's one grants door and its one audit row
(invariant 2).

## One refusal envelope

A refusal carries the uniform envelope it always did, plus two additive
fields:

```json
{ "error": { "code": "forbidden", "message": "not granted — `Areas/Finance/tax.md` is outside your folders; …" },
  "reason": "scope_required",
  "needs":  { "grant": { "tier": "areas", "area": "Areas/Finance" } } }
```

`reason` is a closed enum — `scope_required`, `tier_required`,
`queries_required`, `role_required`, `autonomy_required`,
`membership_required`, `not_member`, `not_exposed`, `not_knowledge`,
`not_in_uses` — and `needs` is the machine-readable form of what would
unlock it: `grant` (what `request_access` takes as input and what Approve
applies), `autonomy` (the entry you would raise), or `door` (the route that
serves this resource, when the refusal is a classification rather than a
permission). **`needs` is produced by `may()`, never by a tool body**; a
handler that hand-writes a remedy sentence is the thing this replaces.
`error.code` is untouched, so invariant 8's envelope is unchanged, and
`formatRefusal()` in `core` is the one function that renders it.

**One wording per reason.** There used to be five dialects across fourteen
sites; there is one sentence per `reason` now, with the facts substituted
and the shape never. So `queries_list` and `queries_run` refuse in the same
words, `knowledge_read` and `knowledge_list`'s `links_for` give the same
scope sentence, and a model learns one sentence per kind of refusal instead
of fourteen.

**And one silence.** Some refusals must be indistinguishable from "there is
nothing here", and that is now a property of the type rather than a comment
at a call site: a `tell: "hide"` decision renders as the door's own absence
answer, carries no `needs`, and loses its `reason` on the way out. Four
things hide — a row outside your projects, a route-only named query, the
console's uniform 403 (CRIT-7: one answer on every management route, never a
403 here and a 404 there), and a knowledge path you may not even list, which
is the 2026-09-19 boundary: an area is named only for a page whose existence
you can already see.

The complete catalogue of what every door can say is committed as
`packages/core/test/access.golden.json` — every entry with the code, the
reason, the `tell`, the message, and what that door answered before, so
changing a refusal's wording is a reviewable diff with a paragraph beside it
rather than a string edited inside a handler.

## One scope vocabulary

`describeScope(principal)` in `core` renders a credential as one triple:

```
an agent · folders: Areas/Health · queries, projects: alpha, autonomy: propose
```

**role · access · extras.** The access word is `none` / `titles` /
`folders` — the tier, said the one way — and the extras are everything that
is not the tier: the `queries` switch, the projects, a crew's `uses`
toolset, the autonomy level. Beside it, in the same structure, is where the
scope came FROM: configuration for the assistant
(`METISTRY_ASSISTANT_AREAS`, plus any area you have approved), its manifest
for a crew, the registry for everything else.

Four surfaces render that one structure and none of them composes words of
its own: `metistry agents list` ([cli.md](cli.md)), the console's Agents
panel, the Needs You `access_request` card (whose payload carries the
rendered scope, so the sentence you read while deciding is the sentence the
panel shows), and the tool descriptions on `/mcp`
([assistant-tools.md](assistant-tools.md)).

## Five roles, and the one that carries a toolset

A credential maps onto one of five roles — `owner`, `assistant`, `agent`,
`crew`, `tool` — and `agents.kind` is what distinguishes the three that
arrive as a bearer. The column has stored `external`, `internal` and `crew`
since Phase 5; since migration 0025 a CHECK says so, and the console passes
the row's value through instead of collapsing anything that is not
`internal` to `external`.

That matters for one rule. A crew is a sub-agent defined by a manifest in
the instance repo, and its manifest names the **tool groups** it may use
(`uses:`). Until 2026-09-20 that list was applied by the process that
dispatched the run — real, because the run's bearer is minted per run and held by that
process alone, but a process boundary rather than the tool. Now the crew's
`uses` rides on the principal, resolved server-side from the loaded
manifest, and `/mcp` refuses every call outside it before the tool body runs:

```json
{ "error": { "code": "forbidden",
             "message": "tasks_comment is not in this crew's toolset — writer holds knowledge, requests (`uses:` in its manifest, …)" } }
```

The refusal is one `runs` row on the crew's own id, and the caller's own
allowlist stays in place as defence in depth. Nothing in a request can
change any of it: the kind comes from the row, the toolset from the
manifest, and neither is a parameter of any tool ([crews.md](crews.md),
`packages/mcp-brain/test/crew-uses.test.ts`).

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
