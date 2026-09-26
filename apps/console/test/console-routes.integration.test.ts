// The four route families this PR adds, over real sockets against the
// scratch database: `/api/compute*`, `/api/knowledge/*`, `/api/commands` and
// `GET /api/runs/:id`. Misuse first (invariant 8: misuse tests ship with the
// interface) — no credential, an agent bearer, a capture owner token, a
// malformed body — then the happy paths.
//
// Nothing here can reach the operator's install. `loadTestEnv` scrubs every
// `METISTRY_*` the allowlist does not name (docs/ops/testing.md), the
// instance directory is a `mkdtemp`, and the compute verbs get an explicit
// `env` object of this file's own making plus an injected `fetch`, so the
// only "reconciler" a write can reach is the assertion below it.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { INSTANCE_LAYOUT, instancePath, mintToken } from "@foldedspacelabs/metistry-core";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import { makeServer } from "../src/server.js";
import { loadRules } from "../src/router.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import type { ComputeAdmin } from "../src/compute-routes.js";
import type { KnowledgeSearchResult } from "../src/knowledge-routes.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-routes";

/** A compute.yaml with the two shapes the report has to render: a keyed off-machine provider and a keyless local one. Comments included, because the write path must preserve them. */
const COMPUTE_YAML = `# hand-written, and it must survive every edit
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }   # a NAME, never a value
    zdr: true
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
assignments:
  default: { model: lmstudio/gemma, effort: medium }
`;

