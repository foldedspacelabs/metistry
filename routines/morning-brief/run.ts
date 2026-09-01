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

/** One brief pass. Returns 1 if a brief was emitted, else 0 (silence-default). */
export async function run(db: Db): Promise<number> {
  // auto-expiry first: un-acted items leave the queue but stay searchable
  const expired = await db.query(
    `UPDATE proposals SET decision = 'expired', decided_at = now()
     WHERE decision = 'pending' AND ts < now() - make_interval(days => $1) RETURNING id`,
    [EXPIRE_DAYS],
  );

  const { rows } = await db.query(
    `SELECT id, kind, ts, payload FROM proposals WHERE decision = 'pending' ORDER BY ts`,
  );
  if (rows.length === 0) return 0; // silence-default

  const now = new Date();
  const picked = pickBudget((rows as PendingRow[]).map((row) => ({ row, s: score(row, now) })));
  const rest = rows.length - picked.length;

  const lines = picked.map(({ row, s }) => `• #${row.id} ${title(row)}  (${row.kind}${s >= CRITICAL_SCORE ? " ⚠" : ""})`);
  const footer = [
    rest > 0 ? `${rest} more pending — open triage to see everything` : "that's the whole queue",
    expired.rows.length > 0 ? `${expired.rows.length} stale item(s) auto-expired (still searchable)` : null,
  ].filter(Boolean).join(" · ");

  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'brief')`, [
    `morning brief — ${rows.length} pending:\n${lines.join("\n")}\n${footer}`,
  ]);
  return 1;
}
