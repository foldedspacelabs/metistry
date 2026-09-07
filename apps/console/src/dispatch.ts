// Compute-target dispatch (plan §4.18.B, Phase 5). A target is a directory
// with a manifest; this is the ONE tool through which a brief leaves the
// machine for one of them. The manifest's data_policy is enforced HERE —
// "comms-derived content never leaves the machine" is a refusal with a
// machine-readable reason, not a sentence in a prompt (CLAUDE.md: enforce
// at the tool, never by prompting).
//
// Every dispatch — refused or sent — is a two-phase `runs` row (CRIT-8)
// carrying the target's cost profile, so per-target spend is one query.
// The first transport is `github`: an issue in the configured repo is the
// external work queue (§6 decision 4); github-state reconciles its status
// back onto the same work row by `gh:owner/repo#n`.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  finishRun,
  runCheck,
  startRun,
  validateManifest,
  type CheckResult,
  type DataPolicy,
  type ErrorCode,
  type TargetManifest,
} from "@foldedspacelabs/metistry-core";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// --- data policy ------------------------------------------------------------

export type PolicyViolation =
  | { kind: "brief_too_large"; bytes: number; max_brief_bytes: number }
  | { kind: "denied_source"; sources: string[] }
  | { kind: "path_outside_allow"; paths: string[]; allow: string[] };

// A vault reference is any `Knowledge/...` token (plain, in a wikilink, in
// backticks, in a markdown link). Terminators are the characters that end
// one in prose or markup; trailing sentence punctuation is stripped after.
const VAULT_PATH = /Knowledge\/[^\s"'`()[\]<>|,;]+/g;
// Provenance markers as they occur in frontmatter (`source: comms`,
// `sources: [comms, x]`) or an inline stamp (`<!-- source: comms -->`).
const SOURCE_MARKER = /\bsources?\s*:\s*(\[[^\]\n]*\]|[A-Za-z][A-Za-z0-9_-]*)/g;

function pathAllowed(allow: string[], path: string): boolean {
  const segs = path.split("/");
  if (segs.includes("..") || segs.includes(".") || segs.includes("")) return false; // no traversal, no `//`
  return allow.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Pure policy check. Returns every violation found (empty = the brief may
 * go). `declaredSources` is the caller's own provenance claim for the
 * brief; the text is scanned for markers regardless, so an honest caller
 * and a sloppy one get the same answer.
 */
export function checkBrief(policy: DataPolicy, brief: string, declaredSources: string[] = []): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const bytes = Buffer.byteLength(brief, "utf8");
  if (bytes > policy.max_brief_bytes) {
    // too big to scan honestly — the size verdict alone is the answer
    return [{ kind: "brief_too_large", bytes, max_brief_bytes: policy.max_brief_bytes }];
  }

  const denied = new Set(policy.deny_sources);
  const hits = new Set<string>();
  const consider = (raw: string) => {
    const s = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (denied.has(s)) hits.add(s);
  };
  for (const s of declaredSources) consider(s);
  for (const m of brief.matchAll(SOURCE_MARKER)) {
    const raw = m[1]!;
    if (raw.startsWith("[")) for (const n of raw.slice(1, -1).split(",")) consider(n);
    else consider(raw);
  }
  if (hits.size > 0) out.push({ kind: "denied_source", sources: [...hits].sort() });

  const outside = new Set<string>();
  for (const m of brief.matchAll(VAULT_PATH)) {
    const p = m[0].replace(/[.,:;!?]+$/, "");
    if (!pathAllowed(policy.allow, p)) outside.add(p);
  }
  if (outside.size > 0) out.push({ kind: "path_outside_allow", paths: [...outside].sort(), allow: policy.allow });
  return out;
}

// --- registry -----------------------------------------------------------------

export interface TargetRegistryOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export interface TargetDescription {
  name: string;
  description?: string;
  transport: TargetManifest["transport"];
  submit: Record<string, unknown>;
  result: Record<string, unknown>;
  auth?: string;
  cost?: TargetManifest["cost"];
  data_policy: DataPolicy;
  check: CheckResult;
}

/** `env:VAR` → the variable's value (undefined when unset/empty); anything else is literal. */
export function resolveRef(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (!value.startsWith("env:")) return value;
  const v = env[value.slice(4)];
  return v === undefined || v === "" ? undefined : v;
}

const GITHUB_API = "https://api.github.com";

export class TargetRegistry {
  private readonly targets = new Map<string, TargetManifest>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;

