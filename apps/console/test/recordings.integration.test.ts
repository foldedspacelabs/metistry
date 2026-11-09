// A recording's transcript and its retention state, the console's doors
// (T8-4, plan §2.15; X-73 folded in — the owner's ruling on W3 question 29).
// Over a real socket against the scratch database (docs/ops/testing.md).
//
//   POST /capture — a transcript from an owner credential is filed at
//   `Journal/Transcripts/<date>-<session>.md`, create-only, in the OWNER's
//   name, and records the session's row; the same frontmatter on an agent
//   bearer lands in `Inbox/` as `capture` and records nothing.
//
//   GET /api/recordings/:id — U2's misuse tests, then the retention state
//   the rule gives (audio until ingested + 7 days, never over 30; the
//   transcript 30 days).
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { vaultSink, type CaptureVault } from "@foldedspacelabs/metistry-mcp-brain";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { transcriptOf, transcriptPath } from "../src/recordings.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-recordings";
const SESSION = "20000101-120000-0a1b";
const OTHER = "20000101-130000-0c2d";

/**
 * What the live-capture bridge sends — `renderTranscript`'s output
 * (packages/mcp-live-capture/src/delivery.ts): JSON-literal frontmatter
 * values, then one line per segment. Written out here rather than imported,
 * so the console takes no dependency on a bridge package.
 */
