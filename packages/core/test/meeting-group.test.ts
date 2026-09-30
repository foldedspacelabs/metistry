// A meeting's group and its jots' anchors (T8-7; C77, C81): the pure half the
// inbox drain and the console share.
import { describe, expect, it } from "vitest";
import { isTranscriptPath, jotAnchorOf, meetingGroupId, pickMeetingEvent, promoteJotAnchor, recordedSessionOf, sessionOfMeetingGroup } from "../src/index.js";

const SESSION = "20260928-120000-00ab";
const PATH = `Journal/Transcripts/2026-09-28-${SESSION}.md`;

const jot = (fields: Record<string, unknown>, body = "Kessler confirmed net-45") =>
  ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`), "---", body, ""].join("\n");

describe("the meeting group", () => {
  it("is a function of the session and nothing else, and reads back", () => {
    expect(meetingGroupId(SESSION)).toBe(`meeting:${SESSION}`);
    expect(sessionOfMeetingGroup(meetingGroupId(SESSION))).toBe(SESSION);
  });

  it("refuses what is not a recorder session id, and reads no other group as a meeting", () => {
    for (const bad of ["", "UPPER", "../x", "a/b", "a b", "x".repeat(65)]) expect(() => meetingGroupId(bad), bad).toThrow(TypeError);
    for (const other of [null, undefined, 7, "", "meeting:", "meeting:../x", "pr:owner/repo#1", `Meeting:${SESSION}`]) expect(sessionOfMeetingGroup(other), String(other)).toBeUndefined();
  });
});

describe("a recording's session, from its transcript's frontmatter", () => {
  const transcript = (extra: Record<string, unknown> = {}) =>
    jot({ kind: "transcript", title: "Recording 2026-09-28 13:00", capture_session: SESSION, started_at: "2026-09-28T12:00:00Z", ended_at: "2026-09-28T12:41:07Z", source: "live-capture", ...extra }, "[00:00:01] (apps) hello");

  it("reads the session, its times and the recorder's title", () => {
    expect(recordedSessionOf(transcript())).toEqual({ session: SESSION, startedAt: new Date("2026-09-28T12:00:00Z"), endedAt: new Date("2026-09-28T12:41:07Z"), title: "Recording 2026-09-28 13:00" });
    expect(recordedSessionOf(transcript({ ended_at: "" }))?.endedAt).toBeNull();
  });

  it("is nothing short of all four: kind, source, a session id and a start", () => {
    expect(recordedSessionOf(transcript({ kind: "note" }))).toBeUndefined();
    expect(recordedSessionOf(transcript({ source: "shortcut" }))).toBeUndefined();
    expect(recordedSessionOf(transcript({ capture_session: "../../Me/profile" }))).toBeUndefined();
    expect(recordedSessionOf(transcript({ started_at: "yesterday-ish" }))).toBeUndefined();
    expect(recordedSessionOf("no frontmatter")).toBeUndefined();
    expect(recordedSessionOf(null)).toBeUndefined();
  });
});

describe("a jot's anchor", () => {
  it("is (session, offset) while the meeting runs, and (transcript path, offset) once promoted", () => {
    expect(jotAnchorOf(jot({ kind: "jot", jot: "note", capture_session: SESSION, offset_s: 754 }))).toEqual({ state: "session", jot: "note", offsetS: 754, session: SESSION });
    expect(jotAnchorOf(jot({ kind: "jot", jot: "todo", source: `meeting:${PATH}`, offset_s: "754" }))).toEqual({ state: "promoted", jot: "todo", offsetS: 754, path: PATH });
  });

  it("is not a jot at all when any part is missing, both anchors are present, or the path is not a transcript", () => {
    const bad: Record<string, unknown>[] = [
      { kind: "note", jot: "note", capture_session: SESSION, offset_s: 1 },
      { kind: "jot", jot: "idea", capture_session: SESSION, offset_s: 1 },
      { kind: "jot", jot: "note", capture_session: SESSION },
      { kind: "jot", jot: "note", capture_session: SESSION, offset_s: -1 },
      { kind: "jot", jot: "note", capture_session: SESSION, offset_s: 86_401 },
      { kind: "jot", jot: "note", capture_session: SESSION, offset_s: 1.5 },
      { kind: "jot", jot: "note", capture_session: "Me/profile.md", offset_s: 1 },
      { kind: "jot", jot: "note", offset_s: 1 },
      { kind: "jot", jot: "note", capture_session: SESSION, source: `meeting:${PATH}`, offset_s: 1 },
      { kind: "jot", jot: "note", source: "meeting:Inbox/1-transcript.md", offset_s: 1 },
      { kind: "jot", jot: "note", source: "meeting:Journal/Transcripts/../../Me/profile.md", offset_s: 1 },
      { kind: "jot", jot: "note", source: `mail:${PATH}`, offset_s: 1 },
    ];
    for (const fields of bad) expect(jotAnchorOf(jot(fields)), JSON.stringify(fields)).toBeUndefined();
  });
});

describe("promoting a jot's anchor", () => {
  const running = jot({ kind: "jot", jot: "todo", capture_session: SESSION, offset_s: 754, mine: "kept" }, "Send Kessler the revised terms\n\nsecond line");

  it("rewrites exactly the session line to the transcript's path, and nothing else moves", () => {
    const r = promoteJotAnchor(running, SESSION, PATH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(running.replace(`capture_session: "${SESSION}"`, `source: "meeting:${PATH}"`));
    expect(jotAnchorOf(r.text)).toEqual({ state: "promoted", jot: "todo", offsetS: 754, path: PATH });
    // idempotent: promoting again is `already`, never a second edit
    expect(promoteJotAnchor(r.text, SESSION, PATH)).toEqual({ ok: false, why: "already" });
  });

  it("keeps CRLF line endings the owner's editor wrote", () => {
    const crlf = running.replaceAll("\n", "\r\n");
    const r = promoteJotAnchor(crlf, SESSION, PATH);
    expect(r.ok && r.text).toBe(crlf.replace(`capture_session: "${SESSION}"`, `source: "meeting:${PATH}"`));
  });

  it("refuses another session's jot, a path outside Journal/Transcripts/, and anything it cannot read back", () => {
    expect(promoteJotAnchor(running, "20260928-130000-00cd", PATH)).toEqual({ ok: false, why: "not_this_session" });
    expect(promoteJotAnchor(running, SESSION, "Inbox/1-transcript-x.md")).toEqual({ ok: false, why: "unreadable" });
    expect(promoteJotAnchor(running, SESSION, "Journal/Transcripts/a b.md")).toEqual({ ok: false, why: "unreadable" });
    expect(promoteJotAnchor("just words", SESSION, PATH)).toEqual({ ok: false, why: "unreadable" });
    const promotedElsewhere = jot({ kind: "jot", jot: "note", source: "meeting:Journal/Transcripts/other.md", offset_s: 3 });
    expect(promoteJotAnchor(promotedElsewhere, SESSION, PATH)).toEqual({ ok: false, why: "not_this_session" });
  });

  it("only a transcript path is a place to anchor", () => {
    expect(isTranscriptPath(PATH)).toBe(true);
    expect(isTranscriptPath("Journal/Transcripts/2026/x.md")).toBe(true);
    for (const p of ["Inbox/x.md", "Journal/Transcripts/", "Journal/Transcripts/.x.md", "Journal/Transcripts/x.txt", "Journal/TranscriptsOld/x.md", "Journal/Transcripts/../x.md", 'Journal/Transcripts/a"b.md', 7]) {
      expect(isTranscriptPath(p), String(p)).toBe(false);
    }
  });
});

describe("the calendar event a recording was of", () => {
  const ev = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ event_id: id, title: `t-${id}`, start, end, all_day: false, self_status: "accepted", note: null, ...extra });
  const s = new Date("2026-09-28T09:55:00Z");
  const e = new Date("2026-09-28T10:40:00Z");

  it("is the timed event it overlaps the most", () => {
    const rows = [ev("a", "2026-09-28T09:00:00Z", "2026-09-28T10:00:00Z"), ev("b", "2026-09-28T10:00:00Z", "2026-09-28T11:00:00Z")];
    expect(pickMeetingEvent(rows, s, e)).toEqual({ event_id: "b", title: "t-b", start: "2026-09-28T10:00:00.000Z", end: "2026-09-28T11:00:00.000Z", note: null });
  });

  it("never an all-day event, a declined one, or one it does not touch — then nothing", () => {
    const rows = [
      ev("allday", "2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z", { all_day: true }),
      ev("declined", "2026-09-28T10:00:00Z", "2026-09-28T11:00:00Z", { self_status: "declined" }),
      ev("later", "2026-09-28T11:00:00Z", "2026-09-28T12:00:00Z"),
    ];
    expect(pickMeetingEvent(rows, s, e)).toBeUndefined();
  });

  it("ties go to the nearest start, then the id's byte order — the same answer on every pass", () => {
    const rows = [ev("z", "2026-09-28T09:00:00Z", "2026-09-28T12:00:00Z"), ev("y", "2026-09-28T09:00:00Z", "2026-09-28T12:00:00Z"), ev("x", "2026-09-28T09:30:00Z", "2026-09-28T12:00:00Z")];
    expect(pickMeetingEvent(rows, s, e)?.event_id).toBe("x");
    expect(pickMeetingEvent(rows.slice(0, 2), s, e)?.event_id).toBe("y");
    expect(pickMeetingEvent([...rows.slice(0, 2)].reverse(), s, e)?.event_id).toBe("y");
  });

  it("a recording with no end is the instant it started", () => {
    const rows = [ev("a", "2026-09-28T09:00:00Z", "2026-09-28T10:00:00Z"), ev("b", "2026-09-28T10:00:00Z", "2026-09-28T11:00:00Z")];
    expect(pickMeetingEvent(rows, s, null)?.event_id).toBe("a");
  });
});
