// devin-sessions unit tests: a fake fetch for Devin's session GET and a fake
// db that records the proposal insert and the work-row transitions. The
// scratch-db pass (apps/console/test/devin.integration.test.ts) proves the
// round trip against real SQL; this file proves the verdicts.
import { describe, expect, it } from "vitest";
import { check, devinRef, parseDevinRef, reportBody, run, SOURCE_AGENT, verdictOf, type DevinSession } from "./run.js";

const ANSWER = { answer: "It is deployed by the `release` workflow.", sources: ["acme/api/.github/workflows/release.yml"], confidence: "high", open_questions: [] };

/** One dispatched work row, shaped the way `dispatch()` leaves it. */
function workRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: "why does the deploy hang",
    external_ref: "devin:devin-123",
    meta: { devin: { session_id: "devin-123", org: "org-abc", url: "https://app.devin.ai/sessions/123", max_acu: 5, purpose: "knowledge_research", target: "devin-sessions", dispatch_run_id: 101 } },
    created_at: "2026-09-15T10:00:00.000Z",
    updated_at: "2026-09-15T10:00:00.000Z",
    ...over,
  };
}

/** Enough of Postgres for this collector: the open-row SELECT, the work/runs updates, and `submitReport`'s lookup + insert. */
function fakeDb(rows: Record<string, unknown>[] = [workRow()]) {
  const q: { text: string; values: unknown[] }[] = [];
  const proposals: unknown[][] = [];
  return {
    q,
    proposals,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.includes("FROM work")) return { rows };
      if (text.startsWith("SELECT id FROM proposals")) return { rows: [] }; // never a duplicate in these tests
      if (text.startsWith("INSERT INTO proposals")) {
        proposals.push(values);
        return { rows: [{ id: proposals.length }] };
      }
      return { rows: [] };
    },
    workUpdate() {
      return q.find((x) => x.text.startsWith("UPDATE work SET status"));
    },
    workPoll() {
      return q.find((x) => x.text.startsWith("UPDATE work SET meta"));
    },
    runUpdate() {
      return q.find((x) => x.text.startsWith("UPDATE runs"));
    },
    proposal() {
      return proposals[0] ? { source_agent: proposals[0][0], payload: JSON.parse(String(proposals[0][1])) } : null;
    },
  };
}

function fakeFetch(session: Partial<DevinSession> | { status: number }, calls: string[] = []) {
  return (async (url: string) => {
    calls.push(url);
    if ("status" in session && typeof session.status === "number") return { ok: false, status: session.status, text: async () => "no" };
    return { ok: true, status: 200, json: async () => ({ session_id: "devin-123", url: "https://app.devin.ai/sessions/123", ...session }) };
  }) as unknown as typeof fetch;
}

const ctx = (session: Partial<DevinSession> | { status: number }, over: Record<string, unknown> = {}) => ({
  devinApiKey: "cog_x",
  fetchFn: fakeFetch(session),
  now: new Date("2026-09-15T11:00:00.000Z"),
  ...over,
});

describe("devin-sessions: refs", () => {
  it("round-trips a session id and refuses anything else", () => {
    expect(devinRef("devin-123")).toBe("devin:devin-123");
    expect(parseDevinRef("devin:devin-123")).toBe("devin-123");
    expect(parseDevinRef("gh:o/r#1")).toBeNull();
    expect(parseDevinRef("devin:")).toBeNull();
    expect(parseDevinRef(null)).toBeNull();
  });
});

describe("devin-sessions: verdicts (the documented status enum)", () => {
  const s = (over: Partial<DevinSession>): DevinSession => ({ session_id: "devin-123", status: "running", ...over });

  it("exit + structured_output is the only answer", () => {
    expect(verdictOf(s({ status: "exit", structured_output: ANSWER }))).toEqual({ kind: "answered", output: ANSWER });
  });

  it("exit without structured output is a failure — Devin failed its own required contract", () => {
    const v = verdictOf(s({ status: "exit", status_detail: "finished", structured_output: null }));
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.reason).toMatch(/without structured output/);
  });

  it("error and suspended are failures, and the detail is carried so the reason is readable", () => {
    expect(verdictOf(s({ status: "error", status_detail: "error" }))).toMatchObject({ kind: "failed" });
    const v = verdictOf(s({ status: "suspended", status_detail: "out_of_credits" }));
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.reason).toMatch(/suspended \(out_of_credits\)/);
  });

  it("waiting on a person is a failure, because this return path does not answer sessions", () => {
    expect(verdictOf(s({ status: "running", status_detail: "waiting_for_user" })).kind).toBe("failed");
    expect(verdictOf(s({ status: "running", status_detail: "waiting_for_approval" })).kind).toBe("failed");
  });

  it("new/claimed/running/resuming are pending until the dispatch timeout", () => {
    for (const status of ["new", "claimed", "running", "resuming"]) expect(verdictOf(s({ status, status_detail: "working" })).kind).toBe("pending");
    const v = verdictOf(s({ status: "running", status_detail: "working" }), { timedOut: true });
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.reason).toMatch(/past the dispatch timeout/);
  });
});

