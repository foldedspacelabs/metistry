// `completeJson()` — the ONE way a collector calls a model.
//
// Collectors run unattended, on a clock, with nobody reading the answer
// until later. The plan's rule has always been "a collector never calls a
// BILLABLE model; a free on-device tier is permitted where the scenario
// warrants it" (ruled 2026-09-01 for inbox-drain). What changed with the
// compute refresh is that the free tier is now an ordinary provider — Apple
// Foundation Models and the bundled `llama-server` are `openai-compatible`
// entries at cost 0 — so the rule stops being a thing to remember and
// becomes a condition on a name.
//
// Four properties this module exists to hold:
//
//   * **One protocol.** `POST <base_url>/chat/completions` with
//     `response_format: json_schema`, the same call the engine makes, the
//     same call LM Studio and Ollama answer. No bridge-specific route, no
//     second client to keep in step.
//   * **The money rule is enforced HERE, not asked for in a comment.** A
//     collector whose `uses_model:` names a provider that is not
//     `locality: on_machine` THROWS, loudly, before any request is built.
//     CI refuses the same thing statically (`collectors/test/
//     collector-providers.test.ts`); this is the half that survives an
//     instance editing its own `compute.yaml` after CI has run.
//   * **Absent is not a failure.** No `uses_model:`, no such provider in
//     `compute.yaml`, no credential, a server that does not answer, an
//     answer that is not the schema — every one of those returns a reason
//     and the caller keeps its deterministic result. The only thing that
//     throws is the money rule.
//   * **Parse, never string-match.** PoC-19 measured 20 identical
//     generations coming back as 20 different byte strings: Apple's
//     `GeneratedContent.jsonString` does not emit object keys in a stable
//     order. Anything that hashed, regexed or compared raw model output
//     would see differences that are not there.
//
// REDACTION lands here too. The `apple-fm` bridge's `/classify` route
// scrubbed the model's free text before returning it (PoC-13's OTP lesson);
// its `/v1` route cannot, because a provider surface has to hand back
// exactly what the model said or `strict: true` was a lie. So the scrub
// moved one layer out: every string leaf of the parsed result goes through
// `scrubModelOutput` before any caller sees it. Same guarantee, one place,
// and now it covers every collector rather than one route.

import {
  choiceServerOf,
  collectorProviderIssue,
  parseModelRef,
  scoreChoiceOver,
  scrubModelOutput,
  type ChoiceFetch,
  type ChoiceOption,
  type ChoiceServer,
  type Compute,
  type ModelRef,
  type Provider,
} from "@foldedspacelabs/metistry-core";

/** A JSON Schema object, as `response_format.json_schema.schema` takes it. */
export type JsonSchema = Record<string, unknown>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What a collector needs from the world to make the call. Carried on `CollectorCtx`. */
export interface ComputeAccess {
  /** the configuration IN FORCE, as a getter — `compute.yaml` hot-reloads, and a collector that captured it at startup would keep calling a provider the operator removed */
  compute?: () => Compute;
  /** where a provider's `auth.secret` is resolved from (the console's own environment) */
  secretEnv?: NodeJS.ProcessEnv;
  /** the pinned `<provider>/<model-id>` from THIS collector's manifest, handed down by the runner */
  usesModel?: string;
  fetchFn?: typeof fetch;
}

export type JsonCompletion<T> =
  | { ok: true; value: T; provider: string; model: string; tokens_in: number; tokens_out: number }
  /** nothing was called, or the call did not produce a usable answer. The caller keeps whatever it had. */
  | { ok: false; why: string };

export interface CompleteJsonOptions {
  /** the collector's name, for the refusal messages */
  collector: string;
  schema: JsonSchema;
  /** the name the schema is announced under, as `json_schema.name` */
  schemaName: string;
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}

/** 60s: one on-device generation, not a conversation. The helper is serial, so a queued request waits behind at most one other. */
const DEFAULT_TIMEOUT_MS = 60_000; // limit: fixed — one generation on a resident local model; a longer wait is a hung server, not a slow one

const skip = (why: string): { ok: false; why: string } => ({ ok: false, why });

/** A model reference resolved against the `compute.yaml` in force, with everything a request needs. */
interface ResolvedCall {
  ref: ModelRef;
  provider: Provider;
  url: string;
  bearer: string | undefined;
}

