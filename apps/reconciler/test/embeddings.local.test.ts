// The real leg: real Postgres + pgvector, a real local model server, a real
// embedding model. Nothing here is stubbed, which is the point — the stub
// suite proves the bookkeeping, this one proves the thing actually
// retrieves. Skips cleanly (not fails) when either is absent, so a Mac with
// no local server still runs the suite.
//
// The server is whatever `METISTRY_LOCAL_MODEL_URL` names and, failing that,
// a default Ollama — the probe is `/v1/embeddings` (C18), so LM Studio and
// the bundled llama-server serve this suite equally well.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { EMBED_DEFAULT_DIM, EMBED_DEFAULT_MODEL, EmbedClient, resolveLocalModelUrl } from "@foldedspacelabs/metistry-core";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Embeddings } from "../src/embeddings.js";
import { Indexer } from "../src/indexer.js";
import { searchVault } from "../src/search.js";
import { tempRepo, type TempRepo } from "./helpers.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

const LOCAL = resolveLocalModelUrl(process.env).url;
const MODEL = process.env.METISTRY_EMBED_MODEL ?? EMBED_DEFAULT_MODEL;
const hasDb = !!process.env.METISTRY_DB_PASSWORD;

/** Is the model actually loaded? A running server without it is still "absent". */
const embedderReady = await (async () => {
  try {
    const res = await fetch(`${LOCAL}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: ["probe"] }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
})();
if (!embedderReady) console.warn(`local model server: ${LOCAL} does not serve ${MODEL} — skipping the real-embedder suite (\`metistry compute models install <provider>/${MODEL}\`)`);

// A random marker per run, so this suite's rows in the path-keyed tables
// (embeddings, knowledge_links, knowledge_files) never share a literal path
// with a sibling reconciler test file's rows in the shared scratch db
// (docs/ops/testing.md, "count your own rows").
const MARKER = `itest-${randomUUID().slice(0, 8)}`;
const PREFIX = `Areas/${MARKER}/`;

const NOTES: Record<string, string> = {
  [`${PREFIX}WaterHeater.md`]: [
    "---",
    "title: Water heater",
    "description: the tank in the basement and what to do about it",
    "---",
    "",
    "# Water heater",
    "",
    "The forty gallon tank downstairs is fourteen years old and the anode rod is gone.",
    "The plumber quoted replacement at about two thousand dollars, or a tankless unit for rather more.",
    "",
    "## Decision",
    "",
    "Replace it before winter rather than waiting for it to fail and flood the basement floor.",
  ].join("\n"),
  [`${PREFIX}Marathon.md`]: [
    "---",
    "title: Marathon training",
    "description: the build to race day",
    "---",
    "",
    "# Marathon training",
    "",
    "Mileage peaked at fifty a week in week twelve and the long run reached twenty miles.",
    "",
    "## Taper",
    "",
    "Cut volume sharply in the last three weeks before the race while keeping some intensity,",
    "so the legs arrive fresh on the start line instead of tired from training.",
  ].join("\n"),
  [`${PREFIX}Unsettled.md`]: ["---", "title: Unsettled", "status: draft", "---", "", "Tapering before a race is something I should write about properly one day."].join("\n"),
};

describe.skipIf(!hasDb || !embedderReady)("reconciler embeddings (real db, a real local model server)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let deps: Parameters<typeof searchVault>[0];
  let embeddings: Embeddings;

  const clean = async () => {
    await pool.query(`DELETE FROM embeddings WHERE path LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE $1 OR to_path LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`${PREFIX}%`]);
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
    repo = await tempRepo(MARKER);
    for (const [path, body] of Object.entries(NOTES)) await writeFile(join(repo.root, path), `${body}\n`);
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 200_000 });
    const client = new EmbedClient({ url: LOCAL, model: MODEL, dim: EMBED_DEFAULT_DIM, batch: 16 });
    embeddings = new Embeddings(pool, client, async (p) => {
      const r = await vault.read(p);
      return r.ok ? r.value.content : null;
    });
    const indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false }, embeddings);
    deps = { vault, db: pool, embeddings, client };

    const started = Date.now();
    const s = await indexer.reconcile("test");
    console.log(`ollama: embedded ${s.embeddings?.chunks} chunks across ${s.embeddings?.files} notes in ${Date.now() - started}ms (${MODEL})`);
    expect(s.embeddings?.degraded).toBeNull();
  }, 120_000);

  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("stores 768-dimension vectors for settled notes only, model and dim on every row", async () => {
    const { rows } = await pool.query(`SELECT path, model, dim, vector_dims(embedding) AS d FROM embeddings WHERE path LIKE $1 ORDER BY path, chunk_index`, [
      `${PREFIX}%`,
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.model === MODEL && Number(r.dim) === EMBED_DEFAULT_DIM && Number(r.d) === EMBED_DEFAULT_DIM)).toBe(true);
    expect(rows.map((r) => String(r.path))).not.toContain(`${PREFIX}Unsettled.md`); // the draft, which mentions tapering
  });

  it("semantic finds the note by meaning where keyword finds nothing", async () => {
    // Not one word of this query appears in the taper section.
    const q = "how much should I ease off running in the final weeks so my legs are fresh";
    const kw = await searchVault(deps, q, 5, "keyword");
    expect(kw.hits.map((h) => h.path)).not.toContain(`${PREFIX}Marathon.md`);

    const started = Date.now();
    const sem = await searchVault(deps, q, 5, "semantic");
    const ms = Date.now() - started;
    console.log(`ollama: semantic query in ${ms}ms → ${sem.hits.map((h) => `${h.path} ${h.score.toFixed(3)}`).join(", ")}`);

    expect(sem.mode).toBe("semantic");
    expect(sem.hits[0]!.path).toBe(`${PREFIX}Marathon.md`);
    expect(sem.hits[0]!.score).toBeGreaterThan(0.5);
    expect(sem.hits[0]!.score).toBeGreaterThan(sem.hits[1]!.score);
    expect(sem.hits.map((h) => h.path)).not.toContain(`${PREFIX}Unsettled.md`);
  }, 60_000);

  it("the other note wins its own question — the ranking is about meaning, not one lucky note", async () => {
    const sem = await searchVault(deps, "should I replace the old tank in the basement before it leaks", 5, "semantic");
    expect(sem.hits[0]!.path).toBe(`${PREFIX}WaterHeater.md`);
  }, 60_000);

  it("hybrid is the default once vectors exist, and fuses both lists", async () => {
    const auto = await searchVault(deps, "taper", 10, null);
    expect(auto.mode).toBe("hybrid"); // no mode asked for, vectors present
    // "taper" is a literal word in Marathon.md (keyword) and the semantic
    // neighbourhood of the same note: fusion should agree with both.
    expect(auto.hits[0]!.path).toBe(`${PREFIX}Marathon.md`);
    expect(auto.hits.some((h) => h.source === "both")).toBe(true);
    expect(auto.hits.every((h) => h.score > 0)).toBe(true);
  }, 60_000);

  it("a rebuild reproduces the same chunks byte for byte (decision 8)", async () => {
    const before = await pool.query(`SELECT path, chunk_index, content_hash FROM embeddings WHERE path LIKE $1 ORDER BY path, chunk_index`, [`${PREFIX}%`]);
    const r = await embeddings.rebuild();
    expect(r.degraded).toBeNull();
    const after = await pool.query(`SELECT path, chunk_index, content_hash FROM embeddings WHERE path LIKE $1 ORDER BY path, chunk_index`, [`${PREFIX}%`]);
    expect(after.rows).toEqual(before.rows);
  }, 120_000);
});
