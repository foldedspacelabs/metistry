// A meeting is one card, and the owner's jots find their place in it (plan
// §2.12, §3.3 T8-7; review-00 C77 and C81; screen 3 §10.3; screen 11 §2.1).
//
// Three facts, each a pure function here so the inbox drain (which raises the
// group) and the console (which promotes the anchors on Approve) cannot
// disagree about them:
//
//   * **One group per recording session.** A recording's rows — its
//     transcript today, the notes and to-dos drafted from it later — share
//     `proposals.group_id = meeting:<session id>` (migration 0027), and
//     Accept All answers them one `allow` per row, in order. The id is a
//     function of the session and nothing else, so whatever raises a row for
//     a session later lands on the same card without asking which one it is.
//   * **A jot is anchored to (session, offset) while the meeting runs.** A
//     Note or To-do the owner makes during a recording is a capture like any
//     other (`POST /capture`), saved the moment it is typed, and its
//     frontmatter says where in the recording it was made:
//
//       kind: "jot"
//       jot: "note"                                # or "todo"
//       capture_session: "20260928-120000-00ab"
//       offset_s: 754                              # seconds from Record
//
//     At that moment the only stable anchor is the session: the transcript
//     it will point into does not exist until the session ends (C77).
//   * **On Approve the anchor is promoted to the transcript's path.** The
//     owner's Approve of the meeting's transcript rewrites each of its jots'
//     `capture_session` line to `source: "meeting:<path>"` — the provenance
//     spelling the task index already reads (daily-flow-spec §1.3) — and
//     keeps `offset_s`, which is still where in that transcript the jot was
//     made. Transcripts live in `Journal/Transcripts/` (the owner's ruling on
//     W3 question 29), and an anchor points nowhere else: a transcript filed
//     anywhere else promotes nothing, and its jots keep their session
//     anchor, which still names it.
//
// No model is anywhere in this, and nothing here reads a transcript's words:
// only its frontmatter, which our own door writes.

import { TRANSCRIPTS_DIR } from "./instance-layout.js";
import { profileFrontmatter } from "./scheduled.js";
import { RECORDING_ID_RE } from "./transcripts.js";

/** The `group_id` prefix a meeting's rows share. */
export const MEETING_GROUP_PREFIX = "meeting:";

/** A recorder session id — T8-4's `RECORDING_ID_RE`, one definition: lowercase letters, digits, hyphens, never a path. */
export const CAPTURE_SESSION_RE = RECORDING_ID_RE;

/** Where transcripts live (Q29, ruled 2026-09-30; `TRANSCRIPTS_DIR`) — the only folder an anchor is promoted into. */
const TRANSCRIPT_FOLDER = `${TRANSCRIPTS_DIR}/`;

/** The frontmatter `kind:` of a jot. */
export const JOT_KIND = "jot";
/** What a jot is: the bar's Note or its To-do (screen 11 §2.1). Closed. */
export const JOT_TYPES = ["note", "todo"] as const;
export type JotType = (typeof JOT_TYPES)[number];

/** The furthest a jot can sit from Record. */
const MAX_OFFSET_S = 86_400; // limit: fixed — the recorder stops itself at ten hours (C137); a day is past any recording, so a larger offset is a malformed jot, not a long one

/** `meeting:<session>` — the one card a session's rows are answered as. */
export function meetingGroupId(session: string): string {
  if (!CAPTURE_SESSION_RE.test(session)) throw new TypeError("meetingGroupId: not a recorder session id");
  return `${MEETING_GROUP_PREFIX}${session}`;
}

/** The session a meeting group names, or undefined for any other group (or none). */
export function sessionOfMeetingGroup(groupId: unknown): string | undefined {
  if (typeof groupId !== "string" || !groupId.startsWith(MEETING_GROUP_PREFIX)) return undefined;
  const session = groupId.slice(MEETING_GROUP_PREFIX.length);
  return CAPTURE_SESSION_RE.test(session) ? session : undefined;
}

