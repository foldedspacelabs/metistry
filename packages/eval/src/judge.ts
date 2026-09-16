// The judge (§3.2, Atomic ADOPT 6).
//
// Three axes out of five are judgment and voice, and there is no way to score
// those in code. The rule that makes a rubric score mean anything:
//
//   * the judge is from a THIRD model family — neither the candidate's nor
//     the bar's, so nothing marks its own homework. The bar is Claude, so a
//     Claude judge is refused for every candidate, and a candidate judged by
//     its own family is refused too;
//   * an ABSENT judge fails the RUN, not the case. A harness that quietly
//     scores rubric axes as passes when no judge is configured would report a
//     local model at the bar's level on the strength of a missing API key;
//   * a judge that is configured but UNREACHABLE fails the CASE, with the
//     reason on the row. Same principle, one level down: the case is not
//     scored, so it cannot pass.
//
// Both refusals are named errors, and both name what would permit them (R3).

import { z } from "zod";
import { RUBRIC_PASS, type Fixture } from "./fixtures.js";
import type { Candidate, JudgeVerdict } from "./record.js";

/** Bare model ids with no `<family>/` prefix — a local server's own catalogue naming. The prefix is checked first; this is the fallback. */
const FAMILY_HINTS: readonly [RegExp, string][] = [
  [/^claude/, "anthropic"],
  [/^(gpt|o[1-9]|chatgpt|davinci)/, "openai"],
  [/^(gemini|gemma)/, "google"],
  [/^(qwen|qwq)/, "qwen"],
  [/^(llama|codellama)/, "meta"],
  [/^deepseek/, "deepseek"],
  [/^(mistral|mixtral|magistral|devstral|codestral)/, "mistral"],
  [/^(kimi|moonshot)/, "moonshot"],
  [/^granite/, "ibm"],
  [/^phi/, "microsoft"],
  [/^(command|cohere)/, "cohere"],
  [/^(nova|titan)/, "amazon"],
  [/^(glm|chatglm)/, "zhipu"],
];

/**
 * The family a model id belongs to. The segment before `/` when there is one
 * (`anthropic/claude-sonnet-5` → `anthropic`) — which is OpenRouter's own
 * naming and therefore the common case — and otherwise a small map over the
 * bare id, with the local servers' tag and quant suffixes stripped first
 * (`qwen3.6:35b-a3b-q4_K_M` → `qwen3.6` → `qwen`).
 *
 * An id this cannot place resolves to the id itself, lowercased: an unknown
 * family is never accidentally EQUAL to another unknown one, so the
 * third-family rule fails safe — it refuses nothing it should not, and the
 * one thing it must catch (a judge from the candidate's own family, spelled
 * the same way) it always catches.
 */
export function familyOf(model: string): string {
  const id = model.trim().toLowerCase();
  if (id === "") return "";
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  const bare = id.split(":")[0]!;
  for (const [pattern, family] of FAMILY_HINTS) if (pattern.test(bare)) return family;
  return bare;
}

export class JudgeNotConfiguredError extends Error {
  readonly code = "judge_not_configured";
  constructor(rubricCases: number) {
    super(
      `${rubricCases} fixture(s) are rubric-scored and no judge is configured — an absent judge FAILS the run rather than passing the cases (docs/plan-refresh-2026-09-13.md §3.2). ` +
        `Set METISTRY_EVAL_JUDGE_MODEL and METISTRY_EVAL_JUDGE_BASE_URL (and METISTRY_EVAL_JUDGE_API_KEY where the endpoint needs one), or run only the deterministic axes with --axis tool_calls --axis stopping.`,
    );
    this.name = "JudgeNotConfiguredError";
  }
}

export class JudgeFamilyError extends Error {
  readonly code = "judge_same_family";
  constructor(
    readonly judgeModel: string,
    readonly clashesWith: string,
    readonly role: "candidate" | "bar",
  ) {
    super(
      `the judge ${judgeModel} is from the same family as the ${role} (${clashesWith}: family "${familyOf(judgeModel)}") — a rubric score is only worth something from a third family (Atomic ADOPT 6). ` +
        `Name a judge from a different family in METISTRY_EVAL_JUDGE_MODEL.`,
    );
    this.name = "JudgeFamilyError";
  }
}

export interface JudgeConfig {
  model: string;
  /** Overrides `familyOf(model)` for an id the map cannot place. */
  family?: string | undefined;
}

/**
 * The rule, in one place. Called once before a run starts, so a misconfigured
 * judge costs nothing rather than being discovered on the fiftieth case.
 * `bar` is the bar candidate's model id where the run knows it.
 */
export function assertThirdFamily(judge: JudgeConfig, candidate: Pick<Candidate, "model">, bar?: string | undefined): void {
  const judgeFamily = judge.family ?? familyOf(judge.model);
  if (judgeFamily === familyOf(candidate.model)) throw new JudgeFamilyError(judge.model, candidate.model, "candidate");
  if (bar !== undefined && bar !== "" && judgeFamily === familyOf(bar)) throw new JudgeFamilyError(judge.model, bar, "bar");
}

