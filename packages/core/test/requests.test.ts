// The request type table (plan §2.12, F-5). What the table REFUSES — an
// unknown kind's `allow`, a payload's body outside its type, a column that is
// not a column — matters as much as what it maps, because the query, the
// brief and every client take its word for it.
import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGED,
  REQUEST_BODIES,
  REQUEST_DECISIONS,
  REQUEST_DOORS,
  REQUEST_KIND_TYPE,
  REQUEST_KINDS,
  REQUEST_SUBJECT_BASES,
  REQUEST_TYPE_SUBJECT,
  REQUEST_TYPE_TABLE,
  REQUEST_TYPES,
  describeRequest,
  isRequestKind,
  readBackOf,
  parseSubjectFingerprint,
  requestBodyOf,
  requestSubjectOf,
  requestTypeOf,
  requestWordOf,
  requestWordSql,
  subjectFingerprint,
  subjectUnchanged,
  type RequestAnswer,
} from "../src/index.js";

const answersOf = (t: (typeof REQUEST_TYPES)[number]): RequestAnswer[] =>
  REQUEST_TYPE_TABLE[t].bodies.flatMap((b) => [b.primary, b.revise, b.decline]).filter((a): a is RequestAnswer => a !== null);

describe("request types — the table", () => {
  it("every stored kind maps to one of the twelve types, and reads as that type's word", () => {
    expect(REQUEST_TYPES).toHaveLength(12);
    for (const kind of REQUEST_KINDS) {
      const type = requestTypeOf(kind);
      expect(REQUEST_TYPES, kind).toContain(type);
      expect(requestWordOf(kind), kind).toBe(REQUEST_TYPE_TABLE[type].word);
      expect(REQUEST_TYPE_TABLE[type].bodies.map((b) => b.body), kind).toContain(requestBodyOf(kind));
    }
    // §2.12's stored-kind column, said out loud — the words the owner reads
    expect(Object.fromEntries(REQUEST_KINDS.map((k) => [k, requestWordOf(k)]))).toEqual({
      decision: "question",
      pull_request: "pull request",
      access_request: "access",
      grant_elevation: "access",
      secret_failure: "access",
      action: "action",
      connection_call: "action",
      review: "review",
      knowledge: "note",
      draft_settle: "note",
      improvement: "improvement",
      report: "report",
      invitation: "invitation",
      task: "task",
      message: "message",
    });
  });

  it("C80: `action` reads action — not note, the word both old mappings gave it", () => {
    expect(requestTypeOf("action")).toBe("action");
    expect(requestWordOf("action")).toBe("action");
    expect(requestWordOf("action")).not.toBe(requestWordOf("knowledge"));
  });

  it("every type but meeting is reached by a stored kind; a meeting is a group, never a kind", () => {
    const reached = new Set(Object.values(REQUEST_KIND_TYPE));
    for (const t of REQUEST_TYPES) expect(reached.has(t), t).toBe(t !== "meeting");
    expect(REQUEST_TYPE_TABLE.meeting.grouped).toBe(true);
    expect(REQUEST_TYPES.filter((t) => REQUEST_TYPE_TABLE[t].grouped)).toEqual(["meeting"]);
  });

  it("bodies come from the closed set; answers name only closed decisions and doors, in Title Case", () => {
    for (const t of REQUEST_TYPES) {
      for (const b of REQUEST_TYPE_TABLE[t].bodies) expect(REQUEST_BODIES, t).toContain(b.body);
      for (const a of answersOf(t)) {
        if ("decision" in a.sends) expect(REQUEST_DECISIONS, t).toContain(a.sends.decision);
        else expect(REQUEST_DOORS, t).toContain(a.sends.door);
        if (a.label !== null) expect(a.label, t).toMatch(/^[A-Z][a-z]*( (the|to|[A-Z][a-z]*))*$/);
      }
    }
    // the one label a row supplies is a report's act
    const unlabelled = REQUEST_TYPES.flatMap((t) => answersOf(t).filter((a) => a.label === null).map((a) => [t, a.sends]));
    expect(unlabelled).toEqual([["report", { door: "act" }]]);
  });

  it("the words §2.12 fixes: GitHub's on a pull request, narrower-only on access, Dismiss and Not Mine as skip", () => {
    const [diff, thread] = REQUEST_TYPE_TABLE.pull_request.bodies;
    expect(diff).toMatchObject({ body: "diff", primary: { label: "Approve" }, revise: { label: "Request Changes", required: true }, decline: null });
    expect(thread).toMatchObject({ body: "thread", primary: { label: "Reply", required: true } });
    expect(REQUEST_TYPE_TABLE.access.bodies[0].revise).toEqual({ label: "Revise", sends: { decision: "accept_with_changes" }, carries: "area" });
    expect(REQUEST_TYPE_TABLE.report.bodies[0].decline).toEqual({ label: "Dismiss", sends: { decision: "skip" } });
    expect(REQUEST_TYPE_TABLE.message.bodies[0].decline).toEqual({ label: "Not Mine", sends: { decision: "skip" } });
    expect(REQUEST_TYPE_TABLE.meeting.bodies[0]).toMatchObject({ primary: { label: "Accept All", sends: { decision: "allow" } }, decline: { label: "Decline All", sends: { decision: "deny" } } });
    // Decline sends `deny`, always, wherever the answer lands on the row (Q10)
    for (const t of REQUEST_TYPES) {
      for (const b of REQUEST_TYPE_TABLE[t].bodies) {
        if (b.decline?.label === "Decline" && "decision" in b.decline.sends) expect(b.decline.sends.decision, t).toBe("deny");
      }
    }
  });
});

