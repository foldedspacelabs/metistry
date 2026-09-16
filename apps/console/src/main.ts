import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  budgetMiss,
  computeTiers,
  EMBED_DEFAULT_DIM,
  EMBED_DEFAULT_MODEL,
  EMBED_DEFAULT_URL,
  EmbedClient,
  firstOnMachineBaseUrl,
  INSTANCES_FILENAME,
  intEnv,
  optionalEnv,
  requireEnv,
  resolveLocalModelUrl,
  ROUTINE_TIER,
  SPEND_QUERY,
  type PreflightMiss,
  type SpendRow,
} from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { makePool } from "./db.js";
import { makeServer } from "./server.js";
import { pushConfigFromEnv, startNotifier } from "./push.js";
import { collectors } from "@metistry-apps/collectors";
import { routines } from "@metistry-apps/routines";
import { loadSchedules, startRunner } from "./runner.js";
import { loadRules } from "./router.js";
import { watchCompute } from "./compute.js";
import { TargetRegistry } from "./dispatch.js";
import { dirSink, vaultSink, DEFAULT_MAX_TRACKED_BYTES, INBOX_PREFIX, vaultBridgeLister, vaultBridgeSearcher, vaultBridgeWriter } from "@foldedspacelabs/metistry-mcp-brain";
import { ASSISTANT_DEFAULT_AREAS, INTERNAL_ASSISTANT_ID, ensureInternalAgent, revokeAgent, validateGrants } from "./agents.js";
import { httpVaultClient } from "./vault-client.js";
import { CrewRegistry } from "./crews.js";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { defaultGatewayFrom, parseTrustedProxies } from "./local-owner.js";
import { canonicalOrigin } from "./webauthn.js";
import { loadPublicIdentity } from "./identity.js";

const require_ = createRequire(import.meta.url);

const pool = makePool();
const queries = new QueryStore(pool);

// The instance's own assistant is the first INTERNAL agent on the mcp-brain
// surface (§4.11: one knowledge interface for all agents). Its scope is
// configuration in the user's hand — the environment is its manifest — so
// the registry row is re-synced from it on every start: token hash, grants
// (widest valid read unless narrowed), projects (empty = every project).
// The env var is the switch: absent, an existing row is revoked so the old
// token stops authenticating.
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (process.env.METISTRY_ASSISTANT_TOKEN) {
  const areas = list(process.env.METISTRY_ASSISTANT_AREAS);
  const r = await ensureInternalAgent(pool, INTERNAL_ASSISTANT_ID, {
    token: process.env.METISTRY_ASSISTANT_TOKEN,
    grants: validateGrants({ tier: "areas", areas: areas.length > 0 ? areas : [...ASSISTANT_DEFAULT_AREAS] }, { kind: "internal" }),
    projects: list(process.env.METISTRY_ASSISTANT_PROJECTS),
  });
  console.log(`internal agent '${r.id}' ${r.created ? "registered" : "re-synced"} (projects: ${list(process.env.METISTRY_ASSISTANT_PROJECTS).join(", ") || "all"})`);
} else if (await revokeAgent(pool, INTERNAL_ASSISTANT_ID)) {
  console.warn(`internal agent '${INTERNAL_ASSISTANT_ID}' revoked: METISTRY_ASSISTANT_TOKEN is unset (degrades: the assistant runs tool-less)`);
}

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

// compute.yaml (C1): providers, assignments and budgets, hot-reloaded.
// Here it does two things: when the file carries `assignments:`, they are the
// (model, effort) map the ROUTER records against (the assistant re-resolves
// the same names to a provider at the point of the call), and the file in
// force is what the collaboration rule and the routine budget pause read
// (docs/ops/compute.md).
const rulesTiers = rules.tiers;
const applyAssignments = (): void => {
  const assigned = computeTiers(compute.store.current);
  rules!.tiers = assigned ?? rulesTiers;
  console.log(assigned ? `tiers from compute.yaml assignments: ${Object.entries(assigned).map(([k, t]) => `${k}=${t.model}/${t.effort}`).join(" ")}` : "tiers from rules.yaml (compute.yaml assigns nothing)");
};
const compute = await watchCompute(pool, "console", applyAssignments);
applyAssignments();

// D4 overlay for compute targets (§4.18): product dir first, instance dirs after.
const targets = new TargetRegistry();
for (const dir of optionalEnv("METISTRY_TARGETS_DIRS", "targets").split(":")) {
  await targets.loadDir(dir);
}
console.log(`targets: ${targets.names().join(", ") || "(none)"}`);

