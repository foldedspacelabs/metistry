// morning-brief — the daily review, spec'd per the ratified decisions:
// D10 SOFT budget (surface the most impactful ~5, +1-2 extra only if also
// critical; link to the full queue, never hard-truncate), consequence
// ranking (deterministic — no model ranks your attention), auto-expiry
// (un-acted proposals expire after EXPIRE_DAYS to decision='expired' —
// searchable, never lost), silence-default (nothing pending = no brief).

import { requestWordOf } from "@foldedspacelabs/metistry-core";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const BUDGET = 5; // limit: fixed — D10's soft budget: surface the ~5 most impactful, never hard-truncate (the full queue is one tap away)
const CRITICAL_EXTRA_MAX = 2; // limit: fixed — D10's "+1-2 extra only if also critical"
const CRITICAL_SCORE = 80;
const EXPIRE_DAYS = 14;

interface PendingRow {
  id: number;
  kind: string;
  ts: Date;
  payload: any;
}

// Consequence ranking: what it costs the user to ignore this. Deterministic
// weights, auditable like the classifier's reasons.
const KIND_WEIGHT: Record<string, number> = {
  decision: 100, // the assistant asked and cannot continue — a waiting assistant is blocked
  grant_elevation: 100, // a waiting agent is blocked; also security-relevant
  access_request: 100,  // the same fact, asked by the agent itself (request_access): it is stuck until you answer
  action: 70,
  report: 45,
  knowledge: 30,
  draft_settle: 20,
};

export function score(row: PendingRow, now: Date): number {
  let s = KIND_WEIGHT[row.kind] ?? 25;
  const c = row.payload?.classification;
  if (c?.has_action) s += 25; // the capture states a concrete task
  if (c?.kind === "todo") s += 15;
  const ageDays = (now.getTime() - new Date(row.ts).getTime()) / 86_400_000;
  s += Math.min(ageDays * 2, 14); // aging raises urgency, capped
  return Math.round(s);
}

export function pickBudget(scored: { row: PendingRow; s: number }[]): { row: PendingRow; s: number }[] {
  const sorted = [...scored].sort((a, b) => b.s - a.s);
  const base = sorted.slice(0, BUDGET);
  const extra = sorted.slice(BUDGET, BUDGET + CRITICAL_EXTRA_MAX).filter((x) => x.s >= CRITICAL_SCORE);
  return [...base, ...extra];
}

// The word each request is called by is the request type table's
// (packages/core/src/requests.ts, plan §2.12) — the same word the Needs You
// queue and `pending_requests` use, so the brief has no spelling of its own.
// The stored kinds are the machinery's business; a kind the table does not
// know reads as a report, never as itself.
function title(row: PendingRow): string {
  const c = row.payload?.classification;
  return (c?.action || c?.title || row.payload?.title || `${requestWordOf(row.kind)} request`).slice(0, 70);
}

// ---- sections (owner feedback 2026-09-01: actionable, question-shaped).
// Each returns lines or null; an absent data source silently omits its
// section (degrades: absent). Sections still to come as sources land:
// schedule + meeting prep (EventKit bridge), project status (collectors),
// narrative "what to focus on" (assistant-composed brief — model tier).

async function sectionToday(db: Db): Promise<string[] | null> {
  const work = await db.query(
    `SELECT title, status, due FROM work
     WHERE status IN ('in_progress','blocked')
        OR (status = 'open' AND due IS NOT NULL AND due <= current_date + 1)
     ORDER BY due NULLS LAST, updated_at DESC LIMIT 8`,
  );
  const todos = await db.query(
    // `snoozed_until` (migration 0019): a `later` is not an answer, but it IS
    // "not before then" — a brief that pushes it at 07:00 anyway makes the
    // verb a lie. Pending, minus what the user put down.
    `SELECT id, payload FROM proposals
     WHERE decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())
       AND payload->'classification'->>'has_action' = 'true'
     ORDER BY ts LIMIT 5`,
  );
  const lines = [
    ...work.rows.map((w: any) => `• ${w.title}${w.due ? ` (due ${w.due.toISOString?.().slice(0, 10) ?? w.due})` : ""}${w.status === "blocked" ? " — blocked" : ""}`),
    ...todos.rows.map((t: any) => `• ${(t.payload?.classification?.action || t.payload?.classification?.title || "").slice(0, 70)}  (captured, still a request #${t.id})`),
  ];
  return lines.length ? lines : null;
}

