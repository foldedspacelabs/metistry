#!/usr/bin/env node
// `metistry-eval` — validate | tools | run | report (PoC-18, §3.6),
// `intents` (PoC-20 phase 1, docs/poc/poc20-intent-tier/README.md), and
// `complexity` (T9-3, the router's confirmatory eval — docs/ops/dynamic-router.md §7.2).
//
// Hand-rolled argument parsing, matching `packages/cli`: a handful of
// subcommands does not justify a dependency this project would maintain for
// years (CLAUDE.md).
//
// `run` takes `--engine <module>`, a file exporting `createEngine(context)`
// that returns the harness's `EngineFactory`. That seam is why the harness
// can be finished and tested before the compute engine merges, and why the
// stage-0 script is ten lines rather than a fork of this file: the engine is
// the assistant's, the scoring is here, and neither imports the other.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHOICE_SERVERS, INTENT_OPTIONS, INTENT_PHRASINGS, POLICY_TIMEOUT_DEFAULT_MS, POLICY_TIMEOUT_MAX_MS, POLICY_TIMEOUT_MIN_MS, codesFor, parseCompute, type ChoiceServer, type IntentPhrasing } from "@foldedspacelabs/metistry-core";
import {
  CacheReportJson,
  RouteReportJson,
  buildComplexityReport,
  buildCostReport,
  fitComplexityThreshold,
  isCorrect,
  loadComplexityFixtures,
  loadEvalRules,
  parseRecording,
  recordingFetch,
  renderComplexityReport,
  replayFetch,
  runComplexityEval,
  servedScorer,
  type ComplexityFixture,
  type EvalRules,
} from "./complexity.js";
import { axisCounts, loadFixturesFromText, type Axis, type Fixture, AXES } from "./fixtures.js";
import { buildIntentReport, liveScorer, loadIntentFixtures, renderIntentReport, runIntentEval, type IntentFixture } from "./intents.js";
import { judgeFromEnv, JudgeFamilyError, JudgeNotConfiguredError } from "./judge.js";
import { buildReport, renderReport } from "./report.js";
import { Candidate, EFFORTS, HARNESS_VERSION, parseRunRecords, runId, serialiseRecord, RunMeta, type RunRecord } from "./record.js";
import { checkJudgeConfiguration, judgeFamilyOf, runBakeoff, type EngineFactory } from "./runner.js";
import { brainToolDefs, toolDefsFromListResult, type ToolDef } from "./tools.js";

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
  repeated: Record<string, string[]>;
}

/** Flags that never take a value, so `metistry-eval run --json fixtures.jsonl` keeps its file. */
export const BOOLEAN_FLAGS = new Set(["json", "help", "include-examples", "dry-run", "strict", "fit", "phrasings", "no-warm-up"]);
/** Flags that may appear more than once. */
export const REPEATED_FLAGS = new Set(["axis"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      let value: string | true;
      if (inline !== undefined) value = inline;
      else if (BOOLEAN_FLAGS.has(name)) value = true;
      else {
        const next = argv[i + 1];
        value = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      }
      if (REPEATED_FLAGS.has(name) && typeof value === "string") (repeated[name] ??= []).push(value);
      else flags[name] = value;
      continue;
    }
    if (command === undefined) command = arg;
    else positional.push(arg);
  }
  return { command, positional, flags, repeated };
}

