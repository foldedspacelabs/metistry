// X-5 — the PWA reads F-5's request type table (design-build-plan §2.12)
// instead of holding its own copy, and Skip is bulk-only (K2).
//
// The PWA cannot import core, so GET /api/proposals serves each row's reading
// as `request` (`withRequestShape` → core's `describeRequest`), and Needs You
// draws the word it is given. These tests hold the two together: the row the
// server builds, drawn by the PWA's own card and list row, says the table's
// word for every kind the table knows — and a report for one it does not —
// and offers no Skip.
//
// Needs You is its own module since T7-3a (apps/console/web/needs-you.js),
// with no DOM at the top level, so its drawing functions are imported as they
// are rather than lifted out of app.js.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUEST_KINDS, REQUEST_TYPES, REQUEST_TYPE_TABLE, describeRequest, requestWordOf } from "@foldedspacelabs/metistry-core";
import { withRequestShape } from "../src/server.js";
import { answersOf, cardHtml, LATER, requestHeading, requestWord, rowHtml } from "../web/needs-you.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const APP = read("../web/app.js");
const NEEDS_YOU = read("../web/needs-you.js");
const HTML = read("../web/index.html");

/** A row as GET /api/proposals serves it — the stored columns, then the server's own `withRequestShape`. */
let nextId = 1;
const served = (kind: string, payload: Record<string, unknown> = {}) =>
  withRequestShape({ id: nextId++, ts: "2026-09-26T08:00:00.000Z", kind, source_agent: "assistant", trust: "internal", payload, decision: "pending" });

/** The word a drawn card or list row shows as its type: the table's word, in Title Case. */
const typeWord = (html: string) => /<span class="(?:card|req)-type">([^<]*)<\/span>/.exec(html)?.[1];
/** What the owner reads: the text and the accessible names, not the machine attributes. */
const readText = (html: string) => html.replace(/<[^>]*aria-label="([^"]*)"[^>]*>/g, " $1 ").replace(/<[^>]*>/g, " ");

describe("every kind renders the table's word (F-5, §2.12)", () => {
  for (const kind of REQUEST_KINDS) {
    it(`${kind} reads as “${requestWordOf(kind)}”`, () => {
      const row = served(kind);
      expect(row.request).toEqual(describeRequest(kind, {}));
      expect(typeWord(cardHtml(row)), kind).toBe(requestHeading(requestWordOf(kind)));
      expect(typeWord(rowHtml(row)), kind).toBe(requestHeading(requestWordOf(kind)));
    });
  }

  it("a kind the table does not know reads as a report — never as its stored kind", () => {
    const row = served("sync_conflict");
    for (const html of [cardHtml(row), rowHtml(row, { selecting: true })]) {
      expect(typeWord(html)).toBe(requestHeading(REQUEST_TYPE_TABLE.report.word));
      expect(readText(html)).not.toContain("sync_conflict");
    }
    expect(readText(rowHtml(row, { selecting: true }))).toMatch(/Select Report/);
  });

  it("the word comes off the served row, not off the kind: the view has no mapping to consult", () => {
    // a row whose served reading disagrees with its kind is drawn as served —
    // proof the PWA reads `request`, rather than keeping a map that happens to agree
    const row = { ...served("knowledge"), request: { ...describeRequest("knowledge"), word: "served word" } };
    expect(typeWord(cardHtml(row))).toBe("Served Word");
    expect(requestWord({ kind: "knowledge" })).toBe("");
  });

  it("no module of the PWA holds a copy of the kind → word mapping", () => {
    for (const [name, src] of [["app.js", APP], ["needs-you.js", NEEDS_YOU]] as const) {
      for (const kind of REQUEST_KINDS.filter((k) => k !== requestWordOf(k))) {
        expect(src, `${name} names the stored kind ${kind}`).not.toMatch(new RegExp(`\\b${kind}\\s*:\\s*"`));
      }
      expect(src).not.toMatch(/\bREQUEST_TYPE\b|\bTYPE_LABEL\b|\brequestType\(/);
    }
  });

  it("group headings are the table's words in Title Case (P10)", () => {
    const headings = REQUEST_TYPES.map((t) => requestHeading(REQUEST_TYPE_TABLE[t].word));
    expect(headings).toContain("Pull Request");
    expect(headings).toContain("Question");
    for (const h of headings) expect(h, h).toMatch(/^[A-Z][a-z]*(?: [A-Z][a-z]*)*$/);
  });

  it("escapes the served word like every other field (CRIT-7)", () => {
    const row = { ...served("knowledge"), request: { ...describeRequest("knowledge"), word: "<img src=x>" } };
    for (const html of [cardHtml(row), rowHtml(row)]) {
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;Img Src=X&gt;");
    }
  });
});

describe("no row offers Skip — Skip is bulk-only (K2)", () => {
  const payloads: Record<string, Record<string, unknown>> = {
    decision: { options: ["ship", "hold"] },
    access_request: { area: "Areas/Health", current_tier: "index" },
    action: { action: { kind: "vault.move", args: { from: "a", to: "b" } }, reason: "tidy" },
    knowledge: { suggested_work: { title: "write it up" } },
    report: { suggested_work: { title: "look into it" } },
  };

  for (const kind of [...REQUEST_KINDS, "sync_conflict"]) {
    it(`${kind}: Later is the one verb beside the answers, and there is no Skip`, () => {
      const row = served(kind, payloads[kind] ?? {});
      const html = cardHtml(row);
      expect(html).not.toMatch(/>\s*Skip\s*</);
      expect(html).toMatch(/data-d="later"[^>]*>Later</);
      // the only single-row `skip` wire is a type's own Decline that the table says stores it —
      // a report's Dismiss, a message's Not Mine — and it is never called Skip
      const decline = answersOf(row).decline;
      if (/data-d="skip"/.test(html)) expect(decline).toMatchObject({ sends: { decision: "skip" } });
      if (decline?.sends && "decision" in decline.sends && decline.sends.decision === "skip") expect(decline.label).not.toBe("Skip");
    });
  }

  it("the per-row defer is Later alone", () => {
    expect(LATER).toEqual({ d: "later", label: "Later" });
  });

  it("Skip stays on the selection bar and its shortcut", () => {
    expect(HTML).toMatch(/id="triage-skip"[^>]*>Skip</);
    expect(NEEDS_YOU).toContain(`$("triage-skip").onclick = () => batchDecide("skip");`);
    expect(NEEDS_YOU).toMatch(/e\.key === "s"\) \{ e\.preventDefault\(\); batchDecide\("skip"\);/);
  });
});
