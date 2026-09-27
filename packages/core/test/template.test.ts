// The template engine (P1-6, daily-flow-spec §6). Three properties carry the
// file, and each has its own block below:
//
//  1. **Every §6.4 row renders its note and the file still renders.** A day
//     with no plan because the calendar was down is the worst outcome, so
//     "the file still renders" is asserted on every single failure.
//  2. **The engine cannot exceed its own ceiling.** `prose` outside a fold
//     template is refused, `include` does not recurse, a routine cannot
//     materialise a task line into a note the user owns, and `where:` leaves
//     as bind params of one named query — pinned here to
//     `TASK_FILTER_PARAM_SPEC` so the query's YAML and the parser cannot
//     drift without a test noticing.
//  3. **The six seeded templates validate and render** (the contract with
//     #237): a form the grammar rejects is a bug in one of them, not a
//     licence to widen the grammar.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { TASK_FILTER_PARAM_SPEC } from "../src/task-filter.js";
import { PROSE_PENDING } from "../src/prose-slots.js";
import {
  DEFAULT_RECURRING_MAX_PER_DAY,
  FOLD_SOURCE,
  PROSE_REFUSAL,
  PROSE_SOURCES,
  RECURRING_QUERY,
  REQUESTS_QUERY,
  TEMPLATE_ENGINE_VERSION,
  TEMPLATE_UNREADABLE,
  TEMPLATE_VERBS,
  USER_SOURCE,
  WORK_QUERY,
  carriedTimes,
  formatTemplateDate,
  parseWorkWhere,
  renderTemplate,
  sectionOf,
  templateSkip,
  validateTemplate,
  type CalendarEvent,
  type TemplateContext,
  type TemplateQueries,
} from "../src/template.js";
import { NOTE_SECTIONS, scanNoteSection } from "../src/note-section.js";

const TASK_QUERY = "vault_tasks_query";
const SEED = fileURLToPath(new URL("../../../seed/vault/Templates/", import.meta.url));

/** 2026-09-18 in New York, so `today`/`tomorrow`/`yesterday` are fixed values in every assertion. */
const at = { now: new Date("2026-09-18T12:00:00Z"), timeZone: "America/New_York" };
const TODAY = "2026-09-18";
const TOMORROW = "2026-09-19";

class FakeQueries implements TemplateQueries {
  calls: { name: string; params: Record<string, string | number | boolean> }[] = [];
  constructor(
    private readonly tables: Record<string, Record<string, unknown>[]> = {},
    private readonly unreachable: string | null = null,
  ) {}
  async run(name: string, params: Record<string, string | number | boolean>): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ name, params });
    if (this.unreachable === name) throw new Error("connection refused");
    const rows = this.tables[name] ?? [];
    // a real named query honours its own `limit`, and the recurring
    // directive's "one more than the cap" only means something if this does
    const limit = params["limit"];
    return { rows: typeof limit === "number" ? rows.slice(0, limit) : rows };
  }
  paramsFor(name: string): Record<string, string | number | boolean> {
    const call = this.calls.find((c) => c.name === name);
    if (!call) throw new Error(`no call to ${name} — calls: ${this.calls.map((c) => c.name).join(", ") || "(none)"}`);
    return call.params;
  }
}

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  templatePath: "Templates/Plan.md",
  source: "plan-tomorrow",
  queries: new FakeQueries(),
  renderedAt: new Date("2026-09-18T19:04:30Z"),
  now: at.now,
  timeZone: at.timeZone,
  env: {},
  ...over,
});

const render = (text: string, over: Partial<TemplateContext> = {}) => renderTemplate(text, ctx(over));

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: "Journal/2026-09-18.md",
  task_key: "h:abc:0",
  anchor: null,
  line_no: 14,
  text: "Call the dentist",
  checked: false,
  due: "2026-09-19",
  priority: 1,
  size: "M",
  ...over,
});

const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: "Me/Routines.md",
  task_key: "h:water:0",
  line_no: 3,
  text: "Water the plants",
  recur_rule: "every week",
  recur_next: TODAY,
  open_instance_since: null,
  ...over,
});

describe("the grammar's ceiling", () => {
  it("is eight verbs and one block form — a ninth is a product decision (D13)", () => {
    expect([...TEMPLATE_VERBS]).toEqual(["date", "tasks", "recurring", "calendar", "work", "requests", "include", "prose"]);
  });

  it("refuses a verb it does not know, and the file still renders", async () => {
    const out = await render("# Plan\n\n{{ foo bar: 1 }}\n\nkeep me");
    expect(out.markdown).toContain("> ⚠️ metistry: unknown directive `foo` (Templates/Plan.md:3)");
    expect(out.markdown).toContain("keep me");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]?.line).toBe(3);
  });

  it("gives every verb but `date` a line of its own (§6.2)", async () => {
    const out = await render("Today: {{ tasks }} and more");
    expect(out.markdown).toContain("`tasks` needs a line of its own");
    expect(out.markdown).toContain("Today:  and more");
  });
});

