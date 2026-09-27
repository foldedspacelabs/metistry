// `metistry compute` — the verbs over `compute.yaml` (C1), and the surface
// the Mac app's Compute pane drives (`--json` on every one of them).
//
// Three properties this module exists to hold:
//
//   * It never writes an invalid file. Every verb edits the instance's
//     `compute.yaml` as a yaml Document (so comments, ordering and
//     hand-written blocks survive the way `deployment set-shape` preserves
//     them), then re-parses the RESULT through core's schema and refuses
//     the whole write if it does not validate.
//   * It writes as the `user`. `compute.yaml` says how the system behaves,
//     so it is a §4.7 protected path: the write goes through the
//     reconciler as the `user` principal (protected-write.ts), exactly as
//     `deployment.yaml`, `metistry.lock` and `identity.yaml` do.
//   * A secret value never reaches an argument. A provider's key is one of
//     THIS INSTANCE'S secrets (plan §2.14, the owner's Q3: per instance
//     only): `providers add` reads it from stdin into the login Keychain
//     under the instance's own account, records its name in secrets.yaml
//     (`secrets set`, the same code), and writes `{{ secret.<name> }}` —
//     a reference — into compute.yaml. Nothing here can print a value.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, parse as parseYaml } from "yaml";
import {
  BILLINGS,
  BUDGET_ACTIONS,
  COMPUTE_FILENAME,
  DEFAULT_CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_CACHING,
  INSTANCE_SECRET_NAME_RE,
  MODEL_IDENTITIES_FILENAME,
  SECRET_NAME_RE,
  credentialEnvNames,
  credentialFromEnv,
  credentialOf,
  egressDestination,
  extensionsDirFor,
  groupCatalogue,
  instanceFile,
  InstanceSecrets,
  instancePresence,
  loadKind,
  loadModelIdentities,
  PROVIDER_NAME_RE,
  loadCompute,
  modelRefIssue,
  parseCompute,
  parseModelRef,
  parseSecretsFile,
  providerCredential,
  providerEnabled,
  providerSchema,
  providerTag,
  secretService,
  type Billing,
  type Budget,
  type BudgetAction,
  type CatalogueEntry,
  type CatalogueRow,
  type Compute,
  type Effort,
  type Provider,
  type ProviderCredential,
  type ProviderManifest,
  type ProviderTag,
  type Registry,
} from "@foldedspacelabs/metistry-core";
import { readStdin } from "./connect-repo.js";
import { consoleCall, renderConsoleCallError } from "./console-client.js";
import { realExec, type Exec } from "./exec.js";
import {
  LOCAL_SERVERS,
  apiRoot,
  downloadGguf,
  fetchModels,
  lmsGet,
  lmsLoad,
  modelsDir,
  ollamaPull,
  parseGgufRef,
  probeLocalServers,
  relativeModelPath,
  serverOf,
  serverOrigin,
  type LocalServerName,
  type LocalServerRow,
} from "./local-models.js";
import { readInstanceId } from "./instance.js";
import { Keychain, keychainAccount, securityKeychain, securityPresence } from "./keychain.js";
import { protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { secretsFilePath, secretsReplace, secretsSet, type NamedSecretsOptions } from "./secrets.js";
import { StepFailed, StepRunner } from "./steps.js";
import { defaultUi, type Ui } from "./ui.js";

/**
 * The provider templates (plan §2.7): the `provider` registry, built from
 * manifests rather than a list in code — the product's
 * `seed/compute-templates/<name>/manifest.yaml`, then this instance's own in
 * `.metistry/extensions/` (an owner's template of the same name wins, D4). A
 * name that is not one of them is a typo, never a guess. **One cloud template
 * only** among the product's (OPEN-7, ruled 2026-09-17): every other
 * OpenAI-compatible cloud — OpenCode Zen included — is reached with
 * `--base-url`, by writing the block by hand, or as the owner's own template.
 */
export function computeTemplates(opts: Pick<ComputeOptions, "seedDir" | "instanceDir">): Promise<Registry<ProviderManifest>> {
  return loadKind("provider", { seedDir: opts.seedDir, extensionsDir: extensionsDirFor(opts.instanceDir) });
}

/** The template names, for a hint or a usage line: `a|b|c`, or a pointer when there are none. */
export function templateChoices(names: readonly string[]): string {
  return names.length > 0 ? names.join("|") : "<template>";
}

/** `--action allow|stop|critical_only` — strict, because a typo must not silently weaken a budget. */
export function parseBudgetAction(v: string | undefined): BudgetAction | undefined {
  return (BUDGET_ACTIONS as readonly string[]).includes(v ?? "") ? (v as BudgetAction) : undefined;
}

/** `--effort low|medium|high`; anything else throws rather than defaulting. */
export function parseEffort(v: string | undefined): Effort | undefined {
  if (v === undefined) return undefined;
  if (v !== "low" && v !== "medium" && v !== "high") throw new Error(`--effort must be low, medium or high, not ${JSON.stringify(v)}`);
  return v;
}

/** The three things an assignment can be addressed as. */
export type AssignmentTarget = { kind: "default" } | { kind: "tier"; name: string } | { kind: "crew"; name: string };

/** `default`, `<tier>`, `crew:<name>`. Never a guess: an unparseable target is an error with the three spellings in it. */
export function parseAssignmentTarget(v: string | undefined): AssignmentTarget {
  if (!v) throw new Error("say what to assign: `default`, a tier name (e.g. `deep`), or `crew:<name>`");
  if (v === "default") return { kind: "default" };
  if (v.startsWith("crew:")) {
    const name = v.slice("crew:".length);
    if (!PROVIDER_NAME_RE.test(name)) throw new Error(`crew names are lowercase kebab-case — ${JSON.stringify(name)} is not one`);
    return { kind: "crew", name };
  }
  if (!PROVIDER_NAME_RE.test(v)) throw new Error(`${JSON.stringify(v)} is not an assignment target — use \`default\`, a tier name (lowercase kebab-case), or \`crew:<name>\``);
  return { kind: "tier", name: v };
}

/** Where an assignment lives in the file — also the field name a refusal names. */
export function assignmentPath(t: AssignmentTarget): string[] {
  return t.kind === "default" ? ["assignments", "default"] : t.kind === "tier" ? ["assignments", "tiers", t.name] : ["assignments", "crews", t.name];
}

/** `instance` or `provider:<name>`. */
export type BudgetTarget = { kind: "instance" } | { kind: "provider"; name: string };

export function parseBudgetTarget(v: string | undefined): BudgetTarget {
  if (!v) throw new Error("say whose budget: `instance` or `provider:<name>`");
  if (v === "instance") return { kind: "instance" };
  if (v.startsWith("provider:")) {
    const name = v.slice("provider:".length);
    if (!PROVIDER_NAME_RE.test(name)) throw new Error(`provider names are lowercase kebab-case — ${JSON.stringify(name)} is not one`);
    return { kind: "provider", name };
  }
  throw new Error(`${JSON.stringify(v)} is not a budget target — use \`instance\` or \`provider:<name>\``);
}

export function budgetPath(t: BudgetTarget): string[] {
  return t.kind === "instance" ? ["budgets", "instance"] : ["budgets", "providers", t.name];
}

// ---- the options every verb takes --------------------------------------------

export interface ComputeOptions {
  /** the instance repo: where the file this command edits lives */
  instanceDir: string;
  /** the product's `seed/`: where `compute-templates/` is read from */
  seedDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  /** `providers add` reads the key here — stdin, so it is never in argv or shell history */
  readSecret?: (() => Promise<string>) | undefined;
  /** print the plan and change nothing */
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

/** The candidate files, in overlay order: the product's seed, then this instance's own. */
export function computeFiles(opts: Pick<ComputeOptions, "instanceDir" | "seedDir" | "env">): string {
  return opts.env.METISTRY_COMPUTE_FILES ?? `${join(opts.seedDir, COMPUTE_FILENAME)}:${instanceComputeFile(opts.instanceDir)}`;
}

export function instanceComputeFile(instanceDir: string): string {
  return instanceFile(instanceDir, "compute");
}

// ---- a provider's credential: this instance's, and only ever this instance's --------
//
// C6 filed provider keys under the per-USER account, shared by every instance
// on the Mac. The owner's Q3 (plan §2.14) retired that: a secret belongs to
// exactly one instance, filed under its `instance_id`. So no provider key is
// read from or written to the per-user account below — `metistry secrets
// migrate-scope` is what copies an old key across, once. (An `env:` install
// variable of an install with no `instance_id` yet is looked for under the
// per-user account, exactly as `accountFor` files it until one is minted.)

/** This instance's `instance_id` — the one Keychain account its secrets are filed under — or undefined when identity.yaml has none yet. */
async function instanceIdOf(opts: Pick<ComputeOptions, "instanceDir">): Promise<string | undefined> {
  return readInstanceId(opts.instanceDir).catch(() => undefined);
}

/** Is there a login Keychain to ask? darwin only; a container and CI's Linux have none. */
const hasKeychain = (opts: Pick<ComputeOptions, "platform">): boolean => opts.platform === "darwin";

/**
 * Whether the credential a provider references is where it would be read —
 * presence only, never a value:
 *
 *   `{{ secret.x }}` an item `x` under THIS instance's account (a Keychain to
 *                    ask), else its delivery line in this process's environment
 *   `env:NAME`       NAME in this process's environment, else the install's own
 *                    `metistry:NAME` item under this install's account
 */
async function credentialPresent(opts: ComputeOptions, c: ProviderCredential, instanceId: string | undefined): Promise<boolean> {
  const exec = opts.exec ?? realExec;
  if (c.kind === "secret") {
    if (hasKeychain(opts) && instanceId) return instancePresence(securityPresence(exec), instanceId).has(c.name);
    return credentialFromEnv(c, opts.env) !== undefined;
  }
  if ((opts.env[c.name] ?? "").trim() !== "") return true;
  if (!hasKeychain(opts)) return false;
  return new Keychain(exec, instanceId ?? keychainAccount(opts.env)).hasSecret(c.name);
}

/**
 * `--secret` as the owner types it → the reference written into the file.
 * A secret NAME (`openrouter_key`) or `{{ secret.openrouter_key }}` is one of
 * this instance's secrets; `env:NAME` is an install variable. The pre-T4-18
 * UPPER_SNAKE spelling is refused with the name it would be now: a provider's
 * key is an instance secret, and the flag that stored one under the per-user
 * account is exactly what Q3 retired.
 */
export function secretReferenceArg(v: string): string {
  const t = v.trim();
  if (INSTANCE_SECRET_NAME_RE.test(t)) return `{{ secret.${t} }}`;
  const c = credentialOf(t);
  if (c && !(c.kind === "env" && c.legacy)) return c.kind === "secret" ? `{{ secret.${c.name} }}` : t;
  if (SECRET_NAME_RE.test(t)) {
    const suggest = t.replace(/^METISTRY_/, "").toLowerCase();
    throw new StepFailed(
      `--secret takes one of this instance's secrets by name (lowercase, e.g. ${INSTANCE_SECRET_NAME_RE.test(suggest) ? suggest : "openrouter_key"}) — a provider's key is per instance now (plan §2.14). ` +
        `An install variable is written env:${t}.`,
    );
  }
  // never echoed, not even in part: what was typed here may be the key itself
  throw new StepFailed("--secret takes the NAME of a secret (lowercase, e.g. openrouter_key), {{ secret.<name> }}, or env:<NAME> — never the key itself, and what was given is none of them");
}

const HEADER = [
  `# ${COMPUTE_FILENAME} — this instance's compute: providers, assignments, budgets.`,
  "# Written by `metistry compute` (docs/ops/compute.md); hand-edit anything",
  "# the verbs do not cover. A §4.7 protected path: it says how the system",
  "# behaves, so only you change it (invariant 2).",
  "",
];

interface Editable {
  path: string;
  doc: ReturnType<typeof parseDocument>;
}

/** What is at `path` in the document, as plain JS — `getIn` hands back YAML nodes, whose fields are not where a reader expects them. */
function plainAt(edit: Editable, path: string[]): Record<string, unknown> | undefined {
  const node = edit.doc.getIn(path) as { toJSON?: () => unknown } | undefined;
  const value = node && typeof node.toJSON === "function" ? node.toJSON() : node;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** The instance's own file as an editable document — comments and all. A file that does not exist yet starts from the header, freshly written rather than copied. */
async function openInstanceFile(opts: ComputeOptions): Promise<Editable> {
  const path = instanceComputeFile(opts.instanceDir);
  const text = existsSync(path) ? await readFile(path, "utf8") : HEADER.join("\n");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new StepFailed(`${path} is not valid YAML (${doc.errors[0]?.message}) — fix it by hand; refusing to edit a file this command cannot read back`);
  return { path, doc };
}

/**
 * Serialize, validate the RESULT through the same schema the console and
 * the app use, and only then write — as `user`, through the reconciler.
 * An edit that would produce a file the engine could not load is refused
 * with the field that caused it, and nothing is written.
 */
async function commit(opts: ComputeOptions, edit: Editable, message: string): Promise<{ compute: Compute; content: string; delivery: ProtectedWrite }> {
  const content = String(edit.doc);
  let compute: Compute;
  try {
    compute = parseCompute(content);
  } catch (e) {
    throw new StepFailed(`refusing to write ${edit.path}: the result would be invalid — ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "compute"), content, message, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  return { compute, content, delivery };
}

// ---- show --------------------------------------------------------------------

export interface ProviderRow {
  name: string;
  kind: string;
  locality: string;
  base_url: string;
  zdr: boolean | undefined;
  /** the switch (C130): off = neither searched nor offered, and nothing may be assigned to it */
  enabled: boolean;
  /** how it charges — `token` or `subscription` off this machine, absent on it (C128) */
  billing?: Billing;
  /** the ONE tag it shows (C132): local · cloud · subscription */
  tag: ProviderTag;
  /** `auth.secret` exactly as the file writes it — a REFERENCE (`{{ secret.x }}`, `env:NAME`), never a value */
  secret?: string;
  /** what the reference is: one of this instance's secrets, or an install variable */
  secret_kind?: "secret" | "env";
  /** the secret's name (`x`) or the variable (`NAME`) */
  secret_name?: string;
  /** the pre-T4-18 bare spelling — `metistry secrets migrate-scope` rewrites a retired provider key to `{{ secret.x }}` */
  secret_legacy?: boolean;
  /** whether it is where it would be read — this instance's Keychain account for a secret — presence only */
  secret_present?: boolean;
  models_assigned: string[];
  budget?: Budget;
}

export interface AssignmentRow {
  target: string;
  provider: string;
  model: string;
  effort: Effort;
  critical?: boolean;
  /** an off_machine provider that does not claim ZDR: a warning, never a block (C13) */
  warn_non_zdr: boolean;
}

export interface ComputeReport {
  /** the file the effective configuration came from; absent = none of the overlay's candidates exist */
  file?: string;
  /** the overlay this report resolved */
  files: string[];
  /** the instance's own file, whether or not it exists yet — what the verbs edit */
  instance_file: string;
  providers: ProviderRow[];
  assignments: AssignmentRow[];
  instance_budget?: Budget;
  /** true while `rules.yaml`'s `tiers:` is still the live map */
  assigns_nothing: boolean;
}

export async function computeReport(opts: ComputeOptions): Promise<ComputeReport> {
  const files = computeFiles(opts);
  const loaded = await loadCompute(files);
  const cfg = loaded.compute;
  const instanceId = await instanceIdOf(opts);

  const assigned = new Map<string, string[]>();
  const rows: AssignmentRow[] = [];
  const add = (target: string, model: string, effort: Effort, critical?: boolean): void => {
    const ref = parseModelRef(model);
    const p = cfg.providers[ref.provider];
    assigned.set(ref.provider, [...(assigned.get(ref.provider) ?? []), ref.model]);
    rows.push({
      target,
      provider: ref.provider,
      model: ref.model,
      effort,
      ...(critical ? { critical } : {}),
      warn_non_zdr: p?.locality === "off_machine" && p.zdr !== true,
    });
  };
  if (cfg.assignments) {
    add("default", cfg.assignments.default.model, cfg.assignments.default.effort, cfg.assignments.default.critical);
    for (const [name, a] of Object.entries(cfg.assignments.tiers)) add(name, a.model, a.effort, a.critical);
    for (const [name, a] of Object.entries(cfg.assignments.crews)) add(`crew:${name}`, a.model, a.effort, a.critical);
  }

  const providers: ProviderRow[] = [];
  for (const [name, p] of Object.entries(cfg.providers)) {
    const c = providerCredential(p);
    providers.push({
      name,
      kind: p.kind,
      locality: p.locality,
      base_url: p.base_url,
      zdr: p.zdr,
      enabled: providerEnabled(p),
      ...(p.billing ? { billing: p.billing } : {}),
      tag: providerTag(p),
      ...(c
        ? {
            secret: c.ref,
            secret_kind: c.kind,
            secret_name: c.name,
            ...(c.kind === "env" && c.legacy ? { secret_legacy: true } : {}),
            secret_present: await credentialPresent(opts, c, instanceId),
          }
        : {}),
      models_assigned: [...new Set(assigned.get(name) ?? [])],
      ...(cfg.budgets?.providers[name] ? { budget: cfg.budgets.providers[name] } : {}),
    });
  }

  return {
    ...(loaded.path ? { file: loaded.path } : {}),
    files: files.split(":").filter(Boolean),
    instance_file: instanceComputeFile(opts.instanceDir),
    providers,
    assignments: rows,
    ...(cfg.budgets?.instance ? { instance_budget: cfg.budgets.instance } : {}),
    assigns_nothing: cfg.assignments === undefined,
  };
}

function table(head: string[], body: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)];
}

const money = (n: number | undefined): string => (n === undefined ? "-" : `$${n}`);

/** `templates`: the provider registry's names, for the no-providers hint (`computeTemplates`). */
export function renderComputeReport(r: ComputeReport, templates: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push(r.file ? `compute: ${r.file} (overlay: ${r.files.join(" → ")}, last existing wins)` : `compute: none of ${r.files.join(", ")} exists yet`);
  lines.push(`this instance's file: ${r.instance_file}`);
  lines.push("");
  lines.push(
    ...table(
      ["provider", "on", "tag", "base_url", "zdr", "secret", "budget"],
      r.providers.map((p) => [
        p.name,
        p.enabled ? "on" : "OFF",
        p.tag,
        p.base_url,
        p.zdr === undefined ? "-" : p.zdr ? "yes" : "no",
        p.secret ? `${p.secret} ${p.secret_present ? (p.secret_kind === "secret" ? "(in Keychain)" : "(set)") : "(MISSING)"}${p.secret_legacy ? " — old spelling: `metistry secrets migrate-scope`" : ""}` : "-",
        p.budget ? `${money(p.budget.daily_usd)}/day ${money(p.budget.monthly_usd)}/mo ${p.budget.action}` : "-",
      ]),
    ),
  );
  if (r.providers.length === 0) lines.push(`(no providers — \`metistry compute providers add --from ${templateChoices(templates)}\`)`);
  lines.push("");
  if (r.assignments.length === 0) {
    lines.push("assignments: none — rules.yaml's `tiers:` is still the live map (`metistry compute assign default <provider/model>` moves it here).");
  } else {
    lines.push(...table(["assignment", "provider", "model", "effort", ""], r.assignments.map((a) => [a.target, a.provider, a.model, a.effort, a.warn_non_zdr ? "⚠ off-machine, no ZDR claimed" : a.critical ? "critical" : ""])));
  }
  if (r.instance_budget) {
    lines.push("");
    lines.push(`instance budget: ${money(r.instance_budget.daily_usd)}/day ${money(r.instance_budget.monthly_usd)}/month, action ${r.instance_budget.action}`);
  }
  lines.push("");
  lines.push("The engine dials these providers and enforces every budget above, before the call (docs/ops/compute.md).");
  return lines.join("\n");
}

// ---- providers add / remove --------------------------------------------------

export interface ProvidersAddOptions extends ComputeOptions {
  /** a provider template's name — the provider registry's (`computeTemplates`) */
  template: string;
  /** the name this provider gets in the file; default = the template's own */
  name?: string | undefined;
  baseUrl?: string | undefined;
  /** which secret the key is: a secret NAME (`openrouter_key`), `{{ secret.<name> }}`, or `env:<NAME>` — never a value */
  secret?: string | undefined;
  /** skip the live `/models` probe this normally ends with */
  skipTest?: boolean | undefined;
}

export interface ProvidersAddResult {
  name: string;
  provider: Provider;
  /** the REFERENCE written as `auth.secret`, when this provider authenticates — never a value */
  secret?: string;
  /** what happened to the key: stored from stdin, already there, or none needed */
  secretStatus: "stored" | "present" | "none" | "skipped";
  test?: ProviderTestResult;
  delivery: ProtectedWrite;
  /** the secrets.yaml write that recorded a newly stored key's name */
  secret_delivery?: ProtectedWrite;
}

/**
 * One template, through the provider registry: its name and its `provider:`
 * block exactly as the manifest writes it (the raw YAML, not the parsed form,
 * so nothing a default fills in is written into the owner's file). An
 * unknown name is refused with the names that exist — and, when a unit of
 * that name was skipped, why.
 */
export async function readTemplate(opts: Pick<ComputeOptions, "seedDir" | "instanceDir">, template: string): Promise<{ name: string; block: Record<string, unknown>; origin: "product" | "extension"; path: string }> {
  const reg = await computeTemplates(opts);
  const unit = reg.get(template);
  if (!unit) {
    const skipped = reg.skipped.filter((s) => s.name === template).map((s) => `${s.path} was skipped: ${s.reason}`);
    const known = reg.names();
    throw new StepFailed(
      `no provider template named ${JSON.stringify(template)}${skipped.length > 0 ? ` (${skipped.join("; ")})` : ""} — ${known.length > 0 ? `one of ${known.join(", ")}` : `none found under ${join(opts.seedDir, "compute-templates")}; set METISTRY_PRODUCT_DIR to a Metistry checkout (or pass --product-dir)`}`,
    );
  }
  const raw = parseYaml(await readFile(unit.path, "utf8")) as { provider?: unknown };
  if (typeof raw?.provider !== "object" || raw.provider === null) throw new StepFailed(`${unit.path} has no provider: block`);
  return { name: unit.name, block: raw.provider as Record<string, unknown>, origin: unit.origin, path: unit.path };
}

/** The `metistry secrets` options for this instance, from a compute verb's. */
function namedSecretsOptions(opts: ComputeOptions, instanceId: string): NamedSecretsOptions {
  return {
    instanceDir: opts.instanceDir,
    instanceId,
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    exec: opts.exec,
    fetchFn: opts.fetchFn,
    readSecret: opts.readSecret,
    dryRun: opts.dryRun,
    out: opts.out,
  };
}

/**
 * A provider's key, into THIS instance's Keychain account — through
 * `metistry secrets set`'s own code, so the item and its line in
 * secrets.yaml land together exactly as they do by hand. The line's *Sent
 * only to* is the provider's host: the one place this key is for.
 */
async function storeProviderSecret(opts: ProvidersAddOptions, provider: string, p: Provider, name: string): Promise<{ status: ProvidersAddResult["secretStatus"]; delivery?: ProtectedWrite | undefined }> {
  const deliverAs = credentialEnvNames({ kind: "secret", name, ref: "" })[0]!;
  if (!hasKeychain(opts)) {
    opts.out(`no login Keychain on ${opts.platform}: store ${name} on the Mac that holds this instance (\`metistry secrets set ${name}\`), or hand it to this install's services as ${deliverAs}.`);
    return { status: "skipped" };
  }
  const instanceId = await instanceIdOf(opts);
  if (!instanceId) {
    throw new StepFailed(`${opts.instanceDir} has no instance_id in identity.yaml, and a provider's key belongs to exactly one instance — \`metistry up\` or \`metistry secrets sync --to env\` mints one; ${instanceComputeFile(opts.instanceDir)} was NOT changed`);
  }
  const store = new InstanceSecrets(securityKeychain(opts.exec ?? realExec), instanceId);
  if (await store.has(name)) {
    opts.out(`${name} is already one of this instance's secrets (${secretService(name)}, account ${store.account}) — left as it is (\`metistry compute providers test ${provider}\` proves it works).`);
    return { status: "present" };
  }
  if (opts.dryRun === true) {
    opts.out(`[dry-run] would ask for the ${provider} key on stdin and store it as ${name} (${secretService(name)}, account ${store.account})`);
    return { status: "skipped" };
  }
  const path = secretsFilePath(opts.instanceDir);
  const named = existsSync(path) && Object.hasOwn(parseSecretsFile(await readFile(path, "utf8")).secrets, name);
  const host = egressDestination(p.base_url)?.entry;
  opts.out(`paste the ${provider} API key, then Ctrl-D (read from stdin, never echoed, never in argv):`);
  const r = named ? await secretsReplace(name, {}, namedSecretsOptions(opts, instanceId)) : await secretsSet(name, { hosts: host ? [host] : [] }, namedSecretsOptions(opts, instanceId));
  opts.out(`the engine reads it as ${deliverAs} once \`metistry secrets sync --to env\` has written that line (then \`metistry restart assistant\`).`);
  return { status: "stored", delivery: r.delivery };
}

export async function providersAdd(opts: ProvidersAddOptions): Promise<ProvidersAddResult> {
  const { name: templateName, block } = await readTemplate(opts, opts.template);
  const name = opts.name ?? templateName;
  if (!PROVIDER_NAME_RE.test(name)) throw new StepFailed(`--name ${JSON.stringify(name)} is not a provider name (lowercase, digits, - and _, starting with a letter)`);
  if (opts.baseUrl !== undefined) block.base_url = opts.baseUrl;
  if (opts.secret !== undefined) block.auth = { secret: secretReferenceArg(opts.secret) };
  const parsed = providerSchema.safeParse(block);
  if (!parsed.success) {
    throw new StepFailed(`the ${opts.template} template with these overrides is not a valid provider: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const provider = parsed.data;

  const edit = await openInstanceFile(opts);
  if (edit.doc.hasIn(["providers", name])) {
    throw new StepFailed(`${edit.path} already declares provider ${name} — \`metistry compute providers remove ${name}\` first, or pass --name <other> to add a second one`);
  }
  edit.doc.setIn(["providers", name], block);
  // Refused BEFORE a key is asked for: an edit that could not be written
  // must not have cost anybody a paste, or left an item behind it.
  try {
    parseCompute(String(edit.doc));
  } catch (e) {
    throw new StepFailed(`refusing to write ${edit.path}: the result would be invalid — ${e instanceof Error ? e.message : String(e)}`);
  }

  // The key, before the provider: a run that cannot store the credential does
  // not leave a provider in the file with nothing behind it.
  let secretStatus: ProvidersAddResult["secretStatus"] = "none";
  let secretDelivery: ProtectedWrite | undefined;
  const cred = providerCredential(provider);
  if (cred?.kind === "secret") {
    const r = await storeProviderSecret(opts, name, provider, cred.name);
    secretStatus = r.status;
    secretDelivery = r.delivery;
  } else if (cred?.kind === "env") {
    // An install variable — the normal case for a provider that IS one of
    // Metistry's own bridges: `applefm` authenticates with
    // METISTRY_BRIDGE_TOKEN_APPLE_FM, which this install minted. Nothing to
    // paste and nothing to store: prompting would be asking the operator to
    // paste back a value we made.
    if ((opts.env[cred.name] ?? "").trim() !== "") {
      opts.out(`${cred.name} is already set in this install's environment — nothing to store (\`metistry secrets list\` says where it lives).`);
      secretStatus = "present";
    } else {
      opts.out(`${cred.name} is an install variable and is not set here — \`metistry secrets sync --to env\` writes the ones this install mints; a key you hold belongs in one of this instance's secrets instead (\`--secret <name>\`).`);
      secretStatus = "skipped";
    }
  }

  const { delivery } = await commit(opts, edit, `metistry compute providers add ${name} (--from ${opts.template})`);
  const test = opts.skipTest === true || opts.dryRun === true ? undefined : await providerTest({ ...opts, name }).catch((e) => ({ name, ok: false, listingOk: false, url: provider.base_url, detail: e instanceof Error ? e.message : String(e), models: [] }) as ProviderTestResult);
  return { name, provider, ...(provider.auth ? { secret: provider.auth.secret } : {}), secretStatus, ...(test ? { test } : {}), delivery, ...(secretDelivery ? { secret_delivery: secretDelivery } : {}) };
}

export interface ProvidersRemoveResult {
  name: string;
  delivery: ProtectedWrite;
}

export async function providersRemove(opts: ComputeOptions & { name: string }): Promise<ProvidersRemoveResult> {
  const edit = await openInstanceFile(opts);
  if (!edit.doc.hasIn(["providers", opts.name])) {
    throw new StepFailed(`${edit.path} does not declare a provider called ${opts.name}`);
  }
  edit.doc.deleteIn(["providers", opts.name]);
  // The schema refuses an assignment whose provider is gone, so `commit`
  // would fail anyway — this says which field to change first instead of
  // making the operator read a validation error.
  const before = parseCompute(await readFile(edit.path, "utf8").catch(() => ""));
  const users = [
    ...(before.assignments && parseModelRef(before.assignments.default.model).provider === opts.name ? ["assignments.default"] : []),
    ...Object.entries(before.assignments?.tiers ?? {}).filter(([, a]) => parseModelRef(a.model).provider === opts.name).map(([n]) => `assignments.tiers.${n}`),
    ...Object.entries(before.assignments?.crews ?? {}).filter(([, a]) => parseModelRef(a.model).provider === opts.name).map(([n]) => `assignments.crews.${n}`),
    ...(before.budgets?.providers[opts.name] ? [`budgets.providers.${opts.name}`] : []),
  ];
  if (users.length > 0) {
    throw new StepFailed(`${opts.name} is still named by ${users.join(", ")} — reassign those first (\`metistry compute assign <target> <other-provider>/<model>\`); ${edit.path} was NOT changed`);
  }
  const cred = providerCredential(before.providers[opts.name]!);
  const { delivery } = await commit(opts, edit, `metistry compute providers remove ${opts.name}`);
  if (cred?.kind === "secret") opts.out(`its key, ${cred.name}, is left as one of this instance's secrets — \`metistry secrets remove ${cred.name}\` is the only thing that deletes one (it lists what else references it first).`);
  return { name: opts.name, delivery };
}

// ---- providers set: the gear (screen-15 §5.3) ------------------------------------

/** `on|off|true|false` → a boolean; anything else throws rather than guessing. */
export function parseSwitch(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === "on" || v === "true") return true;
  if (v === "off" || v === "false") return false;
  throw new Error(`--enabled takes on or off, not ${JSON.stringify(v)}`);
}

/** `--billing token|subscription`, strict. */
export function parseBilling(v: string | undefined): Billing | undefined {
  if (v === undefined) return undefined;
  if (!(BILLINGS as readonly string[]).includes(v)) throw new Error(`--billing takes ${BILLINGS.join(" or ")}, not ${JSON.stringify(v)}`);
  return v as Billing;
}

export interface ProvidersSetOptions extends ComputeOptions {
  name: string;
  /** the switch (C130): off = not searched, not offered, and nothing may be assigned to it */
  enabled?: boolean | undefined;
  billing?: Billing | undefined;
  baseUrl?: string | undefined;
  /** which secret the key is — a NAME, `{{ secret.<name> }}` or `env:<NAME>` — never a value; the key itself goes in with `metistry secrets set` */
  secret?: string | undefined;
}

export interface ProvidersSetResult {
  name: string;
  provider: Provider;
  /** the fields this run changed, by name */
  changed: string[];
  delivery: ProtectedWrite;
}

/**
 * `metistry compute providers set <name>` — the provider's gear, and its
 * switch (M16: keys and base URLs are where prompts go, so this is the
 * Mac's and the CLI's, never a console route). The same edit-validate-write
 * as every verb here: switching off a provider that an assignment still
 * names is refused by the schema, naming the assignment, and nothing is
 * written.
 *
 * `--secret` points the provider at one of this instance's secrets; it takes
 * no value. A name this instance has no item for is written anyway, with a
 * note — setting the reference first and the key second is a legitimate
 * order — and `compute show` reports it `MISSING` until it is there.
 */
export async function providersSet(opts: ProvidersSetOptions): Promise<ProvidersSetResult> {
  const edit = await openInstanceFile(opts);
  if (!edit.doc.hasIn(["providers", opts.name])) {
    throw new StepFailed(`${edit.path} does not declare a provider called ${opts.name} — \`metistry compute providers add --from <template> --name ${opts.name}\` adds one`);
  }
  const at = (field: string): string[] => ["providers", opts.name, field];
  const changed: string[] = [];
  if (opts.enabled !== undefined) {
    // on is the absence of the key — the shape every file had before the switch existed
    if (opts.enabled) edit.doc.deleteIn(at("enabled"));
    else edit.doc.setIn(at("enabled"), false);
    changed.push("enabled");
  }
  if (opts.billing !== undefined) {
    edit.doc.setIn(at("billing"), opts.billing);
    changed.push("billing");
  }
  if (opts.baseUrl !== undefined) {
    edit.doc.setIn(at("base_url"), opts.baseUrl);
    changed.push("base_url");
  }
  let reference: string | undefined;
  if (opts.secret !== undefined) {
    reference = secretReferenceArg(opts.secret);
    edit.doc.setIn(["providers", opts.name, "auth"], edit.doc.createNode({ secret: reference }, { flow: true }));
    changed.push("auth.secret");
  }
  if (changed.length === 0) {
    throw new StepFailed("say what to change: --enabled on|off, --billing token|subscription, --base-url <url>, or --secret <name>");
  }
  const { compute, delivery } = await commit(opts, edit, `metistry compute providers set ${opts.name} (${changed.join(", ")})`);
  const provider = compute.providers[opts.name]!;
  const cred = reference ? credentialOf(reference) : undefined;
  if (cred?.kind === "secret" && !(await credentialPresent(opts, cred, await instanceIdOf(opts)))) {
    opts.out(`this instance has no secret ${cred.name} yet — \`metistry secrets set ${cred.name}\` stores it (the key on stdin); until then \`compute show\` reports it MISSING.`);
  }
  if (opts.enabled === false && opts.dryRun !== true) opts.out(`${opts.name} is switched off: it is neither searched nor offered, and nothing may be assigned to it until \`metistry compute providers set ${opts.name} --enabled on\`.`);
  return { name: opts.name, provider, changed, delivery };
}

// ---- providers test / models list --------------------------------------------

export interface ProviderTestResult {
  name: string;
  /** the listing succeeded, and — when `--complete` was asked — the completion did too */
  ok: boolean;
  /** the listing alone, independent of any completion probe below it: what tells a render "the key is fine, only the probe model was wrong" apart from "the key itself was refused" */
  listingOk: boolean;
  url: string;
  /** model ids the provider served back, capped for display */
  models: string[];
  /** one line: an HTTP status, a model count, or why it failed. Never a secret. */
  detail: string;
  /** `--complete`: a real one-token call, against whichever model `chooseProbeModel` picked, and why */
  completion?: { ok: boolean; model: string; reason: string; detail: string };
}

/**
 * The one model per known `base_url` that this project's own docs point an
 * operator at first — `docs/poc/poc18-bakeoff/SETUP.md` ("The bar — Sonnet
 * via OpenRouter") and the commented `assignments.default` in
 * `seed/compute.yaml`. Keyed by `base_url`, not by the provider's NAME in
 * this instance's file, because `--name` can call a provider anything.
 */
const KNOWN_PROBE_MODELS: ReadonlyArray<{ base_url: string; model: string }> = [{ base_url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5" }];

/**
 * OpenRouter's own auto-router — a documented last resort (verified present
 * in OpenRouter's own `/v1/models` listing, 2026-09-19) for the case the
 * shortlist above does not cover: a provider that has answered `/models` at
 * all has already proven it can reach OpenRouter, and `openrouter/auto`
 * routes to whatever OpenRouter itself considers live right now.
 */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_FALLBACK_MODEL = "openrouter/auto";

/**
 * Which model `--complete` calls, and why. The bug this exists to fix: with
 * nothing assigned yet, the previous rule was "the alphabetically first
 * model in the listing" — for OpenRouter's 447+ models that is some obscure
 * `aion-labs/…` entry with no route to a provider, a 404 that has nothing to
 * do with whether the credential works. In order:
 *
 *   1. `--model <id>` — the operator's own choice, unconditionally.
 *   2. a model already ASSIGNED to this provider in `compute.yaml` — it
 *      proves the wiring a turn is about to depend on.
 *   3. this provider's entry in `KNOWN_PROBE_MODELS`, when the listing
 *      actually serves it.
 *   4. OpenRouter's own auto-router, when this IS OpenRouter and the listing
 *      serves it.
 *   5. the first model the listing served — the original rule, now a last
 *      resort rather than the only one.
 *
 * `undefined` only when the listing served no models and nothing above
 * applies — there is nothing left to call.
 */
function chooseProbeModel(opts: { name: string; provider: Provider; compute: Compute; models: string[]; override?: string | undefined }): { model: string; reason: string } | undefined {
  if (opts.override) return { model: opts.override, reason: "--model" };

  const assignedHere: Array<{ target: string; model: string }> = [];
  const consider = (target: string, model: string | undefined): void => {
    if (!model || modelRefIssue(model)) return;
    const ref = parseModelRef(model);
    if (ref.provider === opts.name) assignedHere.push({ target, model: ref.model });
  };
  consider("assignments.default", opts.compute.assignments?.default.model);
  for (const [n, a] of Object.entries(opts.compute.assignments?.tiers ?? {})) consider(`assignments.tiers.${n}`, a.model);
  for (const [n, a] of Object.entries(opts.compute.assignments?.crews ?? {})) consider(`assignments.crews.${n}`, a.model);
  if (assignedHere[0]) return { model: assignedHere[0].model, reason: `assigned to ${assignedHere[0].target} in compute.yaml` };

  const root = apiRoot(opts.provider.base_url);
  const known = KNOWN_PROBE_MODELS.find((k) => k.base_url === root && opts.models.includes(k.model));
  if (known) return { model: known.model, reason: "on the bake-off's own shortlist for this provider (docs/poc/poc18-bakeoff/SETUP.md)" };

  if (root === OPENROUTER_BASE_URL && opts.models.includes(OPENROUTER_FALLBACK_MODEL)) {
    return { model: OPENROUTER_FALLBACK_MODEL, reason: "OpenRouter's own auto-router — nothing else here names a model to probe" };
  }

  const first = opts.models[0];
  return first ? { model: first, reason: "the first model this provider's listing served" } : undefined;
}

/** The provider's block from the effective (overlaid) configuration, with the field name in the refusal when it is not there. */
async function providerOf(opts: ComputeOptions, name: string): Promise<{ provider: Provider; compute: Compute }> {
  const { compute } = await loadCompute(computeFiles(opts));
  const provider = compute.providers[name];
  if (!provider) {
    throw new StepFailed(`providers.${name} is not declared in ${computeFiles(opts).split(":").filter(Boolean).join(" or ")} (declared: ${Object.keys(compute.providers).join(", ") || "none"})`);
  }
  return { provider, compute };
}

/** The API root with no trailing slash, so `${root}/models` is right whatever the file says. Defined with the rest of the local-server wire in local-models.ts; re-exported because this is where every caller already imports it from. */
export { apiRoot };

/**
 * The bearer for a provider. Undefined for one that declares no auth; a
 * refusal naming the REFERENCE — never a value — when there is nothing to
 * send. This verb is the owner's hand, so it may read the Keychain; a
 * service never does (`credentialEnvNames`).
 *
 *   `{{ secret.x }}` this instance's item `x` — the Keychain is the record,
 *                    so a stale delivery line cannot pass a test the engine
 *                    would then fail — else, with no Keychain, the delivery
 *                    variable
 *   `env:NAME`       NAME from the environment, else this install's own
 *                    `metistry:NAME` item. Never the retired per-user account.
 */
async function bearerFor(opts: ComputeOptions, name: string, provider: Provider): Promise<string | undefined> {
  const c = providerCredential(provider);
  if (!c) return undefined;
  const exec = opts.exec ?? realExec;
  if (c.kind === "secret") {
    const instanceId = hasKeychain(opts) ? await instanceIdOf(opts) : undefined;
    const value = instanceId ? await new InstanceSecrets(securityKeychain(exec), instanceId).value(c.name) : credentialFromEnv(c, opts.env);
    if (value) return value;
    throw new StepFailed(
      hasKeychain(opts)
        ? `providers.${name}.auth.secret is {{ secret.${c.name} }}, and this instance has no secret ${c.name}${instanceId ? ` (account ${instanceId})` : " (identity.yaml has no instance_id)"} — \`metistry secrets set ${c.name}\` stores one (the key on stdin), or \`metistry compute providers set ${name} --secret <name>\` points at another`
        : `providers.${name}.auth.secret is {{ secret.${c.name} }}, and there is no login Keychain on ${opts.platform} — set ${credentialEnvNames(c).join(" or ")} in this environment`,
    );
  }
  const fromEnv = (opts.env[c.name] ?? "").trim();
  if (fromEnv) return fromEnv;
  if (!hasKeychain(opts)) throw new StepFailed(`${c.name} is not in this environment and there is no login Keychain on ${opts.platform} — export it before running this`);
  const instanceId = await instanceIdOf(opts);
  const value = await new Keychain(exec, instanceId ?? keychainAccount(opts.env)).getSecret(c.name);
  if (value) return value;
  throw new StepFailed(
    `providers.${name}.auth.secret names ${c.name}, an install variable that is neither in this environment nor this install's Keychain — ` +
      `a key you hold is one of this instance's secrets: \`metistry secrets set <name>\`, then \`metistry compute providers set ${name} --secret <name>\``,
  );
}

/** One provider's `/v1/models`, with its credential. The call itself is `fetchModels` — the one place that knows the wire — so a cloud provider, a local one and doctor all report a failure in the same words. */
async function listModelsFrom(opts: ComputeOptions, name: string, provider: Provider): Promise<{ ok: boolean; models: string[]; detail: string }> {
  const bearer = await bearerFor(opts, name, provider);
  return fetchModels({ url: provider.base_url, bearer, fetchFn: opts.fetchFn, local: provider.locality === "on_machine" });
}

export async function providerTest(opts: ComputeOptions & { name: string; complete?: boolean | undefined; model?: string | undefined }): Promise<ProviderTestResult> {
  const { provider, compute } = await providerOf(opts, opts.name);
  const probe = await listModelsFrom(opts, opts.name, provider);
  const result: ProviderTestResult = { name: opts.name, ok: probe.ok, listingOk: probe.ok, url: apiRoot(provider.base_url), models: probe.models.slice(0, 20), detail: probe.detail };
  if (!opts.complete || !probe.ok) return result;

  // A real one-token call: the only thing that proves the credential can
  // actually buy a completion rather than just list a catalogue. Which model
  // is `chooseProbeModel`'s to decide — an alphabetically-first pick from a
  // 447-model catalogue is how this probe used to 404 on a model nobody ever
  // meant to call (`--model` overrides the choice either way).
  const choice = chooseProbeModel({ name: opts.name, provider, compute, models: probe.models, override: opts.model });
  if (!choice) {
    return { ...result, ok: false, completion: { ok: false, model: "", reason: "nothing to call", detail: "this provider served no models and nothing is assigned to it" } };
  }
  const { model, reason } = choice;
  const url = `${apiRoot(provider.base_url)}/chat/completions`;
  const bearer = await bearerFor(opts, opts.name, provider);
  try {
    const res = await (opts.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, ...(provider.request ?? {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    return { ...result, ok: result.ok && res.ok, completion: { ok: res.ok, model, reason, detail: `${url} → HTTP ${res.status}` } };
  } catch (err) {
    return { ...result, ok: false, completion: { ok: false, model, reason, detail: `${url} did not answer (${err instanceof Error ? err.message : String(err)})` } };
  }
}

/**
 * The listing's verdict, then what it is made of as aligned sub-rows
 * (docs/ops/cli-style.md): the models `/v1/models` served back, and — with
 * `--complete` — whether a real one-token call came back, against which
 * model, and how that model was chosen. The icon is the WHOLE result: a
 * listing that worked under a completion that did not is still a failure.
 */
export function renderProviderTest(t: ProviderTestResult, ui: Ui = defaultUi()): string {
  const verdict = (ok: boolean) => (ok ? ui.paint("ok", "ok") : ui.paint("failed", "FAILED"));
  const lines = [`${ui.statusIcon(t.ok ? "ok" : "failed")} ${ui.strong(t.name)}  listing ${verdict(t.listingOk)} ${ui.dim(`— ${t.detail}`)}`];
  const rows: Array<[string, string]> = [];
  if (t.models.length > 0) rows.push(["models", `${t.models.slice(0, 8).join(", ")}${t.models.length > 8 ? ui.dim(`, … (${t.models.length} total)`) : ""}`]);
  if (t.completion) {
    const override = t.completion.ok ? "" : " — override with --model <id>";
    rows.push(["completion", `${verdict(t.completion.ok)} ${ui.dim(`${t.completion.model || "none"} (chosen: ${t.completion.reason}) — ${t.completion.detail}${override}`)}`]);
  }
  if (rows.length > 0) lines.push(ui.kv(rows, { indent: 4 }));
  return lines.join("\n");
}

export interface ModelsListResult {
  providers: Array<{ name: string; ok: boolean; detail: string; models: string[] }>;
  /**
   * Local servers found on this Mac that NO provider in `compute.yaml`
   * dials. Discovery is not "what did I configure" — a person who already
   * runs LM Studio should be told so, with the one command that wires it
   * up, rather than shown an empty list.
   */
  detected: LocalServerRow[];
}

/**
 * `/v1/models`, live, for one provider or every declared one — plus the
 * local servers nothing is configured for (skipped when `--provider` asks
 * about one in particular, where a Mac-wide scan would be an answer to a
 * question nobody asked).
 */
export async function modelsList(opts: ComputeOptions & { provider?: string | undefined }): Promise<ModelsListResult> {
  const { compute } = await loadCompute(computeFiles(opts));
  const names = opts.provider ? [opts.provider] : Object.keys(compute.providers);
  if (opts.provider && !compute.providers[opts.provider]) await providerOf(opts, opts.provider); // one refusal, one place
  const providers: ModelsListResult["providers"] = [];
  for (const name of names) {
    const p = compute.providers[name]!;
    try {
      const probe = await listModelsFrom(opts, name, p);
      providers.push({ name, ok: probe.ok, detail: probe.detail, models: probe.models });
    } catch (e) {
      providers.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), models: [] });
    }
  }
  const detected = opts.provider ? [] : (await probeLocalServers({ compute, env: opts.env, fetchFn: opts.fetchFn })).filter((r) => r.ok && r.provider === undefined);
  return { providers, detected };
}

/** `templates`: the provider registry's names, for the no-providers hint (`computeTemplates`). */
export function renderModelsList(r: ModelsListResult, templates: readonly string[] = []): string {
  const lines: string[] = [];
  if (r.providers.length === 0) {
    lines.push(`no providers declared — \`metistry compute providers add --from ${templateChoices(templates)}\``);
  }
  for (const p of r.providers) {
    lines.push(`${p.name}: ${p.detail}`);
    for (const m of p.models) lines.push(`  ${p.name}/${m}`);
    if (p.models.length === 0 && p.ok) lines.push("  (none loaded)");
  }
  for (const d of r.detected) {
    lines.push("");
    lines.push(`${d.label} on ${d.url}: not configured — \`metistry compute providers add --from ${LOCAL_SERVERS[d.server].template}\``);
    for (const m of d.models.slice(0, 12)) lines.push(`  (${LOCAL_SERVERS[d.server].template})/${m}`);
    if (d.models.length > 12) lines.push(`  … ${d.models.length} models in total`);
    if (d.models.length === 0) lines.push("  (none loaded)");
  }
  lines.push("");
  lines.push("Assign one with: metistry compute assign <default|tier|crew:name> <provider/model> [--effort low|medium|high]");
  return lines.join("\n");
}

// ---- models search: one model, several places (C131) -----------------------------

/**
 * The listings `modelsSearch` read, kept between calls — the console holds
 * one so a search-as-you-type is not a round of `/v1/models` per keystroke,
 * and **Refresh** (C132) is `refresh: true`: every switched-on provider's
 * catalogue re-read. The CLI passes none and always reads live.
 */
export interface ListingCache {
  get(key: string): { probe: Awaited<ReturnType<typeof fetchModels>>; at: string } | undefined;
  set(key: string, value: { probe: Awaited<ReturnType<typeof fetchModels>>; at: string }): void;
}

export interface ModelsSearchOptions extends ComputeOptions {
  query?: string | undefined;
  /** only this provider's catalogue */
  provider?: string | undefined;
  /** re-read every catalogue even where `cache` holds one */
  refresh?: boolean | undefined;
  cache?: ListingCache | undefined;
}

export interface ModelsSearchResult {
  query: string;
  /** the switched-on providers searched, and what each listing said */
  providers: Array<{ name: string; tag: ProviderTag; ok: boolean; detail: string; count: number; read_at: string }>;
  /** providers left out, and why — a switched-off one is never searched (C130) */
  skipped: Array<{ name: string; why: string }>;
  /** grouped by model: one row per model, one line per place; an id the table cannot map is its own row */
  rows: CatalogueRow[];
  /** the model identity files read, in overlay order */
  identity_files: string[];
}

/** The identity table's overlay: the product's seed, then this instance's own (by key — model-identities.ts). */
export function modelIdentityFiles(opts: Pick<ComputeOptions, "seedDir" | "instanceDir">): string[] {
  return [join(opts.seedDir, MODEL_IDENTITIES_FILENAME), instanceFile(opts.instanceDir, "modelIdentities")];
}

/** A listing's cache key: the provider AND where it points, so an edited base URL is never answered from the old one. */
const listingKey = (name: string, p: Provider): string => `${name}\u0000${apiRoot(p.base_url)}\u0000${p.auth?.secret ?? ""}`;

/**
 * `metistry compute models search [<query>]` — every switched-on provider's
 * catalogue, grouped by MODEL through the model identity table (C131), best
 * match first. Prices come from the listing where it carries them (OpenRouter
 * does), else from `compute.yaml`'s `pricing:`; a subscription's place reads
 * *Included*, a local one is free. Nothing is invented where both are silent.
 */
export async function modelsSearch(opts: ModelsSearchOptions): Promise<ModelsSearchResult> {
  const { compute } = await loadCompute(computeFiles(opts));
  if (opts.provider !== undefined && !compute.providers[opts.provider]) await providerOf(opts, opts.provider); // one refusal, one place
  const identityFiles = modelIdentityFiles(opts);
  const table = await loadModelIdentities(identityFiles);
  const result: ModelsSearchResult = { query: (opts.query ?? "").trim(), providers: [], skipped: [], rows: [], identity_files: identityFiles };
  const entries: CatalogueEntry[] = [];
  for (const [name, p] of Object.entries(compute.providers)) {
    if (opts.provider !== undefined && name !== opts.provider) continue;
    if (!providerEnabled(p)) {
      result.skipped.push({ name, why: `switched off — \`metistry compute providers set ${name} --enabled on\`` });
      continue;
    }
    const key = listingKey(name, p);
    let hit = opts.refresh === true ? undefined : opts.cache?.get(key);
    if (!hit) {
      let probe: Awaited<ReturnType<typeof fetchModels>>;
      try {
        probe = await fetchModels({ url: p.base_url, bearer: await bearerFor(opts, name, p), fetchFn: opts.fetchFn, local: p.locality === "on_machine" });
      } catch (e) {
        probe = { ok: false, models: [], owned_by: {}, detail: e instanceof Error ? e.message : String(e) };
      }
      hit = { probe, at: new Date().toISOString() };
      // a failed read is not kept: the next search tries again rather than repeating the failure
      if (probe.ok) opts.cache?.set(key, hit);
    }
    const tag = providerTag(p);
    result.providers.push({ name, tag, ok: hit.probe.ok, detail: hit.probe.detail, count: hit.probe.models.length, read_at: hit.at });
    for (const model of hit.probe.models) {
      const d = hit.probe.details?.[model];
      const rate = p.pricing?.[model];
      const listed = d?.in_per_m !== undefined && d.out_per_m !== undefined;
      entries.push({
        provider: name,
        model,
        tag,
        ...(p.zdr !== undefined ? { zdr: p.zdr } : {}),
        ...(listed ? { in_per_m: d!.in_per_m, out_per_m: d!.out_per_m, price_source: "listing" as const } : rate ? { in_per_m: rate.in_per_m, out_per_m: rate.out_per_m, price_source: "pricing" as const } : {}),
        ...(d?.name ? { listed_name: d.name } : {}),
        ...(d?.context ? { context: d.context } : {}),
        ...(d?.tools ? { tools: true } : {}),
      });
    }
  }
  result.rows = groupCatalogue(entries, table, { query: opts.query });
  return result;
}

const perM = (n: number | null): string => (n === null ? "-" : `$${n}`);

/** One line per model, then one indented line per place: **name** maker · provider · tag (C132). */
export function renderModelsSearch(r: ModelsSearchResult, ui: Ui = defaultUi()): string {
  const lines: string[] = [];
  for (const p of r.providers) lines.push(`${ui.statusIcon(p.ok ? "ok" : "failed")} ${p.name} ${ui.dim(`(${p.tag}) — ${p.detail}`)}`);
  for (const s of r.skipped) lines.push(`${ui.icon("off")} ${s.name} ${ui.dim(`— ${s.why}`)}`);
  if (lines.length === 0) lines.push("no providers to search — `metistry compute providers add --from <template>`");
  lines.push("");
  if (r.rows.length === 0) lines.push(r.query ? `nothing matches ${JSON.stringify(r.query)}.` : "no models listed.");
  for (const row of r.rows) {
    const where = [row.summary.local ? "local" : "", row.summary.cloud ? "cloud" : ""].filter(Boolean).join(" or ");
    const from = row.summary.from_in_per_m !== null ? ` · from $${row.summary.from_in_per_m} per M` : "";
    lines.push(`${ui.strong(row.name)} ${ui.dim(row.maker ?? "")}${row.kind === "unmapped" ? ui.dim(" (not in the identity table)") : ""} ${ui.dim(`— ${row.places.length} place${row.places.length === 1 ? "" : "s"}, ${where}${from}`)}`);
    for (const pl of row.places) {
      const price = pl.included ? "included in the plan" : pl.tag === "local" ? "free" : `${perM(pl.in_per_m)} in / ${perM(pl.out_per_m)} out per M`;
      lines.push(`    ${pl.ref}  ${pl.tag}  ${price}${pl.cheapest ? "  cheapest" : ""}`);
    }
  }
  return lines.join("\n");
}

// ---- models install / load / unload ----------------------------------------------

export interface ModelsInstallResult {
  provider: string;
  server: LocalServerName;
  model: string;
  ok: boolean;
  detail: string;
  /** llamaserver only: where the GGUF landed, and the `model_path` written into compute.yaml */
  path?: string;
  model_path?: string;
  bytes?: number;
  sha256?: string;
  /** llamaserver only: absent when nothing had to be written (the path was already right) */
  delivery?: ProtectedWrite;
}

/**
 * Which of the three servers a provider IS, or a refusal that says why
 * Metistry cannot install into it. A cloud provider has a catalogue, not an
 * install; a local server on a port nobody recognises is one Metistry can
 * talk to but has no mechanism for.
 */
function installServerFor(name: string, provider: Provider): LocalServerName {
  if (provider.locality !== "on_machine") {
    throw new StepFailed(`${name} is ${provider.locality}: its models are a catalogue, not an install. \`metistry compute models list --provider ${name}\` shows what it serves.`);
  }
  const server = serverOf(name, provider);
  if (!server) {
    throw new StepFailed(
      `Metistry does not know how to install a model into ${name} (${provider.base_url}) — it recognises LM Studio (:1234), Ollama (:11434) and the bundled llama-server (a \`serve:\` block). Install the model with that server's own tools; \`metistry compute models list\` will see it either way.`,
    );
  }
  return server;
}

/**
 * `metistry compute models install <provider>/<model>` — each server's own
 * mechanism, spoken directly:
 *
 *   * **LM Studio** — `lms get <id>`, its CLI, which owns its model directory.
 *   * **Ollama** — `POST /api/pull`, streamed, progress as it arrives.
 *   * **llama-server** — one HTTPS GET of a Hugging Face GGUF into
 *     `<instance>/state/models/`, then `serve.model_path` written into
 *     `compute.yaml` as the `user`. The download is checked against the
 *     digest Hugging Face publishes before anything is written.
 */
export async function modelsInstall(opts: ComputeOptions & { ref: string }): Promise<ModelsInstallResult> {
  const why = modelRefIssue(opts.ref);
  if (why) throw new StepFailed(`${why} — \`metistry compute models install <provider>/<model>\``);
  const ref = parseModelRef(opts.ref);
  const { provider } = await providerOf(opts, ref.provider);
  const server = installServerFor(ref.provider, provider);
  const out = opts.out;

  if (server === "lmstudio") {
    if (opts.dryRun === true) {
      out(`[dry-run] would run: lms get ${ref.model}`);
      return { provider: ref.provider, server, model: ref.model, ok: true, detail: `[dry-run] lms get ${ref.model}` };
    }
    const r = await lmsGet({ exec: opts.exec ?? realExec, model: ref.model });
    out(r.detail);
    return { provider: ref.provider, server, model: ref.model, ok: r.ok, detail: r.detail };
  }

  if (server === "ollama") {
    const origin = serverOrigin(provider.base_url);
    if (opts.dryRun === true) {
      out(`[dry-run] would POST ${origin}/api/pull { model: ${ref.model} }`);
      return { provider: ref.provider, server, model: ref.model, ok: true, detail: `[dry-run] ${origin}/api/pull ${ref.model}` };
    }
    const r = await ollamaPull({ origin, model: ref.model, fetchFn: opts.fetchFn, onProgress: (line) => out(`  ${line}`) });
    out(r.detail);
    return { provider: ref.provider, server, model: ref.model, ok: r.ok, detail: r.detail };
  }

  // llamaserver: a GGUF, by URL, into this instance's state — then the path
  // into compute.yaml, so `metistry up` has something to serve.
  const gguf = parseGgufRef(ref.model);
  const dir = join(modelsDir(opts.instanceDir), gguf.repo);
  const modelPath = relativeModelPath(gguf.repo, gguf.name, opts.instanceDir);
  if (opts.dryRun === true) {
    out(`[dry-run] would download ${gguf.url} to ${join(dir, gguf.name)} and set providers.${ref.provider}.serve.model_path = ${modelPath}`);
    return { provider: ref.provider, server, model: ref.model, ok: true, detail: `[dry-run] ${gguf.url}`, model_path: modelPath };
  }
  out(`downloading ${gguf.url}`);
  const got = await downloadGguf({ ref: gguf, dir, fetchFn: opts.fetchFn, token: opts.env.METISTRY_HF_TOKEN, onProgress: (line) => out(`  ${line}`) });
  out(`${got.path}: ${got.detail}`);

  const edit = await openInstanceFile(opts);
  if (!edit.doc.hasIn(["providers", ref.provider])) {
    throw new StepFailed(`${got.path} was downloaded, but ${edit.path} declares no provider ${ref.provider} to point at it — \`metistry compute providers add --from llamaserver\` (the file was NOT changed)`);
  }
  const already = plainAt(edit, ["providers", ref.provider, "serve"])?.model_path === modelPath;
  if (already) {
    return { provider: ref.provider, server, model: ref.model, ok: true, detail: got.detail, path: got.path, model_path: modelPath, bytes: got.bytes, sha256: got.sha256 };
  }
  edit.doc.setIn(["providers", ref.provider, "serve", "model_path"], modelPath);
  const { delivery } = await commit(opts, edit, `metistry compute models install ${opts.ref}`);
  out(`providers.${ref.provider}.serve.model_path = ${modelPath} — \`metistry up\` (or \`metistry restart llamaserver\`) loads it.`);
  return { provider: ref.provider, server, model: ref.model, ok: true, detail: got.detail, path: got.path, model_path: modelPath, bytes: got.bytes, sha256: got.sha256, delivery };
}

export interface ModelsLoadResult {
  provider: string;
  server: LocalServerName;
  model: string;
  action: "load" | "unload";
  ok: boolean;
  /** true when this server has no addressable load and the call was a message rather than an action */
  noop: boolean;
  detail: string;
}

/**
 * `load`/`unload`. LM Studio is the only one of the three with an
 * addressable load, so it is the only one this does anything for — and the
 * other two get a MESSAGE that says what actually governs their residency,
 * not a silent success that implies an action nobody took.
 */
export async function modelsLoad(opts: ComputeOptions & { ref: string; unload?: boolean | undefined; ttlSeconds?: number | undefined }): Promise<ModelsLoadResult> {
  const why = modelRefIssue(opts.ref);
  if (why) throw new StepFailed(`${why} — \`metistry compute models ${opts.unload ? "unload" : "load"} <provider>/<model>\``);
  const ref = parseModelRef(opts.ref);
  const { provider } = await providerOf(opts, ref.provider);
  const server = installServerFor(ref.provider, provider);
  const action = opts.unload ? "unload" : "load";
  const base = { provider: ref.provider, server, model: ref.model, action } as const;

  if (server === "lmstudio") {
    if (opts.dryRun === true) return { ...base, ok: true, noop: false, detail: `[dry-run] lms ${action} ${ref.model}` };
    const r = await lmsLoad({ exec: opts.exec ?? realExec, model: ref.model, unload: opts.unload === true, ttlSeconds: opts.ttlSeconds });
    opts.out(r.detail);
    return { ...base, ok: r.ok, noop: false, detail: r.detail };
  }
  const detail =
    server === "ollama"
      ? `Ollama has no addressable ${action}: it loads a model on the first request and evicts it after keep_alive (default 5 minutes). Nothing to do — \`metistry compute models list --provider ${ref.provider}\` shows what it will serve.`
      : `The bundled llama-server holds exactly the model compute.yaml names, for as long as it runs. To change it: \`metistry compute models install ${ref.provider}/<owner>/<repo>/<file>.gguf\`, then \`metistry restart llamaserver\`.`;
  opts.out(detail);
  return { ...base, ok: true, noop: true, detail };
}

export function renderModelsInstall(r: ModelsInstallResult): string {
  return `${r.provider}/${r.model}: ${r.ok ? "installed" : "FAILED"} — ${r.detail}${r.model_path ? `\n  serve.model_path = ${r.model_path}` : ""}`;
}

// ---- assign ------------------------------------------------------------------

export interface AssignResult {
  target: string;
  provider: string;
  model: string;
  effort: Effort;
  warn_non_zdr: boolean;
  delivery: ProtectedWrite;
}

export async function assign(opts: ComputeOptions & { target: AssignmentTarget; model: string; effort?: Effort | undefined }): Promise<AssignResult> {
  const why = modelRefIssue(opts.model);
  if (why) throw new StepFailed(`${assignmentPath(opts.target).join(".")}.model: ${why}`);
  const ref = parseModelRef(opts.model);
  const edit = await openInstanceFile(opts);
  const path = assignmentPath(opts.target);
  // `assignments.default` is where every unknown and unnamed tier lands, so
  // it has to exist before a tier or a crew can be assigned — otherwise some
  // turns would resolve here and the rest would still resolve in rules.yaml,
  // which is the one thing "one read path into state" is against.
  if (opts.target.kind !== "default" && plainAt(edit, ["assignments", "default"]) === undefined) {
    throw new StepFailed(`assignments.default is not set yet, and it is where every unnamed and unknown tier lands — run \`metistry compute assign default <provider/model>\` first; ${edit.path} was NOT changed`);
  }
  const existing = plainAt(edit, path);
  const effort = opts.effort ?? (typeof existing?.effort === "string" ? (existing.effort as Effort) : "medium");
  edit.doc.setIn(path, { model: opts.model, effort });
  const { compute, delivery } = await commit(opts, edit, `metistry compute assign ${path.join(".")} → ${opts.model}`);
  const p = compute.providers[ref.provider]!;
  const warn = p.locality === "off_machine" && p.zdr !== true;
  if (warn) opts.out(`⚠ ${ref.provider} is off_machine and does not claim zero data retention — this is recorded, never blocked (C13); the engine writes one warning row per run.`);
  return { target: path.join("."), provider: ref.provider, model: ref.model, effort, warn_non_zdr: warn, delivery };
}

// ---- unassign: tiers are editable (Q1) ------------------------------------------

export interface UnassignResult {
  target: string;
  delivery: ProtectedWrite;
}

/**
 * `metistry compute unassign <tier|crew:name>` — the other half of editing
 * the tiers (the owner's Q1: `assignments.tiers` stays, as the allow-list the
 * dynamic router chooses from, edited under Settings ▸ Compute ▸ Advanced).
 *
 * `default` is refused: it is required whenever `assignments:` exists and is
 * where every unnamed tier lands, so it is reassigned, never removed. A tier
 * removed here is not an error anywhere: a turn that still names it resolves
 * to `default`, the rule `resolveAssignment` has always followed.
 */
export async function unassign(opts: ComputeOptions & { target: AssignmentTarget }): Promise<UnassignResult> {
  if (opts.target.kind === "default") {
    throw new StepFailed("assignments.default cannot be removed: it is where every unnamed and unknown tier lands — `metistry compute assign default <provider/model>` changes it");
  }
  const edit = await openInstanceFile(opts);
  const path = assignmentPath(opts.target);
  if (!edit.doc.hasIn(path)) throw new StepFailed(`${path.join(".")} is not assigned in ${edit.path} — nothing to remove`);
  edit.doc.deleteIn(path);
  const { delivery } = await commit(opts, edit, `metistry compute unassign ${path.join(".")}`);
  const who = opts.target.kind === "tier" ? `a turn that names ${opts.target.name}` : `crew ${opts.target.name}, where its definition still says a legacy haiku|sonnet|opus,`;
  opts.out(opts.dryRun === true ? `[dry-run] ${path.join(".")} would be removed — ${who} would then run on assignments.default.` : `${path.join(".")} removed — ${who} now runs on assignments.default.`);
  return { target: path.join("."), delivery };
}

// ---- budget ------------------------------------------------------------------

export interface BudgetResult {
  target: string;
  daily_usd?: number;
  monthly_usd?: number;
  action: BudgetAction;
  delivery: ProtectedWrite;
}

export async function setBudget(
  opts: ComputeOptions & { target: BudgetTarget; daily?: number | undefined; monthly?: number | undefined; action: BudgetAction },
): Promise<BudgetResult> {
  const path = budgetPath(opts.target);
  const edit = await openInstanceFile(opts);
  const existing = plainAt(edit, path) ?? {};
  const daily = opts.daily ?? (typeof existing.daily_usd === "number" ? existing.daily_usd : undefined);
  const monthly = opts.monthly ?? (typeof existing.monthly_usd === "number" ? existing.monthly_usd : undefined);
  if (daily === undefined && monthly === undefined) {
    throw new StepFailed(`${path.join(".")}: give --daily <usd> or --monthly <usd> — an action with no limit never fires`);
  }
  edit.doc.setIn(path, { ...(daily === undefined ? {} : { daily_usd: daily }), ...(monthly === undefined ? {} : { monthly_usd: monthly }), action: opts.action });
  const { delivery } = await commit(opts, edit, `metistry compute budget ${path.join(".")} → ${opts.action}`);
  opts.out("Recorded. Enforced in the engine, before the call (docs/ops/compute.md).");
  return { target: path.join("."), ...(daily === undefined ? {} : { daily_usd: daily }), ...(monthly === undefined ? {} : { monthly_usd: monthly }), action: opts.action, delivery };
}

// ---- cache-report: OPEN-6's measurement, as one command ----------------------
//
// OPEN-6 (`docs/plan-refresh-2026-09-13.md`, ruled 2026-09-17: ship automatic
// top-level `cache_control` first and measure afterwards) left the owner a
// measurement to run. This is that measurement, and it is a verb rather than
// a script somebody writes once and loses.
//
// TWO SOURCES, joined here and nowhere else:
//
//   the LEDGER — `seed/queries/cache_report.yaml` through the console's
//     generic `GET /api/q/<name>` door, like every other read (invariant 3:
//     the CLI does not talk to Postgres, and invariant 10: an existing door,
//     never a new one). It knows what the cache DID.
//   `compute.yaml` — the provider's `pricing:` table and its current
//     `caching:` mode. It knows what a cached token COSTS, which the ledger
//     cannot: on the `provider` cost path the row carries a total and no
//     rates at all.
//
// The join is why the dollar figure lives in the CLI instead of in the SQL.
// A named query that read `compute.yaml` would be a second read path into
// configuration, and one that hard-coded 0.1× would be pricing a stranger's
// provider at Anthropic's rates.

/**
 * The hit ratio at which the prefix is behaving — the line the verdict is
 * drawn at, and a number to revise once the measurement has been run rather
 * than a law.
 *
 * `docs/research/2026-09-cost-optimization.md` records Anthropic's own figure
 * for a healthy agent loop: **89 % cache reads** after a task boundary, which
 * is what a system prompt → tools → prior turns prefix that nobody perturbs
 * looks like. 80 % is set below it deliberately: a real install rolls
 * sessions, and the first turn after every roll is a legitimate miss that
 * drags the window's average down. Under 80 % something is changing between
 * turns that should not be — a timestamp in the system prompt, an edited
 * prompt, a changed `effort`, a tool added or reordered — and the same
 * document lists them.
 */
export const STABLE_PREFIX_HIT_RATIO = 0.8; // limit: fixed — a reading threshold from published guidance, not an install's policy

/** `7d`, `2w`, `3m`, or a bare number of days. Strict: a spelling this does not know is an error naming the ones it does, never a silent 7. */
export function parseSince(v: string | undefined): number {
  if (v === undefined || v.trim() === "") return 7;
  const m = /^(\d+)\s*(d|w|m)?$/.exec(v.trim().toLowerCase());
  if (!m) throw new Error(`--since takes a number of days (\`14\`), or \`<n>d\`, \`<n>w\`, \`<n>m\` — not ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  if (n < 1) throw new Error("--since must be at least one day — a window with no turns in it measures nothing");
  return m[2] === "w" ? n * 7 : m[2] === "m" ? n * 30 : n;
}

/** One (provider, model, tier, caching) group: the query's row, plus what only `compute.yaml` can say. */
export interface CacheReportGroup {
  provider: string;
  model: string;
  tier: string;
  /** the `caching:` mode IN FORCE when these turns ran (`runs.meta.caching`); `unknown` predates the stamp */
  caching: string;
  turns: number;
  /** turns whose response carried a cache field at all — `turns - turns_reporting` is the provider saying nothing, which is a different finding from a miss */
  turns_reporting: number;
  turns_hit: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  /** `cache_read / tokens_in`; null when the group billed no prompt at all (not a reading, and not 0 %) */
  hit_ratio: number | null;
  cost_usd: number;
  turns_unpriced: number;
  /**
   * What the cache was worth in dollars, NET: the reads billed at a fraction
   * of the input rate instead of in full, minus the premium the writes paid.
   * Absent where `compute.yaml` names no `pricing:` entry for this (provider,
   * model) — which is the normal case on OpenRouter, whose responses carry
   * `usage.cost` and no rates. The refusal names the field (R3).
   */
  saved_usd?: number;
  /** why `saved_usd` is absent, naming the field that would fill it */
  saved_unavailable?: string;
  /** what `compute.yaml` says TODAY, where that differs from `caching` above — the setting was changed inside the window */
  caching_now?: string;
}

export interface CacheReport {
  /** the window asked for, in days */
  since_days: number;
  /** the query's `as_of` — a cached answer keeps the original (packages/queries) */
  as_of?: string;
  groups: CacheReportGroup[];
  totals: {
    turns: number;
    turns_reporting: number;
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    cache_write: number;
    hit_ratio: number | null;
    cost_usd: number;
    turns_unpriced: number;
    saved_usd?: number;
  };
  /** the threshold the verdict is drawn at, so `--json` does not have to guess it */
  threshold: number;
  verdict: { status: "ok" | "degraded" | "n/a"; line: string };
}

const numberOf = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** `numeric` arrives as a string from pg, and NULL has to stay NULL: a group that billed no prompt has no ratio, which is not 0 %. */
const ratioOf = (v: unknown): number | null => (v === null || v === undefined ? null : numberOf(v));

/**
 * What the cache was worth, in dollars, for one group — or nothing, said out
 * loud. The arithmetic mirrors `costOf`'s `pricing` path exactly, because a
 * saving computed on different assumptions from the charge is not a saving:
 *
 *   reads  saved (1 − cache_read_multiplier) × in_per_m each, having been
 *          billed at the multiplier instead of in full;
 *   writes COST (cache_write_multiplier − 1) × in_per_m each, which is the
 *          premium a five-minute write pays for the read that follows.
 *
 * Net, so a prefix that is rewritten every turn and never re-read comes out
 * NEGATIVE — that is the finding, and hiding it behind a floor of zero would
 * be the one number in this report that lies.
 */
function savingOf(g: { cache_read: number; cache_write: number }, provider: Provider | undefined, model: string): { saved_usd: number } | { saved_unavailable: string } {
  if (provider?.locality === "on_machine") {
    return { saved_unavailable: `${provider.kind} on this machine bills nothing for a prompt — there is no dollar saving to compute, only the latency one` };
  }
  const rate = provider?.pricing?.[model];
  if (!rate) {
    return {
      saved_unavailable: `no published rate: add providers.<name>.pricing["${model}"].in_per_m to compute.yaml for a dollar figure (the token counts above stand either way)`,
    };
  }
  const read = rate.cache_read_multiplier ?? DEFAULT_CACHE_READ_MULTIPLIER;
  const write = rate.cache_write_multiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER;
  const saved = (g.cache_read / 1_000_000) * rate.in_per_m * (1 - read) - (g.cache_write / 1_000_000) * rate.in_per_m * (write - 1);
  return { saved_usd: Math.round(saved * 1e6) / 1e6 };
}

export interface CacheReportOptions extends ComputeOptions {
  /** `--since`: `7d`, `2w`, `3m`, or a bare number of days. Default 7. */
  since?: string | undefined;
  /** this install's `instance_id` — the Keychain account the console's owner token is filed under */
  instanceId?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * The measurement. One console request and one `compute.yaml` read; nothing
 * is written, nothing is dialled at a provider, and no model is called —
 * this reads the ledger of calls already made.
 */
export async function cacheReport(opts: CacheReportOptions): Promise<CacheReport> {
  const days = parseSince(opts.since);
  const { compute } = await loadCompute(computeFiles(opts));
  const res = await consoleCall({
    method: "GET",
    path: `/api/q/cache_report?days=${days}`,
    env: opts.env,
    platform: opts.platform,
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    // a namespaced instance's console is on its own port (state/ports.yaml), never the default 8080
    instanceDir: opts.instanceDir,
    ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (res.status >= 400) {
    throw new StepFailed(
      `the console would not answer /api/q/cache_report: ${renderConsoleCallError(res)}` +
        (res.status === 404 ? " — this install's seed/queries/ predates cache_report.yaml; `metistry update` lands it" : ""),
    );
  }
  const body = (res.body ?? {}) as { rows?: unknown; as_of?: unknown };
  const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];

  const groups: CacheReportGroup[] = rows.map((r) => {
    const provider = String(r.provider ?? "");
    const model = String(r.model ?? "");
    const p = compute.providers[provider];
    const counts = {
      turns: numberOf(r.turns),
      turns_reporting: numberOf(r.turns_reporting),
      turns_hit: numberOf(r.turns_hit),
      tokens_in: numberOf(r.tokens_in),
      tokens_out: numberOf(r.tokens_out),
      cache_read: numberOf(r.cache_read),
      cache_write: numberOf(r.cache_write),
    };
    const caching = String(r.caching ?? "unknown");
    const now = p ? (p.caching ?? DEFAULT_CACHING) : undefined;
    return {
      provider,
      model,
      tier: String(r.tier ?? ""),
      caching,
      ...counts,
      hit_ratio: ratioOf(r.hit_ratio),
      cost_usd: numberOf(r.cost_usd),
      turns_unpriced: numberOf(r.turns_unpriced),
      ...savingOf(counts, p, model),
      // Only when it CHANGED: the row says what was in force then, the file
      // says what is in force now, and a window that spans the switch is a
      // window whose average means two different things.
      ...(now !== undefined && now !== caching && caching !== "unknown" ? { caching_now: now } : {}),
    };
  });

  const sum = (pick: (g: CacheReportGroup) => number): number => groups.reduce((a, g) => a + pick(g), 0);
  const tokensIn = sum((g) => g.tokens_in);
  const cacheRead = sum((g) => g.cache_read);
  const priced = groups.filter((g) => g.saved_usd !== undefined);
  const totals = {
    turns: sum((g) => g.turns),
    turns_reporting: sum((g) => g.turns_reporting),
    tokens_in: tokensIn,
    tokens_out: sum((g) => g.tokens_out),
    cache_read: cacheRead,
    cache_write: sum((g) => g.cache_write),
    hit_ratio: tokensIn > 0 ? Math.round((cacheRead / tokensIn) * 1e4) / 1e4 : null,
    cost_usd: Math.round(sum((g) => g.cost_usd) * 1e6) / 1e6,
    turns_unpriced: sum((g) => g.turns_unpriced),
    ...(priced.length > 0 ? { saved_usd: Math.round(priced.reduce((a, g) => a + (g.saved_usd ?? 0), 0) * 1e6) / 1e6 } : {}),
  };

  return {
    since_days: days,
    ...(typeof body.as_of === "string" ? { as_of: body.as_of } : {}),
    groups,
    totals,
    threshold: STABLE_PREFIX_HIT_RATIO,
    verdict: verdictFor(groups, totals, days),
  };
}

/**
 * ONE line, and it has to be the line the owner would have written after
 * reading the table. Four readings, in the order that matters — a provider
 * that never answers the question has to be caught before a ratio taken over
 * its silence is reported as a failure.
 */
function verdictFor(groups: CacheReportGroup[], totals: CacheReport["totals"], days: number): CacheReport["verdict"] {
  const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
  if (totals.turns === 0) {
    return { status: "n/a", line: `no engine turns in the last ${days}d — nothing to measure yet. OPEN-6 wants about ten real turns on a configured provider.` };
  }
  const asking = groups.filter((g) => g.caching === "auto");
  if (asking.length === 0) {
    return {
      status: "n/a",
      line: `${totals.turns} turns, none of them on a provider with \`caching: auto\` — nothing asked for a cache, so there is no hit ratio to judge. Set \`caching: auto\` on an off-machine provider block (docs/ops/compute.md, "Prompt caching").`,
    };
  }
  const silent = asking.filter((g) => g.turns_reporting === 0);
  if (silent.length === asking.length) {
    return {
      status: "degraded",
      line:
        `${asking.reduce((a, g) => a + g.turns, 0)} turns asked for a cache and NOT ONE response reported a cache field. ` +
        `That is a wire question, not a prefix question: either the caching field is not reaching the provider, or the names core reads ` +
        `(prompt_tokens_details.cached_tokens, cache_read_input_tokens) are not the ones it sends. Check one raw response before changing any prompt.`,
    };
  }
  const asked = asking.reduce((a, g) => a + g.tokens_in, 0);
  const read = asking.reduce((a, g) => a + g.cache_read, 0);
  const ratio = asked > 0 ? read / asked : 0;
  if (ratio >= STABLE_PREFIX_HIT_RATIO) {
    return {
      status: "ok",
      line:
        `hit ratio ${pct(ratio)} across the turns that ASKED for a cache, on the ${pct(STABLE_PREFIX_HIT_RATIO)} threshold — the prefix is stable, ` +
        `and automatic top-level cache_control is doing its job. Explicit breakpoints are the other half of OPEN-6 and have this to beat.`,
    };
  }
  return {
    status: "degraded",
    line:
      `hit ratio ${pct(ratio)} across the turns that ASKED for a cache, under the ${pct(STABLE_PREFIX_HIT_RATIO)} a stable prefix holds — ` +
      `look at what changes turn to turn: ` +
      `a timestamp or anything volatile in the system prompt, an edited prompt, a changed effort, a tool added or reordered ` +
      `(docs/research/2026-09-cost-optimization.md). ${totals.cache_write > totals.cache_read ? "More was WRITTEN to the cache than read from it, which is the prefix being rebuilt every turn and paid for at a premium." : ""}`.trim(),
  };
}

const pctCell = (r: number | null): string => (r === null ? "-" : `${Math.round(r * 1000) / 10}%`);
const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : String(n));
const usd = (n: number | undefined): string => (n === undefined ? "-" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(4)}`);

/**
 * A table per provider/model, because that is the grain a decision is taken
 * at — a tier that is missing its cache on one model and hitting on another
 * is invisible in a single total. The verdict goes LAST, under the evidence
 * for it.
 */
export function renderCacheReport(r: CacheReport, ui: Ui = defaultUi()): string {
  const lines: string[] = [`prompt cache, last ${r.since_days}d${r.as_of ? ui.dim(` (as of ${r.as_of})`) : ""}`];
  if (r.groups.length === 0) {
    lines.push("");
    lines.push(ui.wrap("No engine turns in this window. Run some — a chat turn or two is enough to see the shape — then ask again.", { indent: 2 }));
    lines.push("");
    lines.push(`${ui.statusIcon(r.verdict.status)} ${ui.wrap(r.verdict.line, { hanging: 2 }).trimStart()}`);
    return lines.join("\n");
  }
  const byModel = new Map<string, CacheReportGroup[]>();
  for (const g of r.groups) {
    const key = `${g.provider}/${g.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), g]);
  }
  for (const [key, gs] of byModel) {
    lines.push("");
    lines.push(ui.heading(key));
    lines.push(
      ui.table(
        ["tier", "caching", "turns", "reported", "prompt", "cache read", "cache write", "hit", "cost", "saved"],
        gs.map((g) => [
          g.tier || ui.dim("(none)"),
          g.caching_now ? `${g.caching} ${ui.dim(`→ now ${g.caching_now}`)}` : g.caching,
          String(g.turns),
          // the count that says whether the provider answers the question at
          // all — dimmed when every turn did, loud when none did
          g.turns_reporting === g.turns ? ui.dim(`${g.turns_reporting}/${g.turns}`) : ui.paint("degraded", `${g.turns_reporting}/${g.turns}`),
          tokens(g.tokens_in),
          tokens(g.cache_read),
          tokens(g.cache_write),
          g.hit_ratio === null ? "-" : g.hit_ratio >= STABLE_PREFIX_HIT_RATIO ? ui.paint("ok", pctCell(g.hit_ratio)) : ui.paint("degraded", pctCell(g.hit_ratio)),
          usd(g.cost_usd),
          usd(g.saved_usd),
        ]),
        { indent: 2, ragged: [] },
      ),
    );
    const why = gs.find((g) => g.saved_unavailable !== undefined)?.saved_unavailable;
    if (why) lines.push(ui.note(`    saved: ${why}`));
    const unpriced = gs.reduce((a, g) => a + g.turns_unpriced, 0);
    if (unpriced > 0) lines.push(ui.note(`    ${unpriced} turn${unpriced === 1 ? "" : "s"} recorded at $0 with cost_source unknown — the cost column understates by that much`));
  }
  lines.push("");
  lines.push(
    ui.kv(
      [
        ["turns", `${r.totals.turns} (${r.totals.turns_reporting} reported a cache field)`],
        ["prompt tokens", `${tokens(r.totals.tokens_in)} in, ${tokens(r.totals.tokens_out)} out`],
        ["from cache", `${tokens(r.totals.cache_read)} read, ${tokens(r.totals.cache_write)} written`],
        ["hit ratio", `${pctCell(r.totals.hit_ratio)} ${ui.dim("(cache read ÷ prompt tokens, over EVERY turn — the prompt already includes what was cached; the verdict below counts only the turns that asked for a cache)")}`],
        ["recorded cost", usd(r.totals.cost_usd)],
        ...(r.totals.saved_usd !== undefined ? ([["net saving", `${usd(r.totals.saved_usd)} ${ui.dim("(reads below the input rate, less what the writes paid extra)")}`]] as Array<[string, string]>) : []),
      ],
      { indent: 2 },
    ),
  );
  lines.push("");
  lines.push(`${ui.statusIcon(r.verdict.status)} ${ui.wrap(r.verdict.line, { hanging: 2 }).trimStart()}`);
  return lines.join("\n");
}

