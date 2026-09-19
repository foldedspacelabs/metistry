// queries_list / queries_run — the mcp-brain adapter over invariant 3's one
// read path (packages/queries' QueryStore). No component talks to Postgres
// directly; this bridges the SAME named-query surface the console's own
// dashboard uses, out to agents, so a query written once serves both.
//
// Access is a separate axis from knowledge grants: an internal principal
// (the instance's own assistant) always has it; an external agent needs an
// explicit `queries: true` grant (agents.ts `validateGrants`, default
// false) — the knowledge tier says nothing about compute-query access.
// Absent a QueryStore, both tools answer `not_available` (degrades: absent),
// uniform with knowledge_read/write and artifact_*.
//
// **This is the GENERIC door, and it honours `expose` like the other one.**
// A query whose manifest says `expose: route` has an endpoint of its own
// that does something a by-name runner cannot — `knowledge_pages` and
// `knowledge_page_links` filter every row through the caller's scope — so
// serving it here would be that filter undone. The console closed its
// generic `/api/q/<name>` to them on 2026-09-19 and left this one open,
// which meant a `queries: true` grant was a way around every knowledge tier:
// tier `none` could not be told a single title by `knowledge_search`, and
// could page the whole vault index through `queries_run`. Closed here on the
// same rule (ruled 2026-09-19: "all queries including /mcp should be scoped
// and follow the same token based enforcements"), with the scoped door
// beside it — `knowledge_list`, which runs the same two named queries
// through the same `canSeeUnder` (knowledge-fs.ts).
//
// The refusal is the UNKNOWN-QUERY refusal, byte for byte — same code, same
// message — and `queries_list` does not list a route-backed query either, so
// neither tool tells a caller which route-only queries this build has.

import { z } from "zod";
import { QueryError, type QueryStore } from "@foldedspacelabs/metistry-queries";
import { done, fail, type Outcome } from "./outcome.js";
import type { AgentPrincipal } from "./types.js";

export const QUERIES_TOOL_NAMES = ["queries_list", "queries_run"] as const;
export type QueriesToolName = (typeof QUERIES_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: QueriesToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

export const MAX_ROWS = 200; // limit: fixed — part of the tool's contract; a named query wanting more needs its own LIMIT

const NOT_AVAILABLE = "named queries are not configured in this deployment (the console loads seed/queries + the instance's queries/)";

/** internal principals always; external agents only with an explicit `queries: true` grant. */
function allowed(principal: AgentPrincipal): boolean {
  return principal.kind === "internal" || principal.grants.queries === true;
}

/** QueryError's three load/run-time codes → the uniform envelope (invariant 8). */
function fromQueryError(err: QueryError): Outcome {
  return fail(err.code === "unknown_query" ? "not_found" : "invalid_request", err.message);
}

/**
 * The refusal a name that is not servable here gets — whether it is not
 * loaded at all or loaded as `expose: route`. `packages/queries` spells the
 * unknown-query message `no such query: <name>`, so this repeats it exactly:
 * a distinguishable refusal would make this tool an oracle for which
 * route-backed queries exist, which is the disclosure `expose` exists to
 * prevent.
 */
function noSuchQuery(name: string): Outcome {
  return fail("not_found", `no such query: ${name}`);
}

/** Servable by name here: loaded, and `expose: generic` (the default every manifest without the field carries). */
function generic(store: QueryStore, name: string): boolean {
  return store.exposure(name) === "generic";
}

export function registerQueriesTools(reg: Register, store: QueryStore | undefined, principal: AgentPrincipal): void {
  reg(
    "queries_list",
    "List named queries available on this instance; each entry names its params (type + default) for queries_run.",
    {},
    async () => {
      if (!allowed(principal)) return fail("forbidden");
      if (!store) return fail("not_available", NOT_AVAILABLE);
      // Route-backed queries are not listed, because they are not runnable
      // here: a list that named one would contradict the refusal below and
      // publish the route-only set in the same breath.
      const queries = store.list().filter((q) => generic(store, q.name));
      return done({ queries }, { count: queries.length });
    },
  );

  reg(
    "queries_run",
    `Run one named query with optional params (unknown/wrong-type params refused). Capped at ${MAX_ROWS} rows (truncated: true if more); as_of is the real fetch time, even when cached.`,
    {
      name: z.string().min(1).max(100),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
    async (a) => {
      if (!allowed(principal)) return fail("forbidden");
      if (!store) return fail("not_available", NOT_AVAILABLE);
      // `expose`, read off the manifest through the store rather than
      // matched against a list kept here, which could drift from the files
      // (invariant 5). Unknown and route-backed are the same answer.
      if (!generic(store, a.name)) return noSuchQuery(a.name);
      let result;
      try {
        result = await store.run(a.name, a.params ?? {});
      } catch (err) {
        if (err instanceof QueryError) return fromQueryError(err);
        throw err;
      }
      const truncated = result.rows.length > MAX_ROWS;
      const rows = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;
      return done(
        { name: a.name, params: a.params ?? {}, rows, as_of: result.as_of.toISOString(), row_count: rows.length, ...(truncated ? { truncated: true } : {}) },
        { name: a.name, row_count: rows.length, ...(truncated ? { truncated: true } : {}) },
      );
    },
  );
}
