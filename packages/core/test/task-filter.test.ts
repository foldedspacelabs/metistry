// The filter vocabulary (P1-2, daily-flow-spec §6.2). One language, three
// consumers — a template's `where:`, the app's chips, the plugin's suggester —
// compiled to BIND PARAMS of one named query and never to SQL text.
//
// The misuse block at the bottom is the point of the file (invariant 8): a
// `where:` carrying SQL is REFUSED, not escaped, not quoted, not passed
// through. Every refusal is a value the caller renders, because §6.4 says the
// template still produces a file.
import { describe, expect, it } from "vitest";
import {
  TASK_FILTER_FIELDS,
  TASK_FILTER_FLAGS,
  TASK_FILTER_PARAM_SPEC,
  TASK_QUERY_NAME,
  TASK_STATUSES,
  compileTaskFilter,
  taskFilterParams,
  type TaskFilterParams,
} from "../src/task-filter.js";

const at = { now: new Date("2026-09-18T12:00:00Z"), timeZone: "America/New_York" };

/** Only what a clause CHANGED, so a test reads as "these params and no others". */
function changed(where: string, order?: string): Partial<TaskFilterParams> {
  const out = compileTaskFilter(order === undefined ? { where } : { where, order }, at);
  if (!out.ok) throw new Error(out.error);
  const base = taskFilterParams() as Record<string, unknown>;
  return Object.fromEntries(Object.entries(out.params).filter(([k, v]) => base[k] !== v)) as Partial<TaskFilterParams>;
}

const refusal = (where: string): string => {
  const out = compileTaskFilter({ where }, at);
  if (out.ok) throw new Error(`expected a refusal, got params for: ${where}`);
  return out.error;
};

describe("the param shape", () => {
  it("names one query and always binds every param", () => {
    expect(TASK_QUERY_NAME).toBe("vault_tasks_query");
    const out = compileTaskFilter({}, at);
    expect(out.ok && Object.keys(out.params)).toEqual(Object.keys(taskFilterParams()));
  });

  it("publishes the same shape a query manifest declares, so the two cannot drift", () => {
    expect(TASK_FILTER_PARAM_SPEC.due_on).toEqual({ type: "text", default: "" });
    expect(TASK_FILTER_PARAM_SPEC.priority_eq).toEqual({ type: "int", default: 0 });
    expect(TASK_FILTER_PARAM_SPEC.overdue).toEqual({ type: "boolean", default: false });
    expect(TASK_FILTER_PARAM_SPEC.limit).toEqual({ type: "int", default: 50 });
    for (const spec of Object.values(TASK_FILTER_PARAM_SPEC)) {
      expect(["int", "text", "boolean"]).toContain(spec.type); // packages/queries' three param types
    }
  });

  it("an empty filter filters nothing", () => {
    expect(changed("")).toEqual({});
  });
});

