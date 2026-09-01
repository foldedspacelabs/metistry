import { fileURLToPath } from "node:url";
import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { makePool } from "./db.js";
import { makeServer } from "./server.js";
import { pushConfigFromEnv, startNotifier } from "./push.js";
import { collectors } from "@metistry-apps/collectors";
import { loadSchedules, startRunner } from "./runner.js";
import { loadRules } from "./router.js";
import { readFile } from "node:fs/promises";

const pool = makePool();
const queries = new QueryStore(pool);

// D4 overlay: seed defaults first, instance dirs after (later loads win).
for (const dir of optionalEnv("METISTRY_QUERIES_DIRS", "seed/queries").split(":")) {
  await queries.loadDir(dir);
}

// D4 overlay for rules too: last existing file wins.
let rules;
for (const p of optionalEnv("METISTRY_RULES_FILES", "seed/rules.yaml:rules.yaml").split(":")) {
  try {
    rules = loadRules(await readFile(p, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}
if (!rules) throw new Error("no rules.yaml found (METISTRY_RULES_FILES)");

const origin = requireEnv("METISTRY_ORIGIN"); // canonical HTTPS origin (§4.2)
const push = pushConfigFromEnv();
if (!push) console.warn("web push absent: set METISTRY_VAPID_* to enable (degrades: absent)");
const server = makeServer(pool, queries, {
  origin,
  inboxDir: optionalEnv("METISTRY_INBOX_DIR", "./inbox"),
  policy: {
    idleDays: intEnv("METISTRY_SESSION_IDLE_DAYS", 30),
    maxDays: intEnv("METISTRY_SESSION_MAX_DAYS", 365),
  },
  secureCookies: origin.startsWith("https:"),
  webRoot: fileURLToPath(new URL("../web", import.meta.url)),
  rules,
  ...(push ? { push } : {}),
});
if (push) startNotifier(pool, push);

// routine runner (SHOULD-8): collectors scheduled from their manifests
const scheduled = await loadSchedules(collectors, optionalEnv("METISTRY_COLLECTORS_DIR", "collectors"));
startRunner(pool, scheduled, {
  ...(process.env.METISTRY_AFM_URL ? { afmUrl: process.env.METISTRY_AFM_URL } : {}),
  ...(process.env.METISTRY_BRIDGE_TOKEN_APPLE_FM ? { afmToken: process.env.METISTRY_BRIDGE_TOKEN_APPLE_FM } : {}),
});
console.log(`runner: ${scheduled.map((c) => `${c.name}/${c.intervalSec}s`).join(", ")}`);

const host = optionalEnv("METISTRY_CONSOLE_HOST", "127.0.0.1"); // loopback default (invariant 8)
const port = intEnv("METISTRY_CONSOLE_PORT", 8080);
server.listen(port, host, () => console.log(`console listening on ${host}:${port} (${queries.names().length} queries)`));