describe("{{ date }}", () => {
  it("renders today in the instance's zone, and takes a format and a day offset", async () => {
    expect((await render("{{ date }}")).markdown).toContain(TODAY);
    expect((await render('{{ date format: "YYYY-MM-DD" offset: 1 }}')).markdown).toContain(TOMORROW);
    expect((await render('{{ date format: "ddd DD MMM YYYY" offset: -1 }}')).markdown).toContain("Thu 17 Sep 2026");
  });

  it("renders inside a heading, because that is where the seeded templates put it", async () => {
    const out = await render('# Plan — {{ date format: "YYYY-MM-DD" offset: 1 }}');
    expect(out.markdown).toContain(`# Plan — ${TOMORROW}`);
    expect(out.warnings).toEqual([]);
  });

  it("refuses an offset that is not a whole number of days", async () => {
    const out = await render("{{ date offset: soon }}");
    expect(out.markdown).toContain("can't read `offset: soon`");
  });

  it("formats only the tokens it documents, and leaves everything else verbatim", () => {
    expect(formatTemplateDate("2026-09-21", "dddd, MMMM DD 'YY")).toBe("Monday, September 21 '26");
  });
});

describe("{{ tasks }}", () => {
  it("compiles `where:`/`order:` to bind params of one named query — every param TASK_FILTER_PARAM_SPEC declares", async () => {
    const q = new FakeQueries();
    await render('{{ tasks where: "due <= tomorrow or overdue" order: "priority, due desc" limit: 3 }}', { queries: q });
    const params = q.paramsFor(TASK_QUERY);
    for (const [key, spec] of Object.entries(TASK_FILTER_PARAM_SPEC)) {
      const value = params[key];
      expect(typeof value).toBe(spec.type === "int" ? "number" : spec.type === "boolean" ? "boolean" : "string");
    }
    expect(params["due_on_or_before"]).toBe(TOMORROW);
    expect(params["overdue"]).toBe(true);
    expect(params["match_any"]).toBe(true);
    expect(params["order_1"]).toBe("priority");
    expect(params["order_2"]).toBe("due");
    expect(params["order_2_desc"]).toBe(true);
    expect(params["limit"]).toBe(3);
  });

  it("fills the context params the query leaves to the caller — never the `where:` text", async () => {
    const q = new FakeQueries();
    await render('{{ tasks where: "assigned_to_me" }}', { queries: q, me: "People/Sam Rivera.md" });
    // `overdue`/`carried` are measured against a DAY, and the day is the
    // instance's zone rather than whatever the cluster's current_date is
    expect(q.paramsFor(TASK_QUERY)["today"]).toBe(TODAY);
    expect(q.paramsFor(TASK_QUERY)["me"]).toBe("People/Sam Rivera.md");
  });

  it("binds nothing `vault_tasks_query` has not declared — the seed YAML is the contract", async () => {
    const yaml = readFileSync(fileURLToPath(new URL("../../../seed/queries/vault_tasks_query.yaml", import.meta.url)), "utf8");
    const declared = new Set(Object.keys((parseYaml(yaml) as { params: Record<string, unknown> }).params));
    const q = new FakeQueries();
    await render('{{ tasks where: "overdue" order: "due" limit: 5 }}', { queries: q, me: "People/Sam Rivera.md" });
    for (const key of Object.keys(q.paramsFor(TASK_QUERY))) expect([key, declared.has(key)]).toEqual([key, true]);
    for (const key of Object.keys(TASK_FILTER_PARAM_SPEC)) expect([key, declared.has(key)]).toEqual([key, true]);
  });

  it("renders a link to the note the line lives in, never a copy of it (§2.1)", async () => {
    const q = new FakeQueries({ [TASK_QUERY]: [task({ assigned: "People/Jim Fallon.md", carried_days: 3 })] });
    const out = await render("{{ tasks }}", { queries: q });
    expect(out.markdown).toContain("- [[Journal/2026-09-18]] — Call the dentist · due 2026-09-19 · p1 · size m · @[[People/Jim Fallon]] · carried 3d");
  });

  it("renders a table when asked, and refuses a shape it does not know", async () => {
    const q = new FakeQueries({ [TASK_QUERY]: [task()] });
    expect((await render('{{ tasks as: "table" }}', { queries: q })).markdown).toContain("| Task | Due | P | Size | Where |");
    expect((await render('{{ tasks as: "kanban" }}')).markdown).toContain("can't read `as: kanban`");
  });

  it("carries §1.4's one visible line for a token the parser could not read", async () => {
    const q = new FakeQueries({ [TASK_QUERY]: [task({ parse_warning: "due nextweek" })] });
    const out = await render("{{ tasks }}", { queries: q });
    expect(out.markdown).toContain("> ⚠️ couldn't read `due nextweek` — Journal/2026-09-18.md:14");
  });
});

