// The OpenAI-compatible half of the bridge: `GET /v1/models` and
// `POST /v1/chat/completions`, translated to and from the Swift helper's
// stdio protocol. Pure functions — no sockets, no child process — so every
// refusal below is a unit test rather than a thing you find out in
// production (PoC-19's design, with the wire contract it did not have).
//
// WHY THIS SHAPE AT ALL. The engine already speaks `/v1` to every provider
// (`apps/assistant/src/engine-openai.ts`). Making Apple Foundation Models a
// provider rather than a special case means `compute.yaml` can point at it
// with the same four lines as LM Studio, and nothing engine-side changes
// except the rule that on-machine providers run with reasoning off. The
// research note called this option (b); option (a) — a bespoke `kind:
// apple-fm` over `/classify` — stays rejected.
//
// WHAT IS DELIBERATELY REFUSED, each with the field named:
//   stream: true       no SSE mapping is proven (PoC-19 did not verify it)
//   tools:             tool calling is out of scope for v1
//   n > 1              one generation per request; serial by design
//   logprobs: true     Apple Foundation Models exposes no token probabilities
//   top_logprobs > 0   same — nothing to return even if `logprobs` is unset
//   embeddings         Apple exposes no embedding model here
//
// ERROR SHAPE. `/check` and `/classify` keep Metistry's uniform envelope
// (`{error:{code,message}}`, core's `errorEnvelope`). `/v1/*` answers in
// OpenAI's (`{error:{message,type,code}}`) because its caller is an OpenAI
// client that reads `error.message` — the same reason the route exists.
// Both carry a `code`; only the sibling fields differ.
//
// REDACTION moves, and does not vanish. `/classify` scrubs the model's
// `action` text before returning it (PoC-13's OTP lesson). `/v1` cannot: a
// provider surface must hand back exactly what the model said, or a JSON
// payload comes back corrupted and `strict: true` was a lie. So the scrub
// moves to the caller — `completeJson()` in the collectors package runs it
// over every string leaf of the parsed result, which is where `/classify`'s
// guarantee lived anyway.

/** The one model id this provider serves, matching the helper's `MODEL_ID`. */
export const MODEL_ID = "foundation-model";

export interface OpenAiError {
  error: { message: string; type: string; code: string };
}

export function openAiError(message: string, code: string, type = "invalid_request_error"): OpenAiError {
  return { error: { message, type, code } };
}

/** The helper's own code for a failure → the HTTP status the caller sees. Anything unrecognised is a 500: an unknown failure is ours, not the caller's. */
export function statusForHelperCode(code: string | undefined): number {
  switch (code) {
    case "invalid_request":
    case "unsupported_schema":
    case "context_length_exceeded":
      return 400;
    case "not_available":
    case "model_unavailable":
      return 503;
    default:
      return 500;
  }
}

/** OpenAI's `error.type` for the same code, so a client's own error handling sees the class it expects. */
export function typeForHelperCode(code: string | undefined): string {
  return statusForHelperCode(code) === 400 ? "invalid_request_error" : "server_error";
}

export function modelsList(now = Date.now()): unknown {
  return {
    object: "list",
    data: [{ id: MODEL_ID, object: "model", created: Math.floor(now / 1000), owned_by: "apple" }],
  };
}

/** What the helper is asked for: one prompt, optional instructions, optional schema. */
export interface HelperComplete {
  op: "complete";
  prompt: string;
  instructions?: string;
  schema?: unknown;
  temperature?: number;
  max_tokens?: number;
}

export type Translated = { ok: true; request: HelperComplete } | { ok: false; status: number; body: OpenAiError };

const bad = (message: string, code: string, status = 400): Translated => ({ ok: false, status, body: openAiError(message, code) });

/**
 * An OpenAI chat request → the helper's request.
 *
 * `system`/`developer` messages become Foundation Models' `Instructions`;
 * everything else becomes one prompt — unlabelled when there is a single
 * turn, role-labelled when the caller sent a history. (PoC-19 wrote the
 * multi-turn form but measured only the single-turn one; it is exercised
 * here by a unit test and by nothing else yet.)
 */
