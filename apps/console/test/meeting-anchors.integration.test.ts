// T8-7, the console's half: a meeting is one card, and **Accept All keeps
// every receipt** — one `allow` per row, in order, each answered and audited
// on its own, never the batch — and the owner's Approve of the meeting's
// transcript is where their jots move from (session, offset) to the
// transcript's path in `Journal/Transcripts/` (C77, C81; the owner's ruling
// on W3 question 29), through the vault bridge as `user`.
//
// The jots arrive through the door they use in production — `POST /capture`,
// saved the moment they are typed — into an in-memory vault standing in for
// the reconciler's bridge. The drain's half (collectors/inbox-drain, tested
// in meeting-group.integration.test.ts) is stood in for here by settling the
// rows exactly as it does, so this suite never drains rows another suite in
// the scratch database owns.
//
// Misuse (U2): Approve is `POST /api/proposals/:id`, reach `owner` — 401 bare,
// 403 for an agent bearer and the capture owner token, the local owner token
// reaches it — and none of the refused answers moves an anchor. An agent's
// row wearing the meeting's group, an agent's capture wearing a jot's
// frontmatter, and another session's jot are never touched.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { vaultSink } from "@foldedspacelabs/metistry-mcp-brain";
import { meetingGroupId, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };

const front = (fields: Record<string, unknown>, body: string) =>
  ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", body, ""].join("\n");