const USAGE = `metistry-eval — the PoC-18 bake-off harness

  validate <file...>              check fixtures against the schema; exit 1 on any issue
  tools [--out <file>]            print production's mcp-brain tools/list, the definitions a run presents
  run <fixtures...> --engine <m>  run every fixture against one candidate, appending to a run file
  report <runs...> [--bar <name>] pass rate per axis, agreement with the bar, and the promotion line
  intents <file...>               score YOUR labelled messages through the intent tier, and FIT the threshold
  complexity [<file...>]          the router's confirmatory eval: YOUR labelled messages through the planner as served, against the pre-registered bar

run flags
  --engine <module>      a JS/TS module exporting createEngine(ctx) => EngineFactory   (required)
  --candidate <name>     the run's name; also the run file's stem                      (required)
  --provider <name>      the compute.yaml provider key                                 (required)
  --model <id>           the model id as the provider knows it                         (required)
  --server <name>        llamaserver | lmstudio | ollama | a cloud provider            (required)
  --effort low|medium|high                                                  (default medium)
  --out-dir <dir>        default docs/poc/poc18-bakeoff/runs
  --run-file <file>      resume into an existing run file instead of starting a new one
  --bar-model <id>       the bar's model id, so a same-family judge is refused
  --axis <axis>          repeatable; default every axis present in the fixtures
  --concurrency <n>      default 1 — the local half measures one model on one machine
  --tools <file>         a captured tools/list instead of asking mcp-brain in-process
  --include-examples     include fixtures marked example: true (they are skipped by default)
  --quant / --server-build / --host / --reasoning   recorded in the run's .meta.json

judge (environment; a rubric fixture with no judge FAILS the run)
  METISTRY_EVAL_JUDGE_MODEL, METISTRY_EVAL_JUDGE_BASE_URL,
  METISTRY_EVAL_JUDGE_API_KEY, METISTRY_EVAL_JUDGE_FAMILY

intents flags  (PoC-20 phase 1 — docs/poc/poc20-intent-tier/README.md)
  --base-url <url>       a local server's API root, e.g. http://127.0.0.1:11434/v1  (required)
  --model <id>           the model id as that server knows it                       (required)
  --server <name>        ${CHOICE_SERVERS.join(" | ")} — decides the request shape
  --api-key-env <VAR>    an environment variable holding a bearer, where the server wants one
  --phrasings            try every question wording and keep the best on YOUR fixtures
  --phrasing <name>      just one: ${INTENT_PHRASINGS.join(" | ")}
  --fit                  print the threshold to paste into rules.yaml (it is an OUTPUT, never an input)
  --min-coverage <0..1>  additionally require this much coverage of the fit
  --top-logprobs <n>     default: one per intent; the server's own ceiling still applies
  --no-warm-up           do not discard the first call per phrasing (cold start then lands in p95)
  --out <file>           write the report instead of printing it

complexity flags  (T9-3 — docs/ops/dynamic-router.md §7.2; exit 0 only on PASS)
  --instance <dir>       read .metistry/eval/complexity.jsonl, .metistry/compute.yaml and .metistry/rules.yaml from it
  --compute <file>       compute.yaml — the planner is its assignments.intent, called exactly as the router calls it
  --rules <file>         rules.yaml — policy.timeout_ms, policy.tiers, policy.complexity.min_confidence
  --fit                  sweep complexity.min_confidence and evaluate at the fitted value (an OUTPUT, never an input)
  --threshold <0..1>     evaluate at this min_confidence instead
  --timeout-ms <n>       the policy.timeout_ms you will serve with (default: rules.yaml's, else ${POLICY_TIMEOUT_DEFAULT_MS})
  --route-report <file>  \`metistry compute route-report --since 14d --json\` — the real mix and the shadow rows
  --cache-report <file>  \`metistry compute cache-report --since 14d --json\` — each tier's observed cost per turn
  --record <file>        write every server response, so the run can be replayed offline
  --replay <file>        answer from a recording instead of the server — no network at all
  --no-warm-up / --json / --out <file>
`;

