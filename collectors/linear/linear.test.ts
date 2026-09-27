// The Linear sync without a database: what it asks Linear, where the key
// goes, what it records and raises, and that it degrades absent. The SQL is
// proven against Postgres in test/linear.integration.test.ts.

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadKind } from "@foldedspacelabs/metistry-core";
import { LINEAR_GRAPHQL_URL, type LinearIssue } from "@foldedspacelabs/metistry-connections";
import { CONNECTION_YAML, ENV, KEY, fakeLinear, fixture, linearInstance, opener } from "../test/linear-fixture.js";
import { RAISE_DEFAULTS, assignedPayload, closedReason, run, workMeta } from "./run.js";
import { taskTitle, todayLine } from "./today.js";

/** Records every statement; answers `RETURNING id` with an id and every read with nothing. */
function fakeDb() {
  const q: { text: string; values: unknown[] }[] = [];
  let id = 0;
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (/RETURNING id/.test(text)) return { rows: [{ id: ++id }] };
      return { rows: [] };
    },
  };
}

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "u-1",
  key: "ENG-1",
  title: "A title",
  url: "https://linear.app/fsl/issue/eng-1/a-title",
  priority: 2,
  priorityLabel: "High",
  state: { name: "Todo", type: "unstarted" },
  team: { key: "ENG", name: "Engineering" },
  dueDate: null,
  updatedAt: "2026-09-26T00:00:00.000Z",
  description: null,
  creator: "Ada",
  assignee: "Me",
  assignedToMe: true,
  ...over,
});

describe("the linear collector's manifest", () => {
  it("loads through the collector registry, and its Needs You defaults are the ones the code applies", async () => {
    const reg = await loadKind("collector", { productDir: fileURLToPath(new URL("../..", import.meta.url)) });
    const m = reg.get("linear")?.manifest;
    expect(m, JSON.stringify(reg.skipped)).toBeDefined();
    expect(Object.fromEntries(Object.entries(m?.needs_you ?? {}).map(([k, v]) => [k, v.default]))).toEqual(RAISE_DEFAULTS);
  });
});

