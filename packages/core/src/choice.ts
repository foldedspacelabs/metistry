// Answer-token scoring — one scored token over a closed, letter-coded
// alphabet (PoC-20 phase 1; docs/research/2026-09-21-intent-classification-tier.md
// §2.5, §5.2).
//
// The technique is Nimble's and Jev's, and neither is a dependency: constrain
// the answer to ONE token from a closed alphabet, ask for `top_logprobs`,
// renormalise over the alphabet in our own code. In the research's own words
// (§2.1, quoting Nimble's README): "Each allowed answer has a code that is one
// token long. The scorer reads the model's logits for these codes. […] so
// there is no generated JSON to parse."
//
// Why the WIRE lives in core rather than in the collector that calls it. The
// threshold this whole tier turns on is FITTED on the owner's fixtures
// (§4.4: "the threshold itself is an output of the eval, not an input"), and a
// threshold fitted against one request shape is not valid against another. So
// `collectors/compute-client.ts`'s `scoreChoice()` and `packages/eval`'s
// `intents` command both build their body here, and a run of the harness and a
// run at the capture door put the same bytes on the wire.
//
// Three properties this module holds:
//
//   * **It decides nothing.** It returns a distribution, a peak, and a
//     published statistic over them. No threshold, no tier name, no model
//     name, nothing a rule could mistake for a destination (invariant 4, and
//     §3.2 P1: the classifier emits a FACT).
//   * **The request shape is per-server, and every line of it was measured**
//     on this Mac (see `CHOICE_WIRE`). A server that cannot answer with
//     logprobs says so by name rather than being asked and failing.
//   * **`alpha` is reported, always.** It is the share of the model's own
//     top-N probability mass that landed INSIDE the closed alphabet. Near 1.0
//     means the constraint is not fighting the model; a low `alpha` is an
//     honest "this input is not in my vocabulary" that JSON-schema decoding
//     cannot produce (§2.5 note 2).

import type { Provider } from "./compute.js";

/** Single-token answer codes. 26 is Nimble's own ceiling and the reason for `choicePlan`'s cascade (§2.1 item 6). */
export const CHOICE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The absolute ceiling on one call: one capital letter is one token. */
export const CHOICE_CODE_CEILING = CHOICE_ALPHABET.length;

/**
 * How many options one call may carry before it is split into a cascade.
 *
 * Twenty, and the number is not ours: THREE independent projects put their
 * ceiling inside the brief's 20–50 range (§2.3.1 lesson 5). Nimble stops at
 * 26 because an answer code is one token; Laya's authors report "accuracy
 * degrading past roughly 20 options" and score 0.425 on 77-label Banking77
 * against Jev's 0.870. All three reach for the same fix — shortlist first,
 * decide second — which is what `choicePlan` does.
 */
export const CHOICE_MAX_OPTIONS = 20; // limit: fixed — three upstream projects independently report accuracy degrading past ~20 options (research §2.3.1.5); past it `choicePlan` cascades rather than widening the call

/** One thing the model may answer, with the DESCRIPTION Laya lesson 1 says to send instead of a bare name. */
export interface ChoiceOption {
  /** the caller's own key — an intent name, a category. Never sent to the model: the model sees a letter and a description. */
  key: string;
  /** what this option MEANS, in the owner's words. `§2.3.1.1`: descriptions beat bare names, and the research's own arms differed on exactly this. */
  description: string;
}

/** Codes for `n` options, GENERATED from the count. Never a hand-maintained table: a table and a list drift, and the drift is silent. */
export function codesFor(n: number): string[] {
  if (n > CHOICE_CODE_CEILING) {
    throw new Error(`${n} options need ${n} one-token codes and there are ${CHOICE_CODE_CEILING} capital letters — split the call with choicePlan() (research §2.5, "the 26-intent ceiling, and how to pass it")`);
  }
  return Array.from({ length: n }, (_, i) => CHOICE_ALPHABET[i]!);
}

// ---- the cascade (Laya lesson 5: shortlist first, decide second) --------------

