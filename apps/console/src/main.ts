import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  budgetMiss,
  computeTiers,
  EMBED_DEFAULT_DIM,
  EMBED_DEFAULT_MODEL,
  EMBED_DEFAULT_URL,
  EmbedClient,
  configuredTimeZone,
  describeSchedule,
  extensionsDirFromEnv,
  firstOnMachineBaseUrl,
  INSTANCE_LAYOUT,
  instancePresence,
  overlayFilesFromEnv,
  resolveInstanceLayout,
  intEnv,
  optionalEnv,
  parseSecretsFile,
  requireEnv,
  resolveLocalModelUrl,
  ROUTINE_TIER,
  SCHEDULED_FILENAME,
  SPEND_QUERY,
  type BudgetMiss,
  type RegistrySkip,
  type SpendRow,
} from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { makePool } from "./db.js";
import { makeServer } from "./server.js";
import { pushConfigFromEnv, startNotifier } from "./push.js";
import { linearTrackerOpener, loadCollectors } from "@metistry-apps/collectors";
import { loadRoutines } from "@metistry-apps/routines";
import { PROFILE_PATH, loadSchedules, profileFacts, readOverlay, routineCapabilities, runNow, startRunner, unitOf, type ComponentCtx, type RunnerOptions } from "./runner.js";
import type { ScheduledAdmin } from "./scheduled-routes.js";
import { PLAN_ROUTINE, RoutineTrigger, closeTriggeredPass } from "./close-day.js";
import { loadRules, makeRoutePolicy } from "./router.js";
import { watchCompute } from "./compute.js";
import { TargetRegistry } from "./dispatch.js";
import {
  dirSink,
  vaultSink,
  DEFAULT_CONNECTION_ASKS_PER_HOUR,
  DEFAULT_CONNECTION_CALLS_PER_HOUR,
  DEFAULT_CONNECTION_CONFIRM_TTL_S,
  DEFAULT_MAX_TRACKED_BYTES,
  INBOX_PREFIX,
  vaultBridgeLister,
  vaultBridgeSearcher,
  vaultBridgeWriter,
  type ConnectionLimits,
} from "@foldedspacelabs/metistry-mcp-brain";
import { ASSISTANT_DEFAULT_AREAS, INTERNAL_ASSISTANT_ID, ensureInternalAgent, listAgents, revokeAgent, validateGrants } from "./agents.js";
import { httpVaultClient } from "./vault-client.js";
import { SCHEDULED_PATH, STANDUP_MOVE_RETRY_MS, fileOverlay, startStandupMove } from "./profile-tidy.js";
import { httpVaultStatus } from "./vault-status.js";
import { httpVaultReverter } from "./vault-rollback.js";
import { vaultBridgeConflicts, vaultBridgeHistory, vaultBridgeSearch } from "./knowledge-routes.js";
import type { ComputeAdmin } from "./compute-routes.js";
import type { SecretsView } from "./secrets-route.js";
import type { VariablesView } from "./variables-route.js";
import type { ConnectionsView } from "./connections-route.js";
import { envSecretSource, instanceSyncOpener } from "@foldedspacelabs/metistry-connections";
import { GithubWriteClient } from "./github-write.js";
import { readInstanceId, securityPresence, realExec } from "@foldedspacelabs/metistry-cli";
import { CrewRegistry, crewRoutineQueue } from "./crews.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { assistantPromptFiles, loadAssistantDefinition } from "./actors.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { defaultGatewayFrom, parseTrustedProxies } from "./local-owner.js";
import { canonicalOrigin } from "./webauthn.js";
import { loadPublicIdentity } from "./identity.js";
import { hubFromEnv, startEventFeed } from "./events.js";

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

