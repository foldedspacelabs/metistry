// Wire-contract tests with a scripted fake helper (real FM inference is
// smoked separately — it needs Apple hardware). Misuse tests per §4.3.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeBridge } from "../src/index.js";
import type { Helper, HelperResponse } from "../src/helper.js";

const token = mintToken();

const fakeHelper = {
  async request(p: { text?: string; op?: string }): Promise<HelperResponse> {
    if (p.op === "check") return { id: 1, ok: true, probe: "canned", category: "todo" };
    if (p.text === "explode") return { id: 1, ok: false, error: "boom" };
    return {
      id: 1,
      ok: true,
      classification: { category: "todo", has_action: true, action: `code is 482913 for ${p.text}` },
    };
  },
  stop() {},
} as unknown as Helper;

describe("apple-fm bridge wire contract", () => {
  let base: string;
  let server: ReturnType<typeof makeBridge>;

  beforeAll(async () => {
    server = makeBridge(fakeHelper, { token });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  // CRIT-9 misuse tests: loopback is not a trust boundary
  it("refuses missing/wrong/malformed bearer with the uniform envelope", async () => {
    for (const headers of [{}, { authorization: `Bearer ${mintToken()}` }, { authorization: token }]) {
      const r = await fetch(`${base}/check`, { headers: headers as Record<string, string> });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
  });

  it("check() returns the frozen shape with a behavioral probe", async () => {
    const r = await fetch(`${base}/check`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const c = await r.json();
    expect(c).toMatchObject({ name: "apple-fm", status: "ok" });
    expect(c.probe).toContain("real classification");
    expect(typeof c.latency_ms).toBe("number");
  });

  it("classify scrubs digit runs from model output (PoC-13 OTP lesson)", async () => {
    const r = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: 7, text: "renew cert" }] }),
    });
    const { results } = await r.json();
    expect(results[0].classification.action).not.toContain("482913");
    expect(results[0].classification.category).toBe("todo");
  });

  it("per-item failures degrade per item, not per batch", async () => {
    const r = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: 1, text: "explode" }, { id: 2, text: "fine" }] }),
    });
    const { results } = await r.json();
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });

  it("rejects empty and oversized batches", async () => {
    for (const items of [[], Array.from({ length: 101 }, (_, i) => ({ id: i, text: "x" }))]) {
      const r = await fetch(`${base}/classify`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      expect(r.status).toBe(400);
    }
  });
});
