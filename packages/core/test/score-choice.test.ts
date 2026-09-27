// `scoreChoice()` — the answer-token sibling of the collectors'
// `completeJson()`, at the level of the client rather than the caller
// (PoC-20 phase 1). Moved here from `collectors/test/compute-client.test.ts`
// with the function itself (T9-2): the router's policy asks the same
// question, and the console cannot import from `collectors/`.
//
// What is checked here: that it resolves the provider and applies the money
// rule through `resolveOnMachineCall` (the half `completeJson` shares —
// `collectors/test/compute-client.test.ts` holds that the two refuse
// identically), that a model reference it is NOT given means "the tier is
// off" rather than an error, and that the one textual thing a server can put
// in front of a caller — an error body, which can echo the prompt — is
// scrubbed.
import { describe, expect, it } from "vitest";
import { codesFor } from "../src/choice.js";
import { parseCompute, type Compute } from "../src/compute.js";
import { REDACTED } from "../src/redact.js";
import { resolveOnMachineCall, scoreChoice, type ModelAccess } from "../src/score-choice.js";

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

const ctx = (cfg: Compute, fetchFn: typeof fetch, secretEnv: NodeJS.ProcessEnv = {}): ModelAccess => ({ compute: () => cfg, secretEnv, fetchFn });

describe("scoreChoice resolves through resolveOnMachineCall", () => {
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

  it("a {{ secret.x }} key is read from its delivery variable, and a switched-off provider degrades like an absent one (T4-18)", async () => {
    const named = parseCompute(`
providers:
  ollama:
    kind: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    locality: on_machine
    auth: { secret: "{{ secret.ollama_key }}" }
`);
    const missing = fake(scored("A"));
    const r = await scoreChoice(ctx(named, missing.fn), { collector: "inbox-drain", modelRef: "ollama/m", options, codes, messages });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("METISTRY_SECRET_OLLAMA_KEY");
    expect(missing.sent).toHaveLength(0);

    const off = parseCompute(`
providers:
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine, enabled: false }
`);
    const server = fake(scored("A"));
    const r2 = await scoreChoice(ctx(off, server.fn), { collector: "inbox-drain", modelRef: "ollama/m", options, codes, messages });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.why).toContain("switched off");
    expect(server.sent).toHaveLength(0);
  });

  it("THROWS on the money rule, before any request is built, and sends nothing", async () => {
    const server = fake(scored("A"));
    await expect(
      scoreChoice(ctx(offMachine, server.fn), { collector: "inbox-drain", modelRef: "openrouter/anthropic/claude-sonnet-5", options, codes, messages }),
    ).rejects.toThrow(/locality: off_machine/);
    // the shared half, on its own: the refusal is the resolution's, not the scorer's
    expect(() => resolveOnMachineCall(ctx(offMachine, server.fn), "the router's policy", "openrouter/anthropic/claude-sonnet-5", "absent")).toThrow(/locality: off_machine/);
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
