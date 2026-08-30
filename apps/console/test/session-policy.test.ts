import { describe, expect, it } from "vitest";
import { evaluateSession, shouldRefreshLastSeen } from "../src/session-policy.js";

const policy = { idleDays: 30, maxDays: 365 };
const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-08-30T12:00:00Z");

function row(overrides: Partial<Parameters<typeof evaluateSession>[0]> = {}) {
  return {
    last_seen_at: new Date(now.getTime() - day),
    absolute_expires_at: new Date(now.getTime() + 300 * day),
    revoked_at: null,
    ...overrides,
  };
}

describe("session policy (30d idle / 1y absolute)", () => {
  it("valid inside both windows", () => {
    expect(evaluateSession(row(), policy, now)).toBe("valid");
  });
  it("idle-expires a device unseen for 30 days", () => {
    expect(evaluateSession(row({ last_seen_at: new Date(now.getTime() - 30 * day) }), policy, now)).toBe("idle_expired");
    expect(evaluateSession(row({ last_seen_at: new Date(now.getTime() - 29 * day) }), policy, now)).toBe("valid");
  });
  it("absolute backstop wins regardless of activity", () => {
    expect(
      evaluateSession(row({ last_seen_at: now, absolute_expires_at: new Date(now.getTime() - 1) }), policy, now),
    ).toBe("absolute_expired");
  });
  it("revoked wins over everything", () => {
    expect(evaluateSession(row({ revoked_at: now }), policy, now)).toBe("revoked");
  });
  it("refreshes last_seen at most hourly", () => {
    expect(shouldRefreshLastSeen(row({ last_seen_at: new Date(now.getTime() - 2 * 60 * 60 * 1000) }), now)).toBe(true);
    expect(shouldRefreshLastSeen(row({ last_seen_at: new Date(now.getTime() - 10 * 60 * 1000) }), now)).toBe(false);
  });
});
