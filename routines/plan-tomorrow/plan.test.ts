// plan-tomorrow against fakes: the gate, the ownership rule, and what the
// routine does with a template it cannot use. The real-db suite
// (routines/test/plan-tomorrow.integration.test.ts) proves the SQL and a real
// render of the seeded template; this proves the decisions.
//
// Three properties carry the file:
//
//  1. **The guard is pure** — `gate()` takes a target date and what
//     `Me/profile.md` says, and returns a verdict. Not a working day and no
//     `Me/` are assertions with no database, no vault and no clock. There is
//     no clock gate at all any more: the console's runner fires the routine
//     at its slot (§2.5, T3-1), and a late run plans from that slot.
//  2. **It never writes a file it does not own** (§5.1). The plan file's own
//     frontmatter is the question asked, and a file with no `source:` at all
//     is the user's (#231).
//  3. **It writes exactly one file, idempotently.** Re-running the same
//     evening replaces the same path under compare-and-swap; nothing is
//     appended, nothing is duplicated, and no task line with a minted anchor
//     can reach a machine file (D4).
//  4. **Early, then superseded** (§2.5, T3-7). Close the Day renders the plan
//     early and never asks whether the date is settled; the 23:00 run
//     replaces that render with tonight's fold. Only the SCHEDULED pass asks
//     whether a date is already settled — a close never asks, and since
//     ruling 15 (X-15) neither does Run Now: it always re-renders, even after
//     the 23:00 run has settled the date. The fake `runs` table below answers
//     the settled read the way its SQL does, so one fake carries a whole
//     evening.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TemplateQueries } from "@foldedspacelabs/metistry-core";
import {
  COMPONENT,
  FOLD_HEADING,
  PLAN_DIR,
  PROFILE_PATH,
  TEMPLATE_PATH,
  dayEndOf,
  eventkitCalendar,
  foldSection,
  gate,
  instantOn,
  isCalendarDate,
  parseProfile,
  refuseMaterialised,
  run,
  runZone,
  sourceOf,
  triggerOf,
  weekdayOf,
  withFoldSection,
  workingDaysOf,
  zoneOf,
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

/**
 * The `runs` table as this routine uses it: the rows it was seeded with plus
 * every row a pass inserts, and the settled read answered the way its SQL
 * says — same `planned_for`, and not a Close the Day row. The real-db suite
 * proves the SQL itself; this lets one fake carry a whole evening.
 */
function fakeDb(seeded: Record<string, unknown>[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const inserted = (): Record<string, any>[] =>
    calls.filter((c) => c.text.includes("INSERT INTO runs")).map((c) => JSON.parse(String(c.values[1])) as Record<string, any>);
  return {
    calls,
    rows: inserted,
    proposals: (): Record<string, any>[] =>
      calls.filter((c) => c.text.includes("INSERT INTO proposals")).map((c) => JSON.parse(String(c.values[1])) as Record<string, any>),
    settledReads: (): number => calls.filter((c) => c.text.includes("FROM runs")).length,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("FROM runs")) {
        const metas = [...seeded.map((r) => (r["meta"] ?? {}) as Record<string, any>), ...inserted()].reverse(); // newest first
        const hit = metas.find((m) => m["planned_for"] === values[1] && !(text.includes("IS DISTINCT FROM 'close'") && m["trigger"] === "close"));
        return { rows: hit ? [{ meta: hit }] : [] };
      }
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
    const verdict = gate({ target: TARGET, profile: parseProfile(null) });
    expect(verdict).toMatchObject({ ok: false, reason: "no_working_days" });
    if (!verdict.ok) expect(verdict.why).toContain(PROFILE_PATH);
  });

  it("the working-day guard stays: the eve of a day you do not work is silent", () => {
    const verdict = gate({ target: "2026-09-26", profile: parseProfile(PROFILE) }); // Friday's run → Saturday
    expect(weekdayOf("2026-09-26")).toBe(6);
    expect(verdict).toMatchObject({ ok: false, reason: "not_a_working_eve" });
    if (!verdict.ok) expect(verdict.why).toContain("not the eve of a working day");
  });

  it("no clock in the guard: a working day is planned whatever the hour, and with no working_hours nothing is defaulted", () => {
    expect(gate({ target: TARGET, profile: parseProfile(PROFILE) })).toEqual({ ok: true });
    expect(gate({ target: TARGET, profile: parseProfile(`---\nworking_days: [mon, tue, wed, thu, fri]\n---\n`) })).toEqual({ ok: true });
  });
});

