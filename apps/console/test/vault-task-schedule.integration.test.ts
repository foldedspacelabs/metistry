// The Defer door (design-build-plan §2.11, T2-5; owner ruling K6):
// `POST /api/vault-tasks/:task_key/schedule {do | someday, seen_text}` writes
// one `do <date>` or one `someday` on one line of the owner's note — the
// spelling `formatTaskLine` emits — through the vault bridge as `user`, with
// the hash of the bytes it read. Over real sockets against the scratch
// database (docs/ops/testing.md); the vault is the in-memory one, so every
// write the door makes is visible here byte for byte.
//
// The ticket's own: 409; round-trips through the parser; **no emoji is ever
// written**. Plus U2's four, and the refusals the Tick door's tests hold it to
// (a key under `.metistry/`, a changed line), since this is the same door.
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, sha256Hex, type MemoryVault, type VaultClient, type VaultIntent } from "@foldedspacelabs/metistry-artifacts";
import { mintToken, parseTaskLine, taskHashKey } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-defer";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const DIR = `Journal/itest-defer-${suffix}`;
const DAY = "2026-10-02";

/** The bytes that differ between two strings: the removed and added runs a reviewer's diff would show. */
function byteDiff(a: string, b: string): { removed: string; added: string } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { removed: a.slice(s, ea), added: b.slice(s, eb) };
}

const emoji = (s: string): string[] => [...s].filter((c) => /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u{FE0F}/u.test(c));