describe("{{ recurring }}", () => {
  it("materialises the day's instance only in the user's own hand (§4, D4)", async () => {
    const q = new FakeQueries({ [RECURRING_QUERY]: [rule()] });
    const out = await render("{{ recurring due: today }}", { queries: q, source: USER_SOURCE, newAnchor: () => "mt-9k4p0000" });
    expect(out.markdown).toContain("- [ ] Water the plants source template:recurring ^mt-9k4p0000");
    expect(q.paramsFor(RECURRING_QUERY)["due"]).toBe(TODAY);
  });

  it("proposes, and never materialises, when a routine is the writer", async () => {
    const q = new FakeQueries({ [RECURRING_QUERY]: [rule({ recur_next: TOMORROW })] });
    const out = await render("{{ recurring due: tomorrow }}", { queries: q, source: "plan-tomorrow", newAnchor: () => "mt-never0000" });
    expect(out.markdown).toContain(`- Water the plants — every week, due ${TOMORROW}`);
    expect(out.markdown).not.toContain("- [ ]");
    expect(out.markdown).not.toContain("^mt-");
  });

  it("carries a rule whose previous instance is still open, rather than making a second one", async () => {
    const q = new FakeQueries({ [RECURRING_QUERY]: [rule({ open_instance_since: "2026-09-04" })] });
    const out = await render("{{ recurring due: today }}", { queries: q, source: USER_SOURCE });
    expect(out.markdown).toContain("- [ ] Water the plants — carried, 3rd time");
  });

  it("counts the carry by stepping the rule, and says nothing it cannot derive", () => {
    expect(carriedTimes("every week", "2026-09-04", TODAY)).toBe(3);
    expect(carriedTimes("every week", TODAY, TODAY)).toBe(1);
    expect(carriedTimes("every fortnight-ish", "2026-09-04", TODAY)).toBeNull();
  });

  it("caps the day's rules and says how many it did not show (§4's third bound)", async () => {
    const rules = Array.from({ length: 5 }, (_, i) => rule({ task_key: `h:r${i}`, text: `Rule ${i}` }));
    const q = new FakeQueries({ [RECURRING_QUERY]: rules });
    const out = await render("{{ recurring limit: 3 }}", { queries: q, source: USER_SOURCE, newAnchor: () => "mt-aaaaaaaa" });
    expect(q.paramsFor(RECURRING_QUERY)["limit"]).toBe(4); // one more than the cap, so "there are more" is a fact
    expect(out.markdown).toContain("…and 1 more recurring (see Work ▸ Today)");
    expect(out.markdown).not.toContain("Rule 3");
  });

  it("defaults to §4's per-render cap", async () => {
    const q = new FakeQueries();
    await render("{{ recurring }}", { queries: q, source: USER_SOURCE });
    expect(q.paramsFor(RECURRING_QUERY)["limit"]).toBe(DEFAULT_RECURRING_MAX_PER_DAY + 1);
  });
});

describe("{{ calendar }}", () => {
  const events: CalendarEvent[] = [
    { title: "Standup", start: "2026-09-18T13:30:00Z", end: "2026-09-18T14:00:00Z", location: "Room 3" },
    { title: "Company offsite", all_day: true },
  ];

  it("renders the day's events in the instance's zone", async () => {
    const out = await render("{{ calendar day: today }}", { calendar: { events: async () => events } });
    expect(out.markdown).toContain("- 09:30–10:00 Standup · Room 3");
    expect(out.markdown).toContain("- all day Company offsite");
  });

  it("asks the provider for the day the directive names", async () => {
    const asked: string[] = [];
    await render("{{ calendar day: tomorrow }}", { calendar: { events: async (d) => (asked.push(d), []) } });
    expect(asked).toEqual([TOMORROW]);
  });
});

