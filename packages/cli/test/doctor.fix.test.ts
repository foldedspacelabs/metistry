// X-123: `metistry doctor` repairs what it finds. The owner's ruling —
// "regardless of the problems found, the user only needs to run `metistry
// doctor`" — and the contract that keeps a repairing tool safe to leave
// running: a closed fix table, `--check` writes nothing, a your-hand row is
// never auto-fixed, a destructive fix never runs without its confirm, a fix
// that fails leaves its row failed with the error, one pass and never a
// loop. Every fixer here is a fake handed in through the seam; the real ones
// are held to their service separately (`FIXERS`).
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRows, doctor, renderTable, type Db, type DoctorReport, type DoctorRow, type Repair } from "../src/doctor.js";
import { applyFixes, doctorMode, FIXERS, fixKey, fixLogPath, holdRecentRestarts, planFixes, readFixLog, renderCheckTrailer, renderFixes, type FixContext, type FixLogEntry } from "../src/doctor-fix.js";
import { MIGRATION_LOCK_KEY } from "../src/migrate.js";
import { labelFor } from "../src/launchd.js";
import { localServerRows, probeLocalServers } from "../src/local-models.js";
import { BOOLEAN_FLAGS, main, parseArgs } from "../src/main.js";
import { StepRunner } from "../src/steps.js";
import { checkout, fakeExec, put } from "./fixtures.js";

const NOW = 1_800_000_000_000;

const row = (name: string, status: DoctorRow["status"], extra: Partial<DoctorRow> = {}): DoctorRow => ({ kind: "test", name, status, latency_ms: 1, probe: `probe ${name}`, ...(status === "ok" ? {} : { remediation: `fix ${name}` }), ...extra });
const restart = (target: string, confirm = false): Repair => ({ id: "restart", target, confirm, does: `restart ${target}` });
const report = (rows: DoctorRow[], productDir = "/p"): DoctorReport => ({ as_of: "now", product_dir: productDir, shape: "compose", ok: !rows.some((r) => r.status === "failed"), rows: classifyRows(rows) });

/** A doctorFn for the re-check: answers with the rows given, counting calls. */
function recheck(rows: DoctorRow[]) {
  const calls: unknown[] = [];
  const fn = async (deps: unknown): Promise<DoctorReport> => (calls.push(deps), report(rows));
  return { fn, calls };
}

async function scratch(): Promise<{ dir: string; logPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-doctor-fix-"));
  return { dir, logPath: join(dir, "doctor-fixes.jsonl") };
}

describe("doctorMode — when a bare `doctor` repairs", () => {
  it("--check is read-only and --fix repairs, whoever runs them", () => {
    for (const interactive of [true, false]) {
      expect(doctorMode({ check: true, fix: false, interactive })).toBe("check");
      expect(doctorMode({ check: false, fix: true, interactive })).toBe("fix");
    }
  });
  it("a bare `doctor` repairs only with a person at a terminal to ask; a pipe, a script and the Mac app's refresh get --check", () => {
    expect(doctorMode({ check: false, fix: false, interactive: true })).toBe("fix");
    expect(doctorMode({ check: false, fix: false, interactive: false })).toBe("check");
  });
  it("the flags parse as booleans", () => {
    expect(BOOLEAN_FLAGS.has("check") && BOOLEAN_FLAGS.has("fix") && BOOLEAN_FLAGS.has("yes")).toBe(true);
    expect(parseArgs(["doctor", "--fix", "--yes", "--product-dir", "/p"])).toEqual({ command: "doctor", positional: [], flags: { fix: true, yes: true, "product-dir": "/p" } });
  });
});

