// The launchd shape's jobs carry `.env` as it was when `up` rendered them.
//
// The supervisor's LaunchAgent plist embeds the install's environment in its
// `EnvironmentVariables` dict, and `supervisor.json` embeds it again (its own
// `env`, and every child's). Both are written by `metistry up` and by nothing
// else. So every verb that rewrites `.env` — `secrets sync --to env`,
// `secrets mint`, `secrets migrate-scope`, `secrets retire-legacy-env`, and
// `update`'s owner-bearer mint and shared-scope migration — left the running
// install on the values it replaced: on the owner's 0.14.2 instance the
// bridges 401'd the watchdog and the console (new tokens in `.env`, old ones
// in the jobs), and the OpenRouter key never reached the supervisor at all,
// so there was no assistant child while doctor said "assistant ok".
//
// Two halves, one comparison:
//
//   `envDrift`       which of `.env`'s values the installed jobs do not
//                    carry — names only, never a value. Doctor's
//                    `launchd env` row is this, read-only.
//   `followEnvFile`  what a writer of `.env` ends with: when the jobs have
//                    drifted, run `metistry up` — the ONE renderer, so a
//                    plist is never rendered two ways — which rewrites the
//                    plists and supervisor.json from `.env` and kickstarts
//                    the supervisor. When it cannot, ONE exact instruction.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KEEP_AWAKE_ENV, resolveUrl } from "@foldedspacelabs/metistry-core";
import { CONSOLE_ENV_DENY } from "./deployment.js";
import { parseDotEnv } from "./env.js";
import type { Exec } from "./exec.js";
import { labelFor, launchAgentsDir } from "./launchd.js";
import { loadNamespace } from "./namespace.js";
import { readSupervisorConfig, supervisorConfigPath, SUPERVISOR_SERVICE } from "./supervisor.js";

/** The instruction, word for word, wherever this module cannot do the work itself. */
export const FOLLOW_ENV_COMMAND = "metistry up";

/**
 * Names the console's (and so the supervisor's) environment sets ITSELF
 * rather than passing through from `.env` (deployment.ts `consoleEnv`,
 * `instanceVars`; up.ts adds keep-awake from deployment.yaml). Their job
 * value legitimately differs from `.env`'s, so comparing them would report
 * drift that `up` can never remove.
 */
export const JOB_OWNED_VARS: ReadonlySet<string> = new Set([
  "METISTRY_DB_HOST",
  "METISTRY_DB_PORT",
  "METISTRY_CONSOLE_HOST",
  "METISTRY_CONSOLE_PORT",
  "METISTRY_INBOX_DIR",
  "METISTRY_INSTANCE_DIR",
  "METISTRY_SEED_DIR",
  KEEP_AWAKE_ENV,
]);

/** XML text content back to the string `renderEnvDict` escaped. */
export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** A rendered plist's `EnvironmentVariables` dict, or undefined when it has none. */
export function parsePlistEnv(plist: string): Record<string, string> | undefined {
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1];
  if (dict === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const m of dict.matchAll(/<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\/>)/g)) out[xmlUnescape(m[1]!)] = xmlUnescape(m[2] ?? "");
  return out;
}

/**
 * What the supervisor's environment should hold for each `.env` line it
 * passes through: every `METISTRY_*` but the owner bearer the console is
 * never given, with URLs resolved for a host process — `consoleEnv`'s own
 * rule, applied to the file alone.
 */
export function expectedFromDotenv(dotenv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dotenv)) {
    if (!k.startsWith("METISTRY_") || CONSOLE_ENV_DENY.includes(k) || JOB_OWNED_VARS.has(k)) continue;
    out[k] = k.endsWith("_URL") ? resolveUrl(v, { shape: "launchd", vantage: "host" }) : v;
  }
  return out;
}

/** sha256 over `name=value` lines, sorted — so two environments can be compared in a report that must never print a value. */
export function envHash(env: Record<string, string>, names: readonly string[]): string {
  const h = createHash("sha256");
  for (const n of [...names].sort()) h.update(`${n}=${env[n] ?? "\u0000absent"}\n`);
  return h.digest("hex").slice(0, 12);
}