// D4 overlay for rules too: last existing file wins. The instance half is
// resolved against METISTRY_INSTANCE_DIR (core's `overlayFilesFromEnv`), not against
// this process's cwd — the launchd console runs with the PRODUCT checkout as
// its working directory, so a relative `.metistry/rules.yaml` named the
// product's own directory and the router ran on the SEED's rules while the
// instance's file sat unread.
let rules;
for (const p of optionalEnv("METISTRY_RULES_FILES", overlayFilesFromEnv(process.env, "rules")).split(":")) {
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

// Extensions (plan §2.7, M15): the owner's units in `.metistry/extensions/`,
// loaded through the same registries as the product's. Only a console that
// can see its instance has any — the compose console mounts none (D5).
const extensionsDir = extensionsDirFromEnv(process.env);
console.log(extensionsDir ? `extensions: ${extensionsDir}` : "extensions: none — METISTRY_INSTANCE_DIR is unset, so product units only");
/** One line per unit a registry refused: never fatal, never silent (plan §2.7). */
const logSkips = (kind: string, skipped: readonly RegistrySkip[]): void => {
  for (const s of skipped) console.warn(`${kind} ${s.name ?? s.path}: skipped — ${s.reason} (${s.path})`);
};

// Compute targets (§4.18) load through the target registry: the FIRST
// METISTRY_TARGETS_DIRS entry is the product's, every later one the owner's
// overlay, then the extensions directory; an owner's unit wins by name (D4).
const [productTargets, ...ownerTargets] = optionalEnv("METISTRY_TARGETS_DIRS", `targets:${INSTANCE_LAYOUT.targetsDir}`).split(":");
const targets = new TargetRegistry();
await targets.load([
  ...(productTargets ? [{ dir: productTargets, origin: "product" as const }] : []),
  ...ownerTargets.map((dir) => ({ dir, origin: "extension" as const })),
  ...(extensionsDir ? [{ dir: extensionsDir, origin: "extension" as const }] : []),
]);
logSkips("target", targets.skipped);
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
// GET /api/knowledge/search (docs/ops/console-api.md): the SAME bridge
// endpoint, in a caller-chosen mode and carrying snippets. The keyword-pinned
// searcher above stays exactly what it is — knowledge_grep's candidate
// pre-filter — because widening it would change what a grep costs.
const searchKnowledge = reconcilerUrl && reconcilerToken ? vaultBridgeSearch({ url: reconcilerUrl, token: reconcilerToken }) : undefined;
// GET /api/knowledge/history and /version (§2.21, T10-4): a note's commits
// and its bytes at one of them — the bridge's /vault/log and /vault/show.
const knowledgeHistory = reconcilerUrl && reconcilerToken ? vaultBridgeHistory({ url: reconcilerUrl, token: reconcilerToken }) : undefined;
// POST /api/knowledge/conflicts/resolve (§2.11, T2-10): keep one side of a
// sync conflict, as `user` — the bridge's /vault/conflicts/resolve.
const knowledgeConflicts = reconcilerUrl && reconcilerToken ? vaultBridgeConflicts({ url: reconcilerUrl, token: reconcilerToken }) : undefined;
if (!vault) console.warn("vault bridge absent: set METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER for knowledge_read, knowledge_write, knowledge_list, knowledge_grep, /api/knowledge/* and artifacts (degrades: absent)");

// Captures live in the vault at `Inbox/` (docs/ops/inbox.md), so
// Obsidian sees them and git carries them. The bytes go through the SAME
// bridge as every other vault write — the reconciler stays the only process
// holding the instance repo (D5), and this container gets no mount.
// Without a bridge the sink degrades to a plain directory: capture keeps
// working (SHOULD-10 — one silent drop ends the trust), those files are not
// in the vault, and moving them into `Inbox/` later is enough for
// the reconciler's scan to pick them up.
//
// An instance that has not run `metistry migrate-layout` yet still keeps its
// vault — and so its inbox — in `Knowledge/`. Both the directory and the
// prefix the rows are recorded under come from the resolved layout rather
// than the flat spelling: a legacy instance would otherwise capture into a
// new root `Inbox/` that its own Obsidian vault cannot see.
const inboxLayout = process.env.METISTRY_INSTANCE_DIR ? resolveInstanceLayout(process.env.METISTRY_INSTANCE_DIR) : undefined;
const inboxPrefix = inboxLayout?.layout.inboxDir ?? INBOX_PREFIX;
const inboxDir = optionalEnv("METISTRY_INBOX_DIR", inboxLayout ? inboxLayout.path("inboxDir") : `./${INBOX_PREFIX}`);
const maxTrackedBytes = intEnv("METISTRY_INBOX_MAX_TRACKED_BYTES", DEFAULT_MAX_TRACKED_BYTES);
const inbox = vault ? vaultSink(vault, { prefix: inboxPrefix, maxTrackedBytes }) : dirSink(inboxDir, { prefix: inboxDir.endsWith(inboxPrefix) ? inboxPrefix : "", maxTrackedBytes });
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
const crews = new CrewRegistry(pool, optionalEnv("METISTRY_AGENTS_DIRS", `seed/agents:${INSTANCE_LAYOUT.agentsDir}`).split(":"), vault, {
  // so an actor's definition names each file relative to where it lives (docs/ops/actors.md)
  instanceDir: process.env.METISTRY_INSTANCE_DIR?.trim() || undefined,
  productDir: process.cwd(),
});
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
const identityFiles = optionalEnv("METISTRY_IDENTITY_FILES", overlayFilesFromEnv(process.env, "identity"));
const identity = await loadPublicIdentity(identityFiles);
if (!identity) console.warn(`identity absent: no complete identity.yaml (name + instance_id) in ${identityFiles} — GET /api/identity answers 503 (degrades: absent)`);

// GET /api/instances (S4, docs/ops/instances.md): the peer registry the
// instance repo holds, read through the same overlay rule. There is no seed
// default — an install's peers are its own — so an instance dir is what
// makes the route answer at all.
const instanceDir = process.env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "");
const instancesFiles = process.env.METISTRY_INSTANCES_FILES ?? (instanceDir ? resolveInstanceLayout(instanceDir).path("instances") : undefined);
if (!instancesFiles) console.warn("peer registry absent: neither METISTRY_INSTANCES_FILES nor METISTRY_INSTANCE_DIR is set — GET /api/instances answers 503 (degrades: absent)");