describe("classifyRows — every row leaves doctor() with a class", () => {
  it("a row with a fix is fixable; ok and absent are facts; degraded and failed nobody claimed are the owner's hand", () => {
    const rows = classifyRows([row("a", "ok"), row("b", "absent"), row("c", "degraded"), row("d", "failed"), row("e", "failed", { repair: restart("console") })]);
    expect(rows.map((r) => [r.name, r.fix, r.fixed])).toEqual([
      ["a", "info", null],
      ["b", "info", null],
      ["c", "hand", null],
      ["d", "hand", null],
      ["e", "fixable", null],
    ]);
  });
  it("a class a builder set wins, and a non-fixable row never carries a fix", () => {
    const rows = classifyRows([row("a", "absent", { fix: "hand" }), row("b", "degraded", { fix: "info" }), row("c", "failed", { fix: "info", repair: restart("x") })]);
    expect(rows.map((r) => [r.name, r.fix, r.repair])).toEqual([
      ["a", "hand", undefined],
      ["b", "info", undefined],
      ["c", "info", undefined],
    ]);
  });
  it("MISUSE (rule 6): a service the owner stopped is never restarted by another row's fix — it becomes `metistry start`, the owner's", () => {
    const rows = classifyRows([
      { ...row("child:eventkit", "degraded"), kind: "child", meta: { state: "stopped" }, fix: "info" },
      row("eventkit", "failed", { repair: restart("eventkit") }),
      row("apple-fm", "failed", { repair: restart("apple-fm") }),
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["eventkit"]).toMatchObject({ fix: "hand", remediation: expect.stringMatching(/stopped with `metistry stop`.*`metistry start eventkit` is yours/) });
    expect(byName["eventkit"]!.repair).toBeUndefined();
    expect(byName["apple-fm"]).toMatchObject({ fix: "fixable", repair: { id: "restart", target: "apple-fm" } });
  });
});

describe("planFixes — one run per fix, in dependency order", () => {
  it("rows sharing a fix share one run; one of them asking to confirm makes it a confirm", () => {
    const planned = planFixes(classifyRows([row("console", "failed", { repair: restart("console") }), row("console-401", "degraded", { repair: restart("console", true) }), row("x", "degraded")]));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.repair).toMatchObject({ id: "restart", target: "console", confirm: true });
    expect(planned[0]!.rows.map((r) => r.name)).toEqual(["console", "console-401"]);
  });
  it("the db restarts before the schema is migrated, before the render, before the files (rule 8)", () => {
    const planned = planFixes(
      classifyRows([
        row("inbox", "degraded", { repair: { id: "migrate_inbox", confirm: true, does: "" } }),
        row("cli", "absent", { repair: { id: "cli_shim", confirm: false, does: "" } }),
        row("migrations", "degraded", { repair: { id: "migrate", confirm: false, does: "" } }),
        row("db", "failed", { repair: restart("db") }),
      ]),
    );
    expect(planned.map((p) => fixKey(p.repair))).toEqual(["restart:db", "migrate", "cli_shim", "migrate_inbox"]);
  });
  it("a render restarts the supervisor and every child, so no restart runs beside it; the supervisor's restart takes its children's with it", () => {
    const withRender = planFixes(classifyRows([row("child:console", "failed", { repair: restart("console") }), row("launchd env", "degraded", { repair: { id: "render", confirm: true, does: "" } })]));
    expect(withRender.map((p) => fixKey(p.repair))).toEqual(["render"]);
    const withSupervisor = planFixes(classifyRows([row("child:console", "failed", { repair: restart("console") }), row("supervisor:x", "failed", { repair: restart("supervisor", true) }), row("db", "failed", { repair: restart("db") })]));
    expect(withSupervisor.map((p) => fixKey(p.repair))).toEqual(["restart:db", "restart:supervisor"]);
  });
  it("nothing is planned for a hand or info row", () => {
    expect(planFixes(classifyRows([row("a", "failed"), row("b", "degraded", { fix: "info" }), row("c", "ok")]))).toEqual([]);
  });
});

