// The runner: fixture × candidate → one JSONL row (§3.2, §3.5, §3.7 stage 0).
//
// The engine is INJECTED, and the injection point is a factory taking the
// per-case tool host — `(host) => Engine` — because that is the shape
// `apps/assistant`'s own engine already has (`tools: (spec) => ToolHost` in
// its config). The harness therefore holds no opinion about how a turn is
// executed and adds no dependency on the assistant: a stage-0 script wires
// `makeOpenAiEngine` to it in about ten lines, and every test here runs
// against a fake engine with nothing listening.
//
// Three properties worth stating plainly:
//
//   * PARALLELISM IS 1 BY DEFAULT. The local half of this bake-off measures
//     tokens/s and TTFT on one machine with one model resident; two cases at
//     once would measure the queue instead. `--concurrency` exists for the
//     cloud rows, where it only costs money.
//   * RESUMABLE. The run file is the state. A (candidate, fixture) pair
//     already in it is skipped, so an interrupted run — a laptop that slept,
//     a rate limit, a model that had to be reloaded — continues rather than
//     restarting, and the same command is safe to re-run.
//   * A JUDGE THAT IS NOT THERE FAILS THINGS. No judge configured and a
//     rubric fixture selected → the RUN refuses to start. A judge that
//     throws mid-run → that CASE fails with the reason on the row. Neither
//     path can produce a pass (Atomic ADOPT 6).

import { composePrompt, type Axis, type Fixture } from "./fixtures.js";
import { assertThirdFamily, JudgeNotConfiguredError, familyOf, type JudgeConfig, type JudgeFn } from "./judge.js";
import { caseKey, type Candidate, type RunRecord } from "./record.js";
import { needsJudge, scoreCase, type Observation } from "./score.js";
import { recordingToolHost, type RecordingToolHost, type ToolDef } from "./tools.js";

/**
 * What one turn runs as — structurally the assistant's `TurnSpec`, narrowed
 * to the fields a fixture can set. Deliberately not imported: `packages/`
 * never depends on `apps/` (CLAUDE.md), and the harness must build against
 * the interface whether or not the engine has landed.
 */
export interface EvalTurnSpec {
  model: string;
  effort: "low" | "medium" | "high";
  thread?: string | undefined;
  tier?: string | undefined;
  maxTurns?: number | undefined;
}

/** Structurally the assistant's `TurnResult`, plus the trace counters an engine may report. Everything optional is `null` in the row when absent. */
export interface EvalTurnResult {
  text: string;
  session_id: string;
  tokens_in?: number | undefined;
  tokens_out?: number | undefined;
  cost_usd?: number | undefined;
  turns?: number | undefined;
  stopped?: "max_turns" | "max_budget" | "veto" | undefined;
  /** Time to first token, where the engine measured it. */
  ttft_ms?: number | undefined;
  /** Repair retries after a structured-output validation failure (Atomic ADOPT 3). */
  parse_retries?: number | undefined;
  /** Assistant messages that carried at least one tool call — planner churn, as distinct from call count. */
  batch_count?: number | undefined;
  /** The server's own counters, where it reports them separately from what was billed. */
  prompt_tokens?: number | undefined;
  predicted_tokens?: number | undefined;
}

/** One turn. `(prompt, spec) => result` — the assistant's `Engine`, structurally. */
export type EvalEngine = (prompt: string, spec: EvalTurnSpec) => Promise<EvalTurnResult>;

/** Built per case, so each fixture gets its own recording host and its own empty call log. */
export type EngineFactory = (host: RecordingToolHost, fixture: Fixture) => EvalEngine | Promise<EvalEngine>;

export interface RunOptions {
  fixtures: readonly Fixture[];
  candidate: Candidate;
  engine: EngineFactory;
  /** Production's tool surface (tools.ts). The candidate sees these definitions and executes none of them. */
  toolDefs: readonly ToolDef[];
  judge?: JudgeFn | undefined;
  judgeConfig?: JudgeConfig | undefined;
  /** The bar's model id, for the third-family rule. The bar is Claude, so a Claude judge is refused here. */
  barModel?: string | undefined;
  /** Default 1 — see the note above. */
  concurrency?: number | undefined;
  /** Rows already in the run file. A pair present here is skipped. */
  existing?: readonly RunRecord[] | undefined;
  /** Where `transcript_ref` points, relative to the run file. */
  transcriptDir?: string | undefined;
  /** Called with every finished row, in completion order — the CLI appends it to the run file so a crash keeps what ran. */
  onRecord?: ((record: RunRecord, transcript: Transcript) => void | Promise<void>) | undefined;
  /** Injected in tests. */
  now?: (() => number) | undefined;
  clock?: (() => Date) | undefined;
  maxTurns?: number | undefined;
}

/** What gets written to `.transcripts/` — everything the row deliberately does not carry. */
export interface Transcript {
  fixture_id: string;
  candidate: Candidate;
  prompt: string;
  answer: string;
  calls: Observation["calls"];
  turns: number;
  stopped?: string | undefined;
  judge?: { model: string; verdict: number; reason: string } | undefined;
  error?: string | undefined;
  ts: string;
}

export interface RunSummary {
  records: RunRecord[];
  skipped: number;
}

/**
 * Refuse the run before it costs anything. Two named errors, both saying what
 * would permit them: no judge for a rubric fixture, and a judge from the
 * candidate's or the bar's family.
 */