/**
 * The half `completeJson` and `scoreChoice` share: the provider resolution,
 * the money rule, the bearer, and the URL.
 *
 * ONE implementation, because the money rule is the property this module
 * exists to hold and a second copy of it is a second place for it to be
 * wrong. THROWS for an off-machine provider — the one thing that does not
 * degrade — and returns a reason for everything else.
 */
function resolveCall(ctx: ComputeAccess, collector: string, modelRef: string | undefined, absent: string): ResolvedCall | { ok: false; why: string } {
  if (!modelRef) return skip(absent);
  const ref = parseModelRef(modelRef);
  const cfg = ctx.compute?.();
  const provider = cfg?.providers[ref.provider];

  const issue = collectorProviderIssue(collector, ref.provider, provider);
  if (issue) throw new Error(issue);

  if (!provider) {
    return skip(
      `compute.yaml declares no provider ${ref.provider}, so ${collector} has no on-device tier — ` +
        `\`metistry compute providers add --from ${ref.provider}\` if you want one (\`metistry doctor\` reports whether the server is answering)`,
    );
  }

  const secret = provider.auth?.secret;
  const bearer = secret ? ctx.secretEnv?.[secret] : undefined;
  if (secret && !bearer) {
    return skip(`providers.${ref.provider}.auth.secret names ${secret}, which is not in this process's environment — \`metistry secrets sync --to env\` and restart`);
  }

  return { ref, provider, url: `${provider.base_url.replace(/\/+$/, "")}/chat/completions`, bearer };
}

/**
 * Run one schema-constrained completion on the model this collector's
 * manifest pins, or say why nothing ran.
 *
 * THROWS only for the money rule — a `uses_model:` whose provider is
 * off-machine. That is a configuration error the operator has to see, and
 * the runner turns a thrown collector into a `runs` row and a Needs You
 * item; degrading quietly would mean an unattended job had started spending.
 */
