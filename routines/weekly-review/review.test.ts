import { describe, expect, it } from "vitest";
import { monthlyWindow, run } from "./run.js";

// A Saturday mid-month: the weekly window is Sep 12–19 and the monthly
// block is gated off. Tests that want the block inject a first-week date.
const now = new Date("2026-09-19T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

type Stub = (sql: string, values?: unknown[]) => any[] | undefined;

// Fake db keyed on SQL substrings. Specific stubs must come BEFORE generic
// ones — the first match wins, and e.g. "FROM proposals" appears in three
// section queries.
function fakeDb(stubs: Array<[string, Stub | any[]]>) {
  const sent: string[] = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO outbound_messages")) {
        sent.push(String(values![0]));
        return { rows: [] };
      }
      for (const [key, stub] of stubs) {
        if (!sql.includes(key)) continue;
        const rows = typeof stub === "function" ? stub(sql, values) : stub;
        if (rows !== undefined) return { rows };
      }
      return { rows: [] };
    },
  };
  return { db, sent };
}

describe("weekly review", () => {
  it("always emits exactly one 'review' row, with every section present and honest when empty", async () => {
    const inserts: unknown[][] = [];
    const db = {
      async query(sql: string, values?: unknown[]) {
        if (sql.includes("INSERT INTO outbound_messages")) inserts.push([sql, ...values!]);
        return { rows: [] };
      },
    };
    expect(await run(db, { now })).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0]![0])).toContain("'review'");
    const text = String(inserts[0]![1]);
    expect(text).toContain("📋 weekly review — Sep 12 to Sep 19");
    for (const h of ["📂 Projects:", "✅ Decisions you made:", "🔔 Still pending:", "🤖 Agents:", "💸 Spend (7 days):", "⚙️ System:", "🔭 Next week:"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("• no project activity this week");
    expect(text).toContain("• none this week — nothing needed you");
    expect(text).toContain("• nothing pending");
    expect(text).toContain("• no agents registered and no agent activity this week");
    expect(text).toContain("• assistant: no usage metrics yet");
    expect(text).toContain("• AWS: no cost data");
    expect(text).toContain("• no collector or routine runs recorded");
    expect(text).toContain("• no watchdog alerts");
    expect(text).toContain("• inbox clear");
    expect(text).toContain("• nothing due in the next 7 days");
    expect(text).toContain("EventKit bridge is connected");
    expect(text).not.toContain("📅 Last month");
  });

  it("projects: per area/project counts, PRs from gh: refs, blocked items with age", async () => {
    const { db, sent } = fakeDb([
      ["AS age_days", [{ title: "EventKit signing", name: "metistry", age_days: "12" }]],
      ["AS tasks_created", [
        { name: "metistry", tasks_created: "4", tasks_closed: "6", prs_opened: "3", prs_closed: "2", blocked: "1" },
        { name: "home", tasks_created: "1", tasks_closed: "0", prs_opened: "0", prs_closed: "0", blocked: "0" },
      ]],
    ]);
    await run(db, { now });
    expect(sent[0]).toContain("• metistry: 4 tasks created, 6 closed; 3 PRs opened, 2 closed; 1 blocked\n    blocked: EventKit signing (12d)");
    expect(sent[0]).toContain("• home: 1 task created, 0 closed; 0 PRs opened, 0 closed\n");
  });

  it("decisions: counts by outcome, top denied reasons from feedback; pending is a count and a link (D10), never the list", async () => {
    const { db, sent } = fakeDb([
      ["feedback IS NOT NULL", [{ feedback: "duplicate of an existing note", n: "2" }, { feedback: "wrong area", n: "1" }]],
      ["decision = 'pending'", [{ n: "4", oldest: daysAgo(9) }]],
      ["GROUP BY decision", [{ decision: "allow", n: "7" }, { decision: "deny", n: "3" }, { decision: "accept_with_changes", n: "1" }, { decision: "expired", n: "2" }]],
    ]);
    await run(db, { now });
    expect(sent[0]).toContain("• 13 decided: 7 allowed, 3 denied, 1 accepted with changes; 2 auto-expired (still searchable)");
    expect(sent[0]).toContain('• top denied reasons: "duplicate of an existing note" (2), "wrong area" (1)');
    expect(sent[0]).toContain("• 4 waiting, oldest 9d — open triage to see everything");
    expect(sent[0]).not.toMatch(/^• #\d+/m); // no per-item pending lines
  });

  it("decisions: denied reasons line is omitted when no feedback was left", async () => {
    const { db, sent } = fakeDb([["GROUP BY decision", [{ decision: "allow", n: "2" }]]]);
    await run(db, { now });
    expect(sent[0]).toContain("• 2 decided: 2 allowed\n");
    expect(sent[0]).not.toContain("top denied reasons");
  });

  it("agents: per source_agent stats, spend only if any, last_seen from the agents table", async () => {
    const { db, sent } = fakeDb([
      ["AS reports", [
        { id: "claude-desk", display_name: "Claude Desktop", last_seen_at: daysAgo(2), revoked_at: null, reports: "2", proposals: "1", claimed: "3", closed: "1", calls: "41", spend: "0.32" },
        { id: "ghost", display_name: null, last_seen_at: null, revoked_at: null, reports: "0", proposals: "0", claimed: "1", closed: "0", calls: "1", spend: "0" },
        { id: "old", display_name: "Old", last_seen_at: daysAgo(40), revoked_at: daysAgo(30), reports: "0", proposals: "0", claimed: "0", closed: "0", calls: "0", spend: "0" },
      ]],
    ]);
    await run(db, { now });
    expect(sent[0]).toContain("• claude-desk (Claude Desktop): 2 reports, 1 proposal, 3 tasks claimed, 1 closed, 41 tool calls, 0.32 USD — last seen 2d ago");
    expect(sent[0]).toContain("• ghost: 0 reports, 1 task claimed, 0 closed, 1 tool call — not registered");
    expect(sent[0]).toContain("• old (Old): 0 reports, 0 tasks claimed, 0 closed, 0 tool calls — revoked");
  });

  it("agents: the list is capped at the busiest 10 with a count for the rest, never the roster", async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, display_name: null, last_seen_at: null, revoked_at: null, reports: "0", proposals: "0", claimed: "0", closed: "0", calls: String(13 - i), spend: "0" }));
    const { db, sent } = fakeDb([["AS reports", many]]);
    await run(db, { now });
    const section = sent[0]!.split("🤖 Agents:")[1]!.split("💸")[0]!;
    expect(section.match(/^• a\d+/gm)).toHaveLength(10);
    expect(section).toContain("…3 more agent(s) — see the agents page");
  });

  it("spend: assistant by model tier labelled API-equivalent, AWS total with top 3 services", async () => {
    const { db, sent } = fakeDb([
      ["claude.cost_usd", [{ model: "sonnet", usd: "0.90" }, { model: "haiku", usd: "0.33" }]],
      ["aws.cost_usd", [{ service: "EC2", usd: "20.1" }, { service: "S3", usd: "11" }, { service: "Route53", usd: "3" }, { service: "KMS", usd: "1" }]],
    ]);
    await run(db, { now });
    expect(sent[0]).toContain("• assistant (API-equivalent): 1.23 USD — sonnet 0.90, haiku 0.33");
    expect(sent[0]).toContain("• AWS: 35.10 USD — EC2 20.10, S3 11.00, Route53 3.00\n");
  });

  it("system: runs by component with failures and silent collectors flagged, watchdog alerts, inbox backlog", async () => {
    const { db, sent } = fakeDb([
      ["'collector_run', 'routine_run'", [
        { component: "aws-costs", ok: "27", failed: "1", last_ts: daysAgo(0) },
        { component: "github-state", ok: "168", failed: "0", last_ts: daysAgo(0) },
        { component: "inbox-drain", ok: "0", failed: "0", last_ts: daysAgo(9) },
      ]],
      ["kind = 'alert'", [{ text: "console probe failed\nsecond line", n: "2" }, { text: "db down", n: "1" }]],
      ["FROM inbox", [{ n: "4", oldest: daysAgo(9) }]],
    ]);
    await run(db, { now });
    expect(sent[0]).toContain("• runs: aws-costs 27 ok ⚠ 1 failed, github-state 168 ok, inbox-drain ⚠ silent 9d");
    expect(sent[0]).toContain('• 3 watchdog alerts: "console probe failed" ×2, "db down" ×1');
    expect(sent[0]).toContain("• inbox: 4 untriaged, oldest 9d");
  });

  it("next week: due dates (overdue marked) plus calendar events when the bridge is configured; bridge failure degrades to one line", async () => {
    const { db, sent } = fakeDb([
      ["to_char(due", [
        { title: "renew cert", due: "2026-09-17", status: "open" },
        { title: "ship phase 5", due: "2026-09-22", status: "blocked" },
      ]],
    ]);
    const events = [
      { title: "Standup", start: "2026-09-21T13:30:00Z", end: "2026-09-21T13:45:00Z", all_day: false, location: "", attendees: [] },
      { title: "Offsite", start: "2026-09-23T00:00:00Z", end: "2026-09-24T00:00:00Z", all_day: true, location: "", attendees: [] },
    ];
    let url = "";
    const okFetch = (async (u: string) => { url = u; return { ok: true, json: async () => ({ events }) }; }) as unknown as typeof fetch;
    await run(db, { now, ekUrl: "http://ek", ekToken: "t", fetchFn: okFetch });
    expect(url).toBe("http://ek/events?days=7");
    expect(sent[0]).toContain("• 2026-09-17 renew cert — overdue");
    expect(sent[0]).toContain("• 2026-09-22 ship phase 5 — blocked");
    expect(sent[0]).toContain("• calendar: 2 events");
    expect(sent[0]).toMatch(/ {4}\w{3}, Sep 21 .*Standup/);
    expect(sent[0]).toMatch(/ {4}\w{3}, Sep 2\d \(all day\) Offsite/);
    expect(sent[0]).not.toContain("EventKit bridge is connected");

    const deadFetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    await run(db, { now, ekUrl: "http://ek", ekToken: "t", fetchFn: deadFetch });
    expect(sent[1]).toContain("• calendar unavailable this run");
    expect(sent[1]).toContain("renew cert"); // work still listed
  });

  it("monthly block: only in the first 7 days of a month, covering the previous calendar month", () => {
    expect(monthlyWindow(new Date(2026, 8, 6, 12))).toEqual({ from: "2026-08-01", to: "2026-09-01", label: expect.stringMatching(/August 2026/) });
    expect(monthlyWindow(new Date(2026, 8, 7, 12))).not.toBeNull();
    expect(monthlyWindow(new Date(2026, 8, 8, 12))).toBeNull();
    expect(monthlyWindow(new Date(2026, 0, 3, 12))).toEqual({ from: "2025-12-01", to: "2026-01-01", label: expect.stringMatching(/December 2025/) });
  });

  it("monthly block renders last month's spend by tier and AWS total, separately from the 7-day window", async () => {
    const firstWeek = new Date(2026, 8, 6, 12); // local Sep 6
    const { db, sent } = fakeDb([
      ["claude.cost_usd", (_sql, v) => (v![0] === "2026-08-01" ? [{ model: "opus", usd: "12.5" }, { model: "haiku", usd: "1.5" }] : [{ model: "haiku", usd: "0.10" }])],
      ["aws.cost_usd", (_sql, v) => (v![0] === "2026-08-01" ? [{ service: "EC2", usd: "80" }] : [])],
    ]);
    await run(db, { now: firstWeek });
    const [weekly, monthly] = sent[0]!.split("📅 Last month (August 2026):");
    expect(monthly).toBeDefined();
    expect(weekly).toContain("• assistant (API-equivalent): 0.10 USD — haiku 0.10");
    expect(weekly).toContain("• AWS: no cost data");
    expect(monthly).toContain("• assistant (API-equivalent): 14.00 USD — opus 12.50, haiku 1.50");
    expect(monthly).toContain("• AWS: 80.00 USD — EC2 80.00");
    expect(monthly).toContain("subscription headroom check");
  });
});