describe.skipIf(!hasDb)("the console's compute, knowledge, commands and run-detail routes", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  let ownerToken: string;
  let agentToken: string;
  let instanceDir: string;
  let bridgeCalls: Array<{ url: string; body: Record<string, unknown>; auth: string | undefined }>;
  let turnRunId: number;
  const localOwnerToken = mintToken();
  const agentId = `itest-routes-${mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`;
  // Unique per run, not a fixed literal: the scratch database is shared with
  // every other suite, `runs` is not scoped by component in the join under
  // test, and `packages/mcp-brain`'s own suite writes a tool row carrying a
  // hand-picked `turn_id` of its own. A collision there made this test count
  // somebody else's tool call — which is the very thing the join exists to
  // prevent, so the fixture must not rely on a name nobody else guessed.
  const turnId = `itest-routes-turn-${mintToken(8)}`;
  // Same reason, for `knowledge_files`: the index is keyed by path and shared
  // with every other suite, so this one's fixtures live under a name nobody
  // else can have guessed and are counted by that name alone.
  const pageTag = `KpRoutes${mintToken(6).replaceAll(/[^A-Za-z0-9]/g, "")}`;

  /** Search results the fake bridge hands back — one hit inside the vault, three the route must never pass on. */
  const BRIDGE_HITS: KnowledgeSearchResult = {
    q: "sleep",
    mode: "keyword",
    hits: [
      { path: "Areas/Health/sleep.md", title: "Sleep", description: "the taper", snippet: "…slept badly…", score: 0.9, source: "keyword" },
      { path: ".metistry/state/.env", title: ".env", description: null, snippet: "METISTRY_DB_PASSWORD=…", score: 0.8, source: "keyword" },
      { path: "Artifacts/report.pdf", title: "report", description: null, snippet: "…", score: 0.7, source: "keyword" },
      { path: "CLAUDE.md", title: "CLAUDE", description: null, snippet: "…", score: 0.6, source: "keyword" },
    ],
    degraded: "no embeddings stored for model nomic-embed-text — served keyword",
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [MARK]);

    instanceDir = await mkdtemp(join(tmpdir(), "metistry-routes-"));
    await mkdir(join(instanceDir, ".metistry"), { recursive: true });
    await writeFile(instancePath(instanceDir, "compute"), COMPUTE_YAML);

    bridgeCalls = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      bridgeCalls.push({
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      if (url.endsWith("/vault/write")) return new Response(JSON.stringify({ path: INSTANCE_LAYOUT.compute, sha256: "x".repeat(64), bytes: 1, created: false }), { status: 200 });
      if (url.includes("/models")) return new Response(JSON.stringify({ data: [{ id: "gemma" }, { id: "qwen" }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // The compute verbs' whole environment: the bridge, its token, and
    // nothing else. `platform: "linux"` is deliberate — it is CI's, and it
    // keeps the Keychain (`security`) out of the test entirely, so
    // `secret_present` is reported honestly as false.
    const computeAdmin: ComputeAdmin = {
      instanceDir,
      seedDir: fileURLToPath(new URL("../../../seed", import.meta.url)),
      env: { METISTRY_RECONCILER_URL: "http://127.0.0.1:7811", METISTRY_BRIDGE_TOKEN_RECONCILER: "bridge-token" },
      platform: "linux",
      uid: 501,
      fetchFn,
    };

    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));

    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: join(tmpdir(), `metistry-routes-inbox-${Date.now()}`),
      policy,
      secureCookies: false,
      rules: loadRules(await readFile(new URL("../../../seed/rules.yaml", import.meta.url), "utf8")),
      localOwner: { token: localOwnerToken, trusted: [] },
      computeAdmin,
      searchKnowledge: async (q, mode, limit) => ({ ...BRIDGE_HITS, q, mode: mode ?? "keyword", hits: BRIDGE_HITS.hits.slice(0, limit) }),
      // A minimal VaultClient: only `read` is exercised here, and it answers
      // for one page. Every other path is "not there", which is what the
      // route must be indistinguishable from when it refuses one.
      vault: {
        read: async (path: string) =>
          path === "Areas/Health/sleep.md"
            ? { path, content: Buffer.from("# Sleep\n\nthe taper\n", "utf8"), sha256: "a".repeat(64), bytes: 20 }
            : path === "Areas/Health/boom.md"
              ? (() => {
                  throw new VaultError("not_available", "the reconciler did not answer");
                })()
              : null,
        write: async () => {
          throw new Error("the knowledge read path must never write");
        },
        delete: async () => {},
        list: async () => [],
        log: async () => [],
        diff: async () => ({ diff: "", from: "", to: "" }),
        flush: async () => ({}),
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pkId = `routes-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "routes-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest routes agent" })).token;

    // A shadowed turn with two tool calls behind it, for the drill-down —
    // plus a third call carrying a DIFFERENT turn_id, which is the one the
    // join has to leave out.
    const turn = await pool.query(
      `INSERT INTO runs (component, kind, tool, provider, model, tokens_in, tokens_out, cost_usd, ok, meta, shadow_provider, shadow_model, shadow_agreement, shadow_cost_usd, shadow_transcript)
       VALUES ($1, 'turn', NULL, 'openrouter', 'anthropic/claude-haiku-4', 900, 120, 0.004200, true,
               jsonb_build_object('turn_id', $2::text, 'tier', 'default'),
               'lmstudio', 'gemma', 0.812, 0.000000, '{"agreement":{"tool_sequence":true,"answer_similarity":0.77},"shadow":{}}')
       RETURNING id`,
      [MARK, turnId],
    );
    turnRunId = Number(turn.rows[0].id);
    await pool.query(
      `INSERT INTO runs (component, kind, tool, ok, duration_ms, meta) VALUES
         ($1, 'tool', 'knowledge_search', true,  12, jsonb_build_object('turn_id', $2::text)),
         ($1, 'tool', 'tasks_update',     false, 30, jsonb_build_object('turn_id', $2::text)),
         ($1, 'tool', 'knowledge_read',   true,   9, jsonb_build_object('turn_id', $2::text || '-other'))`,
      [MARK, turnId],
    );

    // The page list's fixtures, in the reconciler's index. The last two are
    // rows the walk would never write — `isVaultPath` excludes them — and are
    // here precisely because the ROUTE, not the query, is what must refuse
    // them: a row predating a narrowing, or an overlay query with a looser
    // WHERE, is exactly this shape.
    await pool.query(
      `INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES
         ($1 || '/sleep.md',        'Sleep',  'the taper', false, 'clean',    now(), now()),
         ($1 || '/2026/taper.md',   NULL,     NULL,        false, 'dirty',    now(), now()),
         ($1 || 'care/billing.md',  'Billing', NULL,       false, 'clean',    now(), now()),
         ($1 || '/secret.md',       'Secret',  NULL,       true,  'clean',    now(), now()),
         ($1 || '/torn.md',         'Torn',    NULL,       false, 'conflict', now(), now()),
         ('.metistry/' || $2 || '.yaml', 'machinery', NULL, false, 'clean',   now(), now()),
         ('Artifacts/' || $2 || '.pdf',  'artifact',  NULL, false, 'clean',   now(), now())`,
      [`Areas/${pageTag}`, pageTag],
    );

    // The link graph over those same fixtures. Three of these five edges must
    // not come back, and each is refused by a different part of the stack:
    // the draft by the query, the `.metistry/` backlink by the route's scope
    // filter, and the sibling area by a narrowed scope in the unit tests.
    await pool.query(
      `INSERT INTO knowledge_links (from_path, to_path, kind) VALUES
         ($1 || '/sleep.md',       $1 || '/2026/taper.md', 'wikilink'),
         ($1 || '/sleep.md',       $1 || '/2026/taper.md', 'embed'),
         ($1 || '/sleep.md',       $1 || '/nowhere.md',    'wikilink'),
         ($1 || '/sleep.md',       $1 || '/secret.md',     'wikilink'),
         ($1 || 'care/billing.md', $1 || '/sleep.md',      'wikilink'),
         ('.metistry/' || $2 || '.yaml', $1 || '/sleep.md', 'frontmatter')`,
      [`Areas/${pageTag}`, pageTag],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE component = $1`, [MARK]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE $1 OR to_path LIKE $1`, [`%${pageTag}%`]);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`%${pageTag}%`]);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  const owner = () => ({ cookie });
  const get = (path: string, headers: Record<string, string> = owner()) => fetch(base + path, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = owner()) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  // ---------------------------------------------------------------- the door

  const EVERY_ROUTE = [
    "GET /api/compute",
    "GET /api/compute/models",
    "POST /api/compute/assign",
    "POST /api/compute/budget",
    "POST /api/compute/providers/test",
    "GET /api/knowledge/search?q=x",
    "GET /api/knowledge/page?path=Areas/Health/sleep.md",
    "GET /api/knowledge/pages",
    "GET /api/knowledge/links?path=Areas/Health/sleep.md",
    "GET /api/commands",
  ];

  it("401, with no detail, on every new route without a credential", async () => {
    for (const route of [...EVERY_ROUTE, "GET /api/runs/1"]) {
      const [method, path] = route.split(" ") as [string, string];
      const r = await fetch(base + path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
      expect(r.status, route).toBe(401);
      expect(await r.json(), route).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
  });

  // CRIT-7: an agent bearer works on `/capture` and the `/mcp` mount and is a
  // uniform 403 everywhere else. Knowledge under grants is `knowledge_search`
  // / `knowledge_read` on that mount — never these routes, so the canonical
  // "not granted" is the whole answer and nothing distinguishes a route that
  // exists from one that does not.
  it("403 `not granted` for an agent bearer on every one of them, and the message is uniform", async () => {
    for (const route of [...EVERY_ROUTE, `GET /api/runs/${turnRunId}`]) {
      const [method, path] = route.split(" ") as [string, string];
      const r = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(r.status, route).toBe(403);
      expect((await r.json()).error, route).toEqual({ code: "forbidden", message: "not granted" });
    }
  });

  it("403 for a capture owner token too — these are the `user` principal's, not any owner credential's", async () => {
    for (const route of [...EVERY_ROUTE, `GET /api/runs/${turnRunId}`]) {
      const [method, path] = route.split(" ") as [string, string];
      const r = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(r.status, route).toBe(403);
    }
  });

  it("the LOCAL owner token reaches all of them — the Mac app and the CLI are the same principal", async () => {
    const auth = { authorization: `Bearer ${localOwnerToken}` };
    expect((await get("/api/compute", auth)).status).toBe(200);
    expect((await get("/api/commands", auth)).status).toBe(200);
    expect((await get("/api/knowledge/search?q=sleep", auth)).status).toBe(200);
    expect((await get("/api/knowledge/pages", auth)).status).toBe(200);
    expect((await get(`/api/runs/${turnRunId}`, auth)).status).toBe(200);
  });

  // ------------------------------------------------------------- GET /api/compute

  it("reports providers, assignments and budgets with secrets reduced to PRESENCE", async () => {
    const r = await get("/api/compute");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.file).toBe(instancePath(instanceDir, "compute"));
    expect(body.instance_file).toBe(instancePath(instanceDir, "compute"));
    expect(body.writable).toBe(true);
    const or = body.providers.find((p: any) => p.name === "openrouter");
    expect(or).toMatchObject({ kind: "openai-compatible", locality: "off_machine", zdr: true, secret: "METISTRY_OPENROUTER_API_KEY", secret_present: false });
    expect(body.providers.find((p: any) => p.name === "lmstudio")).not.toHaveProperty("secret");
    expect(body.assignments).toEqual([{ target: "default", provider: "lmstudio", model: "gemma", effort: "medium", warn_non_zdr: false }]);
    expect(body.spend).toMatchObject({ instance: { daily: expect.any(Number), monthly: expect.any(Number) }, providers: { openrouter: expect.anything(), lmstudio: expect.anything() } });
    // The whole response, serialised, contains no secret VALUE-shaped field.
    expect(JSON.stringify(body)).not.toContain("sk-");
    expect(Object.keys(or)).not.toContain("secret_value");
  });

  it("lists a provider's live models through its own credential", async () => {
    const r = await get("/api/compute/models?provider=lmstudio");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.providers).toEqual([{ name: "lmstudio", ok: true, detail: expect.stringContaining("2 model(s)"), models: ["gemma", "qwen"] }]);
  });

  // ------------------------------------------------------- the two writes

  it("assign edits the YAML DOCUMENT and delivers it through the reconciler as `user`", async () => {
    bridgeCalls.length = 0;
    const r = await post("/api/compute/assign", { tier: "deep", model: "openrouter/anthropic/claude-opus-4", effort: "high" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, target: "assignments.tiers.deep", provider: "openrouter", model: "anthropic/claude-opus-4", effort: "high", warn_non_zdr: false });
    expect(body.delivery.how).toBe("bridge");

    const write = bridgeCalls.find((c) => c.url.endsWith("/vault/write"));
    expect(write).toBeDefined();
    expect(write!.auth).toBe("Bearer bridge-token");
    expect(write!.body.path).toBe(INSTANCE_LAYOUT.compute);
    expect(write!.body.intent).toMatchObject({ principal: "user" }); // invariant 2: a human change, in the user's name
    const written = String(write!.body.content);
    expect(written).toContain("# hand-written, and it must survive every edit"); // comments survive
    expect(written).toContain("model: openrouter/anthropic/claude-opus-4");
    expect(written).toContain("openrouter:"); // and so does everything the edit did not touch
    expect(written).toContain("lmstudio:");
  });

  it("budget records both windows and the action, through the same door", async () => {
    bridgeCalls.length = 0;
    const r = await post("/api/compute/budget", { scope: "provider:openrouter", daily: 5, monthly: 60, action: "stop" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, target: "budgets.providers.openrouter", daily_usd: 5, monthly_usd: 60, action: "stop" });
    const written = String(bridgeCalls.find((c) => c.url.endsWith("/vault/write"))!.body.content);
    expect(written).toContain("daily_usd: 5");
    expect(written).toContain("action: stop");
  });

  it("refuses the body a client could get wrong, naming the field — and writes nothing", async () => {
    bridgeCalls.length = 0;
    const cases: Array<[string, unknown, string]> = [
      ["/api/compute/assign", { model: "lmstudio/gemma" }, "neither"],
      ["/api/compute/assign", { tier: "deep", crew: "writer", model: "lmstudio/gemma" }, "tier and crew"],
      ["/api/compute/assign", { tier: "deep" }, "<provider>/<model>"],
      ["/api/compute/assign", { tier: "deep", model: "gemma" }, "provider"],
      ["/api/compute/assign", { tier: "deep", model: "lmstudio/gemma", effort: "extreme" }, "low | medium | high"],
      ["/api/compute/budget", { daily: 5, action: "stop" }, '"instance"'],
      ["/api/compute/budget", { scope: "instance", action: "stop" }, "--daily"],
      ["/api/compute/budget", { scope: "instance", daily: 5, action: "shrug" }, "allow | stop | critical_only"],
      ["/api/compute/budget", { scope: "instance", daily: "5", action: "stop" }, "non-negative number"],
      ["/api/compute/providers/test", {}, "declared in compute.yaml"],
      ["/api/compute/providers/test", { name: "nope" }, "providers.nope is not declared"],
    ];
    for (const [path, body, needle] of cases) {
      const r = await post(path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      const envelope = await r.json();
      expect(Object.keys(envelope)).toEqual(["error"]);
      expect(envelope.error.code).toBe("invalid_request");
      expect(envelope.error.message, `${path} ${JSON.stringify(body)}`).toContain(needle);
    }
    expect(bridgeCalls.filter((c) => c.url.endsWith("/vault/write"))).toEqual([]);
  });

  it("a body that is not JSON is a 400, not a 500", async () => {
    const r = await fetch(`${base}/api/compute/assign`, { method: "POST", headers: { ...owner(), "content-type": "application/json" }, body: "{oops" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe("request body is not JSON");
  });

  it("404 on an unknown verb under the prefix, never a 405 or a silent 200", async () => {
    expect((await post("/api/compute/nuke", {})).status).toBe(404);
    expect((await get("/api/compute/assign")).status).toBe(404);
  });

  // ------------------------------------------------------ GET /api/knowledge/*

  it("search proxies the bridge, keeps `degraded`, and drops every hit that is not knowledge", async () => {
    const r = await get("/api/knowledge/search?q=sleep&mode=hybrid&limit=10");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.hits.map((h: any) => h.path)).toEqual(["Areas/Health/sleep.md"]);
    expect(body.hits[0]).toMatchObject({ title: "Sleep", snippet: "…slept badly…", score: 0.9, source: "keyword" });
    expect(body.mode).toBe("hybrid");
    expect(body.degraded).toContain("served keyword"); // P5: a fact, not an error
    // Nothing about the three filtered paths reaches the client — not the
    // path, not the snippet, not a count.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(".metistry");
    expect(raw).not.toContain("METISTRY_DB_PASSWORD");
    expect(raw).not.toContain("Artifacts/");
    expect(raw).not.toContain("CLAUDE.md");
  });

  it("search refuses a missing q, an over-long q, an unknown mode and an out-of-range limit — each by name", async () => {
    for (const [qs, needle] of [
      ["", "q is required"],
      ["?q=%20%20", "q is required"],
      [`?q=${"x".repeat(201)}`, "200 characters or fewer"],
      ["?q=x&mode=vibes", "keyword | semantic | hybrid"],
      ["?q=x&limit=0", "between 1 and 100"],
      ["?q=x&limit=101", "between 1 and 100"],
      ["?q=x&limit=abc", "between 1 and 100"],
    ] as const) {
      const r = await get(`/api/knowledge/search${qs}`);
      expect(r.status, qs).toBe(400);
      expect((await r.json()).error.message, qs).toContain(needle);
    }
  });

  it("page returns one note's bytes and its hash", async () => {
    const r = await get("/api/knowledge/page?path=Areas/Health/sleep.md");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ path: "Areas/Health/sleep.md", content: "# Sleep\n\nthe taper\n", sha256: "a".repeat(64), bytes: 20 });
  });

  // The reconciler's /vault/read serves these happily with the console's own
  // bearer. This route is the reason the app cannot ask it to.
  it("page classifies .metistry/, Artifacts/, the root CLAUDE.md and traversal for the owner — the door that has it, never a refusal", async () => {
    // These are all the OWNER's own paths (the session cookie above), and
    // since P4 none of them is a permission refusal: the door classifies
    // what it was handed and names the door that has it. Not one byte of
    // any of them crosses — `.metistry/state/.env` least of all.
    for (const [path, cls, door] of [
      [".metistry/compute.yaml", "machinery", "the file itself"],
      [".metistry/state/.env", "machinery", "the file itself"],
      ["Artifacts/report.pdf", "an artifact", "GET /api/artifacts"],
      ["CLAUDE.md", "machinery", "the file itself"],
      ["../../../etc/passwd", "outside the vault", null],
      ["Areas/../../etc/passwd", "outside the vault", null],
      ["/etc/passwd", "outside the vault", null],
      [".obsidian/workspace.json", "machinery", "the file itself"],
    ] as const) {
      const r = await get(`/api/knowledge/page?path=${encodeURIComponent(path)}`);
      expect(r.status, path).toBe(400);
      const body = await r.json();
      expect(body.error.code, path).toBe("invalid_request");
      expect(body.error.message, path).toContain(`is ${cls}, not knowledge`);
      expect(body.reason, path).toBe("not_knowledge");
      expect(body.needs?.door ?? null, path).toBe(door);
      expect(JSON.stringify(body), path).not.toContain("content");
    }
    // …and a page that genuinely is not there is still a 404: the
    // classification answer is about a path this door does not SERVE, never
    // about one it simply has not got.
    expect((await get("/api/knowledge/page?path=Areas/Health/nope.md")).status).toBe(404);
    expect((await get("/api/knowledge/page")).status).toBe(400); // a MISSING param is the caller's mistake, and says so
  });

  it("a bridge that cannot answer comes back as its own envelope code, not a 500", async () => {
    const r = await get("/api/knowledge/page?path=Areas/Health/boom.md");
    expect(r.status).toBe(503);
    expect((await r.json()).error).toEqual({ code: "not_available", message: "the reconciler did not answer" });
  });

  // The third door, and the one that is NOT a proxy: a page list is derived
  // state, so invariant 3 sends it through `seed/queries/knowledge_pages.yaml`
  // and the route holds no SQL. The bridge is not consulted at all, which the
  // untouched `bridgeCalls` below says out loud.
  it("pages lists the index through the named query, with the area derived and both timestamps", async () => {
    const before = bridgeCalls.length;
    const r = await get(`/api/knowledge/pages?prefix=Areas/${pageTag}&limit=10`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.pages.map((p: any) => p.path)).toEqual([`Areas/${pageTag}/2026/taper.md`, `Areas/${pageTag}/sleep.md`]);
    expect(body.pages[1]).toMatchObject({ area: `Areas/${pageTag}`, title: "Sleep", description: "the taper", status: "clean" });
    expect(body.pages[0]).toMatchObject({ title: "taper", status: "dirty" }); // no frontmatter title → the basename; `dirty` = edited since the last walk
    expect(body.pages[1].modified).toEqual(expect.any(String));
    expect(body.pages[1].indexed_at).toEqual(expect.any(String));
    // the filters are echoed, and there is deliberately no `total`
    expect(body).toMatchObject({ prefix: `Areas/${pageTag}`, area: null, limit: 10, offset: 0, as_of: expect.any(String) });
    expect(body).not.toHaveProperty("total");
    expect(bridgeCalls.length).toBe(before); // a list never touches the vault bridge
  });

  it("pages filters by the derived area, pages with limit/offset, and never leaks a neighbouring area", async () => {
    const byArea = await (await get(`/api/knowledge/pages?area=Areas/${pageTag}`)).json();
    expect(byArea.pages.map((p: any) => p.path)).toEqual([`Areas/${pageTag}/2026/taper.md`, `Areas/${pageTag}/sleep.md`]);
    // `Areas/<tag>care` is the `Health`/`Healthcare` pair: a substring filter
    // would hand it over on both of the calls above.
    expect(JSON.stringify(byArea)).not.toContain("billing.md");
    expect(JSON.stringify(await (await get(`/api/knowledge/pages?prefix=Areas/${pageTag}`)).json())).not.toContain("billing.md");
    const care = await (await get(`/api/knowledge/pages?area=Areas/${pageTag}care`)).json();
    expect(care.pages.map((p: any) => p.path)).toEqual([`Areas/${pageTag}care/billing.md`]);

    const first = await (await get(`/api/knowledge/pages?prefix=Areas/${pageTag}&limit=1`)).json();
    const second = await (await get(`/api/knowledge/pages?prefix=Areas/${pageTag}&limit=1&offset=1`)).json();
    expect(first.pages.map((p: any) => p.path)).toEqual([`Areas/${pageTag}/2026/taper.md`]);
    expect(second.pages.map((p: any) => p.path)).toEqual([`Areas/${pageTag}/sleep.md`]);
    expect((await (await get(`/api/knowledge/pages?prefix=Areas/${pageTag}&limit=1&offset=99`)).json()).pages).toEqual([]);
  });

  // The query hides them, and so does the route's own scope filter. Both,
  // deliberately: the query is overlayable per instance (D4) and the route's
  // filter is not.
  it("pages never carries a draft, an unsettled conflict, or a row that is not vault CONTENT", async () => {
    const all = JSON.stringify(await (await get(`/api/knowledge/pages?limit=500`)).json());
    expect(all).not.toContain("secret.md"); // draft
    expect(all).not.toContain("torn.md"); // status conflict
    expect(all).not.toContain(".metistry/"); // indexed, and still not knowledge — `canSee`, for the owner too
    expect(all).not.toContain("Artifacts/");
    // …and asking for them by name is an empty list, not a refusal: a 400 on
    // the filter would say which prefixes exist.
    for (const qs of [`?prefix=.metistry`, `?prefix=Artifacts`, `?area=.metistry`]) {
      const r = await get(`/api/knowledge/pages${qs}`);
      expect(r.status, qs).toBe(200);
      expect((await r.json()).pages, qs).toEqual([]);
    }
  });

  // The other half of "the page list is scoped": there is no second way to
  // the same rows. `knowledge_pages.yaml` declares `expose: route`, so the
  // generic door answers it with the refusal it gives a name it has never
  // heard of — over a real socket, with the seed manifests actually loaded,
  // which is the combination a unit test cannot pin.
  it("serves the page list to the OWNER at the generic door, and still hides it from everyone else", async () => {
    // P4. The rule `expose: route` protects is a filter on what an AGENT
    // may see of the vault; the owner's scope IS the whole vault, so the two
    // doors return the same rows to them and the refusal was only ever a
    // second door to remember (§2.6). `get` carries the session cookie.
    const served = await get("/api/q/knowledge_pages");
    expect(served.status).toBe(200);
    expect(Array.isArray((await served.json()).rows)).toBe(true);
    expect((await get(`/api/q/knowledge_pages?prefix=Areas/${pageTag}&limit=10`)).status).toBe(200);
    // …and an unknown name is still a 404 for the owner too: being served
    // every query this door has is not being served one it has not.
    const unknown = await get("/api/q/no_such_query_at_all");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "not_found", message: "not found" } });

    // **The capture owner token is NOT the owner** — the plan's tier 0, the
    // credential the management gate keeps off `/api/knowledge/*` — and for
    // it the door is unchanged, byte for byte: the unknown-query refusal, so
    // it is not an oracle for which route-only queries this build has.
    const closed = await get("/api/q/knowledge_pages", { authorization: `Bearer ${ownerToken}` });
    expect(closed.status).toBe(404);
    const a = await closed.json();
    expect(a).toEqual(await (await get("/api/q/no_such_query_at_all", { authorization: `Bearer ${ownerToken}` })).json());
    expect(a).toEqual({ error: { code: "not_found", message: "not found" } });
    expect(JSON.stringify(a)).not.toContain(pageTag);
    expect((await get("/api/q/open_work?limit=1", { authorization: `Bearer ${ownerToken}` })).status).toBe(200); // that credential's reach here is unchanged, and stated in docs/ops/console-api.md
    // …while the generic door is untouched for every query that has no route
    // of its own — closing one door is not closing the corridor.
    const open = await get("/api/q/open_work?limit=3");
    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({ rows: expect.any(Array), as_of: expect.any(String) });
    // and the scoped route still answers, from that same closed query
    expect((await (await get(`/api/knowledge/pages?prefix=Areas/${pageTag}&limit=10`)).json()).pages).toHaveLength(2);
  });

  it("pages refuses an out-of-range limit, a negative offset and an unusable filter — each by name", async () => {
    for (const [qs, needle] of [
      ["?limit=0", "between 1 and 500"],
      ["?limit=501", "between 1 and 500"],
      ["?limit=abc", "between 1 and 500"],
      ["?limit=1.5", "between 1 and 500"],
      ["?offset=-1", "non-negative integer"],
      ["?offset=abc", "non-negative integer"],
      [`?prefix=${"x".repeat(501)}`, "500 characters or fewer"],
      [`?area=${"x".repeat(501)}`, "500 characters or fewer"],
      ["?prefix=Areas%5Cx", "no backslashes"],
      ["?area=Areas%00x", "no backslashes"],
    ] as const) {
      const r = await get(`/api/knowledge/pages${qs}`);
      expect(r.status, qs).toBe(400);
      expect((await r.json()).error.message, qs).toContain(needle);
    }
  });

  // The fourth door: the link graph, the other half of what §6.1 sized and
  // the last piece #206 left open. Derived state, so it is a named query and
  // the route holds no SQL — and the bridge is not consulted, which the
  // untouched `bridgeCalls` says out loud.
  it("links lists both directions at a page, with the draft edge gone and the machinery backlink filtered", async () => {
    const before = bridgeCalls.length;
    const r = await get(`/api/knowledge/links?path=Areas/${pageTag}/sleep.md`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.links.map((l: any) => [l.direction, l.path, l.kind])).toEqual([
      ["outgoing", `Areas/${pageTag}/2026/taper.md`, "embed"],
      ["outgoing", `Areas/${pageTag}/2026/taper.md`, "wikilink"],
      ["outgoing", `Areas/${pageTag}/nowhere.md`, "wikilink"],
      ["incoming", `Areas/${pageTag}care/billing.md`, "wikilink"],
    ]);
    expect(body.links[0]).toMatchObject({ title: "taper", status: "dirty", resolved: true });
    expect(body.links[2]).toMatchObject({ title: "nowhere", resolved: false, description: null }); // nothing lives there yet, and the row says so
    expect(body).toMatchObject({ path: `Areas/${pageTag}/sleep.md`, limit: 100, offset: 0, as_of: expect.any(String) });
    expect(body).not.toHaveProperty("total");
    const text = JSON.stringify(body);
    expect(text).not.toContain("secret.md"); // a draft, dropped by the query at either end
    expect(text).not.toContain(".metistry/"); // an indexed backlink that is not knowledge, dropped by the route
    expect(bridgeCalls.length).toBe(before);

    // paged against the same total order, and the generic door does not
    // serve this query either
    const first = await (await get(`/api/knowledge/links?path=Areas/${pageTag}/sleep.md&limit=1`)).json();
    const second = await (await get(`/api/knowledge/links?path=Areas/${pageTag}/sleep.md&limit=1&offset=1`)).json();
    expect(first.links.map((l: any) => l.path)).toEqual([`Areas/${pageTag}/2026/taper.md`]);
    expect(second.links.map((l: any) => [l.path, l.kind])).toEqual([[`Areas/${pageTag}/2026/taper.md`, "wikilink"]]);
    // …served to the owner at the generic door since P4, and to nobody else.
    expect((await get("/api/q/knowledge_page_links")).status).toBe(200);
  });

  it("links classifies a path that is not knowledge, and treats a missing path as having no links", async () => {
    // The owner may open `.metistry/compute.yaml` in a text editor, and the
    // honest answer on the KNOWLEDGE route is that it is machinery — this
    // door has no page for it — rather than a 404 implying it is not there.
    const machinery = await get(`/api/knowledge/links?path=.metistry/${pageTag}.yaml`);
    const absent = await get(`/api/knowledge/links?path=Areas/${pageTag}/no-such-note.md`);
    expect(machinery.status).toBe(400);
    expect((await machinery.json()).error.message).toContain("is machinery, not knowledge");
    // An absent page is not an error at all — it simply has no links, which
    // is what "refused and absent are indistinguishable" costs and is worth.
    expect(absent.status).toBe(200);
    expect((await absent.json()).links).toEqual([]);
    for (const [qs, needle] of [
      ["", "path is required"],
      [`?path=Areas/${pageTag}/sleep.md&limit=501`, "between 1 and 500"],
      [`?path=Areas/${pageTag}/sleep.md&offset=-1`, "non-negative integer"],
    ] as const) {
      const r = await get(`/api/knowledge/links${qs}`);
      expect(r.status, qs).toBe(400);
      expect((await r.json()).error.message, qs).toContain(needle);
    }
  });

  it("an unknown verb under the prefix is a 404 naming every door there is", async () => {
    const r = await get("/api/knowledge/backlinks");
    expect(r.status).toBe(404);
    const message = (await r.json()).error.message;
    for (const door of ["/api/knowledge/search", "/api/knowledge/page", "/api/knowledge/pages", "/api/knowledge/links"]) {
      expect(message, door).toContain(door);
    }
  });

  // ------------------------------------------------------------ GET /api/commands

  it("derives the command list from the seeded rules.yaml, with the agent registry beside it", async () => {
    const r = await get("/api/commands");
    expect(r.status).toBe(200);
    const body = await r.json();
    const ids = body.commands.map((c: any) => c.id);
    // seed/rules.yaml: `^/(status|open)\b` → /open + /status; plus the
    // router's own three. `^what('| i)?s …` yields nothing, on purpose.
    expect(ids).toEqual(["/deep", "/model", "/note", "/open", "/status"]);
    expect(ids.some((i: string) => i.startsWith("/what"))).toBe(false);
    expect(body.commands.find((c: any) => c.id === "/status")).toMatchObject({
      routes_to: "fast_path",
      query: "open_work",
      description: "Work items not yet closed, newest first", // the query's own line
      tier: null,
    });
    expect(body.commands.find((c: any) => c.id === "/deep")).toMatchObject({ routes_to: "model_override", tier: "deep", model: "opus", effort: "high" });
    expect(body.agents.map((a: any) => a.id)).toContain(`@${agentId}`);
    expect(JSON.stringify(body)).not.toContain("token");
  });

  // What the PWA and the Mac app insert must be what the router accepts.
  // Nothing else in this repo holds the two together.
  it("every command it offers is one the router actually routes", async () => {
    const { commands } = await (await get("/api/commands")).json();
    const rules = loadRules(await readFile(new URL("../../../seed/rules.yaml", import.meta.url), "utf8"));
    const { route } = await import("../src/router.js");
    for (const c of commands) {
      if (c.id === "/model") continue; // `/model <tier> <text>` — its argument IS a tier, exercised in router.test.ts
      const decision = route(rules, c.takes_argument ? `${c.id} something` : c.id);
      expect(decision.kind, c.id).toBe(c.routes_to === "model_override" ? "model" : c.routes_to);
      if (c.routes_to === "fast_path") expect((decision as { query: string }).query, c.id).toBe(c.query);
      if (c.routes_to === "model_override") expect((decision as { tier: string }).tier, c.id).toBe(c.tier);
    }
  });

  // ------------------------------------------------------------- GET /api/runs/:id

  it("returns one run in full, with the tool calls that reply made and the shadow measure", async () => {
    const r = await get(`/api/runs/${turnRunId}`);
    expect(r.status).toBe(200);
    const { run } = await r.json();
    expect(run).toMatchObject({
      id: String(turnRunId),
      component: MARK,
      kind: "turn",
      provider: "openrouter",
      model: "anthropic/claude-haiku-4",
      tokens_in: 900,
      tokens_out: 120,
      cost_usd: "0.004200",
      ok: true,
      shadow_provider: "lmstudio",
      shadow_model: "gemma",
      shadow_same_tool_sequence: true,
      tool_calls_total: "2",
      tool_calls_failed: "1",
    });
    // Grouped by the turn's own `turn_id`, so another reply's call is not
    // attributed to this one.
    expect(run.tool_calls.map((c: any) => c.tool)).toEqual(["knowledge_search", "tasks_update"]);
    expect(run.tool_calls.map((c: any) => c.tool)).not.toContain("knowledge_read");
    // The transcripts themselves are two full replies; the drill-down wants
    // the measure, not the text.
    expect(run).not.toHaveProperty("shadow_transcript");
  });

  it("404 for an id that is not in the ledger, 404 for one that is not an id at all", async () => {
    expect((await get("/api/runs/999999999")).status).toBe(404);
    expect((await get("/api/runs/abc")).status).toBe(404);
    expect((await get("/api/runs/-1")).status).toBe(404);
  });

  // ------------------------------------------------------------------- audit

  it("writes one `runs` row per door, so the console's own hand is in the ledger", async () => {
    const { rows } = await pool.query(
      `SELECT kind, tool, ok FROM runs WHERE component = 'console' AND kind IN ('compute_admin','knowledge') AND ts > now() - interval '5 minutes' ORDER BY id`,
    );
    const tools = rows.map((r) => `${r.kind}:${r.tool}`);
    expect(tools).toContain("compute_admin:assign");
    expect(tools).toContain("compute_admin:budget");
    expect(tools).toContain("knowledge:search");
    expect(tools).toContain("knowledge:page");
    expect(tools).toContain("knowledge:pages");
    expect(rows.some((r) => r.kind === "knowledge" && r.tool === "page" && r.ok === false)).toBe(true); // the refusals are recorded too
  });
});

// ------------------------------------------------ the shapes that degrade absent

describe.skipIf(!hasDb)("degrades absent: nothing configured, and every route says which variable", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    // No computeAdmin, no searchKnowledge, no vault, no rules, and a
    // QueryStore with nothing loaded.
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: join(tmpdir(), `metistry-routes-bare-${Date.now()}`),
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `bare-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "bare" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("503 naming what is missing, on each one", async () => {
    const cases: Array<[string, string]> = [
      ["/api/compute", "METISTRY_INSTANCE_DIR"],
      ["/api/compute/models", "METISTRY_INSTANCE_DIR"],
      ["/api/knowledge/search?q=x", "METISTRY_RECONCILER_URL"],
      ["/api/knowledge/page?path=Areas/x.md", "METISTRY_RECONCILER_URL"],
      ["/api/knowledge/pages", "knowledge_pages"], // no bridge to name: the list's dependency is the named query, and it says so
      ["/api/commands", "METISTRY_RULES_FILES"],
      ["/api/runs/1", "run_detail"],
    ];
    for (const [path, needle] of cases) {
      const r = await fetch(base + path, { headers: { cookie } });
      expect(r.status, path).toBe(503);
      expect((await r.json()).error.message, path).toContain(needle);
    }
  });

  // The classification is decided before the bridge is consulted, so a
  // deployment with no vault still answers `.metistry/` with "that is
  // machinery" rather than a 503 admitting it might have served it.
  it("still classifies a non-knowledge path rather than 503ing — the answer is not a function of the wiring", async () => {
    const r = await fetch(`${base}/api/knowledge/page?path=.metistry/compute.yaml`, { headers: { cookie } });
    expect(r.status).toBe(400);
    expect((await r.json()).reason).toBe("not_knowledge");
  });
});
