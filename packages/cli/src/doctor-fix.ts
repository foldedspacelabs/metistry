// `metistry doctor` repairs what it finds (X-123).
//
// The owner's ruling, 2026-10-04: "regardless of the problems found, the user
// only needs to run `metistry doctor` to fix it". So doctor's purpose is
// repair, not a status pane. Every row `doctor()` returns is classified —
// fixable (doctor does it), your hand (the owner does it; the row says exactly
// what), informational (a fact, not a fault) — and plain `doctor` in a
// terminal applies every fixable row's fix, then checks once more and says
// before → after. `--check` is the read-only run `up`, `update`, CI and the
// Mac app's refresh use; `--fix` is the repair run without a terminal.
//
// What holds the line, enforced here and not by any sentence:
//
//   * A fix is an id in a CLOSED table (`RepairId`, doctor.ts) mapped to one
//     function below, each an existing audited service — `metistry restart`,
//     the migration runner, `up`'s render, `update`'s steps — run through the
//     same `StepRunner` as `up`'s and `update`'s steps. No new shell-out, no
//     raw git, nothing a row's prose could add (invariants 9 and 10).
//   * A `hand` row applies nothing. An `info` row applies nothing.
//   * A destructive or disruptive fix (it moves files, or restarts a running
//     service) previews and asks first; `--yes` skips the question and is
//     never the default. Without a terminal and without `--yes` it is listed
//     and left, and the run exits non-zero.
//   * One pass, never a loop: each fix runs at most once per invocation, the
//     re-check fixes nothing, and a restart-class fix is not repeated within
//     the restart window across invocations — the local fix log is the
//     evidence, and after one try the row is the owner's, with the log.
//   * Every fix is audited: the `$ argv` lines a terminal shows are the
//     runner's, as `up`'s are, and each fix is appended to
//     `.metistry/state/doctor-fixes.jsonl` (0600; names, never a value).
//   * Doctor never starts what the owner stopped (doctor.ts `classifyRows`),
//     never mints or rotates a credential, never changes a declaration.

import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { instanceStatePath, intEnv, type CheckResult, type KeychainBackend } from "@foldedspacelabs/metistry-core";
import { writeCliShim } from "./cli-shim.js";
import { describeProduct, doctor, type DoctorDeps, type DoctorReport, type DoctorRow, type FixClass, type Repair, type RepairId } from "./doctor.js";
import type { StartedAt } from "./doctor-grace.js";
import { realExec, type Exec } from "./exec.js";
import type { Ask } from "./init.js";
import { labelFor } from "./launchd.js";
import { loadNamespace } from "./namespace.js";
import { migrateInbox } from "./migrate-inbox.js";
import { migrateLayout } from "./migrate-layout.js";
import { openMigrationSession, runMigrations, MIGRATION_LOCK_KEY, type MigrationSession } from "./migrate.js";
import { controlServices } from "./service-control.js";
import { StepRunner } from "./steps.js";
import { defaultUi, statusName, type Ui } from "./ui.js";
import { instanceLock, up, type UpOptions, type UpResult } from "./up.js";
import { seedTemplates, updateSharedScope } from "./update.js";
import { renameCaseMismatches } from "./vault-case.js";

/** `--check`: read-only, exactly the report. `--fix`: apply, re-check once. */
export type DoctorMode = "check" | "fix";

/**
 * Which mode a doctor invocation runs in. The flags decide outright; a bare
 * `doctor` repairs when a person is at a terminal to be asked, and is `--check`
 * otherwise — so every script, agent and the Mac app's refresh that runs
 * `metistry doctor` or `doctor --json` today stays read-only by construction,
 * and the only way to repair without a terminal is to say `--fix`.
 */
export function doctorMode(o: { check: boolean; fix: boolean; interactive: boolean }): DoctorMode {
  if (o.check) return "check";
  if (o.fix) return "fix";
  return o.interactive ? "fix" : "check";
}

/** How long a restart-class fix (`restart`, `render`) is not repeated for the same target (METISTRY_DOCTOR_RESTART_WINDOW_MIN). */
export const DEFAULT_RESTART_WINDOW_MIN = 30;

