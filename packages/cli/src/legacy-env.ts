// Retiring the product checkout's `.env` — the file every command warns is
// "still being read as a fallback and is deprecated". An instance's
// environment lives at `<instance>/.metistry/state/.env`; the CLI still reads
// the checkout's file AFTER it, so a variable that exists only there keeps
// working for the CLI and nothing says which ones those are. Deleting the file
// by hand therefore drops whatever only it had, silently.
//
// `metistry secrets retire-legacy-env` makes that a verb: it lists what only
// the old file has (names, never values), copies those into the instance's
// file — appended, never over a line the instance already has — and, with
// `--yes`, deletes the old file. Two things make it refuse the deletion rather
// than trust the operator:
//
//   * a job still sources the old file. `up` renders every job against the env
//     file it resolved at the time, and an install that ran `up` before its
//     state/.env existed has jobs — plists, or the supervisor's children —
//     that `. '<product>/.env'` on every start. Deleting it would stop them
//     the next time they restart. `metistry up` re-renders them first.
//   * this CLI found the instance ONLY through `METISTRY_INSTANCE_DIR` in the
//     old file. Deleting it would leave the CLI unable to find its own
//     instance; run through the `metistry` shim (which exports it) instead.
//
// Nothing here reads the Keychain or prints a value.

import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDotEnv } from "./env.js";
import { launchAgentsDir, LABEL_PREFIX } from "./launchd.js";
import { quoteEnvValue } from "./secrets.js";

/** The pointer the CLI reads out of the old file to find the instance; copying it INTO the instance's own file would be circular. */
const POINTER = "METISTRY_INSTANCE_DIR";

export const RETIRE_LEGACY_ENV_COMMAND = "metistry secrets retire-legacy-env";

export interface LegacyEnvReport {
  /** the product checkout's `.env` */
  legacy: string;
  /** the instance's `.metistry/state/.env` */
  target: string;
  /** live only in the old file — what a retirement copies */
  onlyLegacy: string[];
  /** in both, with different values: the instance's already wins, and the old value is read by nothing */
  shadowed: string[];
  /** in both, with the same value */
  same: string[];
  /** the old file declares METISTRY_INSTANCE_DIR (never copied) */
  pointer: boolean;
  /** job files that still source the old file — the deletion is refused while there is one */
  sourcedBy: string[];
}

/**
 * Every job file that could `. '<legacy>'` on its next start: the
 * supervisor's config (its children's argv) and this product's LaunchAgent
 * plists. Only files that exist are returned.
 */
export async function jobFilesFor(o: { instanceDir: string; home: string | undefined }): Promise<string[]> {
  const files = [join(o.instanceDir, ".metistry", "state", "supervisor.json")];
  if (o.home) {
    const dir = launchAgentsDir(o.home);
    try {
      for (const name of (await readdir(dir)).sort()) {
        if (name.startsWith(LABEL_PREFIX) && name.endsWith(".plist")) files.push(join(dir, name));
      }
    } catch {
      /* no LaunchAgents directory — nothing installed there */
    }
  }
  return files.filter((f) => existsSync(f));
}