// ---- route-report: PoC-20 phase 0's baseline, as one command ------------------
//
// `docs/research/2026-09-21-intent-classification-tier.md` §5.2 phase 0 is a
// measurement and an exit rule, and it could not be run where it was written:
// *"The owner runs this: it needs the instance's database, which this research
// did not touch."* This is that command. It reads
// `seed/queries/route_report.yaml` through the console's generic query door
// (invariant 3, and invariant 10: an existing door, never a new one), calls no
// model, dials no provider and writes nothing.
//
// ONE source, unlike `cache-report`: there is no second half to join. What the
// router did is entirely in `inbound_messages.meta.route`, and how the router
// decides is `rules.yaml`, which the owner reads directly — so everything here
// is arithmetic over the query's rows and a verdict drawn at one line.

/**
 * §5.2's exit rule, and the only number in this file that decides anything:
 *
 *   *"If fall-through is under ~40 %, stop and write `fast_path` rules
 *   instead — an extra regex is free, auditable, and self-documenting in the
 *   command menu."*
 *
 * The `~` is the research's own. It is a decision line for a half-day
 * measurement, not a law: a reading either side of it by a point or two is a
 * reason to widen `--since`, which is what the verdict says when it lands
 * there.
 */
export const CLASSIFIER_FALL_THROUGH_THRESHOLD = 0.4; // limit: fixed — the research's exit rule, not an install's policy

