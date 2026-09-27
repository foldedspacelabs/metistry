// The question-answer convention (§4.21 prompt cards, docs/product/ux-direction.md
// "Rich request–response dialogues"; v2, T2-3 — screen 3 §12.3, C105). When a
// reply ENDS with a fenced `decision` block, the sender is blocked on the
// user's answer. One question, the v1 shape, still parses:
//
//     ```decision
//     title: Which repo should this land in?
//     options:
//     - metistry
//     - metistry-instance
//     ```
//
// …and so do several, each pick one (the default) or pick any, each ending in
// *Something else…* unless it says `other: no`:
//
//     ```decision
//     title: Two things before I file this
//     question: Which repo should it land in?
//     - metistry
//     - metistry-instance
//     question: Which labels apply?
//     pick: any
//     other: no
//     - bug
//     - docs
//     ```
//
// The emitter parses it once, at the point the reply is stored, and turns it
// into a `proposals` row of kind `decision` — so a blocking question is in the
// one "Needs You" queue like everything else, answerable from chat, from
// triage, or from a notification. Agents ask the same questions through
// `requests_create` kind `question` (`checkQuestions` below is that door's
// bound, so a block and a tool call cannot disagree about what a question is).
//
// Nothing here trusts the model beyond the shape: a malformed block is ignored
// (the reply still sends, it simply does not create a queue item), an answer
// is one of the question's own options or — where the question allows it —
// the owner's own words as `other`, and NO answer is executable (C105). The
// server checks every answer against the STORED row (`questionsOf` +
// `checkAnswers`), never against the request.
//
// Deliberately a tiny hand-rolled parser rather than YAML: this runs on every
// reply, the grammar is seven line shapes, and an over-permissive parser here
// would widen what a model can put into the user's queue.

/** One question in a request: its prompt, its options, and how it is answered. */
export interface Question {
  readonly prompt: string;
  readonly options: readonly string[];
  /** Pick any (`true`) or pick one (`false`, the default). */
  readonly multi: boolean;
  /** Ends in *Something else…* — an answer in the owner's own words, stored as `other` (C105). */
  readonly allow_other: boolean;
}

export interface DecisionBlock {
  /** The one line the queue shows for the whole request. */
  title: string;
  questions: Question[];
}

/** One question's answer: the options chosen (at most one on a pick-one question), and/or the owner's own words. */
export interface QuestionAnswer {
  readonly choices: readonly string[];
  readonly other?: string;
}

export const QUESTION_MAX_TITLE = 200; // limit: fixed — the decision-block wire format the console and the Mac app both parse
export const QUESTION_MAX_PROMPT = 200; // limit: fixed — one question has to fit one step of the stepped card (screen 3 §13.2)
export const QUESTION_MAX_OPTION = 80; // limit: fixed — an option has to fit on a notification button
export const QUESTION_MAX_OPTIONS = 8; // limit: fixed — more choices than this is not a decision block
export const QUESTION_MIN_OPTIONS = 2; // limit: fixed — one option is a statement, not a decision
export const QUESTION_MAX_COUNT = 5; // limit: fixed — more questions than this is a form, not a request (the stepped card's segmented bar)
export const QUESTION_MAX_OTHER = 1000; // limit: fixed — *Something else…* is an answer, not a document