// ------------------------------------------------------------ one per night

describe("plan-tomorrow: one plan an evening", () => {
  // T3-1: the runner fires it at 23:00 on the eve of a working day and hands
  // it the slot. A run the Mac slept through is fired on waking, and plans
  // the day after its SLOT — not the day after the moment it woke.
  it("a late run plans the day after its slot, in the slot's zone — Sunday 23:00 caught up on Monday morning plans Monday", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    const sunday2300 = new Date("2026-09-21T03:00:00Z"); // Sun 23:00 EDT
    const mondayMorning = new Date("2026-09-21T11:30:00Z"); // Mon 07:30 EDT, when the Mac woke
    const ctx = ctxWith(vault, new FakeQueries(), { now: mondayMorning, scheduledFor: sunday2300, timeZone: TZ });
    expect(await run(db, ctx)).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([`${PLAN_DIR}/2026-09-21.md`]);
    expect(vault.writes[0]?.text).toContain("# Plan — 2026-09-21"); // the template's "tomorrow" is the slot's
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: "2026-09-21", outcome: "acted" })]);
  });

  it("no clock gate: a run in the morning is a plan, not a silent tick", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), { now: new Date("2026-09-21T13:00:00Z") }))).toBe(1); // Mon 09:00 EDT
    expect(vault.writes.map((w) => w.path)).toEqual([PLAN_FILE]);
  });

  it("the slot's zone decides which day is tomorrow — not METISTRY_TZ", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    // 23:30 Monday in New York is already Tuesday in Tokyo
    const ctx = ctxWith(vault, new FakeQueries(), { now: EVENING, scheduledFor: new Date("2026-09-22T03:30:00Z"), timeZone: "Asia/Tokyo" });
    expect(await run(db, ctx)).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([`${PLAN_DIR}/2026-09-23.md`]);
  });

  it("a target date already settled by a scheduled pass is not planned twice by another one", async () => {
    const db = fakeDb([{ meta: { planned_for: TARGET, outcome: "acted" } }]);
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), { scheduledFor: EVENING, timeZone: TZ }))).toBe(0);
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toHaveLength(0); // the settled row is the record; a second is noise
  });

  it("…but Run Now never asks — ruling 15 (X-15): it always re-renders, settled or not", async () => {
    const db = fakeDb([{ meta: { planned_for: TARGET, outcome: "acted", trigger: "schedule" } }]);
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries()))).toBe(1); // no scheduledFor, no closedDay → manual
    expect(vault.writes.map((w) => w.path)).toEqual([PLAN_FILE]);
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: TARGET, outcome: "acted", trigger: "manual" })]);
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

  it("no working_hours defaults nothing: the plan is written at its slot, with no note about a day end", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [PROFILE_PATH]: `---\nworking_days: [mon, tue, wed, thu, fri]\n---\n` });
    expect(await run(db, ctxWith(vault, queries()))).toBe(1);
    const text = vault.files.get(PLAN_FILE) ?? "";
    expect(text).not.toContain("working_hours");
    expect(db.rows()[0]).not.toHaveProperty("degraded");
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

// ------------------------------------------------- which evenings plan (§2.5)

