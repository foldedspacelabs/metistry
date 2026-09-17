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
import { INSTANCE_LAYOUT } from "./instance-layout.js";
import { dataPolicySchema } from "./manifest.js";
import { PROVIDER_NAME_RE, modelRefIssue, parseModelRef, type ModelRef } from "./model-ref.js";
import { DEFAULT_TIER, EFFORTS, type Effort, type TierMap } from "./tiers.js";

/** The file's name wherever it lives — the instance's `.metistry/`, and `seed/`. */
export const COMPUTE_FILENAME = "compute.yaml";

/**
 * The D4 overlay default: the product's seed first, the instance's own file
 * after it. LAST EXISTING FILE WINS, whole — the same rule (and the same
 * spelling) as `METISTRY_RULES_FILES`, so there is no deep merge to reason
 * about and an instance file is always self-contained.
 */
export const COMPUTE_FILES_DEFAULT = `seed/${COMPUTE_FILENAME}:${INSTANCE_LAYOUT.compute}`;

/** The same overlay rule for `rules.yaml` (`METISTRY_RULES_FILES`) — the router's tier map. Here so the console and the engine cannot disagree about where it lives. */
export const RULES_FILES_DEFAULT = `seed/rules.yaml:${INSTANCE_LAYOUT.rules}`;

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

/** Tier and crew names, the same spelling `tiersSchema` already enforces. */
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

// ---- model references --------------------------------------------------------
//
// The rule itself lives in `model-ref.ts` — `manifest.ts` needs it too (a
// collector's `uses_model:`) and this file needs `manifest.ts`, so the
// shared half sits under both. Re-exported here because this is where every
// caller already imports it from.

export { PROVIDER_NAME_RE, modelRefIssue, parseModelRef, type ModelRef };

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

/**
 * The local server runtimes Metistry RUNS ITSELF — the two whose lifecycle
 * this install owns:
 *
 *   `llamaserver` the `llama-server` built into the bundled runtime pack
 *                 (`ops/release/build-runtime-deps.sh`,
 *                 docs/ops/bundled-runtime.md), so a fresh Mac has a local
 *                 model without being sent to install a second app. `up`
 *                 renders a supervisor child for it from the `serve:` block.
 *   `applefm`     the `apple-fm` bridge's OpenAI-compatible `/v1` surface
 *                 over Apple Foundation Models (PoC-19). No new process:
 *                 the bridge is ALREADY a supervised service, so this
 *                 `serve:` block starts nothing — it declares that the
 *                 provider on the other end of `base_url` is Metistry's own,
 *                 which is what keeps its port honest (checked below) and
 *                 tells `up` not to look for a second one.
 *
 * LM Studio and Ollama are deliberately NOT in this list. They are peers,
 * discovered over `/v1/models` like any other provider — Metistry uses them
 * where they are already running and never claims their lifecycle.
 */
export const SERVE_RUNTIMES = ["llamaserver", "applefm"] as const;
export type ServeRuntime = (typeof SERVE_RUNTIMES)[number];

/** A GGUF path under the instance, or an absolute one. Never a URL: what is loaded into memory is a file on this machine. */
const MODEL_PATH_RE = /^[^\0]+\.gguf$/i;

/**
 * `serve:` — ADDITIVE, and optional everywhere. A provider WITHOUT it is
 * exactly what PR 1 shipped: a base URL somebody else is listening on. A
 * provider WITH it says "this one is mine to run", and `metistry up` renders
 * a supervisor child for it beside the console and the reconciler.
 *
 * Nothing here decides anything a model could: the runtime is an enum of one
 * and the port must be the port the `base_url` already names, so a served
 * provider cannot be dialled anywhere other than where it listens.
 */
