# @foldedspacelabs/metistry-tasks

A shared task list for heterogeneous agents — yours, someone else's, any
vendor's — backed by one Postgres table. Agents **pull** work; the list
holds state. It gives you the five primitives every serious coordination
system converged on independently:

- **Atomic claim** — assignee + status + lease in one `UPDATE`; two agents
  racing for a task get exactly one winner. Never read-then-write.
- **Leases with heartbeat** — a dead agent cannot strand a task. When the
  lease lapses the task is claimable again; the old holder's heartbeat is
  refused.
- **Dependency edges with auto-unblock** — `depends_on` gates "ready work";
  B is ready only after A is closed.
- **Idempotent create** — retry with the same `idempotency_key`, get the same
  row back.
- **Append-only history + action record** — every task carries its own
  `history`; every mutation also lands in a `runs` table with the acting
  agent, so there is one audit trail.

It is one TypeScript service. HTTP routes, MCP tools, or CLI verbs are thin
adapters over it — policy lives here once. No framework, no ORM: the only
runtime dependency is `@foldedspacelabs/metistry-core` (which pulls `zod`).

## Install

```sh
npm i @foldedspacelabs/metistry-tasks pg
```

Any client with pg's `query(text, values)` shape works (`pg.Pool`,
`pg.Client`, a transaction-scoped client, or a fake in tests).

## Use

```ts
import pg from "pg";
import { TasksService, ensureSchema } from "@foldedspacelabs/metistry-tasks";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await ensureSchema(pool); // idempotent: creates `work` and `runs` if absent
const tasks = new TasksService(pool, { defaultLeaseSeconds: 900 });

// The second argument is ALWAYS the agent identity your adapter derived
// from the credential (API key, bearer token, session). Never read it from
// the request body — self-declared identity is how audit logs get forged.
const a = await tasks.create({ title: "Draft the spec", project: "launch", idempotency_key: "spec-1" }, "agent:writer");
const b = await tasks.create({ title: "Review the spec", project: "launch", depends_on: [a.id] }, "agent:writer");

await tasks.listReady({ project: "launch" }); // [a] — b waits on a

const claim = await tasks.claim(a.id, "agent:writer", 600); // { ok: true, task } | { ok: false, reason }
if (claim.ok) {
  await tasks.heartbeat(a.id, "agent:writer"); // renew the lease while working
  await tasks.update(a.id, "agent:writer", { note: "first pass done" });
  await tasks.update(a.id, "agent:writer", { status: "closed" }); // releases the claim, stamps closed_at
}

await tasks.listReady({ project: "launch" }); // [b] — unblocked
```

## API

All ids are integers; every mutating call takes `agent: string` last (or
second) and records a `runs` row (`component = agent`, `kind = 'task_op'`,
`meta = {op, id}`), succeed or fail.

| Method | Does | Returns |
| --- | --- | --- |
| `create(input, agent)` | Insert a task. `input`: `title` (required), `project?`, `area?`, `depends_on?: number[]`, `due?: 'YYYY-MM-DD'`, `idempotency_key?`, `external_ref?`. Unknown `depends_on` ids are refused. Same key → the existing row, untouched. | `Task` |
| `listReady({project?, limit?})` | Status `open`, kind `task`/`review`, unclaimed or lease expired, every dependency `closed`. Due dates first, then oldest. Rows collected from a source of truth (`issue`, `pr`, `event`) are never listed or claimable — their status belongs to the source. | `Task[]` |
| `claim(id, agent, leaseSeconds?)` | One atomic `UPDATE`: requires unclaimed-or-expired, status `open`/`in_progress`, dependencies closed. Sets holder, lease, `in_progress`. | `Result` |
| `heartbeat(id, agent, leaseSeconds?, note?)` | Extend the lease. Holder only, and only while the lease is live — an expired lease is never renewed. `note` lands on `history`; a renew *without* one appends nothing, so a lease kept alive every few minutes never buries the row's record. | `Result` |
| `update(id, agent, {status?, note?, owner?, title?, project?})` | **Two arms** — see below. Holder arm: `status` ∈ `in_progress \| blocked \| closed` (`closed` releases the claim and sets `closed_at`; `blocked` keeps it), and/or a bare `note`. Board arm: `owner` (`null` clears), `title`, `project`, and `status: 'open'` (the unblock, legal from `blocked` only). Appends to `history`. | `Result` |
| `release(id, agent, note?)` | Holder hands the task back: clears the claim, status → `open`. | `Result` |
| `get(id)` | One task or `null`. | `Task \| null` |
| `listForAgent(agent)` | Everything the agent currently holds. | `Task[]` |
| `check()` / `check(db)` | Behavioral probe: selects every column the service needs. `status: 'failed'` with the error as `remediation` on an unmigrated database. | `CheckResult` |
| `ensureSchema(db)` | Runs `sql/schema.sql` — every statement `IF NOT EXISTS`, safe on every start. | `void` |

