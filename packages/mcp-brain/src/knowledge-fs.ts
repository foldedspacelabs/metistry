// Filesystem semantics for agents over the vault (docs/research/2026-09-stash-review.md
// item 3): `knowledge_list` walks the tree, `knowledge_grep` searches note
// CONTENT with a regex. Both are gated by the same grant tiers as
// knowledge_search/knowledge_read (knowledge.ts) — nothing new is invented
// here, this is the same tier rule applied to a directory listing and to a
// line-oriented search instead of a title index.
//
// `knowledge_list` sources its listing from the reconciler's vault bridge
// (`GET /vault/list`, filesystem truth) and cross-references
// `knowledge_files` only to exclude known drafts and to add `title`/`updated`
// when the path is indexed — an unindexed file (not markdown, or not yet
// reconciled) still lists, since we cannot assert it is a draft.
//
// `knowledge_grep` reads settled note content via the SAME `readKnowledge`
// reader `knowledge_read` uses, so it needs the same `areas` tier (tier
// `index` has titles only, never content — same rule as knowledge_read).
// Candidates come from the bridge's own keyword search (`GET
// /vault/search?mode=keyword`) seeded with a literal substring pulled out
// of the regex — most real grep patterns contain one; when none can be
// found (a pattern of pure metacharacters), candidates fall back to a
// prefix listing instead. Either way the candidate set is capped before a
// single byte of content is read. The actual regex is then evaluated
// against each candidate's lines in a worker thread with a hard wall-clock
// timeout — the only way to interrupt Node's synchronous regex engine mid
// evaluation — so a catastrophic pattern (`(a+)+$` style) is killed rather
// than hanging the request (invariant 8: every boundary testable).

import { Worker } from "node:worker_threads";
import { z } from "zod";
import { knowledgeScope, titleSql, underAreas, type KnowledgeReader } from "./knowledge.js";
import { done, fail, type Outcome } from "./outcome.js";
import type { AgentPrincipal, Db } from "./types.js";
import type { VaultBridgeOptions } from "./knowledge-write.js";

export const KNOWLEDGE_FS_TOOL_NAMES = ["knowledge_list", "knowledge_grep"] as const;
export type KnowledgeFsToolName = (typeof KNOWLEDGE_FS_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: KnowledgeFsToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

export interface VaultListEntry {
  path: string;
  kind: "file" | "dir";
}

/** Files and directories under a prefix (the bridge's `GET /vault/list`). Absent → knowledge_list is `not_available`. */
export type KnowledgeLister = (prefix: string, depth: number) => Promise<VaultListEntry[]>;

export interface VaultKeywordHit {
  path: string;
}

/** Keyword-mode candidates from the bridge's own content search (`GET /vault/search?mode=keyword`), for knowledge_grep's pre-filter. Absent → knowledge_grep falls back to a prefix listing for candidates. */
export type KnowledgeVaultSearcher = (query: string, limit: number) => Promise<VaultKeywordHit[]>;

export interface KnowledgeFsDeps {
  db: Db;
  list?: KnowledgeLister | undefined;
  search?: KnowledgeVaultSearcher | undefined;
  /** The same reader knowledge_read uses — knowledge_grep's content source. */
  read?: KnowledgeReader | undefined;
}

const NOT_AVAILABLE_LIST = "the vault bridge's listing is not configured in this deployment (knowledge_list needs METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER, same as knowledge_read)";
const NOT_AVAILABLE_READ = "note contents are not readable from this deployment yet (knowledge_grep needs the same vault read path as knowledge_read)";

const MAX_GREP_FILES = 50;
const MAX_GREP_HITS = 200;
const GREP_TIMEOUT_MS = 1500;
const LIST_FALLBACK_DEPTH = 10;

// --- the bridge clients (mirrors knowledge-write.ts's vaultBridgeWriter) --

/** A `KnowledgeLister` over the reconciler's `GET /vault/list`. */
export function vaultBridgeLister(opts: VaultBridgeOptions): KnowledgeLister {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  const headers = { authorization: `Bearer ${opts.token}` };
  return async (prefix, depth) => {
    const url = new URL(`${base}/vault/list`);
    if (prefix) url.searchParams.set("prefix", prefix);
    url.searchParams.set("depth", String(depth));
    const r = await doFetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`vault bridge list returned ${r.status}`);
    const body = (await r.json()) as { entries?: VaultListEntry[] };
    return body.entries ?? [];
  };
}

