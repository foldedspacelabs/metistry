// The intent enum — what a message SAYS, from a closed list this product
// maintains (PoC-20 phase 1;
// docs/research/2026-09-21-intent-classification-tier.md §3.2, §3.3, §5.2).
//
// It sits beside `ACTION_KINDS` for the reason `actions.ts:16-19` gives about
// that list, which applies word for word here:
//
//   > The enum is CLOSED and it is here. A kind nobody validated is a kind
//   > nobody reviewed.
//
// Invariant 10 territory, and deliberately: **a new intent is a product change,
// never a prompt or a config line.** An instance may move a THRESHOLD (that is
// `rules.yaml`, below, and it is the owner's own hand); it may not invent a
// verb.
//
// Three properties, each of which a reviewer can check without running
// anything:
//
//   * **A verdict is a FACT, never a destination** (§3.2 P1). Nothing in this
//     file names a tier, a model or an effort, and nothing in it can hold one.
//     `Route` is not extended and the router does not read this module —
//     `apps/console/test/invariant4.test.ts` greps for exactly that.
//   * **The codes are GENERATED from the list** (`codesFor`, choice.ts). A
//     hand-maintained letter table and a list drift, and the drift is silent:
//     the model answers `C`, the table says `task_update`, and the list has
//     moved on. `intent.test.ts` asserts the generation.
//   * **The question asks what the message SAYS, never what to do about it.**
//     That is Laya's lesson 1 (§2.3.1.1) — "Where is the bird relative to the
//     gap?" produced clean graded probabilities; "Which way must the bird
//     move?" came out inverted on every checkpoint — and it is the same shape
//     invariant 4 requires for a different reason. The invariant-safe shape
//     and the accurate shape are the same shape.

import { z } from "zod";
import { CHOICE_MAX_OPTIONS, choicePlan, codesFor, type ChoiceGroup, type ChoiceOption } from "./choice.js";

/**
 * Every intent, with the DESCRIPTION the model is actually shown.
 *
 * Laya lesson 1 (§2.3.1): descriptions, not bare names. The research's own
 * arms differed on exactly this — the answer-token run in §2.5 used bare
 * intent names while the embedding and Laya runs used descriptions — and
 * §5.2 phase 1 says to close that gap rather than inherit it. `metistry-eval
 * intents --phrasings` measures it on the owner's fixtures.
 *
 * Each description is a statement about the TEXT, in the present tense,
 * starting "it …". Never an instruction, never a destination.
 *
 * The list is derived from the fifteen the research measured (§2.5, §2.6) plus
 * `unsure`. Nimble's README is the reason the last one exists, verbatim: "If
 * it is possible that none of your answers fit, add an answer that means 'no
 * match'."
 */
export const INTENTS = [
  { name: "task_create", description: "it states a new thing that has to be done" },
  { name: "task_update", description: "it changes something about a task that already exists — who owns it, which project it is in, what it is called" },
  { name: "task_close", description: "it says a task that already exists is finished, done with, or no longer wanted" },
  { name: "task_list", description: "it asks to be shown a set of tasks that already exist" },
  { name: "status_open_work", description: "it asks how things stand right now — what is open, in flight, or outstanding" },
  { name: "note_capture", description: "it is a fact, a thought or an observation worth keeping, with nothing to do about it" },
  { name: "knowledge_search", description: "it asks about something that was written down or decided before" },
  { name: "link_capture", description: "it is mostly a link, or a pointer to something that lives somewhere else" },
  { name: "event_capture", description: "it records something that happens on a named day or at a named time" },
  { name: "schedule_lookup", description: "it asks about a calendar — a meeting, a free slot, the shape of a day" },
  { name: "explanation_request", description: "it asks for an explanation, a diagnosis, or a judgement about something" },
  { name: "artifact_review", description: "it asks for a document, a change or a piece of writing to be read and commented on" },
  { name: "triage_answer", description: "it answers a question that was put to the writer — an approval, a refusal, or a correction" },
  { name: "agent_delegate", description: "it asks for something to be handed to somebody or something else to carry out" },
  { name: "smalltalk", description: "it is a greeting, thanks, or conversation with no request in it" },
  { name: "unsure", description: "it is none of the things the lines above describe" },
] as const satisfies readonly { name: string; description: string }[];

export type Intent = (typeof INTENTS)[number]["name"];

