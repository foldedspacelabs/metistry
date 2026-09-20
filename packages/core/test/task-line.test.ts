// The task line (P1-1, daily-flow-spec §1). The parser decides what a line the
// user typed by hand MEANS, so the cases that matter most are the ones where
// it must decide it means nothing: `@Jim` in the middle of a sentence assigns
// nobody, `due nextweek` sets no date, and a line that is not a checkbox is
// not a task.
import { describe, expect, it } from "vitest";
import {
  ANCHOR_ALPHABET,
  ANCHOR_LENGTH,
  EXT_REF_SCHEMES,
  PRIORITY_ALIASES,
  SIZE_ALIASES,
  UNSET_PRIORITY,
  calendarDate,
  formatTaskLine,
  isTaskAnchor,
  nextRecurrence,
  normalizeTaskText,
  parseTaskLine,
  resolveTaskDate,
  type ParsedTaskLine,
} from "../src/task-line.js";

// A Friday, 08:00 in New York — so "friday" is next Friday and the zone is
// doing real work rather than agreeing with UTC by accident.
const NOW = new Date("2026-09-18T12:00:00Z");
const TZ = "America/New_York";
const at = { now: NOW, timeZone: TZ };

const parse = (line: string): ParsedTaskLine => {
  const t = parseTaskLine(line, at);
  if (!t) throw new Error(`not a task line: ${line}`);
  return t;
};

describe("parseTaskLine — the §1.1 examples", () => {
  it("reads every line in the spec's own sample", () => {
    expect(parse("- [ ] Call the dentist due friday")).toMatchObject({
      text: "Call the dentist", due: "2026-09-25", checked: false, dropped: false,
    });
    expect(parse("- [ ] Draft the Q4 plan due 2026-09-30 p1 size l type planning +drey")).toMatchObject({
      text: "Draft the Q4 plan", due: "2026-09-30", priority: 1, size: "l", type: "planning", project: "drey",
    });
    expect(parse("- [ ] Send Jim the brand deck @Jim due tomorrow")).toMatchObject({
      text: "Send Jim the brand deck", assigned: "Jim", due: "2026-09-19",
    });
    expect(parse("- [ ] Water the plants every week")).toMatchObject({
      text: "Water the plants", recurrence: { rule: "every week", unit: "week", interval: 1 },
    });
    expect(parse("- [x] Send the contract")).toMatchObject({ text: "Send the contract", checked: true });
  });

  it("is not fooled by lines that are not tasks", () => {
    for (const line of ["", "## Heading", "- a plain bullet", "  not a list", "- [] missing a space", "[ ] no bullet", "- [?] not a box"]) {
      expect(parseTaskLine(line, at)).toBeNull();
    }
  });

  it("keeps the indent, the marker and the box it found", () => {
    expect(parse("    * [x] Nested and done")).toMatchObject({ indent: "    ", marker: "*", checked: true, text: "Nested and done" });
    expect(parse("- [-] Dropped")).toMatchObject({ dropped: true, checked: false });
    expect(parse("+ [ ] Plus marker")).toMatchObject({ marker: "+" });
  });
});

describe("the trailing run (§1.1)", () => {
  it("stops at the first token that is not a field — `@Jim` mid-text assigns nobody", () => {
    const t = parse("- [ ] Ask @Jim about the pricing deck");
    expect(t.assigned).toBeNull();
    expect(t.text).toBe("Ask @Jim about the pricing deck");
  });

  it("takes the run when it does reach the end of the line", () => {
    const t = parse("- [ ] Ask Jim about pricing @Jim due friday");
    expect(t.assigned).toBe("Jim");
    expect(t.text).toBe("Ask Jim about pricing");
  });

  it("leaves the text verbatim, punctuation and all", () => {
    expect(parse("- [ ] Email Ana re: the Q4 numbers (draft #2) p1").text).toBe("Email Ana re: the Q4 numbers (draft #2)");
  });

  it("reads a line that is nothing but fields, and one with no fields at all", () => {
    expect(parse("- [ ] due friday")).toMatchObject({ text: "", due: "2026-09-25" });
    expect(parse("- [ ] Just a thing")).toMatchObject({ text: "Just a thing", due: null, priority: null });
  });

  it("does not turn a trailing keyword with nothing after it into a field", () => {
    const t = parse("- [ ] Work out what there is to do");
    expect(t.scheduled_for).toBeNull();
    expect(t.text).toBe("Work out what there is to do");
  });
});

