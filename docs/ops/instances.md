# Instances: naming them, and naming agents across them

Two adopts from the SAM review (`docs/research/2026-09-13-google-sam-review.md`,
ADOPT 3 and 4; `docs/plan-refresh-2026-09-13.md` §1 S3/S4), which answer the
same question from two ends: **when this instance and another one talk about
the same thing, do they use the same word?**

The review's honest scoreboard was that SAM's one uncontested win over
"tailnet + `/mcp`" is cross-instance discovery and capability
advertisement — and that this is a **registry** feature, not a mesh one. So
Metistry takes the registry and skips the mesh: no libp2p, no control
plane, no Biscuit, no second policy language. At two instances on one
tailnet, a registry is a file.

## `agent:<name>@<instance_id>` — the qualified form (S3)

An agent id is a slug (`cursor`, `devin`, `assistant`). That is unambiguous
*inside* one instance and meaningless outside it: two instances can both
have a `cursor`, and a token minted by one means nothing to the other. The
qualified form is the naming half of a portable identity, with none of the
crypto:

```
agent:cursor@8b6a3a2e-1c4d-4f7a-9b2e-0d1c2b3a4e5f
└─────┘└────┘ └──────────────── the instance_id `metistry init` minted ───┘
 fixed  the registry id
```

`packages/core` owns it — `qualifyAgentId(name, instanceId)`,
`parseAgentId(value)`, `qualifyIfPossible(name, instanceId)`. It is strict
on both halves and **refuses to qualify an already-qualified id**: a
`agent:a@x@y` that got written once would look like a name for the rest of
time.

**Where it is used.** At the boundaries, and nowhere else:

| place | form |
| --- | --- |
| `agents` rows, `inbox.source_agent`, `proposals.source_agent`, `runs.meta.agent`, artifact `author_principal`, `work.owner` (`crew:`/`agent:`) | the **bare** `<name>` — the instance is implicit |
| `GET /api/runs/export` (`docs/ops/console-api.md`) | **qualified**, plus a top-level `instance_id` on every line |
| anything else that leaves this machine and names an agent | **qualified** |

This is deliberate and additive. **Existing rows are not rewritten** — a
migration that rewrote historical identity to say something it did not say
at the time would be worse than the ambiguity it fixed. So there is a
**mixed period**: rows written before this carry bare names, rows written
after carry bare names too *in storage*, and the qualified form is minted at
the boundary from `(name, instance_id)`. A reader that has to cope with both
uses `parseAgentId`, which returns `undefined` for a bare name rather than
guessing an instance.

When the console has no complete `identity.yaml` — no `instance_id` to
qualify with — `qualifyIfPossible` passes the bare name through rather than
inventing one. An export from such an instance is honest about being
unqualified.

## `instances.yaml` — the peer registry (S4)

A file in the instance repo, listing the *other* instances this one knows
about. A §4.7 protected path, like `compute.yaml` and `deployment.yaml`:
every write goes through the reconciler as the `user` principal (D5,
invariant 2), because which machines this instance will talk to is a
statement about how the system behaves.

```yaml
# instances.yaml — the instances this one knows about (docs/ops/instances.md).
instances:
  - instance_id: "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
    name: Second
    origin: https://second.example.com
    last_seen: "2026-09-16T01:00:00.000Z"
    capabilities: [capture, knowledge, queries, tasks]
    resources: []
```

- **Keyed by `instance_id`, never by origin.** An origin can move — that is
  exactly why the phone keys everything by `instance_id`
  (`docs/research/2026-09-11-multi-instance-and-offline-client.md` O1) — so
  the same instance at a new address *updates* its row instead of making a
  second one.
- **`origin`** is a scheme, host and optional port. No path, no trailing
  slash; the verbs append `/api/identity` themselves.
- **`capabilities`** is whatever that instance advertised, filtered through
  the shared vocabulary. A peer running a newer version that advertises a
  group this one has never heard of has that word dropped, not stored — the
  registry never records a capability this code cannot name.
- **`last_seen`** is when a verb last got an answer. Absent means never
  reached; it is not a presence signal (see "closed laptops" below).
- **`resources: []` is a placeholder and stays empty.** The plan's S4 line
  includes "an instance's directory of exposable resources: CLI commands,
  directories, MCP servers, compute, tasks/knowledge, Slack, Linear", and
  the scope of "resource" is explicitly **OPEN-7** in
  `docs/plan-refresh-2026-09-13.md` — a question for the owner, not ratified
  to build. Rather than guess a shape that would then have to be migrated,
  the key exists and the schema refuses a non-empty value, naming OPEN-7 in
  the refusal. Nothing reads it.

## The verbs

```
metistry instances list [--json]
metistry instances add <origin> [--dry-run]
metistry instances remove <instance_id|name> [--dry-run]
metistry instances refresh [--dry-run]
```

`add` **asks the origin who it is** — `GET /api/identity`, the one
unauthenticated read a Metistry console has (`docs/ops/console-api.md`) —
and records what it answers. Three consequences worth stating:

1. **No credential is needed to add a peer**, which is the point: a design
   whose registry needed a shared secret would be the second credential
   class the review said to skip.
2. **An origin that will not say who it is does not go in the file.** A 503
   (no complete `identity.yaml`), a non-Metistry answer, a timeout — all
   refusals, and nothing is written from a guess.
3. **Adding *this* instance is refused.** A registry of peers that contains
   itself makes every consumer filter it.

`refresh` re-asks every recorded origin and:

- leaves an **unreachable** peer's row exactly as it was. A closed laptop is
  not a departed instance — O4 rules that no wake path is built, so
  unreachability is the ordinary case, not news.
- leaves a row alone when its origin now answers as a **different**
  `instance_id`, and reports it. That address belongs to someone else now;
  silently repointing the owner's registry at whoever answers it today is
  precisely the failure a registry exists to prevent.

Every verb re-parses the *result* through the same schema the console serves
it with, and refuses the whole write if it would not validate — the rule
`metistry compute` follows, for the same reason.

`GET /api/instances` (the `user` principal) serves the same file to the Mac
app and the phone.

## What this is not

Not a mesh, and not a step toward becoming one. There is no transport here,
no NAT traversal, no peer identity beyond a UUID a peer volunteers about
itself over TLS. Reachability is the user's routing layer (invariants 7/8)
and identity is proven per request at the application layer; the registry is
a list of *where to look*, not a way in. An instance in this file has
exactly as much access to this one as it had before it was added: none.

The mesh question is revisited when agents run on machines the owner does
not control, when there is more than one administrator, or when instances
cannot share one tailnet — the thresholds in the review's Verdict. Until
then S6 (an internal mesh) stays BORROW-LATER and, per the owner's ruling,
not before this registry exists.