function str(flags: Record<string, string | true>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function required(flags: Record<string, string | true>, name: string): string {
  const v = str(flags, name);
  if (v === undefined) throw new Error(`--${name} is required (metistry-eval --help)`);
  return v;
}

function readFixtureFiles(paths: readonly string[], includeExamples: boolean, axes: readonly Axis[]): { fixtures: Fixture[]; issues: string[] } {
  const fixtures: Fixture[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const result = loadFixturesFromText(readFileSync(path, "utf8"), path);
    for (const issue of result.issues) issues.push(`${issue.source}#${issue.index}${issue.id ? ` (${issue.id})` : ""}: ${issue.message}`);
    for (const f of result.fixtures) {
      if (seen.has(f.id)) {
        issues.push(`${path}: duplicate id across files: ${f.id}`);
        continue;
      }
      seen.add(f.id);
      if (!includeExamples && f.example === true) continue;
      if (axes.length > 0 && !axes.includes(f.axis)) continue;
      fixtures.push(f);
    }
  }
  return { fixtures, issues };
}

async function cmdValidate(args: ParsedArgs): Promise<number> {
  const files = args.positional;
  if (files.length === 0) {
    process.stderr.write("validate needs at least one fixture file\n");
    return 2;
  }
  const { fixtures, issues } = readFixtureFiles(files, true, []);
  const counts = axisCounts(fixtures);
  const examples = fixtures.filter((f) => f.example === true).length;
  if (args.flags.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: issues.length === 0, fixtures: fixtures.length, examples, axes: counts, issues }, null, 2)}\n`);
  } else {
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    const axisLine = AXES.map((a) => `${a} ${counts[a]}`).join(" · ");
    process.stdout.write(`${fixtures.length} fixture(s)${examples > 0 ? ` (${examples} example)` : ""}: ${axisLine}\n`);
    const empty = AXES.filter((a) => counts[a] === 0);
    if (empty.length > 0) process.stdout.write(`no fixtures on: ${empty.join(", ")}\n`);
    process.stdout.write(issues.length === 0 ? "ok\n" : `${issues.length} issue(s)\n`);
  }
  return issues.length === 0 ? 0 : 1;
}

async function cmdTools(args: ParsedArgs): Promise<number> {
  const defs = await brainToolDefs();
  const body = `${JSON.stringify({ tools: defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters })) }, null, 2)}\n`;
  const out = str(args.flags, "out");
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), body);
    process.stdout.write(`${defs.length} tool(s) → ${out}\n`);
  } else process.stdout.write(body);
  return 0;
}

export const DEFAULT_RUNS_DIR = join("docs", "poc", "poc18-bakeoff", "runs");

async function cmdRun(args: ParsedArgs): Promise<number> {
  if (args.positional.length === 0) throw new Error("run needs at least one fixture file");
  const includeExamples = args.flags["include-examples"] === true;
  const axes = (args.repeated.axis ?? []).map((a) => {
    if (!(AXES as readonly string[]).includes(a)) throw new Error(`--axis ${a} is not one of ${AXES.join(", ")}`);
    return a as Axis;
  });
  const { fixtures, issues } = readFixtureFiles(args.positional, includeExamples, axes);
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    throw new Error(`${issues.length} invalid fixture(s): run \`metistry-eval validate\` and fix them before spending anything`);
  }
  if (fixtures.length === 0) throw new Error("no fixtures selected (examples are skipped unless --include-examples)");

  const effortFlag = str(args.flags, "effort") ?? "medium";
  if (!(EFFORTS as readonly string[]).includes(effortFlag)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  const candidate = Candidate.parse({
    name: required(args.flags, "candidate"),
    provider: required(args.flags, "provider"),
    model: required(args.flags, "model"),
    server: required(args.flags, "server"),
    effort: effortFlag,
  });

  // Every refusal that can be made from the arguments alone is made HERE,
  // before a directory is created, a tool surface is read or a model is
  // dialled: a misconfigured judge should cost nothing.
  const fromEnv = judgeFromEnv();
  const barModel = str(args.flags, "bar-model");
  checkJudgeConfiguration({
    fixtures,
    candidate,
    ...(fromEnv ? { judge: fromEnv.judge, judgeConfig: fromEnv.config } : {}),
    ...(barModel !== undefined ? { barModel } : {}),
  });

  const toolsFile = str(args.flags, "tools");
  const toolDefs: ToolDef[] = toolsFile ? toolDefsFromListResult(JSON.parse(readFileSync(resolve(toolsFile), "utf8"))) : await brainToolDefs();

  const outDir = resolve(str(args.flags, "out-dir") ?? DEFAULT_RUNS_DIR);
  const existingFile = str(args.flags, "run-file");
  const runFile = existingFile ? resolve(existingFile) : join(outDir, `${runId(candidate.name, new Date())}.jsonl`);
  const stem = runFile.replace(/\.jsonl$/, "");
  const transcriptDirName = join(".transcripts", stem.split("/").pop()!);
  const transcriptDir = join(dirname(runFile), transcriptDirName);
  mkdirSync(dirname(runFile), { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });

  let existing: RunRecord[] = [];
  if (existsSync(runFile)) {
    const parsed = parseRunRecords(readFileSync(runFile, "utf8"), runFile);
    if (parsed.issues.length > 0) throw new Error(`the run file cannot be resumed — it has rows this harness cannot read:\n  ${parsed.issues.join("\n  ")}`);
    existing = parsed.records;
  }

  const engineModule = resolve(required(args.flags, "engine"));
  const loaded = (await import(pathToFileURL(engineModule).href)) as { createEngine?: (ctx: unknown) => EngineFactory | Promise<EngineFactory>; default?: (ctx: unknown) => EngineFactory | Promise<EngineFactory> };
  const create = loaded.createEngine ?? loaded.default;
  if (typeof create !== "function") throw new Error(`${engineModule} exports no createEngine(ctx) — see docs/poc/poc18-bakeoff/README.md`);
  const factory = await create({ candidate, toolDefs, flags: args.flags });

  const concurrency = Number.parseInt(str(args.flags, "concurrency") ?? "1", 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

  const summary = await runBakeoff({
    fixtures,
    candidate,
    engine: factory,
    toolDefs,
    ...(fromEnv ? { judge: fromEnv.judge, judgeConfig: fromEnv.config } : {}),
    ...(barModel !== undefined ? { barModel } : {}),
    concurrency,
    existing,
    transcriptDir: transcriptDirName,
    onRecord: (record, transcript) => {
      appendFileSync(runFile, `${serialiseRecord(record)}\n`);
      writeFileSync(join(transcriptDir, `${record.fixture_id}.json`), `${JSON.stringify(transcript, null, 2)}\n`);
      process.stdout.write(`${record.pass ? "pass" : "FAIL"}  ${record.axis.padEnd(10)} ${record.fixture_id}  ${Math.round(record.latency_ms)} ms${record.error ? `  — ${record.error}` : ""}\n`);
    },
  });

  const meta = RunMeta.parse({
    run: stem.split("/").pop(),
    candidate,
    quant: str(args.flags, "quant") ?? null,
    server_build: str(args.flags, "server-build") ?? null,
    host: str(args.flags, "host") ?? null,
    reasoning: str(args.flags, "reasoning") ?? null,
    judge_model: fromEnv?.config.model ?? null,
    judge_family: judgeFamilyOf(fromEnv?.config),
    started_at: new Date().toISOString(),
    fixtures: existing.length + summary.records.length,
    harness_version: HARNESS_VERSION,
  });
  writeFileSync(`${stem}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);

  const passed = summary.records.filter((r) => r.pass).length;
  process.stdout.write(`\n${passed}/${summary.records.length} passed${summary.skipped > 0 ? `, ${summary.skipped} already in ${runFile}` : ""}\n${runFile}\n`);
  return 0;
}

async function cmdReport(args: ParsedArgs): Promise<number> {
  if (args.positional.length === 0) throw new Error("report needs at least one run file");
  const records: RunRecord[] = [];
  const issues: string[] = [];
  for (const path of args.positional) {
    const parsed = parseRunRecords(readFileSync(path, "utf8"), path);
    records.push(...parsed.records);
    issues.push(...parsed.issues);
  }
  for (const issue of issues) process.stderr.write(`${issue}\n`);
  if (args.flags.strict === true && issues.length > 0) return 1;
  const report = buildReport(records, { ...(str(args.flags, "bar") !== undefined ? { bar: str(args.flags, "bar") } : {}) });
  const body = args.flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`;
  const out = str(args.flags, "out");
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), body);
    process.stdout.write(`${report.candidates.length} candidate(s) → ${out}\n`);
  } else process.stdout.write(body);
  return 0;
}

