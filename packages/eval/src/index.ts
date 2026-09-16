// `@metistry-apps/eval` — the bake-off harness (PoC-18).
//
// PRIVATE and unpublished: it is the runner, not the product. The fixtures,
// the runs and the write-up live in `docs/poc/poc18-bakeoff/`; this package is
// the one scorer stage 2's shadow mode and any CI regression will reuse, which
// is why it is a workspace package rather than a script in the PoC directory
// (§3.6 — "the new package is the owner's to ratify").

export {
  AXES,
  ArgMatcher,
  DETERMINISTIC_AXES,
  Expected,
  ExpectedToolCall,
  Fixture,
  FixtureContext,
  FixtureError,
  MATCHER_KEYS,
  RUBRIC_AXES,
  RUBRIC_PASS,
  axisCounts,
  composePrompt,
  isRubricAxis,
  loadFixturesFromText,
  looksLikeMatcher,
  parseFixtureRows,
  validateFixtures,
  type Axis,
  type FixtureIssue,
  type LoadResult,
} from "./fixtures.js";

export {
  Candidate,
  EFFORTS,
  HARNESS_VERSION,
  JudgeVerdict,
  RecordedCall,
  RunMeta,
  RunRecord,
  caseKey,
  parseRunRecords,
  runId,
  serialiseRecord,
  type Effort,
} from "./record.js";

export {
  JudgeFamilyError,
  JudgeNotConfiguredError,
  assertThirdFamily,
  familyOf,
  judgeFromEnv,
  judgePrompt,
  openAiJudge,
  stripFence,
  type JudgeConfig,
  type JudgeFn,
  type JudgeRequest,
  type OpenAiJudgeOptions,
} from "./judge.js";

export {
  BRAIN_SERVER,
  DEFAULT_STUB_RESULT,
  brainToolDefs,
  qualify,
  recordingToolHost,
  toolDefsFromListResult,
  unqualify,
  type RecordedToolCall,
  type RecordingToolHost,
  type ToolDef,
  type ToolHostLike,
} from "./tools.js";

export {
  checkGates,
  includes,
  matchesArg,
  matchesCall,
  needsJudge,
  scoreCase,
  scoreRubric,
  scoreStopping,
  scoreToolCalls,
  type Observation,
  type Score,
} from "./score.js";

export {
  checkJudgeConfiguration,
  judgeFamilyOf,
  pending,
  runBakeoff,
  selectedAxes,
  type EngineFactory,
  type EvalEngine,
  type EvalTurnResult,
  type EvalTurnSpec,
  type RunOptions,
  type RunSummary,
  type Transcript,
} from "./runner.js";

export {
  buildReport,
  callSignature,
  renderReport,
  statsFor,
  type AxisStat,
  type CandidateStat,
  type Report,
  type ReportOptions,
  type TraceStat,
} from "./report.js";
