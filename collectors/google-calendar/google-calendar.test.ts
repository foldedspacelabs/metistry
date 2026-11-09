// The Google Calendar sync (design-build-plan §2.6, T4-14): the fixture Google
// (packages/connections/test/google-server.ts — 127.0.0.1, an ephemeral port,
// never Google) read through the console's own opener into
// `calendar_events`, the access token minted from the owner's sign-in and
// filled at the egress door. The window-replacement SQL is the eventkit
// sync's (`replaceCalendarWindow`), proven there and again here against the
// scratch database — and a reply through the provider shows up as the
// owner's answer on the next pass.
//
// The product's seed ships no client id until the maintainer's client exists
// (§3.4), so the instance here signs in with the owner's own — the path an
// owner has today.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { SecretRedactor, loadKind, parseSecretsFile } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import {
  GOOGLE_CALENDAR_ORIGIN,
  GOOGLE_TOKEN_HOSTS,
  authorizeConnection,
  envSecretSource,
  instanceSyncOpener,
  loadInstanceCatalog,
  openSyncHttp,
  previewGoogleReply,
  respondToGoogleInvitation,
  type SyncOpener,
} from "@foldedspacelabs/metistry-connections";
import { INVITE, INVITE_BODY } from "../../packages/connections/test/google-fixtures.js";
import { fakeGoogle, type FakeGoogle } from "../../packages/connections/test/google-server.js";
import { run } from "./run.js";
import { calendarRsvpOpener, confirmInvitationReply, previewInvitationReply } from "../invitations.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));
/** Monday 28 September 2026, noon in New York. */
const NOW = Date.parse("2026-09-28T16:00:00Z");
const ZONE = "America/New_York";
const CLIENT = "5678-own.apps.googleusercontent.com";

const connectionYaml = (name: string) =>
  `name: ${name}\ntype: calendar\nprovider: google-calendar\nreach:\n  http:\n    url: https://www.googleapis.com/calendar/v3/\n    auth: oauth\nconfig:\n  google:\n    token: "{{ secret.google_oauth_token }}"\n    client_id: "{{ secret.google_client_id }}"\nsecrets: [google_oauth_token, google_client_id]\n`;
const secretsYaml = (name: string, tokenHosts: readonly string[] = GOOGLE_TOKEN_HOSTS) =>
  `secrets:\n  google_oauth_token:\n    hosts: [${tokenHosts.join(", ")}]\n    grants: { "connection:${name}": on }\n  google_client_id:\n    hosts: [accounts.google.com, oauth2.googleapis.com]\n    grants: { "connection:${name}": on }\n`;

/** A scratch instance under os.tmpdir() with the given `.metistry/` files. */
function instance(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-google-calendar-"));
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, ".metistry", rel), text);
  return dir;
}

const googles: FakeGoogle[] = [];
afterEach(async () => {
  await Promise.all(googles.splice(0).map((g) => g.close()));
});

/** A signed-in Google connection: the instance, and the environment `metistry secrets sync --to env` would deliver. */
async function signedIn(name = "google", tokenHosts?: readonly string[]): Promise<{ g: FakeGoogle; dir: string; env: Record<string, string> }> {
  const g = await fakeGoogle({ clients: [CLIENT] });
  googles.push(g);
  const dir = instance({ [`connections/${name}.yaml`]: connectionYaml(name), "secrets.yaml": secretsYaml(name, tokenHosts) });
  const catalog = await loadInstanceCatalog({ instanceDir: dir, seedDir: SEED_DIR, extensions: false });
  const entry = catalog.entries[0]!;
  expect(entry.status, entry.issues.join("; ")).toBe("ok");
  const kept = new Map<string, string>();
  await authorizeConnection(entry, {
    secrets: parseSecretsFile(secretsYaml(name)),
    source: { value: async (n) => (n === "google_client_id" ? CLIENT : undefined) },
    redactor: new SecretRedactor(),
    fetch: g.routeTo(),
    store: { set: async (n, v) => void kept.set(n, v) },
    open: (url) => void g.browse(url),
  });
  return { g, dir, env: { METISTRY_SECRET_GOOGLE_OAUTH_TOKEN: kept.get("google_oauth_token")!, METISTRY_SECRET_GOOGLE_CLIENT_ID: CLIENT } };
}

