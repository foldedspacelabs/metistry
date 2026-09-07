# @foldedspacelabs/metistry-artifacts

Publish-and-review for agent output. An **artifact** is the versioned,
commentable result of agent work — a plan, a report, an HTML page, a
mockup, a CSV — that today lands as an unreviewable chat reply. This
module gives it:

- **Versions that are commits.** Content lives in a directory
  `Artifacts/<project>/<slug>/` behind a *vault client*; every publish
  writes its files under one commit intent, so history is `git log` and
  a diff is `git diff`. No object store, no upload API.
- **Compare-and-swap publish.** Pass the current version you read; a
  stale publisher gets `conflict`, never a silent overwrite. Retrying with
  the same `idempotency_key` returns the same version.
- **Comment threads on an exact version**, optionally on one file with an
  opaque client-owned anchor; one level of replies; `open`/`resolved`;
  every author denormalized from the *server-side* principal.
- **Review dispatch that rides a shared task list**: a bundle of threads
  becomes ONE claimable `review` task for another agent
  (`@foldedspacelabs/metistry-tasks`), and "addressed" is inferred from
  the threads — nothing writes it.
- **An autonomy boundary enforced in the service, not by prompting.**
  Inside a project agents collaborate freely; a dispatch to an agent that
  is not a member of the artifact's project becomes a proposal for the
  user. Two agents cannot trade replies forever: past a per-thread cap of
  consecutive agent-only replies the thread demotes to the user with its
  transcript.

It is one TypeScript service. HTTP routes, MCP tools, or CLI verbs are
thin adapters over it — policy lives here once. Runtime dependencies:
`@foldedspacelabs/metistry-core` and `@foldedspacelabs/metistry-tasks`
(which pull `zod`). No framework, no ORM, no git binary.

## Install

```sh
npm i @foldedspacelabs/metistry-artifacts @foldedspacelabs/metistry-tasks pg
```

Any client with pg's `query(text, values)` shape works. The schema is
`db/migrations/0010_artifacts.sql` in the Metistry repo (three tables:
`artifacts`, `artifact_versions`, `artifact_comments`) plus the tasks
module's `work`/`runs` and a `proposals` table for demotions.

## Use

```ts
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, memoryVault, staticDirectory } from "@foldedspacelabs/metistry-artifacts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const artifacts = new ArtifactsService(pool, memoryVault(), {
  origin: "https://console.example",          // links are built from this
  tasks: new TasksService(pool),               // review bundles ride this list
  agents: staticDirectory([                    // who is a member of what (the target side of a dispatch)
    { id: "writer", kind: "external", projects: ["launch"], revoked: false },
    { id: "qa", kind: "external", projects: ["launch"], revoked: false },
  ]),
});

// The second argument is ALWAYS the principal your adapter derived from
// the credential. Never read it from the request — self-declared identity
// is how audit logs get forged.
const writer = { kind: "agent", id: "writer", projects: ["launch"] } as const;
const qa = { kind: "agent", id: "qa", projects: ["launch"] } as const;
const user = { kind: "user", id: "user" } as const;

const v1 = await artifacts.publish(
  { project: "launch", slug: "plan", files: [{ path: "plan.md", content: "# Plan\n" }], expected_current_version: null, idempotency_key: "plan-1", message: "first draft" },
  writer,
);
v1.links; // { artifact, version, review } — hand the user `review` first

const thread = await artifacts.commentCreate({ artifact: v1.artifact.id, version: v1.version.id, path: "plan.md", anchor: { line: 1 }, body: "tighten the intro" }, user);
const bundle = await artifacts.dispatchReview({ artifact: v1.artifact.id, version: v1.version.id, thread_ids: [thread!.id], to_agent: "qa" }, writer);
// bundle.route === "work": one `work` row of kind `review`, owner qa, claimable via TasksService
await artifacts.commentResolve(thread!.id, qa);
(await artifacts.bundleStatus(bundle!.route === "work" ? bundle.work.id : 0, qa))?.addressed; // true — inferred

// a stale publish is refused, never merged
await artifacts.publish({ project: "launch", slug: "plan", files: [{ path: "plan.md", content: "…" }], expected_current_version: null, idempotency_key: "plan-2", message: "oops" }, writer); // throws ArtifactsError("conflict")
```

### The vault client

The service never touches a filesystem or git. It takes any object with
this shape (`VaultClient`):

| Method | Meaning |
| --- | --- |
| `read(path)` | `{ path, content: Buffer, sha256, bytes }` or `null` |
| `write(path, content, intent, expectedSha256?)` | lands at once; `intent = { principal, message, group }` — `group` is what makes a multi-file publish one commit |
| `delete(path, intent)` | absent path is not an error |
| `list(prefix, depth?)` | files and dirs |
| `log(path, limit?)` | commits touching the path, newest first — `{ sha, author, date, subject }` |
| `diff(path, from, to)` | unified diff between revisions; `to = null` is the working tree |
| `flush?()` | optional: commit now (the service calls it after each publish so two publishes inside one flush interval stay two commits) |

`memoryVault()` ships in the package: the same semantics with no
repository, for tests or a no-git deployment. In Metistry the console
provides an HTTP implementation over the reconciler's vault bridge
(`apps/console/src/vault-client.ts`) — the reconciler is the only process
that holds the repo and runs git.

The commit sha of a version is `null` until the vault has flushed; reads
resolve it lazily from `log()` by the `(ver_…)` tag every publish puts in
its commit subject. Nothing waits on git.

## API

