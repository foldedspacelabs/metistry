// The run record — one JSONL row per (fixture, candidate) (§3.2, §3.5).
//
// The shape is PoC-15/16's, kept deliberately: one flat row per case per run
// and a `.meta.json` per run, now carrying `server`, `quant`, `server_build`
// and `host` beside `model`, because the bake-off's second question is which
// SERVER to bundle and a row that only names the model cannot answer it.
//
// Flat, not nested, and specifically the six trace columns are six columns
// (Atomic ADOPT 3). "A scalar says a model failed; an axis plus churn counts
// says whether to fix the model or the harness" — `steps`, `parse_retries`,
// `tool_errors`, `batch_count`, `prompt_tokens`, `predicted_tokens` are what
// separate a wrong answer from planner churn, and `null` in one of them means
// the engine did not report it, never zero.
//
// What is NOT in the row: the transcript. `transcript_ref` points at a file
// under the run directory's `.transcripts/`, which is gitignored — the rows
// are committed as PoC evidence (poc15/16 precedent) and stay small enough to
// read in a diff, while the full message history, which can carry vault
// content, stays on the machine that produced it.

import { z } from "zod";
import { AXES } from "./fixtures.js";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * One row of the bake-off matrix: a model, on a server, at an effort. `server`
 * is the axis C14 added — `llamaserver`, `lmstudio`, `ollama` (the names
 * `packages/cli`'s `/v1/models` discovery uses) or a cloud provider's own
 * name. `name` is what the report and `--bar` refer to it by.
 */
export const Candidate = z.strictObject({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be filename-safe: it names the run file"),
  /** The `compute.yaml` provider key this ran through. */
  provider: z.string().min(1),
  /** The model id as the provider knows it — `anthropic/claude-sonnet-5`, `qwen3.6:35b-a3b-q4_K_M`. */
  model: z.string().min(1),
  /** Which server served it. Free-form: the three local names, or a cloud provider. */
  server: z.string().min(1),
  effort: z.enum(EFFORTS),
});
export type Candidate = z.infer<typeof Candidate>;

export const JudgeVerdict = z.strictObject({
  model: z.string().min(1),
  /** The segment before `/`, or what `familyOf` resolved a bare id to. Stored so a same-family judge is visible in the record, not only refused at run time. */
  family: z.string().min(1),
  /** 1–5. Pass is ≥ RUBRIC_PASS (§3.2). */
  verdict: z.int().min(1).max(5),
  reason: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const RecordedCall = z.strictObject({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** The stub answered with an error — an unknown tool, or a recorded refusal. */
  is_error: z.boolean().optional(),
});
export type RecordedCall = z.infer<typeof RecordedCall>;

/** `null` means the engine did not report this counter; `0` means it reported zero. The difference is the whole point of the columns. */
const traceColumn = z.number().nullable();

export const RunRecord = z.strictObject({
  fixture_id: z.string().min(1),
  axis: z.enum(AXES),
  candidate: Candidate,
  /** How much this case counts in its axis's pass rate — copied from the fixture so the report needs only the run files. */
  weight: z.number().positive().default(1),
  pass: z.boolean(),
  /** 0–1. Deterministic axes score the fraction of expectations met; a rubric axis scores `verdict / 5`. */
  score: z.number().min(0).max(1),
  /** `null` on a deterministic axis, and on a rubric case the judge could not reach — which FAILS the case (ADOPT 6). */
  judge: JudgeVerdict.nullable(),
  tokens_in: z.number().min(0),
  tokens_out: z.number().min(0),
  cost_usd: z.number().min(0),
  latency_ms: z.number().min(0),
  /** Time to first token, where the engine measured it. */
  ttft_ms: z.number().min(0).nullable().optional(),
  /** Agentic turns the loop actually took. */
  turns: z.number().min(0),
  tool_calls: z.array(RecordedCall),
  /** Relative to the run file's directory: `.transcripts/<run>/<fixture>.json`. */
  transcript_ref: z.string().min(1),
  /** Every way the ANSWER missed the expectation, in the order they were checked. Empty on a pass; this is what makes a run file readable a year later. */
  reasons: z.array(z.string()).default([]),
  /** Why this case failed for a reason that is NOT the model's answer — an engine error, a judge that could not be reached. */
  error: z.string().optional(),
  // ---- the six trace columns (Atomic ADOPT 3) ----
  steps: traceColumn,
  parse_retries: traceColumn,
  tool_errors: traceColumn,
  batch_count: traceColumn,
  prompt_tokens: traceColumn,
  predicted_tokens: traceColumn,
  /** When the case ran, ISO-8601. Ordering inside a resumed run file is append order, not time order. */
  ts: z.string().min(1),
});
export type RunRecord = z.infer<typeof RunRecord>;

/** The `.meta.json` beside every run file (§3.2). One per run, describing what the whole file was produced by. */
export const RunMeta = z.looseObject({
  run: z.string().min(1),
  candidate: Candidate,
  /** The quantisation as the file names it — `Q4_K_M`. `null` for a cloud model, where the question does not apply. */
  quant: z.string().nullable(),
  /** `llama-server b4xxx`, `LM Studio 0.3.x`, `ollama 0.x` — the build, not just the product. */
  server_build: z.string().nullable(),
  /** The machine: `M4 Max 64GB`. RAM headroom (§3.5) is read against this. */
  host: z.string().nullable(),
  /** Reasoning style as it was actually SET for this run — recorded per model, never assumed off (§3.5, §2.9). */
  reasoning: z.string().nullable(),
  judge_model: z.string().nullable(),
  started_at: z.string().min(1),
  fixtures: z.number().min(0),
  harness_version: z.string().min(1),
});
export type RunMeta = z.infer<typeof RunMeta>;

/** One JSON object per line, blank lines ignored. Unparseable or invalid rows are returned as issues, never dropped in silence. */
export function parseRunRecords(text: string, source = "(run)"): { records: RunRecord[]; issues: string[] } {
  const records: RunRecord[] = [];
  const issues: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      issues.push(`${source} line ${i + 1}: not JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = RunRecord.safeParse(raw);
    if (!parsed.success) {
      issues.push(`${source} line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ")}`);
      continue;
    }
    records.push(parsed.data);
  }
  return { records, issues };
}

/** One record, one line, keys in a stable order so a re-run diffs cleanly against the last one. */
export function serialiseRecord(r: RunRecord): string {
  return JSON.stringify(r);
}

/** The pair a resume skips. Two runs of the same candidate against the same fixture are the same case. */
export function caseKey(fixtureId: string, candidateName: string): string {
  return `${candidateName}/${fixtureId}`;
}

/** `<candidate>-<ts>` — the run id, the run file's stem, and the transcript directory's name. */
export function runId(candidate: string, at: Date): string {
  const ts = at.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  return `${candidate}-${ts}`;
}

/** Stamped into every run's `.meta.json`, so a row says which harness produced it. */
export const HARNESS_VERSION = "poc18.1";
