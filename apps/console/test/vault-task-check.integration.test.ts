// The Tick door (design-build-plan §2.11, T2-4):
// `POST /api/vault-tasks/:task_key/check {checked, seen_text}` writes exactly
// `[x]` and `done <date>` on one line of the owner's note — Undo is the same
// door, the reverse — through the vault bridge as `user`, with the hash of the
// bytes it read. Over real sockets against the scratch database
// (docs/ops/testing.md); the vault is the in-memory one, so every write the
// door makes is visible here byte for byte.
//
// The ticket's own misuse tests, bold in its Tests line: a byte diff shows
// only the two tokens; a changed line is refused; agent and capture tokens are
// refused; a key under `.metistry/` is refused. Plus U2's four.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, sha256Hex, type MemoryVault, type VaultClient, type VaultIntent } from "@foldedspacelabs/metistry-artifacts";
import { mintToken, taskHashKey, taskToday } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-tick";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const DIR = `Journal/itest-tick-${suffix}`;

/** The bytes that differ between two strings: the removed and added runs a reviewer's diff would show. */
function byteDiff(a: string, b: string): { at: number; removed: string; added: string } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { at: s, removed: a.slice(s, ea), added: b.slice(s, eb) };
}

describe.skipIf(!hasDb)("the Tick door: POST /api/vault-tasks/:task_key/check", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let vault: MemoryVault;
  /** What the server writes through: the memory vault, with a hook to move the note between the door's read and its write. */
  let beforeWrite: (() => Promise<void>) | null = null;
  /** Every write the server made through the bridge, with the intent and the hash it claimed to have read. */
  const writes: { path: string; intent: VaultIntent; expected: string | undefined }[] = [];
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-tick-${suffix}`;
  const passkeyIds: string[] = [];
  let n = 0;

  const today = () => taskToday();

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    vault = memoryVault();
    const racing: VaultClient = {
      ...vault,
      read: (p) => vault.read(p),
      write: async (p, c, i, sha) => {
        writes.push({ path: p, intent: i, expected: sha });
        if (beforeWrite) {
          const hook = beforeWrite;
          beforeWrite = null;
          await hook();
        }
        return vault.write(p, c, i, sha);
      },
    };
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-tick-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      vault: racing,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest tick" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1 OR path LIKE '.metistry/itest-tick-%'`, [`${DIR}/%`]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  beforeEach(() => {
    beforeWrite = null;
  });

  /** A note on disk and the walk's row for one line of it — what the index would hold after one pass. */
  async function seed(lines: string[], lineNo: number, taskKey: string, text: string, path = `${DIR}/${++n}.md`): Promise<{ path: string; content: string }> {
    const content = `${lines.join("\n")}\n`;
    await vault.write(path, Buffer.from(content), { principal: "user", message: "seed" });
    await pool.query(
      `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, parsed_on, first_seen_on, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, lower($5), false, current_date, current_date, now())`,
      [path, taskKey, taskKey.startsWith("mt-") ? taskKey : null, lineNo, text],
    );
    return { path, content };
  }

  const bytes = async (path: string) => (await vault.read(path))!.content.toString("utf8");

  async function tick(taskKey: string, body: Record<string, unknown>, headers: Record<string, string> = { authorization: `Bearer ${localOwnerToken}` }) {
    const r = await fetch(`${base}/api/vault-tasks/${encodeURIComponent(taskKey)}/check`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any>, replayed: r.headers.get("idempotency-replayed") };
  }

  // ---- U2: the four --------------------------------------------------------------------------

  describe("who may tick (U2)", () => {
    it("no credential is the uniform 401, and the note is untouched", async () => {
      const { path, content } = await seed(["# Day", "- [ ] Call the dentist ^mt-u2none00"], 2, "mt-u2none00", "Call the dentist");
      const r = await tick("mt-u2none00", { checked: true, seen_text: "Call the dentist" }, {});
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      expect(await bytes(path)).toBe(content);
    });

    it("an agent bearer is refused 403 with the canonical answer, and the note is untouched", async () => {
      const { path, content } = await seed(["- [ ] Call the dentist ^mt-u2agent0"], 1, "mt-u2agent0", "Call the dentist");
      const r = await tick("mt-u2agent0", { checked: true, seen_text: "Call the dentist" }, { authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(await bytes(path)).toBe(content);
    });

    it("the capture owner token is refused 403 — capture is its whole reach — and the note is untouched", async () => {
      const { path, content } = await seed(["- [ ] Call the dentist ^mt-u2capt00"], 1, "mt-u2capt00", "Call the dentist");
      const r = await tick("mt-u2capt00", { checked: true, seen_text: "Call the dentist" }, { authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(await bytes(path)).toBe(content);
    });

    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      const a = await seed(["- [ ] Call the dentist ^mt-u2local0"], 1, "mt-u2local0", "Call the dentist");
      expect((await tick("mt-u2local0", { checked: true, seen_text: "Call the dentist" })).status).toBe(200);
      expect(await bytes(a.path)).toBe(`- [x] Call the dentist done ${today()} ^mt-u2local0\n`);
      const b = await seed(["- [ ] Call the dentist ^mt-u2sess00"], 1, "mt-u2sess00", "Call the dentist");
      expect((await tick("mt-u2sess00", { checked: true, seen_text: "Call the dentist" }, { cookie: sessionCookie })).status).toBe(200);
      expect(await bytes(b.path)).toBe(`- [x] Call the dentist done ${today()} ^mt-u2sess00\n`);
    });
  });

  // ---- the ticket's own ---------------------------------------------------------------------

  it("a byte diff of the whole note shows only the two tokens: the box and `done <date>`", async () => {
    const lines = [
      "---",
      "area: \"[[Projects/Metistry]]\"",
      "---",
      "# 2026-09-28",
      "",
      "Some prose — with  double  spaces, and a trailing space ",
      "- [ ] Send Dana the fixture format due 2026-09-28 p2 size s ^mt-diff0000",
      "\t- [ ] A nested one",
      "",
    ];
    const { path, content } = await seed(lines, 7, "mt-diff0000", "Send Dana the fixture format");
    const r = await tick("mt-diff0000", { checked: true, seen_text: "Send Dana the fixture format" });
    expect(r.status).toBe(200);
    const after = await bytes(path);
    const box = byteDiff(content, after);
    // first difference: the box on that line, ` ` → `x`
    expect(content.slice(box.at - 3, box.at)).toBe("- [");
    expect(after[box.at]).toBe("x");
    // with the box put back, the only other difference is one inserted ` done <date>` before the anchor
    const unboxed = after.slice(0, box.at) + " " + after.slice(box.at + 1);
    expect(byteDiff(content, unboxed).removed).toBe("");
    expect(unboxed.replace(` done ${today()}`, "")).toBe(content);
    expect(r.body).toEqual({
      ok: true,
      line: `- [x] Send Dana the fixture format due 2026-09-28 p2 size s done ${today()} ^mt-diff0000`,
      task: { path, task_key: "mt-diff0000", anchor: "mt-diff0000", line_no: 7, text: "Send Dana the fixture format", checked: true, done_on: today() },
    });
    // written as the owner's own hand, with the hash of the bytes the door read
    expect(writes.at(-1)).toEqual({ path, intent: { principal: "user", message: 'complete "Send Dana the fixture format"' }, expected: sha256Hex(content) });
  });

  it("a changed line is refused 409 stale with the line as it stands, and nothing is written", async () => {
    const { path, content } = await seed(["- [ ] Call the dentist on Monday ^mt-changed0"], 1, "mt-changed0", "Call the dentist");
    const r = await tick("mt-changed0", { checked: true, seen_text: "Call the dentist" });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("stale");
    expect(r.body.error.code).toBe("conflict");
    expect(r.body.line).toBe("- [ ] Call the dentist on Monday ^mt-changed0");
    expect(r.body.task).toMatchObject({ text: "Call the dentist on Monday", checked: false });
    expect(await bytes(path)).toBe(content);
  });

  it("a line ticked in the note since Today was drawn is 409 stale, not a second `done`", async () => {
    const { path, content } = await seed([`- [x] Call the dentist done 2026-09-27 ^mt-already0`], 1, "mt-already0", "Call the dentist");
    const r = await tick("mt-already0", { checked: true, seen_text: "Call the dentist" });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("stale");
    expect(r.body.line).toBe("- [x] Call the dentist done 2026-09-27 ^mt-already0");
    expect(await bytes(path)).toBe(content);
  });

  it("a line gone from the note is 409 stale with no line", async () => {
    const { path } = await seed(["- [ ] Gone soon ^mt-gone0000"], 1, "mt-gone0000", "Gone soon");
    await vault.write(path, Buffer.from("# nothing here now\n"), { principal: "user", message: "edit" });
    const r = await tick("mt-gone0000", { checked: true, seen_text: "Gone soon" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "stale", line: null, task: null });
  });

  it("a note that moves between the door's read and its write is 409 stale, and the other hand's bytes stand", async () => {
    const { path } = await seed(["- [ ] Race me ^mt-race0000"], 1, "mt-race0000", "Race me");
    const theirs = "- [ ] Race me, edited in Obsidian ^mt-race0000\n";
    beforeWrite = async () => {
      await vault.write(path, Buffer.from(theirs), { principal: "user", message: "obsidian" });
    };
    const r = await tick("mt-race0000", { checked: true, seen_text: "Race me" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "stale", line: "- [ ] Race me, edited in Obsidian ^mt-race0000" });
    expect(await bytes(path)).toBe(theirs);
  });

  it("a key whose row is under `.metistry/` is refused 403 before anything is read or written", async () => {
    const path = `.metistry/itest-tick-${suffix}.md`;
    const { content } = await seed(["- [ ] Rewrite the rules ^mt-protect0"], 1, "mt-protect0", "Rewrite the rules", path);
    const reads: string[] = [];
    const orig = vault.read.bind(vault);
    vault.read = async (p) => {
      reads.push(p);
      return orig(p);
    };
    try {
      const r = await tick("mt-protect0", { checked: true, seen_text: "Rewrite the rules" });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(r.body.error.message).toContain(".metistry/");
      expect(reads).toEqual([]);
    } finally {
      vault.read = orig;
    }
    expect(await bytes(path)).toBe(content);
  });

  it("refuses every other non-note path the index could name the same way: a dot-directory, Artifacts/, the root CLAUDE.md", async () => {
    for (const [i, path] of [`.obsidian/itest-tick-${suffix}.md`, `Artifacts/itest-tick-${suffix}.md`, "CLAUDE.md"].entries()) {
      const key = `mt-otherpa${i}`;
      await pool.query(
        `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, parsed_on, first_seen_on, last_seen_at)
         VALUES ($1, $2, $2, 1, 'x', 'x', false, current_date, current_date, now())`,
        [path, key],
      );
      try {
        expect((await tick(key, { checked: true, seen_text: "x" })).status, path).toBe(403);
      } finally {
        await pool.query(`DELETE FROM vault_tasks WHERE path = $1 AND task_key = $2`, [path, key]);
      }
    }
  });

  // ---- accept: Undo is the same door --------------------------------------------------------

  it("Undo is the same door, the reverse: tick then untick gives back the note byte for byte", async () => {
    const { path, content } = await seed(["# Day", "- [ ] Water the fern @Jim +home size m ^mt-undo0000", "after"], 2, "mt-undo0000", "Water the fern");
    const ticked = await tick("mt-undo0000", { checked: true, seen_text: "Water the fern" });
    expect(ticked.status).toBe(200);
    expect(await bytes(path)).not.toBe(content);
    const undone = await tick("mt-undo0000", { checked: false, seen_text: "Water the fern" });
    expect(undone.status).toBe(200);
    expect(undone.body.task).toMatchObject({ checked: false, done_on: null });
    expect(await bytes(path)).toBe(content);
    // and Undo of a line that is not ticked is stale, like a second tick
    expect((await tick("mt-undo0000", { checked: false, seen_text: "Water the fern" })).status).toBe(409);
  });

  // ---- finding the line ---------------------------------------------------------------------

  it("finds the line by its key when lines were added above it since the walk", async () => {
    const { path } = await seed(["- [ ] Moved ^mt-moved000"], 1, "mt-moved000", "Moved");
    await vault.write(path, Buffer.from("# New heading\n\nprose\n- [ ] Moved ^mt-moved000\n"), { principal: "user", message: "edit" });
    const r = await tick("mt-moved000", { checked: true, seen_text: "Moved" });
    expect(r.status).toBe(200);
    expect(r.body.task.line_no).toBe(4);
    expect(await bytes(path)).toBe(`# New heading\n\nprose\n- [x] Moved done ${today()} ^mt-moved000\n`);
  });

  it("ticks an anchorless line by its hash key, and refuses to guess when the key names two notes", async () => {
    const key = taskHashKey("buy milk", 0);
    const a = await seed(["- [ ] Buy milk"], 1, key, "Buy milk");
    const b = await seed(["- [ ] Buy milk"], 1, key, "Buy milk");
    const ambiguous = await tick(key, { checked: true, seen_text: "Buy milk" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.message).toContain("send path");
    const r = await tick(key, { checked: true, seen_text: "Buy milk", path: b.path });
    expect(r.status).toBe(200);
    expect(await bytes(b.path)).toBe(`- [x] Buy milk done ${today()}\n`);
    expect(await bytes(a.path)).toBe("- [ ] Buy milk\n");
  });

  // ---- Idempotency-Key: the outbox's replay --------------------------------------------------

  it("a replay under the same Idempotency-Key is the first answer, marked, and writes nothing", async () => {
    const { path } = await seed(["- [ ] Replay me ^mt-replay00"], 1, "mt-replay00", "Replay me");
    const headers = { authorization: `Bearer ${localOwnerToken}`, "idempotency-key": `tick-${suffix}-1` };
    const first = await tick("mt-replay00", { checked: true, seen_text: "Replay me" }, headers);
    expect(first.status).toBe(200);
    expect(first.replayed).toBeNull();
    const afterFirst = await bytes(path);
    const second = await tick("mt-replay00", { checked: true, seen_text: "Replay me" }, headers);
    expect(second.status).toBe(200);
    expect(second.replayed).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(await bytes(path)).toBe(afterFirst);
    // the same key for a different request is a caller bug, never a replay
    const reused = await tick("mt-replay00", { checked: false, seen_text: "Replay me" }, headers);
    expect(reused.status).toBe(400);
    // without the key, the same request again is judged against the note: already ticked
    expect((await tick("mt-replay00", { checked: true, seen_text: "Replay me" })).status).toBe(409);
  });

  // ---- the body ------------------------------------------------------------------------------

  it("refuses a malformed request before it looks anything up", async () => {
    expect((await tick("mt-nosuch00", { checked: "yes", seen_text: "x" })).status).toBe(400);
    expect((await tick("mt-nosuch00", { checked: true })).status).toBe(400);
    expect((await tick("mt-nosuch00", { checked: true, seen_text: "x", patch: "- [x] anything" })).body.error.message).toContain("patch");
    expect((await tick("../../etc", { checked: true, seen_text: "x" })).status).toBe(400); // one segment, and not a key
    expect((await tick("not-a-key", { checked: true, seen_text: "x" })).status).toBe(400);
    expect((await tick("mt-nosuch00", { checked: true, seen_text: "x" })).status).toBe(404);
  });

  it("refuses a recurrence rule line — never itself a task — without writing", async () => {
    const { path, content } = await seed(["- [ ] Water the plants every week ^mt-rule0000"], 1, "mt-rule0000", "Water the plants");
    const r = await tick("mt-rule0000", { checked: true, seen_text: "Water the plants" });
    expect(r.status).toBe(400);
    expect(await bytes(path)).toBe(content);
  });

  it("answers 503 when the deployment has no vault bridge", async () => {
    const bare = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir: await mkdtemp(join(tmpdir(), "metistry-tick-bare-")), policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] } });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/vault-tasks/mt-bare0000/check`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${localOwnerToken}` },
        body: JSON.stringify({ checked: true, seen_text: "x" }),
      });
      expect(r.status).toBe(503);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  it("the key lookup is `expose: route`: the capture token asking the generic door gets the unknown-query answer", async () => {
    const r = await fetch(`${base}/api/q/vault_task_by_key?task_key=mt-u2local0`, { headers: { authorization: `Bearer ${ownerToken}` } });
    const unknown = await fetch(`${base}/api/q/no_such_query_${suffix}`, { headers: { authorization: `Bearer ${ownerToken}` } });
    expect(r.status).toBe(unknown.status);
    expect(await r.json()).toEqual(await unknown.json());
  });
});
