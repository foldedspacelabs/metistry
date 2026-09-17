// The CLI's half of the supervisor: what `up` writes, and how every other
// verb talks to it.
//
// Under the launchd shape the core is ONE launchd agent
// (`com.foldedspacelabs.metistry`, program name `Metistry`, so System
// Settings shows one background item called Metistry) with Postgres, the
// console, the reconciler, the assistant and any enabled bridges as its
// children. Their argv still comes from `ops/launchd/*.plist` — those
// templates stay the record of how each service is started, and `up` renders
// them exactly as before; it just turns the rendered plist into a child spec
// instead of installing eight agents.
//
// Turning a rendered plist into a child is deliberate rather than a second
// table: everything the trial and the migration rehearsal fixed in
// `renderPlist` (the quoting, the refusal to leave a placeholder behind) is
// still in the path, and `metistry logs <service>` keeps tailing the same
// file the plist named.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  SUPERVISOR_CONFIG_FILENAME,
  SUPERVISOR_LABEL,
  SUPERVISOR_SERVICE,
  SUPERVISOR_SOCKET_FILENAME,
  parseSupervisorConfig,
  type ChildSpecInput,
  type ControlOp,
  type ControlResponse,
  type SupervisorConfig,
  type SupervisorConfigInput,
  statePath,
} from "@foldedspacelabs/metistry-core";
import { parsePlistTemplate, type PlistTemplate } from "./launchd.js";

export { SUPERVISOR_LABEL, SUPERVISOR_SERVICE };

/** `<instance>/.metistry/state/supervisor.json` — 0600, because it carries what the plists' env dicts used to. */
export function supervisorConfigPath(stateRoot: string): string {
  return statePath(stateRoot, SUPERVISOR_CONFIG_FILENAME);
}

/**
 * `<instance>/.metistry/state/run/supervisor.sock`. Beside Postgres' socket on purpose:
 * that directory is already the one `up` length-checks, and a unix socket
 * path over 103 bytes is silently unusable in exactly the same way.
 */
export function supervisorSocketPath(stateRoot: string): string {
  return statePath(stateRoot, "run", SUPERVISOR_SOCKET_FILENAME);
}

/**
 * The executable the supervisor's plist names — a symlink to this install's
 * node, called `Metistry`.
 *
 * This is the whole point of the exercise. launchd's background-item entry
 * (System Settings › General › Login Items, `sfltool dumpbtm`) is named
 * after the agent's program, so an agent whose program is `…/bin/node`
 * appears to the user as "node". A symlink costs nothing, changes no
 * behaviour — node resolves its own installation through the real path —
 * and makes the one item read `Metistry`.
 */
export function supervisorBinPath(stateRoot: string): string {
  return statePath(stateRoot, "bin", "Metistry");
}

/**
 * `~/Library/Application Support/Metistry/supervisor.env` — the three paths
 * the app-bundled launcher needs, and the ONLY install-specific thing the
 * app path can carry: the plist inside a signed bundle is immutable, and
 * `BundleProgram` is its only bundle-relative key.
 */
export function supervisorLauncherEnvPath(home: string): string {
  return join(home, "Library", "Application Support", "Metistry", "supervisor.env");
}

/**
 * Its contents. Shell-quoted because the launcher SOURCES it, and
 * `~/Library/Application Support/…` has a space in it — the same defect the
 * 2026-09-10 trial found in four plists, refused here rather than repeated
 * (a value containing a single quote is rejected: nobody needs an apostrophe
 * in an install path, and a refusal beats a mis-escape).
 */
export function serializeLauncherEnv(values: { bin: string; main: string; config: string }): string {
  const line = (k: string, v: string) => {
    if (v.includes("'")) throw new Error(`refusing to write ${k}='${v}' into supervisor.env: a single quote would escape the shell quoting — move the install somewhere without one`);
    return `${k}='${v}'`;
  };
  return [
    "# metistry up --register-via app wrote this. It is SOURCED by",
    "# Metistry.app/Contents/Resources/MetistrySupervisor — paths only, no secrets.",
    line("METISTRY_SUPERVISOR_BIN", values.bin),
    line("METISTRY_SUPERVISOR_MAIN", values.main),
    line("METISTRY_SUPERVISOR_CONFIG", values.config),
    "",
  ].join("\n");
}