export function translateChatRequest(raw: unknown): Translated {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("body is not a JSON object", "bad_json");
  const body = raw as Record<string, unknown>;

  if (body.stream === true) return bad("`stream` is not implemented — this provider answers in one piece (docs/ops/compute.md \"Apple Foundation Models\")", "stream_unsupported");
  if (body.tools !== undefined) return bad("`tools` is not supported: tool calling is out of scope for this provider's v1 surface", "tools_unsupported");
  if (typeof body.n === "number" && body.n !== 1) return bad("`n` must be 1 — this provider generates one completion per request, serially", "n_unsupported");
  if (body.logprobs === true) return bad("`logprobs` is not supported: Apple Foundation Models exposes no token probabilities", "logprobs_unsupported");
  if (typeof body.top_logprobs === "number" && body.top_logprobs !== 0) return bad("`top_logprobs` is not supported: Apple Foundation Models exposes no token probabilities", "logprobs_unsupported");

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return bad("`messages` is required and must be a non-empty array", "missing_messages");

  const systemParts: string[] = [];
  const turns: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) return bad("every entry of `messages` must be an object with a role and string content", "invalid_message");
    const msg = m as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "user";
    // Only string content: this provider has no vision and no audio, so a
    // content-parts array would be silently dropping half the request.
    if (typeof msg.content !== "string") return bad("`messages[].content` must be a string — this provider takes no content parts, images or audio", "invalid_message");
    if (role === "system" || role === "developer") systemParts.push(msg.content);
    else turns.push({ role, content: msg.content });
  }
  if (turns.length === 0) return bad("`messages` carries only system content — add a user message", "missing_messages");

  const request: HelperComplete = {
    op: "complete",
    prompt: turns.length === 1 ? turns[0]!.content : turns.map((t) => `${t.role}: ${t.content}`).join("\n"),
    ...(systemParts.length > 0 ? { instructions: systemParts.join("\n\n") } : {}),
  };

  const rf = body.response_format;
  if (rf !== undefined) {
    if (typeof rf !== "object" || rf === null) return bad("`response_format` must be an object", "unsupported_response_format");
    const kind = (rf as Record<string, unknown>).type;
    if (kind === "json_schema") {
      const js = (rf as Record<string, unknown>).json_schema;
      const schema = typeof js === "object" && js !== null ? (js as Record<string, unknown>).schema : undefined;
      if (schema === undefined) return bad("`response_format.json_schema.schema` is required", "missing_schema");
      request.schema = schema;
    } else if (kind === "json_object") {
      return bad("`response_format: json_object` has no schema to constrain on — use `json_schema`, which this provider enforces at generation time", "unsupported_response_format");
    } else if (kind !== "text") {
      return bad(`unsupported \`response_format.type\`: ${JSON.stringify(kind)}`, "unsupported_response_format");
    }
  }

  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || body.temperature < 0) return bad("`temperature` must be a non-negative number", "invalid_request");
    if (body.temperature > 0) request.temperature = body.temperature;
  }
  const max = body.max_tokens ?? body.max_completion_tokens;
  if (max !== undefined) {
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return bad("`max_tokens` must be a positive integer", "invalid_request");
    request.max_tokens = max;
  }
  return { ok: true, request };
}

export interface HelperCompletion {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  /** false on macOS < 26.4, where `tokenCount(for:)` does not exist */
  usage_ok: boolean;
  schema_mode: string;
  respond_ms: number;
}

/**
 * The helper's completion → an OpenAI `chat.completion`.
 *
 * `usage` is OMITTED, not zeroed, when the helper could not count: a
 * confident `{prompt_tokens: 0}` would be a lie the `runs` row would then
 * repeat. `x_metistry` says which happened; every OpenAI client ignores it.
 */
export function chatCompletion(c: HelperCompletion, opts: { id: string; now?: number }): unknown {
  return {
    id: `chatcmpl-${opts.id}`,
    object: "chat.completion",
    created: Math.floor((opts.now ?? Date.now()) / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content: c.content }, finish_reason: "stop" }],
    ...(c.usage_ok
      ? { usage: { prompt_tokens: c.prompt_tokens, completion_tokens: c.completion_tokens, total_tokens: c.prompt_tokens + c.completion_tokens } }
      : {}),
    x_metistry: {
      cost_usd: 0,
      schema_mode: c.schema_mode,
      respond_ms: c.respond_ms,
      ...(c.usage_ok ? {} : { usage: "unavailable: tokenCount(for:) needs macOS 26.4" }),
    },
  };
}
