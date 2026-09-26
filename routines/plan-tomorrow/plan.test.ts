// plan-tomorrow against fakes: the gate, the ownership rule, and what the
// routine does with a template it cannot use. The real-db suite
// (routines/test/plan-tomorrow.integration.test.ts) proves the SQL and a real
// render of the seeded template; this proves the decisions.
//
// Three properties carry the file:
//
//  1. **The gate is pure** — `gate()` takes a clock, a zone, a target date and
//     what `Me/profile.md` says, and returns a verdict. Too early, already
//     planned, not a working day and no `Me/` are four assertions with no
//     database, no vault and no clock of their own.
//  2. **It never writes a file it does not own** (§5.1). The plan file's own
//     frontmatter is the question asked, and a file with no `source:` at all
//     is the user's (#231).
//  3. **It writes exactly one file, idempotently.** Re-running the same
//     evening replaces the same path under compare-and-swap; nothing is
//     appended, nothing is duplicated, and no task line with a minted anchor
//     can reach a machine file (D4).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TemplateQueries } from "@foldedspacelabs/metistry-core";
import {
  COMPONENT,
  DEFAULT_DAY_END,
  EARLIEST_PLAN_HOUR,
  PLAN_DIR,
  PROFILE_PATH,
  TEMPLATE_PATH,
  dayEndOf,
  eventkitCalendar,
  gate,
  parseProfile,
  run,
  sourceOf,
  weekdayOf,
  workingDaysOf,
  type PlanCtx,
  type PlanVault,
} from "./run.js";

const SEED = fileURLToPath(new URL("../../seed/vault/", import.meta.url));
const seedFile = (rel: string): string => readFileSync(`${SEED}${rel}`, "utf8");

const ENV = { METISTRY_TZ: "America/New_York" } satisfies NodeJS.ProcessEnv;
const TZ = "America/New_York";
/** Monday 2026-09-21, 19:30 in New York — past a 17:30 day end, so the target is Tuesday 2026-09-22. */
const EVENING = new Date("2026-09-21T23:30:00Z");
const TARGET = "2026-09-22";
const PLAN_FILE = `${PLAN_DIR}/${TARGET}.md`;

const PROFILE = `---
source: user
timezone: America/New_York
working_days: [mon, tue, wed, thu, fri]
working_hours: "09:00-17:30"
---
# Working profile
`;

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface FakeVault extends PlanVault {
  files: Map<string, string>;
  writes: { path: string; text: string; principal: string; message: string; expected: string | undefined }[];
}

function fakeVault(files: Record<string, string> = {}): FakeVault {
  const store = new Map(Object.entries(files));
  const writes: FakeVault["writes"] = [];
  return {
    files: store,
    writes,
    async read(path) {
      const text = store.get(path);
      return text === undefined ? null : { content: Buffer.from(text, "utf8"), sha256: sha(text) };
    },
    async write(path, content, intent, expectedSha256) {
      const current = store.get(path);
      // the bridge's own compare-and-swap ("" = must not exist), so a test
      // that loses a race is a failing test rather than a silent overwrite
      const at = current === undefined ? "" : sha(current);
      if (expectedSha256 !== undefined && expectedSha256 !== at) throw new Error(`conflict: expected ${expectedSha256}, have ${at}`);
      const text = content.toString("utf8");
      store.set(path, text);
      writes.push({ path, text, principal: intent.principal, message: intent.message, expected: expectedSha256 });
      return { path, sha256: sha(text), bytes: Buffer.byteLength(text, "utf8"), created: current === undefined };
    },
  };
}

function fakeDb(settled: Record<string, unknown>[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    rows: (): Record<string, any>[] =>
      calls.filter((c) => c.text.includes("INSERT INTO runs")).map((c) => JSON.parse(String(c.values[1])) as Record<string, any>),
    proposals: (): Record<string, any>[] =>
      calls.filter((c) => c.text.includes("INSERT INTO proposals")).map((c) => JSON.parse(String(c.values[1])) as Record<string, any>),
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("FROM runs")) return { rows: settled };
      return { rows: [] };
    },
  };
}

class FakeQueries implements TemplateQueries {
  calls: { name: string; params: Record<string, string | number | boolean> }[] = [];
  constructor(private readonly tables: Record<string, Record<string, unknown>[]> = {}) {}
  async run(name: string, params: Record<string, string | number | boolean>): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ name, params });
    return { rows: this.tables[name] ?? [] };
  }
}

