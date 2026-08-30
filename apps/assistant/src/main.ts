import pg from "pg";
import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { drainOne } from "./drain.js";
import { sdkEngine } from "./engine.js";

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
console.log(`assistant draining (model=${model}, every ${interval}ms)`);

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    while (await drainOne(pool, sdkEngine, model)) {} // drain the backlog
  } catch (err) {
    console.error("drain:", err);
  } finally {
    busy = false;
  }
}, interval);
