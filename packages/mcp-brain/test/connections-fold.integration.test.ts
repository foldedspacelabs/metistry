// A folded connection answer and its pages (X-132), against the real scratch
// database with a fake proxy: the whole answer lands in `connection_answers`
// under the call's own `runs` id, and what is held is SQL, not a sentence:
//
//   * **the same principal pages the whole answer back**, byte for byte, and
//     the fold is the same on a second dial of the same answer;
//   * **another principal cannot read the stored answer back** (the ticket's
//     bold test) — the same `not_found` an unknown handle gets, down one path;
//   * **with folding off the answer comes whole**, and nothing is stored;
//   * an expired answer is gone, a page past the last is refused, and the
//     `runs` row carries bytes in, bytes out and the handle.
//
// The misuse tests of the door itself (401 with no credential, the grant
// gate) are connections-tools.test.ts, which drives `page` through the same
// server with a fake Db.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { DEFAULT_CONNECTION_FOLD, createBrainServer, type AgentPrincipal, type ConnectionFold, type ConnectionsProxy, type ProxiedConnection } from "../src/index.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const FOLD: ConnectionFold = { ...DEFAULT_CONNECTION_FOLD, thresholdBytes: 600, arrayOver: 5, arrayKeep: 2 };

const issues = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `issue ${i + 1} — ünïcödé 😀`, state: i % 2 ? "open" : "closed" }));
const BIG = JSON.stringify(issues(60));

const github = (fold: boolean | undefined): ProxiedConnection => ({
  name: "github",
  type: "mcp",
  description: "GitHub",
  status: "ok",
  offer_to_agents: true,
  ...(fold === undefined ? {} : { fold }),
  tools: [
    { name: "list_issues", group: "reads", mode: "on" },
    { name: "list_prs", group: "reads", mode: "on" },
  ],
});

type CallReq = Parameters<ConnectionsProxy["call"]>[0];

function fakeProxy(connection: ProxiedConnection): ConnectionsProxy & { calls: CallReq[] } {
  const calls: CallReq[] = [];
  return {
    calls,
    async list() {
      return [connection];
    },
    async tools() {
      return [];
    },
    async call(req) {
      calls.push(req);
      return { content: [{ type: "text", text: BIG }], structuredContent: issues(60), isError: false, secrets: ["github_token"] };
    },
  };
}

interface Parsed {
  isError: boolean;
  body: any;
}