/** The whole vault a plan needs: the six seeded templates' Plan.md, the prose it includes, and a filled-in profile. */
const vaultWithSeed = (extra: Record<string, string> = {}): FakeVault =>
  fakeVault({
    [TEMPLATE_PATH]: seedFile("Templates/Plan.md"),
    [PROFILE_PATH]: PROFILE,
    "Me/Working Style.md": seedFile("Me/Working Style.md"),
    ...extra,
  });

const ctxWith = (vault: FakeVault, queries: TemplateQueries, over: Partial<PlanCtx> = {}): PlanCtx => ({
  vault,
  queries,
  calendar: null, // no eventkit bridge in this suite: §6.4's line, and the plan still lands
  now: EVENING,
  env: ENV,
  ...over,
});

// ---------------------------------------------------------------- the gate

describe("plan-tomorrow: what Me/ says, and what it does not", () => {
  it("reads working_days in every shape YAML admits, and never invents one", () => {
    expect(workingDaysOf(["mon", "tue", "wed", "thu", "fri"])).toEqual([1, 2, 3, 4, 5]);
    expect(workingDaysOf(["Monday", "SUN"])).toEqual([0, 1]);
    expect(workingDaysOf("mon, wed")).toEqual([1, 3]);
    expect(workingDaysOf(undefined)).toBeNull();
    expect(workingDaysOf(["lundi"])).toBeNull(); // not readable is not "all of them"
  });

  it("reads the day's end from working_hours, and refuses anything else", () => {
    expect(dayEndOf("09:00-17:30")).toBe(17 * 60 + 30);
    expect(dayEndOf("9:00 - 17:00")).toBe(17 * 60);
    expect(dayEndOf("mornings")).toBeNull();
    expect(dayEndOf("09:00-25:00")).toBeNull();
  });

  it("the SEEDED Me/profile.md says nothing — every fact is commented out on purpose (#237)", () => {
    const profile = parseProfile(seedFile("Me/profile.md"));
    expect(profile.workingDays).toBeNull();
    expect(profile.dayEnd).toBeNull();
  });

  it("no working_days → nothing is written and the run says so, rather than guessing Monday-to-Friday (§6.6)", () => {
    const verdict = gate({ now: EVENING, timeZone: TZ, target: TARGET, profile: parseProfile(null) });
    expect(verdict).toMatchObject({ ok: false, reason: "no_working_days" });
    if (!verdict.ok) expect(verdict.why).toContain(PROFILE_PATH);
  });

  it("before the day end Me/ states, nothing is planned — the day it plans from is not over", () => {
    const afternoon = new Date("2026-09-21T20:30:00Z"); // 16:30 New York, an hour before 17:30
    const verdict = gate({ now: afternoon, timeZone: TZ, target: TARGET, profile: parseProfile(PROFILE) });
    expect(verdict).toMatchObject({ ok: false, reason: "too_early" });
    if (!verdict.ok) expect(verdict.why).toContain("17:30");
  });

  it(`a day that ends before ${EARLIEST_PLAN_HOUR}:00 still waits for it — a plan written over breakfast is a plan for a day that has not happened`, () => {
    const early = `---\nworking_days: [mon, tue, wed, thu, fri]\nworking_hours: "01:00-06:00"\n---\n`;
    const breakfast = new Date("2026-09-21T14:00:00Z"); // 10:00 New York, past 06:00 and before noon
    expect(gate({ now: breakfast, timeZone: TZ, target: TARGET, profile: parseProfile(early) })).toMatchObject({ ok: false, reason: "too_early" });
  });

  it("the eve of a day you do not work is silent", () => {
    const friday = new Date("2026-09-25T23:30:00Z"); // Friday 19:30 New York → target Saturday
    const verdict = gate({ now: friday, timeZone: TZ, target: "2026-09-26", profile: parseProfile(PROFILE) });
    expect(weekdayOf("2026-09-26")).toBe(6);
    expect(verdict).toMatchObject({ ok: false, reason: "not_a_working_day" });
  });

  it("no working_hours → the plan is written from the default hour and SAYS which (§6.4 visible, never silent)", () => {
    const noHours = `---\nworking_days: [mon, tue, wed, thu, fri]\n---\n`;
    const sevenPm = new Date("2026-09-21T23:30:00Z");
    const verdict = gate({ now: sevenPm, timeZone: TZ, target: TARGET, profile: parseProfile(noHours) });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.note).toContain("working_hours");
      expect(verdict.note).toContain(DEFAULT_DAY_END);
    }
    // …and at 18:00, before that default, it is still too early
    expect(gate({ now: new Date("2026-09-21T22:00:00Z"), timeZone: TZ, target: TARGET, profile: parseProfile(noHours) })).toMatchObject({ ok: false, reason: "too_early" });
  });
});

