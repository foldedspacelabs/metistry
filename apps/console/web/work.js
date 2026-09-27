// Work — Board, Projects and Artifacts, and what each of them pushes: a card,
// its room, a project, an artifact and an artifact's thread (screen 18 §5;
// screen 6 the board, screen 13 projects, screen 14 the card, screen 16
// artifacts and rooms). T7-3b split it out of app.js.
//
// **Board is one column at a time on a phone**, picked by chips that carry
// the column's count; from 600px the columns sit side by side and snap, and at
// 900px it is the Mac's board, drags and all. **Drag becomes Move to…**: an
// action sheet listing every other column, where a move the service would
// accept is a button and one it would refuse is listed disabled with the
// reason. **Every tap opens the card** (C84), pushed full-screen; the room is a
// push from the card. An artifact's threads become **counts on their lines**,
// opening a sheet — the margin does not fit.
//
// Where it reads: the `board` and `board_projects` named queries (invariant 3
// — `board` decides every card's column, so nothing here derives a state),
// `areas_overview`, `GET /api/projects`, the artifact routes and a task's
// room. Where it writes: one route per move (docs/ops/board.md "Drags"), a
// project's mode, and the comment, resolve and dispatch doors it had before —
// nothing new.
//
// Every value reaches markup through esc()/attr(); a note or an artifact's
// markdown through md.js (escape first, whitelisted tags only); an HTML
// artifact only inside an opaque-origin sandbox (decision #14) (CRIT-7).

import { ago, asNum, attr, barHtml, bodyClass, clockTime, dateTime, esc, fmtUsd, glyph } from "./lib.js";
import { renderMarkdownBlocks } from "./md.js";

/** The one principal the console's task routes act as (task-routes.ts `USER`): a claim the owner makes is `claimed_by = "user"`. */
export const USER = "user";

// ============================================================================
// The board — pure, so a test drives it with the recorded `board` rows
// ============================================================================

// The five columns in board order, each with the sentence its predicate means
// (P10: Title Case names things). The order must match board.yaml's.
//
// Every label is the word its KEY says (T1-2; C2, C38, C39): `assigned` is
// Assigned and `blocked` is Blocked, because a label that disagrees with its
// own value is a bug waiting for someone to fix the wrong side of it — and
// "Needs You" is the request queue's name, not a column's. Reported is not a
// column: whether a report came back is the `reported` flag on a Done card.
export const BOARD_COLUMNS = [
  ["backlog", "Backlog", "open, nobody's name on it"],
  ["assigned", "Assigned", "someone's name on it, not started"],
  ["in_progress", "In Progress", "someone holds the lease"],
  ["blocked", "Blocked", "nothing but your hand moves it"],
  ["done", "Done", "closed — and whether a report came back"],
];
export const BOARD_LABEL = new Map(BOARD_COLUMNS.map(([key, label]) => [key, label]));
/** Per column — board.yaml's default, named here so the header can say "showing N". */
export const BOARD_LIMIT = 50;

// Where a released or unblocked row LANDS is not the board's choice: release()
// and the unblock both clear the claim and set status open, so board.yaml's
// CASE puts it in Assigned or Backlog by whether `owner` is set. Naming that
// column is what stops a move from lying about where the card goes.
export const boardHome = (c) => (c.owner ? "assigned" : "backlog");

const whose = (name) => (name === USER ? "your" : `${name}'s`);
const holderOf = (c) => (c.claimed_by === null || c.claimed_by === undefined || c.claimed_by === "" ? null : String(c.claimed_by));

/**
 * Every move for ONE card: each column but its own, in board order, as
 * `{column, label, op, what}` where the service would accept it and
 * `{column, label, why}` where it would refuse.
 *
 * The rule is the statements' in packages/tasks, read off the row — and the
 * refusals say what the service would say (task-routes.ts `refusalMessage`):
 *
 * - claim takes an unclaimed card that is open or in progress, as the owner
 *   (`claimed_by = user`) — nobody moves a card onto another's lease;
 * - release, close and "blocked" are the HOLDER's (the holder arm's WHERE is
 *   `claimed_by = $agent`): the owner closes or releases only a card they hold;
 * - assign, unassign and the unblock are the board arm: no claim needed, any
 *   card that is not closed — the unblock from Blocked only;
 * - a released or unblocked card lands in its home column, never the other;
 * - a closed card takes nothing.
 *
 * When the two still disagree (a dependency still open, a claim that raced
 * in) the STATEMENT wins: the move is undone and the server's sentence shown.
 */
export function movesFor(c) {
  const col = String(c.column);
  const others = BOARD_COLUMNS.map(([k]) => k).filter((k) => k !== col);
  const label = (k) => BOARD_LABEL.get(k) ?? k;
  if (c.status === "closed" || col === "done") {
    return others.map((k) => ({ column: k, label: label(k), why: "it is closed — a closed card takes no more changes; make a follow-up instead" }));
  }
  const holder = holderOf(c);
  const mine = holder === USER;
  const home = boardHome(c);
  const lands = c.owner ? `it has ${whose(String(c.owner))} name on it, so it goes back to Assigned` : "nobody's name is on it, so it goes back to Backlog";
  const blockedWhy = "a card is marked blocked from its work, never moved there";
  const closeWhy = holder ? `${mine ? "you hold" : `${holder} holds`} it — only the one holding a card closes it` : "only the one holding a card closes it — claim it first";
  const closeMove = mine ? { op: "close", what: "closes it" } : { why: closeWhy };

  const move = (k) => {
    if (col === "backlog" || col === "assigned") {
      if (k === "assigned") return { op: "assign", what: "pick who it is for" };
      if (k === "backlog") return { op: "unassign", what: `clears ${whose(String(c.owner))} name` };
      if (k === "in_progress") return { op: "claim", what: "you claim it" };
      if (k === "blocked") return { why: blockedWhy };
      return { why: "only the one holding a card closes it — claim it first" };
    }
    if (col === "in_progress") {
      if (k === "blocked") return { why: blockedWhy };
      if (k === "done") return closeMove;
      if (!mine) return { why: holder ? `${holder} holds it — only the holder hands a card back` : "nobody holds it, so there is no claim to hand back" };
      if (k === home) return { op: "release", what: "hands it back — releases your claim" };
      return { why: `released, ${lands}` };
    }
    // blocked
    if (k === "in_progress") return { why: "nothing claims a blocked card — unblock it first" };
    if (k === "done") return closeMove;
    if (k === home) return { op: "unblock", what: holder && !mine ? `unblocks it — releases ${holder}'s claim` : "unblocks it" };
    return { why: `unblocked, ${lands}` };
  };

  return others.map((k) => {
    const m = move(k);
    return { column: k, label: m.op === "assign" ? "Assigned to…" : label(k), ...m };
  });
}

/** The legal moves for one card, `{ targetColumn: op }` — what a drag may drop, and what the drag draws as a target. */
export function dropsFor(c) {
  return Object.fromEntries(movesFor(c).filter((m) => m.op).map((m) => [m.column, m.op]));
}

