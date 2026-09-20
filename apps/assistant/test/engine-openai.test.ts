// The in-house loop against a fake OpenAI-compatible server (no network, no
// model). Everything asserted here is a control rather than a behaviour:
// what goes on the wire, what stops the loop, what the turn cost, and what a
// refusal says.
import { describe, expect, it } from "vitest";
import { parseCompute, resolveAssignment, type ResolvedAssignment } from "@foldedspacelabs/metistry-core";
import {
  CredentialError,
  UNPRODUCTIVE_VETO,
  completeJson,
  completionsUrl,
  credentialFor,
  makeChatClient,
  makeOpenAiEngine,
} from "../src/engine-openai.js";
import { memorySessionStore } from "../src/sessions.js";
import type { ToolHost, ToolSpec } from "../src/tools.js";
import { z } from "zod";

const FILE = `
providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    zdr: true
    caching: auto
    request: { provider: { order: [anthropic], allow_fallbacks: false } }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
    pricing: { anthropic/claude-sonnet-5: { in_per_m: 3, out_per_m: 15 } }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: high }
  tiers:
    routine: { model: lmstudio/google/gemma-3n-e4b, effort: low }
`;

const cfg = parseCompute(FILE);
const cloud = resolveAssignment(cfg, "default")!;
const local = resolveAssignment(cfg, "routine")!;

// ---- the fake server ---------------------------------------------------------

interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  /** an OpenAI chat/completions body, or a raw string for an error response */
  body?: unknown;
}

function server(script: Scripted[]) {
  const requests: { url: string; body: any; headers: Record<string, string> }[] = [];
  const slept: number[] = [];
  const fetchFn = (async (url: any, init: any) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers ?? {} });
    const next = script.shift() ?? { body: chat("(script exhausted)") };
    const status = next.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: new Headers(next.headers ?? {}),
      json: async () => next.body,
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, requests, slept, sleep: async (ms: number) => void slept.push(ms) };
}

