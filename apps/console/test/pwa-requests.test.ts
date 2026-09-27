// X-5 — the PWA reads F-5's request type table (design-build-plan §2.12)
// instead of holding its own copy, and Skip is bulk-only (K2).
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
    "DECISIONS",
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
    "proposalRow",
  ]
    .map(lift)
    .join("\n")}\nreturn { requestWord, requestHeading, DEFER, proposalRow };`,
)(esc) as {
  requestWord: (p: unknown) => string;
  requestHeading: (word: string) => string;
  DEFER: { d: string; label: string }[];
  proposalRow: (p: unknown) => string;
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
      const html = pwa.proposalRow(served(kind, payloads[kind] ?? {}));
      expect(html).not.toMatch(/data-d="skip"/);
      expect(html).not.toMatch(/>\s*Skip\s*</);
      expect(html).toMatch(/data-d="later"[^>]*>Later</);
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
