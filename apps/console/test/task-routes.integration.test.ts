// The board's drags, end to end (docs/ops/board.md "Drags"). One test per
// drop the panel offers, against a live server and the scratch database: the
// route, the row it leaves behind, the `runs` audit row, and — invariant 8 —
// the misuse tests that ship with the interface. Every refusal must name what
// would permit it (R3), so the messages are asserted, not just the codes.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const P = "itest-drags";

describe.skipIf(!hasDb)("task routes — the board's drags (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let session: string;
  let ownerToken: string;
  let agentToken: string;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await pool.query(`DELETE FROM work WHERE project = $1`, [P]);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `drags-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "drags-test" });
    session = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "drags-test");
    agentToken = (await agents.createAgent(pool, { id: `drag-agent-${mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`, display_name: "drag agent" })).token;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  async function newTask(title: string, cols = "", vals: unknown[] = []): Promise<number> {
    const extra = cols ? `, ${cols}` : "";
    const ph = vals.map((_, i) => `, $${i + 2}`).join("");
    const { rows } = await pool.query(
      `INSERT INTO work (title, project, kind, status, created_by${extra}) VALUES ($1, '${P}', 'task', 'open', 'user'${ph}) RETURNING id`,
      [title, ...vals],
    );
    return Number(rows[0].id);
  }
  const row = async (id: number) =>
    (await pool.query(`SELECT status, owner, claimed_by, title, project, history FROM work WHERE id = $1`, [id])).rows[0] as {
      status: string;
      owner: string | null;
      claimed_by: string | null;
      title: string;
      project: string | null;
      history: { op: string; agent: string; note?: string; owner?: string | null }[];
    };
  const send = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const asUser = (method: string, path: string, body?: unknown) => send(method, path, body, { cookie: session });
  const auditFor = async (id: number, op: string) =>
    (await pool.query(`SELECT ok, meta FROM runs WHERE component = 'console' AND kind = 'task_admin' AND meta->>'task' = $1 AND meta->>'op' = $2 ORDER BY id DESC LIMIT 1`, [String(id), op]))
      .rows[0] as { ok: boolean; meta: Record<string, unknown> } | undefined;

  // ----- misuse (invariant 8): the user's hand only, and no existence leak -----

  it("no credential → 401; an owner token or an agent token → 403 on every task route", async () => {
    const id = await newTask("guarded");
    const paths: [string, string][] = [
      ["PATCH", `/api/tasks/${id}`],
      ["POST", `/api/tasks/${id}/claim`],
      ["POST", `/api/tasks/${id}/release`],
      ["POST", `/api/tasks/${id}/renew`],
    ];
    for (const [method, path] of paths) {
      expect((await send(method, path, { note: "x" }, {})).status, path).toBe(401);
      expect((await send(method, path, { note: "x" }, { authorization: `Bearer ${ownerToken}` })).status, path).toBe(403);
      expect((await send(method, path, { note: "x" }, { authorization: `Bearer ${agentToken}` })).status, path).toBe(403);
    }
    // the row is untouched, and a 403 never says whether it exists: a task
    // that does NOT exist answers exactly the same way
    expect((await row(id)).status).toBe("open");
    const ghost = await send("PATCH", `/api/tasks/999999999/`.replace(/\/$/, ""), { owner: "x" }, { authorization: `Bearer ${ownerToken}` });
    expect(ghost.status).toBe(403);
  });

  it("validates before it acts: unknown fields, an empty patch and a bad status are named, not ignored", async () => {
    const id = await newTask("validated");
    const cases: [unknown, RegExp][] = [
      [{ assignee: "helper-a" }, /unknown field\(s\) assignee/],
      [{}, /at least one of status, owner, project, title/],
      [{ status: "ready" }, /status must be one of open, in_progress, blocked, closed/],
      [{ owner: 7 }, /owner must be a string/],
      [{ title: "  " }, /title must be a non-empty string/],
      [{ status: "closed", owner: "helper-a" }, /status: closed is claim-gated and owner is not/],
    ];
    for (const [body, msg] of cases) {
      const res = await asUser("PATCH", `/api/tasks/${id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.message, JSON.stringify(body)).toMatch(msg);
    }
    expect((await row(id)).status).toBe("open");
  });

  // ----- one test per drop the panel offers -----

  it("backlog → assigned: PATCH owner, on a row nobody holds; and assigned → backlog clears it", async () => {
    const id = await newTask("to assign");
    const res = await asUser("PATCH", `/api/tasks/${id}`, { owner: "helper-a" });
    expect(res.status).toBe(200);
    expect((await res.json()).task).toMatchObject({ owner: "helper-a", status: "open" }); // Assigned = open + owner
    expect((await row(id)).history.at(-1)).toMatchObject({ agent: "user", op: "update", owner: "helper-a" });
    expect(await auditFor(id, "patch")).toMatchObject({ ok: true, meta: { owner: "helper-a", fields: ["owner"] } });

    expect((await asUser("PATCH", `/api/tasks/${id}`, { owner: null })).status).toBe(200);
    expect((await row(id)).owner).toBeNull();
  });

  it("→ in_progress: claim as the user, and a second drop onto the same card is refused by name", async () => {
    const id = await newTask("to claim");
    const res = await asUser("POST", `/api/tasks/${id}/claim`, {});
    expect(res.status).toBe(200);
    expect((await row(id))).toMatchObject({ status: "in_progress", claimed_by: "user" });
    expect(await auditFor(id, "claim")).toMatchObject({ ok: true });

    // a crew takes it over after the user hands it back — now the user's drop loses
    expect((await asUser("POST", `/api/tasks/${id}/release`, {})).status).toBe(200);
    await pool.query(`UPDATE work SET status = 'in_progress', claimed_by = 'helper-a', lease_expires_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    const again = await asUser("POST", `/api/tasks/${id}/claim`, {});
    expect(again.status).toBe(409);
    expect((await again.json()).error.message).toMatch(/is held by helper-a .* release/);
    expect(await auditFor(id, "claim")).toMatchObject({ ok: false, meta: { refused: "claimed" } });
  });

  it("in_progress → assigned/backlog: release, and a card the user does not hold refuses with the holder named", async () => {
    const id = await newTask("to release", "owner", ["helper-a"]);
    expect((await asUser("POST", `/api/tasks/${id}/claim`, {})).status).toBe(200);
    const res = await asUser("POST", `/api/tasks/${id}/release`, { note: "not mine after all" });
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "open", claimed_by: null, owner: "helper-a" }); // owner survives: it lands back in Assigned
    expect((await row(id)).history.at(-1)).toMatchObject({ op: "release", agent: "user", note: "not mine after all" });

    await pool.query(`UPDATE work SET status = 'in_progress', claimed_by = 'helper-a', lease_expires_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    const refused = await asUser("POST", `/api/tasks/${id}/release`, {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toMatch(/held by helper-a, not by user .* claim it first/);
  });

  it("needs_you → backlog: PATCH status open is the unblock — it works on a row a crew still holds, and refuses on a row that is not blocked", async () => {
    const id = await newTask("stuck");
    await pool.query(`UPDATE work SET status = 'blocked', claimed_by = 'helper-a', lease_expires_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    const res = await asUser("PATCH", `/api/tasks/${id}`, { status: "open" });
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "open", claimed_by: null }); // handed back the way release does

    const refused = await asUser("PATCH", `/api/tasks/${id}`, { status: "open" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toMatch(/is open, not blocked — status "open" is the unblock/);
    expect(await auditFor(id, "patch")).toMatchObject({ ok: false, meta: { refused: "not_blocked" } });
  });

  it("→ done: PATCH status closed only from the current status the service allows — the holder's, and the refusal says so", async () => {
    const id = await newTask("to close");
    // the board offers the drop from every open column; the SERVICE decides
    const early = await asUser("PATCH", `/api/tasks/${id}`, { status: "closed" });
    expect(early.status).toBe(409);
    expect((await early.json()).error.message).toMatch(/held by nobody, not by user .* claim it first/);

    expect((await asUser("POST", `/api/tasks/${id}/claim`, {})).status).toBe(200);
    expect((await asUser("PATCH", `/api/tasks/${id}`, { status: "closed" })).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "closed", claimed_by: null });

    // done/reported are terminal: a closed card is not draggable, and the route agrees
    const after = await asUser("PATCH", `/api/tasks/${id}`, { owner: "helper-a" });
    expect(after.status).toBe(409);
    expect((await after.json()).error.message).toMatch(/is closed — a closed row takes no further change here/);
  });

  it("renew carries a note onto history; a lapsed lease is refused with the route that would fix it", async () => {
    const id = await newTask("long job");
    expect((await asUser("POST", `/api/tasks/${id}/claim`, { lease_seconds: 3600 })).status).toBe(200);
    const before = (await row(id)).history.length;
    expect((await asUser("POST", `/api/tasks/${id}/renew`, {})).status).toBe(200);
    expect((await row(id)).history).toHaveLength(before); // a silent renew stays silent
    expect((await asUser("POST", `/api/tasks/${id}/renew`, { note: "still reading the diff" })).status).toBe(200);
    expect((await row(id)).history.at(-1)).toMatchObject({ op: "heartbeat", agent: "user", note: "still reading the diff" });

    await pool.query(`UPDATE work SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    const lapsed = await asUser("POST", `/api/tasks/${id}/renew`, {});
    expect(lapsed.status).toBe(409);
    expect((await lapsed.json()).error.message).toMatch(/has lapsed — claim it again/);
  });

  it("a collected row is never the board's to move — github-state owns what an issue says", async () => {
    const { rows } = await pool.query(
      `INSERT INTO work (title, project, kind, status, external_ref) VALUES ('an issue', $1, 'issue', 'open', $2) RETURNING id`,
      [P, `gh:itest/drags#${Date.now() % 100000}`],
    );
    const id = Number(rows[0].id);
    const res = await asUser("PATCH", `/api/tasks/${id}`, { owner: "helper-a" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/kind "issue" — a row a collector reconciles/);
    expect((await row(id)).owner).toBeNull();
  });

  it("a task that does not exist is a 404 to the user, never a silent success", async () => {
    const res = await asUser("PATCH", `/api/tasks/999999999`, { owner: "helper-a" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/task 999999999 does not exist/);
  });
});
