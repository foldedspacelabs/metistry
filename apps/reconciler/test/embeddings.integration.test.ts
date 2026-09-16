// Embedding on reconcile, against the real (scratch) database with a
// STUBBED embedder: only Postgres can prove the upserts, the per-model
// uniqueness, the orphan sweep and the pgvector ordering, and only a stub
// can prove the batching, the draft exclusion and the degrade path
// deterministically. The real-Ollama leg lives in embeddings.ollama.test.ts.
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { EmbedClient, type FetchLike } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Embeddings } from "../src/embeddings.js";
import { Indexer } from "../src/indexer.js";
import { searchVault } from "../src/search.js";
import { tempRepo, type TempRepo } from "./helpers.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const MODEL = "itest-embed";
const DIM = 768;

/**
 * A deterministic stand-in for nomic-embed-text: a normalized bag-of-words
 * vector. It is not a language model — it only has to be stable and to make
 * lexically related text closer, which is enough to assert ordering.
 */
function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Records every request so batching and "no request at all" are assertable. */
class StubOllama {
  batches: number[] = [];
  down = false;
  readonly fetchImpl: FetchLike = async (_url, init) => {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    const body = JSON.parse(init.body) as { input: string[] };
    this.batches.push(body.input.length);
    const payload = { embeddings: body.input.map(fakeVector) };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  get calls(): number {
    return this.batches.length;
  }
  reset(): void {
    this.batches = [];
  }
}

describe.skipIf(!hasDb)("reconciler embeddings (real db, stub embedder)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let vault: Vault;
  let embeddings: Embeddings;
  let indexer: Indexer;
  let client: EmbedClient;
  const stub = new StubOllama();

  const clean = async () => {
    await pool.query(`DELETE FROM embeddings`);
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'reconciler'`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await clean();
    repo = await tempRepo();
    // a note long enough to chunk, so batching is real and not one-per-file
    await writeFile(
      join(repo.root, "Knowledge", "Areas", "Sleep.md"),
      ["---", "title: Sleep", "description: how I sleep", "---", "", "# Sleep", "", ...Array.from({ length: 16 }, (_, i) => `Section ${i}: ${"restful night ".repeat(40)}`).flatMap((p) => [p, ""])].join("\n"),
    );
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    vault = new Vault(repo.root, repo.git, committer, { maxBytes: 200_000 });
    client = new EmbedClient({ model: MODEL, dim: DIM, batch: 4, fetchImpl: stub.fetchImpl });
    embeddings = new Embeddings(pool, client, async (p) => {
      const r = await vault.read(p);
      return r.ok ? r.value.content : null;
    });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false }, embeddings);
  });

  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("embeds settled notes on reconcile, batched, drafts excluded, model+dim per row", async () => {
    stub.reset();
    const s = await indexer.reconcile("test");
    expect(s.embeddings).toMatchObject({ degraded: null, pending: 0 });
    expect(s.embeddings!.files).toBe(4); // now.md, Alpha, Beta, Sleep — Draft.md is `status: draft`
    expect(s.embeddings!.chunks).toBeGreaterThan(4); // Sleep.md chunked

    // batching: the long note went out in requests of the configured size, not one call per chunk
    expect(Math.max(...stub.batches)).toBe(4); // the configured batch size, not one request per chunk
    expect(stub.batches.every((n) => n <= 4)).toBe(true);
    expect(stub.calls).toBeLessThan(s.embeddings!.chunks);

    const { rows } = await pool.query(`SELECT path, model, dim, count(*)::int AS n FROM embeddings GROUP BY path, model, dim ORDER BY path`);
    expect(rows.map((r) => r.path)).toEqual(["Knowledge/Areas/Alpha.md", "Knowledge/Areas/Beta.md", "Knowledge/Areas/Sleep.md", "Knowledge/now.md"]);
    expect(rows.every((r) => r.model === MODEL && r.dim === DIM)).toBe(true);
    expect(Number(rows.find((r) => r.path === "Knowledge/Areas/Sleep.md")!.n)).toBeGreaterThan(1);

    // the draft is indexed but never embedded — the exclusion is structural
    const draft = await pool.query(`SELECT 1 FROM embeddings WHERE path = 'Knowledge/Areas/Draft.md'`);
    expect(draft.rows).toHaveLength(0);
    expect((await pool.query(`SELECT draft FROM knowledge_files WHERE path = 'Knowledge/Areas/Draft.md'`)).rows[0]!.draft).toBe(true);
  });

  it("a second cycle embeds nothing: unchanged content is not re-embedded", async () => {
    stub.reset();
    const s = await indexer.reconcile("test");
    expect(stub.calls).toBe(0);
    expect(s.embeddings).toMatchObject({ files: 0, chunks: 0, pending: 0, degraded: null });
  });

  it("an edit re-embeds only the chunks that changed", async () => {
    const path = join(repo.root, "Knowledge", "Areas", "Beta.md");
    await writeFile(path, "# Beta\n\nplain note mentioning zebra and now also quokka\n");
    stub.reset();
    const s = await indexer.reconcile("test");
    expect(s.embeddings).toMatchObject({ files: 1, chunks: 1, degraded: null });
    expect(stub.calls).toBe(1);
    const { rows } = await pool.query(`SELECT content FROM embeddings WHERE path = 'Knowledge/Areas/Beta.md'`);
    expect(rows[0]!.content).toContain("quokka");
  });

  it("a rename re-keys the vectors instead of re-embedding them", async () => {
    const before = await pool.query(`SELECT content_hash FROM embeddings WHERE path = 'Knowledge/Areas/Alpha.md' ORDER BY chunk_index`);
    expect(before.rows.length).toBeGreaterThan(0);
    await rename(join(repo.root, "Knowledge", "Areas", "Alpha.md"), join(repo.root, "Knowledge", "Areas", "Renamed.md"));
    stub.reset();
    const s = await indexer.reconcile("test");
    expect(s.renamed).toBe(1);
    expect(stub.calls).toBe(0); // the bytes did not change: no embedder call at all
    expect(s.embeddings).toMatchObject({ files: 0, chunks: 0, degraded: null });
    const after = await pool.query(`SELECT content_hash FROM embeddings WHERE path = 'Knowledge/Areas/Renamed.md' ORDER BY chunk_index`);
    expect(after.rows).toEqual(before.rows);
    expect((await pool.query(`SELECT 1 FROM embeddings WHERE path = 'Knowledge/Areas/Alpha.md'`)).rows).toHaveLength(0);
  });

  it("a removed note's vectors go with it, and so do a note's when it becomes a draft", async () => {
    await rm(join(repo.root, "Knowledge", "Areas", "Renamed.md"));
    await writeFile(join(repo.root, "Knowledge", "Areas", "Beta.md"), "---\nstatus: draft\n---\n\nnot ready\n");
    stub.reset();
    const s = await indexer.reconcile("test");
    expect(s.removed).toBe(1);
    expect(s.embeddings!.deleted).toBeGreaterThanOrEqual(2);
    const { rows } = await pool.query(`SELECT DISTINCT path FROM embeddings ORDER BY path`);
    expect(rows.map((r) => r.path)).toEqual(["Knowledge/Areas/Sleep.md", "Knowledge/now.md"]);
  });

  it("an embedder that is down degrades the cycle, never fails it, and the note is retried later", async () => {
    await writeFile(join(repo.root, "Knowledge", "Areas", "Late.md"), "# Late\n\narrived while the embedder was down\n");
    stub.down = true;
    const s = await indexer.reconcile("test");
    stub.down = false;

    expect(s.added).toBe(1); // the INDEX is complete and correct
    expect(s.embeddings!.degraded).toMatch(/ECONNREFUSED/);
    expect(s.embeddings!.pending).toBeGreaterThan(0);
    expect((await pool.query(`SELECT 1 FROM embeddings WHERE path = 'Knowledge/Areas/Late.md'`)).rows).toHaveLength(0);
    expect((await embeddings.status()).degraded).toMatch(/ECONNREFUSED/);

    // no rebuild needed, no lost work: the next cycle picks up exactly that note
    const s2 = await indexer.reconcile("test");
    expect(s2.embeddings).toMatchObject({ files: 1, degraded: null, pending: 0 });
    expect((await pool.query(`SELECT 1 FROM embeddings WHERE path = 'Knowledge/Areas/Late.md'`)).rows).toHaveLength(1);
  });

  it("rows from another model mean a rebuild is required, and the rebuild is deterministic", async () => {
    const before = await pool.query(`SELECT path, chunk_index, content_hash FROM embeddings WHERE model = $1 ORDER BY path, chunk_index`, [MODEL]);
    await pool.query(
      `INSERT INTO embeddings (path, chunk_index, content, model, dim, embedding, content_hash)
       VALUES ('Knowledge/now.md', 0, 'stale', 'some-other-model', $1, $2::vector, 'deadbeef')`,
      [DIM, `[${new Array(DIM).fill(0).join(",")}]`],
    );
    const stale = await embeddings.status();
    expect(stale.rebuild_required).toBe(true);
    expect(stale.stored.map((s) => s.model).sort()).toEqual([MODEL, "some-other-model"]);

    const r = await embeddings.rebuild();
    expect(r.degraded).toBeNull();
    const after = await pool.query(`SELECT path, chunk_index, content_hash FROM embeddings WHERE model = $1 ORDER BY path, chunk_index`, [MODEL]);
    expect(after.rows).toEqual(before.rows); // same content, same chunks, same hashes
    const fresh = await embeddings.status();
    expect(fresh.rebuild_required).toBe(false);
    expect(fresh.stored.map((s) => s.model)).toEqual([MODEL]);
  });

  it("search modes: keyword, semantic, hybrid — all with a score, drafts never present", async () => {
    await writeFile(join(repo.root, "Knowledge", "Areas", "Nights.md"), "---\ntitle: Nights\n---\n\n# Nights\n\nrestful night after restful night, the quokka slept\n");
    await indexer.reconcile("test");
    const deps = { vault, db: pool, embeddings, client };

    const kw = await searchVault(deps, "quokka", 10, "keyword");
    expect(kw.mode).toBe("keyword");
    expect(kw.hits.map((h) => h.path)).toEqual(["Knowledge/Areas/Nights.md"]);
    expect(kw.hits[0]!.score).toBe(1);

    // "restful night" appears in both Sleep.md and Nights.md; the vector ranks them
    const sem = await searchVault(deps, "restful night", 10, "semantic");
    expect(sem.mode).toBe("semantic");
    expect(sem.hits.length).toBeGreaterThan(1);
    expect(sem.hits.map((h) => h.path)).toContain("Knowledge/Areas/Sleep.md");
    expect(sem.hits[0]!.score).toBeGreaterThan(sem.hits[sem.hits.length - 1]!.score);
    expect(sem.hits.every((h) => h.source === "semantic" && h.score <= 1)).toBe(true);
    expect(sem.hits.map((h) => h.path)).not.toContain("Knowledge/Areas/Beta.md"); // the draft

    // the default is hybrid once vectors exist, and fusion finds notes only one list had
    const auto = await searchVault(deps, "restful night", 10, null);
    expect(auto.mode).toBe("hybrid");
    expect(auto.hits.some((h) => h.source === "both")).toBe(true);
    expect(auto.hits[0]!.score).toBeLessThan(1); // RRF, not a similarity

    // an embedder that is down does not take search with it
    stub.down = true;
    const fallback = await searchVault(deps, "quokka", 10, "semantic");
    stub.down = false;
    expect(fallback.mode).toBe("keyword");
    expect(fallback.degraded).toMatch(/embedder unavailable/);
    expect(fallback.hits.map((h) => h.path)).toEqual(["Knowledge/Areas/Nights.md"]);
  });
});
