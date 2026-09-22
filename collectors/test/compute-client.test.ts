// `scoreChoice()` — the answer-token sibling of `completeJson()`, at the
// level of the client rather than the collector (PoC-20 phase 1).
//
// What is checked here and nowhere else: that it shares `completeJson`'s
// provider resolution and money rule exactly, that a model reference it is
// NOT given means "the tier is off" rather than an error, and that the one
// textual thing a server can put in front of a caller — an error body, which
// can echo the prompt — is scrubbed.
import { describe, expect, it } from "vitest";
import { REDACTED, codesFor, parseCompute, type Compute } from "@foldedspacelabs/metistry-core";
import { completeJson, scoreChoice, type ComputeAccess } from "../compute-client.js";

const options = [
  { key: "a", description: "it is the first thing" },
  { key: "b", description: "it is the second thing" },
];
const codes = codesFor(2);
const messages = [{ role: "system" as const, content: "which one?" }];

const onMachine: Compute = parseCompute(`
providers:
  ollama:
    kind: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    locality: on_machine
  guarded:
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
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
`);

function fake(reply: unknown, status = 200) {
  const sent: any[] = [];
  const fn = (async (url: string, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

const scored = (token: string) => ({ choices: [{ message: { content: token }, logprobs: { content: [{ top_logprobs: [{ token, logprob: Math.log(0.95) }, { token: token === "A" ? "B" : "A", logprob: Math.log(0.05) }] }] } }] });

const ctx = (cfg: Compute, fetchFn: typeof fetch, secretEnv: NodeJS.ProcessEnv = {}): ComputeAccess => ({ compute: () => cfg, secretEnv, fetchFn });

describe("scoreChoice shares completeJson's resolution", () => {
  it("dials the provider's base_url + /chat/completions and carries its bearer", async () => {
    const server = fake(scored("B"));
    const r = await scoreChoice(ctx(onMachine, server.fn, { METISTRY_BRIDGE_TOKEN_APPLE_FM: "t" }), {
      collector: "inbox-drain",
      modelRef: "guarded/foundation-model",
      options,
      codes,
      messages,
    });
    // `guarded` is on the apple-fm port, which has no logprobs at all — the
    // refusal is by name, before any request.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/no per-token logits|no answer-token logprobs/);
    expect(server.sent).toHaveLength(0);
  });

  it("scores through an ollama provider, with the bearer where one is declared", async () => {
    const server = fake(scored("B"));
    const r = await scoreChoice(ctx(onMachine, server.fn), { collector: "inbox-drain", modelRef: "ollama/m", options, codes, messages });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice).toBe("b");
    expect(r.code).toBe("B");
    expect(r.server).toBe("ollama");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("m");
    expect(r.alpha).toBeCloseTo(1, 6);
    expect(r.covered).toBe(2);
    expect(server.sent[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(server.sent[0]!.headers.authorization).toBeUndefined();
  });

  it("says the tier is off — not that something failed — when nothing assigns it a model", async () => {
    const server = fake(scored("A"));
    const r = await scoreChoice(ctx(onMachine, server.fn), { collector: "inbox-drain", modelRef: undefined, options, codes, messages });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(/assignments.intent/);
      expect(r.why).toMatch(/supported install/);
    }
    expect(server.sent).toHaveLength(0);
  });

  it("names the missing credential rather than dialling without one", async () => {
    const server = fake(scored("A"));
    const cfg = parseCompute(`
providers:
  ollama:
    kind: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    locality: on_machine
    auth: { secret: METISTRY_SOME_KEY }
`);
    const r = await scoreChoice(ctx(cfg, server.fn), { collector: "inbox-drain", modelRef: "ollama/m", options, codes, messages });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/METISTRY_SOME_KEY/);
    expect(server.sent).toHaveLength(0);
  });

  it("THROWS on the money rule, exactly as completeJson does, and sends nothing", async () => {
    const server = fake(scored("A"));
    await expect(
      scoreChoice(ctx(offMachine, server.fn), { collector: "inbox-drain", modelRef: "openrouter/anthropic/claude-sonnet-5", options, codes, messages }),
    ).rejects.toThrow(/locality: off_machine/);
    await expect(
      completeJson({ ...ctx(offMachine, server.fn), usesModel: "openrouter/anthropic/claude-sonnet-5" }, { collector: "inbox-drain", schema: {}, schemaName: "x", messages }),
    ).rejects.toThrow(/locality: off_machine/);
    expect(server.sent).toHaveLength(0);
  });

  it("scrubs a server's error body, which can echo the prompt back", async () => {
    const server = fake({ error: "bad request near 'reply with code 482913'" }, 400);
    const r = await scoreChoice(ctx(onMachine, server.fn), { collector: "inbox-drain", modelRef: "ollama/m", options, codes, messages });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).not.toContain("482913");
      expect(r.why).toContain(REDACTED);
    }
  });
});
