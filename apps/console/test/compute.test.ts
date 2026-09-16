// The console's and the assistant's wiring onto compute.yaml. The reload
// RULES are core's and are tested there; what is tested here is the wiring
// core deliberately does not carry: the chokidar adapter really fires on a
// file that is REPLACED (which is what git and every editor do, and what a
// raw fs.watch misses), an invalid reload writes exactly one `runs` warning
// row, and the assistant's copy of this module has not drifted from the
// console's.
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunExecutor } from "@foldedspacelabs/metistry-core";
import { chokidarWatch, recordComputeReload } from "../src/compute.js";

/** A pg-shaped executor that records statements and hands back an id for the insert. */
function fakeDb(): RunExecutor & { calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return { rows: text.startsWith("INSERT") ? [{ id: 7 }] : [] };
    },
  };
}

describe("recordComputeReload", () => {
  it("writes nothing when the reload was fine", async () => {
    const db = fakeDb();
    await recordComputeReload(db, "console", { ok: true, path: "compute.yaml", changed: true });
    expect(db.calls).toEqual([]);
  });

  it("writes one failed run naming the file that broke and the one still in force", async () => {
    const db = fakeDb();
    await recordComputeReload(db, "console", { ok: false, path: "seed/compute.yaml", failedPath: "compute.yaml", errors: ["providers.x.data_policy: …"], changed: false });
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.text).toContain("INSERT INTO runs");
    expect(db.calls[0]?.values.slice(0, 2)).toEqual(["console", "config"]);
    expect(JSON.parse(String(db.calls[0]?.values[6]))).toEqual({ file: "compute.yaml", in_force: "seed/compute.yaml" });
    expect(db.calls[1]?.values[1]).toBe(false); // ok = false
    expect(String(db.calls[1]?.values[2])).toContain("the last good configuration is still in force");
  });
});

describe("chokidarWatch", () => {
  it("fires when the watched file is REPLACED, not just written in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-watch-"));
    const target = join(dir, "compute.yaml");
    await writeFile(target, "providers: {}\n");
    let fired = 0;
    const close = chokidarWatch([target], () => {
      fired += 1;
    });
    try {
      await new Promise((r) => setTimeout(r, 300)); // chokidar's initial scan
      await writeFile(join(dir, "next"), "providers: { a: {} }\n");
      await rename(join(dir, "next"), target); // the atomic save git and editors do
      await new Promise((r) => setTimeout(r, 1200));
      expect(fired).toBeGreaterThan(0);
      expect(await readFile(target, "utf8")).toContain("a:");
    } finally {
      await close();
    }
  }, 15_000);
});

describe("the assistant's copy", () => {
  it("is byte-identical to the console's — one implementation, two services", async () => {
    const here = await readFile(fileURLToPath(new URL("../src/compute.ts", import.meta.url)), "utf8");
    const there = await readFile(fileURLToPath(new URL("../../assistant/src/compute.ts", import.meta.url)), "utf8");
    expect(there).toBe(here);
  });
});
