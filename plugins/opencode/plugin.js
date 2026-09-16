// The OpenCode plugin (plan refresh §4b W5): one finished session, one note in
// the inbox, with the same `kind: "session"` frontmatter and the same
// `idempotency_key` formula as `plugins/claude-code`, `plugins/cursor` and
// `metistry import-sessions` — so the console dedupes across every door and
// `inbox-drain` classifies all of them the same way.
//
// Default OFF: does nothing unless METISTRY_CAPTURE_ON_STOP=1, the same switch
// the other two plugins use, so one export covers whichever tool the session
// happened in. No model is called: the transcript is measured, never
// interpreted.
//
// Shape verified against opencode.ai/docs/plugins and a running OpenCode
// 1.18.30 on 2026-09-16:
//
//   * a plugin is a JS/TS module exporting `async ({ project, client, $,
//     directory, worktree }) => hooks`; the context this version passes is
//     `{ client, project, worktree, directory, experimental_workspace,
//     serverUrl, $ }`.
//   * the hook for events is `event: async ({ event }) => …` and the event
//     that means "a session finished" is `session.idle`, whose payload is
//     `{ id, type, properties: { sessionID } }`.
//   * `~/.config/opencode/plugins/` (global) and `.opencode/plugins/`
//     (project) are scanned for `.js` and `.ts` files. `.mjs` is NOT loaded —
//     which is why this file is `.js` where the rest of the plugin is `.mjs`.
//
// Why a quiet window rather than a straight capture on the event: OpenCode has
// no session-end event, and `session.idle` fires every time the assistant stops
// talking. Capturing on each one would put a note in the inbox per turn. So an
// idle arms a timer (METISTRY_OPENCODE_IDLE_MS, default 90 s), a further idle
// re-arms it, and the capture happens once the session has actually gone quiet.
// The timer is unref'd: a capture is never the reason OpenCode is still open.
//
// What that cannot reach, measured rather than assumed (OpenCode 1.18.30,
// 2026-09-16): a one-shot `opencode run "…"` exits 17 ms after `session.idle`
// on the success path and ~100 ms on the error path, `beforeExit` never fires,
// and an event hook's promise is not awaited — a plugin that slept 4 s in the
// hook was cut off mid-sleep. So nothing asynchronous can complete there, and
// this plugin captures the sessions whose process outlives them: the TUI, the
// desktop app, and `opencode serve`/`attach`. docs/ops/opencode.md says so in
// the same words rather than leaving anyone to debug it twice.
//
// Failure is silent by contract: every path resolves, nothing is ever thrown at
// OpenCode, and nothing is written to stdout (a `console.log` would corrupt the
// TUI) — the plugin reports through `client.app.log`, which is what the docs
// ask for. With METISTRY_CAPTURE_DIR set, an unreachable console means the note
// is written there instead of dropped (SHOULD-10).

import { config, captureSession, readMessages, readSession, redact, summarizeSession, unreadableSession } from "./scripts/lib.mjs";

/**
 * The event hook's own contract, hand-typed from the docs rather than imported:
 * `@opencode-ai/plugin` is a types-only dev dependency and this repo asks
 * before adding one (CLAUDE.md, "Ask before adding a dependency").
 *
 * @typedef {{ type?: string, properties?: { sessionID?: string } }} OpenCodeEvent
 * @typedef {{ session: { get: Function, messages: Function }, app?: { log?: Function } }} OpenCodeClient
 * @typedef {{ client: OpenCodeClient, directory?: string, worktree?: string, project?: unknown }} OpenCodeContext
 */

/** Timers, injected so the tests drive the quiet window without waiting for it. */
const realTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // A capture must never be the reason OpenCode is still running.
    if (typeof t?.unref === "function") t.unref();
    return t;
  },
  clear: (t) => clearTimeout(t),
};

/**
 * The capture machine, separated from the hook so every branch is testable
 * without an OpenCode: `onEvent` for what arrives, `flush` for what is still
 * armed when the process is about to exit.
 *
 * @param {{
 *   client: OpenCodeClient,
 *   directory?: string | null,
 *   env?: Record<string, string | undefined>,
 *   fetchFn?: typeof fetch,
 *   timers?: { set: (fn: () => void, ms: number) => unknown, clear: (handle: never) => void },
 *   now?: () => Date,
 *   log?: (message: string, level?: string) => Promise<unknown>,
 * }} options
 */
