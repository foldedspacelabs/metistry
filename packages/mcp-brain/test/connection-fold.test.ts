// The fold is a pure function of the text (X-132; connection-fold.ts): the
// same answer folds to the same bytes twice, each shape fits what it is for,
// the output never exceeds the threshold by more than its marker, and the
// pages the whole answer is cut into reassemble it byte for byte.

import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECTION_FOLD, answerText, byteLength, collapseRepeatedLines, foldText, headAndTail, pagesOf, parsePageRef, wireBytes, type ConnectionFold } from "../src/connection-fold.js";

const cfg: ConnectionFold = { ...DEFAULT_CONNECTION_FOLD, thresholdBytes: 400, arrayOver: 5, arrayKeep: 2 };

const issues = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, state: i % 2 ? "open" : "closed" }));

describe("foldText — three shapes, applied once, deterministically", () => {
  it("one answer folds identically twice (the ticket's bold test)", () => {
    const text = JSON.stringify(issues(40));
    const a = foldText(text, cfg);
    const b = foldText(text, cfg);
    expect(a).toEqual(b);
    const log = Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? `step ${i}` : "warning: retrying")).join("\n");
    expect(foldText(log, cfg)).toEqual(foldText(log, cfg));
  });

  it("a JSON array over N items becomes its first k, its last and the count", () => {
    const folded = foldText(JSON.stringify(issues(40)), cfg);
    expect(folded.how).toEqual(["array"]);
    expect(JSON.parse(folded.text)).toEqual({ folded: "array", count: 40, first: issues(40).slice(0, 2), last: { number: 40, title: "issue 40", state: "open" } });
    // at or under N the array is not an array fold — the cap decides alone
    const small = foldText(JSON.stringify(issues(5)), { ...cfg, thresholdBytes: 10_000 });
    expect(small.how).toEqual([]);
    expect(small.text).toBe(JSON.stringify(issues(5)));
  });

  it("repeated lines become counts, blank runs say so, and a pair stays a pair", () => {
    const text = ["start", "retrying", "retrying", "retrying", "", "", "", "", "a", "a", "done"].join("\n");
    expect(collapseRepeatedLines(text)).toBe(["start", "retrying  [×3]", "[×4 blank lines]", "a", "a", "done"].join("\n"));
    const folded = foldText(text, { ...cfg, thresholdBytes: 10_000 });
    expect(folded.how).toEqual(["lines"]);
  });

  it("anything else gets a head and a tail within the threshold, the bytes between them named", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} of some prose that does not repeat`).join("\n");
    const folded = foldText(text, cfg);
    expect(folded.how).toEqual(["cap"]);
    expect(folded.text.startsWith("line 0 of some prose")).toBe(true);
    expect(folded.text.endsWith("line 199 of some prose that does not repeat")).toBe(true);
    expect(folded.text).toMatch(/\n…\[\d+ bytes folded — the whole answer is on its pages\]…\n/);
    const marker = /\n…\[\d+ bytes folded — the whole answer is on its pages\]…\n/.exec(folded.text)![0];
    expect(byteLength(folded.text) - byteLength(marker)).toBeLessThanOrEqual(cfg.thresholdBytes);
    // an array fold that is still too long is capped on top
    const wide = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ i, body: "x".repeat(300) })));
    expect(foldText(wide, cfg).how).toEqual(["array", "cap"]);
  });

  it("cuts at code points, never through a character", () => {
    const text = "é".repeat(500) + "😀".repeat(100);
    const folded = foldText(text, cfg);
    expect(folded.text).not.toContain("�");
    expect(Buffer.from(folded.text, "utf8").toString("utf8")).toBe(folded.text);
    expect(headAndTail("短い", 100)).toBe("短い");
  });
});

describe("pagesOf — the whole answer, every byte on exactly one page", () => {
  it("reassembles the text, each page within the page size, cut at code points", () => {
    const text = JSON.stringify(issues(300)) + "😀".repeat(50) + "é".repeat(999);
    const pages = pagesOf(text, 1000);
    expect(pages.join("")).toBe(text);
    for (const p of pages) {
      expect(byteLength(p)).toBeLessThanOrEqual(1000);
      expect(p).not.toContain("�");
    }
    expect(pages.length).toBe(Math.ceil(byteLength(text) / 1000) + (pages.length - Math.ceil(byteLength(text) / 1000))); // one more at most for code-point slack
    expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(byteLength(text) / 1000));
    expect(pagesOf("", 10)).toEqual([""]);
    expect(pagesOf(text, 1000)).toEqual(pages); // the same cut every time
  });
});

describe("answerText and wireBytes — the one text a fold and its pages are over", () => {
  it("joins text blocks; falls back to structured content, then to the blocks as JSON", () => {
    expect(answerText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(answerText({ content: [], structuredContent: { rows: [1, 2] } })).toBe('{"rows":[1,2]}');
    expect(answerText({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).toBe('[{"type":"image","data":"AAAA","mimeType":"image/png"}]');
    expect(wireBytes({ content: [{ type: "text", text: "é" }] })).toBe(byteLength('{"content":[{"type":"text","text":"é"}]}'));
  });
});

describe("parsePageRef", () => {
  it("takes `<handle>/<n>` and nothing else", () => {
    expect(parsePageRef("4821/2")).toEqual({ handle: 4821, page: 2 });
    for (const bad of ["4821", "/2", "a/2", "4821/", "4821/2/3", " 4821/2", "4821/-1", "1".repeat(16) + "/1"]) expect(parsePageRef(bad)).toBeUndefined();
  });
});