describe("holdRecentRestarts — rule 5 across invocations", () => {
  const entry = (id: FixLogEntry["id"], target: string | undefined, at: number, outcome: FixLogEntry["outcome"] = "applied"): FixLogEntry => ({ at: new Date(at).toISOString(), id, ...(target ? { target } : {}), rows: ["r"], does: "", confirm: false, outcome, steps: [], before: {} });
  it("a restart tried inside the window is not tried again: the row becomes the owner's, with when and the log", () => {
    const rows = holdRecentRestarts(classifyRows([row("child:console", "failed", { repair: restart("console") })]), [entry("restart", "console", NOW - 5 * 60_000)], NOW, 30 * 60_000);
    expect(rows[0]).toMatchObject({ fix: "hand", remediation: expect.stringMatching(/doctor restarted console at .* still failing.*not restarted again within 30 minutes.*metistry logs console/) });
    expect(rows[0]!.repair).toBeUndefined();
    expect(rows[0]!.meta).toMatchObject({ restart_held: { outcome: "applied" } });
  });
  it("past the window, another target, a fix that never ran, or a non-restart fix: untouched", () => {
    const fixable = classifyRows([row("child:console", "failed", { repair: restart("console") }), row("migrations", "degraded", { repair: { id: "migrate", confirm: false, does: "" } })]);
    expect(holdRecentRestarts(fixable, [entry("restart", "console", NOW - 31 * 60_000)], NOW, 30 * 60_000)).toEqual(fixable);
    expect(holdRecentRestarts(fixable, [entry("restart", "db", NOW - 60_000)], NOW, 30 * 60_000)).toEqual(fixable);
    expect(holdRecentRestarts(fixable, [entry("restart", "console", NOW - 60_000, "needs_confirm"), entry("restart", "console", NOW - 60_000, "declined")], NOW, 30 * 60_000)).toEqual(fixable);
    expect(holdRecentRestarts(fixable, [entry("migrate", undefined, NOW - 60_000)], NOW, 30 * 60_000)).toEqual(fixable);
  });
});