Every mutating call takes a `Principal` last — `{ kind: 'user' | 'agent'
| 'system', id, projects?, all_projects?, agent_kind? }` — and records a
`runs` row (`component = principal id`, `kind = 'artifact_op'`,
`meta = { module, op, … }`). For an **agent** principal every read and
write is scoped to its projects: an artifact outside them returns `null`
(render as `not_found`, never as "forbidden" — no existence leak); a
publish into a project it is not a member of throws `forbidden`.
Membership comes from `projects`/`all_projects` on the principal when the
adapter knows them, else from the `agents` directory.

| Method | Does | Returns |
| --- | --- | --- |
| `publish(input, p)` | `{ project, slug, files: [{ path, content \| content_base64 }], expected_current_version?, idempotency_key, message }`. CAS on `expected_current_version` (`undefined` = whatever is current, `null` = must be new, an id = exact); one commit intent group = the version id; kind sniffed from content (magic bytes for image/pdf, markup → `html`, JSON by parse, markdown by shape; the extension only breaks ties). Files the previous version had and this one lacks are deleted in the same commit. | `{ artifact, version, links, deduplicated }` |
| `get(id, p)` | The artifact, its current version (commit resolved), links. | `{ artifact, current, links } \| null` |
| `list({ project?, limit? }, p)` | By project, or every project the principal can see. | `Artifact[]` |
| `versions(id, p)` / `version(id, ver, p)` | Newest first; the exact one. | `Version[] \| null` / `{ artifact, version, links } \| null` |
| `readFile(id, ver, path, p)` | Bytes from the working tree, only while the hash still matches that version (else `not_available` — diff instead). | `{ path, kind, sha256, content } \| null` |
| `diff(id, from, to, p)` | `git diff` between two versions (`to = null` → working tree); `not_available` until both are committed. | `{ from, to, diff } \| null` |
| `links(artifactId, versionId)` | `artifact` (follows current), `version` (exact), `review` (exact, comments open) — `<origin>/#/artifacts/<id>[/<ver>[/review]]`. | `Links` |
| `commentCreate({ artifact, version, path?, anchor?, body }, p)` | A thread root on an exact version; `path` must be in the version's manifest. | `Comment \| null` |
| `commentReply({ parent, body }, p)` | One level: `parent` must be a root. Past the cap of consecutive agent-only comments, an agent reply is NOT stored: the thread becomes one pending `proposals` row (kind `review`, reason `ping_pong_cap`) with the transcript. A human reply resets the run. | `{ demoted: false, comment } \| { demoted: true, proposal_id, cap } \| null` |
| `commentResolve(id, p)` / `commentReopen(id, p)` | Roots only. | `Comment \| null` |
| `commentList(id, ver, p)` | Roots in order, replies nested. | `Thread[] \| null` |
| `dispatchReview({ artifact, version, thread_ids, to_agent, message?, idempotency_key? }, p)` | Every thread must be a root on that version (a cross-version handle is rejected at write). Route: the user always → `work`; an agent → `work` only if it AND `to_agent` are members of the artifact's project, else a `proposals` row (kind `review`, reason `outside_project`). `work` = one `TasksService.create` of kind `review`, `owner = to_agent`, `meta.bundle = { artifact, version, thread_ids, from, to_agent, links }` — handles, never payloads. | `{ route: 'work', work, links } \| { route: 'proposal', proposal_id, reason } \| null` |
| `bundleStatus(workId, p)` | Reads the bundle's threads; `addressed = every thread resolved`. Nothing writes it. | `BundleStatus \| null` |
| `check()` | Behavioral probe: selects every column the service needs and lists `Artifacts/` through the vault. | `CheckResult` |

Errors are `ArtifactsError` with a core `ErrorCode` (`invalid_request`,
`forbidden`, `conflict`, `not_found`, `not_available`) so an adapter can
pass them through the uniform envelope unchanged.

### Options

| Option | Meaning |
| --- | --- |
| `origin` | canonical console origin for links |
| `tasks?` | a `TasksService`; absent → `dispatchReview`/`bundleStatus` throw `not_available` |
| `agents?` | an `AgentDirectory` (`lookup(id) → { id, kind, projects, revoked } \| null`); default reads Metistry's `agents` table (`internal` + empty list = every project) |
| `maxFiles?` / `maxBytes?` | per-publish caps (200 / 8 MB) |
| `pingPongCap?` | consecutive agent-only comments a thread may hold before the next agent reply demotes it (default 10) |

### Pure policy

Exported for anyone who wants the rules without the rows: `casAllows`,
`agentTailLength`, `pingPongDemotes`, `inferAddressed`, `dispatchRoute`,
`validFilePath`, `sniffKind`, `artifactKind`, `contentTypeFor`.

## Rendering, if you build a viewer

The kind is sniffed from bytes, never from the extension, and anything
that could carry script — HTML, SVG, XML with markup — is `html`. Render
`html` only inside an opaque-origin sandboxed iframe (`sandbox=""`, no
tokens) with a CSP inside the document; serve raw bytes to a browser only
for `image`/`pdf` (`contentTypeFor`), everything else as an attachment,
and never as `text/html` on your own origin. Metistry's console PWA is one
such viewer (`apps/console/web/app.js`, "artifacts").

## In Metistry

The console mounts the service twice over one instance: session-only
routes under `/api/artifacts` + `/api/dispatches` for the user, and the
`artifact_*` tools on `mcp-brain` for agents (`packages/mcp-brain/src/
artifacts-tools.ts`). Storage goes through the reconciler's vault bridge
(`METISTRY_RECONCILER_URL` + `METISTRY_BRIDGE_TOKEN_RECONCILER`); without
it both adapters answer `not_available`.
