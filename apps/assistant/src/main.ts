import pg from "pg";
import { SPEND_QUERY, engineStatus, intEnv, optionalEnv, requireEnv, type SpendRow } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { drainOne } from "./drain.js";
import { DEFAULT_BRIEF_THREAD_BYTES, drainCrewOne } from "./crew-drain.js";
import { makeEngine } from "./engine.js";
import { makeBudgetGuard } from "./budgets.js";
import { pgSessionStore } from "./sessions.js";
import { mcpToolHost, NO_TOOLS } from "./tools.js";
import { brainConfigFromEnv, brainToolNames } from "./brain.js";
import { loadSystemPrompt } from "./prompt.js";
import { loadTiers, RULES_FILES_DEFAULT } from "./tiers.js";
import { warnNonZdrAssignments, watchCompute } from "./compute.js";

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
// Its `assignments:` supersede rules.yaml's `tiers:` when they are there, and
// they name PINNED `<provider>/<id>` references — so they say which ENGINE
// answers as well as which model.
//
// They are RESOLVED AT THE POINT OF THE CALL (drain.ts,
// crew-drain.ts) rather than flattened into a tier map here: the provider is
// half of what a turn needs, and flattening threw it away. rules.yaml's
// `tiers:` stays the map for every install that assigns nothing.
const tiers = rulesTiers;
const currentCompute = () => compute.store.current;
const describeAssignments = (): void => {
  const cfg = currentCompute();
  if (!cfg.assignments) {
    console.log("compute.yaml assigns nothing — there is no engine, so this process should not have started (see below)");
    return;
  }
  const a = cfg.assignments;
  console.log(
    `compute.yaml assignments: default=${a.default.model}/${a.default.effort} ` +
      Object.entries(a.tiers).map(([k, t]) => `${k}=${t.model}/${t.effort}`).join(" ") +
      Object.entries(a.crews).map(([k, t]) => ` crew:${k}=${t.model}`).join(""),
  );
  // C13: an off-machine provider with no zdr: true warns once and works.
  void warnNonZdrAssignments(pool, "assistant", cfg).catch((e) => console.warn("non-ZDR warning row:", e));
};
const compute = await watchCompute(pool, "assistant", describeAssignments);
describeAssignments();

// The engine never starts half-configured. An install with NO engine is a
// SUPPORTED shape, not a fault: `metistry up` omits this child, doctor
// reports `assistant: absent`, and captures, tasks, search and the console
// all run (docs/ops/assistant-tools.md, "Running without an engine"). So if
// this process is running at all and there is still no engine, something
// started it by hand — say which half is missing and stop, rather than
// crash-looping on the first turn. The same seam `up` and `doctor` read
// (core's `engineStatus`), so the three can never disagree.
const engineReady = engineStatus(currentCompute());
if (!engineReady.ok) {
  throw new Error(`${engineReady.why} — ${engineReady.fix}`);
}

// Spend is read through the ONE read path (invariant 3): the `spend` named
// query, executed by packages/queries. Budgets are enforced against it in the
// engine's guard, BEFORE the call. No budgets in compute.yaml → the query is
// never run.
const queries = new QueryStore(pool);
for (const dir of optionalEnv("METISTRY_QUERIES_DIRS", "seed/queries").split(":").filter(Boolean)) {
  try {
    await queries.loadDir(dir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}
const hasSpend = queries.names().includes(SPEND_QUERY);
if (!hasSpend) console.warn(`the \`${SPEND_QUERY}\` named query is not loaded (METISTRY_QUERIES_DIRS) — budgets in compute.yaml will refuse rather than guess`);
const guard = makeBudgetGuard({
  db: pool,
  compute: currentCompute,
  ...(hasSpend ? { spend: async () => (await queries.run(SPEND_QUERY)).rows as SpendRow[] } : {}),
});

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

// One engine object (engine.ts): the provider's `kind` decides which adapter
// serves a turn, and today there is one — the in-house OpenAI-compatible
// loop. Claude arrives through OpenRouter like any other cloud model.
const engine = makeEngine({
  systemPrompt: loaded?.prompt,
  guard,
  sessions: pgSessionStore(pool),
  tools: () => (brain ? mcpToolHost({ url: brain.url, token: brain.token, allow: brainToolNames() }) : NO_TOOLS),
  ...(process.env.METISTRY_MAX_TURNS ? { maxTurns: intEnv("METISTRY_MAX_TURNS", 12) } : {}),
});
const shown = engineReady.assignment!;
console.log(`assistant draining (default ${shown.ref} at ${shown.effort} effort, every ${interval}ms)`);

// Crews (docs/ops/crews.md): the same loop drains the crew queue after the
// inbound one. Each run gets a per-run token minted here and burned after;
// the brain URL is the assistant's own (the token is NOT — a crew never
// presents the assistant's credential).
const crewCfg = {
  brainUrl: brain?.url,
  identity: loaded?.identity,
  compute: currentCompute,
  guard,
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
    while (await drainOne(pool, engine, tiers, { compute: currentCompute })) {} // drain the backlog
    while (await drainCrewOne(pool, crewCfg)) {} // then the crew queue
  } catch (err) {
    console.error("drain:", err);
  } finally {
    busy = false;
  }
}, interval);