export function createCapturer({ client, directory = null, env = process.env, fetchFn = fetch, timers = realTimers, now = () => new Date(), log = async () => {} }) {
  /** sessionID → timer handle */
  const armed = new Map();
  /** sessionID → the last key delivered, so a flush right after a timer fire is not a second call */
  const sent = new Map();

  async function capture(sessionId) {
    armed.delete(sessionId);
    let summary = null;
    try {
      const messages = await readMessages(client, sessionId);
      if (messages === null) {
        summary = unreadableSession(sessionId, { directory, reason: "the client returned no message list" });
      } else {
        let session = null;
        try {
          session = await readSession(client, sessionId);
        } catch {
          session = null; // the messages are the summary; the session row only adds the version and the directory
        }
        summary = summarizeSession(messages, { session: session ?? { id: sessionId }, directory });
      }
    } catch (err) {
      summary = unreadableSession(sessionId, { directory, reason: String(err?.message ?? err).slice(0, 120) });
    }
    // A session with no conversation in it is not a note anyone wants.
    if (!summary) return { state: "empty", sessionId };

    const key = `${summary.sessionId ?? sessionId}:${summary.ended ?? ""}:${summary.turns ?? ""}:${summary.assistantMessages ?? ""}`;
    if (sent.get(sessionId) === key) return { state: "unchanged", sessionId };

    try {
      const r = await captureSession({ summary, env, fetchFn, now: now() });
      sent.set(sessionId, key);
      await log(r.delivered === "file" ? `console unreachable (${r.reason}) — session saved to ${r.path}` : `session captured → inbox #${r.id ?? "?"}`, r.delivered === "file" ? "warn" : "info");
      return { state: r.delivered, sessionId, ...r };
    } catch (err) {
      await log(`session capture skipped: ${redact(err?.message ?? err, config(env).token)}`, "warn");
      return { state: "failed", sessionId, reason: String(err?.message ?? err) };
    }
  }

  return {
    armed,
    /** Handle one OpenCode event. Resolves to what it did, which is what the tests assert on. */
    async onEvent(event) {
      if (env.METISTRY_CAPTURE_ON_STOP !== "1") return "off";
      const type = event?.type;
      if (type === "session.deleted") {
        const id = event?.properties?.sessionID;
        if (id && armed.has(id)) {
          timers.clear(armed.get(id));
          armed.delete(id);
          return "cancelled";
        }
        return "ignored";
      }
      if (type !== "session.idle") return "ignored";
      const id = event?.properties?.sessionID;
      if (typeof id !== "string" || id === "") return "ignored";
      if (armed.has(id)) timers.clear(armed.get(id));
      armed.set(
        id,
        timers.set(() => {
          void capture(id);
        }, config(env).idleMs),
      );
      return "armed";
    },
    /** Capture everything still waiting for its quiet window — the one-shot `opencode run` path. */
    async flush() {
      const ids = [...armed.keys()];
      for (const id of ids) timers.clear(armed.get(id));
      const results = [];
      for (const id of ids) results.push(await capture(id));
      return results;
    },
    capture,
  };
}

/** The plugin OpenCode loads. One hook, one event, everything else untouched. */
export const MetistryPlugin = async (ctx) => {
  const client = ctx?.client;
  const capturer = createCapturer({
    client,
    directory: ctx?.worktree ?? ctx?.directory ?? null,
    // Structured logging, as the docs ask: never stdout, which the TUI owns.
    log: async (message, level = "info") => {
      try {
        await client?.app?.log?.({ body: { service: "metistry", level, message } });
      } catch {
        /* a log line is never worth failing a session over */
      }
    },
  });

  // No `beforeExit` hook here on purpose: it was tried and it does not fire —
  // OpenCode ends a one-shot run with an outright `process.exit`. `flush()`
  // stays on the capturer as the seam a caller WITH a real shutdown signal
  // would use (and as what the tests drive), but registering a handler that
  // provably never runs would be worse than the gap it pretends to close.
  return {
    event: async ({ event }) => {
      try {
        await capturer.onEvent(event);
      } catch {
        /* a capture door never throws at the tool it lives in */
      }
    },
  };
};
