// Filesystem semantics for agents over the vault (docs/research/2026-09-stash-review.md
// item 3): `knowledge_list` walks the tree, `knowledge_grep` searches note
// CONTENT with a regex. Both are gated by the same grant tiers as
// knowledge_search/knowledge_read (knowledge.ts) — nothing new is invented
// here, this is the same tier rule applied to a directory listing and to a
// line-oriented search instead of a title index.
//
// `knowledge_list` sources its listing from the reconciler's vault bridge
// (`GET /vault/list`, filesystem truth) and cross-references
// `knowledge_files` only to exclude known drafts and to add
// `title`/`description`/`updated` when the path is indexed — an unindexed
// file (not markdown, or not yet reconciled) still lists, since we cannot
// assert it is a draft. Where no bridge is configured the listing comes from
// the reconciler's INDEX instead of being refused: the named query
// `knowledge_pages`, run through `packages/queries` (invariant 3), which is
// the same query and the same rows `GET /api/knowledge/pages` serves the
// owner. Either way every entry passes `scope.canList`.
//
// **Every path on this surface is judged by ONE function** — `canSeeUnder`
// (knowledge.ts), which `apps/console/src/knowledge-routes.ts`'s `canSee`
// also calls. Before 2026-09-19 the console filtered its page list and its
// link graph and `/mcp` filtered neither, because `queries_run` would run
// `knowledge_pages` for any holder of a `queries: true` grant, tier `none`
// included. That door is closed (queries-tools.ts) and this is the scoped
// one that replaces it: `links_for` runs `knowledge_page_links` through the
// same store and filters BOTH ends of every edge, exactly as the route does.
//
// The two tiers are deliberately different widths here. Tier `index` lists
// TITLES anywhere in the vault index — that is the discovery the tier is
// for: an agent finds out that `Areas/Health/sleep.md` exists so it can ask
// the owner for the area that holds it, and can read none of it. Tier
// `areas` lists, reads and traverses links within its prefixes and nowhere
// else. Tier `none` gets nothing, and is told "not granted" rather than
// "not found" — absence of permission must not look like absence of
// knowledge.
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
import { QueryError, type QueryStore } from "@foldedspacelabs/metistry-queries";
import { isSettledPage, knowledgeScope, scopeRequired, titleSql, underAreas, type KnowledgeReader, type KnowledgeScope } from "./knowledge.js";
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

/** Files and directories under a prefix (the bridge's `GET /vault/list`). Absent → knowledge_list answers from the reconciler's index instead (`knowledge_pages`), and only refuses when that query is not loaded either. */
export type KnowledgeLister = (prefix: string, depth: number) => Promise<VaultListEntry[]>;

/** A listing row on its way out: the bridge's tree entry, or an index page, carrying whatever discovery metadata its source knows. Never content, at any tier. */
type ListEntry = VaultListEntry & { title?: string | undefined; description?: string | undefined };

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
  /** Invariant 3's one read path — the SAME `QueryStore` the console's `/api/knowledge/pages` and `/api/knowledge/links` run through, so a listing an agent gets and a listing the owner gets come from one query. Absent → `knowledge_list` falls back to the bridge alone and `links_for` is `not_available`. */
  queries?: QueryStore | undefined;
}

/**
 * The named query the page LIST is, on every door (`seed/queries/knowledge_pages.yaml`).
 *
 * `expose: route`, which is why the name is a constant somewhere a scoped
 * caller can reach rather than a string an agent may pass to `queries_run`:
 * the generic door refuses it, and this is one of the two surfaces that may
 * run it — after `canSeeUnder` has judged every row it returns.
 */
export const KNOWLEDGE_PAGES_QUERY = "knowledge_pages";

/** The named query the LINK graph is (`seed/queries/knowledge_page_links.yaml`). Same `expose: route` rule, same reason: every row's `path` is the other end of an edge and has to be judged before it travels. */
export const KNOWLEDGE_LINKS_QUERY = "knowledge_page_links";

const NOT_AVAILABLE_LIST = "the vault bridge's listing is not configured in this deployment (knowledge_list needs METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER, same as knowledge_read)";
const NOT_AVAILABLE_READ = "note contents are not readable from this deployment yet (knowledge_grep needs the same vault read path as knowledge_read)";
const notLoaded = (name: string) => `the named query ${name} is not loaded (seed/queries/${name}.yaml, METISTRY_QUERIES_DIRS)`;

/** Refusal wording for every tier gate here — unchanged, and deliberately not "not found": absence of permission must not look like absence of knowledge. How to get more is in the tool description, not appended to every refusal. */
const NOT_GRANTED = "not granted";