describe("every clause the vocabulary has", () => {
  it("dates, resolved at compile time against METISTRY_TZ", () => {
    expect(changed("due = today")).toEqual({ due_on: "2026-09-18" });
    expect(changed("due: 2026-09-22")).toEqual({ due_on: "2026-09-22" });
    expect(changed("due <= today")).toEqual({ due_on_or_before: "2026-09-18" });
    expect(changed("due >= tomorrow")).toEqual({ due_on_or_after: "2026-09-19" });
    expect(changed("due < today")).toEqual({ due_on_or_before: "2026-09-17" }); // a strict bound IS the next day's inclusive one
    expect(changed("due > today")).toEqual({ due_on_or_after: "2026-09-19" });
    expect(changed("due <= +7d")).toEqual({ due_on_or_before: "2026-09-25" });
    expect(changed("due <= friday")).toEqual({ due_on_or_before: "2026-09-25" });
    expect(changed("do = today")).toEqual({ do_on: "2026-09-18" });
    expect(changed("start <= today")).toEqual({ start_on_or_before: "2026-09-18" });
    expect(changed("done >= yesterday")).toEqual({ done_on_or_after: "2026-09-17" });
  });

  it("priority, on the numeric scale it is stored on", () => {
    expect(changed("priority = p1")).toEqual({ priority_eq: 1 });
    expect(changed("priority: critical")).toEqual({ priority_eq: 1 });
    expect(changed("priority = high")).toEqual({ priority_eq: 2 });
    expect(changed("priority = 4")).toEqual({ priority_eq: 4 });
    expect(changed("priority <= p2")).toEqual({ priority_max: 2 }); // p1 or p2 — more important, not less
    expect(changed("priority < p2")).toEqual({ priority_max: 1 });
    expect(changed("priority >= p3")).toEqual({ priority_min: 3 });
    expect(changed("priority > p3")).toEqual({ priority_min: 4 });
  });

  it("size, by rank, so the query never has to know the letters' order", () => {
    expect(changed("size = m")).toEqual({ size: "m" });
    expect(changed("size: large")).toEqual({ size: "l" });
    expect(changed("size <= m")).toEqual({ size_rank_max: 2 });
    expect(changed("size < m")).toEqual({ size_rank_max: 1 });
    expect(changed("size >= m")).toEqual({ size_rank_min: 2 });
  });

  it("type, assigned, project, area, source and status", () => {
    expect(changed("type = coding")).toEqual({ type: "coding" });
    expect(changed("assigned:[[Jim Fallon]]")).toEqual({ assigned: "Jim Fallon" });
    expect(changed("assigned = Jim")).toEqual({ assigned: "Jim" });
    expect(changed("assigned = @Jim")).toEqual({ assigned: "Jim" });
    expect(changed("project = drey")).toEqual({ project: "drey" });
    expect(changed("area:[[Areas/Work]]")).toEqual({ area_prefix: "Areas/Work" }); // prefix: takes its children too
    expect(changed("source = meeting")).toEqual({ source_prefix: "meeting" });
    expect(changed("source = template:recurring")).toEqual({ source_prefix: "template:recurring" });
    for (const status of TASK_STATUSES) expect(changed(`status = ${status}`)).toEqual({ status });
  });

  it("every flag", () => {
    for (const flag of TASK_FILTER_FLAGS) expect(changed(flag)).toEqual({ [flag]: true });
  });

  it("joins with `and` by default and says so when it is `or`", () => {
    expect(changed("due <= today and priority <= p2")).toEqual({ due_on_or_before: "2026-09-18", priority_max: 2 });
    expect(changed("due <= today or overdue")).toEqual({ due_on_or_before: "2026-09-18", overdue: true, match_any: true });
    expect(changed("overdue")).toEqual({ overdue: true }); // one clause needs no joiner, and `and` is the default
  });

  it("reads the spec's own examples", () => {
    const plan = compileTaskFilter({ where: "due <= today or overdue", order: "priority, due", limit: 10 }, at);
    expect(plan.ok && plan.params).toMatchObject({
      due_on_or_before: "2026-09-18", overdue: true, match_any: true,
      order_1: "priority", order_1_desc: false, order_2: "due", order_2_desc: false, limit: 10,
    });
    expect(compileTaskFilter({ where: "assigned:[[Jim Fallon]]" }, at).ok).toBe(true);
  });

  it("keeps the parse beside the params, for the app's chips", () => {
    const out = compileTaskFilter({ where: "due <= today or overdue", order: "due desc" }, at);
    expect(out.ok && out.filter).toEqual({
      clauses: [
        { kind: "field", field: "due", op: "<=", value: "today" },
        { kind: "flag", flag: "overdue" },
      ],
      join: "or",
      order: [{ field: "due", desc: true }],
      limit: 50,
    });
  });
});

describe("order:", () => {
  it("takes a comma list of fields, each optionally desc", () => {
    expect(changed("", "priority, due, size")).toEqual({ order_1: "priority", order_2: "due", order_3: "size" });
    expect(changed("", "due desc")).toEqual({ order_1: "due", order_1_desc: true });
    expect(changed("", "  due  ,  priority desc ")).toEqual({ order_1: "due", order_2: "priority", order_2_desc: true });
    expect(changed("", "")).toEqual({});
  });

  it("refuses a field it does not have, a direction it does not know, and more slots than the query has", () => {
    const err = (order: string): string => {
      const out = compileTaskFilter({ order }, at);
      if (out.ok) throw new Error(`expected a refusal for: ${order}`);
      return out.error;
    };
    expect(err("urgency")).toMatch(/does not know `urgency`/);
    expect(err("due sideways")).toMatch(/expected `asc` or `desc`/);
    expect(err("due, priority, size, type")).toMatch(/at most 3 fields/);
    expect(err("due; drop table vault_tasks")).toMatch(/cannot contain `;`/);
  });
});