/** 256 bits, hex: the control socket's shared secret. Minted once per `up`, and the file that holds it is 0600. */
export function mintControlToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * What launchd hands a job that sets no EnvironmentVariables of its own:
 * a minimal PATH, HOME, and the per-user temp dir. A child's environment is
 * REPLACED rather than inherited (the supervisor's own environment carries
 * the install's secrets, and `assistantEnv` is an allowlist that must stay
 * one), so the base the plists used to get implicitly is supplied here
 * explicitly.
 */
export function launchdBaseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["HOME", "TMPDIR", "USER", "LOGNAME", "LANG"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * One rendered plist → one child spec. `rendered` is the plist `up` would
 * have written, with any extra environment already merged in, so the child
 * runs the same argv, in the same directory, with the same environment, and
 * appends to the same log file the job did.
 */
export function childFromRenderedPlist(t: PlistTemplate, rendered: string, base: Record<string, string>, ready?: ChildSpecInput["ready"]): ChildSpecInput {
  const parsed = parsePlistTemplate(t.file, rendered);
  const log = parsed.standardOutPath ?? t.standardOutPath;
  if (!log) throw new Error(`${t.file} has no StandardOutPath — the supervisor would have nowhere to put ${t.service}'s output`);
  return {
    name: t.service,
    argv: parsed.programArguments,
    ...(parsed.workingDirectory ? { cwd: parsed.workingDirectory } : {}),
    env: { ...base, ...parsed.environment },
    log,
    ...(ready ? { ready } : {}),
  };
}

export interface SupervisorConfigInputs {
  label: string;
  socket: string;
  token: string;
  /** the supervisor's own environment (the watchdog half needs the db credentials) */
  env: Record<string, string>;
  children: ChildSpecInput[];
}

export function supervisorConfig(inputs: SupervisorConfigInputs): SupervisorConfigInput {
  return { schema: 1, label: inputs.label, socket: inputs.socket, token: inputs.token, env: inputs.env, children: inputs.children };
}

/** Pretty JSON: this file is read by a person as often as by the supervisor. */
export function serializeSupervisorConfig(config: SupervisorConfigInput): string {
  return JSON.stringify(config, null, 2) + "\n";
}

export async function readSupervisorConfig(path: string): Promise<SupervisorConfig | undefined> {
  if (!existsSync(path)) return undefined;
  return parseSupervisorConfig(JSON.parse(await readFile(path, "utf8")), path);
}

/** Used by nothing but the tests and `up`'s non-StepRunner paths; the real write goes through StepRunner so a dry run prints it. */
export async function writeSupervisorConfig(path: string, config: SupervisorConfigInput): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeSupervisorConfig(config), "utf8");
  await chmod(path, 0o600);
}

// ---- talking to it ----------------------------------------------------------

export class SupervisorUnreachable extends Error {
  constructor(
    public readonly socket: string,
    cause: string,
  ) {
    super(`no supervisor answering on ${socket} (${cause}) — is it running? \`launchctl print gui/$(id -u)/${SUPERVISOR_LABEL}\``);
  }
}

/** One request, one response, one line each. Times out rather than hanging a CLI verb forever. */
export function controlRequest(
  socket: string,
  req: { op: ControlOp; token: string; service?: string | undefined },
  timeoutMs = 30_000,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let buf = "";
    const fail = (why: string) => {
      s.removeAllListeners();
      s.destroy();
      reject(new SupervisorUnreachable(socket, why));
    };
    s.setTimeout(timeoutMs);
    s.once("error", (err: Error) => fail(err.message));
    s.once("timeout", () => fail(`no answer in ${timeoutMs}ms`));
    s.once("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      s.removeAllListeners();
      s.destroy();
      try {
        resolve(JSON.parse(line) as ControlResponse);
      } catch (err) {
        reject(new Error(`the supervisor answered something that is not JSON: ${line.slice(0, 200)} (${err instanceof Error ? err.message : String(err)})`));
      }
    });
  });
}