describe("request types — a kind this table does not know", () => {
  it("renders `excerpt`, whatever its payload names", () => {
    expect(isRequestKind("sync_conflict")).toBe(false);
    expect(requestBodyOf("sync_conflict")).toBe("excerpt");
    expect(requestBodyOf("sync_conflict", { body: { kind: "diff" } })).toBe("excerpt");
    expect(requestBodyOf("")).toBe("excerpt");
  });

  it("reads as a report, never as its stored kind, and Dismiss is the only answer — nothing it could mean is approved", () => {
    expect(requestTypeOf("sync_conflict")).toBe("report");
    expect(requestWordOf("sync_conflict")).toBe("report");
    const shape = describeRequest("sync_conflict", { suggested_work: { title: "x" } });
    expect(shape).toMatchObject({ type: "report", word: "report", body: "excerpt", primary: null, revise: null, decline: { label: "Dismiss" } });
    expect(shape.decisions).toEqual(["skip"]);
  });

  it("an inherited property name is not a kind", () => {
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isRequestKind(k), k).toBe(false);
      expect(requestWordOf(k), k).toBe("report");
    }
  });
});

describe("request types — a row", () => {
  it("a payload chooses among its type's bodies and never outside them", () => {
    expect(requestBodyOf("pull_request")).toBe("diff");
    expect(requestBodyOf("pull_request", { body: { kind: "thread" } })).toBe("thread");
    expect(requestBodyOf("review")).toBe("preview");
    expect(requestBodyOf("review", { body: { kind: "before_after" } })).toBe("before_after");
    // in the closed set, not this type's: the type's own
    expect(requestBodyOf("access_request", { body: { kind: "choices" } })).toBe("before_after");
    // outside the closed set, or not a body at all: the type's own
    expect(requestBodyOf("action", { body: { kind: "html" } })).toBe("preview");
    expect(requestBodyOf("report", { body: "a report's text, as requests_create stores it" })).toBe("excerpt");
    expect(requestBodyOf("knowledge", null)).toBe("preview");
    // and the answers follow the body: a conflict is settled at its door
    expect(describeRequest("review", { body: { kind: "before_after" } })).toMatchObject({ primary: { label: "Keep Mine", sends: { door: "resolve_conflict" } }, revise: { label: "Take the Other" } });
    expect(describeRequest("review", { body: { kind: "before_after" } }).decisions).toEqual(["deny"]);
  });

  it("Approve sends accept_as_work where the payload suggests work, and only where Approve sends allow", () => {
    const plain = describeRequest("knowledge", { title: "t" });
    expect(plain.primary?.sends).toEqual({ decision: "allow" });
    expect(plain.decisions).toEqual(["allow", "accept_with_changes", "deny"]);

    const suggested = describeRequest("knowledge", { suggested_work: { title: "Call the dentist" } });
    expect(suggested.primary).toMatchObject({ label: "Approve", sends: { decision: "accept_as_work" } });
    expect(suggested.decisions).toEqual(["allow", "accept_as_work", "accept_with_changes", "deny"]);

    // a question answers with its answers; a report has no Approve to fold into — Acknowledge is not one (X-10)
    expect(describeRequest("decision", { options: ["a", "b"], suggested_work: {} }).decisions).toEqual(["answers", "accept_with_changes", "deny"]);
    expect(describeRequest("report", { suggested_work: {} }).decisions).toEqual(["acknowledge", "skip"]);
    // the table itself is untouched by a row's payload
    expect(REQUEST_TYPE_TABLE.note.bodies[0].primary?.sends).toEqual({ decision: "allow" });
  });

  it("a question carries its questions — v2's, or a v1 row's options as one — and with none it has no Send Answers (T2-3)", () => {
    const questions = [
      { prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true },
      { prompt: "Which labels?", options: ["bug", "docs"], multi: true, allow_other: false },
    ];
    expect(describeRequest("decision", { title: "Two things", questions })).toMatchObject({
      type: "question",
      body: "choices",
      primary: { label: "Send Answers", sends: { decision: "answers" } },
      decisions: ["answers", "accept_with_changes", "deny"],
      questions,
    });
    expect(describeRequest("decision", { title: "Let devin in?", options: ["approve", "deny"] }).questions).toEqual([
      { prompt: "Let devin in?", options: ["approve", "deny"], multi: false, allow_other: false },
    ]);
    // nothing to answer: Revise and Decline only — never a Send Answers that cannot send
    const empty = describeRequest("decision", { title: "Enrol this agent?" });
    expect(empty).toMatchObject({ primary: null, questions: [], decisions: ["accept_with_changes", "deny"] });
    // only a question carries the field
    expect(describeRequest("knowledge", { questions })).not.toHaveProperty("questions");
    expect(describeRequest("report", { questions })).not.toHaveProperty("questions");
  });

  it("a type answered at another system's door stores no decision on the row but its skip", () => {
    expect(describeRequest("pull_request").decisions).toEqual([]);
    expect(describeRequest("invitation").decisions).toEqual([]);
    expect(describeRequest("task").decisions).toEqual([]);
    expect(describeRequest("message").decisions).toEqual(["skip"]);
  });
});

