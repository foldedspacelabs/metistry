// The meeting-note door (design-build-plan §2.11, T2-11):
// `POST /api/meetings/:event_id/note` renders the owner's
// `Templates/Meeting.md` and writes it as `user` to
// `Journal/Meetings/<date>-<topic>.md`, once per event. Over real sockets
// against the scratch database (docs/ops/testing.md); the vault is the
// in-memory one, so every write the door makes is visible here byte for byte.
//
// The ticket's own tests, bold in its Tests line: **notes never reach an
// agent** (here: the note is the template and never an invite body, and both
// calendar reads are refused on the generic door; the bridge and the sync
// prove their halves in packages/mcp-eventkit and collectors/eventkit-calendar)
// and **a second note call returns the first path**. Plus U2's four.
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, type MemoryVault, type VaultClient, type VaultIntent } from "@foldedspacelabs/metistry-artifacts";
import { mintToken, taskToday } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { meetingNotePaths, meetingTopic, noteEventId, validEventId } from "../src/meeting-note-route.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-meet";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const CONNECTION = `itest-meet-${suffix}`;
const TEMPLATE = readFileSync(fileURLToPath(new URL("../../../seed/vault/Templates/Meeting.md", import.meta.url)), "utf8");
const NOTES = "Dial-in 555-0100, pin 4242 — the confidential agenda";

describe("the meeting note's names (pure)", () => {
  it("a topic is the title lowercased, runs of anything but letters and digits one hyphen, in any script", () => {
    expect(meetingTopic("Q4 Planning — Drey / Ops")).toBe("q4-planning-drey-ops");
    expect(meetingTopic("1:1 with Jim")).toBe("1-1-with-jim");
    expect(meetingTopic("Réunion d'équipe")).toBe("réunion-d-équipe");
    expect(meetingTopic("   ")).toBe("meeting");
    expect(meetingTopic("../../.metistry/rules")).toBe("metistry-rules"); // a title can never climb out of Journal/Meetings/
    expect(meetingTopic("x".repeat(200))).toHaveLength(60);
  });

  it("the file names an event's note may take: the day and topic, then -2 … -20, all under Journal/Meetings/", () => {
    const paths = meetingNotePaths("2026-09-28", "Standup");
    expect(paths[0]).toBe("Journal/Meetings/2026-09-28-standup.md");
    expect(paths[1]).toBe("Journal/Meetings/2026-09-28-standup-2.md");
    expect(paths).toHaveLength(20);
    for (const p of paths) expect(p.startsWith("Journal/Meetings/2026-09-28-standup")).toBe(true);
  });

  it("an event id is the walk's: whole, no surrounding space, no control character, at most 1024", () => {
    expect(validEventId("EK-1:ABC_20260928T133000Z")).toBe(true);
    for (const bad of ["", " EK-1", "EK-1 ", "EK\t1", "EK\u00001", "x".repeat(1025)]) expect(validEventId(bad), JSON.stringify(bad)).toBe(false);
  });

  it("reads a note's own `event_id:` as the walk does", () => {
    expect(noteEventId("---\nevent_id: EK-1\nsource: user\n---\n# x\n")).toBe("EK-1");
    expect(noteEventId("---\nevent_id: 4815162342\n---\n")).toBe("4815162342");
    expect(noteEventId("# no frontmatter\nevent_id: EK-1\n")).toBeNull();
    expect(noteEventId("---\nevent_id: [a, b]\n---\n")).toBeNull();
  });
});