export function restartWindowMs(env: NodeJS.ProcessEnv): number {
  return intEnv("METISTRY_DOCTOR_RESTART_WINDOW_MIN", DEFAULT_RESTART_WINDOW_MIN, env) * 60_000;
}

/** The fix log's file name, under `.metistry/state/` — derived state (invariant 1), 0600. */
export const FIX_LOG_FILENAME = "doctor-fixes.jsonl";

export function fixLogPath(stateRoot: string): string {
  return instanceStatePath(stateRoot, FIX_LOG_FILENAME);
}

export type FixOutcome =
  /** ran, and the re-check cleared every row it was for */
  | "fixed"
  /** ran without error, and a row it was for is still a finding — "tried X; still failing" */
  | "applied"
  /** the fix itself threw: the row stays as it was, with the error */
  | "failed"
  /** a confirm-class fix the person said no to */
  | "declined"
  /** a confirm-class fix with nobody to ask and no `--yes`: previewed, not run */
  | "needs_confirm";

/** One fix of one run: what, for which rows, what it did, how it went. Also the shape of a fix-log line. */
export interface FixRecord {
  id: RepairId;
  target?: string;
  /** the row names this fix was for */
  rows: string[];
  does: string;
  confirm: boolean;
  outcome: FixOutcome;
  /** every command and action the fix ran, in order — the runner's ledger, the same lines a terminal showed */
  steps: string[];
  error?: string;
  before: Record<string, CheckResult["status"]>;
  after?: Record<string, CheckResult["status"]>;
}

/** A fix-log line: a FixRecord plus when. */
export interface FixLogEntry extends FixRecord {
  at: string;
}

export interface DoctorRunReport extends DoctorReport {
  mode: DoctorMode;
  /** fix mode only: what ran, in order, and how each went */
  fixes?: FixRecord[];
}

/** A fix's implementation: runs through `ctx.runner`, throws on failure. */
export type FixRunner = (ctx: FixContext, repair: Repair) => Promise<void>;

export interface FixContext {
  runner: StepRunner;
  /** the product dir doctor was given — a release install's root (holding `releases/` and `current`) or a checkout */
  productDir: string;
  /** the directory doctor read the manifests, seed and migrations from (`current` for a release) */
  readDir: string;
  instanceDir: string | undefined;
  env: NodeJS.ProcessEnv;
  exec: Exec;
  platform: NodeJS.Platform;
  uid: number;
  home: string | undefined;
  fetchFn: typeof fetch;
  out: (line: string) => void;
  openSession: (env: NodeJS.ProcessEnv) => Promise<(MigrationSession & { end(): Promise<void> }) | null>;
  keychain?: KeychainBackend | undefined;
  upFn: (opts: UpOptions) => Promise<UpResult>;
}

/** What `applyFixes` needs beyond `doctor()`'s own deps — all optional, every one a seam a test fills with a fake. */
export interface DoctorRunDeps extends DoctorDeps {
  home?: string | undefined;
  /** test seam: the fix implementations, by id (default: the real ones below) */
  fixers?: Partial<Record<RepairId, FixRunner>> | undefined;
  /** test seam: `up`, for the `render` fix */
  upFn?: ((opts: UpOptions) => Promise<UpResult>) | undefined;
  /** test seam: the single-session db handle the `migrate` fix (and the layout and inbox migrations) open */
  openSession?: ((env: NodeJS.ProcessEnv) => Promise<(MigrationSession & { end(): Promise<void> }) | null>) | undefined;
  /** the fix log (default `<instance>/.metistry/state/doctor-fixes.jsonl`) */
  fixLogPath?: string | undefined;
}

export interface ApplyOptions {
  deps: DoctorRunDeps;
  /** test seam: the re-check (default `doctor`) */
  doctorFn?: ((deps: DoctorDeps) => Promise<DoctorReport>) | undefined;
  /** `--yes`: a confirm-class fix runs without the question */
  yes: boolean;
  /** asks one y/N question per confirm-class fix; undefined = nobody to ask (no terminal, or `--json`), so such a fix needs `--yes` */
  ask?: Ask | undefined;
  out: (line: string) => void;
  ui?: Ui | undefined;
}

