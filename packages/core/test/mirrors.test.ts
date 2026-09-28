// Mirrors (T1-8) without a database: what `raiseMirror` and `resolveAtSource`
// REFUSE before a statement is sent, and that the statement they send is the
// one migration 0027's index answers. The dedupe itself is Postgres's, proved
// against the real table in routines/test/mirrors.integration.test.ts.
import { describe, expect, it } from "vitest";
import { ALSO_ASKED_MAX, DEFAULT_SOURCE_RECEIPT, REDACTED, REQUEST_DECISIONS, RESOLVED_AT_SOURCE, SOURCE_RECEIPT_MAX, parseRequestSource, raiseMirror, resolveAtSource, sourceReceipt, type MirrorExecutor } from "../src/index.js";

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

const pr = { kind: "github", external_ref: "gh:foldedspacelabs/metistry#41", person: "samrivera" };
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

  it("a second raise by the same asker returns the waiting row's id and writes nothing", async () => {
    const db = fake([], [{ id: 12, source_agent: "github-state", also_asked: null }]);
    expect(await raiseMirror(db, raise)).toEqual({ id: 12, raised: false });
    expect(db.calls[1]!.text).toMatch(/^SELECT id, source_agent, payload->'also_asked' AS also_asked FROM proposals WHERE decision = 'pending'/);
    expect(db.calls[1]!.values).toEqual([pr.kind, pr.external_ref]);
    expect(db.calls).toHaveLength(2);
  });

  it("a second raise by ANOTHER asker lands on the same card and adds its asker — once, atomically, bounded", async () => {
    const db = fake([], [{ id: 12, source_agent: "github-state", also_asked: null }], []);
    const ask = { ...raise, source_agent: "agent-a", trust: "external" as const, payload: { title: "Review please", event: "review_asked", context: { prose: "tests pass" }, api_key: "sk-live-9" } };
    expect(await raiseMirror(db, ask)).toEqual({ id: 12, raised: false });
    expect(db.calls).toHaveLength(3);
    const text = db.calls[2]!.text.replace(/\s+/g, " ");
    expect(text).toContain("SET payload = jsonb_set(payload, '{also_asked}', coalesce(payload->'also_asked', '[]'::jsonb) || jsonb_build_array($2::jsonb))");
    expect(text).toContain("WHERE id = $1 AND decision = 'pending' AND source_agent <> $3");
    expect(text).toContain("@> jsonb_build_array(jsonb_build_object('source_agent', $3::text))");
    const [id, asker, agent, max] = db.calls[2]!.values as [number, string, string, number];
    expect([id, agent, max]).toEqual([12, "agent-a", ALSO_ASKED_MAX]);
    expect(JSON.parse(asker)).toMatchObject({ source_agent: "agent-a", trust: "external", title: "Review please", event: "review_asked", context: { prose: "tests pass" } });
    expect(asker).not.toContain("sk-live-9"); // only named fields travel, and those redacted

    // already on the card: nothing is sent
    const again = fake([], [{ id: 12, source_agent: "github-state", also_asked: [{ source_agent: "agent-a" }] }]);
    expect(await raiseMirror(again, ask)).toEqual({ id: 12, raised: false });
    expect(again.calls).toHaveLength(2);
  });

  it("refuses a raise that writes the mirror's own keys — the askers and the receipt are never an asker's to say", async () => {
    const db = fake();
    await expect(raiseMirror(db, { ...raise, payload: { title: "t", also_asked: [] } })).rejects.toThrow(/also_asked/);
    await expect(raiseMirror(db, { ...raise, payload: { title: "t", cleared: { what: "x" } } })).rejects.toThrow(/cleared/);
    expect(db.calls).toHaveLength(0);
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
    expect(db.calls[0]!.values).toEqual([pr.kind, pr.external_ref, DEFAULT_SOURCE_RECEIPT]);
  });

  it("writes a receipt beside the decision: what happened, and the source it happened in", async () => {
    const db = fake([{ id: 12 }]);
    await resolveAtSource(db, pr, "  You approved it on GitHub ");
    expect(db.calls[0]!.text.replace(/\s+/g, " ")).toContain("payload = payload || jsonb_build_object('cleared', jsonb_build_object('what', $3::text, 'where', source->>'kind'))");
    expect(db.calls[0]!.values).toEqual([pr.kind, pr.external_ref, "You approved it on GitHub"]);
  });

  it("refuses a receipt that is blank, multi-line or longer than a line — never cut", async () => {
    const db = fake();
    for (const bad of ["", "   ", "a\nb", "x".repeat(SOURCE_RECEIPT_MAX + 1)]) {
      await expect(resolveAtSource(db, pr, bad), JSON.stringify(bad)).rejects.toThrow(TypeError);
    }
    expect(() => sourceReceipt(7)).toThrow(TypeError);
    expect(db.calls).toHaveLength(0);
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