export function checkJudgeConfiguration(opts: Pick<RunOptions, "fixtures" | "judge" | "judgeConfig" | "candidate" | "barModel">): void {
  const rubricCases = opts.fixtures.filter(needsJudge).length;
  if (rubricCases === 0) return;
  if (!opts.judge || !opts.judgeConfig) throw new JudgeNotConfiguredError(rubricCases);
  assertThirdFamily(opts.judgeConfig, opts.candidate, opts.barModel);
}

/** Which fixtures still have to run. Order is preserved: a resumed run continues where it left off. */
export function pending(fixtures: readonly Fixture[], candidate: Candidate, existing: readonly RunRecord[] = []): Fixture[] {
  const done = new Set(existing.map((r) => caseKey(r.fixture_id, r.candidate.name)));
  return fixtures.filter((f) => !done.has(caseKey(f.id, candidate.name)));
}

function num(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function runBakeoff(opts: RunOptions): Promise<RunSummary> {
  checkJudgeConfiguration(opts);
  const now = opts.now ?? (() => Date.now());
  const clock = opts.clock ?? (() => new Date());
  const transcriptDir = opts.transcriptDir ?? ".transcripts";
  const todo = pending(opts.fixtures, opts.candidate, opts.existing ?? []);
  const skipped = opts.fixtures.length - todo.length;
  const records: RunRecord[] = [];
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? 1));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const fixture = todo[index];
      if (!fixture) return;
      const { record, transcript } = await runOne(fixture, opts, now, clock, transcriptDir);
      records.push(record);
      if (opts.onRecord) await opts.onRecord(record, transcript);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(todo.length, 1)) }, worker));
  return { records, skipped };
}

async function runOne(
  fixture: Fixture,
  opts: RunOptions,
  now: () => number,
  clock: () => Date,
  transcriptDir: string,
): Promise<{ record: RunRecord; transcript: Transcript }> {
  const host = recordingToolHost(opts.toolDefs);
  const prompt = composePrompt(fixture);
  const spec: EvalTurnSpec = {
    model: opts.candidate.model,
    effort: opts.candidate.effort,
    // One session key per case: two fixtures must never share history, or the
    // second one is measuring the first one's turn as well.
    thread: `eval:${opts.candidate.name}:${fixture.id}`,
    tier: "eval",
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
  };
  const ts = clock().toISOString();
  const transcript_ref = `${transcriptDir}/${fixture.id}.json`;

  let result: EvalTurnResult | undefined;
  let engineError: string | undefined;
  const started = now();
  try {
    const engine = await opts.engine(host, fixture);
    result = await engine(prompt, spec);
  } catch (err) {
    engineError = `engine: ${err instanceof Error ? err.message : String(err)}`;
  }
  const latency_ms = Math.max(0, now() - started);
  await host.close().catch(() => {});

  const obs: Observation = {
    answer: result?.text ?? "",
    calls: host.calls,
    hallucinated: host.hallucinated,
    turns: result?.turns ?? 0,
    ...(result?.stopped !== undefined ? { stopped: result.stopped } : {}),
  };

  // The judge, and the two ways it can fail. Neither produces a pass.
  let judge: RunRecord["judge"] = null;
  let judgeError: string | undefined;
  if (engineError === undefined && needsJudge(fixture)) {
    if (!opts.judge) {
      judgeError = "judge_not_configured";
    } else {
      try {
        judge = await opts.judge({ fixture, answer: obs.answer });
      } catch (err) {
        judgeError = `judge_unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const score = scoreCase(fixture, obs, judge ?? undefined);
  const error = engineError ?? judgeError;
  const pass = error === undefined && score.pass;

  const record: RunRecord = {
    fixture_id: fixture.id,
    axis: fixture.axis,
    candidate: opts.candidate,
    weight: fixture.weight,
    pass,
    score: error === undefined ? score.score : 0,
    judge,
    tokens_in: result?.tokens_in ?? 0,
    tokens_out: result?.tokens_out ?? 0,
    cost_usd: result?.cost_usd ?? 0,
    latency_ms,
    ttft_ms: num(result?.ttft_ms),
    turns: obs.turns,
    tool_calls: host.calls.map((c) => ({ name: c.name, args: c.args, ...(c.is_error ? { is_error: true } : {}) })),
    transcript_ref,
    reasons: score.reasons,
    ...(error !== undefined ? { error } : {}),
    steps: num(result?.turns),
    parse_retries: num(result?.parse_retries),
    tool_errors: host.toolErrors(),
    batch_count: num(result?.batch_count),
    prompt_tokens: num(result?.prompt_tokens ?? result?.tokens_in),
    predicted_tokens: num(result?.predicted_tokens ?? result?.tokens_out),
    ts,
  };

  const transcript: Transcript = {
    fixture_id: fixture.id,
    candidate: opts.candidate,
    prompt,
    answer: obs.answer,
    calls: host.calls,
    turns: obs.turns,
    ...(obs.stopped !== undefined ? { stopped: obs.stopped } : {}),
    ...(judge ? { judge: { model: judge.model, verdict: judge.verdict, reason: judge.reason } } : {}),
    ...(error !== undefined ? { error } : {}),
    ts,
  };
  return { record, transcript };
}

/** Which axes a selection covers — the validator and the CLI both report it, and an axis with no fixtures is a gap worth seeing. */
export function selectedAxes(fixtures: readonly Fixture[]): Axis[] {
  return [...new Set(fixtures.map((f) => f.axis))];
}

/** The judge's family as it will be recorded, for the run's `.meta.json`. */
export function judgeFamilyOf(config: JudgeConfig | undefined): string | null {
  return config ? (config.family ?? familyOf(config.model)) : null;
}
