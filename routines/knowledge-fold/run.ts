// knowledge-fold — the evening fold (plan §4.11: "Metis folds reports into
// knowledge on the evening routine, in its own voice, as its own commit";
// docs/research/2026-09-stash-review.md §"Worth taking" 1). The routine is
// the ASSEMBLER, never the author:
//
//   1. **Reads only what is new since its last successful fold.** The anchor
//      is its own `runs` row (component `knowledge-fold`, kind
//      `routine_run`, ok, `meta.folded = true`) — a skipped pass never moves
//      the window. First ever run: a bounded FALLBACK_DAYS window, so a
//      fresh instance does not fold its whole history in one turn.
//   2. **Writes only inside reserved paths** — the routine writes nothing to
//      the vault at all; the assistant does, under the Fold section of its
//      prompt and the ownership rule enforced in `knowledge_write`
//      (packages/mcp-brain/src/knowledge-write.ts).
//   3. **Never reads its own output.** Enforced by construction: every
//      handle below comes from a Postgres table, and nothing here opens the
//      vault — so `Journal/*` and every `source: knowledge-fold`
//      note are unreachable as input. Items the fold itself produced
//      (proposals or captures whose `source_agent` is this routine) are
//      excluded in SQL as well.
//
// No model runs here (invariant 4). The routine assembles handles — ids,
// paths, titles, one-line summaries — and enqueues exactly ONE assistant
// turn on thread `fold` (`inbound_messages`, `meta.kind = 'fold'` plus the
// BRIEF_PREFIX the prompt keys on). The assistant is the one writer.
//
// SCHEDULE (deviation, documented in docs/ops/knowledge-fold.md): the runner
// has no notion of time of day, and it gates the next run on the LAST
// `routine_run` row for the component — so an `@daily` routine that skips
// because it is 09:00 would be due again at 09:00 tomorrow and never reach
// the evening. So: `@hourly`, with the evening gate here (local hour ≥
// EVENING_HOUR — the container's TZ is METISTRY_TZ) and a once-per-local-day
// guard off the same anchor. One fold a night, retried hourly until it lands.

import { ROUTINE_TIER } from "@foldedspacelabs/metistry-core";
import type { Db, RoutineCtx } from "../morning-brief/run.js";

export interface FoldCtx extends RoutineCtx {
  now?: Date;
}

export const COMPONENT = "knowledge-fold";
export const THREAD = "fold";
/** The prompt keys on this prefix — `inbound_messages` has no `kind` column, so meta.kind AND a recognisable first line. */
export const BRIEF_PREFIX = "🌙 evening fold";
export const EVENING_HOUR = 18;
export const FALLBACK_DAYS = 7;
export const MAX_BRIEF_BYTES = 4096; // the brief is handles, not payloads
export const PER_GROUP_LIMIT = 25; // before the size cap trims further

export type Group = "proposals" | "work" | "artifacts" | "sessions";

export interface Handle {
  group: Group;
  /** Stable id the assistant can look the item up by: `proposal #41`, `work #12`, `ver_…`, `inbox #88`. */
  ref: string;
  title: string;
  summary?: string | undefined;
  path?: string | undefined;
}

