// The `ics` provider (plan §2.6; T4-12): a `calendar` connection type whose
// implementation is this module — an iCalendar subscription feed (RFC 5545),
// read-only by construction, because a subscription has no way back.
//
// What it does, in three pure pieces and one read:
//
//   * **`parseIcs`** — content lines to components: unfolded, parameters
//     split with their quoting honoured, text unescaped. Nested components
//     keep their own properties, so a VALARM's DESCRIPTION is never read as
//     its event's.
//   * **Zones** — every instant is resolved the way the feed says: `…Z` is
//     UTC; a `TZID` is an IANA zone when this runtime knows it, else the
//     feed's own VTIMEZONE rules (Outlook's "Pacific Standard Time"), else
//     the calendar's zone; a floating time is the calendar's zone
//     (`X-WR-TIMEZONE`), else the owner's; and an all-day date is the
//     owner's day, midnight to midnight — a date has no zone (RFC 5545
//     §3.3.4), and the owner's day is the one Today counts. A wall time a DST
//     change skips moves forward by the gap; one it repeats is the earlier.
//   * **Recurrence** — `RRULE` (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL,
//     COUNT, UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, BYSETPOS, WKST),
//     `RDATE`, `EXDATE`, and `RECURRENCE-ID` overrides, expanded in the
//     event's own wall clock so a 09:00 standup stays at 09:00 across DST. A
//     rule this module does not expand (BYYEARDAY, BYWEEKNO, BYHOUR…, an
//     HOURLY or finer FREQ) is not guessed at: the series is skipped and
//     counted, and the sync says how many.
//   * **`readIcsFeed`** — one GET of the connection's URL through the fetch
//     the sync opened (`sync.ts`): pinned to the connection's own origin,
//     through the egress door, no redirect followed. https only; the body is
//     capped; a body that is not a VCALENDAR is refused.
//
// **An occurrence is keyed as EventKit keys one** (packages/mcp-eventkit
// `eventKey`, the shape Google uses for its instance ids): a one-off event's
// key is its UID; a recurring one's is the UID plus its ORIGINAL start —
// `<uid>_20260928T133000Z`, or `<uid>_20260928` all-day — which stays put
// when that one occurrence is moved, so its meeting note stays with it.
//
// **Never the invite body.** `DESCRIPTION`, `ATTACH`, `COMMENT`, `URL` and
// everything else not named below are never read: an occurrence is built
// from named fields only (`IcsOccurrence`), so a body cannot reach
// `calendar_events` through here — and that table has no column for one.
//
// **The feed address is a secret when it carries a token** (Google's secret
// address, a published iCloud calendar, `?token=`): such a URL is refused at
// the connection file (`load.ts`: a key-shaped value is never written there),
// and a `{{ secret.x }}` in a URL is refused both there and at the egress
// door (`secret_in_url`). So only a feed whose address is public is read in
// this release — the plan's "a secret URL" needs a ruling on how a secret
// that IS a URL reaches the wire (T4-12's PR says so).
//
// Pure over a `fetch`: no Postgres, no vault (the dependency arrow). The sync
// that writes `calendar_events` is `collectors/ics-calendar/`.

import type { SyncHttp } from "./sync.js";

/** The builtin module name an `ics` connection type's `implementation` names. */
export const ICS_MODULE = "ics";
/** The sync (collector unit) that reads ICS connections. */
export const ICS_SYNC = "ics-calendar";

/** The largest feed read. A year of a busy work calendar is well under 2 MB. */
export const ICS_MAX_BYTES = 10 * 1024 * 1024; // limit: fixed — past this a "calendar" is something else, and is refused rather than parsed
const ICS_TIMEOUT_MS = 30_000; // limit: fixed — one GET of a static file; past this the server is wedged, and the run says so
/** Periods a single rule may walk before it is abandoned as runaway (a rule that never matches, e.g. BYMONTHDAY=30 in February only). */
const MAX_PERIODS = 50_000; // limit: fixed — a daily rule from 1900 to the window is ~46,000 periods, and one without COUNT is fast-forwarded

/** Why a feed was not read. A closed set: each is a code path with a test (U3). */
export const ICS_ERROR_CODES = ["not_https", "http_status", "too_large", "not_calendar"] as const;
export type IcsErrorCode = (typeof ICS_ERROR_CODES)[number];

/** A refusal reading a feed. Names the connection and the reason — never the URL's path or query, which is where a token would be. */
export class IcsError extends Error {
  override readonly name = "IcsError";
  constructor(
    readonly code: IcsErrorCode,
    message: string,
  ) {
    super(`ics (${code}): ${message}`);
  }
}

// ---- content lines --------------------------------------------------------------

/** One content line: `NAME;PARAM=a,b:value`. Names and parameter names are uppercased; values are as written. */
export interface IcsProperty {
  name: string;
  params: Readonly<Record<string, readonly string[]>>;
  value: string;
}

