// Crews (plan §4.11 scoped escape hatch, §4.18.B local target, Phase 5
// "crew definitions with their own toolsets"). A crew is a sub-agent the
// instance's own assistant can hand a brief to: `agents/<area>/<name>.md`
// in the instance repo — YAML frontmatter validated by core's `agent`
// manifest, then the operating prompt. This file is the console's whole
// involvement:
//
// - LOAD the manifests. `agents/` is a protected path (§4.7) the console has
//   no mount for, so an entry of METISTRY_AGENTS_DIRS that is not on disk is
//   read through the reconciler's vault bridge (`/vault/list` + `/vault/read`)
//   when one is configured; `seed/agents` ships in the image. D4 overlay:
//   later entries win by name.
// - SYNC the registry. Every valid manifest is an `agents` row of
//   `kind: 'crew'` — grants = its `scope` through the SAME validator external
//   agents face (the bare vault refused: a crew is not the assistant),
//   projects from the manifest. The token hash stored at registration is of
//   a token nobody holds: the assistant's runner mints a fresh one per run
//   and burns it after (apps/assistant/src/crew-drain.ts), so a crew never
//   keeps a credential. A manifest that disappears revokes its row.
// - DISPATCH. `agents_delegate` (mcp-brain) lands here: the brief is checked
//   with the existing dispatch enforcement (`checkBrief`) against the crew's
//   `scope` ∩ the `local-crew` target's `allow` list, and only then becomes a
//   durable `work` row (kind task, owner crew:<name>) the assistant
//   container's drain loop picks up. Refusals are `runs` rows too.
// - RUN A NEW ROUTINE (T3-8, §2.5). The runner's `agentRoutines` queue lands
//   here (`crewRoutineQueue`): the routine's actor is a crew this console
//   loaded, the task is the brief — appended to the crew's definition, which
//   stays the system prompt — and the run's read-only grants ride on the work
//   row (`meta.routine`), held only by that run's bearer (crew-drain.ts).
//   Idempotent per runner row, so a retried tick never enqueues twice.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  autonomyWidenings,
  crossKindRefusal,
  emptyCompute,
  finishRun,
  mintToken,
  parseCrewDefinition,
  ROUTINE_RUN_META_KEY,
  startRun,
  tokenHash,
  type ActorCrewSource,
  type AgentManifest,
  type Compute,
  type DataPolicy,
  type DefinitionFile,
  type TargetManifest,
} from "@foldedspacelabs/metistry-core";
import type { VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { TasksError, type TasksService } from "@foldedspacelabs/metistry-tasks";
import type { AgentPrincipal, CrewDispatcher, CrewDispatchInput, CrewDispatchOutcome, CrewSummary } from "@foldedspacelabs/metistry-mcp-brain";
import type { AgentRoutineQueue, AgentRoutineRun } from "./runner.js";
import { AgentError, recordWidening, validateAutonomy, validateGrants, type Autonomy, type Grants } from "./agents.js";
import { checkBrief, type TargetRegistry } from "./dispatch.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The name of the target every crew dispatch is checked against (targets/local-crew/manifest.yaml). */
export const LOCAL_CREW_TARGET = "local-crew";
/** `work.owner` for a queued crew run; the assistant's drain loop claims rows by this prefix. */
export const CREW_OWNER_PREFIX = "crew:";

// --- manifest files -----------------------------------------------------------

export interface CrewDefinition {
  manifest: AgentManifest;
  /** The operating prompt: the file body below the frontmatter, trimmed. */
  prompt: string;
  /** sha256 of the whole file — stamped on every run so a prompt edit is visible in `runs`. */
  sha256: string;
  /** Where it was read from (`agents/example/researcher.md`, or a disk path). */
  where: string;
  /**
   * The same file as an actor's definition names it (core's `DefinitionFile`):
   * POSIX and RELATIVE — to the instance for the owner's own file, to the
   * release for a shipped one (invariant 7) — with its origin and hash.
   * Absent only on a definition parsed outside `loadCrews`.
   */
  file?: DefinitionFile | undefined;
  /** The registry grant derived from `scope` (tier areas, or none when scope is empty). */
  grants: Grants;
  /** The registry autonomy block derived from `manifest.autonomy` (normalized by the same validator external PUT /autonomy uses; absent → `{}`, narrows nothing). */
  autonomy: Autonomy;
}

const CREW_FILE = /^(?:.*\/)?([a-z0-9-]+)\/([a-z0-9-]+)\.md$/; // <area>/<name>.md

/**
 * Parse one `agents/<area>/<name>.md`. Throws with `where:` on any miss —
 * a malformed manifest is refused whole, never partially registered.
 * `expected` (from the path) must agree with the frontmatter: the name IS
 * the filename, and an `area` key, when present, IS the directory.
 *
 * The file's own rules are core's `parseCrewDefinition` — the reading
 * `metistry agents define` validates an edit with before it writes, so the
 * two hands on this file cannot disagree about it. What is added here is
 * the registry's half: the scope through the grant validator, the autonomy
 * block through the registry's normalizer.
 */
export function parseCrewFile(text: string, where: string, expected?: { name: string; area: string }): CrewDefinition {
  const { manifest, prompt } = parseCrewDefinition(text, where, expected);
  let grants: Grants;
  try {
    // the external validator on purpose: TitleCase areas, never the bare vault — a crew is not the assistant
    grants = manifest.scope.length > 0 ? validateGrants({ tier: "areas", areas: manifest.scope }, { kind: "external" }) : { tier: "none", areas: [] };
  } catch (err) {
    throw new Error(`${where}: scope: ${err instanceof AgentError ? err.message : String(err)}`);
  }
  let autonomy: Autonomy;
  try {
    // the schema already refused an unknown key or a bad shape; this is the
    // same normalizer PUT /api/agents/:id/autonomy uses, so a manifest block
    // and a hand-set one land in the registry identically.
    autonomy = validateAutonomy(manifest.autonomy ?? {});
  } catch (err) {
    throw new Error(`${where}: autonomy: ${err instanceof AgentError ? err.message : String(err)}`);
  }
  return { manifest, prompt, sha256: createHash("sha256").update(text).digest("hex"), where, grants, autonomy };
}

interface CrewFile {
  /** `<area>/<name>.md`, relative to the source root. */
  rel: string;
  text: string;
}

/** Every `<dir>/<area>/<name>.md` on disk; null when the directory does not exist (an overlay entry may be vault-only). */
export async function readCrewDir(dir: string): Promise<CrewFile[] | null> {
  let areas: string[];
  try {
    areas = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  const out: CrewFile[] = [];
  for (const area of areas.sort()) {
    const files = (await readdir(join(dir, area), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    for (const f of files.sort()) out.push({ rel: `${area}/${f}`, text: await readFile(join(dir, area, f), "utf8") });
  }
  return out;
}

/** The same shape through the reconciler's bridge: `list(prefix, 2)` then `read` each `<prefix>/<area>/<name>.md`. Missing prefix → []. */
export async function readCrewVault(vault: VaultClient, prefix: string): Promise<CrewFile[]> {
  const entries = await vault.list(prefix, 2);
  const out: CrewFile[] = [];
  for (const e of entries) {
    if (e.kind !== "file" || !e.path.startsWith(`${prefix}/`)) continue;
    const rel = e.path.slice(prefix.length + 1);
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\.md$/.test(rel)) continue; // not <area>/<name>.md — README, a stray note, a nested dir
    const file = await vault.read(e.path);
    if (file) out.push({ rel, text: file.content.toString("utf8") });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Where the console's crew directories are, so a loaded file can be named the
 * way an actor's definition names it: relative, with its origin.
 */
export interface CrewOrigins {
  /** METISTRY_INSTANCE_DIR: a disk entry under it is the owner's own file. */
  instanceDir?: string | undefined;
  /** The release — the console's working directory, where `seed/` lives. Default: `process.cwd()`. */
  productDir?: string | undefined;
}

/**
 * One loaded crew file as core's `DefinitionFile`. An entry read through the
 * vault bridge is the instance's by construction (the bridge serves the
 * instance repo, and its prefix is instance-relative); a disk entry is the
 * instance's when it sits under the instance directory and the release's
 * otherwise — `seed/agents`, which "changing means writing the instance's own
 * copy, which then wins by name" (docs/ops/actors.md).
 */
export function definitionFileOf(dir: string, rel: string, from: "disk" | "vault", sha256: string, origins: CrewOrigins = {}): DefinitionFile {
  const posix = (p: string) => p.split(sep).join("/");
  if (from === "vault") return { path: `${dir.replace(/^\.\//, "").replace(/\/+$/, "")}/${rel}`, origin: "instance", sha256 };
  const product = origins.productDir ?? process.cwd();
  const abs = resolve(product, dir, rel);
  const instance = origins.instanceDir ? resolve(origins.instanceDir) : undefined;
  if (instance && (abs === instance || abs.startsWith(`${instance}${sep}`))) return { path: posix(relative(instance, abs)), origin: "instance", sha256 };
  return { path: posix(relative(product, abs)), origin: "product", sha256 };
}

export interface CrewLoad {
  crews: Map<string, CrewDefinition>;
  /** Files refused (with the reason); a refused manifest is treated as absent — registered nowhere, revoked if it was. */
  errors: string[];
  /** Where each entry of the overlay came from: `disk` | `vault` | `absent`. */
  sources: Record<string, "disk" | "vault" | "absent">;
}

/**
 * D4 overlay over METISTRY_AGENTS_DIRS: each entry is read from disk when
 * the directory exists there, else through the vault bridge when one is
 * configured (that is how the instance repo's protected `agents/` reaches
 * the console), else skipped. Later entries override earlier ones by name.
 */
export async function loadCrews(dirs: string[], vault?: VaultClient, origins: CrewOrigins = {}): Promise<CrewLoad> {
  const crews = new Map<string, CrewDefinition>();
  const errors: string[] = [];
  const sources: CrewLoad["sources"] = {};
  for (const dir of dirs.map((d) => d.trim()).filter(Boolean)) {
    let files = await readCrewDir(dir);
    if (files !== null) sources[dir] = "disk";
    else if (vault) {
      try {
        files = await readCrewVault(vault, dir.replace(/\/+$/, ""));
        sources[dir] = "vault";
      } catch (err) {
        errors.push(`${dir}: vault bridge: ${err instanceof Error ? err.message : String(err)}`);
        sources[dir] = "absent";
        continue;
      }
    } else {
      sources[dir] = "absent";
      continue;
    }
    const from = sources[dir] === "vault" ? "vault" : "disk";
    for (const f of files) {
      const m = CREW_FILE.exec(f.rel);
      if (!m) continue;
      const where = `${dir}/${f.rel}`;
      try {
        const def = parseCrewFile(f.text, where, { area: m[1]!, name: m[2]! });
        def.file = definitionFileOf(dir, f.rel, from, def.sha256, origins);
        crews.set(def.manifest.name, def);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { crews, errors, sources };
}

// --- registry sync -------------------------------------------------------------

export interface CrewSyncSummary {
  registered: string[];
  resynced: string[];
  revoked: string[];
  /** Names whose `agents` row exists with another kind (the assistant, an external agent): never overwritten, never dispatchable. */
  conflicts: string[];
}

function displayName(def: CrewDefinition): string {
  return `${def.manifest.name} (crew, ${def.manifest.area ?? "no area"})`;
}

/**
 * Reconcile `agents` rows of kind `crew` with the loaded manifests.
 * Idempotent and quiet: a row is written — and an `agent_admin` runs row
 * logged — only when it is new, changed, or gone. Token hashes are NEVER
 * touched here: registration stores the hash of a token that is discarded
 * on the spot (no valid credential exists until a run mints one), and a
 * re-sync leaves whatever hash is there alone.
 */
export async function syncCrews(db: Db, crews: Map<string, CrewDefinition>): Promise<CrewSyncSummary> {
  const out: CrewSyncSummary = { registered: [], resynced: [], revoked: [], conflicts: [] };
  const names = [...crews.keys()];
  const { rows: existing } = await db.query(
    `SELECT id, kind, display_name, grants, projects, autonomy, revoked_at IS NOT NULL AS revoked FROM agents WHERE id = ANY($1::text[])`,
    [names],
  );
  const byId = new Map<string, { kind: string; display_name: string; grants: unknown; projects: string[]; autonomy: unknown; revoked: boolean }>(existing.map((r) => [String(r.id), r]));

  const audit = async (agent: string, op: string, ok: boolean, meta: Record<string, unknown> = {}) => {
    const id = await startRun(db, { component: "console", kind: "agent_admin", tool: "crew_sync", meta: { agent, op, ...meta } });
    await finishRun(db, id, { ok });
  };

  for (const [name, def] of crews) {
    const row = byId.get(name);
    const grantsJson = JSON.stringify(def.grants);
    const autonomyJson = JSON.stringify(def.autonomy);
    const projects = def.manifest.projects;
    const display = displayName(def);
    if (row && row.kind !== "crew") {
      out.conflicts.push(name);
      await audit(name, "conflict", false, { existing_kind: row.kind });
      continue;
    }
    if (!row) {
      // the hash of a token nobody holds — see the file header
      // grant_source (0025): a crew's scope IS its manifest, recorded on the
      // row rather than re-derived from `kind` at each door (§2.7).
      await db.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants, projects, autonomy, grant_source) VALUES ($1, $2, 'crew', $3, $4::jsonb, $5::text[], $6::jsonb, 'manifest')`, [
        name, display, tokenHash(mintToken(32)), grantsJson, projects, autonomyJson,
      ]);
      out.registered.push(name);
      await audit(name, "register", true, { grants: def.grants, projects, autonomy: def.autonomy, where: def.where });
      // A manifest may RAISE a crew's action autonomy — `agents/` is a §4.7
      // protected path, so editing it is the user's own hand, which is the
      // same permission the console route has. It gets the same receipt:
      // a runs row and one alert (docs/ops/actions.md).
      await recordWidening(db, name, autonomyWidenings({}, def.autonomy), `manifest ${def.where}`);
      continue;
    }
    const same = !row.revoked && row.display_name === display && JSON.stringify(row.grants) === grantsJson
      && JSON.stringify(row.projects ?? []) === JSON.stringify(projects) && JSON.stringify(row.autonomy ?? {}) === autonomyJson;
    if (same) continue;
    await db.query(`UPDATE agents SET display_name = $2, grants = $3::jsonb, projects = $4::text[], autonomy = $5::jsonb, grant_source = 'manifest', revoked_at = NULL WHERE id = $1 AND kind = 'crew'`, [
      name, display, grantsJson, projects, autonomyJson,
    ]);
    out.resynced.push(name);
    await audit(name, "resync", true, { grants: def.grants, projects, autonomy: def.autonomy, where: def.where });
    await recordWidening(db, name, autonomyWidenings((row.autonomy ?? {}) as Autonomy, def.autonomy), `manifest ${def.where}`);
  }

  const { rows: gone } = await db.query(
    `UPDATE agents SET revoked_at = now() WHERE kind = 'crew' AND revoked_at IS NULL AND NOT (id = ANY($1::text[])) RETURNING id`,
    [names],
  );
  for (const r of gone) {
    out.revoked.push(String(r.id));
    await audit(String(r.id), "revoke", true, { reason: "manifest absent" });
  }
  return out;
}

/** The loaded crews plus a refresh that re-reads the overlay and re-syncs the registry. One instance per console. */
export class CrewRegistry {
  private crews = new Map<string, CrewDefinition>();
  errors: string[] = [];
  sources: CrewLoad["sources"] = {};
  lastSync: CrewSyncSummary | null = null;

  constructor(
    private readonly db: Db,
    private readonly dirs: string[],
    private readonly vault?: VaultClient | undefined,
    private readonly origins: CrewOrigins = {},
  ) {}

  /** Load + sync. Never throws on a bad manifest (it lands in `errors`); does throw on a dead database. */
  async refresh(): Promise<CrewSyncSummary> {
    const load = await loadCrews(this.dirs, this.vault, this.origins);
    this.crews = load.crews;
    this.errors = load.errors;
    this.sources = load.sources;
    this.lastSync = await syncCrews(this.db, this.crews);
    // a name that belongs to another kind of row (the assistant, an external agent) is not a crew this console can run: not dispatchable
    for (const name of this.lastSync.conflicts) {
      this.errors.push(`${this.crews.get(name)?.where ?? name}: agents.id "${name}" already belongs to a non-crew registry row — rename the crew`);
      this.crews.delete(name);
    }
    return this.lastSync;
  }

  get(name: string): CrewDefinition | undefined {
    return this.crews.get(name);
  }

  names(): string[] {
    return [...this.crews.keys()].sort();
  }

  /**
   * The toolset and the manifest path behind a crew bearer, for the
   * principal `/mcp` decides on (`authenticateAgent`'s `CrewToolsetLookup`).
   *
   * Undefined for a name this console has no loaded manifest for — a revoked
   * crew, a manifest that failed to parse, a console with no `agents/` at
   * all — and the caller reads that as NO tools. Fail closed: a crew whose
   * definition cannot be read is not a crew that gets the benefit of the
   * doubt.
   *
   * It follows the manifest as loaded NOW, not the snapshot frozen into the
   * run's work row. Where a mid-run edit makes them disagree, the door wins;
   * that is the point of moving the allowlist here (P2 §2.2).
   */
  toolset(name: string): { uses: readonly string[]; manifest?: string | undefined } | undefined {
    const def = this.crews.get(name);
    // the file as its definition names it — relative (invariant 7), the same path an actor's lines carry
    return def ? { uses: def.manifest.uses, manifest: def.file?.path ?? def.where } : undefined;
  }

  /**
   * A loaded crew as an actor's source (core's `ActorCrewSource`): the
   * manifest, the prompt, and the file as its definition names it. Undefined
   * for a name with no loaded manifest — which `resolveActor` reads as no
   * actor at all, the same fail-closed answer `toolset` gives the door.
   */
  actorSource(name: string): ActorCrewSource | undefined {
    const def = this.crews.get(name);
    if (!def) return undefined;
    return { manifest: def.manifest, prompt: def.prompt, file: def.file ?? { path: def.where, origin: "instance", sha256: def.sha256 } };
  }

  /**
   * What `agents_delegate` advertises: each crew's name and the `description`
   * its own manifest wrote (H8). A crew with no description is still listed —
   * the name is what dispatch needs; the description is what CHOOSING needs.
   */
  summaries(): CrewSummary[] {
    return this.names().map((name) => {
      const description = this.crews.get(name)?.manifest.description;
      return description === undefined ? { name } : { name, description };
    });
  }
}

// --- data policy: crew scope ∩ target allow ----------------------------------------

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Prefix intersection: for each (scope, allow) pair the narrower of the two when one contains the other; nothing otherwise. Sorted, deduplicated. */
export function intersectAllow(scope: readonly string[], allow: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of scope) {
    for (const a of allow) {
      if (under(s, a)) out.add(s);
      else if (under(a, s)) out.add(a);
    }
  }
  return [...out].sort();
}

/** The policy a brief bound for this crew is checked against: the crew's scope narrowed by the target, the target's sources and size cap. */
export function crewPolicy(crew: AgentManifest, target: TargetManifest): DataPolicy {
  return {
    allow: intersectAllow(crew.scope, target.data_policy.allow),
    deny_sources: target.data_policy.deny_sources,
    max_brief_bytes: target.data_policy.max_brief_bytes,
  };
}

// --- dispatch ------------------------------------------------------------------------

/** What the assistant's runner needs, frozen into the work row at dispatch (the container has no vault): the manifest fields + the prompt. */
export interface CrewSnapshot extends Omit<AgentManifest, "type"> {
  prompt: string;
  /** sha256 of the manifest file this snapshot was taken from. */
  sha256: string;
}

/** `work.meta` of a queued crew run. */
export interface CrewQueueMeta {
  target: string;
  crew: CrewSnapshot;
  brief: string;
  brief_sha: string;
  task_id?: number;
  dispatch_run_id: number;
  /** The effective allow list the brief passed. */
  allow: string[];
  /**
   * The size cap the brief was checked against (target `data_policy`).
   * Frozen here because the runner appends the prior-work block from the
   * task's room (docs/ops/threads.md) and must stay inside the SAME cap the
   * dispatch was allowed under — the container has no target manifest.
   */
  max_brief_bytes: number;
}

export function snapshotOf(def: CrewDefinition): CrewSnapshot {
  const { type: _type, ...rest } = def.manifest;
  return { ...rest, prompt: def.prompt, sha256: def.sha256 };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0) ?? "(no title)";
}

/**
 * The crew dispatch: registry lookup, policy (the existing `checkBrief`),
 * durable enqueue through the tasks module, one two-phase `runs` row
 * (component console, kind dispatch, tool local-crew) whether refused or
 * queued. `principal` is server-side identity (§4.19): the bridge has
 * already refused everyone but the internal assistant; it is written to
 * the row's history and the audit, never read from the input.
 */
export async function dispatchCrew(
  db: Db,
  tasks: TasksService,
  registry: CrewRegistry,
  targets: TargetRegistry | undefined,
  input: CrewDispatchInput,
  principal: AgentPrincipal,
  compute: Compute = emptyCompute(),
): Promise<CrewDispatchOutcome> {
  const def = registry.get(input.crew);
  if (!def) return { ok: false, code: "not_found", message: `unknown crew "${input.crew}" (registered: ${registry.names().join(", ") || "none"})` };
  const target = targets?.get(LOCAL_CREW_TARGET);
  if (!target || target.transport !== "local") {
    return { ok: false, code: "not_available", message: `target ${LOCAL_CREW_TARGET} is not loaded (METISTRY_TARGETS_DIRS) — crews cannot be dispatched` };
  }

  // Collaboration rule 4 (C7), enforced at the tool and nowhere else: a turn
  // may SCOPE work for any agent — an unassigned `work` row anyone can claim
  // — but it may not PUSH work to a named agent whose engine kind differs
  // from its own. The caller's kind is the kind of `assignments.default`:
  // that is what the instance's assistant runs on, and `agents_delegate` is
  // internal-only, so there is no other caller this can be.
  //
  // Checked BEFORE the dispatch run row so a refused push costs nothing but
  // its own audit row, and the refusal names the field that would permit it.
  const cross = crossKindRefusal(compute, null, def.manifest.name, def.manifest);
  if (cross) {
    const id = await startRun(db, {
      component: "console",
      kind: "dispatch",
      tool: LOCAL_CREW_TARGET,
      meta: { crew: def.manifest.name, principal: principal.id, from_kind: cross.from, to_kind: cross.to },
    });
    await finishRun(db, id, { ok: false, error: `collaboration_rule: ${cross.message}` });
    return { ok: false, code: "invalid_request", message: cross.message };
  }

  const briefBytes = Buffer.byteLength(input.brief, "utf8");
  const runId = await startRun(db, {
    component: "console",
    kind: "dispatch",
    tool: target.name,
    meta: { target: target.name, crew: def.manifest.name, principal: principal.id, brief_bytes: briefBytes, ...(input.task_id !== undefined ? { task: input.task_id } : {}) },
  });

  const policy = crewPolicy(def.manifest, target);
  const violations = checkBrief(policy, input.brief);
  if (violations.length > 0) {
    await finishRun(db, runId, { ok: false, error: `data_policy: ${violations.map((v) => v.kind).join(",")}`, meta: { violations, allow: policy.allow } });
    return { ok: false, code: "invalid_request", message: "brief violates the crew's data policy (crew scope ∩ local-crew allow)", violations };
  }

  const briefSha = createHash("sha256").update(input.brief).digest("hex");
  const meta: CrewQueueMeta = {
    target: target.name,
    crew: snapshotOf(def),
    brief: input.brief,
    brief_sha: briefSha,
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
    dispatch_run_id: runId,
    allow: policy.allow,
    max_brief_bytes: policy.max_brief_bytes,
  };
  let work;
  try {
    work = await tasks.create(
      {
        title: `[crew:${def.manifest.name}] ${firstLine(input.brief).slice(0, 120)}`,
        kind: "task",
        owner: `${CREW_OWNER_PREFIX}${def.manifest.name}`,
        ...(input.idempotency_key !== undefined ? { idempotency_key: input.idempotency_key } : {}),
        meta: meta as unknown as Record<string, unknown>,
      },
      principal.id,
    );
  } catch (err) {
    if (err instanceof TasksError) {
      await finishRun(db, runId, { ok: false, error: err.message });
      return { ok: false, code: err.code === "conflict" ? "conflict" : "invalid_request", message: err.message };
    }
    await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const deduplicated = Number((work.meta as { dispatch_run_id?: unknown }).dispatch_run_id) !== runId;
  await finishRun(db, runId, {
    ok: true,
    ...(target.cost ? { cost_usd: target.cost.per_run_estimate_usd } : {}),
    meta: { work_id: work.id, crew: def.manifest.name, allow: policy.allow, deduplicated, brief_sha: briefSha },
  });
  return { ok: true, work_id: work.id, run_id: runId, crew: def.manifest.name, allow: policy.allow, deduplicated };
}

/** The mcp-brain adapter over the above. */
export function crewDispatcher(
  db: Db,
  tasks: TasksService,
  registry: CrewRegistry,
  targets: TargetRegistry | undefined,
  /** `compute.yaml` in force, read per dispatch: it is hot-reloaded, and rule 4 must follow the file rather than the process's startup. */
  compute?: () => Compute,
): CrewDispatcher {
  return {
    dispatch: (input, principal) => dispatchCrew(db, tasks, registry, targets, input, principal, compute?.()),
    crews: () => registry.summaries(),
  };
}

// --- New Routines: one crew run per routine run (T3-8) ---------------------------------

/** Who enqueues a New Routine's run — the runner, never an agent (`runner.ts` RUNNER_AGENT). */
const ROUTINE_ENQUEUER = "runner";

/**
 * Enqueue ONE crew run for a New Routine's run: the crew's snapshot, the
 * task as the brief, and `meta.routine` — the runner row and the run's
 * read-only grants. Throws, naming the fix, when the actor is not a crew
 * this console has loaded (a revoked crew, a removed manifest, the
 * assistant or an external agent): the runner records a failed run.
 */
export async function enqueueRoutineRun(tasks: TasksService, registry: Pick<CrewRegistry, "get">, run: AgentRoutineRun): Promise<number> {
  const def = registry.get(run.actor);
  if (!def) {
    throw new Error(
      `${run.routine}: its actor ${run.actor} is not a crew this console has loaded — a New Routine runs as one crew run; ` +
        `change its actor in Scheduled, or restore agents/<area>/${run.actor}.md`,
    );
  }
  const brief = run.task;
  const work = await tasks.create(
    {
      title: `[routine:${run.routine}] ${firstLine(brief).slice(0, 120)}`,
      kind: "task",
      owner: `${CREW_OWNER_PREFIX}${def.manifest.name}`,
      // one crew run per runner row: a tick retried after a crash lands on the same row
      idempotency_key: `routine:${run.routine}:${run.meta.run_id}`,
      meta: {
        crew: snapshotOf(def),
        brief,
        brief_sha: createHash("sha256").update(brief).digest("hex"),
        dispatch_run_id: run.meta.run_id,
        [ROUTINE_RUN_META_KEY]: run.meta,
      },
    },
    ROUTINE_ENQUEUER,
  );
  return work.id;
}

/** The runner's `agentRoutines`: New Routines onto the crew queue, through the tasks service like every crew row. */
export function crewRoutineQueue(tasks: TasksService, registry: Pick<CrewRegistry, "get">): AgentRoutineQueue {
  return { enqueue: (run) => enqueueRoutineRun(tasks, registry, run) };
}
