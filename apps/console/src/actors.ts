// The console's half of the actor model (T4-6; plan §2.4, docs/ops/actors.md).
//
// Core's `resolveActor` is pure: it reads nothing and is handed its sources.
// This file is where the console LOADS them — the registry rows, the crews it
// has loaded, the assistant's definition files, compute.yaml, and the grant
// history that says where an area came from — and the two things it serves
// from one resolution:
//
//   GET /api/agents                   each row's `permissions` (Resource × Read × Write)
//   GET /api/agents/:id/definition    what the actor runs with, read-only (the write is M12)
//
// Nothing here decides anything. What a line says is `describePermissions`,
// which asks `may()`; what a crew runs on is `crewCompute`; this file only
// reads what they need, the way the door would read it.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  emptyCompute,
  overlayFilesFromEnv,
  resolveActor,
  INSTANCE_LAYOUT,
  type Actor,
  type ActorGrantHistory,
  type ActorRegistryRow,
  type ActorSources,
  type AssistantIdentity,
  type Compute,
  type DefinitionFile,
  type PermissionRow,
} from "@foldedspacelabs/metistry-core";
import type { Db } from "./auth-store.js";
import { ACCESS_REQUEST_KIND, INTERNAL_ASSISTANT_ID, type AgentRow } from "./agents.js";
import type { CrewRegistry } from "./crews.js";
import { parseAssistantIdentity } from "./identity.js";
import { listProjectGrants } from "./projects.js";

/** The assistant's definition: who it is, and the files that make it so. */
export interface AssistantDefinitionSource {
  identity: AssistantIdentity | undefined;
  files: DefinitionFile[];
}

/** Where the assistant's definition files are: the D4 overlay lists the console already resolves, and the two roots a path is made relative to. */
export interface AssistantDefinitionPaths {
  /** Colon-separated, last existing wins (METISTRY_IDENTITY_FILES). */
  identityFiles: string;
  /** Colon-separated, last existing wins — the assistant prompt's overlay (seed, then the instance's). */
  promptFiles: string;
  /** METISTRY_INSTANCE_DIR — where the root `CLAUDE.md` lives, and what makes a file the owner's own. */
  instanceDir?: string | undefined;
  /** The release (the console's working directory). Default: `process.cwd()`. */
  productDir?: string | undefined;
}