/**
 * `metistry-eval intents` — score the owner's own labelled messages through
 * the intent tier and FIT the threshold (PoC-20 phase 1, research §4.4).
 *
 * It refuses an empty fixture file by name rather than reporting 0/0 as a
 * pass. The example this repo ships IS empty, and that is the point: C11
 * forbids a Claude-authored label as an expected answer, so the harness can
 * ship the format and never the data.
 */
async function cmdIntents(args: ParsedArgs): Promise<number> {
  if (args.positional.length === 0) throw new Error("intents needs at least one fixture file — see docs/poc/poc20-intent-tier/README.md for the format");
  const fixtures: IntentFixture[] = [];
  const issues: string[] = [];
  for (const path of args.positional) {
    const loaded = loadIntentFixtures(readFileSync(resolve(path), "utf8"), path);
    fixtures.push(...loaded.fixtures);
    for (const i of loaded.issues) issues.push(`${i.source}:${i.line}: ${i.message}`);
  }
  for (const issue of issues) process.stderr.write(`${issue}\n`);
  if (issues.length > 0) throw new Error(`${issues.length} unreadable fixture line(s) — fix them before measuring anything`);
  if (fixtures.length === 0) {
    throw new Error(
      `no fixtures in ${args.positional.join(", ")}. The fixtures are YOURS: one JSON object per line, ` +
        `{"text": "<a message you actually wrote>", "intent": "<one of this build's intents>"}. ` +
        `Claude may not write the labels (C11), so the shipped example is empty on purpose — docs/poc/poc20-intent-tier/README.md`,
    );
  }

  const serverFlag = str(args.flags, "server");
  if (serverFlag !== undefined && !(CHOICE_SERVERS as readonly string[]).includes(serverFlag)) {
    throw new Error(`--server ${serverFlag} is not one of ${CHOICE_SERVERS.join(", ")}`);
  }
  const phrasingFlag = str(args.flags, "phrasing");
  if (phrasingFlag !== undefined && !(INTENT_PHRASINGS as readonly string[]).includes(phrasingFlag)) {
    throw new Error(`--phrasing ${phrasingFlag} is not one of ${INTENT_PHRASINGS.join(", ")}`);
  }
  const phrasings: IntentPhrasing[] =
    args.flags.phrasings === true ? [...INTENT_PHRASINGS] : phrasingFlag !== undefined ? [phrasingFlag as IntentPhrasing] : [INTENT_PHRASINGS[0]];

  const apiKeyEnv = str(args.flags, "api-key-env");
  const bearer = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !bearer) throw new Error(`--api-key-env ${apiKeyEnv} is not set in this process's environment`);
  const topLogprobs = str(args.flags, "top-logprobs");
  const minCoverage = str(args.flags, "min-coverage");

  const codes = codesFor(INTENT_OPTIONS.length);
  const score = liveScorer({
    baseUrl: required(args.flags, "base-url"),
    model: required(args.flags, "model"),
    options: INTENT_OPTIONS,
    codes,
    ...(serverFlag !== undefined ? { server: serverFlag as ChoiceServer } : {}),
    ...(bearer ? { bearer } : {}),
    ...(topLogprobs !== undefined ? { topLogprobs: Number.parseInt(topLogprobs, 10) } : {}),
  });

  const result = await runIntentEval({
    fixtures,
    score,
    phrasings,
    warmUp: args.flags["no-warm-up"] !== true,
    onRow: (row) => {
      const mark = row.predicted === null ? "----" : row.predicted === row.fixture.intent ? " ok " : "MISS";
      const what = row.guarded ?? row.error ?? `${row.predicted} conf=${row.confidence.toFixed(3)} alpha=${row.alpha.toFixed(3)}`;
      process.stdout.write(`${String(Math.round(row.latency_ms)).padStart(6)} ms  ${mark}  ${row.phrasing.padEnd(10)} ${what}\n`);
    },
  });

  const report = buildIntentReport(result, minCoverage !== undefined ? { minCoverage: Number.parseFloat(minCoverage) } : {});
  const body = args.flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : `\n${renderIntentReport(report)}\n`;
  const out = str(args.flags, "out");
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), body);
    process.stdout.write(`report → ${out}\n`);
  } else process.stdout.write(body);
  // `--fit` asks for a number. An exit code of 1 when no threshold meets the
  // bar is the honest answer to "give me the line to paste".
  if (args.flags.fit === true && report.by_phrasing.every((p) => p.fit.fitted === null)) return 1;
  return 0;
}

