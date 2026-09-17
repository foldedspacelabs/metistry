# Compute targets — dispatching work off the machine

A **target** (plan §4.18.B) is somewhere work can execute: a coding agent
watching a repo, a cloud worker speaking MCP, a local subagent. Each one is
a directory with a manifest (invariant 5), and the console's dispatch tool
(`apps/console/src/dispatch.ts`) is the **only** path a brief takes off the
machine. The manifest's `data_policy` is enforced there — a brief that would
carry comms-derived content, cite a personal vault path, or exceed the byte
cap is refused with a machine-readable reason. That is the rule "comms
never leaves the machine" as code, not as a prompt.

## Adding a target

1. Create `targets/<name>/manifest.yaml` (product default) — or, per
   instance, the same path under any dir listed in `METISTRY_TARGETS_DIRS`
   (colon-separated; later dirs override earlier ones by `name`, D4 overlay).
   The directory name must equal the manifest's `name`.
2. Fill in the manifest (schema: `packages/core/src/manifest.ts`,
   `targetManifest`):

```yaml
name: github-issues
type: target
description: Open a GitHub issue for a task
transport: github                    # mcp | http | github | local
submit: { repo: env:METISTRY_GITHUB_DISPATCH_REPO }   # github: owner/repo or env:VAR
result:
  via: report_queue                  # the only return path (§4.18.B)
  status_via: github-state           # free-form notes are allowed under result:
auth: env:METISTRY_GITHUB_WRITE_TOKEN  # ALWAYS an env reference, never a literal
cost: { per_run_estimate_usd: 0 }    # written to runs.cost_usd on every dispatch
data_policy:                         # REQUIRED, every field
  allow: [Projects]        # vault prefixes a brief may cite; [] = none
  deny_sources: [comms]              # provenance classes that never leave
  max_brief_bytes: 16384
```

3. Run `pnpm test`. CI validates every `manifest.yaml` in the repo
   (`apps/console/test/manifests.test.ts`), so a malformed policy fails the
   build, not a dispatch at 2am.
4. Restart the console; `GET /api/targets` shows the manifest with its live
   `check()` (`absent` until configured, `ok` once the probe passes).

## The shipped targets

| target | transport | goes out as | comes back as | doc |
| --- | --- | --- | --- | --- |
| `github-issues` | `github` | an issue in `METISTRY_GITHUB_DISPATCH_REPO` | status only — `github-state` closes the work row (`gh:owner/repo#n`) | [below](#the-first-target-github-issues) |
| `local-crew` | `local` | a `work` row the assistant container's drain loop claims | whatever the crew reports, plus a `crew_run` row | `docs/ops/crews.md` |
| `devin-sessions` | `http` (`submit.kind: devin-session`) | a Devin session (`devin:<session_id>`) | the structured answer as a `report` proposal, polled home by `collectors/devin-sessions` | `docs/ops/devin.md` |

Three transports have a dispatcher today. `github` and `http` go through
`POST /api/tasks/:id/dispatch` (the `user` principal only); `local` goes
through the assistant's `agents_delegate` tool — its policy is that target's
`data_policy` narrowed by the crew's `scope`. An `http` target whose
`submit.kind` this console does not implement, and every other transport,
validate and list, and `dispatch()` refuses them explicitly by name
(`invalid_request`) — a registered target is never a silent no-op.

`devin-sessions` is the first target whose **content** comes back, not just
its status: `result.via: report_queue` is real there, where `github-issues`
still carries it as a TODO. It is also the first with a real per-dispatch
budget (Devin's `max_acu_limit`) and a machine-checkable return (a Draft-7
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

## The first target: GitHub issues

`targets/github-issues/manifest.yaml`. Dispatch opens an issue in
`METISTRY_GITHUB_DISPATCH_REPO`: title = the task's title, body = the brief
plus a footer naming the task id and the return path. The task row gets
`external_ref = gh:owner/repo#n`, `status = in_progress`,
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

Put it in `.env` as `METISTRY_GITHUB_WRITE_TOKEN`. It is deliberately a
different token from `METISTRY_GITHUB_TOKEN` (the collector's read-only PAT
over every configured repo): a leaked write token must not also read your
whole world, and a leaked read token must not be able to write anything.

### Return path — what exists and what does not

- **Status returns today, with nothing new.** Add the dispatch repo to
  `METISTRY_GITHUB_REPOS`. `github-state` (every 15 min) upserts by
  `external_ref` — the partial unique index `work_external_ref_uidx` means
  `ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL` hits the
  dispatched row rather than inserting a twin — and marks the row `closed`
  when the issue is no longer open. Tested end to end with a GitHub fake in
  `apps/console/test/dispatch.integration.test.ts`.
- **Content does not return yet.** `github-state` does not fetch comments.
  When it does, a closing comment should land as a `report` proposal in the
  queue (§4.11). The manifest's `result:` block carries the TODO; nothing on
  the dispatch side needs to change.

### Verifying

```bash
# checks: absent until both env vars are set, ok once the token can read the repo
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
| `GET /api/targets`                 | passkey session | `{ targets: [{ name, transport, submit, result, auth, cost, data_policy, check }], as_of }`         |
| `POST /api/tasks/:id/dispatch`     | passkey session | `{ target, brief, sources?, purpose?, max_acu? }` → `201 { ok, ref, url, run_id }`; `400` + `violations[]` on a policy refusal (and on an unknown `purpose` or a non-positive `max_acu`); `409` + `check` when the target is unavailable or the task is already bound/closed; `404` unknown task/target |

`purpose` is `work` (default) or `knowledge_research` — why the brief is
going, which selects the preamble and is recorded on the runs row, the work
row and the session's tags. Deliberately a field on the dispatch call rather
than a new `work.kind`: `packages/tasks` owns two claimable kinds and
`github-state` owns the rest, so a third would ripple for no gain.
`max_acu` is the per-dispatch budget ceiling for targets that have one; it
overrides the manifest's `submit.max_acu`.

Owner tokens and agent tokens get a uniform `403` — dispatch is outbound and
lives on the management surface (CRIT-7).
