---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/reconciler": minor
---

The vault bridge takes the principal from the credential, never from the
request body.

**The hole.** Every mutation through the reconciler's bridge carries
`intent: { principal, … }`, and `principal` was the whole of the §4.7 check:
`writeAllowed` admitted `.metistry/**`, `CLAUDE.md` and `README.md` for
`principal: user` and refused everyone else. But `intent` is a field in a
**request body**, and one shared bearer — `METISTRY_BRIDGE_TOKEN_RECONCILER` —
reached that check. Any holder of it (the console, which terminates the
network and multiplexes every agent on the install; anything that ever read
the console's environment) could write `"principal": "user"` and rewrite
`rules.yaml`, an agent definition, a named query, `metistry.lock` or the
assistant's own instructions. Nothing did. Invariant 2 is worth only the
stronger sentence (owner's ruling, 2026-09-20).

**The wire change.** The bridge now derives a caller CLASS from the bearer and
reads the body's `principal` as attribution inside what that class may claim
(`CALLER_AUTHORITY`, `apps/reconciler/src/paths.ts`):

| Bearer | Class | May claim | Protected paths |
| --- | --- | --- | --- |
| `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` (new) | `owner` | `user` only | all |
| `METISTRY_BRIDGE_TOKEN_RECONCILER` | `console` | any principal | `.metistry/assistant-prompt.md` and `.metistry/compute.yaml` only |

A body that exceeds its bearer is `403 forbidden` in the uniform envelope —
never silently downgraded — and every refused mutation is a `runs` row
(`component=reconciler, kind=auth`) carrying the caller class, the claimed
principal and the path. Reads are unchanged: which bearer you hold decides
what you may write, not what you may see. `check()` gains
`meta.principal_from_credential` and `meta.owner_bearer`.

The two protected paths left to the console are the two owner-authenticated
doors it already ships: §4.10's self-modification overlay, which the owner
allows in triage (`prompt-overlay.ts`), and `compute.yaml`, which the Compute
pane's `assign`/`budget` write through the same function `metistry compute`
calls (`compute-routes.ts`). Both are enumerated at the bridge rather than
left to the console's restraint, so `identity.yaml`, `rules.yaml`,
`deployment.yaml`, `metistry.lock`, `queries/`, `agents/`, `routines/`,
`targets/`, `extensions/`, `CLAUDE.md` and `README.md` are refused whatever
it asks for.

**The new bearer.** `metistry init` mints it; `metistry up` and `metistry
update` mint it for an install that has none — before they restart the
reconciler, and `update` kickstarts the reconciler itself if nothing else in
the run did — and `metistry secrets sync --to env` mints it as a
`GENERATED_SECRETS` name. It is kept out of the console's environment by name
(`CONSOLE_ENV_DENY` in the otherwise wholesale `METISTRY_*` passthrough
`consoleEnv` builds), and `docker-compose.yml` never listed it. `writeProtected` presents whichever
bearer its process holds and lets the bridge decide — the CLI's is the owner's,
the console's is not — so a caller cannot widen itself by choosing a variable
name. With no owner bearer configured anywhere, no caller may write a
protected path at all, `metistry doctor`'s `reconciler` row is `degraded` with
the command that mints one, and a 403 from the CLI names that cause.