// METISTRY_ORIGIN may be a comma-separated list; the FIRST entry is
// canonical (rpID, enrolled passkeys, the base for relative URLs) and the
// whole list is what the ceremonies accept (webauthn.ts).
const origins = requireEnv("METISTRY_ORIGIN"); // canonical HTTPS origin(s) (§4.2)
const origin = canonicalOrigin(origins);

// The local owner door (docs/ops/auth.md): METISTRY_LOCAL_OWNER_TOKEN over a
// connection from this machine authenticates as the `user` principal — the
// Mac app and the CLI, which run as the logged-in user and can already read
// the Keychain this token lives in. Unset = no local door; there is no
// default token and no fallback.
//
// METISTRY_TRUSTED_LOOPBACK_PROXY is how the compose shape says "a
// host-loopback connection reaches me NATed": docker-compose.yml sets the
// sentinel `docker-gateway`, resolved here, once, from this container's own
// default route. Unset (launchd, and any console nothing configured) =
// plain loopback.
const ownerToken = process.env.METISTRY_LOCAL_OWNER_TOKEN ?? "";
const trustedProxies = parseTrustedProxies(process.env.METISTRY_TRUSTED_LOOPBACK_PROXY, () => {
  try {
    return defaultGatewayFrom(readFileSync("/proc/net/route", "utf8"));
  } catch {
    return null; // not Linux, or no route table: nothing extra is trusted
  }
});
const localOwner = ownerToken ? { token: ownerToken, trusted: trustedProxies } : undefined;
console.log(
  localOwner
    ? `local owner token: enabled (peer must be loopback${trustedProxies.length ? ` or ${trustedProxies.join(", ")}` : ""})`
    : "local owner token absent: set METISTRY_LOCAL_OWNER_TOKEN for `metistry console whoami` and the Mac app (degrades: passkeys only)",
);
const push = pushConfigFromEnv();
if (!push) console.warn("web push absent: set METISTRY_VAPID_* to enable (degrades: absent)");

// The vault is reached over the reconciler's bridge (D5) with its own
// bearer — no vault mount in this container. It serves two things: note
// contents for mcp-brain's knowledge_read, and the artifacts module's
// storage (§4.21). Unset → both degrade to not_available.
const reconcilerUrl = process.env.METISTRY_RECONCILER_URL;
const reconcilerToken = process.env.METISTRY_BRIDGE_TOKEN_RECONCILER;
const vault = reconcilerUrl && reconcilerToken ? httpVaultClient({ url: reconcilerUrl, token: reconcilerToken }) : undefined;
const writeKnowledge = reconcilerUrl && reconcilerToken ? vaultBridgeWriter({ url: reconcilerUrl, token: reconcilerToken }) : undefined; // knowledge_write = brain-commit over the same bridge
const readKnowledge = vault ? async (path: string): Promise<string | null> => (await vault.read(path))?.content.toString("utf8") ?? null : undefined;
// knowledge_list / knowledge_grep (docs/research/2026-09-stash-review.md item 3): the same bridge, its list and keyword-search endpoints.
const listKnowledge = reconcilerUrl && reconcilerToken ? vaultBridgeLister({ url: reconcilerUrl, token: reconcilerToken }) : undefined;
const searchVaultKeyword = reconcilerUrl && reconcilerToken ? vaultBridgeSearcher({ url: reconcilerUrl, token: reconcilerToken }) : undefined;
if (!vault) console.warn("vault bridge absent: set METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER for knowledge_read, knowledge_write, knowledge_list, knowledge_grep and artifacts (degrades: absent)");

// Captures live in the vault at `Knowledge/Inbox/` (docs/ops/inbox.md), so
// Obsidian sees them and git carries them. The bytes go through the SAME
// bridge as every other vault write — the reconciler stays the only process
// holding the instance repo (D5), and this container gets no mount.
// Without a bridge the sink degrades to a plain directory: capture keeps
// working (SHOULD-10 — one silent drop ends the trust), those files are not
// in the vault, and moving them into `Knowledge/Inbox/` later is enough for
// the reconciler's scan to pick them up.
const inboxDir = optionalEnv("METISTRY_INBOX_DIR", process.env.METISTRY_INSTANCE_DIR ? `${process.env.METISTRY_INSTANCE_DIR.replace(/\/+$/, "")}/${INBOX_PREFIX}` : `./${INBOX_PREFIX}`);
const maxTrackedBytes = intEnv("METISTRY_INBOX_MAX_TRACKED_BYTES", DEFAULT_MAX_TRACKED_BYTES);
const inbox = vault ? vaultSink(vault, { maxTrackedBytes }) : dirSink(inboxDir, { prefix: inboxDir.endsWith(INBOX_PREFIX) ? INBOX_PREFIX : "", maxTrackedBytes });
console.log(`captures: ${inbox.describe}${maxTrackedBytes > 0 ? `, over ${maxTrackedBytes} bytes to .large/ (gitignored)` : ""}`);

