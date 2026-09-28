// An agent asks for the owner's review through `requests_create` kind
// `pull_request` (T2-13, R6) — on /mcp, real MCP client, the scratch
// database. The ask is the SAME subject the GitHub sync mirrors (core's
// `githubPullSource`), so two asks — two agents, or an agent and the sync —
// are one card; it carries the head the sync read, never the agent's; and
// asking posts nothing to GitHub (this package has no GitHub client at all).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { githubPullSource, mintToken, raiseMirror } from "@foldedspacelabs/metistry-core";
import { createBrainServer, pullRequestRefOf, type AgentPrincipal } from "../src/index.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const REPO = `itest-ask-${suffix}/repo`;
const HEAD = "d".repeat(40);
const AGENT = `itest-ask-${suffix}`;
const OTHER = `itest-ask2-${suffix}`;

describe("the PR a ref names (pure)", () => {
  it("is gh:owner/name#n, or the PR's github.com URL spelled that way — nothing else", () => {
    expect(pullRequestRefOf("gh:o/r#41")).toBe("gh:o/r#41");
    expect(pullRequestRefOf("https://github.com/o/r/pull/41")).toBe("gh:o/r#41");
    expect(pullRequestRefOf("https://github.com/o/r/pull/41/files#diff-1")).toBe("gh:o/r#41");
    for (const bad of ["https://github.com/o/r/issues/41", "http://github.com/o/r/pull/41", "https://github.example/o/r/pull/41", "gh:o/r", "Areas/Work/note.md", "task 12"]) {
      expect(pullRequestRefOf(bad), bad).toBeUndefined();
    }
  });
});

describe.skipIf(!hasDb)("requests_create kind pull_request (real db, real MCP client)", () => {
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let workId = 0;
  const principals = new Map<string, AgentPrincipal>();

  async function ask(token: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
    const client = new Client({ name: "itest", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const r = (await client.callTool({ name: "requests_create", arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = r.content[0]!.text;
      const nl = text.indexOf("\n");
      return { isError: !!r.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)) };
    } finally {
      await client.close();
    }
  }
  const rows = async () =>
    (await pool.query(`SELECT id, kind, source_agent, trust, decision, source, work_id, payload FROM proposals WHERE source->>'external_ref' LIKE $1 ORDER BY id`, [`gh:${REPO}#%`])).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const w = await pool.query(
      `INSERT INTO work (title, area, kind, status, external_ref, meta) VALUES ('Fix the parser', 'repo', 'pr', 'open', $1, $2) RETURNING id`,
      [`gh:${REPO}#7`, JSON.stringify({ author: "dana", url: `https://github.com/${REPO}/pull/7`, head_sha: HEAD, needs_my_review: true })],
    );
    workId = Number(w.rows[0].id);
    await pool.query(`INSERT INTO work (title, area, kind, status, external_ref, meta) VALUES ('Merged one', 'repo', 'pr', 'closed', $1, $2)`, [`gh:${REPO}#8`, JSON.stringify({ head_sha: HEAD })]);
    const authenticate = async (req: { headers: Record<string, unknown> }) => {
      const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ""));
      return (m?.[1] && principals.get(m[1])) || null;
    };
    const brain = createBrainServer({ db: pool, authenticate, tasks: new TasksService(pool), inboxDir: "/tmp/metistry-itest-ask" });
    server = createServer((req, res) => {
      if (req.url === "/mcp") void brain.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    principals.set("tok-a", { id: AGENT, grants: { tier: "none", areas: [] }, projects: [] });
    principals.set("tok-b", { id: OTHER, grants: { tier: "none", areas: [] }, projects: [] });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM proposals WHERE source->>'external_ref' LIKE $1`, [`gh:${REPO}#%`]);
    await pool.query(`DELETE FROM work WHERE external_ref LIKE $1`, [`gh:${REPO}#%`]);
    await pool.end();
  });

  it("refuses without exactly one pull request in refs, and for one the sync does not track open — writing nothing", async () => {
    for (const refs of [undefined, [], ["Areas/Work/x.md"], [`gh:${REPO}#7`, `gh:${REPO}#9`]]) {
      const r = await ask("tok-a", { kind: "pull_request", title: "Review please", body: "b", ...(refs ? { refs } : {}) });
      expect(r.isError, JSON.stringify(refs)).toBe(true);
      expect(r.body.error.code).toBe("invalid_request");
    }
    for (const ref of [`gh:${REPO}#9`, `gh:${REPO}#8`]) {
      const r = await ask("tok-a", { kind: "pull_request", title: "Review please", body: "b", refs: [ref] });
      expect(r.isError, ref).toBe(true);
      expect(r.body.error.code).toBe("not_found");
    }
    expect(await rows()).toEqual([]);
  });

  it("raises the PR's mirror with the head the sync read — and a second ask, or the sync's, is the same card", async () => {
    const first = await ask("tok-a", { kind: "pull_request", title: "Review the parser fix", body: "I changed the tokenizer; the tests pass.", refs: [`https://github.com/${REPO}/pull/7`] });
    expect(first.isError).toBe(false);
    expect(first.body.deduplicated).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ kind: "pull_request", source_agent: AGENT, trust: "external", decision: "pending" });
    expect(Number(row.work_id)).toBe(workId);
    expect(row.source).toEqual({ kind: "github", external_ref: `gh:${REPO}#7`, person: "dana" });
    expect(row.payload).toMatchObject({ title: "Review the parser fix", repo: REPO, number: 7, head_sha: HEAD, url: `https://github.com/${REPO}/pull/7`, context: { prose: "I changed the tokenizer; the tests pass." } });

    const second = await ask("tok-b", { kind: "pull_request", title: "Also: review", body: "x", refs: [`gh:${REPO}#7`] });
    expect(second.body).toEqual({ id: first.body.id, deduplicated: "subject" });
    // the sync's raise for the same PR lands on the same row (what github-state calls)
    const sync = await raiseMirror(pool, { kind: "pull_request", source_agent: "github-state", trust: "external", source: githubPullSource(REPO, 7, "dana"), payload: { head_sha: HEAD }, work_id: workId });
    expect(sync).toEqual({ id: first.body.id, raised: false });
    expect(await rows()).toHaveLength(1);
  });
});
