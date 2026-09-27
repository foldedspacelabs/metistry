// The session archive's writer (T3-9; migration 0030, §4 Q16).
//
// Every turn the engine finishes is appended here, one row per turn: the
// system prompt exactly as sent, the messages this turn added, and each tool
// call with its arguments and its result — so Run detail can show the
// working conversation itself (`session_detail`, screen-12 §5) and the
// session fold (T3-10) can learn from it before it expires.
//
// Three properties, each held by the code rather than by a caller:
//
//   * REDACTED AT THE TOOL. `append` runs every argument and every result
//     through core's `redactSecrets` itself — including the copies of both
//     that ride inside the messages (an assistant message's
//     `tool_calls[].function.arguments`, a `tool` message's content). There
//     is no way to hand this store a turn and have it land unredacted, so no
//     future caller can forget to.
//   * EPHEMERAL. `expires_at` is set HERE, 30 days out, never by a caller:
//     the archive is a cache (invariant 1 — lost on `down -v`, nothing
//     durable depends on it), and the purge routine
//     (`routines/session-purge`) deletes what has passed it.
//   * UNFOLDED ON ARRIVAL. `folded_at` is never written here: a new turn is
//     NULL, i.e. in the fold's queue, until the fold itself says otherwise.
//
// Invariant 9 is untouched: this is not a tool. The model cannot reach it,
// name it or skip it — the loop calls it after the turn, the same way it
// saves `assistant_sessions` — and it writes one table the assistant process
// already owns, never the vault and never git.
//
// Read-only for the engine: nothing here is ever replayed. What the next turn
// sees is `assistant_sessions` (sessions.ts), trimmed; this is the record of
// what happened, kept for a month.

import { redactSecrets } from "@foldedspacelabs/metistry-core";
import type { ChatMessage } from "./sessions.js";

/** How long an archived turn lives (§4 Q16, screen-12 §4: "Keep sessions — 30 days"). The purge routine's retention may be shorter, never longer. */
export const ARCHIVE_TTL_DAYS = 30; // limit: fixed — the owner's ruling (§4 Q16); `session_detail` hides a row past it, so a longer retention could keep nothing anyone can read

/** One tool call as the archive keeps it: what was asked and what came back, both redacted. */
export interface ArchivedToolCall {
  /** The provider's call id — the `tool_call_id` its `tool` message answers. */
  id: string;
  /** Fully qualified, as every `runs` row spells it (`mcp__brain__knowledge_search`). */
  tool: string;
  args: unknown;
  /** The result: parsed JSON when the tool answered JSON (so a secret-named key in it is redactable), else the text. */
  result: unknown;
  is_error: boolean;
}

/** One finished turn, as the loop hands it over. */
export interface TurnRecord {
  /** The engine session (`assistant_sessions.id` = `sessions.id`). */
  session_id: string;
  thread: string;
  /** The same handle the turn's tool calls carried in `_meta`, and its `runs` row carries in `meta.turn_id`. */
  turn_id: string;
  /** The system prompt as sent. Empty when the turn ran with none. */
  system_prompt: string;
  /** The messages THIS turn added, in order — never the replayed history, which earlier rows already hold. */
  messages: ChatMessage[];
  tool_calls: ArchivedToolCall[];
}

export interface SessionArchive {
  /** Append one turn. Redacts before it writes; a second append of the same (session, turn) is a no-op. */
  append(turn: TurnRecord): Promise<void>;
}

export interface ArchiveDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// ---- redaction ------------------------------------------------------------------

/**
 * A tool's text through `redactSecrets`. The key-based pass needs keys, so
 * text that IS JSON is parsed, redacted and re-serialised; text that is not
 * JSON has no keys to find and comes back as it was.
 */
export function redactToolText(text: string): string {
  const parsed = parseJson(text);
  return parsed === undefined ? text : JSON.stringify(redactSecrets(parsed));
}

/** A tool result as the archive's `tool_calls` column keeps it: redacted JSON where it parses, the text otherwise. */
export function redactResult(text: string): unknown {
  const parsed = parseJson(text);
  return parsed === undefined ? text : redactSecrets(parsed);
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined; // a bare string or number has no key to redact
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/** An OpenAI-shaped `tool_calls` entry with its `function.arguments` — a JSON string on the wire — redacted. */
function redactWireCall(call: unknown): unknown {
  if (call === null || typeof call !== "object") return call;
  const c = call as Record<string, unknown>;
  const fn = c.function;
  if (fn === null || typeof fn !== "object") return redactSecrets(c);
  const f = fn as Record<string, unknown>;
  const args = typeof f.arguments === "string" ? redactToolText(f.arguments) : redactSecrets(f.arguments);
  return { ...redactSecrets(c), function: { ...redactSecrets(f), arguments: args } };
}

/** One message with every tool argument and tool result in it redacted. */
export function redactMessage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { ...m };
  if (m.role === "tool" && typeof m.content === "string") out.content = redactToolText(m.content);
  if (m.tool_calls) out.tool_calls = m.tool_calls.map(redactWireCall);
  return out;
}

/** The whole turn, redacted: arguments and results wherever they appear. Pure — the input is not touched. */
export function redactTurn(turn: TurnRecord): TurnRecord {
  return {
    ...turn,
    messages: turn.messages.map(redactMessage),
    tool_calls: turn.tool_calls.map((c) => ({
      ...c,
      args: redactSecrets(c.args),
      result: typeof c.result === "string" ? redactResult(c.result) : redactSecrets(c.result),
    })),
  };
}

// ---- stores ---------------------------------------------------------------------

/**
 * The Postgres archive. `ON CONFLICT DO NOTHING` on the (session, turn)
 * unique index: a retried append — the drain retrying a turn after the
 * insert landed — cannot duplicate a turn, and the first write wins.
 * `expires_at` is the database's clock, like every other timestamp the
 * purge compares against.
 */
export function pgSessionArchive(db: ArchiveDb): SessionArchive {
  return {
    async append(turn) {
      const r = redactTurn(turn);
      await db.query(
        `INSERT INTO session_archive (session_id, thread, turn_id, system_prompt, messages, tool_calls, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, now() + make_interval(days => $7::int))
         ON CONFLICT (session_id, turn_id) DO NOTHING`,
        [r.session_id, r.thread, r.turn_id, r.system_prompt, JSON.stringify(r.messages), JSON.stringify(r.tool_calls), ARCHIVE_TTL_DAYS],
      );
    },
  };
}

/** In memory, for tests: what `append` would have written, redacted exactly as the Postgres store redacts it. */
export function memorySessionArchive(): SessionArchive & { rows: TurnRecord[] } {
  const rows: TurnRecord[] = [];
  return {
    rows,
    async append(turn) {
      const r = redactTurn(turn);
      if (!rows.some((x) => x.session_id === r.session_id && x.turn_id === r.turn_id)) rows.push(r);
    },
  };
}
