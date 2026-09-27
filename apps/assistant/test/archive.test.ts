// The session archive's writer (T3-9) — no database: the loop against a fake
// OpenAI-compatible server, and the Postgres store against a recording fake.
//
// The ticket's own test is the first block: **arguments and results pass
// through `core/redact.ts`** — wherever they appear in the archived turn,
// including the copies riding inside the messages, and in the store itself
// so no caller can hand it an unredacted turn. The rest is the shape the
// archive promises its readers (`session_detail`, the fold): one row per
// turn, keyed by the same `turn_id` the tool calls carried, holding only
// that turn's messages, with the system prompt as sent.
import { describe, expect, it } from "vitest";
import { parseCompute, redactSecrets, resolveAssignment, REDACTED } from "@foldedspacelabs/metistry-core";
import { ARCHIVE_TTL_DAYS, memorySessionArchive, pgSessionArchive, redactTurn, type TurnRecord } from "../src/archive.js";
import { makeOpenAiEngine } from "../src/engine-openai.js";
import { memorySessionStore } from "../src/sessions.js";
import type { TurnSpec } from "../src/engine.js";
import type { ToolHost } from "../src/tools.js";

const FILE = `
providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
assignments:
  default: { model: lmstudio/google/gemma-3n-e4b, effort: low }
`;
const local = resolveAssignment(parseCompute(FILE), "default")!;

