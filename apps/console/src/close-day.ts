// Close the Day — `POST /api/today/close {day, line?}` (design-build-plan
// §2.11, §2.13; screen-05-today §15.5.1, rulings C101/C102; ticket T2-8).
//
// The owner closes the day from Today and two things happen, in order:
//
//   1. **The daily note's section is written, as `user`**, through the
//      reconciler's section operation (`POST /vault/section`) — the ONLY way
//      anything writes between `<!-- metistry:day -->` and
//      `<!-- /metistry:day -->`, and a door that cannot touch a byte outside
//      them. The section says what the day did: when it closed, what was
//      done, what moved and to when, and the owner's own line for tomorrow.
//      It is written whole, every close — closing again replaces it.
//   2. **`plan-tomorrow` is enqueued** with `closedDay` (the routine's close
//      shape, T3-7), so tomorrow's plan renders now rather than at 11:00 PM —
//      and renders again on a second close; the 11:00 PM run supersedes it.
//
// What this door is incapable of, which is the point of it:
//
//   * **It never guesses where the owner's text ends.** The note is read and
//     scanned with core's `scanNoteSection` — the grammar the bridge runs —
//     BEFORE anything is sent. Markers deleted, doubled, quoted in code:
//     nothing is written into the note, a `note` request in Needs You says
//     the section could not be found and why, and the close still completes
//     (the plan is still made). The answer is `409 section_missing` so no
//     client can show it as a success. One open request per note: closing
//     again with the markers still broken points at the same request.
//   * **It never creates the owner's note.** No `Journal/<day>.md` is `404`
//     (the template is the owner's to apply); the plan is still made.
//   * **It writes only facts, and no model is anywhere in it.** The body is
//     composed from one named query (`day_close`, invariant 3) and the
//     owner's own line — deterministic, the same inputs giving the same
//     bytes. Generated prose never enters the owner's note (§2.13).
//   * **It closes today, and only today.** `day` is the day the client drew;
//     a page left open past midnight is `409 stale`, never a close of a day
//     that has already gone.
//   * **The owner's hand only.** server.ts's management gate runs first, so
//     an agent bearer and the capture owner token get the uniform 403; and
//     it is not an action — `ACTION_KINDS` is untouched, so no proposal can
//     ask for a close at any autonomy level.

import type { IncomingMessage, ServerResponse } from "node:http";
import { calendarDate, errorEnvelope, scanNoteSection, sectionMissingMessage, statusFor, NOTE_SECTIONS, startRun, finishRun, type ErrorCode, type SectionMissingReason } from "@foldedspacelabs/metistry-core";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import type { Db } from "./auth-store.js";
import { readJson, sendJson } from "./http-util.js";
import type { ConsoleVaultClient, NoteSectionClient } from "./vault-client.js";

export const CLOSE_DAY_ROUTE = "POST /api/today/close";
/** The named query the section is composed from (seed/queries/day_close.yaml). */
export const DAY_CLOSE_QUERY = "day_close";
/** The routine a close enqueues. */
export const PLAN_ROUTINE = "plan-tomorrow";
/** Who the request raised for broken markers is from — the console, on the owner's behalf; never an agent. */
export const CLOSE_REQUEST_SOURCE = "console";

const FIELDS = ["day", "line"] as const;
const LINE_MAX = 500; // limit: fixed — "a line for tomorrow" is a sentence; a paragraph belongs in the note itself
const DAY_ROWS = 200; // limit: fixed — a day with more than this many ticks and deferrals is summarised by the counts, which are exact
const CONFLICT_RETRIES = 1; // limit: fixed — the owner typing outside the section mid-close: read once more, then say so

/** True when the request is for this module. Used by server.ts's management gate so a non-`user` credential gets the uniform 403. */
export function isCloseDayRoute(key: string): boolean {
  return key === CLOSE_DAY_ROUTE;
}

// --- the plan, enqueued ---------------------------------------------------------

/**
 * One routine, run on demand, one pass at a time. A close while a pass is
 * running does not start a second one beside it — it asks for ONE more pass
 * after the current one, however many closes arrive meanwhile, with the
 * latest close's argument, so the last close is always the one the plan
 * reflects and two passes never race the same file.
 */
export class RoutineTrigger<A = string> {
  private running: Promise<void> | null = null;
  private next: { arg: A } | null = null;

  constructor(
    readonly routine: string,
    private readonly pass: (arg: A) => Promise<void>,
  ) {}

