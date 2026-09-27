// The Standup routine against fakes (T3-5; design-build-plan §2.13, §2.5):
// the decisions. The real-db suite (routines/test/standup.integration.test.ts)
// renders the seeded template through the real named queries; the console's
// suites prove the runner never fires it without working days
// (scheduler.test.ts) and that its file landing is a `routine.status`
// (events.integration.test.ts).
//
// What this file carries:
//
//  1. **Nothing is written without working days** — the ticket's test — on
//     the path nobody scheduled (Run Now) as well as the runner's.
//  2. **One file, its own, as `source: standup`** — written through the
//     vault bridge as principal `standup`, dated from the slot, never over a
//     file it does not own, and never twice for one morning.
//  3. **No model in the routine** — the seeded template asks none; a `prose`
//     line (legal since C103) is a pending slot and exactly ONE turn.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CalendarEvent, TemplateQueries } from "@foldedspacelabs/metistry-core";
import { PROFILE_PATH } from "@foldedspacelabs/metistry-core";
import {
  COMPONENT,
  DEFAULT_TEMPLATE,
  PRINCIPAL,
  STANDUP_DIR,
  run,
  standupConfig,
  standupOnCalendar,
  standupPath,
  type StandupCtx,
} from "./run.js";
import type { PlanVault } from "../plan-tomorrow/run.js";

const SEED = fileURLToPath(new URL("../../seed/vault/", import.meta.url));
const seedFile = (rel: string): string => readFileSync(`${SEED}${rel}`, "utf8");

const TZ = "America/New_York";
const ENV = { METISTRY_TZ: TZ } satisfies NodeJS.ProcessEnv;
/** Monday 2026-09-21, 08:00 in New York — the default slot. */
const MONDAY_0800 = new Date("2026-09-21T12:00:00Z");
const DATE = "2026-09-21";
const FILE = standupPath(DATE);

