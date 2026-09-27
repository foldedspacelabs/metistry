// `Me/profile.md` as the facts a schedule follows, and the standup move
// (design-build-plan §2.5, §4 Q13; ticket T3-4). Everything here is pure:
// the console does the reading and writing (apps/console/src/profile-tidy.ts),
// and nothing here can write `Me/profile.md` at all.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STANDUP_DEFAULT_AT,
  parseScheduled,
  planStandupMove,
  profileFacts,
  profileFrontmatter,
  profileTime,
  profileWeekdays,
  readStandupKeys,
  resolveScheduleDays,
  withRoutineSchedule,
  withoutProfileKeys,
  type TimeOfDaySchedule,
} from "../src/index.js";

const seedProfile = (): string => readFileSync(new URL("../../../seed/vault/Me/profile.md", import.meta.url), "utf8");

const PROFILE = `---
source: user
# the facts the daily flow gates on
timezone: America/New_York
working_days: [mon, tue, wed, thu, fri]
standup_days: [mon, tue, wed, thu, fri]
standup_time: "09:15"
today_cap: 3
---
# Working profile

standup_time: this line is prose in the body, and stays.
`;

describe("profile facts — read, never guessed", () => {
  it("the seeded profile says nothing, and carries no standup keys", () => {
    const seed = seedProfile();
    expect(profileFacts(seed)).toEqual({});
    expect(readStandupKeys(seed)).toEqual({ state: "none" });
    expect(seed).not.toMatch(/standup_(days|time)/);
  });

  it("reads timezone and working_days, and nothing it was not told", () => {
    expect(profileFacts(PROFILE)).toEqual({ timezone: "America/New_York", working_days: ["mon", "tue", "wed", "thu", "fri"] });
    expect(profileFacts("---\nsource: user\n---\n")).toEqual({});
    expect(profileFacts(null)).toEqual({});
    expect(profileFacts("no frontmatter at all")).toEqual({});
    expect(profileFacts("---\nworking_days: [lundi]\ntimezone: \"\"\n---\n")).toEqual({}); // unreadable is not "every day", empty is not a zone
    expect(profileFacts("---\ntimezone: Mars/Olympus_Mons\n---\n")).toEqual({ timezone: "Mars/Olympus_Mons" }); // passed on, so it is refused, not skipped
  });

  it("weekdays in any spelling YAML admits, Sunday first", () => {
    expect(profileWeekdays(["fri", "mon"])).toEqual(["mon", "fri"]);
    expect(profileWeekdays(["Monday", "SUN"])).toEqual(["sun", "mon"]);
    expect(profileWeekdays("mon, wed")).toEqual(["mon", "wed"]);
    expect(profileWeekdays(undefined)).toBeNull();
    expect(profileWeekdays([])).toBeNull();
    expect(profileWeekdays(["lundi", 3])).toBeNull();
  });

  it("frontmatter that is not a mapping, or does not parse, is absent", () => {
    expect(profileFrontmatter("---\n- a\n- b\n---\n")).toBeNull();
    expect(profileFrontmatter("---\nkey: [unclosed\n---\n")).toBeNull();
  });
});

describe("working_days follows the profile until set", () => {
  const onSet: TimeOfDaySchedule = { days: "working_days", at: ["08:00"] };
  const eve: TimeOfDaySchedule = { days: "eve_of_working_days", at: ["23:00"] };
  const listed: TimeOfDaySchedule = { days: ["tue", "thu"], at: ["08:00"] };

  it("a profile with no working days → the routine is absent, not guessed", () => {
    for (const facts of [{}, profileFacts(seedProfile()), profileFacts("---\nworking_days: []\n---\n")]) {
      const r = resolveScheduleDays({ value: onSet, origin: "default" }, facts);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("no_working_days");
        expect(r.why).toContain("Me/profile.md");
      }
    }
  });

  it("a day set's days are from your profile; a list is the layer that wrote it", () => {
    const facts = profileFacts(PROFILE);
    expect(resolveScheduleDays({ value: onSet, origin: "default" }, facts)).toEqual({ ok: true, days: { value: ["mon", "tue", "wed", "thu", "fri"], origin: "profile" } });
    expect(resolveScheduleDays({ value: eve, origin: "yours" }, facts)).toEqual({ ok: true, days: { value: ["sun", "mon", "tue", "wed", "thu"], origin: "profile" } });
    expect(resolveScheduleDays({ value: listed, origin: "yours" }, {})).toEqual({ ok: true, days: { value: ["tue", "thu"], origin: "yours" } });
    expect(resolveScheduleDays({ value: listed, origin: "default" }, facts)).toEqual({ ok: true, days: { value: ["tue", "thu"], origin: "default" } });
  });
});