function transcript(session: string, startedAt = "2000-01-01T12:00:00Z"): string {
  const fm: [string, string][] = [
    ["kind", "transcript"],
    ["title", "Recording 2000-01-01 12:00"],
    ["capture_session", session],
    ["started_at", startedAt],
    ["ended_at", "2000-01-01T12:15:00Z"],
    ["ended_reason", "owner"],
    ["apps", "us.zoom.xos, com.microsoft.teams2"],
    ["source", "live-capture"],
    ["media_bytes", "26214400"],
  ];
  return ["---", ...fm.map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", "", "[00:00:01] (apps) the numbers are in", ""].join("\n");
}

describe("transcriptOf / transcriptPath", () => {
  it("reads the bridge's frontmatter, and nothing short of all four marks makes a transcript", () => {
    const t = transcriptOf(transcript(SESSION))!;
    expect(t).toEqual({ session: SESSION, startedAt: new Date("2000-01-01T12:00:00Z"), endedAt: new Date("2000-01-01T12:15:00Z"), apps: ["us.zoom.xos", "com.microsoft.teams2"], mediaBytes: 26214400 });
    expect(transcriptPath(t)).toBe(`Journal/Transcripts/2000-01-01-${SESSION}.md`);
    // the day is the owner's: 02:00 UTC is still the evening before in New York
    expect(transcriptPath(transcriptOf(transcript(SESSION, "2000-01-02T02:00:00Z"))!, "America/New_York")).toBe(`Journal/Transcripts/2000-01-01-${SESSION}.md`);
    for (const bad of [
      transcript("../../etc"),
      transcript("A-B"),
      transcript(SESSION).replace('kind: "transcript"', 'kind: "note"'),
      transcript(SESSION).replace('source: "live-capture"', 'source: "someone"'),
      transcript(SESSION).replace(/started_at: "[^"]*"/, 'started_at: "whenever"'),
      "no frontmatter at all",
      null,
    ]) {
      expect(transcriptOf(bad), String(bad).slice(0, 60)).toBeUndefined();
    }
  });
});

describe.skipIf(!hasDb)("recordings: the transcript's filing and GET /api/recordings/:id", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-rec-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`;
  const passkeyId = `${MARK}-${mintToken(8)}`;
  let inboxDir: string;
  /** Every write the vault bridge was asked for, with the name it was asked in. */
  const writes: { path: string; principal: string; expected: string | undefined }[] = [];
  const files = new Set<string>();
  const vault: CaptureVault = {
    async write(path, _content, intent, expected) {
      if (expected === "" && files.has(path)) throw new Error("conflict: the file exists");
      files.add(path);
      writes.push({ path, principal: intent.principal, expected });
      return {};
    },
    async delete() {
      return {};
    },
    async list() {
      return [];
    },
  };

  const clean = async () => {
    await pool.query(`DELETE FROM capture_sessions WHERE id = ANY($1)`, [[SESSION, OTHER]]);
    await pool.query(`DELETE FROM inbox WHERE path LIKE 'Journal/Transcripts/2000-%' OR (path LIKE 'Inbox/%' AND note LIKE '%${OTHER}%')`);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-recordings-"));
    const queries = new QueryStore(pool);
    queries.load(readFileSync(new URL("../../../seed/queries/recording_state.yaml", import.meta.url), "utf8"));
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir,
      inbox: vaultSink(vault),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest recordings" })).token;
    await clean();
  });

  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    rmSync(inboxDir, { recursive: true, force: true });
  });

  const capture = async (bearer: string, note: string, key: string) => {
    const r = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ note, filename: "transcript.md" }),
    });
    return { status: r.status, body: await r.json() };
  };
  const get = async (headers: Record<string, string>, id = SESSION) => {
    const r = await fetch(`${base}/api/recordings/${id}`, { headers });
    return { status: r.status, body: await r.json() };
  };

  it("**a finished session's transcript lands in Journal/Transcripts/, as the owner, create-only — and records its session**", async () => {
    const p = await capture(ownerToken, transcript(SESSION), `live-capture:${SESSION}`);
    expect(p.status).toBe(201);
    expect(p.body.path).toBe(`Journal/Transcripts/2000-01-01-${SESSION}.md`);
    expect(writes).toEqual([{ path: `Journal/Transcripts/2000-01-01-${SESSION}.md`, principal: "user", expected: "" }]);
    const { rows } = await pool.query(`SELECT * FROM capture_sessions WHERE id = $1`, [SESSION]);
    expect(rows[0]).toMatchObject({ id: SESSION, apps: ["us.zoom.xos", "com.microsoft.teams2"], media_bytes: "26214400", transcript_capture_id: String(p.body.id), transcript_path: p.body.path, folded_at: null, audio_deleted_at: null });
    expect(rows[0].ended_at.toISOString()).toBe("2000-01-01T12:15:00.000Z");
    // the inbox row still carries it, so the drain classifies it (and raises a crash's one report)
    expect((await pool.query(`SELECT path, source_agent FROM inbox WHERE id = $1`, [p.body.id])).rows[0]).toEqual({ path: p.body.path, source_agent: null });

    // a redelivery with the same key is the same row, and nothing is written twice
    const again = await capture(ownerToken, transcript(SESSION), `live-capture:${SESSION}`);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(p.body.id);
    expect(writes).toHaveLength(1);
  });

  it("the same frontmatter on an AGENT bearer is an ordinary capture: Inbox/, as `capture`, and no session row", async () => {
    writes.length = 0;
    const p = await capture(agentToken, transcript(OTHER), `live-capture:${OTHER}`);
    expect(p.status).toBe(201);
    expect(p.body.path).toMatch(/^Inbox\/\d+-transcript\.md$/);
    expect(writes.map((w) => w.principal)).toEqual(["capture"]);
    expect((await pool.query(`SELECT 1 FROM capture_sessions WHERE id = $1`, [OTHER])).rows).toHaveLength(0);
  });

  it("U2: no credential is the uniform 401", async () => {
    const p = await get({});
    expect(p.status).toBe(401);
    expect(p.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
  });

  it("U2: an agent bearer and the capture owner token are the uniform 403", async () => {
    for (const bearer of [agentToken, ownerToken]) {
      const p = await get({ authorization: `Bearer ${bearer}` });
      expect(p.status).toBe(403);
      expect(p.body).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
  });

  it("U2: the local owner token reaches it (and a passkey session): the retention state, dates from the rule", async () => {
    for (const headers of [{ authorization: `Bearer ${localOwnerToken}` }, { cookie: sessionCookie }]) {
      const p = await get(headers);
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({
        id: SESSION,
        event_id: null,
        started_at: "2000-01-01T12:00:00.000Z",
        ended_at: "2000-01-01T12:15:00.000Z",
        scope: { kind: "audio_only", apps: ["us.zoom.xos", "com.microsoft.teams2"] },
        transcript: { path: `Journal/Transcripts/2000-01-01-${SESSION}.md`, ingested_at: null, delete_after: "2000-01-31T12:15:00.000Z", deleted_at: null },
        // not ingested: the ceiling, 30 days after the end
        audio: { kept: true, bytes: 26214400, delete_after: "2000-01-31T12:15:00.000Z", deleted_at: null, deleted_reason: null },
      });
      expect(JSON.stringify(p.body)).not.toContain("the numbers are in"); // state, never the transcript's words
    }
    // ingested two hours after the end: 7 days after that
    await pool.query(`UPDATE capture_sessions SET folded_at = '2000-01-01T14:15:00Z' WHERE id = $1`, [SESSION]);
    expect((await get({ authorization: `Bearer ${localOwnerToken}` })).body.audio.delete_after).toBe("2000-01-08T14:15:00.000Z");
    // …and once the Mac reports it gone
    await pool.query(`UPDATE capture_sessions SET audio_deleted_at = '2000-01-08T14:16:00Z', audio_deleted_reason = 'retention' WHERE id = $1`, [SESSION]);
    expect((await get({ authorization: `Bearer ${localOwnerToken}` })).body.audio).toEqual({ kept: false, bytes: 0, delete_after: "2000-01-08T14:15:00.000Z", deleted_at: "2000-01-08T14:16:00.000Z", deleted_reason: "retention" });
  });

  it("an id no recording has is 404; a malformed one is 400", async () => {
    expect((await get({ authorization: `Bearer ${localOwnerToken}` }, "20000101-000000-ffff")).status).toBe(404);
    const bad = await get({ authorization: `Bearer ${localOwnerToken}` }, "NOT_AN_ID");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
  });
});
