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
//   * **The money rule is enforced at the call, not asked for in a comment.**
//     A collector whose `uses_model:` names a provider that is not
//     `locality: on_machine` THROWS, loudly, before any request is built
//     (core's `resolveOnMachineCall`, which `scoreChoice` shares).
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

import { EgressRefused, resolveOnMachineCall, scrubModelOutput, type ModelAccess } from "@foldedspacelabs/metistry-core";

/** A JSON Schema object, as `response_format.json_schema.schema` takes it. */
export type JsonSchema = Record<string, unknown>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * What a collector needs from the world to make the call. Carried on
 * `CollectorCtx`. The compute getter, the secret environment and the fetch
 * seam are core's `ModelAccess` — the same three `scoreChoice` takes, since
 * the two share one resolution (below).
 */
export interface ComputeAccess extends ModelAccess {
  /** the pinned `<provider>/<model-id>` from THIS collector's manifest, handed down by the runner */
  usesModel?: string;
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

// The provider resolution, the money rule, the credential's door and the URL
// are core's `resolveOnMachineCall` — ONE implementation, shared with
// `scoreChoice` (which moved into `packages/core` with T9-2, because the
// console's router asks the same one-token question and cannot import from
// here). It THROWS for an off-machine provider, the one thing that does not
// degrade, and returns a reason for everything else.

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
  const resolved = resolveOnMachineCall(ctx, opts.collector, ctx.usesModel, `${opts.collector} declares no uses_model: in its manifest, so it calls nothing`);
  if ("ok" in resolved) return resolved;
  // `fetchFn` is core's `computeFetch`, bound to this provider: it refuses a
  // host that is not the provider's and attaches the credential itself, only
  // on the owner's grant (ruling 2, X-7) — this file never holds the key.
  const { ref, provider, url, fetchFn } = resolved;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    // A refusal at the door (no grant, a host that is not the provider's) is
    // a reason like any other: nothing was sent, and the caller keeps its
    // deterministic result.
    if (err instanceof EgressRefused) return skip(err.message);
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

// ---- scoreChoice: moved to `packages/core` (T9-2) ------------------------------
//
// `scoreChoice()` — the answer-token sibling of `completeJson()` (PoC-20
// phase 1) — was written here, on the same URL with different fields. It now
// lives in `packages/core/src/score-choice.ts`, with its off-machine refusal
// intact, because the router's policy asks the same question on the same
// model (docs/ops/dynamic-router.md §2) and the console cannot import from
// `collectors/`. It was moved, not copied: the collectors import it from core
// (`inbox-drain/intent-tier.ts`), and it resolves through the same
// `resolveOnMachineCall` this file does.

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
