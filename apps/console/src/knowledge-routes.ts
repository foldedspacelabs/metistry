// `/api/knowledge/*` — the read path into the vault for every client
// (docs/product/app-ux-plan.md §6.1, docs/ops/knowledge-search.md).
//
// The console has held a vault reader, lister and searcher since Phase 6 and
// wired them only into `mcp-brain`'s tools, so knowledge was reachable by an
// AGENT over MCP and by nothing the owner holds — the phone could not open a
// note and the Mac app could not search one. These routes are that gap
// closed, and the two that proxy are deliberately thin: the reconciler's
// `GET /vault/search` and `GET /vault/read`, which are the bridge's already.
//
// **Invariant 3 is not bent here.** A page's BYTES and a search RANKING are
// not derived state — there is no column holding a note body, which is the
// schema enforcing the rule rather than a convention asking for it — so they
// come through the bridge. Anything countable IS derived, so the page list
// and the link graph run named queries — `seed/queries/knowledge_pages.yaml`
// and `seed/queries/knowledge_page_links.yaml` — through `packages/queries`,
// and write no SQL of their own. Four doors, two sources, and which is which
// is settled by the schema rather than by taste.
//
// Both named queries are `expose: route`: their rows carry vault paths, and
// this file is the only place a path is judged against the caller's scope, so
// the generic `/api/q/<name>` door refuses them (ruled 2026-09-19).
//
// **What the bridge does not refuse, this does.** The reconciler's
// `/vault/read` confines a path to the instance repo and stops there: it will
// happily serve `.metistry/state/.env`, `.metistry/compute.yaml` or the root
// `CLAUDE.md`, because `metistry update` and `metistry compute` write those
// files through the same bridge and a read gate would break the write path.
// Knowledge is a narrower thing than "a file in the instance repo", so the
// narrowing happens HERE, on core's `isVaultPath` — no traversal, no leading
// slash, nothing inside a dot-directory, not `Artifacts/`, not the root
// `CLAUDE.md`/`README.md`. Same predicate `mcp-brain`'s `validKnowledgePath`
// applies to agents and the indexer applies to the walk, so the three cannot
// drift.

import type { IncomingMessage, ServerResponse } from "node:http";
import { filterHits, filterPages, may, readableAreas, type ErrorCode, type KnowledgeScope, type Principal } from "@foldedspacelabs/metistry-core";
import { KNOWLEDGE_LINKS_QUERY, KNOWLEDGE_PAGES_QUERY } from "@foldedspacelabs/metistry-mcp-brain";

/**
 * **The scope rules are `core`'s** (`packages/core/src/access.ts`), since P0
 * of docs/research/2026-09-19-grants-and-access-simplified.md §4. They used to
 * live in `packages/mcp-brain`, which made one bridge's package the host of
 * the console's authorization rules (§2.9). Re-exported here because the route
 * handlers below and their callers in server.ts already name them.
 *
 * `canSee` is the predicate a LIST is filtered with (`filterHits`,
 * `filterPages`); a REFUSAL is `may()`'s, so the sentence this door gives is
 * written once, beside every other refusal, rather than here (P1).
 */
export { NO_SCOPE, OWNER_SCOPE, canSee, filterHits, filterPages, grantedScope, type KnowledgeScope } from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { QueryError, type QueryStore } from "@foldedspacelabs/metistry-queries";
import { sendError, sendJson, sendRefusal, sendUnrouted } from "./http-util.js";

export const KNOWLEDGE_MODES = ["keyword", "semantic", "hybrid"] as const;
export type KnowledgeSearchMode = (typeof KNOWLEDGE_MODES)[number];

/** One hit as the bridge ranks it — `source` is the honest provenance of a fused result, and `degraded` below is why a mode was not the one served. */
export interface KnowledgeSearchHit {
  path: string;
  title: string;
  description: string | null;
  snippet: string;
  score: number;
  source: "keyword" | "semantic" | "both";
}

