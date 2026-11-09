// The `devin-session` submit adapter (W6 of docs/plan-refresh-2026-09-13.md
// §4b): everything about turning a brief into a Devin session request that
// does not need the network. `dispatch.ts` owns the fetch; this file owns
// the prompt, the structured-output contract and its validation, so both are
// testable without a fake server.
//
// Verified against docs.devin.ai on 2026-09-15 (`/v3-openapi.json`):
//
//   Create  POST /v3/organizations/{org_id}/sessions, Bearer `cog_…`.
//           SessionCreateRequest requires `prompt` ONLY; the fields used
//           here are `title`, `tags`, `max_acu_limit`,
//           `structured_output_schema` ("JSON Schema (Draft 7) … Max 64KB.
//           Must be self-contained (no external $ref)") and
//           `structured_output_required` ("When true (default), the agent
//           MUST call provide_structured_output with is_final=true before
//           its turn ends").
//   Answers SessionResponse { session_id, url, status, tags, org_id,
//           created_at, updated_at, acus_consumed, pull_requests, … }.
//   NO idempotency. There is no `Idempotency-Key` header anywhere in the v3
//           spec — it declares no header parameters at all — and unlike v1's
//           CreateSessionParams there is no `idempotent` boolean either.
//           (PR #143 could not verify this; now it is verified NEGATIVE.)
//           So dedupe is ours: the work row's `external_ref` is bound under
//           a unique index in the same statement, one session per row, and
//           every session carries a `metistry:task:<id>` tag so a duplicate
//           is findable from Devin's side too.

/**
 * Why the brief is going. Deliberately a `purpose` on the dispatch call
 * rather than a new `work.kind`: `packages/tasks` owns exactly two claimable
 * kinds (`task`, `review`) and github-state owns the rest, so a third would
 * ripple through claiming, the fold and the reconciler for no gain. The
 * purpose selects a preamble and lands on the runs row and the work row.
 *
 * The purposes are not a list in this file any more (plan §2.7, T4-11): they
 * are the Devin connection type's (`seed/connection-types/devin/manifest.yaml`,
 * `dispatch.purposes`), each with its preamble, and an owner's overlay of
 * that type may add or reword one. What stays here is the answer contract —
 * the structured output and the words that ask for it — because that is a
 * control, not a manifest line.
 */
export type DevinPurpose = string;
/** What a dispatch records as its purpose when its target takes none (a GitHub issue). */
export const DEFAULT_PURPOSE: DevinPurpose = "work";

/** Default ACU ceiling when neither the manifest nor the caller names one. Small on purpose. */
export const DEFAULT_MAX_ACU = 5;  // limit: fixed — the floor when nothing names one; the manifest and the caller both override it
/** Devin's own cap on the schema (documented: "Max 64KB"). */
export const MAX_SCHEMA_BYTES = 64 * 1024;  // limit: fixed — Devin's own documented cap — ours cannot be larger than theirs

/**
 * The answer contract. Sent as `structured_output_schema`, so
 * `structured_output_required`'s default (true) means the session cannot end
 * without filling it in — the return is machine-checkable before it becomes
 * a proposal, which is the reason to prefer this target over an issue for
 * research.
 */
export const DEVIN_ANSWER_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "MetistryAnswer",
  type: "object",
  additionalProperties: false,
  required: ["answer", "sources", "confidence", "open_questions"],
  properties: {
    answer: {
      type: "string",
      description: "The answer in Markdown, self-contained: assume the reader cannot see this session.",
    },
    sources: {
      type: "array",
      description: "Where each claim came from — repo path, file, URL, document title. Empty when the answer is from your own reasoning alone.",
      items: { type: "string" },
    },
    confidence: {
      type: "string",
      description: "How sure you are of the answer as a whole.",
      enum: ["high", "medium", "low"],
    },
    open_questions: {
      type: "array",
      description: "What you could not determine, and what would settle it. Empty when nothing is open.",
      items: { type: "string" },
    },
  },
} as const;

// --- Draft-7 conformance (enforced at the tool, not assumed) ------------------

const DRAFT7_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
// Keywords introduced after Draft 7. A schema carrying one is not Draft 7,
// whatever its $schema says, and Devin documents Draft 7.
const POST_DRAFT7 = ["$defs", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "prefixItems", "unevaluatedItems", "unevaluatedProperties", "dependentRequired", "dependentSchemas"];

/**
 * Every way the answer schema could fail what Devin documents: Draft 7,
 * ≤ 64 KB, self-contained (no external `$ref`). Returns every problem found;
 * empty means it may be sent. `submitDevin` refuses a non-empty result — a
 * malformed contract must not leave as an unvalidated blob.
 */
