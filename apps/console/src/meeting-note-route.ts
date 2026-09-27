// The meeting-note door — `POST /api/meetings/:event_id/note` (design-build-plan
// §2.1, §2.11; ticket T2-11; today-hub-requests A2 and A3).
//
// The owner taps *Open notes* on a meeting and gets that meeting's note: the
// first time, a new note rendered from their own `Templates/Meeting.md` and
// written as `user` to `Journal/Meetings/<date>-<topic>.md`; every time after,
// the same note. A meeting note is the USER's file (daily-flow-spec §5.1, and
// `isUserOwnedPath` at the reconciler), so the tap is the authorship — the
// door writes nothing the owner did not ask for, and can write nothing else:
//
//   * **One note per `event_id`.** The note carries `event_id:` in its
//     frontmatter — the key the reconciler's walk reads into
//     `vault_meeting_refs` (T1-10) — and the door answers from that index
//     first (`calendar_event`'s `note`, where two notes claim one event the
//     shortest path, then byte order). The index is up to one walk behind the
//     vault, so the door does not trust its absence: calls for one event are
//     serialised in this process, the path it wrote is remembered until the
//     walk has it, the file name for an event is the same on every call (its
//     day and its title), a file already there is read and believed only when
//     its own frontmatter names this event, and the write is create-only
//     (`expected_sha256: ""`) — a note that appeared between the read and the
//     write is read again, never overwritten.
//   * **An event the calendar holds, or nothing.** The id must be a row of
//     `calendar_events` (the `calendar_event` query), so a made-up id cannot
//     put an arbitrary `event_id:` into the owner's notes, and its title and
//     day come from the calendar, never from the request — the body is `{}`.
//   * **Never the invite body.** Nothing here reads one: the calendar row has
//     no column for it (0034), and the note is the owner's template, rendered.
//     A meeting note is knowledge an agent may later read; an invite's dial-in
//     codes are not.
//   * **The owner's template, the owner's hand.** `Templates/Meeting.md` is
//     rendered by core's engine with `source: user` — its directives, its
//     frontmatter (with `tags: [template]` dropped and `event_id:` added), the
//     provenance footer every render carries — and the meeting's start is the
//     render's "now", so `{{ date }}` is the meeting's day. `{{ calendar }}`
//     reads `day_events`, the one read path into the calendar. No template,
//     no note: `404`, the file named.
//   * No model is anywhere in it, and it is not an action: `ACTION_KINDS` is
//     untouched, so no proposal can open a note at any autonomy level.
//
// Reached only by the `user` principal: server.ts's management gate runs
// first, so an agent bearer and the capture owner token get the uniform 403.

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_TEMPLATE_MAX_BYTES,
  TEMPLATE_MISSING,
  errorEnvelope,
  isVaultPath,
  renderTemplate,
  statusFor,
  taskToday,
  templateSkip,
  type CalendarEvent,
  type CalendarProvider,
  type ErrorCode,
} from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { readBody, sendJson } from "./http-util.js";

const MEETING_NOTE_ROUTE = /^POST \/api\/meetings\/([^/]+)\/note$/;

/** The named query that turns an id into the event and its note (seed/queries/calendar_event.yaml). */
export const CALENDAR_EVENT_QUERY = "calendar_event";
/** The named query `{{ calendar }}` reads a day through (seed/queries/day_events.yaml). */
export const DAY_EVENTS_QUERY = "day_events";
/** The owner's template (seeded by `metistry init`; theirs to edit). */
export const MEETING_TEMPLATE = "Templates/Meeting.md";
/** Where meeting notes live (daily-flow-spec §5.1): `Journal/Meetings/<date>-<topic>.md`. */
export const MEETINGS_DIR = "Journal/Meetings";

/** apps/reconciler/src/notes.ts `EVENT_ID_MAX`: an id the walk would refuse is one this door will not write. */
const EVENT_ID_MAX = 1024; // limit: fixed — longer than any calendar's event id; refused, never cut to fit
const TOPIC_MAX = 60; // limit: fixed — a file name a person reads in Obsidian's sidebar, not the title in full
/** Candidates after the first (`…-2.md` … `…-20.md`) when a file of the same name is someone else's. */
const MAX_SUFFIX = 20; // limit: fixed — twenty same-titled meetings on one day that each have a note is past any calendar
/** How long the door remembers a path it wrote: the walk's interval, with room (METISTRY_RECONCILE_INTERVAL_SEC defaults to 300). */
const RECENT_TTL_MS = 60 * 60 * 1000; // limit: fixed — past an hour the walk has long since indexed the note
const RECENT_MAX = 500; // limit: fixed — notes opened in an hour, generously; the oldest goes first

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

interface Answer {
  status: number;
  body: unknown;
}

/** True when the request is for this door. Used by server.ts's management gate so a non-`user` credential gets the uniform 403. */
export function isMeetingNoteRoute(key: string): boolean {
  return MEETING_NOTE_ROUTE.test(key);
}

