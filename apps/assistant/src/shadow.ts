// Stage-2 shadow mode (docs/plan-refresh-2026-09-13.md §3.7 stage 2, PR 3's
// last piece). The question it exists to answer is the promotion gate's:
// "would the candidate have done the same thing on my real traffic?" — asked
// without ever risking a real answer on it.
//
// The shape, and why each half is a control rather than a promise:
//
// - AFTER, NEVER INSTEAD. The shadow runs once the real turn has finished and
//   its session is saved. The user's answer is `TurnResult.text`, which is
//   always the assignment's model; the candidate's answer is
//   `TurnResult.shadow`, which the drain stores and nothing renders. Invariant
//   4 is untouched: `shadow:` cannot change which model answers, only which
//   model is measured.
// - TOOLS ARE STUBBED RECORD-ONLY, BY CONSTRUCTION. `shadowToolHost` is
//   handed a tool LIST and a map of results the real run already got. It has
//   no MCP client, no URL and no token — there is no object in scope it could
//   execute a call against, which is the only honest way to promise that a
//   shadow of a turn that wrote to the vault does not write to the vault
//   twice. A call the real run made identically gets that real result (so the
//   candidate's next step is judged against the same facts); anything else
//   gets one fixed string.
// - IT CANNOT BREAK THE TURN. `runShadow` never throws: a missing credential,
//   a provider that is down, a model that does not exist — each comes back as
//   a ShadowRun carrying `error`, and the real turn has already happened.
// - AGREEMENT IS CHEAP AND DETERMINISTIC. Same tool-call names in the same
//   order, plus token Jaccard over the two final answers. That is all it
//   claims to be: a number two weeks of runs can be averaged over (stage 3's
//   gate). The RUBRIC score is `packages/eval`'s, on the owner's fixtures,
//   and it is a hook here (`ShadowRubric`) rather than a second scorer
//   invented in the engine.

import type { CostSource, ResolvedAssignment, ResolvedShadow } from "@foldedspacelabs/metistry-core";
import { finishRun, startRun } from "@foldedspacelabs/metistry-core";
import type { ChatClient, ChatResponse } from "./engine-openai.js";
import type { ChatMessage } from "./sessions.js";
import { toolCallKey, type ToolHost, type ToolSpec } from "./tools.js";

/** The `runs.kind` a shadow's own spend lands under — one word to query for "what has the experiment cost". */
export const SHADOW_KIND = "shadow";

/** What a stubbed tool call returns when the real run never made it. Fixed, so a model cannot tell one stub from another and improvise around it. */
export const SHADOW_STUB_RESULT =
  "(recorded, not executed: this is a shadow comparison run — its tool calls are written down and never performed. Assume the call succeeded and continue.)";

/** One tool call the shadow made. `executed` is a constant because the type is also the claim: nothing here ran. */
export interface ShadowToolRecord {
  name: string;
  args: Record<string, unknown>;
  executed: false;
  /** `real_run` = the real turn made this exact call and its result was handed over; `stub` = the fixed string above. */
  result_from: "real_run" | "stub";
}

/** The deterministic measure. Cheap on purpose: the rubric is `packages/eval`'s job, and `score` is not pretending to be it. */
export interface ShadowAgreement {
  /** 0..1 — the mean of the two below, which is the number the weekly review averages. */
  score: number;
  /** the same tool names in the same order (arguments excluded: a different search phrasing for the same step is agreement) */
  tool_sequence: boolean;
  /** token Jaccard over the two final answers, 0..1 */
  answer_similarity: number;
}

/**
 * What lands on the `runs` row: BOTH transcripts and the measure over them.
 * One object, one `shadow_transcript` column, so the comparison can be re-read
 * later without joining anything.
 */
export interface ShadowRun {
  shadow: {
    provider: string;
    model: string;
    /** the candidate's answer. NEVER shown: the drain writes `TurnResult.text`, and this is not it. */
    text: string;
    /** the messages the candidate ADDED. The prefix it was given is the same turn's, and is the head of `real.messages` — storing it twice would only make the row bigger. */
    messages: ChatMessage[];
    tool_calls: ShadowToolRecord[];
    turns: number;
    stopped?: "max_turns";
    /** the shadow failed. The real turn had already finished — this is a note, never a turn failure. */
    error?: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    cost_source: CostSource;
  };
  real: {
    provider: string;
    model: string;
    text: string;
    messages: ChatMessage[];
    tool_calls: string[];
  };
  agreement: ShadowAgreement;
  /** `packages/eval`'s rubric score, when a scorer is wired in. Absent today — see `ShadowRubric`. */
  rubric_score?: number;
}

