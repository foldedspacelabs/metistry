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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { CLIENT_API, INSTANCE_LAYOUT, InstanceSecrets, SECRET_USE_META_KEY, calendarDate, memoryKeychain, mintToken, resolveInstanceLayout, writeNoteSection } from "@foldedspacelabs/metistry-core";
import { readInstanceId } from "@foldedspacelabs/metistry-cli";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { VaultError, memoryVault } from "@foldedspacelabs/metistry-artifacts";
import { INBOX_PREFIX, vaultSink } from "@foldedspacelabs/metistry-mcp-brain";
import { makeServer } from "../dist/server.js";
import * as authStore from "../dist/auth-store.js";
import * as agents from "../dist/agents.js";
import { CrewRegistry } from "../dist/crews.js";
import { assistantPromptFiles, loadAssistantDefinition } from "../dist/actors.js";
import { loadRules } from "../dist/router.js";
import { TargetRegistry } from "../dist/dispatch.js";
import { loadPublicIdentity } from "../dist/identity.js";
import { EventHub, startEventFeed } from "../dist/events.js";
import { parseVaultStatus } from "../dist/vault-status.js";
import { RoutineTrigger } from "../dist/close-day.js";
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
    auth: { secret: "{{ secret.openrouter_api_key }}" }
    zdr: true
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
  ollama:
    kind: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    locality: on_machine
    enabled: false
assignments:
  default: { model: lmstudio/gemma, effort: medium }
  tiers:
    fast: { model: lmstudio/qwen, effort: low }
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
// the Connections list (§2.6, T4-8a): a stdio MCP server whose token is the
// github_write secret above (granted to connection:github, and held), with a
// tool at each mode; and a sync in scheduled.yaml that reads it, for *used by*.
// Nothing dials it: a read of the list never starts the command.
await mkdir(join(layout.path("metistryDir"), "connections"), { recursive: true });
await writeFile(
  join(layout.path("metistryDir"), "connections", "github.yaml"),
  `name: github
type: mcp
provider: custom
description: GitHub's MCP server
reach:
  command:
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "{{ secret.github_write }}"
      GITHUB_TEAM: "{{ variable.team_name }}"
secrets: [github_write]
variables: [team_name]
tools:
  search_issues: { group: reads, mode: on }
  create_issue: { group: changes, mode: ask }
  delete_issue: { group: changes, mode: off }
offer_to_agents: false
`,
);
await writeFile(join(layout.path("metistryDir"), "scheduled.yaml"), `syncs:\n  github-state:\n    connection: github\n`);

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
  // OpenRouter's catalogue carries names, context and prices; a local server's carries ids (T4-18's catalogue groups both by model)
  if (url === "https://openrouter.ai/api/v1/models") {
    return new Response(
      JSON.stringify({
        data: [
          { id: "google/gemma-3-4b-it", name: "Google: Gemma 3 4B", context_length: 131072, pricing: { prompt: "0.00000002", completion: "0.00000004" } },
          { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] },
        ],
      }),
      { status: 200 },
    );
  }
  if (url.includes("/models")) return new Response(JSON.stringify({ data: [{ id: "gemma" }, { id: "qwen" }, { id: "google/gemma-3-4b" }] }), { status: 200 });
  if (url.startsWith("https://api.github.com/repos/example/fixtures/issues") && init?.method === "POST") {
    return new Response(JSON.stringify({ number: 41, html_url: "https://github.com/example/fixtures/issues/41" }), { status: 201 });
  }
  if (url.startsWith("https://api.github.com/repos/example/fixtures")) return new Response(JSON.stringify({ full_name: "example/fixtures", permissions: { push: true } }), { status: 200 });
  return new Response("{}", { status: 200 });
};