describe("every field of §1.3", () => {
  it("due, do, start and done", () => {
    expect(parse("- [ ] A due 2026-09-22").due).toBe("2026-09-22");
    expect(parse("- [ ] A do monday").scheduled_for).toBe("2026-09-21");
    expect(parse("- [ ] A start 2026-10-01").start_on).toBe("2026-10-01");
    expect(parse("- [x] A done 2026-09-17").done_on).toBe("2026-09-17");
    expect(parse("- [x] A").done_on).toBeNull(); // done_on_observed is the index's, not the line's
  });

  it("every date form the spec lists", () => {
    const due = (v: string): string | null => parse(`- [ ] A due ${v}`).due;
    expect(due("2026-09-22")).toBe("2026-09-22");
    expect(due("today")).toBe("2026-09-18");
    expect(due("tomorrow")).toBe("2026-09-19");
    expect(due("yesterday")).toBe("2026-09-17");
    expect(due("friday")).toBe("2026-09-25"); // the NEXT friday, never today
    expect(due("fri")).toBe("2026-09-25");
    expect(due("monday")).toBe("2026-09-21");
    expect(due("next week")).toBe("2026-09-25");
    expect(due("next month")).toBe("2026-10-18");
    expect(due("next tuesday")).toBe("2026-09-22");
    expect(due("22 sep")).toBe("2026-09-22");
    expect(due("sep 22")).toBe("2026-09-22");
    expect(due("22 september")).toBe("2026-09-22");
    expect(due("1 sep")).toBe("2027-09-01"); // a day that has already gone is next year's
    expect(due("+3d")).toBe("2026-09-21");
    expect(due("+2w")).toBe("2026-10-02");
  });

  it("every priority alias, and unset is unset", () => {
    for (const [alias, level] of Object.entries(PRIORITY_ALIASES)) {
      expect(parse(`- [ ] A ${alias}`).priority).toBe(level);
      expect(parse(`- [ ] A ${alias.toUpperCase()}`).priority).toBe(level);
    }
    expect(parse("- [ ] A").priority).toBeNull();
    expect(UNSET_PRIORITY).toBe(3); // sorts as normal; never stored as one
    expect(parse("- [ ] A priority high").priority).toBe(2);
  });

  it("every size alias", () => {
    for (const [alias, size] of Object.entries(SIZE_ALIASES)) {
      expect(parse(`- [ ] A size ${alias}`).size).toBe(size);
    }
    expect(parse("- [ ] A").size).toBeNull();
  });

  it("type is free text, not an enum (D6)", () => {
    for (const slug of ["coding", "reading", "meeting", "errand", "deep-work"]) {
      expect(parse(`- [ ] A type ${slug}`).type).toBe(slug);
    }
  });

  it("assigned reads both the bare name and the wikilink", () => {
    expect(parse("- [ ] A @Jim")).toMatchObject({ assigned: "Jim", assigned_is_wikilink: false });
    expect(parse("- [ ] A @[[Jim Fallon]]")).toMatchObject({ assigned: "Jim Fallon", assigned_is_wikilink: true });
    expect(parse("- [ ] A @O'Brien").assigned).toBe("O'Brien");
  });

  it("project, waiting and source", () => {
    expect(parse("- [ ] A +drey").project).toBe("drey");
    expect(parse("- [ ] A @Jim waiting")).toMatchObject({ waiting: true, assigned: "Jim" });
    expect(parse("- [ ] A").waiting).toBe(false);
    expect(parse("- [ ] Water the plants source template:recurring").source).toBe("template:recurring");
    expect(parse("- [ ] A source mail:CAF%2B1@mail.example").source).toBe("mail:CAF%2B1@mail.example");
  });

  it("links: one-way references, and the promotion pointer", () => {
    const t = parse("- [ ] A linear:ABC-123 gh:owner/repo#418 work:418");
    expect(t.ext_refs).toEqual(["linear:ABC-123", "gh:owner/repo#418"]);
    expect(t.work_id).toBe(418);
    expect(EXT_REF_SCHEMES).toEqual(["linear", "gh"]);
    expect(parse("- [ ] Read the note: it is long").ext_refs).toEqual([]); // a colon is not a scheme
  });

  it("the anchor comes off the end, without its caret", () => {
    const t = parse("- [ ] Call the dentist due friday ^mt-7x2k9abc");
    expect(t.anchor).toBe("mt-7x2k9abc");
    expect(t.text).toBe("Call the dentist");
    expect(isTaskAnchor("mt-7x2k9abc")).toBe(true);
    expect(isTaskAnchor("mt-7x2k")).toBe(false);
    expect(isTaskAnchor("mt-illegal0")).toBe(false); // Crockford: no i, l, o or u
    expect(ANCHOR_LENGTH).toBe(8);
    expect(ANCHOR_ALPHABET).not.toMatch(/[ilou]/);
  });

  it("text_norm is the dedupe key of §2.3", () => {
    expect(normalizeTaskText("Call the Dentist!")).toBe("call the dentist");
    expect(parse("- [ ] Call  the dentist. due friday").text_norm).toBe("call the dentist");
  });
});

