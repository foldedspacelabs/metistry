#!/usr/bin/env node
// The fixture recorder (design-build-plan §2.16, F-7): one JSON per client-API
// route MetistryKit reads, recorded from a SCRATCH console — the real server,
// real handlers, the scratch database — so every Mac view is built against
// what the console actually says (U9).
//
//   pnpm -r build
//   METISTRY_TEST_DB_NAME=metistry_test_<you> ops/scripts/test-db.sh
//   node apps/console/scripts/record-client-fixtures.mjs            record every served route
//   node apps/console/scripts/record-client-fixtures.mjs --only "GET /api/today"   just these (repeatable)
//   node apps/console/scripts/record-client-fixtures.mjs --check    record in memory; exit 1 where a shape moved
//   … --accept                                                     replace a contract fixture whose shape differs
//
// WHAT "SCRATCH" MEANS HERE, AND WHY IT IS SAFE TO RUN ANYWHERE:
//
//   * The database is opened with `testDb()` — the one opener that refuses
//     anything but a `metistry_test_*` scratch database no install on this
//     machine is configured with (docs/ops/testing.md). The environment is
//     scrubbed by `loadTestEnv` first: nothing but METISTRY_DB_* and
//     METISTRY_TEST_DB_NAME survives, so no bridge URL or token can leak in.
//   * The instance is `metistry init` into a fresh `os.tmpdir()` directory,
//     run with an empty environment, and deleted at the end.
//   * The console is `makeServer` in THIS process on an ephemeral loopback
//     port. Everything it would reach outward — the reconciler's bridge,
//     GitHub, a provider's /models — is an in-process fake handed to it;
//     nothing leaves the machine and no launchd job or container is started.
//
// Recorded bodies are redacted before they are written: a minted bearer
// becomes a placeholder, the scratch instance's temporary path becomes
// `<instance>`, and this checkout's own path `<product>`.
//
// Rows frozen ahead of their ticket keep their hand-written `contract`
// fixture until the console serves them; then this script needs a request for
// the row in REQUESTS below, and it compares the recording's shape with the
// contract fixture before it replaces it (client-fixtures.mjs).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { CLIENT_API, INSTANCE_LAYOUT, InstanceSecrets, SECRET_USE_META_KEY, memoryKeychain, mintToken, resolveInstanceLayout } from "@foldedspacelabs/metistry-core";
import { readInstanceId } from "@foldedspacelabs/metistry-cli";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault } from "@foldedspacelabs/metistry-artifacts";
import { INBOX_PREFIX, vaultSink } from "@foldedspacelabs/metistry-mcp-brain";
import { makeServer } from "../dist/server.js";
import * as authStore from "../dist/auth-store.js";
import * as agents from "../dist/agents.js";
import { CrewRegistry } from "../dist/crews.js";
import { assistantPromptFiles, loadAssistantDefinition } from "../dist/actors.js";
import { loadRules } from "../dist/router.js";
import { TargetRegistry } from "../dist/dispatch.js";
import { loadPublicIdentity } from "../dist/identity.js";
import { FIXTURE_DIR, REPO_ROOT, expectedFixtures, fixtureBody, shapeDiff } from "./client-fixtures.mjs";

// ---- arguments -------------------------------------------------------------------

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const ACCEPT = argv.includes("--accept");
const ONLY = argv.flatMap((a, i) => (a === "--only" ? [argv[i + 1]] : []));
for (const a of argv) {
  if (!["--check", "--accept", "--only"].includes(a) && !ONLY.includes(a)) {
    console.error(`record-client-fixtures: unknown argument ${JSON.stringify(a)}`);
    process.exit(2);
  }
}

// ---- the scratch database ---------------------------------------------------------

const { hasDb } = loadTestEnv(join(REPO_ROOT, ".env"));
if (!hasDb) {
  console.error("record-client-fixtures: no scratch database — set METISTRY_DB_* and METISTRY_TEST_DB_NAME, and run ops/scripts/test-db.sh first (docs/ops/testing.md)");
  process.exit(2);
}
const pool = await testDb(pg.Pool);

// ---- the scratch instance: `metistry init`, with nothing of this shell's environment ----

