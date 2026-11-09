// The complexity fixture generator (X-121; docs/ops/dynamic-router.md §7.2,
// "generating fixtures").
//
// C11 forbids a Claude-authored label: a fixture written by the bar marks its
// own homework. The owner ruled on 2026-10-04 that the 150-plus items of
// `complexity.jsonl` may instead be GENERATED, with two conditions this file
// turns into code rather than prose:
//
//   * **Two non-Claude models, from two families.** A WRITER produces the
//     messages, class by class; a RELABELLER — a second model, another family —
//     labels every one of them blind. A model id naming Claude is refused for
//     either role, and so is a pair from one family (`familyOf`, the judge's
//     own rule). The refusal is a thrown error naming what would permit it.
//   * **Neither model sees the rubric.** Both are given the three class NAMES
//     and §7.2's structural rules (how many, the long-simple and short-demanding
//     traps, the D08-class items) and nothing else — never §2's class
//     descriptions and never the planner's wording. `RUBRIC_PHRASES` is a
//     frozen list taken from §2; every request is checked against it, and
//     against the live descriptions and the live planner prompt, BEFORE it is
//     sent (`assertNoRubric`). A leak is a thrown error, not a warning.
//
// Then the labels: an item both models call the same keeps that label. A
// disagreement is never resolved in silence — an adjacent one (`simple` /
// `moderate`, `moderate` / `demanding`) keeps the writer's label with the
// relabeller's as `accept`, written down in `notes`; an opposite one (`simple`
// against `demanding`) goes to the owner's adjudication pile; every D08-class
// item goes to the pile whatever the two models said, because §7.2 has the
// owner label each. The pile is capped, and what would overflow it is DROPPED
// and counted — a generated item two models cannot agree on at all is not
// worth the owner's time, and dropping it keeps it under no label at all.
//
// Every kept row carries `source: "generated"`, so `metistry-eval complexity`
// holds the generated set and the owner's own to the bar SEPARATELY (the Routr
// review's lesson, #492), and the length-against-label check (|r| < 0.2) is
// computed here as well as there, so a set that fails it is never written as
// if it qualified.
//
// Offline by construction: the calls go through `recordingFetch` /
// `replayFetch`, exactly as the confirmatory eval's do, so every test replays
// a recording and none dials a model.

import { z } from "zod";
import { COMPLEXITY, COMPLEXITY_NAMES, complexityMessages, type Complexity } from "@foldedspacelabs/metistry-core";
import { FIXTURE_SET_BAR, LONG_SIMPLE_MIN_WORDS, SHORT_DEMANDING_MAX_WORDS, checkFixtureSet, pearson, wordCount, type ComplexityFixture, type FixtureSetSummary } from "./complexity.js";
import { familyOf, stripFence } from "./judge.js";

// ---- the models, and the two refusals ----------------------------------------------------

/** The environment the generator reads. The key is never an argument: it is the owner's, read at run time (X-121). */
export const GEN_ENV = {
  BASE_URL: "METISTRY_EVAL_GEN_BASE_URL",
  API_KEY: "METISTRY_EVAL_GEN_API_KEY",
  MODEL: "METISTRY_EVAL_GEN_MODEL",
  RELABEL_MODEL: "METISTRY_EVAL_GEN_RELABEL_MODEL",
} as const;

export class GeneratorModelError extends Error {
  readonly code = "generator_model_refused";
  constructor(message: string) {
    super(message);
    this.name = "GeneratorModelError";
  }
}

export class RubricLeakError extends Error {
  readonly code = "rubric_leak";
  constructor(readonly phrases: readonly string[]) {
    super(`a generator prompt contains the rubric — ${phrases.map((p) => `"${p}"`).join(", ")} — and was not sent: the models see the class names and the structural rules only (docs/ops/dynamic-router.md §7.2, C11)`);
    this.name = "RubricLeakError";
  }
}

export type GeneratorRole = "writer" | "relabeller";