  constructor(opts: TargetRegistryOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Validate and register one manifest; a later add with the same name replaces (D4 overlay). Throws on an invalid manifest. */
  add(input: unknown, where = "(inline)"): TargetManifest {
    const r = validateManifest(input);
    if (!r.ok) throw new Error(`${where}: invalid manifest: ${r.errors.join("; ")}`);
    if (r.manifest.type !== "target") throw new Error(`${where}: not a target (type ${r.manifest.type})`);
    this.targets.set(r.manifest.name, r.manifest);
    return r.manifest;
  }

  /** Load every `<dir>/<name>/manifest.yaml`. A missing dir is skipped (instance overlay dirs are optional). Returns the names loaded. */
  async loadDir(dir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    const loaded: string[] = [];
    for (const name of entries.sort()) {
      const file = join(dir, name, "manifest.yaml");
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") continue; // a directory without a manifest is not a target
        throw err;
      }
      const m = this.add(parseYaml(text), file);
      if (m.name !== name) throw new Error(`${file}: manifest name "${m.name}" must match its directory "${name}"`);
      loaded.push(m.name);
    }
    return loaded;
  }

  names(): string[] {
    return [...this.targets.keys()].sort();
  }

  get(name: string): TargetManifest | undefined {
    return this.targets.get(name);
  }

  /** Resolved github config, or the reason it is unavailable. */
  private github(m: TargetManifest): { ok: true; token: string; repo: string } | { ok: false; remediation: string } {
    const token = resolveRef(m.auth, this.env);
    const repo = resolveRef(m.submit.repo, this.env);
    if (!token) {
      return {
        ok: false,
        remediation: `set ${String(m.auth)} (fine-grained PAT: Issues read/write + Metadata on the target repo only — docs/ops/targets.md)`,
      };
    }
    if (!repo) return { ok: false, remediation: `set ${String(m.submit.repo)} to owner/repo` };
    return { ok: true, token, repo };
  }

