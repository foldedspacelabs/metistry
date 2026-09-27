// X-5 — the PWA reads F-5's request type table (design-build-plan §2.12)
// instead of holding its own copy, and Skip is bulk-only (K2). T2-3 — and
// draws each type's OWN answers from it: Send Answers on a question with its
// questions as the body, Dismiss on a report, Approve as Work folded into
// Approve, and nothing for an answer whose door is not served yet.
//
// The PWA cannot import core, so GET /api/proposals serves each row's reading
// as `request` (`withRequestShape` → core's `describeRequest`), and app.js
// draws the word it is given. These tests hold the two together: the row the
// server builds, rendered by the row function lifted out of app.js, says the
// table's word for every kind the table knows — and a report for one it does
// not — and offers no Skip.
//
// apps/console/web/app.js is a browser script and cannot be imported, so, as
// in pwa-reads.test.ts, the pure top-level declarations are lifted out of the
// source by name and evaluated. A rename makes the lift throw rather than
// letting a test pass vacuously.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUEST_KINDS, REQUEST_TYPES, REQUEST_TYPE_TABLE, describeRequest, requestWordOf } from "@foldedspacelabs/metistry-core";
import { withRequestShape } from "../src/server.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = read("../web/app.js");
const HTML = read("../web/index.html");

/** Lift a top-level `const NAME = …` or `function NAME(…) {…}` out of app.js (pwa-reads.test.ts's, plus arrows that wrap). */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:const|let) ${name}\\b|^function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`app.js no longer declares ${name} — update this test with the rename`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    // an arrow whose body starts on the next line (`scopeOf`) is not over at `=>`
    if (depth <= 0 && !lines[i]!.trimEnd().endsWith("=>")) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`could not find the end of ${name} in app.js`);
}

/** app.js's esc() is textContent → innerHTML: it escapes &, < and >. */
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const pwa = new Function(
  "esc",
  `${[
    "requestWord",
    "requestHeading",
    "DECLINE_STYLE",
    "DEFER",
    "attr",
    "ACTION_NOISE",
    "actionNote",
    "ARG_PREVIEW_CHARS",
    "actionDetail",
    "ACCESS_LABEL",
    "accessLabel",
    "scopeOf",
    "accessDetail",
    "questionDetail",
    "collectAnswers",
    "requestAnswers",
    "proposalRow",
  ]
    .map(lift)
    .join("\n")}\nreturn { requestWord, requestHeading, DEFER, proposalRow, collectAnswers };`,
)(esc) as {
  requestWord: (p: unknown) => string;
  requestHeading: (word: string) => string;
  DEFER: { d: string; label: string }[];
  proposalRow: (p: unknown) => string;
  collectAnswers: (p: unknown, find: (sel: string) => unknown[]) => { answers?: unknown[]; missing?: number };
};

/** A row as GET /api/proposals serves it — the stored columns, then the server's own `withRequestShape`. */
let nextId = 1;
const served = (kind: string, payload: Record<string, unknown> = {}) =>
  withRequestShape({ id: nextId++, ts: "2026-09-26T08:00:00.000Z", kind, source_agent: "assistant", trust: "internal", payload, decision: "pending" });

/** The word a rendered row shows in its meta line: the first thing after the label's muted span opens. */
const metaWord = (html: string) => /<span class="muted">([^<]*?) · /.exec(html)?.[1];