const chat = (content: string | null, opts: { tool_calls?: unknown[]; usage?: unknown } = {}) => ({
  choices: [{ message: { role: "assistant", content, ...(opts.tool_calls ? { tool_calls: opts.tool_calls } : {}) }, finish_reason: opts.tool_calls ? "tool_calls" : "stop" }],
  usage: opts.usage ?? { prompt_tokens: 100, completion_tokens: 10 },
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function host(answers: Record<string, string | (() => string)>, tools: ToolSpec[] = [{ name: "mcp__brain__knowledge_search", description: "search", parameters: { type: "object", properties: { q: { type: "string" } } } }]): ToolHost & { calls: string[]; closed: number } {
  const state = {
    calls: [] as string[],
    closed: 0,
    async list() {
      return tools;
    },
    async call(name: string) {
      state.calls.push(name);
      const a = answers[name] ?? "(nothing)";
      return { text: typeof a === "function" ? a() : a, isError: false };
    },
    async close() {
      state.closed++;
    },
  };
  return state;
}

const engineOn = (assignment: ResolvedAssignment, s: ReturnType<typeof server>, h: ToolHost, extra: Record<string, unknown> = {}) =>
  makeOpenAiEngine({
    tools: () => h,
    sessions: memorySessionStore(),
    systemPrompt: "you are the instance's assistant",
    fetchFn: s.fetchFn,
    sleep: s.sleep,
    env: { METISTRY_OPENROUTER_API_KEY: "sk-test" },
    ...extra,
  });

// ---- the wire ----------------------------------------------------------------

describe("the request", () => {
  it("posts to <base_url>/chat/completions with the bearer, the pinned model and the provider's request: block verbatim", async () => {
    const s = server([{ body: chat("done") }]);
    const h = host({});
    await engineOn(cloud, s, h)("hello", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });
    const req = s.requests[0]!;
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.body.model).toBe("anthropic/claude-sonnet-5");
    expect(req.body.provider).toEqual({ order: ["anthropic"], allow_fallbacks: false });
    expect(req.body.reasoning).toEqual({ effort: "high" }); // off_machine takes the effort knob
    expect(req.body.messages[0]).toEqual({ role: "system", content: "you are the instance's assistant" });
  });

  it("reasoning is OFF on an on_machine provider (PoC-16), and a local provider gets no bearer at all", async () => {
    const s = server([{ body: chat("ok") }]);
    await engineOn(local, s, host({}))("hi", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    expect(s.requests[0]!.body.reasoning).toEqual({ enabled: false });
    expect(s.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("a request: block cannot repoint the call — model and messages belong to the assignment (invariant 4)", async () => {
    const hijack = parseCompute(FILE.replace("request: { provider: { order: [anthropic], allow_fallbacks: false } }", 'request: { model: someone/elses-model, messages: [], temperature: 0.2 }'));
    const a = resolveAssignment(hijack, "default")!;
    const s = server([{ body: chat("ok") }]);
    await engineOn(a, s, host({}))("hi", { model: a.model, effort: a.effort, assignment: a, thread: "t" });
    expect(s.requests[0]!.body.model).toBe("anthropic/claude-sonnet-5");
    expect(s.requests[0]!.body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
    expect(s.requests[0]!.body.temperature).toBe(0.2); // everything else IS verbatim
  });

  it("a declared credential that is unset refuses by name, before anything is sent", () => {
    expect(() => credentialFor(cloud.config, "openrouter", {})).toThrow(CredentialError);
    try {
      credentialFor(cloud.config, "openrouter", {});
    } catch (err) {
      expect((err as Error).message).toContain("providers.openrouter.auth.secret = METISTRY_OPENROUTER_API_KEY");
    }
    expect(completionsUrl("http://x/v1/")).toBe("http://x/v1/chat/completions");
  });
});

// ---- prompt caching (OPEN-6, ruled 2026-09-17) -------------------------------

describe("automatic prompt caching", () => {
  const spec = (a: ResolvedAssignment) => ({ model: a.model, effort: a.effort, assignment: a, thread: "t" });

  it("sends ONE top-level cache_control on a provider whose block says caching: auto", async () => {
    const s = server([{ body: chat("ok") }]);
    await engineOn(cloud, s, host({}))("hi", spec(cloud));
    expect(s.requests[0]!.body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends nothing for caching: off, an absent field, or a local server", async () => {
    const off = resolveAssignment(parseCompute(FILE.replace("caching: auto", "caching: off")), "default")!;
    const absent = resolveAssignment(parseCompute(FILE.replace("    caching: auto\n", "")), "default")!;
    for (const a of [off, absent, local]) {
      const s = server([{ body: chat("ok") }]);
      await engineOn(a, s, host({}))("hi", spec(a));
      expect(s.requests[0]!.body.cache_control).toBeUndefined();
    }
  });

  it("the operator's request: block still wins — explicit breakpoints are theirs to write", async () => {
    const explicit = resolveAssignment(
      parseCompute(FILE.replace("request: { provider: { order: [anthropic], allow_fallbacks: false } }", 'request: { cache_control: { type: ephemeral, ttl: 1h } }')),
      "default",
    )!;
    const s = server([{ body: chat("ok") }]);
    await engineOn(explicit, s, host({}))("hi", spec(explicit));
    expect(s.requests[0]!.body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("cached tokens land on the turn as cache_read / cache_write, summed over the loop", async () => {
    const usage = (cached: number) => ({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: cached }, cache_write_tokens: 100 });
    const s = server([
      { body: chat(null, { tool_calls: [toolCall("c1", "mcp__brain__knowledge_search", { q: "folds" })], usage: usage(0) }) },
      { body: chat("two notes", { usage: usage(900) }) },
    ]);
    const r = await engineOn(cloud, s, host({ mcp__brain__knowledge_search: "two notes mention folds" }))("hi", spec(cloud));
    expect(r).toMatchObject({ tokens_in: 2000, cache_read: 900, cache_write: 200 });
  });

  it("a turn whose provider reported ZERO cached tokens records 0, not nothing — OPEN-6 reads the difference", async () => {
    // A cold prefix and a provider that has never heard of the field are two
    // different findings, and only one of them is answered by looking at what
    // changes turn to turn. They have to be distinguishable on the row.
    const s = server([{ body: chat("ok", { usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }) }]);
    const r = await engineOn(cloud, s, host({}))("hi", spec(cloud));
    expect(r.cache_read).toBe(0);
    expect(r.cache_write).toBeUndefined(); // this response said nothing about writes
  });

  it("a turn whose provider reported no cache fields at all records neither", async () => {
    const s = server([{ body: chat("ok", { usage: { prompt_tokens: 1000, completion_tokens: 10 } }) }]);
    const r = await engineOn(cloud, s, host({}))("hi", spec(cloud));
    expect(r.cache_read).toBeUndefined();
    expect(r.cache_write).toBeUndefined();
  });

  it("an Anthropic-native usage block lands as one whole prompt, not the fresh remainder", async () => {
    // `/v1/messages` reports `input_tokens` as the FRESH share with both cache
    // counts beside it (core's usageFromResponse): 100 + 600 + 300.
    const s = server([{ body: chat("ok", { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 } }) }]);
    const r = await engineOn(cloud, s, host({}))("hi", spec(cloud));
    expect(r).toMatchObject({ tokens_in: 1000, tokens_out: 10, cache_read: 600, cache_write: 300 });
  });

  it("the cached share is priced at the cache multipliers when the response carries no cost", async () => {
    // 100k fresh at $3/M, 800k read at 0.1x, 100k written at 1.25x, no output
    const s = server([{ body: chat("ok", { usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 800_000 }, cache_write_tokens: 100_000 } }) }]);
    const r = await engineOn(cloud, s, host({}))("hi", spec(cloud));
    expect(r).toMatchObject({ cost_usd: 0.915, cost_source: "pricing" });
  });

  it("a shadow inherits its CANDIDATE provider's setting, not the assignment's", async () => {
    // the incumbent caches nothing, the candidate's block says auto: the
    // field travels with the provider being dialled, which is the only
    // reading that survives a candidate on another cloud.
    const file = `
providers:
  plain:
    kind: openai-compatible
    base_url: https://plain.test/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
  cached:
    kind: openai-compatible
    base_url: https://cached.test/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    caching: auto
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
assignments:
  default:
    model: plain/incumbent
    shadow: { model: cached/candidate, fraction: 0.5 }
`;
    const a = resolveAssignment(parseCompute(file), "default")!;
    const s = server([{ body: chat("the incumbent's answer") }, { body: chat("the candidate's answer") }]);
    await engineOn(a, s, host({}), { random: () => 0.05 })("hi", spec(a));
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]!.body.cache_control).toBeUndefined();            // plain/incumbent
    expect(s.requests[1]!.url).toBe("https://cached.test/v1/chat/completions");
    expect(s.requests[1]!.body.cache_control).toEqual({ type: "ephemeral" }); // cached/candidate
  });
});

// ---- the tool loop -----------------------------------------------------------

describe("the tool loop", () => {
  it("round-trips a tool call: the result goes back as a `tool` message and the tally lands on the result", async () => {
    const s = server([
      { body: chat(null, { tool_calls: [toolCall("c1", "mcp__brain__knowledge_search", { q: "folds" })] }) },
      { body: chat("three notes mention folds") },
    ]);
    const h = host({ mcp__brain__knowledge_search: "Areas/folds.md" });
    const r = await engineOn(cloud, s, h)("what do we know about folds?", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });

    expect(h.calls).toEqual(["mcp__brain__knowledge_search"]);
    expect(r.text).toBe("three notes mention folds");
    expect(r.tools_used).toEqual({ mcp__brain__knowledge_search: 1 });
    expect(r.turns).toBe(2);
    expect(h.closed).toBe(1); // the host is closed even on the happy path
    const second = s.requests[1]!.body.messages;
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: "Areas/folds.md" });
    expect(s.requests[0]!.body.tools[0].function.name).toBe("mcp__brain__knowledge_search");
  });

  it("the no-progress veto: the same call with the same answer nudges at 3 and stops tool use at 5, then answers", async () => {
    const repeat = toolCall("c", "mcp__brain__knowledge_search", { q: "same" });
    // the FIRST call is productive (nothing was known before it), so the veto
    // needs five repeats after it — which is the definition, not an off-by-one
    const s = server([
      ...Array.from({ length: UNPRODUCTIVE_VETO + 1 }, () => ({ body: chat(null, { tool_calls: [repeat] }) })),
      { body: chat("I could not find it.") },
    ]);
    const h = host({ mcp__brain__knowledge_search: "identical answer" });
    const r = await engineOn(cloud, s, h)("find it", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });

    expect(r.stopped).toBe("veto");
    expect(r.text).toBe("I could not find it.");
    expect(h.calls).toHaveLength(UNPRODUCTIVE_VETO + 1);
    // the nudge is one user message, added once, at the third unproductive turn
    const nudges = s.requests.at(-1)!.body.messages.filter((m: any) => typeof m.content === "string" && m.content.includes("returned nothing you had not already seen"));
    expect(nudges).toHaveLength(1);
    expect(s.requests.at(-1)!.body.tools).toBeUndefined(); // the final request carries no tools at all
  });

  it("a call whose ANSWER changes is productive, however often it repeats", async () => {
    let n = 0;
    const repeat = toolCall("c", "mcp__brain__tasks_list", {});
    const s = server([
      ...Array.from({ length: 6 }, () => ({ body: chat(null, { tool_calls: [repeat] }) })),
      { body: chat("the list settled") },
    ]);
    const h = host({ mcp__brain__tasks_list: () => `answer ${n++}` }, [{ name: "mcp__brain__tasks_list", description: "", parameters: {} }]);
    const r = await engineOn(cloud, s, h)("watch the list", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t", maxTurns: 8 });
    expect(r.stopped).toBeUndefined();
    expect(h.calls).toHaveLength(6);
  });

  it("out of turns: the last request goes out with tools off, so the run ends in an answer", async () => {
    const call = toolCall("c", "mcp__brain__knowledge_search", { q: "x" });
    const s = server([{ body: chat(null, { tool_calls: [call] }) }, { body: chat(null, { tool_calls: [call] }) }, { body: chat("here is what I have") }]);
    const r = await engineOn(cloud, s, host({ mcp__brain__knowledge_search: "a" }))("go", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t", maxTurns: 2 });
    expect(r.stopped).toBe("max_turns");
    expect(r.text).toBe("here is what I have");
  });

  it("the per-run cost cap stops the loop between requests and answers", async () => {
    const call = toolCall("c", "mcp__brain__knowledge_search", { q: "x" });
    const s = server([
      { body: chat(null, { tool_calls: [call], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.5 } }) },
      { body: chat("stopping there", { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }) },
    ]);
    const r = await engineOn(cloud, s, host({ mcp__brain__knowledge_search: "a" }))("go", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t", maxCostUsd: 0.25 });
    expect(r.stopped).toBe("max_budget");
    expect(r.cost_usd).toBeCloseTo(0.51, 6);
  });
});

// ---- retries and cost --------------------------------------------------------

describe("backoff and cost", () => {
  it("retries a 429 honouring Retry-After, then succeeds", async () => {
    const s = server([{ status: 429, headers: { "retry-after": "2" }, body: "slow down" }, { body: chat("ok") }]);
    const r = await engineOn(cloud, s, host({}))("hi", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });
    expect(r.text).toBe("ok");
    expect(s.slept).toEqual([2000]);
    expect(s.requests).toHaveLength(2);
  });

  it("retries a 5xx on exponential backoff and gives up with the provider's own status", async () => {
    const s = server([{ status: 503, body: "loading model" }, { status: 503, body: "loading model" }]);
    const client = makeChatClient({ assignment: local, fetchFn: s.fetchFn, sleep: s.sleep, attempts: 2, backoffMs: 100 });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/returned 503/);
    expect(s.slept).toEqual([100]);
  });

  it("a 4xx that is not 429 is not retried — a bad request will be bad again", async () => {
    const s = server([{ status: 400, body: "no such model" }]);
    const client = makeChatClient({ assignment: local, fetchFn: s.fetchFn, sleep: s.sleep });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/returned 400/);
    expect(s.slept).toEqual([]);
  });

  it("cost comes from the provider's usage.cost when it sends one …", async () => {
    const s = server([{ body: chat("ok", { usage: { prompt_tokens: 2000, completion_tokens: 100, cost: 0.0042, prompt_tokens_details: { cached_tokens: 1500 } } }) }]);
    const r = await engineOn(cloud, s, host({}))("hi", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });
    expect(r).toMatchObject({ cost_usd: 0.0042, cost_source: "provider", tokens_in: 2000, tokens_out: 100, cache_read: 1500, provider: "openrouter", model: "anthropic/claude-sonnet-5" });
  });

  it("… and from the pricing: table when it does not; a local turn is 0 and says `local`", async () => {
    const priced = server([{ body: chat("ok", { usage: { prompt_tokens: 1_000_000, completion_tokens: 200_000 } }) }]);
    const r = await engineOn(cloud, priced, host({}))("hi", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });
    expect(r).toMatchObject({ cost_usd: 6, cost_source: "pricing" });

    const free = server([{ body: chat("ok", { usage: { prompt_tokens: 9000, completion_tokens: 900 } }) }]);
    const l = await engineOn(local, free, host({}))("hi", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    expect(l).toMatchObject({ cost_usd: 0, cost_source: "local", provider: "lmstudio" });
  });

  it("an unpriced off-machine call is $0 with a note naming the pricing field — never a guessed rate", async () => {
    const unlisted = resolveAssignment(parseCompute(FILE.replace("pricing: { anthropic/claude-sonnet-5: { in_per_m: 3, out_per_m: 15 } }", "pricing: {}")), "default")!;
    const s = server([{ body: chat("ok", { usage: { prompt_tokens: 100, completion_tokens: 10 } }) }]);
    const r = await engineOn(unlisted, s, host({}))("hi", { model: unlisted.model, effort: unlisted.effort, assignment: unlisted, thread: "t" });
    expect(r.cost_usd).toBe(0);
    expect(r.cost_source).toBe("unknown");
    expect(r.notes?.[0]).toContain("providers.openrouter.pricing");
  });
});

