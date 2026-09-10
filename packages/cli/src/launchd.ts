// The host-side supervisor: ops/launchd/*.plist are templates with three
// placeholders — `__REPO__` (the product checkout), `__NODE__` (the node
// binary) and `__ENV_FILE__` (the install's `.env`, which lives in the
// INSTANCE directory: `<instance>/state/.env`, because an instance
// directory is self-contained) — that the by-hand install rendered with
// sed. `up` renders them
// the same way into ~/Library/LaunchAgents and (re)bootstraps each job;
// `update` restarts the ones whose code changed. On Linux there is no
// launchd: the equivalent systemd user units are printed, not written
// (docs/ops/cli.md — a documented follow-up, so nothing is installed
// behind the operator's back on a platform this has not been run on).

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { SHAPED_SERVICES, type DeploymentShape } from "@foldedspacelabs/metistry-core";

export const PLACEHOLDERS = ["__REPO__", "__NODE__", "__ENV_FILE__"] as const;

/** Every job's label is the reverse-DNS prefix plus the service name. */
export const LABEL_PREFIX = "com.foldedspacelabs.metistry.";

/**
 * `com.foldedspacelabs.metistry.console` → `console`, and
 * `com.foldedspacelabs.metistry.a1b2c3d4.console` → `console` too: a
 * NAMESPACED install (namespace.ts) puts the instance's suffix between the
 * prefix and the service, so a second instance's jobs cannot collide with
 * the first's. Service names carry no dots (`apple-fm`,
 * `eventkit-helper`), so the last component is always the service.
 */
export function serviceOf(label: string): string {
  const rest = label.startsWith(LABEL_PREFIX) ? label.slice(LABEL_PREFIX.length) : label;
  const dot = rest.indexOf(".");
  return dot === -1 ? rest : rest.slice(dot + 1);
}

/** The label a service's job carries, in this install's namespace. `undefined` suffix = today's fixed label. */
export function labelFor(service: string, suffix?: string | undefined): string {
  return `${LABEL_PREFIX}${suffix ? `${suffix}.` : ""}${service}`;
}

/** `/tmp/metistry-console.log`, or `/tmp/metistry-a1b2c3d4-console.log` when namespaced — two instances must not write one log. */
export function logPathFor(service: string, suffix?: string | undefined): string {
  return `/tmp/metistry-${suffix ? `${suffix}-` : ""}${service}.log`;
}

/**
 * Rewrite a template into an instance's namespace: the Label, the plist's
 * own file name, and the StandardOut/StandardError paths. Done to the
 * TEMPLATE TEXT rather than after rendering, so every later consumer
 * (`parsePlistTemplate`'s fields, the `__ENV__` dict, the by-hand `sed`
 * recipe in each plist's comment) sees one consistent job.
 */
export function withNamespace(t: PlistTemplate, suffix: string | undefined): PlistTemplate {
  if (!suffix) return t;
  const label = labelFor(t.service, suffix);
  const log = logPathFor(t.service, suffix);
  const template = t.template.split(t.label).join(label).split(logPathFor(t.service)).join(log);
  return {
    ...t,
    file: `${label}.plist`,
    label,
    template,
    ...(t.standardOutPath !== undefined ? { standardOutPath: log } : {}),
  };
}

export interface PlistTemplate {
  /** file name, e.g. com.foldedspacelabs.metistry.watchdog.plist */
  file: string;
  label: string;
  /** the service this job runs, from the label: `console`, `watchdog`, `eventkit-helper` */
  service: string;
  /** the raw template text (placeholders intact) */
  template: string;
  /** ProgramArguments as written in the template */
  programArguments: string[];
  workingDirectory?: string;
  /** StandardOutPath — every shipped plist points this and StandardErrorPath at the same file (`metistry logs`, docs/ops/cli.md) */
  standardOutPath?: string;
  environment: Record<string, string>;
  /** checkout-relative paths the job executes from (`__REPO__/<rel>` in ProgramArguments), e.g. apps/watchdog/dist/main.js */
  repoPaths: string[];
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function stringsIn(block: string): string[] {
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescape(m[1] ?? ""));
}