describe("devin-sessions: the answer becomes a report proposal", () => {
  it("files the structured answer with provenance, closes the work row, and records the ACUs on the dispatch run", async () => {
    const db = fakeDb();
    const n = await run(db, ctx({ status: "exit", status_detail: "finished", structured_output: ANSWER, acus_consumed: 2.5 }));
    expect(n).toBe(1);

    const p = db.proposal()!;
    expect(p.source_agent).toBe(SOURCE_AGENT);
    expect(p.payload.kind).toBe("finding");
    expect(p.payload.title).toBe("[devin] why does the deploy hang");
    expect(p.payload.idempotency_key).toBe("devin-session:devin-123");
    expect(p.payload.refs).toEqual(["https://app.devin.ai/sessions/123", "task:7"]);
    expect(p.payload.body).toContain("It is deployed by the `release` workflow.");
    expect(p.payload.body).toContain("## Sources\n- acme/api/.github/workflows/release.yml");
    expect(p.payload.body).toContain("- session: https://app.devin.ai/sessions/123");
    expect(p.payload.body).toContain("- confidence: high");
    expect(p.payload.body).toContain("- ACUs used: 2.5 (cap 5)");
    expect(p.payload.body).toContain("- dispatched for: task #7 (knowledge_research)");
    expect(p.payload.body).not.toContain("## Open questions"); // an empty array renders nothing, not an empty heading

    const upd = db.workUpdate()!;
    expect(upd.values[1]).toBe("closed");
    expect(JSON.parse(String(upd.values[3]))[0]).toMatchObject({ agent: "collector:devin-sessions", op: "update", status: "closed" });
    expect(JSON.parse(String(upd.values[2])).devin).toMatchObject({ status: "exit", acus_consumed: 2.5, polled_at: "2026-09-15T11:00:00.000Z" });

    const runUpd = db.runUpdate()!;
    expect(runUpd.values[0]).toBe(101); // the dispatch runs row, from meta.devin
    expect(JSON.parse(String(runUpd.values[1]))).toEqual({ acus_consumed: 2.5, devin_status: "exit", outcome: "answered" });
  });

  it("renders open questions when there are any, and says so when Devin reported no ACUs", async () => {
    const db = fakeDb();
    await run(db, ctx({ status: "exit", structured_output: { ...ANSWER, confidence: "low", open_questions: ["which region?"] } }));
    const body = String(db.proposal()!.payload.body);
    expect(body).toContain("## Open questions\n- which region?");
    expect(body).toContain("- ACUs used: not reported (cap 5)");
    expect(body).toContain("- confidence: low");
  });

  it("the body renderer is pure and survives a malformed answer rather than throwing", () => {
    const body = reportBody({ answer: "a", sources: "not an array", open_questions: [{ q: 1 }] }, { session_url: "u", status: "exit", max_acu: 5, task_id: 7, purpose: "work" });
    expect(body).toContain("a");
    expect(body).not.toContain("## Sources");
    expect(body).toContain('- {"q":1}');
  });
});

describe("devin-sessions: the failure path", () => {
  it("an errored session files a report with the reason and BLOCKS the work row (never closes it)", async () => {
    const db = fakeDb();
    expect(await run(db, ctx({ status: "error", status_detail: "error", acus_consumed: 1 }))).toBe(1);
    const p = db.proposal()!;
    expect(p.payload.kind).toBe("progress");
    expect(p.payload.title).toBe("[devin] why does the deploy hang — no answer");
    expect(p.payload.idempotency_key).toBe("devin-session:devin-123:failed");
    expect(p.payload.body).toMatch(/session errored \(error\)/);
    expect(p.payload.body).toContain("- ACUs used: 1 (cap 5)");
    const upd = db.workUpdate()!;
    expect(upd.values[1]).toBe("blocked");
    expect(JSON.parse(String(db.runUpdate()!.values[1])).outcome).toBe("failed");
  });

  it("a session past the timeout is reported and blocked rather than polled forever", async () => {
    const db = fakeDb();
    const n = await run(db, ctx({ status: "running", status_detail: "working" }, { devinSessionTimeoutHours: 0.5 }));
    expect(n).toBe(1);
    expect(db.proposal()!.payload.body).toMatch(/past the dispatch timeout/);
    expect(db.workUpdate()!.values[1]).toBe("blocked");
  });

  it("a pending session touches meta only — no proposal, no status change", async () => {
    const db = fakeDb();
    expect(await run(db, ctx({ status: "running", status_detail: "working", acus_consumed: 0.5 }))).toBe(0);
    expect(db.proposals).toHaveLength(0);
    expect(db.workUpdate()).toBeUndefined();
    expect(JSON.parse(String(db.workPoll()!.values[1])).devin).toMatchObject({ status: "running", status_detail: "working", acus_consumed: 0.5 });
  });

  it("a 429 stops the pass without a verdict; a per-row HTTP failure skips that row", async () => {
    const limited = fakeDb([workRow(), workRow({ id: 8, external_ref: "devin:devin-999" })]);
    expect(await run(limited, ctx({ status: 429 }))).toBe(0);
    expect(limited.q.filter((x) => x.text.includes("FROM work"))).toHaveLength(1); // one SELECT, then stopped
    expect(limited.proposals).toHaveLength(0);
    const failed = fakeDb();
    expect(await run(failed, ctx({ status: 500 }))).toBe(0);
    expect(failed.workUpdate()).toBeUndefined();
  });

  it("a row whose meta carries no organization is skipped, not guessed at", async () => {
    const db = fakeDb([workRow({ meta: {} })]);
    expect(await run(db, ctx({ status: "exit", structured_output: ANSWER }))).toBe(0);
    expect(db.proposals).toHaveLength(0);
  });
});

describe("devin-sessions: degrades absent", () => {
  it("run() returns 0 and queries nothing without a key", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("check() is absent with the remediation that names the shared key", async () => {
    const r = await check({});
    expect(r.status).toBe("absent");
    expect(r.name).toBe("devin-sessions");
    expect(r.remediation).toMatch(/METISTRY_DEVIN_API_KEY/);
    expect((await check({ devinApiKey: "cog_x" })).status).toBe("ok");
  });
});