/** One scored call: a set of options and the codes they were given. */
export interface ChoiceStage {
  /** `groups` narrows to a member stage; `members` answers. A plan of one stage is always `members`. */
  kind: "groups" | "members";
  options: ChoiceOption[];
  codes: string[];
  /** on a `groups` stage, the group key → the options that stage would narrow to */
  narrows?: Record<string, ChoiceOption[]>;
}

export interface ChoiceGroup {
  key: string;
  description: string;
  members: readonly string[];
}

/**
 * The FIRST call to make about `options`, in a call of at most
 * `CHOICE_MAX_OPTIONS`.
 *
 * At or under the ceiling this is a `members` stage, the groups are never
 * used, and one call answers — which is the shipped case today (the intent
 * enum is 16). Past it, it is a `groups` stage: one scored token over the
 * groups, then `stageFor()` gives the second over the winning group's members.
 * Two scored tokens at ~155 ms is still under the JSON-schema route's single
 * 336 ms (§2.5).
 */
export function choicePlan(options: readonly ChoiceOption[], groups: readonly ChoiceGroup[] = []): ChoiceStage {
  if (options.length <= CHOICE_MAX_OPTIONS) {
    return { kind: "members", options: [...options], codes: codesFor(options.length) };
  }
  if (groups.length === 0) {
    throw new Error(`${options.length} options is past the ${CHOICE_MAX_OPTIONS}-option ceiling and no groups were given to cascade over (research §2.3.1.5)`);
  }
  const byKey = new Map(options.map((o) => [o.key, o]));
  const narrows: Record<string, ChoiceOption[]> = {};
  for (const g of groups) {
    const members = g.members.map((k) => byKey.get(k)).filter((o): o is ChoiceOption => o !== undefined);
    if (members.length === 0) continue;
    if (members.length > CHOICE_MAX_OPTIONS) {
      throw new Error(`group ${g.key} has ${members.length} members, past the ${CHOICE_MAX_OPTIONS}-option ceiling — split the group rather than the call`);
    }
    narrows[g.key] = members;
  }
  const covered = new Set(Object.values(narrows).flatMap((m) => m.map((o) => o.key)));
  const missing = options.filter((o) => !covered.has(o.key)).map((o) => o.key);
  if (missing.length > 0) {
    throw new Error(`the groups do not cover every option — ${missing.join(", ")} would be unreachable, so the cascade could never name them`);
  }
  const groupOptions = groups.filter((g) => narrows[g.key]).map((g) => ({ key: g.key, description: g.description }));
  return { kind: "groups", options: groupOptions, codes: codesFor(groupOptions.length), narrows };
}

/** The member stage a `groups` verdict narrows to. Undefined for a group key the plan does not know. */
export function stageFor(stage: ChoiceStage, groupKey: string): ChoiceStage | undefined {
  const members = stage.narrows?.[groupKey];
  if (!members) return undefined;
  return { kind: "members", options: members, codes: codesFor(members.length) };
}

// ---- which server, and what it takes ------------------------------------------

/**
 * The four local servers, as `docs/ops/compute.md` names them. The names match
 * `packages/cli`'s `LOCAL_SERVER_NAMES` and `packages/eval`'s
 * `Candidate.server` on purpose: one vocabulary for "which server answered".
 */
export const CHOICE_SERVERS = ["lmstudio", "ollama", "llamaserver", "applefm"] as const;
export type ChoiceServer = (typeof CHOICE_SERVERS)[number];

/**
 * What one server needs on the wire for an answer-token score.
 *
 * **Every row was measured on this Mac on 2026-09-22** (M4 Max, macOS 26.4)
 * against the servers that were running, and two of them CORRECT the research
 * note, which had LM Studio down as schema-only:
 *
 * ```
 * ollama       reasoning_effort=none   max_tokens=1  top_logprobs=20  "A" -0.028   ← suppression is load-bearing
 * ollama       (no suppression)        max_tokens=1  top_logprobs=20  "<|channel>" -0.436, "A" -1.063
 * llamaserver  enable_thinking=false   max_tokens=1  top_logprobs=20  logprobs present (toy model: shape only)
 * lmstudio     any suppression         max_tokens=1  top_logprobs<=10 logprobs NULL, completion_tokens 0
 * lmstudio     any suppression         max_tokens=2  top_logprobs<=10 logprobs PRESENT, first token is the answer
 * lmstudio                             max_tokens>1  top_logprobs=20  HTTP 400 "top_logprobs must be <= 10"
 * ```
 *
 * So LM Studio is **not** schema-only: it needs `max_tokens: 2` and a
 * `top_logprobs` of at most 10, and then the FIRST content token's
 * distribution is exactly what the other two return. At `max_tokens: 1` it
 * answers `200` with `logprobs: null` and `completion_tokens: 0`, which is
 * what the research measured and read as "no logprobs".
 *
 * Apple FM is the one that genuinely cannot: FoundationModels exposes no
 * per-token logits (§1.4), so `top_logprobs_max: null` and the caller is told
 * by name rather than being sent a request that cannot work.
 */