describe("linear run — degrades absent", () => {
  it("no opener (no instance) is 0 and no statement", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("no Linear connection yet is 0, no statement, no request", async () => {
    const db = fakeDb();
    const linear = fakeLinear({ assigned: [fixture("assigned-2.json")] });
    expect(await run(db, { openSync: opener(linearInstance({ "connections/linear.yaml": "" }), linear.fetch) })).toBe(0);
    expect(db.q).toHaveLength(0);
    expect(linear.sent).toHaveLength(0);
  });

  it("a connection that cannot be read fails the run with why — never a silent 0", async () => {
    const linear = fakeLinear({ assigned: [fixture("assigned-2.json")] });
    const dir = linearInstance({ "connections/linear.yaml": CONNECTION_YAML.replace("https://api.linear.app/graphql", "https://linear.evil.test/graphql") });
    await expect(run(fakeDb(), { openSync: opener(dir, linear.fetch) })).rejects.toThrow(/api\.linear\.app and nowhere else/);
    expect(linear.sent).toHaveLength(0);
  });
});

describe("linear run — through the door", () => {
  it("**the key goes to api.linear.app only, as Authorization: <API_KEY>, and only read queries leave**", async () => {
    const db = fakeDb();
    const linear = fakeLinear({ assigned: [fixture("assigned-1a.json"), fixture("assigned-1b.json")] });
    const n = await run(db, { openSync: opener(linearInstance(), linear.fetch) });
    expect(n).toBe(4);
    expect(linear.sent.map((s) => s.url)).toEqual([LINEAR_GRAPHQL_URL, LINEAR_GRAPHQL_URL]);
    expect(linear.sent.every((s) => s.authorization === KEY)).toBe(true); // no Bearer
    expect(linear.sent.map((s) => [s.operation, s.variables.after])).toEqual([
      ["MetistryAssignedIssues", null],
      ["MetistryAssignedIssues", "WyJlbmctMTAyIl0="],
    ]);
    const statements = db.q.map((x) => x.text).join("\n");
    expect(statements).not.toContain(KEY); // nothing it writes carries the key
    expect(JSON.stringify(db.q.map((x) => x.values))).not.toContain(KEY);
  });

  it("**a secret listed for another host is refused at the door: no request, the run fails, the key is not in the error**", async () => {
    const linear = fakeLinear({ assigned: [fixture("assigned-2.json")] });
    const dir = linearInstance({ "secrets.yaml": 'secrets:\n  linear_api_key:\n    hosts: [collector.evil.test]\n    grants: { "connection:linear": on }\n' });
    const err = await run(fakeDb(), { openSync: opener(dir, linear.fetch) }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/host_not_listed/);
    expect(String(err)).not.toContain(KEY);
    expect(linear.sent).toHaveLength(0);
  });

  it("with no delivered key the run fails missing_secret and nothing is sent", async () => {
    const linear = fakeLinear({ assigned: [fixture("assigned-2.json")] });
    await expect(run(fakeDb(), { openSync: opener(linearInstance(), linear.fetch, {}) })).rejects.toThrow(/missing_secret/);
    expect(linear.sent).toHaveLength(0);
  });

  it("with the raise switched off in scheduled.yaml, it reconciles and raises nothing", async () => {
    const db = fakeDb();
    const linear = fakeLinear({ assigned: [fixture("assigned-2.json")] });
    const dir = linearInstance({ "scheduled.yaml": "syncs:\n  linear:\n    connection: linear\n    raise: { assigned: false }\n" });
    expect(await run(db, { openSync: opener(dir, linear.fetch, ENV) })).toBe(2);
    expect(db.q.filter((x) => x.text.includes("INSERT INTO work"))).toHaveLength(2);
    expect(db.q.filter((x) => x.text.includes("proposals"))).toHaveLength(0);
  });
});

describe("what it records and raises", () => {
  it("work meta: the connection, state, priority and url — never the description", () => {
    expect(workMeta(issue({ description: "secret plans" }), "linear")).toEqual({
      connection: "linear",
      id: "u-1",
      key: "ENG-1",
      url: "https://linear.app/fsl/issue/eng-1/a-title",
      state: "Todo",
      state_type: "unstarted",
      priority: 2,
      priority_label: "High",
      team: "ENG",
    });
  });

  it("the task request: the key and title, an excerpt, the url", () => {
    const p = assignedPayload(issue({ description: `line one\n\n${"x".repeat(400)}` }), "linear");
    expect(p).toMatchObject({ title: "ENG-1 · A title", event: "linear_assigned", key: "ENG-1", url: "https://linear.app/fsl/issue/eng-1/a-title", priority: "High", team: "Engineering" });
    expect((p.body as string).length).toBe(280);
    expect(p.body as string).toMatch(/^line one x/);
    expect(assignedPayload(issue(), "linear").body).toBe("A title");
  });

  it("why an issue left: completed · canceled · unassigned · gone — and not at all when it is still the owner's", () => {
    expect(closedReason(undefined)).toBe("gone");
    expect(closedReason(issue({ state: { name: "Done", type: "completed" } }))).toBe("completed");
    expect(closedReason(issue({ state: { name: "Canceled", type: "canceled" } }))).toBe("canceled");
    expect(closedReason(issue({ assignedToMe: false }))).toBe("unassigned");
    expect(closedReason(issue())).toBeNull();
  });
});

describe("the Add to Today line", () => {
  it("is `- [ ] <title> do <today> linear:<KEY>`, one line whatever the title holds", () => {
    expect(todayLine("Rotate the backup key", "OPS-7", "2026-09-27")).toBe("- [ ] Rotate the backup key do 2026-09-27 linear:OPS-7");
    expect(todayLine("two\nlines\r\n- [ ] and a marker", "OPS-7", "2026-09-27")).toBe("- [ ] two lines - [ ] and a marker do 2026-09-27 linear:OPS-7");
    expect(taskTitle("- [x] already a task")).toBe("already a task");
    expect(taskTitle("  ")).toBe("(untitled)");
    expect(taskTitle("y".repeat(500))).toHaveLength(200);
  });
});
