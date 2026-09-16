// The `/v1` provider surface, with a scripted fake helper. Real Foundation
// Models inference is smoked separately (helper.integration.test.ts, which
// needs Apple hardware); everything here is the translation and the
// refusals, which are the parts that can be wrong silently.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeBridge } from "../src/index.js";
import type { Helper, HelperRequest, HelperResponse } from "../src/helper.js";
import { MODEL_ID, translateChatRequest } from "../src/v1.js";

const token = mintToken();
const sent: HelperRequest[] = [];

const fakeHelper = {
  async request(p: HelperRequest): Promise<HelperResponse> {
    sent.push(p);
    if (p.op === "models") return { id: 1, ok: true, models: [{ id: MODEL_ID, owned_by: "apple" }] };
    if (p.op === "complete") {
      if (p.prompt === "boom") return { id: 1, ok: false, error: "`$ref` is not supported at Response", code: "unsupported_schema" };
      if (p.prompt === "toobig") return { id: 1, ok: false, error: "response_format.json_schema.schema would not fit: 5342 prompt tokens", code: "context_length_exceeded" };
      if (p.prompt === "old") return { id: 1, ok: false, error: "`type: null` needs macOS 26.4", code: "not_available" };
      if (p.prompt === "nousage") {
        return { id: 1, ok: true, completion: { content: "{}", prompt_tokens: 0, completion_tokens: 0, usage_ok: false, schema_mode: "dynamic", respond_ms: 3 } };
      }
      return { id: 1, ok: true, completion: { content: '{"category": "todo"}', prompt_tokens: 208, completion_tokens: 42, usage_ok: true, schema_mode: "dynamic", respond_ms: 501.2 } };
    }
    return { id: 1, ok: false, error: "unexpected op" };
  },
  stop() {},
} as unknown as Helper;

const schemaBody = (prompt: string): string =>
  JSON.stringify({
    model: MODEL_ID,
    messages: [
      { role: "system", content: "You classify things." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_schema", json_schema: { name: "c", strict: true, schema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] } } },
  });

describe("apple-fm /v1 — the provider surface", () => {
  let base: string;
  let server: ReturnType<typeof makeBridge>;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  beforeAll(async () => {
    server = makeBridge(fakeHelper, { token });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  // Invariant 8: the network is not a boundary, and a local model endpoint
  // is no more exempt than any other route on this listener.
  it("refuses every /v1 route without the bearer, in OpenAI's error shape", async () => {
    for (const path of ["/v1/models", "/v1/chat/completions"]) {
      for (const headers of [{}, { authorization: `Bearer ${mintToken()}` }, { authorization: token }]) {
        const r = await fetch(`${base}${path}`, { method: path.endsWith("models") ? "GET" : "POST", headers: headers as Record<string, string>, body: path.endsWith("models") ? undefined : "{}" });
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ error: { message: "authentication required", type: "invalid_request_error", code: "unauthenticated" } });
      }
    }
  });

  it("GET /v1/models lists exactly one id", async () => {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "apple" }] });
  });

  it("a schema completion round-trips to an OpenAI chat.completion with honest usage", async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: schemaBody("milk tomorrow") });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe(MODEL_ID);
    expect(body.choices[0].message).toEqual({ role: "assistant", content: '{"category": "todo"}' });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 208, completion_tokens: 42, total_tokens: 250 });
    expect(body.x_metistry.cost_usd).toBe(0);
    // system became instructions, the single user turn became an unlabelled prompt
    const last = sent[sent.length - 1]!;
    expect(last).toMatchObject({ op: "complete", instructions: "You classify things.", prompt: "milk tomorrow" });
    expect(last.schema).toMatchObject({ type: "object" });
  });

  it("omits usage rather than reporting a confident zero when the helper could not count", async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: schemaBody("nousage") });
    const body = (await r.json()) as any;
    expect(body.usage).toBeUndefined();
    expect(body.x_metistry.usage).toContain("macOS 26.4");
  });

  it("maps the helper's own failure codes to statuses, and says which field", async () => {
    const cases: Array<[string, number, string]> = [
      ["boom", 400, "unsupported_schema"],
      ["toobig", 400, "context_length_exceeded"],
      ["old", 503, "not_available"],
    ];
    for (const [prompt, status, code] of cases) {
      const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: schemaBody(prompt) });
      expect(r.status).toBe(status);
      const body = (await r.json()) as any;
      expect(body.error.code).toBe(code);
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });

  it("refuses what it cannot do, naming the field, rather than degrading silently", async () => {
    const bodies: Array<[unknown, string]> = [
      [{ messages: [{ role: "user", content: "x" }], stream: true }, "stream_unsupported"],
      [{ messages: [{ role: "user", content: "x" }], tools: [] }, "tools_unsupported"],
      [{ messages: [{ role: "user", content: "x" }], n: 2 }, "n_unsupported"],
      [{ messages: [] }, "missing_messages"],
      [{ messages: [{ role: "system", content: "only system" }] }, "missing_messages"],
      [{ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, "invalid_message"],
      [{ messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } }, "unsupported_response_format"],
      [{ messages: [{ role: "user", content: "x" }], response_format: { type: "json_schema", json_schema: {} } }, "missing_schema"],
      [{ messages: [{ role: "user", content: "x" }], max_tokens: 0 }, "invalid_request"],
    ];
    for (const [body, code] of bodies) {
      const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      expect(r.status, code).toBe(400);
      expect((await r.json()).error.code, JSON.stringify(body)).toBe(code);
    }
  });

  it("an unknown /v1 route is a 404 in OpenAI's shape, not the bridge's", async () => {
    const r = await fetch(`${base}/v1/embeddings`, { method: "POST", headers: auth, body: "{}" });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatchObject({ code: "not_found", type: "invalid_request_error" });
  });

  it("the bridge contract is untouched: /check keeps Metistry's envelope", async () => {
    const r = await fetch(`${base}/check`, { headers: { authorization: token } });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
  });
});

describe("translateChatRequest (pure)", () => {
  it("role-labels a multi-turn history and leaves a single turn bare", () => {
    const one = translateChatRequest({ messages: [{ role: "user", content: "hello" }] });
    expect(one).toMatchObject({ ok: true, request: { prompt: "hello" } });
    const many = translateChatRequest({
      messages: [
        { role: "system", content: "S1" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "system", content: "S2" },
        { role: "user", content: "c" },
      ],
    });
    expect(many).toMatchObject({ ok: true, request: { instructions: "S1\n\nS2", prompt: "user: a\nassistant: b\nuser: c" } });
  });

  it("passes temperature and max_tokens through, dropping a zero temperature (greedy is the default)", () => {
    const t = translateChatRequest({ messages: [{ role: "user", content: "x" }], temperature: 0, max_completion_tokens: 64 });
    expect(t).toMatchObject({ ok: true, request: { max_tokens: 64 } });
    expect((t as { request: Record<string, unknown> }).request.temperature).toBeUndefined();
    expect(translateChatRequest({ messages: [{ role: "user", content: "x" }], temperature: 0.7 })).toMatchObject({ ok: true, request: { temperature: 0.7 } });
  });
});
