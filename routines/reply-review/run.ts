// reply-review — the loop that closes on a thumbs-down (docs/ops/reply-feedback.md).
//
// Daily: gather every reply the user marked 👎 since the last `improvement`
// proposal this routine emitted (or the last 7 days, if it has never emitted
// one), with their note, the prompt that provoked it, the reply itself and
// that turn's tool calls, and emit exactly ONE proposal of kind `improvement`
// describing the patterns and a suggested edit to the assistant's prompt
// overlay.
//
// Three rules hold this honest:
//
// 1. **No model runs here** (invariant 4 — routines never call one). The
//    "patterns" are counts, and the suggested edit is a template that lists
//    the flagged cases verbatim. It is a starting point for the user, not a
//    ghost-written prompt; asking the assistant to draft better wording is a
//    separate, explicit step from triage.
// 2. **Nothing is applied.** The routine writes a proposal and stops. The
//    prompt overlay changes only when the user allows that proposal, and the
//    write then goes through the vault bridge as principal `user`
//    (apps/console/src/prompt-overlay.ts) — a human change, invariant 2.
// 3. **Silence-default and self-bounding.** No new 👎 since the last proposal
//    → no proposal. Because the window for the next run starts where the
//    last emitted proposal's timestamp left off, a run right after another
//    (with no new feedback in between) naturally finds nothing new — no
//    separate dedup check needed.

import type { Db, RoutineCtx } from "../morning-brief/run.js";

export interface ReplyReviewCtx extends RoutineCtx {
  now?: Date;
}

const FALLBACK_DAYS = 7; // window to look back when the routine has never emitted a proposal
const MAX_CASES = 20; // limit: fixed — the proposal is for reading; beyond this it is a query, not a prompt card
const PROMPT_CHARS = 300;
const REPLY_CHARS = 400;
const LONG_REPLY_CHARS = 2000;

export const SOURCE_AGENT = "reply-review";
export const OVERLAY_PATH = "assistant-prompt.md";

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface FlaggedCase {
  message_id: number;
  ts: string;
  thread: string;
  note: string | null;
  prompt: string;
  reply: string;
  model: string | null;
  tools: string[];
}

/** Deterministic observations over the flagged set — counts only, no interpretation. */
export function patterns(cases: FlaggedCase[]): string[] {
  const out: string[] = [];
  const noTools = cases.filter((c) => c.tools.length === 0).length;
  if (noTools > 0) out.push(`${noTools} of ${cases.length} answered with no tool call at all`);
  const long = cases.filter((c) => c.reply.length >= LONG_REPLY_CHARS).length;
  if (long > 0) out.push(`${long} reply(s) ran past ${LONG_REPLY_CHARS} characters`);
  const noNote = cases.filter((c) => !c.note).length;
  if (noNote > 0) out.push(`${noNote} were flagged without a note — the reply text is all there is to go on`);
  const byThread = new Map<string, number>();
  for (const c of cases) byThread.set(c.thread, (byThread.get(c.thread) ?? 0) + 1);
  const worst = [...byThread.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 1) out.push(`${worst[1]} came from the same thread (${worst[0]})`);
  const byTool = new Map<string, number>();
  for (const c of cases) for (const t of new Set(c.tools)) byTool.set(t, (byTool.get(t) ?? 0) + 1);
  const topTool = [...byTool.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topTool && topTool[1] > 1) out.push(`${topTool[1]} used ${topTool[0]}`);
  return out;
}

/**
 * The suggested prompt-overlay section. A template, deliberately: it states
 * what was flagged and asks for the correction in the user's own words. No
 * model wrote it and none is implied to have.
 */
