// X-32 — a push carries Needs You only, and no text (screen 18 §6).
//
// The notifier used to push every `outbound_messages` row — a reply, an ack,
// a brief, an alert — with 160 characters of its text as `body` and `url: "/"`.
// The worker (sw.js, T7-5) never showed the body, but the text still left the
// console for the push service. Now the source sends only for a request that
// has come to need the owner, and what it sends is `type`, `title` and the
// card's link — the JSON handed to web-push is read back here, byte for byte.
//
// The ticket's bold tests, by name: **an outbound message never pushes** and
// **a Needs You push carries type, title and its card's url and nothing
// else** — plus a key-shaped request title never reaching the wire, a snooze
// running out pushing again, a meeting's rows pushing once, a burst coalescing,
// and an unknown kind reading as a report rather than as itself.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { looksLikeKey, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

// What web-push was handed: the subscription's endpoint and the exact bytes.
const wire = vi.hoisted(() => [] as { endpoint: string; body: string }[]);
vi.mock("web-push", () => ({
  default: {
    sendNotification: vi.fn(async (sub: { endpoint: string }, body: string) => {
      wire.push({ endpoint: sub.endpoint, body });
      return { statusCode: 201 };
    }),
  },
}));

import {
  NEEDS_YOU_BURST,
  NEEDS_YOU_TITLE,
  needsYouNotifier,
  needsYouPayload,
  sendToAll,
  startNotifier,
  wirePayload,
  type PushConfig,
  type PushPayload,
} from "../src/push.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const cfg: PushConfig = { publicKey: "test", privateKey: "test", subject: "mailto:test@example.com" };

// Assembled, not written whole, so no secret scanner mistakes a fake for a leak.
const KEY = ["sk-", "ant-api03-", "Zx9Qw8Er7Ty6Ui5Op4As3Df2"].join("");

describe("the payload a push carries (X-32)", () => {
  it("a request's push is its type in the table's words, the fixed title and its card — nothing from the row but its id and kind", () => {
    expect(needsYouPayload({ id: 42, kind: "decision" })).toEqual({ type: "Question", title: NEEDS_YOU_TITLE, url: "/#/needs-you/42" });
    expect(needsYouPayload({ id: "7", kind: "pull_request" })).toEqual({ type: "Pull Request", title: "Needs You", url: "/#/needs-you/7" });
  });

  it("an unknown kind reads as a report, never as itself — a kind is a column anyone raising a row writes", () => {
    const p = needsYouPayload({ id: 9, kind: `x32 ${KEY}` })!;
    expect(p.type).toBe("Report");
    expect(JSON.stringify(p)).not.toContain(KEY.slice(0, 12));
  });

  it("no link is made from an id that is not a row id", () => {
    for (const id of ["0", "-1", "1/../../evil", "abc", "", "12345678901234567890"]) expect(needsYouPayload({ id, kind: "decision" })).toBeNull();
  });

  it("the wire copies type, title and url and no other field — a body cast past the type is dropped", () => {
    const smuggled = { type: "Question", title: "Needs You", url: "/#/needs-you/1", body: `the key is ${KEY}`, actions: [{ action: "yes" }], image: "/x.png" } as unknown as PushPayload;
    expect(JSON.parse(wirePayload(smuggled))).toEqual({ type: "Question", title: "Needs You", url: "/#/needs-you/1" });
    expect(wirePayload(smuggled)).not.toContain("body");
    expect(JSON.parse(wirePayload({ title: "Needs You", url: "/#/needs-you" }))).toEqual({ title: "Needs You", url: "/#/needs-you" });
  });
});

