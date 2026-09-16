// Reading `deployment.yaml` (core owns the schema, the overlay and the URL
// resolution — this file is only the filesystem half of it, so core keeps
// no yaml or fs dependency), and turning a shape into the concrete
// environment each launchd job runs with.
//
// The D4 overlay: `seed/deployment.yaml` in the product is the default;
// `<instance>/deployment.yaml` wins by filename. Neither present = today's
// install, `shape: compose`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_DEPLOYMENT,
  DEPLOYMENT_FILENAME,
  ENGINE_CREDENTIAL_VAR,
  engineCredentialPresent,
  overlayDeployment,
  parseDeployment,
  resolveUrl,
  type Deployment,
  type DeploymentShape,
} from "@foldedspacelabs/metistry-core";

async function readYaml(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return parseYaml(text);
}

/** Where the two copies live: the product's default and, when configured, the instance's. */
export function deploymentPaths(productDir: string, env: NodeJS.ProcessEnv): { seed: string; instance?: string } {
  const instanceDir = env.METISTRY_INSTANCE_DIR;
  return {
    seed: join(productDir, "seed", DEPLOYMENT_FILENAME),
    ...(instanceDir ? { instance: join(instanceDir, DEPLOYMENT_FILENAME) } : {}),
  };
}

export interface LoadedDeployment {
  deployment: Deployment;
  /** where the shape came from, for the `up` note and the doctor row */
  from: string;
}

/**
 * `METISTRY_DEPLOYMENT_SHAPE` overrides the file. It exists so a shape can
 * be previewed (`metistry up --dry-run`) before anything is committed to an
 * instance's deployment.yaml — the file stays the record, and both `up` and
 * `doctor` say out loud which of the two they read.
 */
export async function loadDeployment(productDir: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedDeployment> {
  const paths = deploymentPaths(productDir, env);
  const seedRaw = await readYaml(paths.seed);
  const seed = seedRaw === undefined ? { ...DEFAULT_DEPLOYMENT } : parseDeployment(seedRaw, `seed/${DEPLOYMENT_FILENAME}`);
  const instanceRaw = paths.instance ? await readYaml(paths.instance) : undefined;
  const merged = overlayDeployment(seed, instanceRaw === undefined ? undefined : parseDeployment(instanceRaw, paths.instance));
  const from =
    instanceRaw !== undefined ? paths.instance! : seedRaw !== undefined ? `seed/${DEPLOYMENT_FILENAME}` : `no ${DEPLOYMENT_FILENAME} — the built-in default`;

  const override = env.METISTRY_DEPLOYMENT_SHAPE;
  if (override !== undefined && override !== "") {
    const parsed = parseDeployment({ ...merged, shape: override }, "METISTRY_DEPLOYMENT_SHAPE");
    return { deployment: parsed, from: `METISTRY_DEPLOYMENT_SHAPE (overriding ${from})` };
  }
  return { deployment: merged, from };
}

/**
 * `metistry deployment set-shape` rewrites just the `shape:` line, the way
 * `secrets.ts`'s `rewriteEnv` and `instance.ts`'s `withInstanceId` rewrite
 * one field of a file a person may also hand-edit: every comment, the
 * `services:` overrides, and their ordering survive untouched. No instance
 * file yet gets the seed's own commented shape, freshly written rather than
 * copied, so a first `set-shape` doesn't have to explain the seed's prose.
 */
export function applyShapeToYaml(existing: string | undefined, shape: DeploymentShape): string {
  if (existing === undefined) {
    return [
      "# deployment.yaml — this instance's deployment shape (docs/ops/deployment-shapes.md).",
      "# `metistry deployment set-shape` wrote this line; edit shape/services by hand otherwise.",
      `shape: ${shape}`,
      "",
      "services: {}",
      "",
    ].join("\n");
  }
  if (/^shape:.*$/m.test(existing)) return existing.replace(/^shape:.*$/m, `shape: ${shape}`);
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return `shape: ${shape}\n${sep}${existing}`;
}

// ---- the environment each host job runs with -------------------------------

export interface ShapeContext {
  productDir: string;
  /** METISTRY_INSTANCE_DIR: where state/ and inbox/ live when there is an instance repo */
  instanceDir?: string | undefined;
  /** the install's environment — .env, already loaded (env.ts loadDotEnv) */
  env: NodeJS.ProcessEnv;
  shape: DeploymentShape;
  /** the assistant's own state directory; also its HOME (the SDK's transcripts) */
  stateDir: string;
}

export const CONSOLE_DEFAULT_PORT = 8080;
export const DB_DEFAULT_PORT = 5432;

export function consolePort(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env.METISTRY_CONSOLE_PORT ?? "", 10);
  return Number.isNaN(n) ? CONSOLE_DEFAULT_PORT : n;
}

export function dbPort(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env.METISTRY_DB_PORT ?? "", 10);
  return Number.isNaN(n) ? DB_DEFAULT_PORT : n;
}

