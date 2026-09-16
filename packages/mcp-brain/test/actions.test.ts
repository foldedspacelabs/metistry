// propose_action, without a database (docs/ops/actions.md). A fake executor
// proves the control flow the console's integration suite cannot isolate:
// which mode wrote a row, which one ran it, and what a failed execution leaves
// behind. Misuse first — every one of these is about a refusal.
import { describe, expect, it } from "vitest";
import { proposeAction, type ActionExecution, type AgentPrincipal, type Db } from "../src/index.js";

const base: AgentPrincipal = { id: "researcher", kind: "external", grants: { tier: "none", areas: [] }, projects: ["p1"] };
const comment = { work_id: 12, body: "scoping this before I claim it" };

/** Records every statement, answers an id for the insert. */
function fakeDb(): Db & { statements: { text: string; values: unknown[] }[] } {
  const statements: { text: string; values: unknown[] }[] = [];
  return {
    statements,
    async query(text, values = []) {
      statements.push({ text: text.trim(), values });
      return text.includes("INSERT INTO proposals") ? { rows: [{ id: 77 }] } : { rows: [] };
    },
  };
}

const ok = (result: Record<string, unknown>) => ({ execute: async (): Promise<ActionExecution> => ({ ok: true, result }) });
const refuses = (code: "conflict" | "invalid_request", message: string) => ({ execute: async (): Promise<ActionExecution> => ({ ok: false, code, message }) });

describe("the table decides, and it is consulted before anything is written", () => {
  it("deny refuses at the tool, names the field that would permit it, and writes NOTHING", async () => {
    const db = fakeDb();
    const denied: AgentPrincipal = { ...base, autonomy: { level: "act_within_scope", actions: { comment: "deny" } } };
    const r = await proposeAction(db, denied, ok({}), "comment", comment, "because");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("forbidden");
      expect(r.message).toContain("autonomy.actions.comment is deny");
      expect(r.message).toContain("metistry agents autonomy researcher --allow comment");
    }
    expect(db.statements).toEqual([]); // no proposal, no row, no trace but the caller's own runs row
  });

  it("an absent level denies every kind — the axis is opt-in, so an existing agent gains nothing", async () => {
    const db = fakeDb();
    for (const kind of ["dispatch", "task_update", "comment", "capture"]) {
      const r = await proposeAction(db, base, ok({}), kind, kind === "capture" ? { note: "n" } : comment, "why");
      expect(r.ok, kind).toBe(false);
    }
    expect(db.statements).toEqual([]);
  });

  it("propose writes a pending row and stops — the executor is never called", async () => {
    const db = fakeDb();
    let called = false;
    const executor = { execute: async (): Promise<ActionExecution> => { called = true; return { ok: true, result: {} }; } };
    const r = await proposeAction(db, { ...base, autonomy: { level: "propose" } }, executor, "comment", comment, "scoping");
    expect(called).toBe(false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toMatchObject({ status: "pending", proposal_id: 77, action: "comment" });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]!.text).toContain("INSERT INTO proposals");
    expect(db.statements[0]!.values[0]).toBe("researcher"); // source_agent from the credential, never an argument
    expect(db.statements[0]!.values[3]).toBe(12); // work_id linked, so staleness and the room join it
  });

  it("an `allow` that only the ceiling would grant is still a proposal — auto-execution belongs to act_within_scope alone", async () => {
    const db = fakeDb();
    let called = false;
    const executor = { execute: async (): Promise<ActionExecution> => { called = true; return { ok: true, result: {} }; } };
    const r = await proposeAction(db, { ...base, autonomy: { level: "propose", actions: { comment: "allow" } } }, executor, "comment", comment, "scoping");
    expect(called).toBe(false);
    if (r.ok) expect((r.result as { status: string }).status).toBe("pending");
  });
});

describe("allow runs it, and says so where the user can see it", () => {
  it("executes, decides the row `auto`, and writes the result back", async () => {
    const db = fakeDb();
    const r = await proposeAction(db, { ...base, autonomy: { level: "act_within_scope" } }, ok({ comment_id: "cmt_9" }), "comment", comment, "scoping");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toMatchObject({ status: "executed", proposal_id: 77, result: { comment_id: "cmt_9" } });
    expect(db.statements).toHaveLength(2);
    const settle = db.statements[1]!;
    expect(settle.text).toContain("decision = 'auto'");
    expect(settle.text).toContain("decision = 'pending'"); // the WHERE: it can only settle a row nobody answered
    expect(JSON.parse(String(settle.values[1]))).toMatchObject({ comment_id: "cmt_9", by: "auto", on_behalf_of: "researcher" });
  });

  it("a refused execution leaves the row PENDING with the error on it, and answers the service's own sentence", async () => {
    const db = fakeDb();
    const r = await proposeAction(
      db,
      { ...base, autonomy: { level: "act_within_scope" } },
      refuses("conflict", "task 12 is held by crew:x, not by user"),
      "task_update",
      { work_id: 12, patch: { status: "blocked" } },
      "it is stuck",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("conflict");
      expect(r.message).toContain("held by crew:x");
      expect(r.meta).toMatchObject({ proposal_id: 77 });
    }
    const after = db.statements[1]!;
    expect(after.text).toContain("'error'");
    expect(after.text).not.toContain("decision = 'auto'"); // never settled
    expect(JSON.parse(String(after.values[1]))).toMatchObject({ code: "conflict" });
  });

  it("dispatch is `propose` even at act_within_scope, so off-machine stays a human decision", async () => {
    const db = fakeDb();
    let called = false;
    const executor = { execute: async (): Promise<ActionExecution> => { called = true; return { ok: true, result: {} }; } };
    const r = await proposeAction(db, { ...base, autonomy: { level: "act_within_scope" } }, executor, "dispatch", { work_id: 12, target: "devin", brief: "b" }, "why");
    expect(called).toBe(false);
    if (r.ok) expect((r.result as { status: string }).status).toBe("pending");
    // …unless the owner said otherwise, by hand, which is a recorded widening
    const db2 = fakeDb();
    const r2 = await proposeAction(db2, { ...base, autonomy: { level: "act_within_scope", actions: { dispatch: "allow" } } }, ok({ ref: "gh:o/r#1" }), "dispatch", { work_id: 12, target: "devin", brief: "b" }, "why");
    if (r2.ok) expect((r2.result as { status: string }).status).toBe("executed");
  });
});

describe("the closed enum holds at the tool", () => {
  it("an unknown kind or a malformed arg is refused before the table is even consulted", async () => {
    const db = fakeDb();
    const free: AgentPrincipal = { ...base, autonomy: { level: "act_within_scope" } };
    for (const [kind, args] of [
      ["send_email", { to: "a@b.c", body: "hi" }],
      ["shell", { cmd: "rm -rf /" }],
      ["comment", { body: "hi" }],
      ["capture", { note: "n", principal: "user" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await proposeAction(db, free, ok({}), kind, args, "why");
      expect(r.ok, kind).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_request");
    }
    expect(db.statements).toEqual([]);
  });

  it("degrades absent: an allowed action with no executor answers not_available rather than quietly becoming a proposal", async () => {
    const db = fakeDb();
    const r = await proposeAction(db, { ...base, autonomy: { level: "act_within_scope" } }, undefined, "comment", comment, "why");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_available");
    expect(db.statements).toEqual([]);
  });
});
