// `metistry doctor` schedules section against a seeded `runs` table. The
// point of the section is that a component which has been failing every hour
// for a week is a SENTENCE, not a number on a tile — so every assertion here
// is about what the row says and whether doctor exits non-zero for it.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scheduleRows, type Db, type DoctorRow } from "../src/doctor.js";

const NOW = new Date("2026-09-15T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** A checkout with one hourly collector, one daily routine, and one on §2.5's time of day. */
async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "metistry-schedules-"));
  const put = async (rel: string, text: string) => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), text);
  };
  await put("collectors/gh/manifest.yaml", "name: gh\ntype: collector\nschedule: '@hourly'\nwrites: [work]\n");
  await put("routines/fold/manifest.yaml", "name: fold\ntype: routine\nschedule: '@daily'\n");
  await put("routines/brief/manifest.yaml", 'name: brief\ntype: routine\nschedule: { days: working_days, at: ["07:00"] }\n');
  return root;
}

interface Seed {
  component: string;
  kind: string;
  tool?: string;
  at: Date;
  ok: boolean | null;
  error?: string;
  meta?: Record<string, unknown>;
}

/** The three reads the section makes, answered from one seeded row list. */
const seededDb = (rows: Seed[]): Db => ({
  query: async (text: string, values: unknown[] = []) => {
    if (text.includes("last_ok")) {
      const kinds = values[0] as string[];
      const keys = [...new Set(rows.filter((r) => kinds.includes(r.kind)).map((r) => `${r.component} ${r.kind}`))];
      return {
        rows: keys.flatMap((key) => {
          const [component, kind] = key.split(" ") as [string, string];
          const mine = rows.filter((r) => r.component === component && r.kind === kind).sort((a, b) => +a.at - +b.at);
          const lastOk = [...mine].reverse().find((r) => r.ok === true);
          const open = mine.filter((r) => r.ok === false && (!lastOk || r.at > lastOk.at));
          return open.length === 0 ? [] : [{ component, kind, n: String(open.length), since: open[0]!.at, last_error: open.at(-1)!.error ?? null }];
        }),
      };
    }
    if (text.includes("DISTINCT ON")) {
      const kinds = values[0] as string[];
      const keys = [...new Set(rows.filter((r) => kinds.includes(r.kind)).map((r) => `${r.component} ${r.kind}`))];
      return {
        rows: keys.map((key) => {
          const [component, kind] = key.split(" ") as [string, string];
          const newest = rows.filter((r) => r.component === component && r.kind === kind).sort((a, b) => +b.at - +a.at)[0]!;
          return { component, kind, ts: newest.at, ok: newest.ok, error: newest.error ?? null, meta: newest.meta ?? {} };
        }),
      };
    }
    // the runner's own bookkeeping rows
    const tools = values[1] as string[];
    const markers = rows.filter((r) => r.kind === values[0] && r.tool && tools.includes(r.tool));
    return {
      rows: markers.map((m) => ({ component: m.component, tool: m.tool, ts: m.at, error: m.error ?? null })),
    };
  },
});

const byName = (rows: DoctorRow[]) => Object.fromEntries(rows.map((r) => [r.name, r]));
const rowsFor = async (seed: Seed[], env: NodeJS.ProcessEnv = {}) => byName(await scheduleRows(seededDb(seed), await checkout(), env, NOW));

