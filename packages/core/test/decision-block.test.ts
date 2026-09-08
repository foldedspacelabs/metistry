// The question-answer convention (§4.21). A reply that ends with a fenced
// `decision` block becomes a queue item; anything else is just a reply. The
// parser is deliberately strict — it decides what a model can put in front of
// the user — so the malformed cases matter as much as the happy one.
import { describe, expect, it } from "vitest";
import { parseDecisionBlock } from "../src/decision-block.js";

const block = (body: string) => "here is what I found.\n\n```decision\n" + body + "\n```";

describe("parseDecisionBlock", () => {
  it("parses a trailing block into a title and its options", () => {
    expect(parseDecisionBlock(block("title: Which repo?\noptions:\n- metistry\n- metistry-instance"))).toEqual({
      title: "Which repo?",
      options: ["metistry", "metistry-instance"],
    });
  });

  it("tolerates blank lines, quotes, trailing whitespace and CRLF", () => {
    expect(parseDecisionBlock("ask\r\n\r\n```decision\r\ntitle: \"Ship it?\"\r\n\r\noptions:\r\n-  yes\r\n- 'not yet'\r\n```\r\n  ")).toEqual({
      title: "Ship it?",
      options: ["yes", "not yet"],
    });
  });

  it("is absent from an ordinary reply", () => {
    expect(parseDecisionBlock("no question here")).toBeNull();
    expect(parseDecisionBlock("```js\nconst a = 1;\n```")).toBeNull();
    expect(parseDecisionBlock("")).toBeNull();
    expect(parseDecisionBlock(undefined)).toBeNull();
  });

  it("ignores a block that is not the last thing in the reply", () => {
    expect(parseDecisionBlock(block("title: t\noptions:\n- a\n- b") + "\n\nanything after")).toBeNull();
  });

  it("ignores malformed blocks rather than half-reading them", () => {
    const bad = [
      "options:\n- a\n- b", // no title
      "title: t", // no options
      "title: t\noptions:\n- only-one", // one option is not a choice
      "title: t\noptions:\n- a\n- a", // duplicates would be ambiguous answers
      "title: t\noptions:\n- a\n-", // empty option
      "title: t\ntitle: u\noptions:\n- a\n- b", // two titles
      "title: t\noptions:\n- a\n- b\nnote: something else", // unknown line
      `title: ${"x".repeat(201)}\noptions:\n- a\n- b`, // title too long
      `title: t\noptions:\n- ${"x".repeat(81)}\n- b`, // option too long
      `title: t\noptions:\n${Array.from({ length: 9 }, (_, i) => `- o${i}`).join("\n")}`, // too many
    ];
    for (const body of bad) expect(parseDecisionBlock(block(body)), body).toBeNull();
  });
});
