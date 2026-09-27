// `metistry variables set|unset|list` — M14 (design-build-plan §2.2, §2.14; T4-4).
//
//   variables set <name> <value>     add or change one; refused if the value
//                                    looks like a key (Store as Secret), is
//                                    one of this instance's secret values, or
//                                    is a schedule or a time (ruling 2)
//   variables unset <name>           remove one, naming what references it
//   variables list [--json]          the rows GET /api/variables serves
//
// `.metistry/variables.yaml` is a §4.7 protected path — text agents read —
// so every write goes through the reconciler as the owner (`writeProtected`),
// edited as a YAML document so hand-written comments survive, and the RESULT
// is parsed by core's `parseVariablesFile` — the one judge of what a variable
// may hold — before anything is written. A refusal names the variable and
// the reason, never the value.
//
// The one check core cannot make on its own is the Keychain's: a value equal
// to (or containing) one of THIS instance's secrets. The CLI can ask, because
// it runs as the person whose login Keychain holds them; it compares in
// memory and prints only the secret's name.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import {
  InstanceSecrets,
  describeVariables,
  instanceFile,
  parseSecretsFile,
  parseVariablesFile,
  resolveInstanceLayout,
  secretHeldIn,
  variableNameIssue,
  variableRefsIn,
  variableValueIssue,
  type KeychainBackend,
  type VariableRow,
  type VariablesFile,
} from "@foldedspacelabs/metistry-core";
import { realExec, type Exec } from "./exec.js";
import { securityKeychain } from "./keychain.js";
import { protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";

export const VARIABLE_VERBS = ["set", "unset", "list"] as const;
export type VariableVerb = (typeof VARIABLE_VERBS)[number];

export function parseVariableVerb(v: string | undefined): VariableVerb | undefined {
  return (VARIABLE_VERBS as readonly string[]).includes(v ?? "") ? (v as VariableVerb) : undefined;
}

/** `.metistry/variables.yaml` as this instance spells it. */
export function variablesFilePath(instanceDir: string): string {
  return instanceFile(instanceDir, "variables");
}

const VARIABLES_HEADER = [
  "# variables.yaml — plain shared values, referenced as {{ variable.<name> }} in",
  "# connection files and agents' instructions. Agents read them, so a value is",
  "# never a secret (a key-shaped one is refused: `metistry secrets set`) and",
  "# never a schedule or a time (a routine's timing is its schedule; facts about",
  "# you are Me/profile.md). Written by `metistry variables` (docs/ops/cli.md);",
  "# a §4.7 protected path, so only you change it.",
  "",
];

export interface VariablesOptions {
  /** the instance repo whose `.metistry/variables.yaml` this edits */
  instanceDir: string;
  /** its `instance_id` — the Keychain account its secrets are under; absent = no secret comparison possible */
  instanceId: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  /** test seam: the Keychain. Default: the login Keychain through `security`, on darwin. */
  keychain?: KeychainBackend | undefined;
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

/**
 * Every file under `.metistry/` (state excluded) that references a variable,
 * as name → instance-relative paths. The console's `GET /api/variables` and
 * `variables list` both read *used in* from this one walk.
 */
export async function variableUsage(instanceDir: string): Promise<Map<string, string[]>> {
  const root = resolveInstanceLayout(instanceDir);
  const base = root.path("metistryDir");
  const state = root.path("stateDir");
  const own = root.path("variables");
  const usage = new Map<string, string[]>();
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== state) await walk(p);
        continue;
      }
      if (!e.isFile() || p === own || !/\.(ya?ml|md|json)$/.test(e.name)) continue;
      const text = await readFile(p, "utf8").catch(() => "");
      for (const name of variableRefsIn(text).names) {
        const list = usage.get(name) ?? [];
        list.push(relative(instanceDir, p));
        usage.set(name, list);
      }
    }
  };
  // a legacy (flat) instance has no `.metistry/` to walk — only the instance root, which is the vault
  if (base !== instanceDir.replace(/\/+$/, "")) await walk(base);
  return usage;
}

/** The file and its rows. Absent file = no variables. A file that does not validate throws, naming the variable — never a value. */
export async function readVariables(instanceDir: string): Promise<VariablesFile> {
  const path = variablesFilePath(instanceDir);
  return parseVariablesFile(existsSync(path) ? await readFile(path, "utf8") : "");
}

/** `variables list`: the same rows `GET /api/variables` serves. */
export async function variablesList(opts: Pick<VariablesOptions, "instanceDir">): Promise<VariableRow[]> {
  return describeVariables(await readVariables(opts.instanceDir), await variableUsage(opts.instanceDir));
}

export function renderVariables(rows: VariableRow[]): string {
  if (rows.length === 0) return "no variables yet — `metistry variables set <name> <value>` adds one; reference it as {{ variable.<name> }}.";
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const vwidth = Math.min(40, Math.max(5, ...rows.map((r) => r.value.length)));
  const head = `${"name".padEnd(width)}  ${"value".padEnd(vwidth)}  used in`;
  const body = rows.map((r) => `${r.name.padEnd(width)}  ${(r.value.length > vwidth ? `${r.value.slice(0, vwidth - 1)}…` : r.value).padEnd(vwidth)}  ${r.used_in.join(", ") || "-"}`);
  return [head, "-".repeat(head.length), ...body].join("\n");
}

