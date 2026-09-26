// The request type table (plan §2.12, F-5). What the table REFUSES — an
// unknown kind's `allow`, a payload's body outside its type, a column that is
// not a column — matters as much as what it maps, because the query, the
// brief and every client take its word for it.
import { describe, expect, it } from "vitest";
import {
  REQUEST_BODIES,
  REQUEST_DECISIONS,
  REQUEST_DOORS,
  REQUEST_KIND_TYPE,
  REQUEST_KINDS,
  REQUEST_TYPE_TABLE,
  REQUEST_TYPES,
  describeRequest,
  isRequestKind,
  requestBodyOf,
  requestTypeOf,
  requestWordOf,
  requestWordSql,
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

    // a question answers with its answers; a report has no Approve to fold into
    expect(describeRequest("decision", { suggested_work: {} }).decisions).toEqual(["answers", "accept_with_changes", "deny"]);
    expect(describeRequest("report", { suggested_work: {} }).decisions).toEqual(["skip"]);
    // the table itself is untouched by a row's payload
    expect(REQUEST_TYPE_TABLE.note.bodies[0].primary?.sends).toEqual({ decision: "allow" });
  });

  it("a type answered at another system's door stores no decision on the row but its skip", () => {
    expect(describeRequest("pull_request").decisions).toEqual([]);
    expect(describeRequest("invitation").decisions).toEqual([]);
    expect(describeRequest("task").decisions).toEqual([]);
    expect(describeRequest("message").decisions).toEqual(["skip"]);
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