/** C11, at the tool: a Claude model may not write or label a fixture, under any spelling of its id. */
export function assertNotClaude(model: string, role: GeneratorRole): void {
  const id = model.trim();
  if (id === "") throw new GeneratorModelError(`the ${role} model id is empty — set ${role === "writer" ? GEN_ENV.MODEL : GEN_ENV.RELABEL_MODEL} to a non-Claude model id`);
  if (/claude/i.test(id) || familyOf(id) === "anthropic") {
    throw new GeneratorModelError(`the ${role} model ${id} is a Claude model, and Claude may not write or label a complexity fixture (C11) — name a model from another family in ${role === "writer" ? GEN_ENV.MODEL : GEN_ENV.RELABEL_MODEL}`);
  }
}

/** The relabeller is a SECOND opinion only if it comes from a second family. */
export function assertTwoFamilies(writer: string, relabeller: string): void {
  if (familyOf(writer) === familyOf(relabeller)) {
    throw new GeneratorModelError(`the writer ${writer} and the relabeller ${relabeller} are the same family ("${familyOf(writer)}") — a blind re-label from the family that wrote the item is not a second opinion; name a model from another family in ${GEN_ENV.RELABEL_MODEL}`);
  }
}

export interface GeneratorConfig {
  /** An OpenAI-compatible root — `https://openrouter.ai/api/v1`. Absent only under `--replay`, where nothing is dialled. */
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  writer: string;
  relabeller: string;
}

/**
 * The generator's models, from the environment, with both refusals applied
 * before anything else happens. `replay` relaxes the base URL and the key
 * only — the two model ids still name what the recording was made with.
 */
export function generatorFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { replay?: boolean } = {}): GeneratorConfig {
  const writer = (env[GEN_ENV.MODEL] ?? "").trim();
  const relabeller = (env[GEN_ENV.RELABEL_MODEL] ?? "").trim();
  if (writer === "" || relabeller === "") {
    throw new GeneratorModelError(`set ${GEN_ENV.MODEL} (the writer) and ${GEN_ENV.RELABEL_MODEL} (the blind relabeller) to two non-Claude model ids from two families`);
  }
  assertNotClaude(writer, "writer");
  assertNotClaude(relabeller, "relabeller");
  assertTwoFamilies(writer, relabeller);
  const baseUrl = (env[GEN_ENV.BASE_URL] ?? "").trim();
  const apiKey = (env[GEN_ENV.API_KEY] ?? "").trim();
  if (!opts.replay && baseUrl === "") {
    throw new GeneratorModelError(`set ${GEN_ENV.BASE_URL} to an OpenAI-compatible root (OpenRouter's is https://openrouter.ai/api/v1) and ${GEN_ENV.API_KEY} to your key — the key is read from the environment and never from an argument`);
  }
  return { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), writer, relabeller };
}

// ---- the rubric, which the models never see --------------------------------------------------

/**
 * Frozen 2026-10-18 from `docs/ops/dynamic-router.md` §2 — the three class
 * descriptions, in the pieces a paraphrase would most likely keep — and from
 * the planner's own prompt (`intentMessages`). The list is FROZEN on purpose:
 * `rubricLeaks` also checks the live descriptions and the live planner
 * wording, but a list that moved with them would let a reworded rubric slip
 * into a prompt in the same PR that reworded it.
 */
export const RUBRIC_PHRASES: readonly string[] = [
  // simple
  "one small thing",
  "a fact, a short reply, a lookup, a quick change",
  // moderate
  "a piece of work with a few steps",
  "reading, gathering, or writing something of moderate length",
  // demanding
  "careful judgement",
  "weighing options",
  "planning around several constraints",
  "getting something consequential right",
  // the planner's wording
  "one short message someone wrote for themselves",
  "Which line below describes what the message says",
  "Which line below fits it best",
  "Which label below names what the message is",
  "Answer with one letter and nothing else",
];

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The planner's system prompt at a fixed clock, split into the lines that say something. */
function plannerLines(): string[] {
  const [system] = complexityMessages("", { now: new Date(0) });
  return (system?.content ?? "")
    .split("\n")
    .map((l) => l.replace(/^[A-Z]\s*=\s*/, "").trim())
    .filter((l) => wordCount(l) >= 4);
}

/**
 * Every rubric phrase the text contains — the frozen list, the live class
 * descriptions and the live planner wording. Empty is the only acceptable
 * answer for a prompt that is about to be sent.
 */
