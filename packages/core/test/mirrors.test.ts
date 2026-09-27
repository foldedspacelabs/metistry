// Mirrors (T1-8) without a database: what `raiseMirror` and `resolveAtSource`
// REFUSE before a statement is sent, and that the statement they send is the
// one migration 0027's index answers. The dedupe itself is Postgres's, proved
// against the real table in routines/test/mirrors.integration.test.ts.
import { describe, expect, it } from "vitest";
import { REDACTED, REQUEST_DECISIONS, RESOLVED_AT_SOURCE, parseRequestSource, raiseMirror, resolveAtSource, type MirrorExecutor } from "../src/index.js";

type Call = { text: string; values: unknown[] };

/** A fake executor: answers each statement from the queue, records what was sent. */
function fake(...answers: Record<string, unknown>[][]): MirrorExecutor & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: answers.shift() ?? [] };
    },
  };
}

const pr = { kind: "github", external_ref: "gh:foldedspacelabs/metistry#41", person: "mattcolf" };
const raise = { kind: "pull_request", source_agent: "github-state", trust: "internal" as const, payload: { title: "Groups and sources" }, source: pr };

describe("parseRequestSource", () => {
  it("takes {kind, external_ref, person?}", () => {
    expect(parseRequestSource(pr)).toEqual(pr);
    expect(parseRequestSource({ kind: "linear", external_ref: "linear:ABC-1" })).toEqual({ kind: "linear", external_ref: "linear:ABC-1" });
    expect(parseRequestSource({ kind: "linear", external_ref: "linear:ABC-1", person: null })).toEqual({ kind: "linear", external_ref: "linear:ABC-1", person: null });
  });

  it("refuses a source that could neither dedupe nor expire", () => {
    for (const bad of [null, "gh:x#1", [], {}, { kind: "github" }, { external_ref: "gh:x#1" }, { kind: "", external_ref: "gh:x#1" }, { kind: "github", external_ref: "  " }, { kind: "github", external_ref: 41 }, { kind: "github", external_ref: "gh:x#1", person: 7 }]) {
      expect(() => parseRequestSource(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});

describe("raiseMirror", () => {
  it("inserts with the ON CONFLICT target migration 0027's unique index answers", async () => {
    const db = fake([{ id: "12" }]);
    expect(await raiseMirror(db, { ...raise, group_id: "meeting:abc" })).toEqual({ id: 12, raised: true });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.text.replace(/\s+/g, " ")).toContain("ON CONFLICT ((source->>'kind'), (source->>'external_ref')) WHERE decision = 'pending' DO NOTHING");
    expect(db.calls[0]!.values).toEqual(["pull_request", "github-state", "internal", JSON.stringify(raise.payload), JSON.stringify(pr), "meeting:abc", null]);
  });

  it("a second raise returns the waiting row's id and writes nothing", async () => {
    const db = fake([], [{ id: 12 }]);
    expect(await raiseMirror(db, raise)).toEqual({ id: 12, raised: false });
    expect(db.calls[1]!.text).toMatch(/^SELECT id FROM proposals WHERE decision = 'pending'/);
    expect(db.calls[1]!.values).toEqual([pr.kind, pr.external_ref]);
  });

  it("the waiting row answered mid-raise frees the subject: the next insert takes it", async () => {
    const db = fake([], [], [{ id: 13 }]);
    expect(await raiseMirror(db, raise)).toEqual({ id: 13, raised: true });
    expect(db.calls).toHaveLength(3);
  });

  it("gives up after a bounded number of lost races rather than loop", async () => {
    const db = fake();
    await expect(raiseMirror(db, raise)).rejects.toThrow(/kept being answered/);
    expect(db.calls).toHaveLength(6);
  });

  it("redacts secret-named payload fields, as every queue write does", async () => {
    const db = fake([{ id: 1 }]);
    await raiseMirror(db, { ...raise, payload: { title: "t", api_key: "sk-live-123" } });
    expect(String(db.calls[0]!.values[3])).not.toContain("sk-live-123");
    expect(String(db.calls[0]!.values[3])).toContain(REDACTED);
  });

  it("refuses before sending anything: an unknown kind, a bad source, a bad trust, a blank group", async () => {
    const db = fake();
    await expect(raiseMirror(db, { ...raise, kind: "meeting" })).rejects.toThrow(/not a request kind/); // a meeting is a group_id, never a kind
    await expect(raiseMirror(db, { ...raise, source: { kind: "github", external_ref: "" } })).rejects.toThrow(/external_ref/);
    await expect(raiseMirror(db, { ...raise, trust: "owner" as never })).rejects.toThrow(/trust/);
    await expect(raiseMirror(db, { ...raise, source_agent: "" })).rejects.toThrow(/source_agent/);
    await expect(raiseMirror(db, { ...raise, group_id: "" })).rejects.toThrow(/group_id/);
    expect(db.calls).toHaveLength(0);
  });
});

describe("resolveAtSource", () => {
  it("closes the pending mirror of that subject, and only a row with a source", async () => {
    const db = fake([{ id: "12" }]);
    expect(await resolveAtSource(db, pr)).toEqual([12]);
    const text = db.calls[0]!.text.replace(/\s+/g, " ");
    expect(text).toContain(`SET decision = '${RESOLVED_AT_SOURCE}'`);
    expect(text).toContain("WHERE decision = 'pending' AND source IS NOT NULL");
    expect(db.calls[0]!.values).toEqual([pr.kind, pr.external_ref]);
  });

  it("refuses a blank subject rather than match nothing — or everything", async () => {
    const db = fake();
    await expect(resolveAtSource(db, { kind: "github", external_ref: "" })).rejects.toThrow(TypeError);
    expect(db.calls).toHaveLength(0);
  });

  it("is not an answer the owner can send", () => {
    expect(REQUEST_DECISIONS as readonly string[]).not.toContain(RESOLVED_AT_SOURCE);
  });
});