// `/api/compute*` (docs/ops/compute.md "From the console"): the same verbs
// `metistry compute` runs, over HTTP, for the `user` principal only. They
// open `<instanceDir>/.metistry/compute.yaml` as a YAML document, so the
// console has to be able to SEE that directory — which is exactly the
// difference between the shapes: the compose console gets no instance mount
// by design (D5), the launchd/native one runs as the user in the instance's
// own environment. Unset or unreadable → every compute route answers 503,
// and `metistry compute` on the Mac is still the whole surface.
const computeAdmin: ComputeAdmin | undefined =
  instanceDir && existsSync(instanceDir)
    ? {
        instanceDir,
        // Relative, like every other product default here
        // (METISTRY_QUERIES_DIRS, METISTRY_AGENTS_DIRS): both shapes run the
        // console with the directory holding `seed/` as its cwd.
        seedDir: optionalEnv("METISTRY_SEED_DIR", "seed"),
        env: process.env,
        platform: process.platform,
        uid: process.getuid?.() ?? 0,
      }
    : undefined;
console.log(
  computeAdmin
    ? `compute admin: ${resolveInstanceLayout(computeAdmin.instanceDir).path("compute")} (secret presence ${computeAdmin.platform === "darwin" ? "from the login Keychain" : "unknown — no Keychain on " + computeAdmin.platform})`
    : "compute admin absent: METISTRY_INSTANCE_DIR is unset or not readable — /api/compute* answers 503; `metistry compute` still works (degrades: absent)",
);

