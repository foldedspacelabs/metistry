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
// **Three more reads are the owner's alone** (design-build-plan §2.10, T1-6):
// the newest fold and its links (`knowledge_fold_latest`), the drafts waiting
// on the owner (`knowledge_drafts`) and the per-area rollup
// (`knowledge_areas`). Each is `expose: route` too, and each refuses every
// principal but the owner HERE, before any SQL runs — not only at server.ts's
// management gate — because a draft is the one thing no agent may ever be
// handed (screen 10 §3.2) and the other two name `Me/` and the owner's own
// journal, which only the owner is shown (#255). One door per operation: no
// agent reaches any of the three at `/api/q/<name>` or through `/mcp`.
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
import { canSee, filterHits, filterPages, may, readableAreas, type ErrorCode, type KnowledgeScope, type Principal } from "@foldedspacelabs/metistry-core";
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
  /** a note's git history — the reconciler's `GET /vault/log` and `GET /vault/show` (§2.21, T10-4); absent → `not_available` */
  history?: KnowledgeHistory | undefined;
}

// ----- file history (design-build-plan §2.21, T10-4) -----
//
// Git is the record (invariant 1), and the console holds no git and no
// working tree (D5, invariant 7): a note's commits and its bytes at one
// commit both come from the reconciler's bridge, read with the console's
// bearer. The bridge refuses a non-note path and a revision that is not a
// commit id by itself (`GET /vault/show`); this door refuses both again,
// first, so an owner's question never reaches the bridge in a shape it would
// refuse — and so the rule does not depend on the bridge being new enough.

/** What a commit did to the file, as the bridge reports it. */
export type KnowledgeChange = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

/** One commit as the bridge's `GET /vault/log?path=` returns it. */
export interface KnowledgeCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  source?: string | null | undefined;
  runs?: string[] | undefined;
  turns?: string[] | undefined;
  path?: string | undefined;
  change?: KnowledgeChange | undefined;
}

/** One note at one commit, as the bridge's `GET /vault/show` returns it (bytes decoded). */
export interface KnowledgeVersion extends KnowledgeCommit {
  path: string;
  content: Buffer;
  sha256: string;
  bytes: number;
}

export interface KnowledgeHistory {
  /** The file's commits, newest first, followed across renames. Throws `VaultError` with the bridge's code. */
  log(path: string, limit: number): Promise<KnowledgeCommit[]>;
  /** The file at one commit. Throws `VaultError` — `not_found` for no such commit, not on this branch, or no such file then. */
  show(path: string, sha: string): Promise<KnowledgeVersion>;
}

/** A commit id as this door takes one: hex, abbreviated or full — never a ref, `HEAD~1` or an option. The bridge's own rule (apps/reconciler/src/vault.ts `COMMIT_ID`), stated again at the first door. */
export const COMMIT_ID = /^[0-9a-fA-F]{7,64}$/;

