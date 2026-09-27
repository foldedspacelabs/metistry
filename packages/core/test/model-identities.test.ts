// The model identity table and the catalogue grouped by model (C131, T4-18).
// The assertion the ticket names — an id the table cannot map stays its own
// row — is the one that matters most: grouping is only honest while nothing
// is merged on a guess.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  groupCatalogue,
  identityIndex,
  loadModelIdentities,
  overlayModelIdentities,
  parseModelIdentities,
  type CatalogueEntry,
} from "../src/index.js";

const SEED = readFileSync(new URL("../../../seed/model-identities.yaml", import.meta.url), "utf8");

const TABLE = parseModelIdentities(`
schema: 1
models:
  llama-3.3-70b:
    name: Llama 3.3 70B
    maker: Meta
    context: 131072
    capabilities: [tools]
    ids: [meta-llama/llama-3.3-70b-instruct, llama-3.3-70b-versatile, "llama3.3:70b"]
  gemma-3-4b:
    name: Gemma 3 4B
    maker: Google
    ids: ["gemma3:4b", google/gemma-3-4b-it]
`);

const e = (provider: string, model: string, extra: Partial<CatalogueEntry> = {}): CatalogueEntry => ({ provider, model, tag: "cloud", ...extra });

function refusal(text: string): string {
  try {
    parseModelIdentities(text);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the table to be refused");
}

describe("the table", () => {
  it("the product's seed parses, and every id in it is one model's", () => {
    const t = parseModelIdentities(SEED, "seed/model-identities.yaml");
    expect(Object.keys(t.models).length).toBeGreaterThan(5);
    const ids = Object.values(t.models).flatMap((m) => m.ids.map((i) => i.toLowerCase()));
    expect(new Set(ids).size).toBe(ids.length);
    // C131's own example: one model under three providers' ids
    expect(identityIndex(t).get("llama3.3:70b")).toBe("llama-3.3-70b");
    expect(identityIndex(t).get("meta-llama/llama-3.3-70b-instruct")).toBe("llama-3.3-70b");
  });

  it("refuses an id listed under two models, naming both — a place cannot be two models", () => {
    const m = refusal(`schema: 1\nmodels:\n  a: { name: A, maker: X, ids: [same/id] }\n  b: { name: B, maker: Y, ids: [SAME/ID] }\n`);
    expect(m).toContain("models.b.ids");
    expect(m).toContain("already models.a's");
  });

  it("refuses a capability outside the closed vocabulary, an unknown field, a bad key and a missing schema", () => {
    expect(refusal(`schema: 1\nmodels:\n  a: { name: A, maker: X, ids: [x], capabilities: [telepathy] }\n`)).toContain("a capability is one of tools, vision, reasoning, embeddings");
    expect(refusal(`schema: 1\nmodels:\n  a: { name: A, maker: X, ids: [x], price: 3 }\n`)).toContain("models.a");
    expect(refusal(`schema: 1\nmodels:\n  Bad Key: { name: A, maker: X, ids: [x] }\n`)).toContain("a model key is lowercase");
    expect(refusal(`models:\n  a: { name: A, maker: X, ids: [x] }\n`)).toContain("schema: 1");
    expect(refusal(`schema: 1\nmodels:\n  a: { name: A, maker: X, ids: [] }\n`)).toContain("at least one");
  });

  it("the instance's file overlays BY KEY: replaces, adds, and takes the ids it lists", () => {
    const mine = parseModelIdentities(`
schema: 1
models:
  gemma-3-4b: { name: Gemma Three Four, maker: Google, ids: ["gemma3:4b"] }
  my-box: { name: The Box Model, maker: Me, ids: ["llama3.3:70b"] }
`);
    const t = overlayModelIdentities(TABLE, mine);
    expect(t.models["gemma-3-4b"]?.name).toBe("Gemma Three Four");
    expect(t.models["gemma-3-4b"]?.ids).toEqual(["gemma3:4b"]); // replaced whole
    expect(t.models["my-box"]).toBeDefined();
    expect(t.models["llama-3.3-70b"]?.ids).not.toContain("llama3.3:70b"); // the owner's mapping wins
    expect(identityIndex(t).get("llama3.3:70b")).toBe("my-box");
  });

  it("loads the overlay in order, skipping a missing file and naming one that does not validate", async () => {
    const files: Record<string, string> = { "/seed.yaml": SEED, "/bad.yaml": "schema: 2\n" };
    const read = async (p: string) => {
      if (files[p] === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return files[p]!;
    };
    const t = await loadModelIdentities(["/seed.yaml", "/missing.yaml"], read);
    expect(t.models["claude-sonnet-5"]).toBeDefined();
    await expect(loadModelIdentities(["/seed.yaml", "/bad.yaml"], read)).rejects.toThrow("/bad.yaml does not validate");
  });
});

describe("the catalogue, grouped by model (C131)", () => {
  it("**unmapped ids stay separate rows** — one per (provider, id), even when two providers spell one id the same way", () => {
    const rows = groupCatalogue([e("openrouter", "acme/mystery-7b"), e("groq", "acme/mystery-7b"), e("openrouter", "acme/other")], TABLE);
    const unmapped = rows.filter((r) => r.kind === "unmapped");
    expect(unmapped.map((r) => r.key).sort()).toEqual(["groq/acme/mystery-7b", "openrouter/acme/mystery-7b", "openrouter/acme/other"]);
    for (const r of unmapped) {
      expect(r.places).toHaveLength(1);
      expect(r.maker).toBeNull();
    }
  });

  it("a mapped model is ONE row with a line per place, whatever each provider calls it", () => {
    const rows = groupCatalogue(
      [
        e("openrouter", "meta-llama/llama-3.3-70b-instruct", { in_per_m: 0.13, out_per_m: 0.4, price_source: "listing", zdr: true }),
        e("groq", "llama-3.3-70b-versatile", { in_per_m: 0.59, out_per_m: 0.79, price_source: "pricing" }),
        e("ollama", "llama3.3:70b", { tag: "local" }),
      ],
      TABLE,
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ kind: "model", key: "llama-3.3-70b", name: "Llama 3.3 70B", maker: "Meta", context: 131072, capabilities: ["tools"] });
    expect(row!.places.map((p) => p.ref)).toEqual(["ollama/llama3.3:70b", "openrouter/meta-llama/llama-3.3-70b-instruct", "groq/llama-3.3-70b-versatile"]);
    expect(row!.places.find((p) => p.provider === "openrouter")?.cheapest).toBe(true);
    expect(row!.places.filter((p) => p.cheapest)).toHaveLength(1);
    expect(row!.places.find((p) => p.provider === "ollama")).toMatchObject({ tag: "local", zdr: null, in_per_m: null, cheapest: false });
    expect(row!.summary).toEqual({ local: true, cloud: true, from_in_per_m: 0.13 });
  });

  it("ids match without case, and the same place listed twice is one line", () => {
    const rows = groupCatalogue([e("ollama", "GEMMA3:4B", { tag: "local" }), e("ollama", "GEMMA3:4B", { tag: "local" })], TABLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.places).toHaveLength(1);
  });

  it("a subscription's place reads Included, not a price; one priced place is not called cheapest", () => {
    const rows = groupCatalogue([e("zen", "gemma3:4b", { tag: "subscription", in_per_m: 1, out_per_m: 1 }), e("openrouter", "google/gemma-3-4b-it", { in_per_m: 0.02, out_per_m: 0.04 })], TABLE);
    const places = rows[0]!.places;
    expect(places.find((p) => p.provider === "zen")).toMatchObject({ included: true, in_per_m: null });
    expect(places.some((p) => p.cheapest)).toBe(false);
    expect(rows[0]!.summary.from_in_per_m).toBe(0.02);
  });

  it("an unmapped row takes the listing's own name and context, and a listing that says tools adds the capability", () => {
    const rows = groupCatalogue([e("openrouter", "acme/x", { listed_name: "Acme X", context: 32768, tools: true })], TABLE);
    expect(rows[0]).toMatchObject({ kind: "unmapped", name: "Acme X", context: 32768, capabilities: ["tools"] });
  });

  it("the query keeps rows where every word appears — name, maker, key or a place — best match first", () => {
    const entries = [e("ollama", "gemma3:4b", { tag: "local" }), e("openrouter", "meta-llama/llama-3.3-70b-instruct"), e("openrouter", "acme/gemma-fork")];
    expect(groupCatalogue(entries, TABLE, { query: "gemma" }).map((r) => r.key)).toEqual(["gemma-3-4b", "openrouter/acme/gemma-fork"]);
    expect(groupCatalogue(entries, TABLE, { query: "meta 70b" }).map((r) => r.key)).toEqual(["llama-3.3-70b"]);
    expect(groupCatalogue(entries, TABLE, { query: "ollama" }).map((r) => r.key)).toEqual(["gemma-3-4b"]);
    expect(groupCatalogue(entries, TABLE, { query: "no such thing" })).toEqual([]);
    // an empty query lists everything: mapped models first, then unmapped ids
    expect(groupCatalogue(entries, TABLE).map((r) => r.kind)).toEqual(["model", "model", "unmapped"]);
  });
});