const MAX_INDEX_ROWS = 500; // limit: fixed — the ceiling `apps/console/src/knowledge-routes.ts` puts on the same two queries, so an agent's window and the owner's are the same size

const MAX_GREP_FILES = 50;  // limit: fixed — named in knowledge_grep's own description, so it is contract the model reads
const MAX_GREP_HITS = 200;  // limit: fixed — same — it is the input schema's .max() as well
const GREP_TIMEOUT_MS = 1500;  // limit: fixed — refusing an expensive pattern is the behaviour; a tunable one would defeat it
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
  description: string | null;
  updated: string | null;
  draft: boolean;
}

/** One batched lookup for a candidate set of paths: title (falls back to basename), the one-line description discovery runs on, mtime as `updated`, and the draft flag that excludes a file everywhere. */
async function loadFileMeta(db: Db, paths: string[]): Promise<Map<string, FileMeta>> {
  const out = new Map<string, FileMeta>();
  if (paths.length === 0) return out;
  const { rows } = await db.query(`SELECT path, ${titleSql()} AS title, description, mtime, draft FROM knowledge_files WHERE path = ANY($1)`, [paths]);
  for (const r of rows) {
    const mtime = r.mtime as string | Date | null;
    out.set(String(r.path), {
      title: typeof r.title === "string" ? r.title : null,
      description: typeof r.description === "string" ? r.description : null,
      updated: mtime ? new Date(mtime).toISOString() : null,
      draft: r.draft === true,
    });
  }
  return out;
}

/** `QueryError` → the uniform envelope, the same mapping the console's knowledge routes make: a param the instance's own spelling of the query does not declare is the caller's mistake; a query that vanished between the check and the run is the deployment's. Never a 500. */
function fromQueryError(err: unknown): Outcome {
  if (err instanceof QueryError) return fail(err.code === "unknown_query" ? "not_available" : "invalid_request", err.message);
  throw err;
}

/**
 * The page list out of the reconciler's INDEX, for a deployment with no
 * vault bridge: the same named query, run through the same driver, that
 * `GET /api/knowledge/pages` serves the owner. Rows come back as list
 * entries (`kind: "file"`, since the index holds pages and not directories)
 * carrying path, title and one-line description — the discovery contract,
 * and never a byte of content.
 *
 * Tier `areas` runs it once per granted prefix and merges, the way the
 * bridge branch aggregates across areas; tier `index` runs it once,
 * unrestricted. `scope.canList` judges every row either way — the query's
 * own `prefix` is an optimisation, never the security boundary.
 */
