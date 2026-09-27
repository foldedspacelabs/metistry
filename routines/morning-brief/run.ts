// morning-brief — the one morning surface (design-build-plan §2.13, §2.5;
// C97, C102, C103, C111; ticket T3-6). It does three things, in this order:
//
//  1. **The brief's own file**, `Journal/Brief/<date>.md` — rendered from
//     `Templates/Brief.md` (the owner's, in their vault) and written through
//     the reconciler as principal `morning-brief`, so it carries
//     `source: morning-brief`. `Journal/Brief/` is this routine's reserved
//     subfolder: an OWNERSHIP fact (owner ruling (a), W1), not a grant. It
//     presents the standup BY REFERENCE — `![[Journal/Standup/<date>]]` in the
//     seeded template — never by copy: the brief runs at 7:00 and the standup
//     at 8:00, so the embed is empty until that file lands, and nothing is
//     regenerated when it does (§2.5). Under its `## Next Up` heading (added
//     at the end when the template has none) the routine lists today's timed
//     meetings, each with one prose slot.
//  2. **The daily note's section** — the bytes between `<!-- metistry:day -->`
//     markers in `Journal/<date>.md`, through the reconciler's section
//     operation (`POST /vault/section`, T2-6): today's plan, meetings and the
//     standup's embed. MODEL-FREE by construction: `daySectionBody` is built
//     from calendar rows and paths alone and takes no prose, and the section's
//     writer list (`SECTION_WRITERS`, `apps/reconciler/src/paths.ts`) admits
//     `morning-brief` and `user` — never `assistant`. Before the owner opens
//     the day (no note yet) the section is not written: the section operation
//     never creates the owner's note, and neither does this routine; the run
//     says `day_section: no_daily_note` and Close the Day writes it later.
//     Broken markers write nothing and raise one `note` request (C102).
//  3. **ONE assistant turn** for the file's prose slots — the template's
//     `{{ prose }}` lines (C103) and each meeting's Next Up line. The routine
//     calls no model (invariant 4); the turn fills the slots through
//     `knowledge_write`, which accepts a change to a pending slot's line in
//     this folder and nothing else (`fillProseSlots`, core). No slot, no turn.
//
// Then the chat message it always sent — the D10 soft budget over Needs You,
// the reviews, the areas, the system — now opening with the brief's file
// ("the message links there", C97). It keeps its own rules, spec'd per the
// ratified decisions: D10 SOFT budget (surface the most impactful ~5, +1-2
// extra only if also critical; link to the full queue, never hard-truncate),
// consequence ranking (deterministic — no model ranks your attention),
// auto-expiry (un-acted proposals expire after EXPIRE_DAYS to
// decision='expired' — searchable, never lost; a mirror never does, K15),
// silence-default (nothing pending = no message; the FILE is written every
// working day, because it is Today's first state).
//
// SCHEDULE (§2.5): working days at 07:00, from the manifest. With no working
// days in `Me/profile.md` the runner never fires it; a run nobody scheduled
// (Run Now) asks the same question and writes no file, recording
// `skipped:no_working_days`. A late run is dated from its slot.

import {
  DEFAULT_TEMPLATE_MAX_BYTES,
  PROFILE_PATH,
  TEMPLATE_MISSING,
  TEMPLATE_UNREADABLE,
  calendarDate,
  configuredTimeZone,
  intEnv,
  profileFacts,
  renderTemplate,
  requestWordOf,
  scanNoteSection,
  sectionMissingMessage,
  templateSkip,
  NOTE_SECTIONS,
  PROSE_PENDING,
  proseMarker,
  type CalendarEvent,
  type CalendarProvider,
  type ProseRequest,
  type SectionMissingReason,
} from "@foldedspacelabs/metistry-core";
import { NO_QUERIES, eventkitCalendar, refuseMaterialised, sourceOf, type PlanCtx, type PlanVault } from "../plan-tomorrow/run.js";
import { enqueueProseTurn } from "../prose-turn.js";
import { vaultReader } from "../vault-reader.js";

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
  secret_failure: 100,  // the third kind of access (T2-9): a secret that failed — whatever needs it is stopped until you act
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
  /**
   * The slot this run is FOR, when a time-of-day schedule fired it (the
   * console's runner, apps/console/src/runner.ts). A run that is late — the
   * Mac slept through 23:00 and woke at 07:30 — still dates and plans from
   * its slot, not from the moment it woke. Absent: an interval schedule, or a
   * run nobody scheduled.
   */
  scheduledFor?: Date | undefined;
  /** The zone that slot was read in — the schedule's `tz`, then `Me/profile.md`'s `timezone`, then METISTRY_TZ. */
  timeZone?: string | undefined;
  /**
   * The runner's own `runs` row for this run (apps/console/src/runner.ts).
   * The §2.21 act key: a routine that passes it on each of its vault writes
   * gets them as ONE commit with a `Metistry-Run:` trailer — the Morning
   * Brief's file and its daily-note section are one act. Absent (a direct
   * call, a test): each write is its own commit.
   */
  runId?: number | undefined;
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