describe("plan-tomorrow: eve_of_working_days — Sunday to Thursday plan, Friday and Saturday do not", () => {
  // 23:00 in New York on each evening, as the runner's slot (EDT, UTC−4)
  const slot = (utc: string): Partial<PlanCtx> => ({ now: new Date(utc), scheduledFor: new Date(utc), timeZone: TZ });

  it("with Monday–Friday working days, a Sunday 23:00 run plans Monday", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), slot("2026-09-21T03:00:00Z")))).toBe(1); // Sun 2026-09-20 23:00
    expect(vault.writes.map((w) => w.path)).toEqual([`${PLAN_DIR}/2026-09-21.md`]);
    expect(weekdayOf("2026-09-21")).toBe(1);
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: "2026-09-21", outcome: "acted", trigger: "schedule" })]);
  });

  it("…and a Thursday 23:00 run plans Friday", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), slot("2026-09-25T03:00:00Z")))).toBe(1); // Thu 2026-09-24 23:00
    expect(vault.writes.map((w) => w.path)).toEqual([`${PLAN_DIR}/2026-09-25.md`]);
    expect(weekdayOf("2026-09-25")).toBe(5);
  });

  it("a Friday 23:00 run is skipped not_a_working_eve — nothing plans Monday on a Friday", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), slot("2026-09-26T03:00:00Z")))).toBe(0); // Fri 2026-09-25 23:00
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: "2026-09-26", outcome: "skipped:not_a_working_eve", trigger: "schedule" })]);
    expect(db.rows()[0]?.why).toContain("2026-09-26 is not one of your working days");
  });

  it("…and so is a Saturday 23:00 run", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), slot("2026-09-27T03:00:00Z")))).toBe(0); // Sat 2026-09-26 23:00
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: "2026-09-27", outcome: "skipped:not_a_working_eve" })]);
  });
});

// ------------------------------------------------ the zone, never TZ (T3-5)

describe("plan-tomorrow: the zone is METISTRY_TZ, never TZ", () => {
  it("zoneOf reads METISTRY_TZ and ignores TZ, which both deployment shapes pin to UTC", () => {
    expect(zoneOf({ TZ: "Asia/Tokyo" })).toBe("UTC");
    expect(zoneOf({ METISTRY_TZ: "America/New_York", TZ: "UTC" })).toBe("America/New_York");
    expect(zoneOf({})).toBe("UTC");
  });

  it("a run nobody scheduled dates in the profile's timezone, then METISTRY_TZ — and a slot's zone beats both", () => {
    const profile = `---\ntimezone: Asia/Tokyo\n---\n`;
    expect(runZone({}, profile, { METISTRY_TZ: TZ })).toBe("Asia/Tokyo");
    expect(runZone({}, `---\ntimezone: Mars/Olympus\n---\n`, { METISTRY_TZ: TZ })).toBe(TZ); // a zone Intl does not know is not one to date in
    expect(runZone({}, null, { TZ: "Asia/Tokyo" })).toBe("UTC");
    expect(runZone({ timeZone: "Europe/Paris" }, profile, { METISTRY_TZ: TZ })).toBe("Europe/Paris");
  });

  it("TZ set to a zone where it is already tomorrow does not move the plan a day", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [PROFILE_PATH]: `---\nworking_days: [mon, tue, wed, thu, fri]\n---\n` });
    // Monday 19:30 in New York is Tuesday morning in Tokyo; only METISTRY_TZ counts
    expect(await run(db, ctxWith(vault, new FakeQueries(), { env: { METISTRY_TZ: TZ, TZ: "Asia/Tokyo" } }))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([PLAN_FILE]);
  });
});

// --------------------------------------------------------- tonight's fold

const FOLD_DATE = "2026-09-21"; // the Monday evening EVENING is in
const FOLD_FILE = `Journal/Fold/${FOLD_DATE}.md`;
const FOLD = `---
source: knowledge-fold
decisions:
  - Ship the router behind a flag
  - "[ ] this is not a task"
  - { owner: nobody }
---
# Fold — ${FOLD_DATE}
`;

