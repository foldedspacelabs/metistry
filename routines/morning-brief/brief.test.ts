import { describe, expect, it } from "vitest";
import { pickBudget, run, score } from "./run.js";

const now = new Date("2026-09-01T12:00:00Z");
const row = (id: number, kind: string, payload: any = {}, ageDays = 0) => ({
  id, kind, payload, ts: new Date(now.getTime() - ageDays * 86_400_000),
});

describe("morning brief (D10 soft budget)", () => {
  it("ranks by consequence: elevations > actionable todos > notes; age raises, capped", () => {
    const grant = score(row(1, "grant_elevation"), now);
    const todo = score(row(2, "knowledge", { classification: { kind: "todo", has_action: true } }), now);
    const note = score(row(3, "knowledge", { classification: { kind: "note" } }), now);
    expect(grant).toBeGreaterThan(todo);
    expect(todo).toBeGreaterThan(note);
    expect(score(row(4, "knowledge", {}, 30), now) - score(row(4, "knowledge", {}), now)).toBe(14); // cap
  });

  it("a blocking question scores with elevations — a waiting assistant is a blocked assistant", () => {
    const decision = score(row(5, "decision", { title: "Which repo?", options: ["a", "b"] }), now);
    expect(decision).toBe(score(row(6, "grant_elevation"), now));
    expect(decision).toBeGreaterThanOrEqual(80); // CRITICAL_SCORE: rides above the soft budget when queued behind others
    expect(decision).toBeGreaterThan(score(row(7, "report"), now));
  });

  it("soft budget: 5 base, +2 only when also critical — never a hard cut", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ row: row(i, "knowledge"), s: 50 - i }));
    expect(pickBudget(many)).toHaveLength(5); // nothing critical beyond 5
    const critical = Array.from({ length: 10 }, (_, i) => ({ row: row(i, "grant_elevation"), s: 100 - i }));
    expect(pickBudget(critical)).toHaveLength(7); // +2 critical extras, not all 10
  });

  it("schedule section renders today's events with attendees; bridge failure degrades absent", async () => {
    let text = "";
    const db = { async query(t: string, v?: unknown[]) {
      if (t.includes("FROM runs")) return { rows: [{ runs_ok: 0, turns: 0, captures: 0, failures: 0, spend: 0 }] };
      if (t.includes("INSERT INTO outbound_messages")) { text = String(v![0]); return { rows: [] }; }
      return { rows: [] };
    } };
    const events = [{ title: "Standup", start: "2026-09-02T13:30:00Z", end: "2026-09-02T13:45:00Z", all_day: false, location: "Zoom", attendees: ["Alex", "Sam"] }];
    const okFetch = (async () => ({ ok: true, json: async () => ({ events }) })) as unknown as typeof fetch;
    expect(await run(db, { ekUrl: "http://ek", ekToken: "t", fetchFn: okFetch })).toBe(1); // events alone justify a brief
    expect(text).toContain("📅 Schedule:");
    expect(text).toContain("Standup @ Zoom");
    expect(text).toContain("with Alex, Sam");
    expect(text).not.toContain("calendar bridge is connected");

    const deadFetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await run(db, { ekUrl: "http://ek", ekToken: "t", fetchFn: deadFetch })).toBe(0); // nothing else pending → silent
  });

  it("silence-default: nothing pending, nothing due, nothing failing emits nothing", async () => {
    const q: string[] = [];
    const db = { async query(t: string) {
      q.push(t);
      if (t.includes("FROM runs")) return { rows: [{ runs_ok: 0, turns: 0, captures: 0, failures: 0, spend: 0 }] };
      return { rows: [] };
    } };
    expect(await run(db)).toBe(0);
    expect(q.some((t) => t.includes("INSERT INTO outbound_messages"))).toBe(false);
  });

  it("emits an actionable sectioned brief: today, decisions (soft budget), system", async () => {
    let briefText = "";
    const pending = Array.from({ length: 8 }, (_, i) => row(i + 1, "knowledge", { classification: { title: `item ${i + 1}` } }, i));
    const db = {
      async query(t: string, v?: unknown[]) {
        if (t.includes("SET decision = 'expired'")) return { rows: [{ id: 99 }] };
        if (t.startsWith("SELECT id, kind")) return { rows: pending };
        if (t.includes("GROUP BY area")) return { rows: [{ area: "metistry", open: 4, blocked: 1, closed_7d: 9, latest: ["EventKit bridge", "test isolation"] }] };
        if (t.includes("needs_my_review")) return { rows: [{ external_ref: "gh:foldedspacelabs/metistry#41", title: "claude-usage collector", author: "claude", updated_at: new Date(Date.now() - 2 * 86_400_000) }] };
        if (t.includes("FROM work")) return { rows: [{ title: "ship phase 3", status: "in_progress", due: null }] };
        if (t.includes("has_action")) return { rows: [{ id: 7, payload: { classification: { action: "renew cert" } } }] };
        if (t.includes("FROM runs")) return { rows: [{ runs_ok: 3, turns: 2, captures: 4, failures: 1, spend: 0.12 }] };
        if (t.includes("INSERT INTO outbound_messages")) { briefText = String(v![0]); return { rows: [] }; }
        return { rows: [] };
      },
    };
    expect(await run(db)).toBe(1);
    expect(briefText).toContain("✅ Today:");
    expect(briefText).toContain("ship phase 3");
    expect(briefText).toContain("renew cert");
    expect(briefText).toContain("👀 Reviews waiting on you:");
    expect(briefText).toContain("• foldedspacelabs/metistry#41 claude-usage collector — claude, 2d");
    expect(briefText).toContain("🔔 Needs your decision:");
    expect(briefText.split("🔔")[1]!.split("📂")[0]!.match(/^• /gm)!.length).toBe(5); // soft budget holds
    expect(briefText).toContain("…3 more — open triage");
    expect(briefText).toContain("auto-expired, still searchable");
    expect(briefText).toContain("📂 Projects:");
    expect(briefText).toContain("metistry: 4 open, 1 blocked, 9 closed this week");
    expect(briefText).toContain("latest: EventKit bridge · test isolation");
    expect(briefText).toContain("⚙️ What I've been doing:");
    expect(briefText).toContain("1 failed run(s)");
    expect(briefText).toContain("calendar bridge");
  });

  it("a budget flip to review mode (runs kind project_mode, §4.21) is enough to break the silence and is named in the system section", async () => {
    let briefText = "";
    const db = {
      async query(t: string, v?: unknown[]) {
        if (t.includes("kind = 'project_mode'")) return { rows: [{ meta: { project: "drey", from: "autonomous", to: "review", reason: "budget", spend_usd: 12.5, budget_usd: 10 } }, { meta: { project: "x", to: "autonomous" } }] };
        if (t.includes("FROM runs")) return { rows: [{ runs_ok: 3, turns: 0, captures: 0, failures: 0, spend: 12.5 }] };
        if (t.includes("INSERT INTO outbound_messages")) { briefText = String(v![0]); return { rows: [] }; }
        return { rows: [] };
      },
    };
    expect(await run(db)).toBe(1);
    expect(briefText).toContain("• ⚠ project drey flipped to review mode: budget (12.50 of 10.00 USD) — agent-to-agent review is queued for you until you switch it back");
    expect(briefText).not.toContain("project x");
  });
});