describe.skipIf(!hasDb)("connections_call folds a large answer and pages it back (real db)", () => {
  let pool: pg.Pool;
  const servers: Server[] = [];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  async function brainFor(principal: AgentPrincipal, connection: ProxiedConnection, fold: ConnectionFold = FOLD) {
    const proxy = fakeProxy(connection);
    const brain = createBrainServer({ db: pool, authenticate: async () => principal, tasks: new TasksService(pool), inboxDir: "/nonexistent", connections: proxy, connectionFold: fold });
    const server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let id = 1;
    const call = async (args: Record<string, unknown>): Promise<Parsed> => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer itest-fold-bearer-0123456789abcdef" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "connections_call", arguments: args } }),
      });
      const answer = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      return { isError: answer.result.isError === true, body: JSON.parse(answer.result.content[0]!.text.split("\n")[0]!) };
    };
    return { call, proxy };
  }

  const agent = (id: string): AgentPrincipal => ({ id, grants: { tier: "none", areas: [], connections: ["github"] }, projects: [] });
  const lastRun = async (component: string) => (await pool.query(`SELECT id, ok, error, meta FROM runs WHERE component = $1 AND kind = 'connection_call' ORDER BY id DESC LIMIT 1`, [component])).rows[0]!;

  it("folds over the threshold, keeps the whole under the call's run id, and the same principal pages it all back", async () => {
    const who = `itest-fold-${suffix}`;
    const { call, proxy } = await brainFor(agent(who), github(undefined));
    const first = await call({ connection: "github", tool: "list_issues" });
    expect(first.isError).toBe(false);
    expect(proxy.calls).toHaveLength(1);
    // the fold: first k, last, count — and no structuredContent beside it
    expect(first.body.content).toHaveLength(1);
    expect(JSON.parse(first.body.content[0].text)).toEqual({ folded: "array", count: 60, first: issues(60).slice(0, 2), last: issues(60)[59] });
    expect(first.body.structuredContent).toBeUndefined();
    const { handle, bytes, pages, how } = first.body.folded;
    expect(how).toEqual(["array"]);
    const run = await lastRun(who);
    expect(String(run.id)).toBe(handle);
    expect(run.meta).toMatchObject({ mode: "call", dialled: true, fold: "array", handle, pages, bytes_in: bytes, secrets: ["github_token"] });
    expect(Number((run.meta as { bytes_out: number }).bytes_out)).toBeLessThan(bytes);
    expect(Number((run.meta as { bytes_out: number }).bytes_out)).toBeGreaterThan(0);
    // what is stored is the whole redacted answer, under this principal
    const stored = (await pool.query(`SELECT principal, connection, tool, bytes, answer FROM connection_answers WHERE run_id = $1`, [Number(handle)])).rows[0]!;
    expect(stored).toMatchObject({ principal: who, connection: "github", tool: "list_issues", bytes });
    expect((stored.answer as { content: unknown[] }).content).toEqual([{ type: "text", text: BIG }]);

    // the pages, in order, are the text whole
    let text = "";
    for (let n = 1; n <= pages; n += 1) {
      const page = await call({ connection: "github", tool: "list_issues", page: `${handle}/${n}` });
      expect(page.isError, JSON.stringify(page.body)).toBe(false);
      expect(page.body).toMatchObject({ connection: "github", tool: "list_issues", handle, page: n, pages, bytes });
      expect(Buffer.byteLength(page.body.text, "utf8")).toBeLessThanOrEqual(FOLD.thresholdBytes);
      if (n < pages) expect(page.body.next).toBe(`${handle}/${n + 1}`);
      else expect(page.body.next).toBeUndefined();
      text += page.body.text;
    }
    expect(text).toBe(BIG);
    expect(proxy.calls).toHaveLength(1); // a page dials nothing
    const pageRun = await lastRun(who);
    expect(pageRun.meta).toMatchObject({ mode: "page", handle, page: pages, pages });
    expect(pageRun.meta).not.toHaveProperty("dialled");

    // past the last page: refused, naming the range
    const beyond = await call({ connection: "github", tool: "list_issues", page: `${handle}/${pages + 1}` });
    expect(beyond.body.error.code).toBe("invalid_request");
    expect(beyond.body.error.message).toContain(`"${handle}/1" to "${handle}/${pages}"`);
    expect((await call({ connection: "github", tool: "list_issues", page: `${handle}/0` })).body.error.code).toBe("invalid_request");
    // a page under another tool of the same connection is not this answer
    expect((await call({ connection: "github", tool: "list_prs", page: `${handle}/1` })).body.error).toEqual({ code: "not_found", message: `no such answer: ${handle}/1` });

    // the same answer folds identically on a second dial
    const second = await call({ connection: "github", tool: "list_issues" });
    expect(second.body.content).toEqual(first.body.content);
    expect(second.body.folded).toMatchObject({ bytes, pages, how });
    expect(second.body.folded.handle).not.toBe(handle); // a new call, a new handle
  });

  it("another principal cannot read the stored answer back — the same not_found an unknown handle gets", async () => {
    const owner = `itest-fold-owner-${suffix}`;
    const other = `itest-fold-other-${suffix}`;
    const mine = await brainFor(agent(owner), github(undefined));
    const { handle } = (await mine.call({ connection: "github", tool: "list_issues" })).body.folded;
    expect((await mine.call({ connection: "github", tool: "list_issues", page: `${handle}/1` })).isError).toBe(false);

    const theirs = await brainFor(agent(other), github(undefined));
    const refused = await theirs.call({ connection: "github", tool: "list_issues", page: `${handle}/1` });
    expect(refused.body.error).toEqual({ code: "not_found", message: `no such answer: ${handle}/1` });
    expect((await lastRun(other)).meta).toMatchObject({ mode: "page", handle, refusal: "no_answer" });
    const unknown = await theirs.call({ connection: "github", tool: "list_issues", page: `999999999/1` });
    expect(unknown.body.error).toEqual({ code: "not_found", message: "no such answer: 999999999/1" });
    expect(theirs.proxy.calls).toEqual([]);
    // the row is untouched: still the owner's
    expect((await pool.query(`SELECT principal FROM connection_answers WHERE run_id = $1`, [Number(handle)])).rows[0]).toEqual({ principal: owner });
  });

  it("with folding off the answer comes whole, and nothing is stored", async () => {
    const who = `itest-fold-off-${suffix}`;
    const { call } = await brainFor(agent(who), github(false));
    const whole = await call({ connection: "github", tool: "list_issues" });
    expect(whole.isError).toBe(false);
    expect(whole.body.content).toEqual([{ type: "text", text: BIG }]);
    expect(whole.body.structuredContent).toEqual(issues(60));
    expect(whole.body.folded).toBeUndefined();
    const run = await lastRun(who);
    expect(run.meta).toMatchObject({ mode: "call", dialled: true, fold: "off" });
    expect((run.meta as { bytes_in: number; bytes_out: number }).bytes_in).toBe((run.meta as { bytes_in: number; bytes_out: number }).bytes_out);
    expect(run.meta).not.toHaveProperty("handle");
    expect((await pool.query(`SELECT count(*)::int AS n FROM connection_answers WHERE run_id = $1`, [Number(run.id)])).rows[0]).toEqual({ n: 0 });
  });

  it("an expired answer is gone to its own caller, and the next write purges it", async () => {
    const who = `itest-fold-expired-${suffix}`;
    const { call } = await brainFor(agent(who), github(undefined), { ...FOLD, keepHours: 0 });
    const { handle } = (await call({ connection: "github", tool: "list_issues" })).body.folded;
    expect((await call({ connection: "github", tool: "list_issues", page: `${handle}/1` })).body.error).toEqual({ code: "not_found", message: `no such answer: ${handle}/1` });
    // the next fold's write deletes what has expired
    await call({ connection: "github", tool: "list_issues" });
    expect((await pool.query(`SELECT count(*)::int AS n FROM connection_answers WHERE run_id = $1`, [Number(handle)])).rows[0]).toEqual({ n: 0 });
  });
});