const GROUP_HEADINGS: Record<Group, string> = {
  proposals: "accepted proposals (queries_run for the payload):",
  work: "work closed:",
  artifacts: "artifacts published (artifacts_get):",
  sessions: "sessions captured (inbox):",
};
const GROUP_ORDER: Group[] = ["proposals", "work", "artifacts", "sessions"];

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Local calendar date — the container's TZ is METISTRY_TZ, so "today" is the user's, not UTC's. */
export const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const stamp = (d: Date): string => `${localDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function handleLine(h: Handle): string {
  const summary = h.summary ? ` · ${clip(h.summary, 110)}` : "";
  const path = h.path ? ` (${clip(h.path, 90)})` : "";
  return `- ${h.ref} — ${clip(h.title, 90)}${summary}${path}`;
}

export interface RenderedBrief {
  text: string;
  /** Handles that made it into the brief, in order. */
  included: Handle[];
  /** How many were dropped by the size cap, per group. */
  dropped: Record<string, number>;
}

/**
 * The brief: a header, the fold instruction (one line — the detail lives in
 * the assistant's prompt), then the handles grouped. Capped at
 * MAX_BRIEF_BYTES by dropping from the largest group first and saying so, so
 * a busy day degrades to "and N more" rather than to a 40 KB prompt.
 */
export function renderBrief(handles: Handle[], window: { start: Date; end: Date }): RenderedBrief {
  const header = [
    `${BRIEF_PREFIX} — ${localDate(window.end)}`,
    "",
    `New since the last fold (${stamp(window.start)}). Fold it: read each handle, write`,
    `Journal/${localDate(window.end)}.md, and create or update only the entity pages you own.`,
    "Anything belonging to the user (Me/, a note whose source is theirs) → report, don't write.",
    "",
  ].join("\n");

  const kept = new Map<Group, Handle[]>(GROUP_ORDER.map((g) => [g, handles.filter((h) => h.group === g)]));
  const dropped: Record<string, number> = {};
  const build = () => {
    const parts = [header];
    for (const g of GROUP_ORDER) {
      const items = kept.get(g) ?? [];
      const n = dropped[g] ?? 0;
      if (items.length === 0 && n === 0) continue;
      parts.push(GROUP_HEADINGS[g], ...items.map(handleLine), ...(n > 0 ? [`- …and ${n} more (not listed — the queue has them)`] : []), "");
    }
    return parts.join("\n").trimEnd();
  };

  let text = build();
  while (Buffer.byteLength(text, "utf8") > MAX_BRIEF_BYTES) {
    // drop one from the currently largest group — deterministic, and it
    // never starves a small group of its single line
    const largest = GROUP_ORDER.map((g) => [g, (kept.get(g) ?? []).length] as const).sort((a, b) => b[1] - a[1])[0];
    if (!largest || largest[1] === 0) break; // header alone is over cap: nothing left to trim
    const items = kept.get(largest[0])!;
    items.pop();
    dropped[largest[0]] = (dropped[largest[0]] ?? 0) + 1;
    text = build();
  }
  return { text, included: GROUP_ORDER.flatMap((g) => kept.get(g) ?? []), dropped };
}

// --- what is new -----------------------------------------------------------

/** The last fold that actually enqueued a turn. A skipped pass writes no such row, so the window never slides past unread material. */
async function anchor(db: Db): Promise<Date | null> {
  const { rows } = await db.query(
    `SELECT ts FROM runs
     WHERE component = $1 AND kind = 'routine_run' AND ok AND meta->>'folded' = 'true'
     ORDER BY ts DESC LIMIT 1`,
    [COMPONENT],
  );
  return rows[0]?.ts ? new Date(rows[0].ts) : null;
}

async function newHandles(db: Db, since: Date): Promise<Handle[]> {
  const out: Handle[] = [];

  // Decisions the user made: proposals allowed (or allowed with changes).
  // `source_agent <> knowledge-fold` is the never-read-your-own-output rule
  // in SQL as well as by construction.
  const proposals = await db.query(
    `SELECT id, kind, source_agent, payload FROM proposals
     WHERE decision IN ('allow', 'accept_with_changes')
       AND kind IN ('knowledge', 'report', 'session', 'review')
       AND source_agent <> $2
       AND coalesce(decided_at, ts) > $1::timestamptz
     ORDER BY coalesce(decided_at, ts) LIMIT $3`,
    [since, COMPONENT, PER_GROUP_LIMIT],
  );
  for (const r of proposals.rows) {
    const p = r.payload ?? {};
    const title = p.title ?? p.classification?.title ?? p.classification?.action ?? p.summary ?? `${r.kind} proposal`;
    out.push({
      group: "proposals",
      ref: `proposal #${r.id}`,
      title: String(title),
      summary: `${r.kind} from ${r.source_agent}`,
      ...(typeof p.path === "string" ? { path: p.path } : {}),
    });
  }

  const work = await db.query(
    `SELECT id, title, area, kind, external_ref FROM work
     WHERE status = 'closed' AND updated_at > $1::timestamptz
     ORDER BY updated_at LIMIT $2`,
    [since, PER_GROUP_LIMIT],
  );
  for (const r of work.rows) {
    out.push({
      group: "work",
      ref: `work #${r.id}`,
      title: String(r.title ?? ""),
      summary: [r.kind, r.area ? `area ${r.area}` : null, r.external_ref].filter(Boolean).join(", "),
    });
  }

  const artifacts = await db.query(
    `SELECT v.id, v.artifact_id, v.path_prefix, v.message, v.author_principal, a.project, a.slug
     FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
     WHERE v.created_at > $1::timestamptz AND v.author_principal <> $2
     ORDER BY v.created_at LIMIT $3`,
    [since, COMPONENT, PER_GROUP_LIMIT],
  );
  for (const r of artifacts.rows) {
    out.push({
      group: "artifacts",
      ref: `${r.artifact_id} ${r.id}`,
      title: String(r.message ?? ""),
      summary: `${r.project}/${r.slug} by ${r.author_principal}`,
      path: String(r.path_prefix ?? ""),
    });
  }

  // Session summaries (`metistry import-sessions` → POST /capture). `inbox`
  // has no `kind` column, so both encodings count: the transport slot
  // (`source = 'session'`) and the classifier payload.
  const sessions = await db.query(
    `SELECT id, path, note, source FROM inbox
     WHERE ts > $1::timestamptz
       AND (source = 'session' OR proposal->>'kind' = 'session')
       AND coalesce(source_agent, '') <> $2
     ORDER BY ts LIMIT $3`,
    [since, COMPONENT, PER_GROUP_LIMIT],
  );
  for (const r of sessions.rows) {
    out.push({
      group: "sessions",
      ref: `inbox #${r.id}`,
      title: clip(r.note ?? r.path, 90) || String(r.path),
      path: String(r.path ?? ""),
    });
  }

  return out;
}