export const serveSchema = z
  .strictObject({
    runtime: z.enum(SERVE_RUNTIMES, { error: `serve.runtime must be one of ${SERVE_RUNTIMES.join(", ")} — LM Studio and Ollama are peers discovered over /v1/models, never processes Metistry starts` }),
    /** the GGUF this server loads; relative paths resolve against the INSTANCE directory, which is where `compute models install` puts them. `llamaserver` only — `applefm` loads nothing from disk. */
    model_path: z.string().regex(MODEL_PATH_RE, "serve.model_path is the path of a .gguf file (relative to the instance directory, or absolute) — `metistry compute models install <provider>/<hf-repo>/<file.gguf>` downloads one and fills this in").optional(),
    port: z.number().int().min(1).max(65535),
    /** passed verbatim after the flags this product sets; a way to tune context size or slots without a schema change. `llamaserver` only. */
    extra_args: z.array(z.string().min(1)).default([]),
  })
  // Each runtime takes exactly the fields that mean something to it. A
  // `model_path` under `applefm` is not a harmless extra line: it would read
  // as "this is the model it loads", and nothing would ever load it.
  .superRefine((s, ctx) => {
    if (s.runtime === "llamaserver" && s.model_path === undefined) {
      ctx.addIssue({ code: "custom", path: ["model_path"], message: "serve.runtime: llamaserver needs serve.model_path — `metistry compute models install <provider>/<owner>/<repo>/<file>.gguf` downloads a GGUF and fills it in" });
    }
    if (s.runtime === "applefm") {
      if (s.model_path !== undefined) {
        ctx.addIssue({ code: "custom", path: ["model_path"], message: "serve.runtime: applefm loads no file: the model is the operating system's, already resident. Remove serve.model_path." });
      }
      if (s.extra_args.length > 0) {
        ctx.addIssue({ code: "custom", path: ["extra_args"], message: "serve.runtime: applefm starts no process, so there is no argv to extend. Remove serve.extra_args." });
      }
    }
  });

export type Serve = z.infer<typeof serveSchema>;

/** A `serve:` block that really does name a GGUF — what `llamaServerChild` needs and what the schema above guarantees for `runtime: llamaserver`. */
export type LlamaServe = Serve & { model_path: string };

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
  /** present = Metistry runs this server itself (the bundled `llama-server`); absent = somebody else is listening there */
  serve: serveSchema.optional(),
})
  .superRefine((p, ctx) => {
    if (!p.serve) return;
    if (p.locality !== "on_machine") {
      ctx.addIssue({ code: "custom", path: ["serve"], message: `serve: is how a provider says Metistry starts it, so it only makes sense with locality: on_machine (this one is ${p.locality})` });
    }
    // The port is stated twice — once as the URL callers dial, once as the
    // port the process binds — so it is checked once, here, rather than
    // discovered as a connection refused at the first turn.
    let port: string;
    try {
      const u = new URL(p.base_url);
      port = u.port || (u.protocol === "https:" ? "443" : "80");
    } catch {
      return; // base_url already failed its own check
    }
    if (port !== String(p.serve.port)) {
      ctx.addIssue({ code: "custom", path: ["serve", "port"], message: `serve.port is ${p.serve.port} but base_url dials port ${port} — a server Metistry starts must be dialled where it listens` });
    }
  });

export type Provider = z.infer<typeof providerSchema>;

/** Every provider this file says Metistry starts itself, in declaration order. `up` renders one supervisor child per entry. */
export function servedProviders(cfg: Compute): Array<{ name: string; provider: Provider; serve: Serve }> {
  return Object.entries(cfg.providers)
    .filter((e): e is [string, Provider & { serve: Serve }] => e[1].serve !== undefined)
    .map(([name, provider]) => ({ name, provider, serve: provider.serve }));
}

// ---- the collector rule (plan §"collectors never call a billable model") -----

/**
 * Why this collector may not call this model, or undefined when it may.
 *
 * A collector runs unattended, on a clock, with nobody reading the result
 * until later. The plan's rule has always been "collectors never call a
 * BILLABLE model; a free on-device tier is permitted" (ruled 2026-09-01 for
 * `inbox-drain`); since the refresh made Apple FM and `llama-server`
 * ordinary providers, that rule becomes mechanical — one condition on the
 * provider a collector names.
 *
 * The condition is `locality: on_machine`, and that is the whole of it: cost
 * for an on-machine provider is not a field anyone fills in, it is 0 BY
 * DEFINITION (`cost.ts`, `cost_source: "local"`). A second "and cost must be
 * 0" check would be theatre — there is no way to write a billing rate that
 * an on-machine provider would be charged at.
 *
 * `undefined` for a provider this file does not declare is deliberate and is
 * NOT the caller's cue to call something else: `completeJson` treats an
 * undeclared provider as "no model tier configured" and takes the
 * deterministic path. A name that is declared and billable is the case this
 * refuses, loudly, in CI and again at the call.
 */
