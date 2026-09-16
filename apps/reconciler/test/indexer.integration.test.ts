// The reconcile loop against the real (scratch) database: only Postgres
// can prove the upserts, the partial-index ON CONFLICT for conflict
// proposals, and the rename/removal bookkeeping. Skipped without a db.
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Indexer } from "../src/indexer.js";
import { tempRepo, type TempRepo } from "./helpers.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

describe.skipIf(!hasDb)("reconciler index loop (real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let committer: Committer;
  let indexer: Indexer;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    // the index is derived (invariant 1): start from nothing
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'reconciler'`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
    repo = await tempRepo();
    committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: true });
  });
  afterAll(async () => {
    await repo.cleanup();
    // leave the shared scratch db as found: later suites (mcp-brain) index-search globally
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'reconciler'`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
    await pool.end();
  });

  it("first cycle indexes every note: hash, title, description, draft, links; one runs row", async () => {
    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ files: 4, added: 4, changed: 0, renamed: 0, removed: 0, conflicts: 0, external_edits: 0 });
    const { rows } = await pool.query(`SELECT path, title, description, draft, status, length(content_hash) AS hl FROM knowledge_files ORDER BY path`);
    expect(rows).toEqual([
      { path: "Knowledge/Areas/Alpha.md", title: "Alpha", description: "the first area", draft: false, status: "clean", hl: 64 },
      { path: "Knowledge/Areas/Beta.md", title: "Beta", description: null, draft: false, status: "clean", hl: 64 },
      { path: "Knowledge/Areas/Draft.md", title: "Draft", description: null, draft: true, status: "clean", hl: 64 },
      { path: "Knowledge/now.md", title: "now", description: null, draft: false, status: "clean", hl: 64 },
    ]);
    const links = await pool.query(`SELECT from_path, to_path, kind FROM knowledge_links ORDER BY to_path`);
    expect(links.rows).toEqual([
      { from_path: "Knowledge/Areas/Alpha.md", to_path: "Areas/Gamma", kind: "wikilink" }, // dangling: kept as written
      { from_path: "Knowledge/Areas/Alpha.md", to_path: "Knowledge/Areas/Beta.md", kind: "wikilink" }, // resolved by basename
    ]);
    const run = await pool.query(`SELECT component, kind, ok, meta FROM runs WHERE id = $1`, [s.run_id]);
    expect(run.rows[0]).toMatchObject({ component: "reconciler", kind: "collector_run", ok: true });
    expect(run.rows[0].meta.files).toBe(4);
  });

  it("a content-identical touch changes nothing (hash, not mtime)", async () => {
    const p = join(repo.root, "Knowledge/Areas/Beta.md");
    const before = (await pool.query(`SELECT indexed_at FROM knowledge_files WHERE path = 'Knowledge/Areas/Beta.md'`)).rows[0].indexed_at;
    await new Promise((r) => setTimeout(r, 20));
    const { utimes } = await import("node:fs/promises");
    await utimes(p, new Date(), new Date()); // sync-style mtime churn
    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ added: 0, changed: 0, renamed: 0, removed: 0 });
    const after = (await pool.query(`SELECT indexed_at FROM knowledge_files WHERE path = 'Knowledge/Areas/Beta.md'`)).rows[0].indexed_at;
    expect(String(after)).toBe(String(before));
  });

  it("detects a rename by hash and carries the row + links across", async () => {
    await mkdir(join(repo.root, "Knowledge/Areas/Moved"), { recursive: true });
    await rename(join(repo.root, "Knowledge/Areas/Alpha.md"), join(repo.root, "Knowledge/Areas/Moved/Alpha.md"));
    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ files: 4, added: 0, changed: 0, renamed: 1, removed: 0 });
    const { rows } = await pool.query(`SELECT path FROM knowledge_files WHERE title = 'Alpha'`);
    expect(rows).toEqual([{ path: "Knowledge/Areas/Moved/Alpha.md" }]);
    const links = await pool.query(`SELECT to_path FROM knowledge_links WHERE from_path = 'Knowledge/Areas/Moved/Alpha.md' ORDER BY to_path`);
    expect(links.rows.map((r) => r.to_path)).toEqual(["Areas/Gamma", "Knowledge/Areas/Beta.md"]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM knowledge_links WHERE from_path = 'Knowledge/Areas/Alpha.md'`)).rows[0].n).toBe(0);
  });

  it("an edit re-indexes; a removal drops the row and its links", async () => {
    await writeFile(join(repo.root, "Knowledge/Areas/Beta.md"), "---\ntitle: Beta!\nstatus: draft\n---\nnow a draft linking [[now]]\n");
    await unlink(join(repo.root, "Knowledge/Areas/Draft.md"));
    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ files: 3, added: 0, changed: 1, renamed: 0, removed: 1 });
    const beta = (await pool.query(`SELECT title, draft FROM knowledge_files WHERE path = 'Knowledge/Areas/Beta.md'`)).rows[0];
    expect(beta).toEqual({ title: "Beta!", draft: true });
    expect((await pool.query(`SELECT to_path FROM knowledge_links WHERE from_path = 'Knowledge/Areas/Beta.md'`)).rows).toEqual([{ to_path: "Knowledge/now.md" }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM knowledge_files WHERE path = 'Knowledge/Areas/Draft.md'`)).rows[0].n).toBe(0);
  });

  it("an Obsidian conflict file is flagged once as a proposal, never indexed as a note", async () => {
    const p = "Knowledge/Areas/Beta (conflict 2026-09-06 12-00-00).md";
    await writeFile(join(repo.root, p), "# Beta\n\nthe other device's version\n");
    const s1 = await indexer.reconcile("test");
    expect(s1).toMatchObject({ conflicts: 1, conflicts_new: 1 });
    const s2 = await indexer.reconcile("test");
    expect(s2).toMatchObject({ conflicts: 1, conflicts_new: 0 }); // not one per cycle
    const props = await pool.query(`SELECT kind, source_agent, trust, decision, payload FROM proposals WHERE source_agent = 'reconciler'`);
    expect(props.rows).toHaveLength(1);
    expect(props.rows[0]).toMatchObject({ kind: "report", source_agent: "reconciler", trust: "internal", decision: "pending" });
    expect(props.rows[0].payload).toMatchObject({ kind: "conflict_file", refs: [p], idempotency_key: `conflict:${p}` });
    const row = (await pool.query(`SELECT status, draft FROM knowledge_files WHERE path = $1`, [p])).rows[0];
    expect(row).toEqual({ status: "conflict", draft: true }); // structurally invisible to agents
    expect((await pool.query(`SELECT count(*)::int AS n FROM knowledge_links WHERE from_path = $1`, [p])).rows[0].n).toBe(0);
  });

  it("sweeps edits made outside the bridge into one `user` commit intent, skipping pending bridge paths and conflict copies", async () => {
    // everything so far in this file was written straight to disk, i.e. "Obsidian did it" —
    // the earlier cycles queued those; land them so this test sees a clean slate
    const first = await committer.flush();
    const swept = first.commits.find((c) => c.principal === "user");
    expect(swept).toBeTruthy();
    expect(swept!.group).toBe("sync");
    expect(swept!.paths).toContain("Knowledge/Areas/Moved/Alpha.md");
    expect(swept!.paths.some((p) => p.includes("(conflict"))).toBe(false); // flagged, not committed
    expect((await repo.git.run(["show", "-s", "--format=%an", swept!.sha])).trim()).toBe("Metistry user");

    await writeFile(join(repo.root, "Knowledge/Areas/Phone.md"), "typed on a phone\n"); // sync delivered this
    await writeFile(join(repo.root, "Knowledge/Areas/Bridge.md"), "written via the bridge\n");
    committer.enqueue({ paths: ["Knowledge/Areas/Bridge.md"], principal: "assistant", message: "Add Bridge" }); // in-flight bridge intent
    const s = await indexer.reconcile("test");
    expect(s.external_edits).toBe(1);
    const r = await committer.flush();
    const user = r.commits.find((c) => c.principal === "user");
    expect(user!.paths).toEqual(["Knowledge/Areas/Phone.md"]); // not Bridge.md (the assistant's), not the conflict copy
    expect(r.commits.find((c) => c.principal === "assistant")!.paths).toEqual(["Knowledge/Areas/Bridge.md"]);
    // a quiet cycle sweeps nothing
    const again = await indexer.reconcile("test");
    expect(again.external_edits).toBe(0);
  });
});