/** A `KnowledgeHistory` over the reconciler's `GET /vault/log` and `GET /vault/show` (mirrors `vaultBridgeSearch`). */
export function vaultBridgeHistory(opts: KnowledgeBridgeOptions): KnowledgeHistory {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  const call = async (route: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(`${base}${route}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await doFetch(url, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) {
      const j = await body(r);
      throw new VaultError(codeOf(j, r.status), j?.error?.message ?? `vault bridge ${route} returned ${r.status}`);
    }
    return r.json();
  };
  return {
    async log(path, limit) {
      return ((await call("/vault/log", { path, limit: String(limit) })) as { entries: KnowledgeCommit[] }).entries;
    },
    async show(path, sha) {
      const { content_base64, ...v } = (await call("/vault/show", { path, sha })) as Omit<KnowledgeVersion, "content"> & { content_base64: string };
      return { ...v, content: Buffer.from(content_base64, "base64") };
    },
  };
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

/** The named queries behind the owner's three knowledge reads (§2.10). Not loaded → the route is `not_available` naming the file, as for the page list. */
export const KNOWLEDGE_FOLD_QUERY = "knowledge_fold_latest";
export const KNOWLEDGE_DRAFTS_QUERY = "knowledge_drafts";
export const KNOWLEDGE_AREAS_QUERY = "knowledge_areas";

/** The owner's alone: refused to every other principal by the route itself, whatever server.ts's gate did first. */
const OWNER_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/knowledge/fold",
  "GET /api/knowledge/drafts",
  "GET /api/knowledge/areas",
  // A note's history is every version of it, including the ones an edit
  // since took out — never an agent's, whatever its grants (§2.21, T10-4).
  "GET /api/knowledge/history",
  "GET /api/knowledge/version",
]);

const MAX_HISTORY_LIMIT = 200; // limit: fixed — the bridge clamps `GET /vault/log` at 200, so promising more here would be a lie
const DEFAULT_HISTORY_LIMIT = 50; // limit: fixed — a year of a busy note's acts at a glance; page by asking for more, up to the ceiling

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
 * GET /api/knowledge/fold?date=  ·  GET /api/knowledge/drafts?limit=&offset=
 * GET /api/knowledge/areas
 * GET /api/knowledge/history?path=&limit=  ·  GET /api/knowledge/version?path=&sha=
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

  // ----- the owner's alone: the fold, the drafts, the areas (T1-6), a note's history (T10-4) -----
  if (OWNER_ONLY_ROUTES.has(key)) {
    // A code path, not a sentence (U3): whoever else reached this — a gate
    // in server.ts widened by mistake, a narrower principal minted one day —
    // gets the console's uniform hidden 403, and no query runs.
    const owner = may(principal, "read", { kind: "console", door: "console_management", route: key });
    if (!owner.ok) {
      await audit("knowledge", key.slice("GET /api/knowledge/".length), false, { refused: owner.reason });
      return sendRefusal(res, owner);
    }
  }

  if (key === "GET /api/knowledge/history" || key === "GET /api/knowledge/version") {
    const op = key === "GET /api/knowledge/history" ? "history" : "version";
    const path = (url.searchParams.get("path") ?? "").trim();
    if (path === "") return sendError(res, "invalid_request", "path is required — a vault-relative path, e.g. Areas/Health/sleep.md");
    // The page route's rule, for the page's past: `.metistry/`, `Artifacts/`
    // and every other path that is not a note is refused before the bridge is
    // asked, for the owner too — the history of the machinery is the CLI's.
    const seen = may(principal, "read", { kind: "knowledge", door: "console_page", path });
    if (!seen.ok) {
      await audit("knowledge", op, false, { refused: seen.reason });
      return sendRefusal(res, seen);
    }
    if (op === "history") {
      const limit = clampHistory(url.searchParams.get("limit"));
      if (limit === undefined) return sendError(res, "invalid_request", `limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`);
      if (!deps.history) return sendError(res, "not_available", NOT_AVAILABLE);
      let entries: KnowledgeCommit[];
      try {
        entries = await deps.history.log(path, limit);
      } catch (err) {
        if (err instanceof VaultError) return sendError(res, err.code, err.message);
        throw err;
      }
      // Across a rename, a commit names the file as it was called then — the
      // name `version` needs for that commit. A name that was never a note
      // (moved in from `.metistry/`) is dropped, as any row outside the scope is.
      const commits = entries.map((e) => commitOf(e, path)).filter((c) => canSee(c.path, scope));
      await audit("knowledge", "history", true, { commits: commits.length, filtered: entries.length - commits.length });
      return sendJson(res, 200, { path, commits, limit, as_of: new Date().toISOString() });
    }
    const sha = (url.searchParams.get("sha") ?? "").trim();
    if (!COMMIT_ID.test(sha)) return sendError(res, "invalid_request", "sha must be a commit id — 7 to 64 hex characters, as GET /api/knowledge/history lists them");
    if (!deps.history) return sendError(res, "not_available", NOT_AVAILABLE);
    let v: KnowledgeVersion;
    try {
      v = await deps.history.show(path, sha);
    } catch (err) {
      if (err instanceof VaultError) return sendError(res, err.code, err.message);
      throw err;
    }
    await audit("knowledge", "version", true, { bytes: v.bytes });
    // The commit's own fields; `path` is the version's, and `change` is a
    // history row's (what the commit did to the file), not a version's.
    const { path: _p, change: _c, ...commit } = commitOf(v, path);
    return sendJson(res, 200, {
      path: v.path,
      ...commit,
      content: v.content.toString("utf8"),
      sha256: v.sha256,
      bytes: v.bytes,
      as_of: new Date().toISOString(),
    });
  }

  if (key === "GET /api/knowledge/fold") {
    const date = (url.searchParams.get("date") ?? "").trim();
    if (date !== "" && !isCalendarDay(date)) return sendError(res, "invalid_request", "date must be a calendar day, YYYY-MM-DD — omit it for the newest fold there is");
    const result = await runNamed(res, deps, KNOWLEDGE_FOLD_QUERY, { date });
    if (!result) return;
    // Rows, one per outgoing link with the fold's columns repeated (none at
    // all before the first fold): folded into one object here. The fold's
    // own path and every link target pass `canSee` like any other row — the
    // owner's scope is the whole vault, and even the owner is never handed a
    // `.metistry/` or `Artifacts/` path as a page.
    const head = filterPages(result.rows.slice(0, 1), scope)[0];
    const links = head
      ? filterPages(
          result.rows
            .filter((r) => typeof r.link_path === "string")
            .map((r) => ({ path: r.link_path, title: r.link_title, kind: r.link_kind, resolved: r.link_resolved === true })),
          scope,
        )
      : [];
    await audit("knowledge", "fold", true, { found: head !== undefined, links: links.length, ...(date ? { date } : {}) });
    return sendJson(res, 200, {
      fold: head ? { path: head.path, date: head.date, title: head.title, modified: head.modified ?? null, links } : null,
      date: date || null,
      as_of: result.as_of.toISOString(),
    });
  }

  if (key === "GET /api/knowledge/drafts") {
    const limit = clampPages(url.searchParams.get("limit"));
    if (limit === undefined) return sendError(res, "invalid_request", `limit must be an integer between 1 and ${MAX_PAGES_LIMIT}`);
    const offset = offsetOf(url.searchParams.get("offset"));
    if (offset === undefined) return sendError(res, "invalid_request", "offset must be a non-negative integer");
    const result = await runNamed(res, deps, KNOWLEDGE_DRAFTS_QUERY, { limit, offset });
    if (!result) return;
    const drafts = filterPages(result.rows, scope);
    await audit("knowledge", "drafts", true, { rows: drafts.length, filtered: result.rows.length - drafts.length });
    // No total, for the page list's reason. Page until a window comes back short.
    return sendJson(res, 200, { drafts, limit, offset, as_of: result.as_of.toISOString() });
  }

  if (key === "GET /api/knowledge/areas") {
    const result = await runNamed(res, deps, KNOWLEDGE_AREAS_QUERY, {});
    if (!result) return;
    // An area is a FOLDER, and whether a folder holds knowledge is core's
    // predicate, asked of a page inside it — the same `canSee` every row of
    // the page list passes. So an index row the walk should never have
    // written (`.metistry`, `Artifacts`) cannot become a folder on screen.
    const areas = result.rows.filter((r) => typeof r.area === "string" && r.area !== "" && canSee(`${r.area}/${AREA_INDEX}`, scope));
    await audit("knowledge", "areas", true, { rows: areas.length, filtered: result.rows.length - areas.length });
    return sendJson(res, 200, { areas, as_of: result.as_of.toISOString() });
  }

  // Anything else under /api/knowledge/.
  return sendUnrouted(
    res,
    "the knowledge read path is GET /api/knowledge/search, GET /api/knowledge/page, GET /api/knowledge/pages, GET /api/knowledge/links, GET /api/knowledge/fold, GET /api/knowledge/drafts, GET /api/knowledge/areas, GET /api/knowledge/history and GET /api/knowledge/version (docs/ops/client-api.md)",
  );
}

/**
 * One commit on the wire: the bridge's fields, named for a client — `at` is
 * the author date in UTC (the bridge hands back git's own offset form), and
 * `change` is null on a merge that carried the file without changing it.
 * `source`, `runs` and `turns` are the committer's trailers — provenance to
 * show, never authority.
 */
function commitOf(e: KnowledgeCommit, path: string) {
  const at = new Date(e.date);
  return {
    sha: e.sha,
    path: e.path ?? path,
    change: e.change ?? null,
    subject: e.subject,
    author: e.author,
    source: e.source ?? null,
    runs: e.runs ?? [],
    turns: e.turns ?? [],
    at: Number.isNaN(at.getTime()) ? e.date : at.toISOString(),
  };
}

/** History's `limit` — "learn the ceiling", as `clamp` below. */
function clampHistory(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return DEFAULT_HISTORY_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_LIMIT) return undefined;
  return n;
}

/** The page an area's description is read from (`knowledge_areas.yaml`), and the probe its folder is judged by. */
const AREA_INDEX = "README.md";

/**
 * Run one of the owner's named queries, or answer why not and return
 * undefined. Invariant 3: the ONLY thing that produces derived state here is
 * the query driver — no SQL in this file. Not loaded is the deployment's 503
 * naming the file; a param the overlay does not declare is the caller's 400;
 * neither is a 500.
 */
async function runNamed(res: ServerResponse, deps: KnowledgeDeps, name: string, params: Record<string, string | number>): Promise<Awaited<ReturnType<QueryStore["run"]>> | undefined> {
  if (!deps.queries?.names().includes(name)) {
    sendError(res, "not_available", `the named query ${name} is not loaded (seed/queries/${name}.yaml, METISTRY_QUERIES_DIRS)`);
    return undefined;
  }
  try {
    return await deps.queries.run(name, params);
  } catch (err) {
    if (err instanceof QueryError) {
      sendError(res, err.code === "unknown_query" ? "not_available" : "invalid_request", err.message);
      return undefined;
    }
    throw err;
  }
}

/** `2026-02-30` has the shape and is no day: round-trip it through the UTC calendar, which has no zone to disagree with. */
function isCalendarDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
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