function opener(s: { g: FakeGoogle; dir: string; env: Record<string, string> }): SyncOpener {
  return instanceSyncOpener({ instanceDir: s.dir, seedDir: SEED_DIR, extensions: false, env: s.env, fetch: s.g.routeTo() });
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

describe("the google-calendar collector's manifest", () => {
  it("loads through the collector registry as a sync every 15 minutes", async () => {
    const reg = await loadKind("collector", { productDir: fileURLToPath(new URL("../..", import.meta.url)) });
    const m = reg.get("google-calendar")?.manifest;
    expect(m, JSON.stringify(reg.skipped)).toMatchObject({ name: "google-calendar", display_name: "Google Calendar", schedule: { every: "15m" }, writes: ["calendar_events", "sync_state", "proposals"] });
    expect(m?.type === "collector" ? m.needs_you : null).toEqual({ invitation: { label: "A meeting invitation waits on your answer", default: true } });
  });
});

describe("google-calendar run — degrades absent", () => {
  it("no opener (no instance) is 0 and no statement", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("no Google Calendar connection yet is 0, no statement, nothing sent", async () => {
    const g = await fakeGoogle();
    googles.push(g);
    const db = fakeDb();
    expect(await run(db, { openSync: instanceSyncOpener({ instanceDir: instance({}), seedDir: SEED_DIR, extensions: false, env: {}, fetch: g.routeTo() }) })).toBe(0);
    expect(db.q).toHaveLength(0);
    expect(g.api).toHaveLength(0);
  });
});

describe("google-calendar run — the owner's primary calendar", () => {
  it("writes every occurrence in the window under the connection's name, the owner's answer as self_status, never the description", async () => {
    const s = await signedIn();
    const db = fakeDb();
    const n = await run(db, { openSync: opener(s), ownerTimeZone: ZONE, now: () => NOW });
    const rows = writtenRows(db);
    expect(n).toBe(rows.length);
    expect(rows.map((r) => [r.event_id, r.starts_at, r.all_day, r.self_status])).toEqual([
      ["stand0up0series00001_20260928T133000Z", "2026-09-28T13:30:00.000Z", false, "accepted"],
      ["inv0design0review0001", "2026-09-28T14:00:00.000Z", false, "pending"],
      ["own0focus0block00001", "2026-09-28T18:00:00.000Z", false, null],
      ["host0one0on0one00001", "2026-09-29T20:00:00.000Z", false, "accepted"],
      ["off0site0all0day0001", "2026-09-30T04:00:00.000Z", true, null],
    ]);
    const invite = rows.find((r) => r.event_id === INVITE.id)!;
    expect(invite).toMatchObject({ organizer: "alice@example.com", location: "Room 4", title: "Design review", ical_uid: "inv0design0review0001@google.com" });
    expect((invite.attendees as { email: string; self: boolean }[]).filter((a) => a.self).map((a) => a.email)).toEqual(["me@example.com"]);
    const written = JSON.stringify(db.q.map((x) => x.values));
    expect(written).not.toContain(INVITE_BODY);
    expect(written).not.toContain(s.env.METISTRY_SECRET_GOOGLE_OAUTH_TOKEN);
    const state = db.q.find((x) => /INSERT INTO sync_state/.test(x.text))!;
    expect(state.values[0]).toBe("google");
    expect(Object.fromEntries((state.values[1] as string[]).map((k, i) => [k, (state.values[2] as string[])[i]]))).toEqual({
      window_start: "2026-09-28T04:00:00.000Z",
      window_end: "2026-10-12T04:00:00.000Z",
      events: "5",
      pages: "2",
      cancelled: "1",
      working_location: "1",
      unreadable: "0",
    });
  });

  it("**a sign-in whose token may go anywhere but the token endpoint and the Calendar API is never used** — the run fails naming the hosts; nothing is sent or written", async () => {
    const s = await signedIn("google", [...GOOGLE_TOKEN_HOSTS, "evil.example.test"]);
    const tokenRequests = s.g.auth.tokenRequests.length;
    const db = fakeDb();
    await expect(run(db, { openSync: opener(s), now: () => NOW })).rejects.toThrow(/is sent to exactly oauth2\.googleapis\.com and www\.googleapis\.com/);
    expect(s.g.api).toHaveLength(0);
    expect(s.g.auth.tokenRequests).toHaveLength(tokenRequests);
    expect(db.q).toHaveLength(0);
  });

  it("a connection pointed at another host is refused at the file — the sync reads nothing", async () => {
    const g = await fakeGoogle();
    googles.push(g);
    const dir = instance({ "connections/google.yaml": connectionYaml("google").replace("https://www.googleapis.com/calendar/v3/", "https://calendar.example.test/calendar/v3/"), "secrets.yaml": secretsYaml("google") });
    const db = fakeDb();
    expect(await run(db, { openSync: instanceSyncOpener({ instanceDir: dir, seedDir: SEED_DIR, extensions: false, env: {}, fetch: g.routeTo() }), now: () => NOW })).toBe(0);
    expect(g.api).toHaveLength(0);
    const catalog = await loadInstanceCatalog({ instanceDir: dir, seedDir: SEED_DIR, extensions: false });
    expect(catalog.entries[0]).toMatchObject({ status: "failed", issues: [expect.stringContaining(`reached at ${GOOGLE_CALENDAR_ORIGIN}/calendar/v3/ and nowhere else`)] });
  });
});

describe.skipIf(!hasDb)("the google-calendar sync (real db)", () => {
  let pool: pg.Pool;
  const CONN = `itest-google-${process.pid}`;
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
    const s = await signedIn(CONN);
    const ctx = { openSync: opener(s), ownerTimeZone: ZONE, now: () => NOW };
    expect(await run(pool, ctx)).toBe(5);
    expect(await run(pool, ctx)).toBe(0);
    const status = async () => (await pool.query(`SELECT self_status FROM calendar_events WHERE connection = $1 AND event_id = $2`, [CONN, INVITE.id])).rows[0]?.self_status;
    expect(await status()).toBe("pending");

    // the owner accepts through the provider (what T4-17's door will call), with the same door the sync uses
    const catalog = await loadInstanceCatalog({ instanceDir: s.dir, seedDir: SEED_DIR, extensions: false });
    const opened = openSyncHttp({ catalog, sync: "google-calendar", origin: GOOGLE_CALENDAR_ORIGIN, module: "google-calendar", tokenHosts: GOOGLE_TOKEN_HOSTS, secrets: envSecretSource(s.env), fetch: s.g.routeTo() });
    if (!opened.ok) throw new Error(opened.why);
    const preview = await previewGoogleReply(opened.sync, { event_id: String(INVITE.id), response: "accepted" });
    await respondToGoogleInvitation(opened.sync, { event_id: String(INVITE.id), response: "accepted", etag: preview.etag });

    expect(await run(pool, ctx)).toBe(1);
    expect(await status()).toBe("accepted");
    expect(JSON.stringify((await pool.query(`SELECT * FROM calendar_events WHERE connection = $1`, [CONN])).rows)).not.toContain(INVITE_BODY);
  });

  it("raises the invitation, and Respond (T4-17) answers it through Google — the owner's own responseStatus — and clears it", async () => {
    const s = await signedIn(CONN);
    const early = Date.parse("2026-09-28T12:00:00Z"); // before the design review starts
    await run(pool, { openSync: opener(s), ownerTimeZone: ZONE, now: () => early });
    const mirror = async () =>
      (await pool.query(`SELECT decision, payload->'cleared' AS cleared, payload->>'rsvp' AS rsvp FROM proposals WHERE kind = 'invitation' AND source->>'external_ref' = $1 AND payload->>'connection' = $2`, [`invite:uid/${INVITE.iCalUID}`, CONN])).rows;
    expect(await mirror()).toEqual([{ decision: "pending", cleared: null, rsvp: "true" }]);

    const open = calendarRsvpOpener({ instanceDir: s.dir, seedDir: SEED_DIR, extensions: false, env: s.env, fetch: s.g.routeTo() });
    const p = await previewInvitationReply(pool, open, { event_id: String(INVITE.id), response: "declined" });
    expect(p).toMatchObject({ connection: CONN, title: "Design review", organizer: "alice@example.com", response: "declined", unchanged: false });
    expect(p.binding.target).toBe(String(INVITE.id));
    const done = await confirmInvitationReply(pool, open, p.binding);
    expect(done.cleared).toHaveLength(1);
    expect(await mirror()).toEqual([{ decision: "resolved_at_source", cleared: { what: "You declined — the reply went to the organizer", where: "calendar" }, rsvp: "true" }]);
    expect((await pool.query(`SELECT self_status FROM calendar_events WHERE connection = $1 AND event_id = $2`, [CONN, INVITE.id])).rows).toEqual([{ self_status: "declined" }]);
  });
});
