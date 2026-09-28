// Send to Linear's service (T4-25): one issue per task, idempotent by task
// key with no state of its own — the issue's id is derived from the task, so
// a second send answers the first issue and a lost answer is found again.
// Over a stateful fake Linear, never the real API; and once through the
// connection's own door, so the key is seen going to api.linear.app only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ConnectionRefused,
  ISSUE_CREATE_MUTATION,
  LINEAR_GRAPHQL_URL,
  LINEAR_MODULE,
  LINEAR_ORIGIN,
  LINEAR_SYNC,
  LinearError,
  VIEWER_TEAMS_QUERY,
  createLinearIssue,
  envSecretSource,
  issueTitle,
  openSyncHttp,
  trackerIssueId,
} from "../src/index.js";
import { catalogOf } from "./helpers.js";

interface Call {
  url: string;
  authorization: string | null;
  operation: string;
  variables: Record<string, unknown>;
}

/**
 * A Linear that keeps what it is sent: issues by id, a create refused when
 * the id is taken (as Linear refuses a duplicate primary key), and knobs to
 * lose an answer or fail a call.
 */
function fakeLinear(opts: { teams?: { id: string; key: string; name: string }[]; loseCreateAnswer?: boolean; createStatus?: number } = {}) {
  const teams = opts.teams ?? [{ id: "team-eng", key: "ENG", name: "Engineering" }];
  const issues = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  let n = 0;
  const node = (id: string, teamId: string, title: string) => {
    const team = teams.find((t) => t.id === teamId)!;
    const key = `${team.key}-${++n}`;
    return {
      id,
      identifier: key,
      title,
      url: `https://linear.app/fsl/issue/${key.toLowerCase()}/x`,
      priority: 0,
      priorityLabel: "No priority",
      dueDate: null,
      updatedAt: "2026-09-28T12:00:00.000Z",
      description: null,
      state: { name: "Backlog", type: "backlog" },
      team: { key: team.key, name: team.name },
      creator: { name: "Me" },
      assignee: null,
    };
  };
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
    calls.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), operation, variables: body.variables });
    if (operation === "MetistryIssuesById") {
      const ids = (body.variables.ids as string[]) ?? [];
      return Response.json({ data: { issues: { nodes: ids.flatMap((id) => (issues.has(id) ? [issues.get(id)] : [])) } } });
    }
    if (operation === "MetistryViewerTeams") return Response.json({ data: { viewer: { teams: { nodes: teams } } } });
    if (operation === "MetistryIssueCreate") {
      const input = body.variables.input as { id: string; teamId: string; title: string };
      if (issues.has(input.id)) return Response.json({ errors: [{ message: "Entity already exists", extensions: { code: "INVALID_INPUT" } }] });
      if (opts.createStatus) return new Response("upstream", { status: opts.createStatus });
      const created = node(input.id, input.teamId, input.title);
      issues.set(input.id, created);
      if (opts.loseCreateAnswer) throw new TypeError("fetch failed"); // it landed; the answer did not
      return Response.json({ data: { issueCreate: { success: true, issue: created } } });
    }
    return Response.json({ errors: [{ message: `unexpected ${operation}` }] });
  }) as typeof fetch;
  const creates = () => calls.filter((c) => c.operation === "MetistryIssueCreate");
  return { fetch: fetchFn, sync: { fetch: fetchFn, headers: { authorization: "{{ secret.linear_api_key }}" } }, calls, issues, creates };
}

const ID = trackerIssueId("linear", "Journal/2026-09-28.md", "mt-7f3k2a");