// ------------------------------------------------------------ one per night

describe("plan-tomorrow: one plan an evening", () => {
  it("before noon it touches nothing at all — no query, no vault read", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), { now: new Date("2026-09-21T13:00:00Z") }))).toBe(0);
    expect(db.calls).toHaveLength(0);
    expect(vault.writes).toHaveLength(0);
  });

  it("a target date this routine has already settled is not planned twice", async () => {
    const db = fakeDb([{ meta: { planned_for: TARGET, outcome: "acted" } }]);
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries()))).toBe(0);
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toHaveLength(0); // the settled row is the record; a second is noise
  });

  it("too early writes no row — it is the schedule working, not news", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), { now: new Date("2026-09-21T20:30:00Z") }))).toBe(0);
    expect(db.rows()).toHaveLength(0);
    expect(vault.writes).toHaveLength(0);
  });

  it("a night it decides NOT to plan is recorded once, with the reason", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [PROFILE_PATH]: "---\nsource: user\n---\n" });
    expect(await run(db, ctxWith(vault, new FakeQueries()))).toBe(0);
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: TARGET, outcome: "skipped:no_working_days" })]);
    expect(vault.writes).toHaveLength(0);
  });
});

// ------------------------------------------------------------ the template

describe("plan-tomorrow: a template it cannot use", () => {
  it("a missing template writes nothing and is a configuration fact, not a failure (§6.4)", async () => {
    const db = fakeDb();
    const vault = fakeVault({ [PROFILE_PATH]: PROFILE });
    expect(await run(db, ctxWith(vault, new FakeQueries()))).toBe(0);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:template_missing", template: TEMPLATE_PATH })]);
    expect(db.proposals()).toHaveLength(0); // silent, deliberately
    expect(vault.writes).toHaveLength(0);
  });

  it("a template over the cap writes nothing and raises ONE report naming the file", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [TEMPLATE_PATH]: "x".repeat(200) });
    expect(await run(db, ctxWith(vault, new FakeQueries(), { env: { ...ENV, METISTRY_TEMPLATE_MAX_BYTES: "100" } }))).toBe(0);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:template_unreadable" })]);
    const [report] = db.proposals();
    expect(report?.title).toContain(TEMPLATE_PATH);
    expect(report?.refs).toEqual([TEMPLATE_PATH]);
    expect(vault.writes).toHaveLength(0);
  });
});

// ------------------------------------------------------------- the writing

