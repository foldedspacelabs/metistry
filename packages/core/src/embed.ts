// Embeddings (§6 decision 8): heading-aware markdown chunking and a batched
// client for a local Ollama `/api/embed`. Two consumers — the reconciler,
// which owns the index and embeds notes on reconcile, and the brain bridge,
// which embeds one query at search time — so the chunker and the wire shape
// live here rather than being written twice.
//
// The model and its dimension travel with every row (`embeddings.model`,
// `embeddings.dim`) so the choice stays reversible: changing the model is a
// full re-embed, not a data loss. PoC-5 measured that at ~125 chunks/sec.

/** One chunk of a note, ready to embed. `index` is stable for identical input. */
export interface Chunk {
  index: number;
  /** Heading breadcrumb ("Sleep > Protocol"), or null for text above the first heading. */
  heading: string | null;
  /** What gets embedded and stored: the breadcrumb (when there is one) then the body. */
  text: string;
}

export interface ChunkOptions {
  /** Target chunk size in characters (~4 chars/token; the default is ~500 tokens). */
  targetChars?: number | undefined;
  /** Characters carried from the tail of one chunk into the next (~50 tokens). */
  overlapChars?: number | undefined;
}

export const CHUNK_TARGET_CHARS = 2000;
export const CHUNK_OVERLAP_CHARS = 200;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface Section {
  heading: string | null;
  body: string;
}

/**
 * Split on markdown headings first (fenced code is not scanned for them),
 * then pack paragraphs up to `targetChars`, carrying an overlap tail when a
 * section spills. Each chunk is prefixed with its heading breadcrumb so a
 * chunk retrieved alone still says where it came from.
 */
export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): Chunk[] {
  const target = Math.max(200, opts.targetChars ?? CHUNK_TARGET_CHARS);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? CHUNK_OVERLAP_CHARS, Math.floor(target / 2)));
  const out: Chunk[] = [];
  for (const section of splitSections(markdown)) {
    const prefix = section.heading ? `${section.heading}\n\n` : "";
    const room = Math.max(120, target - prefix.length);
    for (const piece of packParagraphs(section.body, room, overlap)) {
      out.push({ index: out.length, heading: section.heading, text: prefix + piece });
    }
  }
  return out;
}

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let heading: string | null = null;
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ heading, body });
    buf = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (line.trim().startsWith(fence)) fence = null;
      buf.push(line);
      continue;
    }
    if (fence !== null) {
      buf.push(line);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (!h) {
      buf.push(line);
      continue;
    }
    flush();
    const level = h[1]!.length;
    const text = h[2]!.trim();
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text });
    heading = stack.map((s) => s.text).join(" > ");
  }
  flush();
  return sections;
}

/** Greedy paragraph packing with a character overlap; oversize paragraphs hard-split. */
function packParagraphs(body: string, target: number, overlap: number): string[] {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (!cur.trim()) {
      cur = "";
      return;
    }
    chunks.push(cur.trim());
    cur = overlap > 0 ? tailOf(cur, overlap) : "";
  };
  for (const p of paras) {
    if (cur && cur.length + 2 + p.length > target) flush();
    if (p.length <= target) {
      cur = cur ? `${cur}\n\n${p}` : p;
      continue;
    }
    // paragraph longer than a whole chunk: hard-split it, keeping the overlap
    let start = 0;
    while (start < p.length) {
      const room = cur ? Math.max(1, target - cur.length - 2) : target;
      const end = Math.min(p.length, start + room);
      const piece = p.slice(start, end);
      cur = cur ? `${cur}\n\n${piece}` : piece;
      if (end >= p.length) break;
      flush();
      start = Math.max(end - overlap, start + 1);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/** The last `n` characters, snapped forward to a word boundary when there is one. */
function tailOf(s: string, n: number): string {
  const tail = s.slice(Math.max(0, s.length - n));
  const cut = tail.search(/\s/);
  return (cut > 0 && cut < 40 ? tail.slice(cut + 1) : tail).trimStart();
}

// --- the Ollama client ----------------------------------------------------

export const EMBED_DEFAULT_URL = "http://127.0.0.1:11434";
export const EMBED_DEFAULT_MODEL = "nomic-embed-text";
export const EMBED_DEFAULT_DIM = 768;
export const EMBED_DEFAULT_BATCH = 16;

/** The embedder is not answering. Callers degrade; they never fail the cycle. */
export class EmbedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedUnavailableError";
  }
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface EmbedClientOptions {
  url?: string | undefined;
  model?: string | undefined;
  dim?: number | undefined;
  batch?: number | undefined;
  timeoutMs?: number | undefined;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike | undefined;
}

export class EmbedClient {
  readonly url: string;
  readonly model: string;
  readonly dim: number;
  readonly batch: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: EmbedClientOptions = {}) {
    this.url = (opts.url ?? EMBED_DEFAULT_URL).replace(/\/+$/, "");
    this.model = opts.model ?? EMBED_DEFAULT_MODEL;
    this.dim = opts.dim ?? EMBED_DEFAULT_DIM;
    this.batch = Math.max(1, opts.batch ?? EMBED_DEFAULT_BATCH);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>);
  }

  /** Embed many texts, `batch` per request. Order is preserved. */
  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      out.push(...(await this.post(texts.slice(i, i + this.batch))));
    }
    return out;
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.post([text]);
    if (!v) throw new EmbedUnavailableError(`${this.model}: no embedding returned`);
    return v;
  }

  private async post(input: readonly string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: [...input] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new EmbedUnavailableError(`${this.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new EmbedUnavailableError(`${this.url}/api/embed → ${res.status}${body ? `: ${body}` : ""}`);
    }
    const json = (await res.json()) as { embeddings?: unknown };
    const vectors = json.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== input.length) {
      throw new EmbedUnavailableError(`${this.model}: expected ${input.length} embeddings, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`);
    }
    return vectors.map((v) => {
      if (!Array.isArray(v) || v.length !== this.dim || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
        throw new EmbedUnavailableError(`${this.model}: expected ${this.dim}-dimension vectors, got ${Array.isArray(v) ? v.length : typeof v}`);
      }
      return v as number[];
    });
  }
}

/** pgvector's literal form. Never interpolate anything else into SQL. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}
