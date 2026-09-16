// `compute.yaml` — one file for providers, assignments and budgets
// (docs/research/2026-09-11-local-models-openrouter-opencode.md, C1 in
// docs/plan-refresh-2026-09-13.md §1).
//
// Where work runs and what it may cost is how the system behaves, so the
// file is a §4.7 protected path in the instance repo, written as the `user`
// principal (invariant 2) and never by the assistant. A provider is
// therefore CONFIGURATION, not a component — and invariant 5 ("everything
// is a directory with a manifest") is met the way it is met for
// `deployment.yaml`: by a schema in `packages/core` that the CLI, CI and
// the app all validate against, rather than by a second manifest kind.
//
// This module is the schema and the pure resolution rules. It reads no
// environment and opens no file by itself: every path comes in as an
// argument and every side of the world (reading a file, watching one) is a
// seam, so the same code runs in the console, in the assistant, in the CLI
// and in a test with nothing on disk.
//
// What is deliberately NOT here: making a call, counting a token, or
// enforcing a budget. Those are the engine's (PR 3). A budget in this file
// is recorded and validated; nothing yet refuses a call because of one.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { dataPolicySchema } from "./manifest.js";
import { DEFAULT_TIER, EFFORTS, type Effort, type TierMap } from "./tiers.js";

/** The file's name wherever it lives — the instance repo's root, and `seed/`. */
export const COMPUTE_FILENAME = "compute.yaml";

/**
 * The D4 overlay default: the product's seed first, the instance's own file
 * after it. LAST EXISTING FILE WINS, whole — the same rule (and the same
 * spelling) as `METISTRY_RULES_FILES`, so there is no deep merge to reason
 * about and an instance file is always self-contained.
 */
export const COMPUTE_FILES_DEFAULT = `seed/${COMPUTE_FILENAME}:${COMPUTE_FILENAME}`;

/**
 * One engine, one wire protocol (C2). `kind` stays a field rather than
 * being dropped because a later provider kind (a bundled `llama-server`
 * with GBNF grammars, C15) is then an additive change to this list instead
 * of a schema rewrite — and because a file that names an unknown kind must
 * fail loudly rather than be treated as OpenAI-shaped.
 */
export const PROVIDER_KINDS = ["openai-compatible"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Whether tokens leave this machine. `on_machine` costs nothing and needs no data policy; `off_machine` must declare one. */
export const LOCALITIES = ["on_machine", "off_machine"] as const;
export type Locality = (typeof LOCALITIES)[number];

/** What a budget does when its window is spent (C5). Enforcement is the engine's (PR 3); this file is where the choice is recorded. */
export const BUDGET_ACTIONS = ["allow", "stop", "critical_only"] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

/** `stop` by default: an unstated budget action must be the safe one (C5). */
export const DEFAULT_BUDGET_ACTION: BudgetAction = "stop";

/** An environment-variable NAME. A value can never match it, which is the point. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Provider names are lowercase kebab-case — the casing rule: only `Knowledge/` is TitleCase. */
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** Tier and crew names, the same spelling `tiersSchema` already enforces. */
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

// ---- model references --------------------------------------------------------

export interface ModelRef {
  /** the first segment: a provider named in THIS file */
  provider: string;
  /** everything after it, verbatim — LM Studio and OpenRouter ids contain slashes */
  model: string;
  /** the `<provider>/<id>` string as written */
  ref: string;
}

/**
 * Why a string is not a usable model reference, or undefined when it is.
 * Returned as a message rather than thrown so the schema, the CLI's
 * argument parsing and the app can all refuse in the same words.
 *
 * `/auto` and anything list-shaped are refused outright: invariant 4 says
 * the router is deterministic — no model decides which model runs — and an
 * auto-router or a fallback list hands that choice to the provider.
 */
export function modelRefIssue(ref: string): string | undefined {
  if (ref.trim() !== ref || ref === "") return "must not be empty or padded with spaces";
  if (/\s/.test(ref)) return `${JSON.stringify(ref)} contains whitespace — a model reference is one \`<provider>/<model-id>\` token`;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return `${JSON.stringify(ref)} is not \`<provider>/<model-id>\` — pin the provider that serves it (e.g. openrouter/anthropic/claude-sonnet-5), so nothing has to guess where it runs`;
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (!PROVIDER_NAME_RE.test(provider)) return `provider ${JSON.stringify(provider)} is not a provider name (lowercase, digits, - and _, starting with a letter)`;
  if (model.split("/").includes("auto") || model.endsWith(":auto")) {
    return `${JSON.stringify(ref)} names an auto-router — pin one model instead (invariant 4: the router is deterministic; no model decides which model runs)`;
  }
  return undefined;
}

/** Split a validated reference. Throws with the same message the schema would give. */
export function parseModelRef(ref: string): ModelRef {
  const why = modelRefIssue(ref);
  if (why) throw new Error(`model: ${why}`);
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), ref };
}

