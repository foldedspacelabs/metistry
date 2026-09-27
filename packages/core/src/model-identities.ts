// One model, several places (C131, screen-15 §5.3.1).
//
// The same model is served by several providers under several ids —
// OpenRouter's `meta-llama/llama-3.3-70b-instruct`, Groq's
// `llama-3.3-70b-versatile`, Ollama's `llama3.3:70b` — and billed
// differently at each. Search groups by MODEL, and under each model one line
// per PLACE it runs. What makes that possible is this table: provider model
// id → one identity (name, maker, context, capabilities).
//
// Two rules the table is built around:
//
//   * **An id the table does not map stays its own row**, under the provider
//     that served it — never merged with a look-alike on another provider by
//     a guess at string similarity. Two providers can serve two different
//     models under one id string; only the table says they are one model.
//   * **An id maps to ONE model.** Listing it under two identities is
//     refused, naming both, because a place cannot be two models at once.
//
// `seed/model-identities.yaml` is the product's table; the instance's
// `.metistry/model-identities.yaml` overlays it BY KEY (plan §2.9:
// "overlayable") — an owner's entry replaces the product's entry of the same
// key whole, adds a key the product does not have, and takes any id it lists
// away from whichever product entry had it. Per key rather than D4's
// whole-file rule because this is product DATA that grows every release: a
// whole-file overlay would freeze an instance at the table it copied.
//
// Pure, like compute.ts: no file is read here that the caller did not name,
// and grouping is a function of its inputs.

import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { ProviderTag } from "./compute.js";

/** The file's name, in `seed/` and in the instance's `.metistry/`. */
export const MODEL_IDENTITIES_FILENAME = "model-identities.yaml";

/** What a model can do — a CLOSED vocabulary (plan §2.7): a filter the app renders must mean one thing everywhere, so a typo is refused rather than shown as a new capability. */
export const MODEL_CAPABILITIES = ["tools", "vision", "reasoning", "embeddings"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** An identity's key: lowercase, digits, `.` and `-` — `llama-3.3-70b`, `claude-sonnet-5`. */
export const MODEL_IDENTITY_KEY_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

const identitySchema = z.strictObject({
  /** how the model is written everywhere (C132): **name** maker · provider · tag */
  name: z.string().trim().min(1, "name is how the model is written — e.g. Llama 3.3 70B"),
  maker: z.string().trim().min(1, "maker is who made the model — e.g. Meta"),
  /** the context window in tokens, where the maker states one */
  context: z.number().int().positive().optional(),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES, { error: `a capability is one of ${MODEL_CAPABILITIES.join(", ")}` })).default([]),
  /** every provider model id this model is served under, EXACTLY as the provider lists it (compared without case) */
  ids: z.array(z.string().trim().min(1)).min(1, "ids lists the provider model ids this model is served under — at least one"),
});

export type ModelIdentity = z.infer<typeof identitySchema>;

export const modelIdentitiesSchema = z
  .strictObject({
    schema: z.literal(1, { error: "schema: 1 — the only version of this file there is" }),
    // keys checked below rather than by the record, whose own refusal ("Invalid key in record") names no rule
    models: z.record(z.string(), identitySchema).default({}),
  })
  .superRefine((file, ctx) => {
    const owner = new Map<string, string>();
    for (const [key, m] of Object.entries(file.models)) {
      if (!MODEL_IDENTITY_KEY_RE.test(key)) ctx.addIssue({ code: "custom", path: ["models", key], message: "a model key is lowercase letters, digits, . and - (e.g. llama-3.3-70b)" });
      for (const id of m.ids) {
        const k = id.toLowerCase();
        const other = owner.get(k);
        if (other !== undefined && other !== key) {
          ctx.addIssue({ code: "custom", path: ["models", key, "ids"], message: `${JSON.stringify(id)} is already models.${other}'s — a provider id is ONE model, so it is listed under one key` });
        }
        owner.set(k, key);
      }
    }
  });

export type ModelIdentities = z.infer<typeof modelIdentitiesSchema>;

