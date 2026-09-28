// Routine suggestions (design-build-plan §2.5, §2.12; screen 8 §10.4; ticket
// T3-11): an `improvement` request carrying the before and after of one
// `.metistry/scheduled.yaml` entry, which Approve writes through the
// Scheduled door as `user`.
//
// The ticket's own test, in bold there: **nothing is written before
// Approve** — raising one writes nothing; Later, Revise and Decline write
// nothing; a refused Approve (no credential, an agent bearer, the capture
// owner token, a stale entry, an agent's request) writes nothing. Then the
// door's misuse tests (U2): Approve is `POST /api/proposals/:id`, reach
// `owner` — 401 bare, 403 for an agent bearer and the capture owner token,
// and the local owner token reaches it.
//
// The product's own routine and collector manifests are loaded exactly as
// the console loads them; the overlay lives in an in-memory vault standing in
// for the reconciler's bridge, the one writer.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault } from "@foldedspacelabs/metistry-artifacts";
import { emptyScheduled, mintToken, parseScheduled, type Scheduled } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { loadCollectors } from "@metistry-apps/collectors";
import { loadRoutines } from "@metistry-apps/routines";
import { makeServer } from "../src/server.js";
import { loadSchedules, unitOf, type ScheduledCollector } from "../src/runner.js";
import { SCHEDULED_PATH } from "../src/profile-tidy.js";
import type { ScheduledAdmin } from "../src/scheduled-routes.js";
import { applySuggestion, carriesSuggestion, suggestionOf, suggestionPayload, type SuggestionInput } from "../src/routine-suggestions.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const WEEKDAYS_0830 = { days: ["mon", "tue", "wed", "thu", "fri"], at: ["08:30"] };
const OWNER_FILE = `# my changes — kept
routines:
  standup:
    schedule: { days: working_days, at: ["06:00"] }
  vendor-sweep:
    actor: researcher
    task: Summarise Areas/Finance
    grants: { read: [Areas/Finance] }
    schedule: { days: [mon], at: ["07:00"] }
syncs:
  github-state:
    connection: github
    every: 15m
`;

async function loadComponents(): Promise<ScheduledCollector[]> {
  return [
    ...(await loadSchedules((await loadCollectors({ home: join(REPO, "collectors") })).collectors)),
    ...(await loadSchedules((await loadRoutines({ home: join(REPO, "routines") })).routines)),
  ];
}

/** An admin over an in-memory vault that records every write the door makes. */
function adminOver(components: ScheduledCollector[]) {
  const vault = memoryVault();
  const writes: { message: string; expected: string }[] = [];
  const read = async (): Promise<Buffer | null> => (await vault.read(SCHEDULED_PATH))?.content ?? null;
  const admin: ScheduledAdmin = {
    components,
    overlay: {
      read,
      write: async (content, expected, message) => {
        writes.push({ message, expected });
        await vault.write(SCHEDULED_PATH, content, { principal: "user", message }, expected);
      },
    },
    timeZone: "Etc/UTC",
  };
  const set = async (text: string): Promise<void> => {
    if (await vault.read(SCHEDULED_PATH)) await vault.delete(SCHEDULED_PATH, { principal: "user", message: "reset" });
    if (text !== "") await vault.write(SCHEDULED_PATH, Buffer.from(text), { principal: "user", message: "seed" });
    writes.length = 0;
  };
  const text = async (): Promise<string | null> => (await read())?.toString("utf8") ?? null;
  const file = async (): Promise<Scheduled> => {
    const t = await text();
    if (t === null) return emptyScheduled;
    const p = parseScheduled(t);
    if (!p.ok) throw new Error(p.errors.join("; "));
    return p.value;
  };
  return { admin, writes, set, text, file };
}

