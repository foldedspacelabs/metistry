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

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { instanceStatePath, overlayFiles, SEED_DIR } from "@foldedspacelabs/metistry-core";
import type { Compute, InstancePathKey } from "@foldedspacelabs/metistry-core";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SANDBOX_PROFILE_REL = "ops/sandbox/assistant.sb";

/**
 * The hosts the engine is expected to reach, DERIVED from this install's
 * `compute.yaml` rather than hardcoded to one vendor (C2): every provider's
 * `base_url` and nothing else — which is also exactly the set the engine's
 * own `fetch` can dial, because `completionsUrl` is built from the assigned
 * provider's base URL and there is no other outbound call in the loop
 * (apps/assistant/src/engine-openai.ts).
 *
 * sandbox-exec filters outbound by PORT, not by name, so this list is
 * documentation, not an enforced rule — the profile allows TLS and nothing
 * else, and the variable name METISTRY_ASSISTANT_ALLOWED_HOSTS is reserved
 * for when a layer exists that can enforce it. Name-level enforcement
 * arrives with App Sandbox; docs/ops/deployment-shapes.md says so plainly
 * rather than letting the profile imply a guarantee it does not make.
 */
export function engineHosts(compute: Compute): string[] {
  const out = new Set<string>();
  for (const p of Object.values(compute.providers)) {
    try {
      out.add(new URL(p.base_url).hostname);
    } catch {
      // a base_url that does not parse failed the schema already
    }
  }
  return [...out].sort();
}

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

/**
 * The instance files the engine reads, and the ONLY ones the profile lets
 * it open outside its own dist and state: its identity, its system-prompt
 * template, the router's tier map and `compute.yaml`.
 *
 * Grants are per FILE, not a directory. `<instance>/.metistry/` would be a
 * one-line rule and would also hand the engine `instances.yaml`,
 * `metistry.lock` and the whole Postgres cluster under `state/`; and on a
 * legacy instance the machinery IS the vault root, so a directory grant
 * there would hand it every note in the vault — which is precisely what D5
 * says it may never read from disk. Four literals say the same thing in
 * both layouts and say nothing more.
 */
export const ENGINE_CONFIG_KEYS = ["identity", "assistantPrompt", "rules", "compute"] as const satisfies readonly InstancePathKey[];