export function rubricLeaks(text: string): string[] {
  const hay = normalise(text);
  const candidates = new Set<string>([...RUBRIC_PHRASES, ...COMPLEXITY.map((c) => c.description), ...plannerLines()]);
  const found: string[] = [];
  for (const phrase of candidates) {
    const needle = normalise(phrase);
    if (needle !== "" && hay.includes(needle)) found.push(phrase);
  }
  return found;
}

/** The guard every request passes before it is sent. Throws; nothing is dialled. */
export function assertNoRubric(...texts: readonly string[]): void {
  const leaks = texts.flatMap((t) => rubricLeaks(t));
  if (leaks.length > 0) throw new RubricLeakError([...new Set(leaks)]);
}

// ---- the prompts: class names and structural rules only ----------------------------------------

/** §7.2's D08 description, which the writer IS told — it is a structural rule of the set, not a class description. */
export const D08_RULE = "terse, operational replanning under several constraints";

export interface WriterRequest {
  label: Complexity;
  count: number;
  /** `simple` only: how many of the items must run longer than 40 words */
  longMin?: number;
  /** `demanding` only: how many must be 8 words or fewer */
  shortMin?: number;
  /** `demanding` only: how many are D08-class, marked `d08: true` */
  d08?: number;
}

const quoteNames = (): string => COMPLEXITY_NAMES.map((n) => `"${n}"`).join(", ");

/**
 * The writer's instructions for one class. It is told the three names, which
 * one to write, and the structural rules; it is told in so many words that no
 * definitions are given. Realism comes from the frame — a person writing to
 * their own assistant about their own life and work — and from being asked to
 * vary topic, tone and length, with length tied to nothing.
 */
export function writerPrompt(req: WriterRequest): { system: string; user: string } {
  const others = COMPLEXITY_NAMES.filter((n) => n !== req.label).map((n) => `"${n}"`);
  const system = [
    "You write realistic test messages: the things one person actually types to their own personal assistant about their own life and work —",
    "calendar, mail, notes, tasks, errands, travel, money, home, health, people, reading, projects, and so on. First person, as typed, no greeting or sign-off.",
    `Every message belongs to exactly one of three classes, named ${quoteNames()}. Use your own understanding of those words: no definitions are given, on purpose.`,
    "Vary the topic, the tone and the length widely from message to message. Length must carry no information about the class: within a class, write some messages of a few words and some of several sentences.",
    'Reply with JSON only, in this shape: {"items": [{"text": "<the message>", "d08": <true or false>}, ...]}. Set "d08" to false unless told otherwise.',
  ].join("\n");
  const rules: string[] = [];
  if (req.longMin) rules.push(`At least ${req.longMin} of them must run longer than ${LONG_SIMPLE_MIN_WORDS - 1} words while still being "${req.label}".`);
  if (req.shortMin) rules.push(`At least ${req.shortMin} of them must be ${SHORT_DEMANDING_MAX_WORDS} words or fewer while still being "${req.label}".`);
  if (req.d08) rules.push(`Exactly ${req.d08} of them must be ${D08_RULE} — a plan already in motion that has to change, said tersely, with the constraints in the message. Mark those "d08": true and every other item "d08": false.`);
  const user = [
    `Write ${req.count} different messages a person would send their assistant, every one of which you would call "${req.label}" rather than ${others.join(" or ")}.`,
    ...rules,
    "No two messages may share a subject and a phrasing. Do not number them and do not explain them.",
  ].join("\n");
  return { system, user };
}

/**
 * The relabeller's instructions: the names alone, every item at once in a
 * numbered list, no hint of what the writer was asked for. The items arrive
 * shuffled across classes, so the order says nothing either.
 */
export function relabelPrompt(items: readonly string[]): { system: string; user: string } {
  const system = [
    "You read messages a person sent to their own personal assistant and sort each one into exactly one of three classes,",
    `named ${quoteNames()}. Use your own understanding of those words: no definitions are given, on purpose. Judge each message on its own.`,
    'Reply with JSON only, in this shape: {"labels": [{"i": <the item number>, "label": "<one of the three names>"}, ...]}, one entry per item, every item answered.',
  ].join("\n");
  const user = items.map((t, i) => `${i + 1}. ${JSON.stringify(t)}`).join("\n");
  return { system, user };
}