// 📂 Areas: status rollup from the work table by area (fed by the
// github-state collector today; more collectors → richer status). C82
// renamed this section from Projects — "Projects" now names the per-project
// rollup with modes, budgets and a cap (`projects_rollup`).
async function sectionAreas(db: Db): Promise<string[] | null> {
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

// ============================================================================
// The brief's own file, the daily note's section, and the one turn (T3-6)
// ============================================================================

export const COMPONENT = "morning-brief";
/** The `intent.principal` every write carries, the `source:` the file declares, and the section writer `SECTION_WRITERS` names. */
export const PRINCIPAL = COMPONENT;
/** §2.13: `Journal/Brief/<date>.md` — this routine's reserved subfolder (`JOURNAL_ROUTINE_DIRS`), one writer, and this is it. */
export const BRIEF_DIR = "Journal/Brief";
export const briefPath = (date: string): string => `${BRIEF_DIR}/${date}.md`;
/** The owner's daily note — the section lives in it, and nothing else of it is ours. */
export const dailyNotePath = (date: string): string => `Journal/${date}.md`;
/** The manifest's default for `config.template`. */
export const DEFAULT_TEMPLATE = "Templates/Brief.md";
export const TEMPLATE_KEY = "template";
/** Where the Next Up list goes: under the template's own heading of this text, or appended at the end with it. */
export const NEXT_UP_HEADING = "## Next Up";
export const MAX_NEXT_UP = 12; // limit: fixed — a working day's meetings; past that the day has bigger problems than a prep line each
const MAX_EVENT_TEXT = 120; // limit: fixed — a title or a location, one line; the prompt that carries it is bounded too (≤200, like a template's)
const MAX_PROMPT_CHARS = 200; // limit: fixed — the same bound a template's `prose` prompt has

/**
 * Why a pass wrote no file. Each is a fact about the install or the day,
 * never a fault: the run is `ok`, the reason is on the row as
 * `skipped:<reason>` (D7).
 */
export const BRIEF_SKIPS = [
  "no_working_days", // §2.5 / §6.4: Me/profile.md does not say which days you work — the absent state Today draws
  TEMPLATE_MISSING,
  TEMPLATE_UNREADABLE, // one report request names the file
  "user_owned", // the file on disk is not this routine's; §5.1's ownership rule wins
  "would_materialise", // the belt behind D4
] as const;
export type BriefSkip = (typeof BRIEF_SKIPS)[number];

/**
 * What became of the daily note's section — `meta.day_section` on the run.
 * `written` is the only one that touched the note; `no_daily_note` is the
 * ordinary 7:00 AM answer before the owner has opened the day.
 */
export const DAY_SECTION_STATES = ["written", "no_daily_note", "section_missing", "conflict", "no_section_door"] as const;
export type DaySectionState = (typeof DAY_SECTION_STATES)[number];

/** `PlanVault` plus the one door into a region of the owner's note. `section` is optional so a vault without it degrades to `no_section_door`, never a crash. */
export interface BriefVault extends PlanVault {
  write(
    path: string,
    content: Buffer,
    intent: { principal: string; message: string; group?: string | undefined; run?: string | undefined },
    expectedSha256?: string,
  ): Promise<{ path: string; sha256: string; bytes: number; created: boolean }>;
  /** `POST /vault/section` (the reconciler, T2-6). Throws the bridge's error — its `code` is the envelope's. */
  section?(
    path: string,
    marker: "day",
    body: string,
    principal: string,
    expectedOuterSha: string,
    act?: { run?: string | undefined },
  ): Promise<{ path: string; sha256: string; appended: boolean }>;
}

export interface BriefCtx extends PlanCtx {
  vault?: BriefVault | undefined;
  /** The resolved Scheduled config (manifest ⊕ `.metistry/scheduled.yaml`): `template`. Absent → the manifest's default. */
  config?: Record<string, unknown> | undefined;
}

/** The template setting, from the resolved config or the default. A wrong kind is refused, never coerced. */
export function briefConfig(config?: Record<string, unknown>): { template: string } {
  const template = config?.[TEMPLATE_KEY] ?? DEFAULT_TEMPLATE;
  if (typeof template !== "string" || template === "") {
    throw new Error(`${COMPONENT}: config.${TEMPLATE_KEY} is ${JSON.stringify(template)} — it must be a vault path (routines.morning-brief.config in .metistry/scheduled.yaml); nothing was written`);
  }
  return { template };
}

// --- text from outside ---------------------------------------------------------

/**
 * A calendar string made safe to put on ONE line of markdown this routine
 * writes: an invitation's title is someone else's text. No line breaks (a
 * title cannot add a line — a task, a heading — to the owner's note), no HTML
 * comment delimiters (it cannot forge a section or a prose marker), bounded.
 */
export function oneLine(value: unknown, max = MAX_EVENT_TEXT): string {
  const text = String(value ?? "")
    .replace(/<!--|-->/g, " ")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A meeting as the brief and the section show it — retrieved facts only. */
export interface Meeting {
  start: string;
  end: string;
  /** "9:30 AM–10:00 AM", in the day's zone. */
  when: string;
  title: string;
  location: string;
  attendees: string[];
}

function clock(iso: string, timeZone: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

/** Today's timed events, in start order and bounded — an all-day event has no "next up". */
export function meetingsOf(events: readonly CalendarEvent[], timeZone: string): Meeting[] {
  const out: Meeting[] = [];
  for (const e of events) {
    if (e.all_day === true || typeof e.start !== "string" || typeof e.end !== "string") continue;
    const from = clock(e.start, timeZone);
    const to = clock(e.end, timeZone);
    if (from === null || to === null) continue;
    const attendees = Array.isArray(e.attendees) ? e.attendees.map((a) => oneLine(a, 60)).filter(Boolean).slice(0, 6) : [];
    out.push({ start: e.start, end: e.end, when: `${from}–${to}`, title: oneLine(e.title) || "(untitled)", location: oneLine(String(e.location ?? "").split("\n")[0]), attendees });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_NEXT_UP);
}

const meetingLine = (m: Meeting): string =>
  `- ${m.when} · ${m.title}${m.location ? ` · ${m.location}` : ""}${m.attendees.length > 0 ? ` · with ${m.attendees.join(", ")}` : ""}`;

const NO_CALENDAR = "_No calendar — the eventkit bridge is not reachable._";
const NOTHING_TODAY = "_Nothing on your calendar today._";

/** The prompt one meeting's slot carries (bounded like a template's). */
export function nextUpPrompt(m: Meeting): string {
  const who = m.attendees.length > 0 ? ` with ${m.attendees.join(", ")}` : "";
  const prompt = `One line to prepare for "${m.title}" at ${m.when.split("–")[0]}${who}: what to bring, ask or follow up`;
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS - 1)}…` : prompt;
}

/**
 * The Next Up list: each timed meeting, and under it ONE pending prose slot,
 * numbered after the template's own. Returns the markdown and the slots.
 */
export function nextUpBlock(meetings: readonly Meeting[] | null, firstIndex: number, line: number): { markdown: string; requests: ProseRequest[] } {
  if (meetings === null) return { markdown: NO_CALENDAR, requests: [] };
  if (meetings.length === 0) return { markdown: NOTHING_TODAY, requests: [] };
  const requests: ProseRequest[] = [];
  const lines: string[] = [];
  meetings.forEach((m, i) => {
    const index = firstIndex + i;
    const marker = proseMarker(index);
    requests.push({ index, prompt: nextUpPrompt(m), using: null, marker, line });
    lines.push(meetingLine(m), `  - ${marker} ${PROSE_PENDING}`);
  });
  return { markdown: lines.join("\n"), requests };
}

/**
 * Put the Next Up block under the rendered file's `## Next Up` heading — or,
 * when the template has none, at the end with the heading, above the
 * provenance footer (which `renderTemplate` always writes as the last line).
 */
export function placeNextUp(markdown: string, block: string): string {
  const lines = markdown.split("\n");
  const at = lines.findIndex((l) => l.trim() === NEXT_UP_HEADING);
  if (at !== -1) {
    lines.splice(at + 1, 0, "", block);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const footer = markdown.lastIndexOf("\n<!-- rendered by ");
  const [head, tail] = footer === -1 ? [markdown.replace(/\n+$/, ""), "\n"] : [markdown.slice(0, footer).replace(/\n+$/, ""), markdown.slice(footer)];
  return `${head}\n\n${NEXT_UP_HEADING}\n\n${block}\n${tail}`;
}

// --- the daily note's section ---------------------------------------------------

export interface DaySectionInput {
  date: string;
  /** "7:00 AM" — each write stamps its time (screen 05 §15.5.1). */
  at: string;
  /** Whether `Journal/Plan/<date>.md` exists — embedded when it does, said when it does not. */
  plan: boolean;
  /** Today's meetings; null when the calendar could not be asked. */
  meetings: readonly Meeting[] | null;
}

/**
 * The section's whole body, model-free by construction: its inputs are a
 * date, a clock time, one existence bit and the calendar's rows (each already
 * `oneLine`d) — there is no parameter a model's words could arrive through.
 * The standup is embedded, never copied (§2.5): at 7:00 it does not exist
 * yet, and the embed shows it the moment it lands at 8:00.
 */
export function daySectionBody(input: DaySectionInput): string {
  const { date } = input;
  const meetings = input.meetings === null ? [NO_CALENDAR] : input.meetings.length === 0 ? [NOTHING_TODAY] : input.meetings.map(meetingLine);
  return [
    `_Morning Brief · ${input.at} · [[${briefPath(date).replace(/\.md$/, "")}|the brief]]_`,
    "",
    "### Plan",
    "",
    input.plan ? `![[Journal/Plan/${date}]]` : "_No plan was written for today._",
    "",
    "### Meetings",
    "",
    ...meetings,
    "",
    "### Standup",
    "",
    `![[Journal/Standup/${date}]]`,
    "",
  ].join("\n");
}

const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** One `note` request per broken note (deduped while one is pending) — C102: broken markers stop the write and raise a request, never a guess. */
async function raiseSectionMissing(db: Db, path: string, date: string, reason: SectionMissingReason, line: number | null, body: string): Promise<void> {
  const message = sectionMissingMessage(path, "day", reason, line);
  const payload = {
    title: `Today's section in ${path} could not be found`,
    summary:
      `${message} The Morning Brief wrote nothing into the note — Metistry never guesses where your text ends — and the brief itself is in ${briefPath(date)}. ` +
      `Put the two markers back around the section (or delete both, and the heading \`${NOTE_SECTIONS.day.heading}\`, to have it added at the end).`,
    refs: [path, briefPath(date)],
    preview: body,
    day_section: { day: date, path, reason, at_line: line },
  };
  // One while it waits: a routine runs once a morning, so a read before the
  // insert is the whole dedupe (no second writer races it).
  const open = await db.query(
    `SELECT 1 FROM proposals WHERE kind = 'knowledge' AND decision = 'pending' AND source_agent = $1 AND payload->'day_section'->>'path' = $2 LIMIT 1`,
    [COMPONENT, path],
  );
  if (open.rows.length > 0) return;
  await db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', $1, 'internal', $2)`, [COMPONENT, JSON.stringify(payload)]);
}

/**
 * Write the section, or say why not. Reads the note, computes the outer hash
 * core's grammar computes (`scanNoteSection`), and hands the body to the
 * section door with it — the reconciler checks the same hash and refuses an
 * owner's edit that lands in between (`conflict`), which is retried ONCE from
 * a fresh read and then left alone.
 */
export async function writeDaySection(db: Db, vault: BriefVault, date: string, body: string, runId?: number): Promise<{ state: DaySectionState; reason?: SectionMissingReason }> {
  if (typeof vault.section !== "function") return { state: "no_section_door" };
  const path = dailyNotePath(date);
  for (let attempt = 0; attempt < 2; attempt++) {
    const note = await vault.read(path);
    if (note === null) return { state: "no_daily_note" };
    const scan = scanNoteSection(note.content, "day");
    if (scan.state === "missing") {
      await raiseSectionMissing(db, path, date, scan.reason, scan.line, body);
      return { state: "section_missing", reason: scan.reason };
    }
    try {
      await vault.section(path, "day", body, PRINCIPAL, scan.outerSha256, runId !== undefined ? { run: String(runId) } : {});
      return { state: "written" };
    } catch (err) {
      const code = codeOf(err);
      if (code === "not_found") return { state: "no_daily_note" };
      if (code === "conflict") continue; // the owner typed in between: read again, once
      if (code === "section_missing") {
        // the note changed shape between the read and the write; the next read names why
        continue;
      }
      throw err;
    }
  }
  return { state: "conflict" };
}

// --- bookkeeping ---------------------------------------------------------------

/** Has a pass already written this date's brief? Only a write settles a date; a skip is recorded and the next run tries again. `meta.brief_for` is the discriminator — the runner's own row carries none. */
async function written(db: Db, date: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM runs
     WHERE component = $1 AND kind = 'routine_run' AND ok AND meta->>'brief_for' = $2 AND meta->>'outcome' = 'acted'
     LIMIT 1`,
    [COMPONENT, date],
  );
  return rows.length > 0;
}

async function record(db: Db, date: string, reason: "wrote" | BriefSkip, meta: Record<string, unknown> = {}): Promise<void> {
  const outcome = reason === "wrote" ? "acted" : `skipped:${reason}`;
  await db.query(
    `INSERT INTO runs (component, kind, ok, started_at, finished_at, meta)
     VALUES ($1, 'routine_run', true, now(), now(), $2)`,
    [COMPONENT, JSON.stringify({ brief_for: date, outcome, ...meta })],
  );
}

/**
 * One `report` request per template the brief could not use — missing (W2
 * checkpoint D1: an upgraded vault never got `Templates/Brief.md`, and the
 * routine skipped every morning with nobody told) or unreadable (§6.4) —
 * deduped per template path while one is pending: a routine runs once a
 * morning, so a read before the insert is the whole dedupe, and the owner is
 * asked once, not every day.
 */
async function reportTemplate(db: Db, template: string, date: string, reason: typeof TEMPLATE_MISSING | typeof TEMPLATE_UNREADABLE, maxBytes: number): Promise<void> {
  const open = await db.query(
    `SELECT 1 FROM proposals WHERE kind = 'report' AND decision = 'pending' AND source_agent = $1 AND payload->'template_issue'->>'path' = $2 LIMIT 1`,
    [COMPONENT, template],
  );
  if (open.rows.length > 0) return;
  const payload =
    reason === TEMPLATE_MISSING
      ? {
          title: `${template} is not in the vault — no Morning Brief for ${date}`,
          summary: `The brief is written from ${template}, and there is no such file, so nothing was written. \`metistry update\` re-seeds the templates a vault lacks (it never touches one you have), or write your own ${template}.`,
        }
      : {
          title: `${template} could not be read — no Morning Brief for ${date}`,
          summary: `The template is not readable text, or is larger than METISTRY_TEMPLATE_MAX_BYTES (${maxBytes} bytes). Nothing was written. Open it in Obsidian, or run \`metistry templates check\`.`,
        };
  await db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', $2)`, [
    COMPONENT,
    JSON.stringify({ ...payload, refs: [template], template_issue: { path: template, reason } }),
  ]);
}

