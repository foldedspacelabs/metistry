// `metistry instances` — the peer registry (S4,
// docs/research/2026-09-13-google-sam-review.md ADOPT 4, docs/ops/instances.md).
//
// SAM's one uncontested win over "tailnet + /mcp" is cross-instance
// discovery, and that is a REGISTRY feature, not a mesh one: at two
// instances on one tailnet, a registry is a file. This is that file's
// verbs, built exactly like `metistry compute`'s:
//
//   * It never writes an invalid file. Every verb edits `instances.yaml` as
//     a yaml Document (comments survive), then re-parses the RESULT through
//     core's schema and refuses the whole write if it does not validate.
//   * It writes as the `user`. The registry says which other instances this
//     one will talk to, so it is a §4.7 protected path: the write goes
//     through the reconciler as the `user` principal (protected-write.ts),
//     exactly as compute.yaml, deployment.yaml and identity.yaml do.
//   * It learns a peer's identity from the peer, never from an argument.
//     `add <origin>` fetches `GET /api/identity` there — the one
//     unauthenticated read — and records what it answers. An origin that
//     will not say who it is does not go in the file.
//
// What is NOT here: a "directory of exposable resources" (CLI commands,
// directories, MCP servers, compute, Slack, Linear). That is OPEN-7 in
// docs/plan-refresh-2026-09-13.md §1 (S4) — the owner has not ruled on what
// a "resource" is — so the schema keeps an empty `resources: []` and this
// file designs nothing for it.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  INSTANCES_FILENAME,
  normalizeCapabilities,
  parseInstances,
  type InstanceEntry,
  type Instances,
} from "@foldedspacelabs/metistry-core";
import { realExec, type Exec } from "./exec.js";
import { writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";

export const INSTANCE_VERBS = ["list", "add", "remove", "refresh"] as const;
export type InstanceVerb = (typeof INSTANCE_VERBS)[number];

export function parseInstanceVerb(v: string | undefined): InstanceVerb | undefined {
  return (INSTANCE_VERBS as readonly string[]).includes(v ?? "") ? (v as InstanceVerb) : undefined;
}

export interface InstancesOptions {
  /** the instance repo: where instances.yaml lives */
  instanceDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** print the plan and change nothing */
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

export function instancesFile(instanceDir: string): string {
  return join(instanceDir.replace(/\/+$/, ""), INSTANCES_FILENAME);
}

const HEADER = [
  `# ${INSTANCES_FILENAME} — the instances this one knows about (docs/ops/instances.md).`,
  "# Written by `metistry instances`; `add <origin>` learns an instance's id,",
  "# name and capabilities from its own GET /api/identity. A §4.7 protected",
  "# path: it says who this instance will talk to, so only you change it",
  "# (invariant 2).",
  "#",
  "# `resources:` stays empty — what an instance exposes as a resource is",
  "# OPEN-7 (docs/plan-refresh-2026-09-13.md S4) and is not designed yet.",
  "",
];

/** The registry as it is on disk. An unreadable or invalid file is refused, never silently treated as empty. */
export async function readRegistry(opts: Pick<InstancesOptions, "instanceDir">): Promise<{ file: string; exists: boolean; registry: Instances }> {
  const file = instancesFile(opts.instanceDir);
  if (!existsSync(file)) return { file, exists: false, registry: { instances: [] } };
  const r = parseInstances(await readFile(file, "utf8"));
  if (!r.ok) throw new StepFailed(`${file} does not validate (${r.errors.join("; ")}) — fix it by hand; refusing to edit a file this command cannot read back`);
  return { file, exists: true, registry: r.value };
}

/**
 * Serialize, validate the RESULT through the same schema the console
 * serves it with, and only then write — as `user`, through the reconciler.
 */
async function commit(opts: InstancesOptions, entries: InstanceEntry[], message: string): Promise<{ file: string; delivery: ProtectedWrite }> {
  const file = instancesFile(opts.instanceDir);
  const text = existsSync(file) ? await readFile(file, "utf8") : HEADER.join("\n");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new StepFailed(`${file} is not valid YAML (${doc.errors[0]?.message}) — fix it by hand; refusing to edit a file this command cannot read back`);
  doc.setIn(["instances"], entries.length === 0 ? [] : entries.map((e) => ({ ...e })));
  const content = String(doc);
  const validated = parseInstances(content);
  if (!validated.ok) throw new StepFailed(`refusing to write ${file}: the result would be invalid — ${validated.errors.join("; ")}`);

  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const delivery = await writeProtected(r, INSTANCES_FILENAME, content, message, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  return { file, delivery };
}

// ---- what an origin says about itself -------------------------------------------

export interface PeerIdentity {
  instance_id: string;
  name: string;
  capabilities: string[];
}

/** Normalise what a person types: strip a trailing slash, refuse a path — an origin is a scheme and a host. */
export function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new StepFailed(`${JSON.stringify(raw)} is not an origin — give a scheme and a host, e.g. https://metis.example.com`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new StepFailed(`${JSON.stringify(raw)} is not an http(s) origin`);
  if (u.pathname !== "/" && u.pathname !== "") throw new StepFailed(`${JSON.stringify(raw)} has a path — an origin is the scheme, host and port only (the verb appends /api/identity itself)`);
  return u.origin;
}

/**
 * `GET /api/identity` at an origin: the one unauthenticated read a Metistry
 * console has (docs/ops/console-api.md), so adding a peer needs no
 * credential for it — which is the point, since a credential for a peer is
 * exactly what this design does not create.
 */
export async function fetchIdentity(origin: string, opts: Pick<InstancesOptions, "fetchFn" | "timeoutMs">): Promise<PeerIdentity> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${origin}/api/identity`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch (err) {
    throw new StepFailed(`${origin} did not answer (${(err as { cause?: { message?: string } })?.cause?.message ?? (err instanceof Error ? err.message : String(err))}) — nothing was written`);
  }
  if (res.status === 503) throw new StepFailed(`${url} answered 503: that console has no complete identity.yaml (name + instance_id), so it is not addressable yet — \`metistry init\` stamps the id`);
  if (!res.ok) throw new StepFailed(`${url} answered HTTP ${res.status} — is that a Metistry console?`);
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new StepFailed(`${url} did not answer JSON — is that a Metistry console?`);
  }
  const instanceId = typeof body.instance_id === "string" ? body.instance_id.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!instanceId || !name) throw new StepFailed(`${url} answered without instance_id + name — nothing to record`);
  const capabilities = Array.isArray(body.capabilities) ? normalizeCapabilities(body.capabilities.filter((c): c is string => typeof c === "string")) : [];
  return { instance_id: instanceId, name, capabilities };
}