export interface ChoiceWire {
  /** how many tokens the server must be allowed to produce before it will report the first one's distribution */
  max_tokens: number;
  /** the server's own ceiling on `top_logprobs`; `null` means this server returns no logprobs at all */
  top_logprobs_max: number | null;
  /** the fields that turn the reasoning channel off — per-server, and PoC-16 finding 2 is why (reasoning hurts this task, measured) */
  suppression: Record<string, unknown>;
  /** one line for the row that records why a request looked the way it did */
  note: string;
}

const SUPPRESS_OLLAMA = { reasoning_effort: "none" } as const;
const SUPPRESS_LLAMA = { chat_template_kwargs: { enable_thinking: false } } as const;

export const CHOICE_WIRE: Record<ChoiceServer, ChoiceWire> = {
  ollama: {
    max_tokens: 1,
    top_logprobs_max: 20,
    suppression: { ...SUPPRESS_OLLAMA },
    note: "ollama /v1 honours reasoning_effort: none (without it the top token is the reasoning channel opener, measured)",
  },
  llamaserver: {
    max_tokens: 1,
    top_logprobs_max: 20,
    suppression: { ...SUPPRESS_LLAMA },
    note: "llama-server takes chat_template_kwargs: { enable_thinking: false }",
  },
  lmstudio: {
    max_tokens: 2,
    top_logprobs_max: 10,
    // Both, because LM Studio's build accepts either and neither removes the
    // reasoning-channel token from the distribution — it sits at ~-6 logits,
    // which `alpha` reports rather than hides.
    suppression: { ...SUPPRESS_OLLAMA, ...SUPPRESS_LLAMA },
    note: "LM Studio needs max_tokens >= 2 (at 1 it answers logprobs: null) and refuses top_logprobs > 10",
  },
  applefm: {
    max_tokens: 1,
    top_logprobs_max: null,
    suppression: {},
    note: "Apple Foundation Models exposes no per-token logits, so this server can only do the JSON-schema arm (research §1.4)",
  },
};

/**
 * The shape every server measured here accepts, for a provider that is none of
 * the four: `max_tokens: 2` with `top_logprobs` capped at 10 answered
 * correctly on all three servers that return logprobs at all, so an
 * unrecognised endpoint is asked in the way most likely to work rather than in
 * the way that is fastest on one of them.
 */
export const CHOICE_WIRE_UNKNOWN: ChoiceWire = {
  max_tokens: 2,
  top_logprobs_max: 10,
  suppression: { ...SUPPRESS_OLLAMA, ...SUPPRESS_LLAMA },
  note: "an unrecognised server, asked in the shape all three measured servers accept",
};

export function choiceWireFor(server: ChoiceServer | undefined): ChoiceWire {
  return server ? CHOICE_WIRE[server] : CHOICE_WIRE_UNKNOWN;
}

function portOf(url: string): number | undefined {
  try {
    const u = new URL(url);
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return undefined;
  }
}

/**
 * Which of the four a provider block IS — the same rule
 * `packages/cli`'s `serverOf` applies, restated here because a collector may
 * not import the CLI (CLAUDE.md: the dependency arrow points one way). A
 * `serve:` block says so outright; otherwise the default ports are the only
 * evidence there is, and an unrecognised one gets `CHOICE_WIRE_UNKNOWN`.
 */