// Phase 6: knowledge_search mode=semantic|hybrid needs to embed the QUERY
// with the same model the reconciler embedded the notes with. The vectors
// are already in Postgres; this is one call to the local server's
// /v1/embeddings (C18) — LM Studio, Ollama or the bundled llama-server,
// whichever compute.yaml's first on_machine provider names.
// Absent or unreachable → every mode answers, in keyword (degrades).
const localModel = resolveLocalModelUrl(process.env, firstOnMachineBaseUrl(compute.store.current));
if (localModel.warning) console.warn(localModel.warning);
const embedder =
  optionalEnv("METISTRY_EMBED_ENABLED", "true") === "false"
    ? undefined
    : new EmbedClient({
        url: localModel.url,
        model: optionalEnv("METISTRY_EMBED_MODEL", EMBED_DEFAULT_MODEL),
        dim: intEnv("METISTRY_EMBED_DIM", EMBED_DEFAULT_DIM),
      });
console.log(`embeddings: ${localModel.url}/embeddings (from ${localModel.from}), model ${optionalEnv("METISTRY_EMBED_MODEL", EMBED_DEFAULT_MODEL)}`);

// Crews (Phase 5; docs/ops/crews.md): agents/<area>/<name>.md manifests,
// D4 overlay — an entry not on disk is read through the vault bridge (that
// is how the instance repo's protected `agents/` reaches this container).
// Loaded now and re-synced on an interval; the registry rows are kind=crew.
const crews = new CrewRegistry(pool, optionalEnv("METISTRY_AGENTS_DIRS", "seed/agents:agents").split(":"), vault);
const logCrewSync = (s: Awaited<ReturnType<CrewRegistry["refresh"]>>) => {
  const changes = [`registered ${s.registered.length}`, `resynced ${s.resynced.length}`, `revoked ${s.revoked.length}`, ...(s.conflicts.length ? [`CONFLICTS ${s.conflicts.join(",")}`] : [])];
  console.log(`crews: ${crews.names().join(", ") || "(none)"} [${changes.join(", ")}] sources ${JSON.stringify(crews.sources)}`);
  for (const e of crews.errors) console.warn(`crews: refused ${e}`);
};
logCrewSync(await crews.refresh());
setInterval(() => crews.refresh().then(logCrewSync, (err) => console.error("crews: refresh failed:", err)), intEnv("METISTRY_CREWS_SYNC_S", 300) * 1000).unref();

// GET /api/identity: identity.yaml through the assistant's overlay rule
// (docs/ops/assistant-tools.md), defaulting to the instance repo's copy when
// METISTRY_INSTANCE_DIR says where that is.
const identityFiles = optionalEnv("METISTRY_IDENTITY_FILES", `seed/identity.yaml:${process.env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || "."}/identity.yaml`);
const identity = await loadPublicIdentity(identityFiles);
if (!identity) console.warn(`identity absent: no complete identity.yaml (name + instance_id) in ${identityFiles} — GET /api/identity answers 503 (degrades: absent)`);

// GET /api/instances (S4, docs/ops/instances.md): the peer registry the
// instance repo holds, read through the same overlay rule. There is no seed
// default — an install's peers are its own — so an instance dir is what
// makes the route answer at all.
const instanceDir = process.env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "");
const instancesFiles = process.env.METISTRY_INSTANCES_FILES ?? (instanceDir ? `${instanceDir}/${INSTANCES_FILENAME}` : undefined);
if (!instancesFiles) console.warn("peer registry absent: neither METISTRY_INSTANCES_FILES nor METISTRY_INSTANCE_DIR is set — GET /api/instances answers 503 (degrades: absent)");

const server = makeServer(pool, queries, {
  origin,
  origins,
  ...(identity ? { identity } : {}),
  ...(instancesFiles ? { instancesFiles } : {}),
  version: require_("../package.json").version,
  ...(localOwner ? { localOwner } : {}),
  inboxDir,
  inbox,
  policy: {
    idleDays: intEnv("METISTRY_SESSION_IDLE_DAYS", 30),
    maxDays: intEnv("METISTRY_SESSION_MAX_DAYS", 365),
  },
  secureCookies: origin.startsWith("https:"),
  webRoot: fileURLToPath(new URL("../web", import.meta.url)),
  rules,
  targets,
  ...(push ? { push } : {}),
  ...(readKnowledge ? { readKnowledge } : {}),
  ...(embedder ? { embedder } : {}),
  ...(writeKnowledge ? { writeKnowledge } : {}),
  ...(listKnowledge ? { listKnowledge } : {}),
  ...(searchVaultKeyword ? { searchVaultKeyword } : {}),
  ...(vault ? { vault } : {}),
  crews,
  compute: () => compute.store.current,
});
if (push) startNotifier(pool, push);