describe("a routine suggestion's request", () => {
  let components: ScheduledCollector[];
  let o: ReturnType<typeof adminOver>;
  const units = () => components.map(unitOf);
  const build = async (input: Partial<SuggestionInput> & Pick<SuggestionInput, "name" | "change">) =>
    suggestionPayload(units(), await o.file(), { title: "Draft standup at 8:30 instead of 6:00?", ...input });

  beforeAll(async () => {
    components = await loadComponents();
  });
  beforeEach(async () => {
    o = adminOver(components);
    await o.set(OWNER_FILE);
  });

  it("carries the entry before and after, and the words the owner reads — and raising it writes nothing", async () => {
    const r = await build({ name: "standup", change: { schedule: WEEKDAYS_0830 }, context: "You open the draft around 9:05 most days." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      title: "Draft standup at 8:30 instead of 6:00?",
      summary: "You open the draft around 9:05 most days.",
      subject: { kind: "routine", name: "standup", title: "Standup" },
      body: {
        kind: "before_after",
        heading: "Standup",
        before: { label: "Now", text: "Schedule: working days at 06:00\nPaused: no (default)" },
        after: { label: "Suggested", text: "Schedule: mon, tue, wed, thu, fri at 08:30\nPaused: no (default)" },
      },
      scheduled_edit: { section: "routines", name: "standup", before: { schedule: { days: "working_days", at: ["06:00"] } }, after: { schedule: WEEKDAYS_0830 } },
    });
    expect(carriesSuggestion(r.payload)).toBe(true);
    expect(suggestionOf(r.payload)?.edit.after).toEqual({ schedule: WEEKDAYS_0830 });
    expect(o.writes).toEqual([]);
    expect(await o.text()).toBe(OWNER_FILE);
  });

  it("a default routine's before is its manifest's, marked default; a sync's reads its cadence and raise rules", async () => {
    const brief = await build({ name: "morning-brief", change: { paused: true } });
    expect(brief.ok && brief.payload.body).toMatchObject({ before: { text: "Schedule: working days at 07:00 (default)\nPaused: no (default)" }, after: { text: "Schedule: working days at 07:00 (default)\nPaused: yes" } });
    const sync = await build({ name: "github-state", change: { every: "1h", raise: { assigned: false } } });
    expect(sync.ok).toBe(true);
    if (!sync.ok) return;
    expect(sync.edit).toEqual({ section: "syncs", name: "github-state", before: { connection: "github", every: "15m" }, after: { connection: "github", every: "1h", raise: { assigned: false } } });
    expect((sync.payload.body as { after: { text: string } }).after.text).toContain("Checked: every 1h\nPaused: no (default)\nRaises assigned: off\n");
  });

  it("changes only when it runs: what runs, a sync's connection and a routine's config are never suggested", async () => {
    for (const [name, change] of [
      ["vendor-sweep", { actor: "someone-else" }],
      ["vendor-sweep", { task: "Do something else" }],
      ["vendor-sweep", { grants: { read: ["Areas"], write: ["Journal/Digest/"] } }],
      ["github-state", { connection: "other" }],
      ["standup", { config: { skip_without_calendar_event: true } }],
    ] as const) {
      const r = await build({ name, change: change as Record<string, unknown> });
      expect(r.ok, `${name} ${JSON.stringify(change)}`).toBe(false);
      expect(!r.ok && r.refusal.code).toBe("invalid_request");
    }
  });

  it("is never raised when Approve would be refused: an invalid schedule, nothing to change, a New Routine's reset, an unknown name", async () => {
    expect((await build({ name: "standup", change: { schedule: { every: "10m" } } })).ok).toBe(false);
    expect((await build({ name: "standup", change: { schedule: { days: "working_days", at: ["06:00"] } } })).ok).toBe(false);
    expect((await build({ name: "vendor-sweep", change: { schedule: null } })).ok).toBe(false);
    expect((await build({ name: "no-such-routine", change: { paused: true } })).ok).toBe(false);
    expect((await build({ name: "standup", change: { paused: true }, title: "  " })).ok).toBe(false);
    // a sync with no entry names no connection, and a suggestion never sets one
    await o.set("");
    expect((await build({ name: "github-state", change: { every: "1h" } })).ok).toBe(false);
  });

  it("is read back strictly — and a malformed one is still a suggestion, never another kind of improvement", async () => {
    const r = await build({ name: "standup", change: { paused: true } });
    if (!r.ok) throw new Error("built");
    const p = r.payload as Record<string, any>;
    const edit = p.scheduled_edit;
    expect(suggestionOf({ ...p, scheduled_edit: { ...edit, section: "agents" } })).toBeNull();
    expect(suggestionOf({ ...p, scheduled_edit: { ...edit, name: "../x" } })).toBeNull();
    expect(suggestionOf({ ...p, scheduled_edit: { ...edit, after: edit.before } })).toBeNull();
    expect(suggestionOf({ ...p, scheduled_edit: { ...edit, after: { ...edit.after, actor: "x" } } })).toBeNull();
    expect(suggestionOf({ ...p, body: { kind: "preview" } })).toBeNull();
    expect(carriesSuggestion({ scheduled_edit: null })).toBe(true);
    expect(carriesSuggestion({ suggested_edit: { content: "x" } })).toBe(false);
  });

  it("Approve writes exactly the after, through the Scheduled door, compare-and-swap — the owner's comments kept", async () => {
    const r = await build({ name: "standup", change: { schedule: WEEKDAYS_0830 } });
    if (!r.ok) throw new Error("built");
    const out = await applySuggestion(o.admin, suggestionOf(r.payload)!, 41);
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(o.writes).toHaveLength(1);
    expect(o.writes[0]!.message).toBe("scheduled: Standup, approved suggestion #41 (from Scheduled, as you)");
    const text = (await o.text())!;
    expect(text).toContain("# my changes — kept");
    expect(text).toContain('schedule: { days: [ mon, tue, wed, thu, fri ], at: [ "08:30" ] }');
    expect((await o.file()).routines?.["vendor-sweep"]).toMatchObject({ actor: "researcher" });
  });

  it("returning every field to its default removes the entry — Reset to Default, suggested", async () => {
    const r = await build({ name: "standup", change: { schedule: null } });
    if (!r.ok) throw new Error("built");
    expect(r.edit.after).toBeNull();
    expect(await applySuggestion(o.admin, suggestionOf(r.payload)!, 42)).toMatchObject({ ok: true });
    expect((await o.file()).routines).not.toHaveProperty("standup");
  });

  it("an entry that changed since is refused stale — nothing written", async () => {
    const r = await build({ name: "standup", change: { schedule: WEEKDAYS_0830 } });
    if (!r.ok) throw new Error("built");
    const moved = OWNER_FILE.replace('at: ["06:00"]', 'at: ["06:15"]');
    await o.set(moved);
    const out = await applySuggestion(o.admin, suggestionOf(r.payload)!, 43);
    expect(out).toMatchObject({ ok: false, refusal: { code: "conflict" } });
    expect(o.writes).toEqual([]);
    expect(await o.text()).toBe(moved);
  });

  it("words that are not what the entries draw are refused — Approve never writes something other than what was shown", async () => {
    const r = await build({ name: "standup", change: { schedule: WEEKDAYS_0830 } });
    if (!r.ok) throw new Error("built");
    const lying = { ...r.payload, body: { ...(r.payload.body as object), after: { label: "Suggested", text: "Schedule: working days at 06:00" } } };
    expect(await applySuggestion(o.admin, suggestionOf(lying)!, 44)).toMatchObject({ ok: false, refusal: { code: "conflict" } });
    expect(o.writes).toEqual([]);
  });

  it("a console that cannot write the overlay writes nothing, and says why", async () => {
    const r = await build({ name: "standup", change: { paused: true } });
    if (!r.ok) throw new Error("built");
    const readOnly: ScheduledAdmin = { ...o.admin, overlay: { read: o.admin.overlay.read, readOnly: "no vault bridge" } };
    expect(await applySuggestion(readOnly, suggestionOf(r.payload)!, 45)).toMatchObject({ ok: false, refusal: { code: "not_available", message: "no vault bridge" } });
    expect(await o.text()).toBe(OWNER_FILE);
  });
});

