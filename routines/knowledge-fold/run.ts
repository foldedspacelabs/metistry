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
//      (packages/mcp-brain/src/knowledge-write.ts). Its own file is
//      `Journal/Fold/<date>.md`, `source: knowledge-fold` — never
//      `Journal/<date>.md`, which is the user's own note and no writer here
//      may touch (daily-flow-spec §5.1, ticket P1-9).
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
// THE FOLD'S OWN FILE (§6, §13.2): rendered from `Templates/Fold.md`, the one
// template where `{{ prose }}` is legal (D14) — every other directive is
// filled by `renderTemplate` itself (`packages/core/src/template.ts`), which
// hands back a `ProseRequest` for each `prose` slot. Filling THOSE is the one
// piece of the file this routine cannot do (invariant 4: a routine calls no
// model), so the rendered skeleton — prose slots still open, marked
// `<!-- metistry:prose N -->` — rides on the SAME turn the routine already
// enqueues, and the assistant's whole job is to fill the numbered slots and
// write the result verbatim. No reader wired, or no such file in the vault
// yet: §6.4's `template_missing` row would normally mean "write nothing", but
// this file predates the template (daily-flow-spec §13.2), so instead the
// routine falls back to the pre-template instruction — freeform, at the SAME
// new path, with a visible note saying why — rather than losing the fold
// outright on an instance that has not stamped `Templates/Fold.md` yet.
//
// SCHEDULE (deviation, documented in docs/ops/knowledge-fold.md): the runner
// has no notion of time of day, and it gates the next run on the LAST
// `routine_run` row for the component — so an `@daily` routine that skips
// because it is 09:00 would be due again at 09:00 tomorrow and never reach
// the evening. So: `@hourly`, with the evening gate here (local hour ≥
// EVENING_HOUR — the container's TZ is METISTRY_TZ) and a once-per-local-day
// guard off the same anchor. One fold a night, retried hourly until it lands.

import {
  DEFAULT_TEMPLATE_MAX_BYTES,
  FOLD_SOURCE,
  ROUTINE_TIER,
  TEMPLATES_DIR,
  TEMPLATE_MISSING,
  intEnv,
  renderTemplate,
  templateSkip,
  type ProseRequest,
  type TemplateQueries,
  type TemplateReader,
} from "@foldedspacelabs/metistry-core";
import type { Db, RoutineCtx } from "../morning-brief/run.js";

export interface FoldCtx extends RoutineCtx {
  now?: Date;
  /**
   * The named-query door `{{ requests limit: 5 }}` (and any query-backed
   * directive an instance adds to `Templates/Fold.md`) reads through
   * (invariant 3). Not yet wired from the runner (`apps/console/src/main.ts`
   * builds one already, for its own routes) — absent renders each
   * query-backed directive's own §6.4 "not configured" note rather than
   * failing the render, exactly like a missing calendar bridge.
   */
  queries?: TemplateQueries;
  /**
   * `GET /vault/read`, for the template's own text and any `include` inside
   * it. Absent is indistinguishable from "no such file" (`templateSkip`
   * reads both as null), so the routine takes the same fallback either way —
   * §6.4's `template_missing` is a configuration fact, not a reason to lose
   * the fold.
   */
  reader?: TemplateReader;
}

export const COMPONENT = "knowledge-fold";
export const THREAD = "fold";
/** The prompt keys on this prefix — `inbound_messages` has no `kind` column, so meta.kind AND a recognisable first line. */
export const BRIEF_PREFIX = "🌙 evening fold";
export const EVENING_HOUR = 18;
export const FALLBACK_DAYS = 7;
export const MAX_BRIEF_BYTES = 4096; // limit: fixed — the brief is handles, not payloads (docs/ops/knowledge-fold.md); the assistant fetches content itself
export const PER_GROUP_LIMIT = 25; // limit: fixed — a per-group query bound; MAX_BRIEF_BYTES trims further if every group's 25 is still too much

/** Where the fold's own file is rendered FROM (§6.1) — `Templates/Fold.md`. */
export const FOLD_TEMPLATE_PATH = `${TEMPLATES_DIR}/Fold.md`;
/** Where it is rendered TO (§5.1): the fold's own reserved directory, never `Journal/<date>.md` — that file is the user's. */
export const FOLD_DIR = "Journal/Fold";
export const foldPath = (date: string): string => `${FOLD_DIR}/${date}.md`;

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

// --- the fold's own file (§6, §13.2) ----------------------------------------

export type FoldRenderMode = "skeleton" | "fallback";

/**
 * What the assistant is told to write tonight. `"skeleton"` — the ordinary
 * case once `Templates/Fold.md` reads — hands over the whole file with every
 * directive but `prose` already filled; the assistant's only job is the
 * numbered slots. `"fallback"` is §6.4's `template_missing`/`template_unreadable`
 * with one difference from an ordinary template: rather than writing nothing,
 * it keeps the pre-template instruction alive at the NEW path, with a note
 * saying why there is no skeleton (never silent, per CLAUDE.md's "enforce at
 * the tool, never by prompting" — the note is data on the turn, not a hope
 * that the model remembers).
 */
export interface FoldWrite {
  mode: FoldRenderMode;
  /** `Journal/Fold/<date>.md` — never `Journal/<date>.md`, which is the user's (§5.1). */
  path: string;
  /** Set only in `"skeleton"` mode: the rendered file, `<!-- metistry:prose N -->` markers still open. */
  skeleton?: string;
  proseRequests?: ProseRequest[];
  /** Set only in `"fallback"` mode: why there is no skeleton, quoted verbatim in the brief. */
  note?: string;
}