// ---- sessions ----------------------------------------------------------------

describe("sessions", () => {
  it("a resumed session replays its history; a session built on another model is not resumed", async () => {
    const sessions = memorySessionStore();
    const s = server([{ body: chat("first") }, { body: chat("second") }, { body: chat("third") }]);
    const engine = makeOpenAiEngine({ tools: () => host({}), sessions, fetchFn: s.fetchFn, sleep: s.sleep, env: { METISTRY_OPENROUTER_API_KEY: "k" } });
    const one = await engine("hello", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });
    await engine("again", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t", resume: one.session_id });
    expect(s.requests[1]!.body.messages.map((m: any) => m.content)).toEqual(["hello", "first", "again"]);

    // the same id, a different model: the transcript is NOT replayed into it
    await engine("again", { model: local.model, effort: local.effort, assignment: local, thread: "t", resume: one.session_id });
    expect(s.requests[2]!.body.messages.map((m: any) => m.content)).toEqual(["again"]);
  });
});

// ---- structured output -------------------------------------------------------

describe("completeJson", () => {
  const schema = z.object({ tier: z.enum(["fast", "deep"]), why: z.string().min(1) });
  const jsonSchema = { type: "object", properties: { tier: { type: "string" }, why: { type: "string" } }, required: ["tier", "why"], additionalProperties: false };

  it("sends response_format: json_schema and validates the answer with zod anyway", async () => {
    const s = server([{ body: chat('{"tier":"deep","why":"it needs judgement"}') }]);
    const client = makeChatClient({ assignment: cloud, apiKey: "k", fetchFn: s.fetchFn, sleep: s.sleep });
    const r = await completeJson(client, { messages: [{ role: "user", content: "which tier?" }], schema, jsonSchema, name: "tier_pick" });
    expect(r.value).toEqual({ tier: "deep", why: "it needs judgement" });
    expect(r.repaired).toBe(false);
    expect(s.requests[0]!.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "tier_pick", strict: true } });
  });

  it("repairs ONCE when the provider treated the schema as a hint, carrying the validation error back", async () => {
    const s = server([{ body: chat('```json\n{"tier":"medium"}\n```') }, { body: chat('{"tier":"fast","why":"a lookup"}') }]);
    const client = makeChatClient({ assignment: cloud, apiKey: "k", fetchFn: s.fetchFn, sleep: s.sleep });
    const r = await completeJson(client, { messages: [{ role: "user", content: "which tier?" }], schema, jsonSchema });
    expect(r.value.tier).toBe("fast");
    expect(r.repaired).toBe(true);
    const repair = s.requests[1]!.body.messages.at(-1);
    expect(repair.content).toContain("did not match the schema");
    expect(repair.content).toContain("tier:");
  });

  it("two failures is a failure — it never returns unvalidated JSON", async () => {
    const s = server([{ body: chat("not json at all") }, { body: chat('{"tier":"nope"}') }]);
    const client = makeChatClient({ assignment: cloud, apiKey: "k", fetchFn: s.fetchFn, sleep: s.sleep });
    await expect(completeJson(client, { messages: [{ role: "user", content: "x" }], schema, jsonSchema })).rejects.toThrow(/structured output failed twice/);
  });
});

