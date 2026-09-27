// Today — the day, in one column (screen 18 §2; screen 5 §12–§15). T7-3a
// split it out of app.js.
//
// The Mac's order at 358pt: the Morning Brief (or its folded line), Next Up,
// then the spine — past items folded above a Now rule, meetings at their
// time with the time as a line above each, and the day's tasks in the gap
// before the next one. **The rail comes last** — Agents, Since You Last
// Looked — and the Needs You line is dropped, because the bell is in the
// header. With no meetings the spine is the plain list (screen 5 §12.4).
//
// Where it reads: `GET /api/today` (T2-7) for the day — tasks, work, the
// owner's order, events and the brief, standup and plan paths; the brief and
// the standup through `GET /api/knowledge/page`; the rail through the
// `agent_presence` and `activity_feed` named queries. Where it writes: the
// Tick and Defer doors (§2.11) and nothing else — each one field on one line
// of the owner's note, as `user`, refused `409 stale` if the line is not the
// one drawn here. Reordering waits for `PUT /api/today/order` (T2-7); Close
// the Day for `POST /api/today/close` (T2-8).
//
// Every value reaches markup through esc()/attr(); the brief and the standup
// through md.js (escape first, whitelisted tags only) (CRIT-7).

import { attr, clockTime, dateTime, esc } from "./lib.js";
import { renderMarkdown } from "./md.js";

// ============================================================================
// The day as a spine — pure, so a test drives it with the recorded fixture
// ============================================================================

const MIN = 60 * 1000;
/** Next Up appears this long before a meeting (screen 5 §15.2). */
export const NEXT_UP_LEAD_MS = 30 * MIN;

/** A local calendar day, `YYYY-MM-DD` — the Defer door's `do` is a day in the owner's zone, resolved by the client. */
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** `YYYY-MM-DD` read as a LOCAL day (a bare date is not UTC midnight). */
const localDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) ? new Date(`${s}T00:00:00`) : null);

/**
 * Where Defer can send a line (screen 5 §15.5): Tomorrow, This Week — the
 * week's last working day, Friday, offered only while it is still after
 * tomorrow — and Someday. `do` days are the client's to resolve (§2.11).
 */
export function deferChoices(now) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const friday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - now.getDay() + 7) % 7));
  return [
    { when: "tomorrow", label: "Tomorrow", body: { do: ymd(tomorrow) } },
    ...(friday > tomorrow ? [{ when: "week", label: "This Week", body: { do: ymd(friday) } }] : []),
    { when: "someday", label: "Someday", body: { someday: true } },
  ];
}

/** The day's tasks and work in the owner's order (`today_order`: a `task_key` or `work:<id>`); anything unordered after, as served. */
export function orderedItems(day) {
  const items = [
    ...(day?.tasks ?? []).map((row) => ({ type: "task", key: String(row.task_key), row })),
    ...(day?.work ?? []).map((row) => ({ type: "work", key: `work:${row.id}`, row })),
  ];
  const at = new Map((day?.order ?? []).map((k, i) => [String(k), i]));
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (at.get(a.it.key) ?? Infinity) - (at.get(b.it.key) ?? Infinity) || a.i - b.i)
    .map((x) => x.it);
}

const isDone = (it) => (it.type === "task" ? Boolean(it.row.checked || it.row.dropped) : Boolean(it.row.closed_at) || it.row.status === "closed");

/**
 * The spine at `now`: what is behind (folded), what is happening, the open
 * tasks and work for the gap before the next meeting, the meetings still to
 * come, and Next Up — the next meeting, from 30 minutes before it.
 */
export function spineOf(day, now, keep = new Set()) {
  const t = now.getTime();
  const events = (day?.events ?? [])
    .map((row) => ({ type: "event", key: `event:${row.event_id}`, row, start: new Date(row.start).getTime(), end: new Date(row.end ?? row.start).getTime() }))
    .filter((e) => Number.isFinite(e.start));
  const timed = events.filter((e) => !e.row.all_day).sort((a, b) => a.start - b.start);
  const items = orderedItems(day);
  const later = timed.filter((e) => e.start > t);
  const next = later[0] ?? null;
  return {
    // a line ticked a moment ago stays where it was, struck, with its receipt (P9: nothing moves under the reader)
    past: [...timed.filter((e) => e.end <= t), ...items.filter((it) => isDone(it) && !keep.has(it.key))],
    allDay: events.filter((e) => e.row.all_day),
    current: timed.filter((e) => e.start <= t && e.end > t),
    open: items.filter((it) => !isDone(it) || keep.has(it.key)),
    later,
    nextUp: next && next.start - t <= NEXT_UP_LEAD_MS ? next : null,
    calendar: events.length > 0,
    // there were meetings, and none is left: Next Up says so rather than going quiet
    calendarDone: timed.length > 0 && later.length === 0 && timed.every((e) => e.end <= t),
  };
}

