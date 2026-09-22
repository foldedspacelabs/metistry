// The intent enum, the prompt, the guard, and the thresholds that fail at
// load (PoC-20 phase 1).
import { describe, expect, it } from "vitest";
import {
  CHOICE_MAX_OPTIONS,
  choicePlan,
  codesFor,
  type ChoiceOption,
} from "../src/choice.js";
import {
  DEFAULT_INTENT_PHRASING,
  INTENTS,
  INTENT_CODES,
  INTENT_GROUPS,
  INTENT_MAX_CHARS,
  INTENT_NAMES,
  INTENT_OPTIONS,
  INTENT_PHRASINGS,
  INTENT_UNSURE,
  intentGuard,
  intentMessages,
  intentRulesSchema,
  intentStage,
  intentThreshold,
  isIntent,
  messageFacts,
} from "../src/intent.js";

describe("the enum", () => {
  it("fits one scored call and one letter per member", () => {
    expect(INTENTS.length).toBeLessThanOrEqual(CHOICE_MAX_OPTIONS);
    expect(new Set(INTENT_NAMES).size).toBe(INTENTS.length);
  });

  it("carries a DESCRIPTION for every member — never a bare name (Laya lesson 1)", () => {
    for (const i of INTENTS) {
      expect(i.description.length).toBeGreaterThan(12);
      // A description says what the text IS, never what to do about it.
      expect(i.description.startsWith("it ")).toBe(true);
    }
  });

  it("has a `no match` member, because none-of-these has to be sayable (Nimble's README)", () => {
    expect(isIntent(INTENT_UNSURE)).toBe(true);
    expect(INTENT_NAMES.at(-1)).toBe(INTENT_UNSURE);
  });

  it("names no tier, no model and no destination — §3.2 P1, checked as a property", () => {
    const forbidden = /\b(tier|model|effort|escalate|route|router|haiku|opus|sonnet|deep|fast|default|cheap|expensive|routine)\b/i;
    for (const name of INTENT_NAMES) expect(name).not.toMatch(forbidden);
  });
});

describe("the letter codes are GENERATED", () => {
  it("is exactly codesFor() over the list, in order", () => {
    const expected = Object.fromEntries(codesFor(INTENTS.length).map((c, i) => [INTENTS[i]!.name, c]));
    expect(INTENT_CODES).toEqual(expected);
  });

  it("shifts every code after an insertion — the property a hand-maintained table cannot keep", () => {
    const before = codesFor(3);
    const after = codesFor(4);
    expect(before).toEqual(["A", "B", "C"]);
    // Insert at position 1: what was B is now C. A table would still say B.
    const list: ChoiceOption[] = [{ key: "x", description: "d" }, { key: "NEW", description: "d" }, { key: "y", description: "d" }, { key: "z", description: "d" }];
    const codes = codesFor(list.length);
    expect(after).toEqual(codes);
    expect(codes[list.findIndex((o) => o.key === "y")]).toBe("C");
  });
});

describe("the groups cover the enum, so the cascade could name everything", () => {
  it("every intent belongs to exactly one group", () => {
    const members = INTENT_GROUPS.flatMap((g) => g.members);
    expect([...members].sort()).toEqual([...INTENT_NAMES].sort());
    expect(new Set(members).size).toBe(members.length);
  });

  it("the shipped stage is a single members call today", () => {
    const stage = intentStage();
    expect(stage.kind).toBe("members");
    expect(stage.options).toHaveLength(INTENTS.length);
    // …and would cascade cleanly if the enum grew past the ceiling.
    const padded = [...INTENT_OPTIONS, ...Array.from({ length: CHOICE_MAX_OPTIONS }, (_, i) => ({ key: `extra_${i}`, description: "d" }))];
    const groups = [...INTENT_GROUPS, { key: "extras", description: "d", members: padded.slice(INTENTS.length).map((o) => o.key) }];
    expect(choicePlan(padded, groups).kind).toBe("groups");
  });
});

describe("the deterministic guard, ahead of the model (research §2.3.1.3)", () => {
  it("passes ordinary text", () => {
    expect(intentGuard("remind me to call the dentist tomorrow").ok).toBe(true);
    expect(intentGuard("hey").ok).toBe(true); // three letters is a message, not out-of-distribution
  });

  it("refuses nothing-to-read, without a call", () => {
    expect(intentGuard("")).toMatchObject({ ok: false, intent: INTENT_UNSURE });
    expect(intentGuard("   ")).toMatchObject({ ok: false });
    expect(intentGuard(null)).toMatchObject({ ok: false });
    expect(intentGuard(42 as never)).toMatchObject({ ok: false });
  });

  it("refuses a mime that is not text", () => {
    const r = intentGuard("a screenshot", { mime: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not text/);
    expect(intentGuard("# hi", { mime: "text/markdown" }).ok).toBe(true);
  });

  it("refuses a document", () => {
    const r = intentGuard("x".repeat(INTENT_MAX_CHARS + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/);
  });

  it("refuses a script the English option list cannot describe, and cites the number", () => {
    const r = intentGuard("សូមរំលឹកខ្ញុំឱ្យទូរស័ព្ទទៅទន្តបណ្ឌិតនៅថ្ងៃស្អែក");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/out of script/);
      expect(r.reason).toMatch(/0\.000 accuracy at 0\.952 confidence/);
    }
  });

  it("does not refuse a short emoji-and-word message, where the statistic has no power", () => {
    expect(intentGuard("ship it 🚀").ok).toBe(true);
  });

  it("refuses a message with no letters at all", () => {
    const r = intentGuard("🚀🚀🚀");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no letters/);
  });
});