/** True for a path an anchor may be promoted to: a Markdown file directly or deeper under `Journal/Transcripts/`. */
export function isTranscriptPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith(TRANSCRIPT_FOLDER) || !path.endsWith(".md")) return false;
  const rest = path.slice(TRANSCRIPT_FOLDER.length);
  return rest.length > 3 && rest.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith(".")) && !/[\s"\\]/.test(path);
}

/** `meeting:<path>` — a promoted jot's `source:`, in the task index's provenance spelling. */
export function meetingSource(path: string): string {
  return `meeting:${path}`;
}

/** What a recording's transcript capture says about its session, from its frontmatter. */
export interface RecordedSession {
  session: string;
  startedAt: Date;
  endedAt: Date | null;
  /** The recorder's own title (`Recording 2026-09-28 14:05`), or null. */
  title: string | null;
}

function instant(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The session a capture's frontmatter declares, or undefined when it is not a
 * recording's transcript: `kind: transcript`, `source: live-capture`, a
 * `capture_session` that is a recorder id and a `started_at` that is an
 * instant (packages/mcp-live-capture `renderTranscript`). Anything short of
 * all four is an ordinary capture.
 */
export function recordedSessionOf(note: string | null | undefined): RecordedSession | undefined {
  const fm = profileFrontmatter(note ?? null);
  if (!fm || fm.kind !== "transcript" || fm.source !== "live-capture") return undefined;
  const session = typeof fm.capture_session === "string" ? fm.capture_session : "";
  if (!CAPTURE_SESSION_RE.test(session)) return undefined;
  const startedAt = instant(fm.started_at);
  if (!startedAt) return undefined;
  const title = typeof fm.title === "string" && fm.title.trim() !== "" ? fm.title.trim().slice(0, 200) : null;
  return { session, startedAt, endedAt: instant(fm.ended_at), title };
}

/** Where a jot is anchored: in a running session, or — once its meeting was approved — in the transcript. */
export type JotAnchor =
  | { state: "session"; jot: JotType; offsetS: number; session: string }
  | { state: "promoted"; jot: JotType; offsetS: number; path: string };

function offsetOf(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_OFFSET_S ? n : undefined;
}

/**
 * A capture's jot anchor, or undefined when it is not a well-formed jot:
 * `kind: jot`, `jot` one of `JOT_TYPES`, an `offset_s`, and exactly one of a
 * `capture_session` (not yet promoted) or a `source: meeting:<transcript
 * path>` (promoted). A jot that names both, or neither, is not one.
 */
export function jotAnchorOf(note: string | null | undefined): JotAnchor | undefined {
  const fm = profileFrontmatter(note ?? null);
  if (!fm || fm.kind !== JOT_KIND) return undefined;
  const jot = (JOT_TYPES as readonly unknown[]).includes(fm.jot) ? (fm.jot as JotType) : undefined;
  const offsetS = offsetOf(fm.offset_s);
  if (!jot || offsetS === undefined) return undefined;
  const hasSession = fm.capture_session !== undefined;
  const source = typeof fm.source === "string" && fm.source.startsWith(MEETING_GROUP_PREFIX) ? fm.source.slice(MEETING_GROUP_PREFIX.length) : undefined;
  if (hasSession && fm.source === undefined) {
    const session = typeof fm.capture_session === "string" ? fm.capture_session : "";
    return CAPTURE_SESSION_RE.test(session) ? { state: "session", jot, offsetS, session } : undefined;
  }
  if (!hasSession && source !== undefined && isTranscriptPath(source)) return { state: "promoted", jot, offsetS, path: source };
  return undefined;
}

export type JotPromotion =
  | { ok: true; text: string }
  | { ok: false; why: "already" | "not_this_session" | "unreadable" };

const HEADER_RE = /^---(\r?\n)([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/;

/**
 * The jot's text with its session anchor promoted to `path`, or why not. The
 * edit is one line of the frontmatter — `capture_session: …` becomes
 * `source: "meeting:<path>"` — and nothing else in the file moves: not the
 * body, not `offset_s`, not a key the owner added. The result is parsed back
 * and must read as this jot promoted to this path, or the promotion is
 * refused (`unreadable`) rather than written.
 */
export function promoteJotAnchor(text: string, session: string, path: string): JotPromotion {
  if (!CAPTURE_SESSION_RE.test(session) || !isTranscriptPath(path)) return { ok: false, why: "unreadable" };
  const before = jotAnchorOf(text);
  if (!before) return { ok: false, why: "unreadable" };
  if (before.state === "promoted") return before.path === path ? { ok: false, why: "already" } : { ok: false, why: "not_this_session" };
  if (before.session !== session) return { ok: false, why: "not_this_session" };
  const m = HEADER_RE.exec(text);
  if (!m) return { ok: false, why: "unreadable" };
  const eol = m[1]!;
  const lines = m[2]!.split(/\r?\n/);
  const at = lines.flatMap((l, i) => (/^capture_session:/.test(l) ? [i] : []));
  if (at.length !== 1) return { ok: false, why: "unreadable" };
  lines[at[0]!] = `source: ${JSON.stringify(meetingSource(path))}`;
  const out = `---${eol}${lines.join(eol)}${eol}---${text.slice(m[0].length)}`;
  const after = jotAnchorOf(out);
  if (!after || after.state !== "promoted" || after.path !== path || after.offsetS !== before.offsetS || after.jot !== before.jot) return { ok: false, why: "unreadable" };
  return { ok: true, text: out };
}

/** A calendar row as `day_events` serves it — the fields the meeting is chosen by. */
export interface MeetingEventRow {
  event_id?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
  all_day?: unknown;
  self_status?: unknown;
  note?: unknown;
}

export interface MeetingEvent {
  event_id: string;
  title: string;
  start: string;
  end: string;
  /** The meeting note the calendar already knows for it (`vault_meeting_refs`), or null. */
  note: string | null;
}

/**
 * The calendar event a recording was of: the timed event, not declined, that
 * overlaps the recording the most — ties to the one that started nearest the
 * recording, then byte order of its id, so the choice never flips between
 * passes. A recording with no end yet (a crash the helper has not closed) is
 * the instant it started. No overlap, no event: the recording keeps its own
 * title rather than borrowing the nearest meeting's.
 */
export function pickMeetingEvent(rows: readonly MeetingEventRow[], startedAt: Date, endedAt: Date | null): MeetingEvent | undefined {
  const s = startedAt.getTime();
  const e = endedAt && endedAt.getTime() > s ? endedAt.getTime() : s;
  let best: { ev: MeetingEvent; overlap: number; distance: number } | undefined;
  for (const r of rows) {
    if (r.all_day === true || r.self_status === "declined") continue;
    const id = typeof r.event_id === "string" ? r.event_id : "";
    const start = instant(r.start);
    const end = instant(r.end);
    if (id === "" || !start || !end || end.getTime() <= start.getTime()) continue;
    const overlap = e > s ? Math.min(e, end.getTime()) - Math.max(s, start.getTime()) : s >= start.getTime() && s < end.getTime() ? 1 : 0;
    if (overlap <= 0) continue;
    const distance = Math.abs(start.getTime() - s);
    const ev: MeetingEvent = {
      event_id: id,
      title: typeof r.title === "string" && r.title.trim() !== "" ? r.title.trim().slice(0, 200) : "",
      start: start.toISOString(),
      end: end.toISOString(),
      note: typeof r.note === "string" && r.note !== "" ? r.note : null,
    };
    if (!best || overlap > best.overlap || (overlap === best.overlap && (distance < best.distance || (distance === best.distance && Buffer.compare(Buffer.from(id), Buffer.from(best.ev.event_id)) < 0)))) {
      best = { ev, overlap, distance };
    }
  }
  return best?.ev;
}