describe("misuse: a `where:` is refused, never escaped (invariant 8)", () => {
  it("refuses SQL outright, in every shape it can be written", () => {
    const attempts = [
      "due <= today; DROP TABLE vault_tasks",
      "1=1 or 1=1",
      "type = 'coding' OR 1=1--",
      "project = drey' UNION SELECT token FROM bridge_tokens --",
      "due <= (SELECT max(due) FROM vault_tasks)",
      "type = coding /* comment */",
      "due <= today\; delete from vault_tasks",
      "assigned = pg_sleep(10)",
      'type = "coding"',
      "type = coding%",
      "exists (select 1)",
      "due <= today UNION ALL SELECT 1",
    ];
    for (const where of attempts) {
      const out = compileTaskFilter({ where }, at);
      expect(out.ok, where).toBe(false);
      if (out.ok) continue;
      // Nothing of the attempt survives into a param, because there are no
      // params: a refusal returns an error and no shape at all.
      expect(out).not.toHaveProperty("params");
      expect(out.error).toMatch(/where:/);
    }
  });

  it("says it is not SQL when the input looks like SQL, without relying on having recognised it", () => {
    expect(refusal("select * from vault_tasks")).toMatch(/not SQL/);
    expect(refusal("due <= today; DROP TABLE vault_tasks")).toMatch(/cannot contain `;`/);
    expect(refusal("nonsense")).toMatch(/does not know `nonsense`/); // the closed vocabulary is the defence, not the SQL sniffer
  });

  it("refuses the characters a string, a call or a comment would need", () => {
    for (const ch of ["'", '"', "(", ")", ";", "%", "*", "\\", "|", "&", "#", "$", "{", "}", "!"]) {
      expect(refusal(`type = cod${ch}ing`)).toMatch(/cannot contain/);
    }
  });

  it("refuses a field or a flag that is not in the vocabulary", () => {
    expect(refusal("urgency = high")).toMatch(/does not know `urgency`/);
    expect(refusal("blocked")).toMatch(/does not know `blocked`/);
    expect(refusal("due")).toMatch(/expected one of/);
    expect(refusal("due today")).toMatch(/expected one of <= < = >= > : after `due`/);
    expect(refusal("due <=")).toMatch(/expected a value/);
    expect(refusal("overdue waiting")).toMatch(/expected `and` or `or`/);
    expect(refusal("overdue and")).toMatch(/ends with `and`/);
  });

  it("refuses a value it cannot read rather than guessing one (§1.4)", () => {
    expect(refusal("due <= soonish")).toMatch(/cannot read the date `soonish`/);
    expect(refusal("due <= nextweek")).toMatch(/cannot read the date `nextweek`/);
    expect(refusal("priority = p9")).toMatch(/cannot read the priority `p9`/);
    expect(refusal("size = enormous")).toMatch(/cannot read the size `enormous`/);
    expect(refusal("status = pending")).toMatch(/does not know the status `pending`/);
    expect(refusal("project = Drey Ltd")).toMatch(/expected `and` or `or`/);
    expect(refusal("priority < p1")).toMatch(/outside p1\.\.p4/);
    expect(refusal("size > l")).toMatch(/outside s\.\.l/);
  });

  it("refuses an order the vocabulary cannot mean", () => {
    expect(refusal("due <= today and overdue or waiting")).toMatch(/cannot mix `and` with `or`/);
  });

  it("caps the expression, the clause count and the row count", () => {
    expect(refusal(`type = ${"a".repeat(401)}`)).toMatch(/longer than 400 characters/);
    expect(refusal(Array.from({ length: 13 }, () => "overdue").join(" and "))).toMatch(/more than 12 clauses/);
    const over = compileTaskFilter({ limit: 501 }, at);
    expect(over.ok === false && over.error).toMatch(/above 500/);
    const bad = compileTaskFilter({ limit: 0 }, at);
    expect(bad.ok === false && bad.error).toMatch(/whole number of rows/);
  });

  it("every field and flag the spec lists is reachable, and nothing else is", () => {
    expect([...TASK_FILTER_FIELDS]).toEqual(["due", "do", "start", "done", "priority", "size", "type", "assigned", "project", "area", "source", "status"]);
    expect([...TASK_FILTER_FLAGS]).toEqual(["overdue", "unscheduled", "waiting", "recurring", "carried", "blocking_agent", "assigned_to_me"]);
  });
});
