// X-128: `GET /api/briefing` against the real scratch database and a live
// server — the misuse tests (U2, and the ticket's own): no credential 401;
// the capture owner token and the local owner token 403 (an owner credential
// is not an agent principal here, as at /mcp); a `none` grant gets an empty
// briefing; an opted-out agent gets an empty briefing; an `index` grant gets
// titles from its tier only; an agent outside the project never sees an
// unfolded session; no agent-written line appears as text; one `runs` row
// per briefing carries the handles and the hash of what was sent.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, normalizeRepoRemote } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { parseRemoteParam, parseRepoParam } from "../src/briefing-route.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe("the route's two parameters (pure)", () => {
  it("repo is one path segment; blank, slashes and control characters are refused", () => {
    expect(parseRepoParam(" Metistry ")).toBe("Metistry");
    for (const bad of [null, "", "  ", "a/b", "a\\b", "a\nb", "\0", "x".repeat(201)]) expect(parseRepoParam(bad), JSON.stringify(bad)).toBeNull();
  });
  it("remote is optional and reduces to the canonical shape, or to none — never an error", () => {
    expect(parseRemoteParam("git@github.com:Org/Repo.git")).toBe("github.com/Org/Repo");
    expect(parseRemoteParam("https://github.com/Org/Repo/")).toBe("github.com/Org/Repo");
    for (const bad of [null, "", "metistry", "github.com", "x".repeat(600)]) expect(parseRemoteParam(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe.skipIf(!hasDb)("GET /api/briefing", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let ownerToken: string;
  const localOwnerToken = mintToken();
  const MARK = `itest-briefing-${mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 4) || "x"}`;
  const tag = `bf${Date.now()}`;
  const slug = `${tag}-probe`; // Projects/<Name>.md → slug: lowercase of the name
  const PAGE = `Projects/${tag}-probe.md`;
  const RUNBOOK = `Areas/Ops/${tag}-runbook.md`;
  const FOLD = `Journal/Fold/2001-02-03.md`; // a day no other suite folds, so the shared scratch database cannot already hold it
  const FOLD_DRAFT = `Journal/Fold/2001-02-04.md`;
  const REMOTE = `github.com/${tag}/${tag}-probe`;
  const repo = `${tag}-probe`;
  const FOLDED = `Inbox/claude-code-session-${tag}-folded.md`;
  const UNFOLDED = `Inbox/claude-code-session-${tag}-unfolded.md`;
  const tokens: Record<string, string> = {};
  const ids = ["none", "index", "in", "out", "narrow", "optout"].map((k) => `${MARK}-${k}`);
  const [NONE, INDEX, IN, OUT, NARROW, OPTOUT] = ids as [string, string, string, string, string, string];
  let anchorRun: number;

  const AREAS = ["Projects", "Inbox", "Journal", "Areas/Ops"];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: "/nonexistent-briefing-inbox",
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      briefing: { budgetTokens: 1200 },
      now: () => new Date("2026-10-19T12:00:00.000Z"),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);

    // ---- the vault as the index holds it ----
    await pool.query(
      `INSERT INTO knowledge_files (path, mtime, content_hash, title, description) VALUES
         ($1, now(), 'a1a1a1a1a1a1a1a1', $2, 'OWNER-DESCRIPTION the probe project'),
         ($3, now(), 'b2b2b2b2b2b2b2b2', 'Runbook', 'LINKED-DESCRIPTION never shown')`,
      [PAGE, `${tag} Probe`, RUNBOOK],
    );
    await pool.query(`INSERT INTO knowledge_files (path, mtime, content_hash, title) VALUES ($1, now(), 'c3c3c3c3c3c3c3c3', 'ASSISTANT-FOLD-TITLE')`, [FOLD]);
    await pool.query(`INSERT INTO knowledge_files (path, mtime, content_hash, title, draft) VALUES ($1, now(), 'd4', 'A DRAFT FOLD', true)`, [FOLD_DRAFT]);
    await pool.query(
      `INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, $2, 'wikilink'), ($1, $2, 'frontmatter'), ($3, $1, 'wikilink'), ($4, $1, 'wikilink')`,
      [PAGE, RUNBOOK, FOLD, FOLD_DRAFT],
    );
    await pool.query(`INSERT INTO project_repos (remote, path) VALUES ($1, $2)`, [REMOTE, PAGE]);
    const task = (path: string, line: number, text: string, source: string | null, key: string) =>
      pool.query(
        `INSERT INTO vault_tasks (path, task_key, line_no, text, text_norm, checked, project, source, parsed_on, first_seen_on, last_seen_at, priority, due)
         VALUES ($1, $2, $3, $4, lower($4), false, $5, $6, current_date, current_date, now(), 1, '2026-10-20')`,
        [path, key, line, text, slug, source],
      );
    await task(PAGE, 7, "OWNER-TASK-TEXT ship the loader fix", null, `h:${tag}:1`);
    await task(PAGE, 9, "AGENT-PLANTED-TASK", "agent:scout", `h:${tag}:2`);
    await task(RUNBOOK, 3, "OTHER-PAGE-TASK", null, `h:${tag}:3`);
    // the fold's anchor, and two sessions: one the fold has read, one still waiting
    anchorRun = Number(
      (await pool.query(`INSERT INTO runs (component, kind, ok, ts, meta) VALUES ('knowledge-fold', 'routine_run', true, now() - interval '2 hours', '{"folded":"true"}') RETURNING id`)).rows[0]!.id,
    );
    const session = (path: string, started: string, prompt: string) =>
      pool.query(
        `INSERT INTO vault_sessions (path, content_hash, tool, repo, branch, started, turns, files, first_prompt)
         VALUES ($1, 'h', 'claude-code', $2, 'main', $3::timestamptz, 4, '["src/a.ts","src/b.ts"]', $4)`,
        [path, repo, started, prompt],
      );
    const dayAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    await session(FOLDED, dayAgo(1), "OWNER-FIRST-PROMPT fix the loader");
    await pool.query(`INSERT INTO inbox (source, path, note, ts, status) VALUES ('http', $1, 'note', $2::timestamptz, 'classified')`, [FOLDED, dayAgo(1)]);
    await session(UNFOLDED, dayAgo(0), "UNFOLDED-PROMPT still waiting");
    await pool.query(`INSERT INTO inbox (source, path, note, ts, status) VALUES ('http', $1, 'note', $2::timestamptz, 'new')`, [UNFOLDED, new Date(Date.now() + 86_400_000).toISOString()]);

    // ---- the agents ----
    for (const id of ids) tokens[id] = (await agents.createAgent(pool, { id, display_name: id })).token;
    await agents.setGrants(pool, INDEX, agents.validateGrants({ tier: "index" }));
    await agents.setGrants(pool, IN, agents.validateGrants({ tier: "areas", areas: AREAS }));
    await agents.setProjects(pool, IN, [slug]);
    await agents.setGrants(pool, OUT, agents.validateGrants({ tier: "areas", areas: AREAS }));
    await agents.setGrants(pool, NARROW, agents.validateGrants({ tier: "areas", areas: ["Areas/Ops"] }));
    await agents.setGrants(pool, OPTOUT, agents.validateGrants({ tier: "areas", areas: AREAS, briefing: false }));
    await agents.setProjects(pool, OPTOUT, [slug]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM runs WHERE id = $1 OR (kind = 'briefing' AND meta->>'agent' = ANY($2))`, [anchorRun, ids]);
    await pool.query(`DELETE FROM vault_sessions WHERE path = ANY($1)`, [[FOLDED, UNFOLDED]]);
    await pool.query(`DELETE FROM inbox WHERE path = ANY($1)`, [[FOLDED, UNFOLDED]]);
    await pool.query(`DELETE FROM vault_tasks WHERE task_key LIKE $1`, [`h:${tag}:%`]);
    await pool.query(`DELETE FROM project_repos WHERE path = $1`, [PAGE]);
    await pool.query(`DELETE FROM knowledge_links WHERE from_path = ANY($1) OR to_path = ANY($1)`, [[PAGE, RUNBOOK, FOLD, FOLD_DRAFT]]);
    await pool.query(`DELETE FROM knowledge_files WHERE path = ANY($1)`, [[PAGE, RUNBOOK, FOLD, FOLD_DRAFT]]);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  const get = (query: string, bearer?: string) =>
    fetch(`${base}/api/briefing${query}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  const Q = `?repo=${encodeURIComponent(repo)}&remote=${encodeURIComponent(`git@github.com:${tag}/${tag}-probe.git`)}`;

  it("U2: no credential is 401; the capture owner token and the local owner token are 403 — an owner credential is not an agent principal here", async () => {
    expect((await get(Q)).status).toBe(401);
    const capture = await get(Q, ownerToken);
    expect(capture.status).toBe(403);
    expect(await capture.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    const local = await get(Q, localOwnerToken);
    expect(local.status).toBe(403);
    expect(await local.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
  });

  it("an agent bearer reaches it; `repo` is required", async () => {
    const r = await get("", tokens[IN]);
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_request");
    expect((await get("?repo=a/b", tokens[IN])).status).toBe(400);
  });

  it("a `none` grant gets an empty briefing, and a runs row saying so", async () => {
    const r = await get(Q, tokens[NONE]);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ agent: NONE, repo, tier: "none", project: null, handles: [], text: "", empty: true });
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'briefing' AND meta->>'agent' = $1 ORDER BY id DESC LIMIT 1`, [NONE]);
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.meta).toMatchObject({ tier: "none", empty: true, handles: [], sha256: b.sha256 });
  });

  it("an opted-out agent gets an empty briefing — whatever its grant and project — and the runs row records the opt-out", async () => {
    const r = await get(Q, tokens[OPTOUT]);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ agent: OPTOUT, tier: "none", project: null, handles: [], text: "", empty: true });
    const { rows } = await pool.query(`SELECT meta FROM runs WHERE kind = 'briefing' AND meta->>'agent' = $1 ORDER BY id DESC LIMIT 1`, [OPTOUT]);
    expect(rows[0]!.meta).toMatchObject({ opted_out: true, empty: true });
  });

  it("an `index` grant gets titles from its tier only: paths and titles, never a description, a task, a file or a prompt", async () => {
    const r = await get(Q, tokens[INDEX]);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.tier).toBe("index");
    expect(b.project).toEqual({ path: PAGE, slug, title: `${tag} Probe`, sha256: "a1a1a1a1a1a1a1a1" });
    expect(b.text).toContain(`Project: ${PAGE} · "${tag} Probe" · sha256 a1a1a1a1a1a1`);
    expect(b.text).toContain(RUNBOOK);
    expect(b.text).toContain(`${FOLD} · 2001-02-03`);
    expect(b.text).toContain(FOLDED);
    expect(b.text).not.toContain(UNFOLDED); // not in the project
    for (const never of ["OWNER-DESCRIPTION", "LINKED-DESCRIPTION", "Open tasks", "OWNER-TASK-TEXT", "src/a.ts", "OWNER-FIRST-PROMPT", "A DRAFT FOLD", FOLD_DRAFT]) expect(b.text, never).not.toContain(never);
  });

  it("an `areas` grant in the project: the owner's text as text, every agent-written line as a handle, the unfolded session included", async () => {
    const r = await get(Q, tokens[IN]);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ agent: IN, repo, remote: REMOTE, tier: "areas", empty: false, truncated: false });
    expect(b.text).toContain("  OWNER-DESCRIPTION the probe project");
    expect(b.text).toContain(`  - [ ] OWNER-TASK-TEXT ship the loader fix · due 2026-10-20 · p1 · ${PAGE}:7`);
    expect(b.text).toContain(`  - ${PAGE}:9 · due 2026-10-20 · p1 (a task line; its text is not included)`);
    expect(b.text).toContain(`  - ${RUNBOOK}:3 · due 2026-10-20 · p1 (a task line; its text is not included)`);
    expect(b.text).toContain('first prompt "OWNER-FIRST-PROMPT fix the loader"');
    expect(b.text).toContain('first prompt "UNFOLDED-PROMPT still waiting"');
    expect(b.text).toContain(`${FOLD} · 2001-02-03 · "ASSISTANT-FOLD-TITLE" · sha256 c3c3c3c3c3c3`);
    expect(b.text).toContain(`  - ${RUNBOOK} · "Runbook" · sha256 b2b2b2b2b2b2`);
    for (const never of ["AGENT-PLANTED-TASK", "OTHER-PAGE-TASK", "LINKED-DESCRIPTION", "A DRAFT FOLD", FOLD_DRAFT]) expect(b.text, never).not.toContain(never);
    expect(b.handles.map((h: { kind: string; path: string }) => `${h.kind}:${h.path}`)).toEqual([
      `project:${PAGE}`,
      `task:${RUNBOOK}`, // the same priority and due date: then by path in byte order
      `task:${PAGE}`,
      `task:${PAGE}`,
      `session:${UNFOLDED}`,
      `session:${FOLDED}`,
      `fold:${FOLD}`,
      `link:${RUNBOOK}`,
    ]);
    // one runs row per briefing: the handles and the hash of what was sent, never the text
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'briefing' AND meta->>'agent' = $1 ORDER BY id DESC LIMIT 1`, [IN]);
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.meta).toMatchObject({ agent: IN, repo, remote: REMOTE, tier: "areas", empty: false, sha256: b.sha256, chars: b.chars, project: slug });
    expect(rows[0]!.meta.handles.map((h: { path: string }) => h.path)).toEqual(b.handles.map((h: { path: string }) => h.path));
    expect(JSON.stringify(rows[0]!.meta)).not.toContain("OWNER-DESCRIPTION");
    // and it is the same bytes on the next call (assembled from the same index; the hook calls once)
    const again = await (await get(Q, tokens[IN])).json();
    expect(again.sha256).toBe(b.sha256);
  });

  it("an agent outside the project never sees an unfolded session — nor with the project's remote on another checkout's name", async () => {
    const out = await (await get(Q, tokens[OUT])).json();
    expect(out.text).toContain(FOLDED);
    expect(out.text).not.toContain(UNFOLDED);
    expect(out.text).not.toContain("UNFOLDED-PROMPT");
    // in the project, but the checkout's name disagrees with the remote: folded only (X-131's tie)
    const mismatch = await (await get(`?repo=${encodeURIComponent(`${tag}-other`)}&remote=${encodeURIComponent(`https://github.com/${tag}/${tag}-probe`)}`, tokens[IN])).json();
    expect(mismatch.project?.path).toBe(PAGE);
    expect(mismatch.text).not.toContain(UNFOLDED);
  });

  it("a path outside the grant is never named: a grant that does not reach the project page gets no project, no task and no session", async () => {
    const b = await (await get(Q, tokens[NARROW])).json();
    expect(b.tier).toBe("areas");
    expect(b.project).toBeNull();
    expect(b.handles).toEqual([]);
    expect(b.empty).toBe(true);
    expect(b.text).toBe("");
  });

  it("the remote is matched in any clone spelling, and a repository nothing is known about is an empty briefing", async () => {
    const https = await (await get(`?repo=${encodeURIComponent(repo)}&remote=${encodeURIComponent(`https://github.com/${tag}/${tag}-probe/`)}`, tokens[IN])).json();
    expect(https.project?.path).toBe(PAGE);
    expect(normalizeRepoRemote(`https://github.com/${tag}/${tag}-probe/`)).toBe(REMOTE);
    const unknown = await (await get(`?repo=${encodeURIComponent(`${tag}-nothing`)}&remote=${encodeURIComponent(`https://github.com/${tag}/nothing`)}`, tokens[IN])).json();
    expect(unknown).toMatchObject({ project: null, handles: [], empty: true, remote: `github.com/${tag}/nothing` });
  });
});
