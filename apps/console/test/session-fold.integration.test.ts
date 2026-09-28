// The session fold (T3-10, C79; screen-12 §2, §5.2–5.4) against the scratch
// database, end to end through the console's Approve door. The ticket's own
// test, in bold there:
//
//   * **nothing reaches `Me/` without an Approve** — enqueueing the fold turn,
//     harvesting its answer and raising the requests write not one byte of
//     `Me/`; only the owner's Approve writes the after they were shown, as
//     `user`, compare-and-swap on the before.
//
// And around it: what the model says is checked (a quote the owner never
// typed, a turn the fold never showed — dropped); a machine's turn is never
// read as the owner's words; one waiting request per file, superseded rather
// than doubled; a Declined line is never proposed again; a failed or
// abandoned fold turn loses nothing. And U2 on the door Approve is
// (`POST /api/proposals/:id`, reach `owner`): 401 bare, 403 for an agent
// bearer and for the capture owner token, the local owner token reaches it.
//
// Hermetic in a shared database: every archived turn is in a session this
// file minted, and each pass is narrowed to those sessions (`ctx.sessions`),
// so a concurrent suite's archive — Purge Now's year-2000 turns — is never
// read, folded or purged from here.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { VaultError, type VaultClient, type VaultIntent } from "@foldedspacelabs/metistry-artifacts";
import { foldPass, foldSource, type SessionFoldCtx } from "@metistry-apps/routines";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { meEditOf } from "../src/profile-tidy.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const STYLE_PATH = "Me/Working Style.md";
const PROFILE_PATH = "Me/profile.md";
const STYLE = "---\nsource: user\n---\n# Working style\n\n## Prioritisation\n\nDue tomorrow first.\n";
const PROFILE = "---\nsource: user\n# timezone: America/New_York\n# working_days: [mon, tue, wed, thu, fri]\n---\n# Working profile\n";

/** An in-memory vault that records every write — the same shape the reconciler's client has. */
function fakeVault(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: { path: string; content: string; intent: VaultIntent; expected?: string | undefined }[] = [];
  const client = {
    async read(path: string) {
      const content = files.get(path);
      if (content === undefined) return null;
      return { path, content: Buffer.from(content, "utf8"), sha256: sha(content), bytes: content.length };
    },
    async write(path: string, content: Buffer, intent: VaultIntent, expectedSha256?: string) {
      const text = content.toString("utf8");
      const existing = files.get(path);
      if (expectedSha256 !== undefined && expectedSha256 !== (existing === undefined ? "" : sha(existing))) throw new VaultError("conflict");
      writes.push({ path, content: text, intent, expected: expectedSha256 });
      files.set(path, text);
      return { path, sha256: sha(text), bytes: text.length, created: existing === undefined };
    },
  } as unknown as VaultClient;
  return { client, files, writes };
}