`Result` is `{ ok: true, task }` or `{ ok: false, reason, task? }` with
`reason` one of `not_found`, `closed`, `blocked`, `claimed`,
`dependencies_open`, `not_holder`, `lease_expired`, `not_blocked`. Policy refusals are
outcomes, not exceptions; malformed input throws `TasksError` with `code`
`invalid_input`, `unknown_dependency`, or `conflict` (duplicate
`external_ref`).

### `update` has two arms, and the FIELDS pick the arm

Which gate a change meets is derived from what it names — never from a flag
the caller passes:

| Arm | Fields | Gate |
| --- | --- | --- |
| **holder** | `status: in_progress \| blocked \| closed`, a bare `note` | `claimed_by = agent` |
| **board** | `owner`, `title`, `project`, `status: 'open'` | none — but kind `task`/`review`, not closed, and `open` only from `blocked` |

The board arm exists because addressing, renaming and re-filing a card are
gestures on a row nobody need hold, and because `blocked` is the one state
nothing in the system could leave: `UpdateInput.status` used to be
`Exclude<TaskStatus, 'open'>`, so *unblock was unreachable*.

**The two may not be mixed in one call** — `{status: 'closed', owner: 'x'}`
throws `invalid_input` naming both fields. Mixing would let the arm with the
looser gate carry the other arm's write, which is the whole reason the gate
lives in the `WHERE` clause and not in an adapter.

The unblock hands the row back the way `release()` does (claim and lease
cleared), so it lands wherever `owner` says it should. `owner` stays
informational throughout: claims are first-come, and an agent that is not the
addressee can still claim an addressed row.

### Rules worth knowing

- **Holder authority outlives the lease** for `update` and `release`, until
  someone else claims the task. Late work can still be closed; only
  `heartbeat` and other agents' `claim` care about expiry.
- A `blocked` task is not listed as ready and cannot be claimed by others —
  the holder is expected to keep heartbeating and set it back to
  `in_progress`. If the holder vanishes, `update(id, …, {status: 'open'})`
  is the way out: it needs no claim, precisely because the holder is the
  thing that is stuck.
- A dangling `depends_on` id (row deleted later) **blocks**; a typo must not
  silently release work.
- Identity strings are bind values everywhere. The SQL never contains
  caller text.

## Schema

`sql/schema.sql` creates two tables. If you already run Metistry, its
migrations own the schema (`db/migrations/0008_tasks.sql` adds the tasks
columns) and `ensureSchema` is a no-op.

```
work(id, title, project, area, kind, status, external_ref, owner, due,
     claimed_by, lease_expires_at, depends_on bigint[], idempotency_key,
     history jsonb, created_by, closed_at, created_at, updated_at, meta)
runs(id, ts, component, kind, meta, ok, error, started_at, finished_at, ...)
```

## Testing

`vitest run` in this package. Unit tests use a fake `Db`. The integration
suite runs when `METISTRY_DB_PASSWORD` is set (from the environment or a
repo-root `.env`) against `METISTRY_TEST_DB_NAME` (default `metistry_test`),
and proves the race: five concurrent claims, one winner.

## License

Apache-2.0
