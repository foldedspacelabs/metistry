// The owner's three knowledge reads (design-build-plan §2.10, T1-6) —
// `GET /api/knowledge/{fold,drafts,areas}` — over real sockets against the
// scratch database, and the property the ticket names in bold: **drafts are
// never reachable at the generic door or through `/mcp`.**
//
// Misuse first (invariant 8). The four U2 answers live beside every other
// knowledge route in `console-routes.integration.test.ts`; what is here is
// the rest of the ways a draft could leave the building: the generic
// `/api/q/<name>` door by name, and each `/mcp` tool an agent granted the
// very folder the draft sits in — with `queries: true` — could reach for.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const OWNER_READS = ["knowledge_drafts", "knowledge_fold_latest", "knowledge_areas"] as const;

describe.skipIf(!hasDb)("the owner's knowledge reads, and the doors a draft never leaves by", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  let ownerToken: string;
  let agentToken: string;
  let nextId = 1;
  const localOwnerToken = mintToken();
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-kor-${suffix}`;
  // The index is shared with every other suite, so this one's rows live
  // under a name nobody else can have guessed — and its folds in year 2998,
  // which nothing else writes (`seed-queries.test.ts` uses 9999, and neither
  // suite asserts which fold is the newest WITHOUT a date).
  const tag = `KOwn${mintToken(6).replaceAll(/[^A-Za-z0-9]/g, "")}`;
  const area = `Areas/${tag}`;
  const DRAFT = `${area}/secret-plan.md`;
  const DRAFT_TITLE = `Secret plan ${tag}`;
  const FOLD = "Journal/Fold/2998-01-02.md";
  const FOLDS = ["Journal/Fold/2998-01-01.md", FOLD];

  const rpc = (method: string, params: unknown, headers: Record<string, string>) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await rpc("tools/call", { name, arguments: args }, { authorization: `Bearer ${agentToken}` });
    expect(r.status, name).toBe(200);
    const result = (await r.json()).result;
    return { isError: result.isError === true, text: result.content[0].text as string, body: JSON.parse(result.content[0].text.split("\n")[0]) };
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-kor-${Date.now()}`,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      // The bridge would hand the draft's bytes to anyone who asked it — it
      // is the index, not the bridge, that knows the file is a draft. So the
      // stand-in answers for the draft too, and the refusal below is proven
      // to be the tool's own.
      readKnowledge: async (path) => (path === DRAFT ? `---\nstatus: draft\n---\n# ${DRAFT_TITLE}\n` : path === `${area}/sleep.md` ? "# Sleep\n" : null),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pkId = `kor-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "kor-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "kor-test");
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest owner-reads agent" })).token;
    // The widest an agent gets: content of the very folder the draft is in,
    // and the named-query door. Neither is a way to a draft.
    expect(await agents.setGrants(pool, agentId, { tier: "areas", areas: [area], queries: true })).toBe(true);

    await pool.query(
      `INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES
         ($1 || '/README.md',  'Index',  'Sleep, labs, and the protein blend', false, 'clean', '2026-09-20T12:00:00Z', now()),
         ($1 || '/sleep.md',   'Sleep',  'the taper',                          false, 'clean', '2026-09-27T08:00:00Z', now()),
         ($2,                  $3,       'not settled yet',                    true,  'clean', '2026-09-28T08:00:00Z', now()),
         ($1 || '/torn.md',    'Torn',   NULL,                                 true,  'conflict', now(), now()),
         ('Journal/Fold/2998-01-01.md', 'Fold — 1 January',  NULL, false, 'clean', now(), now()),
         ('Journal/Fold/2998-01-02.md', 'Fold — 2 January',  NULL, false, 'clean', now(), now())`,
      [area, DRAFT, DRAFT_TITLE],
    );
    await pool.query(
      `INSERT INTO knowledge_links (from_path, to_path, kind) VALUES
         ($1, $2 || '/sleep.md', 'wikilink'),
         ($1, $3,                'wikilink')`,
      [FOLD, area, DRAFT],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM knowledge_links WHERE from_path = ANY($1) OR to_path LIKE $2`, [FOLDS, `%${tag}%`]);
    await pool.query(`DELETE FROM knowledge_files WHERE path = ANY($1) OR path LIKE $2`, [FOLDS, `%${tag}%`]);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  const owner = () => ({ cookie });
  const get = (path: string, headers: Record<string, string> = owner()) => fetch(base + path, { headers });

  // ------------------------------------------------------ the generic door

  it("the generic door answers every non-owner credential the unknown-query refusal for all three, byte for byte", async () => {
    for (const headers of [{}, { authorization: `Bearer ${ownerToken}` }]) {
      const unknown = await get("/api/q/no_such_query_at_all", headers);
      const unknownBody = await unknown.json();
      for (const name of OWNER_READS) {
        const r = await get(`/api/q/${name}`, headers);
        expect(r.status, `${name} ${JSON.stringify(headers)}`).toBe(unknown.status);
        expect(await r.json(), name).toEqual(unknownBody);
      }
    }
    // An agent bearer never reaches the door at all: CRIT-7's uniform 403,
    // the same on this name as on any other route outside /capture and /mcp.
    for (const name of OWNER_READS) {
      const r = await get(`/api/q/${name}`, { authorization: `Bearer ${agentToken}` });
      expect(r.status, name).toBe(403);
      const text = await r.text();
      expect(text, name).not.toContain(tag);
    }
  });

  // --------------------------------------------------------------- /mcp

  it("/mcp's queries_list does not name them, and queries_run answers them as an unknown query", async () => {
    const listed = await tool("queries_list", {});
    expect(listed.isError).toBe(false);
    const names = (listed.body.queries as { name: string }[]).map((q) => q.name);
    for (const name of OWNER_READS) expect(names, name).not.toContain(name);

    const unknown = await tool("queries_run", { name: "no_such_query_at_all" });
    for (const name of OWNER_READS) {
      const r = await tool("queries_run", { name });
      expect(r.isError, name).toBe(true);
      expect(r.body, name).toEqual({ error: { code: "not_found", message: `no such query: ${name}` } });
      expect(r.body.error.code).toBe(unknown.body.error.code);
      expect(r.text, name).not.toContain(tag);
    }
  });

  it("no /mcp knowledge tool hands the agent the draft, though its folder is granted", async () => {
    // Content of a settled page in the same folder IS reachable — the grant is real …
    const sleep = await tool("knowledge_read", { path: `${area}/sleep.md` });
    expect(sleep.isError).toBe(false);
    // … and the draft beside it is not there, in the words a missing page gets.
    const read = await tool("knowledge_read", { path: DRAFT });
    expect(read.isError).toBe(true);
    expect(read.body.error.code).toBe("not_found");
    expect(read.text).not.toContain("not settled yet");

    const search = await tool("knowledge_search", { query: DRAFT_TITLE });
    expect(search.text).not.toContain("secret-plan");
    const listed = await tool("knowledge_list", { prefix: area });
    expect(listed.text).not.toContain("secret-plan");
  });

  // ------------------------------------------------------- the owner's door

  it("the owner reads the drafts — the draft, never the conflict or a settled page", async () => {
    for (const auth of [owner(), { authorization: `Bearer ${localOwnerToken}` }]) {
      const r = await get("/api/knowledge/drafts?limit=500", auth);
      expect(r.status).toBe(200);
      const body = await r.json();
      const mine = body.drafts.filter((d: { path: string }) => d.path.includes(tag));
      expect(mine).toEqual([{ path: DRAFT, area, title: DRAFT_TITLE, description: "not settled yet", modified: "2026-09-28T08:00:00.000Z" }]);
      expect(body).toMatchObject({ limit: 500, offset: 0, as_of: expect.any(String) });
    }
  });

  it("the owner reads the fold for a day: its links, a draft target dropped", async () => {
    const r = await get("/api/knowledge/fold?date=2998-01-02");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.fold).toMatchObject({ path: FOLD, date: "2998-01-02", title: "Fold — 2 January" });
    expect(body.fold.links).toEqual([{ path: `${area}/sleep.md`, title: "Sleep", kind: "wikilink", resolved: true }]);
    expect(JSON.stringify(body)).not.toContain("secret-plan");
    // on or before: the day before the newer one is the older fold, which links nowhere
    expect((await (await get("/api/knowledge/fold?date=2998-01-01")).json()).fold).toMatchObject({ path: "Journal/Fold/2998-01-01.md", links: [] });
    expect((await get("/api/knowledge/fold?date=2998-13-01")).status).toBe(400);
  });

  it("the owner reads the areas: the README's line, the settled count, the last settled change", async () => {
    const r = await get("/api/knowledge/areas");
    expect(r.status).toBe(200);
    const row = (await r.json()).areas.find((a: { area: string }) => a.area === area);
    // `named_by_fold` is the NEWEST fold's, which another suite may own at the moment this runs — so it is only typed here (seed-queries.test.ts pins it)
    expect(row).toEqual({ area, description: "Sleep, labs, and the protein blend", pages: 2, last_change: "2026-09-27T08:00:00.000Z", named_by_fold: expect.any(Boolean) });
  });
});