const root = await mkdtemp(join(tmpdir(), "metistry-fixtures-"));
const instanceDir = join(root, "inst");
execFileSync(process.execPath, [join(REPO_ROOT, "packages/cli/dist/main.js"), "init", instanceDir, "--name", "Aide", "--shape", "launchd"], {
  env: { HOME: root, PATH: "/usr/bin:/bin" },
  stdio: ["ignore", "ignore", "inherit"],
});
const layout = resolveInstanceLayout(instanceDir);
await writeFile(
  layout.path("compute"),
  `providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    zdr: true
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
assignments:
  default: { model: lmstudio/gemma, effort: medium }
`,
);
await writeFile(
  layout.path("instances"),
  `instances:
  - instance_id: "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
    name: Second
    origin: https://second.example.com
    last_seen: "2026-09-16T01:00:00.000Z"
    capabilities: [capture, knowledge, queries, tasks]
    resources: []
`,
);

// the Secrets list (§2.14): a policy file, and a Keychain in memory — never the
// login Keychain — holding this instance's item, so `present` reads true
await writeFile(
  layout.path("secrets"),
  `secrets:
  github_write:
    hosts: [api.github.com]
    grants:
      connection:github: on
      agent:devin: ask
`,
);
// the Variables list (§2.14): the file, and a connection that declares one —
// so `read_by` and `used_in` have something to say
await writeFile(layout.path("variables"), `variables:\n  team_name: Platform\n  company: Acme\n`);
await mkdir(join(layout.path("metistryDir"), "connections"), { recursive: true });
await writeFile(join(layout.path("metistryDir"), "connections", "github.yaml"), `name: github\ntype: mcp\nvariables: [team_name]\n`);

const fixtureKeychain = memoryKeychain();
const instanceSecrets = new InstanceSecrets(fixtureKeychain, await readInstanceId(instanceDir));
await instanceSecrets.set("github_write", "fixture-value-never-recorded");

// ---- the outside world, faked in-process ------------------------------------------

/** The reconciler's bridge, GitHub, a provider's /models: every outbound call the console could make lands here. */
const outbound = [];
const fakeFetch = async (input, init) => {
  const url = String(input);
  outbound.push(url);
  if (url.endsWith("/vault/write")) return new Response(JSON.stringify({ path: INSTANCE_LAYOUT.compute, sha256: "0".repeat(64), bytes: 1, created: false }), { status: 200 });
  if (url.includes("/models")) return new Response(JSON.stringify({ data: [{ id: "gemma" }, { id: "qwen" }] }), { status: 200 });
  if (url.startsWith("https://api.github.com/repos/example/fixtures/issues") && init?.method === "POST") {
    return new Response(JSON.stringify({ number: 41, html_url: "https://github.com/example/fixtures/issues/41" }), { status: 201 });
  }
  if (url.startsWith("https://api.github.com/repos/example/fixtures")) return new Response(JSON.stringify({ full_name: "example/fixtures", permissions: { push: true } }), { status: 200 });
  return new Response("{}", { status: 200 });
};

const vault = memoryVault();
const PAGE = "Projects/Metistry/Roadmap.md";
await vault.write(PAGE, Buffer.from("# Roadmap\n\nShip the store interface, then the stores. See [[Projects/Metistry/Design]].\n"), { principal: "user", message: "fixture" });

// a day note with tasks on it, for the Tick door (T2-4) and the Defer door (T2-5) to write — one each, so neither sees the other's edit
const DAY = "Journal/2026-09-28.md";
const TASK_TEXT = "Send Dana the fixture format";
const DEFER_TEXT = "Draft the Q4 plan";
await vault.write(DAY, Buffer.from(`# 2026-09-28\n\n- [ ] ${TASK_TEXT} due 2026-09-28 p2 size s ^mt-7f3k2a\n- [ ] Book the room for Thursday\n- [ ] ${DEFER_TEXT} due 2026-10-01 p1 ^mt-4q8r2d\n`), { principal: "user", message: "fixture" });

const queries = new QueryStore(pool);
await queries.loadDir(join(REPO_ROOT, "seed/queries"));
const targets = new TargetRegistry({ env: { METISTRY_GITHUB_WRITE_TOKEN: "fixture-not-a-token", METISTRY_GITHUB_DISPATCH_REPO: "example/fixtures" }, fetchFn: fakeFetch });
await targets.loadDir(join(REPO_ROOT, "targets"));

// the shipped crew, loaded as the console loads it: an actor with a definition
// (T4-6). Synced after the seeded rows below, so its audit rows come after them
// in the ledger and the runs export still opens on the turn.
const crews = new CrewRegistry(pool, [join(REPO_ROOT, "seed/agents")], undefined, { productDir: REPO_ROOT, instanceDir });