// GET /api/secrets (plan §2.14): the instance's `.metistry/secrets.yaml`, and
// — where there is a login Keychain — a PRESENCE probe bound to this
// instance's instance_id: `security find-generic-password` without `-w`,
// which answers from the item's attributes and never reads its data. That
// probe is the whole of the console's Keychain access; nothing here can
// return a value. No instance directory (the compose shape) → 503. No
// instance_id → the file is still listed, presence unknown.
const secretsInstanceId = computeAdmin ? await readInstanceId(computeAdmin.instanceDir) : undefined;
const secrets: SecretsView | undefined = computeAdmin
  ? {
      file: resolveInstanceLayout(computeAdmin.instanceDir).path("secrets"),
      ...(secretsInstanceId && process.platform === "darwin" ? { presence: instancePresence(securityPresence(realExec), secretsInstanceId) } : {}),
    }
  : undefined;
console.log(
  secrets
    ? `secrets: ${secrets.file} (presence ${secrets.presence ? `from the login Keychain, account ${secretsInstanceId}` : "unknown — no Keychain or no instance_id"})`
    : "secrets absent: METISTRY_INSTANCE_DIR is unset or not readable — GET /api/secrets answers 503; `metistry secrets list --named` still works (degrades: absent)",
);

// The owner's GitHub client (plan §2.11, T2-13): the pull request doors post
// a review, a thread reply or a resolve through it, as the owner, with the
// `github_write` secret `metistry secrets sync --to env` delivers
// (METISTRY_SECRET_GITHUB_WRITE) — only while secrets.yaml, read per call,
// sends it to api.github.com. Built here and handed to the doors alone; the
// github-state sync reads with its own read-only token and never sees it. No
// instance directory → no secrets.yaml → every door says what is missing.
const githubWrite = new GithubWriteClient({
  secrets: envSecretSource(process.env),
  policy: async () => (secrets && existsSync(secrets.file) ? parseSecretsFile(await readFile(secrets.file, "utf8")) : undefined),
});

// GET /api/variables (plan §2.14): the instance's `.metistry/variables.yaml`,
// and its `.metistry/` walked for *used in*. No instance directory → 503.
const variables: VariablesView | undefined = computeAdmin
  ? { instanceDir: computeAdmin.instanceDir, file: resolveInstanceLayout(computeAdmin.instanceDir).path("variables") }
  : undefined;
console.log(
  variables
    ? `variables: ${variables.file}`
    : "variables absent: METISTRY_INSTANCE_DIR is unset or not readable — GET /api/variables answers 503; `metistry variables list` still works (degrades: absent)",
);

// Live changes (§2.20): one hub, fed by ONE `LISTEN` on a connection of its
// own (migration 0035's triggers), streamed by `GET /api/events`. The feed
// re-establishes a dropped LISTEN by itself and tells subscribers to resync.
const events = hubFromEnv();
startEventFeed({ hub: events, db: pool, connect: () => pool.connect() });
const consoleVersion: string = require_("../package.json").version;

// The router's policy (T9-2, docs/ops/dynamic-router.md): the owner's
// `rules.yaml` `policy:` table, consulted IN SHADOW after the 202 on every
// fall-through and override. It reads the live tier map and `compute.yaml`
// (the session rule, and `assignments.intent` for its one local scorer), and
// checks a chosen query or crew against what is loaded now. No block, no
// policy: every route row reads `absent`, the shipped behaviour.
const routePolicy = makeRoutePolicy({
  rules,
  compute: () => compute.store.current,
  secretEnv: process.env,
  hasQuery: (name) => queries.names().includes(name),
  hasCrew: (name) => crews.get(name) !== undefined,
});
console.log(
  rules.policy
    ? `route policy: ${rules.policy.mode}, ${rules.policy.table.length} row(s), tiers ${rules.policy.tiers.join(" < ")}, deadline ${rules.policy.timeout_ms} ms`
    : "route policy: absent — no policy: block in rules.yaml (every route row reads `absent`)",
);

// GET /api/connections(/:name) (plan §2.6): the instance's
// `.metistry/connections/`, read against the connection-type registry (the
// seed's and the owner's extensions), with the same presence-only probe the
// Secrets list has. Nothing here dials. No instance directory → 503.
const connections: ConnectionsView | undefined = computeAdmin
  ? { instanceDir: computeAdmin.instanceDir, seedDir: computeAdmin.seedDir, ...(secrets?.presence ? { presence: secrets.presence } : {}) }
  : undefined;
