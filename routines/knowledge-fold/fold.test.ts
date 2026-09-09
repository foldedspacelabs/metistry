// knowledge-fold against a fake db: the anchor (a skipped pass must not move
// the window), the two gates that make an hourly routine an evening one, the
// silence-default, the 4 KB cap on the brief, and the exclusion of the fold's
// own output — the three rules of docs/research/2026-09-stash-review.md item 1
// in test form. The real-db suite proves the SQL; this proves the logic.
import { describe, expect, it } from "vitest";
import { BRIEF_PREFIX, COMPONENT, MAX_BRIEF_BYTES, renderBrief, run, type Handle } from "./run.js";

const evening = new Date(2026, 8, 9, 19, 30, 0); // 19:30 local — the container's TZ is METISTRY_TZ
const morning = new Date(2026, 8, 9, 9, 15, 0);

interface Call {
  text: string;
  values: unknown[];
}

/** A db that answers each of the fold's five reads from `rows`, and records every call. */
function fakeDb(rows: {
  anchor?: any[];
  proposals?: any[];
  work?: any[];
  artifacts?: any[];
  sessions?: any[];
}) {
  const calls: Call[] = [];
  return {
    calls,
    inbound: () => calls.filter((c) => c.text.includes("INSERT INTO inbound_messages")),
    runsRows: () => calls.filter((c) => c.text.includes("INSERT INTO runs")),
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("kind = 'routine_run'")) return { rows: rows.anchor ?? [] };
      if (text.includes("FROM proposals")) return { rows: rows.proposals ?? [] };
      if (text.includes("FROM work")) return { rows: rows.work ?? [] };
      if (text.includes("FROM artifact_versions")) return { rows: rows.artifacts ?? [] };
      if (text.includes("FROM inbox")) return { rows: rows.sessions ?? [] };
      if (text.includes("INSERT INTO inbound_messages")) return { rows: [{ id: 501 }] };
      return { rows: [] };
    },
  };
}

const someProposal = [{ id: 41, kind: "knowledge", source_agent: "assistant", payload: { title: "Drey rebrand starts Oct 1" } }];

describe("knowledge-fold gates", () => {
  it("before 18:00 local it folds nothing — the runner has no time of day, so the gate is in the routine", async () => {
    const db = fakeDb({ proposals: someProposal });
    expect(await run(db, { now: morning })).toBe(0);
    expect(db.inbound()).toHaveLength(0);
    expect(db.runsRows()).toHaveLength(0);
  });

  it("a fold that already happened today is not repeated (hourly schedule, one fold a night)", async () => {
    const db = fakeDb({ anchor: [{ ts: new Date(2026, 8, 9, 18, 2, 0) }], proposals: someProposal });
    expect(await run(db, { now: evening })).toBe(0);
    expect(db.inbound()).toHaveLength(0);
  });

  it("silence-default: nothing new since the anchor → no turn, no runs row", async () => {
    const db = fakeDb({ anchor: [{ ts: new Date(2026, 8, 8, 18, 2, 0) }] });
    expect(await run(db, { now: evening })).toBe(0);
    expect(db.inbound()).toHaveLength(0);
    expect(db.runsRows()).toHaveLength(0);
  });
});