/**
 * The query store is optional on `FoldCtx` (not yet wired from the runner —
 * see the field's own comment). Absent, every query-backed directive fails
 * its own call and renders its OWN §6.4 note (`renderRequests` etc. catch
 * this and say "not configured"), so the file still renders — the engine
 * never needed a real query store to produce a page, only to fill it in.
 */
const NO_QUERIES: TemplateQueries = {
  async run(): Promise<{ rows: Record<string, unknown>[] }> {
    throw new Error(`no query store is wired into ${COMPONENT} yet`);
  },
};

/**
 * Render tonight's fold file from `Templates/Fold.md`. The routine calls no
 * model (invariant 4), so this fills every directive EXCEPT `prose` and hands
 * the still-open slots back as `ProseRequest`s for the assistant's turn.
 *
 * No reader wired, or no such file in the vault (`templateSkip` cannot tell
 * the two apart, and does not need to): falls back to the pre-template
 * instruction at the new path, §6.4's `template_missing` made visible on the
 * turn rather than silently losing tonight's fold.
 */
async function renderFoldWrite(ctx: FoldCtx, now: Date, date: string): Promise<FoldWrite> {
  const path = foldPath(date);
  const env = process.env;
  const maxBytes = intEnv("METISTRY_TEMPLATE_MAX_BYTES", DEFAULT_TEMPLATE_MAX_BYTES, env);
  const raw = ctx.reader ? await ctx.reader.read(FOLD_TEMPLATE_PATH) : null;
  const skip = templateSkip(raw, maxBytes);
  if (skip !== null) {
    const note =
      skip === TEMPLATE_MISSING
        ? `no ${FOLD_TEMPLATE_PATH} yet — \`metistry init\` stamps it (daily-flow-spec §6.1); writing freeform tonight`
        : `${FOLD_TEMPLATE_PATH} is not renderable (${skip}) — writing freeform tonight`;
    return { mode: "fallback", path, note };
  }
  const rendered = await renderTemplate(raw!, {
    templatePath: FOLD_TEMPLATE_PATH,
    source: FOLD_SOURCE,
    queries: ctx.queries ?? NO_QUERIES,
    reader: ctx.reader,
    now,
    env,
  });
  return { mode: "skeleton", path, skeleton: rendered.markdown, proseRequests: rendered.proseRequests };
}

/** The one or two lines that tell the assistant where and how to write tonight — the rest of the mechanism lives in `seed/assistant-prompt.md`'s Fold section. */
function writeInstructionLines(write: FoldWrite): string[] {
  return write.mode === "skeleton"
    ? [`Fold it: read each handle, then write ${write.path} (source: knowledge-fold) — fill ONLY the numbered prose slots in the skeleton below, keep every other line exactly as rendered, and create or update the entity pages you own.`]
    : [`Fold it: read each handle, write ${write.path} (source: knowledge-fold; ${write.note}), and create or update only the entity pages you own.`];
}

/** The rendered skeleton plus its numbered prose slots, appended after the handle groups. Its own size is bounded by the template engine's cap (`METISTRY_TEMPLATE_MAX_BYTES`, default 16 KB) — a second budget from MAX_BRIEF_BYTES, which stays about handles alone. */
function skeletonBlock(write: FoldWrite): string {
  const lines = [`Skeleton for ${write.path}, rendered from ${FOLD_TEMPLATE_PATH} — write it verbatim except the prose slots:`, "", "```markdown", (write.skeleton ?? "").trimEnd(), "```"];
  const reqs = write.proseRequests ?? [];
  if (reqs.length > 0) {
    lines.push("", "Prose slots — replace each marker LINE with your answer, nothing more:");
    for (const r of reqs) lines.push(`${r.index}. ${r.prompt}${r.using ? ` (read ${r.using})` : ""} — replaces \`<!-- metistry:prose ${r.index} -->\``);
  }
  return lines.join("\n");
}

/**
 * The brief: a header, the fold instruction (the detail lives in the
 * assistant's prompt), the handles grouped, then — when `Templates/Fold.md`
 * rendered — the skeleton to fill. The handle groups are capped at
 * MAX_BRIEF_BYTES by dropping from the largest group first and saying so, so
 * a busy day degrades to "and N more" rather than to a 40 KB prompt; the
 * skeleton trails uncapped by that same budget (it is the file, not a
 * handle, and the engine already bounds its own size).
 */
export function renderBrief(handles: Handle[], window: { start: Date; end: Date }, write: FoldWrite): RenderedBrief {
  const header = [
    `${BRIEF_PREFIX} — ${localDate(window.end)}`,
    "",
    `New since the last fold (${stamp(window.start)}).`,
    ...writeInstructionLines(write),
    "Anything belonging to the user (Me/, a note whose source is theirs) → report, don't write. Never write Journal/<date>.md — that is the user's own file, not the fold's.",
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
  if (write.mode === "skeleton") text = `${text}\n\n${skeletonBlock(write)}`;
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

  const write = await renderFoldWrite(ctx, now, localDate(now));
  const brief = renderBrief(handles, { start: since, end: now }, write);
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
    // (decision 3); the drain honours both. `fold_path`/`fold_mode` are the
    // one-line answer to "where did tonight's fold go" without re-deriving
    // the date from the window.
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
        fold_path: write.path,
        fold_mode: write.mode,
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
        fold_path: write.path,
        fold_mode: write.mode,
      }),
    ],
  );
  return 1;
}