// ---- the call --------------------------------------------------------------------------------

/** A writer call carries fifty-odd messages; a batch of relabels, twenty. Three minutes is a hung server, not a slow one. */
export const GEN_CALL_TIMEOUT_MS = 180_000; // limit: fixed — a wall-clock ceiling on one generation call, not a tunable

const WriterReply = z.object({ items: z.array(z.object({ text: z.string(), d08: z.boolean().optional() })) });
const RelabelReply = z.object({ labels: z.array(z.object({ i: z.number().int(), label: z.string() })) });

export interface ChatJsonOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  fetchFn: typeof fetch;
  temperature: number;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs?: number | undefined;
  /** the user message is the writer's own items quoted back (the relabel batch): data, not instructions, so it is not what the rubric guard is for */
  userIsData?: boolean | undefined;
}

/**
 * One POST to `<base>/chat/completions`, as the judge makes it: plain `fetch`,
 * `response_format: json_schema` sent and then not trusted — the reply is
 * parsed and validated by the caller. The rubric guard runs here, on the
 * exact instruction strings about to leave the machine: both messages of a
 * writer call, the system message of a relabel call (its user message is the
 * generated items themselves, and a message a person might write can say
 * "weighing options" without being the rubric).
 */
export async function chatJson(opts: ChatJsonOptions, system: string, user: string): Promise<unknown> {
  if (opts.userIsData) assertNoRubric(system);
  else assertNoRubric(system, user);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await opts.fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts.temperature,
      response_format: { type: "json_schema", json_schema: { name: opts.schemaName, strict: true, schema: opts.schema } },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? GEN_CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${opts.model} returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${opts.model} returned no message content`);
  try {
    return JSON.parse(stripFence(content));
  } catch (err) {
    throw new Error(`${opts.model} did not answer with JSON (${err instanceof Error ? err.message : String(err)}): ${content.slice(0, 200)}`);
  }
}

const WRITER_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, d08: { type: "boolean" } }, required: ["text", "d08"], additionalProperties: false } } },
  required: ["items"],
  additionalProperties: false,
};

const RELABEL_SCHEMA = {
  type: "object",
  properties: { labels: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, label: { type: "string", enum: [...COMPLEXITY_NAMES] } }, required: ["i", "label"], additionalProperties: false } } },
  required: ["labels"],
  additionalProperties: false,
};

// ---- the run ---------------------------------------------------------------------------------

/** One message as the writer produced it and the relabeller read it. */
export interface GeneratedItem {
  text: string;
  /** the class the writer was asked for */
  writer: Complexity;
  d08: boolean;
  /** the relabeller's blind class; `null` when it answered nothing for this item */
  relabel: Complexity | null;
}

export type Disposition = "kept" | "accepted" | "pile" | "dropped";

/** A pile row is a fixture with its label still to be written: `"?"` is refused by the fixture loader, so an unadjudicated row can never be scored by accident. */
export const ADJUDICATE_LABEL = "?";

export interface AdjudicationRow {
  id: string;
  text: string;
  label: typeof ADJUDICATE_LABEL;
  source: "generated";
  d08?: true;
  notes: string;
}

export interface GenerateOptions {
  config: GeneratorConfig;
  fetchFn?: typeof fetch | undefined;
  /** items asked of the writer per class (the D08-class ones come on top) */
  perClass?: number | undefined;
  /** D08-class `demanding` items asked for — every one goes to the owner's pile */
  d08?: number | undefined;
  /** the pile's ceiling; D08-class items always fit, disagreements fill what is left */
  maxAdjudicate?: number | undefined;
  /** the shuffle, so a replay walks the same order */
  seed?: number | undefined;
  relabelBatch?: number | undefined;
  timeoutMs?: number | undefined;
  onProgress?: ((line: string) => void) | undefined;
}

export const GENERATE_DEFAULTS = {
  perClass: 56,
  d08: 8,
  maxAdjudicate: 20, // limit: fixed — the owner's attention: "cap ~20" (2026-10-04)
  seed: 1,
  relabelBatch: 20,
} as const;

export interface GenerateStats {
  writer: string;
  relabeller: string;
  seed: number;
  asked: Record<Complexity, number>;
  written: Record<Complexity, number>;
  /** writer class → relabeller class → n (`null` relabel counted under `unanswered`) */
  confusion: Record<Complexity, Record<Complexity, number>>;
  unanswered: number;
  agreement: number | null;
  agreement_by_class: Record<Complexity, number | null>;
  dispositions: Record<Disposition, number>;
  kept_by_class: Record<Complexity, number>;
  long_simple: number;
  short_demanding: number;
  pile_d08: number;
  pile_disagreements: number;
  /** Pearson r between word count and the kept label's order */
  length_r: number | null;
  fixture_set: FixtureSetSummary;
  /** what the owner has to do before the set can qualify */
  pending: string[];
  /** the generated set meets every requirement that does not wait on the owner, and the pile holds enough D08-class rows for the one that does */
  ok: boolean;
  duplicates_dropped: number;
}

export interface GenerateResult {
  kept: ComplexityFixture[];
  pile: AdjudicationRow[];
  dropped: GeneratedItem[];
  items: GeneratedItem[];
  stats: GenerateStats;
}

const ORDINAL: Record<Complexity, number> = Object.fromEntries(COMPLEXITY_NAMES.map((c, i) => [c, i])) as Record<Complexity, number>;
const isName = (v: unknown): v is Complexity => typeof v === "string" && (COMPLEXITY_NAMES as readonly string[]).includes(v);

/** mulberry32 — a seeded shuffle so `--replay` asks the relabeller the same batches the recording answered. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rnd = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The trap an item IS, from its words and label — never from what the writer was asked for. */
export function trapOf(label: Complexity, text: string): ComplexityFixture["trap"] {
  const words = wordCount(text);
  if (label === "simple" && words >= LONG_SIMPLE_MIN_WORDS) return "long_simple";
  if (label === "demanding" && words <= SHORT_DEMANDING_MAX_WORDS) return "short_demanding";
  return undefined;
}

const pad = (n: number): string => String(n).padStart(3, "0");

/**
 * The whole run: write, shuffle, relabel, resolve, check. Pure over its
 * `fetchFn`, so a recording replays it exactly.
 */
export async function generateComplexityFixtures(opts: GenerateOptions): Promise<GenerateResult> {
  const cfg = opts.config;
  assertNotClaude(cfg.writer, "writer");
  assertNotClaude(cfg.relabeller, "relabeller");
  assertTwoFamilies(cfg.writer, cfg.relabeller);
  if (!cfg.baseUrl) throw new GeneratorModelError(`no base URL — set ${GEN_ENV.BASE_URL}, or pass --replay`);
  const perClass = opts.perClass ?? GENERATE_DEFAULTS.perClass;
  const d08Count = opts.d08 ?? GENERATE_DEFAULTS.d08;
  const maxAdjudicate = opts.maxAdjudicate ?? GENERATE_DEFAULTS.maxAdjudicate;
  const seed = opts.seed ?? GENERATE_DEFAULTS.seed;
  const batch = opts.relabelBatch ?? GENERATE_DEFAULTS.relabelBatch;
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.onProgress ?? (() => {});
  const call = (model: string, temperature: number, schemaName: string, schema: Record<string, unknown>, userIsData: boolean) => (system: string, user: string) =>
    chatJson({ baseUrl: cfg.baseUrl!, apiKey: cfg.apiKey, model, fetchFn, temperature, schemaName, schema, timeoutMs: opts.timeoutMs, userIsData }, system, user);
  const write = call(cfg.writer, 1, "items", WRITER_SCHEMA, false);
  const relabel = call(cfg.relabeller, 0, "labels", RELABEL_SCHEMA, true);

  // ---- write, class by class
  const trapMin = Math.ceil(perClass * FIXTURE_SET_BAR.trap_share) + 2; // headroom over the 10 %: an accepted disagreement or a pile row can take a trap with it
  const asked = {} as Record<Complexity, number>;
  const written = {} as Record<Complexity, number>;
  const items: GeneratedItem[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const label of COMPLEXITY_NAMES) {
    const req: WriterRequest = {
      label,
      count: label === "demanding" ? perClass + d08Count : perClass,
      ...(label === "simple" ? { longMin: trapMin } : {}),
      ...(label === "demanding" ? { shortMin: trapMin, d08: d08Count } : {}),
    };
    asked[label] = req.count;
    const { system, user } = writerPrompt(req);
    const reply = WriterReply.safeParse(await write(system, user));
    if (!reply.success) throw new Error(`the writer ${cfg.writer} answered the "${label}" request with the wrong shape: ${reply.error.issues.map((i) => i.message).join("; ")}`);
    let n = 0;
    for (const it of reply.data.items) {
      const text = it.text.trim();
      if (text === "") continue;
      const key = normalise(text);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      items.push({ text, writer: label, d08: label === "demanding" && it.d08 === true, relabel: null });
      n += 1;
    }
    written[label] = n;
    log(`writer  ${label.padEnd(9)} asked ${req.count}, wrote ${n}`);
  }

  // ---- relabel, blind, shuffled, in batches
  const order = shuffled(items, seed);
  for (let start = 0; start < order.length; start += batch) {
    const slice = order.slice(start, start + batch);
    const { system, user } = relabelPrompt(slice.map((i) => i.text));
    const reply = RelabelReply.safeParse(await relabel(system, user));
    if (!reply.success) throw new Error(`the relabeller ${cfg.relabeller} answered batch ${start / batch + 1} with the wrong shape: ${reply.error.issues.map((i) => i.message).join("; ")}`);
    let answered = 0;
    for (const l of reply.data.labels) {
      const item = slice[l.i - 1];
      if (!item || !isName(l.label) || item.relabel !== null) continue;
      item.relabel = l.label;
      answered += 1;
    }
    log(`relabel batch ${String(start / batch + 1).padStart(2)}  ${answered}/${slice.length} answered`);
  }

  // ---- resolve
  const kept: ComplexityFixture[] = [];
  const pile: AdjudicationRow[] = [];
  const dropped: GeneratedItem[] = [];
  const dispositions: Record<Disposition, number> = { kept: 0, accepted: 0, pile: 0, dropped: 0 };
  const toPile = (item: GeneratedItem, why: string): void => {
    const row: AdjudicationRow = {
      id: `gen-adj-${pad(pile.length + 1)}`,
      text: item.text,
      label: ADJUDICATE_LABEL,
      source: "generated",
      ...(item.d08 ? { d08: true as const } : {}),
      notes: `ADJUDICATE — writer: ${item.writer}; relabeller: ${item.relabel ?? "no answer"}. ${why} Replace "?" with your class, from the names alone, and append the line to complexity.generated.jsonl.`,
    };
    pile.push(row);
    dispositions.pile += 1;
  };
  // D08-class items first: §7.2 has the owner label each, so they always fit the pile.
  for (const item of order) if (item.d08) toPile(item, "D08-class: §7.2 has the owner label each of these before it is scored.");
  let keptN = 0;
  for (const item of order) {
    if (item.d08) continue;
    const r = item.relabel;
    if (r === item.writer) {
      kept.push(fixtureOf(item, ++keptN, item.writer, undefined, undefined));
      dispositions.kept += 1;
    } else if (r !== null && Math.abs(ORDINAL[r] - ORDINAL[item.writer]) === 1) {
      kept.push(fixtureOf(item, ++keptN, item.writer, [r], `writer: ${item.writer}; relabeller: ${r} — adjacent, kept as accept`));
      dispositions.accepted += 1;
    } else if (pile.length < maxAdjudicate) {
      toPile(item, r === null ? "The relabeller gave no class for it." : "The two models are two classes apart.");
    } else {
      dropped.push(item);
      dispositions.dropped += 1;
    }
  }

  // ---- count
  const confusion = Object.fromEntries(COMPLEXITY_NAMES.map((w) => [w, Object.fromEntries(COMPLEXITY_NAMES.map((r) => [r, 0]))])) as Record<Complexity, Record<Complexity, number>>;
  let unanswered = 0;
  for (const it of items) {
    if (it.relabel === null) unanswered += 1;
    else confusion[it.writer][it.relabel] += 1;
  }
  const answered = items.filter((i) => i.relabel !== null);
  const agree = answered.filter((i) => i.relabel === i.writer).length;
  const agreement_by_class = Object.fromEntries(
    COMPLEXITY_NAMES.map((c) => {
      const of = answered.filter((i) => i.writer === c);
      return [c, of.length === 0 ? null : of.filter((i) => i.relabel === c).length / of.length];
    }),
  ) as Record<Complexity, number | null>;
  const kept_by_class = Object.fromEntries(COMPLEXITY_NAMES.map((c) => [c, kept.filter((f) => f.label === c).length])) as Record<Complexity, number>;
  const set = checkFixtureSet(kept);
  const length_r = pearson(
    kept.map((f) => wordCount(f.text)),
    kept.map((f) => ORDINAL[f.label]),
  );
  const pile_d08 = pile.filter((p) => p.d08).length;
  const pending: string[] = [];
  if (pile.length > 0) pending.push(`label the ${pile.length} row(s) in the adjudication pile (${pile_d08} D08-class) and append them to complexity.generated.jsonl — the D08 requirement (≥ ${FIXTURE_SET_BAR.min_d08}) counts only after that`);
  const unmet = set.requirements.filter((r) => !r.pass && !/D08/.test(r.requirement));
  if (pile_d08 > maxAdjudicate) pending.push(`${pile_d08} D08-class rows exceed the pile's cap of ${maxAdjudicate} on their own — they are all there (§7.2 needs each labelled), and no disagreement was taken`);
  const ok = unmet.length === 0 && pile_d08 >= FIXTURE_SET_BAR.min_d08;
  return {
    kept,
    pile,
    dropped,
    items,
    stats: {
      writer: cfg.writer,
      relabeller: cfg.relabeller,
      seed,
      asked,
      written,
      confusion,
      unanswered,
      agreement: answered.length === 0 ? null : agree / answered.length,
      agreement_by_class,
      dispositions,
      kept_by_class,
      long_simple: kept.filter((f) => f.trap === "long_simple").length,
      short_demanding: kept.filter((f) => f.trap === "short_demanding").length,
      pile_d08,
      pile_disagreements: pile.length - pile_d08,
      length_r,
      fixture_set: set,
      pending,
      ok,
      duplicates_dropped: duplicates,
    },
  };
}