/** *3 earlier today · 2 done · 1 meeting* — the past folds itself (screen 5 §14.4). */
export function pastLine(past) {
  const meetings = past.filter((i) => i.type === "event").length;
  const done = past.length - meetings;
  const parts = [done ? `${done} done` : "", meetings ? `${meetings} ${meetings === 1 ? "meeting" : "meetings"}` : ""].filter(Boolean);
  return `${past.length} earlier today${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

/** The reason line under a task (screen 5 §2): due · priority · size · project — the fields it already has, never styled as a control. */
function taskMeta(row, today) {
  const due = localDay(row.due);
  const dueText = due && row.due !== today ? `due ${due.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}` : row.due === today ? "due today" : "";
  return [dueText, row.priority_effective ? `P${row.priority_effective}` : "", row.size ? String(row.size).toUpperCase() : "", row.project ?? ""].filter(Boolean).join(" · ");
}

/** At most two chips above priority (screen 5 §13.3): overdue, waiting, carried 3+ days — state tokens, never `failed` for a carry-over. */
function taskChips(row, today) {
  const chips = [];
  if (row.due && today && row.due < today && !row.checked) chips.push(`<span class="chip degraded-chip">overdue</span>`);
  if (row.waiting) chips.push(`<span class="chip">waiting</span>`);
  if (Number(row.carried_days) >= 3) chips.push(`<span class="chip degraded-chip">carried ${Number(row.carried_days)} days</span>`);
  return chips.length > 2 ? `${chips.slice(0, 2).join("")}<span class="chip">+${chips.length - 2}</span>` : chips.join("");
}

const who = (attendees) => (Array.isArray(attendees) ? attendees.filter((a) => a && !a.self).map((a) => String(a.name ?? a.email ?? "")).filter(Boolean) : []);
const span = (e) => (e.row.all_day ? "All day" : `${clockTime(e.row.start)} – ${clockTime(e.row.end)}`);
const glyph = (id, cls = "glyph lead") => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#g-${id}"/></svg>`;
const words = (s) => String(s ?? "").replaceAll("_", " ");

/**
 * One task row: a checkbox — you tick it — the line's own text, its reason
 * line and chips, and Defer. `note` is what the last write left on it: the
 * receipt with Undo, a stale refusal with the line as it stands, or an error.
 */
export function taskHtml(it, { n, today, note, deferring, busy, now = new Date() } = {}) {
  const r = it.row;
  const k = attr(it.key);
  const done = Boolean(r.checked);
  const dis = busy ? " disabled" : "";
  const choices = deferring && !done
    ? `<div class="defer-choices" role="group" aria-label="Defer to">${deferChoices(now).map((c) => `<button type="button" class="secondary" data-act="defer-to" data-key="${k}" data-when="${c.when}"${dis}>${c.label}</button>`).join("")}</div>`
    : "";
  return `<li class="spine-item task${done ? " done" : ""}${r.priority_effective === 1 ? " p1" : ""}" data-key="${k}">` +
    `<input type="checkbox" id="tick-${n}" data-act="tick" data-key="${k}"${done ? " checked" : ""}${dis}>` +
    `<div class="item-body"><label class="item-title" for="tick-${n}">${esc(r.text)}</label>` +
    `<span class="item-meta">${esc(taskMeta(r, today))}${taskChips(r, today)}</span>` +
    (done ? "" : `<div class="item-acts"><button type="button" class="quiet" data-act="defer" data-key="${k}" aria-expanded="${deferring ? "true" : "false"}"${dis}>Defer</button></div>`) +
    `${choices}${noteHtml(it.key, note)}</div></li>`;
}

/** What a write left on its row (screen 5 §5, §15.4): a receipt that names the file, with Undo on a tick; a stale refusal showing the line as it stands. */
export function noteHtml(key, note) {
  if (!note) return "";
  const k = attr(key);
  if (note.kind === "ticked") return `<p class="receipt" role="status">Ticked in <span class="mono">${esc(note.path)}</span> <button type="button" class="link" data-act="undo" data-key="${k}">Undo</button></p>`;
  if (note.kind === "reopened") return `<p class="receipt" role="status">Reopened in <span class="mono">${esc(note.path)}</span></p>`;
  if (note.kind === "stale") {
    return `<p class="stale-note" role="status">This line changed in your note since it was shown. Nothing was written.` +
      `${note.line ? `<br><span class="mono">${esc(note.line)}</span>` : "<br>The line is gone from the note."}</p>`;
  }
  return `<p class="card-error" role="status">${esc(note.message)}</p>`;
}

/** A `work` row: the board glyph and no checkbox — there is nothing here for you to tick; it is finished on the Board. */
export function workHtml(it) {
  const r = it.row;
  const meta = [words(r.status), r.claimed_by ? `with ${r.claimed_by}` : r.owner ? `for ${r.owner}` : "", r.project ?? ""].filter(Boolean).join(" · ");
  return `<li class="spine-item work" data-key="${attr(it.key)}">${glyph("board")}<div class="item-body">` +
    `<span class="item-title">${esc(r.title)}</span><span class="item-meta">${esc(meta)}</span>` +
    `<div class="item-acts"><button type="button" class="quiet" data-act="board">Open on the Board</button></div></div></li>`;
}

/** A meeting in the spine — retrieved, so plain: title, time, where, who. The one in Next Up says so instead of repeating it. */
export function eventHtml(e, { inNextUp = false } = {}) {
  const people = who(e.row.attendees);
  const meta = [span(e), e.row.location ?? "", people.length ? `with ${people.join(", ")}` : ""].filter(Boolean).join(" · ");
  return `<li class="spine-item event" data-key="${attr(e.key)}">${glyph("today")}<div class="item-body">` +
    `<span class="item-title">${esc(e.row.title)}</span>` +
    `<span class="item-meta">${inNextUp ? "in Next Up ↑" : esc(meta)}</span></div></li>`;
}

/** A line above an item. A meeting's time is also in its own row, so that line is not spoken twice; a gap's line is the only place it is said. */
const line = (text, { spoken = false } = {}) => `<li class="spine-line"${spoken ? "" : ' aria-hidden="true"'}>${esc(text)}</li>`;

/** The whole spine, in order. `view` carries the per-row notes and which row's Defer is open. */
export function spineHtml(s, day, view = {}) {
  const now = view.now ?? new Date();
  const today = day?.date ?? ymd(now);
  let n = 0;
  const row = (it) => {
    const opts = { n: n++, today, note: view.notes?.get(it.key), deferring: view.deferring === it.key, busy: view.busy?.has(it.key), now };
    return it.type === "task" ? taskHtml(it, opts) : it.type === "work" ? workHtml(it) : eventHtml(it, { inNextUp: s.nextUp?.key === it.key });
  };
  const out = [];
  if (s.past.length) {
    out.push(`<li class="spine-fold"><details><summary>${esc(pastLine(s.past))}</summary><ol class="spine">${s.past.map(row).join("")}</ol></details></li>`);
  }
  if (s.calendar) out.push(`<li class="spine-now" role="separator" aria-label="${attr(`Now, ${clockTime(now)}`)}"><span>Now · ${esc(clockTime(now))}</span></li>`);
  if (s.allDay.length) out.push(line("All Day"), ...s.allDay.map(row));
  for (const e of s.current) out.push(line(span(e)), row(e));
  if (s.open.length) {
    if (s.later.length) out.push(line(`Until ${clockTime(s.later[0].row.start)}`, { spoken: true }));
    else if (s.calendar) out.push(line("Rest of the Day", { spoken: true }));
    out.push(...s.open.map(row));
  }
  for (const e of s.later) out.push(line(clockTime(e.row.start)), row(e));
  return out.join("");
}

/** Next Up (screen 5 §15.2): the retrieved half — title and time, where, who is in it — or that the calendar is done. */
export function nextUpHtml(s, now) {
  if (s.nextUp) {
    const e = s.nextUp;
    const mins = Math.max(0, Math.round((e.start - now.getTime()) / MIN));
    const people = who(e.row.attendees);
    return `<p class="next-label">Next Up · ${mins ? `in ${mins} min` : "now"}</p><p class="next-title">${esc(e.row.title)}</p>` +
      `<p class="muted">${esc([span(e), e.row.location ?? ""].filter(Boolean).join(" · "))}</p>` +
      (people.length ? `<p class="muted">With ${esc(people.join(", "))}</p>` : "");
  }
  return s.calendarDone ? `<p class="muted">Nothing else on your calendar today.</p>` : "";
}

// ----- the Morning Brief (screen 5 §15.1) -----

/** A note's first heading is its title, which the brief's own header already says. */
const withoutTitle = (md) => String(md ?? "").replace(/^\s*#\s[^\n]*\n+/, "");
/** The folded line: *Morning Brief — Four things today; …*, the first sentence of the prose. */
export function briefLine(md) {
  const prose = withoutTitle(md).split("\n").map((l) => l.trim()).find((l) => l && !/^(#|[-*]\s|>|```|\|)/.test(l)) ?? "";
  const plain = prose.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, t, a) => a ?? t).replace(/[*_`]/g, "");
  const first = /^(.*?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return `Morning Brief — ${first.length > 120 ? `${first.slice(0, 119)}…` : first}`.replace(/ — $/, "");
}

/** The brief, open or folded; its Standup section collapsed, with Copy Standup; the foot names the file and does not repeat the plan. */
export function briefHtml({ date, brief, standup, open, planned, carried, path, failed }) {
  if (failed) {
    return `<p class="brief-state">Couldn't read the Morning Brief — the day below is still complete.</p><p class="mono reason">${esc(failed)}</p>`;
  }
  if (brief === null || brief === undefined) return `<p class="brief-state">No Morning Brief yet today — the day below is still complete.</p>`;
  if (!open) return `<button type="button" class="brief-fold" data-act="brief-open" aria-expanded="false">${esc(briefLine(brief))}</button>`;
  const stand = standup
    ? `<details class="standup"><summary>Standup</summary><div class="agent-prose">${renderMarkdown(withoutTitle(standup))}</div>` +
      `<p class="muted">Metistry doesn't post this.</p><button type="button" class="secondary" data-act="copy-standup">Copy Standup</button></details>`
    : "";
  return `<p class="brief-head">Morning Brief <span class="muted">${esc(date ?? "")}</span></p>` +
    `<div class="brief-body agent-prose">${renderMarkdown(withoutTitle(brief))}</div>${stand}` +
    `<p class="muted brief-foot">The plan is the day below · ${planned} ${planned === 1 ? "task" : "tasks"}${carried ? `, ${carried} carried` : ""} · <span class="mono">${esc(path)}</span></p>`;
}

// ----- the rail: what is true now, regardless of the clock (screen 5 §12.2) -----

const PRESENCE = new Set(["working", "queued", "idle", "interrupted", "over-cap", "blocked"]);
/** Agents: the ones doing something, each with its state in words and what it holds; idle ones are not news. */
export function agentsHtml(rows) {
  const busy = (rows ?? []).filter((a) => a.state && a.state !== "idle");
  if (!busy.length) return `<li class="muted">No agent is working right now.</li>`;
  return busy.map((a) => {
    const claim = Array.isArray(a.current_claims) && a.current_claims[0]?.title ? ` <span class="muted">${esc(a.current_claims[0].title)}</span>` : "";
    const state = PRESENCE.has(a.state) ? a.state : "idle";
    return `<li><span><b>${esc(a.display_name ?? a.id)}</b> <span class="chip state-${state}">${esc(words(a.state))}</span>${claim}</span></li>`;
  }).join("");
}

/** Since You Last Looked: how many things happened, and the newest few, from the activity feed. */
export function sinceHtml(rows, since, now = new Date()) {
  const list = rows ?? [];
  // a look from another day says which day
  const when = !since ? "" : ymd(new Date(since)) === ymd(now) ? clockTime(since) : dateTime(since);
  if (!list.length) return `<li class="muted">Nothing new${when ? ` since ${esc(when)}` : ""}.</li>`;
  const head = `<li class="muted">${list.length} ${list.length === 1 ? "thing" : "things"}${when ? ` since ${esc(when)}` : ""}</li>`;
  return head + list.slice(0, 5).map((r) => `<li><span>${esc(r.subject ?? r.kind)}<span class="muted"> ${esc(r.detail ?? "")}</span></span><span class="muted when">${esc(clockTime(r.ts))}</span></li>`).join("");
}

// ============================================================================
// The view — wired to the DOM when app.js mounts it
// ============================================================================

const BRIEF_READ = "metistry.brief-read"; // the day whose brief was scrolled past: it folds on the next open
const LOOKED = "metistry.today-looked"; // when Today was last opened: the rail's *since*
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: nothing remembered */ } },
};

