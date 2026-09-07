// artifacts module (plan §4.21, built as a §4.20 module): versioned,
// commentable output of agent work. One TypeScript service; the console
// routes, mcp-brain tools, and CLI verbs adapt it and add nothing.
//
// Storage: git is the record. Content lives at
// `Artifacts/<project>/<slug>/` behind the injected vault client; every
// publish writes its files under ONE intent group = the version id, so
// the reconciler lands one commit per version. Postgres holds the index
// (artifacts, artifact_versions — derived) and the comment threads
// (artifact_comments — durable, D6). The commit sha is filled lazily from
// `vault.log` — nothing waits on git.
//
// Trust rules (§4.19/§4.20), enforced here, not in adapters:
// - the principal is what the adapter derived from the credential; no
//   field in an input is ever read as identity;
// - project membership is the scope for every read and write an AGENT
//   makes (a row outside its projects is `not_found`, uniform);
// - review dispatch across the boundary, and a thread that exceeds the
//   ping-pong cap, are demoted to `proposals` rows by rule;
// - the §4.21 controls ride the same dispatch: the project's `mode`
//   (review = every agent-to-agent bundle becomes a proposal), manifest
//   narrowing (`may_dispatch_to` / `accept_from`), per-agent and
//   per-project open-bundle caps (over cap = queued, never dropped), and
//   the daily soft budget (over budget = the project flips to review);
// - every mutation is a `runs` row (component = principal id, kind =
//   artifact_op) and is idempotent or compare-and-swap.

import {
  DEFAULT_MAX_OPEN_BUNDLES,
  PROJECT_COLS,
  ensureProject,
  finishRun,
  runCheck,
  startRun,
  toProjectRow,
  type CheckResult,
  type ErrorCode,
  type ProjectMode,
} from "@foldedspacelabs/metistry-core";
import type { Task, TasksService } from "@foldedspacelabs/metistry-tasks";
import { isId, newId } from "./ids.js";
import { artifactKind, sniffKind, type FileKind } from "./kinds.js";
import {
  AGENT_RE,
  DEFAULT_AGENT_BUNDLE_CAP,
  DEFAULT_PING_PONG_CAP,
  PROJECT_RE,
  SLUG_RE,
  agentTailLength,
  budgetExceeded,
  capExceeded,
  casAllows,
  dispatchDecision,
  inferAddressed,
  parseAutonomy,
  pingPongDemotes,
  validFilePath,
  type AuthorKind,
  type Autonomy,
  type CapReason,
  type DispatchProposalReason,
} from "./policy.js";
import { VaultError, sha256Hex, type VaultClient } from "./vault.js";

/** Minimal executor shape — satisfied by pg.Pool / pg.Client / a fake. */
export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * The server-side principal (§4.20). For an agent, `projects` /
 * `all_projects` are what the adapter learned from the credential; when
 * the adapter cannot say (undefined), the agent directory is consulted.
 */
export interface Principal {
  kind: "user" | "agent" | "system";
  id: string;
  projects?: string[] | undefined;
  all_projects?: boolean | undefined;
  /** agent only: feeds `proposals.trust`; default external */
  agent_kind?: "internal" | "external" | undefined;
}

export interface AgentInfo {
  id: string;
  kind: "internal" | "external";
  projects: string[];
  revoked: boolean;
  /** §4.21 narrowing from the agent's manifest (`agents.autonomy`); absent = project defaults. */
  autonomy?: Autonomy | undefined;
}

/** Who is a member of what — the target side of a dispatch needs it; the caller side usually rides the principal. */
export interface AgentDirectory {
  lookup(id: string): Promise<AgentInfo | null>;
}

/** The default directory: the console's `agents` table (0007). */
export function agentsTableDirectory(db: Db): AgentDirectory {
  return {
    async lookup(id) {
      const { rows } = await db.query(`SELECT id, kind, projects, revoked_at, autonomy FROM agents WHERE id = $1`, [id]);
      const r = rows[0];
      if (!r) return null;
      return { id: String(r.id), kind: r.kind === "internal" ? "internal" : "external", projects: (r.projects as string[] | null) ?? [], revoked: r.revoked_at !== null && r.revoked_at !== undefined, autonomy: parseAutonomy(r.autonomy) };
    },
  };
}

export function staticDirectory(agents: AgentInfo[]): AgentDirectory {
  const m = new Map(agents.map((a) => [a.id, a]));
  return { async lookup(id) { return m.get(id) ?? null; } };
}

/** mcp-brain's internal rule, restated: internal + empty list = every project. */
export function agentIsMember(info: AgentInfo | null, project: string): boolean {
  if (!info || info.revoked) return false;
  if (info.kind === "internal" && info.projects.length === 0) return true;
  return info.projects.includes(project);
}

export interface ManifestEntry {
  sha256: string;
  bytes: number;
  kind: FileKind;
}