export interface KnowledgeSearchResult {
  q: string;
  mode: KnowledgeSearchMode;
  hits: KnowledgeSearchHit[];
  degraded?: string;
}

/**
 * Full-result vault search with snippets, in a caller-chosen mode. Distinct
 * from `mcp-brain`'s `KnowledgeVaultSearcher`, which pins `mode=keyword` and
 * returns paths only — that one is `knowledge_grep`'s candidate pre-filter,
 * and widening it would change what a grep costs. Absent → the route answers
 * `not_available` naming the two variables.
 */
export type KnowledgeSearcher = (q: string, mode: KnowledgeSearchMode | null, limit: number) => Promise<KnowledgeSearchResult>;

export interface KnowledgeBridgeOptions {
  url: string;
  token: string;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

/** A `KnowledgeSearcher` over the reconciler's `GET /vault/search` (mirrors `vaultBridgeLister`/`vaultBridgeSearcher`). */
export function vaultBridgeSearch(opts: KnowledgeBridgeOptions): KnowledgeSearcher {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  return async (q, mode, limit) => {
    const url = new URL(`${base}/vault/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));
    // No `mode` at all means "choose for me" at the bridge (hybrid when
    // vectors exist, keyword otherwise) — not a default invented here.
    if (mode) url.searchParams.set("mode", mode);
    const r = await doFetch(url, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new VaultError(codeOf(await body(r), r.status), `vault bridge search returned ${r.status}`);
    return (await r.json()) as KnowledgeSearchResult;
  };
}

async function body(r: Response): Promise<{ error?: { code?: string; message?: string } } | null> {
  try {
    return (await r.json()) as { error?: { code?: string; message?: string } };
  } catch {
    return null;
  }
}

const CODES: ReadonlySet<string> = new Set(["unauthenticated", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "not_available", "internal"]);

/** The bridge's envelope code, or `not_available` — a bridge that cannot answer is a dependency being down, not the caller's mistake. */
function codeOf(j: { error?: { code?: string } } | null, _status: number): ErrorCode {
  const code = j?.error?.code;
  return code && CODES.has(code) ? (code as ErrorCode) : "not_available";
}

export interface KnowledgeDeps {
  /** the reconciler's `/vault/search`; absent → `not_available` */
  search?: KnowledgeSearcher | undefined;
  /** the same vault client the artifacts module stores through — `/vault/read`; absent → `not_available` */
  vault?: VaultClient | undefined;
  /** the console's own QueryStore — invariant 3's ONE read path into derived state, for `GET /api/knowledge/pages` and `GET /api/knowledge/links`; without the named query loaded, the route answers `not_available` naming the file */
  queries?: QueryStore | undefined;
}

const NOT_AVAILABLE =
  "the vault bridge is not configured in this deployment — set METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)";

const MAX_LIMIT = 100; // limit: fixed — the bridge clamps at 100 with no offset and no cursor, so promising more here would be a lie (docs/product/app-ux-plan.md §6.1)
const DEFAULT_LIMIT = 20; // limit: fixed — the bridge's own default, so an omitted `limit` means the same thing on both doors
const MAX_QUERY = 200; // limit: fixed — the bridge refuses a longer `q`; refusing it here names the parameter instead of relaying a 400

/**
 * The named queries `GET /api/knowledge/pages` and `GET /api/knowledge/links`
 * are. Not loaded → the route is `not_available` naming the file, never a 500
 * and never a hand-written SELECT.
 *
 * Re-exported rather than spelled again: `mcp-brain`'s `knowledge_list` runs
 * the SAME two queries for an agent under the same filter, and two string
 * literals in two packages is two places for an overlay's name to be wrong.
 */
export { KNOWLEDGE_PAGES_QUERY, KNOWLEDGE_LINKS_QUERY } from "@foldedspacelabs/metistry-mcp-brain";

const MAX_PAGES_LIMIT = 500; // limit: fixed — a LIST out of the index is scalar columns over an indexed key, so it is not the bridge's 100; 500 rows is one screenful of scrolling and bounds the response a phone has to parse. Shared by the page list and the link list, which page the same way
const DEFAULT_PAGES_LIMIT = 100; // limit: fixed — the default `knowledge_pages.yaml` and `knowledge_page_links.yaml` both declare, so an omitted `limit` means the same thing on the route and in the manifest
const MAX_FILTER = 500; // limit: fixed — `canSee` refuses a path over 500 characters, so a filter longer than one cannot select anything a client may see

/**
 * Everything under the prefix, the bare prefix included. Used by server.ts's
 * management gate, so a non-`user` credential gets the canonical 403 on the
 * whole family rather than a 403 on some paths and a 404 on others — a
 * difference that would say which spellings this build knows.
 */
export function isKnowledgeRoute(pathname: string): boolean {
  return pathname === "/api/knowledge" || pathname.startsWith("/api/knowledge/");
}

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

/**
 * GET /api/knowledge/search?q=&mode=&limit=  ·  GET /api/knowledge/page?path=
 * GET /api/knowledge/pages?area=&prefix=&limit=&offset=
 * GET /api/knowledge/links?path=&limit=&offset=
 *
 * server.ts has already established the principal; `scope` is what that
 * principal may see. Not streamed — the bridge's hit list is bounded at 100,
 * a page is one file, and the list is one bounded window of an index.
 */
export async function knowledgeRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  key: string,
  url: URL,
  deps: KnowledgeDeps,
  principal: Principal,
  audit: Audit,
): Promise<void> {
  // Two different questions off one principal, and keeping them apart is the
  // point. `scope` is what a LIST may show — the areas whose CONTENT this
  // credential may read, `null` for the owner — and it filters rows. `may()`
  // is what a single path gets, and since P4 the owner's answer there is
  // never a narrower scope: it is `ok`, or a classification naming the door
  // that has the bytes.
  const scope: KnowledgeScope = { areas: readableAreas(principal.scope) };
  if (key === "GET /api/knowledge/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q === "") return sendError(res, "invalid_request", "q is required — the text to search for");
    if (q.length > MAX_QUERY) return sendError(res, "invalid_request", `q must be ${MAX_QUERY} characters or fewer`);
    const rawMode = url.searchParams.get("mode");
    if (rawMode !== null && rawMode !== "" && !(KNOWLEDGE_MODES as readonly string[]).includes(rawMode)) {
      return sendError(res, "invalid_request", `mode must be one of ${KNOWLEDGE_MODES.join(" | ")} — omit it and the bridge chooses (hybrid where vectors exist, keyword otherwise)`);
    }
    const limit = clamp(url.searchParams.get("limit"));
    if (limit === undefined) return sendError(res, "invalid_request", `limit must be an integer between 1 and ${MAX_LIMIT}`);
    if (!deps.search) return sendError(res, "not_available", NOT_AVAILABLE);

    let result: KnowledgeSearchResult;
    try {
      result = await deps.search(q, rawMode ? (rawMode as KnowledgeSearchMode) : null, limit);
    } catch (err) {
      if (err instanceof VaultError) return sendError(res, err.code, err.message);
      throw err;
    }
    const hits = filterHits(result.hits ?? [], scope);
    await audit("knowledge", "search", true, { mode: result.mode, hits: hits.length, filtered: (result.hits?.length ?? 0) - hits.length, ...(result.degraded ? { degraded: result.degraded } : {}) });
    // `degraded` reaches the client rather than being swallowed (P5): "keyword
    // only — the embedder is down" is a fact the UI states, not an error.
    return sendJson(res, 200, {
      q: result.q ?? q,
      mode: result.mode,
      hits,
      degraded: result.degraded ?? null,
      as_of: new Date().toISOString(),
    });
  }

  if (key === "GET /api/knowledge/page") {
    const path = (url.searchParams.get("path") ?? "").trim();
    if (path === "") return sendError(res, "invalid_request", "path is required — a vault-relative path, e.g. Areas/Health/sleep.md");
    // Refused and NOT FOUND are the same answer on purpose, and `may` is
    // where that is written down: a path outside the scope must not be
    // distinguishable from a path that is not there, or the route is an
    // oracle for what exists where the caller cannot look.
    const seen = may(principal, "read", { kind: "knowledge", door: "console_page", path });
    if (!seen.ok) {
      await audit("knowledge", "page", false, { refused: seen.reason });
      return sendRefusal(res, seen);
    }
    if (!deps.vault) return sendError(res, "not_available", NOT_AVAILABLE);

    let page: Awaited<ReturnType<VaultClient["read"]>>;
    try {
      page = await deps.vault.read(path);
    } catch (err) {
      if (err instanceof VaultError) return sendError(res, err.code, err.message);
      throw err;
    }
    if (!page) return sendError(res, "not_found", "no such page");
    await audit("knowledge", "page", true, { bytes: page.bytes });
    return sendJson(res, 200, {
      path: page.path,
      content: page.content.toString("utf8"),
      sha256: page.sha256,
      bytes: page.bytes,
      as_of: new Date().toISOString(),
    });
  }

  if (key === "GET /api/knowledge/pages") {
    const area = (url.searchParams.get("area") ?? "").trim();
    const prefix = (url.searchParams.get("prefix") ?? "").trim();
    for (const [name, value] of [
      ["area", area],
      ["prefix", prefix],
    ] as const) {
      // Shape only. What a filter may SELECT is decided below by `canSee` on
      // each row, not here on the argument — a filter pointing outside the
      // scope must come back empty rather than refused, or the 400 tells the
      // caller which prefixes exist.
      if (value.length > MAX_FILTER) return sendError(res, "invalid_request", `${name} must be ${MAX_FILTER} characters or fewer`);
      if (/[\0\\]/.test(value)) return sendError(res, "invalid_request", `${name} must be a vault path prefix — no backslashes, no NULs (docs/ops/instance-layout.md)`);
    }
    const limit = clampPages(url.searchParams.get("limit"));
    if (limit === undefined) return sendError(res, "invalid_request", `limit must be an integer between 1 and ${MAX_PAGES_LIMIT}`);
    const offset = offsetOf(url.searchParams.get("offset"));
    if (offset === undefined) return sendError(res, "invalid_request", "offset must be a non-negative integer");
    // Invariant 3: the list is derived state, so the ONLY thing that may
    // produce it is the query driver running a named query. No SQL here.
    if (!deps.queries?.names().includes(KNOWLEDGE_PAGES_QUERY)) {
      return sendError(res, "not_available", `the named query ${KNOWLEDGE_PAGES_QUERY} is not loaded (seed/queries/${KNOWLEDGE_PAGES_QUERY}.yaml, METISTRY_QUERIES_DIRS)`);
    }

    let result: Awaited<ReturnType<QueryStore["run"]>>;
    try {
      result = await deps.queries.run(KNOWLEDGE_PAGES_QUERY, { area, prefix, limit, offset });
    } catch (err) {
      // A param the overlay's own spelling of the query does not declare is
      // the caller's 400; a query that vanished between the check and the run
      // is the deployment's 503. Neither is a 500.
      if (err instanceof QueryError) return sendError(res, err.code === "unknown_query" ? "not_available" : "invalid_request", err.message);
      throw err;
    }
    const pages = filterPages(result.rows, scope);
    await audit("knowledge", "pages", true, { rows: pages.length, filtered: result.rows.length - pages.length, ...(area ? { area } : {}), ...(prefix ? { prefix } : {}) });
    // The filters are echoed (the search route echoes `q` the same way) and
    // there is NO total: a count over the unscoped filter is the directory
    // listing of what was filtered that `filterPages` exists to withhold.
    // Page until a window comes back shorter than `limit`.
    return sendJson(res, 200, {
      pages,
      area: area || null,
      prefix: prefix || null,
      limit,
      offset,
      as_of: result.as_of.toISOString(),
    });
  }

  if (key === "GET /api/knowledge/links") {
    const path = (url.searchParams.get("path") ?? "").trim();
    if (path === "") return sendError(res, "invalid_request", "path is required — the page whose links you want, e.g. Areas/Health/sleep.md");
    // BOTH ends of every link have to pass the scope, and this is the first
    // end: the page being asked about. Refused and absent are the same answer
    // here, exactly as on `GET /api/knowledge/page` — "which pages link to
    // this" must not be answerable for a page the caller cannot see, and the
    // honest description of `.metistry/compute.yaml` is still "not
    // knowledge", for the owner too.
    const seen = may(principal, "read", { kind: "knowledge", door: "console_page", path });
    if (!seen.ok) {
      await audit("knowledge", "links", false, { refused: seen.reason });
      return sendRefusal(res, seen);
    }
    const limit = clampPages(url.searchParams.get("limit"));
    if (limit === undefined) return sendError(res, "invalid_request", `limit must be an integer between 1 and ${MAX_PAGES_LIMIT}`);
    const offset = offsetOf(url.searchParams.get("offset"));
    if (offset === undefined) return sendError(res, "invalid_request", "offset must be a non-negative integer");
    // Invariant 3 again: the graph is derived state — the reconciler parses
    // it out of the notes on every walk — so the only thing that may produce
    // it is the query driver running a named query. No SQL here.
    if (!deps.queries?.names().includes(KNOWLEDGE_LINKS_QUERY)) {
      return sendError(res, "not_available", `the named query ${KNOWLEDGE_LINKS_QUERY} is not loaded (seed/queries/${KNOWLEDGE_LINKS_QUERY}.yaml, METISTRY_QUERIES_DIRS)`);
    }

    let result: Awaited<ReturnType<QueryStore["run"]>>;
    try {
      result = await deps.queries.run(KNOWLEDGE_LINKS_QUERY, { path, limit, offset });
    } catch (err) {
      if (err instanceof QueryError) return sendError(res, err.code === "unknown_query" ? "not_available" : "invalid_request", err.message);
      throw err;
    }
    // …and the second end: every row's `path` is the OTHER side of an edge,
    // judged by the same predicate the page list uses. A link the scope does
    // not cover is dropped, so a backlink cannot report the existence of a
    // note in an area the caller was never granted.
    const links = filterPages(result.rows, scope);
    await audit("knowledge", "links", true, { links: links.length, filtered: result.rows.length - links.length });
    // `path` is echoed the way the search route echoes `q`, and there is NO
    // total, for the reason the page list has none: a count over the
    // unfiltered edges is the size of what was withheld. Page until a window
    // comes back shorter than `limit`.
    return sendJson(res, 200, {
      path,
      links,
      limit,
      offset,
      as_of: result.as_of.toISOString(),
    });
  }

  // Anything else under /api/knowledge/.
  return sendUnrouted(
    res,
    "the knowledge read path is GET /api/knowledge/search, GET /api/knowledge/page, GET /api/knowledge/pages and GET /api/knowledge/links (docs/ops/client-api.md)",
  );
}

/** `limit`, or undefined when it is not an integer in range — never silently clamped, because a client that asked for 500 should learn the ceiling. */
function clamp(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return undefined;
  return n;
}

/** The page list's own `limit` — the same "learn the ceiling" rule against a ceiling that is this route's rather than the bridge's. */
function clampPages(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return DEFAULT_PAGES_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES_LIMIT) return undefined;
  return n;
}

/** `offset`, or undefined when it is not a non-negative safe integer. Unbounded above on purpose: the window is bounded by `limit`, and a far offset costs the index a scan, not the caller a promise. */
function offsetOf(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  return n;
}
