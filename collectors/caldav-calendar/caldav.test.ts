// The CalDAV sync (design-build-plan §2.6, T4-13): a local CalDAV fixture
// server (packages/connections/test/caldav-server.ts — 127.0.0.1, an
// ephemeral port, never a real service) read through the console's own
// opener into `calendar_events`, the app password filled at the egress door.
// The window-replacement SQL is the eventkit sync's (`replaceCalendarWindow`),
// proven there and again here against the scratch database — and a reply
// through the provider shows up as the owner's answer on the next pass.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadKind } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { instanceSyncOpener, openSyncHttp, previewReply, respondToInvitation, loadInstanceCatalog, envSecretSource, type SyncOpener } from "@foldedspacelabs/metistry-connections";
import { ALL_EVENTS, INVITE_BODY } from "../../packages/connections/test/caldav-fixtures.js";
import { fakeCaldav, type FakeCaldav } from "../../packages/connections/test/caldav-server.js";
import { run } from "./run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));
/** Monday 28 September 2026, noon in New York. */
const NOW = Date.parse("2026-09-28T16:00:00Z");
const ZONE = "America/New_York";
const USER = "me@example.com";
// an app password's shape; built at run time so no key-shaped literal is in the tree
const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join("-");
const ENV = { METISTRY_SECRET_CALDAV_PASSWORD: PASSWORD };

const connectionYaml = (name: string, url: string) =>
  `name: ${name}\ntype: calendar\nprovider: caldav\nreach:\n  http:\n    url: ${url}\n    auth: { scheme: basic, username: ${USER}, secret: caldav_password }\nsecrets: [caldav_password]\n`;
const secretsYaml = (host: string, name: string) => `secrets:\n  caldav_password:\n    hosts: ["${host}"]\n    grants: { "connection:${name}": on }\n`;

/** A scratch instance under os.tmpdir() with the given `.metistry/` files. */
function instance(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-caldav-"));
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, ".metistry", rel), text);
  return dir;
}

function calendarInstance(s: FakeCaldav, name = "calendar"): string {
  return instance({ [`connections/${name}.yaml`]: connectionYaml(name, s.url), "secrets.yaml": secretsYaml(s.host, name) });
}

function opener(dir: string): SyncOpener {
  return instanceSyncOpener({ instanceDir: dir, seedDir: SEED_DIR, extensions: false, env: ENV });
}

/** Records every statement; answers the window replacement with counts. */
function fakeDb() {
  const q: { text: string; values: unknown[] }[] = [];
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (/INSERT INTO calendar_events/.test(text)) return { rows: [{ upserted: (JSON.parse(String(values[1])) as unknown[]).length, removed: 0 }] };
      return { rows: [] };
    },
  };
}

const writtenRows = (db: ReturnType<typeof fakeDb>) => JSON.parse(String(db.q.find((x) => /INSERT INTO calendar_events/.test(x.text))?.values[1] ?? "[]")) as Record<string, unknown>[];