describe.skipIf(!hasDb)("the meeting-note door: POST /api/meetings/:event_id/note", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let vault: MemoryVault;
  /** Every write the server made through the bridge, with the intent and the hash it claimed. */
  const writes: { path: string; intent: VaultIntent; expected: string | undefined }[] = [];
  /** A hook run between the door's read of a path and its write — to put a file there first. */
  let beforeWrite: (() => Promise<void>) | null = null;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-meet-${suffix}`;
  const passkeyIds: string[] = [];
  const inboxDirs: string[] = [];
  let n = 0;

  /** A server over the same pool, queries and vault — a fresh one has none of the door's memory, as after a restart. */
  async function serve(): Promise<{ server: ReturnType<typeof makeServer>; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), "metistry-meet-"));
    inboxDirs.push(dir);
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
    const s = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir: dir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] }, vault: racing });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    vault = memoryVault();
    ({ server, base } = await serve());
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest meet" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [CONNECTION]);
    await pool.query(`DELETE FROM vault_meeting_refs WHERE event_id LIKE $1`, [`${CONNECTION}-%`]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    for (const dir of inboxDirs) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    beforeWrite = null;
    await vault.write("Templates/Meeting.md", Buffer.from(TEMPLATE), { principal: "user", message: "seed" });
  });

  /** One event in the calendar table, as a sync would leave it — noon UTC, so its day is the same in every zone a test runs in. */
  async function event(title: string, over: { start?: string; attendees?: unknown[] } = {}): Promise<{ id: string; day: string; start: string }> {
    const id = `${CONNECTION}-${++n}`;
    const start = over.start ?? `2026-10-${String(n).padStart(2, "0")}T12:00:00.000Z`;
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title, attendees, self_status)
       VALUES ($1, $2, $3, $3::timestamptz + interval '30 minutes', $4, $5::jsonb, 'accepted')`,
      [CONNECTION, id, start, title, JSON.stringify(over.attendees ?? [{ name: "Dana", email: "dana@example.com", status: "accepted", role: "required", type: "person", self: false }])],
    );
    return { id, start, day: taskToday({ now: new Date(start) }) };
  }

  async function open(id: string, body: unknown = {}, headers: Record<string, string> = { authorization: `Bearer ${localOwnerToken}` }, at = base) {
    const r = await fetch(`${at}/api/meetings/${encodeURIComponent(id)}/note`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  }

  const text = async (path: string) => (await vault.read(path))?.content.toString("utf8") ?? null;
  const frontmatter = (t: string) => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(t)![1]!) as Record<string, unknown>;
  const notesUnder = async (prefix: string) => (await vault.list("Journal/Meetings", 1)).map((e) => e.path).filter((p) => p.startsWith(prefix));

  // ---- U2: the four --------------------------------------------------------------------------

  describe("who may open a meeting note (U2)", () => {
    it("no credential is the uniform 401, and nothing is written", async () => {
      const e = await event("U2 none");
      const before = writes.length;
      const r = await open(e.id, {}, {});
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      expect(writes.length).toBe(before);
    });

    it("an agent bearer is refused 403 with the canonical answer, and nothing is written", async () => {
      const e = await event("U2 agent");
      const before = writes.length;
      const r = await open(e.id, {}, { authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(writes.length).toBe(before);
    });

    it("the capture owner token is refused 403 — capture is its whole reach — and nothing is written", async () => {
      const e = await event("U2 capture");
      const before = writes.length;
      const r = await open(e.id, {}, { authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(writes.length).toBe(before);
    });

    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      const a = await event("U2 local");
      expect((await open(a.id)).status).toBe(201);
      const b = await event("U2 session");
      expect((await open(b.id, {}, { cookie: sessionCookie })).status).toBe(201);
    });
  });

  // ---- the ticket's own ---------------------------------------------------------------------

  it("renders the owner's template as `user` into Journal/Meetings/<date>-<topic>.md, with `event_id:` — and never an invite body", async () => {
    const e = await event("Q4 Planning / Drey");
    const r = await open(e.id);
    const path = `Journal/Meetings/${e.day}-q4-planning-drey.md`;
    expect(r).toEqual({ status: 201, body: { ok: true, event_id: e.id, path, created: true } });
    const note = (await text(path))!;
    expect(frontmatter(note)).toEqual({ source: "user", type: "resource", event_id: e.id }); // tags: [template] dropped
    expect(note).toContain(`# Meeting — ${e.day}`); // `{{ date }}` is the meeting's day, not today
    expect(note).toContain("## Action items");
    expect(note).not.toContain("{{");
    expect(note).not.toContain("4242");
    expect(note).not.toContain("Dial-in");
    // the owner's hand, and create-only: the door never overwrites
    expect(writes.at(-1)).toEqual({ path, intent: { principal: "user", message: 'open notes for "Q4 Planning / Drey"' }, expected: "" });
    // the walk would link it: the key it reads is exactly `event_id:`
    expect(noteEventId(note)).toBe(e.id);
  });

  it("**a second note call returns the first path** — before the walk has seen it, after a restart, and once the walk has", async () => {
    const e = await event("Standup");
    const first = await open(e.id);
    expect(first.status).toBe(201);
    const path = first.body.path as string;
    const written = writes.length;

    // 1. at once, before any walk: the door remembers what it wrote
    expect(await open(e.id)).toEqual({ status: 200, body: { ok: true, event_id: e.id, path, created: false } });
    // 2. a restarted console, still before the walk: the same file name, and the note's own `event_id:`
    const fresh = await serve();
    try {
      expect(await open(e.id, {}, undefined, fresh.base)).toEqual({ status: 200, body: { ok: true, event_id: e.id, path, created: false } });
    } finally {
      await new Promise<void>((r) => fresh.server.close(() => r()));
    }
    // 3. the walk has it — even renamed since, even with a copy beside it: the index's first note
    const moved = `Journal/Meetings/2026/10/${e.day}-standup.md`;
    await pool.query(`INSERT INTO vault_meeting_refs (event_id, path) VALUES ($1, $2), ($1, $3)`, [e.id, moved, `${moved.slice(0, -3)} 1.md`]);
    expect(await open(e.id)).toEqual({ status: 200, body: { ok: true, event_id: e.id, path: moved, created: false } });
    expect(writes.length).toBe(written); // not one more write
    expect(await notesUnder(`Journal/Meetings/${e.day}-standup`)).toEqual([path]);
  });

  it("two taps at once make one note", async () => {
    const e = await event("Double tap");
    const [a, b] = await Promise.all([open(e.id), open(e.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.path).toBe(b.body.path);
    expect(await notesUnder(`Journal/Meetings/${e.day}-double-tap`)).toHaveLength(1);
  });

  it("a note of the same name that is not this event's is left alone; this one takes the next name", async () => {
    const e = await event("Sync");
    const theirs = `Journal/Meetings/${e.day}-sync.md`;
    await vault.write(theirs, Buffer.from("# my own sync notes, typed by hand\n"), { principal: "user", message: "obsidian" });
    const r = await open(e.id);
    expect(r).toEqual({ status: 201, body: { ok: true, event_id: e.id, path: `Journal/Meetings/${e.day}-sync-2.md`, created: true } });
    expect(await text(theirs)).toBe("# my own sync notes, typed by hand\n");
  });

  it("a note that appears between the door's read and its write is read again, never overwritten", async () => {
    const e = await event("Race");
    const path = `Journal/Meetings/${e.day}-race.md`;
    const mine = `---\nevent_id: ${e.id}\nsource: user\n---\n# made in Obsidian a moment ago\n`;
    beforeWrite = async () => {
      await vault.write(path, Buffer.from(mine), { principal: "user", message: "obsidian" });
    };
    expect(await open(e.id)).toEqual({ status: 200, body: { ok: true, event_id: e.id, path, created: false } });
    expect(await text(path)).toBe(mine);
  });

  it("an id no calendar holds is 404, and nothing is written — a made-up id never lands in the owner's notes", async () => {
    const before = writes.length;
    const r = await open(`${CONNECTION}-no-such-event`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
    expect(writes.length).toBe(before);
  });

  it("no template is 404 naming it, and nothing is written", async () => {
    const e = await event("No template");
    await vault.delete("Templates/Meeting.md", { principal: "user", message: "gone" });
    const before = writes.length;
    const r = await open(e.id);
    expect(r.status).toBe(404);
    expect(r.body.error.message).toContain("Templates/Meeting.md");
    expect(writes.length).toBe(before);
  });

  it("the body is {} or nothing: a field — a title, a path — is refused 400 and nothing is written", async () => {
    const e = await event("Body");
    const before = writes.length;
    for (const body of [{ title: "Something else" }, { path: ".metistry/rules.yaml" }, [], "null", "not json"]) {
      const r = await open(e.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(writes.length).toBe(before);
    expect((await open(e.id, undefined)).status).toBe(201); // no body is {}
  });

  it("an id with surrounding space or a control character is 400", async () => {
    for (const id of [" EK-1", "EK\t1"]) expect((await open(id)).status, JSON.stringify(id)).toBe(400);
  });

  it("**notes never reach an agent**: both calendar reads are route-only — the capture token asking the generic door gets the unknown-query answer", async () => {
    const unknown = await fetch(`${base}/api/q/no_such_query_${suffix}`, { headers: { authorization: `Bearer ${ownerToken}` } });
    const want = await unknown.json();
    for (const q of ["day_events?day=2026-10-01", `calendar_event?event_id=${CONNECTION}-1`]) {
      const r = await fetch(`${base}/api/q/${q}`, { headers: { authorization: `Bearer ${ownerToken}` } });
      expect(r.status, q).toBe(unknown.status);
      expect(await r.json(), q).toEqual(want);
    }
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'calendar_events'`)).rows.map((r) => r.column_name);
    expect(cols.filter((c) => /note|body|description/i.test(c))).toEqual([]);
  });

  it("the ledger row names the id and the outcome — never the title or the path", async () => {
    const e = await event("Private title with Jim");
    await open(e.id);
    const { rows } = await pool.query(`SELECT tool, ok, meta FROM runs WHERE component = 'console' AND kind = 'meeting_note' AND meta->>'event_id' = $1`, [e.id]);
    expect(rows).toEqual([{ tool: "open", ok: true, meta: { event_id: e.id, outcome: "created" } }]);
  });
});
