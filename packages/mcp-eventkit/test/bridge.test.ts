// Wire-contract tests with a scripted fake helper. Real EventKit is
// verified live (it needs the TCC grant on this Mac).
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeBridge } from "../src/index.js";
import type { Helper, HelperResponse } from "../src/helper.js";

const token = mintToken();
const created: any[] = [];
const fakeHelper = {
  async request(p: Record<string, unknown>): Promise<HelperResponse> {
    if (p.op === "check") return { id: 1, ok: true, auth_events: "full_access", auth_reminders: "full_access", events_found: 3 };
    if (p.op === "list_events") return { id: 1, ok: true, events: [{ title: "standup" }] };
    if (p.op === "create_event" || p.op === "create_reminder") { created.push(p); return { id: 1, ok: true, created: { id: "x1" } }; }
    return { id: 1, ok: false, error: "nope" };
  },
  stop() {},
} as unknown as Helper;

describe("eventkit bridge wire contract", () => {
  let base: string;
  let server: ReturnType<typeof makeBridge>;
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  beforeAll(async () => {
    server = makeBridge(fakeHelper, { token });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  it("refuses missing/wrong bearer uniformly (CRIT-9)", async () => {
    expect((await fetch(`${base}/check`)).status).toBe(401);
    expect((await fetch(`${base}/events`, { headers: { authorization: `Bearer ${mintToken()}` } })).status).toBe(401);
  });

  it("check() reports auth status in the frozen shape", async () => {
    const c = await (await fetch(`${base}/check`, { headers: H })).json();
    expect(c).toMatchObject({ name: "eventkit", status: "ok", meta: { events: "full_access" } });
  });

  it("reads events with an as_of stamp", async () => {
    const r = await (await fetch(`${base}/events?days=3`, { headers: H })).json();
    expect(r.events[0].title).toBe("standup");
    expect(r.as_of).toBeTruthy();
  });

  // §4.3 default 2: destructive tools preview first, execute only on confirm
  it("create is preview-then-confirm: no write without the token, token bound to the payload", async () => {
    const body = { title: "dentist", start: "2026-09-02T10:00:00Z", end: "2026-09-02T11:00:00Z" };
    const preview = await (await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    expect(preview.preview).toContain("dentist");
    expect(created).toHaveLength(0); // nothing written yet
    // tampered payload with a valid token → refused
    const tampered = await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ ...body, title: "not dentist", confirm_token: preview.confirm_token }) });
    expect(tampered.status).toBe(409);
    expect(created).toHaveLength(0);
    // fresh preview + honest confirm → executes once; token is single-use
    const p2 = await (await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    const ok = await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ ...body, confirm_token: p2.confirm_token }) });
    expect(ok.status).toBe(201);
    expect(created).toHaveLength(1);
    const replay = await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ ...body, confirm_token: p2.confirm_token }) });
    expect(replay.status).toBe(409);
    expect(created).toHaveLength(1);
  });

  it("rejects malformed creates", async () => {
    expect((await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ title: "x" }) })).status).toBe(400);
  });
});
