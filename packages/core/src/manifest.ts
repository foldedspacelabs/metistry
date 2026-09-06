// Manifest schema — invariant 5: everything is a directory with a manifest.
// One discriminated union over `type`; CI and `metistry doctor` both
// validate against this, so the schema is the contract.

import { z } from "zod";

const cron = z
  .string()
  .regex(
    /^(@(hourly|daily|weekly|monthly)|(\S+\s+){4}\S+)$/,
    "schedule must be a 5-field cron expression or @hourly/@daily/@weekly/@monthly",
  );

const name = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "names are lowercase kebab-case (casing rule: only Knowledge/ is TitleCase)");

const base = z.object({
  name,
  description: z.string().optional(),
});

// TCC permissions a bridge may declare. Behavioral probes, not permission
// APIs, verify these at runtime (Phase 0 hard requirement 3).
const tccGrant = z.enum([
  "full_disk_access",
  "automation",
  "calendars",
  "reminders",
  "contacts",
]);

export const bridgeManifest = base.extend({
  type: z.literal("bridge"),
  transport: z.enum(["http", "stdio"]),
  port: z.number().int().min(1).max(65535).optional(),
  runs_on: z.enum(["host", "container"]),
  requires_tcc: z.array(tccGrant).default([]),
  // Default eager (PoC-17: lazy loses on small surfaces); lazy is for
  // bridges past >20 tools / >5k definition tokens.
  discovery: z.enum(["lazy", "eager"]).default("eager"),
  degrades: z.string().default("absent"), // "absent" | <fallback bridge name>
  exposes: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        destructive: z.boolean().default(false),
      }),
    )
    .min(1),
}).superRefine((m, ctx) => {
  // PoC-1: a stdio server spawned by the agent inherits the agent's TCC
  // identity. Any TCC-requiring bridge MUST be its own http host service.
  if (m.requires_tcc.length > 0 && (m.transport !== "http" || m.runs_on !== "host")) {
    ctx.addIssue({
      code: "custom",
      message: "bridges with requires_tcc must be transport: http and runs_on: host (PoC-1)",
    });
  }
  if (m.transport === "http" && m.port === undefined) {
    ctx.addIssue({ code: "custom", message: "http bridges must declare a port" });
  }
});

export const collectorManifest = base.extend({
  type: z.literal("collector"),
  schedule: cron,
  writes: z.array(z.string()).min(1),
  reads: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
});

export const agentManifest = base.extend({
  type: z.literal("agent"),
  model: z.string(),
  uses: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  scope: z.array(z.string()).default([]),
  manages: z.array(z.string()).default([]),
});

export const routineManifest = base.extend({
  type: z.literal("routine"),
  schedule: cron,
  agent: z.string().optional(),
});

// Secrets are referenced, never written into a manifest: `env:VAR`.
const envRef = z
  .string()
  .regex(/^env:[A-Z][A-Z0-9_]*$/, "must be an environment reference (env:VAR) — never a literal secret");

// A vault-relative path prefix the brief may reference (plan §4.15: scopes
// are prefix matches, so `Knowledge/Areas/fsl` covers every sub-area).
const knowledgePrefix = z
  .string()
  .regex(/^Knowledge(\/[A-Za-z0-9_.-]+)*$/, "allow entries are Knowledge/... path prefixes (no '..', no trailing slash)")
  .refine((p) => !p.split("/").includes(".."), "allow entries may not contain '..'");

// What a brief bound for this target may carry (§4.18.B). Every field is
// required so the policy is a declaration, not a default nobody chose. The
// dispatch tool enforces it — a manifest is the contract, the tool is the
// control.
export const dataPolicySchema = z.object({
  /** Knowledge path prefixes a brief may reference; empty = no vault references at all. */
  allow: z.array(knowledgePrefix),
  /** Provenance classes that may never leave the machine via this target, e.g. `comms` (§4.12). */
  deny_sources: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/, "source names are lowercase kebab-case")),
  max_brief_bytes: z.number().int().positive(),
});

export type DataPolicy = z.infer<typeof dataPolicySchema>;

export const targetManifest = base
  .extend({
    type: z.literal("target"),
    transport: z.enum(["mcp", "http", "github", "local"]),
    /** How work goes in — shape depends on transport (github: `repo`). */
    submit: z.record(z.string(), z.unknown()),
    /** How results come back. `via: report_queue` is the only return path (§4.18.B). */
    result: z.looseObject({ via: z.string() }),
    auth: envRef.optional(),
    cost: z.object({ per_run_estimate_usd: z.number().nonnegative() }).optional(),
    data_policy: dataPolicySchema,
  })
  .superRefine((m, ctx) => {
    if (m.transport === "github") {
      const repo = m.submit.repo;
      if (typeof repo !== "string" || !/^(env:[A-Z][A-Z0-9_]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(repo)) {
        ctx.addIssue({
          code: "custom",
          path: ["submit", "repo"],
          message: "github targets must declare submit.repo as owner/repo or env:VAR",
        });
      }
      if (m.auth === undefined) {
        ctx.addIssue({ code: "custom", path: ["auth"], message: "github targets must declare auth (env:VAR — a write token)" });
      }
    }
  });

export type TargetManifest = z.infer<typeof targetManifest>;

// Long-running processes doctor must see: reconciler, watchdog, console
// (review SHOULD-14 — the components most likely to die silently).
export const serviceManifest = base.extend({
  type: z.literal("service"),
  runs_on: z.enum(["host", "container"]),
  port: z.number().int().min(1).max(65535).optional(),
});

export const manifestSchema = z.discriminatedUnion("type", [
  bridgeManifest,
  collectorManifest,
  agentManifest,
  routineManifest,
  targetManifest,
  serviceManifest,
]);

export type Manifest = z.infer<typeof manifestSchema>;

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] };

/** Validate a parsed manifest object. Never throws. */
export function validateManifest(input: unknown): ManifestResult {
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
