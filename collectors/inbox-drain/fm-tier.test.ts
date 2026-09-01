import { describe, expect, it } from "vitest";
import { run, type CollectorCtx } from "./run.js";

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

const ambiguous = { id: 1, path: "1-note.md", mime: "text/markdown", note: "thoughts on the migration approach", source: "note" };
const todoRow = { id: 2, path: "2-note.md", mime: "text/markdown", note: "buy milk", source: "note" };

describe("inbox-drain FM tier (ruled 2026-09-01)", () => {
  it("refines only rule-default items; fired rules stand", async () => {
    const sent: any[] = [];
    const ctx: CollectorCtx = {
      afmUrl: "http://bridge",
      afmToken: "t",
      fetchFn: (async (_url: string, init: any) => {
        sent.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({ results: [{ id: 1, ok: true, classification: { category: "idea", has_action: false, action: "" } }] }),
        };
      }) as unknown as typeof fetch,
    };
    const db = fakeDb([ambiguous, todoRow]);
    await run(db, ctx);
    expect(sent[0].items).toHaveLength(1); // only the ambiguous one crossed
    expect(sent[0].items[0].id).toBe(1);
    const p1 = db.proposals.find((p) => p.inbox_id === 1);
    const p2 = db.proposals.find((p) => p.inbox_id === 2);
    expect(p1.tier).toBe("apple-fm");
    expect(p1.classification.kind).toBe("idea");
    expect(p2.tier).toBe("deterministic"); // todo rule fired; FM never consulted
  });

  it("string ids from pg (bigint) still match FM results (regression)", async () => {
    const ctx: CollectorCtx = {
      afmUrl: "http://bridge",
      afmToken: "t",
      fetchFn: (async () => ({
        ok: true,
        json: async () => ({ results: [{ id: 36, ok: true, classification: { category: "idea", has_action: false, action: "" } }] }),
      })) as unknown as typeof fetch,
    };
    const db = fakeDb([{ ...ambiguous, id: "36" }]); // pg-style string id
    await run(db, ctx);
    expect(db.proposals[0].tier).toBe("apple-fm");
  });

  it("degrades to deterministic on bridge failure or missing config", async () => {
    for (const ctx of [{}, { afmUrl: "http://x", afmToken: "t", fetchFn: (async () => { throw new Error("down"); }) as unknown as typeof fetch }]) {
      const db = fakeDb([{ ...ambiguous }]);
      await run(db, ctx as CollectorCtx);
      expect(db.proposals[0].tier).toBe("deterministic");
      expect(db.proposals[0].classification.kind).toBe("note");
    }
  });
});
