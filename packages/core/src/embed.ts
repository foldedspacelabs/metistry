// Embeddings (§6 decision 8): heading-aware markdown chunking and a batched
// client for a local server's OpenAI-compatible `/v1/embeddings`. Two
// consumers — the reconciler, which owns the index and embeds notes on
// reconcile, and the brain bridge, which embeds one query at search time —
// so the chunker and the wire shape live here rather than being written twice.
//
// ONE protocol (C18). This used to post Ollama's native `/api/embed`, which
// meant Ollama was the only local server that could ever embed. LM Studio,
// the bundled `llama-server` and Ollama all serve `/v1/embeddings`, so the
// embedder now speaks the same wire the rest of compute does and the choice
// of server is a URL.
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

// --- resolving WHICH local server ------------------------------------------

/** The env var that names the local OpenAI-compatible API root every local call uses. */
export const LOCAL_MODEL_URL_VAR = "METISTRY_LOCAL_MODEL_URL";
/** What it replaced. Still read, still works, warned about once at startup. */
export const OLLAMA_URL_VAR = "METISTRY_OLLAMA_URL";

export interface LocalModelUrl {
  /** the API ROOT — `…/v1`, so `${url}/embeddings` and `${url}/models` are both right */
  url: string;
  from: "env" | "alias" | "compute.yaml" | "default";
  /** the one line to log at startup when the deprecated alias was what decided it */
  warning?: string;
}

/**
 * `…/v1` with no trailing slash. An alias value that names only a HOST
 * (`http://127.0.0.1:11434`, the old `METISTRY_OLLAMA_URL` default) gets
 * `/v1` appended — the variable meant "Ollama's root" and Ollama's
 * OpenAI-compatible root is one path segment down.
 */
export function apiRootOf(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    return u.pathname === "" || u.pathname === "/" ? `${trimmed}/v1` : trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Where the local model server is, in one place and one order (C18):
 *
 *   1. `METISTRY_LOCAL_MODEL_URL` — said explicitly, so nothing else is consulted.
 *   2. `METISTRY_OLLAMA_URL` — the deprecated alias, mapped to the `/v1` root
 *      with a warning. It keeps every existing install embedding across the
 *      upgrade; it is not removed quietly, it is removed after it has said so.
 *   3. the first `on_machine` provider's `base_url` in `compute.yaml`, passed
 *      in by the caller (this module opens no file).
 *   4. `http://127.0.0.1:11434/v1` — a default Ollama, which is what the
 *      install that never configured anything already had.
 */
export function resolveLocalModelUrl(env: NodeJS.ProcessEnv, computeBaseUrl?: string | undefined): LocalModelUrl {
  const explicit = env[LOCAL_MODEL_URL_VAR]?.trim();
  if (explicit) return { url: apiRootOf(explicit), from: "env" };
  const alias = env[OLLAMA_URL_VAR]?.trim();
  if (alias) {
    const url = apiRootOf(alias);
    return {
      url,
      from: "alias",
      warning: `${OLLAMA_URL_VAR} is deprecated: embeddings now go to any local server's OpenAI-compatible /v1/embeddings, not Ollama's native /api/embed. Using ${url} — rename the variable to ${LOCAL_MODEL_URL_VAR} (docs/ops/knowledge-search.md).`,
    };
  }
  if (computeBaseUrl?.trim()) return { url: apiRootOf(computeBaseUrl.trim()), from: "compute.yaml" };
  return { url: EMBED_DEFAULT_URL, from: "default" };
}

// --- the client ------------------------------------------------------------

/** A default Ollama's OpenAI-compatible root: what an install that configured nothing already had. */
export const EMBED_DEFAULT_URL = "http://127.0.0.1:11434/v1";
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
    this.url = apiRootOf(opts.url ?? EMBED_DEFAULT_URL);
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
    const url = `${this.url}/embeddings`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
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
      throw new EmbedUnavailableError(`${url} → ${res.status}${body ? `: ${body}` : ""}`);
    }
    // OpenAI's shape: { data: [{ index, embedding }] }. `index` is honoured
    // where it is given because the spec permits any order, and a silently
    // shuffled batch would put the wrong vector on the right chunk — a
    // corruption no test of the search results would obviously catch.
    const json = (await res.json()) as { data?: unknown };
    const rows = json.data;
    if (!Array.isArray(rows) || rows.length !== input.length) {
      throw new EmbedUnavailableError(`${this.model}: expected ${input.length} embeddings, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
    }
    const vectors: unknown[] = new Array(input.length);
    rows.forEach((row, i) => {
      const r = row as { index?: unknown; embedding?: unknown } | null;
      const at = typeof r?.index === "number" && Number.isInteger(r.index) && r.index >= 0 && r.index < input.length ? r.index : i;
      vectors[at] = r?.embedding;
    });
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