describe("doctor: schedules", () => {
  it("one row per schedulable manifest, with last run, streak, next due", async () => {
    const r = await rowsFor([
      { component: "gh", kind: "collector_run", at: ago(10), ok: true },
      { component: "fold", kind: "routine_run", at: ago(30), ok: true },
    ]);
    expect(r.gh).toMatchObject({ kind: "schedule", status: "ok" });
    expect(r.gh?.meta).toMatchObject({
      dir: "collectors/gh",
      schedule: "@hourly",
      interval_sec: 3600,
      run_kind: "collector_run",
      last_run_at: ago(10).toISOString(),
      last_ok: true,
      streak: 0,
      error_signature: null,
      next_due_at: new Date(ago(10).getTime() + 3600_000).toISOString(),
      overdue_sec: 0,
      skipped_streak: false,
      preflight_failed: false,
    });
    expect(r.fold?.meta).toMatchObject({ run_kind: "routine_run", interval_sec: 86400 });
    expect(r.gh?.probe).toContain("@hourly");
  });

  it("never ran is absent, not failed — a fresh install is not broken", async () => {
    const r = await rowsFor([]);
    expect(r.gh?.status).toBe("absent");
    expect(r.gh?.remediation).toContain("no run recorded yet");
    expect(r.gh?.meta).toMatchObject({ last_run_at: null, streak: 0 });
    expect(r.gh?.action).toBeUndefined(); // a fresh install is not a problem to hand a button to
  });

  it("overdue by more than 2× the interval is a finding, and names where to look", async () => {
    const r = await rowsFor([{ component: "gh", kind: "collector_run", at: ago(185), ok: true }]);
    expect(r.gh?.status).toBe("failed");
    expect(r.gh?.remediation).toContain("over 2×");
    expect(r.gh?.remediation).toContain("metistry logs console");
    expect(r.gh?.meta).toMatchObject({ overdue_sec: 185 * 60 - 3600 });
    // T4-21: the same next step the remediation names, as a button
    expect(r.gh?.action).toEqual({ kind: "run_verb", command: ["metistry", "logs", "console"], label: "View console logs" });
  });

  it("an open streak below the limit degrades and names the limit's variable", async () => {
    const r = await rowsFor([
      { component: "gh", kind: "collector_run", at: ago(200), ok: true },
      { component: "gh", kind: "collector_run", at: ago(60), ok: false, error: "401 Bad credentials" },
      { component: "gh", kind: "collector_run", at: ago(5), ok: false, error: "401 Bad credentials" },
    ]);
    expect(r.gh?.status).toBe("degraded");
    expect(r.gh?.meta).toMatchObject({ streak: 2, last_ok: false });
    expect(r.gh?.meta?.error_signature).toMatch(/^[0-9a-f]{12}$/);
    expect(r.gh?.remediation).toContain("2 failed run(s) in a row");
    expect(r.gh?.remediation).toContain("METISTRY_RUNNER_MAX_STREAK (3)"); // three strikes by default (C135)
  });

  it("a fresh skipped_streak row is the state, and the limit it hit is the one you can raise", async () => {
    const r = await rowsFor(
      [
        { component: "gh", kind: "collector_run", at: ago(90), ok: false, error: "401 Bad credentials" },
        { component: "gh", kind: "runner", tool: "skipped_streak", at: ago(20), ok: false, error: "gh skipped: 7 consecutive failed runs" },
      ],
      { METISTRY_RUNNER_MAX_STREAK: "7" },
    );
    expect(r.gh?.status).toBe("failed");
    expect(r.gh?.meta).toMatchObject({ skipped_streak: true });
    expect(r.gh?.remediation).toContain("the runner has stopped running gh");
    expect(r.gh?.remediation).toContain("METISTRY_RUNNER_MAX_STREAK (7)"); // the env value, not the default
    expect(r.gh?.remediation).toContain("collectors/gh/manifest.yaml");
  });

  it("a stale marker is history, not a finding", async () => {
    const r = await rowsFor([
      { component: "gh", kind: "collector_run", at: ago(10), ok: true },
      { component: "gh", kind: "runner", tool: "preflight_failed", at: ago(60 * 24), ok: false, error: "blocked_config: old news" },
    ]);
    expect(r.gh?.status).toBe("ok");
    expect(r.gh?.meta).toMatchObject({ preflight_failed: false });
  });

  it("a blocked_config window reports the missing variable and the file that declares it", async () => {
    const r = await rowsFor([
      { component: "fold", kind: "runner", tool: "preflight_failed", at: ago(30), ok: false, error: "blocked_config: fold did not run — METISTRY_OPENROUTER_API_KEY is unset" },
    ]);
    expect(r.fold?.status).toBe("failed");
    expect(r.fold?.remediation).toContain("METISTRY_OPENROUTER_API_KEY is unset");
    expect(r.fold?.remediation).toContain("`requires` in routines/fold/manifest.yaml");
    expect(r.fold?.meta).toMatchObject({ preflight_failed: true });
  });

  // T3-1: a time of day is due at a slot, not an interval after the last
  // run. Doctor bounds it by the widest gap of its week (a day set: the
  // week, because it follows Me/profile.md) and does not guess when it is
  // next due — the console's runner, which reads the profile, knows that.
  it("a time-of-day schedule is said the way a person would, bounded by its week, with no guessed next-due", async () => {
    const r = await rowsFor([{ component: "brief", kind: "routine_run", at: ago(60 * 26), ok: true }]);
    expect(r.brief?.status).toBe("ok"); // 26 h since the last brief is inside a week's bound
    expect(r.brief?.probe).toContain("working days at 07:00 (at most");
    expect(r.brief?.meta).toMatchObject({ schedule: "working days at 07:00", interval_sec: 7 * 86400 + 3600, next_due_at: null });
  });

  it("a schedule the runner could not place is absent, and says why in the runner's own words", async () => {
    const why = "the schedule runs on working_days, and Me/profile.md does not say which days you work";
    const r = await rowsFor([
      { component: "brief", kind: "routine_run", at: ago(30), ok: true, meta: { schedule_refused: "no_working_days", why, outcome: "skipped:no_working_days" } },
    ]);
    expect(r.brief?.status).toBe("absent");
    expect(r.brief?.remediation).toBe(`not scheduled: ${why}`);
    expect(r.brief?.meta).toMatchObject({ schedule_refused: "no_working_days" });
  });

  // W1 checkpoint D2: the refusal is the LAST RUN's; the profile is read now
  describe("a no_working_days skip, once Me/profile.md has working_days", () => {
    const why = "the schedule runs on working_days, and Me/profile.md does not say which days you work";
    const refused = [{ component: "brief", kind: "routine_run", at: ago(30), ok: true, meta: { schedule_refused: "no_working_days", why, outcome: "skipped:no_working_days" } }];
    const withProfile = async (frontmatter: string) => {
      const inst = await mkdtemp(join(tmpdir(), "metistry-profile-"));
      await mkdir(join(inst, "Me"), { recursive: true });
      await writeFile(join(inst, "Me", "profile.md"), `---\n${frontmatter}---\n\n# Me\n`);
      return inst;
    };

    it("is history: ok, saying it was skipped and when it next runs — no refusal reported", async () => {
      const inst = await withProfile("timezone: America/New_York\nworking_days: [mon, tue, wed, thu, fri]\n");
      const r = await rowsFor(refused, { METISTRY_INSTANCE_DIR: inst });
      expect(r.brief?.status).toBe("ok");
      expect(r.brief?.remediation).toBeUndefined();
      // NOW is Tue 08:00 in New York, past 07:00 — so Wednesday's slot
      expect(r.brief?.meta).toMatchObject({ schedule_refused: "no_working_days", schedule_refused_now: null, next_due_at: "2026-09-16T11:00:00.000Z" });
      expect(r.brief?.meta?.["info"]).toBe(
        "was skipped at 2026-09-15T11:30Z (no_working_days) — Me/profile.md has working_days now, so it is scheduled again: nothing to do until the next run at 2026-09-16 07:00 America/New_York",
      );
    });

    it("takes the zone from METISTRY_TZ when the profile names none", async () => {
      const inst = await withProfile("working_days: [mon, wed]\n");
      const r = await rowsFor(refused, { METISTRY_INSTANCE_DIR: inst, METISTRY_TZ: "Europe/London" });
      expect(r.brief?.status).toBe("ok");
      expect(String(r.brief?.meta?.["info"])).toContain("until the next run at 2026-09-16 07:00 Europe/London");
    });

    it("still absent while the profile has no working_days — the runner's own words", async () => {
      const inst = await withProfile("timezone: America/New_York\n");
      const r = await rowsFor(refused, { METISTRY_INSTANCE_DIR: inst });
      expect(r.brief?.status).toBe("absent");
      expect(r.brief?.remediation).toBe(`not scheduled: ${why}`);
    });

    it("says the refusal that holds NOW when another one has taken its place (no timezone anywhere)", async () => {
      const inst = await withProfile("working_days: [mon, tue, wed, thu, fri]\n");
      const r = await rowsFor(refused, { METISTRY_INSTANCE_DIR: inst });
      expect(r.brief?.status).toBe("absent");
      expect(r.brief?.remediation).toMatch(/^not scheduled: no timezone/);
      expect(r.brief?.meta).toMatchObject({ schedule_refused: "no_working_days", schedule_refused_now: "no_timezone" });
    });
  });

  it("a last run that skipped for a missing template is degraded, names the template and the fix (W2 checkpoint D1)", async () => {
    const r = await rowsFor([
      { component: "brief", kind: "routine_run", at: ago(31), ok: true, meta: { processed: 0, outcome: "silent" } },
      { component: "brief", kind: "routine_run", at: ago(30), ok: true, meta: { brief_for: "2026-09-15", outcome: "skipped:template_missing", template: "Templates/Brief.md", max_bytes: 262144 } },
    ]);
    expect(r.brief?.status).toBe("degraded");
    expect(r.brief?.remediation).toContain("Templates/Brief.md is not in the vault");
    expect(r.brief?.remediation).toContain("`metistry update` re-seeds missing templates");
    expect(r.brief?.meta).toMatchObject({ template_missing: "Templates/Brief.md" });
    expect(r.brief?.action).toEqual({ kind: "run_verb", command: ["metistry", "update"], label: "Run metistry update" });
    // once a run writes the brief, the row is clean again
    const fixed = await rowsFor([
      { component: "brief", kind: "routine_run", at: ago(1470), ok: true, meta: { outcome: "skipped:template_missing", template: "Templates/Brief.md" } },
      { component: "brief", kind: "routine_run", at: ago(30), ok: true, meta: { brief_for: "2026-09-15", outcome: "acted" } },
    ]);
    expect(fixed.brief?.status).toBe("ok");
    expect(fixed.brief?.meta).toMatchObject({ template_missing: null });
  });

  it("a marker a later run has answered is history, even inside its window", async () => {
    const r = await rowsFor([
      { component: "fold", kind: "runner", tool: "preflight_failed", at: ago(120), ok: false, error: "blocked_config: fixed since" },
      { component: "fold", kind: "routine_run", at: ago(60), ok: true },
    ]);
    expect(r.fold?.status).toBe("ok");
    expect(r.fold?.meta).toMatchObject({ preflight_failed: false });
  });

  it("no db: one absent row, never a false clean bill of health", async () => {
    const rows = await scheduleRows(null, await checkout(), {}, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "schedule", name: "schedules", status: "absent" });
    expect(rows[0]?.remediation).toContain("METISTRY_DB_PASSWORD");
  });

  it("a db that cannot answer degrades the section instead of taking the report down", async () => {
    const broken: Db = { query: async () => { throw new Error('relation "runs" does not exist'); } };
    const rows = await scheduleRows(broken, await checkout(), {}, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "degraded" });
    expect(rows[0]?.remediation).toContain("pnpm db:migrate");
  });

  it("no schedulable manifests: no section at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "metistry-schedules-empty-"));
    expect(await scheduleRows(seededDb([]), root, {}, NOW)).toEqual([]);
  });
});