describe("{{ work }} and {{ requests }}", () => {
  it("compiles `work where:` to `day_work`'s flag set and its combinator", async () => {
    const q = new FakeQueries({ [WORK_QUERY]: [{ id: 418, title: "Fix the flaky test", status: "blocked", blocked_by_task_open: true, blocked_by_path: "Journal/2026-09-18.md", blocked_by_task: "Call the dentist" }] });
    const out = await render('{{ work where: "blocked or waiting_on_me" limit: 5 }}', { queries: q });
    expect(q.paramsFor(WORK_QUERY)).toMatchObject({ flags: "blocked,waiting_on_me", combine: "or", limit: 5, day: TODAY });
    expect(out.markdown).toContain("- work:418 — Fix the flaky test · blocked · waiting on [[Journal/2026-09-18]] — Call the dentist");
  });

  it("refuses a flag `work` does not have, and refuses to mix `and` with `or`", async () => {
    expect(parseWorkWhere("blocked or waiting_on_me").ok).toBe(true);
    expect(parseWorkWhere("blocked and waiting_on_me or due").ok).toBe(false);
    expect((await render('{{ work where: "blocked or soonish" }}')).markdown).toContain("can't read `where: \"blocked or soonish\"`");
  });

  it("reads the Needs You queue by name and renders one line per request", async () => {
    const q = new FakeQueries({ [REQUESTS_QUERY]: [{ id: 7, request_type: "access", title: "Read Areas/Fsl", age_days: 2.1, source_agent: "researcher", has_suggested_work: true }] });
    const out = await render("{{ requests limit: 5 }}", { queries: q });
    expect(q.paramsFor(REQUESTS_QUERY)).toMatchObject({ limit: 5 });
    expect(out.markdown).toContain("- access — Read Areas/Fsl · 2.1d · researcher · suggests work");
  });
});

describe("{{ include }}", () => {
  const reader = (files: Record<string, string>) => ({ read: async (p: string) => files[p] ?? null });

  it("splices a named section verbatim", async () => {
    const out = await render('{{ include "Me/Working Style.md#Prioritisation" }}', {
      reader: reader({ "Me/Working Style.md": "# Style\n\n## Prioritisation\n\nDeep work first.\n\n## Standup\n\nYesterday / today.\n" }),
    });
    expect(out.markdown).toContain("Deep work first.");
    expect(out.markdown).not.toContain("Yesterday / today.");
  });

  it("does not evaluate directives inside the included file (§6.3.2)", async () => {
    const out = await render('{{ include "Me/Notes.md" }}', { reader: reader({ "Me/Notes.md": "before {{ tasks }} after" }) });
    expect(out.markdown).toContain("before {{ tasks }} after");
    expect(out.warnings).toEqual([]);
  });

  it("does not recurse — a template that includes itself renders the note and the file still renders", async () => {
    const out = await render('# Plan\n\n{{ include "Templates/Plan.md" }}\n\ntail', {
      reader: reader({ "Templates/Plan.md": '{{ include "Templates/Plan.md" }}' }),
    });
    expect(out.markdown).toContain("`include` cannot include the template itself");
    expect(out.markdown).toContain("tail");
    expect(out.warnings).toHaveLength(1);
  });

  it("names the file it could not read, and the section it could not find", async () => {
    const files = reader({ "Me/Working Style.md": "# Style\n\n## Prioritisation\n\nDeep work first.\n" });
    expect((await render('{{ include "Me/Missing.md" }}', { reader: files })).markdown).toContain("can't read `Me/Missing.md` — no such file in the vault");
    expect((await render('{{ include "Me/Working Style.md#Standup" }}', { reader: files })).markdown).toContain("has no section `Standup`");
  });

  it("refuses a traversal, and needs its quoted path", async () => {
    expect((await render('{{ include "../../etc/passwd" }}')).markdown).toContain("never a traversal");
    expect((await render("{{ include }}")).markdown).toContain("`include` needs its quoted first value");
  });

  it("reads a section up to the next heading of the same or a higher level", () => {
    expect(sectionOf("## A\n\none\n\n### A2\n\ntwo\n\n## B\n\nthree", "A")).toBe("\none\n\n### A2\n\ntwo\n");
    expect(sectionOf("## A\n\none", "Missing")).toBeNull();
  });
});