const modelRefSchema = z
  .string({
    error: (iss) =>
      iss.code === "invalid_type"
        ? "must be ONE pinned `<provider>/<model-id>` string — a list of fallbacks is refused (invariant 4: the router is deterministic; no model decides which model runs)"
        : undefined,
  })
  .superRefine((ref, ctx) => {
    const why = modelRefIssue(ref);
    if (why) ctx.addIssue({ code: "custom", message: why });
  });

// ---- providers ---------------------------------------------------------------

const baseUrl = z
  .string()
  .refine((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "base_url must be an http(s) URL ending at the API root, e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:1234/v1");

const authSchema = z.strictObject({
  /**
   * The NAME of a Keychain item, never a value (C6: provider secrets are
   * user scope). The casing rule is what makes a pasted key impossible to
   * mistake for a name — `sk-or-v1-…` cannot match it.
   */
  secret: z.string().regex(SECRET_NAME_RE, "auth.secret is the NAME of a secret (UPPER_SNAKE_CASE, e.g. METISTRY_OPENROUTER_API_KEY), never the key itself — `metistry compute providers add` puts the value in the login Keychain"),
});

/** Published rates, per million tokens — the cost source for providers whose responses do not carry one (Zen and other clouds). */
const pricingSchema = z.strictObject({
  in_per_m: z.number().nonnegative(),
  out_per_m: z.number().nonnegative(),
});

export const providerSchema = z.strictObject({
  kind: z.enum(PROVIDER_KINDS, { error: `kind must be one of ${PROVIDER_KINDS.join(", ")} — one engine, one wire protocol (C2)` }),
  base_url: baseUrl,
  locality: z.enum(LOCALITIES, { error: `locality must be ${LOCALITIES.join(" or ")} — it is what decides whether a data policy is required` }),
  auth: authSchema.optional(),
  /**
   * Zero data retention, as the provider states it. `false` or absent on an
   * `off_machine` provider is an informed choice, never a block (C13): the
   * engine writes one warning row and the app shows a badge.
   */
  zdr: z.boolean().optional(),
  /** Extra body fields sent verbatim with every request — e.g. OpenRouter's `provider: { order: [anthropic], allow_fallbacks: false }`. */
  request: z.record(z.string(), z.unknown()).optional(),
  /** Required for `off_machine` (checked below): what a brief bound for this provider may carry (§4.18.B, the target schema, reused). */
  data_policy: dataPolicySchema.optional(),
  /** model id → published rates. Only needed where the response carries no cost. */
  pricing: z.record(z.string().min(1), pricingSchema).optional(),
});

export type Provider = z.infer<typeof providerSchema>;

// ---- assignments -------------------------------------------------------------

export const assignmentSchema = z.strictObject({
  model: modelRefSchema,
  /** Absent = medium, exactly as `tierSchema` already defaults it: effort is the other half of the model choice, not a separate knob. */
  effort: z.enum(EFFORTS).default("medium"),
  /**
   * Marks work that keeps running under `action: critical_only`. Recorded
   * only: WHAT may be marked critical is OPEN-4, and enforcement is the
   * engine's (PR 3), so nothing in this repo reads it yet.
   */
  critical: z.boolean().optional(),
});

export type Assignment = z.infer<typeof assignmentSchema>;

export const assignmentsSchema = z.strictObject({
  /** Where every unnamed and unknown tier lands. Required whenever `assignments:` is present — a half-assigned file would silently fall back to `rules.yaml` for some turns and not others. */
  default: assignmentSchema,
  tiers: z.record(z.string().regex(NAME_RE, "tier names are lowercase kebab-case (casing rule: only Knowledge/ is TitleCase)"), assignmentSchema).default({}),
  crews: z.record(z.string().regex(NAME_RE, "crew names are lowercase kebab-case (casing rule: only Knowledge/ is TitleCase)"), assignmentSchema).default({}),
});

export type Assignments = z.infer<typeof assignmentsSchema>;

// ---- budgets -----------------------------------------------------------------

export const budgetSchema = z
  .strictObject({
    daily_usd: z.number().positive().optional(),
    monthly_usd: z.number().positive().optional(),
    action: z.enum(BUDGET_ACTIONS, { error: `action must be ${BUDGET_ACTIONS.join(" | ")} (C5)` }).default(DEFAULT_BUDGET_ACTION),
  })
  .superRefine((b, ctx) => {
    if (b.daily_usd === undefined && b.monthly_usd === undefined) {
      ctx.addIssue({ code: "custom", message: "a budget needs daily_usd or monthly_usd — an action with no limit never fires" });
    }
  });

export type Budget = z.infer<typeof budgetSchema>;

export const budgetsSchema = z.strictObject({
  /** Every provider together. */
  instance: budgetSchema.optional(),
  /** One provider's own window, checked alongside the instance's. */
  providers: z.record(z.string().regex(PROVIDER_NAME_RE, "provider names are lowercase kebab-case"), budgetSchema).default({}),
});

export type Budgets = z.infer<typeof budgetsSchema>;

// ---- the file ----------------------------------------------------------------

export const computeSchema = z
  .strictObject({
    providers: z.record(z.string().regex(PROVIDER_NAME_RE, "provider names are lowercase kebab-case (casing rule: only Knowledge/ is TitleCase)"), providerSchema).default({}),
    /** Absent = this file assigns nothing and `rules.yaml`'s `tiers:` still decides (the transition, until the engine lands). */
    assignments: assignmentsSchema.optional(),
    budgets: budgetsSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    // off_machine must declare what may leave the machine. Checked here
    // rather than on providerSchema so the issue can carry the provider's
    // own name in its path — a refusal names the field that would permit it.
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (p.locality === "off_machine" && p.data_policy === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "data_policy"],
          message: `provider ${name} is off_machine, so it must declare data_policy { allow, deny_sources, max_brief_bytes } — what may leave this machine is a declaration, not a default`,
        });
      }
    }
    // Every model reference names a provider IN THIS FILE. The overlay
    // replaces a file whole, so there is no other file it could mean.
    const known = Object.keys(cfg.providers);
    const check = (ref: string, path: (string | number)[]): void => {
      if (modelRefIssue(ref)) return; // already reported by the field's own schema
      const provider = ref.slice(0, ref.indexOf("/"));
      if (!Object.hasOwn(cfg.providers, provider)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `provider ${JSON.stringify(provider)} is not declared in this file's providers: (${known.join(", ") || "none"}) — add it with \`metistry compute providers add --from <template>\``,
        });
      }
    };
    if (cfg.assignments) {
      check(cfg.assignments.default.model, ["assignments", "default", "model"]);
      for (const [name, a] of Object.entries(cfg.assignments.tiers)) {
        if (name === DEFAULT_TIER) {
          ctx.addIssue({
            code: "custom",
            path: ["assignments", "tiers", name],
            message: `the default assignment is \`assignments.default\`, not a tier named ${DEFAULT_TIER} — one place, so an unknown tier can only resolve one way`,
          });
        }
        check(a.model, ["assignments", "tiers", name, "model"]);
      }
      for (const [name, a] of Object.entries(cfg.assignments.crews)) check(a.model, ["assignments", "crews", name, "model"]);
    }
    for (const name of Object.keys(cfg.budgets?.providers ?? {})) {
      if (!Object.hasOwn(cfg.providers, name)) {
        ctx.addIssue({
          code: "custom",
          path: ["budgets", "providers", name],
          message: `budgets.providers.${name} budgets a provider this file does not declare (${known.join(", ") || "none"})`,
        });
      }
    }
  });

