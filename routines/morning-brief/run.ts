// morning-brief — the daily review, spec'd per the ratified decisions:
// D10 SOFT budget (surface the most impactful ~5, +1-2 extra only if also
// critical; link to the full queue, never hard-truncate), consequence
// ranking (deterministic — no model ranks your attention), auto-expiry
// (un-acted proposals expire after EXPIRE_DAYS to decision='expired' —
// searchable, never lost), silence-default (nothing pending = no brief).

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const BUDGET = 5;
const CRITICAL_EXTRA_MAX = 2;
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
  grant_elevation: 100, // a waiting agent is blocked; also security-relevant
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

function title(row: PendingRow): string {
  const c = row.payload?.classification;
  return (c?.action || c?.title || row.payload?.title || `${row.kind} proposal`).slice(0, 70);
}

// ---- sections (owner feedback 2026-09-01: actionable, question-shaped).
// Each returns lines or null; an absent data source silently omits its
// section (degrades: absent). Sections still to come as sources land:
// schedule + meeting prep (EventKit bridge), project status (collectors),
// narrative "what to focus on" (assistant-composed brief — model tier).

async function sectionToday(db: Db): Promise<string[] | null> {
  const work = await db.query(
    `SELECT title, status, due FROM work
     WHERE status IN ('open','in_progress','blocked') AND (due IS NULL OR due <= current_date + 1)
     ORDER BY due NULLS LAST, updated_at DESC LIMIT 8`,
  );
  const todos = await db.query(
    `SELECT id, payload FROM proposals
     WHERE decision = 'pending' AND payload->'classification'->>'has_action' = 'true'
     ORDER BY ts LIMIT 5`,
  );
  const lines = [
    ...work.rows.map((w: any) => `• ${w.title}${w.due ? ` (due ${w.due.toISOString?.().slice(0, 10) ?? w.due})` : ""}${w.status === "blocked" ? " — blocked" : ""}`),
    ...todos.rows.map((t: any) => `• ${(t.payload?.classification?.action || t.payload?.classification?.title || "").slice(0, 70)}  (captured, untriaged #${t.id})`),
  ];
  return lines.length ? lines : null;
}

async function sectionDecisions(db: Db, expiredCount: number): Promise<string[] | null> {
  const { rows } = await db.query(
    `SELECT id, kind, ts, payload FROM proposals WHERE decision = 'pending' ORDER BY ts`,
  );
  if (rows.length === 0) return null;
  const now = new Date();
  const picked = pickBudget((rows as PendingRow[]).map((row) => ({ row, s: score(row, now) })));
  const rest = rows.length - picked.length;
  return [
    ...picked.map(({ row, s }) => `• #${row.id} ${title(row)}  (${row.kind}${s >= CRITICAL_SCORE ? " ⚠" : ""})`),
    ...(rest > 0 ? [`…${rest} more — open triage to see everything`] : []),
    ...(expiredCount > 0 ? [`${expiredCount} stale item(s) auto-expired, still searchable`] : []),
  ];
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
  if (failed > 0) lines.push(`• ⚠ ${failed} failed run(s) — check the status page; I may need your help`);
  return { lines, needsHelp: failed > 0 };
}

/** One brief pass. Returns 1 if a brief was emitted, else 0 (silence-default). */
export async function run(db: Db): Promise<number> {
  // auto-expiry first: un-acted items leave the queue but stay searchable
  const expired = await db.query(
    `UPDATE proposals SET decision = 'expired', decided_at = now()
     WHERE decision = 'pending' AND ts < now() - make_interval(days => $1) RETURNING id`,
    [EXPIRE_DAYS],
  );

  const decisions = await sectionDecisions(db, expired.rows.length);
  const today = await sectionToday(db);
  const system = await sectionSystem(db);

  // silence-default: emit only when something needs the user
  if (!decisions && !today && !system?.needsHelp) return 0;

  const parts: string[] = ["☀️ morning brief"];
  if (today) parts.push("", "✅ Today:", ...today);
  if (decisions) parts.push("", "🔔 Needs your decision:", ...decisions);
  if (system) parts.push("", "⚙️ What I've been doing:", ...system.lines);
  parts.push("", "📅 Schedule & meeting prep arrive once the calendar bridge is connected.");

  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'brief')`, [
    parts.join("\n"),
  ]);
  return 1;
}