// One op, one route. Anything that needs two calls is not a move.
export function boardRoute(op, card, extra) {
  const id = encodeURIComponent(String(card.id));
  const patch = (body) => [`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }];
  if (op === "assign") return patch({ owner: extra.owner });
  if (op === "unassign") return patch({ owner: null });
  if (op === "unblock") return patch({ status: "open" });
  if (op === "close") return patch({ status: "closed" });
  return [`/api/tasks/${id}/${op}`, { method: "POST", body: "{}" }]; // claim | release
}

/** Where a move lands: the target column, except that release and the unblock land in the card's home, whatever was aimed at. */
const landsIn = (op, card, target) => (op === "release" || op === "unblock" ? boardHome(card) : target);

/**
 * Move to…: every other column, one row each. A move the service accepts is a
 * button saying what it does; one it refuses is the same row, disabled, with
 * the reason in its own words — read aloud with the row, never a tooltip.
 */
export function moveListHtml(card) {
  return movesFor(card)
    .map((m) => m.op
      ? `<li><button type="button" class="row move" data-act="move" data-column="${attr(m.column)}"><span class="label">${esc(m.label)}</span><span class="sub">${esc(m.what)}</span></button></li>`
      : `<li><button type="button" class="row move" data-column="${attr(m.column)}" disabled><span class="label">${esc(m.label)}</span><span class="sub why">${esc(m.why)}</span></button></li>`)
    .join("");
}

/** The assign step: me, then every agent that is not revoked (a HUMAN may address a card to any crew — collaboration rule 4). */
export function ownerListHtml(names, current) {
  return [["user", "Me"], ...names.map((n) => [n, n])]
    .map(([v, l]) => `<li><button type="button" class="row" data-act="assign-to" data-owner="${attr(v)}"${v === current ? ' aria-current="true"' : ""}><span class="label${v === "user" ? "" : " mono"}">${esc(l)}</span>${v === current ? `<span class="sub">assigned now</span>` : ""}</button></li>`)
    .join("");
}

const fmtHours = (h) => {
  const n = asNum(h);
  if (n < 1) return `${Math.max(1, Math.round(n * 60))}m`;
  if (n < 48) return `${Math.round(n)}h`;
  return `${Math.round(n / 24)}d`;
};

// The SERVER decides `escalated`; this only names it, from fields already on
// the wire. A chip that says nothing but "escalated" is a card you have to
// open to understand, and the reason is already on the row.
export function escalationLabel(c, now = new Date()) {
  if (c.lease_expires_at && new Date(c.lease_expires_at) <= now) return "Lease Lapsed";
  if (c.status === "blocked") return c.blocked_by_task_open ? "Waiting on You" : "Blocked";
  return "Overdue";
}

/** The lease, as time: *4m left*, *lease lapsed 12m ago* — or nothing when no one holds it. */
export function leaseText(c, now = new Date()) {
  if (!c.lease_expires_at) return "";
  const t = new Date(c.lease_expires_at).getTime();
  if (Number.isNaN(t)) return "";
  if (t <= now.getTime()) return `lease lapsed ${ago(c.lease_expires_at, now.getTime())}`;
  const m = Math.max(1, Math.round((t - now.getTime()) / 60000));
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h ${m % 60}m left`;
}

/**
 * One card on the board: its glyph, its title, the room's message count, and
 * one line of facets. A card is a button that opens the card (C84); where it
 * can move it is also draggable, and `m` on it opens Move to….
 */
export function boardCardHtml(c, now = new Date()) {
  const bits = [];
  const holder = holderOf(c);
  if (holder) bits.push(holder === USER ? "held by you" : `held by ${holder}`);
  else if (c.owner) bits.push(c.owner === USER ? "for you" : `for ${c.owner}`);
  const lease = leaseText(c, now);
  if (lease) bits.push(lease);
  if (c.project) bits.push(String(c.project));
  // `reported` is the Done column's facet (C39)
  if (c.column === "done") bits.push(c.reported ? `reported ${ago(c.last_report_at, now.getTime())}` : "no report");
  else if (c.last_report_at) bits.push(`last report ${ago(c.last_report_at, now.getTime())}`);
  // blocked-by (board.yaml, from day_work): surfaced, never a gate
  if (c.blocked_by_task_open && c.blocked_by_task) bits.push(`waiting on you: ${c.blocked_by_task}`);
  if (!bits.length) bits.push(`${fmtHours(c.age_hours)} old`);
  const movable = Object.keys(dropsFor(c)).length > 0;
  const n = asNum(c.thread_count);
  const label = `${c.title} — ${BOARD_LABEL.get(String(c.column)) ?? c.column}${c.escalated ? `, ${escalationLabel(c, now)}` : ""}${c.has_thread ? `, room with ${n} ${n === 1 ? "message" : "messages"}` : ""}`;
  return `<li class="card${c.escalated ? " escalated" : ""}" data-act="card" data-id="${attr(c.id)}"${movable ? ` draggable="true"` : ""} tabindex="0" role="button" aria-label="${attr(label)}">` +
    `<div class="card-line">${glyph(c.kind === "review" ? "pencil" : "board", "glyph lead")}<span class="card-title">${esc(c.title)}</span>` +
    `${c.has_thread ? `<span class="thread-mark">${glyph("chat", "glyph")}${esc(String(n))}</span>` : ""}</div>` +
    `<div class="card-meta"><span class="muted">${esc(bits.join(" · "))}</span>${c.escalated ? ` <span class="chip degraded-chip">${esc(escalationLabel(c, now))}</span>` : ""}</div></li>`;
}

// Counts come from board_projects, not from the cards: `board` caps each
// column at BOARD_LIMIT, so counting the rendered cards would quietly
// understate a busy column.
export function boardTotals(rows, project) {
  const totals = new Map(BOARD_COLUMNS.map(([k]) => [k, { cards: 0, escalations: 0 }]));
  for (const r of rows ?? []) {
    if (project && r.project !== project) continue;
    const t = totals.get(String(r.column));
    if (!t) continue;
    t.cards += asNum(r.cards);
    t.escalations += asNum(r.escalations);
  }
  return totals;
}

/** The chips a phone picks its one column with: each column's word and its count. */
export function boardChipsHtml(totals, shown) {
  return BOARD_COLUMNS.map(([k, label]) => {
    const n = asNum(totals.get(k)?.cards);
    return `<button type="button" class="chip col-chip${k === shown ? " on" : ""}" data-act="column" data-column="${attr(k)}" aria-pressed="${k === shown}" aria-label="${attr(`${label}, ${n}`)}">${esc(label)} <span class="count">${n}</span></button>`;
  }).join("");
}

/** The five columns. `cards` null is the first load: placeholder rows, never an empty board that is not empty. */
export function boardColumnsHtml(cards, totals, now = new Date()) {
  const byColumn = new Map(BOARD_COLUMNS.map(([key]) => [key, []]));
  for (const c of cards ?? []) byColumn.get(String(c.column))?.push(c);
  return BOARD_COLUMNS.map(([key, label, why]) => {
    const list = byColumn.get(key) ?? [];
    const t = totals.get(key) ?? { cards: list.length, escalations: 0 };
    const more = cards && asNum(t.cards) > list.length ? ` <span class="muted">showing ${list.length}</span>` : "";
    const body = cards === null
      ? `<li class="card placeholder" aria-hidden="true"></li><li class="card placeholder" aria-hidden="true"></li>`
      : list.length ? list.map((c) => boardCardHtml(c, now)).join("") : `<li class="muted board-none">none</li>`;
    return `<section class="board-col" data-column="${attr(key)}" aria-label="${attr(label)}">` +
      `<h3>${esc(label)} <span class="board-count">${asNum(t.cards)}${t.escalations ? ` <span class="degraded">${asNum(t.escalations)}</span>` : ""}</span></h3>` +
      `<p class="muted board-why">${esc(why)}${more}</p><ul class="board-cards">${body}</ul></section>`;
  }).join("");
}

/** The card's own words for where it is: the column, and the fields a row already carries. */
export function cardFields(c, now = new Date()) {
  const holder = holderOf(c);
  const lease = leaseText(c, now);
  return [
    ["Column", BOARD_LABEL.get(String(c.column)) ?? String(c.column)],
    ["Held by", holder ? `${holder === USER ? "you" : holder}${lease ? ` · ${lease}` : ""}` : "nobody"],
    ["Assigned to", c.owner ? (c.owner === USER ? "you" : String(c.owner)) : "nobody — it is in the open queue"],
    ...(c.project ? [["Project", String(c.project)]] : []),
    ...(c.due ? [["Due", String(c.due)]] : []),
    ...(c.blocked_by ? [["Waiting on", c.blocked_by_task ? `${c.blocked_by_task}${c.blocked_by_task_open ? "" : " (done)"}` : String(c.blocked_by)]] : []),
    ...(c.column === "done" ? [["Report", c.reported ? `came back ${ago(c.last_report_at, now.getTime())}` : "none came back"]] : []),
    ...(c.external_ref ? [["From", String(c.external_ref)]] : []),
    ["Last activity", c.updated_at ? `${ago(c.updated_at, now.getTime())}` : "unknown"],
  ];
}

/** The card, pushed: state chips, what it is about (T1-1), its fields, then its room (C84: the room is a push from here). */
export function cardHtml(c, now = new Date()) {
  const chips = [
    c.escalated ? `<span class="chip degraded-chip">${esc(escalationLabel(c, now))}</span>` : `<span class="chip">${esc(BOARD_LABEL.get(String(c.column)) ?? c.column)}</span>`,
    holderOf(c) ? `<span class="chip agent">${esc(holderOf(c) === USER ? "you" : holderOf(c))}</span>` : "",
    c.project ? `<span class="chip">${esc(c.project)}</span>` : "",
    c.kind === "review" ? `<span class="chip">review</span>` : "",
  ].filter(Boolean).join(" ");
  const n = asNum(c.thread_count);
  const desc = c.description ? `<p class="card-desc">${esc(c.description)}</p>` : `<p class="muted card-desc">No description.</p>`;
  const art = c.artifact ? `<p><a href="#/artifacts/${attr(encodeURIComponent(String(c.artifact)))}">Open the artifact it reviews</a></p>` : "";
  return `<div class="card-chips">${chips}</div>${desc}` +
    `<dl class="fields">${cardFields(c, now).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${art}` +
    `<h3>Room</h3><p class="muted">${c.has_thread ? `${n} ${n === 1 ? "message" : "messages"}` : "Nothing said yet — a message here reaches whoever works on it."}</p>` +
    `<p><button type="button" class="secondary" data-act="room">Open Room</button></p>`;
}

// ============================================================================
// Projects — pure
// ============================================================================

/** A project's mode in the glossary's words: Autonomous, or Review — and Review because the budget was reached, said so (C96). */
export function modeChipHtml(p) {
  if (p.mode !== "review") return `<span class="chip autonomous">Autonomous</span>`;
  const byBudget = p.last_mode_change && p.last_mode_change.to === "review" && p.last_mode_change.by !== "user" && p.last_mode_change.reason === "budget";
  return byBudget ? `<span class="chip review over">Review · over budget</span>` : `<span class="chip review">Review</span>`;
}

/** Today's spend against the day's budget: a line and a bar, the bar in `degraded` once the budget is reached. */
export function spendHtml(p) {
  const spent = asNum(p.spend_today_usd);
  if (p.daily_budget_usd === null || p.daily_budget_usd === undefined) return `<span class="spend"><span class="muted">$${fmtUsd(spent)} today · no budget</span></span>`;
  const budget = asNum(p.daily_budget_usd);
  const over = spent >= budget;
  return `<span class="spend${over ? " over" : ""}"><span class="muted">$${fmtUsd(spent)} of $${fmtUsd(budget)} today</span>${barHtml(spent, budget)}</span>`;
}

/** One project row (screen 18 §5: the mode chip and the spend bar carry it, as on the Mac); a tap pushes the project. */
export function projectRowHtml(p, blocked = null) {
  const counts = [`${asNum(p.open_tasks)} open`, ...(blocked === null ? [] : [`${asNum(blocked)} blocked`]), `${(p.members ?? []).length} ${(p.members ?? []).length === 1 ? "agent" : "agents"}`];
  return `<li><button type="button" class="row project-row" data-act="project" data-id="${attr(p.id)}">` +
    `<span class="label"><span class="project-head"><b>${esc(p.title ?? p.id)}</b> ${modeChipHtml(p)}</span>` +
    `<span class="muted">${esc(counts.join(" · "))}</span>${spendHtml(p)}</span>${glyph("chevron", "chev")}</button></li>`;
}

/** The per-area work rollup (T1-14 `areas_overview`) — Areas, never "Projects" (C82). */
export function areaRollupHtml(rows) {
  if (!rows.length) return `<li class="muted">No work yet — the collectors fill this in.</li>`;
  return rows.map((r) => {
    const latest = (Array.isArray(r.latest) ? r.latest : []).map((t) => esc(String(t).slice(0, 60))).join(" · ");
    const blocked = asNum(r.blocked);
    return `<li><div class="row"><b>${esc(r.area)}</b><span>${asNum(r.open)} open</span></div>` +
      `<div class="muted">${asNum(r.in_progress)} in progress · ${blocked ? `<span class="degraded">${blocked} blocked</span>` : "0 blocked"} · ${asNum(r.closed_7d)} closed this week</div>` +
      `${latest ? `<div class="muted latest">${latest}</div>` : ""}</li>`;
  }).join("");
}

/** The project, pushed: why it is in its mode, the one switch, its people, its work and its money. */
export function projectHtml(p, blocked = null) {
  const change = p.last_mode_change;
  const why = change
    ? `${change.to === "review" ? "Review" : "Autonomous"} since ${new Date(change.ts).toLocaleDateString([], { month: "short", day: "numeric" })} — ${change.by === "user" ? "you set it" : change.reason === "budget" ? "it reached its budget" : esc(change.reason || change.by)}`
    : p.mode === "review" ? "Every agent-to-agent review comes to you in Needs You." : "Members hand work and reviews to each other without you.";
  const flip = p.mode === "review" ? "autonomous" : "review";
  const rows = [
    ["Open tasks", String(asNum(p.open_tasks))],
    ...(blocked === null ? [] : [["Blocked", String(asNum(blocked))]]),
    ["Bundles in flight", `${asNum(p.bundles_in_flight)} of ${asNum(p.max_open_bundles)}${asNum(p.bundles_queued) ? ` · ${asNum(p.bundles_queued)} queued` : ""}`],
    ["Open threads", String(asNum(p.open_threads))],
    ["Waiting on you", String(asNum(p.pending_reviews))],
    ...(p.last_activity ? [["Last active", dateTime(p.last_activity)]] : []),
  ];
  return `<p>${modeChipHtml(p)}</p><p class="muted">${esc(why)}</p>` +
    `<p><button type="button" class="secondary" data-act="mode" data-to="${flip}">${flip === "review" ? "Set to Review" : "Set to Autonomous"}</button></p>` +
    `<h3>Spend</h3><p>${spendHtml(p)}</p>` +
    `<h3>Members</h3><p>${(p.members ?? []).length ? p.members.map((m) => `<span class="chip agent">${esc(m)}</span>`).join(" ") : `<span class="muted">No agents in it yet.</span>`}</p>` +
    `<h3>Work</h3><dl class="fields">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

// ============================================================================
// Artifacts — pure
// ============================================================================

const ART_ID = "art_[0-9A-HJKMNP-TV-Z]{26}";
const VER_ID = "ver_[0-9A-HJKMNP-TV-Z]{26}";
/** `#/artifacts/<id>[/<version>][/review]` — the link a proposal carries. */
export function artifactRoute(hash) {
  const m = new RegExp(`^#/artifacts/(${ART_ID})(?:/(${VER_ID}))?(/review)?$`).exec(hash ?? "");
  return m ? { id: m[1], version: m[2] ?? null, review: !!m[3] } : null;
}
/** `#/rooms/work/<id>` — a task's room. */
export function roomRoute(hash) {
  const m = /^#\/rooms\/work\/(\d{1,12})$/.exec(hash ?? "");
  return m ? { work_id: Number(m[1]) } : null;
}

// HTML renders ONLY inside an opaque-origin sandboxed iframe (sandbox="" —
// no tokens at all, so the frame is never same-origin and never runs script;
// decision #14) with a CSP meta in the srcdoc, so an agent-authored page can
// neither read the session nor call a route.
export const ART_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">';

/** The threads anchored to a line of THIS file, by line. A thread on another file, or on no line, is not on a line here. */
export function threadsByLine(threads, path) {
  const by = new Map();
  for (const t of threads ?? []) {
    const line = t?.anchor?.line;
    if (t?.path !== path || !Number.isInteger(line) || line < 1) continue;
    by.set(line, [...(by.get(line) ?? []), t]);
  }
  return by;
}
/** Every comment in these threads, root and replies alike — the count a line wears. */
export const commentCount = (threads) => threads.reduce((n, t) => n + 1 + (t.replies ?? []).length, 0);

function countButton(lines, threads) {
  const n = commentCount(threads);
  const where = lines.length === 1 ? `Line ${lines[0]}` : `Lines ${lines.join(", ")}`;
  return `<button type="button" class="thread-count" data-act="thread" data-lines="${attr(lines.join(","))}" aria-label="${attr(`${where}, ${n} ${n === 1 ? "comment" : "comments"}`)}">${glyph("chat", "glyph")}${n}</button>`;
}

/**
 * A markdown file with its threads on their lines: each top-level block of
 * md.js's output, highlighted and carrying a count where a thread is anchored
 * inside it. A thread on a blank line belongs to the block after it (or the
 * last one), so no thread on this file is lost.
 */
export function annotatedMarkdownHtml(content, byLine) {
  const blocks = renderMarkdownBlocks(content);
  const at = new Map(); // block index → the anchored lines in it
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    let k = blocks.findIndex((b) => line >= b.start && line <= b.end);
    if (k === -1) k = blocks.findIndex((b) => b.start > line);
    if (k === -1) k = blocks.length - 1;
    if (k === -1) continue;
    at.set(k, [...(at.get(k) ?? []), line]);
  }
  return blocks.map((b, k) => {
    const lines = at.get(k);
    if (!lines) return `<div class="art-block">${b.html}</div>`;
    return `<div class="art-block has-thread">${b.html}${countButton(lines, lines.flatMap((l) => byLine.get(l) ?? []))}</div>`;
  }).join("") || `<p class="muted">This file is empty.</p>`;
}

/** Any other text file, a line at a time — escaped, never markup — with the count on each commented line. */
export function annotatedTextHtml(content, byLine) {
  return String(content ?? "").split("\n").map((text, i) => {
    const ts = byLine.get(i + 1);
    return ts ? `<span class="art-ln has-thread">${esc(text)}${countButton([i + 1], ts)}</span>` : `<span class="art-ln">${esc(text)}</span>`;
  }).join("\n");
}

const who = (c) => `${esc(c.author_principal)}${c.author_kind === "agent" ? ` <span class="chip agent">agent</span>` : ""}`; // agent text is labelled agent-sourced (§4.19)

/** The threads a sheet holds: each with its replies, a reply field, and Resolve or Reopen. */
export function threadSheetHtml(threads) {
  return threads.map((t) => `<li class="thread ${attr(t.state)}" data-thread="${attr(t.id)}">` +
    `<p class="muted">${who(t)} · ${esc(dateTime(t.created_at))} · ${esc(t.state)}</p><div class="${bodyClass(t)}">${esc(t.body)}</div>` +
    (t.replies ?? []).map((r) => `<div class="reply"><p class="muted">${who(r)} · ${esc(dateTime(r.created_at))}</p><div class="${bodyClass(r)}">${esc(r.body)}</div></div>`).join("") +
    `<form class="reply-form" data-reply="${attr(t.id)}"><input type="text" aria-label="Reply" placeholder="Reply…" autocomplete="off"><button type="submit" class="secondary">Reply</button></form>` +
    `<p><button type="button" class="secondary" data-act="${t.state === "open" ? "resolve" : "reopen"}" data-thread="${attr(t.id)}">${t.state === "open" ? "Resolve" : "Reopen"}</button></p></li>`).join("");
}

/** The threads that sit on no line of this file — the version as a whole, or another file — each a row that opens the sheet. */
export function otherThreadsHtml(threads, path, byLine) {
  const onLine = new Set([...byLine.values()].flat().map((t) => t.id));
  const rest = (threads ?? []).filter((t) => !onLine.has(t.id));
  if (!rest.length) return "";
  return `<h3>Comments</h3><ul class="group">${rest.map((t) => `<li><button type="button" class="row" data-act="thread-id" data-thread="${attr(t.id)}">` +
    `<span class="label">${esc(String(t.body ?? "").slice(0, 120))}<span class="sub">${who(t)} · ${t.path && t.path !== path ? `${esc(t.path)} · ` : ""}${esc(t.state)}</span></span>` +
    `<span class="muted">${commentCount([t])}</span>${glyph("chevron", "chev")}</button></li>`).join("")}</ul>`;
}

// A demoted thread has carried `payload.reason` since the ping-pong cap
// shipped; WHY_LINE says the stored value as a sentence (docs/ops/threads.md).
export const WHY_LINE = {
  ping_pong_cap: () => `Ten agent turns went by without a human. The next agent message was not stored — this is where it came to you. Answer, or resolve the room.`,
  outside_project: () => `An agent tried to hand this across a project boundary. Only your hand dispatches across it.`,
  review_mode: () => `The project is in review mode, so every agent-to-agent hand-off queues for you.`,
  may_dispatch_to: () => `The sending agent's manifest does not list this target.`,
  accept_from: () => `The receiving agent's manifest does not accept work from the sender.`,
};

// ============================================================================
// The views — wired to the DOM when app.js mounts them
// ============================================================================

const STORE_COLUMN = "metistry.board.column";

/**
 * `$`, `api` and `show` are the shell's doors; `closeSheet` puts the sheet
 * away when a move has been chosen, and `retitle` names a pushed view once
 * what it shows has been read (a link opened straight from a hash). Returns
 * each view's `load` for the shell's `loadView`.
 */
export function mountWork({ $, api, show, closeSheet, retitle = () => {} }) {
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: the chip is simply not remembered */ } },
  };
  const q = async (name, params) => {
    const res = await api(`/api/q/${name}?${new URLSearchParams(params ?? {})}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message ?? `the console answered ${res.status}`);
    return body;
  };
  const cardById = (id) => (rows ?? []).find((r) => String(r.id) === String(id)) ?? null;

  // ----- the board -----
  let rows = null; // the cards as last read; null until the first answer
  let totals = boardTotals([], "");
  let projectRows = [];
  let shown = BOARD_COLUMNS.some(([k]) => k === store.get(STORE_COLUMN)) ? store.get(STORE_COLUMN) : "in_progress";
  let dragging = null;
  let retry = null; // the move a failed network call would run again
  let timer = null;
  let failed = null;

  async function loadBoard() {
    const project = $("board-project").value ?? "";
    try {
      const [cards, counts] = await Promise.all([q("board", { project, limit: BOARD_LIMIT }), q("board_projects", { limit: 500 })]);
      rows = cards.rows ?? [];
      projectRows = counts.rows ?? [];
      totals = boardTotals(projectRows, project);
      failed = null;
      $("board-asof").textContent = cards.as_of ? `as of ${clockTime(cards.as_of)}` : "";
      populateProjects(projectRows);
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      failed = String(e?.message ?? e);
    }
    paintBoard();
  }

  // The filter's options are the projects that actually have cards — from the
  // board's own counts, so it never offers a project with an empty board.
  function populateProjects(counts) {
    const sel = $("board-project");
    const current = sel.value;
    const projects = [...new Set(counts.map((r) => r.project).filter(Boolean))].sort();
    sel.innerHTML = [`<option value="">All Projects</option>`, ...projects.map((p) => `<option value="${attr(p)}">${esc(p)}</option>`)].join("");
    sel.value = projects.includes(current) ? current : "";
  }

  function paintBoard() {
    const empty = rows !== null && !failed && BOARD_COLUMNS.every(([k]) => asNum(totals.get(k)?.cards) === 0);
    $("board-state").hidden = !failed && !empty;
    $("board-state").className = `panel-state ${failed ? "failed" : "empty"}`;
    $("board-state").innerHTML = failed
      ? `<p class="state-title">Couldn't read the board</p><p class="mono reason">${esc(failed)}</p><p><button type="button" class="secondary" data-act="reload">Try Again</button></p>`
      : empty ? `<p class="state-title">Nothing on the board.</p><p><button type="button" class="secondary" data-act="capture">Capture a Task</button></p>` : "";
    $("board-chips").innerHTML = boardChipsHtml(totals, shown);
    $("board-columns").dataset.show = shown;
    $("board-columns").innerHTML = failed && rows === null ? "" : boardColumnsHtml(rows, totals);
  }

  function boardMsg(text, { again = null } = {}) {
    retry = again;
    $("board-msg").hidden = !text;
    $("board-msg").innerHTML = text ? `${esc(text)}${again ? ` <button type="button" class="secondary" data-act="retry">Try Again</button>` : ""}` : "";
    $("card-msg").hidden = !text;
    $("card-msg").innerHTML = $("board-msg").innerHTML;
  }

  /**
   * Optimistic, then authoritative. The card lands NOW — a board that waits
   * for a round trip feels broken — and a refusal puts it back carrying the
   * SERVER's sentence, never one invented here. Either way the board is read
   * again: the server owns the columns.
   */
  async function run(op, card, target, extra = {}) {
    const row = cardById(card.id);
    const was = row ? row.column : null;
    if (row) row.column = landsIn(op, card, target);
    paintBoard();
    if (open?.id === String(card.id)) paintCard();
    boardMsg("");
    let res;
    try {
      const [path, init] = boardRoute(op, card, extra);
      res = await api(path, init);
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      if (row) row.column = was;
      boardMsg("The console did not answer — nothing moved.", { again: () => run(op, card, target, extra) });
      paintBoard();
      if (open) paintCard();
      return false;
    }
    if (!res.ok) {
      if (row) row.column = was;
      const body = await res.json().catch(() => null);
      boardMsg(body?.error?.message ?? `The console refused that move (${res.status}).`);
    } else if (open?.id === String(card.id)) {
      open.moved = null; // the owner's own move is not news
      $("card-msg").hidden = false;
      $("card-msg").textContent = `Moved to ${BOARD_LABEL.get(landsIn(op, card, target))}.`;
    }
    await loadBoard();
    if (open) { const again = cardById(open.id); if (again) { open.row = again; open.column = again.column; } paintCard(); }
    return res.ok;
  }

  // ----- Move to… (a sheet from the card, or `m` on a focused card) -----
  let moving = null; // { card, step: "moves" | "assign", names }

  function openMove(card) {
    moving = { card, step: "moves", names: null };
    show("move");
  }

  async function loadMove() {
    if (!moving) return;
    $("move-for").textContent = moving.card.title ?? `#${moving.card.id}`;
    if (moving.step === "moves") $("move-list").innerHTML = moveListHtml(moving.card);
    else $("move-list").innerHTML = ownerListHtml(moving.names ?? [], moving.card.owner ?? null);
  }

  let owners = null;
  async function ownerNames() {
    if (owners) return owners;
    try {
      const { agents } = await (await api("/api/agents")).json();
      owners = (agents ?? []).filter((a) => !a.revoked).map((a) => String(a.id)).sort();
    } catch { owners = []; }
    return owners;
  }

  $("move").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled || !moving) return;
    const card = moving.card;
    if (el.dataset.act === "move") {
      const op = dropsFor(card)[el.dataset.column];
      if (!op) return; // a disabled row is not a door, even if something clicks it
      if (op === "assign") {
        moving.step = "assign";
        moving.names = await ownerNames();
        return loadMove();
      }
      moving = null;
      closeSheet();
      return run(op, card, el.dataset.column);
    }
    if (el.dataset.act === "assign-to") {
      moving = null;
      closeSheet();
      return run("assign", card, "assigned", { owner: el.dataset.owner });
    }
  });

  // ----- the board's own controls -----
  $("board").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "column") { shown = el.dataset.column; store.set(STORE_COLUMN, shown); return paintBoard(); }
    if (act === "card") { const c = cardById(el.dataset.id); if (c) openCard(c); return; }
    if (act === "capture") return show("capture");
    if (act === "reload") return loadBoard().catch(() => {});
    if (act === "retry" && retry) return retry();
  });
  $("board").addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target.closest?.("[data-act]");
    if (!el || el.dataset.act !== "card") return;
    const c = cardById(el.dataset.id);
    if (!c) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCard(c); }
    else if (e.key === "m" || e.key === "M") { e.preventDefault(); openMove(c); }
  });
  $("board-project").addEventListener("change", () => loadBoard().catch(() => {}));

  // The drags, at every width a pointer can drag: four listeners and no
  // library (board.md §6b). A target is drawn ONLY on the columns this card
  // may land in — the board declining to draw one is the first half of "no
  // drop the service would refuse"; the statement is the second.
  const columnOf = (e) => e.target.closest?.(".board-col") ?? null;
  const paintTargets = (card) => {
    const drops = card ? dropsFor(card) : {};
    for (const col of $("board-columns").querySelectorAll(".board-col")) {
      col.classList.toggle("drop", Boolean(drops[col.dataset.column]));
      if (!card) col.classList.remove("drop-over");
    }
  };
  $("board-columns").addEventListener("dragstart", (e) => {
    const el = e.target.closest?.("[data-act]");
    const card = el?.dataset.act === "card" ? cardById(el.dataset.id) : null;
    if (!card) return;
    dragging = card;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(card.id));
    paintTargets(card);
  });
  $("board-columns").addEventListener("dragend", (e) => {
    e.target.closest?.("[data-act]")?.classList.remove("dragging");
    dragging = null;
    paintTargets(null);
  });
  $("board-columns").addEventListener("dragover", (e) => {
    const col = columnOf(e);
    if (!col || !dragging || !dropsFor(dragging)[col.dataset.column]) return; // no target drawn, no drop taken
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    col.classList.add("drop-over");
  });
  $("board-columns").addEventListener("dragleave", (e) => columnOf(e)?.classList.remove("drop-over"));
  $("board-columns").addEventListener("drop", (e) => {
    const col = columnOf(e);
    const card = dragging;
    dragging = null;
    paintTargets(null);
    if (!col || !card) return;
    e.preventDefault();
    const op = dropsFor(card)[col.dataset.column];
    if (!op) return;
    if (op === "assign") return openMove(card); // the one move that needs a value asks for it
    return run(op, card, col.dataset.column);
  });

  // [ and ] step the project filter. Never while typing.
  document.addEventListener("keydown", (e) => {
    if ($("board").hidden || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "[" && e.key !== "]")) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const sel = $("board-project");
    if (sel.options.length < 2) return;
    e.preventDefault();
    sel.selectedIndex = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + (e.key === "]" ? 1 : -1)));
    loadBoard().catch(() => {});
  });

  // A board that lags lies about who holds the lease: every 10s while it is in
  // view — never under a drag or an open sheet, which a repaint would cancel.
  const busy = () => dragging !== null || Boolean($("sheet").open);
  function poll(intervalMs = 10000) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if ((!$("board").hidden || !$("card").hidden) && document.visibilityState === "visible" && !busy()) refresh().catch(() => {});
    }, intervalMs);
  }
  async function refresh() {
    await loadBoard();
    if (open && !$("card").hidden) loadCard();
  }

  async function board() {
    if (rows === null) paintBoard(); // the first look: placeholder rows, not an empty board
    await loadBoard();
    poll();
  }

  // ----- the card (pushed; every tap opens it — C84) -----
  let open = null; // { id, row, column (as the owner last saw it), moved }

  function openCard(c) {
    open = { id: String(c.id), row: c, column: c.column, moved: null };
    boardMsg("");
    show("card", { title: c.title ?? `#${c.id}` });
  }

  /** The card as the board last read it; if it moved while the owner was away, say where — and offer that column. */
  function loadCard() {
    if (!open) return show("board");
    const now = cardById(open.id);
    if (now) {
      if (now.column !== open.column) open.moved = now.column;
      open.row = now;
      open.column = now.column;
    }
    retitle(open.row.title ?? `#${open.id}`); // back from its room, the card is still named by its title
    paintCard();
  }

  function paintCard() {
    if (!open) return;
    const c = open.row;
    $("card-body").innerHTML = cardHtml(c);
    $("card-note").hidden = !open.moved;
    $("card-note").innerHTML = open.moved
      ? `Moved to ${esc(BOARD_LABEL.get(open.moved) ?? open.moved)} while you were away. <button type="button" class="secondary" data-act="open-column" data-column="${attr(open.moved)}">Open in ${esc(BOARD_LABEL.get(open.moved) ?? open.moved)}</button>`
      : "";
    const drops = dropsFor(c);
    const release = Object.entries(drops).find(([, op]) => op === "release");
    $("card-release").hidden = !release;
    $("card-release").dataset.column = release ? release[0] : "";
    $("card-move").disabled = false; // a closed card still opens Move to…, which says why nothing is offered
  }

  $("card").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled || !open) return;
    const act = el.dataset.act;
    if (act === "move") return openMove(open.row);
    if (act === "release") return run("release", open.row, el.dataset.column);
    if (act === "room") return openRoom(Number(open.id));
    if (act === "retry" && retry) return retry();
    if (act === "open-column") { shown = el.dataset.column; store.set(STORE_COLUMN, shown); open.moved = null; return show("board"); }
  });

  // ----- a task's room (a push from its card) -----
  let room = null; // { work_id }

  function openRoom(workId) {
    room = { work_id: Number(workId) };
    if (location.hash !== `#/rooms/work/${room.work_id}`) history.replaceState(null, "", `#/rooms/work/${room.work_id}`);
    show("rooms", { title: `#${room.work_id}` });
  }

  async function loadRoom() {
    const r = roomRoute(location.hash);
    if (r) room = r;
    if (!room) return show("board");
    const res = await api(`/api/work/${encodeURIComponent(room.work_id)}/thread`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      $("room-detail").hidden = true;
      $("room-state").hidden = false;
      $("room-state").textContent = res.status === 404 ? `There is no task #${room.work_id}.` : `Couldn't open the room — ${body.error?.message ?? `the console answered ${res.status}`}`;
      return;
    }
    const t = await res.json();
    retitle(`#${room.work_id}`);
    $("room-state").hidden = true;
    $("room-detail").hidden = false;
    $("room-title").textContent = t.title ?? "";
    $("room-meta").textContent = `${t.project ?? "no project"} · ${t.status} · room ${t.state}${t.resolved_by ? ` by ${t.resolved_by}` : ""} · ${t.agent_tail} of ${t.cap} agent turns in a row${t.agent_tail ? " · yours resets it" : ""}`;
    const why = t.agent_tail >= t.cap;
    $("room-why").hidden = !why;
    if (why) $("room-why").textContent = WHY_LINE.ping_pong_cap();
    $("room-messages").innerHTML = t.comments.length
      ? t.comments.map((c) => `<li class="reply"><p class="muted">${who(c)} · ${esc(dateTime(c.created_at))}</p><div class="${bodyClass(c)}">${esc(c.body)}</div></li>`).join("")
      : `<li class="muted">Nothing said yet.</li>`;
    $("room-resolve").textContent = t.state === "open" ? "Resolve" : "Reopen";
    $("room-resolve").dataset.op = t.state === "open" ? "resolve" : "reopen";
    $("room-msg").textContent = "";
  }

  $("room-comment").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("room-comment-body").value.trim();
    if (!body || !room) return;
    const r = await api(`/api/work/${encodeURIComponent(room.work_id)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    if (r.ok) { $("room-comment-body").value = ""; await loadRoom(); }
    else $("room-msg").textContent = `Not posted — the console answered ${r.status}. Your message is still here.`;
  });

  // Resolve is a button here and nowhere else: no tool resolves a room and
  // nothing resolves one on a timer (docs/ops/threads.md).
  $("room-resolve").addEventListener("click", async () => {
    if (!room) return;
    const op = $("room-resolve").dataset.op ?? "resolve";
    const r = await api(`/api/work/${encodeURIComponent(room.work_id)}/thread/${op}`, { method: "POST" });
    if (r.ok) await loadRoom();
    else $("room-msg").textContent = op === "resolve" ? "Nothing to resolve yet — a room needs a message first." : `Couldn't reopen it — the console answered ${r.status}.`;
  });

  // ----- projects -----
  let projects = [];
  let blockedBy = new Map();
  let project = null; // the id pushed

  async function loadProjects() {
    const [p, counts, areas] = await Promise.allSettled([
      api("/api/projects").then((r) => r.json()),
      q("board_projects", { limit: 500 }),
      q("areas_overview"),
    ]);
    blockedBy = new Map();
    if (counts.status === "fulfilled") for (const r of counts.value.rows ?? []) if (r.column === "blocked" && r.project) blockedBy.set(String(r.project), asNum(blockedBy.get(String(r.project))) + asNum(r.cards));
    const blockedOf = (id) => (counts.status === "fulfilled" ? blockedBy.get(String(id)) ?? 0 : null);
    if (p.status === "fulfilled") {
      projects = p.value.projects ?? [];
      $("project-rows").innerHTML = projects.length
        ? projects.map((x) => projectRowHtml(x, blockedOf(x.id))).join("")
        : `<li class="empty">No projects yet — one appears the first time a task, an agent or an artifact names one.</li>`;
      $("projects-asof").textContent = p.value.as_of ? `Spend as of ${clockTime(p.value.as_of)}` : "";
    } else {
      $("project-rows").innerHTML = `<li class="muted">Couldn't read the projects.</li>`;
    }
    $("area-rollup").innerHTML = areas.status === "fulfilled" ? areaRollupHtml(areas.value.rows ?? []) : `<li class="muted">Unavailable.</li>`;
    $("areas-asof").textContent = areas.status === "fulfilled" && areas.value.as_of ? `as of ${clockTime(areas.value.as_of)}` : "";
    if (project && !$("project").hidden) paintProject();
  }

  function paintProject() {
    const p = projects.find((x) => x.id === project);
    if (!p) { $("project-body").innerHTML = `<p class="muted">This project is gone.</p>`; return; }
    $("project-body").innerHTML = projectHtml(p, blockedBy.get(p.id) ?? 0);
  }

  $("projects").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.dataset.act !== "project") return;
    project = el.dataset.id;
    const p = projects.find((x) => x.id === project);
    $("project-msg").textContent = "";
    show("project", { title: p?.title ?? project });
  });

  // The kill switch (§4.21): one toggle, confirmed with its consequence named.
  $("project").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.dataset.act !== "mode" || !project) return;
    const to = el.dataset.to;
    const warn = to === "review"
      ? `Set ${project} to Review? Every agent-to-agent review will come to you until you set it back.`
      : `Set ${project} back to Autonomous? Its members will hand work and reviews to each other without you again.`;
    if (!confirm(warn)) return;
    el.disabled = true;
    const r = await api(`/api/projects/${encodeURIComponent(project)}`, { method: "PUT", body: JSON.stringify({ mode: to }) });
    const body = await r.json().catch(() => ({}));
    $("project-msg").textContent = r.ok ? `${project} is now ${to === "review" ? "in Review" : "Autonomous"}.` : `Not changed — ${body.error?.message ?? `the console answered ${r.status}`}`;
    await loadProjects();
    paintProject();
  });

  // ----- artifacts -----
  let art = null; // { id, artifact, versions, version, path, threads }

  async function loadArtifacts() {
    const proj = $("art-project").value.trim();
    const res = await api(`/api/artifacts${proj ? `?project=${encodeURIComponent(proj)}` : ""}`);
    const body = await res.json().catch(() => ({}));
    const artifacts = res.ok ? body.artifacts ?? [] : [];
    $("art-empty").hidden = !res.ok || artifacts.length > 0;
    $("art-list").innerHTML = res.ok
      ? artifacts.map((a) => `<li><button type="button" class="row" data-act="artifact" data-id="${attr(a.id)}"><span class="label"><b>${esc(a.project)}/${esc(a.slug)}</b><span class="sub">${esc(a.kind ?? "")} · ${esc(a.created_by ?? "")} · ${esc(ago(a.updated_at))}</span></span>${glyph("chevron", "chev")}</button></li>`).join("")
      : `<li class="muted">Couldn't list the artifacts — ${esc(body.error?.message ?? `the console answered ${res.status}`)}</li>`;
  }

  $("artifacts").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (el?.dataset.act === "artifact") location.hash = `#/artifacts/${el.dataset.id}`;
  });
  $("art-filter").addEventListener("submit", (e) => { e.preventDefault(); loadArtifacts(); });

  window.addEventListener("hashchange", () => {
    if (artifactRoute(location.hash)) return $("artifact").hidden ? show("artifact") : loadArtifact();
    if (roomRoute(location.hash)) return $("rooms").hidden ? show("rooms") : loadRoom();
  });

  const versionLabel = (versions, id) => {
    const i = versions.findIndex((v) => v.id === id);
    return i === -1 ? String(id ?? "").slice(-8) : `v${versions.length - i}`;
  };
  const kb = (bytes) => { const n = asNum(bytes); return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`; };

  async function loadArtifact() {
    const r = artifactRoute(location.hash);
    if (!r) return show("artifacts");
    const res = await api(`/api/artifacts/${encodeURIComponent(r.id)}`);
    if (!res.ok) {
      $("artifact-state").hidden = false;
      $("artifact-detail").hidden = true;
      $("artifact-state").textContent = res.status === 404 ? "There is no such artifact." : `Couldn't open it — the console answered ${res.status}.`;
      return;
    }
    const { artifact, current } = await res.json();
    const { versions } = await (await api(`/api/artifacts/${encodeURIComponent(r.id)}/versions`)).json();
    const version = versions.find((v) => v.id === r.version) ?? current ?? versions[0] ?? null;
    art = { id: r.id, artifact, versions, version, path: null, threads: [] };
    $("artifact-state").hidden = true;
    $("artifact-detail").hidden = false;
    retitle(`${artifact.project}/${artifact.slug}`);
    $("art-meta").textContent = version
      ? `${versionLabel(versions, version.id)} · ${version.author_principal} · ${ago(version.created_at)} · ${version.message}${version.id === artifact.current_version ? " · current" : ""}`
      : "No versions yet.";
    $("art-version").innerHTML = versions.map((v) => `<option value="${attr(v.id)}">${esc(versionLabel(versions, v.id))} · ${esc(v.author_principal)} · ${esc(new Date(v.created_at).toLocaleDateString())}</option>`).join("");
    if (version) $("art-version").value = version.id;
    const files = version ? Object.keys(version.manifest).sort() : [];
    $("art-file").innerHTML = files.map((f) => `<option value="${attr(f)}">${esc(f)}</option>`).join("");
    const entry = files.find((f) => /^(index\.html|index\.md|README\.md)$/.test(f)) ?? files[0];
    if (!entry) { $("art-viewer").innerHTML = `<p class="muted">This version has no files.</p>`; return; }
    $("art-file").value = entry;
    await openFile(entry);
  }

  async function loadThreads() {
    if (!art?.version) return [];
    const res = await api(`/api/artifacts/${encodeURIComponent(art.id)}/comments?version=${encodeURIComponent(art.version.id)}`);
    art.threads = res.ok ? (await res.json()).threads ?? [] : [];
    return art.threads;
  }

  async function openFile(path) {
    const { id, version, versions, artifact } = art;
    const meta = version.manifest[path] ?? {};
    art.path = path;
    const viewer = $("art-viewer");
    viewer.innerHTML = `<p class="muted">Opening ${esc(artifact.slug)} · ${esc(versionLabel(versions, version.id))} · ${esc(kb(meta.bytes))}</p>`;
    const threads = await loadThreads();
    const byLine = threadsByLine(threads, path);
    let drawn = false; // whether this file's lines were drawn, so its threads could sit on them
    const fileUrl = (raw) => `/api/artifacts/${encodeURIComponent(id)}/versions/${encodeURIComponent(version.id)}/file?path=${encodeURIComponent(path)}${raw ? "&raw=1" : ""}`;
    if (meta.kind === "image") {
      viewer.innerHTML = `<img src="${attr(fileUrl(true))}" alt="${attr(path)}">`; // same-origin raw route: image/* only, no-store, nosniff
    } else if (meta.kind === "pdf" || meta.kind === "binary") {
      viewer.innerHTML = `<a href="${attr(fileUrl(true))}" target="_blank" rel="noopener">${esc(meta.kind === "pdf" ? `Open ${path}` : `Download ${path}`)}</a>`;
    } else {
      const res = await api(fileUrl(false));
      if (!res.ok) {
        const cur = artifact.current_version;
        viewer.innerHTML = res.status === 503
          ? `<p>${esc(path)} at ${esc(versionLabel(versions, version.id))} was replaced on disk, so it can't be shown.</p>${cur && cur !== version.id ? `<p><button type="button" class="secondary" data-act="version" data-version="${attr(cur)}">Show ${esc(versionLabel(versions, cur))}</button></p>` : ""}`
          : `<p class="muted">Unavailable — the console answered ${res.status}.</p>`;
      } else {
        const body = await res.json();
        if (meta.kind === "html") {
          // opaque origin: sandbox with NO tokens (never the same-origin one), CSP inside the document
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "");
          frame.setAttribute("referrerpolicy", "no-referrer");
          frame.setAttribute("title", path);
          frame.className = "art-frame";
          frame.srcdoc = ART_CSP + body.content;
          viewer.replaceChildren(frame);
        } else if (meta.kind === "markdown") {
          viewer.innerHTML = `<div class="art-md">${annotatedMarkdownHtml(body.content ?? "", byLine)}</div>`; // md.js escapes FIRST
          drawn = true;
        } else {
          viewer.innerHTML = `<pre class="art-pre">${annotatedTextHtml(body.content ?? "", byLine)}</pre>`; // every line through esc()
          drawn = true;
        }
      }
    }
    // an HTML page, an image, a PDF — or a file that could not be read: no
    // line to sit on, so every thread is listed below instead
    $("art-others").innerHTML = otherThreadsHtml(threads, path, drawn ? byLine : new Map());
  }

  // The thread sheet: the comments on one line (or one thread), with reply and Resolve.
  let sheetThreads = null; // { lines, ids }
  function openThreads(title, ids) {
    sheetThreads = { ids };
    show("thread", { title });
  }
  function loadThreadSheet() {
    if (!art || !sheetThreads) return;
    const ts = art.threads.filter((t) => sheetThreads.ids.includes(t.id));
    $("art-thread-list").innerHTML = ts.length ? threadSheetHtml(ts) : `<li class="muted">This thread is gone.</li>`;
    $("art-thread-msg").textContent = "";
  }

  $("artifact").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled || !art) return;
    if (el.dataset.act === "thread") {
      const lines = String(el.dataset.lines).split(",").map(Number);
      const byLine = threadsByLine(art.threads, art.path);
      const ts = lines.flatMap((l) => byLine.get(l) ?? []);
      const n = commentCount(ts);
      return openThreads(`${lines.length === 1 ? `Line ${lines[0]}` : `Lines ${lines.join(", ")}`} · ${n} ${n === 1 ? "comment" : "comments"}`, ts.map((t) => t.id));
    }
    if (el.dataset.act === "thread-id") {
      const t = art.threads.find((x) => x.id === el.dataset.thread);
      if (t) return openThreads(`${commentCount([t])} ${commentCount([t]) === 1 ? "comment" : "comments"}`, [t.id]);
    }
    if (el.dataset.act === "version") location.hash = `#/artifacts/${art.id}/${el.dataset.version}`;
  });
  $("art-version").addEventListener("change", () => { if (art) location.hash = `#/artifacts/${art.id}/${$("art-version").value}`; });
  $("art-file").addEventListener("change", () => { if (art) openFile($("art-file").value); });

  $("art-thread").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled || !art) return;
    if (el.dataset.act !== "resolve" && el.dataset.act !== "reopen") return;
    el.disabled = true;
    const r = await api(`/api/artifacts/${encodeURIComponent(art.id)}/comments/${encodeURIComponent(el.dataset.thread)}/${el.dataset.act}`, { method: "POST" });
    if (!r.ok) $("art-thread-msg").textContent = `Not ${el.dataset.act === "resolve" ? "resolved" : "reopened"} — the console answered ${r.status}.`;
    await loadThreads();
    loadThreadSheet();
    if (r.ok) $("art-thread-msg").textContent = el.dataset.act === "resolve" ? "Resolved." : "Reopened.";
  });
  $("art-thread").addEventListener("submit", async (e) => {
    const form = e.target.closest?.("[data-reply]") ?? e.target;
    if (!form?.dataset?.reply || !art) return;
    e.preventDefault();
    const input = form.querySelector("input");
    const body = String(input?.value ?? "").trim();
    if (!body) return;
    const r = await api(`/api/artifacts/${encodeURIComponent(art.id)}/comments`, { method: "POST", body: JSON.stringify({ parent: form.dataset.reply, body }) });
    if (!r.ok) { $("art-thread-msg").textContent = `Not sent — the console answered ${r.status}. Your reply is still here.`; return; }
    await loadThreads();
    loadThreadSheet();
  });

  $("art-comment").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("art-comment-body").value.trim();
    if (!body || !art?.version) return;
    const r = await api(`/api/artifacts/${encodeURIComponent(art.id)}/comments`, { method: "POST", body: JSON.stringify({ version: art.version.id, body }) });
    if (r.ok) { $("art-comment-body").value = ""; await openFile(art.path); }
    else $("art-dispatch-msg").textContent = `Not posted — the console answered ${r.status}.`;
  });

  // Send the open threads to an agent as one review task (§4.21 dispatch).
  $("art-dispatch").addEventListener("submit", async (e) => {
    e.preventDefault();
    const thread_ids = (art?.threads ?? []).filter((t) => t.state === "open").map((t) => t.id);
    const to_agent = $("art-dispatch-to").value.trim();
    if (!art?.version || !thread_ids.length || !to_agent) { $("art-dispatch-msg").textContent = "Name an agent — and there has to be an open comment to send."; return; }
    const r = await api("/api/dispatches", { method: "POST", body: JSON.stringify({ artifact: art.id, version: art.version.id, thread_ids, to_agent }) });
    const body = await r.json().catch(() => ({}));
    $("art-dispatch-msg").textContent = r.ok
      ? body.route === "work"
        ? `Review task #${body.work.id} ${body.queued ? `queued for ${to_agent} (${body.queued.reason} ${body.queued.open}/${body.queued.cap})` : `created for ${to_agent}`}.`
        : `Queued as request #${body.proposal_id} (${body.reason ?? "outside the project"}).`
      : `Not sent — ${body.error?.message ?? r.status}`;
  });

  // The sheet goes away with the section still hooked: nothing to tidy but the step.
  $("sheet").addEventListener("close", () => { moving = null; });

  return {
    board,
    card: loadCard,
    move: loadMove,
    rooms: loadRoom,
    projects: loadProjects,
    project: paintProject,
    artifacts: loadArtifacts,
    artifact: loadArtifact,
    thread: loadThreadSheet,
    openCard,
    openMove,
    get shown() { return shown; },
    get rows() { return rows; },
  };
}
