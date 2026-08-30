import { fileURLToPath } from "node:url";
import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { makePool } from "./db.js";
import { makeServer } from "./server.js";
import { pushConfigFromEnv } from "./push.js";

const pool = makePool();
const queries = new QueryStore(pool);

// D4 overlay: seed defaults first, instance dirs after (later loads win).
for (const dir of optionalEnv("METISTRY_QUERIES_DIRS", "seed/queries").split(":")) {
  await queries.loadDir(dir);
}

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
  ...(push ? { push } : {}),
});

const host = optionalEnv("METISTRY_CONSOLE_HOST", "127.0.0.1"); // loopback default (invariant 8)
const port = intEnv("METISTRY_CONSOLE_PORT", 8080);
server.listen(port, host, () => console.log(`console listening on ${host}:${port} (${queries.names().length} queries)`));
