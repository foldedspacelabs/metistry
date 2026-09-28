// T4-12's acceptance: **Today reads one table for every source.** An ICS
// feed, synced by the product's own `ics-calendar` code (found by name, as
// the runner finds it), lands in `calendar_events` beside another source's
// rows, and `day_events` — the named query `GET /api/today` composes — serves
// both in one day, in one order, with no question of which calendar a
// meeting came from. The feed is the recorded fixture
// (collectors/ics-calendar/fixtures/work.ics); nothing reads a real calendar.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { instanceSyncOpener } from "@foldedspacelabs/metistry-connections";
import { collectorCode } from "@metistry-apps/collectors";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const SEED = fileURLToPath(new URL("../../../seed", import.meta.url));
const FEED = readFileSync(new URL("../../../collectors/ics-calendar/fixtures/work.ics", import.meta.url), "utf8");
const code = await collectorCode("ics-calendar"); // the registry's lookup: the product's code, by name
if (typeof code !== "function") throw new Error(code.missing);
const syncIcs = code;

describe.skipIf(!hasDb)("Today reads one table for every source (T4-12)", () => {
  let pool: pg.Pool;
  let store: QueryStore;
  const tag = `t412${process.pid}`;
  const ics = `${tag}-feed`;
  const other = `${tag}-mac`;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    store = new QueryStore(pool);
    await store.loadDir(join(SEED, "queries"));
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = ANY($1)`, [[ics, other]]);
    await pool.query(`DELETE FROM sync_state WHERE connection = ANY($1)`, [[ics, other]]);
    await pool.end();
  });

  it("an ICS feed's day and another source's day are one list, all-day first, then by start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-t412-"));
    mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
    writeFileSync(join(dir, ".metistry", "connections", `${ics}.yaml`), `name: ${ics}\ntype: calendar\nprovider: ics\nreach:\n  http:\n    url: https://calendar.example.com/work/basic.ics\n`);
    const openSync = instanceSyncOpener({ instanceDir: dir, seedDir: SEED, extensions: false, env: {}, fetch: (async () => new Response(FEED)) as typeof fetch });
    // the Mac's calendar, as the eventkit sync writes it — on Thursday 1 October too
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title, attendees, self_status)
       VALUES ($1, $2, '2026-10-01T14:00:00Z', '2026-10-01T14:30:00Z', 'One-on-one', '[]'::jsonb, NULL)`,
      [other, `${tag}-1on1`],
    );

    // the runner's ctx plus the sync's clock (IcsCtx.now), pinned to Monday 28 September
    const ctx = { openSync, ownerTimeZone: "America/New_York", now: () => Date.parse("2026-09-28T16:00:00Z") };
    expect(await syncIcs(pool, ctx)).toBe(7);

    const { rows } = await store.run("day_events", { day: "2026-10-01", tz: "America/New_York" });
    const mine = rows.filter((r) => r.connection === ics || r.connection === other);
    expect(mine.map((r) => [r.connection, r.event_id, r.title, r.all_day])).toEqual([
      [ics, "offsite-11@example.com", "Team offsite", true],
      [other, `${tag}-1on1`, "One-on-one", false],
    ]);
    // the same keys whatever the source — the F-7 shape GET /api/today serves
    expect(Object.keys(mine[0]!).sort()).toEqual(Object.keys(mine[1]!).sort());

    const monday = (await store.run("day_events", { day: "2026-09-28", tz: "America/New_York", connection: ics })).rows;
    expect(monday.map((r) => [r.event_id, new Date(r.start as string).toISOString()])).toEqual([["standup-7f3a@example.com_20260928T130000Z", "2026-09-28T13:00:00.000Z"]]);
    expect(monday[0]?.attendees).toEqual([
      { name: "Dana Scully", email: "dana@example.com", person: null, self: false },
      { name: "Mulder, Fox", email: "fox@example.com", person: null, self: false },
      { name: "Room 4", email: "room4@resource.example.com", person: null, self: false },
    ]);
  });
});
