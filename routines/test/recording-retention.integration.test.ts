// recording-retention against the real (scratch) database (T8-4, plan §2.15,
// Q7). The vault and the live-capture bridge are fakes that record what they
// were asked; everything the routine decides in SQL runs against Postgres.
//
//   * a transcript file the table does not know rebuilds its row;
//   * ingestion is the transcript's proposals all decided — never pending,
//     never merely expired — and the first value stands;
//   * the Mac is told, and what it answers is stored;
//   * a transcript past its 30 days is deleted as a COMMIT in the owner's
//     name through the vault bridge — never a raw unlink — and its words are
//     cleared from the inbox row and its proposal; one short of 30 days stays.
//
// Hermetic in a shared database: every recording here is from the year 1990
// and carries the `itest-rr` marker in its id.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { retentionPass, run, RETENTION_PRINCIPAL, type RetentionVault } from "../recording-retention/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url));

const A = "19900101-120000-aaaa";
const B = "19900102-120000-bbbb";
const C = "19900103-120000-cccc";
const ALL = [A, B, C];
const NOW = new Date("1990-02-01T13:00:00Z"); // A ended 1990-01-01 12:15 → 31 days; C ended 1990-01-03 → 29 days

function transcript(session: string, started: string, ended: string): string {
  const fm: [string, string][] = [
    ["kind", "transcript"],
    ["capture_session", session],
    ["started_at", started],
    ["ended_at", ended],
    ["apps", "us.zoom.xos"],
    ["source", "live-capture"],
    ["media_bytes", "1000"],
  ];
  return ["---", ...fm.map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", "", "[00:00:01] (apps) the numbers are in", ""].join("\n");
}

/** The vault bridge, faked: files by path, and every delete with the name it was asked in. */
function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const deletes: { path: string; principal: string; message: string; run?: string }[] = [];
  let refuse = false;
  const vault: RetentionVault & { deletes: typeof deletes; files: typeof files; refuseDeletes(v: boolean): void } = {
    files,
    deletes,
    refuseDeletes(v) {
      refuse = v;
    },
    async read(path) {
      const f = files.get(path);
      return f === undefined ? null : { content: Buffer.from(f), sha256: "x" };
    },
    async list(prefix) {
      return [...files.keys()].filter((p) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes("/")).map((path) => ({ path, kind: "file" as const }));
    },
    async delete(path, intent) {
      if (refuse) throw new Error("forbidden");
      deletes.push({ path, principal: intent.principal, message: intent.message, ...(intent.run ? { run: intent.run } : {}) });
      files.delete(path);
    },
  };
  return vault;
}

