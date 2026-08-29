// Shared helpers for the PoC-5 embed/rebuild/query scripts.
import { createHash } from "node:crypto";

export const OLLAMA_URL = "http://127.0.0.1:11434";
export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIM = 768;

export const PSQL = "/opt/homebrew/opt/libpq/bin/psql";
export const PG_ENV = {
  ...process.env,
  PGPASSWORD: "poc",
  PGHOST: "127.0.0.1",
  PGPORT: "5433",
  PGUSER: "postgres",
  PGDATABASE: "postgres",
};

// --- frontmatter parsing (minimal, matches gen_corpus.mjs's own format) ---
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const [, fm, body] = m;
  const meta = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map((s) => s.trim());
    }
    meta[key] = val;
  }
  return { meta, body };
}

// --- chunking: split on markdown headings first, then greedily pack
// paragraphs up to targetSize chars with a char-based overlap carried
// into the next chunk when a section itself needs splitting. ---
export function chunkMarkdown(body, { targetSize = 700, overlap = 120 } = {}) {
  const text = body.trim();
  if (text.length === 0) return [];

  // Split into paragraphs (blank-line separated), keeping heading lines
  // attached to the paragraph that follows them.
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let cur = "";
  for (const p of paras) {
    const candidate = cur ? cur + "\n\n" + p : p;
    if (candidate.length <= targetSize) {
      cur = candidate;
      continue;
    }
    // candidate too big: flush current chunk (if any), then handle p on its own
    if (cur) {
      chunks.push(cur);
      // carry a tail-overlap from the end of `cur` into the next chunk
      const tail = cur.slice(Math.max(0, cur.length - overlap));
      cur = tail;
    }
    if (p.length <= targetSize) {
      cur = cur ? cur + "\n\n" + p : p;
    } else {
      // paragraph itself exceeds target: hard-split with overlap
      let start = 0;
      while (start < p.length) {
        const end = Math.min(p.length, start + targetSize);
        const piece = p.slice(start, end);
        if (cur) {
          chunks.push(cur ? cur + "\n\n" + piece : piece);
          cur = "";
        } else {
          chunks.push(piece);
        }
        if (end === p.length) break;
        start = end - overlap;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// --- Ollama batch embedding ---
export async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.embeddings || json.embeddings.length !== texts.length) {
    throw new Error(`Ollama returned ${json.embeddings?.length} embeddings for ${texts.length} inputs`);
  }
  return json.embeddings;
}

// --- COPY text-format escaping (backslash, tab, newline, CR only) ---
export function copyEscape(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export function vectorLiteral(embedding) {
  return "[" + embedding.map((x) => (Number.isFinite(x) ? x : 0)).join(",") + "]";
}