function entryFor(origin: string, peer: PeerIdentity, now: string): InstanceEntry {
  return {
    instance_id: peer.instance_id,
    name: peer.name,
    origin,
    last_seen: now,
    capabilities: peer.capabilities,
    resources: [], // OPEN-7: the shape of a resource is not decided (docs/plan-refresh-2026-09-13.md S4)
  };
}

// ---- the verbs -------------------------------------------------------------------

export interface InstancesListResult {
  file: string;
  exists: boolean;
  instances: InstanceEntry[];
}

export async function instancesList(opts: InstancesOptions): Promise<InstancesListResult> {
  const { file, exists, registry } = await readRegistry(opts);
  return { file, exists, instances: registry.instances };
}

export interface InstancesChangeResult extends InstancesListResult {
  /** what the verb did to the registry */
  action: "added" | "updated" | "removed" | "refreshed" | "unchanged";
  /** the entry this verb acted on (absent for `refresh`, which acts on all) */
  entry?: InstanceEntry;
  /** `refresh`: the origins that did not answer, with why. Never fatal — a peer can be asleep. */
  unreachable?: { origin: string; reason: string }[];
  delivery?: ProtectedWrite;
}

/**
 * `add <origin>` — ask that origin who it is, then record it. Keyed by
 * `instance_id`, never by origin: an origin can move (the phone's problem,
 * research 2026-09-11) and the same instance arriving at a new address must
 * update its row, not make a second one. Adding THIS instance is refused —
 * a registry of peers that contains itself makes every consumer filter it.
 */
export async function instancesAdd(opts: InstancesOptions & { origin: string; selfInstanceId?: string | undefined }): Promise<InstancesChangeResult> {
  const origin = normalizeOrigin(opts.origin);
  const peer = await fetchIdentity(origin, opts);
  if (opts.selfInstanceId && peer.instance_id === opts.selfInstanceId) {
    throw new StepFailed(`${origin} is THIS instance (${peer.instance_id}) — the registry lists peers, not itself`);
  }
  const { registry } = await readRegistry(opts);
  const entry = entryFor(origin, peer, new Date().toISOString());
  const existing = registry.instances.findIndex((i) => i.instance_id === peer.instance_id);
  const next = [...registry.instances];
  if (existing === -1) next.push(entry);
  else next[existing] = entry;
  const action = existing === -1 ? "added" : "updated";
  const { file, delivery } = await commit(opts, next, `metistry: ${action} instance ${peer.name} (${peer.instance_id})`);
  return { file, exists: true, instances: next, action, entry, delivery };
}