describe("plan-tomorrow: tonight's fold, linked and its decisions listed (model-free)", () => {
  it("links Journal/Fold/<tonight>.md and lists its decisions: frontmatter, verbatim and inert", async () => {
    const section = await foldSection(fakeVault({ [FOLD_FILE]: FOLD }), FOLD_DATE, false);
    expect(section).toMatchObject({ path: FOLD_FILE, linked: true, decisions: 2 });
    expect(section.markdown).toContain(FOLD_HEADING);
    expect(section.markdown).toContain(`[[Journal/Fold/${FOLD_DATE}]]`);
    expect(section.markdown).toContain("- Ship the router behind a flag");
    // a leading `[` can never make a checkbox in a machine file (D4)
    expect(section.markdown).toContain("- \\[ ] this is not a task");
    expect(section.markdown).not.toMatch(/^- \[ \]/m);
    // a mapping is not guessed at: counted, and pointed at the fold
    expect(section.markdown).toContain("1 `decisions:` entry is not a line of text");
  });

  it("a fold with no decisions says so; a missing fold says so — differently for the early render", async () => {
    const none = await foldSection(fakeVault({ [FOLD_FILE]: "---\nsource: knowledge-fold\n---\n# Fold\n" }), FOLD_DATE, false);
    expect(none).toMatchObject({ linked: true, decisions: 0 });
    expect(none.markdown).toContain("No decisions in its `decisions:` frontmatter");

    const missing = await foldSection(fakeVault(), FOLD_DATE, false);
    expect(missing).toMatchObject({ linked: false, decisions: 0 });
    expect(missing.markdown).toContain(`No fold for ${FOLD_DATE}`);
    expect(missing.markdown).not.toContain("[[");

    const early = await foldSection(fakeVault(), FOLD_DATE, true);
    expect(early.markdown).toContain("Tonight's fold has not run yet — the 11:00 PM plan replaces this one");
  });

  it("a decision over the line cap is clipped, and past the list cap the rest are counted", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `  - decision ${i + 1}`).join("\n");
    const long = "x".repeat(400);
    const section = await foldSection(fakeVault({ [FOLD_FILE]: `---\ndecisions:\n  - ${long}\n${many}\n---\n` }), FOLD_DATE, false);
    expect(section.decisions).toBe(20);
    expect(section.markdown).toContain(`- ${"x".repeat(239)}…`);
    expect(section.markdown).toContain("…and 6 more in the fold.");
  });

  it("the section goes after the template's body and BEFORE the provenance footer, which stays the last line", () => {
    const rendered = "---\nsource: plan-tomorrow\n---\n# Plan\n\nbody\n\n<!-- rendered by plan-tomorrow from Templates/Plan.md -->\n";
    const out = withFoldSection(rendered, `${FOLD_HEADING}\n\nx\n`);
    expect(out.indexOf(FOLD_HEADING)).toBeGreaterThan(out.indexOf("body"));
    expect(out.trimEnd().endsWith("-->")).toBe(true);
    expect(out.split("<!-- rendered by")).toHaveLength(2);
  });

  it("the 23:00 plan carries the fold's section, and the ledger says what it linked", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [FOLD_FILE]: FOLD });
    expect(await run(db, ctxWith(vault, new FakeQueries()))).toBe(1);
    const text = vault.files.get(PLAN_FILE) ?? "";
    expect(text).toContain(`${FOLD_HEADING}\n\n[[Journal/Fold/${FOLD_DATE}]]`);
    expect(text).toContain("- Ship the router behind a flag");
    expect(text.indexOf(FOLD_HEADING)).toBeGreaterThan(text.indexOf("## Prioritisation"));
    expect(text.trimEnd().endsWith("-->")).toBe(true);
    expect(db.rows()[0]).toMatchObject({ outcome: "acted", fold: FOLD_FILE, fold_linked: true, fold_decisions: 2 });
  });

  it("a decision smuggling a task line onto a line of its own stays ONE inert line — no checkbox, no anchor line", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed({ [FOLD_FILE]: `---\ndecisions:\n  - "x\\n- [ ] sneaky ^mt-abcdefgh"\n---\n` });
    expect(await run(db, ctxWith(vault, new FakeQueries()))).toBe(1);
    const text = vault.files.get(PLAN_FILE) ?? "";
    expect(text).toContain("- x - [ ] sneaky ^mt-abcdefgh"); // newlines collapse: one decision, one line
    expect(text).not.toMatch(/^- \[ \] sneaky/m);
    expect(refuseMaterialised(text)).toBe(false);
  });
});

