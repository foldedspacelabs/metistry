// The REAL Swift helper, through the REAL bridge, over `/v1`. Everything
// else in this package's tests scripts the helper; this is the only place
// that proves the translation actually reaches Apple Foundation Models and
// comes back as an OpenAI `chat.completion`.
//
// Needs a Mac with Apple Intelligence on AND the helper built
// (`pnpm --filter @foldedspacelabs/metistry-mcp-apple-fm build:helper`), so
// it SKIPS rather than fails on Linux CI and on a checkout where nobody has
// built it — the same shape as the CLI's runtime-deps test and core's stdio
// conformance case for this binary.
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { Helper, defaultSpawner } from "../src/helper.js";
import { makeBridge } from "../src/index.js";
import { MODEL_ID } from "../src/v1.js";

const BINARY = fileURLToPath(new URL("../helper/afm-helper.app/Contents/MacOS/afm-helper", import.meta.url));
const have = process.platform === "darwin" && existsSync(BINARY);

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["todo", "event", "idea", "link", "note"] },
    has_action: { type: "boolean" },
    action: { type: "string" },
  },
  required: ["category", "has_action", "action"],
  additionalProperties: false,
};

describe.skipIf(!have)("apple-fm /v1 against the real helper (darwin, built)", () => {
  const token = mintToken();
  let helper: Helper;
  let server: ReturnType<typeof makeBridge>;
  let base: string;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const complete = (body: unknown): Promise<Response> => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(body) });

  beforeAll(async () => {
    helper = new Helper(defaultSpawner(BINARY), 120_000);
    server = makeBridge(helper, { token });
    // port 0: never 7810, so a test run can never collide with the bridge
    // this Mac is actually running.
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    helper.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("lists one model", async () => {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    expect(r.status).toBe(200);
    expect((await r.json()).data.map((m: { id: string }) => m.id)).toEqual([MODEL_ID]);
  });

  it("generates JSON that satisfies a schema supplied at request time", async () => {
    const r = await complete({
      model: MODEL_ID,
      messages: [
        { role: "system", content: "You classify short personal-inbox capture items." },
        { role: "user", content: "grocery: pick up milk and bread tomorrow before 6pm" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "classification", strict: true, schema: CLASSIFY_SCHEMA } },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    // PARSE, never string-match: key order out of Apple's structured output
    // is not stable between identical runs (PoC-19 result 3).
    const value = JSON.parse(body.choices[0].message.content);
    expect(Object.keys(value).sort()).toEqual(["action", "category", "has_action"]);
    expect(["todo", "event", "idea", "link", "note"]).toContain(value.category);
    expect(typeof value.has_action).toBe("boolean");
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    expect(body.x_metistry).toMatchObject({ cost_usd: 0, schema_mode: "dynamic" });
  }, 120_000);

  it("refuses a schema it cannot translate rather than dropping the constraint", async () => {
    const r = await complete({
      messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_schema", json_schema: { name: "u", schema: { type: "object", properties: { a: { $ref: "#/$defs/x" } }, required: ["a"] } } },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe("unsupported_schema");
    expect(body.error.message).toContain("$ref");
  }, 60_000);

  it("preflights the context window: a schema too wide is a 400 naming the field, not a 500", async () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) properties[`field_${i}`] = { type: "string", description: `the value of field number ${i}, described at some length so it costs real tokens` };
    const r = await complete({
      messages: [{ role: "user", content: "fill it in" }],
      response_format: { type: "json_schema", json_schema: { name: "wide", schema: { type: "object", properties, required: Object.keys(properties) } } },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.error.message).toContain("response_format.json_schema.schema");
  }, 60_000);

  it("still answers the bridge contract: /check runs a real classification", async () => {
    const r = await fetch(`${base}/check`, { headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "apple-fm", status: "ok" });
  }, 60_000);
});