export function collectorProviderIssue(collector: string, providerName: string, provider: Provider | undefined): string | undefined {
  if (!provider) return undefined;
  if (provider.locality !== "on_machine") {
    return (
      `${collector} names ${providerName}, which is locality: ${provider.locality} — a collector runs unattended on a schedule and may only call an on_machine provider, ` +
      `whose calls cost 0 by definition (docs/ops/compute.md "Apple Foundation Models"). ` +
      `Point providers.${providerName} at a local server, or drop uses_model: from ${collector}/manifest.yaml and let it stay deterministic.`
    );
  }
  return undefined;
}

/**
 * The first `on_machine` provider's API root, in declaration order — the
 * embedder's default when nothing names a URL (C18). Undefined when this
 * file declares no local provider at all.
 */
export function firstOnMachineBaseUrl(cfg: Compute): string | undefined {
  return Object.values(cfg.providers).find((p) => p.locality === "on_machine")?.base_url;
}

// ---- assignments -------------------------------------------------------------

/**
 * `shadow:` — stage 2 of the bake-off (§3.7), as configuration.
 *
 * A fraction of the turns this assignment serves are run a SECOND time on a
 * candidate model, with every tool call stubbed record-only, purely to
 * measure agreement. The candidate's answer is stored and never shown: the
 * user's answer is always the assignment's (invariant 4 — this block cannot
 * change which model answers, only which model is measured).
 *
 * `fraction` has NO default on purpose. The rate IS the spend — a shadow
 * block with an implied rate would pick somebody's bill for them — so the
 * file has to say it. `0` is a legal way to stage the block in with nothing
 * running.
 */
export const shadowSchema = z.strictObject({
  model: modelRefSchema,
  fraction: z
    .number({ error: "shadow.fraction is required: the fraction of this assignment's turns to shadow, 0..1 (0.1 = one turn in ten). It has no default because the rate is the spend." })
    .min(0, "shadow.fraction is a fraction between 0 and 1 — 0 stages the block in with nothing running")
    .max(1, "shadow.fraction is a fraction between 0 and 1 — 1 shadows every turn, which is the most that can be spent"),
});

export type Shadow = z.infer<typeof shadowSchema>;

