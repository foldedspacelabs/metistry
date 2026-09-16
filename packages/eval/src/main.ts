#!/usr/bin/env node
// `metistry-eval` — validate | tools | run | report (PoC-18, §3.6).
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
import { axisCounts, loadFixturesFromText, type Axis, type Fixture, AXES } from "./fixtures.js";
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
export const BOOLEAN_FLAGS = new Set(["json", "help", "include-examples", "dry-run", "strict"]);
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