// A sync reading its connection (T4-24, packages/connections `sync.ts`), and
// Send to Linear filing through one (T4-25): the instance's catalog, read
// afresh on every open, and the secrets `metistry secrets sync --to env`
// delivered for sync-read connections — filled at the egress door for each
// secret's listed hosts, never put on a request here. No instance: absent.
const openSync = connections ? instanceSyncOpener({ instanceDir: connections.instanceDir, seedDir: connections.seedDir, env: process.env }) : undefined;
console.log(
  connections
    ? `connections: ${resolveInstanceLayout(connections.instanceDir).path("connectionsDir")} (read-only; every write is \`metistry connections\`)`
    : "connections absent: METISTRY_INSTANCE_DIR is unset or not readable — GET /api/connections answers 503; `metistry connections list` still works (degrades: absent)",
);

// The connections proxy's confirm-token lifetime and hourly limits, each
// counted from `runs` (T4-9; docs/ops/connections.md). They bind whenever a
// proxy is mounted; the pool itself is not wired on a live console yet.
const connectionLimits: ConnectionLimits = {
  confirmTtlS: intEnv("METISTRY_CONNECTION_CONFIRM_TTL_S", DEFAULT_CONNECTION_CONFIRM_TTL_S),
  callsPerHour: intEnv("METISTRY_CONNECTION_CALLS_PER_HOUR", DEFAULT_CONNECTION_CALLS_PER_HOUR),
  asksPerHour: intEnv("METISTRY_CONNECTION_ASKS_PER_HOUR", DEFAULT_CONNECTION_ASKS_PER_HOUR),
};

// The routine pause (C5): a routine that declares `requires.engine` is not
// started at all when the tier its turn would run on is over a `stop` budget
// — the same verdict the engine's guard reaches, from the same `spend` query
// (invariant 3), so the scheduler and the engine can never disagree. The miss
// carries the budget it hit, which is what the runner keys the one Stop-limit
// request on (C133, T3-12): one per budget window, cleared when it resets.
const routineBudget = async (): Promise<BudgetMiss | null> => {
  const cfg = compute.store.current;
  if (!cfg.budgets || !queries.names().includes(SPEND_QUERY)) return null;
  const { rows } = await queries.run(SPEND_QUERY);
  return budgetMiss(cfg, rows as SpendRow[], ROUTINE_TIER);
};

// The owner's two layers over every manifest's schedule (§2.5), both read on
// EVERY tick so a change lands on the next one: `.metistry/scheduled.yaml`
// (the schedule and pause they set; absent = the defaults), and the facts in
// `Me/profile.md` a time of day follows — `working_days` and `timezone`,
// through the vault bridge like every other vault read here. No instance
// directory, no overlay; no bridge, a profile that says nothing (and a
// routine on `working_days` then says `no_working_days`, never guesses).
const scheduledFile = optionalEnv(
  "METISTRY_SCHEDULED_FILE",
  instanceDir ? join(instanceDir, resolveInstanceLayout(instanceDir).layout.metistryDir, SCHEDULED_FILENAME) : "",
);
const readProfile = vault ? async () => profileFacts((await vault.read(PROFILE_PATH))?.content.toString("utf8") ?? null) : undefined;
const runnerZone = configuredTimeZone(process.env);

const runnerOptions: RunnerOptions = {
  budget: routineBudget,
  compute: () => compute.store.current,
  scheduled: () => readOverlay(scheduledFile || null),
  ...(readProfile ? { profile: readProfile } : {}),
  timeZone: runnerZone,
  // New Routines (T3-8): each run is ONE crew run on its actor's queue, which
  // the assistant container's drain runs with a bearer minted for that run
  agentRoutines: crewRoutineQueue(new TasksService(pool), crews),
};