/** A `KnowledgeVaultSearcher` over the reconciler's `GET /vault/search?mode=keyword`. */
export function vaultBridgeSearcher(opts: VaultBridgeOptions): KnowledgeVaultSearcher {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  const headers = { authorization: `Bearer ${opts.token}` };
  return async (query, limit) => {
    const url = new URL(`${base}/vault/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("mode", "keyword");
    url.searchParams.set("limit", String(limit));
    const r = await doFetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`vault bridge search returned ${r.status}`);
    const body = (await r.json()) as { hits?: VaultKeywordHit[] };
    return body.hits ?? [];
  };
}

// --- knowledge_list ---------------------------------------------------------

interface FileMeta {
  title: string | null;
  updated: string | null;
  draft: boolean;
}

/** One batched lookup for a candidate set of paths: title (falls back to basename), mtime as `updated`, and the draft flag that excludes a file everywhere. */
async function loadFileMeta(db: Db, paths: string[]): Promise<Map<string, FileMeta>> {
  const out = new Map<string, FileMeta>();
  if (paths.length === 0) return out;
  const { rows } = await db.query(`SELECT path, ${titleSql()} AS title, mtime, draft FROM knowledge_files WHERE path = ANY($1)`, [paths]);
  for (const r of rows) {
    const mtime = r.mtime as string | Date | null;
    out.set(String(r.path), {
      title: typeof r.title === "string" ? r.title : null,
      updated: mtime ? new Date(mtime).toISOString() : null,
      draft: r.draft === true,
    });
  }
  return out;
}

function registerKnowledgeList(reg: Register, deps: KnowledgeFsDeps, principal: AgentPrincipal): void {
  reg(
    "knowledge_list",
    "List files/directories under a Knowledge/ prefix, depth-limited. Tier `index` browses everything; tier `areas` is restricted to your granted prefixes. Drafts excluded.",
    { prefix: z.string().max(500).optional(), depth: z.number().int().min(1).max(5).optional() },
    async (a) => {
      const scope = knowledgeScope(principal);
      if (scope.tier === "none") return fail("forbidden", "not granted");
      if (!deps.list) return fail("not_available", NOT_AVAILABLE_LIST);
      const depth = a.depth ?? 1;

      let raw: VaultListEntry[];
      if (scope.prefixes) {
        // tier areas: an explicit prefix must fall under a granted one; an omitted prefix aggregates across all of them
        if (a.prefix !== undefined && a.prefix !== "") {
          if (!scope.canRead(a.prefix)) return fail("forbidden", "not granted");
          raw = await deps.list(a.prefix, depth);
        } else {
          const seen = new Map<string, VaultListEntry>();
          for (const area of scope.prefixes) for (const e of await deps.list(area, depth)) seen.set(e.path, e);
          raw = [...seen.values()].sort((x, y) => x.path.localeCompare(y.path));
        }
      } else {
        // tier index: same info class as knowledge_search at index tier — global, titles only, unrestricted by any prefix
        raw = await deps.list(a.prefix ?? "", depth);
      }

      const filePaths = raw.filter((e) => e.kind === "file").map((e) => e.path);
      const meta = await loadFileMeta(deps.db, filePaths);
      const entries = raw
        .filter((e) => e.kind === "dir" || meta.get(e.path)?.draft !== true)
        .map((e) => {
          const m = meta.get(e.path);
          return { path: e.path, kind: e.kind, ...(m?.title ? { title: m.title } : {}), ...(m?.updated ? { updated: m.updated } : {}) };
        });
      return done({ entries }, { tier: scope.tier, prefix: a.prefix ?? null, depth, count: entries.length });
    },
  );
}

// --- knowledge_grep ----------------------------------------------------------

/**
 * The longest run of "safe" literal characters (letters/digits/space/_/-)
 * in a regex pattern, length ≥ 3 — a heuristic seed for the bridge's
 * substring search. Regex metacharacters act as separators, so
 * `knowledge_write` (a literal call) seeds on "knowledge_write" while
 * `\d{3}-\d{4}` finds nothing and the caller falls back to listing.
 */
export function literalSeed(pattern: string): string | null {
  const runs = pattern.match(/[\p{L}\p{N} _-]{3,}/gu);
  if (!runs || runs.length === 0) return null;
  const best = runs.reduce((a, b) => (b.trim().length > a.trim().length ? b : a)).trim();
  return best.length >= 3 ? best : null;
}

async function candidateFiles(deps: KnowledgeFsDeps, scopes: readonly string[], pattern: string, cap: number): Promise<string[]> {
  const effectiveScopes = scopes.length > 0 ? scopes : [""];
  const seen = new Set<string>();

  const seed = literalSeed(pattern);
  if (seed && deps.search) {
    for (const hit of await deps.search(seed, cap * 4)) {
      if (effectiveScopes.some((scope) => scope === "" || underAreas(hit.path, [scope]))) seen.add(hit.path);
      if (seen.size >= cap) break;
    }
  }

  if (seen.size === 0 && deps.list) {
    outer: for (const scope of effectiveScopes) {
      for (const e of await deps.list(scope, LIST_FALLBACK_DEPTH)) {
        if (e.kind === "file") seen.add(e.path);
        if (seen.size >= cap) break outer;
      }
    }
  }
  return [...seen].slice(0, cap);
}

interface GrepHit {
  path: string;
  line: number;
  text: string;
}

// Runs entirely as CommonJS inside the worker (eval:true scripts are never
// ESM) — `require` and `module` are the worker runtime's own, not this
// package's. Kept deliberately tiny: split, test, collect, cap.
const GREP_WORKER_SOURCE = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  "try {",
  "  const re = new RegExp(workerData.pattern);",
  "  const hits = [];",
  "  outer: for (const [path, content] of workerData.files) {",
  "    const lines = content.split(/\\r?\\n/);",
  "    for (let i = 0; i < lines.length; i++) {",
  "      re.lastIndex = 0;",
  "      if (re.test(lines[i])) {",
  "        hits.push({ path, line: i + 1, text: lines[i].length > 300 ? lines[i].slice(0, 300) : lines[i] });",
  "        if (hits.length >= workerData.limit) break outer;",
  "      }",
  "    }",
  "  }",
  '  parentPort.postMessage({ ok: true, hits });',
  "} catch (err) {",
  '  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });',
  "}",
].join("\n");

/**
 * Evaluate `pattern` over every (path, content) pair, line by line, in a
 * worker thread — the only way to reject a catastrophically slow regex
 * without hanging the request, since V8's regex engine cannot be
 * interrupted mid-`exec` from the same thread. `timeoutMs` past, the
 * worker is killed and the call is refused as `invalid_request` rather
 * than left to hang.
 */
export function grepWithTimeout(pattern: string, files: Array<[string, string]>, limit: number, timeoutMs: number): Promise<GrepHit[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SOURCE, { eval: true, workerData: { pattern, files, limit } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("pattern took too long to evaluate (possible catastrophic backtracking) — simplify it"));
    }, timeoutMs);
    worker.once("message", (msg: { ok: true; hits: GrepHit[] } | { ok: false; error: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.hits);
      else reject(new Error(msg.error));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function registerKnowledgeGrep(reg: Register, deps: KnowledgeFsDeps, principal: AgentPrincipal): void {
  reg(
    "knowledge_grep",
    `Regex search over settled note content under your granted prefixes (requires \`areas\`, like knowledge_read; drafts excluded). Candidates are pre-filtered, capped at ${MAX_GREP_FILES} files / ${MAX_GREP_HITS} hits; an overly expensive pattern is refused, not left to hang.`,
    { pattern: z.string().min(1).max(200), prefix: z.string().max(500).optional(), limit: z.number().int().min(1).max(MAX_GREP_HITS).optional() },
    async (a) => {
      const scope = knowledgeScope(principal);
      if (scope.tier !== "areas") return fail("forbidden", "not granted");
      if (a.prefix !== undefined && a.prefix !== "" && !scope.canRead(a.prefix)) return fail("forbidden", "not granted");
      if (!deps.read) return fail("not_available", NOT_AVAILABLE_READ);

      try {
        // eslint-disable-next-line no-new
        new RegExp(a.pattern);
      } catch {
        return fail("invalid_request", "pattern is not a valid regular expression");
      }

      const scopes = a.prefix ? [a.prefix] : (scope.prefixes ?? []);
      const candidates = await candidateFiles(deps, scopes, a.pattern, MAX_GREP_FILES);
      const meta = await loadFileMeta(deps.db, candidates);
      const settled = candidates.filter((p) => meta.get(p) !== undefined && meta.get(p)!.draft !== true);

      const contents: Array<[string, string]> = [];
      for (const path of settled) {
        const content = await deps.read(path);
        if (content !== null) contents.push([path, content]);
      }

      const limit = a.limit ?? MAX_GREP_HITS;
      let hits: GrepHit[];
      try {
        hits = await grepWithTimeout(a.pattern, contents, limit, GREP_TIMEOUT_MS);
      } catch (err) {
        return fail("invalid_request", err instanceof Error ? err.message : "pattern could not be evaluated");
      }
      return done({ hits }, { tier: scope.tier, prefix: a.prefix ?? null, files: contents.length, hits: hits.length });
    },
  );
}

/** The one registration point for knowledge_list + knowledge_grep, mirroring registerArtifactTools/registerQueriesTools. */
export function registerKnowledgeFsTools(reg: Register, deps: KnowledgeFsDeps, principal: AgentPrincipal): void {
  registerKnowledgeList(reg, deps, principal);
  registerKnowledgeGrep(reg, deps, principal);
}