/**
 * Below this many ROUTED messages a percentage is noise, and the verdict says
 * so rather than sounding confident. §5.2 asks for "real messages" and names
 * no floor; this is the smallest window in which a 40 % line is not decided by
 * three messages either way.
 */
export const MIN_ROUTED_FOR_A_READING = 30; // limit: fixed — a caveat on the reading, never a refusal to report

/** One labelled count from the report, with what its share is taken over already applied. */
export interface RouteShare {
  label: string;
  n: number;
  /** `n / denominator`, or null where the denominator was 0 — which is not "0 %", it is not a reading */
  share: number | null;
  /** what the share is taken over: routed messages for kinds and tiers, fast-path messages for rules, fall-throughs for the rest */
  denominator: number;
}

export interface RouteReport {
  /** the window asked for, in days */
  since_days: number;
  /** the query's `as_of` — a cached answer keeps the original (packages/queries) */
  as_of?: string;
  totals: {
    messages: number;
    /** messages carrying a routing decision at all. The rest are the console filing with no ruleset loaded, and they are NOT fall-throughs */
    routed: number;
    unrouted: number;
    fall_through: number;
    /** the number §5.2's exit rule is drawn on: fall-throughs over ROUTED messages */
    fall_through_share: number | null;
    /** the oldest and newest message in the window — the window that was actually available, which is not always the one asked for */
    first_message?: string;
    last_message?: string;
  };
  /** `note`, `fast_path`, `override`, `default` — always all four, including the zeroes */
  kinds: RouteShare[];
  /** tier names the model routes named; `note` and `fast_path` reach no model and name none */
  tiers: RouteShare[];
  /** the named query each firing `fast_path` rule answered from — a rule has no name of its own in `rules.yaml` */
  rules: RouteShare[];
  /** fall-throughs by word count: ≤5, 6–15, 16–40, >40 — always all four */
  lengths: RouteShare[];
  /** the fifteen commonest opening words of the fall-throughs, `(other)` for anything not a plain word or a `/command` */
  first_words: RouteShare[];
  /** the line the verdict is drawn at, so `--json` does not have to guess it */
  threshold: number;
  verdict: { status: "ok" | "degraded" | "n/a"; line: string };
  /** the route record: what a local policy WOULD have chosen, in shadow (T9-1, docs/ops/dynamic-router.md §6) */
  policy: RoutePolicyReport;
}