// --- the pass --------------------------------------------------------------

export type FoldResult = 0 | 1;

/**
 * One pass. Returns 1 when a fold turn was enqueued, 0 otherwise (too early,
 * already folded today, or nothing new — silence-default either way).
 */
export async function run(db: Db, ctx: FoldCtx = {}): Promise<FoldResult> {
  const now = ctx.now ?? new Date();
  const last = await anchor(db);

  if (now.getHours() < EVENING_HOUR) {
    // The fold is an evening job; the runner has no time of day, so the gate
    // is here. Nothing is lost — the next hourly tick re-checks.
    console.log(`${COMPONENT}: before ${EVENING_HOUR}:00 local (${stamp(now)}) — not folding yet`);
    return 0;
  }
  if (last && localDate(last) === localDate(now)) {
    console.log(`${COMPONENT}: already folded today (${stamp(last)})`);
    return 0;
  }

  const since = last ?? new Date(now.getTime() - FALLBACK_DAYS * 86_400_000);
  const handles = await newHandles(db, since);
  if (handles.length === 0) return 0; // silence-default: nothing new, no turn, no runs row

  const brief = renderBrief(handles, { start: since, end: now });
  const counts = GROUP_ORDER.reduce<Record<string, number>>((acc, g) => {
    const n = brief.included.filter((h) => h.group === g).length;
    if (n > 0) acc[g] = n;
    return acc;
  }, {});

  const inbound = await db.query(
    `INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`,
    // `tier: routine` — a machine-assembled turn, cheap by default (the
    // instance's `routine` tier; cost research decision 2). `fresh_session` —
    // the fold is its own task and never continues the chat's context
    // (decision 3); the drain honours both.
    [
      THREAD,
      brief.text,
      JSON.stringify({
        kind: "fold",
        tier: ROUTINE_TIER,
        fresh_session: true,
        source: COMPONENT,
        window_start: since.toISOString(),
        window_end: now.toISOString(),
      }),
    ],
  );

  // The routine's own runs row: the anchor for the next pass AND the counts
  // the morning brief reads back. `folded: true` is what makes it an anchor —
  // the runner's own routine_run row (written for every tick, skips included)
  // deliberately is not one.
  await db.query(
    `INSERT INTO runs (component, kind, ok, started_at, finished_at, meta)
     VALUES ($1, 'routine_run', true, now(), now(), $2)`,
    [
      COMPONENT,
      JSON.stringify({
        folded: true,
        thread: THREAD,
        inbound_id: Number(inbound.rows[0]?.id),
        window_start: since.toISOString(),
        window_end: now.toISOString(),
        items: brief.included.length,
        counts,
        ...(Object.keys(brief.dropped).length > 0 ? { dropped: brief.dropped } : {}),
        brief_bytes: Buffer.byteLength(brief.text, "utf8"),
      }),
    ],
  );
  return 1;
}
