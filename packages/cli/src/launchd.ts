// The host-side supervisor: ops/launchd/*.plist are templates with two
// placeholders — `__REPO__` (the product checkout) and `__NODE__` (the node
// binary) — that the by-hand install rendered with sed. `up` renders them
// the same way into ~/Library/LaunchAgents and (re)bootstraps each job;
// `update` restarts the ones whose code changed. On Linux there is no
// launchd: the equivalent systemd user units are printed, not written
// (docs/ops/cli.md — a documented follow-up, so nothing is installed
// behind the operator's back on a platform this has not been run on).

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export const PLACEHOLDERS = ["__REPO__", "__NODE__"] as const;

export interface PlistTemplate {
  /** file name, e.g. com.foldedspacelabs.metistry.watchdog.plist */
  file: string;
  label: string;
  /** the raw template text (placeholders intact) */
  template: string;
  /** ProgramArguments as written in the template */
  programArguments: string[];
  workingDirectory?: string;
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
  const environment: Record<string, string> = {};
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(template)?.[1] ?? "";
  for (const m of envBlock.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) environment[m[1]!] = unescape(m[2] ?? "");
  const repoPaths = [...new Set(programArguments.flatMap((a) => [...a.matchAll(/__REPO__\/([^\s;'"]+)/g)].map((m) => m[1]!)))].filter((p) => !p.startsWith(".env"));
  return { file, label, template, programArguments, ...(workingDirectory !== undefined ? { workingDirectory } : {}), environment, repoPaths };
}

export async function loadPlistTemplates(productDir: string): Promise<PlistTemplate[]> {
  const dir = join(productDir, "ops", "launchd");
  if (!existsSync(dir)) return [];
  const out: PlistTemplate[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".plist")).sort()) out.push(parsePlistTemplate(f, await readFile(join(dir, f), "utf8")));
  return out;
}

/** `sed "s|__REPO__|$PWD|g; s|__NODE__|$(which node)|g"`, exactly. Throws if a placeholder would be left behind. */
export function renderPlist(template: string, values: { repo: string; node: string }): string {
  for (const [k, v] of Object.entries(values)) {
    if (v.includes("__")) throw new Error(`refusing to render a plist with "${v}" for ${k}: it contains "__"`);
    if (v.trim() === "") throw new Error(`refusing to render a plist with an empty ${k}`);
  }
  const rendered = template.replace(/__REPO__/g, values.repo).replace(/__NODE__/g, values.node);
  const left = /__[A-Z]+__/.exec(rendered);
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

/** Where the rendered plists go — the per-user agents directory launchd watches. */
export function launchAgentsDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

/**
 * The launchd steps for one job, in order: bootout (tolerated when not
 * loaded), bootstrap the freshly written plist, kickstart -k so a job that
 * was already running restarts on the new code. Argument arrays only.
 */
export function launchdCommands(label: string, plistPath: string, uid: number): { cmd: string; args: string[]; tolerateFailure?: boolean }[] {
  return [
    { cmd: "launchctl", args: ["bootout", `gui/${uid}/${label}`], tolerateFailure: true },
    { cmd: "launchctl", args: ["bootstrap", `gui/${uid}`, plistPath] },
    { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${label}`] },
  ];
}

/**
 * The systemd user unit that says the same thing as a plist (Linux follow-up;
 * printed by `up`, never written). `set -a; . .env; set +a; exec node …` in
 * the plist becomes EnvironmentFile= + ExecStart= so no shell is involved.
 */
export function renderSystemdUnit(t: PlistTemplate, values: { repo: string; node: string }): string {
  const sub = (s: string) => s.replace(/__REPO__/g, values.repo).replace(/__NODE__/g, values.node);
  const shell = t.programArguments[0] === "/bin/sh" && t.programArguments[1] === "-c" ? t.programArguments[2] : undefined;
  const execLine = shell ? (/exec\s+(.+)$/.exec(shell)?.[1] ?? shell) : t.programArguments.join(" ");
  const envFile = shell && /\.\s+__REPO__\/\.env/.test(shell) ? `EnvironmentFile=${values.repo}/.env\n` : "";
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