// ---- stage-2 shadow mode -----------------------------------------------------
//
// The loop's half of shadow.ts: WHEN a second run happens, what it is pointed
// at, and the two things it must never do — answer the user, or touch a tool.

describe("shadow mode", () => {
  const SHADOW_FILE = `
providers:
  lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine }
  candid:   { kind: openai-compatible, base_url: http://127.0.0.1:7813/v1, locality: on_machine }
assignments:
  default:
    model: lmstudio/incumbent
    shadow: { model: candid/qwen3.6-35b-a3b, fraction: 0.1 }
`;
  const shadowed = resolveAssignment(parseCompute(SHADOW_FILE), "default")!;
  const spec = () => ({ model: shadowed.model, effort: shadowed.effort, assignment: shadowed, thread: "t" });

  /** A session store that remembers every save, so "the shadow gets no session" is checkable. */
  function recordingSessions() {
    const inner = memorySessionStore();
    const saved: { provider: string; model: string }[] = [];
    return {
      saved,
      newId: () => inner.newId(),
      load: inner.load,
      async save(state: any) {
        saved.push({ provider: state.provider, model: state.model });
        return inner.save(state);
      },
    };
  }

  it("a sampled turn runs the SAME turn again on the candidate, and the user still gets the assignment's answer", async () => {
    const s = server([{ body: chat("the incumbent's answer") }, { body: chat("the candidate's answer") }]);
    const sessions = recordingSessions();
    const r = await engineOn(shadowed, s, host({}), { sessions, random: () => 0.05 })("hello", spec());

    expect(r.text).toBe("the incumbent's answer"); // what the drain writes to the user
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.url).toBe("http://127.0.0.1:7813/v1/chat/completions");
    expect(s.requests[1]!.body.model).toBe("qwen3.6-35b-a3b");
    // the same turn, not a summary: the system prompt and the user's words, verbatim
    expect(s.requests[1]!.body.messages).toEqual(s.requests[0]!.body.messages);

    expect(r.shadow?.shadow).toMatchObject({ provider: "candid", model: "qwen3.6-35b-a3b", text: "the candidate's answer", turns: 1 });
    expect(r.shadow?.real).toMatchObject({ provider: "lmstudio", model: "incumbent", text: "the incumbent's answer" });
    expect(r.shadow?.agreement).toMatchObject({ tool_sequence: true, score: expect.any(Number) });
    // one session, the real one: a shadow transcript that could be resumed
    // would be a second history for one thread
    expect(sessions.saved).toEqual([{ provider: "lmstudio", model: "incumbent" }]);
  });

  it("an unsampled turn is one request, and carries no shadow at all", async () => {
    const s = server([{ body: chat("just the one") }]);
    const r = await engineOn(shadowed, s, host({}), { random: () => 0.5 })("hello", spec());
    expect(s.requests).toHaveLength(1);
    expect(r.shadow).toBeUndefined();
  });

  it("an assignment with no shadow: block never draws and never runs a second time", async () => {
    const s = server([{ body: chat("ok") }]);
    let draws = 0;
    const r = await engineOn(cloud, s, host({}), {
      random: () => {
        draws++;
        return 0;
      },
    })("hi", { model: cloud.model, effort: cloud.effort, assignment: cloud, thread: "t" });
    expect(draws).toBe(0);
    expect(s.requests).toHaveLength(1);
    expect(r.shadow).toBeUndefined();
  });

  it("the shadow's tool calls are recorded, never executed — and the identical call gets the real run's result", async () => {
    const search = toolCall("c1", "mcp__brain__knowledge_search", { q: "folds" });
    const s = server([
      { body: chat(null, { tool_calls: [search] }) },            // the real turn calls the tool …
      { body: chat("three notes mention folds") },               // … and answers
      { body: chat(null, { tool_calls: [search, toolCall("c2", "mcp__brain__knowledge_write", { path: "Areas/folds.md" })] }) }, // the shadow calls it, and a WRITE
      { body: chat("two notes, and I wrote one") },
    ]);
    const h = host({ mcp__brain__knowledge_search: "Areas/folds.md" });
    const r = await engineOn(shadowed, s, h, { random: () => 0 })("what about folds?", spec());

    // the REAL host was called once, by the real turn, and not again
    expect(h.calls).toEqual(["mcp__brain__knowledge_search"]);
    expect(r.shadow?.shadow.tool_calls).toEqual([
      { name: "mcp__brain__knowledge_search", args: { q: "folds" }, executed: false, result_from: "real_run" },
      { name: "mcp__brain__knowledge_write", args: { path: "Areas/folds.md" }, executed: false, result_from: "stub" },
    ]);
    // the recorded result is the real one for the identical call; the write got the stub
    const shadowTurn = s.requests[3]!.body.messages.filter((m: any) => m.role === "tool");
    expect(shadowTurn[0].content).toBe("Areas/folds.md");
    expect(shadowTurn[1].content).toContain("recorded, not executed");
    // and the ORDER is what agreement compares, so a one-extra-call shadow disagrees
    expect(r.shadow?.agreement.tool_sequence).toBe(false);
  });

  it("the budget gate is asked for the shadow too, with its own provider and critical: false — a refusal skips it", async () => {
    const s = server([{ body: chat("the real answer") }]);
    const asked: { provider: string; critical: boolean }[] = [];
    const r = await engineOn(shadowed, s, host({}), {
      random: () => 0,
      guard: async (sp: any) => {
        asked.push({ provider: sp.assignment.provider, critical: sp.assignment.critical });
        throw new Error("budget_exceeded: instance daily_usd is spent");
      },
    })("hello", spec());
    expect(asked).toEqual([{ provider: "candid", critical: false }]); // the real turn's gate ran in makeEngine, not here
    expect(s.requests).toHaveLength(1);
    expect(r.shadow).toBeUndefined();
    expect(r.text).toBe("the real answer");
  });

  it("a candidate that is down costs the turn nothing: the answer stands and the shadow row carries the reason", async () => {
    const s = server([{ body: chat("the real answer") }, { status: 500, body: "model not loaded" }]);
    const r = await engineOn(shadowed, s, host({}), { random: () => 0, attempts: 1 })("hello", spec());
    expect(r.text).toBe("the real answer");
    expect(r.shadow?.shadow.error).toContain("returned 500");
    expect(r.shadow?.shadow.cost_usd).toBe(0);
  });
});
