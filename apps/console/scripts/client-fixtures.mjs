// The client API's recorded fixtures (design-build-plan §2.16, F-7): what they
// are, where they live, and how two of them are compared. Pure — no database,
// no server, no file writes — so the no-database test in
// `apps/console/test/client-fixtures.test.ts` and the recorder
// (`record-client-fixtures.mjs`) read one definition.
//
// ONE JSON PER ROUTE, under `apps/macos/tests/kit/fixtures/<stem>.json`, for
// every row of `packages/core/src/client-api.ts` MetistryKit has a store
// method for. Two sources, and a fixture says which it is:
//
//   recorded   a served row, recorded from a scratch console by the recorder —
//              real bodies from real handlers, never hand-edited
//   contract   a row frozen ahead of its ticket: the body the contract words
//              (docs/ops/client-api.md) describe, written by hand so every view
//              is built before its route lands (U9). The ticket that serves the
//              row re-records it, and the recorder refuses a recording whose
//              SHAPE differs from the contract fixture unless it is told to
//              accept the difference — "F-7's fixture matches" is checked by
//              the tool, not remembered.
//
// `/api/q/:name` is one row and many queries: one fixture per query the kit
// reads (`KIT_QUERIES`), each stem naming its query.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const FIXTURE_DIR = join(REPO_ROOT, "apps", "macos", "tests", "kit", "fixtures");

/** The two things a fixture can be. */
export const SOURCES = ["recorded", "contract"];

/**
 * Rows MetistryKit has no store method for, and why. Everything else in the
 * table gets exactly one method and one fixture (or, for `/api/q/:name`, one
 * per query below). A row joins this list only with a reason a reviewer can
 * argue with.
 */
export const NOT_IN_THE_KIT = Object.freeze({
  "POST /auth/enroll/start": "the passkey ceremony is a browser's and a phone's way in; the Mac is the local owner and holds no session (ConsoleClient keeps the ceremony for enrolling another device)",
  "POST /auth/enroll/finish": "the passkey ceremony (as enroll/start)",
  "POST /auth/login/start": "the passkey ceremony (as enroll/start)",
  "POST /auth/login/finish": "the passkey ceremony (as enroll/start)",
  "POST /auth/logout": "ends the calling device's session row; the local owner token has none, so the console answers 403",
  "* /mcp": "the agent door; an owner credential is not an agent principal there",
  "GET /api/push/vapid-key": "bound to a device session; the Mac notifies natively and the local owner token has no session to push to",
  "POST /api/push/subscribe": "bound to a device session (as vapid-key)",
  "POST /api/push/test": "bound to a device session (as vapid-key)",
});

/** The named queries the kit reads through `GET /api/q/:name`, one fixture each. */
export const KIT_QUERIES = Object.freeze(["activity_feed", "agent_presence", "aws_costs_daily", "board", "rooms", "spend", "spend_by_actor"]);

export const Q_ROUTE = "GET /api/q/:name";

/**
 * A fixture's file name, without `.json`: the method, then the path's
 * segments, a parameter losing its colon. `GET /api/runs/:id` →
 * `get-api-runs-id`; `GET /api/q/board` → `get-api-q-board`.
 */
export function fixtureStem(method, path) {
  return [method.toLowerCase(), ...path.split("/").filter(Boolean).map((s) => s.replace(/^:/, ""))].join("-");
}

/** Every fixture the kit needs, from the table: `{stem, route, path, served, ticket}`. */
export function expectedFixtures(table) {
  const out = [];
  for (const r of table) {
    const route = `${r.method} ${r.path}`;
    if (route in NOT_IN_THE_KIT) continue;
    if (route === Q_ROUTE) {
      for (const q of KIT_QUERIES) out.push({ stem: fixtureStem("GET", `/api/q/${q}`), route, path: `/api/q/${q}`, served: r.served, ticket: r.ticket });
      continue;
    }
    out.push({ stem: fixtureStem(r.method, r.path), route, path: r.path, served: r.served, ticket: r.ticket });
  }
  return out;
}

function kindOf(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean"
}

/**
 * Where two bodies differ in SHAPE — keys and value kinds, never values. A
 * `null` on either side matches anything (a nullable column is null in one
 * recording and a string in the next); an array is compared by its first
 * element when both have one. Returns one line per difference, empty when
 * the shapes agree.
 */
export function shapeDiff(expected, actual, at = "$") {
  const ke = kindOf(expected);
  const ka = kindOf(actual);
  if (ke === "null" || ka === "null") return [];
  if (ke !== ka) return [`${at}: ${ke} in the fixture, ${ka} in the recording`];
  if (ke === "array") return expected.length > 0 && actual.length > 0 ? shapeDiff(expected[0], actual[0], `${at}[0]`) : [];
  if (ke !== "object") return [];
  const out = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of [...keys].sort()) {
    if (!(k in actual)) out.push(`${at}.${k}: in the fixture, not in the recording`);
    else if (!(k in expected)) out.push(`${at}.${k}: in the recording, not in the fixture`);
    else out.push(...shapeDiff(expected[k], actual[k], `${at}.${k}`));
  }
  return out;
}

/** A fixture's body for comparison: the JSON body, the NDJSON lines, or the event frames. */
export function fixtureBody(f) {
  if ("body_ndjson" in f) return f.body_ndjson;
  if ("stream" in f) return f.stream;
  return f.body;
}
