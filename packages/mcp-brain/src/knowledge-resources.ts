// MCP resources over the vault (docs/research/2026-09-stash-review.md item
// 3): settled notes exposed as `metistry://<vault path>` for any client
// that browses resources rather than calling tools. Same tier rule as
// knowledge_read throughout — a resource grant does not exist as a
// separate concept, `areas` is what makes a note visible or readable.
//
// This bypasses McpServer's high-level `resource()`/`registerResource()`
// sugar and talks to the low-level Server (`server.server`, the "advanced
// operations" escape hatch the SDK documents) directly. Two reasons:
// - the high-level template's `list` callback receives only `extra`, never
//   `request.params.cursor` (see the vendored SDK's
//   `server/mcp.js` `ListResourcesRequestSchema` handler) — there is no way
//   to paginate through the high-level API, and the task calls for real
//   pagination over a vault that can hold thousands of notes;
// - the visible resource set is per-principal (per-request server, same as
//   every tool here), which the template API is not shaped for either.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { areaFilter, knowledgeScope, readKnowledge, titleSql, type KnowledgeReader } from "./knowledge.js";
import type { AgentPrincipal, Db } from "./types.js";

const SCHEME = "metistry";
const PAGE_SIZE = 100;

/** Vault path → resource URI. Not a special URL scheme, so the host segment is never lowercased — `Areas` round-trips. */
export function resourceUriFor(path: string): string {
  return `${SCHEME}://${path}`;
}

/** Resource URI → vault path, or null when it is not one of ours. */
export function pathFromResourceUri(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || !u.host) return null;
  return `${u.host}${u.pathname}`;
}

/**
 * Mount resources/list + resources/read on `server`'s underlying low-level
 * Server, scoped to `principal`. Called once per per-request McpServer
 * (server.ts's `buildServer`), before `connect()`.
 */
export function registerKnowledgeResources(server: McpServer, principal: AgentPrincipal, db: Db, reader: KnowledgeReader | undefined): void {
  server.server.registerCapabilities({ resources: {} });

  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    // Only tier `areas` has "granted prefixes" at all — `none`/`index` see
    // no resources, the same visibility knowledge_read already enforces.
    const scope = knowledgeScope(principal);
    if (scope.tier !== "areas") return { resources: [] };
    const cursor = request.params?.cursor ?? null;
    const { rows } = await db.query(
      `SELECT path, ${titleSql()} AS title, description
         FROM knowledge_files
        WHERE NOT draft
          AND ${areaFilter("path", 2)}
          AND ($3::text IS NULL OR path > $3)
        ORDER BY path
        LIMIT $1`,
      [PAGE_SIZE + 1, scope.prefixes, cursor],
    );
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const resources = page.map((r) => ({
      uri: resourceUriFor(String(r.path)),
      name: String(r.title),
      mimeType: "text/markdown",
      ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
    }));
    return hasMore ? { resources, nextCursor: String(page[page.length - 1]!.path) } : { resources };
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const path = pathFromResourceUri(request.params.uri);
    if (!path) throw new McpError(ErrorCode.InvalidParams, `not a ${SCHEME}:// resource: ${request.params.uri}`);
    const r = await readKnowledge(db, principal, path, reader);
    if (!r.ok) {
      // resources/read has no "forbidden" concept distinct from "does not
      // exist" for this caller — forbidden/not_found/invalid_request all
      // read as InvalidParams; not_available is a real capability gap.
      if (r.code === "not_available") throw new McpError(ErrorCode.InternalError, r.message ?? "note contents are not readable from this deployment");
      throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`);
    }
    return { contents: [{ uri: resourceUriFor(r.path), mimeType: "text/markdown", text: r.content }] };
  });
}