function knownZone(tz: string | undefined): string | undefined {
  if (tz === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** A calendar asked once per day however many directives and lists ask it — the template's `{{ calendar }}` and the Next Up list see the same rows. */
function onceADay(calendar: CalendarProvider | null): CalendarProvider | null {
  if (calendar === null) return null;
  const asked = new Map<string, Promise<CalendarEvent[]>>();
  return {
    events(day: string): Promise<CalendarEvent[]> {
      let p = asked.get(day);
      if (p === undefined) {
        p = calendar.events(day);
        asked.set(day, p);
      }
      return p;
    },
  };
}

export interface BriefFileResult {
  date: string;
  path: string;
  /** True only when this pass wrote the file. */
  wrote: boolean;
  /** True when today's file is there to link — written now, or by an earlier run this morning. */
  exists: boolean;
}

/**
 * The file pass: the brief's own file, the daily note's section, and the one
 * turn. Returns what it did for the chat message to link, or null when there
 * is no vault to do it in.
 */
export async function briefFile(db: Db, ctx: BriefCtx = {}): Promise<BriefFileResult | null> {
  const vault = ctx.vault;
  if (!vault) return null;
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? new Date();
  const { template } = briefConfig(ctx.config);
  const readText = async (p: string): Promise<string | null> => (await vault.read(p))?.content.toString("utf8") ?? null;

  const facts = profileFacts(await readText(PROFILE_PATH));
  const timeZone = ctx.timeZone ?? knownZone(facts.timezone) ?? configuredTimeZone(env) ?? "UTC";
  const morning = ctx.scheduledFor ?? now;
  const date = calendarDate(morning, timeZone);
  const path = briefPath(date);
  const done = (wrote: boolean, exists = wrote): BriefFileResult => ({ date, path, wrote, exists });

  if (await written(db, date)) {
    console.log(`${COMPONENT}: ${path} is already written`);
    return done(false, true);
  }
  if (facts.working_days === undefined) {
    const why = `${PROFILE_PATH} does not say which days you work (\`working_days: [mon, tue, wed, thu, fri]\`) — Metistry discovers that from you and never assumes it, so no brief was written`;
    console.log(`${COMPONENT}: ${why}`);
    await record(db, date, "no_working_days", { why });
    return done(false);
  }

  const maxBytes = intEnv("METISTRY_TEMPLATE_MAX_BYTES", DEFAULT_TEMPLATE_MAX_BYTES, env);
  const templateText = await readText(template);
  const skip = templateSkip(templateText, maxBytes);
  if (skip !== null || templateText === null) {
    const reason = skip ?? TEMPLATE_MISSING;
    console.log(`${COMPONENT}: ${template} — ${reason}; no brief for ${date}`);
    await reportTemplate(db, template, date, reason, maxBytes);
    await record(db, date, reason, { template, max_bytes: maxBytes });
    return done(false);
  }

  const existing = await vault.read(path);
  const owner = existing === null ? null : sourceOf(existing.content.toString("utf8"));
  if (existing !== null && owner !== PRINCIPAL) {
    const why = `${path} says \`source: ${owner ?? "(none — yours)"}\`, not \`${PRINCIPAL}\` — one writer per file, and this one is not mine`;
    console.log(`${COMPONENT}: ${why}`);
    await record(db, date, "user_owned", { path, source: owner, why });
    return done(false);
  }

  // undefined = build one from the environment; null = the caller says there is none
  const calendar = onceADay(ctx.calendar === undefined ? eventkitCalendar(ctx, timeZone, now) : ctx.calendar);
  let meetings: Meeting[] | null = null;
  if (calendar !== null) {
    try {
      meetings = meetingsOf(await calendar.events(date), timeZone);
    } catch {
      meetings = null; // §6.4: the brief still goes out, and says the calendar could not be asked
    }
  }

  const render = await renderTemplate(templateText, {
    templatePath: template,
    source: PRINCIPAL,
    queries: ctx.queries ?? NO_QUERIES,
    calendar,
    reader: vaultReader(vault),
    ...(ctx.me !== undefined ? { me: ctx.me } : {}),
    now: morning,
    timeZone,
    env,
    renderedAt: now,
    maxBytes,
  });
  if (render.skipped !== undefined) {
    await record(db, date, render.skipped, { template });
    return done(false);
  }
  const nextUp = nextUpBlock(meetings, render.proseRequests.length + 1, render.markdown.split("\n").length);
  const markdown = placeNextUp(render.markdown, nextUp.markdown);
  if (refuseMaterialised(markdown)) {
    const why = `the render produced a task line with a minted \`^mt-\` anchor, which no routine may write (D4) — refusing to write ${path}`;
    console.warn(`${COMPONENT}: ${why}`);
    await record(db, date, "would_materialise", { path, why });
    return done(false);
  }

  const run = ctx.runId !== undefined ? String(ctx.runId) : undefined;
  const out = await vault.write(
    path,
    Buffer.from(markdown, "utf8"),
    { principal: PRINCIPAL, message: `morning brief for ${date}`, ...(run !== undefined ? { run } : {}) },
    existing?.sha256 ?? "",
  );

  // The section: model-free, the same act as the file (its run), and never
  // the reason the brief itself fails — a note the owner has not opened is
  // the ordinary 7:00 AM case.
  const plan = (await vault.read(`Journal/Plan/${date}.md`)) !== null;
  const at = clock(now.toISOString(), timeZone) ?? "";
  const body = daySectionBody({ date, at, plan, meetings });
  const section = await writeDaySection(db, vault, date, body, ctx.runId);

  // ONE turn for every slot the file has; none, and no model is asked.
  const requests = [...render.proseRequests, ...nextUp.requests];
  const inboundId = requests.length > 0 ? await enqueueProseTurn(db, { component: COMPONENT, path, date, requests }) : undefined;

  await record(db, date, "wrote", {
    path,
    bytes: out.bytes,
    created: out.created,
    template,
    day_section: section.state,
    ...(section.reason !== undefined ? { day_section_reason: section.reason } : {}),
    next_up: meetings === null ? null : meetings.length,
    prose_slots: requests.length,
    ...(inboundId !== undefined ? { inbound_id: inboundId } : {}),
    template_warnings: render.warnings.length,
    ...(render.warnings.length > 0 ? { warnings: render.warnings.map((w) => `${template}:${w.line} ${w.message}`) } : {}),
    truncated: render.truncated,
  });
  console.log(`${COMPONENT}: wrote ${path} (${out.bytes} bytes, ${requests.length} prose slot(s)); day section: ${section.state}`);
  return done(true);
}

/**
 * One brief pass: the file pass (when there is a vault), then the chat
 * message. Returns 1 if either wrote the file or sent the message, else 0 —
 * the runner turns that into `meta.outcome`: `acted` or `silent` (T1-4).
 */
export async function run(db: Db, ctx: BriefCtx = {}): Promise<number> {
  // auto-expiry first: un-acted items leave the queue but stay searchable.
  // A MIRROR never expires (K15, migration 0027): a row with a `source`
  // stands for something that lives elsewhere — a PR still waiting on the
  // owner's review is still owed on day 15 — and it leaves the queue only
  // when its source changes (`resolved_at_source`, packages/core/src/mirrors.ts).
  const expired = await db.query(
    `UPDATE proposals SET decision = 'expired', decided_at = now()
     WHERE decision = 'pending' AND source IS NULL AND ts < now() - make_interval(days => $1) RETURNING id`,
    [EXPIRE_DAYS],
  );

  const file = await briefFile(db, ctx);
  const sent = await message(db, ctx, expired.rows.length, file);
  return file?.wrote === true || sent ? 1 : 0;
}

/** The chat message — the brief as it always was, opening with the file when there is one (C97: the message links there). Silence-default: nothing needs the user, no message. */
async function message(db: Db, ctx: RoutineCtx, expiredCount: number, file: BriefFileResult | null): Promise<boolean> {
  const schedule = await sectionSchedule(ctx);
  const requests = await sectionRequests(db, expiredCount);
  const today = await sectionToday(db);
  const reviews = await sectionReviews(db);
  const areas = await sectionAreas(db);
  const system = await sectionSystem(db);

  // silence-default: emit only when something needs the user (a calendar
  // with events counts — the day needs planning)
  const hasEvents = !!schedule && !schedule[0]!.includes("nothing on the calendar");
  if (!requests && !today && !reviews && !hasEvents && !system?.needsHelp) return false;

  const parts: string[] = ["☀️ morning brief"];
  if (file?.exists) parts.push(`📄 ${file.path}`);
  if (schedule) parts.push("", "📅 Schedule:", ...schedule);
  if (today) parts.push("", "✅ Today:", ...today);
  if (reviews) parts.push("", "👀 Reviews waiting on you:", ...reviews);
  if (requests) parts.push("", "🔔 Needs you:", ...requests);
  if (areas) parts.push("", "📂 Areas:", ...areas);
  if (system) parts.push("", "⚙️ What I've been doing:", ...system.lines);
  if (!schedule) parts.push("", "📅 Schedule & meeting prep arrive once the calendar bridge is connected.");

  await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'brief')`, [parts.join("\n")]);
  return true;
}