const PROFILE = `---
source: user
timezone: America/New_York
working_days: [mon, tue, wed, thu, fri]
---
# Working profile
`;
const NO_DAYS = `---
source: user
timezone: America/New_York
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
      const at = current === undefined ? "" : sha(current);
      if (expectedSha256 !== undefined && expectedSha256 !== at) throw new Error(`conflict: expected ${expectedSha256}, have ${at}`);
      const text = content.toString("utf8");
      store.set(path, text);
      writes.push({ path, text, principal: intent.principal, message: intent.message, expected: expectedSha256 });
      return { path, sha256: sha(text), bytes: Buffer.byteLength(text, "utf8"), created: current === undefined };
    },
  };
}

/** The runs table as far as this routine reads it: an `acted` row for a date is a date written. */
function fakeDb() {
  const calls: { text: string; values: unknown[] }[] = [];
  const inserted = (table: string) => calls.filter((c) => c.text.includes(`INSERT INTO ${table}`)).map((c) => JSON.parse(String(c.values[1])) as Record<string, any>);
  return {
    calls,
    rows: () => inserted("runs"),
    proposals: () => inserted("proposals"),
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("FROM runs")) {
        const [component, date] = values as [string, string];
        return { rows: inserted("runs").filter((m) => component === COMPONENT && m.standup_for === date && m.outcome === "acted").map(() => ({ "?column?": 1 })) };
      }
      return { rows: [] };
    },
  };
}

class FakeQueries implements TemplateQueries {
  calls: string[] = [];
  constructor(private readonly tables: Record<string, Record<string, unknown>[]> = {}) {}
  async run(name: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push(name);
    return { rows: this.tables[name] ?? [] };
  }
}

const seededVault = (extra: Record<string, string> = {}): FakeVault =>
  fakeVault({
    [DEFAULT_TEMPLATE]: seedFile("Templates/Standup.md"),
    [PROFILE_PATH]: PROFILE,
    "Me/Working Style.md": seedFile("Me/Working Style.md"),
    ...extra,
  });

const ctxWith = (vault: FakeVault, over: Partial<StandupCtx> = {}): StandupCtx => ({
  vault,
  queries: new FakeQueries(),
  calendar: null,
  now: MONDAY_0800,
  scheduledFor: MONDAY_0800,
  timeZone: TZ,
  env: ENV,
  ...over,
});

const calendarWith = (events: Partial<CalendarEvent>[]) => ({
  async events(day: string): Promise<CalendarEvent[]> {
    return day === DATE ? (events.map((e) => ({ start: `${DATE}T13:30:00Z`, end: `${DATE}T13:45:00Z`, all_day: false, ...e })) as CalendarEvent[]) : [];
  },
});

// ------------------------------------------------------------ working days

describe("standup: nothing is written without working days", () => {
  it("a profile that does not say which days you work → no file, and the run says so (skipped:no_working_days)", async () => {
    const db = fakeDb();
    const vault = seededVault({ [PROFILE_PATH]: NO_DAYS });
    expect(await run(db, ctxWith(vault))).toBe(0);
    expect(vault.writes).toEqual([]);
    expect(db.rows()).toEqual([expect.objectContaining({ standup_for: DATE, outcome: "skipped:no_working_days" })]);
    expect(db.rows()[0]!.why).toContain(PROFILE_PATH);
  });

  it("the SEEDED profile (every fact commented out, #237) and no profile at all are the same answer", async () => {
    for (const files of [{ [PROFILE_PATH]: seedFile("Me/profile.md") }, { [PROFILE_PATH]: undefined as unknown as string }]) {
      const db = fakeDb();
      const vault = seededVault(files);
      if (files[PROFILE_PATH] === undefined) vault.files.delete(PROFILE_PATH);
      expect(await run(db, ctxWith(vault))).toBe(0);
      expect(vault.writes).toEqual([]);
      expect(db.rows().map((r) => r.outcome)).toEqual(["skipped:no_working_days"]);
    }
  });

  it("Run Now (no slot) asks the same question — the runner is not the only gate", async () => {
    const db = fakeDb();
    const vault = seededVault({ [PROFILE_PATH]: NO_DAYS });
    expect(await run(db, ctxWith(vault, { scheduledFor: undefined, timeZone: undefined }))).toBe(0);
    expect(vault.writes).toEqual([]);
  });

  it("a skip does not settle the morning: once the profile says, the next run writes", async () => {
    const db = fakeDb();
    const vault = seededVault({ [PROFILE_PATH]: NO_DAYS });
    expect(await run(db, ctxWith(vault))).toBe(0);
    vault.files.set(PROFILE_PATH, PROFILE);
    expect(await run(db, ctxWith(vault))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([FILE]);
  });

  it("which days it runs is the schedule's: a Saturday slot the owner scheduled is written (no working-day guard in the routine)", async () => {
    const db = fakeDb();
    const vault = seededVault();
    const saturday = new Date("2026-09-26T13:00:00Z");
    expect(await run(db, ctxWith(vault, { now: saturday, scheduledFor: saturday }))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([standupPath("2026-09-26")]);
  });
});

// ------------------------------------------------------------- the file

describe("standup: one file, its own, as source: standup", () => {
  it("renders the seeded Templates/Standup.md into Journal/Standup/<date>.md, written as principal standup", async () => {
    const db = fakeDb();
    const vault = seededVault();
    const queries = new FakeQueries();
    expect(await run(db, ctxWith(vault, { queries }))).toBe(1);
    expect(vault.writes).toHaveLength(1);
    const w = vault.writes[0]!;
    expect(w).toMatchObject({ path: `${STANDUP_DIR}/${DATE}.md`, principal: PRINCIPAL, message: `standup for ${DATE}`, expected: "" });
    expect(PRINCIPAL).toBe("standup");
    expect(w.text).toMatch(/^---\n[\s\S]*source: standup\n[\s\S]*---\n/);
    expect(w.text).not.toContain("tags: [template]");
    expect(w.text).toContain(`# Standup — ${DATE}`);
    expect(w.text).toContain("## Yesterday");
    expect(w.text).toContain("## Today");
    // the owner's own standup rule, included verbatim
    expect(w.text).toContain("yesterday / today / blockers");
    // every row came through the named-query door (invariant 3)
    expect(queries.calls).toContain("vault_tasks_query");
    expect(db.rows()).toEqual([expect.objectContaining({ standup_for: DATE, outcome: "acted", path: FILE, template: DEFAULT_TEMPLATE, created: true })]);
  });

  it("a late run is dated from its slot: Friday's 08:00, caught up on Monday, writes Friday's file", async () => {
    const db = fakeDb();
    const vault = seededVault();
    const friday = new Date("2026-09-25T12:00:00Z");
    expect(await run(db, ctxWith(vault, { scheduledFor: friday, now: MONDAY_0800 }))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([standupPath("2026-09-25")]);
    expect(vault.writes[0]!.text).toContain("# Standup — 2026-09-25");
  });

  it("Run Now dates in the profile's zone, not UTC: 01:30 UTC Tuesday is still Monday in New York", async () => {
    const db = fakeDb();
    const vault = seededVault();
    const late = new Date("2026-09-22T01:30:00Z");
    expect(await run(db, ctxWith(vault, { scheduledFor: undefined, timeZone: undefined, now: late, env: {} }))).toBe(1);
    expect(vault.writes.map((w) => w.path)).toEqual([FILE]);
  });

  it("never twice for one morning: a second run for a written date writes nothing", async () => {
    const db = fakeDb();
    const vault = seededVault();
    expect(await run(db, ctxWith(vault))).toBe(1);
    expect(await run(db, ctxWith(vault))).toBe(0);
    expect(vault.writes).toHaveLength(1);
  });

  it("its own file from an earlier run is replaced under compare-and-swap, never raced", async () => {
    const db = fakeDb();
    const mine = `---\nsource: standup\n---\n# Standup — ${DATE}\nold\n`;
    const vault = seededVault({ [FILE]: mine });
    expect(await run(db, ctxWith(vault))).toBe(1);
    expect(vault.writes[0]).toMatchObject({ path: FILE, expected: sha(mine) });
    expect(db.rows()[0]).toMatchObject({ outcome: "acted", created: false });
  });

  it("**a file it does not own is never overwritten** — the owner's (no source:, or source: user) or another writer's", async () => {
    for (const theirs of [`# my own standup notes\n`, `---\nsource: user\n---\nmine\n`, `---\nsource: assistant\n---\nnot the routine's\n`]) {
      const db = fakeDb();
      const vault = seededVault({ [FILE]: theirs });
      expect(await run(db, ctxWith(vault))).toBe(0);
      expect(vault.writes).toEqual([]);
      expect(vault.files.get(FILE)).toBe(theirs);
      expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:user_owned", path: FILE })]);
    }
  });

  it("the template its config names is the one rendered — and a config value of the wrong kind is refused, never coerced", async () => {
    const db = fakeDb();
    const vault = seededVault({ "Templates/Standup Notes.md": "---\nsource: user\n---\n# Notes — {{ date }}\n" });
    expect(await run(db, ctxWith(vault, { config: { template: "Templates/Standup Notes.md" } }))).toBe(1);
    expect(vault.writes[0]!.text).toContain(`# Notes — ${DATE}`);
    expect(db.rows()[0]).toMatchObject({ template: "Templates/Standup Notes.md" });

    expect(standupConfig(undefined)).toEqual({ template: DEFAULT_TEMPLATE, skipWithoutEvent: false });
    expect(() => standupConfig({ template: 7 })).toThrow(/config\.template/);
    expect(() => standupConfig({ skip_without_calendar_event: "no" })).toThrow(/config\.skip_without_calendar_event/);
    await expect(run(fakeDb(), ctxWith(seededVault(), { config: { skip_without_calendar_event: "yes" } }))).rejects.toThrow(/nothing was written/);
  });
});