/** The assistant prompt's overlay, read exactly as the engine reads it (apps/assistant/src/prompt.ts). */
export function assistantPromptFiles(env: NodeJS.ProcessEnv): string {
  return env.METISTRY_PROMPT_FILES ?? overlayFilesFromEnv(env, "assistantPrompt");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A file the console read, named relative to the instance (the owner's) or to the release (shipped) — never absolutely (invariant 7). */
function definitionFile(abs: string, text: string, paths: AssistantDefinitionPaths): DefinitionFile {
  const posix = (p: string) => p.split(sep).join("/");
  const instance = paths.instanceDir ? resolve(paths.instanceDir) : undefined;
  if (instance && abs.startsWith(`${instance}${sep}`)) return { path: posix(relative(instance, abs)), origin: "instance", sha256: sha256(text) };
  return { path: posix(relative(paths.productDir ?? process.cwd(), abs)), origin: "product", sha256: sha256(text) };
}

/** The last existing file of an overlay list, read. */
async function lastOf(list: string, base: string): Promise<{ abs: string; text: string } | undefined> {
  let found: { abs: string; text: string } | undefined;
  for (const p of list.split(":").map((s) => s.trim()).filter(Boolean)) {
    const abs = resolve(base, p);
    try {
      found = { abs, text: await readFile(abs, "utf8") };
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
  return found;
}

/**
 * The assistant's definition as it stands NOW: `identity.yaml`, the root
 * `CLAUDE.md` (absent until the owner writes it), `.metistry/assistant-prompt.md`
 * — those that exist, in that order, each hashed. Read per request: a hash
 * is what an edit is made against, so a cached one would be a stale 409.
 */
export async function loadAssistantDefinition(paths: AssistantDefinitionPaths): Promise<AssistantDefinitionSource> {
  const base = paths.productDir ?? process.cwd();
  const files: DefinitionFile[] = [];
  const identity = await lastOf(paths.identityFiles, base);
  if (identity) files.push(definitionFile(identity.abs, identity.text, paths));
  if (paths.instanceDir) {
    const claude = resolve(paths.instanceDir, INSTANCE_LAYOUT.assistantInstructions);
    if (existsSync(claude)) files.push(definitionFile(claude, await readFile(claude, "utf8"), paths));
  }
  const prompt = await lastOf(paths.promptFiles, base);
  if (prompt) files.push(definitionFile(prompt.abs, prompt.text, paths));
  return { identity: identity ? parseAssistantIdentity(identity.text) : undefined, files };
}

/**
 * Where each approved area came from (docs/ops/actors.md, *Provenance*): for
 * the assistant's row, the approvals 0023 records; for an external row, the
 * approved `access_request` proposals that granted an area. A crew has none —
 * `request_access` is refused to it. Two reads for the whole registry.
 */
export async function grantHistories(db: Db): Promise<{ overrides: Map<string, ActorGrantHistory["approved"][number][]>; asks: Map<string, ActorGrantHistory["approved"][number][]> }> {
  const push = (m: Map<string, ActorGrantHistory["approved"][number][]>, agent: string, area: string, proposalId: number | null) => m.set(agent, [...(m.get(agent) ?? []), { area, proposalId }]);
  const overrides = new Map<string, ActorGrantHistory["approved"][number][]>();
  for (const r of (await db.query(`SELECT agent_id, area, proposal_id FROM agent_grant_overrides ORDER BY granted_at, area`)).rows) {
    push(overrides, String(r.agent_id), String(r.area), r.proposal_id === null || r.proposal_id === undefined ? null : Number(r.proposal_id));
  }
  const asks = new Map<string, ActorGrantHistory["approved"][number][]>();
  const { rows } = await db.query(
    `SELECT id, source_agent, payload->'granted'->>'area' AS area FROM proposals
     WHERE kind = $1 AND decision IN ('allow', 'accept_with_changes') AND payload ? 'granted' ORDER BY id`,
    [ACCESS_REQUEST_KIND],
  );
  for (const r of rows) if (typeof r.area === "string" && r.area !== "") push(asks, String(r.source_agent), r.area, Number(r.id));
  return { overrides, asks };
}

export interface ConsoleActorInputs {
  /** The registry, as `listAgents` read it. */
  rows: readonly AgentRow[];
  crews?: CrewRegistry | undefined;
  assistant: AssistantDefinitionSource;
  compute?: Compute | undefined;
  /**
   * The per-run read grants New Routines give each actor (T3-8, §2.5) —
   * core's `routineGrantsFor` over `.metistry/scheduled.yaml`. Drawn as
   * *while this routine runs*, never in the base scope. Absent = none.
   */
  routineGrants?: ((id: string) => readonly { readonly routine: string; readonly areas: readonly string[] }[]) | undefined;
}

/** A registry row as an actor source reads it. `AgentRow` carries more; this is the part the door reads. */
function registryRow(r: AgentRow): ActorRegistryRow {
  return {
    id: r.id,
    kind: r.kind,
    display_name: r.display_name,
    grants: r.grants,
    projects: r.projects,
    autonomy: r.autonomy,
    grant_source: r.grant_source,
    revoked: r.revoked,
    pending: r.pending,
  };
}

/** Everything `resolveActor` reads, loaded. */
export async function consoleActorSources(db: Db, input: ConsoleActorInputs): Promise<ActorSources> {
  const byId = new Map(input.rows.map((r) => [r.id, registryRow(r)]));
  const { overrides, asks } = await grantHistories(db);
  const assistantRow = byId.get(INTERNAL_ASSISTANT_ID);
  return {
    assistant: {
      id: INTERNAL_ASSISTANT_ID,
      // identity.yaml names it; with no file, the row's own label — never a name spelled here
      identity: input.assistant.identity ?? { name: assistantRow?.display_name ?? INTERNAL_ASSISTANT_ID, mention: null, mark: null },
      files: input.assistant.files,
    },
    registry: (id) => byId.get(id),
    crew: (id) => input.crews?.actorSource(id),
    compute: input.compute ?? emptyCompute(),
    // F-3 / T4-8: the connections an actor may reach. None exist yet.
    connections: () => [],
    grantHistory: (id) => ({ approved: (byId.get(id)?.kind === "internal" ? overrides : asks).get(id) ?? [], routines: input.routineGrants?.(id) ?? [] }),
    // T4-7: a member inherits its projects' grants; resolveActor draws them "via project"
    projectGrants: await listProjectGrants(db),
  };
}

/** Each row's permission lines: the resolved actor's, and `[]` for a row that is no actor now (revoked, or a crew whose manifest is gone). */
export function permissionLines(id: string, sources: ActorSources): readonly PermissionRow[] {
  return resolveActor(id, sources)?.permissions.lines ?? [];
}

/** `GET /api/agents/:id/definition`'s body: the definition, and the compute and limits it sets (C128 — a model and effort are part of the definition). */
export function definitionBody(actor: Actor, asOf: Date = new Date()): Record<string, unknown> {
  return { id: actor.id, definition: actor.definition, compute: actor.compute, limits: actor.limits, as_of: asOf.toISOString() };
}