export interface EnvDrift {
  /** where the installed copy was read: the plist path, or `supervisor.json` */
  source: string;
  /** every `.env` name compared */
  compared: string[];
  /** in both, with different values */
  differs: string[];
  /** in `.env`, absent from the installed job — how the engine's key never reached the supervisor */
  missing: string[];
  /** short hashes of the compared values on each side (never a value) */
  hash: { job: string; env: string };
}

export function envDrift(source: string, expected: Record<string, string>, job: Record<string, string>): EnvDrift {
  const compared = Object.keys(expected).sort();
  const differs = compared.filter((n) => n in job && job[n] !== expected[n]);
  const missing = compared.filter((n) => !(n in job));
  return { source, compared, differs, missing, hash: { job: envHash(job, compared), env: envHash(expected, compared) } };
}

export function driftedNames(d: EnvDrift[]): string[] {
  return [...new Set(d.flatMap((x) => [...x.differs, ...x.missing]))].sort();
}

/** `.env`'s values across the files an install reads — earlier wins, `loadInstallEnv`'s rule. */
export async function readDotenvFiles(files: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const [k, v] of Object.entries(parseDotEnv(await readFile(f, "utf8")))) if (!(k in out)) out[k] = v;
  }
  return out;
}

export interface InstalledEnvOptions {
  /** `<instance>` (or the product checkout, for an install with none) — where `.metistry/state/supervisor.json` is */
  stateRoot: string;
  home: string | undefined;
  /** this instance's namespace suffix, when it has one */
  labelSuffix?: string | undefined;
}

/**
 * The environments the installed launchd shape actually runs with: the
 * supervisor's LaunchAgent plist (absent when the Mac app registered it from
 * its bundle, which carries nothing install-specific) and `supervisor.json`'s
 * `env`, which the supervisor applies to itself at start. Empty = this instance
 * was not brought up under the launchd shape, and there is nothing to follow.
 */
export async function installedJobEnvs(o: InstalledEnvOptions): Promise<{ source: string; env: Record<string, string> }[]> {
  // supervisor.json first, and it is the gate: THIS instance's state
  // directory is what says it was brought up under the launchd shape. A
  // plist under the (shared) LaunchAgents directory alone could belong to
  // another install on the Mac, and following it would restart that one.
  const config = await readSupervisorConfig(supervisorConfigPath(o.stateRoot)).catch(() => undefined);
  if (!config) return [];
  const out: { source: string; env: Record<string, string> }[] = [];
  if (o.home) {
    const plist = join(launchAgentsDir(o.home), `${labelFor(SUPERVISOR_SERVICE, o.labelSuffix)}.plist`);
    if (existsSync(plist)) {
      const env = parsePlistEnv(await readFile(plist, "utf8").catch(() => ""));
      if (env) out.push({ source: plist, env });
    }
  }
  out.push({ source: supervisorConfigPath(o.stateRoot), env: config.env });
  return out;
}

/** Every installed copy against `.env`. */
export async function launchdEnvDrift(o: InstalledEnvOptions & { envFiles: readonly string[] }): Promise<{ installed: boolean; drift: EnvDrift[] }> {
  const jobs = await installedJobEnvs(o);
  if (jobs.length === 0) return { installed: false, drift: [] };
  const expected = expectedFromDotenv(await readDotenvFiles(o.envFiles));
  return { installed: true, drift: jobs.map((j) => envDrift(j.source, expected, j.env)) };
}

export interface FollowEnvOptions {
  /** the `--product-dir` the verb ran with; passed through to `up` unchanged */
  productDir: string;
  /** the files `.env` is read from, in precedence order (`envPaths().read`) */
  envFiles: readonly string[];
  /** `--env-file`, when the verb was given one; `up` gets the same flag */
  envFileFlag?: string | undefined;
  instanceDir?: string | undefined;
  home: string | undefined;
  platform: NodeJS.Platform;
  /** this process's environment; `.env`'s names are REMOVED before `up` sees it (below) */
  env: NodeJS.ProcessEnv;
  exec: Exec;
  out: (line: string) => void;
  /** the CLI to run `up` with: this install's node and `packages/cli/dist/main.js` */
  cli: { node: string; main: string };
  dryRun?: boolean | undefined;
  /** how long the re-render may take; `up` brings the whole install back, Postgres included */
  timeoutMs?: number | undefined;
}

export interface FollowEnvResult {
  action: "none" | "rerendered" | "instruction";
  /** names whose value the jobs did not carry (never a value) */
  drifted: string[];
  detail: string;
}