const chat = (content: string | null, tool_calls?: unknown[]) => ({
  choices: [{ message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/** A fake provider that answers from a script, and records every request body. */
function server(script: unknown[]) {
  const bodies: any[] = [];
  const fetchFn = (async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    const body = script.shift() ?? chat("(script exhausted)");
    return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

/** A tool host that answers every call with `answer`, and remembers the spec it was built from. */
function hostFor(answer: string, seen: TurnSpec[]): (spec: TurnSpec) => ToolHost {
  return (spec) => {
    seen.push(spec);
    return {
      list: async () => [{ name: "mcp__brain__knowledge_search", description: "search", parameters: { type: "object", properties: {} } }],
      call: async () => ({ text: answer, isError: false }),
      close: async () => {},
    };
  };
}

const SECRET_ARG = "hunter2-the-password";
const SECRET_RESULT = "sk-live-0123456789";

describe("**arguments and results pass through core/redact.ts** (T3-9)", () => {
  it("a turn's tool arguments and results are redacted in tool_calls AND in the messages that carry them", async () => {
    const archive = memorySessionArchive();
    const s = server([chat(null, [toolCall("c1", "mcp__brain__knowledge_search", { q: "vpn", password: SECRET_ARG })]), chat("done")]);
    const engine = makeOpenAiEngine({ tools: hostFor(JSON.stringify({ ok: true, api_key: SECRET_RESULT, hits: [{ path: "Areas/Net.md" }] }), []), sessions: memorySessionStore(), archive, fetchFn: s.fetchFn, sleep: async () => {} });
    await engine("find the vpn page", { model: local.model, effort: local.effort, assignment: local, thread: "t" });

    expect(archive.rows).toHaveLength(1);
    const row = archive.rows[0]!;
    // nowhere in the row — not the tool_calls column, not the assistant's
    // wire-format arguments, not the tool message's content
    const whole = JSON.stringify(row);
    expect(whole).not.toContain(SECRET_ARG);
    expect(whole).not.toContain(SECRET_RESULT);

    // …and what IS there is exactly redact.ts's answer, not a look-alike
    expect(row.tool_calls).toEqual([
      {
        id: "c1",
        tool: "mcp__brain__knowledge_search",
        args: redactSecrets({ q: "vpn", password: SECRET_ARG }),
        result: redactSecrets({ ok: true, api_key: SECRET_RESULT, hits: [{ path: "Areas/Net.md" }] }),
        is_error: false,
      },
    ]);
    expect((row.tool_calls[0]!.args as any).password).toBe(REDACTED);
    expect((row.tool_calls[0]!.result as any).api_key).toBe(REDACTED);
    const assistant = row.messages.find((m) => m.role === "assistant" && m.tool_calls)!;
    expect(JSON.parse((assistant.tool_calls![0] as any).function.arguments)).toEqual({ q: "vpn", password: REDACTED });
    const tool = row.messages.find((m) => m.role === "tool")!;
    expect(JSON.parse(tool.content!)).toMatchObject({ api_key: REDACTED, hits: [{ path: "Areas/Net.md" }] });
  });

  it("the Postgres store redacts before it writes — no caller can hand it a turn and have a secret reach the database", async () => {
    const sent: unknown[][] = [];
    const store = pgSessionArchive({
      query: async (_text, values) => {
        sent.push(values ?? []);
        return { rows: [] };
      },
    });
    const turn: TurnRecord = {
      session_id: "3f0e0f0e-0000-4000-8000-000000000001",
      thread: "default",
      turn_id: "turn-1",
      system_prompt: "you are the assistant",
      messages: [
        { role: "user", content: "log in" },
        { role: "assistant", content: null, tool_calls: [toolCall("c1", "mcp__brain__propose_action", { token: SECRET_ARG })] },
        { role: "tool", tool_call_id: "c1", name: "mcp__brain__propose_action", content: JSON.stringify({ authorization: `Bearer ${SECRET_RESULT}` }) },
      ],
      tool_calls: [{ id: "c1", tool: "mcp__brain__propose_action", args: { token: SECRET_ARG }, result: JSON.stringify({ authorization: `Bearer ${SECRET_RESULT}` }), is_error: false }],
    };
    await store.append(turn);
    expect(sent).toHaveLength(1);
    const params = JSON.stringify(sent[0]);
    expect(params).not.toContain(SECRET_ARG);
    expect(params).not.toContain(SECRET_RESULT);
    expect(sent[0]![6]).toBe(ARCHIVE_TTL_DAYS); // expires_at is the store's, 30 days — never a caller's
    // the input was not mutated: redaction returns new structures
    expect((turn.tool_calls[0]!.args as any).token).toBe(SECRET_ARG);
  });

  it("text that is not JSON has no keys to find and is kept as it came; JSON arrays are walked", () => {
    const r = redactTurn({
      session_id: "s",
      thread: "t",
      turn_id: "x",
      system_prompt: "",
      messages: [{ role: "tool", tool_call_id: "c", content: "3 hits for vpn" }],
      tool_calls: [
        { id: "c", tool: "t", args: {}, result: "3 hits for vpn", is_error: false },
        { id: "d", tool: "t", args: [{ secret: "a" }], result: '[{"password":"b"}]', is_error: false },
      ],
    });
    expect(r.messages[0]!.content).toBe("3 hits for vpn");
    expect(r.tool_calls[0]!.result).toBe("3 hits for vpn");
    expect(r.tool_calls[1]!.args).toEqual([{ secret: REDACTED }]);
    expect(r.tool_calls[1]!.result).toEqual([{ password: REDACTED }]);
  });
});

describe("one row per turn, keyed like its tool calls", () => {
  it("the turn_id is the one the tool host stamped on every call — the drain's when it passes one, the engine's own otherwise — and comes back on the result", async () => {
    const archive = memorySessionArchive();
    const seen: TurnSpec[] = [];
    const s = server([chat(null, [toolCall("c1", "mcp__brain__knowledge_search", { q: "a" })]), chat("one"), chat("two")]);
    const engine = makeOpenAiEngine({ tools: hostFor("[]", seen), sessions: memorySessionStore(), archive, fetchFn: s.fetchFn, sleep: async () => {} });

    const first = await engine("q1", { model: local.model, effort: local.effort, assignment: local, thread: "t", turnId: "turn-from-the-drain" });
    expect(seen[0]!.turnId).toBe("turn-from-the-drain");
    expect(first.turn_id).toBe("turn-from-the-drain");
    expect(archive.rows[0]!.turn_id).toBe("turn-from-the-drain");

    const second = await engine("q2", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    expect(second.turn_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.turnId).toBe(second.turn_id);
    expect(archive.rows[1]!.turn_id).toBe(second.turn_id);
  });

  it("a resumed turn archives only its OWN messages — the replayed history is already in the rows that wrote it — and the system prompt as sent", async () => {
    const archive = memorySessionArchive();
    const sessions = memorySessionStore();
    const s = server([chat("first answer"), chat("second answer")]);
    const engine = makeOpenAiEngine({ tools: hostFor("", []), sessions, archive, systemPrompt: "you are the instance's assistant", fetchFn: s.fetchFn, sleep: async () => {} });
    const one = await engine("first question", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    const two = await engine("second question", { model: local.model, effort: local.effort, assignment: local, thread: "t", resume: one.session_id });

    expect(two.session_id).toBe(one.session_id);
    // the provider saw the whole history on the second turn…
    expect(s.bodies[1].messages.map((m: any) => m.content)).toEqual(["you are the instance's assistant", "first question", "first answer", "second question"]);
    // …and the archive holds each turn once, in its own row
    expect(archive.rows.map((r) => r.messages.map((m) => m.content))).toEqual([
      ["first question", "first answer"],
      ["second question", "second answer"],
    ]);
    for (const r of archive.rows) {
      expect(r.session_id).toBe(one.session_id);
      expect(r.thread).toBe("t");
      expect(r.system_prompt).toBe("you are the instance's assistant");
    }
  });

  it("a turn that ran out of tool turns archives the closing instruction where it was sent — though the replayed history never keeps it", async () => {
    const archive = memorySessionArchive();
    const sessions = memorySessionStore();
    const s = server([chat(null, [toolCall("c1", "mcp__brain__knowledge_search", { q: "a" })]), chat("what I have")]);
    const engine = makeOpenAiEngine({ tools: hostFor("[]", []), sessions, archive, maxTurns: 1, fetchFn: s.fetchFn, sleep: async () => {} });
    const r = await engine("q", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    expect(r.stopped).toBe("max_turns");
    const roles = archive.rows[0]!.messages.map((m) => `${m.role}:${m.content ?? "(calls)"}`);
    expect(roles).toEqual(["user:q", "assistant:(calls)", "tool:[]", "user:You have run out of tool turns. Answer now with what you have, and say what is still open.", "assistant:what I have"]);
    const kept = await sessions.load(r.session_id, local.provider, local.model);
    expect(kept!.messages.some((m) => String(m.content).startsWith("You have run out"))).toBe(false);
  });

  it("an archive that fails to write never fails the turn — the reply is delivered and the miss is a note on the run", async () => {
    const s = server([chat("still answered")]);
    const engine = makeOpenAiEngine({
      tools: hostFor("", []),
      sessions: memorySessionStore(),
      archive: { append: async () => { throw new Error("relation \"session_archive\" does not exist"); } },
      fetchFn: s.fetchFn,
      sleep: async () => {},
    });
    const r = await engine("q", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    expect(r.text).toBe("still answered");
    expect(r.notes).toEqual(['session archive not written: relation "session_archive" does not exist']);
  });

  it("no archive configured (a crew run, a test) archives nothing and adds no note", async () => {
    const s = server([chat("ok")]);
    const engine = makeOpenAiEngine({ tools: hostFor("", []), sessions: memorySessionStore(), fetchFn: s.fetchFn, sleep: async () => {} });
    const r = await engine("q", { model: local.model, effort: local.effort, assignment: local, thread: "t" });
    expect(r.notes).toBeUndefined();
  });
});