/** A deliberately small plist reader: the keys ops/launchd uses, nothing more (no dependency for a five-file directory). */
export function parsePlistTemplate(file: string, template: string): PlistTemplate {
  const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(template)?.[1] ?? basename(file, ".plist");
  const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(template)?.[1] ?? "";
  const programArguments = stringsIn(argsBlock);
  const workingDirectory = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(template)?.[1];
  const standardOutPath = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(template)?.[1];
  const environment: Record<string, string> = {};
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(template)?.[1] ?? "";
  for (const m of envBlock.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) environment[m[1]!] = unescape(m[2] ?? "");
  const repoPaths = [...new Set(programArguments.flatMap((a) => [...a.matchAll(/__REPO__\/([^\s;'"]+)/g)].map((m) => m[1]!)))].filter((p) => !p.startsWith(".env"));
  return {
    file,
    label,
    service: serviceOf(label),
    template,
    programArguments,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(standardOutPath !== undefined ? { standardOutPath } : {}),
    environment,
    repoPaths,
  };
}

/**
 * Every plist template a shape installs.
 *
 * `db`, `console` and `assistant` ship a plist each, but they are only host
 * jobs under the `launchd` shape — under `compose` they are containers and
 * their templates must not be rendered, bootstrapped or probed. The default
 * is `compose`, so a caller that does not know the shape gets exactly the
 * set that existed before deployment.yaml did.
 */
export async function loadPlistTemplates(productDir: string, shape: DeploymentShape = "compose", labelSuffix?: string | undefined): Promise<PlistTemplate[]> {
  const dir = join(productDir, "ops", "launchd");
  if (!existsSync(dir)) return [];
  const shaped = new Set<string>(SHAPED_SERVICES);
  const out: PlistTemplate[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".plist")).sort()) {
    const t = parsePlistTemplate(f, await readFile(join(dir, f), "utf8"));
    if (shape !== "launchd" && shaped.has(t.service)) continue;
    out.push(withNamespace(t, labelSuffix));
  }
  return out;
}

/** XML text content — env values are arbitrary strings (a password with an `&` in it must not corrupt the plist). */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The `<key>K</key><string>V</string>` lines that fill a plist's EnvironmentVariables dict, sorted so a rendered plist is stable. */
export function renderEnvDict(env: Record<string, string>, indent = "    "): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${indent}<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join("\n");
}

export interface PlistValues {
  repo: string;
  node: string;
  /** `__ENV_FILE__` — the dotenv file the `sh -c "set -a; . …"` jobs source */
  envFile: string;
  /** further `__NAME__` placeholders — the sandbox parameters, the Postgres paths */
  extra?: Record<string, string> | undefined;
  /** replaces `__ENV__` with an EnvironmentVariables dict body; the shape services carry their whole environment this way */
  env?: Record<string, string> | undefined;
}

/**
 * `sed "s|__REPO__|$PWD|g; s|__NODE__|$(which node)|g"` plus the same
 * treatment for every extra placeholder, and `__ENV__` replaced by a
 * rendered dict body. Throws if a placeholder would be left behind — a
 * plist with `__PG_DATA__` still in it is a job that fails at 2am, not a
 * cosmetic problem.
 *
 * A single quote in a substituted value is refused for the same class of
 * reason. Four plists build a `/bin/sh -c` string, and the placeholders
 * inside it are wrapped in single quotes so a path with a SPACE works —
 * `~/Library/Application Support/Metistry/…` is the Mac app's default
 * product and instance location, and unquoted it produced
 * `/bin/sh: /Users/…/Library/Application: No such file or directory`
 * (found by the 2026-09-10 launchd trial). A value carrying a quote of its
 * own would escape that wrapping, so it is rejected rather than escaped:
 * nobody needs an apostrophe in an install path, and a refusal is a
 * message where a mis-escape is a shell injection.
 */
export function renderPlist(template: string, values: PlistValues): string {
  const subs: Record<string, string> = { __REPO__: values.repo, __NODE__: values.node, __ENV_FILE__: values.envFile };
  for (const [k, v] of Object.entries(values.extra ?? {})) subs[`__${k}__`] = v;
  for (const [k, v] of Object.entries(subs)) {
    if (v.includes("__")) throw new Error(`refusing to render a plist with "${v}" for ${k}: it contains "__"`);
    if (v.includes("'")) throw new Error(`refusing to render a plist with "${v}" for ${k}: a single quote would escape the shell quoting in the sh -c jobs — move the install somewhere without one`);
    if (v.trim() === "") throw new Error(`refusing to render a plist with an empty ${k}`);
  }
  let rendered = template;
  for (const [k, v] of Object.entries(subs)) rendered = rendered.split(k).join(v);
  if (values.env) rendered = rendered.replace(/^[ \t]*__ENV__[ \t]*$/m, renderEnvDict(values.env));
  const left = /__[A-Z][A-Z0-9_]*__/.exec(rendered);
  if (left) throw new Error(`unrendered placeholder ${left[0]} in plist template`);
  return rendered;
}

/**
 * `$(which node)` — the FIRST `node` on PATH, symlink unresolved, exactly as
 * the by-hand recipe did. Not process.execPath: that is the realpath
 * (`…/Cellar/node@22/22.23.1/bin/node`), which stops existing at the next
 * brew upgrade and takes every host job down with it (the Phase 0
 * versioned-path lesson). Falls back to execPath when PATH has no node.
 */
export function nodeOnPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }
  return execPath;
}

/**
 * Host jobs that spawn `git`. A launchd job's PATH is `/usr/bin:/bin:…` and
 * nothing else — no login shell, no Homebrew — and a clean Mac has no git at
 * all until Xcode Command Line Tools are installed. So when this install
 * carries a bundled `runtime/git/bin`, it goes on the FRONT of these jobs'
 * PATH (docs/ops/bundled-runtime.md). The reconciler is the only place git
 * runs (D5).
 */
export const GIT_SPAWNING_SERVICES = new Set(["reconciler"]);

/**
 * Merge entries into a rendered plist's `EnvironmentVariables` dict, adding
 * the dict when the template has none. Applied AFTER `renderPlist`, so the
 * template keeps its two documented placeholders and the by-hand `sed` recipe
 * in each plist's comment still produces a working job.
 */
export function withEnvironmentVariables(plist: string, extra: Record<string, string>): string {
  const entries = Object.entries(extra);
  if (entries.length === 0) return plist;
  const body = renderEnvDict(Object.fromEntries(entries), "    ");
  const existing = /(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/.exec(plist);
  if (existing) {
    // keys the template already sets win: the caller is adding, not overriding
    const already = new Set([...existing[2]!.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]!));
    const add = entries.filter(([k]) => !already.has(k));
    if (add.length === 0) return plist;
    return plist.replace(existing[0], `${existing[1]}${existing[2]}${renderEnvDict(Object.fromEntries(add), "    ")}\n  ${existing[3]}`);
  }
  const at = plist.lastIndexOf("</dict>");
  if (at === -1) return plist;
  return `${plist.slice(0, at)}  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>\n${plist.slice(at)}`;
}

/** Where the rendered plists go — the per-user agents directory launchd watches. */
export function launchAgentsDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

/**
 * The launchd steps for one job, in order: bootout (tolerated when not
 * loaded), WAIT for it to actually be gone, bootstrap the freshly written
 * plist, kickstart -k so a job that was already running restarts on the new
 * code. Argument arrays only.
 *
 * The wait is not belt-and-braces. `launchctl bootout` returns before
 * launchd has finished tearing the job down, so an immediate `bootstrap`
 * of the same label races it and fails with `Bootstrap failed: 5:
 * Input/output error` — which aborts `up` partway, leaving the jobs after
 * it in the alphabet uninstalled. Found by the 2026-09-10 launchd trial,
 * where a second `metistry up` on a running install failed roughly every
 * time.
 */
export function launchdCommands(label: string, plistPath: string, uid: number): { cmd: string; args: string[]; tolerateFailure?: boolean; awaitGone?: boolean }[] {
  return [
    { cmd: "launchctl", args: ["bootout", `gui/${uid}/${label}`], tolerateFailure: true },
    { cmd: "launchctl", args: ["print", `gui/${uid}/${label}`], awaitGone: true },
    { cmd: "launchctl", args: ["bootstrap", `gui/${uid}`, plistPath] },
    { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${label}`] },
  ];
}

/**
 * The systemd user unit that says the same thing as a plist (Linux follow-up;
 * printed by `up`, never written). `set -a; . '.env'; set +a; exec node …` in
 * the plist becomes EnvironmentFile= + ExecStart= so no shell is involved.
 *
 * The plist's shell string single-quotes its paths (a space in
 * `~/Library/Application Support/…` otherwise splits the command). ExecStart
 * keeps that quoting — systemd parses quoted arguments the same way — but
 * `EnvironmentFile=` does not: systemd takes the rest of that line
 * literally, quotes included, so the path goes in bare.
 */
export function renderSystemdUnit(t: PlistTemplate, values: { repo: string; node: string; envFile: string }): string {
  const sub = (s: string) => s.replace(/__REPO__/g, values.repo).replace(/__NODE__/g, values.node).replace(/__ENV_FILE__/g, values.envFile);
  const shell = t.programArguments[0] === "/bin/sh" && t.programArguments[1] === "-c" ? t.programArguments[2] : undefined;
  const execLine = shell ? (/exec\s+(.+)$/.exec(shell)?.[1] ?? shell) : t.programArguments.join(" ");
  const envFile = shell && /\.\s+'?__ENV_FILE__/.test(shell) ? `EnvironmentFile=${values.envFile}\n` : "";
  const envLines = Object.entries(t.environment)
    .map(([k, v]) => `Environment=${k}=${sub(v)}\n`)
    .join("");
  const unitName = `${t.label}.service`;
  return [
    `# ~/.config/systemd/user/${unitName}  —  from ops/launchd/${t.file}`,
    "[Unit]",
    `Description=Metistry ${t.label.replace(/^com\.foldedspacelabs\.metistry\./, "")}`,
    "After=network.target",
    "",
    "[Service]",
    `${envFile}${envLines}${t.workingDirectory ? `WorkingDirectory=${sub(t.workingDirectory)}\n` : ""}ExecStart=${sub(execLine)}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
