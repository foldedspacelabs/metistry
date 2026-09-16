import pg from "pg";
import { computeTiers, intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { drainOne } from "./drain.js";
import { DEFAULT_BRIEF_THREAD_BYTES, drainCrewOne } from "./crew-drain.js";
import { makeSdkEngine } from "./engine.js";
import { brainConfigFromEnv, brainToolNames } from "./brain.js";
import { loadSystemPrompt } from "./prompt.js";
import { loadTiers, RULES_FILES_DEFAULT } from "./tiers.js";
import { watchCompute } from "./compute.js";

// PoC-4 rules: subscription token, never ANTHROPIC_API_KEY in-container.
if (process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must not be set (silently flips to API billing — PoC-4); use CLAUDE_CODE_OAUTH_TOKEN");
}
// The engine never starts half-configured — but an install with NO credential
// is a supported shape: `metistry up` leaves the assistant out of the
// supervisor's children and doctor reports `assistant: absent`. So reaching
// this line means something started the engine that should not have.
if (!(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) {
  throw new Error(
    "CLAUDE_CODE_OAUTH_TOKEN is unset — the supervisor should not have started the assistant without an engine credential (`metistry up` omits the child and `metistry doctor` reports `assistant: absent`); set it and re-run `metistry up`",
  );
}

const pool = new pg.Pool({
  host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
  port: intEnv("METISTRY_DB_PORT", 5432),
  database: optionalEnv("METISTRY_DB_NAME", "metistry"),
  user: optionalEnv("METISTRY_DB_USER", "metistry"),
  password: requireEnv("METISTRY_DB_PASSWORD"),
});

const model = optionalEnv("METISTRY_MODEL_DEFAULT", "haiku");
const interval = intEnv("METISTRY_DRAIN_INTERVAL_MS", 1500);

// Tiers are (model, effort) pairs, read from the same rules.yaml the console's
// router reads (D4 overlay). The drain resolves a tier NAME per turn.
const { tiers: rulesTiers, path: tiersPath } = await loadTiers(optionalEnv("METISTRY_RULES_FILES", RULES_FILES_DEFAULT), model);
if (tiersPath) console.log(`tiers from ${tiersPath}: ${Object.entries(rulesTiers).map(([k, t]) => `${k}=${t.model}/${t.effort}`).join(" ")}`);
else console.warn(`no rules.yaml found (METISTRY_RULES_FILES) — one tier only: default=${model}/medium`);

// compute.yaml (C1), hot-reloaded from the same file the console watches.
// Its `assignments:` supersede rules.yaml's `tiers:` when they are there —
// the one routing change this PR makes. The models they name are PINNED
// `<provider>/<id>` references, which the engine that lands next splits at
// the point of the call; until then an assignment is what the console
// records and what the app's picker shows.
let tiers = rulesTiers;
const applyAssignments = (): void => {
  const assigned = computeTiers(compute.store.current);
  tiers = assigned ?? rulesTiers;
  if (assigned) {
    console.log(`tiers from compute.yaml assignments: ${Object.entries(assigned).map(([k, t]) => `${k}=${t.model}/${t.effort}`).join(" ")}`);
    console.warn("compute.yaml assigns pinned <provider>/<model> references; the engine that dials a provider is not in this build (docs/ops/compute.md) — leave `assignments:` out to keep rules.yaml's tiers live");
  }
};
const compute = await watchCompute(pool, "assistant", applyAssignments);
applyAssignments();

// Tools: the console's mcp-brain, as the first internal agent (§4.11). Both
// env vars or nothing — a URL without a token cannot authenticate, a token
// without a URL has nowhere to go (degrades: absent, tool-less as before).
const brain = brainConfigFromEnv();
if (brain) console.log(`tools: ${brainToolNames().length} via ${brain.url} (allowlist: ${brainToolNames().join(", ")})`);
else console.warn("tools absent: set METISTRY_BRAIN_URL + METISTRY_ASSISTANT_TOKEN to mount mcp-brain (degrades: tool-less)");

// System prompt from identity.yaml + the seed prompt (D4 overlay); absent = none.
const loaded = await loadSystemPrompt();
if (loaded) console.log(`identity: ${loaded.identity.name} (system prompt ${loaded.prompt.length} chars)`);
else console.warn("system prompt absent: no identity.yaml / assistant-prompt.md found (METISTRY_IDENTITY_FILES, METISTRY_PROMPT_FILES)");

const sdkEngine = makeSdkEngine({ brain, systemPrompt: loaded?.prompt, ...(process.env.METISTRY_MAX_TURNS ? { maxTurns: intEnv("METISTRY_MAX_TURNS", 12) } : {}) });
console.log(`assistant draining (default tier=${tiers.default!.model}/${tiers.default!.effort}, every ${interval}ms)`);

// Crews (docs/ops/crews.md): the same loop drains the crew queue after the
// inbound one. Each run gets a per-run token minted here and burned after;
// the brain URL is the assistant's own (the token is NOT — a crew never
// presents the assistant's credential).
const crewCfg = {
  brainUrl: brain?.url,
  identity: loaded?.identity,
  leaseSeconds: intEnv("METISTRY_CREW_LEASE_S", 1800),
  maxAttempts: intEnv("METISTRY_CREW_MAX_ATTEMPTS", 3),
  retryBackoffSeconds: intEnv("METISTRY_CREW_RETRY_S", 300),
  // the brief is the context transfer: how many bytes of the task's room ride along (docs/ops/threads.md)
  briefThreadBytes: intEnv("METISTRY_BRIEF_THREAD_BYTES", DEFAULT_BRIEF_THREAD_BYTES),
};
if (!brain) console.warn("crews: no METISTRY_BRAIN_URL — queued crew runs will park as blocked");

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    while (await drainOne(pool, sdkEngine, tiers)) {} // drain the backlog
    while (await drainCrewOne(pool, crewCfg)) {} // then the crew queue
  } catch (err) {
    console.error("drain:", err);
  } finally {
    busy = false;
  }
}, interval);