// routine runner (SHOULD-8): collectors scheduled from their manifests
const scheduled = [
  ...(await loadSchedules(collectors, optionalEnv("METISTRY_COLLECTORS_DIR", "collectors"))),
  ...(await loadSchedules(routines, optionalEnv("METISTRY_ROUTINES_DIR", "routines"))),
];
// The routine pause (C5): a routine that declares `requires.engine` is not
// started at all when the tier its turn would run on is over a `stop` budget
// — the same verdict the engine's guard reaches, from the same `spend` query
// (invariant 3), so the scheduler and the engine can never disagree.
const routineBudget = async (): Promise<PreflightMiss | null> => {
  const cfg = compute.store.current;
  if (!cfg.budgets || !queries.names().includes(SPEND_QUERY)) return null;
  const { rows } = await queries.run(SPEND_QUERY);
  return budgetMiss(cfg, rows as SpendRow[], ROUTINE_TIER);
};

startRunner(pool, scheduled, {
  // Which model a collector may call is `compute.yaml`'s to say, not an
  // environment variable's: a GETTER, so an edit to the file reaches the
  // next pass without a restart, plus the install's environment, because
  // that is where a provider's `auth.secret` resolves. The manifest's
  // `uses_model:` picks the provider out of it (runner.ts).
  compute: () => compute.store.current,
  secretEnv: process.env,
  ...(process.env.METISTRY_EK_URL ? { ekUrl: process.env.METISTRY_EK_URL } : {}),
  ...(process.env.METISTRY_BRIDGE_TOKEN_EVENTKIT ? { ekToken: process.env.METISTRY_BRIDGE_TOKEN_EVENTKIT } : {}),
  ...(process.env.METISTRY_GITHUB_TOKEN ? { githubToken: process.env.METISTRY_GITHUB_TOKEN } : {}),
  ...(process.env.METISTRY_AWS_ACCESS_KEY_ID && process.env.METISTRY_AWS_SECRET_ACCESS_KEY
    ? { aws: { accessKeyId: process.env.METISTRY_AWS_ACCESS_KEY_ID, secretAccessKey: process.env.METISTRY_AWS_SECRET_ACCESS_KEY, ...(process.env.METISTRY_AWS_SESSION_TOKEN ? { sessionToken: process.env.METISTRY_AWS_SESSION_TOKEN } : {}) } }
    : {}),
  ...(process.env.METISTRY_GITHUB_REPOS ? { githubRepos: process.env.METISTRY_GITHUB_REPOS.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  // devin-knowledge collector (degrades absent): the owner's own `cog_` key.
  // inboxDir is the same directory /capture writes to — this collector's
  // captures are ordinary inbox rows, made idempotent by (principal, key).
  ...(process.env.METISTRY_DEVIN_API_KEY ? { devinApiKey: process.env.METISTRY_DEVIN_API_KEY } : {}),
  ...(process.env.METISTRY_DEVIN_ORG_ID ? { devinOrgId: process.env.METISTRY_DEVIN_ORG_ID } : {}),
  ...(process.env.METISTRY_DEVIN_REPOS ? { devinRepos: process.env.METISTRY_DEVIN_REPOS.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
  ...(process.env.METISTRY_DEVIN_MAX_ITEMS ? { devinMaxItems: intEnv("METISTRY_DEVIN_MAX_ITEMS", 200) } : {}),
  // devin-sessions collector: the return path of targets/devin-sessions. It
  // reads the organization off each work row's meta, so only the key is
  // needed here; the base URL is shared with devin-knowledge.
  ...(process.env.METISTRY_DEVIN_API_URL ? { devinApiUrl: process.env.METISTRY_DEVIN_API_URL } : {}),
  ...(process.env.METISTRY_DEVIN_SESSION_TIMEOUT_HOURS ? { devinSessionTimeoutHours: intEnv("METISTRY_DEVIN_SESSION_TIMEOUT_HOURS", 24) } : {}),
  inboxDir,
  inboxSink: inbox,
}, intEnv("METISTRY_RUNNER_TICK_MS", 60_000), { budget: routineBudget });
console.log(`runner: ${scheduled.map((c) => `${c.name}/${c.intervalSec}s`).join(", ")}`);

const host = optionalEnv("METISTRY_CONSOLE_HOST", "127.0.0.1"); // loopback default (invariant 8)
const port = intEnv("METISTRY_CONSOLE_PORT", 8080);
server.listen(port, host, () => console.log(`console listening on ${host}:${port} (${queries.names().length} queries)`));