// ------------------------------------------------------------- degrading

describe("standup: what it does with a template it cannot use (§6.4)", () => {
  it("no template → nothing written, recorded as a configuration fact", async () => {
    const db = fakeDb();
    const vault = seededVault();
    vault.files.delete(DEFAULT_TEMPLATE);
    expect(await run(db, ctxWith(vault))).toBe(0);
    expect(vault.writes).toEqual([]);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:template_missing" })]);
    expect(db.proposals()).toEqual([]);
  });

  it("an unreadable template → nothing written, and ONE report request names the file", async () => {
    const db = fakeDb();
    const vault = seededVault({ [DEFAULT_TEMPLATE]: "x".repeat(40_000) });
    expect(await run(db, ctxWith(vault))).toBe(0);
    expect(vault.writes).toEqual([]);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:template_unreadable" })]);
    expect(db.proposals()).toEqual([expect.objectContaining({ refs: [DEFAULT_TEMPLATE] })]);
  });

  it("no vault bridge → nothing to do, and no row (the runner's preflight names the variables)", async () => {
    const db = fakeDb();
    expect(await run(db, { now: MONDAY_0800, env: ENV })).toBe(0);
    expect(db.calls).toEqual([]);
  });
});

// ------------------------------------------------------------- no model

describe("standup: model-free by default, one turn for prose (C103)", () => {
  it("the seeded template asks no model: no slot, no turn", async () => {
    const db = fakeDb();
    const vault = seededVault();
    expect(await run(db, ctxWith(vault))).toBe(1);
    expect(vault.writes[0]!.text).not.toContain("metistry:prose");
    expect(db.calls.some((c) => c.text.includes("inbound_messages"))).toBe(false);
    expect(db.rows()[0]).toMatchObject({ prose_slots: 0 });
  });

  it("`prose` lines are pending slots in the file it writes, and ONE turn names them all", async () => {
    const db = fakeDb();
    const vault = seededVault({ [DEFAULT_TEMPLATE]: '---\nsource: user\n---\n# Standup — {{ date }}\n\n{{ prose "say what matters" }}\n\n{{ prose "say what is blocked" }}\n' });
    expect(await run(db, ctxWith(vault))).toBe(1);
    const text = vault.writes[0]!.text;
    expect(vault.writes[0]!.principal).toBe(PRINCIPAL); // the file stays the routine's
    expect(text).toContain("<!-- metistry:prose 1 --> _pending");
    expect(text).toContain("<!-- metistry:prose 2 --> _pending");
    const turns = db.calls.filter((c) => c.text.includes("INSERT INTO inbound_messages"));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.values[0]).toBe(COMPONENT);
    expect(String(turns[0]!.values[1])).toContain("1. say what matters");
    expect(String(turns[0]!.values[1])).toContain("2. say what is blocked");
    expect(JSON.parse(String(turns[0]!.values[2]))).toMatchObject({ kind: "prose", tier: "routine", fresh_session: true, source: COMPONENT, path: FILE, slots: 2 });
    expect(db.rows()[0]).toMatchObject({ prose_slots: 2, template_warnings: 0 });
  });
});

