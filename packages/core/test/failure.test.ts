// The failure model the runner and doctor both read (docs/ops/automation.md).
// The load-bearing property is that a signature survives the parts of an
// error message that change between two occurrences of the same fault — if
// it does not, dedupe is decoration and you get one notification an hour.
import { describe, expect, it } from "vitest";
import {
  errorSignature,
  failureStreaks,
  normalizeError,
  shouldAlert,
  signatureTag,
  streakFor,
  DEFAULT_ALERT_DEDUPE_HOURS,
} from "../src/failure.js";

describe("error signatures", () => {
  it("is stable across ids, paths, hosts' ports and any other digits", () => {
    const a = errorSignature(
      "devin-knowledge",
      "GET https://api.devin.ai/v1/knowledge/9f2a1b3c4d5e failed: 503 after 1841ms (request 0f8e1d2c-3b4a-4c5d-8e9f-a0b1c2d3e4f5)",
    );
    const b = errorSignature(
      "devin-knowledge",
      "GET https://api.devin.ai/v1/knowledge/11223344aabb failed: 503 after 97ms (request 7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d)",
    );
    expect(a).toBe(b);
  });

  it("is stable across absolute paths, which differ between a container and the host", () => {
    expect(errorSignature("inbox-drain", "ENOENT: no such file or directory, open '/data/inbox/2026-09-15-note.md'")).toBe(
      errorSignature("inbox-drain", "ENOENT: no such file or directory, open '/Users/x/Development/inbox/2026-09-16-other.md'"),
    );
  });

  it("separates a different fault, and a different component with the same fault", () => {
    const expired = errorSignature("github-state", "401 Bad credentials");
    expect(errorSignature("github-state", "403 rate limit exceeded")).not.toBe(expired);
    expect(errorSignature("aws-costs", "401 Bad credentials")).not.toBe(expired);
  });

  it("normalises to a bounded, lower-case, placeholder-bearing string; the tag is the dedupe key", () => {
    expect(normalizeError("  Token EXPIRED at 10:04   for /a/b/c ")).toBe("token expired at <n>:<n> for <path>");
    expect(normalizeError("x".repeat(400))).toHaveLength(200);
    expect(signatureTag(errorSignature("c", "e"))).toMatch(/^\[sig:[0-9a-f]{12}\]$/);
  });
});

describe("failure streaks", () => {
  const fake = (rows: Record<string, unknown>[]) => {
    const seen: { text: string; values: unknown[] }[] = [];
    return {
      seen,
      db: { query: async (text: string, values: unknown[]) => (seen.push({ text, values }), { rows })
      },
    };
  };

  it("counts the consecutive failures since the last ok run and signs the newest error", async () => {
    const since = new Date("2026-09-15T01:00:00Z");
    const { db, seen } = fake([
      { component: "github-state", kind: "collector_run", n: "7", since, last_error: "401 Bad credentials" },
    ]);
    const streaks = await failureStreaks(db);
    expect(streaks).toEqual([
      {
        component: "github-state",
        kind: "collector_run",
        count: 7,
        since,
        lastError: "401 Bad credentials",
        signature: errorSignature("github-state", "401 Bad credentials"),
      },
    ]);
    // the streak is bounded by the last ok run, in SQL — not by scanning in js
    expect(seen[0]?.text).toContain("last_ok");
    expect(seen[0]?.values).toEqual([["collector_run", "routine_run"]]);
    expect(streakFor(streaks, "github-state", "collector_run")?.count).toBe(7);
    expect(streakFor(streaks, "github-state", "routine_run")).toBeUndefined();
    expect(streakFor(streaks, "healthy-one", "collector_run")).toBeUndefined(); // no row = no streak
  });
});

describe("alert dedupe", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("alerts the first time, then stays quiet for the window", () => {
    expect(shouldAlert({ lastAlertAt: null, streakSince: hoursAgo(1), now })).toBe(true);
    expect(shouldAlert({ lastAlertAt: hoursAgo(1), streakSince: hoursAgo(2), now })).toBe(false);
    expect(shouldAlert({ lastAlertAt: hoursAgo(DEFAULT_ALERT_DEDUPE_HOURS), streakSince: hoursAgo(48), now })).toBe(true);
    expect(shouldAlert({ lastAlertAt: hoursAgo(7), streakSince: hoursAgo(48), now, windowHours: 6 })).toBe(true);
  });

  it("alerts again when the streak cleared and the same fault came back", () => {
    // alerted 3h ago, but the current streak only started 1h ago: it was
    // fixed in between, and breaking again is news even inside the window
    expect(shouldAlert({ lastAlertAt: hoursAgo(3), streakSince: hoursAgo(1), now })).toBe(true);
    expect(shouldAlert({ lastAlertAt: hoursAgo(3), streakSince: hoursAgo(5), now })).toBe(false);
  });
});