/** A `BEGIN:X` … `END:X` block and what it holds. */
export interface IcsComponent {
  name: string;
  props: IcsProperty[];
  children: IcsComponent[];
}

function parseLine(line: string): IcsProperty | null {
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ";" && line[i] !== ":") i++;
  if (i >= n) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  if (name === "") return null;
  const params: Record<string, string[]> = {};
  while (i < n && line[i] === ";") {
    i++;
    const eq = line.indexOf("=", i);
    if (eq < 0) return null;
    const pname = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    const values: string[] = [];
    for (;;) {
      let v = "";
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        v = line.slice(i + 1, close);
        i = close + 1;
      } else {
        const start = i;
        while (i < n && line[i] !== "," && line[i] !== ";" && line[i] !== ":") i++;
        v = line.slice(start, i);
      }
      values.push(v);
      if (line[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    params[pname] = values;
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

/**
 * Parse an iCalendar text into its root component (the first VCALENDAR).
 * Tolerant, as every calendar client is: a line it cannot read is skipped,
 * an unclosed component is closed at the end. Returns null when there is no
 * VCALENDAR at all.
 */
export function parseIcs(text: string): IcsComponent | null {
  const unfolded = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
  const root: IcsComponent = { name: "", props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const raw of unfolded.split("\n")) {
    if (raw.trim() === "") continue;
    const p = parseLine(raw);
    if (!p) continue;
    const top = stack[stack.length - 1]!;
    if (p.name === "BEGIN") {
      const c: IcsComponent = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      const want = p.value.trim().toUpperCase();
      const at = stack.map((c) => c.name).lastIndexOf(want);
      if (at > 0) stack.length = at;
    } else {
      top.props.push(p);
    }
  }
  return root.children.find((c) => c.name === "VCALENDAR") ?? null;
}

/** RFC 5545 §3.3.11: `\n` `\,` `\;` `\\`. */
export function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const prop = (c: IcsComponent, name: string): IcsProperty | undefined => c.props.find((p) => p.name === name);
const props = (c: IcsComponent, name: string): IcsProperty[] => c.props.filter((p) => p.name === name);
const param = (p: IcsProperty, name: string): string | undefined => p.params[name]?.[0];

// ---- wall clocks and zones ------------------------------------------------------

const DAY = 86_400_000;

/**
 * A time as the feed writes it. `wall` is the wall-clock reading as if it
 * were UTC milliseconds — arithmetic on it is calendar arithmetic, and only
 * `Zones.instant` turns it into a real instant.
 */
export interface IcsTime {
  wall: number;
  /** a DATE (all-day) value */
  date: boolean;
  /** a `…Z` value — its wall IS the instant */
  utc: boolean;
  /** the TZID parameter, when there is one */
  tzid: string | null;
}

const TIME_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

function parseTimeValue(value: string, tzid: string | null, forceDate: boolean): IcsTime | null {
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const date = hh === undefined || forceDate;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), date ? 0 : Number(hh), date ? 0 : Number(mi), date ? 0 : Number(ss));
  if (Number.isNaN(wall)) return null;
  return { wall, date, utc: !date && z === "Z", tzid: !date && z !== "Z" ? tzid : null };
}

/** A DATE or DATE-TIME property (DTSTART, DTEND, RECURRENCE-ID, UNTIL…), or null when it is not one. */
export function timeOf(p: IcsProperty | undefined): IcsTime | null {
  if (!p) return null;
  return parseTimeValue(p.value, param(p, "TZID") ?? null, param(p, "VALUE")?.toUpperCase() === "DATE");
}

/** Every value of a list property (EXDATE, RDATE), each carrying the property's TZID. */
function timesOf(ps: IcsProperty[]): IcsTime[] {
  const out: IcsTime[] = [];
  for (const p of ps) {
    if (param(p, "VALUE")?.toUpperCase() === "PERIOD") continue;
    for (const v of p.value.split(",")) {
      const t = parseTimeValue(v, param(p, "TZID") ?? null, param(p, "VALUE")?.toUpperCase() === "DATE");
      if (t) out.push(t);
    }
  }
  return out;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Whether this runtime knows `zone` as an IANA zone (or UTC). */
export function knownZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `instant`'s offset from UTC in `zone`, in ms — the wall reading minus the instant. */
function ianaOffset(zone: string, instant: number): number {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(zone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(instant))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * A wall reading to an instant, given the zone's offset at any instant.
 * Temporal's "compatible" choice: a reading a DST change repeats is the
 * earlier instant; one it skips is moved forward by the gap.
 */
function wallToInstant(wall: number, offsetAt: (instant: number) => number): number {
  const before = offsetAt(wall - DAY);
  const after = offsetAt(wall + DAY);
  const valid = [before, after].map((o) => wall - o).filter((t) => offsetAt(t) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  return wall - before;
}

/** The instant local midnight starts `wall`'s day in `zone` (an IANA zone, or UTC). */
export function zonedMidnight(wall: number, zone: string): number {
  const day = Math.floor(wall / DAY) * DAY;
  return wallToInstant(day, (t) => ianaOffset(zone, t));
}

/** Today's date in `zone`, as a wall at midnight. */
export function zonedToday(now: number, zone: string): number {
  return Math.floor((now + ianaOffset(zone, now)) / DAY) * DAY;
}

interface Observance {
  start: number; // wall, in the `from` offset
  from: number; // ms
  to: number; // ms
  rule: Rule | null;
  rdates: number[];
}

function parseOffset(v: string | undefined): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((v ?? "").trim());
  if (!m) return null;
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/** A VTIMEZONE's rules as an offset function. Null when it has no usable observance. */
function vtimezoneOffset(tz: IcsComponent): ((instant: number) => number) | null {
  const obs: Observance[] = [];
  for (const c of tz.children) {
    if (c.name !== "STANDARD" && c.name !== "DAYLIGHT") continue;
    const start = timeOf(prop(c, "DTSTART"));
    const from = parseOffset(prop(c, "TZOFFSETFROM")?.value);
    const to = parseOffset(prop(c, "TZOFFSETTO")?.value);
    if (!start || from === null || to === null) continue;
    const rr = prop(c, "RRULE");
    obs.push({ start: start.wall, from, to, rule: rr ? parseRule(rr.value) : null, rdates: timesOf(props(c, "RDATE")).map((t) => t.wall) });
  }
  if (obs.length === 0) return null;
  const earliest = obs.reduce((a, b) => (b.start < a.start ? b : a));
  const cache = new Map<number, { at: number; to: number }[]>();
  const onsets = (year: number): { at: number; to: number }[] => {
    let list = cache.get(year);
    if (list) return list;
    list = [];
    const limit = Date.UTC(year + 2, 0, 1);
    for (const o of obs) {
      const walls = new Set<number>([o.start, ...o.rdates]);
      if (o.rule && o.rule.supported) {
        const until = o.rule.until;
        for (const w of expandRule(o.rule, o.start, false, limit, (wall) => (until ? (until.utc ? wall - o.from > until.wall : wall > until.wall) : false), null)) walls.add(w);
      }
      for (const w of walls) if (w < limit) list.push({ at: w - o.from, to: o.to });
    }
    list.sort((a, b) => a.at - b.at);
    cache.set(year, list);
    return list;
  };
  return (instant: number) => {
    const list = onsets(new Date(instant).getUTCFullYear());
    let best: { at: number; to: number } | undefined;
    for (const o of list) if (o.at <= instant) best = o;
    return best ? best.to : earliest.from;
  };
}

/** What a feed's times resolve against: its VTIMEZONEs, its calendar zone, and the owner's. */
export class Zones {
  private readonly vtz = new Map<string, ((instant: number) => number) | null>();
  private readonly defs: Map<string, IcsComponent>;
  /** TZIDs neither this runtime nor the feed defines — resolved in the calendar's zone, and counted */
  readonly unknown = new Set<string>();
  readonly calendarZone: string;

  constructor(
    calendar: IcsComponent,
    readonly ownerZone: string,
  ) {
    this.defs = new Map(calendar.children.filter((c) => c.name === "VTIMEZONE").flatMap((c) => {
      const id = prop(c, "TZID")?.value.trim();
      return id ? [[id, c] as const] : [];
    }));
    const wr = prop(calendar, "X-WR-TIMEZONE")?.value.trim();
    this.calendarZone = wr !== undefined && knownZone(wr) ? wr : ownerZone;
  }

  private offsetFn(tzid: string | null, date: boolean): (instant: number) => number {
    if (date) return (t) => ianaOffset(this.ownerZone, t);
    if (tzid === null) return (t) => ianaOffset(this.calendarZone, t);
    const iana = ianaFor(tzid);
    if (iana) return (t) => ianaOffset(iana, t);
    if (!this.vtz.has(tzid)) {
      const def = this.defs.get(tzid);
      this.vtz.set(tzid, def ? vtimezoneOffset(def) : null);
    }
    const fn = this.vtz.get(tzid);
    if (fn) return fn;
    this.unknown.add(tzid);
    return (t) => ianaOffset(this.calendarZone, t);
  }

  /** The instant `wall` names, read in the zone `t` carries (its TZID, UTC, the calendar's, or — for a date — the owner's). */
  instant(t: Pick<IcsTime, "date" | "utc" | "tzid">, wall: number): number {
    if (t.utc) return wall;
    return wallToInstant(wall, this.offsetFn(t.tzid, t.date));
  }
}

/** A TZID as an IANA zone: as written, unquoted, or a vendor-prefixed one's `Area/City` tail (`/mozilla.org/…/America/New_York`). */
function ianaFor(tzid: string): string | null {
  const id = tzid.replace(/^"|"$/g, "").trim();
  if (knownZone(id)) return id;
  const tail = id.split("/").filter(Boolean);
  for (let n = Math.min(3, tail.length); n >= 2; n--) {
    const cand = tail.slice(-n).join("/");
    if (knownZone(cand)) return cand;
  }
  return null;
}

// ---- recurrence -------------------------------------------------------------------

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
type Freq = (typeof FREQS)[number];

/** An RRULE as this module expands it. `supported` false: a part it does not expand — the series is skipped, never guessed. */
export interface Rule {
  supported: boolean;
  freq: Freq;
  interval: number;
  count: number | null;
  until: IcsTime | null;
  byDay: { n: number; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
}

const UNSUPPORTED_PARTS = new Set(["BYYEARDAY", "BYWEEKNO", "BYHOUR", "BYMINUTE", "BYSECOND"]);

function ints(v: string, min: number, max: number, nonZero = true): number[] | null {
  const out: number[] = [];
  for (const s of v.split(",")) {
    if (!/^[+-]?\d{1,3}$/.test(s)) return null;
    const n = Number(s);
    if ((nonZero && n === 0) || Math.abs(n) > max || n < -max || (min > 0 && n < min)) return null;
    out.push(n);
  }
  return out;
}

/** Parse an RRULE value. Anything it cannot read makes the rule unsupported. */
export function parseRule(value: string): Rule {
  const rule: Rule = { supported: true, freq: "DAILY", interval: 1, count: null, until: null, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [], wkst: 1 };
  let freq: string | undefined;
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part.slice(eq + 1).trim().toUpperCase();
    if (UNSUPPORTED_PARTS.has(k)) rule.supported = false;
    else if (k === "FREQ") freq = v;
    else if (k === "INTERVAL") {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1) rule.interval = n;
      else rule.supported = false;
    } else if (k === "COUNT") {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1) rule.count = n;
      else rule.supported = false;
    } else if (k === "UNTIL") {
      rule.until = parseTimeValue(v, null, false);
      if (!rule.until) rule.supported = false;
    } else if (k === "BYDAY") {
      for (const d of v.split(",")) {
        const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
        if (!m || (m[1] !== undefined && (Number(m[1]) === 0 || Math.abs(Number(m[1])) > 53))) {
          rule.supported = false;
          continue;
        }
        rule.byDay.push({ n: m[1] === undefined ? 0 : Number(m[1]), wd: WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]) });
      }
    } else if (k === "BYMONTHDAY") {
      const n = ints(v, 0, 31);
      if (n) rule.byMonthDay = n;
      else rule.supported = false;
    } else if (k === "BYMONTH") {
      const n = ints(v, 1, 12);
      if (n) rule.byMonth = n;
      else rule.supported = false;
    } else if (k === "BYSETPOS") {
      const n = ints(v, 0, 366);
      if (n) rule.bySetPos = n;
      else rule.supported = false;
    } else if (k === "WKST") {
      const i = WEEKDAYS.indexOf(v as (typeof WEEKDAYS)[number]);
      if (i >= 0) rule.wkst = i;
      else rule.supported = false;
    }
  }
  if (freq && (FREQS as readonly string[]).includes(freq)) rule.freq = freq as Freq;
  else rule.supported = false;
  return rule;
}

