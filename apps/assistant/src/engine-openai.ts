// The OpenAI-compatible engine (C2, C4) — the in-house loop, ~300 lines over
// `fetch`, the pre-approved MCP client (tools.ts) and zod. No library: an
// OpenAI-compatible base URL already IS the provider abstraction an SDK would
// sell, and a dependency here is a decade-long obligation for one person
// (docs/research/2026-09-11-local-models-openrouter-opencode.md, "Libraries
// for the second engine, honestly"). Revisit at ~600 lines or streaming UI.
//
// What the loop owns, and why each one is here rather than in a vendor's SDK:
//
// - THE TOOL LOOP over the console's `/mcp` — one `tools/list` per run, then
//   `tools/call` per call. The tool surface is the host's (invariant 9);
//   nothing here can reach a shell, a file, or another engine.
// - `max_turns`, and a graceful ending when it is reached: the last request
//   goes out with `tool_choice: "none"`, so a run that ran out of turns still
//   answers instead of throwing.
// - THE NO-PROGRESS VETO (Atomic ADOPT 4). "Unproductive" is defined, not
//   sensed: a turn is unproductive when every tool call it made repeats a
//   (name, arguments) already made in this run AND comes back byte-identical
//   to what that call returned before — the model has learned nothing. Three
//   in a row buys one nudge; five ends tool use and asks for the answer.
// - BACKOFF on 429 and 5xx, honouring `Retry-After`. A local server that is
//   loading a model and a cloud that is rate-limiting look the same here.
// - USAGE → COST on every call (core's `costOf`), so `runs` carries money
//   rather than an estimate reconstructed later — including the cached
//   subset of the prompt, which lands on the row as `cache_read_tokens` /
//   `cache_write_tokens` and is priced at the `pricing:` table's cache
//   multipliers when the response carries no cost of its own.
// - AUTOMATIC PROMPT CACHING for a provider whose block says `caching:
//   auto`, and nothing for one that does not (OPEN-6, ruled 2026-09-17).
//   See `body()` for the field and the source it comes from.
// - `response_format: json_schema` PLUS a validating fallback with ONE repair
//   retry, because LM Studio warns sub-7B models may fail it and OpenRouter
//   says some endpoints "treat it as a strong hint".
// - EFFORT: `reasoning: { effort }` off-machine; reasoning off on-machine
//   (PoC-16 measured reasoning mode hurting the local task). Per-model
//   reasoning style is a bake-off measurement, not an assumption (§2.9).
// - STAGE-2 SHADOW MODE, for the sampled fraction `assignments.default`'s
//   `shadow:` block names: once the real answer exists, the same turn is run
//   again on the candidate with tools stubbed record-only, and the comparison
//   goes on the `runs` row. The candidate's answer is never returned as the
//   turn's. The mechanism, and why it cannot execute a tool or break a turn,
//   is shadow.ts.
// - THE PROVIDER'S `request:` BLOCK, merged verbatim — except `model` and
//   `messages`, which the assignment owns: invariant 4 says no model decides
//   which model runs, and a `request:` that could repoint the call would hand
//   that back. (This is also the hook the 2026-09-12 addendum's `grammar`
//   field lands in when a `llama-server` provider exposes GBNF — nothing
//   here has to change for it.)
//
// The outbound surface is one URL: `<base_url>/chat/completions` on the
// provider this turn was assigned. There is no other host this file can
// reach, which is the in-engine allowlist (R1) as a property of the code
// rather than an environment variable a subprocess may ignore.

import {
  costOf,
  unpricedNote,
  usageFromResponse,
  type CallCost,
  type CallUsage,
  type Provider,
  type ResolvedAssignment,
} from "@foldedspacelabs/metistry-core";
import type { z } from "zod";
import type { ChatMessage, SessionStore } from "./sessions.js";
import { toolCallKey, type ToolHost, type ToolSpec } from "./tools.js";
import type { Engine, TurnGuard, TurnResult, TurnSpec } from "./engine.js";
import { runShadow, shouldShadow, type ShadowRubric, type ShadowRun } from "./shadow.js";
import type { ArchivedToolCall, SessionArchive } from "./archive.js";
import { newTurnId } from "./brain.js";

/** Turns in a row with no new information before the loop nudges, and before it stops using tools (Atomic ADOPT 4). */
export const UNPRODUCTIVE_WARN = 3;
export const UNPRODUCTIVE_VETO = 5;

