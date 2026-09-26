// Reply quality (👍/👎) and the one "Needs You" queue — docs/ops/reply-feedback.md.
//
// Misuse first (invariant 8): rating a reply is a management action, so an
// owner token is refused where a passkey session is not. Then the loop:
// feedback upserts and clears, a blocking `decision` proposal is settled by
// answering in chat OR from triage with one of its own options, and allowing
// an `improvement` proposal writes the prompt overlay through the vault as
// principal `user` — the only path by which the assistant's prompt changes.
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient, type VaultIntent } from "@foldedspacelabs/metistry-artifacts";
import { createHash } from "node:crypto";
import { makeServer } from "../src/server.js";
import { applyImprovement, OVERLAY_PATH } from "../src/prompt-overlay.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const SEED_PROMPT = fileURLToPath(new URL("../../../seed/assistant-prompt.md", import.meta.url));

/** An in-memory vault: enough of the contract for the overlay write, and it records the intent. */
function fakeVault(seed?: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const writes: { path: string; content: string; intent: VaultIntent; expected?: string | undefined }[] = [];
  const client = {
    async read(path: string) {
      const content = files.get(path);
      if (content === undefined) return null;
      return { path, content: Buffer.from(content, "utf8"), sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
    },
    async write(path: string, content: Buffer, intent: VaultIntent, expectedSha256?: string) {
      const text = content.toString("utf8");
      const existing = files.get(path);
      const currentSha = existing === undefined ? "" : createHash("sha256").update(existing).digest("hex");
      if (expectedSha256 !== undefined && expectedSha256 !== currentSha) throw new VaultError("conflict");
      writes.push({ path, content: text, intent, expected: expectedSha256 });
      files.set(path, text);
      return { path, sha256: createHash("sha256").update(text).digest("hex"), bytes: text.length, created: existing === undefined };
    },
    async delete() {
      throw new VaultError("not_available");
    },
    async list() {
      return [];
    },
    async log() {
      return [];
    },
    async diff() {
      return { diff: "", from: "", to: "" };
    },
  } as unknown as VaultClient;
  return { client, files, writes };
}

// what routines/reply-review/run.ts renders into the proposal payload; its own
// shape is asserted there — here it is just the prose that must survive the write
const NOTE = "answered from memory instead of looking";
const SECTION = [
  "## Reply quality — flagged week ending 2026-09-08",
  "",
  "- **2026-09-02 10:00** — they asked: “what is open on drey?”",
  `  their note: “${NOTE}”`,
].join("\n");

describe("applying an improvement proposal (§4.10: suggested, never applied)", () => {
  it("appends the suggested section to an existing overlay, as principal user, compare-and-swap", async () => {
    const v = fakeVault({ [OVERLAY_PATH]: "You are {{name}}.\n" });
    const r = await applyImprovement(v.client, { suggested_edit: { path: OVERLAY_PATH, content: SECTION } }, 42);
    expect(r).toMatchObject({ path: OVERLAY_PATH, created: false });
    const write = v.writes[0]!;
    expect(write.intent.principal).toBe("user"); // invariant 2: a human change, in the user's name
    expect(write.intent.message).toContain("#42");
    expect(write.expected).toBe(createHash("sha256").update("You are {{name}}.\n").digest("hex"));
    expect(write.content.startsWith("You are {{name}}.")).toBe(true); // the base survives
    expect(write.content).toContain("Reply quality — flagged week ending 2026-09-08");
    expect(write.content).toContain(NOTE);
  });

  it("seeds a missing overlay from the shipped seed prompt — never replaces the whole prompt with one section", async () => {
    const v = fakeVault();
    await applyImprovement(v.client, { suggested_edit: { content: "## anything" } }, 1, SEED_PROMPT);
    const write = v.writes[0]!;
    expect(write.expected).toBe(""); // must-not-exist
    expect(write.content).toContain("## Your tools"); // the seed prompt, kept
    expect(write.content.trimEnd().endsWith("## anything")).toBe(true);
  });

  it("refuses a payload with no suggested edit, or one aimed at another path", async () => {
    const v = fakeVault({ [OVERLAY_PATH]: "x" });
    await expect(applyImprovement(v.client, {}, 1)).rejects.toBeInstanceOf(VaultError);
    await expect(applyImprovement(v.client, { suggested_edit: { content: "" } }, 1)).rejects.toBeInstanceOf(VaultError);
    await expect(applyImprovement(v.client, { suggested_edit: { path: "identity.yaml", content: "x" } }, 1)).rejects.toBeInstanceOf(VaultError);
    expect(v.writes).toEqual([]);
  });

  it("with neither an overlay nor a readable seed prompt, refuses rather than guessing", async () => {
    const v = fakeVault();
    await expect(applyImprovement(v.client, { suggested_edit: { content: "x" } }, 1, "/nonexistent/seed.md")).rejects.toMatchObject({ code: "not_available" });
  });
});

describe.skipIf(!hasDb)("reply feedback + Needs You (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  let vault: ReturnType<typeof fakeVault>;
  const thread = `itest-fb-${Date.now()}`;

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const outbound = async (text = "a reply") =>
    (await pool.query(`INSERT INTO outbound_messages (thread, text) VALUES ($1, $2) RETURNING id`, [thread, text])).rows[0].id as number;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    vault = fakeVault({ [OVERLAY_PATH]: "You are {{name}}.\n" });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-fb-${Date.now()}`,
      policy,
      secureCookies: false,
      vault: vault.client,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pkId = `fb-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "fb" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "fb-test");
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent IN ('assistant', 'reply-review') AND payload->>'thread' = $1`, [thread]);
    await pool.query(`DELETE FROM outbound_messages WHERE thread = $1`, [thread]); // before the inbound rows they reference
    await pool.query(`DELETE FROM inbound_messages WHERE thread = $1`, [thread]);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("rating a reply needs a passkey session — an owner token is forbidden, not 404", async () => {
    const id = await outbound();
    const r = await json("POST", `/api/messages/${id}/feedback`, { rating: 1 }, { authorization: `Bearer ${ownerToken}` });
    expect(r.status).toBe(403);
    expect((await json("DELETE", `/api/messages/${id}/feedback`, undefined, { authorization: `Bearer ${ownerToken}` })).status).toBe(403);
    const none = await fetch(`${base}/api/messages/${id}/feedback`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(none.status).toBe(401);
  });

  it("upserts one row per message, carries the note, clears on DELETE, and logs a runs row each time", async () => {
    const id = await outbound("the reply under test");
    expect((await json("POST", `/api/messages/${id}/feedback`, { rating: 1 })).status).toBe(200);
    // second rating replaces the first — one judgement per message
    const down = await json("POST", `/api/messages/${id}/feedback`, { rating: -1, note: "  guessed instead of looking  " });
    expect(down.status).toBe(200);
    expect((await down.json()).feedback).toMatchObject({ rating: -1, note: "guessed instead of looking" });
    const rows = await pool.query(`SELECT rating, note FROM reply_feedback WHERE outbound_message_id = $1`, [id]);
    expect(rows.rows).toEqual([{ rating: -1, note: "guessed instead of looking" }]);

    // the message row itself is untouched
    const msg = await pool.query(`SELECT text FROM outbound_messages WHERE id = $1`, [id]);
    expect(msg.rows[0].text).toBe("the reply under test");

    // GET /api/messages carries it back on the outbound row
    const list = await (await json("GET", "/api/messages?limit=100")).json();
    expect(list.messages.find((m: any) => m.direction === "out" && m.id === id).feedback).toMatchObject({ rating: -1 });

    expect((await json("DELETE", `/api/messages/${id}/feedback`)).status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM reply_feedback WHERE outbound_message_id = $1`, [id])).rows).toEqual([]);

    const runs = await pool.query(
      `SELECT tool FROM runs WHERE component = 'console' AND kind = 'feedback' AND (meta->>'message_id')::bigint = $1 ORDER BY id`,
      [id],
    );
    expect(runs.rows.map((r: any) => r.tool)).toEqual(["up", "down", "clear"]);
  });

  it("refuses a rating that is not ±1, a non-string note, and an unknown message", async () => {
    const id = await outbound();
    for (const body of [{}, { rating: 0 }, { rating: 5 }, { rating: "1" }, { rating: 1, note: { a: 1 } }]) {
      expect((await json("POST", `/api/messages/${id}/feedback`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await json("POST", `/api/messages/999999999/feedback`, { rating: 1 })).status).toBe(404);
  });

  it("a blocking question is a proposals row, and answering in chat settles it", async () => {
    const msgId = await outbound("here are the options");
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'assistant', 'internal', $1) RETURNING id`,
      [JSON.stringify({ title: "Which repo?", options: ["metistry", "metistry-instance"], message_id: msgId, thread })],
    );
    const id = rows[0].id;
    // it shows up in the ONE queue
    const queue = await (await json("GET", "/api/proposals")).json();
    expect(queue.proposals.some((p: any) => p.id === id && p.kind === "decision")).toBe(true);

    expect((await json("POST", "/message", { thread_id: thread, text: "metistry, obviously" })).status).toBe(202);
    const after = await pool.query(`SELECT decision, feedback FROM proposals WHERE id = $1`, [id]);
    expect(after.rows[0]).toMatchObject({ decision: "answered", feedback: "metistry, obviously" });
  });

  it("or is answered from triage with one of its OWN options — anything else is refused", async () => {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'assistant', 'internal', $1) RETURNING id`,
      [JSON.stringify({ title: "Ship it?", options: ["ship", "wait"], thread: `${thread}-triage` })],
    );
    const id = rows[0].id;
    expect((await json("POST", `/api/proposals/${id}`, { decision: "allow" })).status).toBe(400); // not one of its options
    expect((await json("POST", `/api/proposals/${id}`, { decision: "ship" })).status).toBe(200);
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [id])).rows[0].decision).toBe("ship");
  });

  it("allowing an improvement writes the prompt overlay through the vault as `user`", async () => {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('improvement', 'reply-review', 'internal', $1) RETURNING id`,
      [JSON.stringify({ title: "Reply quality", thread, suggested_edit: { path: OVERLAY_PATH, content: SECTION } })],
    );
    const id = rows[0].id;
    const before = vault.writes.length;
    const r = await json("POST", `/api/proposals/${id}`, { decision: "allow" });
    expect(r.status).toBe(200);
    expect((await r.json()).applied).toMatchObject({ path: OVERLAY_PATH });
    expect(vault.writes.length).toBe(before + 1);
    const write = vault.writes.at(-1)!;
    expect(write.intent.principal).toBe("user");
    expect(write.content).toContain("You are {{name}}."); // base kept
    expect(write.content).toContain("Reply quality — flagged week ending 2026-09-08");
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [id])).rows[0].decision).toBe("allow");
  });

  it("the reply_feedback_summary seed query counts by day and carries the flagged turn", async () => {
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    const inId = (await pool.query(`INSERT INTO inbound_messages (thread, text, status) VALUES ($1, 'summary prompt', 'done') RETURNING id`, [thread])).rows[0].id;
    const outId = (await pool.query(`INSERT INTO outbound_messages (thread, text, in_reply_to) VALUES ($1, 'summary reply', $2) RETURNING id`, [thread, inId])).rows[0].id;
    await pool.query(
      `INSERT INTO runs (component, kind, model, ok, meta) VALUES ('assistant', 'turn', 'haiku', true, $1)`,
      [JSON.stringify({ message_id: inId, tools_used: { mcp__brain__capture: 1 } })],
    );
    await json("POST", `/api/messages/${outId}/feedback`, { rating: -1, note: "missed the obvious source" });
    const good = await outbound("a good one");
    await json("POST", `/api/messages/${good}/feedback`, { rating: 1 });

    const { rows } = await queries.run("reply_feedback_summary", { days: 1, limit: 50 });
    const today = rows.filter((r: any) => r.row_kind === "day");
    expect(Number(today.at(-1)!.rated)).toBeGreaterThanOrEqual(2);
    const flagged = rows.find((r: any) => r.row_kind === "flagged" && Number(r.outbound_id) === Number(outId)) as any;
    expect(flagged).toMatchObject({ note: "missed the obvious source", prompt: "summary prompt", reply: "summary reply", model: "haiku" });
    expect(flagged.tools_used).toEqual({ mcp__brain__capture: 1 });
    // a 👍 never appears among the flagged rows
    expect(rows.some((r: any) => r.row_kind === "flagged" && Number(r.outbound_id) === Number(good))).toBe(false);
    await pool.query(`DELETE FROM runs WHERE kind = 'turn' AND (meta->>'message_id')::bigint = $1`, [inId]);
  });

  it("denying an improvement changes nothing on disk", async () => {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('improvement', 'reply-review', 'internal', $1) RETURNING id`,
      [JSON.stringify({ title: "Reply quality", thread, suggested_edit: { path: OVERLAY_PATH, content: "## never applied" } })],
    );
    const before = vault.writes.length;
    expect((await json("POST", `/api/proposals/${rows[0].id}`, { decision: "deny", feedback: "not the problem" })).status).toBe(200);
    expect(vault.writes.length).toBe(before);
  });
});
