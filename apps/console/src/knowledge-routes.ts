// `/api/knowledge/*` — the read path into the vault for every client
// (docs/product/app-ux-plan.md §6.1, docs/ops/knowledge-search.md).
//
// The console has held a vault reader, lister and searcher since Phase 6 and
// wired them only into `mcp-brain`'s tools, so knowledge was reachable by an
// AGENT over MCP and by nothing the owner holds — the phone could not open a
// note and the Mac app could not search one. These two routes are that gap
// closed, and they are deliberately thin: a proxy onto the reconciler's
// `GET /vault/search` and `GET /vault/read`, which are the bridge's already.
//
// **Invariant 3 is not bent here.** A page's BYTES and a search RANKING are
// not derived state — there is no column holding a note body, which is the
// schema enforcing the rule rather than a convention asking for it — so they
// come through the bridge. Anything countable (the page list, the link graph)
// is derived and belongs in a named query; `GET /api/knowledge/pages` is
// therefore NOT here, because no such query exists yet in `seed/queries/`.
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
import { isVaultPath, type ErrorCode } from "@foldedspacelabs/metistry-core";
import { underAreas } from "@foldedspacelabs/metistry-mcp-brain";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { sendError, sendJson } from "./http-util.js";

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

/**
 * The areas a principal may see. `null` is "every vault path" — the `user`
 * principal, whose own vault this is.
 *
 * It is a SCOPE rather than a boolean because the filter below is the one
 * place any surface decides whether a path may be shown, and the narrowed
 * form is what a grant looks like: `mcp-brain`'s `knowledgeScope(principal)`
 * produces exactly this shape from an agent's `grants.areas`. Today no agent
 * credential reaches these routes at all — an agent bearer is a uniform 403
 * on everything outside `/capture` and `/mcp` (CRIT-7), and knowledge under
 * grants is `knowledge_search`/`knowledge_read` on that MCP mount. The scope
 * is here, tested, so that if a narrower console principal is ever minted the
 * filter it needs already exists and is not reinvented at the call site.
 */
export interface KnowledgeScope {
  readonly areas: readonly string[] | null;
}

/** The whole owner's vault. */
export const OWNER_SCOPE: KnowledgeScope = { areas: null };

/**
 * May this principal see this path's content? Two conditions, both
 * necessary: it is vault CONTENT at all (`isVaultPath` — so `.metistry/`,
 * `Artifacts/`, a dot-directory, a traversal and the root `CLAUDE.md` are
 * out for every principal, the owner included), and it falls under the
 * scope's areas.
 */
export function canSee(path: string, scope: KnowledgeScope): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 500 || /[\0\\]/.test(path)) return false;
  if (!isVaultPath(path)) return false;
  return scope.areas === null || underAreas(path, scope.areas);
}

/** Hits the scope does not cover are DROPPED, never returned with a flag: a path is the sensitive part of a hit, and a filtered list must not be a directory listing of what was filtered. */
export function filterHits(hits: readonly KnowledgeSearchHit[], scope: KnowledgeScope): KnowledgeSearchHit[] {
  return hits.filter((h) => canSee(h.path, scope));
}

export interface KnowledgeDeps {
  /** the reconciler's `/vault/search`; absent → `not_available` */
  search?: KnowledgeSearcher | undefined;
  /** the same vault client the artifacts module stores through — `/vault/read`; absent → `not_available` */
  vault?: VaultClient | undefined;
}

const NOT_AVAILABLE =
  "the vault bridge is not configured in this deployment — set METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)";

const MAX_LIMIT = 100; // limit: fixed — the bridge clamps at 100 with no offset and no cursor, so promising more here would be a lie (docs/product/app-ux-plan.md §6.1)
const DEFAULT_LIMIT = 20; // limit: fixed — the bridge's own default, so an omitted `limit` means the same thing on both doors
const MAX_QUERY = 200; // limit: fixed — the bridge refuses a longer `q`; refusing it here names the parameter instead of relaying a 400

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
 *
 * server.ts has already established the principal; `scope` is what that
 * principal may see. Not streamed — the bridge's hit list is bounded at 100
 * and a page is one file.
 */
export async function knowledgeRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  key: string,
  url: URL,
  deps: KnowledgeDeps,
  scope: KnowledgeScope,
  audit: Audit,
): Promise<void> {
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
    // Refused and NOT FOUND are the same answer on purpose. A path outside
    // the scope must not be distinguishable from a path that is not there,
    // or the route is an oracle for what exists where the caller cannot
    // look — and for the owner, who may look everywhere in their vault, the
    // honest description of `.metistry/compute.yaml` is "not knowledge".
    if (!canSee(path, scope)) {
      await audit("knowledge", "page", false, { refused: "out_of_scope" });
      return sendError(res, "not_found", "no such page — a path must be vault CONTENT: not .metistry/, not Artifacts/, not the root CLAUDE.md, no leading slash and no traversal (docs/ops/instance-layout.md)");
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

  // Anything else under /api/knowledge/ — including `pages`, which waits on a
  // named query over `knowledge_files` that seed/queries does not carry yet.
  return sendError(res, "not_found", "the knowledge read path is GET /api/knowledge/search and GET /api/knowledge/page (docs/ops/console-api.md)");
}

/** `limit`, or undefined when it is not an integer in range — never silently clamped, because a client that asked for 500 should learn the ceiling. */
function clamp(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return undefined;
  return n;
}