  /** Queue a pass. Returns at once; the pass runs in the background and records its own `runs` row. */
  enqueue(arg: A): void {
    this.next = { arg };
    if (this.running) return;
    this.running = (async () => {
      while (this.next) {
        const { arg: now } = this.next;
        this.next = null;
        try {
          await this.pass(now);
        } catch (err) {
          // the pass records its own failure (closeTriggeredPass); this is the last line of defence, never a crash
          console.error(`${this.routine} (close): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when no pass is running or queued. For tests and shutdown; the route never waits on it. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}

/** A routine as the runner holds it: its name and its one entry point. */
export interface TriggerableRoutine {
  name: string;
  run(db: Db, ctx: Record<string, unknown>): Promise<number>;
}

/**
 * One close-triggered pass of `plan-tomorrow` for the day closed, recorded
 * as the runner records a scheduled one (runner.ts step 3): a two-phase
 * `routine_run` row with `meta.outcome` — plus `meta.trigger: "close"` and
 * `meta.closed_day`, so Activity and Scheduled's history can say what
 * started it. The routine is handed the same capabilities the runner hands
 * it (`ctx`) plus `closedDay` — the routine's own close shape (T3-7): it
 * renders the plan for the day after `closedDay` early, always, and its
 * 11:00 PM run supersedes that render.
 */
export function closeTriggeredPass(db: Db, routine: TriggerableRoutine, ctx: Record<string, unknown>): (closedDay: string) => Promise<void> {
  return async (closedDay) => {
    const id = await startRun(db, { component: routine.name, kind: "routine_run", meta: { trigger: "close", closed_day: closedDay } });
    try {
      const n = await routine.run(db, { ...ctx, closedDay });
      await finishRun(db, id, { ok: true, meta: { processed: n, outcome: n > 0 ? "acted" : "silent" } });
    } catch (err) {
      await finishRun(db, id, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// --- the door -------------------------------------------------------------------

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface CloseDayDeps {
  db: Db;
  queries: QueryStore;
  /** The reconciler's bridge, with its section operation. Absent (or without `section`) → `503`. */
  vault?: ConsoleVaultClient | undefined;
  audit: Audit;
  /** `plan-tomorrow`, enqueued with the day closed. Absent → the close still writes the section and says the plan was not enqueued. */
  plan?: RoutineTrigger<string> | undefined;
  /** The instant "today" and the stamp are taken from. Injectable for tests. */
  now?: (() => Date) | undefined;
  /** The zone the day is counted in — `METISTRY_TZ`, as the Tick door stamps `done <date>`. */
  timeZone?: string | undefined;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const fail = (code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Answer => ({ status: statusFor(code), body: { ...errorEnvelope(code, message), ...extra } });

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `2026-02-30` has the shape and is no day. */
function isCalendarDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The zone, as the Tick door resolves it (core `taskToday`): the configured one, then METISTRY_TZ, then TZ, then UTC. */
function zoneOf(configured: string | undefined): string {
  return configured || process.env.METISTRY_TZ || process.env.TZ || "UTC";
}

function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One row of `day_close`. */
interface DayRow {
  act: "done" | "moved";
  task_key: string;
  to_day: string | null;
  path: string | null;
  anchor: string | null;
  text: string | null;
}

/** What the section says, counted — the fold line's numbers ("6 done · 3 to tomorrow · 1 someday"). */
export interface DayCounts {
  done: number;
  /** Destination (`YYYY-MM-DD` or `someday`) → how many lines went there. */
  moved: Record<string, number>;
}

/** A line of the owner's text inside Metistry's section: never a marker, never a comment that could swallow the closer. */
function inert(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/\r?\n/g, " ");
}

/** `Journal/2026-09-28.md` → `[[Journal/2026-09-28]]`: where the line lives, as Obsidian links it. */
function linkTo(path: string | null): string {
  return path ? ` · [[${path.replace(/\.md$/, "")}]]` : "";
}

function clock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

/**
 * The section's body: deterministic markdown, facts only. Written whole on
 * every close. Never a checkbox line — the section reports on tasks, it does
 * not mint them, so the reconciler's walk finds no task in it.
 */
export function composeSection(rows: readonly DayRow[], line: string | null, closedAt: Date, timeZone: string): { body: string; counts: DayCounts } {
  const done = rows.filter((r) => r.act === "done" && r.text !== null);
  const moved = rows.filter((r) => r.act === "moved" && r.text !== null && r.to_day !== null);
  const counts: DayCounts = { done: done.length, moved: {} };
  for (const r of moved) counts.moved[r.to_day!] = (counts.moved[r.to_day!] ?? 0) + 1;

  const parts = [`${done.length} done`, ...(moved.length > 0 ? [`${moved.length} moved`] : [])];
  const out: string[] = [`Closed at ${clock(closedAt, timeZone)} · ${parts.join(" · ")}`];
  if (line !== null) out.push("", `**For tomorrow:** ${inert(line)}`);
  if (done.length > 0) out.push("", "### Done", ...done.map((r) => `- ${inert(r.text!)}${linkTo(r.path)}`));
  if (moved.length > 0) out.push("", "### Moved", ...moved.map((r) => `- ${inert(r.text!)} → ${r.to_day}${linkTo(r.path)}`));
  if (done.length === 0 && moved.length === 0) out.push("", "Nothing was ticked or moved today.");
  return { body: `${out.join("\n")}\n`, counts };
}

export async function closeDayRoute(req: IncomingMessage, res: ServerResponse, deps: CloseDayDeps): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJson(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sendJson(res, 400, errorEnvelope("invalid_request", "body must be a JSON object: {day, line?}"));
    body = raw as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "request body is not JSON"));
  }
  const unknown = Object.keys(body).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) return sendJson(res, 400, errorEnvelope("invalid_request", `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — the body is {day, line?}`));
  if (typeof body.day !== "string" || !ISO_DAY_RE.test(body.day) || !isCalendarDay(body.day)) return sendJson(res, 400, errorEnvelope("invalid_request", "day must be the day being closed, YYYY-MM-DD — the day Today was drawn for"));
  let line: string | null = null;
  if (body.line !== undefined && body.line !== null) {
    if (typeof body.line !== "string") return sendJson(res, 400, errorEnvelope("invalid_request", "line, when given, is the owner's line for tomorrow: one line of text"));
    if (/[\r\n]/.test(body.line)) return sendJson(res, 400, errorEnvelope("invalid_request", "line is one line — no line breaks"));
    const trimmed = body.line.trim();
    if (trimmed.length > LINE_MAX) return sendJson(res, 400, errorEnvelope("invalid_request", `line is at most ${LINE_MAX} characters`));
    line = trimmed === "" ? null : trimmed;
  }
  const answer = await close(body.day, line, deps);
  return sendJson(res, answer.status, answer.body);
}

async function close(day: string, line: string | null, deps: CloseDayDeps): Promise<Answer> {
  const audited = async (ok: boolean, outcome: string, answer: Answer, meta: Record<string, unknown> = {}): Promise<Answer> => {
    // the day and the outcome, never the line or a task's text: `runs` is read by surfaces broader than this door
    await deps.audit("today", "close", ok, { day, outcome, line: line !== null, ...meta });
    return answer;
  };

  const vault = deps.vault;
  if (!vault || typeof vault.section !== "function") {
    return fail("not_available", "Close the Day writes the daily note's section through the vault bridge, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)");
  }
  const section = vault.section.bind(vault) as NoteSectionClient["section"];

  const timeZone = zoneOf(deps.timeZone);
  if (!knownZone(timeZone)) return fail("not_available", `the console's zone ${JSON.stringify(timeZone)} is not one this runtime knows — set METISTRY_TZ to an IANA zone (e.g. America/New_York)`);
  const now = (deps.now ?? (() => new Date()))();
  const today = calendarDate(now, timeZone);
  if (day !== today) {
    return audited(false, "stale", fail("conflict", `Close the Day closes today — ${today} in ${timeZone}. This page was drawn for ${day}; refresh Today and close again`, { reason: "stale", today }));
  }

  const path = `Journal/${day}.md`;
  const plan = () => {
    if (!deps.plan) return { enqueued: false, routine: PLAN_ROUTINE, reason: `${PLAN_ROUTINE} is not loaded in this console, so tomorrow's plan renders at its scheduled time` };
    deps.plan.enqueue(day);
    return { enqueued: true, routine: PLAN_ROUTINE };
  };

  const { rows } = await deps.queries.run(DAY_CLOSE_QUERY, { day, tz: timeZone, limit: DAY_ROWS });
  const { body, counts } = composeSection(rows as unknown as DayRow[], line, now, timeZone);

  for (let attempt = 0; ; attempt++) {
    let file;
    try {
      file = await vault.read(path);
    } catch (err) {
      if (err instanceof VaultError) return audited(false, err.code, fail(err.code, `the vault bridge refused to read ${path}: ${err.message}`));
      throw err;
    }
    if (!file) {
      return audited(false, "no_note", fail("not_found", `${path} does not exist — Close the Day writes into the day's note and never creates it (apply Templates/Daily.md in Obsidian, then close again). Tomorrow's plan was still made`, { day, path, plan: plan() }));
    }

    const scan = scanNoteSection(file.content, "day");
    if (scan.state === "missing") return missing(day, path, scan.reason, scan.line, body, deps, plan, audited);

    try {
      const written = await section(path, "day", body, "user", scan.outerSha256);
      return audited(true, "closed", {
        status: 200,
        body: { ok: true, day, path, appended: written.appended, closed_at: now.toISOString(), done: counts.done, moved: counts.moved, line, plan: plan() },
      }, { appended: written.appended, done: counts.done, moved: Object.values(counts.moved).reduce((a, b) => a + b, 0) });
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      if (err.code === "conflict" && attempt < CONFLICT_RETRIES) continue; // the owner typed outside the section between the read and the write: read again
      if (err.code === "conflict") return audited(false, "stale", fail("conflict", `${path} kept changing outside its section while the day was being closed — nothing was written; close again`, { reason: "stale" }));
      if (err.code === "section_missing") {
        // the markers broke between the scan and the write: scan again for the reason the owner reads
        const again = await vault.read(path).catch(() => null);
        const rescan = again ? scanNoteSection(again.content, "day") : null;
        return missing(day, path, rescan?.state === "missing" ? rescan.reason : "unpaired", rescan?.state === "missing" ? rescan.line : null, body, deps, plan, audited);
      }
      if (err.code === "not_found") return audited(false, "no_note", fail("not_found", `${path} does not exist — Close the Day never creates the day's note. Tomorrow's plan was still made`, { day, path, plan: plan() }));
      return audited(false, err.code, fail(err.code, `the vault bridge refused the section write: ${err.message}`));
    }
  }
}

/**
 * The markers are not there to write between: nothing is written into the
 * note, one `note` request says why (brought up to date while it is still
 * open, so a second close does not stack a second card), and the close completes — the
 * plan is enqueued. `409 section_missing` so a client can never render it as
 * a success; the request's id is in the body so it can show the request.
 */
async function missing(
  day: string,
  path: string,
  reason: SectionMissingReason,
  atLine: number | null,
  body: string,
  deps: CloseDayDeps,
  plan: () => Record<string, unknown>,
  audited: (ok: boolean, outcome: string, answer: Answer, meta?: Record<string, unknown>) => Promise<Answer>,
): Promise<Answer> {
  const message = sectionMissingMessage(path, "day", reason, atLine);
  const spec = NOTE_SECTIONS.day;
  const payload = {
    title: `Today's section in ${path} could not be found`,
    summary:
      `${message} Close the Day wrote nothing into the note — Metistry never guesses where your text ends — and tomorrow's plan was still made. ` +
      `Put the two markers back around the section (or delete both, and the heading \`${spec.heading}\`, to have it added at the end), then close the day again.`,
    refs: [path],
    preview: body,
    close_day: { day, path, reason, at_line: atLine },
  };
  // The open request for this note, if there is one, is brought up to date
  // (the preview is what THIS close would have written); otherwise one is raised.
  const refreshed = await deps.db.query(
    `UPDATE proposals SET payload = $2::jsonb
     WHERE kind = 'knowledge' AND decision = 'pending' AND source_agent = $1 AND payload->'close_day'->>'path' = $3
     RETURNING id`,
    [CLOSE_REQUEST_SOURCE, JSON.stringify(payload), path],
  );
  const raised = refreshed.rows.length === 0;
  const rows = raised
    ? (await deps.db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', $1, 'internal', $2::jsonb) RETURNING id`, [CLOSE_REQUEST_SOURCE, JSON.stringify(payload)])).rows
    : refreshed.rows;
  const requestId = Number(rows[0]?.id);
  const answer = fail("section_missing", message, { reason, at_line: atLine, day, path, request_id: requestId, plan: plan() });
  return audited(false, "section_missing", answer, { reason, request_id: requestId, raised });
}
