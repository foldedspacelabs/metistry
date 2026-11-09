# Compute targets — dispatching work off the machine

A **target** (plan §4.18.B) is somewhere work can execute: a coding agent
watching a repo, a cloud worker speaking MCP, a local subagent. Each one is
a directory with a manifest (invariant 5), and the console's dispatch tool
(`apps/console/src/dispatch.ts`) is the **only** path a brief takes off the
machine. The manifest's `data_policy` is enforced there — a brief that would
carry comms-derived content, cite a personal vault path, or exceed the byte
cap is refused with a machine-readable reason. That is the rule "comms
never leaves the machine" as code, not as a prompt.

**A target is an agent connection** (T4-11), with one exception. An `agent`
connection — `.metistry/connections/<name>.yaml` whose connection type
(`seed/connection-types/devin`, `…/github-issues`) carries the dispatcher,
the `data_policy` and the purposes — is a target named for it, and its key is
filled at its own egress door. That is the only way to add Devin or GitHub
Issues (`docs/ops/connections.md`, *Agent connections*). The exception is the
crews' **`local-crew`**, which is not a connection and stays a `targets/`
manifest.

**The one-release shim is gone (0.17.0).** T4-11 kept the `targets/`
manifests for GitHub Issues and Devin, and the `METISTRY_GITHUB_TOKEN` /
`METISTRY_DEVIN_API_KEY` environment keys, working for one release. 0.16.0 was
that release. Now:

- a `targets/` manifest **other than `local-crew`** is refused at load —
  skipped with a reason that names `metistry connections add`, logged by the
  console and shown by `metistry doctor`'s *registries* row; this holds for
  the product's `targets/`, the owner's `.metistry/targets/` overlay and an
  extension alike (an owner's `local-crew` still overlays the product's);
- an environment key alone dispatches nothing, and nothing reads one: with the
  key set and no connection, the target does not exist and `POST
  /api/tasks/:id/dispatch` answers `404`. `metistry doctor` has a *target
  keys* row that names the keys still set, says they are ignored, and names
  the verb that replaces them;
- `METISTRY_GITHUB_WRITE_TOKEN`, `METISTRY_GITHUB_DISPATCH_REPO`,
  `METISTRY_DEVIN_ORG_ID` and the other variables those manifests named are
  read by nothing; `METISTRY_GITHUB_TOKEN` still serves `metistry update`'s
  Releases API calls, and nothing else.

To move an install across, add the connection (`docs/ops/connections.md`
carries the commands for each) and delete the old lines from `.env`.

## Adding a target

A target other than the crews' is a connection **type**, not a manifest: a
new type is a directory under `seed/connection-types/` with a `dispatch:`
block (`docs/ops/connections.md`), or the owner's overlay of one in
`.metistry/extensions/<type>/manifest.yaml` (D4) — which is also how an
instance widens a type's `data_policy.allow`. Only `local-crew` is a
`targets/<name>/manifest.yaml`; its schema is `packages/core/src/manifest.ts`
(`targetManifest`), and the manifest must carry `schema: 1` and name its
directory. `apps/console/test/manifests.test.ts` validates every
`manifest.yaml` in the repo, so a malformed policy fails the build, not a
dispatch at 2am. After a change, `GET /api/targets` shows each target with its
live `check()` (`absent` until configured, `ok` once the probe passes).

## The targets

| target | transport | goes out as | comes back as | doc |
| --- | --- | --- | --- | --- |
| a `github-issues` connection | `github` | an issue in the connection's `repo` | status only — `github-state` closes the work row (`gh:owner/repo#n`) | [below](#github-issues) |
| a `devin` connection | `http` (`submit.kind: devin-session`) | a Devin session (`devin:<session_id>`) | the structured answer as a `report` proposal, polled home by `collectors/devin-sessions` | `docs/ops/devin.md` |
| `local-crew` | `local` | a `work` row the assistant container's drain loop claims | whatever the crew reports, plus a `crew_run` row | `docs/ops/crews.md` |

