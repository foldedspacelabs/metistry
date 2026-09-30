// The end of a session (T8-2b): every ended recording's transcript goes to
// the console's `POST /capture` — "what a recording produces reaches
// Metistry through POST /capture like any capture" (plan §2.2) — as one
// Markdown capture with `kind: transcript` frontmatter (daily-flow-spec §8.4).
//
// Three rules, each a mechanism:
//
//   * THE KEY. `Idempotency-Key: live-capture:<session id>`. The console scopes
//     a key to the credential class and answers a replay with the original
//     row, so a delivery retried after a crash, a timeout or a console restart
//     lands once (docs/ops/client-api.md).
//   * THE HELPER'S RECORD DECIDES. A session is owed until the helper has
//     written where it went (`delivered`), and it writes that only after the
//     console answered 201 with a row id. Anything else — the console down, a
//     refused credential, a body it would not take — leaves the session owed,
//     and the next sweep tries again. Nothing is ever deleted here.
//   * ITS OWN CREDENTIAL. The capture owner token (`METISTRY_LIVE_CAPTURE_INBOX_TOKEN`,
//     an `owner_tokens` row: capture and messages only, CRIT-7) — never the
//     bridge token a tool caller holds, never the bar's control token. A
//     bridge configured with one token in two roles refuses to start
//     (src/index.ts).
//
// Nothing a caller of the bridge sends reaches this: the sweep runs on a
// timer and after the owner's Stop, and the helper ops it uses (`owed`,
// `transcript`, `delivered`) have no route.
//
// A crash is the helper's to find (it ends the session as `crashed` at its
// last write when it next starts); this file carries that word into the
// frontmatter, and the inbox drain raises the ONE report from it
// (collectors/inbox-drain, C137).

import { errorEnvelope } from "@foldedspacelabs/metistry-core";
import type { HelperClient } from "./helper.js";

export interface DeliveryConfig {
  /** Where `POST /capture` is — the console, from this Mac. */
  consoleUrl: string;
  /** The capture owner token. Never the bridge token or the control token. */
  inboxToken: string;
  fetchFn?: typeof fetch;
  /** Per request (default 30 s). */
  timeoutMs?: number;
}

/** A session as the helper's `session.json` stores it (the fields read here). */
export interface SessionRecordJson {
  session_id: string;
  started_at: string;
  ended_at?: string | null;
  ended_reason?: string | null;
  apps?: string[];
  app_audio?: boolean;
  microphone?: boolean;
  gaps?: { from_s: number; to_s: number; reason: string }[];
  delivery?: { inbox_id: number; at: string } | null;
  /** The audio bytes kept on this Mac when the transcript was read (T8-4) — the console's `capture_sessions.media_bytes`. */
  media_bytes?: number;
}

/** One line of `transcript.jsonl`. */
export type TranscriptLine =
  | { kind: "segment"; source: "app" | "mic"; from_s: number; to_s: number; text: string }
  | { kind: "gap"; from_s: number; to_s: number; reason: string };

export interface DeliveryState {
  /** Sessions the helper says are still owed, as of the last sweep. */
  owed: number;
  /** Delivered by this process since it started. */
  delivered: number;
  last_sweep_at?: string;
  /** Why the last sweep stopped short, in the owner's words. Cleared by a clean sweep. */
  last_error?: string;
}

export const IDEMPOTENCY_PREFIX = "live-capture:";

/** `live-capture:<session id>` — one key per session, forever. */
export function idempotencyKey(sessionID: string): string {
  return `${IDEMPOTENCY_PREFIX}${sessionID}`;
}

/** Seconds from Record → `01:02:03`. */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

/** `2026-09-28 14:05`, in this Mac's own time zone — the title the owner reads. */
function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const GAP_WORDS: Record<string, string> = { sleep: "the Mac slept" };

/** What the capture says a line's speaker is: the chosen apps (the other side), or the owner's microphone. */
const SPEAKER: Record<"app" | "mic", string> = { app: "apps", mic: "you" };

/**
 * The transcript as the capture the console stores: frontmatter first — our
 * own door writing it, so the inbox drain may classify on it — then one line
 * per segment and gap, in the order the helper wrote them. Frontmatter values
 * are JSON string literals (valid YAML scalars), so nothing in a session can
 * break out of its line.
 */