const ymdOf = (wall: number) => {
  const d = new Date(wall);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
};
const dayWall = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The days of month `m` a BYDAY list names — every such weekday, or the n-th (from the end when negative). */
function byDayInMonth(y: number, m: number, byDay: Rule["byDay"]): number[] {
  const out: number[] = [];
  const dim = daysIn(y, m);
  for (const { n, wd } of byDay) {
    const days: number[] = [];
    for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) days.push(d);
    if (n === 0) out.push(...days);
    else {
      const pick = n > 0 ? days[n - 1] : days[days.length + n];
      if (pick !== undefined) out.push(pick);
    }
  }
  return out;
}

/** The same, across a whole year (YEARLY with BYDAY and no BYMONTH): day walls. */
function byDayInYear(y: number, byDay: Rule["byDay"]): number[] {
  const out: number[] = [];
  const first = dayWall(y, 1, 1);
  const len = (dayWall(y + 1, 1, 1) - first) / DAY;
  for (const { n, wd } of byDay) {
    const days: number[] = [];
    for (let i = 0; i < len; i++) if (new Date(first + i * DAY).getUTCDay() === wd) days.push(first + i * DAY);
    if (n === 0) out.push(...days);
    else {
      const pick = n > 0 ? days[n - 1] : days[days.length + n];
      if (pick !== undefined) out.push(pick);
    }
  }
  return out;
}