export const FOLLOW_ENV_TIMEOUT_MS = 10 * 60_000; // limit: fixed — a whole `up`, Postgres and the closing doctor included; a hang is reported, not waited out

/**
 * The environment `up` runs with: this one MINUS every name `.env` sets.
 *
 * This process loaded `.env` at start, before the verb rewrote it, and
 * `loadEnvFile` never overwrites a set variable — so a child that inherited
 * it would render the OLD values straight back into the plists. Removing the
 * names makes the child read them from the file, which is the point.
 */
export function freshEnvFor(env: NodeJS.ProcessEnv, dotenvNames: Iterable<string>, instanceDir: string | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const n of dotenvNames) delete out[n];
  if (instanceDir) out.METISTRY_INSTANCE_DIR = instanceDir;
  return out;
}

export async function followEnvFile(o: FollowEnvOptions): Promise<FollowEnvResult> {
  if (o.platform !== "darwin") return { action: "none", drifted: [], detail: "no launchd here" };
  const stateRoot = o.instanceDir ?? o.productDir;
  const ns = await loadNamespace(o.instanceDir).catch(() => undefined);
  const { installed, drift } = await launchdEnvDrift({ stateRoot, home: o.home, labelSuffix: ns?.labelSuffix, envFiles: o.envFiles });
  if (!installed) return { action: "none", drifted: [], detail: "no launchd-shape install to follow (no supervisor plist or supervisor.json)" };
  const drifted = driftedNames(drift);
  if (drifted.length === 0) {
    const detail = "launchd: the supervisor's plist and supervisor.json already carry .env's values — nothing to re-render";
    o.out(detail);
    return { action: "none", drifted, detail };
  }
  const what = `${drifted.length} value(s) the running jobs do not carry: ${drifted.join(", ")}`;
  if (o.dryRun) {
    const detail = `launchd: .env has ${what} — a real run re-renders the plists and supervisor.json from .env and restarts the supervisor (\`${FOLLOW_ENV_COMMAND}\`)`;
    o.out(detail);
    return { action: "instruction", drifted, detail };
  }
  if (!existsSync(o.cli.main)) {
    const detail = `launchd: .env has ${what}, and there is no CLI at ${o.cli.main} to re-render them with — run \`${FOLLOW_ENV_COMMAND}\``;
    o.out(detail);
    return { action: "instruction", drifted, detail };
  }
  o.out(`launchd: .env has ${what} — re-rendering the plists and supervisor.json from it and restarting the supervisor (\`${FOLLOW_ENV_COMMAND}\`):`);
  const names = Object.keys(await readDotenvFiles(o.envFiles));
  const args = [o.cli.main, "up", "--no-compose", "--product-dir", o.productDir, ...(o.envFileFlag ? ["--env-file", o.envFileFlag] : [])];
  const res = await o.exec(o.cli.node, args, { env: freshEnvFor(o.env, names, o.instanceDir), inherit: true, timeoutMs: o.timeoutMs ?? FOLLOW_ENV_TIMEOUT_MS }).catch((err: unknown) => ({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
  // re-read, rather than trust the exit code: `up` exits non-zero when its
  // closing doctor is unhappy about something unrelated, and what this step
  // promised is only that the jobs now carry `.env`
  const after = driftedNames((await launchdEnvDrift({ stateRoot, home: o.home, labelSuffix: ns?.labelSuffix, envFiles: o.envFiles })).drift);
  if (after.length === 0) {
    const detail = `launchd: re-rendered from .env — the supervisor's plist and supervisor.json now carry ${drifted.join(", ")}, and \`${FOLLOW_ENV_COMMAND}\` restarted the supervisor onto them${res.code === 0 ? "" : ` (it exited ${res.code}; its doctor table above says why)`}`;
    o.out(detail);
    return { action: "rerendered", drifted, detail };
  }
  const detail = `launchd: the jobs still do not carry ${after.join(", ")} from .env (\`${FOLLOW_ENV_COMMAND}\` exited ${res.code}${res.stderr ? `: ${res.stderr.trim().split("\n").slice(-1)[0]}` : ""}) — run \`${FOLLOW_ENV_COMMAND}\``;
  o.out(detail);
  return { action: "instruction", drifted, detail };
}