/** A fresh `Idempotency-Key` for one attempt at one write (docs/ops/client-api.md): the outbox (T7-4) replays with the same one. */
const newKey = (verb) => `${verb}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/**
 * Mount Today on #today. `ctx` is the shell's: `$`, `api`, `show`. Returns
 * `{ load }`, which the shell calls each time Today opens.
 */
export function mountToday({ $, api, show }) {
  let day = null;
  let brief = { loaded: false, text: null, standup: null, failed: null };
  let briefOpen = false;
  let freshLook = false; // whether the brief may fold: only when Today opens, never under the reader
  let deferring = null;
  const notes = new Map(); // task_key → what its last write left
  const busy = new Set();

  async function load() {
    // a new look: last visit's receipts and open choices are history, and a line ticked then folds into the past
    $("today-receipt").textContent = "";
    notes.clear();
    deferring = null;
    freshLook = true;
    const since = store.get(LOOKED) ?? new Date(Date.now() - 24 * 60 * MIN).toISOString();
    store.set(LOOKED, new Date().toISOString());
    await Promise.all([loadDay(), loadRail(since)]);
  }

  /**
   * The day. After a write (`again`) a failed read keeps the day on screen
   * with the write's own note beside it, rather than trading what the owner
   * is looking at for an error panel.
   */
  async function loadDay({ again = false } = {}) {
    let res;
    try {
      res = await api("/api/today");
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      return again && day ? paint() : paintState("failed", "Couldn't reach Metistry", String(e?.message ?? e));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return again && day ? paint() : paintState("failed", "Couldn't read today", body.error?.message ?? `the console answered ${res.status}`);
    day = body;
    if (freshLook) {
      // folded once read, on the NEXT open (screen 5 §15.1)
      briefOpen = store.get(BRIEF_READ) !== day.date;
      freshLook = false;
      brief = { loaded: !day.brief, text: null, standup: null, failed: null };
    }
    paint();
    if (!brief.loaded) await loadBrief();
  }

  /** The brief and the standup are notes: read them through the page route, never assembled here. */
  async function loadBrief() {
    if (!day?.brief) return;
    const page = async (path) => {
      const r = await api(`/api/knowledge/page?path=${encodeURIComponent(path)}`);
      const b = await r.json().catch(() => ({}));
      if (r.status === 404) return null; // the path is named before the routine has written it
      if (!r.ok) throw new Error(b.error?.message ?? `the console answered ${r.status}`);
      return String(b.content ?? "");
    };
    try {
      const [text, standup] = await Promise.all([page(day.brief), day.standup ? page(day.standup) : null]);
      brief = { loaded: true, text, standup, failed: null };
    } catch (e) {
      brief = { loaded: true, text: null, standup: null, failed: String(e?.message ?? e) };
    }
    paintBrief();
  }

  async function loadRail(since) {
    const q = async (name, params) => (await api(`/api/q/${name}?${new URLSearchParams(params)}`)).json();
    const hours = Math.min(168, Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / (60 * MIN)) + 1));
    await Promise.all([
      q("agent_presence", { limit: 100 }).then((r) => { $("today-agents").innerHTML = agentsHtml(r.rows); }, () => { $("today-agents").innerHTML = `<li class="muted">Unavailable.</li>`; }),
      q("activity_feed", { hours, limit: 50, since }).then((r) => { $("today-since").innerHTML = sinceHtml(r.rows, since); }, () => { $("today-since").innerHTML = `<li class="muted">Unavailable.</li>`; }),
    ]);
  }

  function paintState(kind, title, reason) {
    day = null;
    $("today-state").hidden = false;
    $("today-state").className = `panel-state ${kind}`;
    $("today-state").innerHTML = `<p class="state-title">${esc(title)}</p>${reason ? `<p class="mono reason">${esc(reason)}</p>` : ""}`;
    for (const id of ["today-brief", "today-next"]) $(id).hidden = true;
    $("today-spine").innerHTML = "";
    $("today-asof").textContent = "";
  }

  function paint() {
    if (!day) return;
    const now = new Date();
    const s = spineOf(day, now, new Set([...notes].filter(([, n]) => n.kind === "ticked").map(([k]) => k)));
    const empty = !s.calendar && !(day.tasks ?? []).length && !(day.work ?? []).length;
    $("today-state").hidden = !empty;
    $("today-state").className = "panel-state empty";
    $("today-state").innerHTML = empty
      ? `<p class="state-title">Nothing scheduled for today.</p><p class="muted">That means nothing is due or planned — not that you're finished.</p>`
      : "";
    const next = nextUpHtml(s, now);
    $("today-next").hidden = !next;
    $("today-next").innerHTML = next;
    $("today-spine").innerHTML = spineHtml(s, day, { now, notes, deferring, busy });
    $("today-asof").textContent = day.as_of ? `as of ${clockTime(day.as_of)}` : "";
    paintBrief();
  }

  function paintBrief() {
    if (!day) return;
    const tasks = day.tasks ?? [];
    $("today-brief").hidden = !brief.loaded; // nothing, rather than a wrong sentence, while the note is read
    $("today-brief").innerHTML = briefHtml({
      date: day.date,
      brief: brief.text,
      standup: brief.standup,
      open: briefOpen,
      planned: tasks.filter((t) => !t.checked).length,
      carried: tasks.filter((t) => Number(t.carried_days) > 0).length,
      path: day.brief,
      failed: brief.failed,
    });
  }

  // The brief folds on the NEXT open once it has been scrolled past — never
  // under the reader (P9): nothing on the page moves while it is being read.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => {
      if (day?.brief && brief.text && briefOpen && !e.isIntersecting && e.boundingClientRect.bottom < 0) store.set(BRIEF_READ, day.date);
    }).observe($("today-brief"));
  }

  /** Tick and Undo: the same door, the two directions (§2.11, T2-4). */
  async function tick(key, checked) {
    const it = orderedItems(day).find((i) => i.key === key && i.type === "task");
    if (!it || busy.has(key)) return;
    busy.add(key);
    notes.delete(key);
    paint();
    const res = await api(`/api/vault-tasks/${encodeURIComponent(key)}/check`, {
      method: "POST",
      headers: { "idempotency-key": newKey(checked ? "tick" : "undo") },
      body: JSON.stringify({ checked, seen_text: it.row.text }),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: `Couldn't reach Metistry — nothing was written (${e?.message ?? e})` } }) }));
    const out = await res.json().catch(() => ({}));
    busy.delete(key);
    await settle(key, res, out, checked ? { kind: "ticked", path: it.row.path } : { kind: "reopened", path: it.row.path });
  }

  /** Defer: a `do` day or someday, one field on one line (T2-5). */
  async function defer(key, when) {
    const it = orderedItems(day).find((i) => i.key === key && i.type === "task");
    const choice = deferChoices(new Date()).find((c) => c.when === when);
    if (!it || !choice || busy.has(key)) return;
    busy.add(key);
    notes.delete(key);
    paint();
    const res = await api(`/api/vault-tasks/${encodeURIComponent(key)}/schedule`, {
      method: "POST",
      headers: { "idempotency-key": newKey("defer") },
      body: JSON.stringify({ ...choice.body, seen_text: it.row.text }),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: `Couldn't reach Metistry — nothing was written (${e?.message ?? e})` } }) }));
    const out = await res.json().catch(() => ({}));
    busy.delete(key);
    deferring = null;
    // the line leaves the day, so what happened is said once above it
    if (res.ok) $("today-receipt").textContent = `Deferred to ${choice.body.someday ? "someday" : localDay(choice.body.do).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} — ${it.row.text}`;
    await settle(key, res, out, null);
  }

  /** What a write leaves: a receipt, the stale line as it stands, or the refusal's own words — then the day as it now is. */
  async function settle(key, res, out, ok) {
    if (res.ok) { if (ok) notes.set(key, ok); else notes.delete(key); }
    else if (res.status === 409 && out.reason === "stale") notes.set(key, { kind: "stale", line: out.line ?? null });
    else notes.set(key, { kind: "error", message: `Not written — ${out.error?.message ?? `the console answered ${res.status}`}` });
    // a refusal keeps the row as it was drawn, so the note sits beside the line it is about
    if (res.ok) await loadDay({ again: true }).catch(() => paint());
    else paint();
  }

  $("today").addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.act === "tick") tick(el.dataset.key, el.checked);
  });

  $("today").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "undo") return tick(el.dataset.key, false);
    if (act === "defer") { deferring = deferring === el.dataset.key ? null : el.dataset.key; return paint(); }
    if (act === "defer-to") return defer(el.dataset.key, el.dataset.when);
    if (act === "board") return show("board");
    if (act === "feed") return show("feed");
    if (act === "brief-open") { briefOpen = true; return paintBrief(); }
    if (act === "copy-standup") {
      // Copy, never send: Metistry does not post the standup (screen 5 §6).
      try {
        await navigator.clipboard.writeText(brief.standup ?? "");
        el.textContent = "Copied";
      } catch {
        el.textContent = "Couldn't Copy";
      }
    }
  });

  return { load };
}