export function choiceServerOf(name: string, p: Pick<Provider, "base_url" | "serve">): ChoiceServer | undefined {
  if (p.serve) return p.serve.runtime;
  const port = portOf(p.base_url);
  if (port === 1234) return "lmstudio";
  if (port === 11434) return "ollama";
  if (port === 7810) return "applefm";
  if (port === 7813) return "llamaserver";
  if ((CHOICE_SERVERS as readonly string[]).includes(name)) return name as ChoiceServer;
  return undefined;
}

// ---- the statistic ------------------------------------------------------------

/**
 * TypeSafe's published confidence statistic, recomputed in our own code from
 * the distribution we obtained locally (research §2.2). Their
 * `ConfidenceExplorer` source, quoted:
 *
 * ```js
 * confidence = max(0, min(1, (n * peak - 1) / (n - 1)))
 * ```
 *
 * It is a statistic over a distribution, published openly, not a licensed
 * artefact — and it is used unchanged in every measurement in the research
 * note, so a number here is comparable with one there.
 *
 * It says how PEAKED the distribution is against the uniform, and nothing
 * whatever about whether the answer is right. Nimble's README, verbatim: "A
 * probability of 0.9 does not mean that the answer is right 90% of the time.
 * […] Test any probability threshold on your own data before you rely on it."
 * That is why §4.4 makes the threshold an output of the eval.
 */
export function choiceConfidence(peak: number, n: number): number {
  if (n <= 1) return peak > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, (n * peak - 1) / (n - 1)));
}

// ---- reading one answer -------------------------------------------------------

export interface ChoiceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TopLogprob {
  token: string;
  logprob: number;
}

export interface ChoiceReading {
  /** the option key the model put the most mass on */
  key: string;
  /** its letter code */
  code: string;
  /** the renormalised probability of `key` — the peak of the distribution below */
  peak: number;
  /** every option key → its renormalised probability. Options outside the returned top-N are 0. */
  distribution: Record<string, number>;
  /** the share of the model's top-N mass that landed inside the closed alphabet, BEFORE renormalisation (§2.5 note 2) */
  alpha: number;
  /** how many of the options appeared in the returned top-N at all — below `options.length` where the server caps `top_logprobs` */
  covered: number;
}

/**
 * Renormalise one returned `top_logprobs` list over the closed alphabet.
 *
 * Case is folded: a model that answers `a` meant `A`, and dropping the
 * lowercase token would move its mass into `alpha`'s complement and make the
 * constraint look like it was fighting the model when it was not (the
 * research's own §2.5 run shows `"a"` in the top-20 at -6.2).
 */
export function readChoice(top: readonly TopLogprob[], options: readonly ChoiceOption[], codes: readonly string[]): ChoiceReading | { why: string } {
  const byCode = new Map(codes.map((c, i) => [c, options[i]!.key]));
  const mass = new Map<string, number>();
  let inside = 0;
  let total = 0;
  for (const t of top) {
    const p = Math.exp(t.logprob);
    total += p;
    const raw = (t.token ?? "").trim();
    if (raw.length !== 1) continue;
    const code = raw.toUpperCase();
    const key = byCode.get(code);
    if (key === undefined) continue;
    inside += p;
    mass.set(key, (mass.get(key) ?? 0) + p);
  }
  if (mass.size === 0) {
    return { why: `the model's top-${top.length} answer tokens contained none of the ${options.length} option codes (${codes.join("")}) — the closed alphabet carried no probability at all` };
  }
  const distribution: Record<string, number> = {};
  for (const o of options) distribution[o.key] = (mass.get(o.key) ?? 0) / inside;
  // Ties resolve to the earlier code, so two runs of the same input are the
  // same answer — stability is an axis §4.4 asks for.
  let key = options[0]!.key;
  let peak = -1;
  for (const o of options) {
    const p = distribution[o.key]!;
    if (p > peak) {
      peak = p;
      key = o.key;
    }
  }
  return {
    key,
    code: codes[options.findIndex((o) => o.key === key)]!,
    peak,
    distribution,
    alpha: total > 0 ? Math.max(0, Math.min(1, inside / Math.max(total, inside))) : 0,
    covered: mass.size,
  };
}

// ---- the call -----------------------------------------------------------------

export type ChoiceFetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

