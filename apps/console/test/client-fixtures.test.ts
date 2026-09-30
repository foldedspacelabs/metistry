// The client API's fixtures against the table (design-build-plan §2.16, F-7):
// one JSON per route MetistryKit reads, under apps/macos/tests/kit/fixtures/,
// recorded where the console serves the row and written from the contract
// where it does not yet. No database — this reads files and the table.
//
// The Swift half (`apps/macos/tests/kit/store-fixtures-tests.swift`) holds
// every store method to its fixture; this file holds every fixture to the
// table. A row the table gains, a row that becomes served, a fixture left
// behind by a removed route — each fails here, in CI, on Linux.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_API, EVENT_CATALOGUE, EVENT_TYPES, matchRoute, routeKey } from "@foldedspacelabs/metistry-core";
import { FIXTURE_DIR, KIT_QUERIES, NOT_IN_THE_KIT, Q_ROUTE, REPO_ROOT, expectedFixtures, fixtureStem, recordingMonthStart, runsExportCursor, shapeDiff } from "../scripts/client-fixtures.mjs";

type Fixture = {
  route: string;
  source: "recorded" | "contract";
  ticket: string | null;
  request: { method: string; path: string; body: unknown; idempotency_key: string | null };
  status: number;
  body?: unknown;
  body_ndjson?: unknown[];
  stream?: { id: string; event: string; data: Record<string, unknown> }[];
};

const onDisk = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
const read = (stem: string): Fixture => JSON.parse(readFileSync(join(FIXTURE_DIR, `${stem}.json`), "utf8"));
const expected = expectedFixtures(CLIENT_API) as { stem: string; route: string; path: string; served: boolean; ticket: string | null }[];