describe("the facts are resolved IN CODE and handed over as words (Laya lesson 3)", () => {
  const now = new Date("2026-09-22T12:00:00Z");

  it("states today rather than asking the model to work it out", () => {
    expect(messageFacts("anything", now)[0]).toBe("Today is Tuesday, 22 September 2026.");
  });

  it("decides the date/link/line questions itself", () => {
    expect(messageFacts("call the dentist tomorrow", now)).toContain("The message names a day or a time.");
    expect(messageFacts("gemma is fast", now)).toContain("The message names no day and no time.");
    expect(messageFacts("https://example.com/x", now)).toContain("The message carries a link.");
    expect(messageFacts("a\nb", now)).toContain("The message runs to more than one line.");
    expect(messageFacts("meet at 14:30", now)).toContain("The message names a day or a time.");
  });

  it("never puts a number in front of the model", () => {
    for (const fact of messageFacts("a\nb https://x.test at 9am on Friday", now).slice(1)) {
      expect(fact).not.toMatch(/\d/);
    }
  });
});

describe("the prompt asks what the message SAYS", () => {
  const system = () => intentMessages("buy milk", { now: new Date("2026-09-22T12:00:00Z") })[0]!.content;

  it("puts a letter against a description, and asks for one letter back", () => {
    const s = system();
    expect(s).toContain(`A = ${INTENTS[0]!.description}`);
    expect(s).toContain("Answer with one letter and nothing else.");
    expect(s).toContain("Which line below describes what the message says?");
  });

  it("never asks what to DO about it — the prescriptive form Laya measured as inverted", () => {
    const s = system();
    expect(s).not.toMatch(/what should|should you|which (tier|model)|route|escalate|what to do/i);
  });

  it("sends the message itself as the user turn, clipped", () => {
    const msgs = intentMessages("x".repeat(5000), { maxChars: 10 });
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toHaveLength(10);
  });

  it("has a bare-names control, so descriptions-vs-names can be measured (§5.2 phase 1)", () => {
    expect(INTENT_PHRASINGS).toContain("names");
    expect(DEFAULT_INTENT_PHRASING).toBe("says");
    const named = intentMessages("buy milk", { phrasing: "names" })[0]!.content;
    expect(named).toContain(`A = ${INTENTS[0]!.name}`);
    expect(named).not.toContain(INTENTS[0]!.description);
  });
});

describe("rules.yaml's intent: block FAILS AT LOAD, not per message", () => {
  it("takes a floor and per-intent overrides", () => {
    const r = intentRulesSchema.parse({ min_confidence: 0.8, by_intent: { task_create: 0.95 } });
    expect(intentThreshold(r, "task_create")).toBe(0.95);
    expect(intentThreshold(r, "note_capture")).toBe(0.8);
  });

  it("refuses a threshold outside [0, 1] — the misuse test the research asks for", () => {
    expect(intentRulesSchema.safeParse({ min_confidence: 1.4 }).success).toBe(false);
    expect(intentRulesSchema.safeParse({ min_confidence: -0.1 }).success).toBe(false);
    const bad = intentRulesSchema.safeParse({ min_confidence: 0.8, by_intent: { task_create: 12 } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]!.message).toMatch(/between 0 and 1/);
  });

  it("refuses an intent this build does not know, naming the enum", () => {
    const bad = intentRulesSchema.safeParse({ min_confidence: 0.8, by_intent: { book_a_flight: 0.9 } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]!.message).toMatch(/not one of the intents/);
      expect(bad.error.issues[0]!.message).toMatch(/invariant 10/);
    }
  });

  it("refuses a threshold on `unsure`, which would be a line that does nothing", () => {
    expect(intentRulesSchema.safeParse({ min_confidence: 0.8, by_intent: { [INTENT_UNSURE]: 0.9 } }).success).toBe(false);
  });

  it("requires min_confidence: there is no default, because a number nobody chose is not a risk tolerance", () => {
    expect(intentRulesSchema.safeParse({}).success).toBe(false);
    expect(intentRulesSchema.safeParse({ by_intent: {} }).success).toBe(false);
  });
});
