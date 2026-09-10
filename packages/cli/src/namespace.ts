// Running a SECOND instance on one Mac — the follow-up
// docs/product/desktop-app-plan.md named ("The limit that remains": launchd
// labels and ports are fixed, so bringing a second instance up would fight
// the first for both).
//
// The whole namespace is ONE file, `<instance>/state/ports.yaml`, written
// once by `metistry up --namespace` and read by `up`, `doctor`,
// `restart|stop|start` and `logs`. Its presence is what namespaces an
// install; delete it and the instance goes back to the fixed defaults. Two
// things live in it because they must not be able to disagree:
//
//   label_suffix   jobs become com.foldedspacelabs.metistry.<suffix>.<service>
//                  and their logs /tmp/metistry-<suffix>-<service>.log
//   ports          one contiguous block, one port per service that binds
//
// Both are derived from `instance_id` (docs/ops/cli.md, "Instance
// directories are self-contained") so two instance directories cannot
// collide by construction — but the file is the record, not the
// derivation: a block that was already taken is stepped past ONCE, at
// allocation, and then never moves. `state/` is derived and gitignored;
// losing this file costs an instance its allocation, not its data
// (invariant 1).
//
// The ports are applied to the environment for variables that are UNSET
// only. An explicit `METISTRY_CONSOLE_PORT` in `<instance>/state/.env`
// still wins everywhere — including in the two host jobs that source that
// file through `sh -c` and would otherwise disagree with the jobs whose
// environment `up` renders into a plist.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { instanceStateDir, normalizeDir } from "./instance.js";

export const PORTS_FILENAME = "ports.yaml";

/** Every service that binds a port, in block order. The offset IS the index — the file records the result, so this list may only ever grow at the end. */
export const PORTED_SERVICES = ["console", "db", "reconciler", "eventkit", "apple-fm"] as const;
export type PortedService = (typeof PORTED_SERVICES)[number];

/** The fixed ports an un-namespaced install uses — today's install, unchanged. */
export const DEFAULT_PORTS: Record<PortedService, number> = {
  console: 8080,
  db: 5432,
  reconciler: 7812,
  eventkit: 7811,
  "apple-fm": 7810,
};

/** `METISTRY_<X>_PORT` is not guessable from the service name for all five (EK, AFM), so the mapping is written out. */
export const PORT_VARS: Record<PortedService, string> = {
  console: "METISTRY_CONSOLE_PORT",
  db: "METISTRY_DB_PORT",
  reconciler: "METISTRY_RECONCILER_PORT",
  eventkit: "METISTRY_EK_PORT",
  "apple-fm": "METISTRY_AFM_PORT",
};

/** The loopback URL each ported service is reached at, when nothing in `.env` says otherwise. */
export const URL_VARS: Partial<Record<PortedService, string>> = {
  console: "METISTRY_CONSOLE_URL",
  reconciler: "METISTRY_RECONCILER_URL",
  eventkit: "METISTRY_EK_URL",
  "apple-fm": "METISTRY_AFM_URL",
};

/**
 * A block is 8 wide (5 used, 3 spare so a sixth ported service does not
 * force every existing instance to move) and blocks live in 8300-8999:
 * above the console's 8080 and the bridges' 78xx, below the ephemeral
 * range, and nowhere near 5432.
 */
export const BLOCK_SIZE = 8;
export const BLOCK_FLOOR = 8300;
export const BLOCK_CEIL = 8999;
export const BLOCK_COUNT = Math.floor((BLOCK_CEIL - BLOCK_FLOOR + 1) / BLOCK_SIZE);

export interface Namespace {
  /** `a1b2c3d4` — the first 8 hex of instance_id; the label and log-file infix */
  labelSuffix: string;
  base: number;
  ports: Record<PortedService, number>;
  /** where this came from, for the `up`/`doctor` note */
  from: string;
}

export function portsFile(instanceDir: string): string {
  return join(instanceStateDir(instanceDir), PORTS_FILENAME);
}