describe("a report is acknowledged (X-10, ruling 8 of 2026-09-27)", () => {
  const act = { label: "Try Again", kind: "run_now", component: "standup" };

  it("a report that names no act — an agent's finding, a routine's note — is answered Acknowledge, or Dismissed", () => {
    const r = describeRequest("report", { title: "Nightly fold finished", body: "12 pages", kind: "finding" });
    expect(r).toMatchObject({ type: "report", body: "excerpt", primary: { label: "Acknowledge", sends: { decision: "acknowledge" } }, revise: null, decline: { label: "Dismiss", sends: { decision: "skip" } } });
    expect(r.decisions).toEqual(["acknowledge", "skip"]);
  });

  it("a report that names its act keeps it: an event's Try Again is not an acknowledgement", () => {
    const r = describeRequest("report", { title: "standup failed", act });
    expect(r.primary).toEqual({ label: null, sends: { door: "act" } });
    expect(r.decisions).toEqual(["skip"]);
    // an act with no label is no act — its button would have no word
    for (const bad of [{}, { label: "" }, { label: "   " }, { label: 3 }, [act], "Try Again", null]) {
      expect(describeRequest("report", { act: bad }).primary?.label, JSON.stringify(bad)).toBe("Acknowledge");
    }
  });

  it("a kind the table does not know is still Dismiss alone — Acknowledge is a report's, and an unknown kind is not one", () => {
    expect(describeRequest("no_such_kind", { title: "x" })).toMatchObject({ primary: null, decisions: ["skip"] });
  });

  it("Acknowledge is offered on no other type, and the table's own report row is untouched", () => {
    for (const kind of ["decision", "action", "knowledge", "review", "improvement", "access_request", "message", "task", "invitation", "pull_request"]) {
      expect(describeRequest(kind, { title: "x" }).decisions, kind).not.toContain("acknowledge");
    }
    expect(REQUEST_TYPE_TABLE.report.bodies[0].primary).toEqual({ label: null, sends: { door: "act" } });
  });
});