// ------------------------------------- Close the Day: early, then superseded

describe("plan-tomorrow: Close the Day renders early, and the 23:00 run supersedes it", () => {
  const MONDAY_1730 = new Date("2026-09-21T21:30:00Z"); // Mon 17:30 EDT, when the owner closes the day
  const MONDAY_2300 = new Date("2026-09-22T03:00:00Z"); // the slot
  const close = (over: Partial<PlanCtx> = {}): Partial<PlanCtx> => ({ now: MONDAY_1730, closedDay: FOLD_DATE, ...over });
  const at2300 = (over: Partial<PlanCtx> = {}): Partial<PlanCtx> => ({ now: MONDAY_2300, scheduledFor: MONDAY_2300, timeZone: TZ, ...over });

  it("says who asked on every row: close, schedule or manual", () => {
    expect(triggerOf({ closedDay: FOLD_DATE, scheduledFor: MONDAY_2300 })).toBe("close");
    expect(triggerOf({ scheduledFor: MONDAY_2300 })).toBe("schedule");
    expect(triggerOf({})).toBe("manual");
  });

  it("a close renders tomorrow's plan early, before there is a fold, and says the 23:00 run will replace it", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), close()))).toBe(1);
    expect(vault.writes).toEqual([expect.objectContaining({ path: PLAN_FILE, principal: COMPONENT, message: `plan for ${TARGET} (at Close the Day)`, expected: "" })]);
    expect(vault.files.get(PLAN_FILE)).toContain("Tonight's fold has not run yet");
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: TARGET, outcome: "acted", trigger: "close", fold_linked: false })]);
    expect(db.settledReads()).toBe(0); // a close never asks whether the date is settled
  });

  it("a second close re-renders — closing again is asking again", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), close()))).toBe(1);
    const first = vault.files.get(PLAN_FILE) ?? "";
    expect(await run(db, ctxWith(vault, new FakeQueries(), close({ now: new Date("2026-09-21T22:10:00Z") })))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([PLAN_FILE, PLAN_FILE]);
    expect(vault.writes[1]?.expected).toBe(sha(first)); // CAS on the early render it replaces
    expect(db.rows().map((r) => r["trigger"])).toEqual(["close", "close"]);
  });

  it("the 23:00 run supersedes the early render with the fold's context", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    await run(db, ctxWith(vault, new FakeQueries(), close()));
    const early = vault.files.get(PLAN_FILE) ?? "";

    vault.files.set(FOLD_FILE, FOLD); // the 21:00 fold lands
    expect(await run(db, ctxWith(vault, new FakeQueries(), at2300()))).toBe(1);
    expect(vault.writes).toHaveLength(2);
    expect(vault.writes[1]).toMatchObject({ path: PLAN_FILE, message: `plan for ${TARGET}`, expected: sha(early) });
    const late = vault.files.get(PLAN_FILE) ?? "";
    expect(late).toContain(`[[Journal/Fold/${FOLD_DATE}]]`);
    expect(late).toContain("- Ship the router behind a flag");
    expect(late).not.toContain("has not run yet");
    expect(db.rows().map((r) => [r["trigger"], r["outcome"]])).toEqual([
      ["close", "acted"],
      ["schedule", "acted"],
    ]);
  });

  it("…and once the 23:00 run has settled the date, a second scheduled pass stays silent", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    await run(db, ctxWith(vault, new FakeQueries(), close()));
    await run(db, ctxWith(vault, new FakeQueries(), at2300()));
    expect(await run(db, ctxWith(vault, new FakeQueries(), at2300({ now: new Date("2026-09-22T03:01:00Z") })))).toBe(0);
    expect(vault.writes).toHaveLength(2);
    expect(db.rows()).toHaveLength(2);
  });

  it("…but Run Now after that 23:00 run re-renders the plan instead of staying silent (ruling 15, X-15)", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    await run(db, ctxWith(vault, new FakeQueries(), close()));
    await run(db, ctxWith(vault, new FakeQueries(), at2300()));
    const settled = vault.files.get(PLAN_FILE) ?? "";

    expect(await run(db, ctxWith(vault, new FakeQueries(), { now: new Date("2026-09-22T03:05:00Z") }))).toBe(1); // Run Now
    expect(vault.writes).toHaveLength(3);
    expect(vault.writes[2]).toMatchObject({ path: PLAN_FILE, expected: sha(settled) }); // CAS on the 23:00 render it replaces
    expect(db.rows().map((r) => [r["trigger"], r["outcome"]])).toEqual([
      ["close", "acted"],
      ["schedule", "acted"],
      ["manual", "acted"],
    ]);
  });

  it("a close after 23:00 still re-renders — the owner's act, not a duplicate", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    await run(db, ctxWith(vault, new FakeQueries(), at2300()));
    expect(await run(db, ctxWith(vault, new FakeQueries(), close({ now: new Date("2026-09-22T03:30:00Z") })))).toBe(1);
    expect(vault.writes).toHaveLength(2);
  });

  it("a close that decided NOT to plan does not settle the date: the 23:00 run tries again", async () => {
    const db = fakeDb();
    const vault = fakeVault({ [PROFILE_PATH]: PROFILE }); // no template yet at 17:30
    expect(await run(db, ctxWith(vault, new FakeQueries(), close()))).toBe(0);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:template_missing", trigger: "close" })]);

    vault.files.set(TEMPLATE_PATH, seedFile("Templates/Plan.md")); // fixed before bed
    vault.files.set("Me/Working Style.md", seedFile("Me/Working Style.md"));
    expect(await run(db, ctxWith(vault, new FakeQueries(), at2300()))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([PLAN_FILE]);
  });

  it("a Friday close is skipped not_a_working_eve, like the Friday evening itself", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    expect(await run(db, ctxWith(vault, new FakeQueries(), close({ closedDay: "2026-09-25", now: new Date("2026-09-25T21:30:00Z") })))).toBe(0);
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toEqual([expect.objectContaining({ planned_for: "2026-09-26", outcome: "skipped:not_a_working_eve", trigger: "close" })]);
  });

  it("a close of an earlier day plans the day after THAT day, not after the clock's", async () => {
    const db = fakeDb();
    const vault = vaultWithSeed();
    // Tuesday morning, closing Monday (forgotten last night): plans Tuesday
    expect(await run(db, ctxWith(vault, new FakeQueries(), close({ closedDay: "2026-09-21", now: new Date("2026-09-22T13:00:00Z") })))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([`${PLAN_DIR}/2026-09-22.md`]);
    expect(vault.files.get(`${PLAN_DIR}/2026-09-22.md`)).toContain("# Plan — 2026-09-22");
    expect(instantOn("2026-09-21", TZ, new Date("2026-09-22T13:00:00Z")).toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(instantOn("2026-09-21", "Pacific/Kiritimati", new Date("2026-09-25T00:00:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("a closedDay that is not a real date is a caller's bug, and loud", async () => {
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-09-21")).toBe(true);
    const db = fakeDb();
    const vault = vaultWithSeed();
    await expect(run(db, ctxWith(vault, new FakeQueries(), close({ closedDay: "tomorrow" })))).rejects.toThrow(/closedDay must be a YYYY-MM-DD date/);
    expect(vault.writes).toHaveLength(0);
    expect(db.rows()).toHaveLength(0);
  });
});