// 👀 Reviews waiting on you — one list across every repo (owner request
// 2026-09-06). github-state marks work.meta.needs_my_review; nothing here
// guesses.
async function sectionReviews(db: Db): Promise<string[] | null> {
  const { rows } = await db.query(
    `SELECT external_ref, title, meta->>'author' AS author, updated_at FROM work
     WHERE kind = 'pr' AND status <> 'closed' AND meta->>'needs_my_review' = 'true'
     ORDER BY updated_at ASC LIMIT 10`,
  );
  if (rows.length === 0) return null;
  const now = Date.now();
  return rows.map((r: any) => {
    const age = Math.floor((now - new Date(r.updated_at).getTime()) / 86_400_000);
    return `• ${String(r.external_ref).replace(/^gh:/, "")} ${String(r.title).slice(0, 60)} — ${r.author ?? "?"}${age > 0 ? `, ${age}d` : ""}`;
  });
}

async function sectionRequests(db: Db, expiredCount: number): Promise<string[] | null> {
  const { rows } = await db.query(
    `SELECT id, kind, ts, payload FROM proposals
     WHERE decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())
     ORDER BY ts`,
  );
  if (rows.length === 0) return null;
  const now = new Date();
  const picked = pickBudget((rows as PendingRow[]).map((row) => ({ row, s: score(row, now) })));
  const rest = rows.length - picked.length;
  return [
    ...picked.map(({ row, s }) => `• #${row.id} ${title(row)}  (${requestWordOf(row.kind)}${s >= CRITICAL_SCORE ? " ⚠" : ""})`),
    ...(rest > 0 ? [`…${rest} more — open Needs You to see everything`] : []),
    ...(expiredCount > 0 ? [`${expiredCount} stale item(s) auto-expired, still searchable`] : []),
  ];
}

export interface RoutineCtx {
  ekUrl?: string; // eventkit bridge (degrades absent)
  ekToken?: string;
  fetchFn?: typeof fetch;
}

interface EkEvent {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  attendees: string[];
}