/** `remove <instance_id|name>` — by id, or by name when that is unambiguous. */
export async function instancesRemove(opts: InstancesOptions & { target: string }): Promise<InstancesChangeResult> {
  const { file, registry } = await readRegistry(opts);
  const wanted = opts.target.trim();
  const byId = registry.instances.filter((i) => i.instance_id === wanted.toLowerCase());
  const matches = byId.length > 0 ? byId : registry.instances.filter((i) => i.name === wanted);
  if (matches.length === 0) throw new StepFailed(`no instance ${JSON.stringify(wanted)} in ${file} — \`metistry instances list\` shows what is there`);
  if (matches.length > 1) {
    throw new StepFailed(`${JSON.stringify(wanted)} names ${matches.length} instances in ${file} — remove it by instance_id (${matches.map((m) => m.instance_id).join(", ")})`);
  }
  const entry = matches[0]!;
  const next = registry.instances.filter((i) => i.instance_id !== entry.instance_id);
  const { delivery } = await commit(opts, next, `metistry: removed instance ${entry.name} (${entry.instance_id})`);
  return { file, exists: true, instances: next, action: "removed", entry, delivery };
}

/**
 * `refresh` — re-ask every recorded origin. An unreachable peer keeps its
 * row exactly as it was (a closed laptop is not a departed instance, O4);
 * one that answers with a DIFFERENT instance_id keeps its row too and is
 * reported, because that origin now belongs to someone else and moving the
 * row would quietly repoint the owner's registry.
 */
export async function instancesRefresh(opts: InstancesOptions): Promise<InstancesChangeResult> {
  const { file, registry } = await readRegistry(opts);
  const now = new Date().toISOString();
  const unreachable: { origin: string; reason: string }[] = [];
  const next: InstanceEntry[] = [];
  for (const entry of registry.instances) {
    try {
      const peer = await fetchIdentity(entry.origin, opts);
      if (peer.instance_id !== entry.instance_id) {
        unreachable.push({ origin: entry.origin, reason: `answers as a different instance (${peer.instance_id}) — the row was left alone; \`instances add ${entry.origin}\` records the new one` });
        next.push(entry);
        continue;
      }
      next.push(entryFor(entry.origin, peer, now));
    } catch (err) {
      unreachable.push({ origin: entry.origin, reason: err instanceof Error ? err.message : String(err) });
      next.push(entry);
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(registry.instances);
  if (!changed) return { file, exists: true, instances: next, action: "unchanged", unreachable };
  const { delivery } = await commit(opts, next, `metistry: refreshed ${next.length - unreachable.length} instance(s)`);
  return { file, exists: true, instances: next, action: "refreshed", unreachable, delivery };
}

// ---- output ----------------------------------------------------------------------

export function renderInstances(r: InstancesListResult & { unreachable?: { origin: string; reason: string }[] }): string {
  if (r.instances.length === 0) {
    return [
      `no peer instances in ${r.file}${r.exists ? "" : " (the file does not exist yet)"}`,
      "`metistry instances add <origin>` asks that origin who it is (GET /api/identity) and records it.",
    ].join("\n");
  }
  const w = (pick: (e: InstanceEntry) => string, head: string): number => Math.max(head.length, ...r.instances.map((e) => pick(e).length));
  const wn = w((e) => e.name, "name");
  const wo = w((e) => e.origin, "origin");
  const head = `${"name".padEnd(wn)}  ${"origin".padEnd(wo)}  instance_id                           capabilities`;
  const lines = [
    `file  ${r.file}`,
    "",
    head,
    "-".repeat(head.length),
    ...r.instances.map((e) => `${e.name.padEnd(wn)}  ${e.origin.padEnd(wo)}  ${e.instance_id}  ${(e.capabilities ?? []).join(", ") || "(not said)"}`),
  ];
  if (r.unreachable?.length) {
    lines.push("", "did not answer:");
    for (const u of r.unreachable) lines.push(`  ${u.origin} — ${u.reason}`);
  }
  lines.push(
    "",
    "capabilities are the coarse tool GROUPS an instance advertises on its own GET /api/identity — never a tool list, which stays behind an agent token at /mcp (docs/ops/instances.md).",
  );
  return lines.join("\n");
}