describe.skipIf(!hasDb)("the session fold (integration)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  let captureToken: string;
  let agentToken: string;
  let vault: ReturnType<typeof fakeVault>;
  let inboxDir: string;
  let sessions: string[];
  const localOwnerToken = mintToken();
  const MARK = `itest-sf-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
  const CHAT = MARK; // the chat thread this file's owner talks on
  const agentId = MARK.slice(0, 40);
  const passkeyId = `${MARK}-pk`;
  const SOURCES = [foldSource(STYLE_PATH), foldSource(PROFILE_PATH)];

  const ctx = (extra: Partial<SessionFoldCtx> = {}): SessionFoldCtx => ({ vault: vault.client, sessions, ...extra });

  /** One archived turn of the owner's chat: their inbound message, the engine's `runs` row for it, and the archive row — `age` minutes old. */
  async function chatTurn(owner: string, o: { age?: number; session?: string; reply?: string; failed?: string[]; kind?: string; thread?: string; noRun?: boolean; expired?: boolean } = {}): Promise<number> {
    const session = o.session ?? sessions[0]!;
    const turnId = `${MARK}-${randomUUID()}`;
    const age = o.age ?? 120;
    const inbound = await pool.query(`INSERT INTO inbound_messages (thread, text, status, meta, ts) VALUES ($1, $2, 'done', $3, now() - make_interval(mins => $4::int)) RETURNING id`, [
      o.thread ?? CHAT,
      owner,
      JSON.stringify(o.kind ? { kind: o.kind } : { route: { kind: "model" } }),
      age + 1,
    ]);
    if (!o.noRun) {
      await pool.query(`INSERT INTO runs (component, kind, ok, ts, meta) VALUES ('assistant', 'turn', true, now() - make_interval(mins => $1::int), $2)`, [
        age + 1,
        JSON.stringify({ turn_id: turnId, message_id: Number(inbound.rows[0].id), thread: o.thread ?? CHAT }),
      ]);
    }
    const messages = [
      { role: "user", content: owner },
      { role: "assistant", content: o.reply ?? "Here is the answer." },
    ];
    const calls = (o.failed ?? []).map((tool, i) => ({ id: `c${i}`, tool: `mcp__brain__${tool}`, args: {}, result: "refused", is_error: true }));
    const { rows } = await pool.query(
      `INSERT INTO session_archive (session_id, thread, turn_id, ts, system_prompt, messages, tool_calls, expires_at)
       VALUES ($1, $2, $3, now() - make_interval(mins => $4::int), 'p', $5, $6, now() + make_interval(days => $7::int)) RETURNING id`,
      [session, o.thread ?? CHAT, turnId, age, JSON.stringify(messages), JSON.stringify(calls), o.expired ? -1 : 29],
    );
    return Number(rows[0].id);
  }

  /** The fold turn the last pass enqueued, still waiting on the assistant. */
  async function foldTurn(): Promise<{ id: number; text: string; meta: any; status: string }> {
    const { rows } = await pool.query(`SELECT id, text, meta, status FROM inbound_messages WHERE thread = 'session-fold' ORDER BY id DESC LIMIT 1`);
    return { ...rows[0], id: Number(rows[0].id) };
  }

  /** The assistant answers the fold turn — what the drain does: the reply, then the turn marked done (or failed). */
  async function answer(inbound: number, text: string, status: "done" | "failed" = "done"): Promise<void> {
    if (status === "done") await pool.query(`INSERT INTO outbound_messages (thread, text, in_reply_to) VALUES ('session-fold', $1, $2)`, [text, inbound]);
    await pool.query(`UPDATE inbound_messages SET status = $2 WHERE id = $1`, [inbound, status]);
  }
  const block = (items: unknown[]): string => `Read them.\n\n\`\`\`learned\n${JSON.stringify(items, null, 2)}\n\`\`\``;

  const requests = async () =>
    (
      await pool.query(`SELECT id, kind, source_agent, trust, decision, payload, source FROM proposals WHERE source->>'kind' = 'metistry' AND source->>'external_ref' = ANY($1::text[]) ORDER BY id`, [
        SOURCES.map((s) => s.external_ref),
      ])
    ).rows;
  const unfolded = async (): Promise<number[]> => (await pool.query(`SELECT id FROM session_archive WHERE session_id = ANY($1::uuid[]) AND folded_at IS NULL ORDER BY id`, [sessions])).rows.map((r) => Number(r.id));
  const decide = (id: number, decision: string, headers: Record<string, string> = { cookie }) =>
    fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision }) });

  async function clean(): Promise<void> {
    await pool.query(`DELETE FROM outbound_messages WHERE in_reply_to IN (SELECT id FROM inbound_messages WHERE thread = 'session-fold' OR thread = $1 OR thread LIKE $2)`, [CHAT, `${MARK}%`]);
    await pool.query(`DELETE FROM inbound_messages WHERE thread = 'session-fold' OR thread = $1 OR thread LIKE $2`, [CHAT, `${MARK}%`]);
    await pool.query(`DELETE FROM runs WHERE component = 'session-fold' OR (component = 'assistant' AND meta->>'turn_id' LIKE $1)`, [`${MARK}%`]);
    await pool.query(`DELETE FROM proposals WHERE source->>'kind' = 'metistry' AND source->>'external_ref' = ANY($1::text[])`, [SOURCES.map((s) => s.external_ref)]);
    if (sessions) await pool.query(`DELETE FROM session_archive WHERE session_id = ANY($1::uuid[])`, [sessions]);
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    vault = fakeVault({});
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-sf-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      // the SAME fake the fold reads: each test's fresh one is the one Approve writes
      vault: {
        read: (path: string) => vault.client.read(path),
        write: (...a: Parameters<VaultClient["write"]>) => vault.client.write(...a),
      } as unknown as VaultClient,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    cookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest session fold" })).token;
  });

  beforeEach(async () => {
    await clean();
    sessions = [randomUUID(), randomUUID()];
    vault = fakeVault({ [STYLE_PATH]: STYLE, [PROFILE_PATH]: PROFILE });
  });

  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(inboxDir, { recursive: true, force: true });
  });

  it("**nothing reaches Me/ without an Approve** — the fold enqueues, harvests and raises; only Approve writes, as `user`", async () => {
    const t1 = await chatTurn("Please lead with the number, then the why.");
    const t2 = await chatTurn("I don't work Fridays, so nothing lands then.", { session: sessions[1] });

    // pass 1: one turn enqueued, carrying both, on its own machine thread
    const first = await foldPass(pool, ctx());
    expect(first.enqueued).toMatchObject({ turns: 2 });
    const turn = await foldTurn();
    expect(turn.status).toBe("new");
    expect(turn.text.startsWith("🧭 session fold")).toBe(true);
    expect(turn.text).toContain(`#${t1} · ${CHAT}`);
    expect(turn.text).toContain("> Please lead with the number, then the why.");
    expect(turn.meta).toMatchObject({ kind: "session-fold", tier: "routine", fresh_session: true, source: "session-fold" });
    expect(turn.meta.turns.map((t: { id: number }) => t.id)).toEqual([t1, t2]);
    expect(await unfolded()).toEqual([t1, t2]); // folded only once the answer is read

    // pass 2 while the turn waits: nothing new behind it
    expect((await foldPass(pool, ctx())).waiting).toBe(turn.id);

    await answer(
      turn.id,
      block([
        { kind: "preference", turn: t1, quote: "lead with the number" },
        { kind: "profile", turn: t2, quote: "I don't work Fridays", key: "working_days", value: ["mon", "tue", "wed", "thu"] },
      ]),
    );
    const harvest = await foldPass(pool, ctx());
    expect(harvest.harvested).toEqual([{ inbound: turn.id, state: "raised", raised: expect.any(Array), folded: 2 }]);
    expect(harvest.harvested[0]!.raised).toHaveLength(2);

    // not one byte of Me/ yet
    expect(vault.writes).toEqual([]);
    expect(vault.files.get(STYLE_PATH)).toBe(STYLE);
    expect(vault.files.get(PROFILE_PATH)).toBe(PROFILE);
    expect(await unfolded()).toEqual([]);

    const [style, profile] = await requests();
    expect(style).toMatchObject({ kind: "improvement", source_agent: "session-fold", trust: "internal", decision: "pending", source: { kind: "metistry", external_ref: "Me/Working Style.md#session-fold" } });
    expect(style.payload.body).toEqual({
      kind: "before_after",
      heading: "What Approve Does",
      before: { label: "Me/Working Style.md now", text: STYLE },
      after: { label: "Me/Working Style.md after", text: `${STYLE}\n## Preferences\n\n- lead with the number\n` },
    });
    // provenance both ways (screen-12 §5.3): the session and turn each line came from
    expect(style.payload.items).toEqual([expect.objectContaining({ kind: "preference", line: "lead with the number", archive_id: t1, session_id: sessions[0], thread: CHAT })]);
    expect(profile.payload.items).toEqual([expect.objectContaining({ kind: "profile", line: "working_days: [mon, tue, wed, thu]", session_id: sessions[1] })]);
    // the console reads both as a Me/ edit — the one Approve path for Me/
    expect(meEditOf(style.payload)).toMatchObject({ path: STYLE_PATH, base_sha256: sha(STYLE), before: STYLE });
    expect(meEditOf(profile.payload)?.after).toBe(PROFILE.replace("# working_days: [mon, tue, wed, thu, fri]", "working_days: [mon, tue, wed, thu]"));

    // Approve: the after the owner was shown, as them, compare-and-swap on the before
    const r = await decide(Number(style.id), "allow");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, applied: { path: STYLE_PATH } });
    expect(vault.writes).toEqual([{ path: STYLE_PATH, content: style.payload.body.after.text, intent: { principal: "user", message: `${STYLE_PATH}: approved request #${style.id}` }, expected: sha(STYLE) }]);
    expect((await decide(Number(profile.id), "allow")).status).toBe(200);
    expect(vault.files.get(PROFILE_PATH)).toContain("\nworking_days: [mon, tue, wed, thu]\n");
    expect(vault.writes.map((w) => w.intent.principal)).toEqual(["user", "user"]);
  });

  it("what the model says is checked: words the owner never typed, a turn the fold never showed — dropped, and nothing is asked", async () => {
    const t1 = await chatTurn("What's on today?", { reply: "Always lead with a chart, you said." });
    await foldPass(pool, ctx());
    const turn = await foldTurn();
    await answer(
      turn.id,
      block([
        { kind: "preference", turn: t1, quote: "Always lead with a chart" }, // the assistant's words, not the owner's
        { kind: "preference", turn: t1 + 1000, quote: "What's on today?" }, // not a turn this fold showed
        { kind: "profile", turn: t1, quote: "What's on today?", key: "standup_time", value: "09:00" }, // moved to the Standup routine (T3-4): never a fact the fold proposes
      ]),
    );
    const pass = await foldPass(pool, ctx());
    expect(pass.harvested[0]).toMatchObject({ state: "nothing", raised: [], folded: 1 });
    const row = (await pool.query(`SELECT meta FROM runs WHERE component = 'session-fold' AND meta->>'harvested' = $1`, [String(turn.id)])).rows[0];
    expect(row.meta.dropped.map((d: { reason: string }) => d.reason.split(":")[0])).toEqual(["not_the_owners_words", "unknown_turn", "unknown_key"]);
    expect(row.meta.outcome).toBe("silent");
    expect(await requests()).toEqual([]);
    expect(vault.writes).toEqual([]);
  });

  it("a machine's turn is never read as the owner's words — a routine's, the fold's own, or one no message traces to; nor a turn too new, nor one expired", async () => {
    const chat = await chatTurn("Keep replies short.");
    const routine = await chatTurn("🌙 evening fold — do the thing", { kind: "fold", thread: `${MARK}-fold` });
    const own = await chatTurn("🧭 session fold — earlier", { kind: "session-fold", thread: `${MARK}-sf` });
    const untraced = await chatTurn("no run row for me", { noRun: true });
    const fresh = await chatTurn("too new to fold", { age: 5 });
    await chatTurn("already expired", { expired: true });

    const pass = await foldPass(pool, ctx());
    expect(pass.enqueued).toMatchObject({ turns: 1, skipped: 3 });
    const turn = await foldTurn();
    expect(turn.meta.turns.map((t: { id: number }) => t.id)).toEqual([chat]);
    for (const words of ["evening fold", "session fold — earlier", "no run row", "too new", "already expired"]) expect(turn.text).not.toContain(words);
    // read-and-skipped: out of the queue, so the purge does not count them as lost learning
    const left = await unfolded();
    expect(left).toContain(chat); // until its answer is read
    expect(left).toContain(fresh);
    for (const id of [routine, own, untraced]) expect(left).not.toContain(id);
  });

  it("one waiting request per file: a later harvest supersedes it with both lines, against the file as it is", async () => {
    const t1 = await chatTurn("Lead with the number.");
    await foldPass(pool, ctx());
    await answer((await foldTurn()).id, block([{ kind: "preference", turn: t1, quote: "Lead with the number" }]));
    await foldPass(pool, ctx());
    const [first] = await requests();

    const t2 = await chatTurn("And no emoji, ever.", { session: sessions[1] });
    await foldPass(pool, ctx());
    await answer((await foldTurn()).id, block([{ kind: "preference", turn: t2, quote: "no emoji, ever" }]));
    await foldPass(pool, ctx());

    const rows = await requests();
    expect(rows.map((r) => r.decision)).toEqual(["resolved_at_source", "pending"]);
    expect(Number(rows[0].id)).toBe(Number(first.id));
    expect(rows[1].payload.items.map((i: { line: string }) => i.line)).toEqual(["Lead with the number", "no emoji, ever"]);
    expect(rows[1].payload.body.after.text).toBe(`${STYLE}\n## Preferences\n\n- Lead with the number\n- no emoji, ever\n`);

    // the superseded one is already decided; the live one writes both
    expect((await decide(Number(first.id), "allow")).status).toBe(409);
    expect(vault.writes).toEqual([]);
    expect((await decide(Number(rows[1].id), "allow")).status).toBe(200);
    expect(vault.files.get(STYLE_PATH)).toBe(rows[1].payload.body.after.text);
  });

  it("a harvest retried after it stopped part-way raises nothing twice — the waiting request is left exactly as it was", async () => {
    const t1 = await chatTurn("Lead with the number.");
    await foldPass(pool, ctx());
    const turn = await foldTurn();
    await answer(turn.id, block([{ kind: "preference", turn: t1, quote: "Lead with the number" }]));
    await foldPass(pool, ctx());
    const before = await requests();
    // the harvest's own row is what marks it done: without it, the next pass harvests the same answer again
    await pool.query(`DELETE FROM runs WHERE component = 'session-fold' AND meta->>'harvested' = $1`, [String(turn.id)]);
    const again = await foldPass(pool, ctx());
    expect(again.harvested[0]).toMatchObject({ inbound: turn.id, state: "nothing", raised: [] });
    expect(await requests()).toEqual(before);
  });

  it("Decline writes nothing, and the same line is never proposed again; a line already in the file is not proposed at all", async () => {
    vault = fakeVault({ [STYLE_PATH]: `${STYLE}\n## Preferences\n\n- short answers\n`, [PROFILE_PATH]: PROFILE });
    const t1 = await chatTurn("Use bullet points. Also: short answers.");
    await foldPass(pool, ctx());
    await answer((await foldTurn()).id, block([{ kind: "preference", turn: t1, quote: "Use bullet points" }, { kind: "preference", turn: t1, quote: "short answers" }]));
    await foldPass(pool, ctx());
    const [asked] = await requests();
    expect(asked.payload.items.map((i: { line: string }) => i.line)).toEqual(["Use bullet points"]); // "short answers" is already theirs
    expect((await decide(Number(asked.id), "deny")).status).toBe(200);
    expect(vault.writes).toEqual([]);

    const t2 = await chatTurn("Use bullet points, I said.", { session: sessions[1] });
    await foldPass(pool, ctx());
    const turn = await foldTurn();
    await answer(turn.id, block([{ kind: "preference", turn: t2, quote: "use bullet points" }]));
    const pass = await foldPass(pool, ctx());
    expect(pass.harvested[0]).toMatchObject({ state: "nothing", raised: [] });
    const row = (await pool.query(`SELECT meta FROM runs WHERE component = 'session-fold' AND meta->>'harvested' = $1`, [String(turn.id)])).rows[0];
    expect(row.meta.files).toEqual([{ path: STYLE_PATH, dropped: [{ line: "Use bullet points", reason: "declined_before" }] }]);
    expect((await requests()).map((r) => r.decision)).toEqual(["deny"]);
  });

  it("Approve after the owner edited the file is refused `stale`: nothing written, the request still waiting", async () => {
    const t1 = await chatTurn("Lead with the number.");
    await foldPass(pool, ctx());
    await answer((await foldTurn()).id, block([{ kind: "preference", turn: t1, quote: "Lead with the number" }]));
    await foldPass(pool, ctx());
    const [asked] = await requests();
    vault.files.set(STYLE_PATH, `${STYLE}\nEdited in Obsidian.\n`);
    const r = await decide(Number(asked.id), "allow");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: "stale", decision: "pending" });
    expect(vault.writes).toEqual([]);
  });

  it("a fold turn that failed, or was never answered in a day, loses nothing: its turns go back in the queue", async () => {
    const t1 = await chatTurn("Lead with the number.");
    await foldPass(pool, ctx());
    const failed = await foldTurn();
    await answer(failed.id, "", "failed");
    const pass = await foldPass(pool, ctx());
    expect(pass.harvested).toEqual([{ inbound: failed.id, state: "turn_failed", raised: [], folded: 0 }]);
    const skip = (await pool.query(`SELECT meta FROM runs WHERE component = 'session-fold' AND meta->>'harvested' = $1`, [String(failed.id)])).rows[0];
    expect(skip.meta.outcome).toBe("skipped:turn_failed");
    // …and the same pass enqueued them again
    expect(pass.enqueued).toMatchObject({ turns: 1 });
    const again = await foldTurn();
    expect(again.id).not.toBe(failed.id);
    expect(again.meta.turns.map((t: { id: number }) => t.id)).toEqual([t1]);

    // a turn nobody answered for a day is abandoned, not waited on forever
    await pool.query(`UPDATE inbound_messages SET ts = now() - interval '25 hours' WHERE id = $1`, [again.id]);
    const later = await foldPass(pool, ctx());
    expect(later.harvested).toEqual([{ inbound: again.id, state: "abandoned", raised: [], folded: 0 }]);
    expect(later.enqueued).toMatchObject({ turns: 1 });
    expect(await unfolded()).toEqual([t1]);
  });

  it("with no vault bridge an answered turn waits — nothing folded, nothing asked — and is harvested once there is one", async () => {
    const t1 = await chatTurn("Lead with the number.");
    await foldPass(pool, ctx());
    const turn = await foldTurn();
    await answer(turn.id, block([{ kind: "preference", turn: t1, quote: "Lead with the number" }]));
    expect(await foldPass(pool, ctx({ vault: undefined }))).toMatchObject({ waiting: turn.id, no_vault: true });
    expect(await unfolded()).toEqual([t1]);
    expect(await requests()).toEqual([]);
    expect((await foldPass(pool, ctx())).harvested[0]).toMatchObject({ inbound: turn.id, state: "raised" });
  });

  it("misuse (U2): Approve is the owner's — 401 bare, 403 for an agent bearer and the capture token, the local owner token reaches it", async () => {
    const t1 = await chatTurn("Lead with the number.");
    await foldPass(pool, ctx());
    await answer((await foldTurn()).id, block([{ kind: "preference", turn: t1, quote: "Lead with the number" }]));
    await foldPass(pool, ctx());
    const [asked] = await requests();
    expect((await decide(Number(asked.id), "allow", {})).status).toBe(401);
    expect((await decide(Number(asked.id), "allow", { authorization: `Bearer ${agentToken}` })).status).toBe(403);
    expect((await decide(Number(asked.id), "allow", { authorization: `Bearer ${captureToken}` })).status).toBe(403);
    expect(vault.writes).toEqual([]); // none of them wrote a byte
    const local = await decide(Number(asked.id), "allow", { authorization: `Bearer ${localOwnerToken}` });
    expect(local.status).toBe(200);
    expect(vault.files.get(STYLE_PATH)).toBe(asked.payload.body.after.text);
  });
});
