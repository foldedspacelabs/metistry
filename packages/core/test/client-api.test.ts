// The client API table's own consistency (design-build-plan §2.1). The
// console's conformance test holds the table to what the server serves, and
// the document test holds it to docs/ops/client-api.md; this file holds the
// table to itself — the rules a row has to keep before either comparison
// means anything.
import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  API_VERSION_HEADER,
  CLIENT_API,
  CLIENT_PRINCIPALS,
  CONFLICT_REASONS,
  IDEMPOTENCY,
  REACHES,
  REACH_PRINCIPALS,
  ROUTE_METHODS,
  isLocalRoute,
  localOnlyMessage,
  matchRoute,
  noRouteMessage,
  routeKey,
  servedRoute,
  type ClientRoute,
} from "../src/index.js";

const key = (r: ClientRoute) => routeKey(r);

describe("the version", () => {
  it("is 1, and travels in one header", () => {
    expect(API_VERSION).toBe(1);
    expect(API_VERSION_HEADER).toBe("Metistry-API-Version");
  });
});

describe("every row", () => {
  it("is unique by method and path", () => {
    const keys = CLIENT_API.map(key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("uses only the declared vocabularies, in their canonical order", () => {
    for (const r of CLIENT_API) {
      expect(ROUTE_METHODS, key(r)).toContain(r.method);
      expect(IDEMPOTENCY, key(r)).toContain(r.idempotent);
      expect(r.reach.length, key(r)).toBeGreaterThan(0);
      expect(r.reach, key(r)).toEqual(REACHES.filter((x) => r.reach.includes(x)));
      expect(r.principals.length, key(r)).toBeGreaterThan(0);
      expect(r.principals, key(r)).toEqual(CLIENT_PRINCIPALS.filter((x) => r.principals.includes(x)));
      for (const reason of r.conflict ?? []) expect(CONFLICT_REASONS, key(r)).toContain(reason);
    }
  });

  it("has a path of literal and `:name` segments, lowercase, with no parameter named twice", () => {
    for (const r of CLIENT_API) {
      expect(r.path, key(r)).toMatch(/^(\/([a-z0-9-]+|:[a-z_]+))+$/);
      const names = r.path.split("/").filter((s) => s.startsWith(":"));
      expect(new Set(names).size, key(r)).toBe(names.length);
    }
  });

  it("has a one-line summary the document's table can carry", () => {
    for (const r of CLIENT_API) {
      expect(r.summary.trim(), key(r)).toBe(r.summary);
      expect(r.summary, key(r)).not.toBe("");
      expect(r.summary, key(r)).not.toMatch(/[|\n]/);
    }
  });

  it("names a ticket when nothing serves it yet", () => {
    for (const r of CLIENT_API) {
      if (!r.served) expect(r.ticket, key(r)).not.toBeNull();
      if (r.ticket !== null) expect(r.ticket, key(r)).toMatch(/^(F|T\d+|X|W\d)-\d+[a-z]?$/);
    }
  });

  it("serves exactly N rows — a ticket flipping a row to served/unserved must update this number", () => {
    expect(CLIENT_API.filter((r) => r.served).length).toBe(107); // T4-8a: GET /api/connections, GET /api/connections/:name; T4-18: GET /api/compute/catalogue, POST /api/compute/unassign; T4-1: GET /api/secrets; T2-5: the Defer door; T4-6: GET /api/agents/:id/definition; T4-4: GET /api/variables; T3-9: POST /api/sessions/purge; T2-18: GET /api/events; T1-7: GET /api/needs-you/count; T1-6: the fold, the drafts, the areas; T10-2: GET /api/vault/status; T1-12: POST|DELETE /api/prose/:id/feedback; T2-17: GET /api/turns/:turn_id/progress, GET /api/sessions/:id; T10-4: GET /api/knowledge/history, GET /api/knowledge/version; T10-6: POST /api/vault/rollback; T2-11: POST /api/meetings/:event_id/note
  });

  it("takes a cursor only on a read, and an Idempotency-Key only on a write", () => {
    for (const r of CLIENT_API) {
      if (r.cursor) expect(r.method, key(r)).toBe("GET");
      if (r.idempotent === "key") expect(r.method, key(r)).not.toBe("GET");
      if (r.method === "GET") expect(r.idempotent, key(r)).toBe("natural");
    }
  });
});

describe("reach and principals", () => {
  it("a public row needs no credential, and only a public row", () => {
    for (const r of CLIENT_API) {
      expect(r.reach.includes("public"), key(r)).toBe(r.principals.includes("anyone"));
      if (r.reach.includes("public")) expect(r.principals, key(r)).toEqual(["anyone"]);
    }
  });

  it("a local row admits the local owner token and nothing else", () => {
    for (const r of CLIENT_API.filter((x) => x.reach.includes("local"))) {
      expect(r.reach, key(r)).toEqual(["local"]);
      expect(r.principals, key(r)).toEqual(["local_owner"]);
    }
  });

  it("minting a bearer is `local` — registering an agent and rotating its token (F-13) — and so is Purge Now, which cannot be undone (T3-9), and what a routine runs (T3-3), and a rollback of the vault's history (T10-6)", () => {
    const local = CLIENT_API.filter((r) => r.served && isLocalRoute(r)).map(key);
    expect(local).toEqual(["POST /api/agents", "POST /api/agents/:id/rotate", "POST /api/sessions/purge", "PUT /api/scheduled/routines/:name/assignment", "POST /api/vault/rollback"]);
    // a routine's timing stays reachable from any owner client; what it runs does not
    for (const k of ["PUT /api/scheduled/routines/:name/schedule", "POST /api/scheduled/routines/:name/pause", "POST /api/scheduled/routines/:name/run", "PUT /api/scheduled/syncs/:name"]) {
      expect(CLIENT_API.find((r) => key(r) === k)!.reach, k).toEqual(["owner"]);
    }
    // the rest of the agent registry stays reachable from any owner client
    for (const k of ["GET /api/agents", "PUT /api/agents/:id/grants", "POST /api/agents/:id/revoke", "POST /api/agents/:id/approve"]) {
      expect(CLIENT_API.find((r) => key(r) === k)!.reach, k).toEqual(["owner"]);
    }
  });

  it("isLocalRoute is exactly the rows filed under `local`", () => {
    for (const r of CLIENT_API) expect(isLocalRoute(r), key(r)).toBe(r.reach.includes("local"));
    expect(isLocalRoute({ reach: ["owner", "local"] }), "a mixed row fails closed").toBe(true);
    expect(isLocalRoute({ reach: ["owner"] })).toBe(false);
  });

  it("the local_only message names the route, the Mac app and the document", () => {
    const m = localOnlyMessage({ method: "POST", path: "/api/agents/:id/rotate" });
    expect(m).toContain("POST /api/agents/:id/rotate");
    expect(m).toContain("Mac app");
    expect(m).toContain("docs/ops/client-api.md");
  });

  it("no agent bearer reaches anything but the agent surface", () => {
    const agentRows = CLIENT_API.filter((r) => r.principals.includes("agent")).map(key);
    expect(agentRows).toEqual(["* /mcp", "POST /capture"]);
  });

  it("the capture owner token reaches the capture door and five owner routes — pinned, so widening it is a decision", () => {
    // Recorded as the server has always behaved (docs/ops/client-api.md
    // "Reach and principals", docs/ops/auth.md): these sit before the
    // console's management gate.
    const captureToken = CLIENT_API.filter((r) => r.principals.includes("owner_token")).map(key);
    expect(captureToken).toEqual(["POST /capture", "GET /api/whoami", "POST /message", "GET /api/messages", "GET /api/status", "GET /api/q/:name"]);
  });

  it("every other row admits a subset of its reach class", () => {
    const allowed = new Set(["POST /capture", "GET /api/whoami", "POST /message", "GET /api/messages", "GET /api/status", "GET /api/q/:name"]);
    for (const r of CLIENT_API) {
      if (allowed.has(key(r))) continue;
      const cls = new Set(r.reach.flatMap((x) => REACH_PRINCIPALS[x]));
      for (const p of r.principals) expect(cls.has(p), `${key(r)} admits ${p}`).toBe(true);
    }
  });
});

describe("matchRoute", () => {
  it("finds the row and its parameters", () => {
    const m = matchRoute("PUT", "/api/agents/devin/grants");
    expect(m && key(m.route)).toBe("PUT /api/agents/:id/grants");
    expect(m?.params).toEqual({ id: "devin" });
  });

  it("prefers the row with more literal segments", () => {
    expect(key(matchRoute("POST", "/api/proposals/batch")!.route)).toBe("POST /api/proposals/batch");
    expect(key(matchRoute("POST", "/api/proposals/17")!.route)).toBe("POST /api/proposals/:id");
  });

  it("matches `*` for every method", () => {
    for (const m of ["GET", "POST", "DELETE", "PATCH"]) expect(key(matchRoute(m, "/mcp")!.route)).toBe("* /mcp");
  });

  it("refuses a wrong method, an extra or missing segment, an empty segment and a trailing slash", () => {
    expect(matchRoute("GET", "/api/proposals/batch")).toBeUndefined();
    expect(matchRoute("GET", "/api/agents/devin/grants")).toBeUndefined();
    expect(matchRoute("GET", "/api/devices/")).toBeUndefined();
    expect(matchRoute("POST", "/api/devices//revoke")).toBeUndefined();
    expect(matchRoute("GET", "/api/q/a/b")).toBeUndefined();
    expect(matchRoute("GET", "/")).toBeUndefined();
    expect(matchRoute("HEAD", "/health")).toBeUndefined();
  });

  it("never makes two rows equally good for one request", () => {
    // Two rows of one method whose templates have the same shape (literals in
    // the same places) would leave the winner to table order.
    const shape = (r: ClientRoute) => `${r.method} ${r.path.replace(/:[a-z_]+/g, ":")}`;
    const shapes = CLIENT_API.map(shape);
    expect(shapes.filter((s, i) => shapes.indexOf(s) !== i)).toEqual([]);
  });

  it("servedRoute answers only for what is served", () => {
    expect(servedRoute("GET", "/api/devices") && key(servedRoute("GET", "/api/devices")!)).toBe("GET /api/devices");
    expect(servedRoute("GET", "/api/today")).toBeUndefined(); // T2-7's, frozen ahead of it
    expect(matchRoute("GET", "/api/today")?.route.served).toBe(false);
  });
});

describe("noRouteMessage", () => {
  it("names the served routes beside a misspelt one", () => {
    const m = noRouteMessage("GET", "/api/knowledge/backlinks");
    for (const door of ["GET /api/knowledge/search", "GET /api/knowledge/page", "GET /api/knowledge/pages", "GET /api/knowledge/links", "GET /api/knowledge/fold", "GET /api/knowledge/drafts", "GET /api/knowledge/areas", "GET /api/knowledge/history", "GET /api/knowledge/version", "POST /api/knowledge/restore"]) expect(m).toContain(door);
    expect(m).not.toContain("/api/knowledge/conflicts/resolve"); // frozen ahead of T2-10, not served — never offered
  });

  it("offers the other method when the path is right", () => {
    expect(noRouteMessage("GET", "/api/proposals/batch")).toContain("POST /api/proposals/batch");
  });

  it("says a frozen route is not served yet, rather than that it does not exist", () => {
    expect(noRouteMessage("GET", "/api/today")).toBe("GET /api/today is in the client API but this console does not serve it yet (docs/ops/client-api.md)");
    expect(noRouteMessage("POST", "/api/vault-tasks/abc/link")).toContain("POST /api/vault-tasks/:task_key/link is in the client API");
  });

  it("falls back to the document when nothing is near", () => {
    expect(noRouteMessage("GET", "/api/nothing")).toBe("no route GET /api/nothing — docs/ops/client-api.md lists every route this console serves");
    expect(noRouteMessage("GET", "/nope")).toContain("docs/ops/client-api.md");
  });
});
