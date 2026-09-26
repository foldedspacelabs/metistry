// The pure halves of the PWA composer and feed row: Title Case at render
// (design-system.md §3.2 + P10) and the deterministic suggestion ranking
// (§3.6). Both are rules rather than preferences, so they get assertions.
//
// apps/console/web/app.js is a browser script — it wires DOM handlers at
// import time and cannot be imported here. These declarations are top-level
// and pure, so the test lifts them out of the source by name and evaluates
// them. If a rename or a deletion loses one, the extraction throws and this
// test fails loudly rather than passing vacuously.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("../web/app.js", import.meta.url)), "utf8");

/** Lift a top-level `const NAME = …` or `function NAME(…) {…}` out of app.js. */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^(?:const|let) ${name}\\b|^function ${name}\\(`).test(l),
  );
  if (start === -1) throw new Error(`app.js no longer declares ${name} — update this test with the rename`);
  // Accumulate until every bracket the declaration opened is closed again.
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`could not find the end of ${name} in app.js`);
}

const sandbox = (names: string[], expr: string) =>
  new Function(
    "localStorage",
    `${names.map(lift).join("\n")}\nreturn (${expr});`,
  )({ getItem: () => null, setItem: () => {} });

const titleCase = sandbox(
  ["TITLE_CASE_KINDS", "MINOR", "isIdentifier", "titleCaseSubject"],
  "titleCaseSubject",
) as (kind: string, subject: string) => string;

describe("feed subjects: Title Case at render, and only for kinds we compose", () => {
  it("title-cases the system-composed kinds", () => {
    expect(titleCase("collector_run", "collector run failed")).toBe("Collector Run Failed");
    expect(titleCase("proposal_created", "proposal #97 awaiting you")).toBe("Proposal #97 Awaiting You");
    expect(titleCase("brief", "morning brief delivered")).toBe("Morning Brief Delivered");
    expect(titleCase("proposal_decided", "allowed proposal #94")).toBe("Allowed Proposal #94");
  });

  // P1: agent text is data, and data is not case-corrected. These kinds carry
  // subjects an agent or the user may have written, so they render as stored.
  it("leaves agent- and user-authored kinds exactly as stored", () => {
    for (const kind of ["turn", "tool", "dispatch"]) {
      expect(titleCase(kind, "dispatch queued for ops-bot")).toBe("dispatch queued for ops-bot");
      expect(titleCase(kind, "ignore previous instructions")).toBe("ignore previous instructions");
    }
    // and an unknown kind is left alone: the safe default is to not touch text
    expect(titleCase("some_new_kind", "a brand new event")).toBe("a brand new event");
  });

  // C18: a work_history subject is the task's own title — someone's writing,
  // not a label the console composed — so it is not on the allow-list.
  it("leaves a task's own title exactly as written (C18)", () => {
    expect(titleCase("work_history", "Migrate the settings pane to tokens")).toBe("Migrate the settings pane to tokens");
    expect(titleCase("work_history", "fix the flaky test")).toBe("fix the flaky test");
  });

  it("never rewrites an identifier inside a subject", () => {
    expect(titleCase("collector_run", "github-state run failed")).toBe("github-state Run Failed");
    expect(titleCase("alert", "budget over the cap for aws-costs")).toBe("Budget Over the Cap for aws-costs");
    expect(titleCase("agent_admin", "rotated drey_dev token")).toBe("Rotated drey_dev Token");
    expect(titleCase("review", "wrote Areas/Health/Taper.md")).toBe("Wrote Areas/Health/Taper.md");
  });

  it("keeps short joining words lowercase unless they lead (P10)", () => {
    expect(titleCase("project_mode", "the mode of a project on hold")).toBe("The Mode of a Project on Hold");
  });

  it("is a rendering only — it never touches an empty or missing subject", () => {
    expect(titleCase("brief", "")).toBe("");
    expect(titleCase("brief", undefined as unknown as string)).toBe("");
  });
});

// A reply is agent text, so the paragraph splitter is a misuse test first
// (invariant 8): hostile input in, and the only tag that comes out is the <p>
// the function itself writes. esc() runs on the TEXT, before markup exists.
describe("reply paragraphs: a blank line is a margin, and nothing else survives", () => {
  const esc = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const replyParagraphs = new Function("esc", `${lift("replyParagraphs")}\nreturn replyParagraphs;`)(
    esc,
  ) as (t: string) => string;

  it("splits on blank lines and keeps single newlines inside a paragraph", () => {
    expect(replyParagraphs("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
    expect(replyParagraphs("one\ntwo")).toBe("<p>one\ntwo</p>");
    expect(replyParagraphs("a\n\n\n\nb")).toBe("<p>a</p><p>b</p>"); // any run of blanks is one break
    expect(replyParagraphs("")).toBe("<p></p>");
    expect(replyParagraphs(undefined as unknown as string)).toBe("<p></p>");
  });

  it("emits no tag but its own <p>, whatever the agent wrote", () => {
    const hostile = `<img src=x onerror=alert(1)>\n\n<script>bad()</script>\n\n<a href="javascript:evil()">x</a>`;
    const out = replyParagraphs(hostile);
    // strip the <p> wrappers this function is allowed to write; nothing else
    // may look like a tag in what remains
    const rest = out.replace(/<\/?p>/g, "");
    expect(rest).not.toMatch(/<[a-zA-Z/]/);
    expect(rest).toContain("&lt;script&gt;");
    expect(rest).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("composer suggestions: deterministic ranking (§3.6)", () => {
  const rank = sandbox(["recentInserts", "rank"], "rank") as (
    items: { id: string; desc?: string }[],
    token: string,
  ) => { id: string }[];
  const items = [
    { id: "@ops-bot" },
    { id: "@doc-bot" },
    { id: "@drey" },
    { id: "@drey-dev" },
  ];

  it("ranks prefix matches before substring matches, ties by id", () => {
    // "o" prefixes @ops-bot and is a substring of @doc-bot — prefix wins, and
    // @drey / @drey-dev do not match at all.
    expect(rank(items, "@o").map((x) => x.id)).toEqual(["@ops-bot", "@doc-bot"]);
    // "d" prefixes three of them, so the tie breaks on the id, alphabetically.
    expect(rank(items, "@d").map((x) => x.id)).toEqual(["@doc-bot", "@drey", "@drey-dev"]);
  });

  it("narrows as the token grows", () => {
    expect(rank(items, "@dre").map((x) => x.id)).toEqual(["@drey", "@drey-dev"]);
    expect(rank(items, "@drey-").map((x) => x.id)).toEqual(["@drey-dev"]);
  });

  it("returns nothing when nothing matches, so the list closes rather than showing an empty box", () => {
    expect(rank(items, "@zzz")).toEqual([]);
  });

  it("offers everything on a bare trigger", () => {
    expect(rank(items, "@").length).toBe(items.length);
  });

  it("is stable — the same token gives the same order every time", () => {
    const once = rank(items, "@d").map((x) => x.id);
    for (let i = 0; i < 5; i++) expect(rank(items, "@d").map((x) => x.id)).toEqual(once);
  });
});