describe("applyFixes — the repair run", () => {
  const base = (logPath: string, fixers: Record<string, (ctx: FixContext, r: Repair) => Promise<void>>, extra: Record<string, unknown> = {}) => ({
    deps: { productDir: "/p", env: {}, exec: fakeExec(), platform: "linux" as const, uid: 501, now: () => NOW, fixLogPath: logPath, fixers, ...extra },
    yes: false,
    out: () => {},
  });

  it("applies each fixable row's fix once, re-checks exactly once, and says before → after; every fix is logged by name", async () => {
    const { logPath } = await scratch();
    const calls: string[] = [];
    const before = report([row("db", "failed", { repair: restart("db") }), row("migrations", "degraded", { repair: { id: "migrate", confirm: false, does: "apply 2 pending" } }), row("brain", "failed", { fix: "info" }), row("tcc", "degraded")]);
    const after = recheck([row("db", "ok"), row("migrations", "ok"), row("brain", "ok"), row("tcc", "degraded")]);
    const r = await applyFixes(before, {
      ...base(logPath, {
        restart: async (ctx, rep) => void (calls.push(`restart ${rep.target}`), ctx.runner.commands.push("launchctl kickstart -k gui/501/db")),
        migrate: async (ctx) => void (calls.push("migrate"), ctx.runner.action("apply migrations")),
      }),
      doctorFn: after.fn,
    });
    expect(calls).toEqual(["restart db", "migrate"]);
    expect(after.calls).toHaveLength(1);
    // what was restarted is handed to the re-check as *starting*, so its grace applies (X-122)
    expect((after.calls[0] as { startedAt: Record<string, number> }).startedAt).toEqual({ [labelFor("db")]: NOW });
    expect(r.code).toBe(0);
    expect(r.report.mode).toBe("fix");
    expect(r.report.fixes).toMatchObject([
      { id: "restart", target: "db", rows: ["db"], outcome: "fixed", before: { db: "failed" }, after: { db: "ok" }, steps: ["launchctl kickstart -k gui/501/db"] },
      { id: "migrate", rows: ["migrations"], outcome: "fixed", before: { migrations: "degraded" }, after: { migrations: "ok" }, steps: ["apply migrations"] },
    ]);
    const byName = Object.fromEntries(r.report.rows.map((x) => [x.name, x]));
    expect(byName["db"]).toMatchObject({ status: "ok", fixed: true });
    expect(byName["migrations"]).toMatchObject({ status: "ok", fixed: true });
    // a row no fix was for — the info row that followed, the hand row — says so
    expect(byName["brain"]!.fixed).toBeNull();
    expect(byName["tcc"]).toMatchObject({ fix: "hand", fixed: null });
    const log = await readFixLog(logPath);
    expect(log.map((e) => [e.id, e.outcome, e.at])).toEqual([
      ["restart", "applied", new Date(NOW).toISOString()],
      ["migrate", "applied", new Date(NOW).toISOString()],
    ]);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    const text = renderFixes(r.report);
    expect(text).toMatch(/db\s+failed .* ok\s+fixed/);
    expect(text).toMatch(/4 checks: 3 ok, 1 degraded, 0 failed, 0 absent — .*healthy/);
  });

  it("MISUSE: a your-hand row applies nothing, and says what the owner does", async () => {
    const { logPath } = await scratch();
    let ran = 0;
    const fixers = Object.fromEntries(Object.keys(FIXERS).map((id) => [id, async () => void ran++]));
    const before = report([row("tcc", "degraded", { remediation: "System Settings ▸ Privacy & Security ▸ Calendars" }), row("down", "failed"), row("fact", "absent")]);
    const after = recheck([]);
    const r = await applyFixes(before, { ...base(logPath, fixers), doctorFn: after.fn });
    expect(ran).toBe(0);
    expect(after.calls).toHaveLength(0); // nothing ran, so nothing to re-check
    expect(existsSync(logPath)).toBe(false);
    expect(r.report.fixes).toEqual([]);
    expect(r.report.rows.map((x) => [x.name, x.fix, x.fixed])).toEqual([
      ["tcc", "hand", null],
      ["down", "hand", null],
      ["fact", "info", null],
    ]);
    expect(r.report.rows[0]!.remediation).toContain("System Settings");
    expect(r.code).toBe(1); // a failed row remains
  });

  it("MISUSE: a destructive fix without --yes and nobody to ask previews, writes nothing, and the run exits non-zero", async () => {
    const { logPath } = await scratch();
    let ran = 0;
    const lines: string[] = [];
    const before = report([row("instance layout", "degraded", { repair: { id: "migrate_layout", confirm: true, does: "move the vault onto the flat layout" } })]);
    const after = recheck([]);
    const r = await applyFixes(before, { ...base(logPath, { migrate_layout: async () => void ran++ }), out: (l) => lines.push(l), doctorFn: after.fn });
    expect(ran).toBe(0);
    expect(after.calls).toHaveLength(0);
    expect(existsSync(logPath)).toBe(false);
    expect(r.code).toBe(1);
    expect(r.report.fixes).toMatchObject([{ id: "migrate_layout", outcome: "needs_confirm", steps: [] }]);
    expect(r.report.rows[0]).toMatchObject({ status: "degraded", fix: "fixable", fixed: null });
    expect(lines.join("\n")).toMatch(/move the vault onto the flat layout/);
    expect(lines.join("\n")).toMatch(/asks first.*--fix --yes/);
    expect(renderFixes(r.report)).toMatch(/needs --yes/);
  });

  it("a destructive fix asks once, in a terminal: no runs nothing, yes runs it; --yes skips the question", async () => {
    const { logPath } = await scratch();
    const questions: string[] = [];
    let ran = 0;
    const before = report([row("inbox", "degraded", { repair: { id: "migrate_inbox", confirm: true, does: "move 3 captures" } })]);
    const declined = await applyFixes(before, { ...base(logPath, { migrate_inbox: async () => void ran++ }), ask: async (q) => (questions.push(q), "n"), doctorFn: recheck([]).fn });
    expect(ran).toBe(0);
    expect(questions).toHaveLength(1);
    expect(declined.report.fixes).toMatchObject([{ outcome: "declined" }]);
    expect(existsSync(logPath)).toBe(false);

    const after = recheck([row("inbox", "ok")]);
    const accepted = await applyFixes(before, { ...base(logPath, { migrate_inbox: async () => void ran++ }), ask: async () => "y", doctorFn: after.fn });
    expect(ran).toBe(1);
    expect(accepted.report.fixes).toMatchObject([{ outcome: "fixed" }]);
    expect(accepted.code).toBe(0);

    const flagged = await applyFixes(before, { ...base(logPath, { migrate_inbox: async () => void ran++ }), yes: true, ask: async () => (questions.push("asked anyway"), "n"), doctorFn: after.fn });
    expect(ran).toBe(2);
    expect(questions).toHaveLength(1); // --yes: not asked
    expect(flagged.report.fixes).toMatchObject([{ outcome: "fixed" }]);
  });

  it("MISUSE: a fix that fails leaves the row as it was, with the error — never `fixed`", async () => {
    const { logPath } = await scratch();
    const before = report([row("migrations", "degraded", { repair: { id: "migrate", confirm: false, does: "apply" } })]);
    const after = recheck([row("migrations", "degraded", { repair: { id: "migrate", confirm: false, does: "apply" } })]);
    const r = await applyFixes(before, {
      ...base(logPath, {
        migrate: async () => {
          throw new Error("migration 0003_x.sql failed: relation exists");
        },
      }),
      doctorFn: after.fn,
    });
    expect(after.calls).toHaveLength(1); // it ran, so the re-check runs — and reports what is, not what was hoped
    expect(r.report.fixes).toMatchObject([{ id: "migrate", outcome: "failed", error: "migration 0003_x.sql failed: relation exists", after: { migrations: "degraded" } }]);
    expect(r.report.rows[0]).toMatchObject({ status: "degraded", fixed: false });
    expect(r.code).toBe(1);
    expect((await readFixLog(logPath)).map((e) => [e.outcome, e.error])).toEqual([["failed", "migration 0003_x.sql failed: relation exists"]]);
    expect(renderFixes(r.report)).toMatch(/migrate failed: migration 0003_x\.sql failed/);
  });

  it("one pass, never a loop: a fix that ran and did not clear its row reads `tried; still failing`, and the re-check fixes nothing", async () => {
    const { logPath } = await scratch();
    let ran = 0;
    const before = report([row("child:console", "failed", { repair: restart("console") }), row("brain", "failed", { fix: "info" })]);
    const still = [row("child:console", "failed", { repair: restart("console") }), row("brain", "failed", { fix: "info" })];
    const after = recheck(still);
    const r = await applyFixes(before, { ...base(logPath, { restart: async () => void ran++ }), doctorFn: after.fn });
    expect(ran).toBe(1);
    expect(after.calls).toHaveLength(1);
    expect(r.report.fixes).toMatchObject([{ outcome: "applied", after: { "child:console": "failed" } }]);
    const console_ = r.report.rows.find((x) => x.name === "child:console")!;
    expect(console_.fixed).toBe(false);
    // and the re-check's row is already the owner's: the restart was just tried (rule 5 reads the log this run wrote)
    expect(console_).toMatchObject({ fix: "hand", remediation: expect.stringMatching(/doctor restarted console at/) });
    expect(renderFixes(r.report)).toMatch(/tried restart console; still failing/);

    // a second invocation inside the window does not restart it again
    const again = await applyFixes(report(still), { ...base(logPath, { restart: async () => void ran++ }), doctorFn: recheck(still).fn });
    expect(ran).toBe(1);
    expect(again.report.fixes).toEqual([]);
    expect(again.report.rows[0]).toMatchObject({ fix: "hand" });
  });

  it("the real `restart` fixer is `metistry restart`: under the compose shape, `docker compose restart <service>` through the exec seam", async () => {
    const productDir = await checkout();
    const { logPath } = await scratch();
    const exec = fakeExec();
    const before = report([row("console", "failed", { repair: restart("console") })], productDir);
    const after = recheck([row("console", "ok")]);
    const r = await applyFixes(before, { deps: { productDir, env: {}, exec, platform: "linux", uid: 501, now: () => NOW, fixLogPath: logPath }, yes: false, out: () => {}, doctorFn: after.fn });
    expect(exec.calls.map((c) => [c.cmd, ...c.args].join(" "))).toContain("docker compose restart console");
    expect(r.report.fixes).toMatchObject([{ id: "restart", target: "console", outcome: "fixed", steps: [expect.stringMatching(/docker compose restart console/)] }]);
  });

  it("the real `migrate` fixer is the migration runner under the advisory lock — one transaction per file, recorded in schema_migrations", async () => {
    const productDir = await checkout();
    const queries: string[] = [];
    const session = {
      query: async (text: string, values?: unknown[]) => {
        queries.push(values ? `${text} ${JSON.stringify(values)}` : text);
        if (text.startsWith("SELECT filename")) return { rows: queries.some((q) => q.startsWith("INSERT")) ? [{ filename: "0001_a.sql" }, { filename: "0002_b.sql" }] : [{ filename: "0001_a.sql" }] };
        return { rows: [] };
      },
      end: async () => {},
    };
    const r = new StepRunner({ dryRun: false, out: () => {}, exec: fakeExec(), env: {} });
    const ctx = { runner: r, productDir, readDir: productDir, instanceDir: undefined, env: {}, exec: fakeExec(), platform: "linux", uid: 501, home: undefined, fetchFn: fetch, out: () => {}, openSession: async () => session, upFn: async () => ({ code: 0 }) } as unknown as FixContext;
    await FIXERS.migrate(ctx, { id: "migrate", confirm: false, does: "" });
    expect(queries[0]).toBe(`SELECT pg_advisory_lock($1) [${MIGRATION_LOCK_KEY}]`);
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("select 2;");
    expect(queries).toContain('INSERT INTO schema_migrations (filename) VALUES ($1) ["0002_b.sql"]');
    expect(queries).not.toContain("select 1;"); // already applied: skipped
    expect(queries[queries.length - 1]).toBe(`SELECT pg_advisory_unlock($1) [${MIGRATION_LOCK_KEY}]`);
    expect(r.commands).toEqual([expect.stringMatching(/apply db\/migrations\/\*\.sql not yet in schema_migrations under pg_advisory_lock/)]);
    // and without a password there is nothing to connect with: the fix fails, it does not guess
    await expect(FIXERS.migrate({ ...ctx, openSession: async () => null }, { id: "migrate", confirm: false, does: "" })).rejects.toThrow(/METISTRY_DB_PASSWORD is unset/);
  });

  it("the fix log tolerates a half-written line and is read by name only", async () => {
    const { logPath } = await scratch();
    await writeFile(logPath, `${JSON.stringify({ at: new Date(NOW).toISOString(), id: "restart", target: "db", rows: ["db"], does: "", confirm: false, outcome: "applied", steps: [], before: {} })}\n{"at": "broken\n`);
    await chmod(logPath, 0o600);
    expect((await readFixLog(logPath)).map((e) => fixKey(e))).toEqual(["restart:db"]);
    expect(fixLogPath("/i")).toBe("/i/.metistry/state/doctor-fixes.jsonl");
  });
});