async function indexEntries(deps: KnowledgeFsDeps, scope: KnowledgeScope, prefix: string): Promise<Outcome | ListEntry[]> {
  const store = deps.queries;
  if (!store?.names().includes(KNOWLEDGE_PAGES_QUERY)) return fail("not_available", `${NOT_AVAILABLE_LIST}; ${notLoaded(KNOWLEDGE_PAGES_QUERY)}`);
  const prefixes = prefix !== "" ? [prefix] : (scope.prefixes ?? [""]);
  const seen = new Map<string, ListEntry>();
  for (const p of prefixes) {
    let rows: Record<string, unknown>[];
    try {
      rows = (await store.run(KNOWLEDGE_PAGES_QUERY, { area: "", prefix: p, limit: MAX_INDEX_ROWS, offset: 0 })).rows;
    } catch (err) {
      return fromQueryError(err);
    }
    for (const r of rows) {
      if (typeof r.path !== "string" || !scope.canList(r.path)) continue;
      seen.set(r.path, {
        path: r.path,
        kind: "file",
        ...(typeof r.title === "string" && r.title ? { title: r.title } : {}),
        ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
      });
    }
  }
  return [...seen.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * One page's links, both directions, out of the `knowledge_page_links` named
 * query — the rows `GET /api/knowledge/links` serves the owner, through the
 * same driver and the same filter.
 *
 * **Both ends are scoped, and that is the whole of it.** The page asked
 * about has to be one this principal may READ (tier `areas` under a granted
 * prefix), because "this page has four backlinks" is a fact about that page;
 * and every row's `path` is the OTHER end of an edge, judged by the same
 * predicate, so a backlink can never report that a note exists in an area
 * the caller was never granted. Rows that do not pass are DROPPED rather
 * than flagged, and no total is published, for the reason the route
 * publishes none: a count over the unfiltered edges is the size of what was
 * withheld.
 *
 * Rows travel unprojected — an instance may overlay the query with columns
 * of its own (D4) and a projection here would swallow them — so the one
 * thing this insists on is a `path` it can judge.
 */
async function listLinks(deps: KnowledgeFsDeps, scope: KnowledgeScope, path: string): Promise<Outcome> {
  if (!scope.canRead(path)) {
    // The same scope_required rule knowledge_read applies (knowledge.ts):
    // a page's edges are content, but a caller who may already see the
    // page's TITLE is told which grant would let it traverse them, rather
    // than the bare string — and only for a page that is really there.
    if (scope.canList(path) && (await isSettledPage(deps.db, path))) {
      const sr = scopeRequired(path);
      return fail("forbidden", sr.message, { tier: scope.tier, areas: scope.prefixes ?? [], links_for: path }, sr.expose);
    }
    return fail("forbidden", NOT_GRANTED, { tier: scope.tier, areas: scope.prefixes ?? [], links_for: path });
  }
  const store = deps.queries;
  if (!store?.names().includes(KNOWLEDGE_LINKS_QUERY)) return fail("not_available", notLoaded(KNOWLEDGE_LINKS_QUERY));
  let rows: Record<string, unknown>[];
  try {
    rows = (await store.run(KNOWLEDGE_LINKS_QUERY, { path, limit: MAX_INDEX_ROWS, offset: 0 })).rows;
  } catch (err) {
    return fromQueryError(err);
  }
  const links = rows.filter((r) => typeof r.path === "string" && scope.canRead(r.path));
  return done({ path, links }, { tier: scope.tier, links_for: path, links: links.length, filtered: rows.length - links.length });
}

function registerKnowledgeList(reg: Register, deps: KnowledgeFsDeps, principal: AgentPrincipal): void {
  reg(
    "knowledge_list",
    "List a vault prefix, depth-limited: path, title, description — never content. Tier `index` browses every title; tier `areas` only its granted prefixes (ask the owner to widen them). `links_for` lists that page's links instead (`areas`). Drafts excluded.",
    { prefix: z.string().max(500).optional(), depth: z.number().int().min(1).max(5).optional(), links_for: z.string().max(500).optional() },
    async (a) => {
      const scope = knowledgeScope(principal);
      if (scope.tier === "none") return fail("forbidden", NOT_GRANTED);
      // `links_for` is the graph rather than the tree: a different named
      // query, the same scope function, and a tier `areas` gate because a
      // page's edges are a fact about the page (knowledge_read's rule).
      if (a.links_for !== undefined && a.links_for !== "") return listLinks(deps, scope, a.links_for);
      const depth = a.depth ?? 1;
      const prefix = a.prefix ?? "";
      // tier areas: an explicit prefix must fall under a granted one, on
      // either source. An omitted prefix aggregates across all of them.
      if (scope.prefixes && prefix !== "" && !scope.canRead(prefix)) return fail("forbidden", NOT_GRANTED);

      let raw: ListEntry[];
      if (!deps.list) {
        // No vault bridge: the index answers instead of the tool refusing —
        // a page list is derived state, so invariant 3's driver has it.
        const indexed = await indexEntries(deps, scope, prefix);
        if (!Array.isArray(indexed)) return indexed;
        raw = indexed;
      } else if (scope.prefixes) {
        if (prefix !== "") {
          raw = await deps.list(prefix, depth);
        } else {
          const seen = new Map<string, ListEntry>();
          for (const area of scope.prefixes) for (const e of await deps.list(area, depth)) seen.set(e.path, e);
          raw = [...seen.values()].sort((x, y) => x.path.localeCompare(y.path));
        }
      } else {
        // tier index: same info class as knowledge_search at index tier — global, titles only, unrestricted by any prefix
        raw = await deps.list(prefix, depth);
      }

      const filePaths = raw.filter((e) => e.kind === "file").map((e) => e.path);
      const meta = await loadFileMeta(deps.db, filePaths);
      const entries = raw
        // The vault-path rule, on every entry, from the one function the
        // console's routes use: the bridge's `/vault/list` confines to the
        // instance repo and stops there, so without this a tier `index`
        // browse of the root would list `.metistry/`, `.obsidian/`,
        // `Artifacts/` and the root `CLAUDE.md` — machinery, not knowledge,
        // and not knowledge for the owner either.
        .filter((e) => scope.canList(e.path))
        .filter((e) => e.kind === "dir" || meta.get(e.path)?.draft !== true)
        .map((e) => {
          const m = meta.get(e.path);
          const title = m?.title ?? e.title;
          const description = m?.description ?? e.description;
          return { path: e.path, kind: e.kind, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(m?.updated ? { updated: m.updated } : {}) };
        });
      return done({ entries }, { tier: scope.tier, prefix: a.prefix ?? null, depth, count: entries.length, source: deps.list ? "vault" : "index" });
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
