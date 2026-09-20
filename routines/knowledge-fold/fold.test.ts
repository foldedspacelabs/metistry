// knowledge-fold against a fake db: the anchor (a skipped pass must not move
// the window), the two gates that make an hourly routine an evening one, the
// silence-default, the 4 KB cap on the brief, the exclusion of the fold's own
// output, and — since ticket P1-9 — the fold's own file at its new path,
// rendered from `Templates/Fold.md` when one is available and falling back to
// the pre-template freeform note, at the SAME new path, when it is not. The
// real-db suite proves the SQL; this proves the logic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TemplateQueries, TemplateReader } from "@foldedspacelabs/metistry-core";
import { vaultReader, type VaultReadable } from "../vault-reader.js";
import { BRIEF_PREFIX, COMPONENT, FOLD_TEMPLATE_PATH, MAX_BRIEF_BYTES, foldPath, renderBrief, run, type FoldWrite, type Handle } from "./run.js";

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

/** `TemplateReader` over an in-memory map — `undefined` for a path it does not hold, exactly like the real vault bridge does for a missing file. */
function fakeReader(files: Record<string, string>): TemplateReader {
  return {
    async read(path: string) {
      return Object.hasOwn(files, path) ? files[path]! : null;
    },
  };
}

/** `TemplateQueries` over fixed rows — enough for `{{ requests limit: 5 }}`, the one query-backed directive the seeded `Templates/Fold.md` uses. */
function fakeQueries(tables: Record<string, Record<string, unknown>[]>): TemplateQueries {
  return {
    async run(name: string) {
      return { rows: tables[name] ?? [] };
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
  it("enqueues exactly one turn on thread `fold`, writing Journal/Fold/<date>.md — never Journal/<date>.md, the user's own file", async () => {
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
    // no reader wired in this test → the pre-template fallback, at the NEW path
    expect(text).toContain("Journal/Fold/2026-09-09.md");
    expect(text).not.toContain("Journal/2026-09-09.md"); // never the user's file
    expect(text).toContain("source: knowledge-fold");
    expect(text).toContain("proposal #41 — Drey rebrand starts Oct 1");
    expect(text).toContain("work #12 — EventKit bridge");
    expect(text).toContain("art_1 ver_2 — v3: tighten the positioning");
    expect(text).toContain("inbox #88 — 3h in metistry: the fold routine");
    // the enqueued turn declares its tier (a machine-assembled turn runs cheap)
    // and that it must not resume the chat's session — cost research decisions 2 and 3
    expect(JSON.parse(String(inbound!.values[2]))).toMatchObject({
      kind: "fold",
      source: COMPONENT,
      tier: "routine",
      fresh_session: true,
      fold_path: "Journal/Fold/2026-09-09.md",
      fold_mode: "fallback",
    });

    const [runsRow] = db.runsRows();
    expect(runsRow!.values[0]).toBe(COMPONENT);
    expect(JSON.parse(String(runsRow!.values[1]))).toMatchObject({
      folded: true,
      thread: "fold",
      inbound_id: 501,
      items: 4,
      counts: { proposals: 1, work: 1, artifacts: 1, sessions: 1 },
      window_start: anchorTs.toISOString(),
      fold_path: "Journal/Fold/2026-09-09.md",
      fold_mode: "fallback",
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
    // and by construction: no SQL call touches the vault at all
    expect(db.calls.some((c) => /knowledge_files|Journal/.test(c.text))).toBe(false);
  });
});

describe("the fold's own file — rendered from Templates/Fold.md (P1-9)", () => {
  const anchorTs = new Date(2026, 8, 8, 18, 2, 0);
  const templateText = readFileSync(fileURLToPath(new URL("../../seed/vault/Templates/Fold.md", import.meta.url)), "utf8");

  it("renders the seeded skeleton and passes it — prose slots still open — through to the enqueued turn", async () => {
    const db = fakeDb({ anchor: [{ ts: anchorTs }], proposals: someProposal });
    const reader = fakeReader({ [FOLD_TEMPLATE_PATH]: templateText });
    const queries = fakeQueries({ pending_requests: [{ request_type: "todo", title: "Call the dentist", age_days: 1 }] });

    expect(await run(db, { now: evening, reader, queries })).toBe(1);

    const [inbound] = db.inbound();
    const text = String(inbound!.values[1]);
    expect(text).toContain("Journal/Fold/2026-09-09.md");
    expect(text).not.toContain("Journal/2026-09-09.md");
    expect(text).toContain("```markdown");
    expect(text).toContain("source: knowledge-fold");
    // both `prose` slots ride on the turn, unfilled, with their prompt and resolved `using:` handle
    expect(text).toContain("<!-- metistry:prose 1 -->");
    expect(text).toContain("1. summarise yesterday in three lines (read Journal/Fold/2026-09-08)");
    expect(text).toContain("<!-- metistry:prose 2 -->");
    expect(text).toContain("2. list anything decided today, one line each; say so if nothing was (read Journal/2026-09-09)");
    // every OTHER directive is already filled — the query-backed one included
    expect(text).toContain("Call the dentist");

    const meta = JSON.parse(String(inbound!.values[2]));
    expect(meta).toMatchObject({ fold_path: "Journal/Fold/2026-09-09.md", fold_mode: "skeleton" });
    const [runsRow] = db.runsRows();
    expect(JSON.parse(String(runsRow!.values[1]))).toMatchObject({ fold_mode: "skeleton", fold_path: "Journal/Fold/2026-09-09.md" });
  });

  it("falls back to the freeform note, at the new path, when no reader is wired", async () => {
    const db = fakeDb({ anchor: [{ ts: anchorTs }], proposals: someProposal });
    expect(await run(db, { now: evening })).toBe(1);
    const text = String(db.inbound()[0]!.values[1]);
    expect(text).toContain("Journal/Fold/2026-09-09.md");
    expect(text).toContain("no Templates/Fold.md yet");
    expect(text).not.toContain("```markdown");
    expect(JSON.parse(String(db.inbound()[0]!.values[2])).fold_mode).toBe("fallback");
  });

  it("falls back the same way — never to Journal/<date>.md — when a reader is wired but Templates/Fold.md is not in the vault (§6.4 template_missing)", async () => {
    const db = fakeDb({ anchor: [{ ts: anchorTs }], proposals: someProposal });
    const reader = fakeReader({}); // no such file
    expect(await run(db, { now: evening, reader })).toBe(1);
    const text = String(db.inbound()[0]!.values[1]);
    expect(text).toContain("Journal/Fold/2026-09-09.md");
    expect(text).not.toContain("Journal/2026-09-09.md");
    expect(text).toContain("no Templates/Fold.md yet");
    expect(JSON.parse(String(db.inbound()[0]!.values[2])).fold_mode).toBe("fallback");
  });

  // The runner (`apps/console/src/runner.ts`'s `routineCapabilities`) does not
  // hand the fold an arbitrary `TemplateReader` — it hands one built by
  // `vaultReader` (`routines/vault-reader.ts`) over the vault bridge client.
  // These two exercise that exact adapter rather than the hand-rolled
  // `fakeReader` above, so the wiring itself — not just `FoldCtx.reader`'s
  // contract — is covered.
  it("with the vaultReader adapter over a vault that holds Templates/Fold.md, takes the skeleton path", async () => {
    const db = fakeDb({ anchor: [{ ts: anchorTs }], proposals: someProposal });
    const vault: VaultReadable = { async read(path) { return path === FOLD_TEMPLATE_PATH ? { content: Buffer.from(templateText, "utf8") } : null; } };
    const queries = fakeQueries({ pending_requests: [] });

    expect(await run(db, { now: evening, reader: vaultReader(vault), queries })).toBe(1);

    const meta = JSON.parse(String(db.inbound()[0]!.values[2]));
    expect(meta).toMatchObject({ fold_path: "Journal/Fold/2026-09-09.md", fold_mode: "skeleton" });
  });

  it("with the vaultReader adapter over a vault bridge that is unreachable, still falls back rather than losing the fold", async () => {
    const db = fakeDb({ anchor: [{ ts: anchorTs }], proposals: someProposal });
    const vault: VaultReadable = { read: () => Promise.reject(new Error("bridge unreachable")) };

    expect(await run(db, { now: evening, reader: vaultReader(vault) })).toBe(1);

    const meta = JSON.parse(String(db.inbound()[0]!.values[2]));
    expect(meta.fold_mode).toBe("fallback");
  });
});

describe("the brief is handles, capped", () => {
  const window = { start: new Date(2026, 8, 8, 18, 0, 0), end: evening };
  const fallbackWrite: FoldWrite = { mode: "fallback", path: foldPath("2026-09-09"), note: "no Templates/Fold.md yet — writing freeform tonight" };

  it("stays under 4 KB by dropping from the largest group and saying how many it dropped", () => {
    const many: Handle[] = Array.from({ length: 200 }, (_, i) => ({
      group: "proposals",
      ref: `proposal #${i}`,
      title: `a decision with a fairly long title, number ${i}`,
      summary: "knowledge from assistant",
    }));
    many.push({ group: "work", ref: "work #1", title: "one closed thing" });
    const r = renderBrief(many, window, fallbackWrite);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    expect(r.included.length).toBeLessThan(201);
    expect(r.dropped.proposals).toBe(201 - r.included.length);
    expect(r.text).toContain("…and");
    expect(r.text).toContain("work #1 — one closed thing"); // a small group is never starved
  });

  it("a short day renders every group and nothing else", () => {
    const r = renderBrief([{ group: "sessions", ref: "inbox #1", title: "a session", path: "s.md" }], window, fallbackWrite);
    expect(r.dropped).toEqual({});
    expect(r.text).toContain("sessions captured");
    expect(r.text).not.toContain("work closed");
    expect(r.text).not.toContain("…and");
  });

  it("a skeleton write appends the rendered file after the handle groups, uncapped by MAX_BRIEF_BYTES", () => {
    const skeletonWrite: FoldWrite = {
      mode: "skeleton",
      path: foldPath("2026-09-09"),
      skeleton: "---\nsource: knowledge-fold\n---\n# Fold — 2026-09-09\n",
      proseRequests: [{ index: 1, prompt: "summarise yesterday", using: "Journal/Fold/2026-09-08", marker: "<!-- metistry:prose 1 -->", line: 5 }],
    };
    const r = renderBrief([{ group: "sessions", ref: "inbox #1", title: "a session" }], window, skeletonWrite);
    expect(r.text).toContain("```markdown");
    expect(r.text).toContain("source: knowledge-fold");
    expect(r.text).toContain("1. summarise yesterday (read Journal/Fold/2026-09-08)");
  });
});

describe("seed/assistant-prompt.md — the Fold section (P1-9)", () => {
  const prompt = readFileSync(fileURLToPath(new URL("../../seed/assistant-prompt.md", import.meta.url)), "utf8");
  const foldSection = prompt.slice(prompt.indexOf("## The evening fold"));

  it("no longer names Journal/<date>.md — the user's own file — as a fold write target", () => {
    expect(foldSection.length).toBeGreaterThan(0); // the section exists at all
    expect(foldSection).not.toContain("**`Journal/<the date in the header>.md`**");
    expect(foldSection).toContain("**`Journal/Fold/<the date in the header>.md`**");
    expect(foldSection).toContain("Never `Journal/<the date>.md`");
  });
});