export function schemaIssues(schema: unknown): string[] {
  const out: string[] = [];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return ["schema must be a JSON object"];
  const root = schema as Record<string, unknown>;
  if (typeof root.$schema !== "string" || !root.$schema.includes("draft-07")) {
    out.push('$schema must name draft-07 ("http://json-schema.org/draft-07/schema#")');
  }
  if (root.type !== "object") out.push('top-level type must be "object" (Devin validates an object against it)');
  const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (bytes > MAX_SCHEMA_BYTES) out.push(`schema is ${bytes} bytes; Devin's documented cap is ${MAX_SCHEMA_BYTES}`);

  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("$ref" in obj) out.push(`${where}: $ref is not allowed — the schema must be self-contained`);
    for (const k of POST_DRAFT7) if (k in obj) out.push(`${where}: "${k}" is not a Draft 7 keyword`);
    if ("type" in obj) {
      const types = Array.isArray(obj.type) ? obj.type : [obj.type];
      for (const t of types) if (typeof t !== "string" || !DRAFT7_TYPES.has(t)) out.push(`${where}: unknown type ${JSON.stringify(t)}`);
    }
    const props = obj.properties;
    if (props !== undefined) {
      if (props === null || typeof props !== "object" || Array.isArray(props)) out.push(`${where}.properties must be an object`);
      else for (const [k, v] of Object.entries(props)) walk(v, `${where}.properties.${k}`);
    }
    if (Array.isArray(obj.required)) {
      const known = props && typeof props === "object" ? Object.keys(props as object) : [];
      for (const r of obj.required) {
        if (typeof r !== "string") out.push(`${where}.required entries must be strings`);
        else if (known.length > 0 && !known.includes(r)) out.push(`${where}.required names "${r}", which is not in properties`);
      }
    }
    for (const k of ["items", "additionalProperties", "not", "if", "then", "else", "allOf", "anyOf", "oneOf"]) {
      if (k in obj) walk(obj[k], `${where}.${k}`);
    }
  };
  walk(schema, "(root)");
  return out;
}

// --- the prompt ----------------------------------------------------------------

const COMMON = [
  "You are answering for an automated knowledge system, not for a person reading this session.",
  "",
  "Finish by calling `provide_structured_output` with `is_final=true`, filling every field of the",
  "schema you were given: `answer` (Markdown, self-contained — assume the reader cannot see this",
  "session), `sources` (where each claim came from), `confidence` (high|medium|low) and",
  "`open_questions` (what you could not determine). An empty array is a valid answer to the last two;",
  "an empty `answer` is not.",
];

export interface PromptInput {
  brief: string;
  taskId: number;
  target: string;
  purpose: DevinPurpose;
  /** the purpose's preamble, from the target's connection type (`dispatch.purposes.<purpose>.preamble`) */
  preamble: string;
}

/**
 * The trailer every dispatched brief carries: who sent it and how the answer
 * gets home. Names no assistant (CLAUDE.md: the name lives in identity.yaml).
 */
export function devinFooter(taskId: number, target: string): string {
  return [
    "---",
    `_Dispatched from metistry — task #${taskId} via target \`${target}\`._`,
    "_Return path: this session is polled; the structured output becomes a report for the owner to triage._",
    "_Nothing you write back to this session is read. The structured output is the whole return._",
  ].join("\n");
}

export function devinPrompt(input: PromptInput): string {
  return `${[input.preamble.trimEnd(), ...COMMON].join("\n")}\n\n---\n\n${input.brief.trimEnd()}\n\n${devinFooter(input.taskId, input.target)}\n`;
}

// --- the request body ------------------------------------------------------------

export interface DevinSessionBodyInput extends PromptInput {
  title: string;
  maxAcu: number;
}

/** `POST /v3/organizations/{org}/sessions` body. Pure — no env, no fetch. */
export function devinSessionBody(input: DevinSessionBodyInput): Record<string, unknown> {
  return {
    prompt: devinPrompt(input),
    title: `metistry task #${input.taskId}: ${input.title}`.slice(0, 200),
    // Tags are our dedupe handle from Devin's side: v3 create takes no
    // Idempotency-Key, so "did I already dispatch this row?" is answerable by
    // listing sessions on the task tag.
    tags: [`metistry:task:${input.taskId}`, `metistry:purpose:${input.purpose}`],
    max_acu_limit: input.maxAcu,
    structured_output_schema: DEVIN_ANSWER_SCHEMA,
    // Explicit, though true is the documented default: the contract is the
    // point of this target, so it is stated rather than inherited.
    structured_output_required: true,
  };
}

/** The `max_acu_limit` actually sent: the dispatch call, else the manifest's `submit.max_acu`, else `DEFAULT_MAX_ACU`. */
export function resolveMaxAcu(fromCall: number | undefined, fromManifest: unknown): number {
  for (const candidate of [fromCall, fromManifest]) {
    const n = Number(candidate);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_ACU;
}