describe("recurrence (§4)", () => {
  const rec = (line: string) => parse(line).recurrence;

  it("reads every rule shape the spec names", () => {
    expect(rec("- [ ] A every day")).toMatchObject({ unit: "day", interval: 1, next: "2026-09-18" });
    expect(rec("- [ ] A every weekday")).toMatchObject({ unit: "weekday", interval: 1, next: "2026-09-18" });
    expect(rec("- [ ] A every week")).toMatchObject({ unit: "week", interval: 1 });
    expect(rec("- [ ] A every 2 weeks")).toMatchObject({ unit: "week", interval: 2, rule: "every 2 weeks" });
    expect(rec("- [ ] A every month")).toMatchObject({ unit: "month", interval: 1 });
    expect(rec("- [ ] A every 3 months")).toMatchObject({ unit: "month", interval: 3 });
    expect(rec("- [ ] A every year")).toMatchObject({ unit: "year", interval: 1 });
    expect(rec("- [ ] A every other week")).toMatchObject({ unit: "week", interval: 2 });
  });

  it("takes `due` as the pin, not as a date, on a rule line", () => {
    const monthly = parse("- [ ] Pay the card every month due 28");
    expect(monthly.text).toBe("Pay the card");
    expect(monthly.due).toBeNull();
    expect(monthly.recurrence).toMatchObject({ pin_day: 28, next: "2026-09-28" });

    const weekly = parse("- [ ] Standup notes every week due monday type meeting size s");
    expect(weekly.recurrence).toMatchObject({ pin_weekday: 1, next: "2026-09-21" });
    expect(weekly).toMatchObject({ type: "meeting", size: "s", due: null });
  });

  it("a weekday on its own is a weekly rule", () => {
    expect(rec("- [ ] A every friday")).toMatchObject({ unit: "week", pin_weekday: 5, next: "2026-09-18" });
  });

  it("nextRecurrence counts from the previous instance when there is one", () => {
    expect(nextRecurrence({ unit: "week", interval: 2, pin_weekday: null, pin_day: null }, "2026-09-18", "2026-09-18")).toBe("2026-10-02");
    expect(nextRecurrence({ unit: "month", interval: 1, pin_day: 28, pin_weekday: null }, "2026-09-18", "2026-09-28")).toBe("2026-10-28");
    expect(nextRecurrence({ unit: "weekday", interval: 1, pin_day: null, pin_weekday: null }, "2026-09-18", "2026-09-18")).toBe("2026-09-21");
  });
});

describe("a field it cannot read is never guessed (§1.4)", () => {
  it("`due nextweek` warns and sets no date", () => {
    const t = parse("- [ ] Send the deck due nextweek");
    expect(t.due).toBeNull();
    expect(t.parse_warning).toBe("due nextweek");
    expect(t.text).toBe("Send the deck");
  });

  it("warns on every unreadable value without giving up the rest of the run", () => {
    const t = parse("- [ ] A due nextweek p1 size huge type 9lives");
    expect(t.priority).toBe(1);
    expect(t.size).toBeNull();
    expect(t.parse_warning).toContain("due nextweek");
    expect(t.parse_warning).toContain("size huge");
    expect(t.parse_warning).toContain("type 9lives");
  });

  it("a bare day of the month is a pin or a warning — never a guessed date", () => {
    const t = parse("- [ ] Pay the card due 28");
    expect(t.due).toBeNull();
    expect(t.parse_warning).toBe("due 28");
  });

  it("a readable line has no warning at all", () => {
    expect(parse("- [ ] A due friday p2 size m type coding +drey @Jim").parse_warning).toBeNull();
  });
});

