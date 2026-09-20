// devin-sessions: the RETURN path of `targets/devin-sessions` (W6 of
// docs/plan-refresh-2026-09-13.md §4b). The console dispatches a work row by
// creating a Devin session and binding `external_ref = devin:<session_id>`;
// this collector polls those rows and, when a session is done, files the
// structured answer as a `report` proposal for the owner to triage.
//
// **Why a collector and not an in-process timer.** A poll is a scheduled data
// pull with a cost, which is what a collector is; making it one buys the
// manifest (invariant 5), a `runs` row per pass, the watchdog's
// silent-collector probe, and a `check()` that `metistry doctor` finds
// generically. An in-process `setInterval` in the console would be fewer
// lines and would have none of that, and it would poll a third-party API
// from a request-serving process with no record that it ran. The only thing
// it would buy is latency — minutes, on work that takes a Devin session
// tens of minutes — so the collector wins outright.
//
// Verified against docs.devin.ai on 2026-09-15 (`/v3-openapi.json`):
//
//   Get     GET /v3/organizations/{org_id}/sessions/{devin_id} → SessionResponse
//   status  new | claimed | running | exit | error | suspended | resuming
//   detail  status_detail: working | waiting_for_user | waiting_for_approval |
//           finished | inactivity | user_request | usage_limit_exceeded |
//           out_of_credits | out_of_quota | no_quota_allocation |
//           payment_declined | org_usage_limit_exceeded |
//           user_usage_limit_exceeded | total_session_limit_exceeded | error
//           ("Only populated on get/list endpoints.")
//   output  `structured_output` sits on the SESSION object, not on a message:
//           "Validated structured output from the session. Only populated on
//           get/list endpoints."
//   spend   `acus_consumed` (number, always present on the response).
//
// There is no completion webhook — Devin's automations are inbound only —
// which is the whole reason this file exists.

import { runCheck, type CheckResult } from "@foldedspacelabs/metistry-core";
import { submitReport } from "@foldedspacelabs/metistry-mcp-brain";
import { DEVIN_API, RateLimited, type DevinCtx } from "../devin-knowledge/run.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The devin-knowledge context (same key, same org, same base) plus the two knobs only the poller has. */
export interface DevinSessionsCtx extends DevinCtx {
  /** REST base override; default `DEVIN_API`. */
  devinApiUrl?: string | undefined;
  /** How long a session may sit non-terminal before it is reported and the row is blocked. */
  devinSessionTimeoutHours?: number | undefined;
}

export const COMPONENT = "devin-sessions";
/** `proposals.source_agent` for everything this collector files. Devin is the author; the trust is `external`. */
export const SOURCE_AGENT = "devin";
/** `work.external_ref` prefix. The console writes it; this collector is the only reader. */
export const REF_PREFIX = "devin:";
/** How long a session may sit non-terminal before the owner is told. */
export const DEFAULT_TIMEOUT_HOURS = 24; // limit: fixed — the floor when ctx.devinSessionTimeoutHours (METISTRY_DEVIN_SESSION_TIMEOUT_HOURS, apps/console/src/main.ts) names none
const MAX_SESSIONS = 25; // limit: fixed — per pass; a dispatch backlog is drained over several ticks, not in one burst
const MAX_ANSWER_BYTES = 64 * 1024; // limit: fixed — a report body the queue can render

export function devinRef(sessionId: string): string {
  return `${REF_PREFIX}${sessionId}`;
}

/** `devin:<session_id>` → the session id; anything else → null. */
export function parseDevinRef(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return null;
  const id = ref.slice(REF_PREFIX.length).trim();
  return id === "" ? null : id;
}

/** What `dispatch()` writes to `work.meta.devin`, and what this collector reads back. */
export interface DevinWorkMeta {
  session_id: string;
  org: string;
  url: string;
  max_acu: number;
  purpose: string;
  target: string;
  dispatch_run_id: number;
  /** Written by this collector on every poll, so a stuck session is visible without an API call. */
  status?: string;
  status_detail?: string | null;
  acus_consumed?: number;
  polled_at?: string;
}

export interface DevinSession {
  session_id: string;
  url?: string;
  status: string;
  status_detail?: string | null;
  title?: string | null;
  acus_consumed?: number;
  structured_output?: Record<string, unknown> | null;
  updated_at?: number;
}

/** The structured answer contract (apps/console/src/devin.ts `DEVIN_ANSWER_SCHEMA`). */
export interface DevinAnswer {
  answer?: unknown;
  sources?: unknown;
  confidence?: unknown;
  open_questions?: unknown;
}

// ---- verdict -----------------------------------------------------------------

export type Verdict =
  | { kind: "pending"; note: string }
  | { kind: "answered"; output: DevinAnswer }
  | { kind: "failed"; reason: string };

/**
 * Terminal or not, and why. Everything that needs the owner is `failed` —
 * including a session that is technically still `running` but is
 * `waiting_for_user`, because nobody is going to answer it: the console's
 * return path is the structured output, not the session chat.
 */