const servers: FakeCaldav[] = [];
async function server(opts: Partial<Parameters<typeof fakeCaldav>[0]> = {}): Promise<FakeCaldav> {
  const s = await fakeCaldav({ username: USER, password: PASSWORD, events: ALL_EVENTS, ...opts });
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("the caldav-calendar collector's manifest", () => {
  it("loads through the collector registry as a sync every 15 minutes", async () => {
    const reg = await loadKind("collector", { productDir: fileURLToPath(new URL("../..", import.meta.url)) });
    const m = reg.get("caldav-calendar")?.manifest;
    expect(m, JSON.stringify(reg.skipped)).toMatchObject({ name: "caldav-calendar", display_name: "CalDAV Calendar", schedule: { every: "15m" }, writes: ["calendar_events", "sync_state", "proposals"] });
    expect(m?.type === "collector" ? m.needs_you : null).toEqual({ invitation: { label: "A meeting invitation waits on your answer", default: true } });
  });
});

describe("caldav-calendar run — degrades absent", () => {
  it("no opener (no instance) is 0 and no statement", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("no CalDAV connection yet is 0, no statement, nothing sent", async () => {
    const s = await server();
    const db = fakeDb();
    expect(await run(db, { openSync: opener(instance({})) })).toBe(0);
    expect(db.q).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
  });
});

describe("caldav-calendar run — the account", () => {
  it("writes every occurrence in the window under the connection's name, the owner's answer as self_status, never an invite body", async () => {
    const s = await server();
    const db = fakeDb();
    const n = await run(db, { openSync: opener(calendarInstance(s)), ownerTimeZone: ZONE, now: () => NOW });
    const rows = writtenRows(db);
    expect(n).toBe(rows.length);
    expect(rows.map((r) => [r.event_id, r.starts_at, r.self_status])).toEqual([
      ["standup-7f3a@example.com_20260928T133000Z", "2026-09-28T13:30:00.000Z", "pending"],
      ["vendor-review-0929@example.com", "2026-09-29T18:00:00.000Z", "pending"],
      ["standup-7f3a@example.com_20260930T133000Z", "2026-09-30T15:30:00.000Z", "pending"],
      ["dentist-1@example.com", "2026-09-30T17:00:00.000Z", null],
      ["planning-2@example.com", "2026-10-01T15:00:00.000Z", "accepted"],
      ["standup-7f3a@example.com_20261002T133000Z", "2026-10-02T13:30:00.000Z", "pending"],
      ["offsite-3@example.com", "2026-10-02T15:00:00.000Z", "pending"],
      ["their-4@example.com", "2026-10-03T15:00:00.000Z", null],
      ["standup-7f3a@example.com_20261005T133000Z", "2026-10-05T13:30:00.000Z", "pending"],
      ["standup-7f3a@example.com_20261007T133000Z", "2026-10-07T13:30:00.000Z", "pending"],
      ["standup-7f3a@example.com_20261009T133000Z", "2026-10-09T13:30:00.000Z", "pending"],
    ]);
    const vendor = rows.find((r) => r.event_id === "vendor-review-0929@example.com")!;
    expect(vendor).toMatchObject({ organizer: "dana@example.com", location: "Room 4, second floor" });
    expect((vendor.attendees as { email: string; self: boolean }[]).filter((a) => a.self).map((a) => a.email)).toEqual(["me@example.com"]);
    expect(JSON.stringify(db.q.map((x) => x.values))).not.toContain(INVITE_BODY);
    expect(JSON.stringify(db.q.map((x) => x.values))).not.toContain(PASSWORD);
    const state = db.q.find((x) => /INSERT INTO sync_state/.test(x.text))!;
    expect(state.values[0]).toBe("calendar");
    expect(Object.fromEntries((state.values[1] as string[]).map((k, i) => [k, (state.values[2] as string[])[i]]))).toMatchObject({
      window_start: "2026-09-28T04:00:00.000Z",
      window_end: "2026-10-12T04:00:00.000Z",
      events: String(rows.length),
      calendars: "1",
      resources: "6",
      scheduling: "true",
    });
  });

  it("**a calendar home on another origin fails the run naming it — nothing is sent there, nothing is written**", async () => {
    const elsewhere = await server();
    const s = await server({ homeOrigin: elsewhere.origin });
    const db = fakeDb();
    await expect(run(db, { openSync: opener(calendarInstance(s)), now: () => NOW })).rejects.toThrow(new RegExp(`keeps this account at ${elsewhere.origin.replace(/[.]/g, "\\.")}`));
    expect(elsewhere.requests).toHaveLength(0);
    expect(db.q).toHaveLength(0);
  });

  it("**a Google CalDAV connection is never read** — the file is refused (Google needs sign-in with Google), so nothing is sent or written", async () => {
    const db = fakeDb();
    const sent: string[] = [];
    const dir = instance({ "connections/calendar.yaml": connectionYaml("calendar", "https://apidata.googleusercontent.com/caldav/v2/me/events"), "secrets.yaml": secretsYaml("apidata.googleusercontent.com", "calendar") });
    const spy = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    expect(await run(db, { openSync: instanceSyncOpener({ instanceDir: dir, seedDir: SEED_DIR, extensions: false, env: ENV, fetch: spy }), now: () => NOW })).toBe(0);
    expect(sent).toHaveLength(0);
    expect(db.q).toHaveLength(0);
    const catalog = await loadInstanceCatalog({ instanceDir: dir, seedDir: SEED_DIR, extensions: false });
    expect(catalog.entries[0]).toMatchObject({ status: "failed", issues: [expect.stringContaining("Google needs sign-in with Google")] });
  });
});

describe.skipIf(!hasDb)("the caldav sync (real db)", () => {
  let pool: pg.Pool;
  const CONN = `itest-caldav-${process.pid}`;
  const clean = async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [CONN]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [CONN]);
    await pool.query(`DELETE FROM proposals WHERE kind = 'invitation' AND payload->>'connection' = $1`, [CONN]);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("writes once, a second identical pass changes nothing — and a reply shows as the owner's answer on the next pass", async () => {
    const s = await server();
    const dir = calendarInstance(s, CONN);
    const ctx = { openSync: opener(dir), ownerTimeZone: ZONE, now: () => NOW };
    const first = await run(pool, ctx);
    expect(first).toBeGreaterThan(0);
    expect(await run(pool, ctx)).toBe(0);
    const status = async () => (await pool.query(`SELECT self_status FROM calendar_events WHERE connection = $1 AND event_id = 'vendor-review-0929@example.com'`, [CONN])).rows[0]?.self_status;
    expect(await status()).toBe("pending");

    // the owner accepts through the provider (what T4-17's door will call), with the same door the sync uses
    const catalog = await loadInstanceCatalog({ instanceDir: dir, seedDir: SEED_DIR, extensions: false });
    const opened = openSyncHttp({ catalog, sync: "caldav-calendar", module: "caldav", secrets: envSecretSource(ENV) });
    if (!opened.ok) throw new Error(opened.why);
    const preview = await previewReply(opened.sync, { uid: "vendor-review-0929@example.com", response: "accepted" });
    await respondToInvitation(opened.sync, { uid: "vendor-review-0929@example.com", response: "accepted", etag: preview.etag });
    expect(s.replies).toEqual([{ uid: "vendor-review-0929@example.com", partstat: "ACCEPTED", to: "dana@example.com" }]);

    // the invitation's request (T4-17) clears when the source changes: one row changed, one request cleared
    const mirror = async () =>
      (await pool.query(`SELECT decision, payload->'cleared' AS cleared FROM proposals WHERE kind = 'invitation' AND source->>'external_ref' = 'invite:uid/vendor-review-0929@example.com' AND payload->>'connection' = $1`, [CONN])).rows;
    expect(await mirror()).toEqual([{ decision: "pending", cleared: null }]);
    expect(await run(pool, ctx)).toBe(2);
    expect(await status()).toBe("accepted");
    expect(await mirror()).toEqual([{ decision: "resolved_at_source", cleared: { what: "You accepted it in your calendar", where: "calendar" } }]);
    expect(JSON.stringify((await pool.query(`SELECT * FROM calendar_events WHERE connection = $1`, [CONN])).rows)).not.toContain(INVITE_BODY);
  });
});
