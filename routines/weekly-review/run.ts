// weekly-review — the batch review (plan §5 "Maintenance cadence", weekly;
// §4.19 names the weekly audit as the batch pass over proposals). Six
// sections over the last 7 days: projects, decisions (+ what's still
// pending under the D10 rule — count and link, never the full list), agents,
// spend, system, next week. Unlike the morning brief this is NOT
// silence-default: the user asked for a cadence, so the review always goes
// out, and an empty section says one honest line instead of vanishing.
// In the first 7 days of a month it adds §5's monthly check — last month's
// assistant spend by model tier against subscription headroom, and AWS.
//
// Model-free end to end (invariant 4): every line is SQL plus formatting.
// `ctx.now` is injectable so the window and the monthly gate are testable;
// every query takes it as $1 rather than calling now() so the real-db test
// is deterministic too.

import type { Db, RoutineCtx } from "../morning-brief/run.js";

export interface WeeklyCtx extends RoutineCtx {
  now?: Date;
}

const WINDOW_DAYS = 7;
const MONTHLY_GATE_DAY = 7; // run falls on day 1..7 → add "last month"

const num = (x: unknown): number => Number(x ?? 0);
const usd = (x: unknown): string => `${num(x).toFixed(2)} USD`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const daysBetween = (from: Date | string, now: Date): number => Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000);
// Local calendar date as YYYY-MM-DD — the container's TZ is METISTRY_TZ, so
// "this month" and "today" mean the user's, not UTC's.
const localDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortDate = (d: Date): string => d.toLocaleDateString([], { month: "short", day: "numeric" });

// ---- sections. Each returns the lines under its heading; an empty data
// source yields one honest line (never an omitted section — see header).

async function sectionProjects(db: Db, now: Date): Promise<string[]> {
  const { rows } = await db.query(
    `WITH s AS (
       SELECT coalesce(project, area) AS name,
              count(*) FILTER (WHERE kind <> 'pr' AND created_at > $1::timestamptz - interval '7 days') AS tasks_created,
              count(*) FILTER (WHERE kind <> 'pr' AND status = 'closed' AND coalesce(closed_at, updated_at) > $1::timestamptz - interval '7 days') AS tasks_closed,
              count(*) FILTER (WHERE kind = 'pr' AND external_ref LIKE 'gh:%' AND created_at > $1::timestamptz - interval '7 days') AS prs_opened,
              count(*) FILTER (WHERE kind = 'pr' AND external_ref LIKE 'gh:%' AND status = 'closed' AND updated_at > $1::timestamptz - interval '7 days') AS prs_closed,
              count(*) FILTER (WHERE status = 'blocked') AS blocked
       FROM work WHERE coalesce(project, area) IS NOT NULL GROUP BY 1)
     SELECT * FROM s WHERE tasks_created + tasks_closed + prs_opened + prs_closed + blocked > 0
     ORDER BY tasks_created + tasks_closed + prs_opened + prs_closed DESC, name LIMIT 8`,
    [now],
  );
  if (rows.length === 0) return ["• no project activity this week"];
  const blocked = await db.query(
    `SELECT title, coalesce(project, area) AS name, floor(extract(epoch FROM $1::timestamptz - updated_at) / 86400) AS age_days
     FROM work WHERE status = 'blocked' AND coalesce(project, area) IS NOT NULL ORDER BY updated_at ASC LIMIT 8`,
    [now],
  );
  return rows.map((r: any) => {
    const parts = [
      `${plural(num(r.tasks_created), "task")} created, ${num(r.tasks_closed)} closed`,
      `${plural(num(r.prs_opened), "PR")} opened, ${num(r.prs_closed)} closed`,
    ];
    if (num(r.blocked) > 0) parts.push(`${num(r.blocked)} blocked`);
    const stuck = blocked.rows
      .filter((b: any) => b.name === r.name)
      .map((b: any) => `${String(b.title).slice(0, 50)} (${num(b.age_days)}d)`)
      .join(" · ");
    return `• ${r.name}: ${parts.join("; ")}${stuck ? `\n    blocked: ${stuck}` : ""}`;
  });
}

const DECISION_LABEL: Record<string, string> = {
  allow: "allowed",
  deny: "denied",
  accept_with_changes: "accepted with changes",
  expired: "auto-expired",
};

