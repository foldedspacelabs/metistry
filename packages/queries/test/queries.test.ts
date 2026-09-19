import { describe, expect, it, vi } from "vitest";
import { QueryError, QueryStore, compile, type SqlExecutor } from "../src/index.js";

const OPEN_WORK = `
name: open_work
description: Work items not yet closed, newest first
params:
  limit: { type: int, default: 20 }
sql: |
  SELECT id, title FROM work WHERE status <> 'closed'
  ORDER BY updated_at DESC LIMIT :limit
cache_ttl: 60
`;

function fakeExecutor() {
  const calls: { text: string; values: unknown[] }[] = [];
  const executor: SqlExecutor = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ id: 1, title: "t" }] };
    },
  };
  return { executor, calls };
}

describe("QueryStore", () => {
  it("binds params positionally — values never enter the SQL text", async () => {
    const { executor, calls } = fakeExecutor();
    const store = new QueryStore(executor);
    store.load(OPEN_WORK);
    await store.run("open_work", { limit: "5" });
    expect(calls[0]?.text).toContain("$1");
    expect(calls[0]?.text).not.toContain(":limit");
    expect(calls[0]?.values).toEqual([5]);
  });

  // Misuse test (SHOULD-5): a hostile text param stays a bind value.
  it("passes hostile text params as inert bind values", async () => {
    const { executor, calls } = fakeExecutor();
    const store = new QueryStore(executor);
    store.load(`
name: by_area
description: filter by area
params:
  area: { type: text, required: true }
sql: SELECT id FROM work WHERE area = :area
`);
    const hostile = "x'; DROP TABLE work; --";
    await store.run("by_area", { area: hostile });
    expect(calls[0]?.text).not.toContain("DROP TABLE");
    expect(calls[0]?.values).toEqual([hostile]);
  });

  it("refuses unknown queries, unknown params, bad types, missing required", async () => {
    const { executor } = fakeExecutor();
    const store = new QueryStore(executor);
    store.load(OPEN_WORK);
    await expect(store.run("nope")).rejects.toMatchObject({ code: "unknown_query" });
    await expect(store.run("open_work", { evil: 1 })).rejects.toMatchObject({ code: "invalid_param" });
    await expect(store.run("open_work", { limit: "ten" })).rejects.toMatchObject({ code: "invalid_param" });
  });

  it("rejects SQL referencing an undeclared param at load time", () => {
    expect(() =>
      compile({
        name: "bad",
        description: "d",
        params: {},
        sql: "SELECT * FROM work WHERE id = :id",
        cache_ttl: 0,
        expose: "generic",
      }),
    ).toThrow(QueryError);
  });

  it("leaves :: casts alone and reuses repeated params", () => {
    const { text, order } = compile({
      name: "c",
      description: "d",
      params: { q: { type: "text", required: true } },
      sql: "SELECT :q::text WHERE title = :q OR area = :q",
      cache_ttl: 0,
      expose: "generic",
    });
    expect(text).toBe("SELECT $1::text WHERE title = $1 OR area = $1");
    expect(order).toEqual(["q"]);
  });

  it("serves from cache within ttl and keeps the original as_of", async () => {
    const { executor, calls } = fakeExecutor();
    let t = 1_000_000;
    const store = new QueryStore(executor, () => t);
    store.load(OPEN_WORK);
    const first = await store.run("open_work", {});
    t += 30_000;
    const second = await store.run("open_work", {});
    expect(calls.length).toBe(1);
    expect(second.as_of).toEqual(first.as_of); // staleness visible via as_of
    t += 31_000; // past 60s ttl
    await store.run("open_work", {});
    expect(calls.length).toBe(2);
  });

  it("caches per distinct param set", async () => {
    const { executor, calls } = fakeExecutor();
    const store = new QueryStore(executor, vi.fn(() => 0));
    store.load(OPEN_WORK);
    await store.run("open_work", { limit: 5 });
    await store.run("open_work", { limit: 6 });
    expect(calls.length).toBe(2);
  });

  it("rejects an invalid spec", () => {
    const { executor } = fakeExecutor();
    const store = new QueryStore(executor);
    expect(() => store.load("name: 'Bad Name'\nsql: SELECT 1")).toThrow(QueryError);
  });
});

// `expose` is how a manifest says which DOOR serves it. The console's generic
// `/api/q/<name>` answers `generic` queries; a `route` query has an endpoint
// of its own that does something the generic door cannot (the page list
// filters every row through the caller's scope), so the generic door refuses
// it. The store is where that fact lives, because the store is what reads the
// manifests — a list of names kept in a server would drift from the files.
describe("expose: which door serves a query", () => {
  const ROUTE_BACKED = `
name: knowledge_pages_like
description: a query with a scoped endpoint of its own
expose: route
params:
  limit: { type: int, default: 10 }
sql: SELECT path FROM knowledge_files LIMIT :limit
`;

  it("defaults to generic, so every manifest written before the field means what it meant", () => {
    const store = new QueryStore(fakeExecutor().executor);
    expect(store.load(OPEN_WORK).expose).toBe("generic");
    expect(store.exposure("open_work")).toBe("generic");
  });

  it("carries `expose: route` off the manifest", () => {
    const store = new QueryStore(fakeExecutor().executor);
    expect(store.load(ROUTE_BACKED).expose).toBe("route");
    expect(store.exposure("knowledge_pages_like")).toBe("route");
  });

  // The door's refusal is "unknown query", and it must be reachable the same
  // way for a name that is route-backed and a name that is not there at all —
  // so `undefined` and `"route"` are both "not for the generic door", and the
  // caller cannot tell them apart by asking.
  it("answers undefined for a query that is not loaded", () => {
    const store = new QueryStore(fakeExecutor().executor);
    store.load(ROUTE_BACKED);
    expect(store.exposure("no_such_query")).toBeUndefined();
    expect(store.exposure("knowledge_pages_like")).not.toBe("generic");
    expect(store.exposure("no_such_query")).not.toBe("generic");
  });

  it("refuses an unknown exposure at load time rather than guessing at one", () => {
    const store = new QueryStore(fakeExecutor().executor);
    const bad = ROUTE_BACKED.replace("expose: route", "expose: public");
    expect(() => store.load(bad)).toThrow(QueryError);
    try {
      store.load(bad);
    } catch (err) {
      expect((err as QueryError).code).toBe("invalid_spec");
    }
    // …and a mis-spelling does not silently become the permissive default
    expect(store.names()).toEqual([]);
    expect(store.exposure("knowledge_pages_like")).toBeUndefined();
    for (const value of ["Route", "ROUTE", "none", "true", ""]) {
      expect(() => store.load(ROUTE_BACKED.replace("expose: route", `expose: ${JSON.stringify(value)}`)), value).toThrow(QueryError);
    }
  });

  // The field closes a DOOR; it does not take the query out of the one read
  // path. Its own endpoint runs it through this same store, params and all.
  it("still runs a route-backed query — the dedicated endpoint goes through the store like everything else", async () => {
    const { executor, calls } = fakeExecutor();
    const store = new QueryStore(executor);
    store.load(ROUTE_BACKED);
    const result = await store.run("knowledge_pages_like", { limit: "3" });
    expect(calls[0]?.values).toEqual([3]);
    expect(result.rows.length).toBe(1);
  });
});