export function verdictOf(s: DevinSession, opts: { timedOut?: boolean } = {}): Verdict {
  const detail = s.status_detail ? ` (${s.status_detail})` : "";
  switch (s.status) {
    case "exit": {
      const out = s.structured_output;
      if (out && typeof out === "object" && !Array.isArray(out)) return { kind: "answered", output: out as DevinAnswer };
      // structured_output_required defaults to true, so this is Devin
      // failing its own contract — reported, never silently accepted.
      return { kind: "failed", reason: `session finished${detail} without structured output — it did not call provide_structured_output with is_final=true` };
    }
    case "error":
      return { kind: "failed", reason: `session errored${detail}` };
    case "suspended":
      // inactivity, usage_limit_exceeded, out_of_credits … none of which resolve on their own
      return { kind: "failed", reason: `session suspended${detail}` };
    default: {
      if (s.status_detail === "waiting_for_user" || s.status_detail === "waiting_for_approval") {
        return { kind: "failed", reason: `session is ${s.status}${detail} — it is waiting on a person and this return path does not answer sessions` };
      }
      if (opts.timedOut) return { kind: "failed", reason: `session is still ${s.status}${detail} past the dispatch timeout` };
      return { kind: "pending", note: `${s.status}${detail}` };
    }
  }
}

// ---- report body ---------------------------------------------------------------

function bullets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter((s) => s.trim() !== "");
}

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_ANSWER_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, MAX_ANSWER_BYTES).toString("utf8")}\n\n_…truncated at ${MAX_ANSWER_BYTES} bytes; the full answer is in the session._`;
}

export interface Provenance {
  session_url: string;
  status: string;
  status_detail?: string | null;
  /** Devin's own number, when it reported one. Absent rather than 0 when it did not. */
  acus_consumed?: number | undefined;
  max_acu: number;
  task_id: number;
  purpose: string;
}

/** Answer + provenance, as the markdown the triage queue renders. */
export function reportBody(answer: DevinAnswer, p: Provenance): string {
  const parts: string[] = [truncate(typeof answer.answer === "string" ? answer.answer.trim() : JSON.stringify(answer.answer ?? null))];
  const sources = bullets(answer.sources);
  if (sources.length > 0) parts.push(`## Sources\n${sources.map((s) => `- ${s}`).join("\n")}`);
  const open = bullets(answer.open_questions);
  if (open.length > 0) parts.push(`## Open questions\n${open.map((s) => `- ${s}`).join("\n")}`);
  parts.push(provenanceBlock(p, typeof answer.confidence === "string" ? answer.confidence : undefined));
  return parts.join("\n\n");
}

export function provenanceBlock(p: Provenance, confidence?: string | undefined): string {
  const lines = [
    `- session: ${p.session_url}`,
    `- status: ${p.status}${p.status_detail ? ` (${p.status_detail})` : ""}`,
    ...(confidence ? [`- confidence: ${confidence}`] : []),
    `- ACUs used: ${p.acus_consumed === undefined ? "not reported" : p.acus_consumed} (cap ${p.max_acu})`,
    `- dispatched for: task #${p.task_id} (${p.purpose})`,
  ];
  return `## Provenance\n${lines.join("\n")}`;
}

// ---- check() -------------------------------------------------------------------

/**
 * Behavioral probe (Phase 0 hard requirement 3). No key = `absent`, which is
 * a supported shape: nothing is dispatched to Devin either, so there is
 * nothing to poll.
 */
export async function check(ctx: DevinSessionsCtx = {}): Promise<CheckResult> {
  return runCheck(COMPONENT, "count work rows with an open devin: external_ref (the poll surface)", async () => {
    if (!ctx.devinApiKey) {
      return {
        status: "absent" as const,
        remediation:
          "METISTRY_DEVIN_API_KEY is unset — the same key collectors/devin-knowledge uses. Nothing can be dispatched to targets/devin-sessions without it, so there is nothing to poll; add it to <instance>/state/.env and run `metistry secrets sync --to keychain`",
      };
    }
    return { status: "ok" as const };
  });
}

// ---- run() ---------------------------------------------------------------------

interface OpenRow {
  id: number;
  title: string;
  external_ref: string;
  meta: DevinWorkMeta | Record<string, unknown> | null;
  updated_at: string;
  created_at: string;
}