export type Compute = z.infer<typeof computeSchema>;

export type ComputeResult = { ok: true; compute: Compute } | { ok: false; errors: string[] };

/** Validate an already-parsed object, reporting every issue with the field that caused it — the shape `validateManifest` uses. */
export function validateCompute(input: unknown): ComputeResult {
  const parsed = computeSchema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, compute: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** Parse `compute.yaml`'s text. Throws with every issue at once — a bad compute file is a startup failure, not a silent default (the way `parseTiers` is). */
export function parseCompute(text: string): Compute {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid ${COMPUTE_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = validateCompute(doc ?? {});
  if (!r.ok) throw new Error(`invalid ${COMPUTE_FILENAME}: ${r.errors.join("; ")}`);
  return r.compute;
}

/** An empty, valid configuration: no providers, no assignments, no budgets. What a file of nothing but comments parses to. */
export function emptyCompute(): Compute {
  return computeSchema.parse({});
}

/** True when this file assigns nothing, so `rules.yaml`'s `tiers:` is still the live map. */
export function assignsNothing(cfg: Compute): boolean {
  return cfg.assignments === undefined;
}

// ---- resolution --------------------------------------------------------------

export interface ResolvedAssignment extends ModelRef {
  effort: Effort;
  /** the key that actually applied — `default` when the name was unknown, never the name that was asked for */
  from: string;
  /** the provider's block, so a caller never has to look it up again */
  config: Provider;
  critical: boolean;
}

/**
 * Resolve a tier name, `crew:<name>`, or `default` to (provider, model,
 * effort). Undefined when this file assigns nothing — the caller then falls
 * back to `rules.yaml`'s `tiers:`, which is what keeps every install working
 * before the engine lands.
 *
 * An unknown name resolves to `default`, never to an invented model: the
 * same rule `resolveTier` follows, for the same reason.
 */
export function resolveAssignment(cfg: Compute, tierOrCrew?: string | null): ResolvedAssignment | undefined {
  const a = cfg.assignments;
  if (!a) return undefined;
  const name = typeof tierOrCrew === "string" ? tierOrCrew : DEFAULT_TIER;
  const crew = name.startsWith("crew:") ? name.slice("crew:".length) : undefined;
  const picked =
    crew !== undefined
      ? Object.hasOwn(a.crews, crew)
        ? ([`crew:${crew}`, a.crews[crew]!] as const)
        : ([DEFAULT_TIER, a.default] as const)
      : Object.hasOwn(a.tiers, name)
        ? ([name, a.tiers[name]!] as const)
        : ([DEFAULT_TIER, a.default] as const);
  const [from, assignment] = picked;
  const ref = parseModelRef(assignment.model);
  return { ...ref, effort: assignment.effort, from, config: cfg.providers[ref.provider]!, critical: assignment.critical === true };
}

/**
 * `assignments` as the (model, effort) map the router and the drain already
 * read, or undefined when this file assigns nothing. The model is the full
 * pinned `<provider>/<id>` reference: one string that says where it runs,
 * which is what the engine (PR 3) splits again at the point of the call.
 *
 * This is the whole of what `compute.yaml` changes about routing in this PR
 * — `resolveTier` reads the assignments when they are there and `rules.yaml`
 * when they are not. Nothing else about how a turn runs moves yet.
 */
export function computeTiers(cfg: Compute): TierMap | undefined {
  const a = cfg.assignments;
  if (!a) return undefined;
  const out: TierMap = { [DEFAULT_TIER]: { model: a.default.model, effort: a.default.effort } };
  for (const [name, t] of Object.entries(a.tiers)) out[name] = { model: t.model, effort: t.effort };
  return out;
}

// ---- loading, with the D4 overlay --------------------------------------------

export interface LoadedCompute {
  compute: Compute;
  /** the file the configuration came from; absent = none of the candidates existed */
  path?: string;
}

/** Read a file as text. The seam every loader takes, so a test needs nothing on disk. */
export type ReadFile = (path: string) => Promise<string>;

const realReadFile: ReadFile = (p) => readFile(p, "utf8");

/** The candidate paths of a colon-separated overlay, in order. */
export function computePaths(paths: string): string[] {
  return paths.split(":").filter(Boolean);
}

/**
 * Load the LAST existing file of the overlay (D4). A missing file is
 * skipped; a file that exists but is invalid throws, because a startup that
 * quietly ran on the seed's defaults after the operator wrote a broken file
 * would be the worst of both.
 */
export async function loadCompute(paths: string, readFileFn: ReadFile = realReadFile): Promise<LoadedCompute> {
  let loaded: LoadedCompute | undefined;
  for (const p of computePaths(paths)) {
    let text: string;
    try {
      text = await readFileFn(p);
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "EISDIR") continue;
      throw err;
    }
    try {
      loaded = { compute: parseCompute(text), path: p };
    } catch (err) {
      throw new Error(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return loaded ?? { compute: emptyCompute() };
}

// ---- hot reload --------------------------------------------------------------

export interface ComputeReload {
  ok: boolean;
  /** the file the configuration IN FORCE came from — on a failure, the last good one */
  path?: string;
  /** the file that failed to parse, on a failure */
  failedPath?: string;
  errors?: string[];
  /** true when the configuration in force actually changed */
  changed: boolean;
}

/** What the console and the assistant hold: the last configuration that parsed, and nothing else. */
export class ComputeStore {
  #loaded: LoadedCompute;

  constructor(initial: LoadedCompute) {
    this.#loaded = initial;
  }

  get current(): Compute {
    return this.#loaded.compute;
  }

  get path(): string | undefined {
    return this.#loaded.path;
  }

  /**
   * Re-read the overlay. A valid parse swaps the configuration atomically —
   * one assignment, so no reader can ever see half of a file. An invalid one
   * KEEPS THE LAST GOOD configuration and reports why: an editor's
   * half-written save must not take the engine's assignments away.
   */
  async reload(paths: string, readFileFn: ReadFile = realReadFile): Promise<ComputeReload> {
    let next: LoadedCompute;
    try {
      next = await loadCompute(paths, readFileFn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedPath = message.slice(0, Math.max(0, message.indexOf(": ")));
      return {
        ok: false,
        ...(this.#loaded.path ? { path: this.#loaded.path } : {}),
        ...(failedPath ? { failedPath } : {}),
        errors: [message],
        changed: false,
      };
    }
    const changed = JSON.stringify(next.compute) !== JSON.stringify(this.#loaded.compute) || next.path !== this.#loaded.path;
    this.#loaded = next; // the atomic swap: one assignment, never a mutation in place
    return { ok: true, ...(next.path ? { path: next.path } : {}), changed };
  }
}

/**
 * A file watcher: given the paths to watch and a callback, return a close
 * function. A seam because the implementation is `chokidar` (pre-approved),
 * which belongs to the two apps that run as services and not to this
 * package, which a stranger installs for the manifest schema.
 */
export type WatchSeam = (paths: string[], onChange: () => void) => () => void | Promise<void>;

export interface ComputeWatchOptions {
  /** colon-separated overlay, e.g. `METISTRY_COMPUTE_FILES` */
  paths: string;
  watch?: WatchSeam | undefined;
  readFileFn?: ReadFile | undefined;
  /** editors and `git checkout` fire several events per save; coalesce them */
  debounceMs?: number | undefined;
  /** called after every re-read, valid or not — where a `runs` warning row is written */
  onReload?: ((r: ComputeReload) => void) | undefined;
}

export interface ComputeWatch {
  store: ComputeStore;
  /** re-read now; what the debounced watcher calls, exported so a test drives it without timers */
  reload(): Promise<ComputeReload>;
  close(): Promise<void>;
}

/**
 * Load once, then watch. The initial load THROWS on an invalid file
 * (startup fails loudly, as `tiers.ts` does); every later one keeps the
 * last good configuration instead.
 */
export async function startComputeWatch(opts: ComputeWatchOptions): Promise<ComputeWatch> {
  const readFileFn = opts.readFileFn ?? realReadFile;
  const store = new ComputeStore(await loadCompute(opts.paths, readFileFn));
  const reload = async (): Promise<ComputeReload> => {
    const r = await store.reload(opts.paths, readFileFn);
    opts.onReload?.(r);
    return r;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closer: (() => void | Promise<void>) | undefined;
  if (opts.watch) {
    closer = opts.watch(computePaths(opts.paths), () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, opts.debounceMs ?? 100);
      timer.unref?.();
    });
  }
  return {
    store,
    reload,
    async close() {
      if (timer) clearTimeout(timer);
      await closer?.();
    },
  };
}
