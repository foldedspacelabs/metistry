// `deployment.yaml` — WHERE the services run (plan §4.17, open decision 15).
//
// Two shapes, and the code is the same code in both (invariant 7 — nothing
// assumes a shared filesystem or a container runtime):
//
//   compose  Postgres, console and assistant as containers; reconciler and
//            watchdog as host jobs. The Linux/cloud shape, and today's
//            default on macOS.
//   launchd  every service a launchd job on the host, Postgres from a
//            user-space install. The shape the Mac app installs, because
//            Docker Desktop is the largest first-run hurdle
//            (docs/product/desktop-app-plan.md).
//
// The file is instance config (D4): the product ships the default in
// `seed/deployment.yaml`, the instance's own copy wins by filename. This
// module owns the schema, the overlay and the URL resolution; reading the
// files is the CLI's job (packages/cli/src/deployment.ts) — core takes no
// filesystem or YAML dependency.

import { z } from "zod";

export const DEPLOYMENT_FILENAME = "deployment.yaml";

export const DEPLOYMENT_SHAPES = ["compose", "launchd"] as const;
export type DeploymentShape = (typeof DEPLOYMENT_SHAPES)[number];

/**
 * The services whose shape actually differs. Under `compose` they are
 * containers; under `launchd` they are host jobs with a plist each.
 */
export const SHAPED_SERVICES = ["db", "console", "assistant"] as const;

/**
 * The services that are host jobs under BOTH shapes (invariant 6): the
 * reconciler holds the instance repo's working tree, the watchdog must
 * outlive the container runtime.
 */
export const HOST_SERVICES = ["reconciler", "watchdog"] as const;

/** Every service `up` brings up and `doctor` reports on, in dependency order. */
export const ALL_SERVICES = [...SHAPED_SERVICES, ...HOST_SERVICES] as const;
export type ServiceName = (typeof ALL_SERVICES)[number];

export const serviceOverrideSchema = z
  .object({
    /** run just this service the other way (a container db under a launchd install, say) */
    shape: z.enum(DEPLOYMENT_SHAPES).optional(),
    /** false = `up` does not start it and `doctor` does not fail on it */
    enabled: z.boolean().optional(),
  })
  .strict();

export const deploymentSchema = z
  .object({
    shape: z.enum(DEPLOYMENT_SHAPES).default("compose"),
    services: z.record(z.string(), serviceOverrideSchema).default({}),
  })
  .strict();

export type Deployment = z.infer<typeof deploymentSchema>;
export type ServiceOverride = z.infer<typeof serviceOverrideSchema>;

/** The shape an install has when there is no deployment.yaml anywhere: today's. */
export const DEFAULT_DEPLOYMENT: Deployment = { shape: "compose", services: {} };

/** Strict: an unknown key or a misspelled shape is an error, never a silent fall back to compose. */
export function parseDeployment(raw: unknown, source = DEPLOYMENT_FILENAME): Deployment {
  if (raw === null || raw === undefined) return { ...DEFAULT_DEPLOYMENT };
  const parsed = deploymentSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${source}: ${why} (docs/ops/deployment-shapes.md documents the shape)`);
  }
  return parsed.data;
}

/**
 * The D4 overlay, for one file: the instance's copy wins whole, and a
 * per-service override in the instance is merged over the seeded one, so a
 * new seeded service default appears on `metistry update` without touching
 * the user's file.
 */
export function overlayDeployment(seed: Deployment, instance: Deployment | undefined): Deployment {
  if (!instance) return seed;
  const services: Record<string, ServiceOverride> = { ...seed.services };
  for (const [name, over] of Object.entries(instance.services)) services[name] = { ...services[name], ...over };
  return { shape: instance.shape, services };
}

/** The shape one service runs in: its own override, else the install's. */
export function shapeOf(d: Deployment, service: string): DeploymentShape {
  return d.services[service]?.shape ?? d.shape;
}

/** A service is on unless the instance turned it off. */
export function enabled(d: Deployment, service: string): boolean {
  return d.services[service]?.enabled !== false;
}

/** Every service with the shape it runs in — what `up` plans from and `doctor` reports. */
export function servicePlan(d: Deployment): { name: ServiceName; shape: DeploymentShape; enabled: boolean }[] {
  return ALL_SERVICES.map((name) => ({
    name,
    // reconciler and watchdog are host jobs in both shapes: an install-wide
    // `shape: compose` must not claim they are containers
    shape: (HOST_SERVICES as readonly string[]).includes(name) ? "launchd" : shapeOf(d, name),
    enabled: enabled(d, name),
  }));
}

/** True when any service needs a container runtime — the only reason `up` calls docker at all. */
export function usesCompose(d: Deployment): boolean {
  return servicePlan(d).some((s) => s.enabled && s.shape === "compose");
}

// ---- URL resolution -------------------------------------------------------

/**
 * Hostnames that only mean something inside a compose network (the service
 * names) or from a container looking outward (the Docker gateway aliases).
 * A process on the host resolves none of them.
 */
export const CONTAINER_HOSTNAMES = new Set(["host.docker.internal", "gateway.docker.internal", "db", "console", "assistant", "reconciler"]);

export type Vantage = "host" | "container";

export interface UrlContext {
  shape: DeploymentShape;
  /** where the process that will USE this url runs (default: the host) */
  vantage?: Vantage;
}

/**
 * The ONE place a configured URL is resolved for the process about to use
 * it. `.env` is written once and read by processes in different places:
 * doctor and the watchdog on the host, the console in a container under the
 * compose shape and on the host under launchd. Rather than each caller
 * knowing which rewrite applies, they all ask here.
 *
 * From the host — and everything is on the host under the launchd shape —
 * a compose hostname becomes loopback. From inside a container under the
 * compose shape the url is already correct and is left alone. A url that
 * does not parse comes back untouched: reporting "not configured properly"
 * is doctor's job, not this function's.
 */
export function resolveUrl(url: string, ctx: UrlContext): string {
  if (ctx.shape === "compose" && (ctx.vantage ?? "host") === "container") return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (CONTAINER_HOSTNAMES.has(u.hostname)) u.hostname = "127.0.0.1";
  return u.toString().replace(/\/$/, "");
}