export interface ChoiceCall {
  /** the full `<base_url>/chat/completions` URL — the caller resolved the provider, this does not */
  url: string;
  model: string;
  messages: readonly ChoiceMessage[];
  options: readonly ChoiceOption[];
  codes: readonly string[];
  server?: ChoiceServer | undefined;
  bearer?: string | undefined;
  /** how many top tokens to ask for; capped by the server's own ceiling. Default: one per option. */
  topLogprobs?: number | undefined;
  timeoutMs?: number | undefined;
  /** the provider's `request:` block, merged LAST exactly as `completeJson` merges it */
  extra?: Record<string, unknown> | undefined;
  fetchFn?: ChoiceFetch | undefined;
}

export type ChoiceScored =
  | (ChoiceReading & { ok: true; confidence: number; latency_ms: number; server: ChoiceServer | undefined; max_tokens: number; top_logprobs: number })
  | { ok: false; why: string };

/** 20s: one scored token on a resident local model. A longer wait is a hung server, not a slow one. */
const CHOICE_TIMEOUT_MS = 20_000; // limit: fixed — one token from a resident local server; the research measured p50 155 ms and p95 231 ms, so 20s is two orders of margin

/** The request body, built once so the harness and the capture door send the same bytes. */
export function choiceBody(call: ChoiceCall): Record<string, unknown> {
  const wire = choiceWireFor(call.server);
  const want = call.topLogprobs ?? call.options.length;
  const top = wire.top_logprobs_max === null ? want : Math.min(want, wire.top_logprobs_max);
  return {
    model: call.model,
    messages: call.messages,
    temperature: 0,
    max_tokens: wire.max_tokens,
    logprobs: true,
    top_logprobs: top,
    ...wire.suppression,
    ...(call.extra ?? {}),
  };
}

/**
 * One scored token, or a REASON. Never throws: absent is normal here exactly
 * as it is for `completeJson` — a server that is not answering leaves the
 * caller with whatever it already had.
 */
export async function scoreChoiceOver(call: ChoiceCall): Promise<ChoiceScored> {
  if (call.options.length !== call.codes.length) {
    return { ok: false, why: `${call.options.length} options were given ${call.codes.length} codes — codesFor() generates them, so this is a caller bug` };
  }
  const wire = choiceWireFor(call.server);
  if (wire.top_logprobs_max === null) {
    return { ok: false, why: `${call.server} returns no answer-token logprobs: ${wire.note}. This tier does not run there; the JSON-schema arm (PoC-20 phase 2) is what that server can do.` };
  }
  const body = choiceBody(call);
  const started = Date.now();
  let res: Response;
  try {
    res = await (call.fetchFn ?? (fetch as unknown as ChoiceFetch))(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(call.bearer ? { authorization: `Bearer ${call.bearer}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(call.timeoutMs ?? CHOICE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, why: `${call.url} did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
  const latency_ms = Date.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, why: `${call.url} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
  }
  let payload: {
    choices?: Array<{ logprobs?: { content?: Array<{ top_logprobs?: unknown }> } | null }>;
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    return { ok: false, why: `${call.url} answered ${res.status} but not JSON` };
  }
  const first = payload.choices?.[0];
  const top = first?.logprobs?.content?.[0]?.top_logprobs;
  if (!Array.isArray(top) || top.length === 0) {
    return {
      ok: false,
      why:
        `${call.url} answered without answer-token logprobs (logprobs ${first?.logprobs === null ? "null" : "absent"}) — ` +
        `asked with max_tokens ${body.max_tokens}, top_logprobs ${body.top_logprobs}. ${wire.note}`,
    };
  }
  const parsed: TopLogprob[] = [];
  for (const t of top as Array<{ token?: unknown; logprob?: unknown }>) {
    if (typeof t?.token === "string" && typeof t.logprob === "number" && Number.isFinite(t.logprob)) parsed.push({ token: t.token, logprob: t.logprob });
  }
  const reading = readChoice(parsed, call.options, call.codes);
  if ("why" in reading) return { ok: false, why: reading.why };
  return {
    ...reading,
    ok: true,
    confidence: choiceConfidence(reading.peak, call.options.length),
    latency_ms,
    server: call.server,
    max_tokens: body.max_tokens as number,
    top_logprobs: body.top_logprobs as number,
  };
}