// 📅 Schedule + meeting prep: today's events from the EventKit bridge.
// Prep today = attendees + location surfaced; richer prep (People notes,
// last-meeting decisions) arrives when the vault exists to look them up.
async function sectionSchedule(ctx: RoutineCtx): Promise<string[] | null> {
  if (!ctx.ekUrl || !ctx.ekToken) return null;
  try {
    const res = await (ctx.fetchFn ?? fetch)(`${ctx.ekUrl}/events?days=1`, {
      headers: { authorization: `Bearer ${ctx.ekToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const { events } = (await res.json()) as { events: EkEvent[] };
    if (events.length === 0) return ["• nothing on the calendar today"];
    const fmt = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return events.map((e) => {
      const when = e.all_day ? "all day" : `${fmt(e.start)}–${fmt(e.end)}`;
      const who = e.attendees.filter(Boolean).slice(0, 4).join(", ");
      const where = e.location ? ` @ ${e.location.split("\n")[0]}` : "";
      return `• ${when} ${e.title}${where}${who ? `\n    with ${who}` : ""}`;
    });
  } catch {
    return null; // degrades absent — the brief still goes out
  }
}

// 📂 Projects: status rollup from the work table by area (fed by the
// github-state collector today; more collectors → richer status).
async function sectionProjects(db: Db): Promise<string[] | null> {
  const { rows } = await db.query(
    `SELECT area,
            count(*) FILTER (WHERE status <> 'closed') AS open,
            count(*) FILTER (WHERE status = 'blocked') AS blocked,
            count(*) FILTER (WHERE status = 'closed' AND updated_at > now() - interval '7 days') AS closed_7d,
            (array_agg(title ORDER BY updated_at DESC) FILTER (WHERE status <> 'closed'))[1:2] AS latest
     FROM work WHERE area IS NOT NULL AND external_ref LIKE 'gh:%'
     GROUP BY area ORDER BY open DESC LIMIT 6`,
  );
  if (rows.length === 0) return null;
  return rows.map((r: any) => {
    const latest = (r.latest ?? []).map((t: string) => t.slice(0, 40)).join(" · ");
    return `• ${r.area}: ${r.open} open${Number(r.blocked) ? `, ${r.blocked} blocked` : ""}, ${r.closed_7d} closed this week${latest ? `\n    latest: ${latest}` : ""}`;
  });
}

async function sectionSystem(db: Db): Promise<{ lines: string[]; needsHelp: boolean } | null> {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE kind IN ('collector_run','routine_run') AND ok) AS runs_ok,
       count(*) FILTER (WHERE kind = 'turn' AND ok) AS turns,
       count(*) FILTER (WHERE kind = 'capture' AND ok) AS captures,
       count(*) FILTER (WHERE ok = false) AS failures,
       coalesce(sum(cost_usd), 0) AS spend
     FROM runs WHERE ts > now() - interval '24 hours'`,
  );
  const s = rows[0];
  const failed = Number(s.failures);
  const lines = [
    `• last 24h: ${s.captures} capture(s) processed, ${s.turns} turn(s), ${Number(s.spend).toFixed(2)} USD spend`,
  ];
  // last night's fold (routines/knowledge-fold): its own runs row carries the
  // counts; the notes written are the knowledge_write calls that followed it.
  const fold = await db.query(
    `SELECT ts, meta FROM runs
     WHERE component = 'knowledge-fold' AND kind = 'routine_run' AND ok AND meta->>'folded' = 'true'
       AND ts > now() - interval '24 hours'
     ORDER BY ts DESC LIMIT 1`,
  );
  if (fold.rows[0]) {
    const items = Number(fold.rows[0].meta?.items ?? 0);
    const wrote = await db.query(
      `SELECT count(*) AS n FROM runs WHERE kind = 'tool' AND tool = 'knowledge_write' AND ok AND ts > $1::timestamptz`,
      [fold.rows[0].ts],
    );
    const n = Number(wrote.rows[0]?.n ?? 0);
    lines.push(`• folded ${items} item(s) into the vault last night (${n} note(s) written)`);
  }
  if (failed > 0) lines.push(`• ⚠ ${failed} failed run(s) — check the status page; I may need your help`);
  // §4.21: a project the budget flipped to review mode needs the user — the brief says so, once per flip
  const flips = await db.query(
    `SELECT meta FROM runs WHERE kind = 'project_mode' AND ok AND ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 5`,
  );
  let flipped = 0;
  for (const r of flips.rows) {
    const m = r.meta ?? {};
    if (typeof m.project !== "string" || m.to !== "review") continue;
    flipped++;
    const budget = m.budget_usd !== undefined ? ` (${Number(m.spend_usd ?? 0).toFixed(2)} of ${Number(m.budget_usd).toFixed(2)} USD)` : "";
    lines.push(`• ⚠ project ${m.project} flipped to review mode: ${m.reason ?? "budget"}${budget} — agent-to-agent review is queued for you until you switch it back`);
  }
  return { lines, needsHelp: failed > 0 || flipped > 0 };
}

/**
 * One brief pass. Returns 1 if a brief was emitted, else 0 (silence-default)
 * — the runner turns that into `meta.outcome`: `acted` or `silent` (T1-4).
 */
export async function run(db: Db, ctx: RoutineCtx = {}): Promise<number> {
  // auto-expiry first: un-acted items leave the queue but stay searchable
  const expired = await db.query(
    `UPDATE proposals SET decision = 'expired', decided_at = now()
     WHERE decision = 'pending' AND ts < now() - make_interval(days => $1) RETURNING id`,
    [EXPIRE_DAYS],
  );

  const schedule = await sectionSchedule(ctx);
  const requests = await sectionRequests(db, expired.rows.length);
  const today = await sectionToday(db);
  const reviews = await sectionReviews(db);
  const projects = await sectionProjects(db);
  const system = await sectionSystem(db);

  // silence-default: emit only when something needs the user (a calendar
  // with events counts — the day needs planning)
  const hasEvents = !!schedule && !schedule[0]!.includes("nothing on the calendar");
  if (!requests && !today && !reviews && !hasEvents && !system?.needsHelp) return 0;

  const parts: string[] = ["☀️ morning brief"];
  if (schedule) parts.push("", "📅 Schedule:", ...schedule);
  if (today) parts.push("", "✅ Today:", ...today);
  if (reviews) parts.push("", "👀 Reviews waiting on you:", ...reviews);
  if (requests) parts.push("", "🔔 Needs you:", ...requests);
  if (projects) parts.push("", "📂 Projects:", ...projects);
  if (system) parts.push("", "⚙️ What I've been doing:", ...system.lines);
  if (!schedule) parts.push("", "📅 Schedule & meeting prep arrive once the calendar bridge is connected.");

  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'brief')`, [
    parts.join("\n"),
  ]);
  return 1;
}