// The Scheduled doors (T3-3, scheduled-routes.ts): the runner's components,
// the overlay the runner reads, and — only when that is the instance's own
// `.metistry/scheduled.yaml` and the vault bridge is up — the reconciler's
// write of it as `user`. Anything else and the doors read but do not write,
// saying which of the two is missing.
const instanceScheduled = instanceDir ? join(instanceDir, SCHEDULED_PATH) : undefined;
const scheduledWritable = vault !== undefined && instanceScheduled !== undefined && scheduledFile === instanceScheduled;

// routine runner (SHOULD-8): collectors and routines scheduled from their
// manifests, each loaded through its registry (plan §2.7) — the product's
// directory, then the owner's extensions — and joined to its product code.
const loadedCollectors = await loadCollectors({ home: optionalEnv("METISTRY_COLLECTORS_DIR", "collectors"), extensionsDir });
const loadedRoutines = await loadRoutines({ home: optionalEnv("METISTRY_ROUTINES_DIR", "routines"), extensionsDir });
logSkips("collector", loadedCollectors.skipped);
logSkips("routine", loadedRoutines.skipped);
const scheduled = [...(await loadSchedules(loadedCollectors.collectors)), ...(await loadSchedules(loadedRoutines.routines))];
// What the runner hands every component (runner.ts `ComponentCtx`), built
// once here so Close the Day's on-demand pass of `plan-tomorrow` and the Scheduled doors' Run Now (T3-3) get exactly
// what the 11:00 PM one does.
const componentCtx: ComponentCtx = {
  // Which model a collector may call is `compute.yaml`'s to say, not an
  // environment variable's: a GETTER, so an edit to the file reaches the
  // next pass without a restart, plus the install's environment, because
  // that is where a provider's `auth.secret` resolves. The manifest's
  // `uses_model:` picks the provider out of it (runner.ts).
  compute: () => compute.store.current,
  secretEnv: process.env,
  // The intent tier's THRESHOLDS (PoC-20 phase 1, research §3.2 P2). They
  // travel from `rules.yaml` — a §4.7 protected path, the owner's own hand —
  // and not from `compute.yaml`, which names the model. Two files, because
  // they are two different decisions: which model may run this is the
  // operator's, and how confident it has to be before anything moves is the
  // owner's. The console validates the block at load and reads it nowhere
  // else; `inbox-drain` is what consumes it.
  ...(rules.intent ? { intentRules: rules.intent } : {}),
  // What a ROUTINE needs and no collector does (docs/product/daily-flow-spec.md
  // §7): the named-query store, so every row `plan-tomorrow` renders comes
  // through a named query and not through SQL of its own (invariant 3); the
  // vault bridge, which is where `Templates/Plan.md` is read from and
  // `Journal/Plan/<date>.md` is written to; and the `TemplateReader` adapter
  // over that same bridge, which `Templates/Fold.md` renders through
  // (`knowledge-fold`'s `FoldCtx.reader` has no `vault` field of its own).
  // All three are built once, here, from the objects this process already
  // built for the server — one console, one way in.
  ...routineCapabilities(queries, vault),
  ...(process.env.METISTRY_EK_URL ? { ekUrl: process.env.METISTRY_EK_URL } : {}),
  ...(process.env.METISTRY_BRIDGE_TOKEN_EVENTKIT ? { ekToken: process.env.METISTRY_BRIDGE_TOKEN_EVENTKIT } : {}),
  ...(process.env.METISTRY_GITHUB_TOKEN ? { githubToken: process.env.METISTRY_GITHUB_TOKEN } : {}),
  // A sync reading its connection (T4-24, packages/connections `sync.ts`):
  // the instance's catalog, read afresh per run, and the secrets `metistry
  // secrets sync --to env` delivered for sync-read connections — filled at
  // the egress door for each secret's listed hosts, never put on a request
  // here. The `linear` collector is the first reader. No instance: absent.
  ...(openSync ? { openSync } : {}),
  // The owner's zone for a sync that must say which day something is on —
  // the ICS sync's all-day dates and window (T4-12). METISTRY_TZ, never TZ.
  ...(runnerZone ? { ownerTimeZone: runnerZone } : {}),
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
  // the Update Check routine compares the newest release with THIS runtime —
  // the console's own version, which is the one `metistry update` replaces
  runtimeVersion: consoleVersion,
};