export const assignmentSchema = z.strictObject({
  model: modelRefSchema,
  /** Absent = medium, exactly as `tierSchema` already defaults it: effort is the other half of the model choice, not a separate knob. */
  effort: z.enum(EFFORTS).default("medium"),
  /**
   * The one thing `action: critical_only` lets through (`checkBudgets`, and
   * the runner's `budgetMiss`). WHAT carries it was OPEN-4, ruled
   * 2026-09-17: the seed marks `assignments.default`, so an interactive turn
   * keeps being answered with the month's money spent while routines and
   * delegation stop. The mark travels with the ASSIGNMENT, so a tier or crew
   * that falls back to `default` inherits it — declare `tiers.routine` when
   * the pause is meant to apply to it.
   */
  critical: z.boolean().optional(),
  /** Stage-2 shadow mode. Only legal on `assignments.default` (checked below) — it is the only place the engine reads it. */
  shadow: shadowSchema.optional(),
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
    // `shadow:` is read in ONE place — the default assignment — so that is
    // the only place it may be written. A block on a tier or a crew would
    // parse, cost nothing, measure nothing, and look like it worked.
    const noShadowHere = (a: Assignment, kind: "tier" | "crew", name: string): void => {
      if (a.shadow === undefined) return;
      ctx.addIssue({
        code: "custom",
        path: ["assignments", kind === "tier" ? "tiers" : "crews", name, "shadow"],
        message: `shadow: is stage-2 shadow mode and the engine reads it on \`assignments.default\` only (docs/ops/compute.md "Shadow mode") — move it there, rather than leaving a block on the ${kind} ${name} that nothing runs`,
      });
    };
    if (cfg.assignments) {
      check(cfg.assignments.default.model, ["assignments", "default", "model"]);
      const shadow = cfg.assignments.default.shadow;
      if (shadow) {
        check(shadow.model, ["assignments", "default", "shadow", "model"]);
        // Shadowing the model that already answered buys no comparison and
        // doubles the turn's spend to produce it.
        if (shadow.model === cfg.assignments.default.model) {
          ctx.addIssue({
            code: "custom",
            path: ["assignments", "default", "shadow", "model"],
            message: `assignments.default.shadow.model is the model that already answers the turn (${shadow.model}) — a shadow of the same model measures nothing and doubles what the turn costs. Name the candidate you are considering instead.`,
          });
        }
      }
      for (const [name, a] of Object.entries(cfg.assignments.tiers)) {
        noShadowHere(a, "tier", name);
        if (name === DEFAULT_TIER) {
          ctx.addIssue({
            code: "custom",
            path: ["assignments", "tiers", name],
            message: `the default assignment is \`assignments.default\`, not a tier named ${DEFAULT_TIER} — one place, so an unknown tier can only resolve one way`,
          });
        }
        check(a.model, ["assignments", "tiers", name, "model"]);
      }
      for (const [name, a] of Object.entries(cfg.assignments.crews)) {
        noShadowHere(a, "crew", name);
        check(a.model, ["assignments", "crews", name, "model"]);
      }
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
  /** The stage-2 shadow candidate, resolved the same way. Present only where the file declared one (`assignments.default`). */
  shadow?: ResolvedShadow;
}

/** A shadow candidate, resolved to (provider, model) with its provider block and the rate it is sampled at. */
export interface ResolvedShadow extends ModelRef {
  /** 0..1, straight from the file: the share of this assignment's turns that are run a second time. */
  fraction: number;
  config: Provider;
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
  // The shadow travels with the assignment that carried it, so a turn that
  // FELL BACK to `default` is shadowed exactly like one that named it — which
  // is the whole population §3.7 stage 2 wants to measure.
  const shadow = assignment.shadow;
  return {
    ...ref,
    effort: assignment.effort,
    from,
    config: cfg.providers[ref.provider]!,
    critical: assignment.critical === true,
    ...(shadow ? { shadow: resolveShadow(cfg, shadow) } : {}),
  };
}

/** The `shadow:` block as (provider, model, fraction, provider block) — the same resolution the assignment itself gets. */
export function resolveShadow(cfg: Compute, shadow: Shadow): ResolvedShadow {
  const ref = parseModelRef(shadow.model);
  return { ...ref, fraction: shadow.fraction, config: cfg.providers[ref.provider]! };
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

// ---- is there an engine at all? ----------------------------------------------

/**
 * The ONE seam for "does this install have an engine": `up` (whether to
 * render the assistant child), `doctor` (the `assistant` row), the routine
 * runner's preflight (whether a turn would be answered) and — through the
 * supervisor's child list — the watchdog all ask it, and they must never
 * disagree.
 *
 * It used to be one environment variable. Since C2/C3 an engine is
 * configuration plus a credential: `assignments.default` says which provider
 * and model a turn runs on, and the provider's `auth.secret` names the
 * Keychain item whose value reaches the process as an environment variable
 * of that name. Either half missing = no engine, and that is a SUPPORTED
 * shape, not a fault: the assistant is the only component that needs a
 * model, so `up` leaves it out of the supervisor's children rather than
 * starting a child that could only crash-loop. Everything model-free
 * (captures, inbox-drain, tasks, search, the console) runs; a queued fold
 * turn waits.
 */
export interface EngineStatus {
  /** an engine can start */
  ok: boolean;
  /** what `default` resolved to, when `assignments.default` is there at all */
  assignment?: ResolvedAssignment;
  /** the secret NAME the default provider declares, when it declares one (a local server needs none) */
  secret?: string;
  /** why not, naming the field or the variable that is missing — never a bare "misconfigured" */
  why?: string;
  /** what to DO about it: one command */
  fix?: string;
}

export function engineStatus(cfg: Compute, env: NodeJS.ProcessEnv = process.env): EngineStatus {
  const assignment = resolveAssignment(cfg, DEFAULT_TIER);
  if (!assignment) {
    return {
      ok: false,
      why: `no assignments.default in ${COMPUTE_FILENAME} — nothing says which provider and model a turn runs on`,
      fix: "metistry compute assign default <provider/model>",
    };
  }
  const secret = assignment.config.auth?.secret;
  if (secret && (env[secret] ?? "").trim() === "") {
    return {
      ok: false,
      assignment,
      secret,
      why: `assignments.default runs on ${assignment.ref}, and providers.${assignment.provider}.auth.secret names ${secret}, which is unset here`,
      fix: `metistry compute providers add --from <template> --name ${assignment.provider} --secret ${secret}, then metistry secrets sync --to env`,
    };
  }
  return { ok: true, assignment, ...(secret ? { secret } : {}) };
}

/** The boolean every caller wants. `engineStatus` is for the ones that also want the sentence. */
export function engineConfigured(cfg: Compute, env: NodeJS.ProcessEnv = process.env): boolean {
  return engineStatus(cfg, env).ok;
}

// ---- the collaboration rule (C7) ---------------------------------------------

/**
 * One engine, one wire protocol (C2), so today this is `ProviderKind` and
 * nothing else: the Claude Agent SDK and its `anthropic` kind left the
 * product with the scrub. The type keeps its name because the collaboration
 * rule below is about KINDS rather than providers, and a second kind (a
 * `llama-server` with GBNF grammars, C15; a native Messages adapter) is then
 * an additive change here rather than a rewrite there.
 */
export type EngineKind = ProviderKind;

/**
 * Which engine kind serves this tier or `crew:<name>`, and `undefined` when
 * nothing assigns it — which now means "no engine runs this at all", not
 * "some other engine does". The whole of rule 1 ("engine is `provider.kind`
 * from config") in one function, so nothing has to derive it twice and
 * differently.
 */
export function engineKindFor(cfg: Compute, tierOrCrew?: string | null): EngineKind | undefined {
  return resolveAssignment(cfg, tierOrCrew)?.config.kind;
}

export interface CrossKindRefusal {
  /** The kind running the turn that asked. */
  from: EngineKind;
  /** The kind that would run the named agent. */
  to: EngineKind;
  message: string;
}

/**
 * Collaboration rule 4 (C7, owner decision 2026-09-11): a turn may SCOPE
 * work for anyone — an unassigned `work` row any agent can claim — but it
 * may not PUSH work to a named agent whose engine kind differs from its own.
 * Documenting work is collaboration; naming the worker is triggering it.
 *
 * Undefined when the push is allowed. The message names the field that
 * would permit it (R3): both sides are one line of `compute.yaml`.
 */
export function crossKindRefusal(cfg: Compute, caller: string | null | undefined, crew: string): CrossKindRefusal | undefined {
  const from = engineKindFor(cfg, caller ?? DEFAULT_TIER);
  const to = engineKindFor(cfg, `crew:${crew}`);
  // `assignments.default` is required whenever `assignments:` exists, so
  // `undefined` here means the file assigns NOTHING — both sides at once,
  // and a turn that never runs rather than a push to refuse.
  if (from === to || from === undefined || to === undefined) return undefined;
  const assigned = resolveAssignment(cfg, `crew:${crew}`);
  const where = assigned?.from === `crew:${crew}` ? `assignments.crews.${crew}` : "assignments.default";
  return {
    from,
    to,
    message:
      `a ${from} turn may not delegate directly to "${crew}", which runs on ${to} (${where} in compute.yaml). ` +
      `Create the work unassigned instead — any agent, this one included, can claim it from the same queue — ` +
      `or assign both sides to one engine kind by editing ${where}.`,
  };
}