async function sectionDecisions(db: Db, now: Date): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT decision, count(*) AS n FROM proposals
     WHERE decision <> 'pending' AND decided_at > $1::timestamptz - interval '7 days'
     GROUP BY decision ORDER BY n DESC, decision`,
    [now],
  );
  if (rows.length === 0) return ["• none this week — nothing needed you"];
  const total = rows.reduce((s: number, r: any) => s + num(r.n), 0);
  const made = rows.filter((r: any) => r.decision !== "expired");
  const expired = rows.find((r: any) => r.decision === "expired");
  const lines = [
    `• ${total} decided: ${made.map((r: any) => `${num(r.n)} ${DECISION_LABEL[r.decision] ?? r.decision}`).join(", ") || "none by you"}${expired ? `; ${num(expired.n)} auto-expired (still searchable)` : ""}`,
  ];
  const reasons = await db.query(
    `SELECT feedback, count(*) AS n FROM proposals
     WHERE decision IN ('deny', 'accept_with_changes') AND decided_at > $1::timestamptz - interval '7 days'
       AND feedback IS NOT NULL AND feedback <> ''
     GROUP BY feedback ORDER BY n DESC, feedback LIMIT 3`,
    [now],
  );
  if (reasons.rows.length > 0) {
    lines.push(`• top denied reasons: ${reasons.rows.map((r: any) => `"${String(r.feedback).slice(0, 40)}" (${num(r.n)})`).join(", ")}`);
  }
  return lines;
}

// D10: the count and a link to the queue, never the list — the daily brief
// already spends the attention budget on the top items.
async function sectionPending(db: Db, now: Date): Promise<string[]> {
  const { rows } = await db.query(`SELECT count(*) AS n, min(ts) AS oldest FROM proposals WHERE decision = 'pending'`);
  const n = num(rows[0]?.n);
  if (n === 0) return ["• nothing pending"];
  return [`• ${n} waiting, oldest ${daysBetween(rows[0].oldest, now)}d — open triage to see everything`];
}

// Per agent: reports and proposals from `proposals` (trust = external, i.e.
// stamped from an agent credential — never self-declared), task ops and
// tool calls from `runs` (component = agent id, or meta.agent for calls the
// console records on an agent's behalf), closures from `work.history`.
async function sectionAgents(db: Db, now: Date): Promise<string[]> {
  const { rows } = await db.query(
    `WITH since AS (SELECT $1::timestamptz - interval '7 days' AS t),
     ids AS (
       SELECT id FROM agents
       UNION SELECT source_agent FROM proposals, since WHERE trust = 'external' AND ts > since.t
       UNION SELECT component FROM runs, since WHERE kind = 'task_op' AND ts > since.t)
     SELECT ids.id, a.display_name, a.last_seen_at, a.revoked_at,
            (SELECT count(*) FROM proposals p, since WHERE p.source_agent = ids.id AND p.kind = 'report' AND p.ts > since.t) AS reports,
            (SELECT count(*) FROM proposals p, since WHERE p.source_agent = ids.id AND p.kind <> 'report' AND p.ts > since.t) AS proposals,
            (SELECT count(*) FROM runs r, since WHERE r.component = ids.id AND r.kind = 'task_op' AND r.meta->>'op' = 'claim' AND r.ok AND r.ts > since.t) AS claimed,
            (SELECT count(*) FROM work w, jsonb_array_elements(w.history) h, since
              WHERE h->>'agent' = ids.id AND h->>'op' = 'update' AND h->>'status' = 'closed' AND (h->>'ts')::timestamptz > since.t) AS closed,
            (SELECT count(*) FROM runs r, since WHERE (r.component = ids.id OR r.meta->>'agent' = ids.id) AND r.ts > since.t) AS calls,
            (SELECT coalesce(sum(r.cost_usd), 0) FROM runs r, since WHERE (r.component = ids.id OR r.meta->>'agent' = ids.id) AND r.ts > since.t) AS spend
     FROM ids LEFT JOIN agents a ON a.id = ids.id
     ORDER BY calls DESC, reports DESC, ids.id`,
    [now],
  );
  if (rows.length === 0) return ["• no agents registered and no agent activity this week"];
  return rows.map((r: any) => {
    const stats = [
      plural(num(r.reports), "report"),
      ...(num(r.proposals) > 0 ? [plural(num(r.proposals), "proposal")] : []),
      `${plural(num(r.claimed), "task")} claimed`,
      `${num(r.closed)} closed`,
      plural(num(r.calls), "tool call"),
      ...(num(r.spend) > 0 ? [usd(r.spend)] : []),
    ];
    const seen = r.revoked_at ? "revoked" : r.last_seen_at ? `last seen ${daysBetween(r.last_seen_at, now)}d ago` : r.display_name ? "never seen" : "not registered";
    return `• ${r.id}${r.display_name ? ` (${r.display_name})` : ""}: ${stats.join(", ")} — ${seen}`;
  });
}

// Spend between two local dates [from, to). Shared by the weekly section and
// the monthly block. Assistant cost is API-equivalent: on a subscription it
// is headroom consumed, not a bill (Phase 4 wording).
async function spendBetween(db: Db, from: string, to: string): Promise<string[]> {
  const claude = await db.query(
    `SELECT labels->>'model' AS model, sum(value) AS usd FROM metrics
     WHERE name = 'claude.cost_usd' AND ts >= $1::date AND ts < $2::date
     GROUP BY 1 ORDER BY 2 DESC`,
    [from, to],
  );
  const aws = await db.query(
    `SELECT labels->>'service' AS service, sum(value) AS usd FROM metrics
     WHERE name = 'aws.cost_usd' AND ts >= $1::date AND ts < $2::date
     GROUP BY 1 ORDER BY 2 DESC`,
    [from, to],
  );
  const lines: string[] = [];
  if (claude.rows.length === 0) lines.push("• assistant: no usage metrics yet (claude-usage collector)");
  else {
    const total = claude.rows.reduce((s: number, r: any) => s + num(r.usd), 0);
    lines.push(`• assistant (API-equivalent): ${usd(total)} — ${claude.rows.map((r: any) => `${r.model ?? "?"} ${num(r.usd).toFixed(2)}`).join(", ")}`);
  }
  if (aws.rows.length === 0) lines.push("• AWS: no cost data (aws-costs collector not configured)");
  else {
    const total = aws.rows.reduce((s: number, r: any) => s + num(r.usd), 0);
    lines.push(`• AWS: ${usd(total)} — ${aws.rows.slice(0, 3).map((r: any) => `${r.service ?? "?"} ${num(r.usd).toFixed(2)}`).join(", ")}`);
  }
  return lines;
}

async function sectionSpend(db: Db, now: Date): Promise<string[]> {
  const from = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const to = new Date(now.getTime() + 86_400_000); // through today
  return spendBetween(db, localDate(from), localDate(to));
}

// Collector/routine health by component (30-day lookback so a collector
// that stopped running shows as "silent" — §5: flag dead collectors),
// watchdog alerts, the inbox backlog.
async function sectionSystem(db: Db, now: Date): Promise<string[]> {
  const runs = await db.query(
    `SELECT component,
            count(*) FILTER (WHERE ok AND ts > $1::timestamptz - interval '7 days') AS ok,
            count(*) FILTER (WHERE ok = false AND ts > $1::timestamptz - interval '7 days') AS failed,
            max(ts) AS last_ts
     FROM runs WHERE kind IN ('collector_run', 'routine_run') AND ts > $1::timestamptz - interval '30 days'
     GROUP BY component ORDER BY failed DESC, component`,
    [now],
  );
  const lines: string[] = [];
  if (runs.rows.length === 0) lines.push("• no collector or routine runs recorded");
  else {
    lines.push(
      `• runs: ${runs.rows
        .map((r: any) => {
          const silent = daysBetween(r.last_ts, now) >= WINDOW_DAYS;
          if (silent) return `${r.component} ⚠ silent ${daysBetween(r.last_ts, now)}d`;
          return `${r.component} ${num(r.ok)} ok${num(r.failed) > 0 ? ` ⚠ ${num(r.failed)} failed` : ""}`;
        })
        .join(", ")}`,
    );
  }
  const alerts = await db.query(
    `SELECT text, count(*) AS n FROM outbound_messages
     WHERE kind = 'alert' AND ts > $1::timestamptz - interval '7 days'
     GROUP BY text ORDER BY n DESC, text LIMIT 3`,
    [now],
  );
  if (alerts.rows.length === 0) lines.push("• no watchdog alerts");
  else {
    const n = alerts.rows.reduce((s: number, r: any) => s + num(r.n), 0);
    lines.push(`• ${plural(n, "watchdog alert")}: ${alerts.rows.map((r: any) => `"${String(r.text).split("\n")[0]!.slice(0, 50)}" ×${num(r.n)}`).join(", ")}`);
  }
  const inbox = await db.query(
    `SELECT count(*) AS n, min(ts) AS oldest FROM inbox WHERE triaged_at IS NULL AND status IN ('new', 'classified')`,
  );
  const untriaged = num(inbox.rows[0]?.n);
  lines.push(untriaged === 0 ? "• inbox clear" : `• inbox: ${untriaged} untriaged, oldest ${daysBetween(inbox.rows[0].oldest, now)}d`);
  return lines;
}

interface EkEvent {
  title: string;
  start: string;
  all_day: boolean;
}

async function sectionNextWeek(db: Db, ctx: WeeklyCtx, now: Date): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT title, to_char(due, 'YYYY-MM-DD') AS due, status FROM work
     WHERE status <> 'closed' AND due IS NOT NULL AND due <= ($1::timestamptz)::date + 7
     ORDER BY due, id LIMIT 10`,
    [now],
  );
  const today = localDate(now);
  const lines = rows.map((r: any) => `• ${r.due} ${String(r.title).slice(0, 60)}${r.due < today ? " — overdue" : ""}${r.status === "blocked" ? " — blocked" : ""}`);
  if (lines.length === 0) lines.push("• nothing due in the next 7 days");

  if (!ctx.ekUrl || !ctx.ekToken) return lines; // calendar degrades absent
  try {
    const res = await (ctx.fetchFn ?? fetch)(`${ctx.ekUrl}/events?days=${WINDOW_DAYS}`, {
      headers: { authorization: `Bearer ${ctx.ekToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`eventkit ${res.status}`);
    const { events } = (await res.json()) as { events: EkEvent[] };
    if (events.length === 0) return [...lines, "• calendar: nothing scheduled"];
    const when = (e: EkEvent) => {
      const d = new Date(e.start);
      const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      return e.all_day ? `${day} (all day)` : `${day} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    };
    return [...lines, `• calendar: ${plural(events.length, "event")}`, ...events.slice(0, 10).map((e) => `    ${when(e)} ${e.title}`)];
  } catch {
    return [...lines, "• calendar unavailable this run"];
  }
}

// §5 monthly: token spend by tier against subscription headroom. Gated on
// the first week so it rides the first weekly review of each month.
export function monthlyWindow(now: Date): { from: string; to: string; label: string } | null {
  if (now.getDate() > MONTHLY_GATE_DAY) return null;
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: localDate(from), to: localDate(to), label: from.toLocaleDateString([], { month: "long", year: "numeric" }) };
}