const scheduledAdmin: ScheduledAdmin = {
  components: scheduled,
  overlay: {
    read: fileOverlay(scheduledFile || undefined),
    ...(scheduledWritable
      ? { write: async (content: Buffer, expectedSha256: string, message: string) => void (await vault!.write(SCHEDULED_PATH, content, { principal: "user", message }, expectedSha256)) }
      : {
          readOnly: !instanceDir
            ? "METISTRY_INSTANCE_DIR is unset, so this console has no .metistry/scheduled.yaml to change (docs/ops/deployment-shapes.md)"
            : !vault
              ? "no vault bridge (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER) — the reconciler is the only writer of .metistry/scheduled.yaml"
              : `METISTRY_SCHEDULED_FILE names ${scheduledFile}, not the instance's ${instanceScheduled} — a change written there would not be the file the runner reads`,
        }),
  },
  ...(readProfile ? { profile: readProfile } : {}),
  timeZone: runnerZone,
  // Run Now gets the same componentCtx and options as a scheduled tick and Close the Day
  runNow: (name: string) => runNow(pool, scheduled, name, componentCtx, runnerOptions),
  // a New Routine's actor is a crew this console loaded (its run is one crew run), and a live one
  actorExists: async (id: string) => crews.get(id) !== undefined && (await listAgents(pool)).some((a) => a.id === id && a.kind === "crew" && !a.revoked),
  runsAssignments: true,
};

// Close the Day (T2-8, close-day.ts) enqueues `plan-tomorrow` with the day
// it closed (`closedDay`, the routine's close shape): one pass at a time, recorded as a `routine_run` like a
// scheduled one. Not loaded here (a trimmed routines directory) → the close
// still writes the section and says the plan was not enqueued.
const planRoutine = scheduled.find((c) => c.name === PLAN_ROUTINE && c.runKind === "routine_run");
const planTomorrow = planRoutine ? new RoutineTrigger(PLAN_ROUTINE, closeTriggeredPass(pool, planRoutine, componentCtx as Record<string, unknown>, unitOf(planRoutine).displayName)) : undefined;
if (!planTomorrow) console.warn(`${PLAN_ROUTINE} is not loaded: Close the Day writes the section but cannot render tomorrow's plan early`);