/** Everything in the install's environment that belongs to Metistry, with every URL resolved for a host process. */
function metistryVars(ctx: ShapeContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) {
    if (v === undefined || !k.startsWith("METISTRY_")) continue;
    out[k] = k.endsWith("_URL") ? resolveUrl(v, { shape: ctx.shape, vantage: "host" }) : v;
  }
  return out;
}

/**
 * The console's environment as a launchd job.
 *
 * Same variables the compose service gets — the console is the component
 * that talks to everything, so a passthrough of `METISTRY_*` is the honest
 * translation of docker-compose.yml — with the container-only values
 * replaced: the db is on loopback rather than the `db` alias, the bind stays
 * loopback (invariant 8), and the inbox is a real directory rather than a
 * named volume.
 */
export function consoleEnv(ctx: ShapeContext): Record<string, string> {
  const inbox = ctx.instanceDir ? join(ctx.instanceDir, "inbox") : join(ctx.productDir, "inbox");
  return {
    ...metistryVars(ctx),
    METISTRY_DB_HOST: "127.0.0.1",
    METISTRY_DB_PORT: String(dbPort(ctx.env)),
    METISTRY_CONSOLE_HOST: "127.0.0.1",
    METISTRY_CONSOLE_PORT: String(consolePort(ctx.env)),
    METISTRY_INBOX_DIR: ctx.env.METISTRY_INBOX_DIR && !ctx.env.METISTRY_INBOX_DIR.startsWith("/data") ? ctx.env.METISTRY_INBOX_DIR : inbox,
    TZ: ctx.env.METISTRY_TZ || "UTC",
  };
}

/**
 * The engine credential seam lives in `packages/core` (deployment.ts) — the
 * console preflights routines against it and `apps/` may not import the CLI.
 * Re-exported here so `up`, `doctor` and the shape tests keep one import.
 */
export { ENGINE_CREDENTIAL_VAR, engineCredentialPresent };

/** The one line `up` prints when this install has no engine. */
export const ENGINE_ABSENT_NOTE = `assistant: absent — no engine credential (${ENGINE_CREDENTIAL_VAR}); captures, tasks, search and the console run; fold turns wait (docs/ops/assistant-tools.md)`;

/**
 * The engine's environment is an ALLOWLIST, not a passthrough.
 *
 * On the host there is no image boundary deciding what the process can see,
 * so this list is the boundary: the db, its own token, the brain URL, the
 * model knobs. The GitHub write PAT, the AWS keys and the VAPID private key
 * stay with the console — the engine reaches every one of those through an
 * allowlisted tool, never through its own environment (invariant 9).
 */
export const ASSISTANT_ENV_KEYS = [
  "METISTRY_DB_HOST",
  "METISTRY_DB_PORT",
  "METISTRY_DB_NAME",
  "METISTRY_DB_USER",
  "METISTRY_DB_PASSWORD",
  "METISTRY_MODEL_DEFAULT",
  "METISTRY_BRAIN_URL",
  "METISTRY_ASSISTANT_TOKEN",
  "METISTRY_MAX_TURNS",
  "METISTRY_DRAIN_INTERVAL_MS",
  "METISTRY_CREW_LEASE_S",
  "METISTRY_CREW_MAX_ATTEMPTS",
  "METISTRY_CREW_RETRY_S",
  "METISTRY_IDENTITY_FILES",
  "METISTRY_PROMPT_FILES",
  // compute.yaml's D4 overlay: the engine's own assignments, watched for
  // changes. Config, not a credential — the provider secrets it NAMES stay
  // in the Keychain and reach the engine per run, never through this list.
  "METISTRY_COMPUTE_FILES",
  ENGINE_CREDENTIAL_VAR,
] as const;

export function assistantEnv(ctx: ShapeContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ASSISTANT_ENV_KEYS) {
    const v = ctx.env[k];
    if (v !== undefined && v !== "") out[k] = k.endsWith("_URL") ? resolveUrl(v, { shape: ctx.shape, vantage: "host" }) : v;
  }
  out.METISTRY_DB_HOST = "127.0.0.1";
  out.METISTRY_DB_PORT = String(dbPort(ctx.env));
  out.METISTRY_BRAIN_URL = resolveUrl(ctx.env.METISTRY_BRAIN_URL || `http://127.0.0.1:${consolePort(ctx.env)}/mcp`, { shape: ctx.shape, vantage: "host" });
  // HOME is the state dir, which is also the only writable path the sandbox
  // profile allows: the SDK writes its session transcripts under it, and
  // they must survive a restart (the launchd twin of the assistant-home
  // volume in docker-compose.yml).
  out.HOME = ctx.stateDir;
  // ANTHROPIC_API_KEY is never set (PoC-4; the engine refuses to start with
  // it) — an allowlist rather than a passthrough is what guarantees that a
  // stray key in the operator's shell cannot reach the engine.
  return out;
}