/** `a1b2c3d4` from `a1b2c3d4-…` — a launchd label component, so it is bounded and lowercase-hex by construction. */
export function suffixFor(instanceId: string): string {
  return instanceId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Deterministic, so the same instance directory asks for the same block on a machine that has never seen it. */
export function preferredBase(instanceId: string): number {
  const h = createHash("sha256").update(instanceId).digest();
  return BLOCK_FLOOR + (h.readUInt32BE(0) % BLOCK_COUNT) * BLOCK_SIZE;
}

export function portsOf(base: number): Record<PortedService, number> {
  return Object.fromEntries(PORTED_SERVICES.map((s, i) => [s, base + i])) as Record<PortedService, number>;
}

/** Can this process bind `127.0.0.1:<port>` right now? The only honest "is it free" — a table of known ports would go stale the first time anything else on the Mac took one. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function blockFree(base: number, free: (p: number) => Promise<boolean> = portFree): Promise<boolean> {
  for (let i = 0; i < BLOCK_SIZE; i++) if (!(await free(base + i))) return false;
  return true;
}

/**
 * The block this instance gets: its preferred one, or the next free block
 * after it. Allocation happens ONCE — after that `ports.yaml` is the
 * record and nothing probes again, because a running instance holding its
 * own ports must not look "taken" to itself.
 */
export async function allocateBase(instanceId: string, free: (p: number) => Promise<boolean> = portFree): Promise<number> {
  const start = preferredBase(instanceId);
  for (let n = 0; n < BLOCK_COUNT; n++) {
    const base = BLOCK_FLOOR + (((start - BLOCK_FLOOR) / BLOCK_SIZE + n) % BLOCK_COUNT) * BLOCK_SIZE;
    if (await blockFree(base, free)) return base;
  }
  throw new Error(`no free ${BLOCK_SIZE}-port block between ${BLOCK_FLOOR} and ${BLOCK_CEIL} — every block on this machine is in use`);
}

export function serializeNamespace(ns: Namespace, instanceId: string): string {
  return [
    "# This instance's namespace — written once by `metistry up --namespace` and",
    "# never rewritten. It is what lets a SECOND instance run on this Mac beside",
    "# the first: the launchd labels and the ports are otherwise fixed",
    '# (docs/product/desktop-app-plan.md, "The limit that remains").',
    "#",
    "# Delete this file to put the instance back on the default labels and ports —",
    "# `metistry stop` FIRST, or the jobs it installed keep their old labels.",
    "#",
    "# Derived state: gitignored, rebuildable, never backed up (invariant 1).",
    "schema: 1",
    `instance_id: ${JSON.stringify(instanceId)}`,
    `label_suffix: ${JSON.stringify(ns.labelSuffix)}`,
    `base: ${ns.base}`,
    "ports:",
    ...PORTED_SERVICES.map((s) => `  ${s}: ${ns.ports[s]}`),
    "",
  ].join("\n");
}

/** Strict: a hand-edited half-block is a job that binds a port doctor does not probe, so it is an error rather than a merge with the defaults. */
export function parseNamespace(text: string, source: string): Namespace {
  const raw = parseYaml(text) as { label_suffix?: unknown; base?: unknown; ports?: unknown } | null;
  const suffix = raw?.label_suffix;
  if (typeof suffix !== "string" || !/^[0-9a-z]{1,16}$/.test(suffix)) {
    throw new Error(`${source}: label_suffix must be 1-16 lowercase alphanumerics, not ${JSON.stringify(suffix)}`);
  }
  const base = raw?.base;
  if (typeof base !== "number" || !Number.isInteger(base)) throw new Error(`${source}: base must be an integer port, not ${JSON.stringify(base)}`);
  const rawPorts = (raw?.ports ?? {}) as Record<string, unknown>;
  const ports = {} as Record<PortedService, number>;
  for (const s of PORTED_SERVICES) {
    const p = rawPorts[s];
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`${source}: ports.${s} must be an integer port, not ${JSON.stringify(p)} (every service in the block must be listed)`);
    }
    ports[s] = p;
  }
  return { labelSuffix: suffix, base, ports, from: source };
}

/** The instance's namespace, or undefined when it has none (the default install — one instance, fixed labels and ports). */
export async function loadNamespace(instanceDir: string | undefined): Promise<Namespace | undefined> {
  if (!instanceDir) return undefined;
  const file = portsFile(normalizeDir(instanceDir));
  if (!existsSync(file)) return undefined;
  return parseNamespace(await readFile(file, "utf8"), file);
}

/**
 * Put the block into the environment for variables nothing has set.
 *
 * UNSET only, deliberately: the reconciler and the TCC bridges source
 * `<instance>/state/.env` themselves through `sh -c`, so anything written
 * there overrides whatever `up` renders into their plists. Filling only
 * the gaps is the one rule under which every job — the ones `up` renders
 * an environment for and the ones that source their own — agrees on which
 * port a service is on.
 */
export function applyPorts(env: NodeJS.ProcessEnv, ns: Namespace): string[] {
  const applied: string[] = [];
  for (const s of PORTED_SERVICES) {
    const port = ns.ports[s];
    const pv = PORT_VARS[s];
    if (env[pv] === undefined || env[pv] === "") {
      env[pv] = String(port);
      applied.push(`${pv}=${port}`);
    }
    const uv = URL_VARS[s];
    if (uv && (env[uv] === undefined || env[uv] === "")) {
      env[uv] = `http://127.0.0.1:${port}`;
      applied.push(`${uv}=http://127.0.0.1:${port}`);
    }
  }
  return applied;
}