const localOwnerToken = mintToken();
const policy = { idleDays: 30, maxDays: 365 };
const server = makeServer(pool, queries, {
  origin: "http://127.0.0.1:8080",
  localOwner: { token: localOwnerToken, trusted: [] },
  inboxDir: layout.path("inboxDir"),
  // the vault is the capture sink and the knowledge reader, as on an install with its reconciler up
  inbox: vaultSink(vault, { prefix: INBOX_PREFIX }),
  readKnowledge: async (path) => (await vault.read(path))?.content.toString("utf8") ?? null,
  policy,
  secureCookies: false,
  rules: loadRules(await readFile(layout.path("rules"), "utf8")),
  targets,
  vault,
  identity: await loadPublicIdentity(layout.path("identity")),
  crews,
  assistantDefinition: () =>
    loadAssistantDefinition({
      identityFiles: `${join(REPO_ROOT, "seed/identity.yaml")}:${layout.path("identity")}`,
      promptFiles: assistantPromptFiles({ METISTRY_INSTANCE_DIR: instanceDir, METISTRY_SEED_DIR: join(REPO_ROOT, "seed") }),
      instanceDir,
      productDir: REPO_ROOT,
    }),
  version: JSON.parse(readFileSync(join(REPO_ROOT, "apps/console/package.json"), "utf8")).version,
  instancesFiles: layout.path("instances"),
  secrets: { file: layout.path("secrets"), presence: instanceSecrets.presence() },
  variables: { instanceDir, file: layout.path("variables") },
  computeAdmin: {
    instanceDir,
    seedDir: join(REPO_ROOT, "seed"),
    env: { METISTRY_RECONCILER_URL: "http://127.0.0.1:1", METISTRY_BRIDGE_TOKEN_RECONCILER: "fixture-not-a-token" },
    platform: "linux", // keeps the Keychain out of it: secret presence reads as false, honestly
    uid: 501,
    fetchFn: fakeFetch,
  },
  searchKnowledge: async (q, mode, limit) => ({
    q,
    mode: mode ?? "keyword",
    hits: [{ path: PAGE, title: "Roadmap", description: "what ships next", snippet: "…Ship the store interface, then the stores…", score: 0.82, source: "keyword" }].slice(0, limit),
    degraded: "keyword only — the embedder is down",
  }),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- seeded rows: what a week of use leaves behind ----------------------------------

const P = "metistry";
const ids = {};
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

await pool.query(`INSERT INTO projects (id, title, area, mode) VALUES ($1, 'Metistry', 'Projects/Metistry', 'review') ON CONFLICT (id) DO NOTHING`, [P]);
ids.task = Number((await one(`INSERT INTO work (title, project, kind, status, created_by, due) VALUES ('Freeze the store interface', $1, 'task', 'open', 'user', current_date + 1) RETURNING id`, [P])).id);
ids.dispatchTask = Number((await one(`INSERT INTO work (title, project, kind, status, created_by) VALUES ('Open the release checklist', $1, 'task', 'open', 'user') RETURNING id`, [P])).id);
ids.roomTask = Number((await one(`INSERT INTO work (title, project, kind, status, created_by) VALUES ('Decide the fixture format', $1, 'task', 'in_progress', 'user') RETURNING id`, [P])).id);

const outboundMessage = async (text) => Number((await one(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'reply') RETURNING id`, [text])).id);
await pool.query(`INSERT INTO inbound_messages (thread, text, status) VALUES ('default', 'what is on today?', 'done')`);
ids.reply = await outboundMessage("Three things today: the store interface, the fixture recorder, and a review.");

const proposal = async (kind, payload) => Number((await one(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, 'assistant', 'internal', $2::jsonb) RETURNING id`, [kind, JSON.stringify(payload)])).id);
// its own thread: a message into a decision's thread answers it (docs/ops/reply-feedback.md)
ids.decision = await proposal("decision", { title: "Which fixture format?", options: ["one file per route", "one file per store"], thread: "fixtures-triage" });
ids.knowledge = await proposal("knowledge", { title: "Add the store list to the roadmap", path: PAGE, summary: "fourteen domain stores, one per screen family" });
ids.later = await proposal("report", { title: "Nightly fold finished", summary: "12 pages touched" });

const turnId = `turn-${mintToken(6).replaceAll(/[^A-Za-z0-9]/g, "")}`;
ids.run = Number((await one(
  `INSERT INTO runs (component, kind, tool, provider, model, tokens_in, tokens_out, cost_usd, ok, duration_ms, meta)
   VALUES ('assistant', 'turn', NULL, 'lmstudio', 'gemma', 900, 120, 0.004200, true, 2300, jsonb_build_object('turn_id', $1::text, 'tier', 'default')) RETURNING id`,
  [turnId],
)).id);
await pool.query(`INSERT INTO runs (component, kind, tool, ok, duration_ms, meta) VALUES ('assistant', 'tool', 'knowledge_search', true, 12, jsonb_build_object('turn_id', $1::text)), ('assistant', 'tool', 'tasks_update', true, 30, jsonb_build_object('turn_id', $1::text))`, [turnId]);
// the egress fill's stamp: the NAMES a run filled in, which is where *last used* comes from
await pool.query(`INSERT INTO runs (ts, component, kind, ok, meta) VALUES ('2026-09-28T13:00:02.000Z', 'egress-proxy', 'egress', true, jsonb_build_object($1::text, jsonb_build_array('github_write')))`, [SECRET_USE_META_KEY]);
// a rename through `metistry identity set` (T2-16): the reconciler records every
// protected write it accepts as a `config_write` run, which is how Activity shows it
await pool.query(`INSERT INTO runs (component, kind, tool, ok, finished_at, duration_ms, meta) VALUES ('reconciler', 'config_write', 'vault_write', true, now(), 3, $1::jsonb)`, [
  JSON.stringify({ path: INSTANCE_LAYOUT.identity, op: "write", caller: "owner", principal: "user", message: "metistry identity set: name Iris → Ada, mention @iris → @ada" }),
]);

await pool.query(
  `INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES
     ($1, 'Roadmap', 'what ships next', false, 'clean', now(), now()),
     ('Projects/Metistry/Design.md', 'Design', 'the store interface', false, 'clean', now(), now())
   ON CONFLICT (path) DO NOTHING`,
  [PAGE],
);
await pool.query(`INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, 'Projects/Metistry/Design.md', 'wikilink') ON CONFLICT DO NOTHING`, [PAGE]);

// the walk's row for that task: the index a tick finds its note through (seed/queries/vault_task_by_key.yaml)
await pool.query(
  `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, due, priority, size, project, area, parsed_on, first_seen_on, last_seen_at)
   VALUES ($1, 'mt-7f3k2a', 'mt-7f3k2a', 3, $2, lower($2), false, '2026-09-28', 2, 's', $3, 'Projects/Metistry', '2026-09-28', '2026-09-25', now())
   ON CONFLICT (path, task_key) DO UPDATE SET checked = false`,
  [DAY, TASK_TEXT, P],
);
await pool.query(
  `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, due, priority, project, area, parsed_on, first_seen_on, last_seen_at)
   VALUES ($1, 'mt-4q8r2d', 'mt-4q8r2d', 5, $2, lower($2), false, '2026-10-01', 1, $3, 'Projects/Metistry', '2026-09-28', '2026-09-25', now())
   ON CONFLICT (path, task_key) DO UPDATE SET checked = false, scheduled_for = NULL`,
  [DAY, DEFER_TEXT, P],
);

// the board's other two shapes (T1-2): a Blocked card waiting on that todo
// (`meta.blocked_by`, resolved to its text), and a Done card whose crew
// reported back — the `reported` facet, from the one work→runs join. Ids
// given, far past the sequence, so every other fixture's work ids are the
// ones they were recorded with.
ids.blockedTask = Number((await one(
  `INSERT INTO work (id, title, project, kind, status, created_by, meta) OVERRIDING SYSTEM VALUE VALUES (41, 'Pick the fixture redaction', $1, 'task', 'blocked', 'user', jsonb_build_object('blocked_by', $2::text)) RETURNING id`,
  [P, `vault:${DAY}#^mt-7f3k2a`],
)).id);
ids.reportedTask = Number((await one(`INSERT INTO work (id, title, project, kind, status, created_by, closed_at) OVERRIDING SYSTEM VALUE VALUES (42, 'Measure the recorder run time', $1, 'task', 'closed', 'user', now()) RETURNING id`, [P])).id);
await pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ('crew:fixtures', 'crew_run', true, now(), now(), jsonb_build_object('work_id', $1::bigint, 'reports', 1))`, [ids.reportedTask]);

// the session archive (T3-9): one session the fold has not read yet, one it
// has — what Purge Now's preview names, and what it leaves unnamed
await pool.query(
  `INSERT INTO session_archive (session_id, thread, turn_id, ts, system_prompt, messages, tool_calls, folded_at, expires_at) VALUES
     ('7b1f2c9e-0000-4000-8000-000000000001', 'default', 'turn-fixture-1', '2026-09-28T12:00:00Z', 'you are Aide', '[{"role":"user","content":"what is on today?"}]', '[]', NULL,  now() + interval '30 days'),
     ('7b1f2c9e-0000-4000-8000-000000000001', 'default', 'turn-fixture-2', '2026-09-28T12:04:00Z', 'you are Aide', '[{"role":"user","content":"and tomorrow?"}]',     '[]', NULL,  now() + interval '30 days'),
     ('7b1f2c9e-0000-4000-8000-000000000002', 'fold',    'turn-fixture-3', '2026-09-27T21:00:00Z', 'you are Aide', '[{"role":"user","content":"fold the day"}]',      '[]', now(), now() + interval '30 days')
   ON CONFLICT (session_id, turn_id) DO NOTHING`,
);

// devices: two sessions on one passkey — one to list, one to revoke
const pkId = `fixture-${mintToken(6)}`;
await authStore.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: ["internal"], origin: "http://127.0.0.1:8080", label: "iPhone" });
await authStore.issueSession(pool, pkId, policy);
await authStore.issueSession(pool, pkId, policy);
ids.session = Number((await one(`SELECT max(s.id) AS id FROM auth_sessions s WHERE s.passkey_id = $1`, [pkId])).id);

// agents: one to hold grants, one to revoke, one to rotate
const agent = async (id, name, extra = {}) => (await agents.createAgent(pool, { id, display_name: name, ...extra })).id;
ids.agent = await agent("cursor", "Cursor");
ids.revokeAgent = await agent("old-laptop", "Old laptop");
ids.rotateAgent = await agent("opencode", "OpenCode");
// …and what a week leaves on two of them, so the permission rows have something
// to say (T4-6): two folders — one of them approved in Needs You — a project and
// named queries on one; room to propose (⏱) on the other. (The PUTs below still
// change something: they narrow cursor's grant, and raise cursor's autonomy.)
await agents.setGrants(pool, ids.agent, { tier: "areas", areas: ["Projects", "Areas/Ops"], queries: true });
await agents.setProjects(pool, ids.agent, [P]);
await agents.setAutonomy(pool, ids.rotateAgent, { level: "propose" }, { allowWidening: true });
await pool.query(
  `INSERT INTO proposals (kind, source_agent, trust, payload, decision, decided_at) VALUES ('access_request', $1, 'external', $2::jsonb, 'allow', now())`,
  [ids.agent, JSON.stringify({ area: "Areas/Ops", reason: "the runbooks live there", granted: { area: "Areas/Ops", by: "user" } })],
);
// the instance's own assistant, registered from its configuration as the console does at start
await agents.ensureInternalAgent(pool, agents.INTERNAL_ASSISTANT_ID, { token: mintToken(32) });
await crews.refresh();

// ---- the requests: one per served route the kit reads ------------------------------
//
// Order matters: reads first, then writes, then the ones that end something.
// A path is a function because it needs an id the seeding (or an earlier
// request) produced.

const REQUESTS = [
  ["GET /health", () => ({ path: "/health" })],
  ["GET /api/identity", () => ({ path: "/api/identity" })],
  ["GET /api/whoami", () => ({ path: "/api/whoami" })],
  ["GET /api/status", () => ({ path: "/api/status" })],
  ["GET /api/devices", () => ({ path: "/api/devices" })],
  ["GET /api/instances", () => ({ path: "/api/instances" })],
  ["GET /api/secrets", () => ({ path: "/api/secrets" })],
  ["GET /api/variables", () => ({ path: "/api/variables" })],
  ["GET /api/commands", () => ({ path: "/api/commands" })],
  ["GET /api/proposals", () => ({ path: "/api/proposals" })],
  ["GET /api/agents", () => ({ path: "/api/agents" })],
  ["GET /api/agents/:id/definition", () => ({ path: "/api/agents/researcher/definition" })],
  ["GET /api/projects", () => ({ path: "/api/projects" })],
  ["GET /api/targets", () => ({ path: "/api/targets" })],
  ["GET /api/runs/:id", () => ({ path: `/api/runs/${ids.run}` })],
  ["GET /api/runs/export", () => ({ path: "/api/runs/export?limit=3", ndjson: true })],
  ["GET /api/compute", () => ({ path: "/api/compute" })],
  ["GET /api/compute/models", () => ({ path: "/api/compute/models" })],
  ["GET /api/knowledge/search", () => ({ path: "/api/knowledge/search?q=store" })],
  ["GET /api/knowledge/page", () => ({ path: `/api/knowledge/page?path=${encodeURIComponent(PAGE)}` })],
  ["GET /api/knowledge/pages", () => ({ path: "/api/knowledge/pages?prefix=Projects" })],
  ["GET /api/knowledge/links", () => ({ path: `/api/knowledge/links?path=${encodeURIComponent(PAGE)}` })],

  ["POST /capture", () => ({ path: "/capture", body: { note: "Ask Dana about the fixture format on Thursday." }, key: "fixture-capture-0001" })],
  ["POST /message", () => ({ path: "/message", body: { text: "What's on today?" } })],
  ["POST /api/messages/:id/feedback", () => ({ path: `/api/messages/${ids.reply}/feedback`, body: { rating: 1, note: "exactly the three" } })],
  ["DELETE /api/messages/:id/feedback", () => ({ path: `/api/messages/${ids.reply}/feedback` })],
  ["POST /api/proposals/:id", () => ({ path: `/api/proposals/${ids.decision}`, body: { decision: "one file per route" } })],
  ["POST /api/proposals/batch", () => ({ path: "/api/proposals/batch", body: { ids: [ids.later], decision: "later" } })],

  ["POST /api/agents", () => ({ path: "/api/agents", body: { id: "devin", display_name: "Devin", remote: true } })],
  ["PUT /api/agents/:id/grants", () => ({ path: `/api/agents/${ids.agent}/grants`, body: { tier: "areas", areas: ["Projects"], queries: true } })],
  ["PUT /api/agents/:id/projects", () => ({ path: `/api/agents/${ids.agent}/projects`, body: { projects: [P] } })],
  ["PUT /api/agents/:id/autonomy", () => ({ path: `/api/agents/${ids.agent}/autonomy`, body: { level: "propose" } })],
  ["POST /api/agents/:id/approve", () => ({ path: "/api/agents/devin/approve", body: {} })],
  ["POST /api/agents/:id/rotate", () => ({ path: `/api/agents/${ids.rotateAgent}/rotate`, body: {} })],
  ["POST /api/agents/:id/revoke", () => ({ path: `/api/agents/${ids.revokeAgent}/revoke`, body: {} })],

  ["PUT /api/projects/:slug", () => ({ path: `/api/projects/${P}`, body: { mode: "review", daily_budget_usd: 5 } })],
  ["PATCH /api/tasks/:id", () => ({ path: `/api/tasks/${ids.task}`, body: { title: "Freeze the store interface (F-7)" } })],
  ["POST /api/tasks/:id/claim", () => ({ path: `/api/tasks/${ids.task}/claim`, body: { lease_seconds: 3600 } })],
  ["POST /api/tasks/:id/renew", () => ({ path: `/api/tasks/${ids.task}/renew`, body: { note: "halfway", lease_seconds: 3600 } })],
  ["POST /api/tasks/:id/release", () => ({ path: `/api/tasks/${ids.task}/release`, body: { note: "back to the board" } })],
  ["POST /api/tasks/:id/dispatch", () => ({ path: `/api/tasks/${ids.dispatchTask}/dispatch`, body: { target: "github-issues", brief: "Open the release checklist for 0.12.0 under Projects/Metistry." } })],

  ["POST /api/artifacts", () => ({ path: "/api/artifacts", body: { project: P, slug: "store-interface", idempotency_key: "fixture-store-interface-1", message: "first cut", files: [{ path: "notes.md", content: "# Store interface\n\nOne protocol per domain.\n" }], expected_current_version: null } })],
  ["POST /api/artifacts", () => ({ path: "/api/artifacts", body: { project: P, slug: "store-interface", idempotency_key: "fixture-store-interface-2", message: "second cut", files: [{ path: "notes.md", content: "# Store interface\n\nOne protocol per domain, one method per route.\n" }], expected_current_version: ids.v1 } }), "v2"],
  ["GET /api/artifacts", () => ({ path: `/api/artifacts?project=${P}` })],
  ["GET /api/artifacts/:id", () => ({ path: `/api/artifacts/${ids.artifact}` })],
  ["GET /api/artifacts/:id/versions", () => ({ path: `/api/artifacts/${ids.artifact}/versions` })],
  ["GET /api/artifacts/:id/versions/:version", () => ({ path: `/api/artifacts/${ids.artifact}/versions/${ids.v2}` })],
  ["GET /api/artifacts/:id/versions/:version/file", () => ({ path: `/api/artifacts/${ids.artifact}/versions/${ids.v2}/file?path=notes.md` })],
  ["GET /api/artifacts/:id/diff", () => ({ path: `/api/artifacts/${ids.artifact}/diff?from=${ids.v1}` })],
  ["POST /api/artifacts/:id/comments", () => ({ path: `/api/artifacts/${ids.artifact}/comments`, body: { version: ids.v2, body: "Name the owning ticket beside each placeholder.", path: "notes.md", anchor: { line: 3 } } })],
  ["GET /api/artifacts/:id/comments", () => ({ path: `/api/artifacts/${ids.artifact}/comments?version=${ids.v2}` })],
  ["POST /api/dispatches", () => ({ path: "/api/dispatches", body: { artifact: ids.artifact, version: ids.v2, thread_ids: [ids.comment], to_agent: ids.agent, message: "One comment to address." } })],
  ["GET /api/dispatches/:id", () => ({ path: `/api/dispatches/${ids.dispatch}` })],
  ["POST /api/artifacts/:id/comments/:comment/resolve", () => ({ path: `/api/artifacts/${ids.artifact}/comments/${ids.comment}/resolve`, body: {} })],
  ["POST /api/artifacts/:id/comments/:comment/reopen", () => ({ path: `/api/artifacts/${ids.artifact}/comments/${ids.comment}/reopen`, body: {} })],

  ["POST /api/work/:id/comments", () => ({ path: `/api/work/${ids.roomTask}/comments`, body: { body: "One file per route — the stem is the method and the path." } })],
  ["GET /api/work/:id/thread", () => ({ path: `/api/work/${ids.roomTask}/thread` })],
  ["POST /api/work/:id/thread/resolve", () => ({ path: `/api/work/${ids.roomTask}/thread/resolve`, body: {} })],
  ["POST /api/work/:id/thread/reopen", () => ({ path: `/api/work/${ids.roomTask}/thread/reopen`, body: {} })],

  ["POST /api/compute/assign", () => ({ path: "/api/compute/assign", body: { tier: "deep", model: "openrouter/anthropic/claude-opus-4", effort: "high" } })],
  ["POST /api/compute/budget", () => ({ path: "/api/compute/budget", body: { scope: "provider:openrouter", daily: 5, monthly: 60, action: "stop" } })],
  ["POST /api/compute/providers/test", () => ({ path: "/api/compute/providers/test", body: { name: "lmstudio" } })],

  // Purge Now's first step: the preview, which deletes nothing (a confirmed purge would empty what later fixtures read)
  ["POST /api/sessions/purge", () => ({ path: "/api/sessions/purge", body: { confirm: false } })],

  ["POST /api/vault-tasks/:task_key/check", () => ({ path: "/api/vault-tasks/mt-7f3k2a/check", body: { checked: true, seen_text: TASK_TEXT }, key: "tick-0928-0001" })],
  ["POST /api/vault-tasks/:task_key/schedule", () => ({ path: "/api/vault-tasks/mt-4q8r2d/schedule", body: { do: "2026-09-30", seen_text: DEFER_TEXT }, key: "defer-0928-0001" })],


  // the reads that show the writes above: a room with a comment, a feed with a capture in it
  ["GET /api/q/board", () => ({ path: `/api/q/board?project=${P}` })],
  ["GET /api/q/rooms", () => ({ path: "/api/q/rooms" })],
  ["GET /api/q/agent_presence", () => ({ path: "/api/q/agent_presence" })],
  ["GET /api/q/activity_feed", () => ({ path: "/api/q/activity_feed?hours=24" })],
  ["GET /api/messages", () => ({ path: "/api/messages?limit=20" })],

  ["POST /api/devices/:id/revoke", () => ({ path: `/api/devices/${ids.session}/revoke`, body: {} })],
];

/** What a response hands on to a later request. */
function remember(route, body, tag) {
  if (route === "POST /api/artifacts" && tag !== "v2") {
    ids.artifact = body.artifact.id;
    ids.v1 = body.version.id;
  }
  if (route === "POST /api/artifacts" && tag === "v2") ids.v2 = body.version.id;
  if (route === "POST /api/artifacts/:id/comments") ids.comment = body.comment.id;
  if (route === "POST /api/dispatches") ids.dispatch = body.work.id;
}

// ---- recording --------------------------------------------------------------------

const PLACEHOLDER_TOKEN = "fixture-token-not-a-secret";
/** A minted bearer never lands in the repository, and neither does this machine's temp path. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "token" && typeof v === "string" ? PLACEHOLDER_TOKEN : redact(v)]));
  if (typeof value === "string") return value.split(instanceDir).join("<instance>").split(root).join("<scratch>").split(REPO_ROOT).join("<product>");
  return value;
}

async function perform(route, make) {
  const req = make();
  const method = route.split(" ")[0];
  const bodied = req.body !== undefined;
  const r = await fetch(base + req.path, {
    method,
    headers: {
      authorization: `Bearer ${localOwnerToken}`,
      ...(bodied ? { "content-type": "application/json" } : {}),
      ...(req.key ? { "idempotency-key": req.key } : {}),
    },
    ...(bodied ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await r.text();
  const parsed = req.ndjson ? text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : text === "" ? null : JSON.parse(text);
  return { req, status: r.status, parsed };
}

const table = expectedFixtures(CLIENT_API);
const byRoute = new Map();
for (const f of table) {
  const key = f.route === "GET /api/q/:name" ? `GET ${f.path}` : f.route;
  byRoute.set(key, f);
}

const recorded = new Map(); // stem → fixture
const failures = [];
for (const [key, make, tag] of REQUESTS) {
  const f = byRoute.get(key);
  if (!f) {
    failures.push(`${key}: the recorder has a request for it, but the kit has no fixture for that row`);
    continue;
  }
  const { req, status, parsed } = await perform(key, make);
  if (status >= 300) {
    // a refusal is not a recording of the route: nothing is written for it
    failures.push(`${key}: ${status} ${JSON.stringify(parsed)}`);
    continue;
  }
  remember(f.route, parsed, tag);
  if (tag) continue; // a set-up request for a later one, not the recording
  const fixture = {
    route: f.route,
    source: "recorded",
    ticket: f.ticket,
    request: { method: key.split(" ")[0], path: req.path, body: req.body ?? null, idempotency_key: req.key ?? null },
    status,
    ...(req.ndjson ? { body_ndjson: redact(parsed) } : { body: redact(parsed) }),
  };
  recorded.set(f.stem, fixture);
}
for (const f of table) {
  if (f.served && !recorded.has(f.stem) && !failures.some((x) => x.startsWith(f.route))) {
    failures.push(`${f.route} (${f.stem}): served, and the recorder has no request for it — add one to REQUESTS`);
  }
}

await new Promise((r) => server.close(() => r()));
await pool.end();
await rm(root, { recursive: true, force: true });
if (outbound.some((u) => !u.startsWith("http://127.0.0.1:1/") && !u.startsWith("https://api.github.com/repos/example/fixtures") && !u.includes("/models"))) {
  failures.push(`an outbound call went somewhere unexpected: ${outbound.join(", ")}`);
}

// ---- writing, or checking -------------------------------------------------------

const read = (stem) => {
  const p = join(FIXTURE_DIR, `${stem}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const selected = (fixture) => ONLY.length === 0 || ONLY.includes(fixture.route) || ONLY.includes(`${fixture.request.method} ${fixture.request.path.split("?")[0]}`);

let written = 0;
const drift = [];
for (const [stem, fixture] of recorded) {
  if (!selected(fixture)) continue;
  const existing = read(stem);
  const diff = existing ? shapeDiff(fixtureBody(existing), fixtureBody(fixture)) : [];
  if (existing && existing.status !== fixture.status) diff.unshift(`status ${existing.status} in the fixture, ${fixture.status} recorded`);
  if (!existing && CHECK) diff.push("no fixture yet — record it");
  if (diff.length > 0) drift.push({ stem, from: existing?.source ?? "none", diff });
  if (CHECK) continue;
  if (existing?.source === "contract" && diff.length > 0 && !ACCEPT) continue; // reported below; --accept replaces it
  await mkdir(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, `${stem}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  written++;
}

for (const f of failures) console.error(`FAIL ${f}`);
for (const d of drift) {
  const verdict = d.from === "contract" && !ACCEPT ? "does NOT match its contract fixture (rerun with --accept to replace it, and say why in the PR)" : CHECK ? "moved" : "changed shape";
  console.error(`${CHECK || d.from === "contract" ? "DRIFT" : "note"} ${d.stem}: ${verdict}\n  ${d.diff.join("\n  ")}`);
}
const contractLeft = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json") && read(n.slice(0, -5))?.source === "contract").length;
console.log(`${CHECK ? "checked" : "recorded"} ${recorded.size} served route(s)${CHECK ? "" : `, wrote ${written}`}; ${contractLeft} contract fixture(s) wait for their tickets`);
const blocking = failures.length > 0 || drift.some((d) => (CHECK ? true : d.from === "contract" && !ACCEPT));
process.exit(blocking ? 1 : 0);