export interface Artifact {
  id: string;
  project: string;
  slug: string;
  kind: string | null;
  current_version: string | null;
  visibility: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Version {
  id: string;
  artifact_id: string;
  commit: string | null;
  path_prefix: string;
  manifest: Record<string, ManifestEntry>;
  author_principal: string;
  author_kind: string;
  message: string;
  idempotency_key: string | null;
  created_at: Date;
}

export interface Comment {
  id: string;
  artifact_id: string;
  version_id: string;
  path: string | null;
  anchor: unknown;
  body: string;
  state: "open" | "resolved";
  author_principal: string;
  author_kind: AuthorKind;
  resolved_by: string | null;
  resolved_at: Date | null;
  parent_id: string | null;
  created_at: Date;
}

export interface Thread extends Comment {
  replies: Comment[];
}

/** The three links every publish returns (§4.21): follows-current, exact, and exact-with-comments-open. */
export interface Links {
  artifact: string;
  version: string;
  review: string;
}

export interface PublishFile {
  path: string;
  content?: string | undefined;
  content_base64?: string | undefined;
}

export interface PublishInput {
  project: string;
  slug: string;
  files: PublishFile[];
  kind?: string | undefined;
  /** undefined = whatever is current; null = must be new; a version id = exact */
  expected_current_version?: string | null | undefined;
  idempotency_key: string;
  message: string;
}

export interface PublishResult {
  artifact: Artifact;
  version: Version;
  links: Links;
  deduplicated: boolean;
}

export interface CommentCreateInput {
  artifact: string;
  version: string;
  path?: string | undefined;
  anchor?: unknown;
  body: string;
}

export interface CommentReplyInput {
  parent: string;
  body: string;
}

export type ReplyResult = { demoted: false; comment: Comment } | { demoted: true; proposal_id: number; cap: number };

export interface DispatchInput {
  artifact: string;
  version: string;
  thread_ids: string[];
  to_agent: string;
  message?: string | undefined;
  idempotency_key?: string | undefined;
}

/** Set when a bundle was created QUEUED (status blocked) because a cap was reached; it is released when a slot frees. */
export interface DispatchQueued {
  reason: CapReason;
  cap: number;
  open: number;
}

export type DispatchResult =
  | { route: "work"; work: Task; links: Links; queued: DispatchQueued | null }
  | { route: "proposal"; proposal_id: number; reason: DispatchProposalReason };

/** What the §4.21 controls read about a project: the row, or the defaults when the slug has none yet. */
export interface ProjectPolicy {
  id: string;
  mode: ProjectMode;
  daily_budget_usd: number | null;
  max_open_bundles: number;
  exists: boolean;
}

export interface BudgetResult {
  project: string;
  mode: ProjectMode;
  spend_usd: number;
  budget_usd: number | null;
  /** True on THIS call only when the check moved the project to review mode. */
  flipped: boolean;
}

export interface BundleStatus {
  work_id: number;
  artifact: string;
  version: string;
  to_agent: string;
  from: string;
  threads: Array<{ id: string; state: "open" | "resolved" }>;
  addressed: boolean;
  status: string;
}

export class ArtifactsError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface ArtifactsServiceOptions {
  /** Canonical console origin (METISTRY_ORIGIN) — links are built from it. */
  origin: string;
  /** The shared task list review bundles ride on; absent → dispatch answers not_available. */
  tasks?: TasksService | undefined;
  /** Membership for the target of a dispatch; default = the `agents` table. */
  agents?: AgentDirectory | undefined;
  maxFiles?: number | undefined;
  maxBytes?: number | undefined;
  pingPongCap?: number | undefined;
  /** Default per-agent open-bundle cap when the agent's autonomy sets none (§4.21). */
  agentBundleCap?: number | undefined;
}

const fail = (code: ErrorCode, message?: string) => new ArtifactsError(code, message);

const ART_COLS = `id, project, slug, kind, current_version, visibility, created_by, created_at, updated_at`;
const VER_COLS = `id, artifact_id, commit, path_prefix, manifest, author_principal, author_kind, message, idempotency_key, created_at`;
const CMT_COLS = `id, artifact_id, version_id, path, anchor, body, state, author_principal, author_kind, resolved_by, resolved_at, parent_id, created_at`;

const toArtifact = (r: Record<string, unknown>): Artifact => r as unknown as Artifact;
const toVersion = (r: Record<string, unknown>): Version => ({ ...(r as unknown as Version), manifest: (r.manifest as Record<string, ManifestEntry> | null) ?? {} });
const toComment = (r: Record<string, unknown>): Comment => r as unknown as Comment;

const VERSION_TAG = /\((ver_[0-9A-HJKMNP-TV-Z]{26})\)$/;

export class ArtifactsService {
  private readonly origin: string;
  private readonly agents: AgentDirectory;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly cap: number;
  private readonly agentBundleCap: number;

  constructor(
    private readonly db: Db,
    private readonly vault: VaultClient,
    private readonly opts: ArtifactsServiceOptions,
  ) {
    this.origin = opts.origin.replace(/\/+$/, "");
    this.agents = opts.agents ?? agentsTableDirectory(db);
    this.maxFiles = opts.maxFiles ?? 200;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.cap = opts.pingPongCap ?? DEFAULT_PING_PONG_CAP;
    this.agentBundleCap = opts.agentBundleCap ?? DEFAULT_AGENT_BUNDLE_CAP;
  }

  // --- scope ------------------------------------------------------------------

  /** The caller's membership: user/system always; an agent by what the credential said, else by the directory. */
  private async callerIsMember(p: Principal, project: string): Promise<boolean> {
    if (p.kind !== "agent") return true;
    if (p.all_projects) return true;
    if (p.projects !== undefined) return p.projects.includes(project);
    return agentIsMember(await this.agents.lookup(p.id), project);
  }

  /** An artifact outside an agent's projects does not exist for it (uniform with tasks_*). */
  private async scoped(id: unknown, p: Principal): Promise<Artifact | null> {
    if (!isId(id, "art")) return null;
    const { rows } = await this.db.query(`SELECT ${ART_COLS} FROM artifacts WHERE id = $1`, [id]);
    const a = rows[0] ? toArtifact(rows[0]) : null;
    if (!a || !(await this.callerIsMember(p, a.project))) return null;
    return a;
  }