// ---- the call -----------------------------------------------------------------

export interface JudgeRequest {
  fixture: Fixture;
  /** The candidate's answer, verbatim. Nothing else from the transcript — the rubric is about the answer. */
  answer: string;
}

/** Injected, so the runner's tests never dial anything. `openAiJudge` is the one implementation that does. */
export type JudgeFn = (req: JudgeRequest) => Promise<JudgeVerdict>;

const JudgeReply = z.object({ verdict: z.number().int().min(1).max(5), reason: z.string() });

/**
 * The judge's instructions. Deliberately short and free of the assistant's
 * name (CLAUDE.md: the name lives in `identity.yaml` and nowhere else) — the
 * rubric is the fixture's, in the owner's words, and the judge's only job is
 * to apply it and say why.
 */
export function judgePrompt(req: JudgeRequest): { system: string; user: string } {
  const system =
    "You score one answer against one rubric and reply with JSON only.\n" +
    "Output shape: {\"verdict\": <integer 1-5>, \"reason\": \"<one sentence>\"}.\n" +
    `5 means the rubric is fully met; ${RUBRIC_PASS} is the passing mark; 1 means it is not met at all.\n` +
    "Score only what the rubric asks about. Do not reward length, hedging, or restating the request.";
  const parts = [`## Rubric\n\n${req.fixture.expected.rubric ?? ""}`];
  if (req.fixture.context?.brief) parts.push(`## The brief the answer was written against\n\n${req.fixture.context.brief}`);
  if (req.fixture.context?.thread) parts.push(`## The thread so far\n\n${req.fixture.context.thread}`);
  parts.push(`## The request\n\n${req.fixture.prompt}`);
  parts.push(`## The answer to score\n\n${req.answer}`);
  return { system, user: parts.join("\n\n") };
}

export interface OpenAiJudgeOptions extends JudgeConfig {
  /** An OpenAI-compatible root — `https://openrouter.ai/api/v1`, `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  apiKey?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** Strip a ```json fence, which small models add however the schema was asked for. */
export function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

/**
 * One POST to `<base>/chat/completions`, `response_format: json_schema` sent
 * and then NOT trusted — the reply is parsed and validated, and a reply that
 * is not a verdict throws, which fails the case rather than scoring it.
 *
 * Plain `fetch`: an OpenAI-compatible base URL is already the abstraction an
 * SDK would sell (C4), and this harness adds no dependency the product does
 * not already carry.
 */
export function openAiJudge(opts: OpenAiJudgeOptions): JudgeFn {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const fetchFn = opts.fetchFn ?? fetch;
  const family = opts.family ?? familyOf(opts.model);
  return async (req) => {
    const { system, user } = judgePrompt(req);
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "verdict",
            strict: true,
            schema: {
              type: "object",
              properties: { verdict: { type: "integer", minimum: 1, maximum: 5 }, reason: { type: "string" } },
              required: ["verdict", "reason"],
              additionalProperties: false,
            },
          },
        },
      }),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (!res.ok) throw new Error(`judge ${opts.model} returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`judge ${opts.model} returned no message content`);
    let raw: unknown;
    try {
      raw = JSON.parse(stripFence(content));
    } catch (err) {
      throw new Error(`judge ${opts.model} did not answer with JSON (${err instanceof Error ? err.message : String(err)}): ${content.slice(0, 200)}`);
    }
    const parsed = JudgeReply.safeParse(raw);
    if (!parsed.success) throw new Error(`judge ${opts.model} answered with the wrong shape: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { model: opts.model, family, verdict: parsed.data.verdict, reason: parsed.data.reason };
  };
}

export interface JudgeFromEnv {
  judge: JudgeFn;
  config: JudgeConfig;
}

/**
 * The judge this install has, or `undefined`. Absent is not an error HERE —
 * it becomes one the moment a rubric fixture is selected (the runner throws
 * `JudgeNotConfiguredError`), so a deterministic-axes-only run needs no judge
 * at all.
 */
export function judgeFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): JudgeFromEnv | undefined {
  const model = (env.METISTRY_EVAL_JUDGE_MODEL ?? "").trim();
  const baseUrl = (env.METISTRY_EVAL_JUDGE_BASE_URL ?? "").trim();
  if (model === "" || baseUrl === "") return undefined;
  const family = (env.METISTRY_EVAL_JUDGE_FAMILY ?? "").trim() || undefined;
  const apiKey = (env.METISTRY_EVAL_JUDGE_API_KEY ?? "").trim() || undefined;
  const config: JudgeConfig = { model, ...(family ? { family } : {}) };
  return { judge: openAiJudge({ ...config, baseUrl, apiKey, fetchFn }), config };
}