/** Attempts per HTTP call, including the first. Four covers a rate-limit window and a model that is still loading. */
export const DEFAULT_ATTEMPTS = 4;
export const DEFAULT_BACKOFF_MS = 500;  // limit: fixed — the base of the 429/5xx backoff schedule; `Retry-After` overrides it per response, and a knob here would only make a provider's rate limit worse
export const DEFAULT_MAX_TURNS = 12;  // limit: fixed — the fallback when a tier names no `max_turns`; the assignment in compute.yaml is the knob, not the environment

export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`${url} returned ${status}: ${body.slice(0, 400)}`);
  }
}

/** The credential is missing, or the file names one that this install has not set. The message names the field (R3). */
export class CredentialError extends Error {}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** The raw assistant message, stored verbatim in the history so a provider's own fields survive a resume. */
  message: ChatMessage;
  usage: CallUsage;
  cost: CallCost;
  finish_reason?: string;
}

export interface ChatClientConfig {
  assignment: ResolvedAssignment;
  /** The bearer, already read from the environment. Absent for a provider with no `auth:` (a local server). */
  apiKey?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  attempts?: number | undefined;
  backoffMs?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface ChatOptions {
  tools?: readonly ToolSpec[] | undefined;
  toolChoice?: "auto" | "none" | undefined;
  responseFormat?: unknown;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read the provider's credential out of the environment. `auth.secret` is a
 * NAME (C6): the value lives in the login Keychain and reaches a service as
 * the environment variable of that name (`metistry secrets sync --to env`).
 */
export function credentialFor(provider: Provider, providerName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = provider.auth?.secret;
  if (!name) return undefined; // a local server needs none; sending an empty bearer would be worse than sending nothing
  const value = (env[name] ?? "").trim();
  if (!value) {
    throw new CredentialError(
      `compute.yaml names providers.${providerName}.auth.secret = ${name}, but ${name} is unset in this install's environment — ` +
        `run \`metistry secrets set ${name}\` then \`metistry secrets sync --to env\`, or drop auth: from the provider if it needs no key`,
    );
  }
  return value;
}

function retryAfterMs(headers: Headers, fallback: number): number {
  const raw = headers.get("retry-after");
  if (!raw) return fallback;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : fallback;
}

/** `<base_url>/chat/completions`, with the trailing slash question settled once. */
export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export interface ChatClient {
  readonly providerName: string;
  readonly model: string;
  readonly provider: Provider;
  chat(messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
}

export function makeChatClient(cfg: ChatClientConfig): ChatClient {
  const { assignment } = cfg;
  const provider = assignment.config;
  const fetchFn = cfg.fetchFn ?? fetch;
  const sleep = cfg.sleep ?? sleepReal;
  const attempts = cfg.attempts ?? DEFAULT_ATTEMPTS;
  const backoff = cfg.backoffMs ?? DEFAULT_BACKOFF_MS;
  const url = completionsUrl(provider.base_url);

  const body = (messages: readonly ChatMessage[], opts: ChatOptions): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (opts.tools && opts.tools.length > 0) {
      out.tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      out.tool_choice = opts.toolChoice ?? "auto";
    }
    // Effort is the other half of the tier (core's tiers.ts). Off-machine
    // providers take OpenRouter's spelling; a local server is asked for no
    // reasoning at all.
    out.reasoning = provider.locality === "off_machine" ? { effort: assignment.effort } : { enabled: false };
    if (opts.responseFormat !== undefined) out.response_format = opts.responseFormat;
    // AUTOMATIC PROMPT CACHING, for a provider whose block says so (OPEN-6,
    // ruled 2026-09-17: ship the automatic form first; automatic vs explicit
    // breakpoints is a measurement on real turns, not a guess). ONE
    // top-level `cache_control: { type: "ephemeral" }` is the automatic
    // placement OpenRouter documents for Anthropic models — reads at 0.1×,
    // five-minute writes at 1.25×, `cached_tokens`/`cache_write_tokens` back
    // in `usage`
    // (docs/research/2026-09-11-local-models-openrouter-opencode.md
    // [or-cache] = https://openrouter.ai/docs/features/prompt-caching,
    // fetched 2026-09-11; the shape is the one that source records, and
    // OPEN-6's measurement is where it meets a live response).
    //
    // Nothing is sent for `caching: off` or an absent field, which is every
    // provider but the openrouter template: a local server has no such
    // field, and a field it would have to ignore is not something to send on
    // every call. Explicit breakpoints are the operator's `request:` block,
    // merged below and therefore able to override this.
    if (provider.caching === "auto") out.cache_control = { type: "ephemeral" };
    // Verbatim last, so an operator can override anything above …
    Object.assign(out, provider.request ?? {});
    // … except what the ASSIGNMENT owns. Invariant 4: no model decides which
    // model runs, and messages are what the data policy was checked against.
    out.model = assignment.model;
    out.messages = messages;
    return out;
  };

  return {
    providerName: assignment.provider,
    model: assignment.model,
    provider,
    async chat(messages, opts = {}) {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body(messages, opts)),
        ...(cfg.timeoutMs ? { signal: AbortSignal.timeout(cfg.timeoutMs) } : {}),
      };
      let lastErr: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let res: Response;
        try {
          res = await fetchFn(url, init);
        } catch (err) {
          // A refused connection is the local-server-not-running case: retry
          // on the same schedule as a 5xx, then give up with the real reason.
          lastErr = err;
          if (attempt === attempts - 1) throw err;
          await sleep(backoff * 2 ** attempt);
          continue;
        }
        if (res.ok) return parseCompletion(await res.json(), provider, assignment.model);
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new EngineHttpError(res.status, text, url);
        if (!retryable || attempt === attempts - 1) throw lastErr;
        await sleep(retryAfterMs(res.headers, backoff * 2 ** attempt));
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

/** Pull the one choice apart: text, tool calls, usage, cost. A response with no choices is a provider bug, and says so. */
export function parseCompletion(raw: unknown, provider: Provider, model: string): ChatResponse {
  const body = (raw ?? {}) as Record<string, unknown>;
  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as Record<string, unknown> | undefined;
  if (!choice) throw new Error(`chat/completions returned no choices: ${JSON.stringify(body).slice(0, 300)}`);
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const toolCalls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((c: any, i: number) => {
    let args: Record<string, unknown> = {};
    const rawArgs = c?.function?.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        // A model that emits unparseable arguments gets the parse error back
        // as the tool result; it is a turn, not a crash.
        args = { __invalid_arguments: rawArgs };
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    return { id: String(c?.id ?? `call_${i}`), name: String(c?.function?.name ?? ""), args };
  });
  const usage = usageFromResponse(body.usage);
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    message: { role: "assistant", content: (message.content as string | null) ?? null, ...(toolCalls.length > 0 ? { tool_calls: message.tool_calls as unknown[] } : {}) },
    usage,
    cost: costOf(usage, provider, model),
    ...(typeof choice.finish_reason === "string" ? { finish_reason: choice.finish_reason } : {}),
  };
}

// ---- structured output: schema first, validation always ----------------------

export interface JsonCompletion<T> {
  value: T;
  /** true when the first answer failed validation and the one repair retry fixed it — the number that says whether a model can be trusted with `json_schema`. */
  repaired: boolean;
  usage: CallUsage;
  cost: CallCost;
}

/** Strip a ```json fence, which small models add however the schema was asked for. */
export function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

/**
 * Ask for JSON, then CHECK it (C4). `response_format: json_schema` goes out
 * every time, but nothing downstream trusts it: the answer is parsed and
 * validated with zod, and one repair retry carries the validation error back
 * to the model. Two failures is a failure — a second repair would cost more
 * than the turn is worth, and the caller can pick a better model.
 */
export async function completeJson<T>(
  client: ChatClient,
  args: {
    messages: readonly ChatMessage[];
    schema: z.ZodType<T>;
    /** The JSON Schema sent on the wire. Same shape, stated twice, because only zod can be trusted to enforce it. */
    jsonSchema: Record<string, unknown>;
    name?: string;
  },
): Promise<JsonCompletion<T>> {
  const responseFormat = { type: "json_schema", json_schema: { name: args.name ?? "result", strict: true, schema: args.jsonSchema } };
  const usage: CallUsage = { tokens_in: 0, tokens_out: 0 };
  let cost = 0;
  let source: CallCost["source"] = "unknown";
  const messages: ChatMessage[] = [...args.messages];

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat(messages, { responseFormat, toolChoice: "none" });
    usage.tokens_in += res.usage.tokens_in;
    usage.tokens_out += res.usage.tokens_out;
    cost += res.cost.cost_usd;
    source = res.cost.source;
    let problem: string;
    try {
      const parsed: unknown = JSON.parse(stripFence(res.text));
      const checked = args.schema.safeParse(parsed);
      if (checked.success) return { value: checked.data, repaired: attempt > 0, usage: { ...usage, cost_usd: cost }, cost: { cost_usd: cost, source } };
      problem = checked.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    } catch (err) {
      problem = `not JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (attempt === 1) throw new Error(`structured output failed twice (${problem}) — the provider treated response_format as a hint; pin a model that supports it`);
    messages.push(res.message, {
      role: "user",
      content: `That did not match the schema — ${problem}. Reply with ONLY the corrected JSON object, no prose and no code fence.`,
    });
  }
  throw new Error("unreachable");
}

// ---- the tool loop ------------------------------------------------------------

export interface OpenAiEngineConfig {
  /** Identity-templated system prompt (prompt.ts). Absent = none. */
  systemPrompt?: string | undefined;
  /** Agentic turns per message. */
  maxTurns?: number | undefined;
  /** The tool surface for this turn — a per-run host, so a crew presents its own bearer and its own `uses` list. The spec it is handed always carries the turn's `turnId`. */
  tools: (spec: TurnSpec) => ToolHost;
  sessions: SessionStore;
  /**
   * The session archive (archive.ts, T3-9): every finished turn is appended
   * — system prompt as sent, this turn's messages, each tool call with its
   * arguments and result, redacted by the store. Absent = nothing archived
   * (tests, and a crew run, whose brief and report are already on its work
   * row). A failed append never fails the turn: the reply is delivered and
   * the miss lands in `notes`.
   */
  archive?: SessionArchive | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchFn?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  attempts?: number | undefined;
  backoffMs?: number | undefined;
  timeoutMs?: number | undefined;
  /**
   * The pre-call gate (budgets.ts). The REAL turn's gate already ran in
   * `makeEngine` before this engine was called; the loop keeps a reference
   * because the SHADOW is a turn too and has to ask the same question with
   * its own provider and `critical: false` — a budget that would refuse a
   * turn refuses the experiment first.
   */
  guard?: TurnGuard | undefined;
  /** The shadow sampler's seam: `Math.random` in production, a script in tests. It decides what is MEASURED, never what answers (invariant 4). */
  random?: (() => number) | undefined;
  /** `packages/eval`'s rubric, when there is one. Absent today — shadow.ts's `ShadowRubric` says why this is a hook. */
  rubric?: ShadowRubric | undefined;
}

const callKey = (c: ToolCall): string => toolCallKey(c.name, c.args);

const NUDGE =
  `Those calls returned nothing you had not already seen. Either take a different action or answer with what you have — ` +
  `repeating a call you have already made does not add information.`;

/**
 * One turn on an OpenAI-compatible provider. Returns the same `TurnResult`
 * the SDK path returns, so `drain.ts` cannot tell which engine ran — that is
 * the whole point of the interface.
 */
export function makeOpenAiEngine(cfg: OpenAiEngineConfig): Engine {
  return async (prompt, spec) => {
    const assignment = spec.assignment;
    if (!assignment) throw new Error("the openai-compatible engine needs a resolved compute.yaml assignment (engine.ts picks the engine from provider.kind)");
    const client = makeChatClient({
      assignment,
      apiKey: credentialFor(assignment.config, assignment.provider, cfg.env ?? process.env),
      fetchFn: cfg.fetchFn,
      sleep: cfg.sleep,
      attempts: cfg.attempts,
      backoffMs: cfg.backoffMs,
      timeoutMs: cfg.timeoutMs,
    });
    // One handle per reply: the tool host stamps it on every call's `_meta`,
    // and the archive keys the turn by it — the same id, so a turn's calls
    // and its archived conversation line up with no time-window guessing.
    const turnId = spec.turnId ?? newTurnId();
    const host = cfg.tools({ ...spec, turnId });
    const maxTurns = spec.maxTurns ?? cfg.maxTurns ?? DEFAULT_MAX_TURNS;
    const thread = spec.thread ?? "default";

    const resumed = spec.resume ? await cfg.sessions.load(spec.resume, assignment.provider, assignment.model) : null;
    const sessionId = resumed?.id ?? cfg.sessions.newId();
    const history: ChatMessage[] = [...(resumed?.messages ?? []), { role: "user", content: prompt }];
    /** Where this turn's own messages start: everything before is replayed history, already archived with the turn that wrote it. */
    const turnStart = resumed?.messages.length ?? 0;
    /** The closing instruction, when the loop had to ask for an answer with tools off — sent, but never kept in the replayed history. */
    let closing: { at: number; message: ChatMessage } | undefined;
    /** Each tool call with its arguments and result, in call order — the archive's `tool_calls` (redacted by the store). */
    const calls: ArchivedToolCall[] = [];
    /** The turn as it STARTED, kept so a shadow re-runs the same turn rather than a summary of it. */
    const opening: ChatMessage[] = [...history];

    const tools = await host.list();
    const toolsUsed: Record<string, number> = {};
    /** Tool names in the order they were called — the sequence half of shadow agreement (`toolsUsed` is a tally and cannot say order). */
    const toolSequence: string[] = [];
    // `cache_read`/`cache_write` start ABSENT, not at 0: a turn whose
    // provider reported no cache field at all must reach the row as NULL
    // rather than as a zero that reads like a missed cache (core's
    // CallUsage, and `seed/queries/cache_report.yaml`, which separates the
    // two findings).
    const usage: CallUsage = { tokens_in: 0, tokens_out: 0 };
    let cost = 0;
    let costSource: CallCost["source"] = "unknown";
    const seen = new Map<string, string>();
    let unproductive = 0;
    let nudged = false;
    let stopped: TurnResult["stopped"];
    let turns = 0;
    let text = "";

    const system: ChatMessage[] = cfg.systemPrompt ? [{ role: "system", content: cfg.systemPrompt }] : [];
    const account = (r: ChatResponse): void => {
      usage.tokens_in += r.usage.tokens_in;
      usage.tokens_out += r.usage.tokens_out;
      // Summed over the loop, but only once a response has actually carried
      // the field: one call that reports `cached_tokens: 0` makes the turn's
      // total 0 (the cache was asked and missed), and a turn where no call
      // reported anything stays undefined (nothing was asked, or the field
      // is not the one this provider sends).
      if (r.usage.cache_read !== undefined) usage.cache_read = (usage.cache_read ?? 0) + r.usage.cache_read;
      if (r.usage.cache_write !== undefined) usage.cache_write = (usage.cache_write ?? 0) + r.usage.cache_write;
      cost += r.cost.cost_usd;
      costSource = r.cost.source;
    };

    try {
      while (turns < maxTurns) {
        // The per-run cap (a crew manifest's `budget_usd_per_run`), checked
        // between requests exactly as a hosted harness checks a session
        // budget: the run stops and answers, it does not overspend and then
        // report it.
        if (spec.maxCostUsd !== undefined && cost >= spec.maxCostUsd) {
          stopped = "max_budget";
          break;
        }
        turns++;
        const res = await client.chat([...system, ...history], { tools, toolChoice: "auto" });
        account(res);
        history.push(res.message);
        if (res.toolCalls.length === 0) {
          text = res.text;
          break;
        }

        let learned = false;
        for (const call of res.toolCalls) {
          toolsUsed[call.name] = (toolsUsed[call.name] ?? 0) + 1;
          toolSequence.push(call.name);
          const out = await host.call(call.name, call.args);
          calls.push({ id: call.id, tool: call.name, args: call.args, result: out.text, is_error: out.isError });
          const key = callKey(call);
          const before = seen.get(key);
          if (before === undefined || before !== out.text) learned = true;
          seen.set(key, out.text);
          history.push({ role: "tool", tool_call_id: call.id, name: call.name, content: out.text });
        }

        // The veto (ADOPT 4). "No new information" is the definition above:
        // same call, same answer. A model that keeps asking the same question
        // is not thinking, and it is spending money to do it.
        unproductive = learned ? 0 : unproductive + 1;
        if (unproductive >= UNPRODUCTIVE_VETO) {
          stopped = "veto";
          break;
        }
        if (unproductive >= UNPRODUCTIVE_WARN && !nudged) {
          nudged = true;
          history.push({ role: "user", content: NUDGE });
        }
      }

      // Out of turns, or vetoed: ask once more with tools off, so the run
      // ends in an answer rather than a stack trace (ADOPT 4's graceful reply).
      if (!text) {
        if (!stopped) stopped = "max_turns";
        const ask: ChatMessage = {
          role: "user",
          content:
            stopped === "veto"
              ? "Stop using tools. Answer now with what you already know, and say plainly what you could not find out."
              : stopped === "max_budget"
                ? "This run has reached its cost limit. Answer now with what you have, and say what is still open."
                : "You have run out of tool turns. Answer now with what you have, and say what is still open.",
        };
        closing = { at: history.length, message: ask };
        const final = await client.chat([...system, ...history, ask], { toolChoice: "none" });
        account(final);
        history.push(final.message);
        text = final.text;
      }
    } finally {
      await host.close();
    }

    await cfg.sessions.save({ id: sessionId, thread, provider: assignment.provider, model: assignment.model, messages: history });

    // ---- the session archive (archive.ts, T3-9) ----------------------------
    //
    // After the session is saved and before the shadow: the archive is the
    // REAL turn as sent, so the shadow's experiment never lands in it. The
    // messages are this turn's own — the replayed history is already in the
    // rows of the turns that wrote it — with the closing instruction put
    // back where it was sent. Caught on purpose, like the shadow's record: a
    // cache that failed to write must not turn a delivered reply into a
    // failed message.
    const notes: string[] = [];
    if (cfg.archive) {
      const own = history.slice(turnStart);
      const messages = closing ? [...own.slice(0, closing.at - turnStart), closing.message, ...own.slice(closing.at - turnStart)] : own;
      try {
        await cfg.archive.append({ session_id: sessionId, thread, turn_id: turnId, system_prompt: cfg.systemPrompt ?? "", messages, tool_calls: calls });
      } catch (err) {
        notes.push(`session archive not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ---- stage-2 shadow mode (shadow.ts) -----------------------------------
    //
    // AFTER the answer exists and the session is saved: the turn the user is
    // waiting on is finished before a token is spent on the experiment, and
    // nothing below can change `text`. The shadow gets NO session of its own —
    // a transcript that could be resumed would be a second history for one
    // thread — and its tool calls are stubbed record-only by construction.
    let shadow: ShadowRun | undefined;
    const candidate = assignment.shadow;
    if (candidate && shouldShadow(candidate, cfg.random ?? Math.random)) {
      // The shadow is a turn, so it asks the gate every turn asks — with its
      // OWN provider and critical: false, so `stop` and `critical_only` both
      // skip it while the interactive turn they let through keeps its answer.
      const shadowAssignment: ResolvedAssignment = {
        provider: candidate.provider,
        model: candidate.model,
        ref: candidate.ref,
        effort: assignment.effort,
        from: `shadow:${assignment.from}`,
        config: candidate.config,
        critical: false,
      };
      let allowed = true;
      try {
        await cfg.guard?.({ ...spec, model: candidate.model, assignment: shadowAssignment });
      } catch {
        allowed = false; // a refused budget skips the comparison; the real answer already happened
      }
      if (allowed) {
        shadow = await runShadow({
          makeClient: () =>
            makeChatClient({
              assignment: shadowAssignment,
              apiKey: credentialFor(candidate.config, candidate.provider, cfg.env ?? process.env),
              fetchFn: cfg.fetchFn,
              sleep: cfg.sleep,
              attempts: cfg.attempts,
              backoffMs: cfg.backoffMs,
              timeoutMs: cfg.timeoutMs,
            }),
          candidate,
          assignment,
          messages: [...system, ...opening],
          tools,
          recorded: seen,
          real: { text, tool_calls: toolSequence, messages: history },
          maxTurns,
          rubric: cfg.rubric,
        });
      }
    }

    if (costSource === "unknown" && assignment.config.locality === "off_machine") notes.unshift(unpricedNote(assignment.provider, assignment.model));
    const result: TurnResult = {
      text: text || "(the model returned no text)",
      session_id: sessionId,
      turn_id: turnId,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      provider: assignment.provider,
      model: assignment.model,
      cost_source: costSource,
      turns,
      // `!== undefined`, never truthiness: a reported zero is the reading
      // that says "the prefix was not stable", and dropping it would make a
      // cold cache indistinguishable from a provider that never answers the
      // question (OPEN-6).
      ...(usage.cache_read !== undefined ? { cache_read: usage.cache_read } : {}),
      ...(usage.cache_write !== undefined ? { cache_write: usage.cache_write } : {}),
      ...(Object.keys(toolsUsed).length > 0 ? { tools_used: toolsUsed } : {}),
      ...(stopped ? { stopped } : {}),
      ...(shadow ? { shadow } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
    return result;
  };
}