export async function completeJson<T>(ctx: ComputeAccess, opts: CompleteJsonOptions): Promise<JsonCompletion<T>> {
  const resolved = resolveCall(ctx, opts.collector, ctx.usesModel, `${opts.collector} declares no uses_model: in its manifest, so it calls nothing`);
  if ("ok" in resolved) return resolved;
  const { ref, provider, url, bearer } = resolved;

  let res: Response;
  try {
    res = await (ctx.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({
        model: ref.model,
        messages: opts.messages,
        response_format: { type: "json_schema", json_schema: { name: opts.schemaName, strict: true, schema: opts.schema } },
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(provider.request ?? {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    return skip(`${url} did not answer (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) {
    // The provider's own message says which field it refused, and a
    // refusal that names nothing is useless to whoever reads the row.
    const body = await res.text().catch(() => "");
    return skip(`${url} → HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  let payload: {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    return skip(`${url} answered ${res.status} but not JSON`);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") return skip(`${url} answered with no message content`);

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return skip(`${ref.ref} answered with text that is not JSON, though the request pinned a schema`);
  }
  if (typeof value !== "object" || value === null) return skip(`${ref.ref} answered a JSON ${Array.isArray(value) ? "array" : typeof value}, not an object`);

  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ok: true,
    value: scrubLeaves(value) as T,
    provider: ref.provider,
    model: ref.model,
    tokens_in: n(payload.usage?.prompt_tokens),
    tokens_out: n(payload.usage?.completion_tokens),
  };
}

// ---- scoreChoice: the answer-token sibling (PoC-20 phase 1) -------------------
//
// `completeJson()` gains a sibling, on the SAME URL with different fields —
// which is the research's own wording (§2.5 note 5). Same provider
// resolution, same money rule, same bearer, same "absent is not a failure".
// What differs is the body: `max_tokens` 1 (or 2, per server), `logprobs:
// true`, `top_logprobs: N`, reasoning suppressed, and the answer read out of
// the returned distribution rather than out of generated JSON.
//
// Measured against the JSON-schema route on identical weights: **p50 155 ms
// against 336 ms**, 2.2× faster, plus a calibrated-looking confidence number
// the schema route cannot produce (§2.5, §2.4).
//
// The request itself is built in `packages/core`'s `choice.ts` rather than
// here, on purpose: the threshold this tier turns on is FITTED on the owner's
// fixtures by `metistry-eval intents`, and a threshold fitted against one
// request shape is not valid against another. One body-builder, two callers,
// same bytes.

export interface ScoreChoiceOptions {
  /** the collector's name, for the refusal messages and the money rule */
  collector: string;
  /** the pinned `<provider>/<model-id>` for THIS tier. Not `ctx.usesModel`: the intent tier is assigned in `compute.yaml`, not in the collector's manifest. */
  modelRef: string | undefined;
  /** what the model may answer, with descriptions (never bare names — research §2.3.1.1) */
  options: readonly ChoiceOption[];
  /** the one-token codes, generated from the option list by `codesFor` */
  codes: readonly string[];
  messages: ChatMessage[];
  /** how many top tokens to ask for; the server's own ceiling still applies. Default: one per option. */
  topLogprobs?: number;
  timeoutMs?: number;
}

export type ChoiceScore =
  | {
      ok: true;
      /** the option key the model put the most mass on — one of `options[].key`, never anything else */
      choice: string;
      code: string;
      /** TypeSafe's statistic over the renormalised distribution, clamped to [0,1] (research §2.2) */
      confidence: number;
      /** every option key → its renormalised probability */
      distribution: Record<string, number>;
      /** the share of the model's own top-N mass that landed inside the closed alphabet */
      alpha: number;
      /** how many options appeared in the returned top-N at all */
      covered: number;
      provider: string;
      model: string;
      /** which of the four local servers answered, where the provider block says so */
      server: ChoiceServer | undefined;
      latency_ms: number;
    }
  | { ok: false; why: string };

/**
 * Score one closed choice on the model `modelRef` names, or say why nothing
 * ran.
 *
 * Degrades exactly as `completeJson` does — no assignment, no such provider,
 * no credential, a server that does not answer, a server that answers without
 * logprobs, a distribution with no option code in it — and THROWS for the one
 * thing that must not degrade, an off-machine provider. `compute.yaml` refuses
 * that at load too (`assignments.intent`); this is the half that survives an
 * instance editing its own file after CI has run.
 *
 * No `scrubLeaves` on the answer, because there is no model free text in it:
 * the answer is one of the caller's own option keys and the rest is
 * arithmetic. The one textual thing a server CAN put in front of a caller is
 * an error body, which may echo the prompt — so that, and only that, is
 * scrubbed.
 */
export async function scoreChoice(ctx: ComputeAccess, opts: ScoreChoiceOptions): Promise<ChoiceScore> {
  const resolved = resolveCall(
    ctx,
    opts.collector,
    opts.modelRef,
    `compute.yaml assigns no model to the intent tier (assignments.intent), so ${opts.collector} scores nothing — the tier is off, which is a supported install`,
  );
  if ("ok" in resolved) return resolved;
  const { ref, provider, url, bearer } = resolved;

  const scored = await scoreChoiceOver({
    url,
    model: ref.model,
    messages: opts.messages,
    options: opts.options,
    codes: opts.codes,
    server: choiceServerOf(ref.provider, provider),
    bearer,
    ...(opts.topLogprobs !== undefined ? { topLogprobs: opts.topLogprobs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(provider.request ? { extra: provider.request } : {}),
    ...(ctx.fetchFn ? { fetchFn: ctx.fetchFn as unknown as ChoiceFetch } : {}),
  });
  if (!scored.ok) return skip(scrubModelOutput(scored.why));
  return {
    ok: true,
    choice: scored.key,
    code: scored.code,
    confidence: scored.confidence,
    distribution: scored.distribution,
    alpha: scored.alpha,
    covered: scored.covered,
    provider: ref.provider,
    model: ref.model,
    server: scored.server,
    latency_ms: scored.latency_ms,
  };
}

/**
 * `scrubModelOutput` over every string in a parsed result, however deep.
 * The deterministic redaction pass §4.3 requires of model output — an OTP,
 * a long digit run, an API key the model echoed out of the text it was
 * given — applied to the whole value rather than to one field somebody
 * remembered. Keys are left alone: they came from the caller's schema, not
 * from the model.
 */
export function scrubLeaves(value: unknown): unknown {
  if (typeof value === "string") return scrubModelOutput(value);
  if (Array.isArray(value)) return value.map(scrubLeaves);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubLeaves(v)]));
  }
  return value;
}