export function suggestedSection(cases: FlaggedCase[], windowEnd: string): string {
  const lines = [
    `## Reply quality — flagged as of ${windowEnd}`,
    "",
    `The user marked ${plural(cases.length, "reply", "replies")} 👎 since the last pass.`,
    "This section was generated from those flags by the reply-review routine (no model wrote it);",
    "edit it into the guidance you actually want before allowing it, or deny the proposal.",
    "",
    "What they flagged:",
    "",
  ];
  for (const c of cases) {
    lines.push(`- **${c.ts}** — they asked: “${clip(c.prompt, PROMPT_CHARS)}”`);
    lines.push(`  the reply began: “${clip(c.reply, REPLY_CHARS)}”`);
    lines.push(`  tools used: ${c.tools.length ? c.tools.join(", ") : "none"}`);
    if (c.note) lines.push(`  their note: “${clip(c.note, 200)}”`);
  }
  lines.push("", "Patterns (counted, not interpreted):", "");
  const ps = patterns(cases);
  lines.push(...(ps.length ? ps.map((p) => `- ${p}`) : ["- none stood out across the set"]));
  lines.push(
    "",
    "Guidance to apply (rewrite this line — it is a placeholder, not advice):",
    "",
    "> When a question resembles the cases above, do the thing that was missing there instead.",
  );
  return lines.join("\n");
}

/** The ts of the last `improvement` proposal this routine emitted, or null if it never has. */
async function lastEmittedAt(db: Db): Promise<Date | null> {
  const { rows } = await db.query(
    `SELECT ts FROM proposals WHERE kind = 'improvement' AND source_agent = $1 ORDER BY ts DESC LIMIT 1`,
    [SOURCE_AGENT],
  );
  return rows.length > 0 ? new Date(rows[0].ts) : null;
}

/** The 👎 replies since `since`, with their turn's tool calls. */
async function flagged(db: Db, since: Date): Promise<FlaggedCase[]> {
  const { rows } = await db.query(
    `SELECT o.id AS message_id, f.ts, o.thread, f.note,
            coalesce(i.text, '') AS prompt, o.text AS reply, r.model, r.meta->'tools_used' AS tools_used
     FROM reply_feedback f
     JOIN outbound_messages o ON o.id = f.outbound_message_id
     LEFT JOIN inbound_messages i ON i.id = o.in_reply_to
     LEFT JOIN LATERAL (
       SELECT model, meta FROM runs
       WHERE kind = 'turn'
         AND (meta->>'turn_id' = o.id::text OR meta->>'message_id' = o.in_reply_to::text)
       ORDER BY ts DESC LIMIT 1
     ) r ON true
     WHERE f.rating = -1 AND f.ts > $1::timestamptz
     ORDER BY f.ts LIMIT $2`,
    [since, MAX_CASES],
  );
  return rows.map((r: any) => ({
    message_id: Number(r.message_id),
    ts: new Date(r.ts).toISOString().slice(0, 16).replace("T", " "),
    thread: String(r.thread ?? "default"),
    note: r.note ? String(r.note) : null,
    prompt: String(r.prompt ?? ""),
    reply: String(r.reply ?? ""),
    model: r.model ? String(r.model) : null,
    tools: r.tools_used && typeof r.tools_used === "object" ? Object.keys(r.tools_used as Record<string, unknown>) : [],
  }));
}

/**
 * One daily pass. Returns the number of proposals emitted: 0 or 1 — the
 * runner turns that into `meta.outcome`: `acted` or `silent` (T1-4).
 */
export async function run(db: Db, ctx: ReplyReviewCtx = {}): Promise<number> {
  const now = ctx.now ?? new Date();
  const windowEnd = isoDay(now);

  const lastTs = await lastEmittedAt(db);
  const since = lastTs ?? new Date(now.getTime() - FALLBACK_DAYS * 86_400_000);

  const cases = await flagged(db, since);
  if (cases.length === 0) return 0; // silence-default: no new 👎 since the last proposal, nothing to say

  const payload = {
    title: `Reply quality: ${plural(cases.length, "reply", "replies")} flagged 👎`,
    window_start: isoDay(since),
    window_end: windowEnd,
    flagged: cases,
    patterns: patterns(cases),
    // A SUGGESTION. Applied only if the user allows this proposal, and then by
    // the console as principal `user` — never from here (invariant 2).
    suggested_edit: {
      path: OVERLAY_PATH,
      mode: "append_section",
      content: suggestedSection(cases, windowEnd),
    },
  };
  await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('improvement', $1, 'internal', $2)`,
    [SOURCE_AGENT, JSON.stringify(payload)],
  );
  return 1;
}