describe("trackerIssueId — the task's issue, named by the task", () => {
  it("is a v4-shaped UUID, the same for the same task, different for another note or key or connection", () => {
    expect(ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(trackerIssueId("linear", "Journal/2026-09-28.md", "mt-7f3k2a")).toBe(ID);
    expect(trackerIssueId("linear", "Journal/2026-09-29.md", "mt-7f3k2a")).not.toBe(ID);
    expect(trackerIssueId("linear", "Journal/2026-09-28.md", "mt-7f3k2b")).not.toBe(ID);
    expect(trackerIssueId("linear-2", "Journal/2026-09-28.md", "mt-7f3k2a")).not.toBe(ID);
  });
});

describe("issueTitle", () => {
  it("one line, no control characters, bounded at 255", () => {
    expect(issueTitle("  Send\tDana \u2028 the\nformat ")).toBe("Send Dana the format");
    expect(issueTitle("x".repeat(400))).toHaveLength(255);
    expect(issueTitle(" \n ")).toBe("");
  });
});

describe("createLinearIssue", () => {
  it("files the issue under the task's id with the id, the team and the title — nothing else of the note", async () => {
    const f = fakeLinear();
    const r = await createLinearIssue(f.sync, { id: ID, title: "Send Dana the fixture format" });
    expect(r).toMatchObject({ ok: true, created: true, issue: { id: ID, key: "ENG-1", title: "Send Dana the fixture format" } });
    expect(f.calls.map((c) => c.operation)).toEqual(["MetistryIssuesById", "MetistryViewerTeams", "MetistryIssueCreate"]);
    expect(f.creates()[0]!.variables).toEqual({ input: { id: ID, teamId: "team-eng", title: "Send Dana the fixture format" } });
    expect(f.calls.every((c) => c.url === LINEAR_GRAPHQL_URL)).toBe(true);
  });

  it("**is not created twice**: a second send answers the first issue, and sends no mutation", async () => {
    const f = fakeLinear();
    const first = await createLinearIssue(f.sync, { id: ID, title: "Send it" });
    const second = await createLinearIssue(f.sync, { id: ID, title: "Send it, reworded" });
    expect(second).toEqual({ ok: true, created: false, issue: (first as { issue: unknown }).issue });
    expect(f.creates()).toHaveLength(1);
    expect(f.issues.size).toBe(1);
  });

  it("**two sends racing meet at Linear**: the second create is refused there, and the first issue is the answer", async () => {
    const f = fakeLinear();
    const [a, b] = await Promise.all([createLinearIssue(f.sync, { id: ID, title: "Race" }), createLinearIssue(f.sync, { id: ID, title: "Race" })]);
    expect(f.issues.size).toBe(1);
    expect([a, b].map((r) => (r.ok ? r.created : null)).sort()).toEqual([false, true]);
    expect((a as { issue: { key: string } }).issue.key).toBe((b as { issue: { key: string } }).issue.key);
  });

  it("**a create whose answer was lost** is found under its id, not filed again", async () => {
    const f = fakeLinear({ loseCreateAnswer: true });
    const r = await createLinearIssue(f.sync, { id: ID, title: "Lost" });
    expect(r).toMatchObject({ ok: true, created: false, issue: { id: ID, key: "ENG-1" } });
    expect(f.issues.size).toBe(1);
  });

  it("a create that failed and did not land is the failure, as a code", async () => {
    await expect(createLinearIssue(fakeLinear({ createStatus: 500 }).sync, { id: ID, title: "No" })).rejects.toMatchObject({ code: "http" });
  });

  it("several teams and none named: nothing is created, and the teams come back to choose from", async () => {
    const teams = [
      { id: "t1", key: "ENG", name: "Engineering" },
      { id: "t2", key: "OPS", name: "Operations" },
    ];
    const f = fakeLinear({ teams });
    expect(await createLinearIssue(f.sync, { id: ID, title: "Which team" })).toEqual({ ok: false, reason: "team_required", teams: [{ key: "ENG", name: "Engineering" }, { key: "OPS", name: "Operations" }] });
    expect(await createLinearIssue(f.sync, { id: ID, title: "Which team", team: "SEC" })).toMatchObject({ ok: false, reason: "unknown_team" });
    expect(f.creates()).toHaveLength(0);
    expect(await createLinearIssue(f.sync, { id: ID, title: "Which team", team: "OPS" })).toMatchObject({ ok: true, created: true, issue: { key: "OPS-1" } });
  });

  it("refuses what the door should have made: a non-UUID id, an empty or multi-line title, a team that is not a key", async () => {
    const f = fakeLinear();
    await expect(createLinearIssue(f.sync, { id: "mt-7f3k2a", title: "x" })).rejects.toThrow(TypeError);
    await expect(createLinearIssue(f.sync, { id: ID, title: "" })).rejects.toThrow(TypeError);
    await expect(createLinearIssue(f.sync, { id: ID, title: "a\nb" })).rejects.toThrow(TypeError);
    await expect(createLinearIssue(f.sync, { id: ID, title: "x", team: "eng" })).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });

  it("the mutation is one fixed document with three inputs, and the read door still refuses it", async () => {
    expect(ISSUE_CREATE_MUTATION).toMatch(/^mutation MetistryIssueCreate\(\$input: IssueCreateInput!\)/);
    expect(VIEWER_TEAMS_QUERY).toMatch(/^query /);
    const { linearQuery } = await import("../src/linear.js");
    await expect(linearQuery(fakeLinear().sync, ISSUE_CREATE_MUTATION)).rejects.toBeInstanceOf(LinearError);
  });
});

describe("createLinearIssue through the connection's door", () => {
  const LINEAR_TYPE = parse(readFileSync(new URL("../../../seed/connection-types/linear/manifest.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
  const KEY = ["lin", "api", "Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz1Xc3Vb5Nm7Qa"].join("_");
  const POLICY = `secrets:\n  linear_api_key:\n    hosts: [api.linear.app]\n    grants: { "connection:linear": on }\n`;
  const file = { name: "linear", type: "tracker", provider: "linear", reach: { http: { url: "https://api.linear.app/graphql", auth: { scheme: "api_key", header: "Authorization", secret: "linear_api_key" } } }, secrets: ["linear_api_key"] };
  const open = (fetchFn: typeof fetch) => {
    const o = openSyncHttp({ catalog: catalogOf([file], { secrets: POLICY, types: [LINEAR_TYPE] }), sync: LINEAR_SYNC, origin: LINEAR_ORIGIN, module: LINEAR_MODULE, secrets: envSecretSource({ METISTRY_SECRET_LINEAR_API_KEY: KEY }), fetch: fetchFn });
    if (!o.ok) throw new Error(o.why);
    return o.sync;
  };

  it("the provider declares `create`, and the key is filled at the door for api.linear.app — never by the caller, never on a URL", async () => {
    const f = fakeLinear();
    const sync = open(f.fetch);
    expect(sync.capabilities).toEqual(["read", "create", "complete"]);
    expect(sync.headers.authorization).toBe("{{ secret.linear_api_key }}");
    await createLinearIssue(sync, { id: ID, title: "Through the door" });
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) {
      expect(c.url).toBe(LINEAR_GRAPHQL_URL);
      expect(c.url).not.toContain(KEY);
      expect(c.authorization).toBe(KEY);
    }
  });

  it("a redirect from Linear is refused, and is not mistaken for a create that may have landed", async () => {
    const redirecting = (async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/graphql" } })) as typeof fetch;
    await expect(createLinearIssue(open(redirecting), { id: ID, title: "x" })).rejects.toBeInstanceOf(ConnectionRefused);
  });
});