/**
 * What the door holds between calls, in the console's memory: one queue per
 * event (a second tap waits for the first rather than racing it into a second
 * file), and the paths it wrote that the walk may not have indexed yet.
 * Losing both on a restart costs nothing — by then the walk has the note, and
 * the file name and the note's own frontmatter answer anyway.
 */
export class MeetingNotes {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly recent = new Map<string, { path: string; at: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Run `act` after every earlier call for this event has finished. */
  async serial<T>(eventId: string, act: () => Promise<T>): Promise<T> {
    const before = this.queues.get(eventId) ?? Promise.resolve();
    const mine = before.then(act, act);
    const settled = mine.catch(() => undefined);
    this.queues.set(eventId, settled);
    try {
      return await mine;
    } finally {
      if (this.queues.get(eventId) === settled) this.queues.delete(eventId);
    }
  }

  remembered(eventId: string): string | null {
    const hit = this.recent.get(eventId);
    if (!hit) return null;
    if (this.clock() - hit.at > RECENT_TTL_MS) {
      this.recent.delete(eventId);
      return null;
    }
    return hit.path;
  }

  remember(eventId: string, path: string): void {
    this.recent.delete(eventId);
    this.recent.set(eventId, { path, at: this.clock() });
    while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value!);
  }
}

export interface MeetingNoteDeps {
  queries: QueryStore;
  /** The reconciler's bridge. Absent → `503`: this door writes a note, and a deployment with no bridge cannot. */
  vault?: VaultClient | undefined;
  audit: Audit;
  notes: MeetingNotes;
  /** The zone the meeting's day is read in: METISTRY_TZ, as the Tick door reads it. Injectable for tests. */
  timeZone?: string | undefined;
  /** The instant the provenance footer is stamped with. */
  now?: () => Date;
}

const fail = (code: ErrorCode, message: string): Answer => ({ status: statusFor(code), body: errorEnvelope(code, message) });

/**
 * The id as the walk would store it (apps/reconciler/src/notes.ts
 * `meetingEventId`): the whole string, no surrounding space, no control
 * character, within the bound. Anything else is not an id this door writes —
 * the note it made would link to nothing.
 */
export function validEventId(id: string): boolean {
  return id !== "" && id === id.trim() && id.length <= EVENT_ID_MAX && !/[\u0000-\u001f\u007f]/.test(id);
}

/** A title as a file name's topic: letters and digits of any script, lowercased, runs of anything else one `-`. */
export function meetingTopic(title: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const cut = [...slug].slice(0, TOPIC_MAX).join("").replace(/-+$/, "");
  return cut === "" ? "meeting" : cut;
}

/** The file names this event's note may take, in order: `<date>-<topic>.md`, then `-2` … `-20`. */
export function meetingNotePaths(day: string, title: string): string[] {
  const stem = `${MEETINGS_DIR}/${day}-${meetingTopic(title)}`;
  return [`${stem}.md`, ...Array.from({ length: MAX_SUFFIX - 1 }, (_, i) => `${stem}-${i + 2}.md`)];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The `event_id:` a note's own frontmatter names, as the walk reads it — or null. */
export function noteEventId(text: string): string | null {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return null;
  const v = (fm as Record<string, unknown>).event_id;
  const raw = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
  return raw !== null && validEventId(raw) ? raw : null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));

/** `{{ calendar }}` in a meeting template: that day, every source, through the one read path. */
function calendarFor(queries: QueryStore, timeZone: string): CalendarProvider {
  return {
    async events(day: string): Promise<CalendarEvent[]> {
      const { rows } = await queries.run(DAY_EVENTS_QUERY, { day, tz: timeZone });
      return rows.map((r) => ({
        title: String(r.title ?? ""),
        start: iso(r.start),
        end: iso(r.end),
        all_day: r.all_day === true,
        location: typeof r.location === "string" ? r.location : undefined,
      }));
    },
  };
}

export async function meetingNoteRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: MeetingNoteDeps): Promise<void> {
  const m = MEETING_NOTE_ROUTE.exec(key)!;
  let eventId: string;
  try {
    eventId = decodeURIComponent(m[1]!);
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "the event id is not valid percent-encoding"));
  }
  if (!validEventId(eventId)) return sendJson(res, 400, errorEnvelope("invalid_request", `an event id is the event's \`event_id\` exactly as GET /api/today returns it — at most ${EVENT_ID_MAX} characters, no surrounding space, no control characters`));

  try {
    const text = (await readBody(req)).toString("utf8");
    const raw: unknown = text.trim() === "" ? {} : JSON.parse(text); // no body is the same request as {}
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return sendJson(res, 400, errorEnvelope("invalid_request", "the body is {} — the event is named in the path"));
    const unknown = Object.keys(raw);
    if (unknown.length > 0) return sendJson(res, 400, errorEnvelope("invalid_request", `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — the body is {}: the note's title, day and template are the calendar's and the vault's, never the request's`));
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "request body is not JSON"));
  }

  const answer = await deps.notes.serial(eventId, () => open(eventId, deps));
  return sendJson(res, answer.status, answer.body);
}

