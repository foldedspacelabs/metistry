// artifact_* tools (§4.21) — an adapter over the artifacts module's one
// service, adding nothing: the principal comes from the credential, the
// project boundary, CAS, idempotency, the autonomy boundary, and the
// ping-pong cap are all the service's. What this file owns is the MCP
// shape and the scope translation: an artifact outside the caller's
// projects is `not_found`, uniform with tasks_*; a publish into a project
// the caller is not a member of is `forbidden`, uniform with tasks_create.
// Every string that reaches the agent passes the server's sanitizer.

import { z } from "zod";
import { ArtifactsError, type ArtifactsService, type Principal } from "@foldedspacelabs/metistry-artifacts";
import { done, fail, type Outcome } from "./outcome.js";
import { allProjects } from "./scope.js";
import type { AgentPrincipal } from "./types.js";

export const ARTIFACTS_TOOL_NAMES = ["artifacts_publish", "artifacts_get", "artifacts_list", "artifacts_comment", "artifacts_resolve", "artifacts_review"] as const;
export type ArtifactsToolName = (typeof ARTIFACTS_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: ArtifactsToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

/** The module's principal, from the bridge's: membership is what the credential said (server-side), never a tool argument. */
export function toPrincipal(p: AgentPrincipal): Principal {
  return { kind: "agent", id: p.id, projects: p.projects, all_projects: allProjects(p), agent_kind: p.kind === "internal" ? "internal" : "external" };
}

const artId = z.string().regex(/^art_[0-9A-HJKMNP-TV-Z]{26}$/);
const verId = z.string().regex(/^ver_[0-9A-HJKMNP-TV-Z]{26}$/);
const cmtId = z.string().regex(/^cmt_[0-9A-HJKMNP-TV-Z]{26}$/);
const TEXT_KINDS = new Set(["markdown", "text", "json", "csv", "html"]);
const MAX_TEXT = 200_000;

const NOT_AVAILABLE = "artifacts are not configured in this deployment (the console needs a vault bridge — docs/ops/reconciler.md)";

export function registerArtifactTools(reg: Register, service: ArtifactsService | undefined, agent: AgentPrincipal): void {
  const principal = toPrincipal(agent);

  /** ArtifactsError → envelope; a null from the service is a scope miss or an unknown id: not_found, uniform. */
  const guard = async (fn: (svc: ArtifactsService) => Promise<Outcome>): Promise<Outcome> => {
    if (!service) return fail("not_available", NOT_AVAILABLE);
    try {
      return await fn(service);
    } catch (err) {
      if (err instanceof ArtifactsError) return fail(err.code, err.message);
      throw err;
    }
  };

  reg(
    "artifacts_publish",
    "Publish a new version of an artifact into one of your projects. Compare-and-swap via expected_current_version (null = new); a stale publish gets `conflict`. Same idempotency_key returns the same version.",
    {
      project: z.string().max(200),
      slug: z.string().min(1).max(80).describe("Directory name under Artifacts/<project>/ — lowercase, digits, . _ -"),
      files: z
        .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(2_000_000).optional(), content_base64: z.string().max(11_000_000).optional() }))
        .min(1)
        .max(200)
        .describe("Relative paths; exactly one of content or content_base64 per file."),
      expected_current_version: verId.nullable().optional().describe("Version id you read, or null for 'must not exist yet'; omit for latest."),
      idempotency_key: z.string().min(1).max(200),
      message: z.string().min(1).max(2000).describe("Commit message (first line is the subject)."),
    },
    (a) =>
      guard(async (svc) => {
        const r = await svc.publish(
          {
            project: a.project,
            slug: a.slug,
            files: a.files,
            idempotency_key: a.idempotency_key,
            message: a.message,
            ...(a.expected_current_version !== undefined ? { expected_current_version: a.expected_current_version } : {}),
          },
          principal,
        );
        return done(
          { artifact: r.artifact, version: { ...r.version, manifest: r.version.manifest }, links: r.links, deduplicated: r.deduplicated },
          { artifact: r.artifact.id, version: r.version.id, deduplicated: r.deduplicated, files: Object.keys(r.version.manifest).length },
        );
      }),
  );

  reg(
    "artifacts_get",
    "One artifact in your projects: current/given version, manifest, version list, comment threads, links. `path` also reads one file's content.",
    { id: artId, version: verId.optional(), path: z.string().max(300).optional() },
    (a) =>
      guard(async (svc) => {
        const got = a.version ? await svc.version(a.id, a.version, principal) : await svc.get(a.id, principal).then((g) => (g?.current ? { artifact: g.artifact, version: g.current, links: g.links! } : g ? { artifact: g.artifact, version: null, links: null } : null));
        if (!got) return fail("not_found");
        const versions = (await svc.versions(a.id, principal)) ?? [];
        const threads = got.version ? ((await svc.commentList(a.id, got.version.id, principal)) ?? []) : [];
        let file: { path: string; kind: string; content: string } | { path: string; kind: string; error: string } | null = null;
        if (a.path !== undefined) {
          if (!got.version) return fail("not_found");
          const f = await svc.readFile(a.id, got.version.id, a.path, principal);
          if (!f) return fail("not_found", "no such file in this version");
          file = TEXT_KINDS.has(f.kind) && f.content.length <= MAX_TEXT ? { path: f.path, kind: f.kind, content: f.content.toString("utf8") } : { path: f.path, kind: f.kind, error: "binary or too large to read here — open the version link" };
        }
        return done(
          {
            artifact: got.artifact,
            version: got.version,
            links: got.links,
            versions: versions.map((v) => ({ id: v.id, commit: v.commit, author: v.author_principal, author_kind: v.author_kind, message: v.message, created_at: v.created_at })),
            threads,
            ...(file ? { file } : {}),
          },
          { artifact: a.id, version: got.version?.id ?? null, threads: threads.length },
        );
      }),
  );

  reg(
    "artifacts_list",
    "Artifacts across your projects (or one of them), most recently updated first.",
    { project: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional() },
    (a) => guard(async (svc) => done({ artifacts: await svc.list({ project: a.project, limit: a.limit }, principal) })),
  );

  reg(
    "artifacts_comment",
    "Comment on an artifact version (optionally one file + anchor), or reply to a thread with `parent` (one level deep). Past the agent-only cap, the thread demotes to a user proposal.",
    {
      artifact: artId,
      version: verId,
      body: z.string().min(1).max(20_000),
      path: z.string().max(300).optional(),
      anchor: z.record(z.string(), z.unknown()).optional().describe("Opaque, client-owned, e.g. { line: 12 }."),
      parent: cmtId.optional().describe("Thread root to reply to; inherits its path/anchor."),
    },
    (a) =>
      guard(async (svc) => {
        if (a.parent) {
          const r = await svc.commentReply({ parent: a.parent, body: a.body }, principal);
          if (!r) return fail("not_found");
          return r.demoted ? done({ demoted: true, proposal_id: r.proposal_id, cap: r.cap }, { demoted: true, proposal_id: r.proposal_id }) : done({ comment: r.comment }, { comment: r.comment.id });
        }
        const c = await svc.commentCreate({ artifact: a.artifact, version: a.version, body: a.body, path: a.path, anchor: a.anchor }, principal);
        if (!c) return fail("not_found");
        return done({ comment: c }, { comment: c.id });
      }),
  );

  reg(
    "artifacts_resolve",
    "Resolve a thread root, or reopen with reopen: true. A review bundle is addressed once every thread resolves.",
    { id: cmtId, reopen: z.boolean().optional() },
    (a) =>
      guard(async (svc) => {
        const c = a.reopen ? await svc.commentReopen(a.id, principal) : await svc.commentResolve(a.id, principal);
        if (!c) return fail("not_found");
        return done({ comment: c }, { comment: c.id, state: c.state });
      }),
  );

  reg(
    "artifacts_review",
    "Send threads on one version to another agent as one claimable review task. Outside the project boundary or a manifest narrowing, it becomes a user proposal (`route: proposal`) instead. Over the open-bundle cap, the task queues rather than dropping.",
    {
      artifact: artId,
      version: verId,
      thread_ids: z.array(cmtId).min(1).max(50),
      to_agent: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      message: z.string().max(2000).optional(),
      idempotency_key: z.string().min(1).max(200).optional(),
    },
    (a) =>
      guard(async (svc) => {
        const r = await svc.dispatchReview({ artifact: a.artifact, version: a.version, thread_ids: a.thread_ids, to_agent: a.to_agent, message: a.message, idempotency_key: a.idempotency_key }, principal);
        if (!r) return fail("not_found");
        return r.route === "work"
          ? done({ route: "work", work: r.work, links: r.links, queued: r.queued }, { route: "work", work_id: r.work.id, ...(r.queued ? { queued: r.queued.reason } : {}) })
          : done({ route: "proposal", proposal_id: r.proposal_id, reason: r.reason }, { route: "proposal", proposal_id: r.proposal_id });
      }),
  );
}