async function getSession(ctx: DevinSessionsCtx, base: string, org: string, sessionId: string): Promise<DevinSession> {
  const url = `${base}/v3/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(sessionId)}`;
  const res = await (ctx.fetchFn ?? fetch)(url, {
    headers: {
      authorization: `Bearer ${ctx.devinApiKey}`,
      accept: "application/json",
      "user-agent": "metistry-devin-sessions",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new RateLimited(`polling session ${sessionId}`);
  if (!res.ok) throw new Error(`devin session ${sessionId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as DevinSession;
}

function historyEntry(op: "update", note: string, status: string, now: Date): string {
  return JSON.stringify([{ ts: now.toISOString(), agent: `collector:${COMPONENT}`, op, note, status }]);
}

/**
 * One pass. Returns the number of work rows that reached a terminal state
 * (a pending session counts for nothing, so a quiet tick returns 0).
 */
export async function run(db: Db, ctx: DevinSessionsCtx = {}): Promise<number> {
  if (!ctx.devinApiKey) return 0; // degrades absent
  const now = ctx.now ?? new Date();
  const base = ctx.devinApiUrl ?? DEVIN_API;
  const timeoutMs = (ctx.devinSessionTimeoutHours ?? DEFAULT_TIMEOUT_HOURS) * 3_600_000;

  // Only rows this target still holds. `dispatch()` sets in_progress; every
  // terminal path below leaves `closed` or `blocked`, so a row is polled
  // until it is decided and never after.
  const { rows } = await db.query(
    `SELECT id, title, external_ref, meta, created_at, updated_at FROM work
     WHERE external_ref LIKE $1 AND status = 'in_progress'
     ORDER BY id LIMIT ${MAX_SESSIONS}`,
    [`${REF_PREFIX}%`],
  );

  let finished = 0;
  for (const row of rows as OpenRow[]) {
    const sessionId = parseDevinRef(row.external_ref);
    const meta = (row.meta ?? {}) as { devin?: DevinWorkMeta };
    const dev = meta.devin;
    const org = dev?.org ?? ctx.devinOrgId;
    if (!sessionId || !org) {
      // A ref we cannot poll is not something to guess at: leave the row
      // alone and say so once per pass.
      console.warn(`devin-sessions: work #${row.id} (${row.external_ref}) has no session id or organization in meta.devin — skipped`);
      continue;
    }

    let session: DevinSession;
    try {
      session = await getSession(ctx, base, org, sessionId);
    } catch (err) {
      if (err instanceof RateLimited) {
        console.warn(`devin-sessions: ${err.message}`);
        break; // backoff-and-stop: the remaining rows are polled next tick
      }
      console.warn(`devin-sessions: work #${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue; // a transient GET failure is not a verdict
    }

    const age = now.getTime() - new Date(row.created_at).getTime();
    const verdict = verdictOf(session, { timedOut: age > timeoutMs });
    const sessionUrl = session.url ?? dev?.url ?? `${base}/sessions/${sessionId}`;
    const provenance: Provenance = {
      session_url: sessionUrl,
      status: session.status,
      status_detail: session.status_detail ?? null,
      acus_consumed: typeof session.acus_consumed === "number" ? session.acus_consumed : undefined,
      max_acu: dev?.max_acu ?? 0,
      task_id: Number(row.id),
      purpose: dev?.purpose ?? "work",
    };
    const pollMeta = {
      devin: {
        ...(dev ?? {}),
        status: session.status,
        status_detail: session.status_detail ?? null,
        ...(provenance.acus_consumed !== undefined ? { acus_consumed: provenance.acus_consumed } : {}),
        polled_at: now.toISOString(),
      },
    };

    if (verdict.kind === "pending") {
      await db.query(`UPDATE work SET meta = meta || $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(pollMeta)]);
      continue;
    }

    const answered = verdict.kind === "answered";
    const report = answered
      ? {
          title: `[devin] ${row.title}`.slice(0, 200),
          body: reportBody(verdict.output, provenance),
          kind: "finding" as const,
          refs: [sessionUrl, `task:${row.id}`],
          idempotency_key: `devin-session:${sessionId}`,
        }
      : {
          title: `[devin] ${row.title} — no answer`.slice(0, 200),
          body: `Devin returned no answer for task #${row.id}.\n\n**${verdict.reason}**\n\n${provenanceBlock(provenance)}`,
          kind: "progress" as const,
          refs: [sessionUrl, `task:${row.id}`],
          idempotency_key: `devin-session:${sessionId}:failed`,
        };
    await submitReport(db as never, SOURCE_AGENT, report);

    // The work row's verdict: an answer closes it, anything else blocks it
    // for the owner (a blocked row is visible, never claimable).
    const note = answered ? `devin session ${sessionId} answered` : `devin session ${sessionId}: ${verdict.reason}`;
    const status = answered ? "closed" : "blocked";
    await db.query(
      `UPDATE work SET status = $2, meta = meta || $3::jsonb, history = history || $4::jsonb,
         closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END, updated_at = now()
       WHERE id = $1`,
      [row.id, status, JSON.stringify(pollMeta), historyEntry("update", note, status, now)],
    );

    // Close the cost loop: the dispatch runs row already carries the target,
    // the session id and the ACU cap; this is the spend Devin actually
    // reported, so per-target cost is still one query over `runs`.
    if (dev?.dispatch_run_id) {
      await db.query(`UPDATE runs SET meta = meta || $2::jsonb WHERE id = $1`, [
        dev.dispatch_run_id,
        JSON.stringify({
          ...(provenance.acus_consumed !== undefined ? { acus_consumed: provenance.acus_consumed } : {}),
          devin_status: session.status,
          outcome: answered ? "answered" : "failed",
        }),
      ]);
    }
    finished++;
  }
  return finished;
}