describe("the kit's fixtures, one per route of the client API table", () => {
  it("every row the kit reads has its fixture, and nothing else does", () => {
    const want = expected.map((f) => f.stem).sort();
    expect(onDisk.filter((s) => !want.includes(s)), "fixtures for no row — delete them, or add the row").toEqual([]);
    expect(want.filter((s) => !onDisk.includes(s)), "rows with no fixture — record them (apps/console/scripts/record-client-fixtures.mjs), or write the contract fixture").toEqual([]);
  });

  it("no two rows share a fixture name", () => {
    const stems = expected.map((f) => f.stem);
    expect(stems.length).toBe(new Set(stems).size);
  });

  it("the rows the kit has no method for are table rows, each with its reason — and every row the local owner cannot reach is one", () => {
    const keys = new Set(CLIENT_API.map(routeKey));
    for (const [route, why] of Object.entries(NOT_IN_THE_KIT)) {
      expect(keys.has(route), route).toBe(true);
      expect(why.length, route).toBeGreaterThan(20);
    }
    for (const r of CLIENT_API) {
      if (r.principals.includes("local_owner") || r.principals.includes("anyone")) continue;
      expect(NOT_IN_THE_KIT, `${routeKey(r)} admits no credential the Mac holds`).toHaveProperty([routeKey(r)]);
    }
  });

  it("each fixture is for its row: recorded where the console serves it, contract (naming its ticket) where it does not yet", () => {
    for (const f of expected) {
      const fx = read(f.stem);
      expect(fx.route, f.stem).toBe(f.route);
      expect(fx.source, `${f.stem}: ${f.served ? "served — record it" : `not served yet — a contract fixture for ${f.ticket}`}`).toBe(f.served ? "recorded" : "contract");
      if (fx.source === "contract") expect(fx.ticket, f.stem).toBe(f.ticket);
      expect(fx.status >= 200 && fx.status < 300, `${f.stem}: a fixture is an answer, not a refusal`).toBe(true);
      // its request is one the table routes to this row
      const [method] = f.route.split(" ");
      const m = matchRoute(method!, fx.request.path.split("?")[0]!);
      expect(m && routeKey(m.route), `${f.stem}: ${fx.request.method} ${fx.request.path}`).toBe(f.route);
      expect(fx.request.method, f.stem).toBe(method);
      if (f.route === Q_ROUTE) expect(fx.request.path.split("?")[0], f.stem).toBe(f.path);
    }
  });

  it("the named queries the kit reads are seed queries", () => {
    for (const q of KIT_QUERIES) expect(existsSync(join(REPO_ROOT, "seed/queries", `${q}.yaml`)), q).toBe(true);
  });

  it("no fixture carries a credential or this machine's paths", () => {
    for (const stem of onDisk) {
      const text = readFileSync(join(FIXTURE_DIR, `${stem}.json`), "utf8");
      expect(text, stem).not.toMatch(/Bearer |\/var\/folders\/|\/private\/tmp\/|\/Users\/|\/home\//);
      const tokens = [...text.matchAll(/"token":\s*"([^"]*)"/g)].map((m) => m[1]);
      for (const t of tokens) expect(t, `${stem}: a minted bearer is replaced before it is written`).toBe("fixture-token-not-a-secret");
    }
  });

  it("the event stream's fixture is the catalogue: every type, nothing else, each with its payload's fields", () => {
    const fx = read(fixtureStem("GET", "/api/events"));
    const types = [...new Set(fx.stream!.map((f) => f.event))].sort();
    expect(types).toEqual([...EVENT_TYPES].sort());
    for (const frame of fx.stream!) {
      const def = EVENT_CATALOGUE.find((e) => e.type === frame.event)!;
      // `{run_id, kind, turn_id?}` / `{work_id | artifact_id}` → the keys a frame may carry
      const allowed = def.payload.replace(/[{}?]/g, "").split(/[,|]/).map((s) => s.trim()).filter(Boolean);
      for (const key of Object.keys(frame.data)) expect(allowed, `${frame.event} carries ${key}`).toContain(key);
    }
  });
});

describe("shapeDiff — how a recording is held to its fixture", () => {
  it("compares keys and kinds, never values", () => {
    expect(shapeDiff({ a: 1, b: "x" }, { a: 2, b: "y" })).toEqual([]);
    expect(shapeDiff({ a: 1 }, { a: "1" })).toEqual(["$.a: number in the fixture, string in the recording"]);
    expect(shapeDiff({ a: 1 }, { a: 1, b: 2 })).toEqual(["$.b: in the recording, not in the fixture"]);
    expect(shapeDiff({ a: 1, b: 2 }, { a: 1 })).toEqual(["$.b: in the fixture, not in the recording"]);
  });

  it("lets a nullable field be null on either side, and reads an array by its first element", () => {
    expect(shapeDiff({ a: null }, { a: "x" })).toEqual([]);
    expect(shapeDiff({ rows: [] }, { rows: [{ id: 1 }] })).toEqual([]);
    expect(shapeDiff({ rows: [{ id: 1 }] }, { rows: [{ id: 1, extra: true }] })).toEqual(["$.rows[0].extra: in the recording, not in the fixture"]);
  });
});

// The recorder's seeds are pinned to RECORDING_NOW (X-31), never the wall
// clock — these two helpers are where that arithmetic lives, so the
// no-database test and the recorder read one definition (this file's own
// header).
describe("recordingMonthStart — Usage's two-bar month, off RECORDING_NOW never the wall clock", () => {
  it("is noon on the first of RECORDING_NOW's month, whatever the real day is", () => {
    expect(recordingMonthStart(new Date("2026-09-28T12:00:00.000Z"))).toBe("2026-09-01T12:00:00.000Z");
  });

  it("stays the same two calendar days apart from RECORDING_NOW even when RECORDING_NOW is itself the 1st — the exact case a wall-clock `now()` used to collapse", () => {
    const recordingNow = new Date("2026-10-01T12:00:00.000Z");
    const monthStart = recordingMonthStart(recordingNow);
    expect(monthStart).toBe("2026-10-01T12:00:00.000Z");
    expect(monthStart).toBe(recordingNow.toISOString()); // both land on the 1st — Usage draws one bar, not two, and that is the seed's job to avoid by NOT doing this on a real re-record
  });
});

describe("runsExportCursor — the export fixture's own floor against a dirty scratch database", () => {
  it("formats runs_export.yaml's own cursor grammar: ts, a pipe, id", () => {
    expect(runsExportCursor({ ts: "2026-09-28 12:00:00+00", id: 41 })).toBe("2026-09-28 12:00:00+00|41");
  });

  it("a fresh database's floor (no prior row) is still a valid cursor, not a blank one that would read from the beginning", () => {
    expect(runsExportCursor({ ts: "1970-01-01 00:00:00+00", id: 0 })).toBe("1970-01-01 00:00:00+00|0");
  });
});