// ---- the closed table -----------------------------------------------------------------------

/**
 * Fixes run in dependency order (rule 8): what the rest reads first — the
 * database, then its schema, then the render every job comes from, then the
 * supervisor, then everything the supervisor runs, then the files.
 */
const ORDER: readonly RepairId[] = ["restart", "migrate", "render", "cli_shim", "seed_templates", "vault_case", "migrate_scope", "migrate_layout", "migrate_inbox"];

/** `restart` targets in the order they are restarted: the db before the schema's readers, the supervisor before its children. */
function restartRank(target: string | undefined): number {
  if (target === "db") return 0;
  if (target === "supervisor") return 1;
  return 2;
}

/** A fix's key: one run per id and target, however many rows asked for it. */
export function fixKey(r: Pick<Repair, "id" | "target">): string {
  return r.target ? `${r.id}:${r.target}` : r.id;
}

/** `restart` and `render` bounce a process; they are the fixes rule 5 holds to once per window. */
const isRestartClass = (id: RepairId): boolean => id === "restart" || id === "render";

/** The table itself — exported so a test can hold each entry to its service; nothing else reaches in. */
export const FIXERS: Record<RepairId, FixRunner> = {
  // `metistry restart <target>`: the supervisor's control socket for a child,
  // `launchctl kickstart -k` for an agent, `docker compose restart` for a
  // container — service-control.ts decides, from the shape, as the verb does.
  restart: async (ctx, repair) => {
    const res = await controlServices({
      action: "restart",
      names: [repair.target!],
      productDir: ctx.productDir,
      env: ctx.env,
      exec: ctx.exec,
      out: ctx.out,
      platform: ctx.platform,
      uid: ctx.uid,
      home: ctx.home,
    });
    for (const c of res.commands) ctx.runner.commands.push(c);
    const bad = res.results.filter((x) => !x.ok);
    if (bad.length > 0) throw new Error(bad.map((x) => `${x.service}: ${x.detail}`).join("; "));
  },
  // `update`'s migration step ALONE — the same idempotent runner under the
  // same advisory lock, one transaction per file (migrate.ts). Never the rest
  // of `update`, and never `pnpm db:migrate`, which a release install lacks.
  migrate: async (ctx) => {
    const migrationsDir = join(ctx.readDir, "db", "migrations");
    if (!ctx.runner.action(`apply db/migrations/*.sql not yet in schema_migrations under pg_advisory_lock(${MIGRATION_LOCK_KEY}), one transaction each`)) return;
    const session = await ctx.openSession(ctx.env);
    if (!session) throw new Error("METISTRY_DB_PASSWORD is unset — nothing to connect with");
    try {
      const r = await runMigrations(session, migrationsDir, (l) => ctx.runner.note(l));
      ctx.runner.note(`migrations: ${r.applied.length} applied, ${r.files.length} total`);
    } finally {
      await session.end().catch(() => {});
    }
  },
  // `up`, inside doctor exactly as `update` runs it inside itself: on this
  // runner, with the lock's product source, and without `up`'s own closing
  // doctor (the re-check below is that). One renderer, never a second copy.
  render: async (ctx) => {
    const lock = await instanceLock(ctx.env);
    const res = await ctx.upFn({
      productDir: ctx.productDir,
      env: ctx.env,
      exec: ctx.exec,
      platform: ctx.platform,
      uid: ctx.uid,
      home: ctx.home,
      fetchFn: ctx.fetchFn,
      within: { runner: ctx.runner, source: lock?.product.source ?? "git", version: lock?.product.version },
    });
    if (res.code !== 0) throw new Error(`\`metistry up\` exited ${res.code}; its output is above`);
  },
  cli_shim: async (ctx) => {
    await writeCliShim(ctx.runner, ctx.productDir, ctx.instanceDir);
  },
  // `update`'s step: files the vault lacks are copied, a file the owner has is
  // never touched. It names what it could not write on the runner rather than
  // throwing (as inside `update`), so a template still missing after it ran is
  // the re-check's finding — "tried; still failing", with the step's own line.
  seed_templates: async (ctx) => {
    await seedTemplates(ctx.runner, { seedDir: join(ctx.readDir, "seed"), instanceDir: ctx.instanceDir, env: ctx.env, platform: ctx.platform, uid: ctx.uid, fetchFn: ctx.fetchFn });
  },
  vault_case: async (ctx) => {
    const r = await renameCaseMismatches(ctx.runner, { seedDir: join(ctx.readDir, "seed"), instanceDir: ctx.instanceDir, env: ctx.env, platform: ctx.platform, uid: ctx.uid, fetchFn: ctx.fetchFn });
    if (r.left.length > 0) throw new Error(r.left.map((m) => `${m.actual}: ${m.why}`).join("; "));
  },
  migrate_scope: async (ctx) => {
    const envFile = ctx.instanceDir ? instanceStatePath(ctx.instanceDir, ".env") : undefined;
    await updateSharedScope(ctx.runner, { instanceDir: ctx.instanceDir, envFile, exampleFile: join(ctx.readDir, ".env.example"), env: ctx.env, platform: ctx.platform, uid: ctx.uid, fetchFn: ctx.fetchFn, exec: ctx.exec, keychain: ctx.keychain });
  },
  migrate_layout: async (ctx) => {
    if (!ctx.instanceDir) throw new Error("no METISTRY_INSTANCE_DIR — no instance to migrate");
    const r = await migrateLayout({ instanceDir: ctx.instanceDir, env: ctx.env, exec: ctx.exec, out: ctx.out, platform: ctx.platform, uid: ctx.uid, openSession: ctx.openSession });
    for (const c of r.commands) ctx.runner.commands.push(c);
    if (r.code !== 0) throw new Error(`migrate-layout exited ${r.code}${r.warnings.length ? `: ${r.warnings.join("; ")}` : ""}`);
  },
  migrate_inbox: async (ctx) => {
    if (!ctx.instanceDir) throw new Error("no METISTRY_INSTANCE_DIR — no instance to migrate");
    const r = await migrateInbox({ instanceDir: ctx.instanceDir, env: ctx.env, exec: ctx.exec, out: ctx.out, openSession: ctx.openSession });
    for (const c of r.commands) ctx.runner.commands.push(c);
    if (r.code !== 0) throw new Error(`migrate-inbox exited ${r.code}`);
  },
};