/** `identity` → `CONFIG_IDENTITY`: the `-D` parameter ops/sandbox/assistant.sb reads it as. */
export function configParamName(key: (typeof ENGINE_CONFIG_KEYS)[number]): string {
  return `CONFIG_${key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

/**
 * The four `-D CONFIG_*` values for one install: this instance's copy of
 * each file as THIS instance spells it (flat or legacy), falling back to the
 * product's seed when there is no instance directory — a grant on a file the
 * profile already allows, rather than an empty parameter `renderPlist` would
 * refuse.
 *
 * The path is granted whether or not the file exists yet: a rule for a
 * missing path matches nothing, and an instance that writes its
 * `assistant-prompt.md` later must not need a re-`up` to be read.
 */
export function engineConfigParams(opts: {
  instanceDir?: string | undefined;
  productDir: string;
  realpath?: ((p: string) => string) | undefined;
  /** test seam: which of the two layouts the instance directory is in (`detectLayout`'s two existence probes) */
  exists?: ((p: string) => boolean) | undefined;
}): Record<string, string> {
  const out: Record<string, string> = {};
  // the same list the engine itself resolves (core's `overlayFiles`): its
  // LAST candidate is the file that wins, which is the one the profile has
  // to allow. No instance directory → that is the seed, already readable
  // under PRODUCT_DIR, so the grant is a no-op rather than an empty
  // parameter `renderPlist` would refuse to render.
  for (const key of ENGINE_CONFIG_KEYS) {
    const candidates = overlayFiles(key, opts.instanceDir, { seedDir: join(opts.productDir, SEED_DIR), ...(opts.exists ? { exists: opts.exists } : {}) }).split(":");
    out[configParamName(key)] = realPathish(candidates[candidates.length - 1]!, opts.realpath);
  }
  return out;
}

export interface SandboxInputs {
  productDir: string;
  nodeBin: string;
  stateDir: string;
  /** the instance directory, so the four config files it holds can be granted by name */
  instanceDir?: string | undefined;
  consolePort: number;
  /**
   * The Postgres port. Under `compose` the engine reached the db through the
   * container network; under `launchd` it is a loopback port like any other,
   * and the profile denies by default — so without this the engine dies at
   * startup with `EPERM connect 127.0.0.1:<port>` (2026-09-10 trial).
   */
  dbPort: number;
  /**
   * The supervisor's egress proxy. The profile's third outbound rule used to
   * be `*:443` with a note saying the host list was documentation; it is now
   * this one loopback port, and the proxy behind it is where the host names
   * are actually enforced (packages/core/src/egress.ts).
   */
  proxyPort: number;
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
  DB_TCP: string;
  PROXY_TCP: string;
  CONFIG_IDENTITY: string;
  CONFIG_ASSISTANT_PROMPT: string;
  CONFIG_RULES: string;
  CONFIG_COMPUTE: string;
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
    DB_TCP: `localhost:${inputs.dbPort}`,
    PROXY_TCP: `localhost:${inputs.proxyPort}`,
    ...(engineConfigParams({ ...(inputs.instanceDir ? { instanceDir: inputs.instanceDir } : {}), productDir: inputs.productDir, ...(inputs.realpath ? { realpath: inputs.realpath } : {}) }) as {
      CONFIG_IDENTITY: string;
      CONFIG_ASSISTANT_PROMPT: string;
      CONFIG_RULES: string;
      CONFIG_COMPUTE: string;
    }),
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
  return instanceStatePath(opts.instanceDir ?? opts.productDir, "assistant");
}

/** The per-user temporary directory, without a trailing slash (macOS `TMPDIR` has one). */
export function tmpDirOf(env: NodeJS.ProcessEnv): string {
  return (env.TMPDIR || "/tmp").replace(/\/+$/, "");
}

// ---- the reconciler -----------------------------------------------------------
//
// The second child to get a profile, and the one the research
// (docs/research/2026-09-19-agent-virtual-filesystems.md §3.2(c)) argued
// matters most: the sole committer (D5) holds the vault's working tree, runs
// git, and had ambient authority over the whole disk. Everything below is
// the same machinery as the engine's — `realPathish`, `nodePrefixFor`, an
// argv array, never a shell string — pointed at a different shape.

export const RECONCILER_SANDBOX_PROFILE_REL = "ops/sandbox/reconciler.sb";
/** The visible off switch (ops/sandbox/unconfined.sb) — `METISTRY_RECONCILER_SANDBOX=0`. */
export const UNCONFINED_PROFILE_REL = "ops/sandbox/unconfined.sb";

/** `0` (or `false`/`off`/`no`) runs the reconciler under `unconfined.sb`; anything else, including unset, confines it. */
export function reconcilerConfined(env: NodeJS.ProcessEnv): boolean {
  const v = (env.METISTRY_RECONCILER_SANDBOX ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function reconcilerSandboxProfilePath(productDir: string, confined = true): string {
  return join(productDir, confined ? RECONCILER_SANDBOX_PROFILE_REL : UNCONFINED_PROFILE_REL);
}

/**
 * `/usr/bin/git` is NOT a git.
 *
 * Measured on macOS 26.4, 2026-09-19: `otool -L /usr/bin/git` shows
 * `/usr/lib/libxcselect.dylib` — it is the xcode-select shim, and it execs
 * the real git out of the active developer directory. Under a profile that
 * grants exactly that literal it dies with
 * `xcrun: error: unable to load libxcrun (… file system sandbox blocked
 * open())`. The research doc guessed the opposite ("a real universal Mach-O
 * … one literal may be the whole answer"); it is a Mach-O, and it is still a
 * shim. Every path under `/usr/bin` gets the same treatment, because that is
 * where Apple puts shims.
 */
export function isXcodeGitShim(gitBin: string): boolean {
  return gitBin === "/usr/bin/git" || gitBin.startsWith("/usr/bin/");
}

/** The Command Line Tools' git — a REAL git (`share/git-core` templates and all), present on any Mac with the CLT installed. */
export const CLT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git";

/**
 * The git the confined reconciler will run, resolved by absolute path: the
 * bundled runtime's first (that is what the deps pack ships it for), then
 * PATH minus the shim, then the Command Line Tools.
 *
 * `undefined` means this Mac has no git the profile can name — on which
 * `up` declines to confine the job and says why, rather than installing a
 * reconciler that cannot commit.
 */
export function resolveGitBin(opts: { productDir: string; path?: string | undefined; exists?: ((p: string) => boolean) | undefined }): string | undefined {
  const exists = opts.exists ?? existsSync;
  const bundled = join(opts.productDir, "runtime", "git", "bin", "git");
  if (exists(bundled)) return bundled;
  for (const dir of (opts.path ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, "git");
    if (!isXcodeGitShim(candidate) && exists(candidate)) return candidate;
  }
  return exists(CLT_GIT) ? CLT_GIT : undefined;
}

/**
 * The installation prefix the profile grants read + exec on: `bin/git`,
 * `libexec/git-core/` (172 helper binaries, `git-remote-https` among them)
 * and `share/git-core/templates`. Two levels up from the binary — except a
 * Homebrew git, which links against sibling formulae, so the self-contained
 * root is the brew prefix. The same rule `nodePrefixFor` applies, for the
 * same reason.
 */
export function gitPrefixFor(gitBin: string, realpath: (p: string) => string = realpathSync): string {
  return nodePrefixFor(gitBin, realpath);
}

export interface ReconcilerSandboxInputs {
  productDir: string;
  nodeBin: string;
  /** the instance repo: the vault, `.metistry/` and `.git/` — the one writable tree */
  instanceDir: string;
  /** an absolute path to a REAL git (`resolveGitBin`) */
  gitBin: string;
  /** `$HOME/.gitconfig`; granted by name because git treats an unreadable one as FATAL, not absent */
  gitConfigGlobal: string;
  /** the askpass shim `up` generates (askpass.ts) — granted read + exec by literal, because git execs askpass directly and no credential helper can run without a shell */
  askpassBin: string;
  reconcilerPort: number;
  consolePort: number;
  dbPort: number;
  /** the on-machine embedding server's loopback port */
  embedPort: number;
  /** the supervisor's egress proxy — the only route off this machine */
  proxyPort: number;
  tmpDir: string;
  realpath?: ((p: string) => string) | undefined;
}

/** Exactly the `-D` parameters ops/sandbox/reconciler.sb declares. */
export interface ReconcilerSandboxParams {
  NODE_BIN: string;
  NODE_PREFIX: string;
  PRODUCT_DIR: string;
  INSTANCE_DIR: string;
  TMP_DIR: string;
  GIT_PREFIX: string;
  GIT_CONFIG_GLOBAL: string;
  ASKPASS_BIN: string;
  RECONCILER_TCP: string;
  CONSOLE_TCP: string;
  DB_TCP: string;
  EMBED_TCP: string;
  PROXY_TCP: string;
}

export function reconcilerSandboxParams(inputs: ReconcilerSandboxInputs): ReconcilerSandboxParams {
  const real = (p: string) => realPathish(p, inputs.realpath);
  return {
    NODE_BIN: inputs.nodeBin,
    NODE_PREFIX: nodePrefixFor(inputs.nodeBin, inputs.realpath),
    PRODUCT_DIR: real(inputs.productDir),
    INSTANCE_DIR: real(inputs.instanceDir),
    TMP_DIR: real(inputs.tmpDir.replace(/\/$/, "")),
    GIT_PREFIX: gitPrefixFor(inputs.gitBin, inputs.realpath),
    // granted whether or not it exists yet: a rule for a missing path matches
    // nothing, and an owner who writes their first ~/.gitconfig next week
    // must not need a re-`up` for the job to keep running
    GIT_CONFIG_GLOBAL: real(inputs.gitConfigGlobal),
    // granted whether or not it exists yet, like the config files: `up`
    // writes it in the same run that renders this, and a rule for a missing
    // path matches nothing
    ASKPASS_BIN: real(inputs.askpassBin),
    RECONCILER_TCP: `localhost:${inputs.reconcilerPort}`,
    CONSOLE_TCP: `localhost:${inputs.consolePort}`,
    DB_TCP: `localhost:${inputs.dbPort}`,
    EMBED_TCP: `localhost:${inputs.embedPort}`,
    PROXY_TCP: `localhost:${inputs.proxyPort}`,
  };
}

/** `$HOME/.gitconfig` — the file the profile grants by name. */
export function globalGitConfigPath(home: string): string {
  return join(home, ".gitconfig");
}