/**
 * The policy's rows of `route_report` (docs/ops/dynamic-router.md §6): one
 * `runs` row of kind `route` per routed message, and what the policy did with
 * it. Every share here carries its own denominator, and they differ on
 * purpose — see each field.
 */
export interface RoutePolicyReport {
  /** false when the console's `route_report.yaml` predates the route record (no `policy_*` rows at all) — `metistry update` lands it */
  recorded: boolean;
  /** finished route rows in the window: one per routed message, /note and the fast path included */
  rows: number;
  /** of those, the ones the policy was (or, with no `policy:` block, would have been) consulted on — every row but /note and the fast path */
  consultations: number;
  /** the eight outcomes of §5, over `rows` — always all eight */
  outcomes: RouteShare[];
  /** which `table[].id` decided, plus `(no match)`, over chosen + no_match */
  table_rows: RouteShare[];
  /** each operation chosen, over `chosen` */
  operations: RouteShare[];
  /** `<served tier> → <chosen tier>`, over `chosen` — the disagreement matrix */
  tiers: RouteShare[];
  /** each `bounded_by` value, over `rows` */
  bounded_by: RouteShare[];
  /** on counterfactuals: did the policy pick the tier the owner picked */
  override: RouteShare[];
  /** `duration_ms` over the consultations that finished; null where there were none */
  latency: { p50_ms: number | null; p95_ms: number | null; over: number };
  /** per chosen tier, the stage-2 shadow runs on those messages and their mean agreement */
  shadow: Array<{ tier: string; turns: number; mean_agreement: number | null }>;
  /** policy-served turns followed within 10 minutes by an override to a higher tier or a re-ask — meaningful from T9-4 */
  miss: RouteShare | null;
  /** fewer than `MIN_ROUTED_FOR_A_READING` consultations: the section says widen --since */
  thin: boolean;
}