// ---- the fix log -------------------------------------------------------------------------------

export async function readFixLog(path: string): Promise<FixLogEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: FixLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as FixLogEntry;
      if (v && typeof v.at === "string" && typeof v.id === "string") out.push(v);
    } catch {
      /* a half-written line is not evidence of anything */
    }
  }
  return out;
}

async function appendFixLog(path: string, entry: FixLogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

/**
 * Rule 5 across invocations: a restart-class fix that RAN for this target
 * inside the window is not run again. The row it would have fixed becomes
 * the owner's — with when doctor tried, and the log to read. Applied to the
 * report before fixing and to the re-check after, so both say the same.
 */
export function holdRecentRestarts(rows: DoctorRow[], log: readonly FixLogEntry[], nowMs: number, windowMs: number): DoctorRow[] {
  const tried = new Map<string, FixLogEntry>();
  for (const e of log) {
    if (!isRestartClass(e.id) || (e.outcome !== "fixed" && e.outcome !== "applied" && e.outcome !== "failed")) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || nowMs - at > windowMs || nowMs - at < 0) continue;
    const key = fixKey(e);
    const prev = tried.get(key);
    if (!prev || Date.parse(prev.at) < at) tried.set(key, e);
  }
  if (tried.size === 0) return rows;
  return rows.map((r) => {
    if (r.fix !== "fixable" || !r.repair || !isRestartClass(r.repair.id)) return r;
    const e = tried.get(fixKey(r.repair));
    if (!e) return r;
    const { repair, ...rest } = r;
    const what = repair.id === "restart" ? `restarted ${repair.target}` : "re-rendered this install";
    return {
      ...rest,
      fix: "hand" as FixClass,
      remediation: `${r.remediation ?? r.probe} — doctor ${what} at ${e.at} and it is still failing, so it is not restarted again within ${Math.round(windowMs / 60_000)} minutes: read the log (\`metistry logs ${repair.target ?? "supervisor"}\`), then \`metistry doctor\` once more`,
      meta: { ...r.meta, restart_held: { tried_at: e.at, outcome: e.outcome } },
    };
  });
}