interface EditableVariables {
  path: string;
  doc: ReturnType<typeof parseDocument>;
  file: VariablesFile;
}

async function openVariables(instanceDir: string): Promise<EditableVariables> {
  const path = variablesFilePath(instanceDir);
  const text = existsSync(path) ? await readFile(path, "utf8") : VARIABLES_HEADER.join("\n");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new StepFailed(`${path} is not valid YAML (${doc.errors[0]?.code}) — fix it by hand; refusing to edit a file this command cannot read back`);
  let file: VariablesFile;
  try {
    file = parseVariablesFile(text);
  } catch (e) {
    throw new StepFailed(`${path}: ${e instanceof Error ? e.message : String(e)} — fix it by hand; refusing to edit it`);
  }
  return { path, doc, file };
}

async function commitVariables(opts: VariablesOptions, edit: EditableVariables, message: string): Promise<ProtectedWrite> {
  const content = String(edit.doc);
  try {
    parseVariablesFile(content);
  } catch (e) {
    throw new StepFailed(`refusing to write ${edit.path}: the result would be invalid — ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  return writeProtected(r, protectedRel(opts.instanceDir, "variables"), content, message, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
}

/**
 * The name of one of this instance's secrets the value equals or contains —
 * or undefined, also when there is nothing to compare against (no
 * instance_id, no Keychain on this host, no secrets.yaml). The heuristic in
 * core has already run by then; this is the exact check on top of it.
 */
async function secretCollision(opts: VariablesOptions, value: string): Promise<string | undefined> {
  if (!opts.instanceId) return undefined;
  const backend = opts.keychain ?? (opts.platform === "darwin" ? securityKeychain(opts.exec ?? realExec) : undefined);
  if (!backend) return undefined;
  const path = instanceFile(opts.instanceDir, "secrets");
  if (!existsSync(path)) return undefined;
  let names: string[];
  try {
    names = Object.keys(parseSecretsFile(await readFile(path, "utf8")).secrets);
  } catch {
    return undefined; // `metistry secrets list --named` reports that file's own trouble
  }
  return secretHeldIn(value, names, new InstanceSecrets(backend, opts.instanceId));
}

export interface VariableResult {
  name: string;
  /** set: the value now held. unset: the value that was removed. */
  value: string | undefined;
  /** instance-relative files that reference it */
  used_in: string[];
  delivery?: ProtectedWrite | undefined;
}

/** `variables set <name> <value>`: add or change one. */
export async function variablesSet(rawName: string | undefined, rawValue: string | undefined, opts: VariablesOptions): Promise<VariableResult> {
  const nameIssue = variableNameIssue(rawName);
  if (nameIssue || rawName === undefined) throw new StepFailed(nameIssue?.message ?? "name the variable");
  const name = rawName;
  if (rawValue === undefined) throw new StepFailed(`give ${name} a value: metistry variables set ${name} <value>`);
  const value = rawValue.trim();
  const valueIssue = variableValueIssue(name, value);
  if (valueIssue) throw new StepFailed(valueIssue.message);
  const held = await secretCollision(opts, value);
  if (held) {
    throw new StepFailed(`${name}: that value is this instance's secret ${held} — variables can be read by agents, so a secret's value never goes in one. Reference the secret where it is needed ({{ secret.${held} }}) instead`);
  }
  const edit = await openVariables(opts.instanceDir);
  const before = Object.hasOwn(edit.file.variables, name) ? edit.file.variables[name] : undefined;
  const usedIn = (await variableUsage(opts.instanceDir)).get(name) ?? [];
  if (before === value) {
    opts.out(`${name} is already ${JSON.stringify(value)} — nothing to write`);
    return { name, value, used_in: usedIn };
  }
  edit.doc.setIn(["variables", name], value);
  opts.out(`${before === undefined ? "set" : "changed"} ${name}: ${JSON.stringify(value)}${usedIn.length ? ` — read by ${usedIn.join(", ")}` : ""}`);
  const delivery = await commitVariables(opts, edit, `variables: ${before === undefined ? "set" : "change"} ${name}`);
  return { name, value, used_in: usedIn, delivery };
}

/** `variables unset <name>`: remove one, naming what references it — those references stop filling until it is set again. */
export async function variablesUnset(rawName: string | undefined, opts: VariablesOptions): Promise<VariableResult> {
  if (typeof rawName !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(rawName)) throw new StepFailed(`${JSON.stringify(rawName ?? "")} is not a variable name — \`metistry variables list\` names them`);
  const name = rawName;
  const edit = await openVariables(opts.instanceDir);
  if (!Object.hasOwn(edit.file.variables, name)) throw new StepFailed(`no variable named ${name} in ${edit.path} — \`metistry variables list\` names them`);
  const usedIn = (await variableUsage(opts.instanceDir)).get(name) ?? [];
  const before = edit.file.variables[name];
  edit.doc.deleteIn(["variables", name]);
  if (usedIn.length) opts.out(`still referenced — {{ variable.${name} }} will not fill in: ${usedIn.join(", ")}`);
  opts.out(`unset ${name}`);
  const delivery = await commitVariables(opts, edit, `variables: unset ${name}`);
  return { name, value: before, used_in: usedIn, delivery };
}