/** Does `text` name `path` as a whole path (not as the prefix of `.env.example` or a longer path)? */
function names(text: string, path: string): boolean {
  let at = text.indexOf(path);
  while (at !== -1) {
    const next = text[at + path.length];
    if (next === undefined || /['"\s<;&|)]/.test(next)) return true;
    at = text.indexOf(path, at + 1);
  }
  return false;
}

/** What the old file still holds, compared with the instance's. Undefined when there is no old file. */
export async function legacyEnvReport(o: { legacy: string; target: string; jobFiles: readonly string[] }): Promise<LegacyEnvReport | undefined> {
  if (!existsSync(o.legacy)) return undefined;
  const old = parseDotEnv(await readFile(o.legacy, "utf8"));
  const own = existsSync(o.target) ? parseDotEnv(await readFile(o.target, "utf8")) : {};
  const report: LegacyEnvReport = { legacy: o.legacy, target: o.target, onlyLegacy: [], shadowed: [], same: [], pointer: POINTER in old, sourcedBy: [] };
  for (const key of Object.keys(old).sort()) {
    if (key === POINTER) continue;
    if (!(key in own)) report.onlyLegacy.push(key);
    else if (own[key] === old[key]) report.same.push(key);
    else report.shadowed.push(key);
  }
  for (const f of o.jobFiles) {
    const text = await readFile(f, "utf8").catch(() => "");
    if (names(text, o.legacy)) report.sourcedBy.push(f);
  }
  return report;
}

export interface RetireLegacyEnvOptions {
  legacy: string;
  target: string;
  jobFiles: readonly string[];
  /** without it, nothing is written or deleted: the preview is the whole command */
  yes: boolean;
  /** this CLI resolved the instance only from METISTRY_INSTANCE_DIR in the old file */
  pointerOnlyInLegacy: boolean;
  out: (line: string) => void;
}

export interface RetireLegacyEnvResult {
  report?: LegacyEnvReport;
  /** names appended to the instance's file */
  copied: string[];
  /** names that could not be written to a dotenv line (a value the parser cannot read back) — the old file is kept for them */
  uncopyable: string[];
  deleted: boolean;
  /** why the old file was kept, when `--yes` was given and it was */
  kept?: string;
}

/**
 * Preview (default) or perform the retirement. Copy first, delete second, and
 * delete only when every name the old file alone had now lives in the
 * instance's file and nothing still sources the old one.
 */
export async function retireLegacyEnv(o: RetireLegacyEnvOptions): Promise<RetireLegacyEnvResult> {
  const report = await legacyEnvReport(o);
  if (!report) {
    o.out(`${o.legacy} does not exist — there is nothing to retire; ${o.target} is this install's whole environment.`);
    return { copied: [], uncopyable: [], deleted: false };
  }
  const old = parseDotEnv(await readFile(o.legacy, "utf8"));
  o.out(`old file:  ${report.legacy}`);
  o.out(`instance:  ${report.target}${existsSync(report.target) ? "" : " (does not exist yet — it would be created, 0600)"}`);
  o.out(`only in the old file — to copy: ${report.onlyLegacy.join(", ") || "(none)"}`);
  if (report.shadowed.length) o.out(`in both, and the instance's value already wins (the old one is read by nothing): ${report.shadowed.join(", ")}`);
  if (report.same.length) o.out(`in both, same value: ${report.same.length} name(s)`);
  if (report.pointer) o.out(`${POINTER}: not copied — in the old file it is how a CLI started without the shim finds the instance; the instance's own file never needs it`);

  const refusals: string[] = [];
  if (report.sourcedBy.length) {
    refusals.push(`${report.sourcedBy.length} job file(s) still source it (${report.sourcedBy.join(", ")}) — run \`metistry up\` first, which renders them against ${report.target}`);
  }
  if (o.pointerOnlyInLegacy) {
    refusals.push(`this CLI found the instance only through ${POINTER} in it — run \`metistry\` through its shim (<instance>/.metistry/state/cli/metistry, which exports ${POINTER}) or export ${POINTER} yourself`);
  }

  if (!o.yes) {
    o.out("");
    o.out(
      refusals.length
        ? `preview only, and --yes would copy but NOT delete: ${refusals.join("; ")}.`
        : `preview only. Nothing was written — rerun with --yes to copy the ${report.onlyLegacy.length} name(s) above into ${report.target} and delete ${report.legacy}.`,
    );
    return { report, copied: [], uncopyable: [], deleted: false };
  }

  const copied: string[] = [];
  const uncopyable: string[] = [];
  const lines: string[] = [];
  for (const key of report.onlyLegacy) {
    try {
      lines.push(`${key}=${quoteEnvValue(old[key] ?? "")}`);
      copied.push(key);
    } catch {
      uncopyable.push(key);
    }
  }
  if (lines.length) {
    const current = existsSync(o.target) ? await readFile(o.target, "utf8") : "";
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    await mkdir(dirname(o.target), { recursive: true });
    await writeFile(o.target, `${current}${sep}\n# --- moved from ${report.legacy} by \`${RETIRE_LEGACY_ENV_COMMAND}\` ---\n${lines.join("\n")}\n`, { mode: 0o600 });
    await chmod(o.target, 0o600);
  }
  o.out(`copied ${copied.length} name(s) into ${o.target} (appended; no line it already had was touched): ${copied.join(", ") || "(none)"}`);
  if (uncopyable.length) {
    refusals.push(`${uncopyable.join(", ")} could not be written as a dotenv line (a newline or a single quote in the value) — move ${uncopyable.length === 1 ? "it" : "them"} by hand`);
  }
  if (refusals.length) {
    const kept = `${report.legacy} was NOT deleted: ${refusals.join("; ")}. Rerun once that is fixed.`;
    o.out(kept);
    return { report, copied, uncopyable, deleted: false, kept };
  }
  await rm(o.legacy);
  o.out(`deleted ${report.legacy} — the deprecation notice goes with it.`);
  return { report, copied, uncopyable, deleted: true };
}