const server = makeServer(pool, queries, {
  origin,
  // Send to Linear (T4-25): the same opener the syncs read their connection
  // through — the catalog afresh per send, the key filled at the egress door
  // for api.linear.app only. No instance: the door answers 503.
  ...(openSync ? { openTracker: openSync } : {}),
  ...(secrets ? { secrets } : {}),
  githubWrite,
  ...(variables ? { variables } : {}),
  ...(connections ? { connections } : {}),
  // Close in Linear (T4-26): the tracker connection the path names, opened
  // through the same egress door the linear sync reads through — its key
  // delivered by `metistry secrets sync --to env`, filled for api.linear.app
  // only. No instance: the door answers 503.
  ...(connections ? { trackers: linearTrackerOpener({ instanceDir: connections.instanceDir, seedDir: connections.seedDir, env: process.env }) } : {}),
  connectionLimits,
  origins,
  ...(identity ? { identity } : {}),
  ...(instancesFiles ? { instancesFiles } : {}),
  version: consoleVersion,
  events,
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
  routePolicy,
  targets,
  ...(push ? { push } : {}),
  ...(readKnowledge ? { readKnowledge } : {}),
  ...(embedder ? { embedder } : {}),
  ...(writeKnowledge ? { writeKnowledge } : {}),
  ...(listKnowledge ? { listKnowledge } : {}),
  ...(searchVaultKeyword ? { searchVaultKeyword } : {}),
  ...(searchKnowledge ? { searchKnowledge } : {}),
  ...(knowledgeHistory ? { knowledgeHistory } : {}),
  ...(knowledgeConflicts ? { knowledgeConflicts } : {}),
  ...(computeAdmin ? { computeAdmin } : {}),
  ...(vault ? { vault } : {}),
  // Move a meeting (T2-12): the eventkit bridge, and the owner-door token only
  // this door presents — the bridge refuses a confirm for an event with others
  // in it without it, and nothing else in this process is handed it
  ...(process.env.METISTRY_EK_URL && process.env.METISTRY_BRIDGE_TOKEN_EVENTKIT
    ? {
        eventkit: {
          url: process.env.METISTRY_EK_URL,
          token: process.env.METISTRY_BRIDGE_TOKEN_EVENTKIT,
          ...(process.env.METISTRY_OWNER_DOOR_TOKEN_EVENTKIT?.trim() ? { ownerDoorToken: process.env.METISTRY_OWNER_DOOR_TOKEN_EVENTKIT.trim() } : {}),
        },
      }
    : {}),
  ...(planTomorrow ? { planTomorrow } : {}),
  // GET /api/vault/status: the reconciler's sync status over the same bridge (T10-2)
  ...(reconcilerUrl && reconcilerToken ? { vaultStatus: httpVaultStatus({ url: reconcilerUrl, token: reconcilerToken }) } : {}),
  ...(reconcilerUrl && reconcilerToken ? { vaultRevert: httpVaultReverter({ url: reconcilerUrl, token: reconcilerToken }) } : {}),
  crews,
  scheduled: scheduledAdmin,
  // Today's day (T2-7): METISTRY_TZ, never TZ — unset, Today counts days in UTC
  timeZone: configuredTimeZone(process.env),
  compute: () => compute.store.current,
  // the assistant's definition (T4-6): the same overlays the engine composes its prompt from
  assistantDefinition: () =>
    loadAssistantDefinition({
      identityFiles,
      promptFiles: assistantPromptFiles(process.env),
      instanceDir: process.env.METISTRY_INSTANCE_DIR?.trim() || undefined,
      productDir: process.cwd(),
    }),
});
if (push) startNotifier(pool, push);


startRunner(pool, scheduled, componentCtx, intEnv("METISTRY_RUNNER_TICK_MS", 60_000), runnerOptions);
console.log(`runner: ${scheduled.map((c) => `${c.name} (${describeSchedule(c.schedule)})`).join(", ")}`);
console.log(
  `runner: overlay ${scheduledFile || "(none — METISTRY_INSTANCE_DIR unset)"}; profile ${readProfile ? `${PROFILE_PATH} via the vault bridge` : "absent (no vault bridge)"}; ` +
    `fallback zone ${runnerZone ?? "none — set METISTRY_TZ, or a time of day with no tz and no profile timezone is refused no_timezone"}`,
);

const host = optionalEnv("METISTRY_CONSOLE_HOST", "127.0.0.1"); // loopback default (invariant 8)
const port = intEnv("METISTRY_CONSOLE_PORT", 8080);
server.listen(port, host, () => console.log(`console listening on ${host}:${port} (${queries.names().length} queries)`));

// The standup move (T3-4, profile-tidy.ts): `standup_days`/`standup_time`
// read ONCE from Me/profile.md into the Standup routine's scheduled.yaml
// entry, then one *Tidy Me/profile.md* request — only the owner's Approve
// edits Me/. Needs the vault bridge (the profile, and the overlay write as
// `user`) and the instance directory (the overlay read); without either it
// says so once and does nothing.
if (vault) startStandupMove({ vault, db: pool, readOverlay: fileOverlay(scheduledFile === instanceScheduled ? instanceScheduled : undefined) }, { retryMs: STANDUP_MOVE_RETRY_MS });
else console.log("standup move: no vault bridge — Me/profile.md cannot be read, so nothing moves");