/** Parse one file's text. Throws naming every field that is wrong; an empty file is an empty table. */
export function parseModelIdentities(text: string, where = MODEL_IDENTITIES_FILENAME): ModelIdentities {
  const doc = parseDocument(text);
  const bad = doc.errors[0];
  if (bad) throw new Error(`${where} is not valid YAML — ${bad.message}`);
  const raw = text.trim() === "" ? { schema: 1 } : (doc.toJS() as unknown);
  const r = modelIdentitiesSchema.safeParse(raw ?? { schema: 1 });
  if (!r.success) throw new Error(`${where} does not validate — ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/**
 * Overlay `over` on `base` by key: a key in `over` replaces `base`'s whole,
 * and every id `over` lists is taken away from whichever `base` entry had it
 * (an entry left with no ids drops out). The result keeps "one id, one
 * model" whatever the two files say.
 */
export function overlayModelIdentities(base: ModelIdentities, over: ModelIdentities): ModelIdentities {
  const claimed = new Set(Object.values(over.models).flatMap((m) => m.ids.map((i) => i.toLowerCase())));
  const models: Record<string, ModelIdentity> = {};
  for (const [key, m] of Object.entries(base.models)) {
    if (Object.hasOwn(over.models, key)) continue;
    const ids = m.ids.filter((i) => !claimed.has(i.toLowerCase()));
    if (ids.length > 0) models[key] = { ...m, ids };
  }
  for (const [key, m] of Object.entries(over.models)) models[key] = m;
  return { schema: 1, models };
}

/** Read the overlay — each path in order, a missing file skipped, a present one that does not validate THROWS naming it. */
export async function loadModelIdentities(paths: readonly string[], read: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<ModelIdentities> {
  let table: ModelIdentities = { schema: 1, models: {} };
  for (const p of paths) {
    let text: string;
    try {
      text = await read(p);
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "EISDIR") continue;
      throw err;
    }
    table = overlayModelIdentities(table, parseModelIdentities(text, p));
  }
  return table;
}

/** provider id (lower-cased) → identity key. */
export function identityIndex(table: ModelIdentities): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, m] of Object.entries(table.models)) for (const id of m.ids) out.set(id.toLowerCase(), key);
  return out;
}

// ---- the catalogue, grouped by model -----------------------------------------------

/** One model id one provider serves, with what its listing and `compute.yaml` say about it. */
export interface CatalogueEntry {
  /** the provider's name in compute.yaml */
  provider: string;
  /** the id exactly as the provider serves it */
  model: string;
  tag: ProviderTag;
  zdr?: boolean | undefined;
  /** USD per million tokens, where the listing or `compute.yaml`'s `pricing:` says; absent = not published here */
  in_per_m?: number | undefined;
  out_per_m?: number | undefined;
  price_source?: "listing" | "pricing" | undefined;
  /** the listing's own display name, where it gives one (OpenRouter does) */
  listed_name?: string | undefined;
  /** the listing's context window, where it gives one */
  context?: number | undefined;
  /** the listing says the model takes tools */
  tools?: boolean | undefined;
}

/** One place a model runs: a line under its row. */
export interface CataloguePlace {
  provider: string;
  model: string;
  /** `<provider>/<model>` — exactly what `compute assign` and an agent's `model:` take */
  ref: string;
  tag: ProviderTag;
  zdr: boolean | null;
  in_per_m: number | null;
  out_per_m: number | null;
  price_source: "listing" | "pricing" | null;
  /** a subscription's model: *Included in* the plan rather than a price */
  included: boolean;
  /** the lowest-priced of two or more priced cloud places (in + out per M) */
  cheapest: boolean;
}

export interface CatalogueRow {
  /** `model`: the table maps it. `unmapped`: an id the table does not know — one row per (provider, id), never merged */
  kind: "model" | "unmapped";
  /** the identity key, or `<provider>/<model>` for an unmapped row */
  key: string;
  name: string;
  maker: string | null;
  context: number | null;
  capabilities: ModelCapability[];
  places: CataloguePlace[];
  /** the collapsed line: *Local or cloud · from $x per M* */
  summary: { local: boolean; cloud: boolean; from_in_per_m: number | null };
}

const lower = (s: string | null | undefined): string => (s ?? "").toLowerCase();

function placeOf(e: CatalogueEntry): CataloguePlace {
  const priced = e.tag === "cloud" && e.in_per_m !== undefined && e.out_per_m !== undefined;
  return {
    provider: e.provider,
    model: e.model,
    ref: `${e.provider}/${e.model}`,
    tag: e.tag,
    zdr: e.tag === "local" ? null : (e.zdr ?? false),
    in_per_m: priced ? e.in_per_m! : null,
    out_per_m: priced ? e.out_per_m! : null,
    price_source: priced ? (e.price_source ?? null) : null,
    included: e.tag === "subscription",
    cheapest: false,
  };
}

/** Rank against the query: 0 exact name, 1 name starts with it, 2 name contains it, 3 matched elsewhere. */
function rankOf(row: CatalogueRow, q: string): number {
  const n = lower(row.name);
  if (q === "") return 3;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

/** Every word of the query appears somewhere in the row: its name, maker, key, or a place's provider or id. */
function matches(row: CatalogueRow, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = [row.name, row.maker, row.key, ...row.places.flatMap((p) => [p.provider, p.model])].map(lower).join("\n");
  return words.every((w) => hay.includes(w));
}

/**
 * Group what the switched-on providers serve by MODEL (C131).
 *
 * A mapped id joins its identity's row as one more place; an unmapped id is
 * a row of its own under its provider's name — keyed `<provider>/<model>`,
 * so the same unmapped string on two providers is TWO rows, because nothing
 * here knows they are the same model. `query` filters (every word must
 * appear) and orders the rows best match first; an empty query lists
 * everything, alphabetically, mapped models before unmapped ids.
 */
export function groupCatalogue(entries: readonly CatalogueEntry[], table: ModelIdentities, opts: { query?: string | undefined } = {}): CatalogueRow[] {
  const index = identityIndex(table);
  const rows = new Map<string, CatalogueRow>();
  for (const e of entries) {
    const key = index.get(e.model.toLowerCase());
    const identity = key !== undefined ? table.models[key] : undefined;
    const rowKey = identity && key !== undefined ? key : `${e.provider}/${e.model}`;
    let row = rows.get(rowKey);
    if (!row) {
      row = identity
        ? { kind: "model", key: rowKey, name: identity.name, maker: identity.maker, context: identity.context ?? null, capabilities: [...identity.capabilities], places: [], summary: { local: false, cloud: false, from_in_per_m: null } }
        : { kind: "unmapped", key: rowKey, name: e.listed_name?.trim() || e.model, maker: null, context: null, capabilities: [], places: [], summary: { local: false, cloud: false, from_in_per_m: null } };
      rows.set(rowKey, row);
    }
    if (row.places.some((p) => p.provider === e.provider && p.model === e.model)) continue;
    row.places.push(placeOf(e));
    if (row.context === null && e.context !== undefined) row.context = e.context;
    if (e.tools && !row.capabilities.includes("tools")) row.capabilities.push("tools");
  }

  for (const row of rows.values()) {
    // local first, then cloud, then subscription; by price, then provider
    const order = { local: 0, cloud: 1, subscription: 2 } as const;
    row.places.sort((a, b) => order[a.tag] - order[b.tag] || (a.in_per_m ?? Infinity) + (a.out_per_m ?? 0) - ((b.in_per_m ?? Infinity) + (b.out_per_m ?? 0)) || a.ref.localeCompare(b.ref));
    const priced = row.places.filter((p) => p.in_per_m !== null && p.out_per_m !== null);
    if (priced.length >= 2) {
      const best = priced.reduce((m, p) => (p.in_per_m! + p.out_per_m! < m.in_per_m! + m.out_per_m! ? p : m));
      best.cheapest = true;
    }
    row.summary = {
      local: row.places.some((p) => p.tag === "local"),
      cloud: row.places.some((p) => p.tag !== "local"),
      from_in_per_m: priced.length > 0 ? Math.min(...priced.map((p) => p.in_per_m!)) : null,
    };
  }

  const q = (opts.query ?? "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return [...rows.values()]
    .filter((r) => matches(r, words))
    .sort((a, b) => rankOf(a, q) - rankOf(b, q) || (a.kind === b.kind ? 0 : a.kind === "model" ? -1 : 1) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