describe("knowledge-fold anchor and enqueue", () => {
  it("enqueues exactly one turn on thread `fold`, and logs the counts on its own runs row", async () => {
    const anchorTs = new Date(2026, 8, 8, 18, 2, 0);
    const db = fakeDb({
      anchor: [{ ts: anchorTs }],
      proposals: someProposal,
      work: [{ id: 12, title: "EventKit bridge", area: "fsl", kind: "issue", external_ref: "gh:foldedspacelabs/metistry#35" }],
      artifacts: [{ id: "ver_2", artifact_id: "art_1", path_prefix: "Artifacts/drey/brief", message: "v3: tighten the positioning", author_principal: "assistant", project: "drey", slug: "brief" }],
      sessions: [{ id: 88, path: "1757-session-metistry.md", note: "3h in metistry: the fold routine", source: "session" }],
    });
    expect(await run(db, { now: evening })).toBe(1);

    const [inbound] = db.inbound();
    expect(inbound!.values[0]).toBe("fold");
    const text = String(inbound!.values[1]);
    expect(text.startsWith(BRIEF_PREFIX)).toBe(true);
    expect(text).toContain("Knowledge/Journal/2026-09-09.md");
    expect(text).toContain("proposal #41 — Drey rebrand starts Oct 1");
    expect(text).toContain("work #12 — EventKit bridge");
    expect(text).toContain("art_1 ver_2 — v3: tighten the positioning");
    expect(text).toContain("inbox #88 — 3h in metistry: the fold routine");
    expect(JSON.parse(String(inbound!.values[2]))).toMatchObject({ kind: "fold", source: COMPONENT });

    const [runsRow] = db.runsRows();
    expect(runsRow!.values[0]).toBe(COMPONENT);
    expect(JSON.parse(String(runsRow!.values[1]))).toMatchObject({
      folded: true,
      thread: "fold",
      inbound_id: 501,
      items: 4,
      counts: { proposals: 1, work: 1, artifacts: 1, sessions: 1 },
      window_start: anchorTs.toISOString(),
    });

    // every read is windowed on the anchor — nothing older is folded twice
    for (const c of db.calls.filter((x) => x.text.trimStart().startsWith("SELECT") && !x.text.includes("routine_run"))) {
      expect(c.values[0]).toEqual(anchorTs);
    }
  });

  it("no anchor yet → a bounded first window, not the whole history", async () => {
    const db = fakeDb({ proposals: someProposal });
    expect(await run(db, { now: evening })).toBe(1);
    const since = db.calls.find((c) => c.text.includes("FROM proposals"))!.values[0] as Date;
    expect(Math.round((evening.getTime() - since.getTime()) / 86_400_000)).toBe(7);
  });

  it("never reads its own output: the fold's own proposals, artifacts and captures are excluded in SQL", async () => {
    const db = fakeDb({ proposals: someProposal });
    await run(db, { now: evening });
    const q = (frag: string) => db.calls.find((c) => c.text.includes(frag))!;
    expect(q("FROM proposals").text).toContain("source_agent <> $2");
    expect(q("FROM proposals").values[1]).toBe(COMPONENT);
    expect(q("FROM artifact_versions").text).toContain("author_principal <> $2");
    expect(q("FROM inbox").text).toContain("coalesce(source_agent, '') <> $2");
    // and by construction: no query touches the vault at all
    expect(db.calls.some((c) => /knowledge_files|Journal/.test(c.text))).toBe(false);
  });
});

describe("the brief is handles, capped", () => {
  const window = { start: new Date(2026, 8, 8, 18, 0, 0), end: evening };

  it("stays under 4 KB by dropping from the largest group and saying how many it dropped", () => {
    const many: Handle[] = Array.from({ length: 200 }, (_, i) => ({
      group: "proposals",
      ref: `proposal #${i}`,
      title: `a decision with a fairly long title, number ${i}`,
      summary: "knowledge from assistant",
    }));
    many.push({ group: "work", ref: "work #1", title: "one closed thing" });
    const r = renderBrief(many, window);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    expect(r.included.length).toBeLessThan(201);
    expect(r.dropped.proposals).toBe(201 - r.included.length);
    expect(r.text).toContain("…and");
    expect(r.text).toContain("work #1 — one closed thing"); // a small group is never starved
  });

  it("a short day renders every group and nothing else", () => {
    const r = renderBrief([{ group: "sessions", ref: "inbox #1", title: "a session", path: "s.md" }], window);
    expect(r.dropped).toEqual({});
    expect(r.text).toContain("sessions captured");
    expect(r.text).not.toContain("work closed");
    expect(r.text).not.toContain("…and");
  });
});
