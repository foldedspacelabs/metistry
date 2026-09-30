// The on-device model tier, against a fake `/v1`. What these pin down is
// that the deterministic half is unchanged and in charge, that the model is
// reached through the ORDINARY provider wire, and that every way the tier
// can be missing leaves the drain working.
import { describe, expect, it } from "vitest";
import { parseCompute, type Compute } from "@foldedspacelabs/metistry-core";
import { run, FM_SCHEMA, type CollectorCtx } from "./run.js";

function fakeDb(inboxRows: any[]) {
  const proposals: any[] = [];
  return {
    proposals,
    async query(text: string, values?: unknown[]): Promise<{ rows: any[] }> {
      if (text.startsWith("SELECT id, path")) return { rows: inboxRows };
      if (text.startsWith("INSERT INTO proposals")) {
        proposals.push(JSON.parse(String(values![0])));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const onMachine = (name = "applefm"): Compute =>
  parseCompute(`
providers:
  ${name}:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
    auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM }
`);

const offMachine: Compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
`);

/** An OpenAI-shaped `/v1/chat/completions` whose content is whatever the test says. */
function fakeV1(content: (prompt: string) => string | { status: number; body: unknown }) {
  const sent: Array<{ url: string; body: any; headers: any }> = [];
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), body, headers: init.headers });
    const user = body.messages.find((m: any) => m.role === "user").content;
    const out = content(user);
    if (typeof out !== "string") return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: out } }], usage: { prompt_tokens: 208, completion_tokens: 42 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fn, sent };
}

const ctxFor = (compute: Compute, fetchFn: typeof fetch, usesModel = "applefm/foundation-model"): CollectorCtx => ({
  compute: () => compute,
  secretEnv: { METISTRY_BRIDGE_TOKEN_APPLE_FM: "bridge-token-fm-tier-0001" }, // a realistic bearer: the egress door refuses a model body that carries it (X-7), and a one-letter one is in every body
  usesModel,
  fetchFn,
});

const ambiguous = { id: 1, path: "1-note.md", mime: "text/markdown", note: "thoughts on the migration approach", source: "note" };
const todoRow = { id: 2, path: "2-note.md", mime: "text/markdown", note: "buy milk", source: "note" };
const classified = (c: object) => JSON.stringify(c);

describe("inbox-drain's on-device tier (ruled 2026-09-01; a provider since PR 4)", () => {
  it("refines only rule-default items, over /v1, with the provider's bearer", async () => {
    const v1 = fakeV1(() => classified({ action: "", has_action: false, category: "idea" })); // deliberately NOT the schema's key order
    const db = fakeDb([ambiguous, todoRow]);
    await run(db, ctxFor(onMachine(), v1.fn));

    expect(v1.sent).toHaveLength(1); // only the ambiguous one crossed
    expect(v1.sent[0]!.url).toBe("http://127.0.0.1:7810/v1/chat/completions");
    expect(v1.sent[0]!.headers.authorization).toBe("Bearer bridge-token-fm-tier-0001");
    expect(v1.sent[0]!.body.model).toBe("foundation-model");
    expect(v1.sent[0]!.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "classification", strict: true, schema: FM_SCHEMA } });
    expect(v1.sent[0]!.body.messages[1].content).toBe("thoughts on the migration approach");

    const p1 = db.proposals.find((p) => p.inbox_id === 1);
    const p2 = db.proposals.find((p) => p.inbox_id === 2);
    expect(p1.tier).toBe("applefm"); // the tier IS the provider's name
    expect(p1.classification.kind).toBe("idea");
    expect(p2.tier).toBe("deterministic"); // todo rule fired; the model was never consulted
  });

  it("the tier's name follows compute.yaml, not a hardcoded 'apple-fm'", async () => {
    const v1 = fakeV1(() => classified({ category: "idea", has_action: false, action: "" }));
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(onMachine("my-local"), v1.fn, "my-local/gemma-3-4b"));
    expect(db.proposals[0].tier).toBe("my-local");
    expect(v1.sent[0]!.body.model).toBe("gemma-3-4b");
  });

  it("string ids from pg (bigint) still match results (regression)", async () => {
    const v1 = fakeV1(() => classified({ category: "idea", has_action: false, action: "" }));
    const db = fakeDb([{ ...ambiguous, id: "36" }]);
    await run(db, ctxFor(onMachine(), v1.fn));
    expect(db.proposals[0].tier).toBe("applefm");
  });

  it("scrubs the model's free text — the guarantee /classify used to give", async () => {
    const v1 = fakeV1(() => classified({ category: "todo", has_action: true, action: "reply with code 482913" }));
    const db = fakeDb([ambiguous]);
    await run(db, ctxFor(onMachine(), v1.fn));
    expect(db.proposals[0].classification.action).not.toContain("482913");
  });

  it("degrades to deterministic on every absent-shaped case", async () => {
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const http500 = fakeV1(() => ({ status: 500, body: { error: { message: "nope" } } })).fn;
    const notJson = fakeV1(() => "this is prose, not JSON").fn;
    const offSchema = fakeV1(() => classified({ category: "spaceship", has_action: false, action: "" })).fn;
    const cases: CollectorCtx[] = [
      {}, // nothing configured at all
      ctxFor(parseCompute("providers: {}"), boom), // no such provider in compute.yaml
      { ...ctxFor(onMachine(), boom), secretEnv: {} }, // credential not in this process's env
      ctxFor(onMachine(), boom), // the server did not answer
      ctxFor(onMachine(), http500), // it answered, badly
      ctxFor(onMachine(), notJson), // it answered with prose despite a pinned schema
      ctxFor(onMachine(), offSchema), // it answered a category outside the enum
      { ...ctxFor(onMachine(), boom), usesModel: undefined }, // the manifest pins nothing
    ];
    for (const ctx of cases) {
      const db = fakeDb([{ ...ambiguous }]);
      await run(db, ctx);
      expect(db.proposals[0].tier).toBe("deterministic");
      expect(db.proposals[0].classification.kind).toBe("note");
    }
  });

  // The money rule is the ONE thing that does not degrade: an unattended job
  // that had quietly started spending is exactly what must not happen, and
  // the runner turns a thrown collector into a runs row and a Needs You item.
  it("THROWS rather than calling a billable provider, and never sends the request", async () => {
    const v1 = fakeV1(() => classified({ category: "idea", has_action: false, action: "" }));
    const db = fakeDb([ambiguous]);
    await expect(run(db, ctxFor(offMachine, v1.fn, "openrouter/anthropic/claude-sonnet-5"))).rejects.toThrow(/locality: off_machine/);
    expect(v1.sent).toHaveLength(0);
  });
});
