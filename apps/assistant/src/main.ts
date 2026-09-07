import pg from "pg";
import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { drainOne } from "./drain.js";
import { drainCrewOne } from "./crew-drain.js";
import { makeSdkEngine } from "./engine.js";
import { brainConfigFromEnv, brainToolNames } from "./brain.js";
import { loadSystemPrompt } from "./prompt.js";

// PoC-4 rules: subscription token, never ANTHROPIC_API_KEY in-container.
if (process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must not be set (silently flips to API billing — PoC-4); use CLAUDE_CODE_OAUTH_TOKEN");
}
requireEnv("CLAUDE_CODE_OAUTH_TOKEN");

const pool = new pg.Pool({
  host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
  port: intEnv("METISTRY_DB_PORT", 5432),
  database: optionalEnv("METISTRY_DB_NAME", "metistry"),
  user: optionalEnv("METISTRY_DB_USER", "metistry"),
  password: requireEnv("METISTRY_DB_PASSWORD"),
});

const model = optionalEnv("METISTRY_MODEL_DEFAULT", "haiku");
const interval = intEnv("METISTRY_DRAIN_INTERVAL_MS", 1500);

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
console.log(`assistant draining (model=${model}, every ${interval}ms)`);

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
};
if (!brain) console.warn("crews: no METISTRY_BRAIN_URL — queued crew runs will park as blocked");

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    while (await drainOne(pool, sdkEngine, model)) {} // drain the backlog
    while (await drainCrewOne(pool, crewCfg)) {} // then the crew queue
  } catch (err) {
    console.error("drain:", err);
  } finally {
    busy = false;
  }
}, interval);
