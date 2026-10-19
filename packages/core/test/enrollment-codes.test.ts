// The enrolment-code module against a fake executor (plan §2.22): what SQL a
// mint, a peek, a consume and a cancel send, that the code itself never
// reaches the database, and what each cancel outcome means. The same
// functions against a real Postgres are packages/cli's enroll.integration test
// and apps/console's server.integration test — one implementation, two callers.
import { describe, expect, it } from "vitest";
import { ENROLLMENT_CODE_TTL_MIN, cancelEnrollmentCode, consumeEnrollmentCode, mintEnrollmentCode, peekEnrollmentCode, tokenHash, type EnrollmentDb } from "../src/index.js";

interface Sent {
  text: string;
  values: unknown[] | undefined;
}

/** Answers each query in turn with the rows given; records what was sent. */
function fakeDb(answers: unknown[][]): EnrollmentDb & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async query(text, values) {
      sent.push({ text, values });
      return { rows: answers.shift() ?? [] };
    },
  };
}

describe("the lifetime", () => {
  it("is ten minutes, fixed — a security parameter, not a setting", () => {
    expect(ENROLLMENT_CODE_TTL_MIN).toBe(10);
  });
});

describe("mintEnrollmentCode", () => {
  it("stores the hash and the ten-minute expiry, returns the code, the row's id and the expiry — never the hash", async () => {
    const expires = new Date("2026-10-18T10:10:00Z");
    const db = fakeDb([[{ id: "42", expires_at: expires }]]);
    const m = await mintEnrollmentCode(db);
    expect(db.sent).toHaveLength(1);
    const { text, values } = db.sent[0]!;
    expect(text).toContain("INSERT INTO auth_enrollment_codes");
    expect(text).toContain(`interval '${ENROLLMENT_CODE_TTL_MIN} minutes'`);
    expect(text).toContain("RETURNING id, expires_at");
    expect(values).toEqual([tokenHash(m.code)]);
    expect(text).not.toContain(m.code);
    expect(m.code).toMatch(/^[A-Za-z0-9_-]{20,}$/); // 16 random bytes, base64url
    expect(m).toEqual({ code: m.code, code_id: 42, expires_at: "2026-10-18T10:10:00.000Z" });
  });

  it("mints a different code every time", async () => {
    const db = fakeDb([[{ id: 1, expires_at: new Date() }], [{ id: 2, expires_at: new Date() }]]);
    const a = await mintEnrollmentCode(db);
    const b = await mintEnrollmentCode(db);
    expect(a.code).not.toBe(b.code);
  });
});

describe("peek and consume", () => {
  it("look the code up by hash, unused and unexpired — peek reads, consume burns", async () => {
    const db = fakeDb([[{ "?column?": 1 }], [], [{ id: 7 }], []]);
    expect(await peekEnrollmentCode(db, "the-code")).toBe(true);
    expect(await peekEnrollmentCode(db, "the-code")).toBe(false);
    expect(await consumeEnrollmentCode(db, "the-code")).toBe(true);
    expect(await consumeEnrollmentCode(db, "the-code")).toBe(false);
    for (const s of db.sent) {
      expect(s.values).toEqual([tokenHash("the-code")]);
      expect(s.text).toContain("used_at IS NULL AND expires_at > now()");
    }
    expect(db.sent[0]!.text).toMatch(/^\s*SELECT/);
    expect(db.sent[2]!.text).toContain("UPDATE auth_enrollment_codes SET used_at = now()");
  });
});

describe("cancelEnrollmentCode", () => {
  it("expires a live, unused code at once — no new column, the existing rule refuses it from then on", async () => {
    const db = fakeDb([[{ id: 5 }]]);
    expect(await cancelEnrollmentCode(db, 5)).toBe("cancelled");
    expect(db.sent).toHaveLength(1);
    expect(db.sent[0]!.text).toContain("SET expires_at = now()");
    expect(db.sent[0]!.text).toContain("WHERE id = $1 AND used_at IS NULL AND expires_at > now()");
    expect(db.sent[0]!.values).toEqual([5]);
  });

  it("tells a used code, an expired one and a missing one apart", async () => {
    expect(await cancelEnrollmentCode(fakeDb([[], [{ used_at: new Date() }]]), 5)).toBe("already_used");
    expect(await cancelEnrollmentCode(fakeDb([[], [{ used_at: null }]]), 5)).toBe("already_expired");
    expect(await cancelEnrollmentCode(fakeDb([[], []]), 5)).toBe("not_found");
  });

  it("refuses an id that is not a positive safe integer without touching the database", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const db = fakeDb([]);
      expect(await cancelEnrollmentCode(db, bad)).toBe("not_found");
      expect(db.sent).toEqual([]);
    }
  });
});
