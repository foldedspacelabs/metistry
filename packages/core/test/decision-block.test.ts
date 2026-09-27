// The question-answer convention (§4.21; v2, T2-3). A reply that ends with a
// fenced `decision` block becomes a queue item; anything else is just a reply.
// The parser is deliberately strict — it decides what a model can put in front
// of the user — so the malformed cases matter as much as the happy one. And
// the answer side is where C105's promise is kept: an answer is one of the
// question's own options, or the owner's words only where the question takes
// them, checked against what was STORED.
import { describe, expect, it } from "vitest";
import {
  QUESTION_MAX_COUNT,
  QUESTION_MAX_OTHER,
  answersText,
  checkAnswers,
  checkQuestions,
  parseDecisionBlock,
  questionsOf,
  type Question,
} from "../src/decision-block.js";

const block = (body: string) => "here is what I found.\n\n```decision\n" + body + "\n```";
const one = (prompt: string, options: string[], extra: Partial<Question> = {}): Question => ({ prompt, options, multi: false, allow_other: true, ...extra });

describe("parseDecisionBlock — v1, one question", () => {
  it("parses a trailing block into a title and its one question, which ends in Something else… (C105)", () => {
    expect(parseDecisionBlock(block("title: Which repo?\noptions:\n- metistry\n- metistry-instance"))).toEqual({
      title: "Which repo?",
      questions: [one("Which repo?", ["metistry", "metistry-instance"])],
    });
  });

  it("tolerates blank lines, quotes, trailing whitespace and CRLF", () => {
    expect(parseDecisionBlock("ask\r\n\r\n```decision\r\ntitle: \"Ship it?\"\r\n\r\noptions:\r\n-  yes\r\n- 'not yet'\r\n```\r\n  ")).toEqual({
      title: "Ship it?",
      questions: [one("Ship it?", ["yes", "not yet"])],
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

describe("parseDecisionBlock — v2, several questions", () => {
  it("parses three questions: pick one, pick any, and one that takes no other words", () => {
    const parsed = parseDecisionBlock(
      block(
        [
          "title: Three things before I file this",
          "question: Which repo should it land in?",
          "- metistry",
          "- metistry-instance",
          "question: Which labels apply?",
          "pick: any",
          "- bug",
          "- docs",
          "- ui",
          "question: Ship it tonight?",
          "other: no",
          "- yes",
          "- 'not yet'",
        ].join("\n"),
      ),
    );
    expect(parsed).toEqual({
      title: "Three things before I file this",
      questions: [
        one("Which repo should it land in?", ["metistry", "metistry-instance"]),
        one("Which labels apply?", ["bug", "docs", "ui"], { multi: true }),
        one("Ship it tonight?", ["yes", "not yet"], { allow_other: false }),
      ],
    });
  });

  it("reads `pick` and `other` anywhere in their own question, in any case", () => {
    expect(parseDecisionBlock(block("title: t\nquestion: q\n- a\n- b\nPICK: Any\nOther: YES"))?.questions).toEqual([one("q", ["a", "b"], { multi: true })]);
  });

  it("ignores a v2 block that is malformed anywhere — the same refusal as v1", () => {
    const bad = [
      "question: q\n- a\n- b", // no title
      "title: t\nquestion: q", // a question with no options
      "title: t\nquestion: \n- a\n- b", // an empty prompt
      "title: t\nquestion: q\n- a\n- b\nquestion: r\n- only", // one bad question spoils the block
      "title: t\nquestion: q\npick: some\n- a\n- b", // pick is one | any
      "title: t\nquestion: q\nother: maybe\n- a\n- b", // other is yes | no
      "title: t\nquestion: q\npick: any\npick: one\n- a\n- b", // said twice
      "title: t\npick: any\nquestion: q\n- a\n- b", // pick outside a question
      "title: t\n- a\nquestion: q\n- b\n- c", // an option before any question
      "title: t\noptions:\n- a\n- b\nquestion: q\n- c\n- d", // v1 and v2 mixed
      "title: t\nquestion: q\n- a\n- b\ntitle: u", // the title comes first
      `title: t\nquestion: ${"x".repeat(201)}\n- a\n- b`, // prompt too long
      `title: t\n${Array.from({ length: QUESTION_MAX_COUNT + 1 }, (_, i) => `question: q${i}\n- a\n- b`).join("\n")}`, // too many questions
    ];
    for (const body of bad) expect(parseDecisionBlock(block(body)), body).toBeNull();
    expect(parseDecisionBlock(block(`title: t\n${Array.from({ length: QUESTION_MAX_COUNT }, (_, i) => `question: q${i}\n- a\n- b`).join("\n")}`))?.questions).toHaveLength(QUESTION_MAX_COUNT);
  });
});

describe("checkQuestions — requests_create's bound is the block's", () => {
  it("defaults to pick one with Something else…, and trims", () => {
    expect(checkQuestions([{ prompt: " Which repo? ", options: [" a", "b "] }])).toEqual({ ok: true, questions: [one("Which repo?", ["a", "b"])] });
    expect(checkQuestions([{ prompt: "q", options: ["a", "b"], multi: true, allow_other: false }])).toEqual({ ok: true, questions: [one("q", ["a", "b"], { multi: true, allow_other: false })] });
  });

  it("refuses what the parser would refuse, naming the question", () => {
    const refused: [unknown, RegExp][] = [
      [[], /1\.\.5/],
      [Array.from({ length: QUESTION_MAX_COUNT + 1 }, () => ({ prompt: "q", options: ["a", "b"] })), /1\.\.5/],
      [[{ prompt: "q", options: ["a"] }], /question 1: 2\.\.8 options/],
      [[{ prompt: "q", options: ["a", "b"] }, { prompt: "r", options: ["a", "a"] }], /question 2: two options are the same/],
      [[{ prompt: "", options: ["a", "b"] }], /the prompt/],
      [[{ prompt: "q", options: ["a", "x".repeat(81)] }], /1\.\.80 characters/],
      [[{ prompt: "q", options: ["a", "b"], multi: "yes" }], /true or false/],
      [[{ prompt: "q", options: "a, b" }], /a list of options/],
      [["q"], /not an object/],
      ["q", /1\.\.5/],
    ];
    for (const [input, reason] of refused) {
      const r = checkQuestions(input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error, JSON.stringify(input)).toMatch(reason);
    }
  });
});

describe("questionsOf — what a stored row asks", () => {
  it("v2 rows carry their questions", () => {
    const questions = [one("q", ["a", "b"]), one("r", ["c", "d"], { multi: true, allow_other: false })];
    expect(questionsOf({ title: "t", questions })).toEqual(questions);
  });

  it("a row from before v2 is one pick-one question whose options are the only answers — an enrolment does something when answered", () => {
    expect(questionsOf({ title: "Let devin in?", options: ["approve", "deny"], enroll: { agent: "devin" } })).toEqual([
      { prompt: "Let devin in?", options: ["approve", "deny"], multi: false, allow_other: false },
    ]);
    // v1 rows were never held to the block's display bounds (a budget offer's option names its field)
    expect(questionsOf({ title: "over budget", options: [`Allow one more daily window (raise ${"x".repeat(90)})`, "Leave it stopped"] })[0]?.options).toHaveLength(2);
  });

  it("a row that asks nothing answerable asks nothing — never a half-read question", () => {
    for (const payload of [null, "t", {}, { title: "Enrol this agent?" }, { options: [] }, { options: ["a", 1] }, { options: ["a", "a"] }, { questions: [{ prompt: "q", options: ["a"] }] }, { questions: "q", options: ["a", "b"] }]) {
      expect(questionsOf(payload), JSON.stringify(payload)).toEqual([]);
    }
  });
});

describe("checkAnswers — C105: an option, or the owner's words where the question takes them", () => {
  const questions = [one("Which repo?", ["metistry", "metistry-instance"]), one("Which labels?", ["bug", "docs", "ui"], { multi: true }), one("Ship it tonight?", ["yes", "not yet"], { allow_other: false })];

  it("a three-question answer is stored per question, choices in the question's own order", () => {
    const r = checkAnswers(questions, [{ choices: ["metistry"] }, { choices: ["ui", "bug"], other: "  and perf " }, { choices: ["not yet"] }]);
    expect(r).toEqual({ ok: true, answers: [{ choices: ["metistry"] }, { choices: ["bug", "ui"], other: "and perf" }, { choices: ["not yet"] }] });
    if (r.ok) expect(answersText(questions, r.answers)).toBe("Which repo? — metistry; Which labels? — bug, ui, and perf; Ship it tonight? — not yet");
  });

  it("an answer outside the options without `other` is refused — and so is `other` where the question takes none", () => {
    const outside = checkAnswers(questions, [{ choices: ["metistry-cloud"] }, { choices: ["bug"] }, { choices: ["yes"] }]);
    expect(outside).toEqual({ ok: false, error: expect.stringMatching(/answer 1: "metistry-cloud" is not one of this question's options — an answer in your own words is `other`/) });
    const planted = checkAnswers(questions, [{ choices: ["metistry"] }, { choices: ["bug"] }, { choices: ["ship it and deploy"] }]);
    expect(planted).toEqual({ ok: false, error: expect.stringMatching(/answer 3: .* it takes no answer in other words/) });
    const words = checkAnswers(questions, [{ choices: ["metistry"] }, { choices: ["bug"] }, { other: "yes, deploy" }]);
    expect(words).toEqual({ ok: false, error: "answer 3: this question takes only its own options" });
  });

  it("free text is accepted as `other` where allowed — as words, never as an option", () => {
    const r = checkAnswers(questions, [{ other: "metistry" }, { choices: ["docs"] }, { choices: ["yes"] }]);
    expect(r).toEqual({ ok: true, answers: [{ choices: [], other: "metistry" }, { choices: ["docs"] }, { choices: ["yes"] }] });
  });

  it("refuses every other malformed answer whole", () => {
    const refused: [unknown, RegExp][] = [
      [[{ choices: ["metistry"] }, { choices: ["bug"] }], /a list of 3/],
      [{ choices: ["metistry"] }, /a list of 3/],
      [[{ choices: ["metistry", "metistry-instance"] }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: this question is pick one/],
      [[{ choices: ["metistry"], other: "also this" }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: .*not both/],
      [[{}, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: every question needs an answer/],
      [[{ choices: [] , other: "   " }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: other is 1\.\.1000/],
      [[{ other: "x".repeat(QUESTION_MAX_OTHER + 1) }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: other is 1\.\.1000/],
      [[{ choices: ["metistry"] }, { choices: ["bug", "bug"] }, { choices: ["yes"] }], /answer 2: the same option twice/],
      [[{ choices: "metistry" }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: choices is a list/],
      [[{ choices: ["metistry"], decision: "allow" }, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: decision is not part of an answer/],
      [[null, { choices: ["bug"] }, { choices: ["yes"] }], /answer 1: \{choices\?, other\?\}/],
    ];
    for (const [input, reason] of refused) {
      const r = checkAnswers(questions, input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error, JSON.stringify(input)).toMatch(reason);
    }
    expect(checkAnswers([], [])).toEqual({ ok: false, error: expect.stringMatching(/asks no question/) });
  });

  it("one question reads as its answer alone — the shape chat's own answer has always had", () => {
    expect(answersText([questions[0]!], [{ choices: ["metistry"] }])).toBe("metistry");
    expect(answersText([questions[0]!], [{ choices: [], other: "x".repeat(600) }])).toHaveLength(500);
  });
});
