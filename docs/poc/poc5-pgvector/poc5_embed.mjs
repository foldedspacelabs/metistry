#!/usr/bin/env node
// PoC-5 embed pipeline: corpus/*.md -> chunk -> sha256 -> Ollama embed -> pgvector.
//
// Insert path avoids naive string interpolation of note content into SQL:
// rows are written to a tab-delimited file using Postgres COPY TEXT-format
// escaping (lib.mjs#copyEscape) and loaded with `\copy ... FROM file`, which
// streams through the COPY protocol rather than building an INSERT string.
//
// Always truncates poc5_embeddings and reinserts the full corpus -- this is
// the "data rebuild" half of a full rebuild; poc5_rebuild.sh pairs it with
// re-running schema.sql for the "DDL rebuild" half.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  parseFrontmatter, chunkMarkdown, sha256, embedBatch,
  copyEscape, vectorLiteral, PSQL, PG_ENV, EMBED_MODEL, EMBED_DIM,
} from "./lib.mjs";

const CORPUS_DIR = join(import.meta.dirname, "corpus");
const BATCH_SIZE = 16;

function fmt(n) { return n.toFixed(2); }

async function main() {
  const t0 = performance.now();

  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".md")).sort();
  console.log(`Found ${files.length} corpus files in ${CORPUS_DIR}`);

  // 1. Read + chunk everything first (cheap, CPU-only)
  const rows = []; // { path, chunk_index, content, hash }
  for (const f of files) {
    const raw = readFileSync(join(CORPUS_DIR, f), "utf8");
    const { body } = parseFrontmatter(raw);
    const chunks = chunkMarkdown(body);
    chunks.forEach((c, i) => {
      rows.push({ path: f, chunk_index: i, content: c, hash: sha256(c) });
    });
  }
  const tChunked = performance.now();
  console.log(`Chunked into ${rows.length} chunks from ${files.length} notes ` +
    `(${fmt(rows.length / files.length)} chunks/note avg) in ${fmt(tChunked - t0)}ms`);

  // 2. Embed in batches via Ollama
  const tEmbedStart = performance.now();
  let embedded = 0;
  const batchTimes = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const bt0 = performance.now();
    const vectors = await embedBatch(batch.map((r) => r.content));
    const bt1 = performance.now();
    batchTimes.push(bt1 - bt0);
    vectors.forEach((v, j) => {
      if (v.length !== EMBED_DIM) {
        throw new Error(`Unexpected embedding dim ${v.length} for ${batch[j].path}#${batch[j].chunk_index}`);
      }
      batch[j].embedding = v;
    });
    embedded += batch.length;
    process.stdout.write(`  embedded ${embedded}/${rows.length}\r`);
  }
  const tEmbedEnd = performance.now();
  console.log(`\nEmbedded ${embedded} chunks in ${fmt(tEmbedEnd - tEmbedStart)}ms ` +
    `(${fmt(embedded / ((tEmbedEnd - tEmbedStart) / 1000))} chunks/sec, ` +
    `${rows.length} batches of up to ${BATCH_SIZE}, ` +
    `batch time min/avg/max = ${fmt(Math.min(...batchTimes))}/` +
    `${fmt(batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length)}/` +
    `${fmt(Math.max(...batchTimes))}ms)`);

  // 3. Write COPY-format TSV
  const tmpDir = mkdtempSync(join(tmpdir(), "poc5-embed-"));
  const tsvPath = join(tmpDir, "rows.tsv");
  const lines = rows.map((r) => [
    copyEscape(r.path),
    String(r.chunk_index),
    copyEscape(r.content),
    EMBED_MODEL,
    String(EMBED_DIM),
    vectorLiteral(r.embedding),
    r.hash,
  ].join("\t"));
  writeFileSync(tsvPath, lines.join("\n") + "\n", "utf8");

  const copySqlPath = join(tmpDir, "copy.sql");
  writeFileSync(copySqlPath,
    `TRUNCATE poc5_embeddings;\n` +
    `\\copy poc5_embeddings(path, chunk_index, content, model, dim, embedding, content_hash) FROM '${tsvPath}' WITH (FORMAT text)\n`,
    "utf8");

  // 4. Load via psql \copy, timed
  const tInsertStart = performance.now();
  execFileSync(PSQL, ["-v", "ON_ERROR_STOP=1", "-f", copySqlPath], { env: PG_ENV, stdio: "inherit" });
  const tInsertEnd = performance.now();
  console.log(`DB insert (TRUNCATE + \\copy) took ${fmt(tInsertEnd - tInsertStart)}ms ` +
    `for ${rows.length} rows (${fmt(rows.length / ((tInsertEnd - tInsertStart) / 1000))} rows/sec)`);

  rmSync(tmpDir, { recursive: true, force: true });

  const tEnd = performance.now();
  console.log(`\nTotal wall time: ${fmt(tEnd - t0)}ms`);
  console.log(JSON.stringify({
    notes: files.length,
    chunks: rows.length,
    chunk_time_ms: tChunked - t0,
    embed_time_ms: tEmbedEnd - tEmbedStart,
    embed_chunks_per_sec: embedded / ((tEmbedEnd - tEmbedStart) / 1000),
    insert_time_ms: tInsertEnd - tInsertStart,
    total_time_ms: tEnd - t0,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