describe("reading the standup keys", () => {
  it("times as people write them, never guessed", () => {
    expect(profileTime("09:15")).toBe("09:15");
    expect(profileTime(" 9:05 ")).toBe("09:05");
    expect(profileTime("9:15 am")).toBe("09:15");
    expect(profileTime("12:30 AM")).toBe("00:30");
    expect(profileTime("1:30 PM")).toBe("13:30");
    expect(profileTime("12:00 p.m.")).toBe("12:00");
    for (const bad of ["24:00", "9", "nine", "13:00 pm", "09:60", 915, null]) expect(profileTime(bad)).toBeNull();
  });

  it("days that ARE the working days keep following the profile; any other list is copied", () => {
    expect(readStandupKeys(PROFILE)).toEqual({ state: "readable", keys: ["standup_days", "standup_time"], schedule: { days: "working_days", at: ["09:15"] } });
    const mwf = PROFILE.replace("standup_days: [mon, tue, wed, thu, fri]", "standup_days: [mon, wed, fri]");
    expect(readStandupKeys(mwf)).toMatchObject({ state: "readable", schedule: { days: ["mon", "wed", "fri"], at: ["09:15"] } });
    // no working_days to compare with: the list is the owner's, as written
    expect(readStandupKeys("---\nstandup_days: [mon, tue, wed, thu, fri]\n---\n")).toMatchObject({ schedule: { days: ["mon", "tue", "wed", "thu", "fri"], at: [STANDUP_DEFAULT_AT] } });
  });

  it("one key alone moves with the other's default", () => {
    expect(readStandupKeys("---\nstandup_time: 7:45\n---\n")).toEqual({ state: "readable", keys: ["standup_time"], schedule: { days: "working_days", at: ["07:45"] } });
  });

  it("a key that cannot be read moves nothing — the owner's words are never dropped for a default", () => {
    const r = readStandupKeys("---\nstandup_days: [mon]\nstandup_time: after coffee\n---\n");
    expect(r).toMatchObject({ state: "unreadable", keys: ["standup_days", "standup_time"] });
    if (r.state === "unreadable") expect(r.why).toContain("standup_time");
    expect(readStandupKeys("---\nstandup_days: someday\n---\n")).toMatchObject({ state: "unreadable" });
  });
});

describe("tidying the profile — the keys go, every other byte stays", () => {
  it("removes exactly the two lines: comments, other keys and the body are untouched", () => {
    const after = withoutProfileKeys(PROFILE, ["standup_days", "standup_time"]);
    expect(after).toBe(PROFILE.replace('standup_days: [mon, tue, wed, thu, fri]\nstandup_time: "09:15"\n', ""));
    expect(after).toContain("standup_time: this line is prose in the body, and stays.");
  });

  it("a block list goes with its key, and CRLF endings survive", () => {
    const block = "---\r\nsource: user\r\nstandup_days:\r\n  - mon\r\n  - tue\r\nstandup_time: '09:15'\r\ntoday_cap: 3\r\n---\r\nbody\r\n";
    expect(withoutProfileKeys(block, ["standup_days", "standup_time"])).toBe("---\r\nsource: user\r\ntoday_cap: 3\r\n---\r\nbody\r\n");
    const flush = "---\nstandup_days:\n- mon\n- tue\n# kept\ntoday_cap: 3\n---\n";
    expect(withoutProfileKeys(flush, ["standup_days"])).toBe("---\n# kept\ntoday_cap: 3\n---\n");
  });

  it("refuses what it cannot prove: a missing key, a nested key, no frontmatter", () => {
    expect(withoutProfileKeys(PROFILE, ["standup_days", "nope"])).toBeNull();
    expect(withoutProfileKeys("---\nflow: { standup_time: '09:15' }\n---\n", ["standup_time"])).toBeNull();
    expect(withoutProfileKeys("# no header\nstandup_time: 09:15\n", ["standup_time"])).toBeNull();
    expect(withoutProfileKeys("---\nstandup_time: 09:15\n", ["standup_time"])).toBeNull(); // never closed
  });

  it("a profile of only those keys keeps its (now empty) frontmatter", () => {
    expect(withoutProfileKeys("---\nstandup_time: 09:15\n---\nbody\n", ["standup_time"])).toBe("---\n---\nbody\n");
  });
});