describe("{{ prose }}", () => {
  const template = '{{ prose "summarise yesterday in three lines" using: "Journal/Fold/{{date offset: -1}}" }}';

  it("is a bounded request object the fold fulfils — never a model call in the engine", async () => {
    const out = await render(template, { source: FOLD_SOURCE, templatePath: "Templates/Fold.md" });
    expect(out.proseRequests).toEqual([
      {
        index: 1,
        prompt: "summarise yesterday in three lines",
        using: "Journal/Fold/2026-09-17",
        marker: "<!-- metistry:prose 1 -->",
        line: 1,
      },
    ]);
    expect(out.markdown).toContain("<!-- metistry:prose 1 --> _pending — the fold writes this slot_");
    expect(out.warnings).toEqual([]);
  });

  it("is refused outside a fold template, every time, and the file still renders", async () => {
    const out = await render(`# Plan\n\n${template}\n\ntail`, { source: "plan-tomorrow" });
    expect(out.markdown).toContain("> ⚠️ metistry: `prose` is only available in the fold's, the Morning Brief's and the Standup's templates (§6.3, C103) (Templates/Plan.md:3)");
    expect(out.markdown).toContain("tail");
    expect(out.proseRequests).toEqual([]);
  });

  it("C103: legal in the Morning Brief's and the Standup's renders too — a pending slot each, never a model call here", async () => {
    for (const source of ["morning-brief", "standup"]) {
      const out = await render(`# ${source}\n\n{{ prose "what matters today" }}\n`, { source });
      expect(out.proseRequests, source).toEqual([{ index: 1, prompt: "what matters today", using: null, marker: "<!-- metistry:prose 1 -->", line: 3 }]);
      expect(out.markdown, source).toContain(`<!-- metistry:prose 1 --> ${PROSE_PENDING}`);
      expect(out.warnings, source).toEqual([]);
      expect(validateTemplate('{{ prose "x" }}\n', { ...at, source }).ok, source).toBe(true);
    }
    expect([...PROSE_SOURCES]).toEqual([FOLD_SOURCE, "standup", "morning-brief"]);
  });

  it("…and still refused for every other writer: Tomorrow's Plan and the owner's own note stay model-free", async () => {
    for (const source of ["plan-tomorrow", USER_SOURCE, "standup-draft", "weekly-review"]) {
      const out = await render('{{ prose "anything" }}\ntail', { source });
      expect(out.proseRequests, source).toEqual([]);
      expect(out.markdown, source).toContain(PROSE_REFUSAL);
      expect(validateTemplate('{{ prose "x" }}\n', { ...at, source }).ok, source).toBe(false);
    }
  });

  it("bounds the prompt — a slot is a sentence, not a brief", async () => {
    const out = await render(`{{ prose "${"x".repeat(201)}" }}`, { source: FOLD_SOURCE });
    expect(out.markdown).toContain("at most 200 characters");
    expect(out.proseRequests).toEqual([]);
  });
});

describe("{{ section }}", () => {
  const block = (body: string, mode = "hide") => `before\n\n{{ section "Today's tasks" if_empty: "${mode}" }}\n${body}\n{{ /section }}\n\nafter`;

  it("vanishes when everything inside it is empty and it says `hide`", async () => {
    const out = await render(block("{{ tasks }}"));
    expect(out.markdown).not.toContain("Today's tasks");
    expect(out.markdown).not.toContain("_no tasks_");
    expect(out.markdown).toContain("before");
    expect(out.markdown).toContain("after");
  });

  it("shows the heading and the empty line when it says `show`", async () => {
    const out = await render(block("{{ tasks }}", "show"));
    expect(out.markdown).toContain("## Today's tasks");
    expect(out.markdown).toContain("_no tasks_");
  });

  it("renders the heading and the rows when there is something to show", async () => {
    const q = new FakeQueries({ [TASK_QUERY]: [task()] });
    const out = await render(block("{{ tasks }}"), { queries: q });
    expect(out.markdown).toContain("## Today's tasks");
    expect(out.markdown).toContain("Call the dentist");
  });

  it("keeps a failure note visible even under `hide` — a warning is content", async () => {
    const q = new FakeQueries({}, TASK_QUERY);
    const out = await render(block("{{ tasks }}"), { queries: q });
    expect(out.markdown).toContain("## Today's tasks");
    expect(out.markdown).toContain("no tasks — the named query `vault_tasks_query` is not available");
  });

  it("refuses a section inside a section, a stray close, and an unclosed block", async () => {
    expect((await render('{{ section "A" }}\n{{ section "B" }}\n{{ /section }}')).markdown).toContain("a section cannot hold another");
    expect((await render("{{ /section }}")).markdown).toContain("`{{ /section }}` with no `{{ section … }}` open");
    const unclosed = await render('{{ section "A" }}\nbody');
    expect(unclosed.markdown).toContain("## A");
    expect(unclosed.markdown).toContain("is never closed");
  });
});

