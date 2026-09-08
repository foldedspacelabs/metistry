// reply-review against a fake db: the rendering, the template, and the two
// properties that make it safe to schedule daily — exactly one proposal per
// pass, and no model anywhere in it (the "suggested edit" is a listing of
// what was flagged, not generated prose).
import { describe, expect, it } from "vitest";
import { patterns, run, suggestedSection, type FlaggedCase } from "../reply-review/run.js";
import { run as weeklyReview } from "../weekly-review/run.js";

const now = new Date("2026-09-08T12:00:00Z");

interface Call {
  text: string;
  values: unknown[];
}

/** A db that answers the flagged-rows query with `flagged`, the last-proposal-ts lookup with `lastProposal`, and records the insert. */
function fakeDb(flagged: any[], lastProposal: any[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("SELECT ts FROM proposals")) return { rows: lastProposal };
      if (text.includes("FROM reply_feedback f")) return { rows: flagged };
      return { rows: [] };
    },
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  message_id: 11,
  ts: "2026-09-02T10:00:00Z",
  thread: "default",
  note: "guessed instead of looking it up",
  prompt: "what is open on drey?",
  reply: "probably a few things",
  model: "haiku",
  tools_used: null,
  ...over,
});

const insert = (db: ReturnType<typeof fakeDb>) => db.calls.find((c) => c.text.includes("INSERT INTO proposals"));

describe("reply-review", () => {
  it("says nothing when nothing was flagged (silence-default)", async () => {
    const db = fakeDb([]);
    expect(await run(db, { now })).toBe(0);
    expect(insert(db)).toBeUndefined();
  });

  it("emits exactly ONE improvement proposal, kind/source/trust stamped server-side", async () => {
    const db = fakeDb([row(), row({ message_id: 12, note: null, tools_used: { mcp__brain__knowledge_search: 2 } })]);
    expect(await run(db, { now })).toBe(1);
    const ins = insert(db)!;
    expect(ins.text).toContain("'improvement'");
    expect(ins.text).toContain("'internal'");
    expect(ins.values[0]).toBe("reply-review");
    const payload = JSON.parse(String(ins.values[1]));
    expect(payload.title).toBe("Reply quality: 2 replies flagged 👎");
    expect(payload.window_start).toBe("2026-09-01");
    expect(payload.window_end).toBe("2026-09-08");
    expect(payload.flagged).toHaveLength(2);
    expect(payload.flagged[1].tools).toEqual(["mcp__brain__knowledge_search"]);
    // the suggested edit names the overlay and is a listing, not advice
    expect(payload.suggested_edit).toMatchObject({ path: "assistant-prompt.md", mode: "append_section" });
    expect(payload.suggested_edit.content).toContain("guessed instead of looking it up");
    expect(payload.suggested_edit.content).toContain("what is open on drey?");
    expect(payload.suggested_edit.content).toContain("no model wrote it");
  });

  it("looks back only to the last proposal it emitted, not always 7 days", async () => {
    const lastTs = "2026-09-05T09:00:00Z";
    const db = fakeDb([row()], [{ ts: lastTs }]);
    expect(await run(db, { now })).toBe(1);
    const flaggedCall = db.calls.find((c) => c.text.includes("FROM reply_feedback f"))!;
    expect(new Date(flaggedCall.values[0] as string).toISOString()).toBe(new Date(lastTs).toISOString());
    const payload = JSON.parse(String(insert(db)!.values[1]));
    expect(payload.window_start).toBe("2026-09-05");
  });

  it("falls back to the last 7 days when it has never emitted a proposal", async () => {
    const db = fakeDb([row()], []);
    await run(db, { now });
    const flaggedCall = db.calls.find((c) => c.text.includes("FROM reply_feedback f"))!;
    expect(new Date(flaggedCall.values[0] as string).toISOString()).toBe(
      new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    );
  });

  it("says nothing when there is no new 👎 since the last proposal (silence-default)", async () => {
    const db = fakeDb([], [{ ts: "2026-09-05T09:00:00Z" }]);
    expect(await run(db, { now })).toBe(0);
    expect(insert(db)).toBeUndefined();
  });

  it("never writes anything but a proposal — no vault, no prompt, no outbound message", async () => {
    const db = fakeDb([row()]);
    await run(db, { now });
    const writes = db.calls.filter((c) => /INSERT|UPDATE|DELETE/.test(c.text));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toContain("INSERT INTO proposals");
  });
});

describe("patterns + template (deterministic, invariant 4)", () => {
  const base: FlaggedCase = {
    message_id: 1,
    ts: "2026-09-02 10:00",
    thread: "default",
    note: null,
    prompt: "p",
    reply: "r",
    model: "haiku",
    tools: [],
  };

  it("counts, and never interprets", () => {
    const out = patterns([base, { ...base, message_id: 2, note: "n", tools: ["mcp__brain__capture"] }]);
    expect(out).toContain("1 of 2 answered with no tool call at all");
    expect(out).toContain("1 were flagged without a note — the reply text is all there is to go on");
    expect(out).toContain("2 came from the same thread (default)");
  });

  it("flags an over-long reply and a repeated tool", () => {
    const long = { ...base, reply: "x".repeat(2500), tools: ["t"] };
    expect(patterns([long, { ...long, message_id: 2 }])).toEqual(
      expect.arrayContaining(["2 reply(s) ran past 2000 characters", "2 used t"]),
    );
  });

  it("renders the same section for the same input (no randomness, no clock)", () => {
    const a = suggestedSection([base], "2026-09-08");
    expect(suggestedSection([base], "2026-09-08")).toBe(a);
    expect(a).toContain("## Reply quality — flagged as of 2026-09-08");
    expect(a).toContain("tools used: none");
    expect(a).toContain("it is a placeholder, not advice");
  });
});

// The weekly review's one line about reply quality — asserted against a fake db
// so it does not race the other suites that emit real reviews.
describe("weekly review: reply quality line", () => {
  const weeklyDb = (rated: number, negative: number, waiting: number) => {
    const calls: Call[] = [];
    return {
      calls,
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        if (text.includes("FROM reply_feedback WHERE ts")) return { rows: [{ rated, negative }] };
        if (text.includes("kind = 'improvement'") && text.includes("count(*)")) return { rows: [{ n: waiting }] };
        return { rows: [] };
      },
    };
  };
  const review = (db: ReturnType<typeof weeklyDb>) =>
    String(db.calls.find((c) => c.text.includes("INSERT INTO outbound_messages"))!.values[0]);

  it("names what was rated and what is waiting on the user", async () => {
    const db = weeklyDb(9, 2, 1);
    await weeklyReview(db, { now });
    expect(review(db)).toContain("• reply quality: 9 rated, 2 👎 — 1 improvement proposal awaiting you");
  });

  it("says so honestly when nothing was rated", async () => {
    const db = weeklyDb(0, 0, 0);
    await weeklyReview(db, { now });
    expect(review(db)).toContain("• reply quality: nothing rated this week");
  });
});