  private async versionOf(a: Artifact, versionId: unknown): Promise<Version | null> {
    if (!isId(versionId, "ver")) return null;
    const { rows } = await this.db.query(`SELECT ${VER_COLS} FROM artifact_versions WHERE id = $1 AND artifact_id = $2`, [versionId, a.id]);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  // --- action record --------------------------------------------------------------

  private async recorded<T>(p: Principal, op: string, meta: Record<string, unknown>, fn: () => Promise<T>, more?: (out: T) => Record<string, unknown>): Promise<T> {
    const runId = await startRun(this.db, { component: p.id, kind: "artifact_op", meta: { module: "artifacts", op, principal_kind: p.kind, ...meta } });
    try {
      const out = await fn();
      await finishRun(this.db, runId, { ok: true, meta: more ? more(out) : {} });
      return out;
    } catch (err) {
      await finishRun(this.db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  // --- links -----------------------------------------------------------------

  links(artifactId: string, versionId: string): Links {
    return {
      artifact: `${this.origin}/#/artifacts/${artifactId}`,
      version: `${this.origin}/#/artifacts/${artifactId}/${versionId}`,
      review: `${this.origin}/#/artifacts/${artifactId}/${versionId}/review`,
    };
  }

  // --- publish -------------------------------------------------------------------

  async publish(input: PublishInput, p: Principal): Promise<PublishResult> {
    const project = requireSlug("project", input.project, PROJECT_RE);
    const slug = requireSlug("slug", input.slug, SLUG_RE);
    const key = requireText("idempotency_key", input.idempotency_key, 200);
    const message = requireText("message", input.message, 2000);
    if (input.expected_current_version !== undefined && input.expected_current_version !== null && !isId(input.expected_current_version, "ver")) {
      throw fail("invalid_request", "expected_current_version must be a version id or null");
    }
    if (!Array.isArray(input.files) || input.files.length === 0) throw fail("invalid_request", "files required");
    if (input.files.length > this.maxFiles) throw fail("invalid_request", `at most ${this.maxFiles} files`);
    if (!(await this.callerIsMember(p, project))) throw fail("forbidden");

    // decode + hash up front: the manifest is known before anything is written
    const decoded = new Map<string, Buffer>();
    let total = 0;
    for (const f of input.files) {
      if (!validFilePath(f.path)) throw fail("invalid_request", `bad file path: ${String(f.path).slice(0, 80)}`);
      if (decoded.has(f.path)) throw fail("invalid_request", `duplicate path: ${f.path}`);
      const hasText = typeof f.content === "string";
      const hasB64 = typeof f.content_base64 === "string";
      if (hasText === hasB64) throw fail("invalid_request", `${f.path}: exactly one of content or content_base64`);
      const bytes = hasText ? Buffer.from(f.content!, "utf8") : Buffer.from(f.content_base64!, "base64");
      total += bytes.length;
      if (total > this.maxBytes) throw fail("invalid_request", `publish exceeds ${this.maxBytes} bytes`);
      decoded.set(f.path, bytes);
    }
    const manifest: Record<string, ManifestEntry> = {};
    for (const [path, bytes] of decoded) manifest[path] = { sha256: sha256Hex(bytes), bytes: bytes.length, kind: sniffKind(path, bytes) };
    const kind = artifactKind(manifest);

    return this.recorded(p, "publish", { project, slug, files: decoded.size, bytes: total }, async () => {
      await ensureProject(this.db, project); // the project row exists from the first use of its slug (0011)
      // idempotent on (principal, key): a retry hands back what the first call made
      const dup = await this.db.query(`SELECT ${VER_COLS} FROM artifact_versions WHERE author_principal = $1 AND idempotency_key = $2`, [p.id, key]);
      if (dup.rows[0]) {
        const version = toVersion(dup.rows[0]);
        const art = await this.db.query(`SELECT ${ART_COLS} FROM artifacts WHERE id = $1`, [version.artifact_id]);
        return { artifact: toArtifact(art.rows[0]!), version, links: this.links(version.artifact_id, version.id), deduplicated: true };
      }

      const existing = await this.db.query(`SELECT ${ART_COLS} FROM artifacts WHERE project = $1 AND slug = $2`, [project, slug]);
      const prior = existing.rows[0] ? toArtifact(existing.rows[0]) : null;
      const current = prior?.current_version ?? null;
      if (!casAllows(current, input.expected_current_version)) throw fail("conflict", `current version is ${current ?? "none"}`);

      const versionId = newId("ver");
      const prefix = `Artifacts/${project}/${slug}`;
      // Reserve the pointer atomically: the WHERE clause is the CAS, so two
      // publishers racing on one artifact get exactly one winner.
      let artifact: Artifact;
      if (prior) {
        const { rows } = await this.db.query(
          `UPDATE artifacts SET current_version = $2, kind = $3, updated_at = now()
           WHERE id = $1 AND current_version IS NOT DISTINCT FROM $4 RETURNING ${ART_COLS}`,
          [prior.id, versionId, kind, current],
        );
        if (!rows[0]) throw fail("conflict", "the artifact changed under you — re-read and retry");
        artifact = toArtifact(rows[0]);
      } else {
        const { rows } = await this.db.query(
          `INSERT INTO artifacts (id, project, slug, kind, current_version, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project, slug) DO NOTHING RETURNING ${ART_COLS}`,
          [newId("art"), project, slug, kind, versionId, p.id],
        );
        if (!rows[0]) throw fail("conflict", "the artifact was created concurrently — re-read and retry");
        artifact = toArtifact(rows[0]);
      }

      const subject = `${message.split("\n")[0]!.slice(0, 150)} (${versionId})`; // the tag is how the commit is found later
      const { rows: vrows } = await this.db.query(
        `INSERT INTO artifact_versions (id, artifact_id, path_prefix, manifest, author_principal, author_kind, message, idempotency_key)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING ${VER_COLS}`,
        [versionId, artifact.id, prefix, JSON.stringify(manifest), p.id, p.kind, subject, key],
      );
      const version = toVersion(vrows[0]!);

      try {
        const intent = { principal: p.id, message: subject, group: versionId };
        for (const [path, bytes] of decoded) await this.vault.write(`${prefix}/${path}`, bytes, intent);
        // files the previous version had and this one does not: gone, in the same commit
        if (prior?.current_version) {
          const prev = await this.db.query(`SELECT manifest FROM artifact_versions WHERE id = $1`, [prior.current_version]);
          for (const path of Object.keys((prev.rows[0]?.manifest as Record<string, unknown> | undefined) ?? {})) {
            if (!decoded.has(path)) await this.vault.delete(`${prefix}/${path}`, intent);
          }
        }
      } catch (err) {
        // best-effort unwind: the pointer goes back, the version row goes away; the vault may hold partial writes until the next publish
        await this.db.query(`DELETE FROM artifact_versions WHERE id = $1`, [versionId]).catch(() => undefined);
        await this.db.query(`UPDATE artifacts SET current_version = $2 WHERE id = $1 AND current_version = $3`, [artifact.id, current, versionId]).catch(() => undefined);
        if (err instanceof VaultError) throw fail(err.code === "forbidden" || err.code === "conflict" ? err.code : "not_available", `vault: ${err.message}`);
        throw err;
      }
      // one version = one commit: flush now rather than let a second publish inside the interval fold into this one
      await this.vault.flush?.().catch(() => undefined);
      return { artifact, version, links: this.links(artifact.id, version.id), deduplicated: false };
    }, (r) => ({ artifact: r.artifact.id, version: r.version.id, deduplicated: r.deduplicated }));
  }

  // --- reads ---------------------------------------------------------------------

  async get(id: string, p: Principal): Promise<{ artifact: Artifact; current: Version | null; links: Links | null } | null> {
    const a = await this.scoped(id, p);
    if (!a) return null;
    const current = a.current_version ? await this.versionOf(a, a.current_version) : null;
    if (current) await this.resolveCommits([current]);
    return { artifact: a, current, links: current ? this.links(a.id, current.id) : null };
  }

  /** By project (agents: only their projects; a project outside them lists as empty). */
  async list(opts: { project?: string | undefined; limit?: number | undefined }, p: Principal): Promise<Artifact[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    if (opts.project !== undefined) {
      const project = requireSlug("project", opts.project, PROJECT_RE);
      if (!(await this.callerIsMember(p, project))) return [];
      const { rows } = await this.db.query(`SELECT ${ART_COLS} FROM artifacts WHERE project = $1 ORDER BY updated_at DESC LIMIT $2`, [project, limit]);
      return rows.map(toArtifact);
    }
    if (p.kind === "agent" && !p.all_projects) {
      const projects = p.projects ?? (await this.agents.lookup(p.id))?.projects ?? [];
      if (projects.length === 0) return [];
      const { rows } = await this.db.query(`SELECT ${ART_COLS} FROM artifacts WHERE project = ANY($1::text[]) ORDER BY updated_at DESC LIMIT $2`, [projects, limit]);
      return rows.map(toArtifact);
    }
    const { rows } = await this.db.query(`SELECT ${ART_COLS} FROM artifacts ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return rows.map(toArtifact);
  }

  async versions(id: string, p: Principal): Promise<Version[] | null> {
    const a = await this.scoped(id, p);
    if (!a) return null;
    const { rows } = await this.db.query(`SELECT ${VER_COLS} FROM artifact_versions WHERE artifact_id = $1 ORDER BY created_at DESC, id DESC`, [a.id]);
    const versions = rows.map(toVersion);
    await this.resolveCommits(versions);
    return versions;
  }

  async version(id: string, versionId: string, p: Principal): Promise<{ artifact: Artifact; version: Version; links: Links } | null> {
    const a = await this.scoped(id, p);
    if (!a) return null;
    const v = await this.versionOf(a, versionId);
    if (!v) return null;
    await this.resolveCommits([v]);
    return { artifact: a, version: v, links: this.links(a.id, v.id) };
  }

  /**
   * One file of one version, from the working tree. The tree holds the
   * CURRENT content; an older version's file is served only while its
   * hash still matches, otherwise `not_available` (diff instead).
   */
  async readFile(id: string, versionId: string, path: string, p: Principal): Promise<{ path: string; kind: FileKind; sha256: string; content: Buffer } | null> {
    const a = await this.scoped(id, p);
    if (!a) return null;
    const v = await this.versionOf(a, versionId);
    if (!v) return null;
    const entry = v.manifest[path];
    if (!entry || !validFilePath(path)) return null;
    const f = await this.vault.read(`${v.path_prefix}/${path}`);
    if (!f) throw fail("not_available", "the file is not on the working tree");
    if (f.sha256 !== entry.sha256) throw fail("not_available", "this version's content has been superseded on the working tree; use diff");
    return { path, kind: entry.kind, sha256: f.sha256, content: f.content };
  }

  /** `git diff` between two versions of one artifact (`to` absent = the working tree). Needs both commits flushed. */
  async diff(id: string, from: string, to: string | null, p: Principal): Promise<{ from: string; to: string | null; diff: string } | null> {
    const a = await this.scoped(id, p);
    if (!a) return null;
    const vf = await this.versionOf(a, from);
    const vt = to === null ? null : await this.versionOf(a, to);
    if (!vf || (to !== null && !vt)) return null;
    await this.resolveCommits(vt ? [vf, vt] : [vf]);
    if (!vf.commit || (vt && !vt.commit)) throw fail("not_available", "not committed yet — the reconciler flushes on its interval");
    try {
      const r = await this.vault.diff(vf.path_prefix, vf.commit, vt ? vt.commit : null);
      return { from: vf.id, to: vt ? vt.id : null, diff: r.diff };
    } catch (err) {
      if (err instanceof VaultError) throw fail(err.code === "not_found" ? "not_available" : err.code, err.message);
      throw err;
    }
  }

  /** Fill `commit` for versions the reconciler has flushed since: one log read per prefix, matched by the version tag in the subject. */
  private async resolveCommits(versions: Version[]): Promise<void> {
    const missing = versions.filter((v) => v.commit === null);
    if (missing.length === 0) return;
    const prefixes = [...new Set(missing.map((v) => v.path_prefix))];
    for (const prefix of prefixes) {
      let entries;
      try {
        entries = await this.vault.log(prefix, 200);
      } catch {
        continue; // history is a courtesy on the read path; never fail a read over it
      }
      const bySubject = new Map<string, string>();
      for (const e of entries) {
        const m = VERSION_TAG.exec(e.subject.trim());
        if (m?.[1] && !bySubject.has(m[1])) bySubject.set(m[1], e.sha);
      }
      for (const v of missing) {
        const sha = bySubject.get(v.id);
        if (!sha) continue;
        v.commit = sha;
        await this.db.query(`UPDATE artifact_versions SET commit = $2 WHERE id = $1 AND commit IS NULL`, [v.id, sha]);
      }
    }
  }

  // --- comments --------------------------------------------------------------------

  private authorKind(p: Principal): AuthorKind {
    return p.kind === "user" ? "human" : "agent";
  }

  async commentCreate(input: CommentCreateInput, p: Principal): Promise<Comment | null> {
    const body = requireText("body", input.body, 20_000);
    const a = await this.scoped(input.artifact, p);
    if (!a) return null;
    const v = await this.versionOf(a, input.version);
    if (!v) return null;
    if (input.path !== undefined && input.path !== null && !v.manifest[input.path]) throw fail("invalid_request", "path is not in this version");
    const anchor = input.anchor === undefined || input.anchor === null ? null : JSON.stringify(input.anchor);
    if (anchor !== null && anchor.length > 4096) throw fail("invalid_request", "anchor too large");
    return this.recorded(p, "comment", { artifact: a.id, version: v.id }, async () => {
      const { rows } = await this.db.query(
        `INSERT INTO artifact_comments (id, artifact_id, version_id, path, anchor, body, author_principal, author_kind)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING ${CMT_COLS}`,
        [newId("cmt"), a.id, v.id, input.path ?? null, anchor, body, p.id, this.authorKind(p)],
      );
      return toComment(rows[0]!);
    }, (c) => ({ comment: c?.id }));
  }

  /** One level: a reply to a root. Past the ping-pong cap an AGENT reply is not stored; the thread demotes to a proposal (once). */
  async commentReply(input: CommentReplyInput, p: Principal): Promise<ReplyResult | null> {
    const body = requireText("body", input.body, 20_000);
    const parent = await this.rootComment(input.parent, p);
    if (!parent) return null;
    const thread = await this.threadRows(parent);
    const authorKind = this.authorKind(p);
    return this.recorded(p, "reply", { artifact: parent.artifact_id, version: parent.version_id, thread: parent.id }, async () => {
      if (pingPongDemotes(thread, authorKind, this.cap)) {
        const proposalId = await this.demoteThread(parent, thread, p);
        return { demoted: true as const, proposal_id: proposalId, cap: this.cap };
      }
      const { rows } = await this.db.query(
        `INSERT INTO artifact_comments (id, artifact_id, version_id, path, body, author_principal, author_kind, parent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${CMT_COLS}`,
        [newId("cmt"), parent.artifact_id, parent.version_id, parent.path, body, p.id, authorKind, parent.id],
      );
      return { demoted: false as const, comment: toComment(rows[0]!) };
    }, (r) => (r?.demoted ? { demoted: true, proposal_id: r.proposal_id, agent_tail: agentTailLength(thread) } : { comment: r?.comment.id }));
  }

  /** Resolving may address a bundle, which frees a cap slot: the oldest queued bundle in the project that now fits is released inline. */
  async commentResolve(id: string, p: Principal): Promise<Comment | null> {
    const c = await this.setState(id, "resolved", p);
    if (c) {
      const a = await this.db.query(`SELECT project FROM artifacts WHERE id = $1`, [c.artifact_id]);
      const project = a.rows[0]?.project;
      if (typeof project === "string") await this.releaseQueued(project, p).catch(() => undefined); // never fail a resolve over the queue
    }
    return c;
  }

  async commentReopen(id: string, p: Principal): Promise<Comment | null> {
    return this.setState(id, "open", p);
  }

  private async setState(id: string, state: "open" | "resolved", p: Principal): Promise<Comment | null> {
    const root = await this.rootComment(id, p);
    if (!root) return null;
    return this.recorded(p, state === "resolved" ? "resolve" : "reopen", { artifact: root.artifact_id, thread: root.id }, async () => {
      const { rows } = await this.db.query(
        `UPDATE artifact_comments SET state = $2, resolved_by = $3, resolved_at = $4 WHERE id = $1 RETURNING ${CMT_COLS}`,
        [root.id, state, state === "resolved" ? p.id : null, state === "resolved" ? new Date() : null],
      );
      return toComment(rows[0]!);
    });
  }

  /** Threads on one version: roots in order with their replies. */
  async commentList(id: string, versionId: string, p: Principal): Promise<Thread[] | null> {
    const a = await this.scoped(id, p);
    if (!a) return null;
    const v = await this.versionOf(a, versionId);
    if (!v) return null;
    const { rows } = await this.db.query(`SELECT ${CMT_COLS} FROM artifact_comments WHERE version_id = $1 ORDER BY created_at ASC, id ASC`, [v.id]);
    const threads = new Map<string, Thread>();
    for (const r of rows) {
      const c = toComment(r);
      if (c.parent_id === null) threads.set(c.id, { ...c, replies: [] });
    }
    for (const r of rows) {
      const c = toComment(r);
      if (c.parent_id !== null) threads.get(c.parent_id)?.replies.push(c);
    }
    return [...threads.values()];
  }

  private async rootComment(id: unknown, p: Principal): Promise<Comment | null> {
    if (!isId(id, "cmt")) return null;
    const { rows } = await this.db.query(`SELECT ${CMT_COLS} FROM artifact_comments WHERE id = $1`, [id]);
    const c = rows[0] ? toComment(rows[0]) : null;
    if (!c) return null;
    if (c.parent_id !== null) throw fail("invalid_request", "replies are one level: reply to the thread root");
    if (!(await this.scoped(c.artifact_id, p))) return null;
    return c;
  }

  private async threadRows(root: Comment): Promise<Comment[]> {
    const { rows } = await this.db.query(`SELECT ${CMT_COLS} FROM artifact_comments WHERE parent_id = $1 ORDER BY created_at ASC, id ASC`, [root.id]);
    return [root, ...rows.map(toComment)];
  }

  private trustOf(p: Principal): string {
    return p.kind === "user" ? "user" : p.kind === "system" ? "internal" : (p.agent_kind ?? "external");
  }

  /** The thread becomes a `review` proposal for the user, with its transcript — once per thread while pending. */
  private async demoteThread(root: Comment, thread: Comment[], p: Principal): Promise<number> {
    const pending = await this.db.query(
      `SELECT id FROM proposals WHERE kind = 'review' AND decision = 'pending' AND payload->>'reason' = 'ping_pong_cap' AND payload->>'thread_id' = $1`,
      [root.id],
    );
    if (pending.rows[0]) return Number(pending.rows[0].id);
    const payload = {
      reason: "ping_pong_cap",
      cap: this.cap,
      title: `review thread needs you: ${thread.length} agent exchanges on ${root.artifact_id}`,
      artifact: root.artifact_id,
      version: root.version_id,
      thread_id: root.id,
      path: root.path,
      links: this.links(root.artifact_id, root.version_id),
      transcript: thread.map((c) => ({ id: c.id, author: c.author_principal, author_kind: c.author_kind, at: c.created_at, body: c.body.slice(0, 2000) })),
    };
    const { rows } = await this.db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('review', $1, $2, $3::jsonb) RETURNING id`, [
      p.id, this.trustOf(p), JSON.stringify(payload),
    ]);
    return Number(rows[0]!.id);
  }

  // --- review dispatch ---------------------------------------------------------------

  async dispatchReview(input: DispatchInput, p: Principal): Promise<DispatchResult | null> {
    if (typeof input.to_agent !== "string" || !AGENT_RE.test(input.to_agent)) throw fail("invalid_request", "to_agent must be an agent id");
    if (!Array.isArray(input.thread_ids) || input.thread_ids.length === 0 || input.thread_ids.length > 50) throw fail("invalid_request", "thread_ids: 1..50 thread ids");
    const threadIds = [...new Set(input.thread_ids)];
    if (!threadIds.every((t) => isId(t, "cmt"))) throw fail("invalid_request", "thread_ids must be comment ids");
    const message = input.message === undefined ? null : requireText("message", input.message, 2000);
    const a = await this.scoped(input.artifact, p);
    if (!a) return null;
    const v = await this.versionOf(a, input.version);
    if (!v) return null;
    // every thread is a ROOT on THIS version — a cross-version or cross-artifact handle is rejected at write, not filtered at read
    const { rows: roots } = await this.db.query(`SELECT id FROM artifact_comments WHERE version_id = $1 AND parent_id IS NULL AND id = ANY($2::text[])`, [v.id, threadIds]);
    if (roots.length !== threadIds.length) throw fail("invalid_request", "every thread_id must be a root thread on this version");

    const target = await this.agents.lookup(input.to_agent);
    const caller = p.kind === "agent" ? await this.agents.lookup(p.id) : null;
    // the soft budget is checked at the one place it changes anything: an agent's dispatch (a flip routes this bundle to the user)
    if (p.kind === "agent") await this.enforceBudget(a.project);
    const policy = await this.projectPolicy(a.project);
    const decision = dispatchDecision({
      callerKind: p.kind,
      callerId: p.id,
      callerIsMember: await this.callerIsMember(p, a.project),
      targetId: input.to_agent,
      targetIsMember: agentIsMember(target, a.project),
      mode: policy.mode,
      callerAutonomy: caller?.autonomy,
      targetAutonomy: target?.autonomy,
    });
    const links = this.links(a.id, v.id);
    return this.recorded(p, "dispatch", { artifact: a.id, version: v.id, to_agent: input.to_agent, threads: threadIds.length, route: decision.route, ...(decision.route === "proposal" ? { reason: decision.reason } : {}) }, async () => {
      if (decision.route === "proposal") {
        const payload = {
          reason: decision.reason,
          title: `review dispatch to ${input.to_agent} needs you: ${a.project}/${a.slug}`,
          artifact: a.id,
          version: v.id,
          project: a.project,
          thread_ids: threadIds,
          to_agent: input.to_agent,
          message,
          links,
        };
        const { rows } = await this.db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('review', $1, $2, $3::jsonb) RETURNING id`, [
          p.id, this.trustOf(p), JSON.stringify(payload),
        ]);
        return { route: "proposal" as const, proposal_id: Number(rows[0]!.id), reason: decision.reason };
      }
      if (!this.opts.tasks) throw fail("not_available", "no task list configured for review bundles");
      // the caps (§4.21 "task/bundle explosion"): over cap the bundle is QUEUED — a blocked row, released when a slot frees — never dropped. The user's hand is never capped.
      const queued = p.kind === "agent" ? await this.capFor(p.id, caller?.autonomy, a.project, policy) : null;
      // ONE work row per dispatch, kind review, claimable through the tasks module; handles, never payloads
      const work = await this.opts.tasks.create(
        {
          title: `review: ${a.project}/${a.slug} ${v.id} (${threadIds.length} thread${threadIds.length === 1 ? "" : "s"})`,
          project: a.project,
          kind: "review",
          owner: input.to_agent,
          ...(input.idempotency_key !== undefined ? { idempotency_key: `artifacts:${p.id}:${input.idempotency_key}` } : {}),
          meta: { bundle: { module: "artifacts", artifact: a.id, version: v.id, thread_ids: threadIds, from: p.id, to_agent: input.to_agent, message, links, ...(queued ? { queued: queued.reason } : {}) } },
          ...(queued ? { status: "blocked" as const, note: `over_cap: ${queued.reason} ${queued.open}/${queued.cap}` } : {}),
        },
        p.id,
      );
      return { route: "work" as const, work, links, queued };
    }, (r) => (r?.route === "work" ? { work_id: r.work.id, ...(r.queued ? { queued: r.queued.reason } : {}) } : r ? { proposal_id: r.proposal_id } : {}));
  }

  // --- §4.21 controls: project policy, caps, budget -----------------------------------

  /** The project's controls, or the defaults for a slug with no row yet (a read never creates one). */
  async projectPolicy(project: string): Promise<ProjectPolicy> {
    const { rows } = await this.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`, [project]);
    if (!rows[0]) return { id: project, mode: "autonomous", daily_budget_usd: null, max_open_bundles: DEFAULT_MAX_OPEN_BUNDLES, exists: false };
    const r = toProjectRow(rows[0]);
    return { id: r.id, mode: r.mode, daily_budget_usd: r.daily_budget_usd, max_open_bundles: r.max_open_bundles, exists: true };
  }

  /**
   * Bundles in flight: review rows this module made that are open or
   * claimed AND not yet addressed (a bundle whose threads are all
   * resolved no longer counts, so addressing frees a slot; nothing has
   * to close the task first). Queued (blocked) rows never count.
   */
  private async openBundles(from: string | null, project: string | null): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM work w
       WHERE w.kind = 'review' AND w.status IN ('open', 'in_progress')
         AND w.meta->'bundle'->>'module' = 'artifacts'
         AND ($1::text IS NULL OR w.meta->'bundle'->>'from' = $1)
         AND ($2::text IS NULL OR w.project = $2)
         AND jsonb_typeof(w.meta->'bundle'->'thread_ids') = 'array'
         AND EXISTS (SELECT 1 FROM artifact_comments c
                     WHERE c.id = ANY(ARRAY(SELECT jsonb_array_elements_text(w.meta->'bundle'->'thread_ids'))) AND c.state <> 'resolved')`,
      [from, project],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private agentCap(autonomy: Autonomy | undefined): number {
    return autonomy?.max_open_bundles ?? this.agentBundleCap;
  }

  /** Which cap, if any, this agent's next bundle in this project would exceed. */
  private async capFor(agent: string, autonomy: Autonomy | undefined, project: string, policy: ProjectPolicy): Promise<DispatchQueued | null> {
    const [agentOpen, projectOpen] = await Promise.all([this.openBundles(agent, null), this.openBundles(null, project)]);
    return capExceeded(agentOpen, this.agentCap(autonomy), projectOpen, policy.max_open_bundles);
  }

  /**
   * Release the oldest queued bundle in the project that now fits under
   * both caps — one per call, oldest first, so a freed slot goes to the
   * bundle that waited longest. Returns the released work id or null.
   */
  async releaseQueued(project: string, by: Principal): Promise<number | null> {
    const policy = await this.projectPolicy(project);
    const { rows } = await this.db.query(
      `SELECT w.id, w.meta->'bundle'->>'from' AS sender FROM work w
       WHERE w.kind = 'review' AND w.status = 'blocked' AND w.claimed_by IS NULL AND w.project = $1
         AND w.meta->'bundle'->>'module' = 'artifacts' AND w.meta->'bundle'->>'queued' IS NOT NULL
       ORDER BY w.created_at ASC, w.id ASC LIMIT 20`,
      [project],
    );
    if (rows.length === 0) return null;
    const projectOpen = await this.openBundles(null, project);
    if (projectOpen >= policy.max_open_bundles) return null;
    const agentOpen = new Map<string, number>();
    for (const r of rows) {
      const sender = String(r.sender ?? "");
      if (!sender) continue;
      const info = await this.agents.lookup(sender);
      const open = agentOpen.get(sender) ?? (await this.openBundles(sender, null));
      agentOpen.set(sender, open);
      if (open >= this.agentCap(info?.autonomy)) continue; // this sender is still at its own cap; a later bundle from someone else may fit
      const entry = JSON.stringify([{ ts: new Date().toISOString(), agent: by.id, op: "update", status: "open", note: "released: under cap" }]);
      const upd = await this.db.query(
        `UPDATE work SET status = 'open', updated_at = now(), history = history || $2::jsonb, meta = meta #- '{bundle,queued}'
         WHERE id = $1 AND status = 'blocked' AND claimed_by IS NULL RETURNING id`,
        [Number(r.id), entry],
      );
      if (upd.rows[0]) {
        const id = Number(upd.rows[0].id);
        await this.recorded(by, "release_queued", { project, work_id: id }, async () => id);
        return id;
      }
    }
    return null;
  }

  /** Today's spend against the project: `runs.cost_usd` from its member agents or rows stamped `meta.project`. */
  async spendToday(project: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT coalesce(sum(r.cost_usd), 0)::float8 AS spend FROM runs r
       WHERE r.ts >= date_trunc('day', now()) AND r.cost_usd IS NOT NULL
         AND (r.meta->>'project' = $1 OR r.component IN (SELECT a.id FROM agents a WHERE $1 = ANY(a.projects)))`,
      [project],
    );
    return Number(rows[0]?.spend ?? 0);
  }

  /**
   * The daily soft budget (§4.21 "cost runaway"): over budget, the project
   * flips to review mode — an atomic UPDATE that only fires on the
   * autonomous→review transition, so the flip is recorded (runs kind
   * project_mode, which the brief reads) and alerted (outbound_messages
   * kind alert, deduped like the watchdog's) exactly once. The user flips
   * it back by hand; the budget does not un-flip.
   */
  async enforceBudget(project: string): Promise<BudgetResult> {
    const policy = await this.projectPolicy(project);
    if (policy.daily_budget_usd === null) return { project, mode: policy.mode, spend_usd: 0, budget_usd: null, flipped: false };
    const spend = await this.spendToday(project);
    const out: BudgetResult = { project, mode: policy.mode, spend_usd: spend, budget_usd: policy.daily_budget_usd, flipped: false };
    if (policy.mode !== "autonomous" || !budgetExceeded(spend, policy.daily_budget_usd)) return out;
    const { rows } = await this.db.query(`UPDATE projects SET mode = 'review', updated_at = now() WHERE id = $1 AND mode = 'autonomous' RETURNING id`, [project]);
    if (!rows[0]) return { ...out, mode: "review" }; // someone else flipped it first
    const runId = await startRun(this.db, { component: "projects", kind: "project_mode", tool: "budget", meta: { project, from: "autonomous", to: "review", reason: "budget", spend_usd: spend, budget_usd: policy.daily_budget_usd } });
    await finishRun(this.db, runId, { ok: true });
    const text = `project ${project} flipped to review mode: daily budget ${policy.daily_budget_usd.toFixed(2)} USD exceeded — agent-to-agent review now queues for you (dashboard → projects)`;
    const dup = await this.db.query(`SELECT 1 FROM outbound_messages WHERE kind = 'alert' AND text = $1 AND ts > now() - interval '24 hours'`, [text]);
    if (!dup.rows[0]) await this.db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'alert')`, [text]);
    return { ...out, mode: "review", flipped: true };
  }

  /** `addressed` is inferred from thread states; nothing writes it. */
  async bundleStatus(workId: number, p: Principal): Promise<BundleStatus | null> {
    if (!this.opts.tasks) throw fail("not_available", "no task list configured for review bundles");
    const task = await this.opts.tasks.get(workId);
    const bundle = (task?.meta as { bundle?: Record<string, unknown> } | undefined)?.bundle;
    if (!task || task.kind !== "review" || !bundle || bundle.module !== "artifacts") return null;
    const a = await this.scoped(bundle.artifact, p);
    if (!a) return null;
    const ids = Array.isArray(bundle.thread_ids) ? (bundle.thread_ids as string[]) : [];
    const { rows } = await this.db.query(`SELECT id, state FROM artifact_comments WHERE id = ANY($1::text[]) ORDER BY created_at ASC`, [ids]);
    const threads = rows.map((r) => ({ id: String(r.id), state: r.state as "open" | "resolved" }));
    return {
      work_id: task.id,
      artifact: a.id,
      version: String(bundle.version),
      to_agent: String(bundle.to_agent),
      from: String(bundle.from),
      threads,
      addressed: inferAddressed(threads),
      status: task.status,
    };
  }

  // --- probe -----------------------------------------------------------------------

  check(): Promise<CheckResult> {
    return runCheck("artifacts", "select every artifacts/versions/comments column the service uses; vault list of Artifacts/", async () => {
      await this.db.query(`SELECT ${ART_COLS} FROM artifacts WHERE false`);
      await this.db.query(`SELECT ${VER_COLS} FROM artifact_versions WHERE false`);
      await this.db.query(`SELECT ${CMT_COLS} FROM artifact_comments WHERE false`);
      await this.db.query(`SELECT id, kind, source_agent, trust, payload, decision FROM proposals WHERE false`);
      await this.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE false`);
      await this.vault.list("Artifacts", 1);
      return { meta: { tasks: this.opts.tasks ? "available" : "not_available" } };
    });
  }
}

// --- input helpers (hand-rolled: the surface is a handful of fields) ------------

function requireText(name: string, v: unknown, max: number): string {
  if (typeof v !== "string" || v.trim() === "") throw fail("invalid_request", `${name} is required`);
  if (v.length > max) throw fail("invalid_request", `${name} exceeds ${max} characters`);
  return v;
}

function requireSlug(name: string, v: unknown, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v)) throw fail("invalid_request", `${name} must match ${re.source}`);
  return v;
}