export interface RouteReportOptions extends ComputeOptions {
  /** `--since`: `7d`, `2w`, `3m`, or a bare number of days. Default 30 — §5.2 wants a real month of typing. */
  since?: string | undefined;
  /** this install's `instance_id` — the Keychain account the console's owner token is filed under */
  instanceId?: string | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_ROUTE_WINDOW_DAYS = 30; // §5.2: a month of real typing, where cache-report's question is answered by a week

/** The rows of one `row_kind`, in the order the query returned them, as shares. */
function sharesOf(rows: Record<string, unknown>[], kind: string): RouteShare[] {
  return rows
    .filter((r) => String(r.row_kind ?? "") === kind)
    .map((r) => ({ label: String(r.label ?? ""), n: numberOf(r.n), share: ratioOf(r.share), denominator: numberOf(r.denominator) }));
}

/**
 * The measurement. One console request; nothing is written, no model is
 * called, and no message body is read — the query returns counts, and this
 * turns them into the one number §5.2's exit rule is drawn on.
 */
export async function routeReport(opts: RouteReportOptions): Promise<RouteReport> {
  // the same strict spelling as `cache-report`, with a wider default: an
  // absent `--since` means 30 here, not `parseSince`'s 7.
  const days = parseSince(opts.since === undefined || opts.since.trim() === "" ? String(DEFAULT_ROUTE_WINDOW_DAYS) : opts.since);
  const res = await consoleCall({
    method: "GET",
    path: `/api/q/route_report?days=${days}`,
    env: opts.env,
    platform: opts.platform,
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    // a namespaced instance's console is on its own port (state/ports.yaml), never the default 8080
    instanceDir: opts.instanceDir,
    ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (res.status >= 400) {
    throw new StepFailed(
      `the console would not answer /api/q/route_report: ${renderConsoleCallError(res)}` +
        (res.status === 404 ? " — this install's seed/queries/ predates route_report.yaml; `metistry update` lands it" : ""),
    );
  }
  const body = (res.body ?? {}) as { rows?: unknown; as_of?: unknown };
  const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];

  const total = rows.find((r) => String(r.row_kind ?? "") === "total") ?? {};
  const routed = numberOf(total.routed);
  const fallThrough = numberOf(total.fall_through);
  const totals = {
    messages: numberOf(total.messages),
    routed,
    unrouted: numberOf(total.unrouted),
    fall_through: fallThrough,
    // over ROUTED, never over every message: a message the router never saw
    // is not evidence that the rules missed it (`route_report.yaml`).
    fall_through_share: routed > 0 ? Math.round((fallThrough / routed) * 1e4) / 1e4 : null,
    ...(typeof total.since === "string" ? { first_message: total.since } : {}),
    ...(typeof total.until === "string" ? { last_message: total.until } : {}),
  };

  return {
    since_days: days,
    ...(typeof body.as_of === "string" ? { as_of: body.as_of } : {}),
    policy: policyOf(rows),
    totals,
    kinds: sharesOf(rows, "kind"),
    tiers: sharesOf(rows, "tier"),
    rules: sharesOf(rows, "rule"),
    lengths: sharesOf(rows, "length"),
    first_words: sharesOf(rows, "first_word"),
    threshold: CLASSIFIER_FALL_THROUGH_THRESHOLD,
    verdict: routeVerdict(totals, days),
  };
}

/** The policy's rows, read off the same answer — no second request, no second source. */
function policyOf(rows: Record<string, unknown>[]): RoutePolicyReport {
  const outcomes = sharesOf(rows, "policy_outcome");
  const total = outcomes[0]?.denominator ?? 0;
  const notConsulted = outcomes.find((o) => o.label === "not_consulted")?.n ?? 0;
  const consultations = total - notConsulted;
  const latencyRows = rows.filter((r) => String(r.row_kind ?? "") === "policy_latency");
  const over = latencyRows.length > 0 ? numberOf(latencyRows[0]!.denominator) : 0;
  const ms = (label: string): number | null => {
    const r = latencyRows.find((x) => String(x.label ?? "") === label);
    return r && over > 0 ? numberOf(r.n) : null;
  };
  return {
    recorded: outcomes.length > 0,
    rows: total,
    consultations,
    outcomes,
    table_rows: sharesOf(rows, "policy_row"),
    operations: sharesOf(rows, "policy_operation"),
    tiers: sharesOf(rows, "policy_tier"),
    bounded_by: sharesOf(rows, "policy_bounded_by"),
    override: sharesOf(rows, "policy_override"),
    latency: { p50_ms: ms("p50"), p95_ms: ms("p95"), over },
    // `share` on these rows is the MEAN agreement, not n / denominator (route_report.yaml)
    shadow: rows
      .filter((r) => String(r.row_kind ?? "") === "policy_shadow")
      .map((r) => ({ tier: String(r.label ?? ""), turns: numberOf(r.n), mean_agreement: ratioOf(r.share) })),
    miss: sharesOf(rows, "policy_miss")[0] ?? null,
    thin: consultations < MIN_ROUTED_FOR_A_READING,
  };
}

/**
 * ONE line, and it is §5.2's exit rule with this install's number in it. Two
 * readings have to come before the rule, in this order, because a percentage
 * taken over silence or over a handful of messages would otherwise be quoted
 * back in a PR as a decision:
 *
 *   nothing routed  the console filed these messages with no ruleset loaded
 *                   (`server.ts:616`), so there is no routing decision to
 *                   measure — a wire finding, not a router one, exactly as
 *                   `cache-report` separates "the provider said nothing"
 *                   from "the cache missed".
 *   too few         under `MIN_ROUTED_FOR_A_READING` the number is reported
 *                   with the caveat attached rather than withheld: the owner
 *                   asked, and "widen the window" is the answer they need.
 */
function routeVerdict(totals: RouteReport["totals"], days: number): RouteReport["verdict"] {
  const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
  const cite = "docs/research/2026-09-21-intent-classification-tier.md §5.2";
  if (totals.messages === 0) {
    return { status: "n/a", line: `no messages in the last ${days}d — nothing to measure yet. Widen --since, or type at it for a while first (${cite}).` };
  }
  if (totals.routed === 0) {
    return {
      status: "n/a",
      line:
        `${totals.messages} messages in the last ${days}d and NOT ONE carries a routing decision. ` +
        `That is a configuration finding, not a router one: the console files a message with no \`route\` in its meta only when it loaded no ruleset at all ` +
        `(a missing or unreadable rules.yaml). Fix that before reading any share off this report.`,
    };
  }
  const share = totals.fall_through / totals.routed;
  const thin =
    totals.routed < MIN_ROUTED_FOR_A_READING
      ? ` On only ${totals.routed} routed message${totals.routed === 1 ? "" : "s"}, though — widen --since past ${days}d before acting on it.`
      : "";
  const unrouted = totals.unrouted > 0 ? ` (${totals.unrouted} more carried no routing decision and are excluded from the share.)` : "";
  if (share < CLASSIFIER_FALL_THROUGH_THRESHOLD) {
    return {
      status: "ok",
      line:
        `fall-through ${pct(share)} of ${totals.routed} routed messages, under the ~${pct(CLASSIFIER_FALL_THROUGH_THRESHOLD)} line — ` +
        `STOP HERE and write fast_path rules instead. An extra regex is free, auditable and self-documenting in the command menu, ` +
        `and the first-word and length rows above are the shortlist to write them from. PoC-20 phase 1 is not warranted on this reading (${cite}).${thin}${unrouted}`,
    };
  }
  return {
    status: "degraded",
    line:
      `fall-through ${pct(share)} of ${totals.routed} routed messages, over the ~${pct(CLASSIFIER_FALL_THROUGH_THRESHOLD)} line — ` +
      `the rules are not catching most of what gets typed, so PoC-20 phase 1 (answer-token scoring through the existing compute layer, no new dependency) ` +
      `is worth building. Write the obvious fast_path rules from the first-word rows first anyway; they are free (${cite}).${thin}${unrouted}`,
  };
}

const sharePct = (s: number | null): string => (s === null ? "-" : `${Math.round(s * 1000) / 10}%`);

/**
 * The route record's half of the report (T9-1): what a local policy would
 * have done, beside what the rules did. Until T9-2 there is no `policy:`
 * block, so every consultation reads `absent` and the section says exactly
 * that rather than printing seven tables of zeroes. A window with fewer than
 * `MIN_ROUTED_FOR_A_READING` consultations says "widen --since", as the
 * fall-through reading does.
 */
function renderPolicy(
  r: RouteReport,
  ui: Ui,
  lines: string[],
  section: (title: string, over: string, rows: RouteShare[], firstCol: string) => void,
): void {
  const p = r.policy;
  lines.push("");
  lines.push(ui.heading(`the policy, in shadow ${ui.dim("— docs/ops/dynamic-router.md")}`));
  if (!p.recorded) {
    lines.push(ui.wrap("This console's route_report predates the route record, so there is nothing to read here yet — `metistry update` lands it.", { indent: 2 }));
    return;
  }
  if (p.rows === 0) {
    lines.push(ui.wrap(`No route rows in the last ${r.since_days}d. The console writes one per routed message; messages filed before it did carry none.`, { indent: 2 }));
    return;
  }
  const absent = p.outcomes.find((o) => o.label === "absent")?.n ?? 0;
  const thin = p.thin ? ` Only ${p.consultations} consultation${p.consultations === 1 ? "" : "s"} — widen --since before reading a share off this.` : "";
  if (absent === p.consultations) {
    lines.push(
      ui.wrap(
        `${p.rows} route rows, ${p.consultations} of them consultations, and no \`policy:\` block in rules.yaml: every consultation is \`absent\` and the rules' default was served. ` +
          `The record is being kept; the table that would choose is not configured.${thin}`,
        { indent: 2 },
      ),
    );
    section("outcomes", "route rows", p.outcomes.filter((o) => o.n > 0), "outcome");
    return;
  }
  if (thin) lines.push(ui.wrap(thin.trim(), { indent: 2 }));
  section("outcomes", "route rows", p.outcomes, "outcome");
  section("table rows that decided", "chosen + no match", p.table_rows, "row");
  section("operations chosen", "chosen", p.operations, "operation");
  section("served tier → chosen tier", "chosen", p.tiers, "tiers");
  section("held by", "route rows", p.bounded_by, "bounded by");
  section("on the owner's overrides", "counterfactuals", p.override, "policy's tier");
  if (p.shadow.length > 0) {
    lines.push("");
    lines.push(ui.heading(`stage-2 shadow on the chosen tier ${ui.dim("— mean shadow_agreement")}`));
    lines.push(
      ui.table(
        ["chosen tier", "shadowed turns", "agreement"],
        p.shadow.map((s) => [s.tier, String(s.turns), s.mean_agreement === null ? "-" : s.mean_agreement.toFixed(3)]),
        { indent: 2, ragged: [] },
      ),
    );
  }
  lines.push("");
  lines.push(
    ui.kv(
      [
        ["latency", p.latency.p50_ms === null ? "-" : `p50 ${p.latency.p50_ms} ms, p95 ${p.latency.p95_ms} ms ${ui.dim(`(over ${p.latency.over} consultations)`)}`],
        ...(p.miss && p.miss.denominator > 0
          ? ([["misses", `${p.miss.n} of ${p.miss.denominator} policy-served turns ${ui.dim(`(${sharePct(p.miss.share)})`)}`]] as Array<[string, string]>)
          : []),
      ],
      { indent: 2 },
    ),
  );
}

/**
 * Five small tables rather than one wide one, because they are answers to
 * five different questions and three of them are taken over a different
 * population. Every table's header says what its share is OVER, so no
 * percentage on the screen is ambiguous. The verdict goes LAST, under the
 * evidence for it.
 */
export function renderRouteReport(r: RouteReport, ui: Ui = defaultUi()): string {
  const lines: string[] = [`router baseline, last ${r.since_days}d${r.as_of ? ui.dim(` (as of ${r.as_of})`) : ""}`];
  const section = (title: string, over: string, rows: RouteShare[], firstCol: string): void => {
    if (rows.length === 0) return;
    lines.push("");
    lines.push(ui.heading(`${title} ${ui.dim(`— share of ${over}`)}`));
    lines.push(
      ui.table(
        [firstCol, "messages", "share"],
        rows.map((s) => [s.label || ui.dim("(none)"), String(s.n), sharePct(s.share)]),
        { indent: 2, ragged: [] },
      ),
    );
  };

  if (r.totals.messages === 0) {
    lines.push("");
    lines.push(ui.wrap("No messages in this window. Nothing has been typed at the console for this long, or --since is shorter than the install is old.", { indent: 2 }));
    lines.push("");
    lines.push(`${ui.statusIcon(r.verdict.status)} ${ui.wrap(r.verdict.line, { hanging: 2 }).trimStart()}`);
    return lines.join("\n");
  }

  section("where messages went", "routed messages", r.kinds, "route");
  section("tiers named", "routed messages", r.tiers, "tier");
  section("fast_path rules that fired", "fast-path messages", r.rules, "answers from");
  section("fall-throughs by length", "fall-throughs", r.lengths, "words");
  section("fall-throughs by first word", "fall-throughs", r.first_words, "first word");

  lines.push("");
  lines.push(
    ui.kv(
      [
        [
          "messages",
          `${r.totals.messages} ${ui.dim(
            r.totals.unrouted > 0
              ? `(${r.totals.routed} carried a routing decision, ${r.totals.unrouted} did not — those are not fall-throughs)`
              : "(all of them carried a routing decision)",
          )}`,
        ],
        ["fall-through", `${r.totals.fall_through} of ${r.totals.routed} routed ${ui.dim(`(${sharePct(r.totals.fall_through_share)} — the number the exit rule is drawn on)`)}`],
        ...(r.totals.first_message && r.totals.last_message
          ? ([["window seen", `${r.totals.first_message.slice(0, 10)} → ${r.totals.last_message.slice(0, 10)}`]] as Array<[string, string]>)
          : []),
      ],
      { indent: 2 },
    ),
  );
  lines.push("");
  lines.push(`${ui.statusIcon(r.verdict.status)} ${ui.wrap(r.verdict.line, { hanging: 2 }).trimStart()}`);
  // the route record's half, after the baseline's verdict: that verdict is
  // about the RULES, and nothing below changes it
  renderPolicy(r, ui, lines, section);
  return lines.join("\n");
}