/** The names alone, in order. The order is the code order, so it is not cosmetic. */
export const INTENT_NAMES = INTENTS.map((i) => i.name) as readonly Intent[] as [Intent, ...Intent[]];

/** The "no match" member. A rule that acts on this one has misread the list. */
export const INTENT_UNSURE = "unsure" satisfies Intent;

/** The options as the scorer takes them — one place, so the harness and the capture door describe the options identically. */
export const INTENT_OPTIONS: ChoiceOption[] = INTENTS.map((i) => ({ key: i.name, description: i.description }));

/**
 * Intent → its one-token code, GENERATED from the list's order.
 *
 * Never written out. `intent.test.ts` asserts that inserting an intent moves
 * every code after it, which is the property that makes a hand-maintained
 * table impossible to keep by accident.
 */
export const INTENT_CODES: Record<Intent, string> = Object.fromEntries(codesFor(INTENTS.length).map((c, i) => [INTENTS[i]!.name, c])) as Record<Intent, string>;

export function isIntent(v: unknown): v is Intent {
  return typeof v === "string" && (INTENT_NAMES as readonly string[]).includes(v);
}

/**
 * The groups the cascade uses past `CHOICE_MAX_OPTIONS` (Laya lesson 5:
 * shortlist first, decide second). Unused today — sixteen intents fit in one
 * call — and present because the alternative is discovering the ceiling on the
 * PR that crosses it. `choicePlan` checks that they cover every intent, so a
 * new intent that belongs to no group fails a test rather than becoming
 * unreachable.
 */
export const INTENT_GROUPS: ChoiceGroup[] = [
  { key: "tasks", description: "it is about a piece of work: making one, changing one, finishing one, or listing them", members: ["task_create", "task_update", "task_close", "task_list", "status_open_work"] },
  { key: "knowledge", description: "it is about something written down: a note, a link, a question about the record", members: ["note_capture", "knowledge_search", "link_capture", "explanation_request"] },
  { key: "time", description: "it is about a day, a time, or a calendar", members: ["event_capture", "schedule_lookup"] },
  { key: "conversation", description: "it is addressed to a reader: an answer, a request to read something, a hand-off, or small talk", members: ["artifact_review", "triage_answer", "agent_delegate", "smalltalk"] },
  { key: "none", description: "it is none of the above", members: ["unsure"] },
];

/** The first (and today only) scored call for the whole enum. */
export const intentStage = () => choicePlan(INTENT_OPTIONS, INTENT_GROUPS);

// ---- the deterministic guard, AHEAD of the model -------------------------------

/**
 * How much of a message the scorer sees. The same 2000 the inbox's own model
 * tier uses (`inbox-drain/run.ts` FM_MAX_CHARS), for the same reason: a small
 * local model's window is charged for the prompt and the options together.
 */
export const INTENT_MAX_CHARS = 2000; // limit: fixed — matches inbox-drain's FM_MAX_CHARS; a 4096-token window is charged for the option list as well as the text

/** Below this many letters a script test is noise, so it is not applied — "hey" is three letters and a perfectly ordinary message. */
const SCRIPT_MIN_LETTERS = 12; // limit: fixed — under a dozen letters the Latin-share statistic has no power, and a short greeting must not be refused

/** The share of a message's letters that must be Latin for an English option list to mean anything. */
const SCRIPT_MIN_LATIN = 0.5; // limit: fixed — a half-and-half message is still legible to an English option list; below it the enum is not describing this text

export type IntentGuard = { ok: true; text: string } | { ok: false; intent: typeof INTENT_UNSURE; reason: string };

/**
 * A deterministic check ahead of the model — the single most load-bearing
 * lesson in the research (§2.3.1.3), and the number that proves it:
 *
 *   > The English checkpoint on Khmer: **0.000 accuracy at 0.952 confidence**
 *   > […] its mean confidence never drops below 0.885 at any accuracy level,
 *   > so confidence gating cannot catch it — which is why routing happens
 *   > *before* the forward pass.
 *
 * A confidence threshold protects against AMBIGUITY. It does not protect
 * against the input being outside the model's competence, because a model
 * outside its competence is not less confident. So four things are refused in
 * code, before any request is built, and each returns `unsure` with the reason
 * that will land in the audit row:
 *
 *   1. nothing to read — empty, or not a string at all;
 *   2. not text — a mime type that is an image, a PDF, a binary;
 *   3. too long — past `INTENT_MAX_CHARS`, where a one-sentence intent is not
 *      what the thing is;
 *   4. not the script this enum is written in — the descriptions above are
 *      English, and an option list the reader cannot read is the Khmer case.
 */
