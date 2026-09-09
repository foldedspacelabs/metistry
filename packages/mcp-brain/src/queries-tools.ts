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

import { z } from "zod";
import { QueryError, type QueryStore } from "@foldedspacelabs/metistry-queries";
import { done, fail, type Outcome } from "./outcome.js";
import type { AgentPrincipal } from "./types.js";

export const QUERIES_TOOL_NAMES = ["queries_list", "queries_run"] as const;
export type QueriesToolName = (typeof QUERIES_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: QueriesToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

export const MAX_ROWS = 200;

const NOT_AVAILABLE = "named queries are not configured in this deployment (the console loads seed/queries + the instance's queries/)";

/** internal principals always; external agents only with an explicit `queries: true` grant. */
function allowed(principal: AgentPrincipal): boolean {
  return principal.kind === "internal" || principal.grants.queries === true;
}

/** QueryError's three load/run-time codes → the uniform envelope (invariant 8). */
function fromQueryError(err: QueryError): Outcome {
  return fail(err.code === "unknown_query" ? "not_found" : "invalid_request", err.message);
}

export function registerQueriesTools(reg: Register, store: QueryStore | undefined, principal: AgentPrincipal): void {
  reg(
    "queries_list",
    "List named queries available on this instance; each entry names its params (type + default) for queries_run.",
    {},
    async () => {
      if (!allowed(principal)) return fail("forbidden");
      if (!store) return fail("not_available", NOT_AVAILABLE);
      const queries = store.list();
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
