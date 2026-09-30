// The connections proxy's lazy pair on /mcp (plan §2.6, C115; T4-8b), driven
// through a real MCP client against the real server with a fake proxy and a
// fake Db — no Postgres, no connection file, no upstream. What is held here:
//
//   * **a crew needs both `uses: [connections]` and a grant** (the ticket's
//     bold test) — and the owner must have offered the connection;
//   * a connection the caller cannot reach answers exactly like one that
//     does not exist, on both tools;
//   * the owner's per-tool policy decides how a tool runs, and nothing but a
//     Read at Allow — or a confirmed call — ever reaches the proxy (T4-9; the
//     full preview → confirm → Approve flows are connections-confirm.integration.test.ts);
//   * the caller's bearer reaches the proxy only as the thing to refuse, and
//     the wire never carries the pool's own sentence (which names secrets);
//   * every call is one `runs` row of kind `connection_call`, refusals
//     included, with the connection, the upstream tool and secret NAMES;
//   * no credential is the uniform 401.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EgressRefused } from "@foldedspacelabs/metistry-core";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { createBrainServer, type AgentPrincipal, type ConnectionsProxy, type Db, type ProxiedConnection } from "../src/index.js";

const BEARER = "agent-bearer-0123456789abcdef";

interface RunRow {
  kind: string;
  component: string;
  tool: string;
  meta: Record<string, unknown>;
  ok?: boolean;
  error?: string | null;
}