describe("§6.4 — every failure renders a visible note, and none is fatal", () => {
  const rows = ["unknown directive", "unknown key or an unreadable where:", "a source that is not configured", "a query returned nothing", "prose outside a fold template", "the template is missing", "the template is unreadable"];

  it(`covers ${rows.length} rows`, () => {
    expect(rows).toHaveLength(7);
  });

  it("row 1 — unknown directive", async () => {
    const out = await render("head\n{{ nope }}\ntail");
    expect(out.markdown).toContain("> ⚠️ metistry: unknown directive `nope` (Templates/Plan.md:2)");
    expect(out.markdown).toContain("tail");
  });

  it("row 2 — an unknown key, or a `where:` the parser refuses", async () => {
    const unknownKey = await render("{{ tasks colour: red }}\ntail");
    expect(unknownKey.markdown).toContain("can't read `colour: red` — `tasks` takes where, order, limit, as");
    expect(unknownKey.markdown).toContain("tail");
    const badWhere = await render('{{ tasks where: "due soonish" }}\ntail');
    expect(badWhere.markdown).toContain('> ⚠️ metistry: can\'t read `where: "due soonish"`');
    expect(badWhere.markdown).toContain("tail");
  });

  it("row 3 — a source that is not configured: no calendar, no query, no reader", async () => {
    const noCalendar = await render("{{ calendar day: today }}\ntail");
    expect(noCalendar.markdown).toContain("> ⚠️ metistry: no calendar — the eventkit bridge is not reachable");
    expect(noCalendar.markdown).toContain("tail");

    const unreachable = await render("{{ calendar day: today }}", { calendar: { events: async () => { throw new Error("down"); } } });
    expect(unreachable.markdown).toContain("no calendar — the eventkit bridge is not reachable");

    const noQuery = await render("{{ tasks }}\ntail", { queries: new FakeQueries({}, TASK_QUERY) });
    expect(noQuery.markdown).toContain("the named query `vault_tasks_query` is not available");
    expect(noQuery.markdown).toContain("tail");

    const noReader = await render('{{ include "Me/Working Style.md" }}\ntail');
    expect(noReader.markdown).toContain("no vault reader — `include` is not available");
    expect(noReader.markdown).toContain("tail");
  });

  it("row 4 — a query returned nothing: an empty line, or the section vanishes", async () => {
    expect((await render("{{ tasks }}")).markdown).toContain("_no tasks_");
    expect((await render("{{ requests }}")).markdown).toContain("_nothing waiting on you_");
    expect((await render('{{ section "T" if_empty: "hide" }}\n{{ tasks }}\n{{ /section }}')).markdown).not.toContain("## T");
  });

  it("row 5 — `prose` in a template the assistant may not write", async () => {
    const out = await render('{{ prose "anything" }}\ntail', { source: "standup-draft" });
    expect(out.markdown).toContain("`prose` is only available in the fold's, the Morning Brief's and the Standup's templates (§6.3, C103)");
    expect(out.markdown).toContain("tail");
  });

  it("row 6 — the template file is missing: nothing is written, and it is not a failure", () => {
    expect(templateSkip(null, 16384)).toBe("template_missing");
    expect(templateSkip(undefined, 16384)).toBe("template_missing");
  });

  it("row 7 — the template is not readable text or is over the cap: nothing is written", async () => {
    expect(templateSkip("a�b", 16384)).toBe(TEMPLATE_UNREADABLE);
    expect(templateSkip("x".repeat(20), 10)).toBe(TEMPLATE_UNREADABLE);
    const out = await render("x".repeat(500), { maxBytes: 100 });
    expect(out.skipped).toBe(TEMPLATE_UNREADABLE);
    expect(out.markdown).toBe("");
  });

  it("counts every note it rendered, for the run's `meta.template_warnings`", async () => {
    const out = await render("{{ nope }}\n{{ tasks colour: red }}\n{{ calendar }}");
    expect(out.warnings.map((w) => w.line)).toEqual([1, 2, 3]);
    expect(out.warnings.every((w) => out.markdown.includes(w.note))).toBe(true);
  });
});

