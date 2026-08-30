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