/** A Db that keeps the runs rows the bridge writes, merged the way `finishRun` merges them. */
function recordingDb(): Db & { runs: RunRow[] } {
  const runs: RunRow[] = [];
  return {
    runs,
    async query(text, values) {
      if (text.startsWith("INSERT INTO runs")) {
        runs.push({ component: values![0] as string, kind: values![1] as string, tool: values![3] as string, meta: JSON.parse(values![6] as string) as Record<string, unknown> });
        return { rows: [{ id: runs.length }] };
      }
      if (text.startsWith("UPDATE runs SET finished_at")) {
        const r = runs[(values![0] as number) - 1]!;
        r.ok = values![1] as boolean;
        r.error = values![2] as string | null;
        Object.assign(r.meta, JSON.parse(values![6] as string));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const GITHUB: ProxiedConnection = {
  name: "github",
  type: "mcp",
  description: "GitHub",
  status: "ok",
  offer_to_agents: true,
  tools: [
    { name: "list_issues", group: "reads", mode: "on" },
    { name: "search_code", group: "reads", mode: "ask" },
    { name: "create_issue", group: "changes", mode: "on" },
    { name: "delete_repo", group: "changes", mode: "off" },
  ],
};
/** Held by the owner, not lent: offer to agents is off. */
const PRIVATE: ProxiedConnection = { ...GITHUB, name: "work-jira", description: "Jira", offer_to_agents: false, tools: [{ name: "list_issues", group: "reads", mode: "on" }] };

/** A proxy that records every call it was asked to make, and answers from a script. */
function fakeProxy(answer?: (req: Parameters<ConnectionsProxy["call"]>[0]) => Promise<Awaited<ReturnType<ConnectionsProxy["call"]>>>): ConnectionsProxy & { calls: Parameters<ConnectionsProxy["call"]>[0][]; dialled: string[] } {
  const calls: Parameters<ConnectionsProxy["call"]>[0][] = [];
  const dialled: string[] = [];
  return {
    calls,
    dialled,
    async list() {
      return [GITHUB, PRIVATE];
    },
    async tools(name) {
      dialled.push(name);
      const c = [GITHUB, PRIVATE].find((x) => x.name === name)!;
      return c.tools.filter((t) => t.mode !== "off").map((t) => ({ ...t, description: `the ${t.name} tool`, inputSchema: { type: "object", properties: { q: { type: "string" } } } }));
    },
    async call(req) {
      calls.push(req);
      return answer ? answer(req) : { content: [{ type: "text", text: `called ${req.tool}` }], isError: false, secrets: ["github_token"] };
    },
  };
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

/** Stand the bridge up for one principal (null = no credential) and return a caller for its tools. */
async function brainFor(principal: AgentPrincipal | null, proxy: ConnectionsProxy | undefined, db = recordingDb()) {
  const brain = createBrainServer({ db, authenticate: async () => principal, tasks: new TasksService(db), inboxDir: "/nonexistent", ...(proxy ? { connections: proxy } : {}) });
  const http = createServer((req, res) => void brain.handle(req, res));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
  servers.push({ close: () => new Promise<void>((r) => http.close(() => r())) });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${BEARER}` } } }) as never);
  servers.push({ close: () => client.close() });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { body: JSON.parse(r.content[0]!.text.split("\n")[0]!) as Record<string, any>, isError: r.isError === true };
  };
  return { call, db, url };
}

const agent = (connections?: string[]): AgentPrincipal => ({ id: "scout", grants: { tier: "none", areas: [], ...(connections ? { connections } : {}) }, projects: [] });
const crew = (uses: string[], connections?: string[]): AgentPrincipal => ({ id: "writer", kind: "crew", uses, grants: { tier: "none", areas: [], ...(connections ? { connections } : {}) }, projects: [] });
const assistant: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] };

describe("who reaches a connection", () => {
  it("a crew needs BOTH `uses: [connections]` and a grant — either alone reaches nothing", async () => {
    // neither
    const none = await brainFor(crew(["knowledge"]), fakeProxy());
    expect((await none.call("connections_call", { connection: "github", tool: "list_issues" })).body.error.code).toBe("forbidden");
    // the grant without the group: refused at the door, naming the toolset it DOES hold
    const grantOnly = fakeProxy();
    const g = await brainFor(crew(["knowledge"], ["github"]), grantOnly);
    const refusedByUses = await g.call("connections_call", { connection: "github", tool: "list_issues" });
    expect(refusedByUses.body.error.code).toBe("forbidden");
    expect(refusedByUses.body.error.message).toContain("not in this crew's toolset");
    expect((await g.call("connections_list")).body.error.code).toBe("forbidden");
    expect(grantOnly.calls).toEqual([]);
    // the group without the grant: the uniform "no such connection"
    const usesOnly = fakeProxy();
    const u = await brainFor(crew(["connections"]), usesOnly);
    expect((await u.call("connections_call", { connection: "github", tool: "list_issues" })).body.error).toEqual({ code: "not_found", message: "no such connection: github" });
    expect((await u.call("connections_list")).body).toEqual({ connections: [] });
    expect(usesOnly.calls).toEqual([]);
    // both: it works
    const both = fakeProxy();
    const b = await brainFor(crew(["connections"], ["github"]), both);
    const ok = await b.call("connections_call", { connection: "github", tool: "list_issues", arguments: { q: "bug" } });
    expect(ok.isError).toBe(false);
    expect(ok.body).toMatchObject({ connection: "github", tool: "list_issues", content: [{ type: "text", text: "called list_issues" }] });
    expect(both.calls).toHaveLength(1);
    expect(both.calls[0]).toMatchObject({ connection: "github", tool: "list_issues", args: { q: "bug" } });
  });

  it("the owner's offer switch binds a granted agent: a connection not offered to agents is not there for it", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(agent(["github", "work-jira"]), proxy);
    expect((await call("connections_call", { connection: "work-jira", tool: "list_issues" })).body.error).toEqual({ code: "not_found", message: "no such connection: work-jira" });
    expect((await call("connections_list")).body.connections.map((c: { name: string }) => c.name)).toEqual(["github"]);
    expect(proxy.calls).toEqual([]);
  });

  it("a connection the caller cannot reach and one that does not exist are the same answer, on both tools", async () => {
    const { call } = await brainFor(agent(["github"]), fakeProxy());
    const unlent = await call("connections_call", { connection: "work-jira", tool: "list_issues" });
    const missing = await call("connections_call", { connection: "work-jiraa", tool: "list_issues" });
    expect(unlent.body.error.message.replace("work-jira", "X")).toBe(missing.body.error.message.replace("work-jiraa", "X"));
    expect(unlent.body.error.code).toBe(missing.body.error.code);
    const listUnlent = await call("connections_list", { connection: "work-jira" });
    const listMissing = await call("connections_list", { connection: "work-jiraa" });
    expect(listUnlent.body.error.code).toBe("not_found");
    expect(listUnlent.body.error.message.replace("work-jira", "X")).toBe(listMissing.body.error.message.replace("work-jiraa", "X"));
  });

  it("an agent with no grant sees the two tools and finds nothing behind them", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(agent(), proxy);
    expect((await call("connections_list")).body).toEqual({ connections: [] });
    expect((await call("connections_call", { connection: "github", tool: "list_issues" })).body.error.code).toBe("not_found");
    expect(proxy.calls).toEqual([]);
    expect(proxy.dialled).toEqual([]);
  });

  it("the assistant reaches every connection, offered or not — the switch is about lending (C115)", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(assistant, proxy);
    expect((await call("connections_list")).body.connections.map((c: { name: string }) => c.name)).toEqual(["github", "work-jira"]);
    expect((await call("connections_call", { connection: "work-jira", tool: "list_issues" })).isError).toBe(false);
  });

  it("no credential is the uniform 401 — the proxy is never reached", async () => {
    const proxy = fakeProxy();
    const brain = createBrainServer({ db: recordingDb(), authenticate: async () => null, tasks: new TasksService(recordingDb()), inboxDir: "/nonexistent", connections: proxy });
    const http = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    servers.push({ close: () => new Promise<void>((r) => http.close(() => r())) });
    const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "connections_call", arguments: { connection: "github", tool: "list_issues" } } }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    expect(proxy.calls).toEqual([]);
  });
});

describe("how each tool runs — the owner's per-tool policy (T4-9)", () => {
  it("lists every tool the caller is offered with how it runs, and fetches definitions only when a connection is named", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(agent(["github"]), proxy);
    const all = await call("connections_list");
    expect(all.body.connections).toEqual([
      {
        name: "github",
        type: "mcp",
        description: "GitHub",
        status: "ok",
        // Never (delete_repo) is not there at all
        tools: [
          { name: "list_issues", runs: "now" },
          { name: "search_code", runs: "owner" },
          { name: "create_issue", runs: "confirm" },
        ],
      },
    ]);
    expect(proxy.dialled).toEqual([]); // the listing never dials
    const one = await call("connections_list", { connection: "github" });
    const schema = { type: "object", properties: { q: { type: "string" } } };
    expect(one.body).toEqual({
      connection: "github",
      tools: [
        { name: "list_issues", runs: "now", description: "the list_issues tool", inputSchema: schema },
        { name: "search_code", runs: "owner", description: "the search_code tool", inputSchema: schema },
        { name: "create_issue", runs: "confirm", description: "the create_issue tool", inputSchema: schema },
      ],
    });
    expect(proxy.dialled).toEqual(["github"]);
  });

  it("Never and an unlisted tool are 'no such tool', and the proxy is asked for neither", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(agent(["github"]), proxy);
    expect((await call("connections_call", { connection: "github", tool: "delete_repo" })).body.error).toEqual({ code: "not_found", message: "no such tool: github/delete_repo" });
    expect((await call("connections_call", { connection: "github", tool: "exfiltrate" })).body.error).toEqual({ code: "not_found", message: "no such tool: github/exfiltrate" });
    // …even with a confirm token in hand
    expect((await call("connections_call", { connection: "github", tool: "delete_repo", confirm_token: "A".repeat(43) })).body.error.code).toBe("not_found");
    expect(proxy.calls).toEqual([]);
  });

  it("a tool that changes things, set to Allow, answers a preview and a token first — nothing is dialled", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(agent(["github"]), proxy);
    const preview = await call("connections_call", { connection: "github", tool: "create_issue", arguments: { title: "flake" } });
    expect(preview.isError).toBe(false);
    expect(preview.body).toMatchObject({ status: "preview", connection: "github", tool: "create_issue", arguments: { title: "flake" }, expires_in_sec: 900 });
    expect(preview.body.confirm_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proxy.calls).toEqual([]);
  });

  it("Ask First never runs on a caller's token — refused before anything is recorded or dialled", async () => {
    const proxy = fakeProxy();
    const db = recordingDb();
    const { call } = await brainFor(agent(["github"]), proxy, db);
    const r = await call("connections_call", { connection: "github", tool: "search_code", confirm_token: "A".repeat(43) });
    expect(r.body.error.code).toBe("forbidden");
    expect(r.body.error.message).toContain("Ask First");
    expect(db.runs.at(-1)!.meta).toMatchObject({ refusal: "ask_only", tool_mode: "ask" });
    expect(proxy.calls).toEqual([]);
  });
});

describe("the caller's credential, and what the wire says about a failure", () => {
  it("hands the caller's bearer to the proxy only as the thing to refuse — never inside the arguments it forwards", async () => {
    const proxy = fakeProxy();
    const { call } = await brainFor(agent(["github"]), proxy);
    await call("connections_call", { connection: "github", tool: "list_issues", arguments: { q: "x" } });
    expect(proxy.calls[0]!.caller).toEqual({ bearer: BEARER });
    expect(JSON.stringify(proxy.calls[0]!.args)).not.toContain(BEARER);
  });

  it("maps the pool's refusals to the envelope without its sentence, which names the owner's secrets", async () => {
    const refusal = (code: string) => Object.assign(new Error(`connection github refused (${code}): connection:github is not granted github_token (\`metistry secrets grant github_token connection:github on\`)`), { name: "ConnectionRefused", code });
    for (const [code, want] of [
      ["secret", "not_available"],
      ["caller_credential", "invalid_request"],
      ["secret_reference", "invalid_request"],
      ["sign_in", "not_available"],
      ["tool_off", "not_found"],
      ["needs_approval", "forbidden"],
      ["unknown_connection", "not_found"],
    ] as const) {
      const db = recordingDb();
      const { call } = await brainFor(agent(["github"]), fakeProxy(async () => Promise.reject(refusal(code))), db);
      const r = await call("connections_call", { connection: "github", tool: "list_issues" });
      expect(r.body.error.code, code).toBe(want);
      expect(JSON.stringify(r.body), code).not.toContain("github_token");
      // …while the owner's audit row keeps the detail
      expect(db.runs.at(-1)!.meta.detail, code).toContain("github_token");
      expect(db.runs.at(-1)!.meta.refusal, code).toBe(code);
    }
    const egress = new EgressRefused("host_not_listed", ["github_token"], "evil.example", "github_token may be sent only to api.github.com");
    const { call } = await brainFor(agent(["github"]), fakeProxy(async () => Promise.reject(egress)));
    const r = await call("connections_call", { connection: "github", tool: "list_issues" });
    expect(r.body.error).toEqual({ code: "not_available", message: "github cannot be reached right now (host_not_listed) — the owner sees why in Connections" });
  });

  it("answers not_available when the host configured no connections", async () => {
    const { call } = await brainFor(assistant, undefined);
    expect((await call("connections_list")).body.error.code).toBe("not_available");
    expect((await call("connections_call", { connection: "github", tool: "list_issues" })).body.error.code).toBe("not_available");
  });
});

describe("the audit — one connection_call row per call", () => {
  it("records the call as kind connection_call: the principal, the connection, the upstream tool and the secret names it carried", async () => {
    const db = recordingDb();
    const { call } = await brainFor(agent(["github"]), fakeProxy(), db);
    await call("connections_call", { connection: "github", tool: "list_issues", arguments: { q: "x" } });
    const row = db.runs.at(-1)!;
    expect(row).toMatchObject({ kind: "connection_call", component: "scout", tool: "connections_call", ok: true });
    expect(row.meta).toMatchObject({ via: "mcp-brain", connection: "github", connection_tool: "list_issues", is_error: false, secrets: ["github_token"] });
  });

  it("records a refusal the same way — who tried to reach what is answerable from runs", async () => {
    const db = recordingDb();
    const { call } = await brainFor(crew(["connections"]), fakeProxy(), db);
    await call("connections_call", { connection: "github", tool: "list_issues" });
    expect(db.runs.at(-1)).toMatchObject({ kind: "connection_call", component: "writer", ok: false, error: "not_found", meta: { connection: "github", connection_tool: "list_issues" } });
    // a crew without the group is refused at the door, and that is a connection_call row too
    const db2 = recordingDb();
    await (await brainFor(crew(["knowledge"], ["github"]), fakeProxy(), db2)).call("connections_call", { connection: "github", tool: "list_issues" });
    expect(db2.runs.at(-1)).toMatchObject({ kind: "connection_call", ok: false, error: "forbidden", meta: { connection: "github", reason: "not_in_uses" } });
  });

  it("keeps connections_list an ordinary tool row — a listing is not a call", async () => {
    const db = recordingDb();
    await (await brainFor(agent(["github"]), fakeProxy(), db)).call("connections_list");
    expect(db.runs.at(-1)).toMatchObject({ kind: "tool", tool: "connections_list", ok: true });
  });
});