describe.skipIf(!hasDb)("recording-retention (real db)", () => {
  let pool: pg.Pool;
  const inboxIds: number[] = [];

  const clean = async () => {
    await pool.query(`DELETE FROM capture_sessions WHERE id = ANY($1)`, [ALL]);
    if (inboxIds.length) {
      await pool.query(`DELETE FROM proposals WHERE payload->>'inbox_id' = ANY($1::text[])`, [inboxIds.map(String)]);
      await pool.query(`DELETE FROM inbox WHERE id = ANY($1::bigint[])`, [inboxIds]);
    }
    inboxIds.length = 0;
  };

  /** A filed recording: its inbox row, its session row, and (optionally) its proposal. */
  async function filed(session: string, started: string, ended: string, proposal?: { decision: string; decided_at?: string }): Promise<number> {
    const path = `Journal/Transcripts/${started.slice(0, 10)}-${session}.md`;
    const id = Number((await pool.query(`INSERT INTO inbox (source, path, note, sha256, status) VALUES ('http', $1, $2, 'x', 'archived') RETURNING id`, [path, transcript(session, started, ended)])).rows[0].id);
    inboxIds.push(id);
    await pool.query(
      `INSERT INTO capture_sessions (id, started_at, ended_at, apps, media_bytes, transcript_capture_id, transcript_path) VALUES ($1, $2, $3, '{us.zoom.xos}', 1000, $4, $5)`,
      [session, started, ended, id, path],
    );
    if (proposal) {
      await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload, decision, decided_at) VALUES ('knowledge', 'inbox-drain', 'user', $1::jsonb, $2, $3)`, [
        JSON.stringify({ inbox_id: id, path, note: transcript(session, started, ended), classification: { kind: "transcript" } }),
        proposal.decision,
        proposal.decided_at ?? null,
      ]);
    }
    return id;
  }
  const row = async (id: string) => (await pool.query(`SELECT * FROM capture_sessions WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("rebuilds a row from a transcript file the table does not know — and leaves a stranger's note in the folder alone", async () => {
    const vault = fakeVault({
      [`Journal/Transcripts/1990-01-02-${B}.md`]: transcript(B, "1990-01-02T12:00:00Z", "1990-01-02T12:30:00Z"),
      "Journal/Transcripts/my-notes.md": "# notes about recordings",
      // a file whose name claims one recording and whose frontmatter another: not taken
      [`Journal/Transcripts/1990-01-03-${C}.md`]: transcript(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z"),
    });
    const pass = await retentionPass(pool, { vault, now: new Date("1990-01-05T00:00:00Z") });
    expect(pass.rebuilt).toBe(1);
    expect(await row(B)).toMatchObject({ id: B, apps: ["us.zoom.xos"], transcript_path: `Journal/Transcripts/1990-01-02-${B}.md`, transcript_capture_id: null });
    expect(await row(A)).toBeUndefined();
    expect(await row(C)).toBeUndefined();
    // a second pass has nothing to rebuild
    expect((await retentionPass(pool, { vault, now: new Date("1990-01-05T00:00:00Z") })).rebuilt).toBe(0);
  });

  it("ingestion is the transcript's proposals decided — not pending, not merely expired — and the first value stands", async () => {
    await filed(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z", { decision: "allow", decided_at: "1990-01-01T14:00:00Z" });
    await filed(B, "1990-01-02T12:00:00Z", "1990-01-02T12:30:00Z", { decision: "pending" });
    await filed(C, "1990-01-03T12:00:00Z", "1990-01-03T12:30:00Z", { decision: "expired", decided_at: "1990-01-10T00:00:00Z" });
    const pass = await retentionPass(pool, { now: new Date("1990-01-05T00:00:00Z") });
    expect(pass.ingested).toBe(1);
    expect((await row(A)).folded_at.toISOString()).toBe("1990-01-01T14:00:00.000Z");
    expect((await row(B)).folded_at).toBeNull();
    expect((await row(C)).folded_at).toBeNull();
    // the fold wrote one first: kept
    await pool.query(`UPDATE capture_sessions SET folded_at = '1990-01-02T13:00:00Z' WHERE id = $1`, [B]);
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = '1990-01-04T00:00:00Z' WHERE payload->>'inbox_id' = $1::text`, [String(inboxIds[1])]);
    await retentionPass(pool, { now: new Date("1990-01-05T00:00:00Z") });
    expect((await row(B)).folded_at.toISOString()).toBe("1990-01-02T13:00:00.000Z");
  });

  it("tells the Mac with the bridge token, and stores what it answers — it never decides the audio itself", async () => {
    await filed(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z", { decision: "allow", decided_at: "1990-01-01T14:00:00Z" });
    await filed(B, "1990-01-02T12:00:00Z", "1990-01-02T12:30:00Z");
    const asked: { auth: string | null; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:7815/recording/retention");
      const body = JSON.parse(String(init.body));
      // a shared scratch database: another suite's recordings are answered, not recorded
      if (!ALL.includes(body.session_id)) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      asked.push({ auth: new Headers(init.headers).get("authorization"), body });
      if (body.session_id === A) return new Response(JSON.stringify({ session_id: A, media_bytes: 0, audio_deleted_at: "1990-01-08T14:00:00Z", audio_deleted_reason: "retention" }), { status: 200 });
      return new Response(JSON.stringify({ session_id: B, media_bytes: 2048 }), { status: 200 });
    }) as unknown as typeof fetch;
    const pass = await retentionPass(pool, { liveCapture: { url: "http://127.0.0.1:7815/", token: "bridge-token" }, fetchFn, now: new Date("1990-01-09T00:00:00Z") });
    expect(pass.audio_deleted).toBe(1);
    expect(asked).toEqual([
      { auth: "Bearer bridge-token", body: { session_id: A, ingested_at: "1990-01-01T14:00:00.000Z" } },
      { auth: "Bearer bridge-token", body: { session_id: B, ingested_at: null } },
    ]);
    expect(await row(A)).toMatchObject({ media_bytes: "0", audio_deleted_reason: "retention" });
    expect((await row(A)).audio_deleted_at.toISOString()).toBe("1990-01-08T14:00:00.000Z");
    expect(await row(B)).toMatchObject({ media_bytes: "2048", audio_deleted_at: null });

    // once gone, it is not asked again
    asked.length = 0;
    await retentionPass(pool, { liveCapture: { url: "http://127.0.0.1:7815", token: "bridge-token" }, fetchFn, now: new Date("1990-01-09T00:00:00Z") });
    expect(asked.map((a) => (a.body as { session_id: string }).session_id)).toEqual([B]);
  });

  it("without a bridge, or with one that is down, it says so and goes on — the transcripts half still runs", async () => {
    await filed(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z");
    const vault = fakeVault({ [`Journal/Transcripts/1990-01-01-${A}.md`]: transcript(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z") });
    const none = await retentionPass(pool, { vault, now: NOW });
    expect(none.audio_skipped).toMatch(/METISTRY_LIVE_CAPTURE_URL/);
    expect(none.transcripts_deleted).toBe(1);

    await filed(B, "1990-01-02T12:00:00Z", "1990-01-02T12:30:00Z");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const pass = await retentionPass(pool, { liveCapture: { url: "http://127.0.0.1:9", token: "t" }, fetchFn: down, now: NOW });
    expect(pass.errors.join("\n")).toMatch(/did not answer.*30 days/);
    expect((await row(B)).audio_deleted_at).toBeNull();
  });

  it("**a transcript past its 30 days is deleted as a commit in the owner's name — never a raw unlink — and its words leave the database too; a day short stays**", async () => {
    const aInbox = await filed(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z", { decision: "allow", decided_at: "1990-01-01T14:00:00Z" });
    await filed(C, "1990-01-03T12:00:00Z", "1990-01-03T12:30:00Z");
    const vault = fakeVault({
      [`Journal/Transcripts/1990-01-01-${A}.md`]: transcript(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z"),
      [`Journal/Transcripts/1990-01-03-${C}.md`]: transcript(C, "1990-01-03T12:00:00Z", "1990-01-03T12:30:00Z"),
    });
    const n = await run(pool, { vault, now: NOW, runId: 4242 });
    expect(n).toBe(1);
    expect(vault.deletes).toEqual([
      { path: `Journal/Transcripts/1990-01-01-${A}.md`, principal: RETENTION_PRINCIPAL, message: `retention: delete the transcript of recording ${A}, 30 days after it ended (Q7)`, run: "4242" },
    ]);
    expect(RETENTION_PRINCIPAL).toBe("user");
    expect((await row(A)).transcript_deleted_at.toISOString()).toBe(NOW.toISOString());
    expect((await row(C)).transcript_deleted_at).toBeNull();
    expect(vault.files.has(`Journal/Transcripts/1990-01-03-${C}.md`)).toBe(true);
    // the words are gone from the inbox row and the proposal as well
    const inbox = (await pool.query(`SELECT note FROM inbox WHERE id = $1`, [aInbox])).rows[0].note as string;
    expect(inbox).toMatch(/^\(transcript deleted 1990-02-01/);
    const proposal = (await pool.query(`SELECT payload FROM proposals WHERE payload->>'inbox_id' = $1::text`, [String(aInbox)])).rows[0].payload;
    expect(proposal.note).toBe(inbox);
    expect(JSON.stringify(proposal)).not.toContain("the numbers are in");
    // a second pass deletes nothing more
    expect(await run(pool, { vault, now: NOW })).toBe(0);
  });

  it("a vault that refuses keeps the row as it was, to try next hour; a path outside the folder is never deleted", async () => {
    await filed(A, "1990-01-01T12:00:00Z", "1990-01-01T12:15:00Z");
    const vault = fakeVault();
    vault.refuseDeletes(true);
    const pass = await retentionPass(pool, { vault, now: NOW });
    expect(pass.transcripts_deleted).toBe(0);
    expect(pass.errors.join("\n")).toMatch(/would not delete/);
    expect((await row(A)).transcript_deleted_at).toBeNull();

    vault.refuseDeletes(false);
    await pool.query(`UPDATE capture_sessions SET transcript_path = 'Journal/1990-01-01.md' WHERE id = $1`, [A]);
    const stray = await retentionPass(pool, { vault, now: NOW });
    expect(stray.errors.join("\n")).toMatch(/not in Journal\/Transcripts\/ — left alone/);
    expect(vault.deletes).toEqual([]);
  });
});