const FENCE = /(?:^|\n)```decision[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/;

const unquote = (s: string): string => (/^(".*"|'.*')$/.test(s) ? s.slice(1, -1).trim() : s);

/** The bounds every question is held to, wherever it comes from; the reason it fails, or null. */
function questionFault(q: Question, n: number): string | null {
  const at = `question ${n + 1}`;
  if (q.prompt === "" || q.prompt.length > QUESTION_MAX_PROMPT) return `${at}: the prompt must be 1..${QUESTION_MAX_PROMPT} characters`;
  if (q.options.length < QUESTION_MIN_OPTIONS || q.options.length > QUESTION_MAX_OPTIONS) return `${at}: ${QUESTION_MIN_OPTIONS}..${QUESTION_MAX_OPTIONS} options`;
  if (q.options.some((o) => o === "" || o.length > QUESTION_MAX_OPTION)) return `${at}: every option must be 1..${QUESTION_MAX_OPTION} characters`;
  if (new Set(q.options).size !== q.options.length) return `${at}: two options are the same, so an answer could not say which`;
  return null;
}

/** Parse a trailing ```decision block; null when there is none or it is malformed. */
export function parseDecisionBlock(reply: unknown): DecisionBlock | null {
  if (typeof reply !== "string") return null;
  const m = FENCE.exec(reply.trimEnd());
  if (!m?.[1]) return null;

  // "head" until `options:` (v1: one question, the title is its prompt) or the
  // first `question:` (v2); the two shapes never mix.
  let state: "head" | "v1" | "v2" = "head";
  let title = "";
  const v1: string[] = [];
  const v2: { prompt: string; options: string[]; pick?: "one" | "any"; other?: "yes" | "no" }[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const current = v2.at(-1);
    if (state === "head" && /^title:/i.test(line)) {
      if (title !== "") return null; // two titles: malformed
      title = unquote(line.slice(6).trim());
      continue;
    }
    if (state === "head" && /^options:$/i.test(line)) {
      state = "v1";
      continue;
    }
    if (state !== "v1" && /^question:/i.test(line)) {
      state = "v2";
      v2.push({ prompt: unquote(line.slice(9).trim()), options: [] });
      continue;
    }
    if (current && /^pick:/i.test(line)) {
      const v = line.slice(5).trim().toLowerCase();
      if (current.pick !== undefined || (v !== "one" && v !== "any")) return null;
      current.pick = v;
      continue;
    }
    if (current && /^other:/i.test(line)) {
      const v = line.slice(6).trim().toLowerCase();
      if (current.other !== undefined || (v !== "yes" && v !== "no")) return null;
      current.other = v;
      continue;
    }
    if (state !== "head" && /^-\s*/.test(line)) {
      (current?.options ?? v1).push(unquote(line.replace(/^-\s*/, "").trim()));
      continue;
    }
    return null; // anything else in the block: malformed, ignore the whole thing
  }

  if (!title || title.length > QUESTION_MAX_TITLE) return null;
  const questions: Question[] =
    state === "v1"
      ? [{ prompt: title, options: v1, multi: false, allow_other: true }]
      : v2.map((q) => ({ prompt: q.prompt, options: q.options, multi: q.pick === "any", allow_other: q.other !== "no" }));
  if (questions.length === 0 || questions.length > QUESTION_MAX_COUNT) return null;
  if (questions.some((q, n) => questionFault(q, n) !== null)) return null;
  return { title, questions };
}

/**
 * Questions as a tool or a stored row hands them over — `{prompt, options,
 * multi?, allow_other?}` each — held to exactly the block's bounds.
 * `allow_other` defaults to true (C105: every question ends in *Something
 * else…*), `multi` to false.
 */
export function checkQuestions(input: unknown): { ok: true; questions: Question[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0 || input.length > QUESTION_MAX_COUNT) return { ok: false, error: `questions: 1..${QUESTION_MAX_COUNT} of them` };
  const questions: Question[] = [];
  for (const [n, q] of input.entries()) {
    const o = q as { prompt?: unknown; options?: unknown; multi?: unknown; allow_other?: unknown } | null;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, error: `question ${n + 1}: not an object` };
    if (typeof o.prompt !== "string" || !Array.isArray(o.options) || !o.options.every((x) => typeof x === "string")) {
      return { ok: false, error: `question ${n + 1}: needs a prompt and a list of options` };
    }
    if ((o.multi !== undefined && typeof o.multi !== "boolean") || (o.allow_other !== undefined && typeof o.allow_other !== "boolean")) {
      return { ok: false, error: `question ${n + 1}: multi and allow_other are true or false` };
    }
    const question: Question = { prompt: o.prompt.trim(), options: (o.options as string[]).map((x) => x.trim()), multi: o.multi === true, allow_other: o.allow_other !== false };
    const fault = questionFault(question, n);
    if (fault !== null) return { ok: false, error: fault };
    questions.push(question);
  }
  return { ok: true, questions };
}

/**
 * The questions a STORED `decision` row asks — what an answer is checked
 * against. v2 rows carry `payload.questions`. A row from before v2 carries
 * `payload.options` and is ONE pick-one question whose prompt is its title,
 * with no *Something else…*: those rows were written under v1's rule that
 * the options are the only answers, and one of them (an agent's enrolment,
 * `approve | deny`) does something when answered. Empty when the row holds
 * neither, so there is nothing to answer — only Revise, Decline and Later.
 */
export function questionsOf(payload: unknown): Question[] {
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as { questions?: unknown; options?: unknown; title?: unknown };
  if (p.questions !== undefined) {
    const v2 = checkQuestions(p.questions);
    return v2.ok ? v2.questions : [];
  }
  if (!Array.isArray(p.options)) return [];
  const options = p.options.filter((o): o is string => typeof o === "string" && o !== "");
  if (options.length === 0 || options.length !== p.options.length || new Set(options).size !== options.length) return [];
  return [{ prompt: typeof p.title === "string" ? p.title : "", options, multi: false, allow_other: false }];
}