const vault = memoryVault();
const PAGE = "Projects/Metistry/Roadmap.md";
const HISTORY = [
  { sha: "4c1d2e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", author: "Metistry user", date: "2026-09-28T09:10:00-04:00", subject: "Rename the plan to the roadmap", source: "user", runs: [], turns: [], path: PAGE, change: "renamed", content: "# Roadmap\n\nShip the store interface, then the stores.\n" },
  { sha: "9ab8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0", author: "Metistry assistant", date: "2026-09-27T23:00:00-04:00", subject: "Fold: the store interface", source: "assistant", runs: ["4107"], turns: ["t_fold-0928"], path: "Projects/Metistry/Plan.md", change: "modified", content: "# Plan\n\nShip the store interface.\n" },
  { sha: "1f2e3d4c5b6a79880706a5b4c3d2e1f0a9b8c7d6", author: "Metistry user", date: "2026-09-27T14:10:00-04:00", subject: "Start the plan", source: "user", runs: [], turns: [], path: "Projects/Metistry/Plan.md", change: "added", content: "# Plan\n" },
];
await vault.write(PAGE, Buffer.from("# Roadmap\n\nShip the store interface, then the stores. See [[Projects/Metistry/Design]].\n"), { principal: "user", message: "fixture" });
const PAGE_SHA256 = (await vault.read(PAGE)).sha256; // what GET /api/knowledge/page serves as `sha256` — the restore's `seen_sha`

// a day note with tasks on it, for the Tick door (T2-4) and the Defer door (T2-5) to write — one each, so neither sees the other's edit
const DAY = "Journal/2026-09-28.md";
const TASK_TEXT = "Send Dana the fixture format";
const DEFER_TEXT = "Draft the Q4 plan";
await vault.write(DAY, Buffer.from(`# 2026-09-28\n\n- [ ] ${TASK_TEXT} due 2026-09-28 p2 size s ^mt-7f3k2a\n- [ ] Book the room for Thursday\n- [ ] ${DEFER_TEXT} due 2026-10-01 p1 ^mt-4q8r2d\n`), { principal: "user", message: "fixture" });