describe("plan-tomorrow: the file it writes", () => {
  const queries = (): FakeQueries =>
    new FakeQueries({
      vault_tasks_query: [{ path: "Journal/2026-09-20.md", text: "Call the dentist", due: TARGET, priority: 1, size: "S" }],
      vault_tasks_recurring: [{ text: "Water the plants", recur_rule: "every week", recur_next: TARGET }],
    });

  it("renders the seeded Templates/Plan.md into Journal/Plan/<tomorrow>.md as principal plan-tomorrow", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, queries()))).toBe(1);

    const [write] = vault.writes;
    expect(write?.path).toBe(PLAN_FILE);
    expect(write?.principal).toBe(COMPONENT);
    expect(write?.message).toBe(`plan for ${TARGET}`);
    expect(write?.expected).toBe(""); // create-only: the file must not already exist

    const text = write?.text ?? "";
    expect(text).toContain("source: plan-tomorrow"); // what ownershipRefusal reads later (§5.1)
    expect(text).not.toContain("tags:"); // a plan is not a template
    expect(text).toContain(`# Plan — ${TARGET}`);
    expect(text).toContain("- [[Journal/2026-09-20]] — Call the dentist");
    expect(text).toContain("no calendar — the eventkit bridge is not reachable"); // absent is not failed
    expect(text).toContain("## Prioritisation");
    expect(text).toContain(`<!-- rendered by ${COMPONENT} from ${TEMPLATE_PATH}`);

    const [row] = db.rows();
    expect(row).toMatchObject({ planned_for: TARGET, outcome: "acted", path: PLAN_FILE, created: true, truncated: false });
    expect(row?.template_warnings).toBe(1); // the missing calendar, and only that
  });

  it("a recurring rule is PROPOSED, never materialised — no checkbox, no minted anchor (§4, D4)", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    await run(db, ctxWith(vault, queries()));
    const text = vault.files.get(PLAN_FILE) ?? "";
    expect(text).toContain("## Recurring tomorrow");
    expect(text).toContain(`- Water the plants — every week, due ${TARGET}`);
    expect(text).not.toMatch(/- \[ \] Water the plants/);
    expect(text).not.toMatch(/\^mt-/);
  });

  it("re-running the same evening rewrites the SAME file under compare-and-swap", async () => {
    const vault = vaultWithSeed();
    expect(await run(fakeDb(), ctxWith(vault, queries()))).toBe(1);
    const first = vault.files.get(PLAN_FILE) ?? "";

    // a second pass with the day not yet settled (the row is the gate; this is
    // the write being idempotent underneath it)
    expect(await run(fakeDb(), ctxWith(vault, queries()))).toBe(1);
    expect(vault.writes).toHaveLength(2);
    expect(vault.writes[1]?.path).toBe(PLAN_FILE);
    expect(vault.writes[1]?.expected).toBe(sha(first)); // CAS on what it just read, not a blind replace
    expect(vault.writes[1]?.text).toBe(first); // same inputs, same file — nothing appended
    expect([...vault.files.keys()].filter((p) => p.startsWith(PLAN_DIR))).toEqual([PLAN_FILE]);
  });

  it("a plan file the USER has taken over is never overwritten (§5.1's ownership rule)", async () => {
    const mine = `---\nsource: user\n---\n# my own plan\n`;
    const db = fakeDb();
    const vault = vaultWithSeed({ [PLAN_FILE]: mine });
    expect(await run(db, ctxWith(vault, queries()))).toBe(0);
    expect(vault.files.get(PLAN_FILE)).toBe(mine);
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:user_owned", source: "user" })]);
  });

  it("…and a plan file with NO source: at all is the user's too (#231), not ownerless", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [PLAN_FILE]: "# notes I dropped in here\n" });
    expect(sourceOf("# notes I dropped in here\n")).toBeNull();
    expect(await run(db, ctxWith(vault, queries()))).toBe(0);
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:user_owned", source: null })]);
  });

  it("no query store wired → each directive says so and the plan still lands (§6.4)", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, undefined as unknown as TemplateQueries, { queries: undefined }))).toBe(1);
    const text = vault.files.get(PLAN_FILE) ?? "";
    expect(text).toContain("⚠️ metistry:");
    expect(text).toContain(`# Plan — ${TARGET}`);
    expect(db.rows()[0]?.template_warnings).toBeGreaterThan(1);
  });

  it("the honest note about a defaulted day end lands in the file, under the frontmatter", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [PROFILE_PATH]: `---\nworking_days: [mon, tue, wed, thu, fri]\n---\n` });
    expect(await run(db, ctxWith(vault, queries()))).toBe(1);
    const text = vault.files.get(PLAN_FILE) ?? "";
    const body = text.slice(text.indexOf("---", 3) + 4);
    expect(body.trimStart().startsWith("> ⚠️ metistry:")).toBe(true);
    expect(text).toContain("has no `working_hours`");
    expect(db.rows()[0]?.degraded).toEqual(["working_hours"]);
  });
});

// -------------------------------------------------------------- the calendar

describe("plan-tomorrow: the eventkit bridge, one day at a time", () => {
  const event = (start: string, title: string) => ({ title, start, end: start, all_day: false, location: "", calendar: "Work" });

  it("asks for the window that reaches the day asked for, and keeps only that day's events", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(
        JSON.stringify({
          events: [event("2026-09-21T18:00:00Z", "today's standup"), event("2026-09-22T14:00:00Z", "tomorrow's review")],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const calendar = eventkitCalendar({ ekUrl: "http://ek.test/", ekToken: "t", fetchFn }, TZ, EVENING);
    const events = await calendar!.events(TARGET);
    expect(asked).toEqual(["http://ek.test/events?days=2"]); // §7: `GET /events?days=2` is exactly tomorrow
    expect(events.map((e) => e.title)).toEqual(["tomorrow's review"]);
  });

  it("no bridge configured → no provider at all, which the engine renders as a fact", () => {
    expect(eventkitCalendar({}, TZ, EVENING)).toBeNull();
    expect(eventkitCalendar({ ekUrl: "http://ek.test" }, TZ, EVENING)).toBeNull();
  });

  it("a bridge that refuses is absent, not fatal: the plan still lands", async () => {
    const fetchFn = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), { calendar: undefined, ekUrl: "http://ek.test", ekToken: "t", fetchFn }))).toBe(1);
    expect(vault.files.get(PLAN_FILE)).toContain("no calendar — the eventkit bridge is not reachable");
  });
});