export function intentGuard(text: unknown, opts: { mime?: string | null; maxChars?: number } = {}): IntentGuard {
  if (typeof text !== "string") return { ok: false, intent: INTENT_UNSURE, reason: `nothing to read: the note is ${text === null ? "null" : typeof text}` };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, intent: INTENT_UNSURE, reason: "nothing to read: the note is empty" };

  const mime = (opts.mime ?? "").toLowerCase();
  if (mime !== "" && !(mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || mime.includes("markdown"))) {
    return { ok: false, intent: INTENT_UNSURE, reason: `not text: mime ${mime} — the option list describes sentences, and this is not one` };
  }

  const max = opts.maxChars ?? INTENT_MAX_CHARS;
  if (trimmed.length > max) {
    return { ok: false, intent: INTENT_UNSURE, reason: `too long: ${trimmed.length} characters against a ceiling of ${max} — a document is outside what a one-sentence intent describes` };
  }

  const letters = trimmed.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) {
    return { ok: false, intent: INTENT_UNSURE, reason: "no letters: there is no sentence here to describe" };
  }
  if (letters.length >= SCRIPT_MIN_LETTERS) {
    const latin = (trimmed.match(/\p{Script=Latin}/gu) ?? []).length;
    const share = latin / letters.length;
    if (share < SCRIPT_MIN_LATIN) {
      return {
        ok: false,
        intent: INTENT_UNSURE,
        reason:
          `out of script: ${Math.round(share * 100)}% of this message's letters are Latin and the option list is English. ` +
          `Confidence cannot catch this — an English checkpoint scored 0.000 accuracy at 0.952 confidence on Khmer (research §2.3.1.3), so the check is here rather than after the call.`,
      };
    }
  }
  return { ok: true, text: trimmed };
}

// ---- the prompt ----------------------------------------------------------------

/**
 * Facts RESOLVED IN CODE and handed over as words — Laya lesson 3
 * (§2.3.1.2), verbatim:
 *
 *   > Given "Bird altitude: 20. Gap altitude: 60." no checkpoint could tell
 *   > which was lower. If a decision depends on a comparison, threshold or
 *   > sum, compute it in code and hand Laya the conclusion.
 *
 * Every one of these is a comparison or a count a small model is bad at and a
 * regex is perfect at: whether the text names a day, whether it carries a
 * link, whether it is one line or many, and what today is. They go in as
 * English sentences, never as numbers — "it names a day or a time", never
 * "dates: 1".
 */
export function messageFacts(text: string, now: Date = new Date()): string[] {
  const facts: string[] = [];
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  facts.push(`Today is ${weekday}.`);
  const dated =
    /\b(today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|next week|this week|next month)\b/i.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    /\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i.test(text) ||
    /\b\d{1,2}\s*(am|pm)\b/i.test(text);
  facts.push(dated ? "The message names a day or a time." : "The message names no day and no time.");
  facts.push(/https?:\/\/\S+/i.test(text) ? "The message carries a link." : "The message carries no link.");
  facts.push(text.trim().includes("\n") ? "The message runs to more than one line." : "The message is a single line.");
  return facts;
}

/**
 * The wordings to try. §5.2 phase 1: "try two or three phrasings of the
 * question and of each label, and keep the best on the fixtures. Laya's
 * authors measured one wording change moving a margin from 0.45 to 0.75."
 *
 * `names` is the CONTROL, and it is the research's own answer-token arm: bare
 * intent names, no descriptions. It exists so the comparison the research
 * could not make — descriptions against names, same technique, same model —
 * is one flag on the harness.
 */
export const INTENT_PHRASINGS = ["says", "best_fits", "names"] as const;
export type IntentPhrasing = (typeof INTENT_PHRASINGS)[number];
export const DEFAULT_INTENT_PHRASING: IntentPhrasing = "says";

const QUESTION: Record<IntentPhrasing, string> = {
  // Perception, not prescription (§2.3.1.1). Note what is NOT asked: not
  // "what should be done about this", not "where should this go".
  says: "Which line below describes what the message says?",
  best_fits: "Read the message. Which line below fits it best?",
  names: "Which label below names what the message is?",
};

function label(o: ChoiceOption, phrasing: IntentPhrasing): string {
  return phrasing === "names" ? o.key : o.description;
}