describe("the provenance footer and the size cap", () => {
  it("names the template, its sha256, when it was rendered and which engine did it (§6.3.4)", async () => {
    const out = await render("# Plan\n");
    const footer = out.markdown.trimEnd().split("\n").at(-1) ?? "";
    expect(footer).toMatch(
      new RegExp(`^<!-- rendered by plan-tomorrow from Templates/Plan\\.md \\(sha256 [0-9a-f]{12}…\\) at 2026-09-18T19:04Z by metistry-template/${TEMPLATE_ENGINE_VERSION} -->$`),
    );
  });

  it("changes its digest when the template changes — a rendered file names the version that produced it", async () => {
    const a = await render("# Plan\n");
    const b = await render("# Plan, edited\n");
    expect(a.markdown.slice(a.markdown.indexOf("sha256"))).not.toBe(b.markdown.slice(b.markdown.indexOf("sha256")));
  });

  it("truncates a directive that would exceed the cap, with the fold's own `…and N more`", async () => {
    const many = Array.from({ length: 40 }, (_, i) => task({ task_key: `k${i}`, text: `Task number ${i}` }));
    const out = await render("{{ tasks }}", { queries: new FakeQueries({ [TASK_QUERY]: many }), maxBytes: 900 });
    expect(out.truncated).toBe(true);
    expect(out.markdown).toMatch(/…and \d+ more/);
    expect(Buffer.byteLength(out.markdown, "utf8")).toBeLessThanOrEqual(900);
    expect(out.markdown).toContain("rendered by plan-tomorrow");
  });

  it("§6.5 — nothing is cached across runs: the same context renders the text it is given, every time", async () => {
    const shared = ctx();
    const first = await renderTemplate("# One\n", shared);
    const second = await renderTemplate("# Two\n", shared);
    const third = await renderTemplate("# One\n", shared);
    expect(first.markdown).toContain("# One");
    expect(second.markdown).toContain("# Two");
    expect(third.markdown).toBe(first.markdown);
  });
});

describe("frontmatter", () => {
  it("carries the writer's own `source:` into the rendered file and drops the template marker (§7)", async () => {
    const out = await render("---\nsource: user\ntype: resource\ntags: [template, daily]\n---\n# Plan\n");
    expect(out.markdown).toContain("source: plan-tomorrow");
    expect(out.markdown).toContain("type: resource");
    expect(out.markdown).toContain("- daily");
    expect(out.markdown).not.toContain("- template");
  });

  it("keeps line numbers pointing at the file the user edits, frontmatter included", async () => {
    const out = await render("---\nsource: user\n---\n# Plan\n\n{{ nope }}\n");
    expect(out.warnings[0]?.line).toBe(6);
  });
});

describe("validateTemplate", () => {
  it("is clean on a template that reads, and needs no database, calendar or vault", () => {
    const result = validateTemplate('# {{ date }}\n\n{{ section "T" if_empty: "hide" }}\n{{ tasks where: "overdue" }}\n{{ /section }}\n', at);
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("reports each directive error with the line number Obsidian shows", () => {
    const result = validateTemplate('# head\n{{ nope }}\n{{ tasks where: "due soonish" }}\n{{ section "A" }}\n', at);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.line)).toEqual([2, 3, 4]);
    expect(result.findings[0]?.message).toContain("unknown directive `nope`");
    expect(result.findings[2]?.message).toContain("is never closed");
  });

  it("calls `prose` an error when it knows the output is not the assistant's, and a note when it does not", () => {
    const text = '{{ prose "summarise yesterday" }}\n';
    expect(validateTemplate(text, { ...at, source: "plan-tomorrow" }).ok).toBe(false);
    const unknown = validateTemplate(text, at);
    expect(unknown.ok).toBe(true);
    expect(unknown.findings[0]?.severity).toBe("note");
    expect(validateTemplate(text, { ...at, source: FOLD_SOURCE }).findings[0]?.severity).toBe("note");
  });

  it("refuses a template over the cap before anything renders it", () => {
    const result = validateTemplate("x".repeat(200), { ...at, maxBytes: 100 });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.message).toContain(TEMPLATE_UNREADABLE);
  });
});

