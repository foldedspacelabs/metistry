// `scoreChoice()` — one scored token on the model a name points at, with the
// money rule enforced at the call (PoC-20 phase 1; moved here from
// `collectors/compute-client.ts` by T9-2, docs/ops/dynamic-router.md §2).
//
// Why it moved. It was written beside `completeJson()` in the collectors,
// which was the only place that called a model on a clock. The router's
// policy asks the same one-token question on the same model — the intent
// verdict and the planner's complexity class are both `assignments.intent`'s
// answers — and the console cannot import from `collectors/` (the dependency
// arrow points one way). So it moved, with the half it shares with
// `completeJson`: the provider resolution, the money rule, the bearer and the
// URL. MOVED, not copied: `completeJson` now resolves through
// `resolveOnMachineCall` below, so the money rule still has exactly one
// implementation, and there is still one place for it to be wrong.
//
// Four properties, carried over unchanged:
//
//   * **One protocol.** `POST <base_url>/chat/completions`, the request body
//     built by `choice.ts` so the eval harness and every caller put the same
//     bytes on the wire (a threshold fitted against one shape is not valid
//     against another).
//   * **The money rule THROWS, before any request is built.** A model
//     reference whose provider is not `locality: on_machine` is refused here —
//     the half that survives an instance editing its own `compute.yaml` after
//     CI and the schema have run.
//   * **Absent is not a failure.** No model reference, no such provider, no
//     credential, a server that does not answer or answers without logprobs —
//     each returns a reason and the caller keeps what it had.
//   * **No model free text reaches a caller.** The answer is one of the
//     caller's own option keys; the one textual thing a server can hand back —
//     an error body, which may echo the prompt — is scrubbed.

import { collectorProviderIssue, type Compute, type Provider } from "./compute.js";
import { parseModelRef, type ModelRef } from "./model-ref.js";
import { scrubModelOutput } from "./redact.js";
import { choiceServerOf, scoreChoiceOver, type ChoiceFetch, type ChoiceMessage, type ChoiceOption, type ChoiceServer } from "./choice.js";

/** What a caller needs from the world to make an on-machine call. The collectors' `ComputeAccess` extends it. */
export interface ModelAccess {
  /** the configuration IN FORCE, as a getter — `compute.yaml` hot-reloads, and a caller that captured it at startup would keep calling a provider the operator removed */
  compute?: () => Compute;
  /** where a provider's `auth.secret` is resolved from (the calling process's own environment) */
  secretEnv?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/** A model reference resolved against the `compute.yaml` in force, with everything a request needs. */
export interface ResolvedOnMachineCall {
  ref: ModelRef;
  provider: Provider;
  url: string;
  bearer: string | undefined;
}

const skip = (why: string): { ok: false; why: string } => ({ ok: false, why });

/**
 * The half `completeJson` and `scoreChoice` share: the provider resolution,
 * the money rule, the bearer, and the URL.
 *
 * ONE implementation, because the money rule is the property both callers
 * exist to hold and a second copy of it is a second place for it to be
 * wrong. THROWS for an off-machine provider — the one thing that does not
 * degrade — and returns a reason for everything else. `caller` names who is
 * calling, in the refusal and in every reason.
 */
export function resolveOnMachineCall(access: ModelAccess, caller: string, modelRef: string | undefined, absent: string): ResolvedOnMachineCall | { ok: false; why: string } {
  if (!modelRef) return skip(absent);
  const ref = parseModelRef(modelRef);
  const cfg = access.compute?.();
  const provider = cfg?.providers[ref.provider];

  const issue = collectorProviderIssue(caller, ref.provider, provider);
  if (issue) throw new Error(issue);

  if (!provider) {
    return skip(
      `compute.yaml declares no provider ${ref.provider}, so ${caller} has no on-device tier — ` +
        `\`metistry compute providers add --from ${ref.provider}\` if you want one (\`metistry doctor\` reports whether the server is answering)`,
    );
  }

  const secret = provider.auth?.secret;
  const bearer = secret ? access.secretEnv?.[secret] : undefined;
  if (secret && !bearer) {
    return skip(`providers.${ref.provider}.auth.secret names ${secret}, which is not in this process's environment — \`metistry secrets sync --to env\` and restart`);
  }

  return { ref, provider, url: `${provider.base_url.replace(/\/+$/, "")}/chat/completions`, bearer };
}

export interface ScoreChoiceOptions {
  /** who is calling — a collector's name, or the router — for the refusal messages and the money rule */
  collector: string;
  /** the pinned `<provider>/<model-id>` for THIS tier. Not a manifest's `uses_model`: the intent tier is assigned in `compute.yaml` (`assignments.intent`). */
  modelRef: string | undefined;
  /** what the model may answer, with descriptions (never bare names — research §2.3.1.1) */
  options: readonly ChoiceOption[];
  /** the one-token codes, generated from the option list by `codesFor` */
  codes: readonly string[];
  messages: readonly ChoiceMessage[];
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
export async function scoreChoice(access: ModelAccess, opts: ScoreChoiceOptions): Promise<ChoiceScore> {
  const resolved = resolveOnMachineCall(
    access,
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
    ...(access.fetchFn ? { fetchFn: access.fetchFn as unknown as ChoiceFetch } : {}),
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
