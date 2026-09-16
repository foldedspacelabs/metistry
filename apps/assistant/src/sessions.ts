// Sessions for the in-house engine (0015_compute_engine).
//
// The Agent SDK kept the transcript for us and handed back a session id to
// resume. An OpenAI-compatible endpoint has no session at all — the message
// array IS the session — so the history has to live somewhere the container
// can restart without losing the thread. `assistant_sessions` is that
// somewhere: one row per session, keyed by the SAME uuid `sessions` uses, so
// a thread has one session id across both tables and core's `rollSession`
// ends it in both (a task boundary must not leave a replayable transcript
// behind — cost research decision 3).
//
// Deliberately not a transcript archive: the row is what the next turn
// replays, trimmed to a cap. Plan §4.16 rule 6 already says the transcript
// is a cache and re-briefing is the durable path.

import { randomUUID } from "node:crypto";

/** An OpenAI-shaped message. `tool_calls`/`tool_call_id` are passed through verbatim — the wire's shape is the stored shape, so nothing is translated twice. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: unknown[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
}

export interface SessionState {
  id: string;
  thread: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  turns: number;
}

export interface SessionDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** How much history one session replays. A cap, not a compaction strategy: what falls off the front is gone, and the re-brief path is what recovers it. */
export const MAX_HISTORY_MESSAGES = 60;
export const MAX_HISTORY_CHARS = 120_000;

/**
 * Trim from the FRONT, then advance to the first `user` message.
 *
 * The second half is what keeps the wire valid: a `tool` message whose
 * `assistant` tool_call was trimmed away is an error at every provider, and
 * an assistant turn that opens a conversation reads as a model talking to
 * itself. Dropping to the next user message costs one round and is the only
 * boundary that is correct for every provider.
 */
export function trimHistory(messages: readonly ChatMessage[], maxMessages = MAX_HISTORY_MESSAGES, maxChars = MAX_HISTORY_CHARS): ChatMessage[] {
  let out = [...messages];
  const size = (m: ChatMessage): number => (typeof m.content === "string" ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  let chars = out.reduce((n, m) => n + size(m), 0);
  while (out.length > maxMessages || chars > maxChars) {
    const dropped = out.shift();
    if (!dropped) break;
    chars -= size(dropped);
  }
  const first = out.findIndex((m) => m.role === "user");
  return first <= 0 ? out : out.slice(first);
}

export interface SessionStore {
  /** The history to replay, or null when the id is unknown, rolled, or was built against a different (provider, model). */
  load(id: string, provider: string, model: string): Promise<SessionState | null>;
  /** Persist the turn. Returns the session id — the caller's `resume` for the next turn. */
  save(state: Omit<SessionState, "turns">): Promise<string>;
  /** A fresh id. Minted here so the engine never invents one shape and the store another. */
  newId(): string;
}

/**
 * The Postgres store. A session whose (provider, model) no longer matches
 * the assignment is NOT resumed: replaying a Claude transcript into a local
 * model — or the reverse — produces a turn neither model would have written,
 * and re-assignment is exactly the moment a fresh session is cheap.
 */
export function pgSessionStore(db: SessionDb): SessionStore {
  return {
    newId: () => randomUUID(),
    async load(id, provider, model) {
      const { rows } = await db.query(
        `SELECT id, thread, provider, model, messages, turns FROM assistant_sessions WHERE id = $1 AND rolled_at IS NULL`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      if (String(row.provider) !== provider || String(row.model) !== model) return null;
      return {
        id: String(row.id),
        thread: String(row.thread),
        provider: String(row.provider),
        model: String(row.model),
        messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
        turns: Number(row.turns ?? 0),
      };
    },
    async save(state) {
      await db.query(
        `INSERT INTO assistant_sessions (id, thread, provider, model, messages, turns)
         VALUES ($1, $2, $3, $4, $5::jsonb, 1)
         ON CONFLICT (id) DO UPDATE SET messages = EXCLUDED.messages, last_active_at = now(),
           turns = assistant_sessions.turns + 1`,
        [state.id, state.thread, state.provider, state.model, JSON.stringify(trimHistory(state.messages))],
      );
      return state.id;
    },
  };
}

/** The store a turn gets when nothing persists history (tests, and a tool-less smoke run): in memory, per process. */
export function memorySessionStore(): SessionStore {
  const rows = new Map<string, SessionState>();
  return {
    newId: () => randomUUID(),
    async load(id, provider, model) {
      const s = rows.get(id);
      if (!s || s.provider !== provider || s.model !== model) return null;
      return { ...s, messages: [...s.messages] };
    },
    async save(state) {
      const existing = rows.get(state.id);
      rows.set(state.id, { ...state, messages: trimHistory(state.messages), turns: (existing?.turns ?? 0) + 1 });
      return state.id;
    },
  };
}