describe.skipIf(!hasDb)("the Defer door: POST /api/vault-tasks/:task_key/schedule", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let vault: MemoryVault;
  let beforeWrite: (() => Promise<void>) | null = null;
  const writes: { path: string; intent: VaultIntent; expected: string | undefined; content: string }[] = [];
  const audits: { kind: string; tool: string; ok: boolean; meta: Record<string, unknown> }[] = [];
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-defer-${suffix}`;
  const passkeyIds: string[] = [];
  const inboxDirs: string[] = [];
  let n = 0;
  const inbox = async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-defer-"));
    inboxDirs.push(dir);
    return dir;
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    vault = memoryVault();
    const racing: VaultClient = {
      ...vault,
      read: (p) => vault.read(p),
      write: async (p, c, i, sha) => {
        writes.push({ path: p, intent: i, expected: sha, content: c.toString("utf8") });
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
      inboxDir: await inbox(),
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
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest defer" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1 OR path LIKE '.metistry/itest-defer-%'`, [`${DIR}/%`]);
    await pool.query(`DELETE FROM runs WHERE kind = 'vault_task' AND meta->>'task_key' LIKE 'mt-d%'`).catch(() => undefined);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    for (const dir of inboxDirs) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    beforeWrite = null;
    audits.length = 0;
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

  async function defer(taskKey: string, body: Record<string, unknown>, headers: Record<string, string> = { authorization: `Bearer ${localOwnerToken}` }) {
    const r = await fetch(`${base}/api/vault-tasks/${encodeURIComponent(taskKey)}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any>, replayed: r.headers.get("idempotency-replayed") };
  }

  // ---- U2: the four --------------------------------------------------------------------------

  describe("who may defer (U2)", () => {
    it("no credential is the uniform 401, and the note is untouched", async () => {
      const { path, content } = await seed(["# Day", "- [ ] Call the dentist ^mt-du2none0"], 2, "mt-du2none0", "Call the dentist");
      const r = await defer("mt-du2none0", { do: DAY, seen_text: "Call the dentist" }, {});
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      expect(await bytes(path)).toBe(content);
    });

    it("an agent bearer is refused 403 with the canonical answer, and the note is untouched", async () => {
      const { path, content } = await seed(["- [ ] Call the dentist ^mt-du2agent"], 1, "mt-du2agent", "Call the dentist");
      const r = await defer("mt-du2agent", { someday: true, seen_text: "Call the dentist" }, { authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(await bytes(path)).toBe(content);
    });

    it("the capture owner token is refused 403 — capture is its whole reach — and the note is untouched", async () => {
      const { path, content } = await seed(["- [ ] Call the dentist ^mt-du2capt0"], 1, "mt-du2capt0", "Call the dentist");
      const r = await defer("mt-du2capt0", { do: DAY, seen_text: "Call the dentist" }, { authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(await bytes(path)).toBe(content);
    });

    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      const a = await seed(["- [ ] Call the dentist ^mt-du2local"], 1, "mt-du2local", "Call the dentist");
      expect((await defer("mt-du2local", { do: DAY, seen_text: "Call the dentist" })).status).toBe(200);
      expect(await bytes(a.path)).toBe(`- [ ] Call the dentist do ${DAY} ^mt-du2local\n`);
      const b = await seed(["- [ ] Call the dentist ^mt-du2sess0"], 1, "mt-du2sess0", "Call the dentist");
      expect((await defer("mt-du2sess0", { someday: true, seen_text: "Call the dentist" }, { cookie: sessionCookie })).status).toBe(200);
      expect(await bytes(b.path)).toBe("- [ ] Call the dentist someday ^mt-du2sess0\n");
    });
  });

  // ---- the ticket's own ---------------------------------------------------------------------

  it("a byte diff of the whole note shows only `do <date>`, written as `user` with the read's hash", async () => {
    const lines = [
      "---",
      "area: \"[[Projects/Metistry]]\"",
      "---",
      "# 2026-09-28",
      "",
      "Some prose — with  double  spaces, and a trailing space ",
      "- [ ] Send Dana the fixture format due 2026-09-28 p2 size s ^mt-ddiff000",
      "\t- [ ] A nested one",
      "",
    ];
    const { path, content } = await seed(lines, 7, "mt-ddiff000", "Send Dana the fixture format");
    const r = await defer("mt-ddiff000", { do: DAY, seen_text: "Send Dana the fixture format" });
    expect(r.status).toBe(200);
    const after = await bytes(path);
    // nothing removed, and taking one ` do <date>` out gives back the note byte for byte
    expect(byteDiff(content, after).removed).toBe("");
    expect(byteDiff(content, after).added.trim()).toBe(`do ${DAY}`);
    expect(after.replace(` do ${DAY}`, "")).toBe(content);
    expect(r.body).toEqual({
      ok: true,
      line: `- [ ] Send Dana the fixture format due 2026-09-28 p2 size s do ${DAY} ^mt-ddiff000`,
      task: { path, task_key: "mt-ddiff000", anchor: "mt-ddiff000", line_no: 7, text: "Send Dana the fixture format", checked: false, due: "2026-09-28", scheduled_for: DAY, someday: false },
    });
    expect(writes.at(-1)).toMatchObject({ path, intent: { principal: "user", message: `defer "Send Dana the fixture format" to ${DAY}` }, expected: sha256Hex(content) });
    // audited: the key, what was asked, the outcome — never the path or the text
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'vault_task' AND meta->>'task_key' = 'mt-ddiff000' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ ok: true, meta: expect.objectContaining({ task_key: "mt-ddiff000", deferral: "do", outcome: "do" }) });
    expect(JSON.stringify(rows[0].meta)).not.toContain("Send Dana");
  });

  it("round-trips through the parser: to a day, to someday, and back to a day, the line reads as the same task every time", async () => {
    const original = "- [ ] Water the fern @Jim +home size m do 2026-09-29 ^mt-dround0";
    const { path } = await seed(["# Day", original, "after"], 2, "mt-dround0", "Water the fern");
    const before = parseTaskLine(original)!;
    for (const [body, scheduled, someday] of [
      [{ someday: true }, null, true],
      [{ do: DAY }, DAY, false],
      [{ do: "2026-10-09" }, "2026-10-09", false],
      [{ someday: true }, null, true],
    ] as const) {
      const r = await defer("mt-dround0", { ...body, seen_text: "Water the fern" });
      expect(r.status, JSON.stringify(body)).toBe(200);
      const written = (await bytes(path)).split("\n")[1]!;
      expect(r.body.line).toBe(written);
      const after = parseTaskLine(written)!;
      expect({ ...after, scheduled_for: null, someday: false }).toEqual({ ...before, scheduled_for: null, someday: false });
      expect(after.scheduled_for).toBe(scheduled);
      expect(after.someday).toBe(someday);
      expect(r.body.task).toMatchObject({ scheduled_for: scheduled, someday });
    }
    expect(await bytes(path)).toBe("# Day\n- [ ] Water the fern @Jim +home size m someday ^mt-dround0\nafter\n");
  });

  it("no emoji is ever written: every write's added bytes are ASCII, and a `⏳` line is refused rather than written beside", async () => {
    const plain = await seed(["- [ ] 🎉 Plan the party 📅 2026-10-10 ^mt-demoji0"], 1, "mt-demoji0", "🎉 Plan the party");
    for (const body of [{ do: DAY }, { someday: true }, { do: "2026-10-05" }]) {
      const before = await bytes(plain.path);
      const r = await defer("mt-demoji0", { ...body, seen_text: "🎉 Plan the party" });
      expect(r.status, JSON.stringify(body)).toBe(200);
      const after = await bytes(plain.path);
      expect(emoji(after)).toEqual(emoji(before)); // the owner's glyphs stay; none is added
      const d = byteDiff(before, after);
      expect(/^[\x20-\x7e]*$/.test(d.added), JSON.stringify(d)).toBe(true);
    }
    for (const w of writes) expect(emoji(w.content).every((c) => ["🎉", "📅"].includes(c)), w.content).toBe(true);

    const hourglass = await seed(["- [ ] Pay rent ⏳ 2026-09-30 ^mt-dhourgl0"], 1, "mt-dhourgl0", "Pay rent");
    const count = writes.length;
    const r = await defer("mt-dhourgl0", { do: DAY, seen_text: "Pay rent" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("⏳");
    expect(writes.length).toBe(count);
    expect(await bytes(hourglass.path)).toBe(hourglass.content);
  });

  describe("409 stale, with the line as it stands, and nothing written", () => {
    it("the text changed", async () => {
      const { path, content } = await seed(["- [ ] Call the dentist on Monday ^mt-dchange0"], 1, "mt-dchange0", "Call the dentist");
      const r = await defer("mt-dchange0", { do: DAY, seen_text: "Call the dentist" });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: { code: "conflict" }, reason: "stale", line: "- [ ] Call the dentist on Monday ^mt-dchange0" });
      expect(r.body.task).toMatchObject({ text: "Call the dentist on Monday", scheduled_for: null, someday: false });
      expect(await bytes(path)).toBe(content);
    });

    it("ticked in the note since Today was drawn — done, not waiting for a day", async () => {
      const { path, content } = await seed(["- [x] Call the dentist done 2026-09-27 ^mt-dticked0"], 1, "mt-dticked0", "Call the dentist");
      const r = await defer("mt-dticked0", { do: DAY, seen_text: "Call the dentist" });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: "stale", line: "- [x] Call the dentist done 2026-09-27 ^mt-dticked0" });
      expect(await bytes(path)).toBe(content);
    });

    it("dropped in the note", async () => {
      const { path, content } = await seed(["- [-] Call the dentist ^mt-ddrop000"], 1, "mt-ddrop000", "Call the dentist");
      expect((await defer("mt-ddrop000", { someday: true, seen_text: "Call the dentist" })).status).toBe(409);
      expect(await bytes(path)).toBe(content);
    });

    it("already deferred exactly so — a second attempt without its key", async () => {
      const { path, content } = await seed([`- [ ] Call the dentist do ${DAY} ^mt-dalread0`], 1, "mt-dalread0", "Call the dentist");
      expect((await defer("mt-dalread0", { do: DAY, seen_text: "Call the dentist" })).status).toBe(409);
      expect(await bytes(path)).toBe(content);
    });

    it("the line is gone", async () => {
      const { path } = await seed(["- [ ] Gone soon ^mt-dgone000"], 1, "mt-dgone000", "Gone soon");
      await vault.write(path, Buffer.from("# nothing here now\n"), { principal: "user", message: "edit" });
      const r = await defer("mt-dgone000", { do: DAY, seen_text: "Gone soon" });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: "stale", line: null, task: null });
    });

    it("the note moves between the door's read and its write, and the other hand's bytes stand", async () => {
      const { path } = await seed(["- [ ] Race me ^mt-drace000"], 1, "mt-drace000", "Race me");
      const theirs = "- [ ] Race me, edited in Obsidian ^mt-drace000\n";
      beforeWrite = async () => {
        await vault.write(path, Buffer.from(theirs), { principal: "user", message: "obsidian" });
      };
      const r = await defer("mt-drace000", { do: DAY, seen_text: "Race me" });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: "stale", line: "- [ ] Race me, edited in Obsidian ^mt-drace000" });
      expect(await bytes(path)).toBe(theirs);
    });
  });

  it("a key whose row is under `.metistry/` is refused 403 before anything is read or written", async () => {
    const path = `.metistry/itest-defer-${suffix}.md`;
    const { content } = await seed(["- [ ] Rewrite the rules ^mt-dprotect"], 1, "mt-dprotect", "Rewrite the rules", path);
    const reads: string[] = [];
    const orig = vault.read.bind(vault);
    vault.read = async (p) => {
      reads.push(p);
      return orig(p);
    };
    try {
      const r = await defer("mt-dprotect", { someday: true, seen_text: "Rewrite the rules" });
      expect(r.status).toBe(403);
      expect(r.body.error.message).toContain(".metistry/");
      expect(reads).toEqual([]);
    } finally {
      vault.read = orig;
    }
    expect(await bytes(path)).toBe(content);
  });

  it("defers an anchorless line by its hash key, and refuses to guess when the key names two notes", async () => {
    const key = taskHashKey("buy oat milk", 0);
    const a = await seed(["- [ ] Buy oat milk"], 1, key, "Buy oat milk");
    const b = await seed(["- [ ] Buy oat milk"], 1, key, "Buy oat milk");
    const ambiguous = await defer(key, { do: DAY, seen_text: "Buy oat milk" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.message).toContain("send path");
    const r = await defer(key, { do: DAY, seen_text: "Buy oat milk", path: b.path });
    expect(r.status).toBe(200);
    expect(await bytes(b.path)).toBe(`- [ ] Buy oat milk do ${DAY}\n`);
    expect(await bytes(a.path)).toBe("- [ ] Buy oat milk\n");
  });

  it("a replay under the same Idempotency-Key is the first answer, marked, and writes nothing", async () => {
    const { path } = await seed(["- [ ] Replay me ^mt-dreplay0"], 1, "mt-dreplay0", "Replay me");
    const headers = { authorization: `Bearer ${localOwnerToken}`, "idempotency-key": `defer-${suffix}-1` };
    const first = await defer("mt-dreplay0", { do: DAY, seen_text: "Replay me" }, headers);
    expect(first.status).toBe(200);
    expect(first.replayed).toBeNull();
    const afterFirst = await bytes(path);
    const second = await defer("mt-dreplay0", { do: DAY, seen_text: "Replay me" }, headers);
    expect(second).toMatchObject({ status: 200, replayed: "true", body: first.body });
    expect(await bytes(path)).toBe(afterFirst);
    // the same key for a different request is a caller bug, never a replay
    expect((await defer("mt-dreplay0", { someday: true, seen_text: "Replay me" }, headers)).status).toBe(400);
    // and a Tick under the same key is a different door's key, not this one's replay
    expect((await fetch(`${base}/api/vault-tasks/mt-dreplay0/check`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ checked: true, seen_text: "Replay me" }) })).status).toBe(200);
  });

  it("refuses a malformed request before it looks anything up", async () => {
    const r = (body: Record<string, unknown>) => defer("mt-dnosuch0", body);
    expect((await r({ seen_text: "x" })).status).toBe(400); // neither
    expect((await r({ do: DAY, someday: true, seen_text: "x" })).status).toBe(400); // both
    expect((await r({ do: "tomorrow", seen_text: "x" })).status).toBe(400); // resolved by the client, never guessed here
    expect((await r({ do: "2026-02-30", seen_text: "x" })).status).toBe(400); // the shape of a day, and no day
    expect((await r({ someday: false, seen_text: "x" })).status).toBe(400);
    expect((await r({ do: DAY })).status).toBe(400);
    expect((await r({ do: DAY, seen_text: "x", due: "2026-10-01" })).body.error.message).toContain("due"); // due is never this door's
    expect((await r({ do: DAY, seen_text: "x", line: "- [ ] anything" })).body.error.message).toContain("line");
    expect((await defer("../../etc", { do: DAY, seen_text: "x" })).status).toBe(400);
    expect((await r({ do: DAY, seen_text: "x" })).status).toBe(404);
  });

  it("refuses a recurrence rule line — never itself a task — without writing", async () => {
    const { path, content } = await seed(["- [ ] Water the plants every week ^mt-drule000"], 1, "mt-drule000", "Water the plants");
    const r = await defer("mt-drule000", { do: DAY, seen_text: "Water the plants" });
    expect(r.status).toBe(400);
    expect(await bytes(path)).toBe(content);
  });

  it("answers 503 when the deployment has no vault bridge", async () => {
    const bare = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir: await inbox(), policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] } });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/vault-tasks/mt-dbare000/schedule`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${localOwnerToken}` },
        body: JSON.stringify({ someday: true, seen_text: "x" }),
      });
      expect(r.status).toBe(503);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});