/**
 * THE HOOK, deliberately not an implementation. Stage 3's gate is "≥ the bar
 * on the fixtures AND two weeks of shadow agreement", and the first half is
 * `packages/eval`'s rubric on the owner's own fixtures (§3.8) — a second
 * rubric invented in the engine would be a different number wearing the same
 * name. When that scorer exists it is passed in here; until then the row
 * carries the deterministic measure and says nothing it cannot prove.
 */
export type ShadowRubric = (run: ShadowRun) => Promise<number | undefined>;

/** Should this turn be shadowed? The one place the fraction is read. */
export function shouldShadow(shadow: ResolvedShadow | undefined, random: () => number): boolean {
  if (!shadow || shadow.fraction <= 0) return false;
  if (shadow.fraction >= 1) return true;
  return random() < shadow.fraction;
}

/**
 * Token Jaccard: |A ∩ B| / |A ∪ B| over lowercased alphanumeric tokens.
 *
 * Not a semantic score, and not sold as one. It is stable, needs no model,
 * and moves in the direction that matters — two answers that say the same
 * things in the same words score high, an answer that wandered off scores
 * low. Two empty answers are identical (1); one empty and one not is 0.
 */
export function tokenJaccard(a: string, b: string): number {
  const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ""));
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return round(shared / (A.size + B.size - shared));
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The measure, over the two sides. Pure, so the weekly review's number can be reproduced from the stored row. */
export function agreementOf(real: { text: string; tool_calls: readonly string[] }, shadow: { text: string; tool_calls: readonly string[] }): ShadowAgreement {
  const tool_sequence = real.tool_calls.length === shadow.tool_calls.length && real.tool_calls.every((n, i) => n === shadow.tool_calls[i]);
  const answer_similarity = tokenJaccard(real.text, shadow.text);
  return { score: round(((tool_sequence ? 1 : 0) + answer_similarity) / 2), tool_sequence, answer_similarity };
}

/**
 * The record-only tool surface. A `ToolHost` by shape, so the loop needs no
 * special case — and an EMPTY one by capability: it closes over a list of
 * names and a map of strings, and there is no client, URL or token in scope
 * for it to call anything with.
 */
export function shadowToolHost(tools: readonly ToolSpec[], recorded: ReadonlyMap<string, string>): ToolHost & { readonly calls: ShadowToolRecord[] } {
  const calls: ShadowToolRecord[] = [];
  return {
    calls,
    async list() {
      return [...tools]; // the same surface the real run saw: a candidate judged on a smaller toolbox is not being judged on this turn
    },
    async call(name, args) {
      const real = recorded.get(toolCallKey(name, args));
      calls.push({ name, args, executed: false, result_from: real === undefined ? "stub" : "real_run" });
      return { text: real ?? SHADOW_STUB_RESULT, isError: false };
    },
    async close() {},
  };
}

export interface ShadowInput {
  /** Built lazily so a missing credential is a shadow error rather than an exception on the real turn's path. */
  makeClient: () => ChatClient;
  candidate: ResolvedShadow;
  assignment: ResolvedAssignment;
  /** System prompt + the turn's history as it was BEFORE the real loop ran: the same turn, not a summary of it. */
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  /** The real run's (name, arguments) → result map, keyed by `toolCallKey`. */
  recorded: ReadonlyMap<string, string>;
  real: { text: string; tool_calls: readonly string[]; messages: readonly ChatMessage[] };
  maxTurns: number;
  rubric?: ShadowRubric | undefined;
}

/**
 * Re-run one turn on the candidate. Never throws, never writes, never speaks
 * to the user: the whole of its output is a `ShadowRun` for the row.
 */