// ---- planning -----------------------------------------------------------------------------------

export interface PlannedFix {
  repair: Repair;
  rows: DoctorRow[];
}

/**
 * The fixes a report asks for, one per id and target, in dependency order,
 * with the ones a prerequisite makes moot pruned (rule 8): a `render`
 * restarts the supervisor and every child, so no restart runs beside it; the
 * supervisor's restart takes its children with it, so none of theirs runs
 * beside that. The rows those would have fixed are re-evaluated by the
 * re-check, not fixed separately.
 */
export function planFixes(rows: readonly DoctorRow[]): PlannedFix[] {
  const byKey = new Map<string, PlannedFix>();
  for (const r of rows) {
    if (r.fix !== "fixable" || !r.repair) continue;
    const key = fixKey(r.repair);
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(r);
      // one row asking to confirm makes the shared fix a confirm
      if (r.repair.confirm) existing.repair = { ...existing.repair, confirm: true };
    } else byKey.set(key, { repair: { ...r.repair }, rows: [r] });
  }
  let planned = [...byKey.values()];
  if (planned.some((p) => p.repair.id === "render")) planned = planned.filter((p) => p.repair.id !== "restart");
  if (planned.some((p) => p.repair.id === "restart" && p.repair.target === "supervisor")) planned = planned.filter((p) => p.repair.id !== "restart" || p.repair.target === "supervisor" || p.repair.target === "db");
  return planned.sort((a, b) => {
    const d = ORDER.indexOf(a.repair.id) - ORDER.indexOf(b.repair.id);
    if (d !== 0) return d;
    if (a.repair.id === "restart") return restartRank(a.repair.target) - restartRank(b.repair.target) || (a.repair.target ?? "").localeCompare(b.repair.target ?? "");
    return 0;
  });
}

// ---- applying -----------------------------------------------------------------------------------

const yesWords = new Set(["y", "yes"]);

/** A row is cleared when the re-check no longer finds anything on it. */
const cleared = (r: DoctorRow | undefined): boolean => r !== undefined && r.status === "ok";

/**
 * Apply the fixable rows of `before`, re-check once, and say what changed.
 * The report returned is the re-check's (the rows as they are NOW), each row
 * carrying `fix` and — for the rows a fix was for — `fixed`; `fixes[]` is
 * what ran, in order, and how each went. Nothing ran → no re-check, and the
 * report is `before` with `mode: "fix"`.
 *
 * The exit code is 0 when nothing `failed` remains, no fix threw, and no
 * confirm-class fix was left waiting for a `--yes`: a run that could not do
 * what it found is not a clean run.
 */