function monthDays(y: number, m: number, byMonthDay: number[]): number[] {
  const dim = daysIn(y, m);
  return byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
}

/** Candidate days (walls at midnight) of month `m` in `y`, for a MONTHLY period or a YEARLY one's month. */
function monthCandidates(y: number, m: number, rule: Rule, startDay: number): number[] {
  let days: number[];
  if (rule.byMonthDay.length > 0 && rule.byDay.length > 0) {
    const wds = new Set(byDayInMonth(y, m, rule.byDay));
    days = monthDays(y, m, rule.byMonthDay).filter((d) => wds.has(d));
  } else if (rule.byMonthDay.length > 0) days = monthDays(y, m, rule.byMonthDay);
  else if (rule.byDay.length > 0) days = byDayInMonth(y, m, rule.byDay);
  else days = startDay <= daysIn(y, m) ? [startDay] : [];
  return days.map((d) => dayWall(y, m, d));
}

function setPos(sorted: number[], pos: number[]): number[] {
  if (pos.length === 0) return sorted;
  const out = new Set<number>();
  for (const p of pos) {
    const v = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
    if (v !== undefined) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The walls a rule produces from `start` (the DTSTART wall) up to `limit`
 * (exclusive), in order — DTSTART itself first, as RFC 5545 counts it.
 * `pastUntil` says whether a wall is beyond UNTIL. `from`, when given, is a
 * wall the caller needs nothing before: a rule with no COUNT skips whole
 * periods up to it (a rule with COUNT must walk from the start to count).
 */
export function* expandRule(rule: Rule, start: number, date: boolean, limit: number, pastUntil: (wall: number) => boolean, from: number | null): Generator<number> {
  if (!rule.supported) return;
  const s = ymdOf(start);
  const tod = start - dayWall(s.y, s.m, s.d);
  let emitted = 0;
  if (start < limit && !pastUntil(start)) {
    yield start;
    emitted++;
    if (rule.count !== null && emitted >= rule.count) return;
  } else return;

  const weekStart = dayWall(s.y, s.m, s.d) - ((s.wd - rule.wkst + 7) % 7) * DAY;
  let k = 0;
  if (rule.count === null && from !== null && from > start) {
    const f = ymdOf(from);
    const span =
      rule.freq === "DAILY"
        ? Math.floor((dayWall(f.y, f.m, f.d) - dayWall(s.y, s.m, s.d)) / DAY)
        : rule.freq === "WEEKLY"
          ? Math.floor((dayWall(f.y, f.m, f.d) - weekStart) / (7 * DAY))
          : rule.freq === "MONTHLY"
            ? (f.y - s.y) * 12 + (f.m - s.m)
            : f.y - s.y;
    k = Math.max(0, Math.floor(span / rule.interval) - 1);
  }
  for (let walked = 0; walked < MAX_PERIODS; walked++, k++) {
    // the period's first day: every candidate is on or after it, so one past the limit ends the walk
    let floor: number;
    let days: number[];
    switch (rule.freq) {
      case "DAILY": {
        floor = dayWall(s.y, s.m, s.d) + k * rule.interval * DAY;
        const d = ymdOf(floor);
        const keep =
          (!rule.byMonth.length || rule.byMonth.includes(d.m)) &&
          (!rule.byMonthDay.length || monthDays(d.y, d.m, rule.byMonthDay).includes(d.d)) &&
          (!rule.byDay.length || rule.byDay.some((b) => b.wd === d.wd));
        days = keep ? [floor] : [];
        break;
      }
      case "WEEKLY": {
        floor = weekStart + k * rule.interval * 7 * DAY;
        const ws = floor;
        const wds = rule.byDay.length ? [...new Set(rule.byDay.map((b) => b.wd))] : [s.wd];
        days = wds.map((wd) => ws + ((wd - rule.wkst + 7) % 7) * DAY).sort((a, b) => a - b);
        if (rule.byMonth.length) days = days.filter((d) => rule.byMonth.includes(ymdOf(d).m));
        break;
      }
      case "MONTHLY": {
        const idx = s.m - 1 + k * rule.interval;
        const y = s.y + Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        floor = dayWall(y, m, 1);
        days = rule.byMonth.length && !rule.byMonth.includes(m) ? [] : monthCandidates(y, m, rule, s.d).sort((a, b) => a - b);
        break;
      }
      case "YEARLY": {
        const y = s.y + k * rule.interval;
        floor = dayWall(y, 1, 1);
        if (rule.byMonth.length) days = rule.byMonth.flatMap((m) => monthCandidates(y, m, rule, s.d));
        else if (rule.byMonthDay.length) days = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((m) => monthCandidates(y, m, rule, s.d));
        else if (rule.byDay.length) days = byDayInYear(y, rule.byDay);
        else days = s.d <= daysIn(y, s.m) ? [dayWall(y, s.m, s.d)] : [];
        days = [...new Set(days)].sort((a, b) => a - b);
        break;
      }
    }
    if (floor >= limit) return;
    for (const day of setPos(days, rule.bySetPos)) {
      const w = date ? day : day + tod;
      if (w <= start) continue;
      if (w >= limit || pastUntil(w)) return;
      yield w;
      emitted++;
      if (rule.count !== null && emitted >= rule.count) return;
    }
  }
}

// ---- events -----------------------------------------------------------------------

/** A participant, spelled as `calendar_events.attendees` spells one (0034) — the email raw; the sync normalises it. */
export interface IcsParticipant {
  name: string | null;
  email: string | null;
  status: string;
  role: string;
  type: string;
  self: boolean;
}

/**
 * One occurrence, named fields only — the shape the eventkit bridge serves
 * (`GET /events`), so the sync builds its row the way the eventkit sync does.
 * There is no field for a body.
 */
export interface IcsOccurrence {
  event_id: string;
  ical_uid: string;
  series_id: string | null;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  organizer: { name: string | null; email: string | null } | null;
  participants: IcsParticipant[];
  /** A feed does not say which attendee is the owner. */
  self_status: null;
}

/** What a pass could not use, by reason — counted, never guessed at. */
export interface IcsSkipped {
  /** a series whose RRULE this module does not expand */
  unsupported_rule: number;
  /** an event with no UID, or no readable DTSTART */
  unreadable: number;
  /** TZIDs neither this runtime nor the feed defines (read in the calendar's zone) */
  unknown_zones: string[];
}

const PARTSTAT: Readonly<Record<string, string>> = {
  "NEEDS-ACTION": "pending",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  DELEGATED: "delegated",
  COMPLETED: "completed",
  "IN-PROCESS": "in_process",
};
const ROLE: Readonly<Record<string, string>> = { "REQ-PARTICIPANT": "required", "OPT-PARTICIPANT": "optional", CHAIR: "chair", "NON-PARTICIPANT": "non_participant" };
const CUTYPE: Readonly<Record<string, string>> = { INDIVIDUAL: "person", ROOM: "room", RESOURCE: "resource", GROUP: "group" };

function address(v: string): string | null {
  const t = v.trim();
  if (!/^mailto:/i.test(t)) return null;
  let a = t.slice("mailto:".length);
  try {
    a = decodeURIComponent(a);
  } catch {
    // as written
  }
  return a === "" ? null : a;
}

function participant(p: IcsProperty): IcsParticipant {
  const cn = param(p, "CN");
  return {
    name: cn && cn.trim() !== "" ? cn.trim() : null,
    email: address(p.value),
    // RFC 5545 §3.2.12: PARTSTAT defaults to NEEDS-ACTION; §3.2.16 ROLE to REQ-PARTICIPANT; §3.2.3 CUTYPE to INDIVIDUAL
    status: PARTSTAT[(param(p, "PARTSTAT") ?? "NEEDS-ACTION").toUpperCase()] ?? "unknown",
    role: ROLE[(param(p, "ROLE") ?? "REQ-PARTICIPANT").toUpperCase()] ?? "unknown",
    type: CUTYPE[(param(p, "CUTYPE") ?? "INDIVIDUAL").toUpperCase()] ?? "unknown",
    self: false,
  };
}

/** `<uid>_20260928T133000Z`, or `<uid>_20260928` for a date — the original start of one occurrence, as EventKit's key spells it. */
function occurrenceSuffix(date: boolean, wall: number, instant: number): string {
  const iso = new Date(date ? wall : instant).toISOString();
  const d = iso.slice(0, 10).replaceAll("-", "");
  return date ? d : `${d}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

/** The nominal length of an RFC 5545 DURATION (`P1DT2H`, `-PT15M`, `P2W`), in ms; null when it is not one. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === "P" || /T$/.test(v.trim())) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

interface Timing {
  start: IcsTime;
  /** the end as a wall in the start's zone, when the end is a wall offset from it (same zone, a DURATION, or a date) */
  wallLength: number | null;
  /** the end as an exact length, when DTEND is in another zone */
  exactLength: number | null;
}

function timingOf(c: IcsComponent, zones: Zones, fallback?: Timing): Timing | null {
  const start = timeOf(prop(c, "DTSTART"));
  if (!start) return null;
  const end = timeOf(prop(c, "DTEND"));
  const dur = prop(c, "DURATION");
  if (end && end.date === start.date && end.tzid === start.tzid && end.utc === start.utc) return { start, wallLength: Math.max(0, end.wall - start.wall), exactLength: null };
  if (end) return { start, wallLength: null, exactLength: Math.max(0, zones.instant(end, end.wall) - zones.instant(start, start.wall)) };
  const d = dur ? parseDuration(dur.value) : null;
  if (d !== null) return { start, wallLength: Math.max(0, d), exactLength: null };
  if (fallback && fallback.start.date === start.date) return { start, wallLength: fallback.wallLength, exactLength: fallback.exactLength };
  // RFC 5545 §3.6.1: no DTEND and no DURATION — a date lasts the day; a date-time is an instant
  return { start, wallLength: start.date ? DAY : 0, exactLength: null };
}

function span(t: Timing, startWall: number, zones: Zones): { start: number; end: number } {
  const start = zones.instant(t.start, startWall);
  const end = t.exactLength !== null ? start + t.exactLength : zones.instant(t.start, startWall + (t.wallLength ?? 0));
  return { start, end: Math.max(start, end) };
}

export interface ExpandOptions {
  /** the window, as instants: an occurrence overlapping [start, end) is returned */
  windowStart: number;
  windowEnd: number;
  /** the owner's IANA zone — an all-day date's day, and a floating time's zone when the calendar names none */
  ownerZone: string;
}

/**
 * Every occurrence of every event in `calendar` that overlaps the window —
 * one-offs, a series' occurrences, and each moved or retitled occurrence as
 * its override says. A cancelled event or occurrence is not returned (the
 * sync removes what it had). Sorted by start, then key.
 */
export function icsOccurrences(calendar: IcsComponent, opts: ExpandOptions): { events: IcsOccurrence[]; skipped: IcsSkipped } {
  const zones = new Zones(calendar, knownZone(opts.ownerZone) ? opts.ownerZone : "UTC");
  const skipped: IcsSkipped = { unsupported_rule: 0, unreadable: 0, unknown_zones: [] };
  const masters = new Map<string, IcsComponent>();
  const overrides = new Map<string, IcsComponent[]>();
  for (const c of calendar.children) {
    if (c.name !== "VEVENT") continue;
    const uid = prop(c, "UID")?.value.trim();
    if (!uid || !timeOf(prop(c, "DTSTART"))) {
      skipped.unreadable++;
      continue;
    }
    if (prop(c, "RECURRENCE-ID")) overrides.set(uid, [...(overrides.get(uid) ?? []), c]);
    else if (!masters.has(uid)) masters.set(uid, c); // the first of two masters with one UID stands
  }

  const out = new Map<string, IcsOccurrence>();
  const overlaps = (s: { start: number; end: number }) => s.start < opts.windowEnd && (s.end > opts.windowStart || s.start >= opts.windowStart);
  const build = (c: IcsComponent, uid: string, eventId: string, series: boolean, s: { start: number; end: number }, allDay: boolean): IcsOccurrence => {
    const org = prop(c, "ORGANIZER");
    const summary = prop(c, "SUMMARY");
    const loc = prop(c, "LOCATION");
    const location = loc ? unescapeText(loc.value).trim() : "";
    return {
      event_id: eventId,
      ical_uid: uid,
      series_id: series ? uid : null,
      title: summary ? unescapeText(summary.value) : "",
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      all_day: allDay,
      location: location === "" ? null : location,
      organizer: org ? { name: param(org, "CN")?.trim() || null, email: address(org.value) } : null,
      participants: props(c, "ATTENDEE").map(participant),
      self_status: null,
    };
  };
  const cancelled = (c: IcsComponent) => prop(c, "STATUS")?.value.trim().toUpperCase() === "CANCELLED";

  for (const [uid, master] of masters) {
    const timing = timingOf(master, zones);
    if (!timing) continue;
    const rr = prop(master, "RRULE");
    const rdates = timesOf(props(master, "RDATE"));
    const recurring = rr !== undefined || rdates.length > 0;
    if (!recurring) {
      if (cancelled(master)) continue;
      const s = span(timing, timing.start.wall, zones);
      if (overlaps(s)) out.set(uid, build(master, uid, uid, false, s, timing.start.date));
      continue;
    }
    if (cancelled(master)) continue;
    const rule = rr ? parseRule(rr.value) : null;
    if (rule && !rule.supported) {
      skipped.unsupported_rule++;
      continue;
    }
    const keyOf = (t: Pick<IcsTime, "date" | "utc" | "tzid">, wall: number) => occurrenceSuffix(t.date, wall, zones.instant(t, wall));
    const excluded = excludedKeys(master, timing.start.date, zones);
    const moved = new Set((overrides.get(uid) ?? []).map((o) => {
      const rid = timeOf(prop(o, "RECURRENCE-ID"))!;
      return keyOf(rid, rid.wall);
    }));
    // walls the rule gives, up to the window's end read as a wall (a day's margin covers any zone's offset)
    const limitWall = opts.windowEnd + 2 * DAY;
    const reach = (timing.wallLength ?? 0) + (timing.exactLength ?? 0) + 2 * DAY;
    const until = rule?.until ?? null;
    const pastUntil = (wall: number): boolean => {
      if (!until) return false;
      if (until.utc) return zones.instant(timing.start, wall) > until.wall;
      if (until.date && !timing.start.date) return Math.floor(wall / DAY) * DAY > until.wall;
      return wall > until.wall;
    };
    const walls = new Set<number>();
    if (rule) for (const w of expandRule(rule, timing.start.wall, timing.start.date, limitWall, pastUntil, opts.windowStart - reach)) walls.add(w);
    else walls.add(timing.start.wall);
    for (const r of rdates) {
      // an RDATE in another zone than DTSTART is read as an instant and re-read as a wall of DTSTART's zone
      const w = r.date === timing.start.date && r.tzid === timing.start.tzid && r.utc === timing.start.utc ? r.wall : timing.start.date ? r.wall : wallOfInstant(zones.instant(r, r.wall), timing.start, zones);
      walls.add(w);
    }
    for (const w of walls) {
      const key = keyOf(timing.start, w);
      if (excluded.has(key) || moved.has(key)) continue;
      const s = span(timing, w, zones);
      if (overlaps(s)) {
        const id = `${uid}_${key}`;
        if (!out.has(id)) out.set(id, build(master, uid, id, true, s, timing.start.date));
      }
    }
  }

  // each moved or retitled occurrence, at its own time; a cancelled one is gone
  for (const [uid, list] of overrides) {
    const master = masters.get(uid);
    const base = master ? timingOf(master, zones) ?? undefined : undefined;
    const excluded = master && base ? excludedKeys(master, base.start.date, zones) : new Set<string>();
    for (const o of list) {
      if (cancelled(o)) continue;
      const rid = timeOf(prop(o, "RECURRENCE-ID"))!;
      const key = occurrenceSuffix(rid.date, rid.wall, zones.instant(rid, rid.wall));
      if (excluded.has(key)) continue;
      const timing = timingOf(o, zones, base);
      if (!timing) continue;
      const s = span(timing, timing.start.wall, zones);
      const id = `${uid}_${key}`;
      if (overlaps(s) && !out.has(id)) out.set(id, build(o, uid, id, true, s, timing.start.date));
    }
  }

  skipped.unknown_zones = [...zones.unknown].sort();
  const events = [...out.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  return { events, skipped };
}

/** The occurrence keys a master's EXDATEs remove, spelled as its occurrences are (a date key for an all-day series). */
function excludedKeys(master: IcsComponent, allDay: boolean, zones: Zones): Set<string> {
  return new Set(timesOf(props(master, "EXDATE")).map((t) => occurrenceSuffix(allDay, t.wall, zones.instant(t, t.wall))));
}

/** An instant as a wall reading of the zone `t` carries (for an RDATE written in another zone than its DTSTART). */
function wallOfInstant(instant: number, t: IcsTime, zones: Zones): number {
  if (t.utc) return instant;
  // one step: the offset at the instant, applied; then corrected once for a DST edge
  const guess = instant + (instant - zones.instant(t, instant));
  return guess + (instant - zones.instant(t, guess));
}

// ---- the read ---------------------------------------------------------------------

/**
 * Read the body with a byte ceiling, so a runaway response is refused rather
 * than buffered. Counted as it streams: the door drops `content-length` (it
 * redacts the body, which can change its length), so the count is the check.
 */
async function cappedText(res: Response, max: number, where: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new IcsError("too_large", `${where}: the feed is more than ${max} bytes, which is not read`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/**
 * One read of the connection's feed, through the door the sync opened. The
 * feed's address is the connection's `reach.http.url`; `sync.fetch` reaches
 * its origin and nowhere else, and follows no redirect. Refusals name the
 * connection and the origin — never the path or query.
 */
export async function readIcsFeed(sync: Pick<SyncHttp, "connection" | "url" | "origin" | "headers" | "fetch">, maxBytes: number = ICS_MAX_BYTES): Promise<IcsComponent> {
  if (!sync.url.startsWith("https://")) {
    throw new IcsError("not_https", `connection ${sync.connection}: a feed is read over https — ${sync.origin} is not (write webcal:// as https://)`);
  }
  const res = await sync.fetch(sync.url, {
    method: "GET",
    headers: { ...sync.headers, accept: "text/calendar, text/plain;q=0.5" },
    signal: AbortSignal.timeout(ICS_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new IcsError("http_status", `connection ${sync.connection}: ${sync.origin} answered the feed with HTTP ${res.status}`);
  }
  const text = await cappedText(res, maxBytes, `connection ${sync.connection}: ${sync.origin}`);
  const calendar = parseIcs(text);
  if (!calendar) throw new IcsError("not_calendar", `connection ${sync.connection}: what ${sync.origin} sent is not an iCalendar feed (no BEGIN:VCALENDAR)`);
  return calendar;
}
