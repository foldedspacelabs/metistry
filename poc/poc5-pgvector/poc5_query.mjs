#!/usr/bin/env node
// PoC-5 retrieval SMOKE TEST -- validates embed->store->retrieve MECHANICS
// (does a query round-trip through Ollama -> pgvector and return something
// sane), NOT the plan's real quality bar ("right doc top-3 for how the user
// actually phrases it"). That bar needs a real note corpus and is deferred.
//
// 10 natural-phrasing queries against the synthetic corpus, each with a
// known expected note (chosen by the corpus author, including several where
// the expected note has a deliberate near-neighbor also in the corpus, to
// give retrieval real discrimination work). Reports top-3 hit rate as the
// smoke-test result, plus per-query latency split: embed-the-query time vs
// SQL search time.

import { execFileSync } from "node:child_process";
import { embedBatch, vectorLiteral, PSQL, PG_ENV } from "./lib.mjs";

const QUERIES = [
  {
    q: "What did I decide about the search backend for Cartograph v2?",
    expect: "proj-cartograph-v2-decision-search-backend.md",
    note: "near-neighbor: the v1 search backend decision note covers the same topic for the earlier version",
  },
  {
    q: "Why did we use plain keyword search instead of embeddings in the first version of Cartograph?",
    expect: "proj-cartograph-v1-decision-search-backend.md",
    note: "near-neighbor: the v2 decision note covers the same topic for the rebuild",
  },
  {
    q: "How much did I budget for the home office renovation and what's it broken down into?",
    expect: "proj-homeoffice-constraints-budget.md",
    note: "near-neighbor: kitchen remodel has its own budget/permit constraints note",
  },
  {
    q: "What's my emergency fund target and which account is it sitting in?",
    expect: "area-finance-emergency-fund.md",
    note: "near-neighbor: the HYS account comparison note covers the same account",
  },
  {
    q: "Which high-yield savings account did I end up picking, and why not the one with the best rate?",
    expect: "area-finance-hys-comparison.md",
    note: "near-neighbor: the emergency fund policy note references the same account",
  },
  {
    q: "What did the plumber quote for replacing the water heater, and which option did I go with?",
    expect: "proj-waterheater-decision-replace.md",
    note: "near-neighbor: the water heater reference note covers the existing unit's specs/history",
  },
  {
    q: "Why did I end up choosing Japan over Portugal for this year's big trip?",
    expect: "proj-portugal-status-booked.md",
    note: "near-neighbor: Japan's own booking-status note also covers the choice from the other side; journal-2026-06-28 also mentions it",
  },
  {
    q: "What's causing my tennis elbow and how did I treat it?",
    expect: "area-health-injury-log.md",
    note: "near-neighbor: the shoulder impingement entry sits in the same log; Dr. Chen's person note also covers the treatment",
  },
  {
    q: "What's my current strength training program and who designed it?",
    expect: "technique-progressive-overload.md",
    note: "near-neighbor: Carlos Mendoza's person note also covers the trainer relationship",
  },
  {
    q: "Why did we decide against building real-time collaborative editing into Cartograph v2?",
    expect: "proj-cartograph-v2-constraints.md",
    note: "near-neighbor: Dev Patel's person note and a journal entry both discuss the same call informally",
  },
];

const TOP_K_CHUNKS = 15; // fetch enough chunks to dedupe into a meaningful top-5 notes
const TOP_N_NOTES = 5;

function runSql(sql) {
  const out = execFileSync(PSQL, ["-t", "-A", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: PG_ENV });
  return out.toString("utf8").trim();
}

async function runQuery({ q, expect, note }) {
  const tEmbed0 = performance.now();
  const [vec] = await embedBatch([q]);
  const tEmbed1 = performance.now();

  const lit = vectorLiteral(vec);
  const sql = `SELECT path, chunk_index, embedding <=> '${lit}'::vector AS distance
               FROM poc5_embeddings
               ORDER BY embedding <=> '${lit}'::vector
               LIMIT ${TOP_K_CHUNKS};`;

  const tSql0 = performance.now();
  const raw = runSql(sql);
  const tSql1 = performance.now();

  const rows = raw.split("\n").filter(Boolean).map((line) => {
    const [path, chunkIndex, distance] = line.split("\t");
    return { path, chunkIndex: Number(chunkIndex), distance: Number(distance) };
  });

  // dedupe to best (lowest-distance) chunk per note path
  const byPath = new Map();
  for (const r of rows) {
    const existing = byPath.get(r.path);
    if (!existing || r.distance < existing.distance) byPath.set(r.path, r);
  }
  const topNotes = [...byPath.values()].sort((a, b) => a.distance - b.distance).slice(0, TOP_N_NOTES);

  const rank = topNotes.findIndex((r) => r.path === expect) + 1; // 0 if not found
  const hitTop3 = rank >= 1 && rank <= 3;

  return {
    q, expect, note,
    embed_ms: tEmbed1 - tEmbed0,
    sql_ms: tSql1 - tSql0,
    top5: topNotes.map((r) => ({ path: r.path, distance: Number(r.distance.toFixed(4)) })),
    rank: rank || null,
    hitTop3,
  };
}

async function main() {
  const results = [];
  for (const item of QUERIES) {
    const r = await runQuery(item);
    results.push(r);
    const status = r.hitTop3 ? "HIT " : "MISS";
    console.log(`[${status}] rank=${r.rank ?? ">5"}  embed=${r.embed_ms.toFixed(0)}ms sql=${r.sql_ms.toFixed(0)}ms`);
    console.log(`  Q: ${r.q}`);
    console.log(`  expected: ${r.expect}`);
    console.log(`  top5: ${r.top5.map((t) => `${t.path}(${t.distance})`).join(", ")}`);
    console.log("");
  }

  const hits = results.filter((r) => r.hitTop3).length;
  const embedTimes = results.map((r) => r.embed_ms).sort((a, b) => a - b);
  const sqlTimes = results.map((r) => r.sql_ms).sort((a, b) => a - b);
  const p50 = (arr) => arr[Math.floor(arr.length / 2)];

  console.log("=".repeat(70));
  console.log(`SMOKE TEST (mechanics only, not quality-validated): top-3 hit rate = ${hits}/${results.length}`);
  console.log(`Warm latency p50 -- embed: ${p50(embedTimes).toFixed(1)}ms, sql search: ${p50(sqlTimes).toFixed(1)}ms`);
  console.log(`Embed min/max: ${embedTimes[0].toFixed(1)}/${embedTimes[embedTimes.length - 1].toFixed(1)}ms`);
  console.log(`SQL min/max: ${sqlTimes[0].toFixed(1)}/${sqlTimes[sqlTimes.length - 1].toFixed(1)}ms`);

  console.log("\nMisses:");
  for (const r of results.filter((r) => !r.hitTop3)) {
    console.log(`  - "${r.q}" -> expected ${r.expect}, got rank ${r.rank ?? ">5"}. ${r.note}`);
  }

  console.log("\n" + JSON.stringify({
    hits, total: results.length,
    hit_rate: hits / results.length,
    embed_p50_ms: p50(embedTimes),
    sql_p50_ms: p50(sqlTimes),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