// --------------------------------------------- skip_without_calendar_event

describe("standup: skip_without_calendar_event", () => {
  const on = { config: { skip_without_calendar_event: true } };

  it("on, and no standup on today's calendar → no file (skipped:no_standup_event)", async () => {
    const db = fakeDb();
    const vault = seededVault();
    expect(await run(db, ctxWith(vault, { ...on, calendar: calendarWith([{ title: "Design review" }]) }))).toBe(0);
    expect(vault.writes).toEqual([]);
    expect(db.rows()).toEqual([expect.objectContaining({ outcome: "skipped:no_standup_event" })]);
  });

  it("on, and a standup on the calendar → written", async () => {
    const db = fakeDb();
    const vault = seededVault();
    expect(await run(db, ctxWith(vault, { ...on, calendar: calendarWith([{ title: "Team Stand-up" }]) }))).toBe(1);
    expect(db.rows()[0]).toMatchObject({ outcome: "acted", on_calendar: "yes" });
  });

  it("on, and a calendar that cannot be asked → still written: unknown is never a reason to skip", async () => {
    const db = fakeDb();
    const vault = seededVault();
    expect(await run(db, ctxWith(vault, { ...on, calendar: null }))).toBe(1);
    expect(db.rows()[0]).toMatchObject({ outcome: "acted", on_calendar: "unknown" });
    const refusing = { async events(): Promise<CalendarEvent[]> { throw new Error("eventkit answered 503"); } };
    expect(await standupOnCalendar(refusing, DATE)).toBe("unknown");
  });

  it("off (the default) → the calendar is not asked at all", async () => {
    let asked = 0;
    const counting = { async events(): Promise<CalendarEvent[]> { asked++; return []; } };
    const db = fakeDb();
    const vault = seededVault();
    expect(await run(db, ctxWith(vault, { calendar: counting }))).toBe(1);
    expect(asked).toBe(0);
    expect(db.rows()[0]).not.toHaveProperty("on_calendar");
  });
});
