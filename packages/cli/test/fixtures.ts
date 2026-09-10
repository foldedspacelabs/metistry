// Shared fakes for the up/update tests: a synthetic product checkout in a
// temp dir (plist templates with the real placeholders, built dist/ trees,
// migrations, compose file, workspace packages) and an exec fake that
// records every call. No subprocess, no network, no db.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorDeps, DoctorReport } from "../src/doctor.js";
import type { Exec, ExecOptions, ExecResult } from "../src/exec.js";

const plist = (label: string, args: string, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>${args}</array>\n${extra}  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`;

/** The shape ops/launchd uses for node services: `set -a; . <instance>/state/.env; set +a; exec node <dist>`. */
export const nodeJob = (label: string, rel: string) =>
  plist(label, `<string>/bin/sh</string><string>-c</string><string>set -a; . __ENV_FILE__; set +a; exec __NODE__ __REPO__/${rel}</string>`, `  <key>WorkingDirectory</key><string>__REPO__</string>\n`);

/** The eventkit-helper shape: the signed binary is the job's root process; env via EnvironmentVariables. */
export const binJob = (label: string, rel: string) =>
  plist(label, `<string>__REPO__/${rel}</string>`, `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>METISTRY_EK_SOCKET</key><string>/tmp/x.sock</string>\n  </dict>\n`);

export const HELPER = "com.foldedspacelabs.metistry.eventkit-helper";
export const RECONCILER = "com.foldedspacelabs.metistry.reconciler";
export const WATCHDOG = "com.foldedspacelabs.metistry.watchdog";
/** in ops/launchd file-name order */
export const JOBS = [HELPER, RECONCILER, WATCHDOG] as const;

export async function put(root: string, rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), text);
}

export async function checkout(opts: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-up-"));
  await put(root, "package.json", JSON.stringify({ name: "metistry" }));
  await put(root, "seed/identity.yaml", "name: Seed\n");
  await put(root, `ops/launchd/${HELPER}.plist`, binJob(HELPER, "packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper"));
  await put(root, `ops/launchd/${RECONCILER}.plist`, nodeJob(RECONCILER, "apps/reconciler/dist/main.js"));
  await put(root, `ops/launchd/${WATCHDOG}.plist`, nodeJob(WATCHDOG, "apps/watchdog/dist/main.js"));
  await put(root, "apps/watchdog/dist/main.js", "v1");
  await put(root, "apps/watchdog/dist/lib/util.js", "v1");
  await put(root, "apps/reconciler/dist/main.js", "v1");
  await put(root, "packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper", "bin");
  await put(root, "db/migrations/0001_a.sql", "select 1;");
  await put(root, "db/migrations/0002_b.sql", "select 2;");
  await put(root, "docker-compose.yml", "services:\n  db: {}\n  console: {}\n");
  await put(root, "packages/core/package.json", JSON.stringify({ name: "@foldedspacelabs/metistry-core", version: "0.0.1" }));
  await put(root, "packages/cli/package.json", JSON.stringify({ name: "@foldedspacelabs/metistry-cli", version: "0.0.1" }));
  await put(root, "packages/private/package.json", JSON.stringify({ name: "@foldedspacelabs/metistry-private", private: true }));
  if (opts.git) await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

export interface Call {
  cmd: string;
  args: string[];
  cwd?: string | undefined;
}

type Handler = (args: string[], opts?: ExecOptions) => Partial<ExecResult> | undefined | void | Promise<Partial<ExecResult> | undefined | void>;

/** Every call succeeds with empty output unless a handler for that binary says otherwise. */
export function fakeExec(handlers: Record<string, Handler> = {}): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const exec = (async (cmd: string, args: string[], opts?: ExecOptions) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const r = await handlers[cmd]?.(args, opts);
    return { code: 0, stdout: "", stderr: "", ...(r ?? {}) };
  }) as Exec & { calls: Call[] };
  exec.calls = calls;
  return exec;
}

export const shown = (c: Call) => [c.cmd, ...c.args].join(" ");

export const okDoctor = async (d: DoctorDeps): Promise<DoctorReport> => ({ as_of: "now", product_dir: d.productDir, shape: "compose", ok: true, rows: [] });
export const failDoctor = async (d: DoctorDeps): Promise<DoctorReport> => ({ as_of: "now", product_dir: d.productDir, shape: "compose", ok: false, rows: [] });