  private ghHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "metistry-dispatch",
    };
  }

  /** Behavioral probe (Phase 0 rule 3): unset config → absent; set → the repo is actually readable with the write token. */
  async check(name: string): Promise<CheckResult> {
    const m = this.targets.get(name);
    if (!m) return { name, status: "absent", latency_ms: 0, probe: "registry lookup", remediation: "no such target" };
    if (m.transport === "local") {
      // crews (docs/ops/crews.md): dispatched by the assistant's crew_dispatch tool, run by the assistant
      // container's drain loop. Loaded + policy-checkable here; the runner itself is not probed from the console.
      return runCheck(name, "manifest loaded; dispatch is the assistant's crew_dispatch tool (runner in the assistant container, not probed here)", async () => ({
        meta: { via: "crew_dispatch", submit: m.submit, result: m.result },
      }));
    }
    if (m.transport !== "github") {
      return runCheck(name, `dispatcher for transport ${m.transport}`, async () => ({
        status: "absent",
        remediation: `transport ${m.transport} has no dispatcher in this console yet`,
      }));
    }
    const gh = this.github(m);
    if (!gh.ok) {
      return runCheck(name, "resolve auth + submit.repo from environment", async () => ({ status: "absent", remediation: gh.remediation }));
    }
    return runCheck(name, `GET /repos/${gh.repo} with the write token (issue creation itself is not probed)`, async () => {
      const res = await this.fetchFn(`${GITHUB_API}/repos/${gh.repo}`, {
        headers: this.ghHeaders(gh.token),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`github HTTP ${res.status} — check the token's repository access and Metadata permission`);
      return { meta: { repo: gh.repo } };
    });
  }

  /** Every target with its live check — the GET /api/targets payload. */
  async describe(): Promise<TargetDescription[]> {
    const out: TargetDescription[] = [];
    for (const name of this.names()) {
      const m = this.targets.get(name)!;
      out.push({
        name: m.name,
        ...(m.description !== undefined ? { description: m.description } : {}),
        transport: m.transport,
        submit: m.submit,
        result: m.result,
        ...(m.auth !== undefined ? { auth: m.auth } : {}),
        ...(m.cost !== undefined ? { cost: m.cost } : {}),
        data_policy: m.data_policy,
        check: await this.check(name),
      });
    }
    return out;
  }

  /** Open the issue. Exposed for the dispatcher only. */
  async submitGithub(m: TargetManifest, title: string, body: string): Promise<{ ref: string; url: string }> {
    const gh = this.github(m);
    if (!gh.ok) throw new Error(`target ${m.name} unavailable: ${gh.remediation}`);
    const res = await this.fetchFn(`${GITHUB_API}/repos/${gh.repo}/issues`, {
      method: "POST",
      headers: { ...this.ghHeaders(gh.token), "content-type": "application/json" },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`github ${gh.repo} issues: HTTP ${res.status}`);
    const issue = (await res.json()) as { number: number; html_url: string };
    return { ref: `gh:${gh.repo}#${issue.number}`, url: issue.html_url };
  }

  available(m: TargetManifest): boolean {
    return m.transport === "github" && this.github(m).ok;
  }
}

// --- dispatch ------------------------------------------------------------------

export type DispatchResult =
  | { ok: true; ref: string; url: string; run_id: number }
  | { ok: false; code: ErrorCode; message: string; violations?: PolicyViolation[]; check?: CheckResult };

/** The trailer every dispatched brief carries: who sent it, and how the result gets home. Names no assistant. */
export function returnFooter(taskId: number, target: string): string {
  return [
    "---",
    `_Dispatched from metistry — task #${taskId} via target \`${target}\`._`,
    `_Return path: closing this issue closes task #${taskId} on the next \`github-state\` reconcile. A closing comment is not read back yet (see \`targets/${target}/manifest.yaml\`, \`result:\`)._`,
  ].join("\n");
}

/**
 * Send a task's brief to a target. `principal` is the SERVER-SIDE identity
 * the adapter derived from the credential (§4.19) — it is written to the
 * task's history, never read from the request. `sources` is the caller's
 * declared provenance for the brief (checked on top of the text scan).
 */
export async function dispatch(
  db: Db,
  registry: TargetRegistry,
  taskId: number,
  targetName: string,
  brief: string,
  principal: string,
  sources: string[] = [],
): Promise<DispatchResult> {
  const target = registry.get(targetName);
  if (!target) return { ok: false, code: "not_found", message: "unknown target" };
  if (!Number.isInteger(taskId) || taskId <= 0) return { ok: false, code: "not_found", message: "no such task" };

  const { rows } = await db.query(`SELECT id, title, status, external_ref FROM work WHERE id = $1`, [taskId]);
  const task = rows[0] as { id: string | number; title: string; status: string; external_ref: string | null } | undefined;
  if (!task) return { ok: false, code: "not_found", message: "no such task" };
  if (task.external_ref) return { ok: false, code: "conflict", message: `task already bound to ${task.external_ref}` };
  if (task.status === "closed") return { ok: false, code: "conflict", message: "task is closed" };

  // Refusals are runs rows too: the safety mechanism must be visible, not silent.
  const runId = await startRun(db, {
    component: "console",
    kind: "dispatch",
    tool: target.name,
    meta: { target: target.name, task: taskId, principal, brief_bytes: Buffer.byteLength(brief, "utf8") },
  });

  const violations = checkBrief(target.data_policy, brief, sources);
  if (violations.length > 0) {
    await finishRun(db, runId, { ok: false, error: `data_policy: ${violations.map((v) => v.kind).join(",")}`, meta: { violations } });
    return { ok: false, code: "invalid_request", message: "brief violates the target's data policy", violations };
  }

  if (target.transport !== "github") {
    await finishRun(db, runId, { ok: false, error: `transport ${target.transport} not dispatchable` });
    // a local target is a crew's: it is dispatched by the assistant's crew_dispatch tool (apps/console/src/crews.ts), never by this route
    const message = target.transport === "local" ? `transport local is dispatched by the assistant's crew_dispatch tool, not by this route (docs/ops/crews.md)` : `transport ${target.transport} has no dispatcher in this console yet`;
    return { ok: false, code: "invalid_request", message };
  }

  if (!registry.available(target)) {
    const check = await registry.check(target.name); // degrades absent: the check carries the remediation
    await finishRun(db, runId, { ok: false, error: "target unavailable", meta: { check } });
    return { ok: false, code: "conflict", message: "target unavailable", check };
  }

  let submitted: { ref: string; url: string };
  try {
    submitted = await registry.submitGithub(target, task.title, `${brief.trimEnd()}\n\n${returnFooter(taskId, target.name)}\n`);
  } catch (err) {
    await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "internal", message: "target submission failed" };
  }

  // Bind the ref (github-state upserts onto this row from now on) and hold
  // the task for the target: claimed with no lease = held until the source
  // closes it (packages/tasks treats a NULL lease as never expiring).
  const entry = JSON.stringify([{ ts: new Date().toISOString(), agent: principal, op: "dispatch", note: `${target.name} → ${submitted.ref}` }]);
  let bound = 0;
  try {
    const upd = await db.query(
      `UPDATE work SET external_ref = $2, status = 'in_progress', claimed_by = $3, lease_expires_at = NULL,
         history = history || $4::jsonb, updated_at = now()
       WHERE id = $1 AND external_ref IS NULL RETURNING id`,
      [taskId, submitted.ref, `target:${target.name}`, entry],
    );
    bound = upd.rows.length;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err; // unique_violation on external_ref: the ref landed elsewhere first
  }
  if (bound !== 1) {
    await finishRun(db, runId, { ok: false, error: "task changed during dispatch", meta: submitted });
    return { ok: false, code: "conflict", message: `task changed during dispatch; ${submitted.ref} was created` };
  }

  await finishRun(db, runId, {
    ok: true,
    ...(target.cost ? { cost_usd: target.cost.per_run_estimate_usd } : {}),
    meta: { ref: submitted.ref, url: submitted.url },
  });
  return { ok: true, ...submitted, run_id: runId };
}