/** One weekly pass. Always emits exactly one review; returns 1. */
export async function run(db: Db, ctx: WeeklyCtx = {}): Promise<number> {
  const now = ctx.now ?? new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  const projects = await sectionProjects(db, now);
  const decisions = await sectionDecisions(db, now);
  const pending = await sectionPending(db, now);
  const agents = await sectionAgents(db, now);
  const spend = await sectionSpend(db, now);
  const system = await sectionSystem(db, now);
  const next = await sectionNextWeek(db, ctx, now);
  const month = monthlyWindow(now);
  const lastMonth = month ? await spendBetween(db, month.from, month.to) : null;

  const parts: string[] = [
    `📋 weekly review — ${shortDate(since)} to ${shortDate(now)}`,
    "",
    "📂 Projects:",
    ...projects,
    "",
    "✅ Decisions you made:",
    ...decisions,
    "",
    "🔔 Still pending:",
    ...pending,
    "",
    "🤖 Agents:",
    ...agents,
    "",
    "💸 Spend (7 days):",
    ...spend,
    "",
    "⚙️ System:",
    ...system,
    "",
    "🔭 Next week:",
    ...next,
  ];
  if (month && lastMonth) {
    parts.push("", `📅 Last month (${month.label}):`, ...lastMonth, "    subscription headroom check (§5): if the assistant is crowding your plan, that is the signal to move it to an API key");
  }
  if (!ctx.ekUrl || !ctx.ekToken) parts.push("", "🔭 Calendar joins next week's view once the EventKit bridge is connected.");

  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'review')`, [parts.join("\n")]);
  return 1;
}