describe("the seven seeded templates (the contract with #237)", () => {
  const names = readdirSync(SEED).filter((f) => f.endsWith(".md")).sort();
  const WRITERS: Record<string, string> = { "Fold.md": FOLD_SOURCE, "Brief.md": "morning-brief", "Standup.md": "standup", "Plan.md": "plan-tomorrow" };
  const sourceOf = (name: string): string => WRITERS[name] ?? USER_SOURCE;

  it("ships seven", () => {
    expect(names).toEqual(["Brief.md", "Daily.md", "Fold.md", "Meeting.md", "Plan.md", "Standup.md", "Weekly.md"]);
  });

  for (const name of names) {
    it(`${name} validates`, () => {
      const result = validateTemplate(readFileSync(join(SEED, name), "utf8"), { ...at, source: sourceOf(name) });
      expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it(`${name} renders against fixture rows with no failure note`, async () => {
      const q = new FakeQueries({
        [TASK_QUERY]: [task()],
        [RECURRING_QUERY]: [rule()],
        [WORK_QUERY]: [{ id: 418, title: "Fix the flaky test", status: "blocked" }],
        [REQUESTS_QUERY]: [{ id: 7, request_type: "question", title: "Which repo?", age_days: 1, source_agent: "researcher" }],
      });
      const out = await renderTemplate(readFileSync(join(SEED, name), "utf8"), ctx({
        templatePath: `Templates/${name}`,
        source: sourceOf(name),
        queries: q,
        calendar: { events: async () => [{ title: "Standup", start: "2026-09-19T13:30:00Z", end: "2026-09-19T14:00:00Z" }] },
        reader: { read: async () => "# Style\n\n## Prioritisation\n\nDeep work first.\n\n## Standup\n\nYesterday / today / blockers.\n" },
        newAnchor: () => "mt-aaaaaaaa",
      }));
      expect(out.warnings).toEqual([]);
      expect(out.skipped).toBeUndefined();
      expect(out.markdown).toContain(`from Templates/${name}`);
      expect(out.markdown).not.toContain("{{");
    });
  }

  it("Plan.md renders the day's plan: the calendar, the tasks, what agents wait on, and the user's own prose", async () => {
    const q = new FakeQueries({
      [TASK_QUERY]: [task()],
      [RECURRING_QUERY]: [rule({ recur_next: TOMORROW })],
      [WORK_QUERY]: [{ id: 418, title: "Fix the flaky test", status: "blocked" }],
      [REQUESTS_QUERY]: [],
    });
    const out = await renderTemplate(readFileSync(join(SEED, "Plan.md"), "utf8"), ctx({
      templatePath: "Templates/Plan.md",
      queries: q,
      calendar: { events: async () => [{ title: "Standup", start: "2026-09-19T13:30:00Z", end: "2026-09-19T14:00:00Z" }] },
      reader: { read: async () => "## Prioritisation\n\nDeep work before the first meeting.\n" },
    }));
    expect(out.markdown).toContain(`# Plan — ${TOMORROW}`);
    expect(out.markdown).toContain("- 09:30–10:00 Standup");
    expect(out.markdown).toContain("## Recurring tomorrow");
    expect(out.markdown).toContain("- Water the plants — every week");
    expect(out.markdown).toContain("## Today's tasks");
    expect(out.markdown).toContain("- [[Journal/2026-09-18]] — Call the dentist");
    expect(out.markdown).toContain("## ⛔ Agents are waiting on you");
    expect(out.markdown).toContain("Deep work before the first meeting.");
    expect(out.markdown).not.toContain("## Requests"); // empty, and the section says hide
    expect(out.markdown).toContain("source: plan-tomorrow");
  });

  it("Daily.md is the one template that materialises the day's recurring instances", async () => {
    const q = new FakeQueries({ [RECURRING_QUERY]: [rule()] });
    const out = await renderTemplate(readFileSync(join(SEED, "Daily.md"), "utf8"), ctx({
      templatePath: "Templates/Daily.md",
      source: USER_SOURCE,
      queries: q,
      newAnchor: () => "mt-9k4p0000",
    }));
    expect(out.markdown).toContain(`# ${TODAY}`);
    expect(out.markdown).toContain("- [ ] Water the plants source template:recurring ^mt-9k4p0000");
    expect(out.markdown).toContain("source: user");
  });

  it("Daily.md places the day section's markers — one clean pair, so Close the Day and the Morning Brief write between them (T2-8)", async () => {
    const out = await renderTemplate(readFileSync(join(SEED, "Daily.md"), "utf8"), ctx({
      templatePath: "Templates/Daily.md",
      source: USER_SOURCE,
      queries: new FakeQueries({ [RECURRING_QUERY]: [] }),
    }));
    expect(scanNoteSection(Buffer.from(out.markdown), "day").state).toBe("present");
    expect(out.markdown).toContain(`${NOTE_SECTIONS.day.heading}\n\n${NOTE_SECTIONS.day.open}\n${NOTE_SECTIONS.day.close}\n`);
  });

  it("Fold.md is the one template whose `prose` slots are legal", async () => {
    const out = await renderTemplate(readFileSync(join(SEED, "Fold.md"), "utf8"), ctx({
      templatePath: "Templates/Fold.md",
      source: FOLD_SOURCE,
      queries: new FakeQueries({ [REQUESTS_QUERY]: [] }),
    }));
    expect(out.proseRequests.map((p) => p.using)).toEqual(["Journal/Fold/2026-09-17", `Journal/${TODAY}`]);
    expect(out.markdown).toContain("<!-- metistry:prose 1 -->");
    expect(out.markdown).toContain("<!-- metistry:prose 2 -->");
    expect(out.warnings).toEqual([]);
  });
});