/**
 * `metistry-eval complexity` — the router's confirmatory eval (T9-3,
 * docs/ops/dynamic-router.md §7.2). The owner runs it: the fixtures, the
 * `compute.yaml` and the local server are the instance's.
 *
 * Every refusal that can be made before a model is dialled is made first — no
 * fixtures, an unreadable line, no `assignments.intent` — so a misconfigured
 * run costs nothing. The planner is on-machine by construction: the schema
 * refuses an off-machine `assignments.intent` at load and core's
 * `scoreChoice` refuses it again at the call.
 */
async function cmdComplexity(args: ParsedArgs): Promise<number> {
  const instance = str(args.flags, "instance");
  const inInstance = (rel: string): string | undefined => (instance ? join(resolve(instance), ".metistry", rel) : undefined);
  const fixturePaths = args.positional.length > 0 ? args.positional : [inInstance(join("eval", "complexity.jsonl"))].filter((p): p is string => p !== undefined);
  if (fixturePaths.length === 0) throw new Error("complexity needs your fixture file (or --instance <dir>) — one labelled message per line, docs/ops/dynamic-router.md §7.2");

  const fixtures: ComplexityFixture[] = [];
  const issues: string[] = [];
  for (const path of fixturePaths) {
    const loaded = loadComplexityFixtures(readFileSync(resolve(path), "utf8"), path);
    fixtures.push(...loaded.fixtures);
    for (const i of loaded.issues) issues.push(`${i.source}:${i.line}: ${i.message}`);
  }
  for (const issue of issues) process.stderr.write(`${issue}\n`);
  if (issues.length > 0) throw new Error(`${issues.length} unreadable fixture line(s) — fix them before measuring anything`);
  if (fixtures.length === 0) {
    throw new Error(
      `no fixtures in ${fixturePaths.join(", ")}. The fixtures are YOURS: one JSON object per line, ` +
        `{"text": "<a message you actually wrote>", "label": "simple" | "moderate" | "demanding"}, labelled from the class names alone. ` +
        `Claude may not write the labels (C11), so the shipped example is empty on purpose — docs/ops/dynamic-router.md §7.2`,
    );
  }

  const computePath = str(args.flags, "compute") ?? inInstance("compute.yaml");
  if (!computePath) throw new Error("--compute <compute.yaml> (or --instance <dir>) is required: the planner is its assignments.intent, called exactly as the router calls it");
  const compute = parseCompute(readFileSync(resolve(computePath), "utf8"));
  const modelRef = compute.assignments?.intent?.model;
  if (!modelRef) throw new Error(`${computePath} assigns no model to assignments.intent, so there is no planner to measure — the router's policy scores complexity on that model`);

  const rulesPath = str(args.flags, "rules") ?? inInstance("rules.yaml");
  const rules: EvalRules = rulesPath && existsSync(resolve(rulesPath)) ? loadEvalRules(readFileSync(resolve(rulesPath), "utf8")) : {};
  if (str(args.flags, "rules") !== undefined && rulesPath && !existsSync(resolve(rulesPath))) throw new Error(`--rules ${rulesPath} does not exist`);

  const timeoutFlag = str(args.flags, "timeout-ms");
  let timeoutMs = rules.policy?.timeout_ms ?? POLICY_TIMEOUT_DEFAULT_MS;
  let timeoutSource = rules.policy ? "rules.yaml policy.timeout_ms" : "the spec's default — rules.yaml has no policy: block";
  if (timeoutFlag !== undefined) {
    timeoutMs = Number.parseInt(timeoutFlag, 10);
    if (!Number.isInteger(timeoutMs) || timeoutMs < POLICY_TIMEOUT_MIN_MS || timeoutMs > POLICY_TIMEOUT_MAX_MS) throw new Error(`--timeout-ms is ${POLICY_TIMEOUT_MIN_MS}–${POLICY_TIMEOUT_MAX_MS}, as policy.timeout_ms is`);
    timeoutSource = "--timeout-ms";
  }
  const thresholdFlag = str(args.flags, "threshold");
  if (thresholdFlag !== undefined) {
    const t = Number.parseFloat(thresholdFlag);
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error("--threshold is between 0 and 1");
  }
  const readJson = <T,>(flag: string, schema: { parse: (v: unknown) => T }): T | undefined => {
    const path = str(args.flags, flag);
    return path === undefined ? undefined : schema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  };
  const routeReport = readJson("route-report", RouteReportJson);
  const cacheReport = readJson("cache-report", CacheReportJson);

  const replayPath = str(args.flags, "replay");
  const recordPath = str(args.flags, "record");
  if (replayPath && recordPath) throw new Error("--record and --replay are two different runs; pass one");
  const replay = replayPath ? replayFetch(parseRecording(readFileSync(resolve(replayPath), "utf8"), replayPath)) : undefined;
  let fetchFn: typeof fetch | undefined = replay?.fetchFn;
  if (recordPath) {
    mkdirSync(dirname(resolve(recordPath)), { recursive: true });
    writeFileSync(resolve(recordPath), "");
    fetchFn = recordingFetch(fetch, (call) => appendFileSync(resolve(recordPath), `${JSON.stringify(call)}\n`));
  }

  const score = servedScorer({
    access: { compute: () => compute, secretEnv: process.env, ...(fetchFn ? { fetchFn } : {}) },
    ...(replay ? { latencyOf: replay.lastLatency } : {}),
  });
  const result = await runComplexityEval({
    fixtures,
    score,
    warmUp: args.flags["no-warm-up"] !== true,
    onAnswer: (f, a, pass) => {
      const what = a.outcome === "scored" ? `${a.class} conf=${(a.confidence ?? 0).toFixed(3)}` : `${a.outcome}${a.reason ? ` (${a.reason})` : ""}`;
      const mark = a.outcome !== "scored" ? "----" : a.class !== undefined && isCorrect(f, a.class) ? " ok " : "MISS";
      process.stdout.write(`${String(Math.round(a.latency_ms ?? 0)).padStart(6)} ms  run ${pass}  ${mark}  ${f.label.padEnd(9)} → ${what}${f.id ? `  ${f.id}` : ""}\n`);
    },
  });
  if (replay && replay.unused() > 0) process.stderr.write(`the recording has ${replay.unused()} response(s) this run never asked for — it was recorded against different fixtures or flags\n`);

  const fit = args.flags.fit === true ? fitComplexityThreshold(result.rows) : null;
  let threshold = 0;
  let thresholdSource = "raw classes — no threshold; pass --fit, --threshold, or a rules.yaml with policy.complexity";
  if (thresholdFlag !== undefined) {
    threshold = Number.parseFloat(thresholdFlag);
    thresholdSource = "--threshold";
  } else if (fit?.fitted) {
    threshold = fit.fitted.threshold;
    thresholdSource = "fitted by --fit";
  } else if (rules.policy?.complexity) {
    threshold = rules.policy.complexity.min_confidence;
    thresholdSource = "rules.yaml policy.complexity.min_confidence";
  }

  const cost =
    routeReport && cacheReport
      ? buildCostReport({ routeReport, cacheReport, compute, policyTiers: rules.policy?.tiers, rows: result.rows, threshold })
      : null;
  const report = buildComplexityReport(result, {
    threshold,
    thresholdSource,
    timeoutMs,
    timeoutSource,
    fit,
    cost,
    ...(cost ? {} : { costAbsent: "Not computed — pass --route-report and --cache-report (each `metistry compute … --since 14d --json`); cost is reported, never gated." }),
    shadow: routeReport ?? null,
    model: modelRef,
    replay: replay !== undefined,
  });
  const body = args.flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : `\n${renderComplexityReport(report)}\n`;
  const out = str(args.flags, "out");
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), body);
    process.stdout.write(`${report.verdict.line}\nreport → ${out}\n`);
  } else process.stdout.write(body);
  // PASS is the only answer that lets T9-4 proceed, so it is the only exit 0.
  return report.verdict.pass ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help === true || args.command === undefined || args.command === "help") {
    process.stdout.write(USAGE);
    return args.command === undefined ? 2 : 0;
  }
  try {
    switch (args.command) {
      case "validate":
        return await cmdValidate(args);
      case "tools":
        return await cmdTools(args);
      case "run":
        return await cmdRun(args);
      case "report":
        return await cmdReport(args);
      case "intents":
        return await cmdIntents(args);
      case "complexity":
        return await cmdComplexity(args);
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof JudgeNotConfiguredError || err instanceof JudgeFamilyError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 3;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}
