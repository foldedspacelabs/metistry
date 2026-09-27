// Shared fakes for the up/update tests: a synthetic product checkout in a
// temp dir (plist templates with the real placeholders, built dist/ trees,
// migrations, compose file, workspace packages) and an exec fake that
// records every call. No subprocess, no network, no db.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorDeps, DoctorReport } from "../src/doctor.js";
import type { Exec, ExecOptions, ExecResult } from "../src/exec.js";
import { APP_BUNDLE_ID } from "../src/mac-app.js";

const plist = (label: string, args: string, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>${args}</array>\n${extra}  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`;

/** The shape ops/launchd uses for node services: `set -a; . <instance>/state/.env; set +a; exec node <dist>`. */
export const nodeJob = (label: string, rel: string) =>
  plist(
    label,
    `<string>/bin/sh</string><string>-c</string><string>set -a; . __ENV_FILE__; set +a; exec __NODE__ __REPO__/${rel}</string>`,
    `  <key>WorkingDirectory</key><string>__REPO__</string>\n  <key>StandardOutPath</key><string>/tmp/metistry-${label.split(".").pop()}.log</string>\n`,
  );

/** The eventkit-helper shape: the signed binary is the job's root process; env via EnvironmentVariables. */
export const binJob = (label: string, rel: string) =>
  plist(label, `<string>__REPO__/${rel}</string>`, `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>METISTRY_EK_SOCKET</key><string>/tmp/x.sock</string>\n  </dict>\n`);

/** The EventKit helper's agent, renamed from `eventkit-helper` with the supervisor. */
export const HELPER = "com.foldedspacelabs.metistry.calendar";
export const RECONCILER = "com.foldedspacelabs.metistry.reconciler";
export const WATCHDOG = "com.foldedspacelabs.metistry.watchdog";
/** The one agent the launchd shape installs for the core; its label is the prefix itself. */
export const SUPERVISOR = "com.foldedspacelabs.metistry";
/** The agents the COMPOSE shape installs, in ops/launchd file-name order (no supervisor: that is the launchd shape's). */
export const JOBS = [HELPER, RECONCILER, WATCHDOG] as const;

export const RETIRED_SERVICES = {
  compose: ["eventkit-helper"],
  launchd: ["db", "console", "assistant", "reconciler", "watchdog", "eventkit", "apple-fm", "eventkit-helper"],
} as const;

/**
 * The retire step as a PLAN — what a dry run prints, which is still the
 * whole unconditional set: a dry run runs no probe, so it shows the most a
 * real run could do. Under compose that is only the EventKit helper's old
 * label (`eventkit-helper` → `calendar`); under launchd the whole
 * pre-supervisor set.
 */
export const retired = (home: string, shape: "compose" | "launchd" = "compose") =>
  RETIRED_SERVICES[shape].flatMap((s) => {
    const label = `com.foldedspacelabs.metistry.${s}`;
    return [`launchctl bootout gui/501/${label}`, `rm -f ${home}/Library/LaunchAgents/${label}.plist`];
  });

/**
 * The retire step as SUBPROCESSES a real run makes. A fake checkout has none
 * of these labels loaded and no plist for any of them in ~/Library/LaunchAgents,
 * so the one `launchctl list` answers for all of them and nothing is booted
 * out — which is exactly the state of a Mac that migrated to the supervisor
 * months ago.
 */
export const retiredCalls = (home: string, shape: "compose" | "launchd" = "compose", loaded: readonly string[] = []) => [
  "launchctl list",
  ...RETIRED_SERVICES[shape]
    .filter((s) => loaded.includes(s))
    .flatMap((s) => {
      const label = `com.foldedspacelabs.metistry.${s}`;
      return [`launchctl bootout gui/501/${label}`, `rm -f ${home}/Library/LaunchAgents/${label}.plist`];
    }),
];

/** `launchctl list` output: the header, then a line per loaded label. */
export const launchctlList = (services: readonly string[]) =>
  ["PID\tStatus\tLabel", ...services.map((s, i) => `${100 + i}\t0\tcom.foldedspacelabs.metistry.${s}`), ""].join("\n");

/** The supervisor's shape: the `Metistry` symlink, the watchdog's entry point, and the config `up` writes. */
export const supervisorJob = () =>
  plist(
    SUPERVISOR,
    `<string>__SUPERVISOR_BIN__</string><string>__REPO__/apps/watchdog/dist/main.js</string><string>--config</string><string>__SUPERVISOR_CONFIG__</string>`,
    `  <key>WorkingDirectory</key><string>__REPO__</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n__ENV__\n  </dict>\n  <key>StandardOutPath</key><string>/tmp/metistry-supervisor.log</string>\n`,
  );

export async function put(root: string, rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), text);
}

export async function checkout(opts: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-up-"));
  await put(root, "package.json", JSON.stringify({ name: "metistry" }));
  await put(root, "seed/identity.yaml", "name: Seed\n");
  await put(root, `ops/launchd/${SUPERVISOR}.plist`, supervisorJob());
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

/**
 * Every call succeeds with empty output unless a handler for that binary
 * says otherwise — except `launchctl print`, which defaults to exit 1
 * ("no such service"). `up` polls that between `bootout` and `bootstrap`
 * (bootout is asynchronous), and a fake that answered 0 would be claiming
 * the job is still loaded after we just booted it out.
 */
export function fakeExec(handlers: Record<string, Handler> = {}): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const exec = (async (cmd: string, args: string[], opts?: ExecOptions) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const r = await handlers[cmd]?.(args, opts);
    if (r === undefined && cmd === "launchctl" && args[0] === "print") return { code: 1, stdout: "", stderr: "Could not find service" };
    return { code: 0, stdout: "", stderr: "", ...(r ?? {}) };
  }) as Exec & { calls: Call[] };
  exec.calls = calls;
  return exec;
}

export const shown = (c: Call) => [c.cmd, ...c.args].join(" ");

export const okDoctor = async (d: DoctorDeps): Promise<DoctorReport> => ({ as_of: "now", product_dir: d.productDir, shape: "compose", ok: true, rows: [] });
export const failDoctor = async (d: DoctorDeps): Promise<DoctorReport> => ({ as_of: "now", product_dir: d.productDir, shape: "compose", ok: false, rows: [] });

/** A real XML Info.plist — the integration test hands the same bundle to the real plutil. */
export function infoPlist(version: string, id = APP_BUNDLE_ID): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Metistry</string>
	<key>CFBundleIdentifier</key>
	<string>${id}</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
</dict>
</plist>
`;
}

/** A fake Metistry.app: a real Info.plist and a shell-script executable — enough for plutil, ditto, codesign and hdiutil. */
export async function makeBundle(path: string, version: string, id = APP_BUNDLE_ID): Promise<string> {
  await mkdir(join(path, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(path, "Contents", "Info.plist"), infoPlist(version, id));
  await writeFile(join(path, "Contents", "MacOS", "Metistry"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return path;
}
