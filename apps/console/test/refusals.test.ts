// A refusal names the config field, the parameter or the grant that would
// permit it (R3, plan-refresh 2026-09-13) — except on the door, where the
// answer stays uniform because a message that distinguishes "not granted"
// from "not found" is an oracle (invariant 8).
//
// "not available" is the sharpest case: a 503 that says only "not available"
// tells the operator their deployment is missing something and refuses to say
// what, when the answer is two environment variables long.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { artifactRoutes } from "../src/artifacts-routes.js";
import { sendError } from "../src/http-util.js";
import { validateGrants, validateProjects, AgentError } from "../src/agents.js";
import { validateProjectPatch } from "../src/projects.js";

/** A real ServerResponse over a detached socket — cheaper than a server, and it exercises the actual writeHead/end path. */
function capture(): { res: ServerResponse; read: () => { status: number; body: any } } {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  (res as unknown as { _send: unknown })._send = () => true;
  res.write = ((c: string | Buffer) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return true;
  }) as ServerResponse["write"];
  res.end = ((c?: string | Buffer) => {
    if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return res;
  }) as ServerResponse["end"];
  return {
    res,
    read: () => ({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }),
  };
}

describe("sendError", () => {
  it("carries the detail onto the wire, keeping the code and the status", () => {
    const c = capture();
    sendError(c.res, "not_available", "METISTRY_RECONCILER_URL is not set");
    expect(c.read()).toEqual({ status: 503, body: { error: { code: "not_available", message: "METISTRY_RECONCILER_URL is not set" } } });
  });

  it("falls back to the canonical message when there is nothing useful to add", () => {
    const c = capture();
    sendError(c.res, "forbidden");
    expect(c.read()).toEqual({ status: 403, body: { error: { code: "forbidden", message: "not granted" } } });
  });

  it("the door stays uniform: a 401 never takes a detail, however hard the caller is pushed", () => {
    const c = capture();
    sendError(c.res, "unauthenticated", "the owner token is stale — run metistry secrets sync");
    expect(c.read()).toEqual({ status: 401, body: { error: { code: "unauthenticated", message: "authentication required" } } });
  });
});

/** Drive the adapter directly: it takes (req, res, url, service), so no server is needed. */
async function route(method: string, path: string, service?: unknown, body?: string) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  if (body !== undefined) {
    req.push(body);
    req.push(null);
  } else {
    req.push(null);
  }
  const c = capture();
  await artifactRoutes(req, c.res, new URL(`http://x${path}`), service as never);
  return c.read();
}

describe("artifacts and dispatch routes name what is missing", () => {
  it("no vault bridge: the 503 names the two variables, not just 'not available'", async () => {
    const r = await route("GET", "/api/artifacts", undefined);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("not_available");
    expect(r.body.error.message).toContain("METISTRY_RECONCILER_URL");
    expect(r.body.error.message).toContain("METISTRY_BRIDGE_TOKEN_RECONCILER");
    expect(r.body.error.message).toContain("docs/ops/reconciler.md");
  });

  const service = { async list() {
    return [];
  } };

  it("each missing query parameter is named, not merely counted", async () => {
    const file = await route("GET", "/api/artifacts/art_00000000000000000000000000/versions/ver_00000000000000000000000000/file", service);
    expect(file.status).toBe(400);
    expect(file.body.error.message).toContain("?path=");

    const diff = await route("GET", "/api/artifacts/art_00000000000000000000000000/diff", service);
    expect(diff.body.error.message).toContain("?from=");

    const comments = await route("GET", "/api/artifacts/art_00000000000000000000000000/comments", service);
    expect(comments.body.error.message).toContain("?version=");
  });

  it("a malformed JSON body says so, rather than 'invalid request'", async () => {
    const r = await route("POST", "/api/artifacts", service, "{not json");
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("request body is not JSON");
  });

  it("a comment body names the field, and the version field names its one exemption", async () => {
    const noBody = await route("POST", "/api/artifacts/art_00000000000000000000000000/comments", service, JSON.stringify({}));
    expect(noBody.body.error.message).toContain("body is required");

    const noVersion = await route("POST", "/api/artifacts/art_00000000000000000000000000/comments", service, JSON.stringify({ body: "hi" }));
    expect(noVersion.body.error.message).toContain("version is required");
    expect(noVersion.body.error.message).toContain("parent");
  });
});

// These validators already name the field; the routes used to answer
// `sendError(res, err.code)` and throw the message away, which is the whole
// difference between "400" and "area must be a TitleCase vault prefix".
describe("the validators behind the connect and budget paths name the field", () => {
  const message = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(AgentError);
      return (e as AgentError).message;
    }
  };

  it("grants (metistry connect --areas lands here)", () => {
    expect(message(() => validateGrants({ tier: "root" }))).toContain("tier must be none | index | areas");
    expect(message(() => validateGrants({ tier: "areas", areas: ["areas/projects"] }))).toContain("TitleCase vault prefix");
    expect(message(() => validateGrants({ tier: "areas", areas: [] }))).toContain("tier=areas needs at least one area");
    expect(message(() => validateGrants({ tier: "index", areas: ["Projects"] }))).toContain("areas only apply to tier=areas");
    expect(message(() => validateProjects(["Not A Slug"]))).toBeTruthy();
  });

  it("budgets and caps (PUT /api/projects/<slug>)", () => {
    expect(message(() => validateProjectPatch({ daily_budget_usd: -1 }))).toContain("daily_budget_usd");
    expect(message(() => validateProjectPatch({ max_open_bundles: 1.5 }))).toContain("max_open_bundles");
    expect(message(() => validateProjectPatch({ mode: "yolo" }))).toContain("mode must be autonomous | review");
    expect(message(() => validateProjectPatch({ nope: 1 }))).toContain("unknown key nope");
    expect(message(() => validateProjectPatch({}))).toContain("nothing to change");
  });
});