// the reconciler's section operation (T2-6), in memory, as the bridge runs it —
// core's `writeNoteSection` — for Close the Day (T2-8); and today's note, from
// the seeded Templates/Daily.md shape, markers and all. Close the Day closes
// TODAY, so this one note is dated by the recording's clock (UTC here).
vault.section = async (path, marker, body, principal, outer) => {
  const cur = await vault.read(path);
  if (!cur) throw new VaultError("not_found", `${path} does not exist`);
  const out = writeNoteSection(cur.content, marker, body, outer);
  if (!out.ok) throw new VaultError(out.code, out.message ?? out.code);
  const w = await vault.write(path, out.content, { principal, message: `update the ${marker} section of ${path}` }, cur.sha256);
  return { path, section: marker, sha256: w.sha256, bytes: w.bytes, outer_sha256: out.outerSha256, appended: out.appended };
};
const CLOSE_DAY = calendarDate(new Date(), process.env.METISTRY_TZ || "UTC");
await vault.write(`Journal/${CLOSE_DAY}.md`, Buffer.from(`# ${CLOSE_DAY}\n\n## Today\n\n## Today · Metistry\n\n<!-- metistry:day -->\n<!-- /metistry:day -->\n\n## Notes\n`), { principal: "user", message: "fixture" });

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
// The live-changes hub (§2.20). Its ids start at a pinned number so a
// re-recording diffs by what changed rather than by the clock; its LISTEN is
// started only for the stream recording at the end, so nothing the requests
// below write is in it.
const STREAM_FIRST_ID = 4100;
const events = new EventHub({ firstId: STREAM_FIRST_ID });
const server = makeServer(pool, queries, {
  origin: "http://127.0.0.1:8080",
  events,
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
  // Close the Day's plan-tomorrow, enqueued — a pass that does nothing here: the recording is of the door
  planTomorrow: new RoutineTrigger("plan-tomorrow", async () => {}),
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
  connections: { instanceDir, seedDir: join(REPO_ROOT, "seed"), presence: instanceSecrets.presence() },
  // the reconciler's GET /vault/status, as a week of use leaves it: two
  // commits not yet pushed under after_commit (the remote was unreachable
  // for the last attempt), nothing new on the remote, no conflict
  vaultStatus: async () =>
    parseVaultStatus({
      branch: "main",
      remote: "origin",
      ahead: 2,
      behind: 0,
      last_commit: { sha: "4c1d2e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", subject: "Tick 1 task", author: "user", at: "2026-09-28T12:58:01.000Z" },
      last_push: { at: "2026-09-28T12:58:31.000Z", ok: false, remote: "origin", error: "fatal: unable to access 'https://github.com/example/vault.git/': Could not resolve host: github.com" },
      last_pull: { at: "2026-09-28T13:00:00.000Z", ok: true, remote: "origin" },
      conflict: null,
      policy: { push: "after_commit", pull: { every: "5m" } },
      as_of: "2026-09-28T13:05:00.000Z",
    }),
  computeAdmin: {
    instanceDir,
    seedDir: join(REPO_ROOT, "seed"),
    // the provider key as a service receives it (T4-18): its delivery variable, never the Keychain
    env: { METISTRY_RECONCILER_URL: "http://127.0.0.1:1", METISTRY_BRIDGE_TOKEN_RECONCILER: "fixture-not-a-token", METISTRY_SECRET_OPENROUTER_API_KEY: "fixture-not-a-key" },
    platform: "linux", // keeps the Keychain out of it: presence reads from the delivery variable
    uid: 501,
    fetchFn: fakeFetch,
  },
  searchKnowledge: async (q, mode, limit) => ({
    q,
    mode: mode ?? "keyword",
    hits: [{ path: PAGE, title: "Roadmap", description: "what ships next", snippet: "…Ship the store interface, then the stores…", score: 0.82, source: "keyword" }].slice(0, limit),
    degraded: "keyword only — the embedder is down",
  }),
  // the reconciler's GET /vault/log and GET /vault/show for the roadmap (T10-4):
  // the owner wrote it as Plan.md, a fold edited it, the owner renamed it
  knowledgeHistory: {
    log: async (path) => (path === PAGE ? HISTORY : []),
    show: async (path, sha) => {
      const c = HISTORY.find((h) => h.sha.startsWith(sha) && h.path === path);
      if (!c) throw new VaultError("not_found", `${path} does not exist at ${sha}`);
      const content = Buffer.from(c.content);
      const { content: _c, change: _ch, ...commit } = c; // the bridge's /vault/show carries no `change`
      return { ...commit, content, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
    },
  },
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
// a card its creator described (T1-1, C85) — the board's `description`, set at create
ids.roomTask = Number((await one(`INSERT INTO work (title, project, kind, status, created_by, description) VALUES ('Decide the fixture format', $1, 'task', 'in_progress', 'user', 'One JSON per route, recorded from a scratch console; the views are built against them.') RETURNING id`, [P])).id);

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
// routines on Activity (T1-3, C43): the plan a routine wrote, one that threw
// (`ok = false`, no `meta.outcome` — the runner's catch, T1-4) and a silent
// tick, which the feed must leave out
await pool.query(
  `INSERT INTO runs (component, kind, ok, error, started_at, finished_at, meta) VALUES
     ('plan-tomorrow', 'routine_run', true, NULL, now(), now(), '{"planned_for":"2026-09-29","outcome":"acted","path":"Journal/Plan/2026-09-29.md"}'),
     ('knowledge-fold', 'routine_run', false, 'vault bridge unreachable', now(), now(), '{"error_signature":"fixture"}'),
     ('morning-brief', 'routine_run', true, NULL, now(), now(), '{"processed":0,"outcome":"silent"}')`,
);

await pool.query(
  `INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES
     ($1, 'Roadmap', 'what ships next', false, 'clean', now(), now()),
     ('Projects/Metistry/Design.md', 'Design', 'the store interface', false, 'clean', now(), now())
   ON CONFLICT (path) DO NOTHING`,
  [PAGE],
);
await pool.query(`INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, 'Projects/Metistry/Design.md', 'wikilink') ON CONFLICT DO NOTHING`, [PAGE]);
// the owner's three knowledge reads (T1-6): last night's fold naming the roadmap (and a
// draft, which the fold route drops), one draft waiting on the owner, and an area whose
// README carries the one-line description the areas list shows
const FOLD = "Journal/Fold/2026-09-28.md";
await pool.query(
  `INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES
     ($1, 'Fold — 28 September', NULL, false, 'clean', '2026-09-28T01:00:00Z', now()),
     ('Areas/Health/README.md', 'Health', 'Sleep, labs, and the protein blend', false, 'clean', '2026-09-20T12:00:00Z', now()),
     ('Areas/Health/Sleep.md', 'Sleep', 'the taper', true, 'clean', '2026-09-27T20:00:00Z', now())
   ON CONFLICT (path) DO NOTHING`,
  [FOLD],
);
await pool.query(
  `INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, $2, 'wikilink'), ($1, 'Areas/Health/Sleep.md', 'wikilink') ON CONFLICT DO NOTHING`,
  [FOLD, PAGE],
);

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
// three questions in one request (T2-3): pick one, pick any with Something
// else…, and one that takes its own options only — as `requests_create` kind
// `question` stores them (context, provenance), asked by the assistant; the
// stepped card's fixture. Seeded after every other proposal so no recorded id
// moves, and a minute older than them so the queue's newest question is still
// the one the component samples draw.
ids.questions = Number((await one(`INSERT INTO proposals (ts, kind, source_agent, trust, payload) VALUES (now() - interval '1 minute', 'decision', 'assistant', 'external', $1::jsonb) RETURNING id`, [
  JSON.stringify({
    title: "Three things before I open the fixtures PR",
    questions: [
      { prompt: "Which store should the fixtures land under?", options: ["NeedsYouStore", "TodayStore"], multi: false, allow_other: true },
      { prompt: "Who should review it?", options: ["Dana", "Kessler", "the assistant"], multi: true, allow_other: true },
      { prompt: "Open it as a draft?", options: ["yes", "no"], multi: false, allow_other: false },
    ],
    context: { prose: "The recorder writes one file per route; the PR needs a home and reviewers.", refs: ["gh:foldedspacelabs/metistry#339"] },
    provenance: { agent: "assistant", via: "mcp-brain", submitted_at: "2026-09-28T12:50:00.000Z" },
  }),
])).id);
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
  ["GET /api/connections", () => ({ path: "/api/connections" })],
  ["GET /api/connections/:name", () => ({ path: "/api/connections/github" })],
  ["GET /api/vault/status", () => ({ path: "/api/vault/status" })],
  ["GET /api/commands", () => ({ path: "/api/commands" })],
  ["GET /api/proposals", () => ({ path: "/api/proposals" })],
  // recorded alongside `GET /api/proposals`, before anything below answers
  // or snoozes one of the four seeded proposals: the acceptance this
  // fixture demonstrates (T1-7) is that `waiting` matches that list's
  // length exactly, at the same moment.
  ["GET /api/needs-you/count", () => ({ path: "/api/needs-you/count" })],
  ["GET /api/agents", () => ({ path: "/api/agents" })],
  ["GET /api/agents/:id/definition", () => ({ path: "/api/agents/researcher/definition" })],
  ["GET /api/projects", () => ({ path: "/api/projects" })],
  ["GET /api/targets", () => ({ path: "/api/targets" })],
  ["GET /api/runs/:id", () => ({ path: `/api/runs/${ids.run}` })],
  ["GET /api/runs/export", () => ({ path: "/api/runs/export?limit=3", ndjson: true })],
  // Chat's working indicator (T2-17): the same turn_id `run_detail`'s tool calls above carry.
  ["GET /api/turns/:turn_id/progress", () => ({ path: `/api/turns/${turnId}/progress` })],
  // Run detail's conversation (T2-17): the unfolded session seeded below, two turns.
  ["GET /api/sessions/:id", () => ({ path: "/api/sessions/7b1f2c9e-0000-4000-8000-000000000001" })],
  ["GET /api/compute", () => ({ path: "/api/compute" })],
  ["GET /api/compute/models", () => ({ path: "/api/compute/models" })],
  // T4-18: grouped by model, the switched-off ollama skipped, every listing read now
  ["GET /api/compute/catalogue", () => ({ path: "/api/compute/catalogue?q=gemma&refresh=true" })],
  ["GET /api/knowledge/search", () => ({ path: "/api/knowledge/search?q=store" })],
  ["GET /api/knowledge/page", () => ({ path: `/api/knowledge/page?path=${encodeURIComponent(PAGE)}` })],
  ["GET /api/knowledge/pages", () => ({ path: "/api/knowledge/pages?prefix=Projects" })],
  ["GET /api/knowledge/links", () => ({ path: `/api/knowledge/links?path=${encodeURIComponent(PAGE)}` })],
  ["GET /api/knowledge/fold", () => ({ path: "/api/knowledge/fold?date=2026-09-28" })],
  ["GET /api/knowledge/drafts", () => ({ path: "/api/knowledge/drafts?limit=20" })],
  ["GET /api/knowledge/areas", () => ({ path: "/api/knowledge/areas" })],
  ["GET /api/knowledge/history", () => ({ path: `/api/knowledge/history?path=${encodeURIComponent(PAGE)}` })],
  ["GET /api/knowledge/version", () => ({ path: `/api/knowledge/version?path=${encodeURIComponent("Projects/Metistry/Plan.md")}&sha=9ab8c7d6` })],
  // T10-5: put the roadmap back as it was at the rename — a Needs You request, nothing written; `seen_sha` is the page's hash as GET /api/knowledge/page served it
  ["POST /api/knowledge/restore", () => ({ path: "/api/knowledge/restore", body: { path: PAGE, sha: "4c1d2e3f", seen_sha: PAGE_SHA256 } })],

  ["POST /capture", () => ({ path: "/capture", body: { note: "Ask Dana about the fixture format on Thursday." }, key: "fixture-capture-0001" })],
  ["POST /message", () => ({ path: "/message", body: { text: "What's on today?" } })],
  ["POST /api/messages/:id/feedback", () => ({ path: `/api/messages/${ids.reply}/feedback`, body: { rating: 1, note: "exactly the three" } })],
  ["DELETE /api/messages/:id/feedback", () => ({ path: `/api/messages/${ids.reply}/feedback` })],
  ["POST /api/prose/:id/feedback", () => ({ path: `/api/prose/${ids.run}/feedback`, body: { rating: 1, note: "guessed instead of retrieving" } })],
  ["DELETE /api/prose/:id/feedback", () => ({ path: `/api/prose/${ids.run}/feedback` })],
  // Send Answers on the three-question request (T2-3): one answer per question — an option, options and the owner's words, an option
  ["POST /api/proposals/:id", () => ({ path: `/api/proposals/${ids.questions}`, body: { decision: "answers", answers: [{ choices: ["NeedsYouStore"] }, { choices: ["Dana", "the assistant"], other: "and whoever owns F-7" }, { choices: ["yes"] }] } })],
  ["POST /api/proposals/batch", () => ({ path: "/api/proposals/batch", body: { ids: [ids.later], decision: "later" } })],

  ["POST /api/agents", () => ({ path: "/api/agents", body: { id: "devin", display_name: "Devin", remote: true } })],
  ["PUT /api/agents/:id/grants", () => ({ path: `/api/agents/${ids.agent}/grants`, body: { tier: "areas", areas: ["Projects"], queries: true } })],
  ["PUT /api/agents/:id/projects", () => ({ path: `/api/agents/${ids.agent}/projects`, body: { projects: [P] } })],
  ["PUT /api/agents/:id/autonomy", () => ({ path: `/api/agents/${ids.agent}/autonomy`, body: { level: "propose" } })],
  ["POST /api/agents/:id/approve", () => ({ path: "/api/agents/devin/approve", body: {} })],
  ["POST /api/agents/:id/rotate", () => ({ path: `/api/agents/${ids.rotateAgent}/rotate`, body: {} })],
  ["POST /api/agents/:id/revoke", () => ({ path: `/api/agents/${ids.revokeAgent}/revoke`, body: {} })],

  ["PUT /api/projects/:slug", () => ({ path: `/api/projects/${P}`, body: { mode: "review", daily_budget_usd: 5 } })],
  ["PATCH /api/tasks/:id", () => ({ path: `/api/tasks/${ids.task}`, body: { title: "Freeze the store interface (F-7)", description: "One protocol per store, and every method answers from a fixture before its route is served." } })],
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
  ["POST /api/compute/unassign", () => ({ path: "/api/compute/unassign", body: { tier: "fast" } })],
  ["POST /api/compute/budget", () => ({ path: "/api/compute/budget", body: { scope: "provider:openrouter", daily: 5, monthly: 60, action: "stop" } })],
  ["POST /api/compute/providers/test", () => ({ path: "/api/compute/providers/test", body: { name: "lmstudio" } })],

  // Purge Now's first step: the preview, which deletes nothing (a confirmed purge would empty what later fixtures read)
  ["POST /api/sessions/purge", () => ({ path: "/api/sessions/purge", body: { confirm: false } })],

  ["POST /api/vault-tasks/:task_key/check", () => ({ path: "/api/vault-tasks/mt-7f3k2a/check", body: { checked: true, seen_text: TASK_TEXT }, key: "tick-0928-0001" })],
  ["POST /api/vault-tasks/:task_key/schedule", () => ({ path: "/api/vault-tasks/mt-4q8r2d/schedule", body: { do: "2026-09-30", seen_text: DEFER_TEXT }, key: "defer-0928-0001" })],
  ["POST /api/today/close", () => ({ path: "/api/today/close", body: { day: CLOSE_DAY, line: "Store interface frozen; recorder next." } })],


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
// ---- the event stream: one frame of every catalogue type, from the real triggers -----
//
// A console that has just started listening; a subscriber resuming from an id
// it never issued (so the first frame is `resync`); then one write per type,
// each waited for before the next, so the frames land in one order every
// time. Every write is the row the type's rule reads (docs/ops/client-api.md,
// "Where events come from"): a `runs` row brings its own run.started and
// run.finished with it, which is what a client really hears.
{
  const f = byRoute.get("GET /api/events");
  const feed = startEventFeed({ hub: events, db: pool, connect: () => pool.connect(), log: (l) => failures.push(`GET /api/events: ${l}`) });
  await feed.ready;
  const request = { method: "GET", path: "/api/events", body: null, idempotency_key: null, last_event_id: String(STREAM_FIRST_ID - 100) };
  const abort = new AbortController();
  const res = await fetch(base + request.path, { headers: { authorization: `Bearer ${localOwnerToken}`, "last-event-id": request.last_event_id }, signal: abort.signal });
  const frames = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    let cur = { data: [] };
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line === "") {
            if (cur.data.length > 0) frames.push({ id: cur.id, event: cur.event, data: JSON.parse(cur.data.join("\n")) });
            cur = { data: [], id: cur.id };
          } else if (!line.startsWith(":")) {
            const i = line.indexOf(":");
            const [field, value] = [line.slice(0, i), line.slice(i + 1).replace(/^ /, "")];
            if (field === "id") cur.id = value;
            else if (field === "event") cur.event = value;
            else if (field === "data") cur.data.push(value);
          }
        }
      }
    } catch {
      /* aborted: done */
    }
  })();
  const heard = async (type) => {
    const end = Date.now() + 5000;
    while (!frames.some((x) => x.event === type)) {
      if (Date.now() > end) throw new Error(`GET /api/events: no ${type} within 5 s — heard ${frames.map((x) => x.event).join(", ")}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const finished = (component, kind, meta, ok = true) =>
    pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ($1, $2, $3, now(), now(), $4)`, [component, kind, ok, JSON.stringify(meta)]);
  const streamTurn = "turn-fixture-stream";
  const steps = [
    ["resync", async () => undefined],
    ["turn.progress", async () => (ids.streamRun = Number((await one(`INSERT INTO runs (component, kind, tool, ok, started_at, meta) VALUES ('cursor', 'tool', 'knowledge_search', NULL, now(), jsonb_build_object('turn_id', $1::text)) RETURNING id`, [streamTurn])).id))],
    ["run.finished", () => pool.query(`UPDATE runs SET ok = true, finished_at = now() WHERE id = $1`, [ids.streamRun])],
    ["message.new", () => outboundMessage("The fixture recorder heard this reply as an id.")],
    ["presence.changed", () => pool.query(`UPDATE agents SET display_name = 'Cursor (fixture)' WHERE id = $1`, [ids.agent])],
    ["needs_you.changed", () => proposal("report", { title: "One more thing to read", summary: "a report for the stream" })],
    ["work.changed", async () => (ids.streamWork = Number((await one(`INSERT INTO work (title, project, kind, status, created_by) VALUES ('Watch the stream', $1, 'task', 'open', 'user') RETURNING id`, [P])).id))],
    // both shapes of thread.changed: a task's room, then an artifact's thread
    ["thread.changed", () => pool.query(`INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ('cmt_01FIXTURESTREAMROOM000000', $1, 'A room the stream names by its task.', 'user', 'human')`, [ids.streamWork])],
    ["thread.changed", async () => {
      await pool.query(`INSERT INTO artifact_comments (id, artifact_id, version_id, body, author_principal, author_kind) VALUES ('cmt_01FIXTURESTREAMART0000000', $1, $2, 'A thread the stream names by its artifact.', 'user', 'human')`, [ids.artifact, ids.v2]);
      const end = Date.now() + 5000;
      while (!frames.some((x) => x.event === "thread.changed" && "artifact_id" in x.data)) {
        if (Date.now() > end) throw new Error("GET /api/events: no thread.changed for the artifact within 5 s");
        await new Promise((r) => setTimeout(r, 10));
      }
    }],
    ["capture.new", () => pool.query(`INSERT INTO inbox (source, path, note) VALUES ('http', 'Inbox/fixture-stream.md', 'a capture the stream names by id')`)],
    ["vault.reconciled", () => finished("reconciler", "collector_run", { trigger: "watch", added: 1, changed: 2, renamed: 0, removed: 1 })],
    ["vault.sync", () => finished("reconciler", "vault_sync", { state: "push" })],
    ["routine.status", () => finished("morning-brief", "routine_run", { outcome: "acted", processed: 1 })],
    ["sync.status", () => finished("github-state", "collector_run", { processed: 3 })],
    ["connection.health", () => finished("github", "connection_call", { connection: "github" }, false)],
    ["config.changed", () => finished("reconciler", "config_write", { path: ".metistry/compute.yaml" })],
    ["budget.state", () => finished("assistant", "budget", { scope: "instance", window: "daily" }, false)],
    ["release.available", () => finished("update-check", "routine_run", { outcome: "acted", current: "0.11.0", release_available: "0.12.0" })],
  ];
  try {
    for (const [type, write] of steps) {
      await write();
      await heard(type);
    }
    await new Promise((r) => setTimeout(r, 400)); // anything the last write brings with it
  } catch (e) {
    failures.push(e.message);
  }
  abort.abort();
  await reading;
  await feed.stop();
  events.closeAll();
  if (f && res.status === 200) recorded.set(f.stem, { route: f.route, source: "recorded", ticket: f.ticket, request, status: res.status, stream: frames });
  else failures.push(`GET /api/events: ${res.status}`);
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
