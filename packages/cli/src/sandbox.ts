// Engine confinement on the host — the cost open decision 15 named.
//
// Under the compose shape the assistant's isolation is the container. Under
// the launchd shape the process runs on the host, so `ops/sandbox/
// assistant.sb` takes that role: deny by default, read its own dist and
// runtime, write only its state dir and tmp, outbound only to the console
// on loopback and TLS. This file computes the profile's parameters — one
// place, so the misuse tests confine a probe with the SAME values the plist
// runs the engine with.
//
// sandbox-exec(1) is deprecated and functional (verified on macOS 26.4).
// The migration path is App Sandbox entitlements once the Mac app hosts the
// process (docs/product/desktop-app-plan.md): same deny-default posture, a
// supported API, and outbound filtering by host name rather than by port.

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SANDBOX_PROFILE_REL = "ops/sandbox/assistant.sb";

/**
 * The Anthropic hosts the Agent SDK talks to. sandbox-exec filters outbound
 * by port, not by name, so this list is documentation and configuration
 * (METISTRY_ASSISTANT_ALLOWED_HOSTS) rather than an enforced rule — the
 * profile allows TLS and nothing else. Name-level enforcement arrives with
 * App Sandbox; docs/ops/deployment-shapes.md says so plainly rather than
 * letting the profile imply a guarantee it does not make.
 */
export const ANTHROPIC_HOSTS = ["api.anthropic.com", "statsig.anthropic.com", "console.anthropic.com"] as const;

/**
 * The runtime tree the profile grants read + exec on.
 *
 * A Homebrew node is a symlink into `Cellar/` and links against dylibs in
 * sibling formulae (`/opt/homebrew/opt/libuv/…`), so the self-contained
 * root is the brew prefix — anything narrower and the engine will not
 * start. A bundled runtime (`…/Resources/metistry/runtime/node/bin/node`)
 * IS self-contained, so its own prefix is enough. Both cases are read-only.
 */
export function nodePrefixFor(nodeBin: string, realpath: (p: string) => string = realpathSync): string {
  let real = nodeBin;
  try {
    real = realpath(nodeBin);
  } catch {
    // a path that does not resolve is the caller's problem to report
  }
  const cellar = real.indexOf("/Cellar/");
  if (cellar !== -1) return real.slice(0, cellar);
  return dirname(dirname(real));
}

/**
 * Sandbox subpaths must be REAL paths.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp` and `/var/folders/…` to
 * `/private/var/folders/…`; the kernel evaluates the profile against the
 * resolved path, so a `(subpath "/var/folders/x")` rule matches nothing and
 * the process cannot even read its own entry point. A path that does not
 * exist yet (the state dir, before `up` creates it) is resolved as far as
 * its nearest existing ancestor and rejoined.
 */
export function realPathish(p: string, realpath: (x: string) => string = realpathSync): string {
  const parts: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return parts.length === 0 ? realpath(cur) : join(realpath(cur), ...parts);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      parts.unshift(cur.slice(parent.length).replace(/^\//, ""));
      cur = parent;
    }
  }
}

export interface SandboxInputs {
  productDir: string;
  nodeBin: string;
  stateDir: string;
  consolePort: number;
  tmpDir: string;
  realpath?: ((p: string) => string) | undefined;
}

/** Exactly the `-D` parameters ops/sandbox/assistant.sb declares — the plist placeholders are named for them. */
export interface SandboxParams {
  NODE_BIN: string;
  NODE_PREFIX: string;
  PRODUCT_DIR: string;
  STATE_DIR: string;
  TMP_DIR: string;
  CONSOLE_TCP: string;
}

export function sandboxParams(inputs: SandboxInputs): SandboxParams {
  const real = (p: string) => realPathish(p, inputs.realpath);
  return {
    NODE_BIN: inputs.nodeBin,
    NODE_PREFIX: nodePrefixFor(inputs.nodeBin, inputs.realpath),
    PRODUCT_DIR: real(inputs.productDir),
    STATE_DIR: real(inputs.stateDir),
    TMP_DIR: real(inputs.tmpDir.replace(/\/$/, "")),
    CONSOLE_TCP: `localhost:${inputs.consolePort}`,
  };
}

/** `sandbox-exec -f <profile> -D K=V … -- <command>`, as an argument array (never a shell string). */
export function sandboxArgv(profilePath: string, params: Record<string, string>, command: string[]): string[] {
  return [SANDBOX_EXEC, "-f", profilePath, ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]), ...command];
}

export function sandboxProfilePath(productDir: string): string {
  return join(productDir, SANDBOX_PROFILE_REL);
}

/** The assistant's state directory: outside the vault, gitignored, and the only path the profile lets it write. */
export function assistantStateDir(opts: { instanceDir?: string | undefined; productDir: string }): string {
  return join(opts.instanceDir ?? opts.productDir, "state", "assistant");
}

/** The per-user temporary directory, without a trailing slash (macOS `TMPDIR` has one). */
export function tmpDirOf(env: NodeJS.ProcessEnv): string {
  return (env.TMPDIR || "/tmp").replace(/\/+$/, "");
}