describe("the overlay the move writes", () => {
  it("sets one routine's schedule and keeps what the owner wrote", () => {
    const mine = "# my changes\nroutines:\n  plan-tomorrow:\n    paused: true   # on holiday\n";
    const next = withRoutineSchedule(mine, "standup", { days: ["mon", "wed"], at: ["09:15"] });
    expect(next).toContain("# my changes");
    expect(next).toContain("# on holiday");
    expect(next).toContain(`schedule: { days: [ mon, wed ], at: [ "09:15" ] }`);
    const r = parseScheduled(next);
    expect(r.ok).toBe(true);
    expect(r.value?.routines?.["plan-tomorrow"]).toEqual({ paused: true });
    expect(r.value?.routines?.["standup"]).toEqual({ schedule: { days: ["mon", "wed"], at: ["09:15"] } });
    expect(parseScheduled(withRoutineSchedule("", "standup", { days: "working_days", at: ["08:00"] })).value).toEqual({ routines: { standup: { schedule: { days: "working_days", at: ["08:00"] } } } });
    expect(() => withRoutineSchedule("routines: [unclosed\n", "standup", { days: "working_days", at: ["08:00"] })).toThrow();
    expect(() => withRoutineSchedule("", "Standup", { days: "working_days", at: ["08:00"] })).toThrow();
  });
});

describe("planning the move", () => {
  it("nothing to move when the profile names no standup keys", () => {
    expect(planStandupMove(seedProfile(), null)).toEqual({ state: "none" });
    expect(planStandupMove(null, null)).toEqual({ state: "none" });
  });

  it("reads the keys once into the Standup routine's entry, and offers the tidy", () => {
    const m = planStandupMove(PROFILE, null);
    expect(m.state).toBe("move");
    if (m.state !== "move") return;
    expect(m.schedule).toEqual({ days: "working_days", at: ["09:15"] });
    expect(parseScheduled(m.overlay!).value).toEqual({ routines: { standup: { schedule: { days: "working_days", at: ["09:15"] } } } });
    expect(m.tidied).toBe(withoutProfileKeys(PROFILE, ["standup_days", "standup_time"]));
  });

  it("keeps the owner's own standup entry: config stays, and a schedule of theirs wins", () => {
    const withConfig = "routines:\n  standup:\n    config: { skip_without_calendar_event: true }\n";
    const m = planStandupMove(PROFILE, withConfig);
    expect(m.state === "move" && parseScheduled(m.overlay!).value?.routines?.["standup"]).toEqual({ config: { skip_without_calendar_event: true }, schedule: { days: "working_days", at: ["09:15"] } });
    const theirs = planStandupMove(PROFILE, 'routines:\n  standup:\n    schedule: { days: [sat], at: ["10:00"] }\n');
    expect(theirs).toMatchObject({ state: "move", overlay: null });
  });

  it("an invalid overlay is never rewritten — the move waits", () => {
    expect(planStandupMove(PROFILE, "routines:\n  standup: { every: 10m }\n")).toMatchObject({ state: "overlay_invalid", keys: ["standup_days", "standup_time"] });
  });

  it("an unreadable key moves nothing", () => {
    expect(planStandupMove("---\nstandup_time: whenever\n---\n", null)).toMatchObject({ state: "unreadable" });
  });
});