describe.skipIf(!hasDb)("routine suggestions at Needs You's Approve (integration)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  let captureToken: string;
  let agentToken: string;
  let inboxDir: string;
  let components: ScheduledCollector[];
  let o: ReturnType<typeof adminOver>;
  const localOwnerToken = mintToken();
  const MARK = `itest-suggest-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
  const SOURCE = MARK; // this suite's rows, by source_agent
  const agentId = MARK.slice(0, 40);
  let passkeyId: string;

  const answer = (id: number, decision: string, headers: Record<string, string> = { cookie }, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision, ...extra }) });
  const raise = async (change: Record<string, unknown> = { schedule: WEEKDAYS_0830 }, trust = "internal"): Promise<number> => {
    const r = suggestionPayload(components.map(unitOf), await o.file(), { name: "standup", change, title: "Draft standup at 8:30 instead of 6:00?" });
    if (!r.ok) throw new Error(r.refusal.message);
    const { rows } = await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('improvement', $1, $2, $3::jsonb) RETURNING id`, [SOURCE, trust, JSON.stringify(r.payload)]);
    return Number(rows[0].id);
  };
  const row = async (id: number) => (await pool.query(`SELECT decision, payload FROM proposals WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    components = await loadComponents();
    o = adminOver(components);
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-suggest-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      scheduled: o.admin,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    passkeyId = `${MARK}-pk`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    cookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest suggest" })).token;
  });

  beforeEach(async () => {
    await o.set(OWNER_FILE);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [SOURCE]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(inboxDir, { recursive: true, force: true });
  });

  it("**nothing is written before Approve**: raising, Later, Revise and Decline leave the file as it was", async () => {
    const later = await raise();
    expect((await answer(later, "later")).status).toBe(200);
    const revise = await raise();
    expect((await answer(revise, "accept_with_changes", { cookie }, { feedback: "9:00, not 8:30" })).status).toBe(200);
    const decline = await raise();
    expect((await answer(decline, "deny")).status).toBe(200);
    expect(o.writes).toEqual([]);
    expect(await o.text()).toBe(OWNER_FILE);
    expect((await row(revise)).decision).toBe("accept_with_changes");
    expect((await row(decline)).decision).toBe("deny");
  });

  it("misuse (U2): Approve is the owner's — 401 bare, 403 for an agent bearer and the capture token, and none of them writes", async () => {
    const id = await raise();
    expect((await answer(id, "allow", {})).status).toBe(401);
    expect((await answer(id, "allow", { authorization: `Bearer ${agentToken}` })).status).toBe(403);
    expect((await answer(id, "allow", { authorization: `Bearer ${captureToken}` })).status).toBe(403);
    expect(o.writes).toEqual([]);
    expect((await row(id)).decision).toBe("pending");
    const local = await answer(id, "allow", { authorization: `Bearer ${localOwnerToken}` });
    expect(local.status).toBe(200);
    expect(o.writes).toHaveLength(1);
  });

  it("Approve from a passkey session writes the after through the Scheduled door as you, and records it", async () => {
    const id = await raise();
    const r = await answer(id, "allow");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, scheduled: { section: "routines", name: "standup", path: SCHEDULED_PATH } });
    expect((await o.file()).routines?.standup).toEqual({ schedule: WEEKDAYS_0830 });
    expect(o.writes.map((w) => w.message)).toEqual([`scheduled: Standup, approved suggestion #${id} (from Scheduled, as you)`]);
    const settled = await row(id);
    expect(settled.decision).toBe("allow");
    expect(settled.payload.scheduled_applied).toMatchObject({ section: "routines", name: "standup", by: "user" });
    const { rows } = await pool.query(`SELECT meta FROM runs WHERE component = 'console' AND kind = 'scheduled' AND tool = 'suggestion' AND meta->>'proposal' = $1`, [String(id)]);
    expect(rows).toHaveLength(1);
  });

  it("an entry that changed since is refused 409 stale — nothing written, the request still waiting", async () => {
    const id = await raise();
    const moved = OWNER_FILE.replace('at: ["06:00"]', 'at: ["06:15"]');
    await o.set(moved);
    const r = await answer(id, "allow");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "conflict" }, reason: "stale", decision: "pending" });
    expect(o.writes).toEqual([]);
    expect(await o.text()).toBe(moved);
    expect((await row(id)).decision).toBe("pending");
  });

  it("an agent's request changes nothing, and a malformed one is never read as a prompt improvement", async () => {
    const external = await raise({ paused: true }, "external");
    expect((await answer(external, "allow")).status).toBe(400);
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('improvement', $1, 'internal', $2::jsonb) RETURNING id`,
      [SOURCE, JSON.stringify({ title: "x", scheduled_edit: { section: "routines", name: "standup", before: null, after: { actor: "x" } }, suggested_edit: { content: "## injected" } })],
    );
    const malformed = await answer(Number(rows[0].id), "allow");
    expect(malformed.status).toBe(400);
    expect(o.writes).toEqual([]);
    expect(await o.text()).toBe(OWNER_FILE);
    expect((await row(external)).decision).toBe("pending");
  });
});
