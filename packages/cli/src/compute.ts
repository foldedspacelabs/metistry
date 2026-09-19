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
//   * A secret value never reaches an argument. `--secret` names a
//     variable; the value is read from stdin into the login Keychain under
//     the USER account (C6: provider secrets are the person's, shared by
//     every instance on this Mac), and nothing here can print one.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, parse as parseYaml } from "yaml";
import {
  BUDGET_ACTIONS,
  COMPUTE_FILENAME,
  instanceFile,
  PROVIDER_NAME_RE,
  SECRET_NAME_RE,
  loadCompute,
  modelRefIssue,
  parseCompute,
  parseModelRef,
  providerSchema,
  type Budget,
  type BudgetAction,
  type Compute,
  type Effort,
  type Provider,
} from "@foldedspacelabs/metistry-core";
import { readStdin } from "./connect-repo.js";
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
import { Keychain, keychainAccount, serviceFor } from "./keychain.js";
import { protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";
import { defaultUi, type Ui } from "./ui.js";

/**
 * The provider blocks `seed/compute-templates/` ships. A name that is not one
 * of these is a typo, never a guess. **One cloud template only** (OPEN-7,
 * ruled 2026-09-17): every other OpenAI-compatible cloud — OpenCode Zen
 * included — is reached with `--base-url`, or by writing the block by hand.
 */
export const COMPUTE_TEMPLATES = ["openrouter", "lmstudio", "ollama", "llamaserver", "applefm"] as const;
export type ComputeTemplate = (typeof COMPUTE_TEMPLATES)[number];

export function parseTemplate(v: string | undefined): ComputeTemplate | undefined {
  return (COMPUTE_TEMPLATES as readonly string[]).includes(v ?? "") ? (v as ComputeTemplate) : undefined;
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

/** The login Keychain under the USER account: a provider credential belongs to the person, not to one instance (C6). */
function providerKeychain(opts: ComputeOptions): Keychain {
  return new Keychain(opts.exec ?? realExec, keychainAccount(opts.env));
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
  /** the NAME of the secret this provider authenticates with, never its value */
  secret?: string;
  /** whether an item of that name exists in the login Keychain — presence only */
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
  const kc = opts.platform === "darwin" ? providerKeychain(opts) : undefined;

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
    providers.push({
      name,
      kind: p.kind,
      locality: p.locality,
      base_url: p.base_url,
      zdr: p.zdr,
      ...(p.auth ? { secret: p.auth.secret, secret_present: kc ? await kc.hasSecret(p.auth.secret) : false } : {}),
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

export function renderComputeReport(r: ComputeReport): string {
  const lines: string[] = [];
  lines.push(r.file ? `compute: ${r.file} (overlay: ${r.files.join(" → ")}, last existing wins)` : `compute: none of ${r.files.join(", ")} exists yet`);
  lines.push(`this instance's file: ${r.instance_file}`);
  lines.push("");
  lines.push(
    ...table(
      ["provider", "locality", "base_url", "zdr", "secret", "budget"],
      r.providers.map((p) => [
        p.name,
        p.locality,
        p.base_url,
        p.zdr === undefined ? "-" : p.zdr ? "yes" : "no",
        p.secret ? `${p.secret} ${p.secret_present ? "(in Keychain)" : "(MISSING)"}` : "-",
        p.budget ? `${money(p.budget.daily_usd)}/day ${money(p.budget.monthly_usd)}/mo ${p.budget.action}` : "-",
      ]),
    ),
  );
  if (r.providers.length === 0) lines.push(`(no providers — \`metistry compute providers add --from ${COMPUTE_TEMPLATES.join("|")}\`)`);
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
  lines.push("Not wired yet: nothing dials a provider, counts a token or enforces a budget — that is the engine (docs/ops/compute.md).");
  return lines.join("\n");
}

// ---- providers add / remove --------------------------------------------------

export interface ProvidersAddOptions extends ComputeOptions {
  template: ComputeTemplate;
  /** the name this provider gets in the file; default = the template's own */
  name?: string | undefined;
  baseUrl?: string | undefined;
  /** the NAME of the Keychain item (never a value) */
  secret?: string | undefined;
  /** skip the live `/models` probe this normally ends with */
  skipTest?: boolean | undefined;
}

export interface ProvidersAddResult {
  name: string;
  provider: Provider;
  /** the secret's NAME, when this provider authenticates */
  secret?: string;
  /** what happened to it: stored from stdin, already there, or none needed */
  secretStatus: "stored" | "present" | "none" | "skipped";
  test?: ProviderTestResult;
  delivery: ProtectedWrite;
}

/** One template file: a map of exactly one provider name → block. */
export async function readTemplate(seedDir: string, template: ComputeTemplate): Promise<{ name: string; block: Record<string, unknown> }> {
  const path = join(seedDir, "compute-templates", `${template}.yaml`);
  if (!existsSync(path)) throw new StepFailed(`no template at ${path} — set METISTRY_PRODUCT_DIR to a Metistry checkout (or pass --product-dir)`);
  const parsed = (parseYaml(await readFile(path, "utf8")) ?? {}) as Record<string, unknown>;
  const [name, block] = Object.entries(parsed)[0] ?? [];
  if (!name || typeof block !== "object" || block === null) throw new StepFailed(`${path} is not a provider template (one top-level <name>: block expected)`);
  return { name, block: block as Record<string, unknown> };
}

export async function providersAdd(opts: ProvidersAddOptions): Promise<ProvidersAddResult> {
  const { name: templateName, block } = await readTemplate(opts.seedDir, opts.template);
  const name = opts.name ?? templateName;
  if (!PROVIDER_NAME_RE.test(name)) throw new StepFailed(`--name ${JSON.stringify(name)} is not a provider name (lowercase, digits, - and _, starting with a letter)`);
  if (opts.baseUrl !== undefined) block.base_url = opts.baseUrl;
  if (opts.secret !== undefined) {
    if (!SECRET_NAME_RE.test(opts.secret)) throw new StepFailed(`--secret takes the NAME of a secret (UPPER_SNAKE_CASE, e.g. METISTRY_OPENROUTER_API_KEY), never the key itself — ${JSON.stringify(opts.secret)} is not a name`);
    block.auth = { secret: opts.secret };
  }
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

  // The value: stdin → the login Keychain, user account. Before the write,
  // so a run that cannot store the credential does not leave a provider in
  // the file with nothing behind it.
  let secretStatus: ProvidersAddResult["secretStatus"] = "none";
  if (provider.auth) {
    const varName = provider.auth.secret;
    if (opts.env[varName]) {
      // Already in this install's environment: nothing to ask for, nothing
      // to store. The normal case for a provider that IS one of Metistry's
      // own bridges — `applefm` authenticates with
      // METISTRY_BRIDGE_TOKEN_APPLE_FM, an instance-scope secret this
      // install already holds. Prompting would be asking the operator to
      // paste back a value we minted.
      opts.out(`${varName} is already set in this install's environment — nothing to store (\`metistry secrets list\` says where it lives).`);
      secretStatus = "present";
    } else if (opts.platform !== "darwin") {
      opts.out(`no login Keychain on ${opts.platform}: put ${varName} in this install's environment yourself (docs/ops/compute.md).`);
      secretStatus = "skipped";
    } else {
      const kc = providerKeychain(opts);
      if (await kc.hasSecret(varName)) {
        opts.out(`${varName} is already in the login Keychain under account ${kc.account} — left as it is (\`metistry compute providers test ${name}\` proves it works).`);
        secretStatus = "present";
      } else if (opts.dryRun === true) {
        opts.out(`[dry-run] would ask for ${varName} on stdin and store it under Keychain account ${kc.account}`);
        secretStatus = "skipped";
      } else {
        opts.out(`paste the ${name} API key, then Ctrl-D (read from stdin, never echoed, never in argv):`);
        const value = (await (opts.readSecret ?? readStdin)()).trim();
        if (!value) throw new StepFailed(`no key on stdin — ${edit.path} was NOT changed`);
        await kc.setSecret(varName, value);
        opts.out(`stored ${varName} in the login Keychain under account ${kc.account} (user scope: a provider credential is yours, shared by every instance on this Mac).`);
        secretStatus = "stored";
      }
    }
  }

  const { delivery } = await commit(opts, edit, `metistry compute providers add ${name} (--from ${opts.template})`);
  const test = opts.skipTest === true || opts.dryRun === true ? undefined : await providerTest({ ...opts, name }).catch((e) => ({ name, ok: false, listingOk: false, url: provider.base_url, detail: e instanceof Error ? e.message : String(e), models: [] }) as ProviderTestResult);
  return { name, provider, ...(provider.auth ? { secret: provider.auth.secret } : {}), secretStatus, ...(test ? { test } : {}), delivery };
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
  const { delivery } = await commit(opts, edit, `metistry compute providers remove ${opts.name}`);
  opts.out(`the ${opts.name} secret (if any) is left in the login Keychain — \`metistry secrets\` is the only thing that deletes one.`);
  return { name: opts.name, delivery };
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

/** The bearer for a provider, from the login Keychain. Returns undefined for a provider that declares no auth; throws when the item is missing, naming the variable and not its value. */
async function bearerFor(opts: ComputeOptions, name: string, provider: Provider): Promise<string | undefined> {
  if (!provider.auth) return undefined;
  const varName = provider.auth.secret;
  const fromEnv = opts.env[varName];
  if (fromEnv) return fromEnv;
  if (opts.platform !== "darwin") throw new StepFailed(`${varName} is not in this environment and there is no login Keychain on ${opts.platform} — export it before running this`);
  const value = await providerKeychain(opts).getSecret(varName);
  if (!value) {
    throw new StepFailed(`providers.${name}.auth.secret names ${varName}, which is not in the login Keychain under account ${keychainAccount(opts.env)} — \`metistry compute providers add --from <template> --name ${name} --secret ${varName}\` stores it (or \`security add-generic-password -a ${keychainAccount(opts.env)} -s ${serviceFor(varName)} -w\`)`);
  }
  return value;
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

export function renderModelsList(r: ModelsListResult): string {
  const lines: string[] = [];
  if (r.providers.length === 0) {
    lines.push(`no providers declared — \`metistry compute providers add --from ${COMPUTE_TEMPLATES.join("|")}\``);
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
  opts.out("Recorded. Nothing enforces it yet — budgets are checked in the engine, before the call (docs/ops/compute.md).");
  return { target: path.join("."), ...(daily === undefined ? {} : { daily_usd: daily }), ...(monthly === undefined ? {} : { monthly_usd: monthly }), action: opts.action, delivery };
}