describe("the compatibility readers (§1.4) — read both, emit neither", () => {
  it("reads Dataview inline fields", () => {
    const t = parse("- [ ] Renew the domain [due:: 2026-09-22] [priority:: high] [size:: large]");
    expect(t).toMatchObject({ text: "Renew the domain", due: "2026-09-22", priority: 2, size: "l" });
    expect(t.compat).toEqual(["dataview"]);
    expect(formatTaskLine(t)).toBe("- [ ] Renew the domain due 2026-09-22 p2 size l");
  });

  it("reads the Tasks plugin's emoji, and never writes one back", () => {
    const t = parse("- [ ] Book the flights 📅 2026-09-22 ⏳ 2026-09-20 🛫 2026-09-19 🔁 every 2 weeks ⏫ 🆔 abc123");
    expect(t).toMatchObject({
      text: "Book the flights", due: "2026-09-22", scheduled_for: "2026-09-20", start_on: "2026-09-19", priority: 2,
    });
    expect(t.recurrence).toMatchObject({ unit: "week", interval: 2 });
    expect(t.compat).toEqual(["tasks-emoji"]);

    const rendered = formatTaskLine(t);
    expect(rendered).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}]/u);
    expect(rendered).toBe("- [ ] Book the flights due 2026-09-22 do 2026-09-20 start 2026-09-19 p2 every 2 weeks");
  });

  it("reads ✅ and ❌", () => {
    expect(parse("- [x] Send the contract ✅ 2026-09-17").done_on).toBe("2026-09-17");
    expect(parse("- [ ] Abandoned ❌ 2026-09-17")).toMatchObject({ dropped: true, done_on: null });
  });

  it("leaves someone else's inline field in the text rather than eating it", () => {
    const t = parse("- [ ] Check [owner:: Ana] before Friday");
    expect(t.text).toBe("Check [owner:: Ana] before Friday");
    expect(t.compat).toEqual([]);
  });

  it("the English field wins when a line carries both", () => {
    const t = parse("- [ ] Thing 📅 2026-09-30 due 2026-09-22");
    expect(t.due).toBe("2026-09-22");
  });

  it("does not eat the sentence after an emoji field", () => {
    expect(parse("- [ ] Ship it 📅 2026-09-22 and tell Ana").text).toBe("Ship it and tell Ana");
  });
});

describe("formatTaskLine — the one shape Metistry writes", () => {
  const lines = [
    "- [ ] Call the dentist due 2026-09-25",
    "- [ ] Draft the Q4 plan due 2026-09-30 p1 size l type planning +drey",
    "- [ ] Send Jim the brand deck @[[Jim Fallon]] due 2026-09-19",
    "- [ ] Water the plants every week source template:recurring ^mt-9k4p7x2v",
    "- [x] Send the contract done 2026-09-17",
    "- [ ] Chase the invoice @Jim waiting p2 linear:ABC-123 work:418",
    "- [ ] Pay the card every month due 28",
    "    * [ ] Nested due 2026-09-22 size s",
  ];

  it("round-trips every canonical line byte for byte", () => {
    for (const line of lines) expect(formatTaskLine(parse(line))).toBe(line);
  });

  it("resolves a relative date rather than re-emitting it", () => {
    expect(formatTaskLine(parse("- [ ] Call the dentist due friday"))).toBe("- [ ] Call the dentist due 2026-09-25");
  });

  it("puts back a token it could not read, so a round trip drops nothing", () => {
    const line = "- [ ] Send the deck due nextweek";
    expect(formatTaskLine(parse(line))).toBe(line);
    expect(parse(formatTaskLine(parse(line))).parse_warning).toBe("due nextweek");
  });

  it("never emits Dataview or emoji, whatever it read", () => {
    const out = formatTaskLine(parse("- [ ] A [due:: 2026-09-22] 📅 2026-09-30 ⏫ 🔁 every week"));
    expect(out).not.toContain("::");
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}]/u);
  });
});

describe("relative dates resolve against METISTRY_TZ (§1.3)", () => {
  it("answers in the user's calendar day, not UTC's", () => {
    const lateEvening = new Date("2026-09-19T02:30:00Z"); // 22:30 on the 18th in New York
    expect(parseTaskLine("- [ ] A due today", { now: lateEvening, timeZone: TZ })?.due).toBe("2026-09-18");
    expect(parseTaskLine("- [ ] A due today", { now: lateEvening, timeZone: "UTC" })?.due).toBe("2026-09-19");
    expect(parseTaskLine("- [ ] A due today", { now: lateEvening, timeZone: "Asia/Tokyo" })?.due).toBe("2026-09-19");
  });

  it("takes the zone from METISTRY_TZ when the caller names none", () => {
    const env = { METISTRY_TZ: "Pacific/Auckland" } as NodeJS.ProcessEnv;
    expect(parseTaskLine("- [ ] A due today", { now: NOW, env })?.parsed_on).toBe("2026-09-19");
    expect(parseTaskLine("- [ ] A due today", { now: NOW, env: {} as NodeJS.ProcessEnv })?.parsed_on).toBe("2026-09-18");
  });

  it("records the date it resolved against, so tomorrow does not re-read it", () => {
    expect(parse("- [ ] A due tomorrow").parsed_on).toBe("2026-09-18");
  });

  it("says so, once, when the zone is not one the runtime knows", () => {
    expect(() => parseTaskLine("- [ ] A", { now: NOW, timeZone: "Mars/Olympus" })).toThrow(/not a time zone/);
  });

  it("exports the date helpers the filter vocabulary shares", () => {
    expect(calendarDate(NOW, TZ)).toBe("2026-09-18");
    expect(resolveTaskDate("friday", at)).toBe("2026-09-25");
    expect(resolveTaskDate("soonish", at)).toBeNull();
  });
});