describe("every kind renders the table's word (F-5, §2.12)", () => {
  for (const kind of REQUEST_KINDS) {
    it(`${kind} reads as “${requestWordOf(kind)}”`, () => {
      const row = served(kind);
      expect(row.request).toEqual(describeRequest(kind, {}));
      expect(metaWord(pwa.proposalRow(row)), kind).toBe(requestWordOf(kind));
    });
  }

  it("a kind the table does not know reads as a report — never as its stored kind", () => {
    const html = pwa.proposalRow(served("sync_conflict"));
    expect(metaWord(html)).toBe(REQUEST_TYPE_TABLE.report.word);
    // what the owner reads: the text and the accessible names, not the machine attributes
    const read = html.replace(/<[^>]*aria-label="([^"]*)"[^>]*>/g, " $1 ").replace(/<[^>]*>/g, " ");
    expect(read).not.toContain("sync_conflict");
    expect(read).toMatch(/select report/);
  });

  it("the word comes off the served row, not off the kind: the view has no mapping to consult", () => {
    // a row whose served reading disagrees with its kind is drawn as served —
    // proof the PWA reads `request`, rather than keeping a map that happens to agree
    const row = { ...served("knowledge"), request: { ...describeRequest("knowledge"), word: "served word" } };
    expect(metaWord(pwa.proposalRow(row))).toBe("served word");
    expect(pwa.requestWord({ kind: "knowledge" })).toBe("");
  });

  it("app.js holds no copy of the kind → word mapping", () => {
    for (const kind of REQUEST_KINDS.filter((k) => k !== requestWordOf(k))) {
      expect(SRC, `app.js names the stored kind ${kind}`).not.toMatch(new RegExp(`\\b${kind}\\s*:\\s*"`));
    }
    expect(SRC).not.toMatch(/\bREQUEST_TYPE\b|\bTYPE_LABEL\b|\brequestType\(/);
  });

  it("group headings are the table's words in Title Case (P10)", () => {
    const headings = REQUEST_TYPES.map((t) => pwa.requestHeading(REQUEST_TYPE_TABLE[t].word));
    expect(headings).toContain("Pull Request");
    expect(headings).toContain("Question");
    for (const h of headings) expect(h, h).toMatch(/^[A-Z][a-z]*(?: [A-Z][a-z]*)*$/);
  });

  it("escapes the served word like every other field (CRIT-7)", () => {
    const row = { ...served("knowledge"), request: { ...describeRequest("knowledge"), word: "<img src=x>" } };
    const html = pwa.proposalRow(row);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});

const payloads: Record<string, Record<string, unknown>> = {
  decision: { options: ["ship", "hold"] },
  access_request: { area: "Areas/Health", current_tier: "index" },
  action: { action: { kind: "vault.move", args: { from: "a", to: "b" } }, reason: "tidy" },
  knowledge: { suggested_work: { title: "write it up" } },
  report: { suggested_work: { title: "look into it" } },
};

/** The buttons a rendered row offers, as [word, decision]. */
const buttons = (html: string) =>
  [...html.matchAll(/<button data-(?:triage|answers)="[^"]*" data-d="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);

describe("no row offers Skip — Skip is bulk-only (K2)", () => {
  for (const kind of [...REQUEST_KINDS, "sync_conflict"]) {
    it(`${kind}: Later is the one verb beside the answers, and there is no Skip`, () => {
      const row = served(kind, payloads[kind] ?? {});
      const html = pwa.proposalRow(row);
      expect(html).not.toMatch(/>\s*Skip\s*</);
      expect(html).toMatch(/data-d="later"[^>]*>Later</);
      // `skip` rides only as the type's own Decline — a report's Dismiss, a message's Not Mine — never under Skip's name
      const skips = buttons(html).filter(([, d]) => d === "skip");
      expect(skips.map(([word]) => word), kind).toEqual(row.request.decline && "decision" in row.request.decline.sends && row.request.decline.sends.decision === "skip" ? [row.request.decline.label] : []);
    });
  }

  it("the per-row defer set is Later alone", () => {
    expect(pwa.DEFER).toEqual([{ d: "later", label: "Later" }]);
  });

  it("Skip stays on the selection bar and its shortcut", () => {
    expect(HTML).toMatch(/id="triage-skip"[^>]*>Skip</);
    expect(SRC).toContain(`$("triage-skip").onclick = () => batchDecide("skip");`);
    expect(SRC).toMatch(/e\.key === "s"\) \{ e\.preventDefault\(\); batchDecide\("skip"\);/);
  });
});

describe("each type draws its own answers from the table (T2-3)", () => {
  for (const kind of [...REQUEST_KINDS, "sync_conflict"]) {
    it(`${kind}: exactly the table's answers that store a decision, in its words, then Later`, () => {
      const row = served(kind, payloads[kind] ?? {});
      const want = [row.request.primary, row.request.revise, row.request.decline]
        .filter((a): a is NonNullable<typeof a> => a !== null && a.label !== null && "decision" in a.sends)
        .map((a) => [a.label, (a.sends as { decision: string }).decision]);
      expect(buttons(pwa.proposalRow(row)), kind).toEqual([...want, ["Later", "later"]]);
    });
  }

  it("a report offers Dismiss and Later — never Approve, and never a button for an act its door does not serve yet", () => {
    const html = pwa.proposalRow(served("report", { title: "Nightly fold finished", suggested_work: { title: "look into it" } }));
    expect(buttons(html)).toEqual([["Dismiss", "skip"], ["Later", "later"]]);
    expect(html).not.toMatch(/data-d="allow"|Approve/);
  });

  it("Approve is Approve as Work where the row suggests work (§1.4), and says what it creates", () => {
    const html = pwa.proposalRow(served("knowledge", { title: "t", suggested_work: { title: "write it up" } }));
    expect(buttons(html)[0]).toEqual(["Approve", "accept_as_work"]);
    expect(html).toContain("creates the task “write it up”, unassigned");
    expect(buttons(pwa.proposalRow(served("knowledge", { title: "t" })))[0]).toEqual(["Approve", "allow"]);
  });

  it("an access request's Revise carries the area; everyone else's carries words", () => {
    expect(pwa.proposalRow(served("access_request", payloads.access_request!))).toMatch(/data-d="accept_with_changes" data-carries="area"[^>]*>Revise</);
    expect(pwa.proposalRow(served("knowledge", {}))).toMatch(/data-d="accept_with_changes" data-carries="feedback"[^>]*>Revise</);
  });

  it("a question draws every question it asks — pick one, pick any, Something else… — and Send Answers", () => {
    const row = served("decision", {
      title: "Three things",
      questions: [
        { prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true },
        { prompt: "Which labels?", options: ["bug", "docs"], multi: true, allow_other: true },
        { prompt: "Ship <it>?", options: ["yes", "not yet"], multi: false, allow_other: false },
      ],
      context: { prose: "The fold drops drafts." },
    });
    const html = pwa.proposalRow(row);
    expect(buttons(html)).toEqual([["Send Answers", "answers"], ["Revise", "accept_with_changes"], ["Decline", "deny"], ["Later", "later"]]);
    expect(html.match(new RegExp(`type="radio" name="q-${row.id}-0"`, "g"))).toHaveLength(3); // two options + Something else…
    expect(html.match(new RegExp(`type="checkbox" name="q-${row.id}-1"`, "g"))).toHaveLength(3);
    expect(html.match(new RegExp(`type="radio" name="q-${row.id}-2"`, "g"))).toHaveLength(2); // no Something else…: its options only
    expect(html.match(/data-other-text=/g)).toHaveLength(2);
    expect(html).toContain('role="radiogroup" aria-label="Ship &lt;it&gt;?"');
    expect(html).toContain("<b>Ship &lt;it&gt;?</b>"); // agent-authored: output-encoded (CRIT-7)
    expect(html).toContain("why: The fold drops drafts.");
    // a row from before v2 is served as its one question: the same body, the same Send Answers
    const v1 = pwa.proposalRow(served("decision", { title: "Ship it?", options: ["ship", "hold"] }));
    expect(buttons(v1)[0]).toEqual(["Send Answers", "answers"]);
    expect(v1).not.toContain("data-other-text"); // v1's options are its only answers
  });

  it("Send Answers sends one answer per question, in order — and names the first one left unanswered", () => {
    const row = served("decision", {
      title: "Two things",
      questions: [
        { prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true },
        { prompt: "Which labels?", options: ["bug", "docs"], multi: true, allow_other: true },
      ],
    });
    type Input = { name?: string; value: string; checked?: boolean; other?: boolean };
    const form = (inputs: Input[]) => (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1];
      const text = /data-other-text="([^"]+)"/.exec(sel)?.[1];
      return inputs
        .filter((i) => (name !== undefined && i.name === name && i.checked !== undefined) || (text !== undefined && i.name === `text:${text}`))
        .map((i) => ({ value: i.value, checked: i.checked ?? false, hasAttribute: (a: string) => a === "data-other" && i.other === true }));
    };
    const q0 = `q-${row.id}-0`;
    const q1 = `q-${row.id}-1`;
    expect(
      pwa.collectAnswers(row, form([
        { name: q0, value: "metistry-instance", checked: true },
        { name: q1, value: "bug", checked: true },
        { name: q1, value: "docs", checked: false },
        { name: q1, value: "", checked: true, other: true },
        { name: `text:${q1}`, value: "  and perf " },
      ])),
    ).toEqual({ answers: [{ choices: ["metistry-instance"] }, { choices: ["bug"], other: "and perf" }] });
    expect(pwa.collectAnswers(row, form([{ name: q0, value: "metistry", checked: true }]))).toEqual({ missing: 1 });
    // Something else… with no words is not an answer
    expect(pwa.collectAnswers(row, form([{ name: q0, value: "", checked: true, other: true }, { name: `text:${q0}`, value: " " }]))).toEqual({ missing: 0 });
  });

  it("app.js sends a question's answers as `answers`, never an option as a verb", () => {
    expect(SRC).toContain(`await decide(b.dataset.answers, { decision: b.dataset.d, answers: got.answers });`);
    expect(SRC).not.toMatch(/data-d="\$\{attr\(o\)\}"/);
  });
});