describe.skipIf(!hasDb)("Needs You's notifier (integration, X-32)", () => {
  let pool: pg.Pool;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const MARK = `x32-${suffix}`;
  const endpoint = `https://push.example/x32-${suffix}`;
  let sessionId: number;

  /** What reached this test's subscription, parsed. */
  const mine = () => wire.filter((w) => w.endpoint === endpoint);
  const parsed = () => mine().map((w) => JSON.parse(w.body) as Record<string, unknown>);
  const pass = () => needsYouNotifier(pool, (p) => sendToAll(pool, cfg, p));

  async function raise(kind: string, payload: Record<string, unknown>, extra: { snoozed_until?: string; group_id?: string } = {}): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, snoozed_until, group_id)
       VALUES ($1, $2, 'internal', $3::jsonb, $4::timestamptz, $5) RETURNING id`,
      [kind, `x32-agent-${suffix}`, JSON.stringify(payload), extra.snoozed_until ?? null, extra.group_id ?? null],
    );
    return Number(rows[0].id);
  }

  async function outbound(kind: string, text: string): Promise<void> {
    await pool.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ($1, $2, $3)`, [`x32-${suffix}`, text, kind]);
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const passkey = `x32-passkey-${suffix}`;
    await pool.query(`INSERT INTO passkeys (id, public_key, rp_origin, label) VALUES ($1, $2, 'https://console.example.test', 'x32 phone')`, [passkey, Buffer.from([1])]);
    const { rows } = await pool.query(
      `INSERT INTO auth_sessions (token_hash, passkey_id, absolute_expires_at, push_subscription)
       VALUES ($1, $2, now() + interval '1 day', $3::jsonb) RETURNING id`,
      [`x32-${mintToken(16)}`, passkey, JSON.stringify({ endpoint, keys: { p256dh: "a", auth: "b" } })],
    );
    sessionId = Number(rows[0].id);
  });

  afterAll(async () => {
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE source_agent = $1 AND decision = 'pending'`, [`x32-agent-${suffix}`]);
    await pool.query(`UPDATE auth_sessions SET push_subscription = NULL, revoked_at = now() WHERE id = $1`, [sessionId]);
    await pool.end();
  });

  it("an outbound message never pushes; a Needs You request pushes once, carrying type, title and its card's url and nothing else", async () => {
    wire.length = 0;
    const timer = startNotifier(pool, cfg, 40);
    try {
      await new Promise((r) => setTimeout(r, 200)); // the first pass learns the queue as it stands
      for (const kind of ["reply", "ack", "brief", "review", "alert"]) await outbound(kind, `${MARK} ${kind}: here is the key you asked for ${KEY}`);
      const id = await raise("decision", { title: `${MARK} Rotate ${KEY} before Friday?`, options: ["Yes", "No"] });
      const deadline = Date.now() + 5000;
      while (!parsed().some((p) => p.url === `/#/needs-you/${id}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
      await new Promise((r) => setTimeout(r, 200)); // more passes: nothing else follows
      expect(parsed()).toEqual([{ type: "Question", title: "Needs You", url: `/#/needs-you/${id}` }]);
      for (const w of mine()) {
        expect(w.body).not.toContain("body");
        expect(w.body).not.toContain(MARK);
        expect(w.body).not.toContain(KEY.slice(0, 12));
        expect(looksLikeKey(w.body)).toBe(false);
      }
    } finally {
      clearInterval(timer);
    }
  });

  it("a key-shaped request title never reaches the wire, from the title, the classification or the kind", async () => {
    wire.length = 0;
    const next = pass();
    await next();
    await raise("report", { title: `${MARK} token ${KEY}`, classification: { title: KEY, action: `paste ${KEY}` }, body: KEY });
    await raise(`x32-${KEY}`, { title: KEY });
    expect(await next()).toBe(2);
    expect(mine()).toHaveLength(2);
    for (const w of mine()) {
      expect(w.body).not.toContain(KEY.slice(0, 12));
      expect(w.body).not.toContain(MARK);
      expect(Object.keys(JSON.parse(w.body)).sort()).toEqual(["title", "type", "url"]);
    }
    expect(parsed().map((p) => p.type)).toEqual(["Report", "Report"]);
  });

  it("a request whose Later runs out needs the owner again, and pushes again", async () => {
    wire.length = 0;
    const id = await raise("decision", { title: "later" }, { snoozed_until: new Date(Date.now() + 3_600_000).toISOString() });
    const next = pass();
    await next();
    expect(await next()).toBe(0); // put down: not showing, not pushed
    await pool.query(`UPDATE proposals SET snoozed_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await next()).toBe(1);
    expect(await next()).toBe(0); // once
    expect(parsed()).toEqual([{ type: "Question", title: "Needs You", url: `/#/needs-you/${id}` }]);
  });

  it("a meeting's rows are one card and push once; a burst is one push for the queue", async () => {
    wire.length = 0;
    const next = pass();
    await next();
    const group = `x32-meeting-${suffix}`;
    const first = await raise("knowledge", { title: "note 1" }, { group_id: group });
    await raise("knowledge", { title: "note 2" }, { group_id: group });
    await raise("task", { title: "to-do" }, { group_id: group });
    expect(await next()).toBe(1);
    expect(parsed()).toEqual([{ type: "Note", title: "Needs You", url: `/#/needs-you/${first}` }]);
    await raise("knowledge", { title: "note 3, raised later" }, { group_id: group });
    expect(await next()).toBe(0); // the meeting's card is already there

    wire.length = 0;
    for (let i = 0; i <= NEEDS_YOU_BURST; i++) await raise("decision", { title: `burst ${i}` });
    expect(await next()).toBe(1);
    expect(parsed()).toEqual([{ title: "Needs You", url: "/#/needs-you" }]);
  });
});