describe("the read-back — what the agent that asked is told (X-10)", () => {
  const questions = [
    { prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true },
    { prompt: "Which labels?", options: ["bug", "docs"], multi: true, allow_other: false },
  ];
  const at = new Date("2026-09-28T09:00:00Z");

  it("a question answered: each question's prompt with the owner's choices and words, in order", () => {
    const row = { decision: "answered", decided_at: at, feedback: "Which repo? — mine; Which labels? — bug", payload: { questions, answers: [{ choices: [], other: "mine" }, { choices: ["bug"] }] } };
    expect(readBackOf(row)).toEqual({
      state: "answered",
      decided_at: "2026-09-28T09:00:00.000Z",
      answers: [
        { prompt: "Which repo?", choices: [], other: "mine" },
        { prompt: "Which labels?", choices: ["bug"] },
      ],
    });
  });

  it("waiting, acknowledged, revised, declined, dismissed, expired — each its own state, the owner's words only where they gave some", () => {
    expect(readBackOf({ decision: "pending", payload: { questions } })).toEqual({ state: "pending" });
    expect(readBackOf({ decision: ACKNOWLEDGED, decided_at: at })).toEqual({ state: "acknowledged", decided_at: at.toISOString() });
    expect(readBackOf({ decision: "accept_with_changes", decided_at: at, feedback: "ask about the migration" })).toEqual({ state: "revised", decided_at: at.toISOString(), feedback: "ask about the migration" });
    expect(readBackOf({ decision: "deny", decided_at: at, feedback: "not now" })).toEqual({ state: "declined", decided_at: at.toISOString(), feedback: "not now" });
    expect(readBackOf({ decision: "deny", decided_at: at, feedback: null })).toEqual({ state: "declined", decided_at: at.toISOString() });
    expect(readBackOf({ decision: "expired", decided_at: at })).toEqual({ state: "expired", decided_at: at.toISOString() });
  });

  it("a Dismiss (skip) carries no words: SKIP_FEEDBACK is a marker, never a reason", () => {
    expect(readBackOf({ decision: "deny", decided_at: at, feedback: "skipped" })).toEqual({ state: "dismissed", decided_at: at.toISOString() });
  });

  it("any other stored decision is `closed` — the machinery's word is never the agent's", () => {
    for (const d of ["allow", "approve", "resolved_at_source", "auto", "", null, 7]) {
      expect(readBackOf({ decision: d, feedback: "private words", payload: { answers: [{ choices: ["x"] }] } }), String(d)).toEqual({ state: "closed" });
    }
  });

  it("reads nothing else off the row: not the payload's other fields, not an answer that is not one", () => {
    const r = readBackOf({ decision: "answered", payload: { questions, answers: [{ choices: ["metistry", 3] }, "junk"], provenance: { agent: "someone" }, context: { prose: "x" } } });
    expect(r).toEqual({ state: "answered", answers: [{ prompt: "Which repo?", choices: ["metistry"] }] });
  });
});

describe("request types — the SQL rendering", () => {
  it("maps every stored kind, and anything else to report", () => {
    const sql = requestWordSql("p.kind");
    expect(sql.startsWith("CASE p.kind\n")).toBe(true);
    for (const k of REQUEST_KINDS) expect(sql, k).toContain(`WHEN '${k}' THEN '${requestWordOf(k)}'`);
    expect(sql.endsWith("  ELSE 'report'\nEND")).toBe(true);
    expect(sql.split("\n")).toHaveLength(REQUEST_KINDS.length + 3); // CASE, one WHEN per kind, ELSE, END
  });

  it("refuses anything but a column reference — generated SQL is code", () => {
    for (const bad of ["p.kind; DROP TABLE proposals", "p.kind --", "'x'", "P.KIND", "a.b.c", "", "kind)"]) {
      expect(() => requestWordSql(bad), bad).toThrow(/is not a column reference/);
    }
    expect(() => requestWordSql("kind")).not.toThrow();
  });
});

