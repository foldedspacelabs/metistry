// Naming instances, and naming agents across them (SAM adopts S1/S3/S4,
// docs/research/2026-09-13-google-sam-review.md "ADOPT"). Three small
// things live here because both ends need the same words:
//
//   * CAPABILITIES — the coarse vocabulary `GET /api/identity` advertises
//     and `instances.yaml` records. Tool GROUP names, never tool names and
//     never counts: discovery of what an instance actually exposes stays
//     behind an agent token at `/mcp` (`tools/list`), which is SAM's own
//     discipline that discovery is itself grantable.
//   * qualifyAgentId — `agent:<name>@<instance_id>`, the naming half of a
//     portable agent identity with none of the crypto. Storage keeps the
//     bare `<name>` where the instance is implicit; the qualified form is
//     what crosses an instance boundary.
//   * instances.yaml — the peer registry: a file, not a service, at this
//     scale. Schema only; the CLI writes it (a §4.7 protected path) and the
//     console serves it.

import { z } from "zod";
import { parse as parseYaml } from "yaml";

/** The instance repo's peer registry (a §4.7 protected path, like compute.yaml). */
export const INSTANCES_FILENAME = "instances.yaml";

/**
 * Tool GROUPS, not tools. An instance advertises which of these it has
 * enabled so a phone switcher or a second instance can name what it offers
 * before signing in; nothing here says how many of anything there is, and
 * nothing names a tool. Alphabetical, because the wire order is stable.
 */
export const CAPABILITIES = ["artifacts", "capture", "dispatch", "knowledge", "queries", "tasks"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Sort + dedupe into the canonical order, dropping anything outside the vocabulary (a peer may be a newer version than this one). */
export function normalizeCapabilities(raw: readonly string[]): Capability[] {
  return CAPABILITIES.filter((c) => raw.includes(c));
}

// ---- agent identity across instances -------------------------------------------

/** The registry id shape (apps/console/src/agents.ts AGENT_ID_RE), repeated as the one core knows. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** An instance_id is the v4 UUID `metistry init` mints (packages/cli/src/instance.ts INSTANCE_ID_RE). */
export const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The canonical qualified form, for a reader that has to recognise one. */
export const QUALIFIED_AGENT_RE = /^agent:([a-z][a-z0-9-]{0,39})@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * `agent:<name>@<instance_id>` — what an agent id is called once it leaves
 * the instance that minted it (S3). Strict on both halves and strict about
 * being handed one of its own results: re-qualifying is a bug at the call
 * site, not something to paper over, because `agent:a@x@y` would look like
 * a name for the rest of time.
 */
export function qualifyAgentId(name: string, instanceId: string): string {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not an agent id (^[a-z][a-z0-9-]{0,39}$) — pass the bare name, not a qualified one`);
  }
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new Error(`${JSON.stringify(instanceId)} is not an instance_id (a lowercase v4 UUID; \`metistry init\` mints it into identity.yaml)`);
  }
  return `agent:${name}@${instanceId}`;
}

/** The two halves back, or undefined when this is not a qualified id (a bare `<name>` from before S3 is not). */
export function parseAgentId(value: string): { name: string; instance_id: string } | undefined {
  const m = QUALIFIED_AGENT_RE.exec(value);
  return m ? { name: m[1]!, instance_id: m[2]! } : undefined;
}

/**
 * Qualify when both halves are known, and pass the bare name through when
 * the instance is not (a console with no complete identity.yaml, and every
 * row written before S3). The mixed period is documented, not hidden —
 * docs/ops/instances.md.
 */
export function qualifyIfPossible(name: string | null | undefined, instanceId: string | undefined): string | null {
  if (!name || !AGENT_NAME_RE.test(name)) return name ?? null;
  if (!instanceId || !INSTANCE_ID_RE.test(instanceId)) return name;
  return qualifyAgentId(name, instanceId);
}

// ---- instances.yaml -------------------------------------------------------------

const originSchema = z
  .string()
  .regex(/^https?:\/\/[^\s/]+(?::\d{1,5})?$/, "origin must be a scheme + host (+ port), no path and no trailing slash");

export const instanceEntrySchema = z.object({
  instance_id: z.string().regex(INSTANCE_ID_RE, "instance_id must be a lowercase v4 UUID"),
  name: z.string().min(1).max(120),
  origin: originSchema,
  /** When `add`/`refresh` last got an answer from that origin. Absent = never reached. */
  last_seen: z.string().min(1).optional(),
  /** What that instance said it offers, coarse (CAPABILITIES). Absent = it did not say. */
  capabilities: z.array(z.string()).optional(),
  /**
   * OPEN-7. An instance's "directory of exposable resources" — CLI
   * commands, directories, MCP servers, compute, Slack, Linear — is listed
   * in docs/plan-refresh-2026-09-13.md (S4) as scope the owner has NOT
   * ruled on. The key exists so the file has a place for it; its shape is
   * not designed here, so the only thing that validates is emptiness.
   */
  resources: z.array(z.unknown()).max(0, "instances.yaml `resources` is OPEN-7 — its shape is not decided (docs/plan-refresh-2026-09-13.md S4); leave it empty").default([]),
});

export type InstanceEntry = z.infer<typeof instanceEntrySchema>;

export const instancesSchema = z.object({
  instances: z.array(instanceEntrySchema).max(200).default([]),
});

export type Instances = z.infer<typeof instancesSchema>;

export const emptyInstances: Instances = { instances: [] };

export interface InstancesResult {
  ok: boolean;
  value: Instances;
  /** One line per problem, each naming the field — never a stack. */
  errors: string[];
}

function issues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Validate a parsed object. An invalid file is never half-applied: `value` is the empty registry. */
export function validateInstances(raw: unknown): InstancesResult {
  const parsed = instancesSchema.safeParse(raw ?? {});
  return parsed.success ? { ok: true, value: parsed.data, errors: [] } : { ok: false, value: emptyInstances, errors: issues(parsed.error) };
}

/** Parse YAML text. A syntax error is an error line, not a throw — the same contract parseCompute has. */
export function parseInstances(text: string): InstancesResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { ok: false, value: emptyInstances, errors: [`(root): ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (raw === null || raw === undefined) return { ok: true, value: emptyInstances, errors: [] }; // an empty file is an empty registry
  return validateInstances(raw);
}

/** Look one up by the key everything is keyed by — an origin can move, an instance_id cannot. */
export function findInstance(list: Instances, instanceId: string): InstanceEntry | undefined {
  return list.instances.find((i) => i.instance_id === instanceId);
}
