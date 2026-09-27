// The `linear` provider's client (T4-24): read queries only, Linear's
// answers read strictly, and every failure a code — over a fake fetch, never
// the real API.

import { describe, expect, it } from "vitest";
import {
  ASSIGNED_ISSUES_QUERY,
  LINEAR_GRAPHQL_URL,
  LinearError,
  assignedOpenIssues,
  issuesById,
  linearQuery,
  linearRef,
  readIssue,
} from "../src/index.js";

const node = (key: string, over: Record<string, unknown> = {}) => ({
  id: `id-${key}`,
  identifier: key,
  title: `title ${key}`,
  url: `https://linear.app/fsl/issue/${key.toLowerCase()}/x`,
  priority: 2,
  priorityLabel: "High",
  dueDate: null,
  updatedAt: "2026-09-26T00:00:00.000Z",
  description: null,
  state: { name: "Todo", type: "unstarted" },
  team: { key: key.split("-")[0], name: "Team" },
  creator: { name: "Ada" },
  assignee: { name: "Me", isMe: true },
  ...over,
});

function fake(answers: Array<Response | ((body: { query: string; variables: Record<string, unknown> }) => Response)>) {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  const headers: Record<string, string>[] = [];
  let i = 0;
  const fetchFn = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    expect(String(url)).toBe(LINEAR_GRAPHQL_URL);
    const b = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    bodies.push(b);
    const h: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (h[k] = v));
    headers.push(h);
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return typeof a === "function" ? a(b) : a.clone();
  }) as typeof fetch;
  return { sync: { fetch: fetchFn, headers: { authorization: "{{ secret.linear_api_key }}" } }, bodies, headers };
}

const page = (nodes: unknown[], next: string | null) => Response.json({ data: { viewer: { assignedIssues: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } } });

describe("linearRef", () => {
  it("spells linear:<KEY> and refuses anything that is not a key", () => {
    expect(linearRef("ENG-12")).toBe("linear:ENG-12");
    for (const bad of ["eng-12", "ENG-0", "ENG12", "ENG-12 ", "ENG-12\nX", "linear:ENG-1"]) expect(() => linearRef(bad)).toThrow(TypeError);
  });
});

describe("linearQuery — read queries only", () => {
  it("**refuses a mutation, a subscription, or anything that is not a query — nothing is sent**", async () => {
    const f = fake([Response.json({ data: {} })]);
    for (const doc of ["mutation { issueCreate(input: {}) { success } }", "subscription { x }", "{ viewer { id } }", "query A { a } mutation B { b }", "# query\nmutation { x }"]) {
      await expect(linearQuery(f.sync, doc)).rejects.toMatchObject({ code: "not_a_query" });
    }
    expect(f.bodies).toHaveLength(0);
  });

  it("sends the connection's headers (a reference), JSON, and the variables", async () => {
    const f = fake([page([], null)]);
    await assignedOpenIssues(f.sync);
    expect(f.headers[0]).toMatchObject({ authorization: "{{ secret.linear_api_key }}", "content-type": "application/json" });
    expect(f.bodies[0]).toEqual({ query: ASSIGNED_ISSUES_QUERY, variables: { after: null } });
  });

  it("every failure is a code: 401, 429, RATELIMITED, AUTHENTICATION_ERROR, other GraphQL errors, not JSON, no data", async () => {
    const cases: Array<[Response, string]> = [
      [new Response("no", { status: 401 }), "unauthorized"],
      [new Response("slow down", { status: 429 }), "rate_limited"],
      [Response.json({ errors: [{ message: "rate", extensions: { code: "RATELIMITED" } }] }), "rate_limited"],
      [Response.json({ errors: [{ message: "auth", extensions: { code: "AUTHENTICATION_ERROR" } }] }), "unauthorized"],
      [Response.json({ errors: [{ message: "Field 'x' is not defined" }] }), "graphql"],
      [new Response("<html>", { status: 502 }), "http"],
      [new Response("<html>", { status: 200 }), "bad_response"],
      [Response.json({ data: null }), "bad_response"],
    ];
    for (const [res, code] of cases) {
      const err = await linearQuery(fake([res]).sync, ASSIGNED_ISSUES_QUERY).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(LinearError);
      expect((err as LinearError).code, code).toBe(code);
    }
  });
});

describe("assignedOpenIssues", () => {
  it("follows the cursor to the end and reads each issue", async () => {
    const f = fake([page([node("ENG-1"), node("ENG-2")], "c1"), page([node("OPS-3", { state: { name: "Started", type: "started" } })], null)]);
    const issues = await assignedOpenIssues(f.sync);
    expect(issues.map((i) => i.key)).toEqual(["ENG-1", "ENG-2", "OPS-3"]);
    expect(f.bodies.map((b) => b.variables.after)).toEqual([null, "c1"]);
    expect(issues[0]).toMatchObject({ id: "id-ENG-1", priority: 2, priorityLabel: "High", team: { key: "ENG" }, assignedToMe: true, assignee: "Me" });
  });

  it("a closed issue that comes back anyway is not the owner's to do", async () => {
    const issues = await assignedOpenIssues(fake([page([node("ENG-1", { state: { name: "Done", type: "completed" } }), node("ENG-2")], null)]).sync);
    expect(issues.map((i) => i.key)).toEqual(["ENG-2"]);
  });

  it("stops rather than reconcile a partial list when the walk will not end", async () => {
    await expect(assignedOpenIssues(fake([page([node("ENG-1")], "again")]).sync)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("issuesById asks in batches of 100", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const f = fake([(b) => Response.json({ data: { issues: { nodes: (b.variables.ids as string[]).slice(0, 1).map(() => node("ENG-9")) } } })]);
    const out = await issuesById(f.sync, ids);
    expect(f.bodies.map((b) => (b.variables.ids as string[]).length)).toEqual([100, 50]);
    expect(out).toHaveLength(2);
  });
});

describe("readIssue — strict", () => {
  it("refuses an issue without an id, a key Linear would not spell, or a url off https://linear.app", () => {
    expect(() => readIssue(node("ENG-1", { id: null }))).toThrow(LinearError);
    expect(() => readIssue(node("ENG-1", { identifier: "eng 1" }))).toThrow(LinearError);
    expect(() => readIssue(node("ENG-1", { url: "https://linear.app.evil.test/x" }))).toThrow(LinearError);
    expect(() => readIssue(node("ENG-1", { url: "javascript:alert(1)" }))).toThrow(LinearError);
  });

  it("an out-of-range priority reads as none; a malformed due date as none", () => {
    expect(readIssue(node("ENG-1", { priority: 9, dueDate: "soon" }))).toMatchObject({ priority: 0, dueDate: null });
  });
});