async function open(eventId: string, deps: MeetingNoteDeps): Promise<Answer> {
  const audited = async (ok: boolean, outcome: string, answer: Answer): Promise<Answer> => {
    // the id and the outcome, never the title or the path: `runs` is read by
    // surfaces broader than this door, and who the owner meets is theirs
    await deps.audit("meeting_note", "open", ok, { event_id: eventId, outcome });
    return answer;
  };
  const found = (path: string): Answer => ({ status: 200, body: { ok: true, event_id: eventId, path, created: false } });

  if (!deps.vault) return fail("not_available", "opening a meeting note writes it, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)");
  const vault = deps.vault;

  const { rows } = await deps.queries.run(CALENDAR_EVENT_QUERY, { event_id: eventId });
  const event = rows[0];
  if (!event) return audited(false, "unknown_event", fail("not_found", "no calendar holds an event with this id — the calendar sync may not have read it yet; refresh Today"));

  // 1. the index's answer: the note the walk has seen for this event
  if (typeof event.note === "string" && event.note !== "") return audited(true, "existing", found(event.note));

  const readText = async (path: string): Promise<string | null> => (await vault.read(path))?.content.toString("utf8") ?? null;
  try {
    // 2. the note this door wrote that the walk has not indexed yet
    const recent = deps.notes.remembered(eventId);
    if (recent !== null) {
      const text = await readText(recent);
      if (text !== null && noteEventId(text) === eventId) return audited(true, "existing", found(recent));
    }

    // 3. make it: the owner's template, the meeting's day and title
    const template = await readText(MEETING_TEMPLATE);
    const skip = templateSkip(template, DEFAULT_TEMPLATE_MAX_BYTES);
    if (skip === TEMPLATE_MISSING) return audited(false, "template_missing", fail("not_found", `${MEETING_TEMPLATE} is not in the vault — a meeting note is rendered from it; restore it (\`metistry init\` seeds one) and try again`));
    if (skip !== null) return audited(false, "template_unreadable", fail("invalid_request", `${MEETING_TEMPLATE} is not a template this door can render (${skip}) — check it with \`metistry templates check\``));

    const start = new Date(iso(event.start));
    if (Number.isNaN(start.getTime())) return audited(false, "bad_event", fail("internal", "the calendar's row for this event has no readable start"));
    // the zone the Tick door reads a day in (core's `taskToday`): the one given, else METISTRY_TZ, else TZ, else UTC
    const zone = deps.timeZone || process.env.METISTRY_TZ || process.env.TZ || "UTC";
    const opts = { now: start, timeZone: zone };
    const day = taskToday(opts);
    const title = typeof event.title === "string" ? event.title : "";
    const rendered = await renderTemplate(template!, {
      templatePath: MEETING_TEMPLATE,
      source: "user",
      queries: deps.queries,
      calendar: calendarFor(deps.queries, zone),
      reader: { read: readText },
      frontmatter: { event_id: eventId },
      renderedAt: (deps.now ?? (() => new Date()))(),
      ...opts,
    });
    if (rendered.skipped) return audited(false, "template_unreadable", fail("invalid_request", `${MEETING_TEMPLATE} is not a template this door can render (${rendered.skipped})`));
    const content = Buffer.from(rendered.markdown, "utf8");
    const message = `open notes for "${title.replace(/\s+/g, " ").trim().slice(0, 120) || "a meeting"}"`;

    // 4. the first of this event's file names that is free — or already its note
    for (const path of meetingNotePaths(day, title)) {
      if (!isVaultPath(path)) return audited(false, "bad_path", fail("internal", "the meeting's file name is not a vault path"));
      for (let attempt = 0; attempt < 2; attempt++) {
        const there = await readText(path);
        if (there !== null) {
          if (noteEventId(there) === eventId) {
            deps.notes.remember(eventId, path);
            return audited(true, "existing", found(path));
          }
          break; // someone else's note by that name: the next name
        }
        try {
          await vault.write(path, content, { principal: "user", message }, ""); // create-only
        } catch (err) {
          if (err instanceof VaultError && err.code === "conflict") continue; // it appeared meanwhile: read it again
          throw err;
        }
        deps.notes.remember(eventId, path);
        return audited(true, "created", { status: 201, body: { ok: true, event_id: eventId, path, created: true } });
      }
    }
    return audited(false, "no_free_name", fail("invalid_request", `every file name this meeting's note could take in ${MEETINGS_DIR}/ is another note's — rename one of them and try again`));
  } catch (err) {
    if (err instanceof VaultError) return audited(false, err.code, fail(err.code, `the vault bridge refused: ${err.message}`));
    throw err;
  }
}