export async function applyFixes(before: DoctorReport, o: ApplyOptions): Promise<{ report: DoctorRunReport; code: number }> {
  const d = o.deps;
  const env = d.env ?? process.env;
  const exec = d.exec ?? realExec;
  const platform = d.platform ?? process.platform;
  const uid = d.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const now = d.now ?? Date.now;
  const ui = o.ui ?? defaultUi();
  const { product, readDir } = describeProduct(d.productDir);
  const instanceDir = env.METISTRY_INSTANCE_DIR?.trim().replace(/\/+$/, "") || undefined;
  const stateRoot = instanceDir ?? readDir;
  const logPath = d.fixLogPath ?? fixLogPath(stateRoot);
  const windowMs = restartWindowMs(env);

  // a namespaced instance's jobs carry its label suffix: what is restarted is graced under the labels that exist
  const labelSuffix = d.namespace === undefined ? (await loadNamespace(env.METISTRY_INSTANCE_DIR))?.labelSuffix : d.namespace?.labelSuffix;

  const log = await readFixLog(logPath);
  const beforeRows = holdRecentRestarts(before.rows, log, now(), windowMs);
  const planned = planFixes(beforeRows);
  const fixes: FixRecord[] = [];
  if (planned.length === 0) {
    return { report: { ...before, rows: beforeRows.map((r) => ({ ...r, fixed: null })), mode: "fix", fixes }, code: before.ok ? 0 : 1 };
  }

  const runner = new StepRunner({ dryRun: false, out: o.out, exec, env, ui });
  const ctx: FixContext = {
    runner,
    productDir: product.install_dir ?? d.productDir,
    readDir,
    instanceDir,
    env,
    exec,
    platform,
    uid,
    home: d.home ?? env.HOME,
    fetchFn: d.fetchFn ?? fetch,
    out: o.out,
    openSession: d.openSession ?? openMigrationSession,
    keychain: d.keychain,
    upFn: d.upFn ?? up,
  };
  runner.section("fixes");
  const restarted: Record<string, number> = {};
  let ran = false;
  for (const p of planned) {
    const statusOf = (rows: readonly DoctorRow[]): Record<string, CheckResult["status"]> => Object.fromEntries(rows.map((r) => [r.name, r.status]));
    const record: FixRecord = {
      id: p.repair.id,
      ...(p.repair.target ? { target: p.repair.target } : {}),
      rows: p.rows.map((r) => r.name),
      does: p.repair.does,
      confirm: p.repair.confirm,
      outcome: "needs_confirm",
      steps: [],
      before: statusOf(p.rows),
    };
    const forRows = `${p.rows.map((r) => r.name).join(", ")}`;
    if (p.repair.confirm && !o.yes) {
      // the preview: what would run, for which rows, and the question — or
      // the flag, when there is nobody to ask
      runner.note(`${forRows}: ${p.repair.does}`);
      if (!o.ask) {
        runner.note(`not applied — a fix that moves files or restarts a running service asks first: \`metistry doctor\` in a terminal, or \`metistry doctor --fix --yes\``);
        fixes.push(record);
        continue;
      }
      const answer = (await o.ask(`   apply? [y/N] `)).trim().toLowerCase();
      if (!yesWords.has(answer)) {
        runner.note("skipped");
        fixes.push({ ...record, outcome: "declined" });
        continue;
      }
    } else runner.note(`${forRows}: ${p.repair.does}`);

    const from = runner.commands.length;
    const fixer = d.fixers?.[p.repair.id] ?? FIXERS[p.repair.id];
    try {
      await fixer(ctx, p.repair);
      record.outcome = "applied";
    } catch (err) {
      record.outcome = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      runner.note(`${ui.icon("fail")} ${forRows}: ${record.error}`);
    }
    ran = true;
    record.steps = runner.commands.slice(from);
    if (isRestartClass(p.repair.id)) {
      // what was just bounced is *starting*: the re-check waits out its start
      // rather than failing a socket that is not there yet (X-122)
      const labels = p.repair.id === "render" ? ["supervisor", "recorder", "calendar", ...p.rows.map((r) => r.repair?.target).filter((x): x is string => !!x)] : [p.repair.target!];
      for (const l of labels) restarted[labelFor(l, labelSuffix)] = now();
    }
    fixes.push(record);
    await appendFixLog(logPath, { at: new Date(now()).toISOString(), ...record }).catch((err) => runner.note(`fix log: could not write ${logPath} (${err instanceof Error ? err.message : String(err)})`));
  }

  if (!ran) {
    const rows = beforeRows.map((r) => ({ ...r, fixed: null }));
    return { report: { ...before, rows, mode: "fix", fixes }, code: before.ok && !fixes.some((f) => f.outcome === "needs_confirm") ? 0 : 1 };
  }

  // the one re-check: the same doctor, read-only, with what was just started graced
  const startedAt: StartedAt = { ...(d.startedAt ?? {}), ...restarted };
  const after = await (o.doctorFn ?? doctor)({ ...d, startedAt });
  const afterRows = holdRecentRestarts(after.rows, await readFixLog(logPath), now(), windowMs);
  const byName = new Map(afterRows.map((r) => [r.name, r]));
  for (const f of fixes) {
    if (f.outcome !== "applied" && f.outcome !== "failed") continue;
    f.after = Object.fromEntries(f.rows.map((n) => [n, byName.get(n)?.status ?? "absent"]));
    if (f.outcome === "applied" && f.rows.every((n) => cleared(byName.get(n)))) f.outcome = "fixed";
  }
  const touched = new Map<string, boolean>();
  for (const f of fixes) {
    if (f.outcome !== "fixed" && f.outcome !== "applied" && f.outcome !== "failed") continue;
    for (const n of f.rows) touched.set(n, cleared(byName.get(n)));
  }
  const rows = afterRows.map((r) => ({ ...r, fixed: touched.has(r.name) ? touched.get(r.name)! : null }));
  const ok = !rows.some((r) => r.status === "failed");
  // a run in which a fix threw, or could not run for want of a --yes, is not a clean run
  const code = ok && !fixes.some((f) => f.outcome === "needs_confirm" || f.outcome === "failed") ? 0 : 1;
  return { report: { ...after, rows, ok, mode: "fix", fixes }, code };
}

