// `completeJson()` and `scoreChoice()` share one resolution — the provider,
// the money rule, the credential's door and the URL — in core's
// `resolveOnMachineCall`.
// `scoreChoice` moved into `packages/core` with T9-2 (its own tests moved
// with it, to packages/core/test/score-choice.test.ts); what stays here is
// the property the move had to keep: the collector's JSON call and the
// scorer refuse an off-machine provider identically, before any request.
import { describe, expect, it } from "vitest";
import { codesFor, parseCompute, parseSecretsFile, scoreChoice, type Compute } from "@foldedspacelabs/metistry-core";
import { completeJson, type ComputeAccess } from "../compute-client.js";

const messages = [{ role: "system" as const, content: "which one?" }];

const offMachine: Compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
`);

const onMachine: Compute = parseCompute(`
providers:
  ollama:
    kind: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    locality: on_machine
    auth: { secret: METISTRY_SOME_KEY }
`);

function fake() {
  const sent: unknown[] = [];
  const fn = (async (url: string) => {
    sent.push(url);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

const ctx = (cfg: Compute, fetchFn: typeof fetch, secretEnv: NodeJS.ProcessEnv = {}): ComputeAccess => ({ compute: () => cfg, secretEnv, fetchFn });

describe("completeJson and scoreChoice share one resolution", () => {
  it("THROW on the money rule, identically, and send nothing", async () => {
    const server = fake();
    const ref = "openrouter/anthropic/claude-sonnet-5";
    const a = await scoreChoice(ctx(offMachine, server.fn), { collector: "inbox-drain", modelRef: ref, options: [{ key: "a", description: "it is a" }], codes: codesFor(1), messages }).catch((e: Error) => e.message);
    const b = await completeJson({ ...ctx(offMachine, server.fn), usesModel: ref }, { collector: "inbox-drain", schema: {}, schemaName: "x", messages }).catch((e: Error) => e.message);
    expect(a).toMatch(/locality: off_machine/);
    expect(b).toBe(a);
    expect(server.sent).toHaveLength(0);
  });

  it("name the same missing credential rather than dialling without one", async () => {
    const server = fake();
    const a = await scoreChoice(ctx(onMachine, server.fn), { collector: "inbox-drain", modelRef: "ollama/m", options: [{ key: "a", description: "it is a" }], codes: codesFor(1), messages });
    const b = await completeJson({ ...ctx(onMachine, server.fn), usesModel: "ollama/m" }, { collector: "inbox-drain", schema: {}, schemaName: "x", messages });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.why).toMatch(/METISTRY_SOME_KEY/);
      expect(b.why).toBe(a.why);
    }
    expect(server.sent).toHaveLength(0);
  });
});

// X-7 (ruling 2 of the W2 checkpoint): both go through core's `computeFetch`.
// A `{{ secret.x }}` key reaches the model server only on the owner's grant
// to `provider:<name>` — and neither caller ever holds it to send by hand.
describe("**a provider key without its grant is refused before dialling** (completeJson and scoreChoice)", () => {
  const keyed: Compute = parseCompute(`
providers:
  keyed:
    kind: openai-compatible
    base_url: http://127.0.0.1:1235/v1
    locality: on_machine
    auth: { secret: "{{ secret.local_key }}" }
`);
  const env = { METISTRY_SECRET_LOCAL_KEY: "local-SENTINEL-key-5150" };
  const policy = (grants: string) => () => ({ ok: true as const, file: parseSecretsFile(`secrets:\n  local_key:\n    hosts: ["127.0.0.1:1235"]\n    grants:\n${grants}`) });

  it("no grant: both return the refusal as their reason, and nothing is sent", async () => {
    const server = fake();
    const access = { ...ctx(keyed, server.fn, env), secretsPolicy: policy("      agent:assistant: on\n") };
    const a = await scoreChoice(access, { collector: "inbox-drain", modelRef: "keyed/m", options: [{ key: "a", description: "it is a" }], codes: codesFor(1), messages });
    const b = await completeJson({ ...access, usesModel: "keyed/m" }, { collector: "inbox-drain", schema: {}, schemaName: "x", messages });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.why).toContain("not_granted");
      expect(b.why).toContain("not_granted");
      expect(b.why).toContain("provider:keyed");
      expect(b.why).not.toContain(env.METISTRY_SECRET_LOCAL_KEY);
    }
    expect(server.sent).toHaveLength(0);
  });

  it("granted: the call is made, to the provider's host, with the key the door attached", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const b = await completeJson({ ...ctx(keyed, fn, env), secretsPolicy: policy("      provider:keyed: on\n"), usesModel: "keyed/m" }, { collector: "inbox-drain", schema: {}, schemaName: "x", messages });
    expect(b.ok).toBe(true);
    expect(seen).toEqual([{ url: "http://127.0.0.1:1235/v1/chat/completions", auth: `Bearer ${env.METISTRY_SECRET_LOCAL_KEY}` }]);
  });
});