function fixtureOf(item: GeneratedItem, n: number, label: Complexity, accept: Complexity[] | undefined, notes: string | undefined): ComplexityFixture {
  const trap = trapOf(label, item.text);
  return {
    id: `gen-${pad(n)}`,
    text: item.text,
    label,
    ...(accept ? { accept } : {}),
    ...(trap ? { trap } : {}),
    source: "generated",
    ...(notes ? { notes } : {}),
  };
}

// ---- the files and the report -------------------------------------------------------------------

/** One row per line, keys in a stable order, a header comment the loader skips. */
export function serialiseFixtures(rows: readonly (ComplexityFixture | AdjudicationRow)[], header: string): string {
  return [`# ${header}`, ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
}

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

/**
 * The recording that makes a run reproducible — `--record` wrote it or
 * `--replay` read it — named by path and sha256 in the report, beside the two
 * model ids and the seed. A run with neither is said to be unreproducible:
 * `--force` lets the owner regenerate under other seeds and models until a
 * set passes, and the report is where that would show.
 */
export interface RecordingRef {
  path: string;
  sha256: string;
}

export function renderGenerateReport(r: GenerateResult, opts: { at?: Date; replay?: boolean; fixturesPath: string; pilePath: string; recording?: RecordingRef | null }): string {
  const s = r.stats;
  const out: string[] = [];
  out.push("# Generated complexity fixtures — the stats report");
  out.push("");
  out.push(`${(opts.at ?? new Date()).toISOString()} · writer \`${s.writer}\` · blind relabeller \`${s.relabeller}\` · seed ${s.seed}${opts.replay ? " · **replayed from a recording**" : ""}`);
  out.push(
    opts.recording
      ? `Recording: \`${opts.recording.path}\` sha256 \`${opts.recording.sha256}\` — this run is reproducible from it with \`--replay\`; a set regenerated under another seed or model is a different run and carries a different hash.`
      : "No recording: this run cannot be reproduced. Pass `--record <file>` so the set you keep can be traced to the responses that produced it.",
  );
  out.push("");
  out.push(`Neither model saw the class descriptions or the planner's wording: every prompt was checked against the frozen rubric phrases before it was sent (docs/ops/dynamic-router.md §7.2, C11). Every kept row carries \`source: "generated"\`; \`metistry-eval complexity\` holds it to the bar apart from anything you wrote.`);
  out.push("");
  out.push("## What was written");
  out.push("");
  out.push("| Class | Asked | Written | Agreement (relabeller said the same) |");
  out.push("| --- | ---: | ---: | ---: |");
  for (const c of COMPLEXITY_NAMES) out.push(`| ${c} | ${s.asked[c]} | ${s.written[c]} | ${pct(s.agreement_by_class[c])} |`);
  out.push(`| **all** | ${Object.values(s.asked).reduce((a, b) => a + b, 0)} | ${Object.values(s.written).reduce((a, b) => a + b, 0)} | ${pct(s.agreement)} |`);
  out.push("");
  if (s.duplicates_dropped > 0) out.push(`${s.duplicates_dropped} duplicate message(s) from the writer were dropped before relabelling.`);
  if (s.unanswered > 0) out.push(`${s.unanswered} item(s) the relabeller gave no class; each went to the pile or was dropped — never kept.`);
  out.push("");
  out.push("## Writer's class ↓, relabeller's blind class →");
  out.push("");
  out.push(`| | ${COMPLEXITY_NAMES.join(" | ")} |`);
  out.push(`| --- | ${COMPLEXITY_NAMES.map(() => "---:").join(" | ")} |`);
  for (const w of COMPLEXITY_NAMES) out.push(`| **${w}** | ${COMPLEXITY_NAMES.map((x) => String(s.confusion[w][x])).join(" | ")} |`);
  out.push("");
  out.push("## Where every item went");
  out.push("");
  out.push("| Disposition | n | |");
  out.push("| --- | ---: | --- |");
  out.push(`| kept — both models agree | ${s.dispositions.kept} | label as written |`);
  out.push(`| kept with \`accept\` — adjacent disagreement | ${s.dispositions.accepted} | the writer's label, the relabeller's as \`accept\`, both in \`notes\` |`);
  out.push(`| adjudication pile — yours to label | ${s.dispositions.pile} | ${s.pile_d08} D08-class (§7.2: you label each) + ${s.pile_disagreements} the models put two classes apart or left unlabelled |`);
  out.push(`| dropped — pile full | ${s.dispositions.dropped} | kept under no label at all |`);
  out.push("");
  out.push(`Kept: ${COMPLEXITY_NAMES.map((c) => `${c} ${s.kept_by_class[c]}`).join(" · ")} → \`${opts.fixturesPath}\`. Pile → \`${opts.pilePath}\`.`);
  out.push("");
  out.push("## The set, against §7.2 (the kept rows, before your adjudication)");
  out.push("");
  out.push("| Requirement | Needed | Have | |");
  out.push("| --- | --- | --- | --- |");
  for (const q of s.fixture_set.requirements) out.push(`| ${q.requirement.replace(/\|/g, "\\|")} | ${q.needed} | ${q.have} | ${q.pass ? "PASS" : /D08/.test(q.requirement) && s.pile_d08 >= FIXTURE_SET_BAR.min_d08 ? `PENDING (${s.pile_d08} in the pile)` : "FAIL"} |`);
  out.push("");
  out.push(`Length against label: r = ${s.length_r === null ? "— (no variance)" : s.length_r.toFixed(3)} (|r| must stay under ${FIXTURE_SET_BAR.max_abs_length_r}).`);
  out.push("");
  out.push("## What is yours to do");
  out.push("");
  if (s.pending.length === 0) out.push("Nothing: the set qualifies as written.");
  for (const p of s.pending) out.push(`- ${p}`);
  out.push(`- spot-check \`${opts.fixturesPath}\`: a label you disagree with is yours to change (the file is yours once written), and the row's \`notes\` say what each model said`);
  out.push("");
  out.push(`**${s.ok ? "OK" : "NOT OK"} — ${s.ok ? "every requirement that does not wait on you holds, and the pile fits its cap" : "see the FAIL rows above; rerun with another seed or model, or widen --per-class"}.**`);
  return out.join("\n");
}