/**
 * v1's `options`, for a request that is exactly one pick-one question —
 * written BESIDE `questions` so a client that predates v2 can still draw it
 * and answer with the option itself (the v1 wire, which the console accepts
 * on such a row and only there). `questions` stays the record: a row that
 * carries both is read by its questions (`questionsOf`).
 */
export function v1Options(questions: readonly Question[]): { options?: string[] } {
  const [only, ...rest] = questions;
  return only !== undefined && rest.length === 0 && !only.multi ? { options: [...only.options] } : {};
}

/**
 * An answer to every question, checked against the questions as STORED: one
 * entry per question, in order, each `{choices?, other?}`. A choice is one of
 * that question's own options (one at most where it is pick one); `other` is
 * the owner's words, accepted only where the question allows it, and never
 * executed. Refused whole, with the reason, rather than half-read.
 */
export function checkAnswers(questions: readonly Question[], input: unknown): { ok: true; answers: QuestionAnswer[] } | { ok: false; error: string } {
  if (questions.length === 0) return { ok: false, error: "this request asks no question an answer could be checked against — Revise or Decline it" };
  if (!Array.isArray(input) || input.length !== questions.length) {
    return { ok: false, error: `answers must be a list of ${questions.length} — one per question, in order` };
  }
  const answers: QuestionAnswer[] = [];
  for (const [n, q] of questions.entries()) {
    const at = `answer ${n + 1}`;
    const a = input[n] as Record<string, unknown> | null;
    if (typeof a !== "object" || a === null || Array.isArray(a)) return { ok: false, error: `${at}: {choices?, other?}` };
    const extra = Object.keys(a).filter((k) => k !== "choices" && k !== "other");
    if (extra.length > 0) return { ok: false, error: `${at}: ${extra.join(", ")} is not part of an answer — {choices?, other?}` };
    const raw = a.choices ?? [];
    if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string")) return { ok: false, error: `${at}: choices is a list of the question's options` };
    const chosen = raw as string[];
    const outside = chosen.filter((c) => !q.options.includes(c));
    if (outside.length > 0) {
      return { ok: false, error: `${at}: ${JSON.stringify(outside[0])} is not one of this question's options${q.allow_other ? " — an answer in your own words is `other`" : ", and it takes no answer in other words"}` };
    }
    if (new Set(chosen).size !== chosen.length) return { ok: false, error: `${at}: the same option twice` };
    if (!q.multi && chosen.length > 1) return { ok: false, error: `${at}: this question is pick one` };
    let other: string | undefined;
    if (a.other !== undefined) {
      if (!q.allow_other) return { ok: false, error: `${at}: this question takes only its own options` };
      if (typeof a.other !== "string" || a.other.trim() === "" || a.other.length > QUESTION_MAX_OTHER) return { ok: false, error: `${at}: other is 1..${QUESTION_MAX_OTHER} characters of your own words` };
      other = a.other.trim();
    }
    if (chosen.length === 0 && other === undefined) return { ok: false, error: `${at}: every question needs an answer` };
    if (!q.multi && chosen.length === 1 && other !== undefined) return { ok: false, error: `${at}: this question is pick one — an option or your own words, not both` };
    // stored in the question's own order, so two clients that ticked the same boxes store the same answer
    const choices = q.options.filter((o) => chosen.includes(o));
    answers.push(other === undefined ? { choices } : { choices, other });
  }
  return { ok: true, answers };
}

const MAX_ANSWER_TEXT = 500; // limit: fixed — the length chat's own answer to a question is stored at (`POST /message`)

/**
 * The answers as words, for `proposals.feedback` — the column chat's free-text
 * answer lands in too, so a question reads the same in the timeline however
 * it was answered. One question: the answer itself; several: each prompt with
 * its answer. The structured record is `payload.answers`; this is its reading.
 */
export function answersText(questions: readonly Question[], answers: readonly QuestionAnswer[]): string {
  const said = answers.map((a) => [...a.choices, ...(a.other !== undefined ? [a.other] : [])].join(", "));
  const text = said.length === 1 ? said[0]! : said.map((s, n) => `${questions[n]?.prompt ?? `question ${n + 1}`} — ${s}`).join("; ");
  return text.slice(0, MAX_ANSWER_TEXT);
}

/**
 * What the `skip` verb writes into `proposals.feedback` (ADOPT 5,
 * docs/ops/reply-feedback.md). Here, in core, because two components must
 * agree on it and neither may own it: the console writes it, and every path
 * that carries a decline's WORDS anywhere — the weekly review's "top reasons
 * you declined" today, anything routing a reason back to a source agent
 * later — reads it to know there is nothing to carry. A skip is the user
 * putting something down, not a judgement about it, so its marker is a fixed
 * value and never the user's own text.
 */
export const SKIP_FEEDBACK = "skipped";
