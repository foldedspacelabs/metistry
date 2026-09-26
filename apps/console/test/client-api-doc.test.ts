// The client API's two halves agree line for line (F-1's acceptance): the
// route table and the event catalogue in `packages/core` against the tables
// in docs/ops/client-api.md. The document is hand-written — its prose is the
// point — but its two tables are the data, spelled one way. On a mismatch
// this prints the block the document should hold, ready to paste.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CLIENT_API, EVENT_CATALOGUE, routeKey, type ClientRoute, type EventDefinition } from "@foldedspacelabs/metistry-core";

const DOC = new URL("../../../docs/ops/client-api.md", import.meta.url);
const POINTER = new URL("../../../docs/ops/console-api.md", import.meta.url);

/** A table cell: a literal `|` inside code still splits a GitHub table, so it is escaped. */
const cell = (s: string) => s.replaceAll("|", "\\|");

function routeLine(r: ClientRoute): string {
  const conflict = r.conflict === null ? "—" : r.conflict.length === 0 ? "409" : r.conflict.join(" · ");
  const status = r.served ? (r.ticket ? `served · ${r.ticket}` : "served") : (r.ticket ?? "");
  return `| \`${routeKey(r)}\` | ${r.reach.join(" · ")} | ${r.principals.join(" · ")} | ${r.idempotent} | ${conflict} | ${r.cursor ? "since" : "—"} | ${status} | ${cell(r.summary)} |`;
}

function eventLine(e: EventDefinition): string {
  return `| \`${e.type}\` | \`${cell(e.payload)}\` | ${cell(e.when)} | ${cell(e.refetch)} | ${e.reach} |`;
}

/** The table rows (not the header, not the rule) between `<!-- client-api:<name>:begin -->` and `…:end -->`. */
function block(doc: string, name: string): string[] {
  const begin = `<!-- client-api:${name}:begin -->`;
  const end = `<!-- client-api:${name}:end -->`;
  const a = doc.indexOf(begin);
  const b = doc.indexOf(end);
  expect(a, `${begin} is missing from docs/ops/client-api.md`).toBeGreaterThanOrEqual(0);
  expect(b, `${end} is missing from docs/ops/client-api.md`).toBeGreaterThan(a);
  return doc
    .slice(a + begin.length, b)
    .split("\n")
    .filter((l) => l.startsWith("| `"));
}

describe("docs/ops/client-api.md against packages/core", () => {
  it("the route table agrees with CLIENT_API, line for line", async () => {
    const doc = await readFile(DOC, "utf8");
    const want = CLIENT_API.map(routeLine);
    expect(block(doc, "routes"), `the document's route table should read:\n\n${want.join("\n")}\n`).toEqual(want);
  });

  it("the event table agrees with EVENT_CATALOGUE, line for line", async () => {
    const doc = await readFile(DOC, "utf8");
    const want = EVENT_CATALOGUE.map(eventLine);
    expect(block(doc, "events"), `the document's event table should read:\n\n${want.join("\n")}\n`).toEqual(want);
  });

  it("every route has its own words somewhere below the table", async () => {
    // The table says what a route is; the sections say its body, its
    // response and its errors. A row with no mention outside the table has
    // only the first half.
    const doc = await readFile(DOC, "utf8");
    const rest = doc.slice(doc.indexOf("<!-- client-api:routes:end -->"));
    const missing = CLIENT_API.filter((r) => !rest.includes(r.path)).map(routeKey);
    expect(missing).toEqual([]);
  });

  it("the old console API document is a pointer, not a second copy", async () => {
    const pointer = await readFile(POINTER, "utf8");
    expect(pointer).toContain("client-api.md");
    expect(pointer.split("\n").length).toBeLessThan(40);
  });
});
