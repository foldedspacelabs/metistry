// makeSdkEngine against a fake SDK stream (no live call): proves the turn
// result carries cache read/write tokens from the result message's `usage`
// (BetaUsage's cache_read_input_tokens / cache_creation_input_tokens) the
// same way it already carries tokens_in/tokens_out and cost — the
// cost-optimisation doc's "measure cache hit rate" starts here.
import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { makeSdkEngine } = await import("../src/engine.js");

function fakeStream(messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

describe("makeSdkEngine", () => {
  it("carries cache_read/cache_write alongside tokens_in/out and cost from the SDK's usage", async () => {
    (query as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "result",
          subtype: "success",
          result: "hi there",
          session_id: "sess-1",
          total_cost_usd: 0.0123,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 30 },
        },
      ]),
    );
    const out = await makeSdkEngine({})("hello", "haiku");
    expect(out).toMatchObject({
      text: "hi there",
      session_id: "sess-1",
      tokens_in: 100,
      tokens_out: 20,
      cache_read: 80,
      cache_write: 30,
      cost_usd: 0.0123,
    });
  });

  it("a result with no cache activity reports cache_read/cache_write as 0, not absent (NonNullableUsage never nulls them)", async () => {
    (query as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-2",
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      ]),
    );
    const out = await makeSdkEngine({})("p", "haiku");
    expect(out.cache_read).toBe(0);
    expect(out.cache_write).toBe(0);
  });
});
