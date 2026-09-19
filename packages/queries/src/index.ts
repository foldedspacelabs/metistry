// Invariant 3: one read path into state. This package is its only
// implementation — YAML definitions, typed param validation, parameterized
// execution (NEVER string interpolation — review SHOULD-5), a per-query TTL
// cache, and a {rows, as_of} envelope so staleness is visible, not silent.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const paramSpec = z.object({
  type: z.enum(["int", "text", "boolean"]),
  default: z.union([z.number(), z.string(), z.boolean()]).optional(),
  required: z.boolean().default(false),
});

/**
 * Which door a query is reachable through.
 *
 * `generic` — the default, so every manifest written before this field means
 * exactly what it meant — is addressable by name on the console's generic
 * `GET /api/q/<name>`: params in, `{rows, as_of}` out, nothing in between.
 *
 * `route` says this query has an endpoint of ITS OWN, and that endpoint does
 * something the generic door cannot. The page list is the case that produced
 * the field: `GET /api/knowledge/pages` filters every row through the
 * principal's scope, and a second, unscoped way to the same rows would be
 * that filter's undoing — one endpoint per operation, so there is one place
 * where the rule lives. The declaration is HERE, on the manifest, rather
 * than in a list of names inside a server: invariant 5 puts a component's
 * shape on its manifest, and the file the CI validator reads is the file the
 * server reads.
 *
 * It is a statement about the generic door, not a grant of any kind: what a
 * caller may reach is still decided by the surface it calls (the console's
 * principal gates, `mcp-brain`'s `queries: true`).
 */
export const EXPOSURES = ["generic", "route"] as const;
export type Exposure = (typeof EXPOSURES)[number];

const querySpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string(),
  params: z.record(z.string(), paramSpec).default({}),
  sql: z.string(),
  cache_ttl: z.number().int().nonnegative().default(0), // seconds; 0 = no cache
  expose: z.enum(EXPOSURES).default("generic"),
});

export type QuerySpec = z.infer<typeof querySpec>;
export type ParamValue = number | string | boolean;

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** When the data was actually fetched — cached results keep the original. */
  as_of: Date;
}

/** Minimal executor shape — satisfied by pg.Pool. Injectable for tests. */
export interface SqlExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class QueryError extends Error {
  constructor(
    readonly code: "unknown_query" | "invalid_param" | "invalid_spec",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Compile `:name` placeholders to positional binds. Only declared params
 * may appear; values travel as binds, never into the SQL text. Casts like
 * `foo::int` are left alone.
 */
export function compile(spec: QuerySpec): { text: string; order: string[] } {
  const order: string[] = [];
  const text = spec.sql.replace(/(?<![:\w]):([a-z][a-z0-9_]*)/g, (_m, name: string) => {
    if (!(name in spec.params)) {
      throw new QueryError("invalid_spec", `query ${spec.name}: sql references undeclared param :${name}`);
    }
    let i = order.indexOf(name);
    if (i === -1) {
      order.push(name);
      i = order.length - 1;
    }
    return `$${i + 1}`;
  });
  return { text, order };
}

function coerce(name: string, spec: z.infer<typeof paramSpec>, raw: unknown): ParamValue {
  // Query-string values arrive as strings; coerce by declared type only.
  switch (spec.type) {
    case "int": {
      const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isInteger(n)) throw new QueryError("invalid_param", `param ${name} must be an integer`);
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new QueryError("invalid_param", `param ${name} must be a boolean`);
    }
    case "text":
      return String(raw); // always a bind value — content is inert by construction
  }
}

interface CacheEntry {
  result: QueryResult;
  expires: number;
}

export class QueryStore {
  private specs = new Map<string, { spec: QuerySpec; text: string; order: string[] }>();
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly executor: SqlExecutor,
    private readonly now: () => number = Date.now,
  ) {}

  /** Load every *.yaml in a directory. Later loads win by filename (instance-over-seed overlay, D4). */
  async loadDir(dir: string): Promise<number> {
    let n = 0;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort()) {
      this.load(await readFile(join(dir, f), "utf8"));
      n++;
    }
    return n;
  }

  load(yamlText: string): QuerySpec {
    const parsed = querySpec.safeParse(parseYaml(yamlText));
    if (!parsed.success) {
      throw new QueryError("invalid_spec", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const spec = parsed.data;
    this.specs.set(spec.name, { spec, ...compile(spec) });
    return spec;
  }

  names(): string[] {
    return [...this.specs.keys()];
  }

  /**
   * A loaded query's `expose`, or `undefined` when no such query is loaded.
   *
   * The generic door asks this instead of matching names, so "which queries
   * are route-backed" is a fact of the manifests rather than a list in a
   * server that can drift from them — and because the two answers a caller
   * may get are deliberately one answer: a route-backed query and an unknown
   * one are the same refusal, so neither the spelling nor the existence of a
   * route-only query travels back.
   */
  exposure(name: string): Exposure | undefined {
    return this.specs.get(name)?.spec.expose;
  }

  /** One entry per loaded query: name, description, and its params' declared type + default (no `required`/sql — callers don't need those to pick a query). */
  list(): { name: string; description: string; params: Record<string, { type: "int" | "text" | "boolean"; default?: ParamValue }> }[] {
    return [...this.specs.values()].map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      params: Object.fromEntries(
        Object.entries(spec.params).map(([k, p]) => [k, p.default === undefined ? { type: p.type } : { type: p.type, default: p.default }]),
      ),
    }));
  }

  async run(name: string, rawParams: Record<string, unknown> = {}): Promise<QueryResult> {
    const entry = this.specs.get(name);
    if (!entry) throw new QueryError("unknown_query", `no such query: ${name}`);
    const { spec, text, order } = entry;

    // Unknown params are refused, not ignored — misuse surfaces loudly.
    for (const k of Object.keys(rawParams)) {
      if (!(k in spec.params)) throw new QueryError("invalid_param", `unknown param ${k}`);
    }

    const bound: Record<string, ParamValue> = {};
    for (const [k, p] of Object.entries(spec.params)) {
      const raw = rawParams[k];
      if (raw === undefined) {
        if (p.default !== undefined) bound[k] = p.default;
        else if (p.required) throw new QueryError("invalid_param", `missing required param ${k}`);
        else throw new QueryError("invalid_param", `param ${k} has no value and no default`);
      } else {
        bound[k] = coerce(k, p, raw);
      }
    }

    const cacheKey = `${name}:${JSON.stringify(bound)}`;
    if (spec.cache_ttl > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expires > this.now()) return hit.result;
    }

    const values = order.map((k) => bound[k]);
    const { rows } = await this.executor.query(text, values);
    const result: QueryResult = { rows, as_of: new Date(this.now()) };

    if (spec.cache_ttl > 0) {
      this.cache.set(cacheKey, { result, expires: this.now() + spec.cache_ttl * 1000 });
    }
    return result;
  }
}