// ---- rendering ----------------------------------------------------------------------------------

/** How many rows each class holds — the one line a check run ends with when something is fixable. */
export function countClasses(rows: readonly DoctorRow[]): Record<FixClass, number> {
  const counts: Record<FixClass, number> = { fixable: 0, hand: 0, info: 0 };
  for (const r of rows) if (r.status !== "ok" && r.fix) counts[r.fix]++;
  return counts;
}

/**
 * The line after a `--check` table (or a bare `doctor` with no terminal):
 * what doctor could put right, and how to have it do so. Nothing when there
 * is nothing fixable.
 */
export function renderCheckTrailer(report: DoctorReport, ui: Ui = defaultUi()): string | undefined {
  const c = countClasses(report.rows);
  if (c.fixable === 0) return undefined;
  const hand = c.hand > 0 ? `, ${c.hand} ${c.hand === 1 ? "needs" : "need"} your hand` : "";
  return ui.dim(`${c.fixable} fixable${hand} — \`metistry doctor\` in a terminal applies the fixes, or \`metistry doctor --fix\``);
}

/**
 * What a repair run ends with: each fix with its rows' before → after and
 * how it went, then the re-check's tally and verdict — the same last line
 * `renderTable` prints, so a person reading two doctor runs reads one shape.
 */
export function renderFixes(report: DoctorRunReport, ui: Ui = defaultUi()): string {
  const out: string[] = ["", ui.heading("after")];
  for (const f of report.fixes ?? []) {
    const what = f.target ? `${f.id} ${f.target}` : f.id;
    const arrow = ui.icon("arrow");
    for (const name of f.rows) {
      const b = f.before[name] ?? "?";
      const a = f.after?.[name];
      const change = a === undefined ? ui.paint(statusName(b), b) : `${ui.paint(statusName(b), b)} ${arrow} ${ui.paint(statusName(a), a)}`;
      const icon = f.outcome === "fixed" ? ui.icon("ok") : f.outcome === "failed" || f.outcome === "applied" ? ui.icon("fail") : ui.icon("warn");
      const note =
        f.outcome === "fixed"
          ? "fixed"
          : f.outcome === "applied"
            ? `tried ${what}; still failing`
            : f.outcome === "failed"
              ? `${what} failed: ${f.error ?? "no detail"}`
              : f.outcome === "declined"
                ? `${what} skipped`
                : `${what} needs --yes (or a terminal to ask in)`;
      out.push(`  ${icon} ${name}  ${change}  ${ui.dim(note)}`);
    }
  }
  const counts = { ok: 0, degraded: 0, failed: 0, absent: 0 };
  for (const r of report.rows) counts[r.status]++;
  const tally = (Object.keys(counts) as Array<keyof typeof counts>).map((k) => ui.paint(statusName(k), `${counts[k]} ${k}`)).join(", ");
  const waiting = (report.fixes ?? []).filter((f) => f.outcome === "needs_confirm").length;
  const verdict = report.ok && waiting === 0 ? ui.paint("ok", `${ui.icon("ok")} healthy`) : ui.paint("failed", `${ui.icon("fail")} ${report.ok ? `${waiting} fix(es) waiting for --yes` : "FAILED"}`);
  out.push("", `${report.rows.length} checks: ${tally} — ${verdict}`);
  return out.join("\n");
}