export function renderTranscript(session: SessionRecordJson, lines: readonly TranscriptLine[]): string {
  const fm: [string, string][] = [
    ["kind", "transcript"],
    ["title", `Recording ${localStamp(session.started_at)}`],
    ["capture_session", session.session_id],
    ["started_at", session.started_at],
    ["ended_at", session.ended_at ?? ""],
    ["ended_reason", session.ended_reason ?? ""],
    ["apps", (session.apps ?? []).join(", ")],
    ["source", "live-capture"],
    // T8-4: how much audio the Mac keeps for this session, until retention deletes it
    ...(typeof session.media_bytes === "number" && Number.isFinite(session.media_bytes) && session.media_bytes >= 0 ? [["media_bytes", String(Math.floor(session.media_bytes))] as [string, string]] : []),
  ];
  const head = ["---", ...fm.map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""];
  const body = lines.map((l) =>
    l.kind === "gap"
      ? `[${clock(l.from_s)}–${clock(l.to_s)}] not recorded — ${GAP_WORDS[l.reason] ?? l.reason}`
      : `[${clock(l.from_s)}] (${SPEAKER[l.source] ?? l.source}) ${l.text.replace(/\s*\n\s*/g, " ")}`,
  );
  if (body.length === 0) body.push("(nothing was transcribed)");
  if (session.ended_reason === "crashed") {
    const at = session.ended_at ? new Date(session.ended_at) : undefined;
    const upTo = at && !Number.isNaN(at.getTime()) ? ` at ${localStamp(session.ended_at!)}` : "";
    body.push("", `The recorder stopped unexpectedly${upTo}; everything above was saved before it did.`);
  }
  return [...head, ...body, ""].join("\n");
}

/** The console's answer, reduced to what decides the next step. */
type Posted = { ok: true; inboxID: number } | { ok: false; status?: number; why: string };

export class Deliverer {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly url: string;
  private running: Promise<DeliveryState> | undefined;
  private current: DeliveryState = { owed: 0, delivered: 0 };

  constructor(
    private readonly helper: HelperClient,
    private readonly cfg: DeliveryConfig,
  ) {
    if (!cfg.inboxToken) throw new Error("live-capture delivery needs the capture owner token");
    this.fetchFn = cfg.fetchFn ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.url = `${cfg.consoleUrl.replace(/\/+$/, "")}/capture`;
  }

  /** The last sweep's reading — what `check` and `status` report. */
  state(): DeliveryState {
    return { ...this.current };
  }

  /**
   * Deliver everything owed, oldest first. One sweep at a time: a second
   * call while one runs gets the running one, so a Stop that lands during the
   * timer's sweep cannot post the same session twice in parallel (the key
   * would make it harmless; this makes it not happen).
   */
  sweep(): Promise<DeliveryState> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<DeliveryState> {
    const at = new Date().toISOString();
    const owed = await this.helper.request({ op: "owed" });
    if (!owed.ok) return this.settle({ last_sweep_at: at, last_error: `the helper did not answer: ${owed.error ?? owed.code ?? "unknown"}` });
    const sessions = (Array.isArray(owed.sessions) ? owed.sessions : []) as SessionRecordJson[];
    let remaining = sessions.length;
    for (const s of sessions) {
      const t = await this.helper.request({ op: "transcript", session_id: s.session_id });
      if (!t.ok) return this.settle({ owed: remaining, last_sweep_at: at, last_error: `session ${s.session_id}: ${t.error ?? t.code}` });
      const body = renderTranscript(t.session as SessionRecordJson, (Array.isArray(t.lines) ? t.lines : []) as TranscriptLine[]);
      const posted = await this.post(s.session_id, body);
      // A refusal or an outage says the same about every other session: stop
      // here, keep them all owed, and say why.
      if (!posted.ok) return this.settle({ owed: remaining, last_sweep_at: at, last_error: posted.why });
      const marked = await this.helper.request({ op: "delivered", session_id: s.session_id, inbox_id: posted.inboxID });
      // The console has it; the helper could not write that down. The next
      // sweep posts again with the same key and gets the same row back.
      if (!marked.ok) return this.settle({ owed: remaining, last_sweep_at: at, last_error: `session ${s.session_id} reached the inbox (#${posted.inboxID}) but the helper could not record it: ${marked.error ?? marked.code}` });
      remaining -= 1;
      this.current.delivered += 1;
    }
    return this.settle({ owed: 0, last_sweep_at: at });
  }

  private settle(next: Partial<DeliveryState>): DeliveryState {
    const { last_error: _, ...kept } = this.current;
    this.current = { ...kept, ...next };
    return this.state();
  }

  private async post(sessionID: string, note: string): Promise<Posted> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.inboxToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey(sessionID),
        },
        body: JSON.stringify({ note, filename: `transcript-${sessionID}.md` }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { ok: false, why: `the console did not answer at ${this.url} (${err instanceof Error ? err.message : String(err)}) — the transcript stays on this Mac and is sent when it does` };
    }
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      answer = undefined;
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, why: `the console refused the capture token (HTTP ${res.status}) — METISTRY_LIVE_CAPTURE_INBOX_TOKEN must be a live owner token (docs/ops/capture-shortcut.md §1); the transcript stays on this Mac` };
    }
    const id = (answer as { id?: unknown } | undefined)?.id;
    if (res.status !== 201 || typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      const said = (answer as ReturnType<typeof errorEnvelope> | undefined)?.error?.message;
      return { ok: false, status: res.status, why: `the console answered HTTP ${res.status}${said ? `: ${said}` : ""} — the transcript stays on this Mac` };
    }
    return { ok: true, inboxID: id };
  }
}