Three dispatchers exist. A connection's go through `POST
/api/tasks/:id/dispatch` (the `user` principal only); `local` goes through the
assistant's `agents_delegate` tool — its policy is that target's `data_policy`
narrowed by the crew's `scope`. A target of any other transport validates and
lists, and `dispatch()` refuses it explicitly by name (`invalid_request`) — a
registered target is never a silent no-op.

A Devin dispatch is the one whose **content** comes back, not just its
status: `result.via: report_queue` is real there, where `github-issues` still
carries it as a TODO. It also has a real per-dispatch budget (Devin's
`max_acu_limit`) and a machine-checkable return (a Draft-7
`structured_output_schema`) — both reasons to prefer it over an issue for
research. See `docs/ops/devin.md`, "Dispatch out".

## The data policy, precisely

`checkBrief()` runs before anything is sent and returns **every** violation
it finds:

| violation            | rule                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| `brief_too_large`    | UTF-8 bytes > `max_brief_bytes` (checked first; an oversized brief is not scanned)     |
| `denied_source`      | a `source:`/`sources:` marker (frontmatter, `<!-- source: comms -->`, or `[a, b]` list) naming a class in `deny_sources`, or the caller's own `sources: []` declaration |
| `path_outside_allow` | any vault-root token (plain, wikilink, backticks) not under an `allow` prefix — per segment, `..`/`.` never match |

A refusal is a `runs` row too (`kind = 'dispatch'`, `ok = false`,
`error = 'data_policy: ...'`, `meta.violations`), so the mechanism is visible,
not silent. Widen `allow` in an instance overlay, never in the product
default.

## GitHub issues

A `github-issues` connection (type `seed/connection-types/github-issues`).
Dispatch opens an issue in the connection's `repo`: title = the task's title,
body = the brief plus a footer naming the task id and the return path. The
task row gets `external_ref = gh:owner/repo#n`, `status = in_progress`,
`claimed_by = target:github-issues` (no lease — held until the source closes
it), and a `dispatch` entry in `history`.

### The write token — exact permission set

Create a **fine-grained** personal access token (GitHub → Settings →
Developer settings → Fine-grained tokens):

- **Repository access:** *Only select repositories* → the dispatch repo(s).
  Nothing else.
- **Repository permissions:** **Issues: Read and write**, **Metadata: Read**
  (added automatically). No Contents, no Pull requests, no Actions.
- **Expiration:** set one; the check() probe goes `failed` with a 401 when it
  lapses, and the watchdog will tell you.

Store it as the connection's secret (`metistry secrets set
github_write_token`, scoped to `api.github.com` and granted to
`connection:github-issues`; the commands are in `docs/ops/connections.md`,
*Agent connections*). It is deliberately a different token from the read-only
one the `github` connection's sync uses: a leaked write token must not also
read your whole world, and a leaked read token must not be able to write
anything.

### Return path — what exists and what does not

- **Status returns today, with nothing new.** Add the dispatch repo to the
  `github` connection's `repos`. `github-state` (every 15 min) upserts by
  `external_ref` — the partial unique index `work_external_ref_uidx` means
  `ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL` hits the
  dispatched row rather than inserting a twin — and marks the row `closed`
  when the issue is no longer open. Tested end to end with a GitHub fake in
  `apps/console/test/dispatch.integration.test.ts`.
- **Content does not return yet.** `github-state` does not fetch comments.
  When it does, a closing comment should land as a `report` proposal in the
  queue (§4.11). The connection type's `dispatch.result` carries the TODO; nothing on
  the dispatch side needs to change.

### Verifying

```bash
# checks: absent until the connection's key is delivered, ok once the token can read the repo
curl -s --cookie "$SESSION" https://<origin>/api/targets | jq '.targets[] | {name, check}'
# dispatch task 12 (session cookie only — an owner token is 403)
curl -s --cookie "$SESSION" -H 'content-type: application/json' \
  -d '{"target":"github-issues","brief":"Implement X per Projects/X.md"}' \
  https://<origin>/api/tasks/12/dispatch
# per-target spend, straight from runs (§4.18.D)
psql ... -c "SELECT tool, count(*), sum(cost_usd) FROM runs WHERE kind='dispatch' AND ok GROUP BY 1"
```

## Routes

| route                              | auth            | body / result                                                                                      |
| ---------------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/targets`                 | passkey session | `{ targets: [{ name, transport, submit, result, auth, cost, data_policy, check, connection? }], as_of }` |
| `POST /api/tasks/:id/dispatch`     | passkey session | `{ target, brief, sources?, purpose?, max_acu? }` → `201 { ok, ref, url, run_id }`; `400` + `violations[]` on a policy refusal (and on an unknown `purpose` or a non-positive `max_acu`); `409` + `check` when the target is unavailable or the task is already bound/closed; `404` unknown task/target |

`purpose` is `work` (default) or `knowledge_research` — why the brief is
going, which selects the preamble and is recorded on the runs row, the work
row and the session's tags. Deliberately a field on the dispatch call rather
than a new `work.kind`: `packages/tasks` owns two claimable kinds and
`github-state` owns the rest, so a third would ripple for no gain.
`max_acu` is the per-dispatch budget ceiling for targets that have one; it
overrides the connection type's `dispatch.max_acu`.

Owner tokens and agent tokens get a uniform `403` — dispatch is outbound and
lives on the management surface (CRIT-7).