export interface IntentPromptOptions {
  options?: readonly ChoiceOption[];
  codes?: readonly string[];
  phrasing?: IntentPhrasing;
  now?: Date;
  maxChars?: number;
}

/**
 * The two messages one scored call sends. Built here rather than in the
 * collector so the eval harness and the capture door ask the identical
 * question — a threshold fitted against one wording is not valid against
 * another (§4.4).
 */
export function intentMessages(text: string, opts: IntentPromptOptions = {}): Array<{ role: "system" | "user"; content: string }> {
  const options = opts.options ?? INTENT_OPTIONS;
  const codes = opts.codes ?? codesFor(options.length);
  const phrasing = opts.phrasing ?? DEFAULT_INTENT_PHRASING;
  const body = text.slice(0, opts.maxChars ?? INTENT_MAX_CHARS);
  const system = [
    "You are reading one short message someone wrote for themselves.",
    ...messageFacts(body, opts.now),
    "",
    QUESTION[phrasing],
    ...options.map((o, i) => `${codes[i]} = ${label(o, phrasing)}`),
    "",
    "Answer with one letter and nothing else.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: body },
  ];
}

// ---- the thresholds, which are the OWNER'S ------------------------------------

/**
 * `rules.yaml`'s `intent:` block — the DECISION half of §3.2 P2.
 *
 * The classifier supplies a fact; this file decides what happens about it, and
 * this file is a §4.7 protected path — `.metistry/rules.yaml`, the user's own
 * hand (`apps/reconciler/src/paths.ts`). TypeSafe's own doctrine, which is the
 * one adopted here:
 *
 *   > A confidence threshold is not one number. Different actions within the
 *   > same system should be gated at different levels depending on the
 *   > consequences of getting it wrong. […] Your code encodes the risk
 *   > tolerance.
 *
 * Hence `by_intent`. And hence the schema: a threshold outside [0, 1] or an
 * intent outside the enum FAILS AT LOAD, in the same zod parse that already
 * refuses a bad `fast_path` regex — not per message, where it would be a
 * surprise on the day somebody captured the wrong sentence.
 *
 * **Absent means off.** No `intent:` block, no decision, and the tier does not
 * run however `compute.yaml` is configured: the model is a compute choice and
 * the threshold is the owner's, and neither one alone is enough to start
 * acting on verdicts.
 */
export const intentRulesSchema = z
  .strictObject({
    /** Below this, the verdict is recorded and ignored. There is no default: a number nobody chose is not a risk tolerance. */
    min_confidence: z
      .number({ error: "intent.min_confidence is a number between 0 and 1 — fit it with `metistry-eval intents --fit` on your own labelled messages rather than picking one (research §4.4)" })
      .min(0, "intent.min_confidence must be between 0 and 1")
      .max(1, "intent.min_confidence must be between 0 and 1"),
    /** Per-intent overrides, for the ones whose consequence differs. */
    by_intent: z.record(z.string(), z.number()).default({}),
  })
  .superRefine((v, ctx) => {
    for (const [name, threshold] of Object.entries(v.by_intent)) {
      if (!isIntent(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["by_intent", name],
          message: `${JSON.stringify(name)} is not one of the intents this build knows (${INTENT_NAMES.join(", ")}) — the enum is a product change, never a config line (invariant 10)`,
        });
        continue;
      }
      if (name === INTENT_UNSURE) {
        ctx.addIssue({
          code: "custom",
          path: ["by_intent", name],
          message: `intent.by_intent.${INTENT_UNSURE} would be a threshold for acting on "none of these fit" — ${INTENT_UNSURE} always falls through, so the line would do nothing`,
        });
      }
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        ctx.addIssue({ code: "custom", path: ["by_intent", name], message: `intent.by_intent.${name} is ${threshold}; a confidence threshold is between 0 and 1` });
      }
    }
  });

export type IntentRules = z.infer<typeof intentRulesSchema>;

/** The threshold that governs ONE verdict: the intent's own if the file names one, otherwise the floor. Pure; the rules decide, the model does not. */
export function intentThreshold(rules: IntentRules, intent: Intent): number {
  const own = rules.by_intent[intent];
  return typeof own === "number" ? own : rules.min_confidence;
}

/** Sanity the enum has to keep, asserted by a test and by `choicePlan` at first use. */
export const INTENT_WITHIN_ONE_CALL = INTENTS.length <= CHOICE_MAX_OPTIONS;