// ---- the subject (T2-14): what a request is about, and whether it moved -------

describe("request subjects — one basis per type", () => {
  const T1 = "2026-09-26 08:00:00.000001+00";
  const T2 = "2026-09-26 08:00:00.000002+00";

  it("a pull request is judged by its head, a task by its line, anything else by its work row", () => {
    expect(REQUEST_TYPE_SUBJECT).toEqual({ pull_request: "head_sha", task: "line_text" });
    const all = { head_sha: "abc123", line_text: "- [ ] call the plumber", work_updated_at: T1 };
    expect(requestSubjectOf("pull_request", all)?.basis).toBe("head_sha");
    expect(requestSubjectOf("task", all)?.basis).toBe("line_text");
    for (const kind of ["action", "review", "knowledge", "decision", "access_request", "improvement", "report", "no_such_kind"]) {
      expect(requestSubjectOf(kind, all)?.basis, kind).toBe("work_updated_at");
    }
  });

  it("falls back to the work row where the type's own basis is missing, and a row with neither has no subject", () => {
    expect(requestSubjectOf("pull_request", { work_updated_at: T1 })?.basis).toBe("work_updated_at");
    expect(requestSubjectOf("task", { work_updated_at: T1 })?.basis).toBe("work_updated_at");
    expect(requestSubjectOf("pull_request", {})).toBeNull();
    expect(requestSubjectOf("decision", { head_sha: "abc", line_text: "x" })).toBeNull(); // a question is not about a head or a line
  });

  it("each subject change moves the fingerprint — a new head, an edited line, a deleted line, a moved work row", () => {
    const pr = (h: string) => requestSubjectOf("pull_request", { head_sha: h, work_updated_at: T1 })!.fingerprint;
    const task = (l: string | null) => requestSubjectOf("task", { line_text: l })!.fingerprint;
    const work = (t: string) => requestSubjectOf("action", { work_updated_at: t })!.fingerprint;
    expect(pr("abc123")).not.toBe(pr("def456"));
    expect(task("- [ ] call the plumber")).not.toBe(task("- [ ] call the plumber today"));
    expect(task("- [ ] call the plumber")).not.toBe(task(null));
    expect(task(null)).toBe("line_text:gone");
    expect(work(T1)).not.toBe(work(T2)); // microseconds apart is still a move
    // …and nothing but the subject moves it: the same reading is the same fingerprint
    expect(pr("abc123")).toBe(pr("abc123"));
  });

  it("is narrow: a pull request whose work row moved but whose head did not is unchanged", () => {
    const before = requestSubjectOf("pull_request", { head_sha: "abc123", work_updated_at: T1 });
    const after = requestSubjectOf("pull_request", { head_sha: "abc123", work_updated_at: T2 });
    expect(subjectUnchanged(before!.fingerprint, after)).toBe(true);
  });

  it("the same value under two bases is two fingerprints", () => {
    expect(subjectFingerprint("head_sha", "x")).not.toBe(subjectFingerprint("line_text", "x"));
    for (const b of REQUEST_SUBJECT_BASES) expect(subjectFingerprint(b, "x")).toMatch(new RegExp(`^${b}:[0-9a-f]{32}$`));
  });

  it("a row that gained or lost its subject has changed", () => {
    const s = requestSubjectOf("action", { work_updated_at: T1 });
    expect(subjectUnchanged(null, null)).toBe(true);
    expect(subjectUnchanged(null, s)).toBe(false);
    expect(subjectUnchanged(s!.fingerprint, null)).toBe(false);
  });

  it("parseSubjectFingerprint takes what the server serves, or null, and nothing else (misuse)", () => {
    const served = requestSubjectOf("task", { line_text: "x" })!.fingerprint;
    expect(parseSubjectFingerprint(served)).toBe(served);
    expect(parseSubjectFingerprint("line_text:gone")).toBe("line_text:gone");
    expect(parseSubjectFingerprint(null)).toBeNull();
    for (const bad of [undefined, "", "abc123", "head_sha:abc123", "HEAD_SHA:" + "0".repeat(32), `nope:${"0".repeat(32)}`, `${served} `, 42, {}, ["x"], true]) {
      expect(parseSubjectFingerprint(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
