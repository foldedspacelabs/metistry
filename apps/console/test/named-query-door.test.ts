// `GET /api/q/<name>` — the generic door onto invariant 3's read path, and
// what it will NOT open.
//
// The page list is filtered by the caller's scope on its own route
// (`GET /api/knowledge/pages`): every path through `canSee`, dropped rather
// than flagged. For as long as the same rows were also addressable by name
// here, that filter was optional — a client (or a narrower principal, the day
// one is minted) had a second way to the same index with nothing in front of
// it. One endpoint per necessary operation (ruled 2026-09-19), so a query
// whose manifest says `expose: route` is not served here.
//
// The refusal has to be the UNKNOWN-QUERY refusal exactly: same code, same
// status, same absent message. A distinguishable 403 would turn this door
// into an oracle for which route-only queries a build has — the same reason
// `/api/knowledge/page` answers 404 for a path it will not show (invariant 8).
import { readFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { QueryStore, type SqlExecutor } from "@foldedspacelabs/metistry-queries";
import { namedQueryDoor } from "../src/server.js";
import type { Auth } from "../src/auth-store.js";

const GENERIC = `
name: open_work_like
description: a query with no endpoint of its own
params:
  limit: { type: int, default: 20 }
sql: SELECT id FROM work LIMIT :limit
`;

/** A real ServerResponse over a detached socket — the harness refusals.test.ts uses, so the actual writeHead/end path runs. */
function capture(): { res: ServerResponse; read: () => { status: number; body: any } } {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  (res as unknown as { _send: unknown })._send = () => true;
  res.write = ((c: string | Buffer) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return true;
  }) as ServerResponse["write"];
  res.end = ((c?: string | Buffer) => {
    if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return res;
  }) as ServerResponse["end"];
  return { res, read: () => ({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }) };
}

/** The shipped `knowledge_pages.yaml` beside a generic query, over an executor that counts what was actually run. */
async function store(): Promise<{ store: QueryStore; ran: string[] }> {
  const ran: string[] = [];
  const executor: SqlExecutor = {
    async query(text) {
      ran.push(text);
      return { rows: [{ path: "Areas/Health/sleep.md" }] };
    },
  };
  const s = new QueryStore(executor, () => 0);
  s.load(GENERIC);
  s.load(await readFile(new URL("../../../seed/queries/knowledge_pages.yaml", import.meta.url), "utf8"));
  return { store: s, ran };
}

async function door(s: QueryStore, name: string, params: Record<string, string> = {}, auth: Auth = null) {
  const c = capture();
  await namedQueryDoor(c.res, s, name, params, auth);
  return c.read();
}

/**
 * The owner, as this door authenticates them: a passkey session. The local
 * owner token is the same principal by `isUser`, which is the whole point of
 * that predicate — so one of them here is both of them.
 */
const OWNER = { kind: "session", session: { id: 1 } } as unknown as Auth;

describe("namedQueryDoor: one endpoint per operation", () => {
  it("serves a query whose manifest leaves it generic", async () => {
    const { store: s, ran } = await store();
    const r = await door(s, "open_work_like", { limit: "5" });
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([{ path: "Areas/Health/sleep.md" }]);
    expect(r.body.as_of).toEqual(expect.any(String));
    expect(ran.length).toBe(1);
  });

  // The seed manifest itself, not a fixture shaped like it: the file that
  // ships is the file that has to carry `expose: route`.
  it("refuses the shipped knowledge_pages — and the refusal is the unknown-query refusal, byte for byte", async () => {
    const { store: s, ran } = await store();
    expect(s.exposure("knowledge_pages")).toBe("route");
    const refused = await door(s, "knowledge_pages");
    const unknown = await door(s, "no_such_query_at_all");
    expect(refused.status).toBe(404);
    expect(refused).toEqual(unknown);
    expect(refused.body).toEqual({ error: { code: "not_found", message: "not found" } });
    // Nothing in the answer names the query, the route that does serve it, or
    // the reason — and the SQL never ran, so a refusal costs the cluster
    // nothing either.
    expect(JSON.stringify(refused.body)).not.toContain("knowledge_pages");
    expect(JSON.stringify(refused.body)).not.toContain("expose");
    expect(ran).toEqual([]);
  });

  /**
   * P4 (§2.6, and the owner's ruling "the owner should always have access to
   * everything"): the rule `expose: route` protects is a filter on what an
   * AGENT may see of the vault. The owner's scope is the whole vault, so the
   * scoped route and this one return them the same rows, and the refusal was
   * only ever a second door to remember.
   *
   * Every other credential is unchanged, byte for byte — including the
   * capture `owner_token`, which is the plan's tier 0 and not the owner.
   */
  it("serves it to the owner, and to nobody else — the refusal is unchanged for every other credential", async () => {
    const { store: s, ran } = await store();
    const served = await door(s, "knowledge_pages", {}, OWNER);
    expect(served.status).toBe(200);
    expect(served.body.rows).toEqual([{ path: "Areas/Health/sleep.md" }]);
    expect(ran.length).toBe(1);

    const captureToken = { kind: "owner_token", token: { id: 1 } } as unknown as Auth;
    for (const auth of [null, captureToken]) {
      const refused = await door(s, "knowledge_pages", {}, auth);
      expect(refused, String(auth === null ? "no credential" : "capture token")).toEqual(await door(s, "no_such_query_at_all", {}, auth));
      expect(refused.body).toEqual({ error: { code: "not_found", message: "not found" } });
      expect(JSON.stringify(refused.body)).not.toContain("reason"); // a hidden refusal says nothing about itself
    }
    expect(ran.length).toBe(1); // and none of those ran any SQL
  });

  it("refuses it however the caller dresses the name up", async () => {
    const { store: s, ran } = await store();
    for (const name of ["knowledge_pages", "knowledge_pages?", "KNOWLEDGE_PAGES", "knowledge_pages ", "", "..", "knowledge_pages/"]) {
      const r = await door(s, name, { limit: "1" });
      expect(r.status, JSON.stringify(name)).toBe(404);
      expect(r.body.error.code, JSON.stringify(name)).toBe("not_found");
    }
    expect(ran).toEqual([]);
  });

  // A param mistake on a query this door does serve is still the caller's
  // 400, naming nothing it should not: the closed door changes one answer
  // and leaves the rest of the contract where it was.
  it("still refuses a bad param on a generic query as a 400", async () => {
    const { store: s } = await store();
    expect((await door(s, "open_work_like", { limit: "ten" })).status).toBe(400);
    expect((await door(s, "open_work_like", { nope: "1" })).status).toBe(400);
  });
});