export async function runShadow(input: ShadowInput): Promise<ShadowRun> {
  const { candidate, real } = input;
  const host = shadowToolHost(input.tools, input.recorded);
  const messages: ChatMessage[] = [...input.messages];
  const transcript: ChatMessage[] = [];
  let tokens_in = 0;
  let tokens_out = 0;
  let cost_usd = 0;
  let cost_source: CostSource = "unknown";
  let turns = 0;
  let text = "";
  let stopped: "max_turns" | undefined;
  let error: string | undefined;

  const account = (r: ChatResponse): void => {
    tokens_in += r.usage.tokens_in;
    tokens_out += r.usage.tokens_out;
    cost_usd += r.cost.cost_usd;
    cost_source = r.cost.source;
  };
  const push = (m: ChatMessage): void => {
    messages.push(m);
    transcript.push(m);
  };

  try {
    const client = input.makeClient();
    const tools = await host.list();
    while (turns < input.maxTurns) {
      turns++;
      const res = await client.chat(messages, { tools, toolChoice: "auto" });
      account(res);
      push(res.message);
      if (res.toolCalls.length === 0) {
        text = res.text;
        break;
      }
      for (const call of res.toolCalls) {
        const out = await host.call(call.name, call.args);
        push({ role: "tool", tool_call_id: call.id, name: call.name, content: out.text });
      }
    }
    // Out of turns: the same graceful ending the real loop gets, so the two
    // answers being compared were produced under the same rules.
    if (!text) {
      stopped = "max_turns";
      push({ role: "user", content: "You have run out of tool turns. Answer now with what you have, and say what is still open." });
      const final = await client.chat(messages, { toolChoice: "none" });
      account(final);
      push(final.message);
      text = final.text;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const run: ShadowRun = {
    shadow: {
      provider: candidate.provider,
      model: candidate.model,
      text,
      messages: transcript,
      tool_calls: host.calls,
      turns,
      ...(stopped ? { stopped } : {}),
      ...(error !== undefined ? { error } : {}),
      tokens_in,
      tokens_out,
      cost_usd: Math.round(cost_usd * 1e6) / 1e6,
      cost_source,
    },
    real: {
      provider: input.assignment.provider,
      model: input.assignment.model,
      text: real.text,
      messages: [...real.messages],
      tool_calls: [...real.tool_calls],
    },
    agreement: agreementOf(real, { text, tool_calls: host.calls.map((c) => c.name) }),
  };
  // The rubric hook. Absent today (see ShadowRubric) and it may not break the
  // turn either — a scorer that throws costs the row its rubric column, not
  // the comparison.
  if (input.rubric) {
    try {
      const score = await input.rubric(run);
      if (typeof score === "number") run.rubric_score = score;
    } catch {
      /* the deterministic measure stands on its own */
    }
  }
  return run;
}

// ---- what lands in the database ----------------------------------------------

export interface ShadowDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Two writes, for two different readers:
 *
 * 1. the TURN's row gains the shadow columns (0020) — provider, model, both
 *    transcripts, the agreement, and the shadow's cost denormalised for the
 *    report;
 * 2. the shadow's SPEND becomes its own `runs` row, kind `shadow`, carrying
 *    the shadow provider's name. That is what makes "shadow spend counts
 *    against budgets like any run" true with no change to `spend.yaml`: the
 *    money is attributed to the provider that was actually paid, rather than
 *    added to the turn's own cost where a per-provider budget would read it
 *    against the wrong provider.
 */
export async function recordShadow(db: ShadowDb, runId: number, run: ShadowRun, ctx: { component?: string; tier?: string | undefined } = {}): Promise<number> {
  await db.query(
    `UPDATE runs SET shadow_provider = $2, shadow_model = $3, shadow_transcript = $4::jsonb, shadow_agreement = $5, shadow_cost_usd = $6 WHERE id = $1`,
    [runId, run.shadow.provider, run.shadow.model, JSON.stringify(run), run.agreement.score, run.shadow.cost_usd],
  );
  const id = await startRun(db, {
    component: ctx.component ?? "assistant",
    kind: SHADOW_KIND,
    provider: run.shadow.provider,
    model: run.shadow.model,
    meta: {
      shadow_of: runId,
      ...(ctx.tier ? { tier: ctx.tier } : {}),
      real_provider: run.real.provider,
      real_model: run.real.model,
      agreement: run.agreement.score,
      tool_sequence: run.agreement.tool_sequence,
      answer_similarity: run.agreement.answer_similarity,
      cost_source: run.shadow.cost_source,
      ...(run.rubric_score !== undefined ? { rubric_score: run.rubric_score } : {}),
    },
  });
  await finishRun(db, id, {
    ok: run.shadow.error === undefined,
    ...(run.shadow.error !== undefined ? { error: run.shadow.error } : {}),
    tokens_in: run.shadow.tokens_in,
    tokens_out: run.shadow.tokens_out,
    cost_usd: run.shadow.cost_usd,
  });
  return id;
}