// ---- through main: the verb a person types -----------------------------------------------------

type Res = { status: number; ok: boolean; json?: () => Promise<unknown> };
const res = (status: number, body?: unknown): Res => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fakeFetch = (routes: Record<string, Res | Error>) =>
  (async (url: string) => {
    const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (!hit) throw new Error(`unrouted ${url}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as unknown as typeof fetch;

/** A db whose schema_migrations lacks 0002_b.sql — the one fixable finding the synthetic checkout produces on linux. */
const pendingDb = (): Db & { migrated: boolean } => {
  const db = {
    migrated: false,
    query: async (text: string) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      if (text.includes("to_regclass")) return { rows: [{ t: "schema_migrations" }] };
      if (text.includes("FROM schema_migrations")) return { rows: db.migrated ? [{ filename: "0001_a.sql" }, { filename: "0002_b.sql" }] : [{ filename: "0001_a.sql" }] };
      if (text.includes("FROM runs")) return { rows: [] };
      throw new Error(`unexpected query ${text}`);
    },
  };
  return db;
};

async function productWithConsole(): Promise<string> {
  const productDir = await checkout();
  await put(productDir, "apps/console/manifest.yaml", "name: console\ntype: service\nruns_on: container\nport: 8080\n");
  return productDir;
}

describe("metistry doctor — through main", () => {
  const env = { METISTRY_CONSOLE_URL: "http://127.0.0.1:8080" };

  it("MISUSE: --check changes nothing — no fixer runs, no log is written, no subprocess acts; the rows still say who fixes what", async () => {
    const productDir = await productWithConsole();
    const { logPath } = await scratch();
    const exec = fakeExec({ docker: () => ({ code: 127 }) });
    const db = pendingDb();
    let ran = 0;
    const fixers = Object.fromEntries(Object.keys(FIXERS).map((id) => [id, async () => void ran++]));
    const out: string[] = [];
    const code = await main(["doctor", "--check", "--json", "--product-dir", productDir], {
      out: (s) => out.push(s),
      ask: async () => "y", // even with someone to ask
      doctorDeps: { env, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db, exec, platform: "linux", fixLogPath: logPath, fixers },
    });
    expect(code).toBe(0);
    expect(ran).toBe(0);
    expect(existsSync(logPath)).toBe(false);
    expect(exec.calls.filter((c) => c.cmd !== "docker")).toEqual([]);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]!);
    expect(doc.mode).toBe("check");
    expect(doc.fixes).toBeUndefined();
    const migrations = doc.rows.find((r: DoctorRow) => r.name === "migrations");
    expect(migrations).toMatchObject({ status: "degraded", fix: "fixable", fixed: null, repair: { id: "migrate", confirm: false } });
    expect(doc.rows.every((r: DoctorRow) => ["fixable", "hand", "info"].includes(r.fix!) && r.fixed === null)).toBe(true);
    expect(doc.rows.find((r: DoctorRow) => r.name === "compose")).toMatchObject({ status: "absent", fix: "hand" });
  });

  it("a bare `doctor` with nobody to ask is --check, and ends by saying what it could fix", async () => {
    const productDir = await productWithConsole();
    const { logPath } = await scratch();
    let ran = 0;
    const out: string[] = [];
    const code = await main(["doctor", "--product-dir", productDir], {
      out: (s) => out.push(s),
      doctorDeps: { env, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db: pendingDb(), exec: fakeExec({ docker: () => ({ code: 127 }) }), platform: "linux", fixLogPath: logPath, fixers: { migrate: async () => void ran++ } },
    });
    expect(code).toBe(0);
    expect(ran).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/migrations\s+degraded\s+\d+ms\s+fixable$/m);
    // the synthetic checkout has a second fixable row (no cli shim yet) and a few of the owner's (docker, the instance dir)
    expect(text).toMatch(/\d+ fixable, \d+ needs? your hand — `metistry doctor` in a terminal applies the fixes, or `metistry doctor --fix`/);
    expect(renderCheckTrailer(report([row("a", "ok")]))).toBeUndefined();
  });

  it("a bare `doctor` with a person to ask repairs: the fix runs, the re-check follows, before → after is printed", async () => {
    const productDir = await productWithConsole();
    const { logPath } = await scratch();
    const db = pendingDb();
    const out: string[] = [];
    const code = await main(["doctor", "--product-dir", productDir], {
      out: (s) => out.push(s),
      ask: async () => "y",
      doctorDeps: { env, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db, exec: fakeExec({ docker: () => ({ code: 127 }) }), platform: "linux", fixLogPath: logPath, fixers: { migrate: async (ctx) => void (ctx.runner.action("apply migrations"), (db.migrated = true)), cli_shim: async () => {} } },
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/== fixes/);
    expect(text).toMatch(/apply migrations/);
    expect(text).toMatch(/^after$/m);
    expect(text).toMatch(/migrations\s+degraded .* ok\s+fixed/);
    expect(await readFixLog(logPath)).toMatchObject(expect.arrayContaining([expect.objectContaining({ id: "migrate", outcome: "applied", rows: ["migrations"] })]));
    // the log carries names and steps, never a value
    expect(await readFile(logPath, "utf8")).not.toMatch(/password|token/i);
  });

  it("--fix --json repairs without a terminal and prints the one document: the re-check's rows, each with `fixed`, and `fixes[]`", async () => {
    const productDir = await productWithConsole();
    const { logPath } = await scratch();
    const db = pendingDb();
    const out: string[] = [];
    const code = await main(["doctor", "--fix", "--json", "--product-dir", productDir], {
      out: (s) => out.push(s),
      doctorDeps: { env, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db, exec: fakeExec({ docker: () => ({ code: 127 }) }), platform: "linux", fixLogPath: logPath, fixers: { migrate: async () => void (db.migrated = true), cli_shim: async () => {} } },
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]!);
    expect(doc.mode).toBe("fix");
    expect(doc.fixes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "migrate", outcome: "fixed", before: { migrations: "degraded" }, after: { migrations: "ok" } })]));
    expect(doc.rows.find((r: DoctorRow) => r.name === "migrations")).toMatchObject({ status: "ok", fix: "info", fixed: true });
  });

  it("--check and --fix exclude each other", async () => {
    const err: string[] = [];
    expect(await main(["doctor", "--check", "--fix", "--product-dir", "/p"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("\n")).toMatch(/--check.*--fix/);
  });

  it("the row builders name their fixes from facts, never from prose: console down → restart; a refused token → restart, confirmed", async () => {
    const productDir = await productWithConsole();
    const down = await doctor({ productDir, env, fetchFn: fakeFetch({ "/health": new Error("connect ECONNREFUSED") }), db: null, exec: fakeExec({ docker: () => ({ code: 127 }) }), platform: "linux" });
    expect(down.rows.find((r) => r.name === "console")).toMatchObject({ status: "failed", fix: "fixable", repair: { id: "restart", target: "console", confirm: false } });
    const refused = await doctor({ productDir, env: { ...env, METISTRY_LOCAL_OWNER_TOKEN: "t" }, fetchFn: fakeFetch({ "/health": res(200), "/api/status": res(401) }), db: null, exec: fakeExec({ docker: () => ({ code: 127 }) }), platform: "linux" });
    expect(refused.rows.find((r) => r.name === "console")).toMatchObject({ status: "degraded", fix: "fixable", repair: { id: "restart", target: "console", confirm: true } });
    // no db configured: the password is the owner's to set, never minted over a data dir
    expect(refused.rows.find((r) => r.name === "db")).toMatchObject({ status: "absent", fix: "hand" });
    expect(renderTable(refused)).toMatch(/db\s+absent\s+\d+ms\s+your hand$/m);
  });
});

// ---- the local-model scan stays off someone else's ports ------------------------------------------

describe("local model servers: the default-port scan is discovery, and runs only while compute.yaml names no on-machine provider", () => {
  const compute = (providers: Record<string, unknown>) => ({ providers, assignments: {}, limits: {} }) as never;
  const dialled = () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), new Response("{}", { status: 500 }))) as unknown as typeof fetch;
    return { urls, fetchFn };
  };

  it("with no on-machine provider every default port is dialled, so a server nobody configured is still found", async () => {
    const { urls, fetchFn } = dialled();
    await probeLocalServers({ compute: compute({}), fetchFn, env: {} });
    expect(urls.some((u) => u.includes(":1234/")) && urls.some((u) => u.includes(":11434/"))).toBe(true);
  });

  it("MISUSE: once the instance has its own local server, LM Studio's 1234 and Ollama's 11434 are not dialled — those rows read absent, not probed", async () => {
    const { urls, fetchFn } = dialled();
    const own = compute({ llama: { base_url: "http://127.0.0.1:7813/v1", locality: "on_machine", serve: { runtime: "llamaserver" } } });
    const rows = await localServerRows({ compute: own, fetchFn, env: {} });
    expect(urls).toEqual(["http://127.0.0.1:7813/v1/models"]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["local:lmstudio"]).toMatchObject({ status: "absent", remediation: expect.stringMatching(/not probed: compute.yaml names this instance's own local server \(llama\)/), meta: { probed: false } });
    expect(byName["local:ollama"]).toMatchObject({ status: "absent", meta: { probed: false } });
    expect(byName["local:llamaserver"]).toMatchObject({ status: "absent", meta: { provider: "llama" } });
  });

  it("`compute models list`'s discovery asks for the scan outright (scanDefaults) and still finds them", async () => {
    const { urls, fetchFn } = dialled();
    const own = compute({ llama: { base_url: "http://127.0.0.1:7813/v1", locality: "on_machine", serve: { runtime: "llamaserver" } } });
    await probeLocalServers({ compute: own, fetchFn, env: {}, scanDefaults: true });
    expect(urls.some((u) => u.includes(":1234/"))).toBe(true);
  });
});