describe.skipIf(!hasDb)("a meeting's card at Needs You: Accept All and the jots' anchors (integration)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let bare: ReturnType<typeof makeServer>; // no vault bridge: the C45 case
  let base: string;
  let bareBase: string;
  let cookie: string;
  let captureToken: string;
  let agentToken: string;
  let inboxDir: string;
  const vault = memoryVault();
  /** Reads that edit the file right after they are served — the owner typing while Approve runs. */
  const editAfterRead = new Map<string, string>();
  const racingVault: VaultClient = {
    // every call looks the method up when it is made, so a test may swap one
    write: (...a) => vault.write(...a),
    delete: (...a) => vault.delete(...a),
    list: (...a) => vault.list(...a),
    log: (...a) => vault.log(...a),
    diff: (...a) => vault.diff(...a),
    read: async (path) => {
      const got = await vault.read(path);
      const edit = editAfterRead.get(path);
      if (got && edit !== undefined) {
        editAfterRead.delete(path);
        await vault.write(path, Buffer.from(edit), { principal: "user", message: "the owner's own edit" });
      }
      return got;
    },
  };
  const localOwnerToken = mintToken();
  const MARK = `itest-t87-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
  const agentId = MARK.slice(0, 40);
  let passkeyId: string;
  let n = 0;
  const session = () => `${MARK}-${++n}`;

  const answer = (id: number, decision: string, headers: Record<string, string> = { cookie }, at = base) =>
    fetch(`${at}/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision }) });
  const capture = async (note: string, headers: Record<string, string> = { cookie }) => {
    const r = await fetch(`${base}/capture`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ note, filename: "jot.md" }) });
    expect(r.status).toBe(201);
    return (await r.json()) as { id: number; path: string };
  };
  /** A jot from the bar, captured, then settled as the inbox drain settles one (collectors/inbox-drain `jotClassification`). */
  const jot = async (s: string, type: "note" | "todo", offset: number, words: string, headers: Record<string, string> = { cookie }) => {
    const text = front({ kind: "jot", jot: type, capture_session: s, offset_s: offset }, words);
    const c = await capture(text, headers);
    await pool.query(`UPDATE inbox SET status = 'classified', triaged_at = now(), proposal = $2 WHERE id = $1`, [
      c.id,
      JSON.stringify({ kind: "jot", reason: "frontmatter kind: jot", title: words, jot: type, offset_s: offset, capture_session: s }),
    ]);
    return { ...c, text };
  };
  /** A row of the meeting's card: the transcript the drain raises, or a draft another raiser put on the same card. */
  const raise = async (s: string, o: { transcriptPath?: string; sourceAgent?: string; trust?: string; kind?: string; title?: string } = {}): Promise<number> => {
    const path = o.transcriptPath ?? `Journal/Transcripts/2026-09-28-${s}.md`;
    const transcript = o.title === undefined;
    const payload = transcript
      ? { inbox_id: 0, path, classification: { kind: "transcript", reason: "frontmatter kind: transcript", title: "Recording 2026-09-28 13:00" }, tier: "deterministic", meeting: { session_id: s, session_title: "Vendor review", transcript_path: path, jots: [] } }
      : { title: o.title, classification: { kind: o.kind ?? "note", title: o.title } };
    const { rows } = await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload, group_id) VALUES ('knowledge', $1, $2, $3::jsonb, $4) RETURNING id`, [
      o.sourceAgent ?? "inbox-drain",
      o.trust ?? "user",
      JSON.stringify(payload),
      meetingGroupId(s),
    ]);
    return Number(rows[0].id);
  };
  const row = async (id: number) => (await pool.query(`SELECT decision, payload FROM proposals WHERE id = $1`, [id])).rows[0];
  const file = async (path: string) => (await vault.read(path))?.content.toString("utf8");
  const promotedText = (text: string, s: string) => text.replace(`capture_session: "${s}"`, `source: "meeting:Journal/Transcripts/2026-09-28-${s}.md"`);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-t87-"));
    const common = { origin: "http://127.0.0.1:0", inboxDir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] } };
    server = makeServer(pool, new QueryStore(pool), { ...common, inbox: vaultSink(racingVault), vault: racingVault });
    bare = makeServer(pool, new QueryStore(pool), common);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    passkeyId = `${MARK}-pk`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    cookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest t87" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE group_id LIKE $1`, [`meeting:${MARK}-%`]);
    await pool.query(`DELETE FROM inbox WHERE proposal->>'capture_session' LIKE $1 OR note LIKE $2`, [`${MARK}-%`, `%${MARK}-%`]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bare.close(() => r()));
    await pool.end();
    await rm(inboxDir, { recursive: true, force: true });
  });

  it("**Accept All keeps every receipt**: one allow per row in order, each answered and audited on its own; the transcript's moves the owner's jots and nothing else's", async () => {
    const s = session();
    const note = await jot(s, "note", 754, "Kessler confirmed net-45");
    const todo = await jot(s, "todo", 1260, "Send Kessler the revised terms");
    const other = await jot(session(), "note", 5, "another meeting's jot");
    const agents_ = await jot(s, "note", 800, "an agent's words in the owner's meeting", { authorization: `Bearer ${agentToken}` });
    // the card: the transcript the drain raised, then the drafts raised onto the same group
    const transcript = await raise(s);
    const notes = await raise(s, { sourceAgent: "assistant", trust: "internal", title: "Notes: Vendor review" });
    const todoDraft = await raise(s, { sourceAgent: "assistant", trust: "internal", title: "Send the revised terms", kind: "todo" });

    // the list says which rows are one card
    const listed = (await (await fetch(`${base}/api/proposals?limit=200`, { headers: { cookie } })).json()) as { proposals: { id: number; group_id: string | null }[] };
    expect(listed.proposals.filter((p) => [transcript, notes, todoDraft].includes(Number(p.id))).map((p) => p.group_id)).toEqual([meetingGroupId(s), meetingGroupId(s), meetingGroupId(s)]);

    // it is not a batch: the batch refuses Approve on purpose
    const batch = await fetch(`${base}/api/proposals/batch`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ ids: [transcript, notes, todoDraft], decision: "allow" }) });
    expect(batch.status).toBe(400);
    expect((await row(transcript)).decision).toBe("pending");
    expect(await file(note.path)).toBe(note.text);

    // Accept All: one allow per row, in order, each with its own receipt
    const receipts: Record<string, unknown>[] = [];
    for (const id of [transcript, notes, todoDraft]) {
      const r = await answer(id, "allow");
      expect(r.status, `#${id}`).toBe(200);
      receipts.push((await r.json()) as Record<string, unknown>);
    }
    expect(receipts[0]).toEqual({ ok: true, anchored: { session: s, path: `Journal/Transcripts/2026-09-28-${s}.md`, promoted: [note.id, todo.id], already: [], kept: [] } });
    expect(receipts[1]).toEqual({ ok: true });
    expect(receipts[2]).toEqual({ ok: true });

    // every row settled, every answer audited on its own row
    for (const id of [transcript, notes, todoDraft]) expect((await row(id)).decision).toBe("allow");
    const audited = (await pool.query(`SELECT meta FROM runs WHERE component = 'console' AND kind = 'triage' AND tool = 'allow' AND meta->>'proposal' = ANY($1::text[]) ORDER BY id`, [[transcript, notes, todoDraft].map(String)])).rows;
    expect(audited.map((a) => Number(a.meta.proposal))).toEqual([transcript, notes, todoDraft]);
    expect(audited[0].meta).toMatchObject({ meeting: s, anchored: 2 });
    // …and the receipt is kept on the row
    expect((await row(transcript)).payload.anchored).toMatchObject({ session: s, promoted: [note.id, todo.id], by: "user" });

    // the owner's jots now point into the transcript, one line changed; the inbox row follows its file
    expect(await file(note.path)).toBe(promotedText(note.text, s));
    expect(await file(todo.path)).toBe(promotedText(todo.text, s));
    const inboxRow = (await pool.query(`SELECT note, sha256, proposal FROM inbox WHERE id = $1`, [note.id])).rows[0];
    expect(inboxRow.note).toBe(promotedText(note.text, s));
    expect(inboxRow.sha256).toBe((await vault.read(note.path))!.sha256);
    expect(inboxRow.proposal).toMatchObject({ kind: "jot", source: `meeting:Journal/Transcripts/2026-09-28-${s}.md` });
    expect(inboxRow.proposal.capture_session).toBeUndefined();
    // …and nobody else's moved
    expect(await file(other.path)).toBe(other.text);
    expect(await file(agents_.path)).toBe(agents_.text);
  });

  it("a part answered elsewhere first is its own statement — the rest are still answered, each with its receipt", async () => {
    const s = session();
    const j = await jot(s, "note", 30, "decided on the phone");
    const transcript = await raise(s);
    const notes = await raise(s, { sourceAgent: "assistant", trust: "internal", title: "Notes" });
    expect((await answer(notes, "deny")).status).toBe(200); // answered on the phone, a moment before
    const out = [];
    for (const id of [transcript, notes]) out.push({ status: (await answer(id, "allow")).status, id });
    expect(out).toEqual([
      { status: 200, id: transcript },
      { status: 409, id: notes },
    ]);
    expect((await row(notes)).decision).toBe("deny");
    expect(await file(j.path)).toBe(promotedText(j.text, s));
    // a second Approve of a settled transcript moves nothing again
    expect((await answer(transcript, "allow")).status).toBe(409);
  });

  it("misuse (U2): Approve is the owner's — 401 bare, 403 for an agent bearer and the capture token; none of them moves an anchor, and the local owner token reaches it", async () => {
    const s = session();
    const j = await jot(s, "todo", 90, "misuse");
    const id = await raise(s);
    expect((await answer(id, "allow", {})).status).toBe(401);
    expect((await answer(id, "allow", { authorization: `Bearer ${agentToken}` })).status).toBe(403);
    expect((await answer(id, "allow", { authorization: `Bearer ${captureToken}` })).status).toBe(403);
    expect((await row(id)).decision).toBe("pending");
    expect(await file(j.path)).toBe(j.text);
    const local = await answer(id, "allow", { authorization: `Bearer ${localOwnerToken}` });
    expect(local.status).toBe(200);
    expect(await file(j.path)).toBe(promotedText(j.text, s));
  });

  it("an agent's row wearing the meeting's group and payload promotes nothing, and is answered like any note", async () => {
    const s = session();
    const j = await jot(s, "note", 12, "the owner's");
    const forged = await raise(s, { sourceAgent: agentId, trust: "external" });
    const r = await answer(forged, "allow");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(await file(j.path)).toBe(j.text);
    expect((await row(forged)).payload.anchored).toBeUndefined();
  });

  it("Revise and Decline move nothing; a transcript outside Journal/Transcripts/ moves nothing and says why", async () => {
    const s = session();
    const j = await jot(s, "note", 12, "kept");
    const revise = await raise(s);
    expect((await answer(revise, "accept_with_changes")).status).toBe(200);
    const decline = await raise(s);
    expect((await answer(decline, "deny")).status).toBe(200);
    expect(await file(j.path)).toBe(j.text);
    const inInbox = await raise(s, { transcriptPath: `Inbox/1759060000000-transcript-${s}.md` });
    const r = await answer(inInbox, "allow");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, anchored: { session: s, path: null, promoted: [], already: [], kept: [{ inbox_id: j.id, why: "the transcript is not filed under Journal/Transcripts/, so the jot keeps its session anchor" }] } });
    expect(await file(j.path)).toBe(j.text);
  });

  it("an edit the owner makes while Approve runs is never overwritten: the jot is read again and promoted with the edit", async () => {
    const s = session();
    const j = await jot(s, "note", 40, "first words");
    const edited = j.text.replace("first words", "first words, and a second thought");
    editAfterRead.set(j.path, edited);
    const r = await answer(await raise(s), "allow");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { anchored: { promoted: number[] } }).anchored.promoted).toEqual([j.id]);
    expect(await file(j.path)).toBe(promotedText(edited, s));
  });

  it("C45: with no vault bridge a meeting with jots is refused, stays pending with the reason, and moves nothing", async () => {
    const s = session();
    const j = await jot(s, "note", 50, "held");
    const id = await raise(s);
    const r = await answer(id, "allow", { cookie }, bareBase);
    expect(r.status).toBe(503);
    const settled = await row(id);
    expect(settled.decision).toBe("pending");
    expect(settled.payload.error).toMatchObject({ code: "not_available", decision: "allow" });
    expect(await file(j.path)).toBe(j.text);
    // …and with the bridge back, the same Approve goes through
    expect((await answer(id, "allow")).status).toBe(200);
    expect(await file(j.path)).toBe(promotedText(j.text, s));
  });

  it("a vault refusal that is not an edit leaves the request pending with the vault's reason", async () => {
    const s = session();
    const j = await jot(s, "note", 60, "refused");
    const id = await raise(s);
    const write = vault.write;
    vault.write = async () => {
      throw new VaultError("forbidden", "the bridge refused the write");
    };
    try {
      const r = await answer(id, "allow");
      expect(r.status).toBe(403);
    } finally {
      vault.write = write;
    }
    expect((await row(id)).decision).toBe("pending");
    expect(await file(j.path)).toBe(j.text);
  });
});
