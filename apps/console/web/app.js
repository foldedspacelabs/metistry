// PWA shell — vanilla, no framework (recipes over frameworks). Auth via
// passkeys; API calls carry the session cookie. Drafts survive re-auth:
// the composer stashes to localStorage and replays after sign-in.

import { renderMarkdown } from "./md.js";
// Shared, DOM-free helpers; each view that has its own file imports them too.
import { attr, clockTime, dateTime, esc, scopeOf } from "./lib.js";
// The views split out of this file (T7-3a, screen 18 §2–§3), mounted below
// with the shell's doors: this file is the shell, and imports them; they
// never import it.
import { mountNeedsYou } from "./needs-you.js";
import { mountToday } from "./today.js";
// The live-changes stream and the polls it stands in for (T7-7, §2.20).
import { EVENTS_CAPABILITY, createLive, createRefresher, viewsFor } from "./live.js";

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
const enrollCode = new URLSearchParams(location.hash.slice(1)).get("enroll");

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...opts.headers } });
  if (res.status === 401) { showAuth(); throw new Error("unauthenticated"); }
  return res;
}

// ===== the shell (screen 18 §1; design-build-plan §2.17) =====
// Under 900px: five tabs — Today · Chat · Work · Knowledge · More — with + and
// the bell in the header, and the usage gauge beside them from 600px. At 900px
// the PWA is the Mac layout: the sidebar in the Mac's order, + and the gauge,
// and the Needs You row in place of the bell (C110).
//
// Every view names its tab, its title, the sections it shows and how it
// arrives: in place, as a push (`back` names where the back button returns),
// or in the sheet. Nothing conditional is a tab, so no tab carries a badge;
// the count lives on the bell and the Needs You row and nowhere else (P2).
const TABS = ["today", "chat", "work", "knowledge", "more"];
const HOME = "today";
const VIEWS = {
  today: { tab: "today", title: "Today", sections: ["today"] },
  chat: { tab: "chat", title: "Chat", sections: ["chat"] },
  board: { tab: "work", title: "Work", sections: ["board"], segment: true },
  projects: { tab: "work", title: "Work", sections: ["projects"], segment: true },
  artifacts: { tab: "work", title: "Work", sections: ["artifacts"], segment: true },
  rooms: { tab: "work", title: "Room", sections: ["rooms"], back: "board" },
  knowledge: { tab: "knowledge", title: "Knowledge", sections: ["knowledge"] },
  more: { tab: "more", title: "More", sections: ["more"] },
  feed: { tab: "more", title: "Activity", sections: ["feed"], back: "more" },
  agents: { tab: "more", title: "Agents", sections: ["agents"], back: "more" },
  settings: { tab: "more", title: "Settings", sections: ["status", "devices"], back: "more" },
  // The bell's sheet under 900px; at 900px a view, reached from its sidebar row.
  triage: { tab: null, title: "Needs You", sections: ["triage"], sheet: "narrow" },
  capture: { tab: null, title: "Capture", sections: ["capture"], sheet: "always" },
  usage: { tab: null, title: "Usage", sections: ["usage"], sheet: "always" },
};
const SECTIONS = [...new Set(Object.values(VIEWS).flatMap((v) => v.sections))];

const WIDE = window.matchMedia("(min-width: 900px)");
let current = null; // the view in place; a sheet sits over it
let beneath = HOME; // the last view in place that was not Needs You
let sheetView = null; // the view the sheet has borrowed, while it is open
let lastWork = "board"; // the Work tab and row return to the child left open
let signedIn = false;

/** `work` is the Work tab or row: the child last open. An unknown name is home. */
const resolveView = (view) => (view === "work" ? lastWork : Object.hasOwn(VIEWS, view) ? view : HOME);
/** Whether a view arrives in the sheet at this width. */
const inSheet = (v, wide) => v.sheet === "always" || (v.sheet === "narrow" && !wide);
/**
 * Where the back button goes, if anywhere. At 900px More is the sidebar, so
 * its rows are places of their own and nothing pushes back to it.
 */
const backFor = (v, wide) => (v.back && !(wide && v.back === "more") ? v.back : null);

/** Go to a view: in place, or in the sheet. Every door in the shell calls this. */
function show(view) {
  view = resolveView(view);
  const v = VIEWS[view];
  if (inSheet(v, WIDE.matches)) return openSheet(view);
  closeSheet();
  signedIn = true;
  chrome(true);
  const moved = view !== current;
  current = view;
  if (view !== "triage") beneath = view;
  if (v.segment) lastWork = view;
  $("auth").hidden = true;
  for (const id of SECTIONS) $(id).hidden = !v.sections.includes(id);
  dropRouteHash(view);
  paintShell();
  if (moved) window.scrollTo(0, 0);
  loadView(view);
}

function loadView(view) {
  ({ today: today.load, feed: loadFeedView, chat: loadMessages, board: loadBoardView, projects: loadProjects, artifacts: loadArtifacts, rooms: loadRooms, settings: loadSettings, triage: needsYou.load, agents: loadAgents, usage: loadUsage }[view] ?? (() => {}))();
}

// A room or an artifact link lives in the hash; leaving that view drops it, so
// the same card opens its room again the next time it is tapped.
function dropRouteHash(view) {
  const h = location.hash;
  if ((h.startsWith("#/rooms/") && view !== "rooms") || (h.startsWith("#/artifacts/") && view !== "artifacts")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

/** The chrome follows the view in place: tabs, sidebar, segments, titles, back. */
function paintShell() {
  const v = VIEWS[current];
  if (!v) return;
  for (const b of document.querySelectorAll("#tabs [data-tab]")) mark(b, b.dataset.tab === v.tab);
  // the page is marked; the Work row is open over its children, not the page itself
  for (const b of document.querySelectorAll("#sidebar [data-view]")) mark(b, b.dataset.view === current);
  $("side-work-row").setAttribute("aria-expanded", String(v.tab === "work"));
  for (const b of document.querySelectorAll("#work-seg [data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === current));
  $("side-work").classList.toggle("open", v.tab === "work");
  $("work-seg").hidden = !v.segment;
  $("title").textContent = v.title;
  $("bar-title").textContent = v.title;
  const back = backFor(v, WIDE.matches);
  $("back").hidden = !back;
  if (back) {
    $("back").dataset.view = back;
    $("back-label").textContent = VIEWS[back].title;
    $("back").setAttribute("aria-label", `Back to ${VIEWS[back].title}`);
  }
  paintNeeds(true);
}

function mark(b, on) {
  if (on) b.setAttribute("aria-current", "page");
  else b.removeAttribute("aria-current");
}

function chrome(on) {
  for (const id of ["tabs", "sidebar", "bar-actions"]) $(id).hidden = !on;
}

function showAuth() {
  signedIn = false;
  live.stop(); // no stream and no poll while signed out; signing in starts both again
  closeSheet();
  current = null;
  chrome(false);
  for (const id of SECTIONS) $(id).hidden = true;
  $("work-seg").hidden = true;
  $("back").hidden = true;
  $("title").textContent = "Metistry";
  $("bar-title").textContent = "";
  $("auth").hidden = false;
  $("enroll-btn").hidden = !enrollCode;
  if (enrollCode) $("auth-msg").textContent = "enroll this device (one-time code detected)";
}

// ----- the sheet: the bell's Needs You, Capture and Usage (screen 18 §1) -----
// One native modal <dialog>, which borrows the view's own section while it is
// open and puts it back in <main> when it closes — Done, Esc or a tap on the
// scrim. The section keeps its ids and handlers wherever it sits.
function openSheet(view) {
  if (sheetView === view) return;
  restoreSheet();
  const v = VIEWS[view];
  const section = $(v.sections[0]);
  sheetView = view;
  $("sheet-title").textContent = v.title;
  $("sheet-body").append(section);
  section.hidden = false;
  if (!$("sheet").open) $("sheet").showModal();
  loadView(view);
}

function restoreSheet() {
  if (!sheetView) return;
  const section = $(VIEWS[sheetView].sections[0]);
  section.hidden = true;
  $("main").append(section);
  sheetView = null;
}

function closeSheet() {
  restoreSheet();
  if ($("sheet").open) $("sheet").close();
}

// Esc closes the dialog natively; the section goes home either way. The event
// is queued, so a sheet opened again before it fires is left where it is.
$("sheet").addEventListener("close", () => { if (!$("sheet").open) restoreSheet(); });
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
$("sheet-done").onclick = () => closeSheet();

// ----- the one count (P2, C110) -----
// The number of requests waiting: on the bell under 900px, on the Needs You
// row at 900px, and on no tab at any width. The row exists while something
// waits; with the count at zero it leaves on the next navigation, never while
// the owner is on it.
let needsCount = null; // null until the server has answered once
function needsBadge(count) {
  const n = Math.max(0, Math.trunc(Number(count)) || 0);
  return { n, text: n ? String(n) : "", label: n ? `Needs You, ${n} waiting` : "Needs You" };
}

function paintNeeds(navigating = false) {
  const b = needsBadge(needsCount ?? 0);
  for (const el of document.querySelectorAll("[data-needs-count]")) {
    el.textContent = b.text;
    el.hidden = !b.n;
  }
  $("bell").setAttribute("aria-label", b.label);
  const row = $("side-needs");
  row.setAttribute("aria-label", b.label);
  if (b.n) row.hidden = false;
  else if (navigating && current !== "triage") row.hidden = true;
}

/** A new count. The badge announces a change once, and not while the owner is on it. */
function setNeeds(count) {
  const n = needsBadge(count).n;
  const changed = needsCount !== null && n !== needsCount;
  needsCount = n;
  paintNeeds();
  if (changed && current !== "triage" && sheetView !== "triage") $("needs-announce").textContent = needsBadge(n).label;
}

// T1-7's own route: `waiting`, the same pending-and-not-snoozed filter as
// the queue itself, without paging the whole thing in on a 30s poll (or on
// every tab regaining focus) just to learn its length.
async function refreshNeeds() {
  const { waiting } = await (await api("/api/needs-you/count")).json();
  setNeeds(waiting);
}

// The fallback while the stream is down: `needs_you.changed` carries the count
// while it is up, and this timer does not run (live.js).
function watchNeeds(intervalMs = 30000) {
  refreshNeeds().catch(() => {});
  live.poll("needs", () => {
    if (signedIn && document.visibilityState === "visible") refreshNeeds().catch(() => {});
  }, intervalMs);
}
document.addEventListener("visibilitychange", () => {
  if (signedIn && document.visibilityState === "visible") refreshNeeds().catch(() => {});
});

// Crossing 900px moves Needs You between the sheet and a view in place.
WIDE.addEventListener("change", () => {
  if (!signedIn || !current) return;
  if (WIDE.matches && sheetView === "triage") show("triage");
  else if (!WIDE.matches && current === "triage") { show(beneath); show("triage"); }
  else paintShell();
});

// The large title collapses into the header once it scrolls under it.
if ("IntersectionObserver" in window) {
  new IntersectionObserver(
    ([e]) => document.body.classList.toggle("title-collapsed", !e.isIntersecting),
    { rootMargin: `-${$("bar").offsetHeight}px 0px 0px 0px` },
  ).observe($("title"));
}

for (const b of document.querySelectorAll("#tabs [data-tab]")) b.onclick = () => show(b.dataset.tab);
for (const b of document.querySelectorAll("#sidebar [data-view], #work-seg [data-view], #more [data-view]")) b.onclick = () => show(b.dataset.view);
$("back").onclick = () => show($("back").dataset.view);
$("capture-btn").onclick = () => show("capture");
$("bell").onclick = () => show("triage");
$("usage-btn").onclick = () => show("usage");

// ----- auth -----
$("enroll-btn").onclick = async () => {
  const start = await fetch("/auth/enroll/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode }) });
  if (!start.ok) return alert("code invalid or expired — mint a new one on the host");
  const { options } = await start.json();
  const response = await startRegistration({ optionsJSON: options });
  const label = prompt("name this device (e.g. Matt's iPhone)", "device") ?? "device";
  const fin = await fetch("/auth/enroll/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode, label, response }) });
  if (fin.ok) { history.replaceState(null, "", "/"); show(HOME); goLive(); } else alert("enrollment failed");
};

$("login-btn").onclick = async () => {
  const start = await fetch("/auth/login/start", { method: "POST" });
  const { key, options } = await start.json();
  const response = await startAuthentication({ optionsJSON: options });
  const fin = await fetch("/auth/login/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, response }) });
  if (fin.ok) { show(hasDraft() ? "chat" : HOME); replayDraft(); goLive(); } else alert("sign-in failed");
};

// ----- chat -----
// P9 (docs/product/design-system.md): the transcript never moves under the
// reader. A poll is a repaint, not a navigation — so the list scrolls ONLY
// when the reader was already at the bottom. Scrolled up (re-reading the
// agent's last answer while typing the reply) means: keep scrollTop exactly
// where it was, and raise the "New Reply" pill instead. Focusing the composer
// scrolls nothing — there is no scrollIntoView anywhere in this file.
const BOTTOM_SLACK_PX = 48; // within this of the end still counts as "at the bottom"
let lastRender = "";
let lastCount = 0;
let atBottom = true;

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
const showPill = (on) => { $("new-reply-row").hidden = !on; };

function scrollToLatest() {
  const list = $("messages");
  list.scrollTop = list.scrollHeight;
  atBottom = true;
  showPill(false);
}

$("messages").addEventListener("scroll", () => {
  atBottom = nearBottom($("messages"));
  if (atBottom) showPill(false); // caught up by hand — the pill has nothing left to say
}, { passive: true });
$("new-reply").onclick = scrollToLatest;

// A blank line in the wire text becomes a 12px margin, not an empty line box
// (design-system.md §4). At 15pt/1.45 an empty line is ~22px — a third of a
// paragraph's worth of space spent on nothing, twice per reply. Single
// newlines inside a paragraph keep their break: each <p> is still pre-wrap.
//
// esc() runs on the TEXT, before any markup exists (CRIT-7, P1): the only
// tags that can come out of here are the <p> this function writes.
function replyParagraphs(text) {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
}

// Clock times are 12-hour with AM/PM, always (design-system-amendments
// §8.1): `clockTime` and `dateTime` live in lib.js, which every view shares.

// Agent prose is set in the serif (C32, C35 — style.css `.agent-prose`), so it
// reads as the assistant's before a word of it is read, and it still says so
// once quoted out of the app. Only for a body an agent wrote: the owner's own
// comment stays in the interface face.
function bodyClass(c) {
  return c?.author_kind === "agent" ? "body agent-prose" : "body";
}

// The tier this message ran at — the name from the instance's `tiers:` block
// (a model + an effort). Shown, not chosen: there is no picker in the composer
// yet, so this is the record of what the router decided. `esc()` because a
// tier name comes from the instance's own rules.yaml, and nothing that reaches
// markup here goes un-escaped.
function tierChip(m) {
  return m.tier ? ` <span class="chip" title="tier (model + effort)">${esc(m.tier)}</span>` : "";
}

async function loadMessages() {
  const res = await api("/api/messages?limit=30");
  const { messages } = await res.json();
  const chrono = messages.reverse();
  const fingerprint = JSON.stringify(chrono.map((m) => [m.direction, m.id, m.status, m.tier ?? "", m.feedback?.rating ?? 0]));
  if (fingerprint === lastRender) return; // no flicker on idle polls
  const firstPaint = lastRender === "";
  const arrived = !firstPaint && chrono.length > lastCount;
  lastRender = fingerprint;
  lastCount = chrono.length;
  const list = $("messages");
  const wasAtBottom = firstPaint || atBottom;
  const keepScrollTop = list.scrollTop; // measured before the re-render, restored after
  list.innerHTML = chrono
    .map((m) => `<li class="${m.direction}"><div class="meta">${dateTime(m.ts)}${m.direction === "in" ? ` · ${m.status}` : ""}${tierChip(m)}</div>${replyParagraphs(m.text)}${m.direction === "out" ? tapbacks(m) : ""}</li>`)
    .join("");
  wireTapbacks();
  if (wasAtBottom) {
    scrollToLatest();
  } else {
    list.scrollTop = keepScrollTop; // the viewport does not move
    if (arrived) showPill(true);
  }
}

// ----- reply quality: a tapback on any reply (docs/ops/reply-feedback.md).
// Two buttons and an optional one-line note; tapping the lit one clears it.
function tapbacks(m) {
  const r = m.feedback?.rating;
  return `<div class="meta fb">
    <button data-fb="${m.id}" data-r="1" class="${r === 1 ? "on" : ""}" aria-label="good reply">👍</button>
    <button data-fb="${m.id}" data-r="-1" class="${r === -1 ? "on" : ""}" aria-label="bad reply">👎</button>
    ${m.feedback?.note ? `<span>${esc(m.feedback.note)}</span>` : ""}</div>`;
}

function wireTapbacks() {
  document.querySelectorAll("[data-fb]").forEach((b) => (b.onclick = async () => {
    const path = `/api/messages/${b.dataset.fb}/feedback`;
    if (b.classList.contains("on")) await api(path, { method: "DELETE" });
    else {
      const rating = Number(b.dataset.r);
      const note = rating === -1 ? (prompt("what was wrong with it? (optional)") ?? "") : "";
      await api(path, { method: "POST", body: JSON.stringify({ rating, note }) });
    }
    lastRender = "";
    loadMessages();
  }));
}

// live updates: `message.new` and `turn.progress` while the stream is up;
// while it is down, poll while the chat is visible, and burst after a send
function pollChat(intervalMs = 2500) {
  live.poll("chat", () => {
    if (!$("chat").hidden && document.visibilityState === "visible") loadMessages().catch(() => {});
  }, intervalMs);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("chat").hidden) loadMessages().catch(() => {});
});

$("send-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("send-text").value.trim();
  if (!text) return;
  localStorage.setItem("draft", text); // survives a re-auth bounce
  try {
    await api("/message", { method: "POST", body: JSON.stringify({ text }) });
    localStorage.removeItem("draft");
    $("send-text").value = "";
    atBottom = true; // sending is an explicit intent to be at the end of the thread
    $("composer-actions").open = false; // 3.6: the menu never survives a send
    closeSuggest(); // nor does the suggestion list
    loadMessages();
    pollChat(1000); // burst while the reply is in flight
    setTimeout(() => pollChat(), 20000);
  } catch {}
};

// ----- §3.6 composer: insertion at the caret, and autocomplete -----
//
// Two renderings of ONE generated list. The menu is the browsable one, the
// suggestion listbox is the same list filtered by what you are typing. Both
// INSERT and neither SENDS: a command tapped in the menu and a command typed
// by hand must produce the identical string, or the two paths diverge and only
// one of them ever gets tested.

// Commands come from THIS instance's rules.yaml, never from a list kept by
// hand (§3.6, ux-direction.md "Discoverability is generated, not
// hand-maintained"). The array that used to sit here was a labelled
// placeholder, and any instance whose rules.yaml differed from the shipped
// defaults was misinformed by it; `GET /api/commands` is the generated list
// (docs/ops/console-api.md). Do not reintroduce a literal — a command the
// menu offers and the router does not route is worse than one it omits.
let composerCommands = [];
let composerCommandsAt = 0;
async function refreshComposerCommands() {
  if (Date.now() - composerCommandsAt < 30000 && composerCommands.length) return composerCommands;
  try {
    const { commands } = await (await api("/api/commands")).json();
    composerCommands = commands.map((c) => ({ id: c.id, desc: c.description }));
    composerCommandsAt = Date.now();
  } catch {} // P5: a source that cannot answer says nothing rather than guessing
  return composerCommands;
}

// Agents come from the registry, never from a list kept by hand (§3.6).
let composerAgents = [];
let composerAgentsAt = 0;
async function refreshComposerAgents() {
  if (Date.now() - composerAgentsAt < 30000 && composerAgents.length) return composerAgents;
  try {
    const { agents } = await (await api("/api/agents")).json();
    composerAgents = agents
      .filter((a) => !a.revoked)
      .map((a) => ({ id: `@${a.id}`, desc: a.display_name ?? a.kind ?? "" }));
    composerAgentsAt = Date.now();
  } catch {} // P5: a source that cannot answer says nothing rather than guessing
  return composerAgents;
}

// Deterministic ranking (§3.6, and the same discipline invariant 4 applies to
// the router): prefix match, then substring, then recency, ties broken by id.
// No model, and no reordering between keystrokes that the user did not cause.
let recentInserts = [];
try { recentInserts = JSON.parse(localStorage.getItem("composer-recent") ?? "[]"); } catch {}
const noteRecent = (id) => {
  recentInserts = [id, ...recentInserts.filter((x) => x !== id)].slice(0, 20);
  try { localStorage.setItem("composer-recent", JSON.stringify(recentInserts)); } catch {}
};
function rank(items, token) {
  const q = token.slice(1).toLowerCase(); // drop the leading @ or /
  const scored = [];
  for (const it of items) {
    const name = it.id.slice(1).toLowerCase();
    let tier;
    if (!q) tier = 2; // bare trigger: everything, ordered by recency then id
    else if (name.startsWith(q)) tier = 0;
    else if (name.includes(q)) tier = 1;
    else continue;
    const r = recentInserts.indexOf(it.id);
    scored.push({ ...it, tier, recent: r === -1 ? Number.MAX_SAFE_INTEGER : r });
  }
  scored.sort((a, b) => a.tier - b.tier || a.recent - b.recent || a.id.localeCompare(b.id));
  return scored;
}

// Insert `text` at the caret, leave the caret after it and a single space, and
// give focus back to the field. Never sends, never scrolls (P9).
function insertAtCaret(field, text) {
  const v = field.value;
  const start = field.selectionStart ?? v.length;
  const end = field.selectionEnd ?? start;
  const before = v.slice(0, start);
  const after = v.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const body = `${lead}${text}`;
  const trail = /^\s/.test(after) ? "" : " ";
  field.value = `${before}${body}${trail}${after}`;
  const caret = before.length + body.length + trail.length;
  field.focus({ preventScroll: true }); // P9: focus never moves the transcript
  field.setSelectionRange(caret, caret);
}

// Replace the token the caret sits in (the `@d` you were typing) with the
// chosen id. Only that token — never text the user typed around it.
function replaceToken(field, tok, text) {
  const v = field.value;
  const after = v.slice(tok.end);
  const trail = /^\s/.test(after) ? "" : " ";
  field.value = `${v.slice(0, tok.start)}${text}${trail}${after}`;
  const caret = tok.start + text.length + trail.length;
  field.focus({ preventScroll: true });
  field.setSelectionRange(caret, caret);
}

// The token under the caret, if it is a trigger. `@` or `/` counts only at the
// start of the field or after whitespace — so `foo@bar` and a path like
// `docs/product` never open the list — and the token ends at the next space.
function triggerToken(field) {
  const caret = field.selectionStart ?? field.value.length;
  const head = field.value.slice(0, caret);
  const m = /(^|\s)([@/][^\s]*)$/.exec(head);
  if (!m) return null;
  return { text: m[2], start: caret - m[2].length, end: caret };
}

let suggestItems = [];
let suggestIndex = -1;

function closeSuggest() {
  suggestItems = [];
  suggestIndex = -1;
  $("suggest").hidden = true;
  $("suggest").innerHTML = "";
  $("send-text").setAttribute("aria-expanded", "false");
  $("send-text").removeAttribute("aria-activedescendant");
}

const SUGGEST_MAX = 6; // §3.6: six rows, so it never becomes a second transcript

function paintSuggest() {
  const ul = $("suggest");
  ul.innerHTML =
    suggestItems
      .map(
        (it, i) =>
          `<li id="sug-${i}" role="option" aria-selected="${i === suggestIndex}" data-i="${i}">` +
          `<b>${esc(it.id)}</b>${it.desc ? `<span class="d">${esc(it.desc)}</span>` : ""}</li>`,
      )
      .join("") + `<li class="rank" aria-hidden="true">prefix → substring → recency</li>`;
  ul.hidden = false;
  $("send-text").setAttribute("aria-expanded", "true");
  if (suggestIndex >= 0) $("send-text").setAttribute("aria-activedescendant", `sug-${suggestIndex}`);
  else $("send-text").removeAttribute("aria-activedescendant");
}

async function updateSuggest() {
  const field = $("send-text");
  const tok = triggerToken(field);
  if (!tok) return closeSuggest();
  const source = tok.text.startsWith("@") ? await refreshComposerAgents() : await refreshComposerCommands();
  const hits = rank(source, tok.text);
  // Typing something that matches nothing closes the list rather than showing
  // an empty box: the user is mid-sentence, not mid-search.
  if (!hits.length) return closeSuggest();
  suggestItems = hits.slice(0, SUGGEST_MAX);
  suggestIndex = 0;
  paintSuggest();
}

function acceptSuggest() {
  const field = $("send-text");
  const it = suggestItems[suggestIndex];
  const tok = triggerToken(field);
  if (!it || !tok) return false;
  noteRecent(it.id);
  replaceToken(field, tok, it.id);
  closeSuggest();
  return true;
}

$("send-text").addEventListener("input", () => { updateSuggest().catch(() => {}); });
$("send-text").addEventListener("click", () => { updateSuggest().catch(() => {}); });
$("send-text").addEventListener("blur", () => { setTimeout(closeSuggest, 120); }); // after a tap lands
$("send-text").addEventListener("keydown", (e) => {
  if ($("suggest").hidden) {
    // Esc with no list up: let the field keep the text and just blur.
    if (e.key === "Escape") $("send-text").blur();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const d = e.key === "ArrowDown" ? 1 : -1;
    suggestIndex = (suggestIndex + d + suggestItems.length) % suggestItems.length;
    paintSuggest();
  } else if (e.key === "Enter" || e.key === "Tab") {
    // Enter inserts the selection instead of sending — the one keystroke the
    // list borrows, and only while it is open with something selected.
    if (acceptSuggest()) e.preventDefault();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSuggest(); // closes without changing the text; a second Esc blurs
  }
});
$("suggest").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  e.preventDefault(); // keep focus on the field so the caret survives the tap
  suggestIndex = Number(li.dataset.i);
  acceptSuggest();
});

// The actions menu opens with no JS (it is a <details>); these handlers only
// insert at the caret, jump to a view, or keep the generated lists fresh.
$("composer-sheet").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.insert !== undefined) {
    // §3.6: menu items insert themselves AT THE CARET. They do not replace the
    // field and they do not send — a half-written reply survives the tap.
    closeSuggest();
    noteRecent(b.dataset.insert.trim());
    insertAtCaret($("send-text"), b.dataset.insert.trim());
    $("composer-actions").open = false;
  } else if (b.dataset.goto) {
    $("composer-actions").open = false;
    show(b.dataset.goto);
  }
});

$("composer-actions").addEventListener("toggle", async () => {
  if (!$("composer-actions").open) return;
  closeSuggest(); // the two never share the space above the field
  const commands = await refreshComposerCommands();
  $("composer-commands").innerHTML = commands.length
    ? commands.map((c) => `<button type="button" data-insert="${esc(c.id)} " title="${esc(c.desc)}">${esc(c.id)}</button>`).join("")
    : '<span class="muted">no commands — this instance\'s rules.yaml could not be read</span>';
  const agents = await refreshComposerAgents();
  $("composer-agents").innerHTML = agents.length
    ? agents.map((a) => `<button type="button" data-insert="${esc(a.id)} ">${esc(a.id)}</button>`).join("")
    : '<span class="muted">no agents registered</span>';
});

function replayDraft() {
  try { const d = localStorage.getItem("draft"); if (d) $("send-text").value = d; } catch {}
}
function hasDraft() {
  try { return Boolean(localStorage.getItem("draft")); } catch { return false; }
}

// ----- capture -----
$("capture-form").onsubmit = async (e) => {
  e.preventDefault();
  const file = $("capture-file").files[0];
  let res;
  if (file) {
    res = await fetch("/capture", { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-metistry-filename": file.name }, body: file });
    if (res.status === 401) { showAuth(); return; }
  } else {
    res = await api("/capture", { method: "POST", body: JSON.stringify({ note: $("capture-note").value }) });
  }
  const body = await res.json();
  $("capture-result").textContent = res.ok ? `captured → inbox #${body.id}` : "capture failed";
  $("capture-note").value = ""; $("capture-file").value = "";
};

// ----- status + push -----
// The four states of core's check() contract, each its own word and its own
// ink (P5, design-system §3.13). `absent` is "not configured" — a fact, not a
// fault — so it never reads as `failed`, and `degraded` (answering, not
// healthy) never reads as either (C10). A word outside the contract is shown
// as it came, in the neutral ink: never a guess at a colour.
const CHECK_STATES = ["ok", "degraded", "failed", "absent"];
const CHECK_WORD = { ok: "ok", degraded: "degraded", failed: "failed", absent: "not configured" };
function checkRowHtml(c) {
  const known = CHECK_STATES.includes(c.status);
  return `<li><span>${esc(c.name)} <span class="muted">${esc(c.probe)}</span></span><span class="${known ? c.status : "absent"}">${esc(known ? CHECK_WORD[c.status] : c.status)} · ${esc(String(c.latency_ms))}ms</span></li>`;
}
// The line above the rows, so the page answers before it is read: "9 ok ·
// 1 degraded · 2 not configured", or that everything is healthy.
function checksSummary(checks) {
  if (checks.length === 0) return "no checks reported";
  const n = (s) => checks.filter((c) => c.status === s).length;
  if (n("ok") === checks.length) return `all ${checks.length} healthy`;
  const other = checks.length - CHECK_STATES.reduce((t, s) => t + n(s), 0);
  return [...CHECK_STATES.map((s) => [n(s), CHECK_WORD[s]]), [other, "unrecognised"]]
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(" · ");
}

async function loadStatus() {
  const res = await api("/api/status");
  const { checks } = await res.json();
  $("checks").innerHTML = `<li class="checks-summary">${esc(checksSummary(checks))}</li>` + checks.map(checkRowHtml).join("");
  // one review list across every configured repo (github-state → prs_for_review)
  const { rows } = await (await api("/api/q/prs_for_review")).json();
  $("reviews").innerHTML = reviewListHtml(rows); // shared with the dashboard panel
}

$("push-enable").onclick = async () => {
  try {
    // iOS allows web push only from the installed Home Screen app
    if (!window.matchMedia("(display-mode: standalone)").matches && navigator.standalone !== true) {
      return alert("open the Home Screen app to enable notifications — iOS doesn't allow push from a Safari tab");
    }
    if (!("Notification" in window) || !("PushManager" in window)) return alert("push not supported here");
    const perm = await Notification.requestPermission(); // must be in the tap gesture
    if (perm !== "granted") return alert(`notification permission: ${perm} — check Settings > Notifications > metistry`);
    const reg = await navigator.serviceWorker.register("/sw.js"); // explicit; don't hang on .ready
    const { key, push } = await (await api("/api/push/vapid-key")).json();
    if (push === "absent") return alert("server has no VAPID keys configured");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub }) });
    alert("subscribed — try test push");
  } catch (err) {
    alert(`push setup failed: ${err?.message ?? err}`);
  }
};

$("push-test").onclick = async () => {
  const { result } = await (await api("/api/push/test", { method: "POST" })).json();
  if (result !== "sent") alert(`push: ${result}`);
};

// ----- Today and Needs You: their own files (T7-3a; screen 18 §2–§3) -----
// Mounted with the shell's doors; `loadView` calls their `load`.
const today = mountToday({ $, api, show });
const needsYou = mountNeedsYou({ $, api, setNeeds, show });

// ----- devices -----
async function loadDevices() {
  const res = await api("/api/devices");
  const { devices } = await res.json();
  $("device-list").innerHTML = devices
    .map((d) => `<li><span>${esc(d.label)} <span class="muted">seen ${new Date(d.last_seen_at).toLocaleDateString()}</span></span>
      ${d.revoked ? '<span class="muted">revoked</span>' : `<button data-revoke="${d.id}">revoke</button>`}</li>`)
    .join("");
  document.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => {
    if (confirm("revoke this device session?")) { await api(`/api/devices/${b.dataset.revoke}/revoke`, { method: "POST" }); loadDevices(); }
  }));
}

// esc() and attr(): lib.js — every server value reaches markup through one of them (CRIT-7).

// ----- agents (external-agent registry; every agent-authored field output-encoded — CRIT-7) -----
// The token is shown exactly once, at mint/rotate; the list never carries it.
// One noun per thing (glossary.md): every agent shows a ROLE — assistant (this
// instance's own), helper (one the user defined under agents/), external —
// and an ACCESS tier read as none / titles / folders. Both are labels over
// the stored values (kind internal|external, tier none|index|areas), which do
// not change.
const ROLE_LABEL = { internal: "assistant", external: "external", crew: "helper" };
// **The effective action table is the SERVER's** (§2.17). Every agent row on
// `GET /api/agents` carries `scope.autonomy` — the level, and `detailed`: each
// kind's mode with WHY (set, defaulted, or clamped to the level's ceiling),
// resolved once by core's `effectiveActionsDetailed`. This panel prints it and
// computes nothing: it used to hold a copy of the defaults, the ceilings and
// the clamp, which is a second implementation of a rule free to drift from
// the one the tool enforces.
//
// What is left here is words. ACTION_MODE_LABEL is the CLI's MODE_LABEL
// (packages/cli/src/agents.ts), and `actionEntryText` says a row the way
// `metistry agents autonomy` does, so the phone and the terminal print the
// same table — a test holds the two to it (apps/console/test/pwa-reads.test.ts).
const ACTION_MODE_LABEL = { allow: "Allow", propose: "Ask First", deny: "Never" };
const modeWord = (m) => ACTION_MODE_LABEL[m] ?? String(m ?? "");
function actionEntryText(entry, level) {
  const word = modeWord(entry.mode);
  if (entry.source === "clamped") return `${word} (asked ${modeWord(entry.asked)} — ${level}'s ceiling is ${word})`;
  if (entry.source === "defaulted") return `${word} (default for ${level})`;
  return word;
}
// The table as rows, in the server's order (the enum's). `null` when the row
// carries no table: said as unavailable, never filled in with a guess (P5).
function actionTableRows(scope) {
  const au = scope?.autonomy;
  if (!au?.level || !au.detailed || typeof au.detailed !== "object") return null;
  return Object.entries(au.detailed).map(([kind, entry]) => ({ kind, source: entry?.source, text: actionEntryText(entry ?? {}, au.level) }));
}
function actionTableHtml(scope) {
  const rows = actionTableRows(scope);
  if (!rows) return `<span class="muted">actions: unavailable</span>`;
  return `<span class="action-table" role="list" aria-label="actions">
    <span class="muted" role="listitem">level: ${esc(scope.autonomy.level)}</span>
    ${rows.map((r) => `<span class="action-row ${esc(r.source ?? "")}" role="listitem"><span class="mono">${esc(r.kind)}</span> ${esc(r.text)}</span>`).join("")}
  </span>`;
}
// **The permissions table is the SERVER's** (T4-6): every agent row on
// `GET /api/agents` carries `permissions` — Resource × Read × Write, drawn by
// core's `describePermissions`, which asks the same `may()` the doors ask.
// This panel prints each cell in the words core's `permissionRowText` gives
// the CLI (`metistry agents list`) and MetistryKit gives the Mac app — a test
// holds the three to one table (apps/console/test/pwa-reads.test.ts). An
// empty cell is the dash: absence is the denial.
const PERMISSION_EMPTY_CELL = "—";
function permissionEntryText(e) {
  const p = e?.provenance ?? {};
  const why = p.kind === "approved" ? (p.proposalId === null || p.proposalId === undefined ? "approved in Needs You" : `approved in Needs You · #${p.proposalId}`) : p.kind === "routine" ? `during ${p.routine} only` : null;
  return `${e?.label ?? ""}${e?.asks ? " ⏱" : ""}${why === null ? "" : ` (${why})`}`;
}
function permissionCellText(entries) {
  return Array.isArray(entries) && entries.length > 0 ? entries.map(permissionEntryText).join(", ") : PERMISSION_EMPTY_CELL;
}
function permissionRowText(row) {
  const label = row?.resource?.kind === "connection" ? `${row.label} ⧉` : String(row?.label ?? "");
  return [label, permissionCellText(row?.read), permissionCellText(row?.write)];
}
function permissionsTableHtml(rows) {
  if (!Array.isArray(rows)) return `<span class="muted">permissions: unavailable</span>`;
  if (rows.length === 0) return `<span class="muted">holds nothing — anything not listed is not granted</span>`;
  const body = rows.map((r) => {
    const [label, read, write] = permissionRowText(r);
    return `<tr><th scope="row">${esc(label)}</th><td>${esc(read)}</td><td>${esc(write)}</td></tr>`;
  }).join("");
  return `<table class="permissions" aria-label="permissions"><thead><tr><td></td><th scope="col">Read</th><th scope="col">Write</th></tr></thead><tbody>${body}</tbody></table>`;
}
// **The scope vocabulary is the SERVER's** since P3 of
// docs/research/2026-09-19-grants-and-access-simplified.md §3.4: every agent
// row on `GET /api/agents` carries a rendered `scope` (core's
// `describeScope`), and so does the payload of an `access_request`. This
// panel prints the words it is given. It used to hold a third spelling of
// them — `ACCESS_LABEL = {none, titles, folders}` lived here — which is how
// one record came to be said four ways (§2.10).
// The words, and the fallback for a row written before the field existed,
// are `scopeOf` in lib.js: Needs You prints an access request's scope in
// the same words.
let agentsCache = [];
async function loadAgents() {
  const res = await api("/api/agents");
  const { agents, access_requests } = await res.json();
  agentsCache = agents;
  // What each agent has ASKED for, beside what it holds (ruled 2026-09-19).
  // The answer is still given in Needs You — this is the panel telling you
  // there is a question, not a second door onto granting.
  const asked = new Map();
  for (const r of access_requests ?? []) asked.set(r.agent, [...(asked.get(r.agent) ?? []), r]);
  $("agents-empty").hidden = agents.length > 0;
  $("agent-list").innerHTML = agents
    .map((a) => {
      const g = a.grants ?? { tier: "none", areas: [] };
      const seen = a.last_seen_at ? `seen ${new Date(a.last_seen_at).toLocaleDateString()}` : "never seen";
      const scope = esc(scopeOf(a.scope, g.tier, g.areas));
      const projects = (a.projects ?? []).length ? ` · projects: ${a.projects.map(esc).join(", ")}` : "";
      // Where the scope came from, said once by the server rather than
      // reconstructed from `kind` here (§2.7): configuration for the
      // assistant, the manifest for a crew, the owner's hand for the rest.
      const from = a.scope?.from ? `<br><span class="muted">scope from ${esc(a.scope.from)}</span>` : "";
      const au = a.autonomy ?? {};
      const narrowing = [
        au.may_dispatch_to ? `delegates to ${au.may_dispatch_to.map(esc).join(", ") || "nobody"}` : "",
        au.accept_from ? `accepts from ${au.accept_from.map(esc).join(", ") || "nobody"}` : "",
        au.max_open_bundles !== undefined ? `max ${Number(au.max_open_bundles) || 0} bundles` : "",
      ].filter(Boolean).join(" · ");
      // The action table as the server resolved it (docs/ops/actions.md) —
      // level as a ceiling, kinds below it. Shown for every row, including
      // `observe`, because "this one can do nothing" is the fact worth being
      // able to see at a glance.
      const actionTable = actionTableHtml(a.scope);
      const asks = (asked.get(a.id) ?? [])
        .map((r) => `asked for ${esc(r.area)} — ${esc(String(r.reason ?? "").slice(0, 120))} (answer it in Needs You, request #${Number(r.proposal_id)})`)
        .join("<br>");
      const actions = a.revoked
        ? '<span class="muted">revoked</span>'
        : `<span><button data-agent-grants="${esc(a.id)}" class="secondary">grants</button> <button data-agent-rotate="${esc(a.id)}" class="secondary">rotate</button> <button data-agent-revoke="${esc(a.id)}">revoke</button></span>`;
      return `<li class="${a.revoked ? "revoked" : ""}"><span><b>${esc(a.display_name)}</b> <span class="muted">${esc(a.id)}</span> <span class="chip">${esc(ROLE_LABEL[a.kind] ?? a.kind)}</span><br>
        <span class="muted">access: ${scope}${projects} · ${seen}</span>${narrowing ? `<br><span class="muted">autonomy: ${narrowing}</span>` : ""}${from}
        ${a.revoked ? "" : permissionsTableHtml(a.permissions)}${actionTable}${asks ? `<span class="muted">${asks}</span><br>` : ""}
        <span id="presence-${esc(a.id)}" class="presence"></span></span>${actions}</li>`;
    })
    .join("");
  document.querySelectorAll("[data-agent-grants]").forEach((b) => (b.onclick = () => openGrants(b.dataset.agentGrants)));
  loadPresence().catch(() => {}); // fills the placeholder spans above from agent_presence (revoked agents get none — the query excludes them)
  document.querySelectorAll("[data-agent-rotate]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.agentRotate;
    if (!confirm(`rotate the token for ${id}? the current token stops working immediately.`)) return;
    const r = await api(`/api/agents/${encodeURIComponent(id)}/rotate`, { method: "POST" });
    if (r.ok) showAgentToken(await r.json()); else alert(await refusalText(r, "rotate failed"));
    loadAgents();
  }));
  document.querySelectorAll("[data-agent-revoke]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.agentRevoke;
    if (!confirm(`revoke ${id}? this cannot be undone — register a new agent to re-admit it.`)) return;
    await api(`/api/agents/${encodeURIComponent(id)}/revoke`, { method: "POST" });
    loadAgents();
  }));
}

// A refusal in the server's own words (F-13): register and rotate are reach
// `local`, so a passkey session gets `403 local_only`, whose message names the
// Mac app — shown as it came, never replaced by a guess at why.
async function refusalText(res, fallback) {
  const body = await res.json().catch(() => ({}));
  return body?.error?.message || fallback;
}

function showAgentToken({ id, token }) {
  $("agent-token-for").textContent = id; // textContent: never markup
  $("agent-token-value").textContent = token;
  $("agent-token").hidden = false;
}

$("agent-create").onsubmit = async (e) => {
  e.preventDefault();
  const body = { id: $("agent-id").value.trim(), display_name: $("agent-name").value.trim(), kind: $("agent-kind").value };
  const r = await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
  if (r.status === 409) return alert("that id is already registered");
  if (!r.ok) return alert(await refusalText(r, "invalid — id is a slug (a-z, 0-9, -; max 40) and a display name is required"));
  showAgentToken(await r.json());
  $("agent-id").value = ""; $("agent-name").value = "";
  loadAgents();
};

function openGrants(id) {
  const a = agentsCache.find((x) => x.id === id);
  if (!a) return;
  $("agent-token").hidden = true;
  $("agent-grants-for").textContent = id;
  $("agent-grants").dataset.agent = id;
  $("agent-tier").value = a.grants?.tier ?? "none";
  $("agent-areas").value = (a.grants?.areas ?? []).join("\n");
  $("agent-queries").checked = a.grants?.queries === true;
  $("agent-projects").value = (a.projects ?? []).join(", ");
  const au = a.autonomy ?? {};
  $("agent-may-dispatch-to").value = (au.may_dispatch_to ?? []).join(", ");
  $("agent-accept-from").value = (au.accept_from ?? []).join(", ");
  $("agent-max-bundles").value = au.max_open_bundles ?? "";
  // The action table, one select per kind, pre-set to what is STORED (not to
  // the resolved value) so saving without touching it changes nothing.
  $("agent-level").value = a.scope?.autonomy?.level ?? au.level ?? "observe";
  renderActionControls(a);
  $("agent-grants-msg").textContent = "";
  $("agent-grants").hidden = false;
}

/**
 * One select per action kind, and beside each what the SERVER says that kind
 * is now — the saved table, never a preview of this draft. What a draft
 * resolves to is core's to compute; it shows in the list the moment Save
 * lands. The kinds are the server's too; with no table from the server they
 * fall back to the record's own entries, so a Save can never drop one.
 */
function renderActionControls(a) {
  const stored = a.autonomy?.actions ?? {};
  const rows = actionTableRows(a.scope);
  const kinds = rows ? rows.map((r) => [r.kind, r.text]) : Object.keys(stored).map((k) => [k, "unavailable"]);
  $("agent-actions").innerHTML = kinds.map(([k, saved]) => `<label>${esc(k)} <span class="muted">saved: ${esc(saved)}</span>
      <select data-action-kind="${esc(k)}">
        <option value="">default for the level</option>
        <option value="deny">deny — refuse it at the tool</option>
        <option value="propose">propose — ask me</option>
        <option value="allow">allow — run it (act within scope only)</option>
      </select></label>`).join("");
  for (const sel of document.querySelectorAll("[data-action-kind]")) sel.value = stored[sel.dataset.actionKind] ?? "";
}

// Blank = the key is absent. The §4.21 keys can only narrow; `level` and
// `actions` may go either way, and this form is one of the two doors allowed
// to widen — the server records and alerts whatever this raises.
function autonomyFromForm() {
  const list = (id) => $(id).value.split(",").map((s) => s.trim()).filter(Boolean);
  const out = {};
  if ($("agent-may-dispatch-to").value.trim()) out.may_dispatch_to = list("agent-may-dispatch-to");
  if ($("agent-accept-from").value.trim()) out.accept_from = list("agent-accept-from");
  if ($("agent-max-bundles").value.trim()) out.max_open_bundles = Number($("agent-max-bundles").value);
  const level = $("agent-level").value;
  if (level) out.level = level; // the select's own options; the server validates it again
  const actions = {};
  for (const sel of document.querySelectorAll("[data-action-kind]")) if (sel.value) actions[sel.dataset.actionKind] = sel.value;
  if (Object.keys(actions).length) out.actions = actions;
  return out;
}

$("agent-grants-cancel").onclick = () => { $("agent-grants").hidden = true; };

$("agent-grants").onsubmit = async (e) => {
  e.preventDefault();
  const id = $("agent-grants").dataset.agent;
  const tier = $("agent-tier").value;
  const areas = tier === "areas" ? $("agent-areas").value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const queries = $("agent-queries").checked;
  const projects = $("agent-projects").value.split(",").map((s) => s.trim()).filter(Boolean);
  const g = await api(`/api/agents/${encodeURIComponent(id)}/grants`, { method: "PUT", body: JSON.stringify({ tier, areas, queries }) });
  if (!g.ok) { $("agent-grants-msg").textContent = "grants rejected — areas must be TitleCase vault prefixes (e.g. Areas/Fsl), one per line, and only for tier areas (the bare vault, /, is for the internal assistant only)"; return; }
  const p = await api(`/api/agents/${encodeURIComponent(id)}/projects`, { method: "PUT", body: JSON.stringify({ projects }) });
  if (!p.ok) { $("agent-grants-msg").textContent = "projects rejected — comma-separated slugs (a-z, 0-9, -)"; return; }
  const au = await api(`/api/agents/${encodeURIComponent(id)}/autonomy`, { method: "PUT", body: JSON.stringify(autonomyFromForm()) });
  if (!au.ok) {
    const why = (await au.json().catch(() => ({})))?.error?.message;
    $("agent-grants-msg").textContent = why || "autonomy rejected — agent ids (and `user` for accept-from), comma-separated; max open bundles 0..1000";
    return;
  }
  $("agent-grants").hidden = true;
  loadAgents();
};
// ===== Today, Projects and Usage (the Phase 4 dashboard, placed by the shell) =====
// Every server value is output-encoded via esc() before it touches the DOM
// (CRIT-7); only a https://github.com/ url may become a link. pg returns
// count()/numeric/bigint as strings, so numbers pass through asNum() first —
// bar widths are numbers we computed, never server text.
const asNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtUsd = (v) => asNum(v).toFixed(2);
const fmtK = (v) => { const n = asNum(v); return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); };
const fmtDay = (v) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T00:00:00`) : new Date(v); // a bare date is local, not UTC
  return Number.isNaN(d.getTime()) ? String(v ?? "") : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const barPct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (asNum(v) / max) * 100)) : 0);
const barHtml = (v, max) => `<span class="bar"><span style="width:${barPct(v, max).toFixed(1)}%"></span></span>`;
// staleness is visible, never silent: every panel stamps the envelope's as_of
const asOfText = (as_of) => (as_of ? `as of ${clockTime(as_of)}` : "");
const dashStamp = (id, as_of) => { $(`dash-${id}-asof`).textContent = asOfText(as_of); };

// one review list across every configured repo (github-state → prs_for_review); the status page uses it too
function reviewListHtml(rows) {
  return rows.length
    ? rows.map((r) => {
        const url = /^https:\/\/github\.com\//.test(r.url ?? "") ? r.url : null; // agent/source text is output-encoded; only a github.com url becomes a link
        const ref = esc(String(r.external_ref).replace(/^gh:/, ""));
        return `<li><span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${ref}</a>` : ref} ${esc(r.title)}</span><span class="muted">${esc(r.author ?? "")}</span></li>`;
      }).join("")
    : `<li class="muted">none</li>`;
}

async function dashQuery(name, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return (await api(`/api/q/${name}${qs}`)).json();
}

// §4.19 one row per project + §4.21 the kill switch: a mode chip and ONE
// toggle (confirm first — flipping back to Auto re-extends trust to every
// member). The user reads Auto / Supervised (glossary.md); the stored values
// stay autonomous / review, and the chip keeps the stored value as its CSS
// class. Every server value is output-encoded; counts pass through asNum().
const MODE_LABEL = { review: "Supervised", autonomous: "Auto" };
const modeLabel = (m) => MODE_LABEL[m] ?? m;
function renderProjectRows({ projects, as_of }) {
  $("dash-project-rows").innerHTML = projects.length
    ? projects.map((p) => {
        const flip = p.mode === "review" ? "autonomous" : "review";
        const why = p.last_mode_change ? ` · ${esc(modeLabel(p.last_mode_change.to))} since ${new Date(p.last_mode_change.ts).toLocaleDateString()} (${esc(p.last_mode_change.reason || p.last_mode_change.by)})` : "";
        const budget = p.daily_budget_usd === null || p.daily_budget_usd === undefined ? "no budget" : `budget $${fmtUsd(p.daily_budget_usd)}/day`;
        const queued = asNum(p.bundles_queued);
        return `<li><div class="row"><span><b>${esc(p.id)}</b> <span class="chip ${esc(p.mode)}">${esc(modeLabel(p.mode))}</span></span>
            <button class="secondary" data-project-mode="${esc(p.id)}" data-to="${flip}">→ ${esc(modeLabel(flip))}</button></div>
          <div class="muted">${p.members.length ? p.members.map(esc).join(", ") : "no members"}${why}</div>
          <div class="muted">${asNum(p.open_tasks)} open task(s) · ${asNum(p.bundles_in_flight)} bundle(s) in flight${queued ? ` · <span class="failed">${queued} queued</span>` : ""} · ${asNum(p.open_threads)} open thread(s)${asNum(p.pending_reviews) ? ` · ${asNum(p.pending_reviews)} awaiting you` : ""}</div>
          <div class="muted">spent $${fmtUsd(p.spend_today_usd)} today · ${budget} · cap ${asNum(p.max_open_bundles)} bundles${p.last_activity ? ` · active ${new Date(p.last_activity).toLocaleDateString()}` : ""}</div></li>`;
      }).join("")
    : `<li class="muted">no projects yet — one appears the first time an agent, task, or artifact uses a project slug</li>`;
  document.querySelectorAll("[data-project-mode]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.projectMode;
    const to = b.dataset.to;
    const warn = to === "review"
      ? `set ${id} to supervised? every agent-to-agent review request will queue for you until you set it back.`
      : `set ${id} back to auto? members will send review requests to each other without you again.`;
    if (!confirm(warn)) return;
    const r = await api(`/api/projects/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ mode: to }) });
    $("dash-projects-msg").textContent = r.ok ? `${id} is now ${modeLabel(to).toLowerCase()}` : `could not switch ${id} (${r.status})`;
    loadProjects();
  }));
  dashStamp("projects", as_of);
}

function renderAreas({ rows, as_of }) {
  $("dash-projects").innerHTML = rows.length
    ? rows.map((r) => {
        const latest = (Array.isArray(r.latest) ? r.latest : []).map((t) => esc(String(t).slice(0, 60))).join(" · ");
        const blocked = asNum(r.blocked);
        return `<li><div class="row"><b>${esc(r.area)}</b><span>${asNum(r.open)} open</span></div>
          <div class="muted">${asNum(r.in_progress)} in progress · ${blocked ? `<span class="failed">${blocked} blocked</span>` : "0 blocked"} · ${asNum(r.closed_7d)} closed this week</div>
          ${latest ? `<div class="muted latest">${latest}</div>` : ""}</li>`;
      }).join("")
    : `<li class="muted">no work items yet — the github-state collector fills this in</li>`;
  dashStamp("projects", as_of);
}

function renderSpend({ rows, as_of }) {
  // split by tier over the window — the Phase 4 "done when"
  const tiers = new Map();
  for (const r of rows) {
    const t = tiers.get(r.model) ?? { cost: 0, tin: 0, tout: 0, turns: 0, cread: 0, cwrite: 0 };
    t.cost += asNum(r.cost_usd); t.tin += asNum(r.tokens_in); t.tout += asNum(r.tokens_out); t.turns += asNum(r.turns);
    t.cread += asNum(r.cache_read); t.cwrite += asNum(r.cache_write);
    tiers.set(r.model, t);
  }
  const sorted = [...tiers].sort((a, b) => b[1].cost - a[1].cost);
  const max = Math.max(0, ...sorted.map(([, t]) => t.cost));
  const total = sorted.reduce((s, [, t]) => s + t.cost, 0);
  $("dash-spend-total").textContent = sorted.length ? `$${fmtUsd(total)} API-equivalent across ${sorted.length} tier(s)` : "";
  // cache_hit_rate (cost-optimisation §"Measure"): cache_read / (cache_read + tokens_in + cache_write), across the whole window
  const cread = sorted.reduce((s, [, t]) => s + t.cread, 0);
  const cwrite = sorted.reduce((s, [, t]) => s + t.cwrite, 0);
  const tin = sorted.reduce((s, [, t]) => s + t.tin, 0);
  const denom = cread + cwrite + tin;
  $("dash-cache-rate").textContent = denom > 0 ? `cache hit rate: ${((cread / denom) * 100).toFixed(0)}%` : "";
  $("dash-tiers").innerHTML = sorted.length
    ? sorted.map(([model, t]) => `<li><div class="row"><span>${esc(model ?? "unknown")}</span><span>$${fmtUsd(t.cost)}</span></div>${barHtml(t.cost, max)}
        <div class="muted">${fmtK(t.tin)} in · ${fmtK(t.tout)} out · ${t.turns} turn(s)</div></li>`).join("")
    : `<li class="muted">no usage recorded yet — the claude-usage collector fills this in</li>`;
  // per day × tier (rows arrive day DESC, cost DESC)
  const days = [...new Set(rows.map((r) => String(r.day)))].slice(0, 14);
  const recent = rows.filter((r) => days.includes(String(r.day)));
  const dayMax = Math.max(0, ...recent.map((r) => asNum(r.cost_usd)));
  $("dash-spend-days").innerHTML = recent.length
    ? `<table><thead><tr><th>day</th><th>tier</th><th class="num">turns</th><th class="num">tokens</th><th class="num">usd</th></tr></thead><tbody>${recent
        .map((r) => `<tr><td>${esc(fmtDay(r.day))}</td><td>${esc(r.model ?? "unknown")}</td><td class="num">${asNum(r.turns)}</td><td class="num">${fmtK(asNum(r.tokens_in) + asNum(r.tokens_out))}</td><td class="num">${fmtUsd(r.cost_usd)}${barHtml(r.cost_usd, dayMax)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  dashStamp("spend", as_of);
}

function renderAws(daily, recent) {
  const rows = daily.rows;
  if (!rows.length) {
    $("dash-aws-total").textContent = "";
    $("dash-aws").innerHTML = `<li class="muted">no data yet — configure the aws-costs collector (METISTRY_AWS_*)</li>`;
    $("dash-aws-services").innerHTML = "";
    dashStamp("aws", daily.as_of);
    return;
  }
  const max = Math.max(0, ...rows.map((r) => asNum(r.usd)));
  const total = rows.reduce((s, r) => s + asNum(r.usd), 0);
  $("dash-aws-total").textContent = `$${fmtUsd(total)} over ${rows.length} day(s)`;
  $("dash-aws").innerHTML = rows.slice(0, 14).map((r) => `<li><div class="row"><span>${esc(fmtDay(r.day))}</span><span>$${fmtUsd(r.usd)}</span></div>${barHtml(r.usd, max)}</li>`).join("");
  const svc = new Map();
  for (const r of recent.rows) svc.set(r.service ?? "unknown", (svc.get(r.service ?? "unknown") ?? 0) + asNum(r.usd));
  const top = [...svc].sort((a, b) => b[1] - a[1]).slice(0, 6);
  $("dash-aws-services").innerHTML = top.map(([s, v]) => `<li class="row"><span>${esc(s)}</span><span>$${fmtUsd(v)}</span></li>`).join("");
  dashStamp("aws", daily.as_of);
}

/** Panels load independently: one absent collector never blanks the page. */
async function loadPanels(panels) {
  await Promise.all(Object.entries(panels).map(async ([id, load]) => {
    try { await load(); } catch { $(`dash-${id}-asof`).textContent = "unavailable"; }
  }));
}

// The old dashboard, where the shell gives it: Work ▸ Projects the project
// rows, and the Usage sheet the spend. Today is the day itself (today.js).
function loadProjects() {
  return loadPanels({
    projects: async () => { renderProjectRows(await (await api("/api/projects")).json()); renderAreas(await dashQuery("areas_overview")); },
  });
}

function loadUsage() {
  return loadPanels({
    spend: async () => renderSpend(await dashQuery("claude_usage_daily", { days: 30 })),
    aws: async () => renderAws(...(await Promise.all([dashQuery("aws_costs_daily", { days: 30 }), dashQuery("aws_costs_recent", { days: 30 })]))),
  });
}

async function loadSettings() {
  await Promise.all([loadStatus(), loadDevices()]);
}

// ===== artifacts (§4.21) =====
// Every server value is output-encoded via esc()/textContent before it
// touches the DOM (CRIT-7). Markdown renders through md.js (escape first,
// whitelisted tags only, https:// and #/ anchors only); other text kinds
// render as escaped text in a <pre>; images come from the raw route as <img>;
// HTML renders ONLY inside an opaque-origin sandboxed iframe (sandbox="" —
// no tokens at all, so the frame is never same-origin and never runs script;
// decision #14) with a CSP meta in the srcdoc, so an agent-authored page can
// neither read the session nor call a route.
const ART_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">';
let artOpen = null; // { id, version }

function artifactRoute() {
  // hoisted (called at boot, before this block's consts exist): the regex lives inline on purpose
  const m = /^#\/artifacts\/(art_[0-9A-HJKMNP-TV-Z]{26})(?:\/(ver_[0-9A-HJKMNP-TV-Z]{26}))?(\/review)?$/.exec(location.hash);
  return m ? { id: m[1], version: m[2] ?? null, review: !!m[3] } : null;
}

async function loadArtifacts() {
  const project = $("art-project").value.trim();
  const res = await api(`/api/artifacts${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  const { artifacts } = await res.json();
  $("art-empty").hidden = artifacts.length > 0;
  $("art-list").innerHTML = artifacts
    .map((a) => `<li><a href="#/artifacts/${esc(a.id)}" data-art="${esc(a.id)}"><b>${esc(a.project)}/${esc(a.slug)}</b></a>
      <span class="muted">${esc(a.kind ?? "")} · ${esc(a.created_by ?? "")} · ${dateTime(a.updated_at)}</span></li>`)
    .join("");
  document.querySelectorAll("[data-art]").forEach((el) => (el.onclick = (e) => { e.preventDefault(); location.hash = `#/artifacts/${el.dataset.art}`; }));
  const r = artifactRoute();
  if (r) await openArtifact(r.id, r.version);
  else $("art-detail").hidden = true;
}

window.addEventListener("hashchange", () => {
  const r = artifactRoute();
  if (r) { if ($("artifacts").hidden) show("artifacts"); else openArtifact(r.id, r.version); }
});

async function openArtifact(id, versionId) {
  const res = await api(`/api/artifacts/${encodeURIComponent(id)}`);
  if (!res.ok) { $("art-detail").hidden = true; return; }
  const { artifact, current } = await res.json();
  const { versions } = await (await api(`/api/artifacts/${encodeURIComponent(id)}/versions`)).json();
  const version = versions.find((v) => v.id === versionId) ?? current ?? versions[0] ?? null;
  artOpen = { id, version: version?.id ?? null };
  $("art-detail").hidden = false;
  $("art-title").textContent = `${artifact.project}/${artifact.slug}`;
  $("art-meta").textContent = version
    ? `${version.author_kind === "agent" ? "agent" : "you"}: ${version.author_principal} · ${version.message} · ${dateTime(version.created_at)} · ${version.commit ? `rev ${version.commit.slice(0, 10)}` : "not committed yet"}${version.id === artifact.current_version ? " · current" : ""}`
    : "no versions";
  const sel = $("art-version");
  sel.innerHTML = versions.map((v) => `<option value="${esc(v.id)}">${esc(v.id.slice(-8))} · ${esc(v.author_principal)} · ${new Date(v.created_at).toLocaleDateString()}</option>`).join("");
  if (version) sel.value = version.id;
  sel.onchange = () => { location.hash = `#/artifacts/${id}/${sel.value}`; };
  const files = version ? Object.keys(version.manifest).sort() : [];
  const fsel = $("art-file");
  fsel.innerHTML = files.map((f) => `<option value="${esc(f)}">${esc(f)} · ${esc(version.manifest[f].kind)}</option>`).join("");
  const entry = files.find((f) => /^(index\.html|index\.md|README\.md)$/.test(f)) ?? files[0];
  if (entry) { fsel.value = entry; await renderArtifactFile(id, version.id, entry, version.manifest[entry].kind); } else $("art-viewer").replaceChildren();
  fsel.onchange = () => renderArtifactFile(id, version.id, fsel.value, version.manifest[fsel.value].kind);
  if (version) await loadThreads(id, version.id);
}

async function renderArtifactFile(id, ver, path, kind) {
  const viewer = $("art-viewer");
  viewer.replaceChildren();
  const fileUrl = (raw) => `/api/artifacts/${encodeURIComponent(id)}/versions/${encodeURIComponent(ver)}/file?path=${encodeURIComponent(path)}${raw ? "&raw=1" : ""}`;
  if (kind === "image") {
    const img = document.createElement("img");
    img.src = fileUrl(true); // same-origin raw route: image/* only, no-store, nosniff
    img.alt = path;
    viewer.append(img);
    return;
  }
  if (kind === "pdf" || kind === "binary") {
    const a = document.createElement("a");
    a.href = fileUrl(true);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = kind === "pdf" ? `open ${path}` : `download ${path}`;
    viewer.append(a);
    return;
  }
  const res = await api(fileUrl(false));
  if (!res.ok) { viewer.textContent = res.status === 503 ? "this version's content is superseded on the working tree — pick the current version or use diff" : "unavailable"; return; }
  const body = await res.json();
  if (kind === "html") {
    // opaque origin: sandbox with NO tokens (never the same-origin one), CSP inside the document, no navigation of the top window
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.className = "art-frame";
    frame.srcdoc = ART_CSP + body.content;
    viewer.append(frame);
    return;
  }
  if (kind === "markdown") {
    const div = document.createElement("div");
    div.className = "art-md";
    div.innerHTML = renderMarkdown(body.content ?? ""); // md.js escapes FIRST; only its own whitelisted tags can come out
    viewer.append(div);
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "art-pre";
  pre.textContent = body.content ?? ""; // textContent: never markup
  viewer.append(pre);
}

async function loadThreads(id, ver) {
  const { threads } = await (await api(`/api/artifacts/${encodeURIComponent(id)}/comments?version=${encodeURIComponent(ver)}`)).json();
  const open = threads.filter((t) => t.state === "open").length;
  $("art-thread-count").textContent = threads.length ? `${open} open · ${threads.length - open} resolved` : "none";
  const who = (c) => `${c.author_kind === "agent" ? "🤖 " : ""}${esc(c.author_principal)}`; // agent text is labeled agent-sourced (§4.19)
  $("art-threads").innerHTML = threads
    .map((t) => `<li class="thread ${t.state}">
      <div class="row"><label><input type="checkbox" data-thread="${esc(t.id)}" ${t.state === "resolved" ? "disabled" : ""}> ${who(t)} <span class="muted">${t.path ? esc(t.path) + " · " : ""}${dateTime(t.created_at)} · ${esc(t.state)}</span></label>
        <button class="secondary" data-state="${esc(t.id)}" data-op="${t.state === "open" ? "resolve" : "reopen"}">${t.state === "open" ? "resolve" : "reopen"}</button></div>
      <div class="${bodyClass(t)}">${esc(t.body)}</div>
      ${t.replies.map((r) => `<div class="reply"><span class="muted">${who(r)} · ${dateTime(r.created_at)}</span><div class="${bodyClass(r)}">${esc(r.body)}</div></div>`).join("")}
      <form data-reply="${esc(t.id)}"><input type="text" placeholder="reply…" autocomplete="off"><button type="submit" class="secondary">reply</button></form>
    </li>`)
    .join("");
  document.querySelectorAll("[data-state]").forEach((b) => (b.onclick = async () => {
    await api(`/api/artifacts/${encodeURIComponent(id)}/comments/${encodeURIComponent(b.dataset.state)}/${b.dataset.op}`, { method: "POST" });
    loadThreads(id, ver);
  }));
  document.querySelectorAll("[data-reply]").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const body = f.querySelector("input").value.trim();
    if (!body) return;
    await api(`/api/artifacts/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ parent: f.dataset.reply, body }) });
    loadThreads(id, ver);
  }));
}

$("art-filter").onsubmit = (e) => { e.preventDefault(); loadArtifacts(); };

$("art-comment").onsubmit = async (e) => {
  e.preventDefault();
  const body = $("art-comment-body").value.trim();
  if (!body || !artOpen?.version) return;
  const r = await api(`/api/artifacts/${encodeURIComponent(artOpen.id)}/comments`, { method: "POST", body: JSON.stringify({ version: artOpen.version, body }) });
  if (r.ok) { $("art-comment-body").value = ""; loadThreads(artOpen.id, artOpen.version); }
};

$("art-dispatch").onsubmit = async (e) => {
  e.preventDefault();
  const thread_ids = [...document.querySelectorAll("[data-thread]:checked")].map((c) => c.dataset.thread);
  const to_agent = $("art-dispatch-to").value.trim();
  if (!artOpen?.version || !thread_ids.length || !to_agent) { $("art-dispatch-msg").textContent = "check at least one open thread and name an agent"; return; }
  const r = await api("/api/dispatches", { method: "POST", body: JSON.stringify({ artifact: artOpen.id, version: artOpen.version, thread_ids, to_agent }) });
  const body = await r.json();
  $("art-dispatch-msg").textContent = r.ok
    ? body.route === "work"
      ? `review task #${body.work.id} ${body.queued ? `queued for ${to_agent} (${body.queued.reason} ${body.queued.open}/${body.queued.cap})` : `created for ${to_agent}`}`
      : `queued as proposal #${body.proposal_id} (${body.reason ?? "outside the project"})`
    : `dispatch failed: ${body.error?.message ?? r.status}`;
};

// ===== rooms (docs/ops/threads.md) =====
// The owner's window onto every conversation at once: threads on artifact
// versions and rooms on `work` rows, from the one `rooms` seed query
// (invariant 3 — this panel calls /api/q/rooms and nothing else). Two
// things it adds over the per-artifact thread list:
//
// - **why this came to you.** A demoted thread has carried
//   `payload.reason` since the ping-pong cap shipped; it was never
//   rendered as a sentence. WHY_LINE turns the stored value into one.
// - **a room you can answer.** A work room's composer posts as the user,
//   which resets the agent-only run — the human turn IS the release valve.
//
// Resolve is a button here and nowhere else: no tool resolves a room and
// nothing resolves one on a timer (a sweep would fire the queued-bundle
// release and start work unattended).
const WHY_LINE = {
  ping_pong_cap: (p) => `Ten agent turns went by without a human. The next agent message was not stored — this is where it came to you. Answer, or resolve the room.`,
  outside_project: () => `An agent tried to hand this across a project boundary. Only your hand dispatches across it.`,
  review_mode: () => `The project is in review mode, so every agent-to-agent hand-off queues for you.`,
  may_dispatch_to: () => `The sending agent's manifest does not list this target.`,
  accept_from: () => `The receiving agent's manifest does not accept work from the sender.`,
};

function roomRoute() {
  // hoisted (called at boot): the regex lives inline, like artifactRoute's
  const m = /^#\/rooms\/work\/(\d{1,12})$/.exec(location.hash);
  return m ? { work_id: Number(m[1]) } : null;
}

let roomOpen = null; // { work_id }

async function loadRooms() {
  const project = $("room-project").value.trim();
  const params = new URLSearchParams({ limit: "50" });
  if (project) params.set("project", project);
  if ($("room-open-only").checked) params.set("state", "open");
  const { rows } = await (await api(`/api/q/rooms?${params}`)).json();
  $("room-empty").hidden = rows.length > 0;
  $("room-list").innerHTML = rows.map(roomCard).join("");
  document.querySelectorAll("[data-room]").forEach((el) => (el.onclick = (e) => { e.preventDefault(); location.hash = el.dataset.room; }));
  const r = roomRoute();
  if (r) await openRoom(r.work_id);
  else $("room-detail").hidden = true;
}

// Every value below came out of the database and may be agent-authored: esc() on all of it (CRIT-7).
function roomCard(r) {
  const href = r.anchor === "work" ? `#/rooms/work/${r.work_id}` : `#/artifacts/${r.artifact_id}/${r.version_id}`;
  const who = (r.participants ?? []).map((p) => `${p.kind === "agent" ? "🤖 " : ""}${esc(p.principal)}`).join(", ");
  const why = r.escalated && WHY_LINE[r.reason] ? `<div class="room-why">${esc(WHY_LINE[r.reason](r))}</div>` : "";
  return `<li class="thread ${esc(r.state)}">
    <div class="row"><a href="${esc(href)}" data-room="${esc(href)}"><b>${esc(r.title ?? "")}</b></a>
      <span class="muted">${esc(r.anchor)} · ${esc(r.state)} · ${r.messages} message${r.messages === 1 ? "" : "s"}${r.agent_tail ? ` · ${r.agent_tail}/${r.cap} agent turns` : ""}</span></div>
    <div class="muted">${who || "—"}${r.last_at ? ` · last ${dateTime(r.last_at)}` : ""}</div>
    ${why}
  </li>`;
}

async function openRoom(workId) {
  const res = await api(`/api/work/${encodeURIComponent(workId)}/thread`);
  if (!res.ok) { $("room-detail").hidden = true; return; }
  const t = await res.json();
  roomOpen = { work_id: t.work_id };
  $("room-detail").hidden = false;
  $("room-title").textContent = `work #${t.work_id} — ${t.title}`;
  $("room-meta").textContent = `${t.project ?? "no project"} · ${t.status} · ${t.state}${t.resolved_by ? ` by ${t.resolved_by}` : ""} · ${t.agent_tail}/${t.cap} consecutive agent turns`;
  const why = t.agent_tail >= t.cap;
  $("room-why").hidden = !why;
  if (why) $("room-why").textContent = WHY_LINE.ping_pong_cap();
  const who = (c) => `${c.author_kind === "agent" ? "🤖 " : ""}${esc(c.author_principal)}`; // agent text is labeled agent-sourced (§4.19)
  $("room-messages").innerHTML = t.comments.length
    ? t.comments.map((c) => `<li class="reply"><span class="muted">${who(c)} · ${dateTime(c.created_at)}</span><div class="${bodyClass(c)}">${esc(c.body)}</div></li>`).join("")
    : `<li class="muted">nothing said yet</li>`;
  $("room-resolve").textContent = t.state === "open" ? "Resolve" : "Reopen";
  $("room-resolve").dataset.op = t.state === "open" ? "resolve" : "reopen";
  $("room-msg").textContent = "";
}

window.addEventListener("hashchange", () => {
  const r = roomRoute();
  if (r) { if ($("rooms").hidden) show("rooms"); else openRoom(r.work_id); }
});

$("room-filter").onsubmit = (e) => { e.preventDefault(); loadRooms(); };

$("room-comment").onsubmit = async (e) => {
  e.preventDefault();
  const body = $("room-comment-body").value.trim();
  if (!body || !roomOpen) return;
  const r = await api(`/api/work/${encodeURIComponent(roomOpen.work_id)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  if (r.ok) { $("room-comment-body").value = ""; await openRoom(roomOpen.work_id); }
  else $("room-msg").textContent = `could not post: ${r.status}`;
};

$("room-resolve").onclick = async () => {
  if (!roomOpen) return;
  const op = $("room-resolve").dataset.op ?? "resolve";
  const r = await api(`/api/work/${encodeURIComponent(roomOpen.work_id)}/thread/${op}`, { method: "POST" });
  if (r.ok) await openRoom(roomOpen.work_id);
  else $("room-msg").textContent = op === "resolve" ? "nothing to resolve yet — a room needs a message first" : `could not reopen: ${r.status}`;
};

// ===== feed (home) + agent presence =====
// docs/product/desktop-app-plan.md "The window": the activity_feed and
// agent_presence seed queries, surfaced as the PWA's first tab and as
// presence chips on the existing agents list. Every server value is
// output-encoded via esc() before it touches the DOM (CRIT-7).
//
// It is the TIMELINE (docs/research/2026-09-16-taskuary-review.md ADOPT 1):
// one ordered stream carrying captures, proposals, runs, work and decisions,
// newest first, filterable by kind, refreshed incrementally through the
// query's own `since` param. Read-only, and staying that way — every verb in
// this system has a place already and none of them is a feed row.
const FEED_ICONS = {
  capture: "📥",
  tool: "🔧", turn: "💬", crew_run: "🧑‍🤝‍🧑", dispatch: "📨", task_op: "🗂️",
  agent_admin: "🛡️", project_mode: "🎛️", collector_run: "⚠️", config_write: "⚙️",
  routine_run: "⏰",
  proposal_created: "📝", proposal_decided: "✅", work_history: "🧾",
  brief: "📰", review: "🔍", alert: "🚨",
};
const feedIcon = (kind) => FEED_ICONS[kind] ?? "•";

// The chips. Each value is passed straight through as the query's `kind`
// param, which matches an exact row kind OR the `group` column
// activity_feed.yaml derives — so this list names groups and the SQL owns
// what is in each one. Adding a kind to the feed does not mean editing here.
// Eight chips (screen-02-activity.md §3): All and the seven groups —
// `routine` the seventh (C43): a routine ran because the clock said so.
const FEED_CHIPS = [
  ["", "All"],
  ["capture", "Captures"],
  ["proposal", "Proposals"],
  ["decision", "Decisions"],
  ["work", "Work"],
  ["run", "Runs"],
  ["message", "Messages"],
  ["routine", "Routines"],
];
let feedKind = "";
// The incremental refresh. `feedSince` is the newest `ts` already painted;
// the query returns rows AT or after it (inclusive, because two sources can
// share a microsecond), and `feedSeen` drops the ones we already have. A
// filter change resets both — a different question deserves a full answer.
let feedSince = "";
let feedRows = [];
const feedKeyOf = (r) => `${r.ref}|${r.ts}|${r.kind}`;

function relTime(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ----- Title Case at render (design-system.md §3.2 + P10) -----
//
// A feed subject is a card title, so P10 says Title Case. But a subject is
// sometimes a string an AGENT wrote, and P1 says agent text is data — data is
// not case-corrected. The two are reconciled by *where* the rule is applied:
// here, in the view layer, never in the database, and only for kinds whose
// subject the console itself composes.
//
// A closed allow-list, not a heuristic. "Is this string ours?" cannot be
// answered by looking at the string — it can be answered by looking at its
// kind, and the kind is a closed set the activity_feed query already returns.
// A new kind is NOT title-cased until someone adds it here deliberately: the
// safe default is to leave text alone. `turn`, `tool` and `dispatch` are
// absent on purpose — their subjects can carry agent- or user-authored text —
// and so is `work_history`, whose subject is the task's own title (C18): "Migrate
// the settings pane to tokens" is someone's writing, not a label we composed.
// `routine_run` is in: its subject is the routine's component name, which the
// system chose (an identifier like `plan-tomorrow` is left as it is anyway).
const TITLE_CASE_KINDS = new Set([
  "collector_run", "proposal_created", "proposal_decided", "project_mode",
  "agent_admin", "brief", "review", "alert", "task_op", "crew_run", "routine_run",
]);
// Short joining words stay lowercase unless they lead (P10).
const MINOR = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "via"]);
// An identifier is left exactly as it is: anything holding a separator or a
// digit (github-state, knowledge_search, mode:, a path, #97, v2) and anything
// already mixed-case (someone chose that capitalisation).
const isIdentifier = (w) => /[/_\-.:\d]/.test(w) || (/[a-z]/.test(w) && /[A-Z]/.test(w));

function titleCaseSubject(kind, subject) {
  if (!subject || !TITLE_CASE_KINDS.has(kind)) return subject ?? "";
  return subject
    .split(/(\s+)/) // keep the whitespace so the string is rebuilt, not rewritten
    .map((w, i) => {
      if (!w.trim() || isIdentifier(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && MINOR.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

// The glyph, not the row, takes `failed` (design-system.md §3.2) — read from
// the query's `ok` column (false only where a run failed; null where the
// source cannot fail), never from the English in `detail` (C19).
function feedRowHtml(r) {
  const failed = r.ok === false;
  return `<li class="feed-row"><span class="feed-icon" title="${esc(failed ? `${r.kind} — failed` : r.kind)}">${failed ? "⛔" : feedIcon(r.kind)}</span>
    <span class="feed-body">
      <span class="chip feed-actor">${esc(r.actor ?? "system")}</span>
      <span class="feed-subject">${esc(titleCaseSubject(r.kind, r.subject))}</span>
      ${r.detail ? `<span class="muted feed-detail">${esc(r.detail)}</span>` : ""}
    </span>
    <span class="muted feed-time" title="${esc(dateTime(r.ts))}">${esc(relTime(r.ts))}</span></li>`;
}

// Agent options come from the feed's own rows (no extra call); project
// options come from the existing /api/projects list (already fetched by
// the dashboard) so an empty feed still offers every known project.
function populateFeedAgents(rows) {
  const sel = $("feed-agent");
  const current = sel.value;
  const actors = [...new Set(rows.map((r) => r.actor).filter(Boolean))].sort();
  sel.innerHTML = [`<option value="">all agents</option>`, ...actors.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`)].join("");
  sel.value = actors.includes(current) ? current : "";
}

async function populateFeedProjects() {
  try {
    const { projects } = await (await api("/api/projects")).json();
    const sel = $("feed-project");
    const current = sel.value;
    sel.innerHTML = [`<option value="">all projects</option>`, ...projects.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}</option>`)].join("");
    sel.value = current;
  } catch {}
}

function renderFeedChips() {
  $("feed-kinds").innerHTML = FEED_CHIPS.map(
    ([k, label]) => `<button type="button" class="chip${k === feedKind ? " on" : ""}" data-kind="${attr(k)}" aria-pressed="${k === feedKind}">${esc(label)}</button>`,
  ).join(" ");
  for (const b of document.querySelectorAll("#feed-kinds [data-kind]")) {
    b.onclick = () => { feedKind = b.dataset.kind; resetFeed(); loadFeed().catch(() => {}); };
  }
}

/** A filter changed: throw the painted stream away rather than merging two questions' answers. */
function resetFeed() {
  feedSince = "";
  feedRows = [];
}

async function loadFeed() {
  const agent = $("feed-agent").value;
  const project = $("feed-project").value;
  const { rows } = await dashQuery("activity_feed", { hours: 24, limit: 100, agent, project, kind: feedKind, since: feedSince });
  // Merge, newest first, de-duplicated on (ref, ts, kind) — the inclusive
  // `since` re-sends the boundary row on purpose, and losing an event to a
  // strict `>` would be worse than re-rendering one.
  const seen = new Set();
  feedRows = [...rows, ...feedRows]
    .filter((r) => !seen.has(feedKeyOf(r)) && seen.add(feedKeyOf(r)))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 200);
  if (feedRows[0]) feedSince = feedRows[0].ts;
  populateFeedAgents(feedRows);
  $("feed-empty").hidden = feedRows.length > 0;
  $("feed-list").innerHTML = feedRows.map(feedRowHtml).join("");
}

async function loadFeedView() {
  renderFeedChips();
  await populateFeedProjects();
  resetFeed();
  await loadFeed();
  pollFeed();
}

// `run.*` and `capture.new` while the stream is up; while it is down,
// auto-refresh every 10s while the tab is visible, like chat's poll
function pollFeed(intervalMs = 10000) {
  live.poll("feed", () => {
    if (!$("feed").hidden && document.visibilityState === "visible") loadFeed().catch(() => {});
  }, intervalMs);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("feed").hidden) loadFeed().catch(() => {});
});

$("feed-agent").onchange = () => { resetFeed(); loadFeed().catch(() => {}); };
$("feed-project").onchange = () => { resetFeed(); loadFeed().catch(() => {}); };

// ===== board (docs/ops/board.md) =====
// A Kanban over the tasks module's work rows. Two named queries do all the
// thinking (invariant 3): `board` returns one card per row with its `column`
// ALREADY DECIDED server-side, and `board_projects` returns the
// project × column counts that fill the filter and the column headers.
// Nothing below derives a state — a wrong predicate is wrong in
// seed/queries/board.yaml, in one place, for this panel and the Mac app
// alike. Every server value goes through esc() (CRIT-7).
//
// The drags (phase 3 of docs/research/2026-09-12-hermes-agent-review.md).
// The rule that keeps invariant 8 honest: **the board offers no drop the
// service would refuse.** `dropsFor()` below is the panel's copy of that
// sentence — it draws a target only where a statement in packages/tasks
// would succeed — and when the two disagree the STATEMENT wins: the card
// snaps back carrying the server's own message. Every drop maps to exactly
// ONE route, so "what did that drag do" has one answer in the `runs` ledger.

// The five columns in board order, each with the sentence its predicate means
// (P10: Title Case names things). The order here must match board.yaml's.
//
// Every label is the word its KEY says (T1-2; C2, C38, C39): `assigned` is
// Assigned and `blocked` is Blocked, because a label that disagrees with its
// own value is a bug waiting for someone to fix the wrong side of it — and
// "Needs You" is the request queue's name, not a column's. Reported is not a
// column: whether a report came back is the `reported` flag on a Done card.
const BOARD_COLUMNS = [
  ["backlog", "Backlog", "open, nobody's name on it"],
  ["assigned", "Assigned", "someone's name on it, not started"],
  ["in_progress", "In Progress", "an agent holds the lease"],
  ["blocked", "Blocked", "nothing but your hand moves it"],
  ["done", "Done", "closed — and whether a report came back"],
];
const BOARD_LABEL = new Map(BOARD_COLUMNS.map(([key, label]) => [key, label]));
const BOARD_LIMIT = 50; // per column — board.yaml's default, named here so the header can say "showing N of M"
// The rendered cards, by id: the drag handlers read the ROW they came from
// rather than re-deriving it out of data attributes, so a drop decides from
// the same `column`/`owner`/`status` the server sent.
const boardCards = new Map();

const fmtAge = (h) => {
  const n = asNum(h);
  if (n < 1) return `${Math.max(1, Math.round(n * 60))}m`;
  if (n < 48) return `${Math.round(n)}h`;
  return `${Math.round(n / 24)}d`;
};

// The SERVER decides `escalated`; this only names it, from fields already on
// the wire. A chip that says nothing but "escalated" is a card you have to
// open to understand, and the reason is already on the row.
function escalationLabel(c) {
  if (c.lease_expires_at && new Date(c.lease_expires_at) <= new Date()) return "lease lapsed";
  if (c.status === "blocked") return "blocked";
  return "overdue";
}

function boardCardHtml(c) {
  const bits = [c.claimed_by ? `held by ${c.claimed_by}` : c.owner ? `for ${c.owner}` : "unclaimed", `${fmtAge(c.age_hours)} old`];
  if (c.kind === "review") bits.push("review bundle");
  // `reported` is the Done column's facet (C39): a closed card whose agent
  // reported back says so; an open one with a report just says when
  if (c.last_report_at) bits.push(`${c.reported ? "reported" : "last report"} ${relTime(c.last_report_at)}`);
  // blocked-by (board.yaml, from day_work): surfaced, never a gate — the
  // text of the owner's own todo line, only while that line is still open
  if (c.blocked_by_task_open && c.blocked_by_task) bits.push(`waiting on you: ${c.blocked_by_task}`);
  // A closed card has nowhere to go — `update()` refuses a row that is
  // already closed — so it gets no grab affordance rather than a dead one.
  const movable = Object.keys(dropsFor(c)).length > 0;
  const label = `${c.title} — ${BOARD_LABEL.get(String(c.column)) ?? c.column}${movable ? ", press m to move it" : ""}`;
  return `<li class="card${c.escalated ? " escalated" : ""}${c.has_thread ? " linked" : ""}" data-card="${esc(c.id)}"${movable ? ` draggable="true"` : ""} tabindex="0" role="button" aria-label="${esc(label)}">
    <div class="row"><span class="card-title">${esc(c.title)}</span><span class="muted">#${esc(c.id)}</span></div>
    <div class="muted">${esc(bits.join(" · "))}${c.has_thread ? ` <span class="chip">room ${esc(asNum(c.thread_count))}</span>` : ""}${c.escalated ? ` <span class="chip failed">${esc(escalationLabel(c))}</span>` : ""}</div></li>`;
}

// ----- the drags: which drop does what (docs/ops/board.md "Drags") -----
//
// Where a released or unblocked row LANDS is not our choice: `release()` and
// the unblock both clear the claim and set status open, so board.yaml's CASE
// puts the card in Assigned or Backlog by whether `owner` is set. Naming that
// column here is what stops the drag from lying about where the card goes.
const boardHome = (c) => (c.owner ? "assigned" : "backlog");

/**
 * The legal drops for ONE card: `{ targetColumn: op }`. Derived from the same
 * rules the statements in packages/tasks enforce, so the board offers no drop
 * the service would refuse. A closed card has no drops at all — and with
 * Reported a flag on Done rather than a column, nothing a drag could reach
 * needs a report to exist.
 */
function dropsFor(c) {
  const d = {};
  if (c.status === "closed") return d;
  if (c.column === "backlog") { d.assigned = "assign"; d.in_progress = "claim"; }
  else if (c.column === "assigned") { d.backlog = "unassign"; d.in_progress = "claim"; }
  else if (c.column === "in_progress") { d[boardHome(c)] = "release"; }   // never orphaned — Hermes's `reclaimed`, which we already had
  else if (c.column === "blocked") { d[boardHome(c)] = "unblock"; }       // the one route back to `open`
  d.done = "close"; // offered from every open column; the SERVICE decides from the current status and a refusal is shown
  return d;
}

// One op, one route. Anything that needs two calls is not a drop.
const DROP_WHAT = {
  assign: "assign it to a crew",
  unassign: "clear the assignee",
  claim: "claim it as you",
  release: "hand it back — release the lease",
  unblock: "unblock it — the one route back to open",
  close: "close it",
};

function boardRoute(op, card, extra) {
  const id = encodeURIComponent(String(card.id));
  const patch = (body) => [`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }];
  if (op === "assign") return patch({ owner: extra.owner });
  if (op === "unassign") return patch({ owner: null });
  if (op === "unblock") return patch({ status: "open" });
  if (op === "close") return patch({ status: "closed" });
  return [`/api/tasks/${id}/${op}`, { method: "POST", body: "{}" }]; // claim | release
}

function boardMsg(text) {
  const el = $("board-msg");
  el.textContent = text ?? "";
  el.hidden = !text;
}

function boardPopClose() {
  for (const id of ["board-move", "board-assign", "board-detail"]) $(id).hidden = true;
  boardAssignCard = null;
}

/**
 * Optimistic, then authoritative. The card moves NOW — a board that waits for
 * a round trip feels broken — and a refusal puts it back carrying the
 * SERVER's sentence, never one invented here. Either way we refetch: the
 * server owns the columns.
 */
async function boardRun(op, card, target, extra = {}) {
  const el = document.querySelector(`#board-columns .card[data-card="${Number(card.id)}"]`);
  const from = el?.parentElement ?? null;
  const into = document.querySelector(`.board-col[data-column="${String(target).replace(/[^a-z_]/g, "")}"] .board-cards`);
  if (el && into) into.prepend(el);
  boardMsg("");
  try {
    const [path, init] = boardRoute(op, card, extra);
    const res = await api(path, init);
    if (res.ok) return true;
    if (el && from) from.prepend(el); // snap back
    const body = await res.json().catch(() => null);
    boardMsg(body?.error?.message ?? `the console refused that move (${res.status})`);
    return false;
  } catch {
    if (el && from) from.prepend(el);
    boardMsg("the console did not answer — nothing moved");
    return false;
  } finally {
    await loadBoard().catch(() => {});
  }
}

function boardDrop(card, target) {
  const op = dropsFor(card)[target];
  if (!op) return Promise.resolve(false);
  if (op === "assign") return openAssign(card); // the one drop that needs a value
  return boardRun(op, card, target);
}

// Highlight ONLY the columns this card may land in — the board declining to
// draw a target is the first half of "no drop the service would refuse".
function paintTargets(card, on) {
  const drops = on && card ? dropsFor(card) : {};
  for (const col of document.querySelectorAll("#board-columns .board-col")) {
    col.classList.toggle("drop", Boolean(drops[col.dataset.column]));
    if (!on) col.classList.remove("drop-over");
  }
}

// The keyboard alternative every drag needs: focus a card, press m, choose a
// column. Same targets, same routes, same refusals.
function openMove(card) {
  const drops = dropsFor(card);
  const keys = Object.keys(drops);
  boardPopClose();
  if (keys.length === 0) return boardMsg(`#${card.id} is closed — a closed card takes no further change here`);
  $("board-move-card").textContent = `#${card.id} ${card.title ?? ""}`;
  $("board-move-targets").innerHTML = keys
    .map((k) => `<button type="button" data-move="${esc(k)}">${esc(BOARD_LABEL.get(k) ?? k)} — ${esc(DROP_WHAT[drops[k]])}</button>`)
    .join("");
  for (const b of $("board-move-targets").querySelectorAll("[data-move]")) {
    b.onclick = () => { const t = b.dataset.move; boardPopClose(); boardDrop(card, t); };
  }
  $("board-move").hidden = false;
  $("board-move-targets").querySelector("button")?.focus();
}

// The assign picker. Names come from the agent registry; "me" is the user's
// own hand. A HUMAN may address a card to ANY crew (collaboration rule 4) —
// and no agent surface can address one at all, which is why there is no
// cross-kind check to run here.
let boardOwners = null;
let boardAssignCard = null;
async function ownerOptions() {
  if (boardOwners) return boardOwners;
  try {
    const { agents } = await (await api("/api/agents")).json();
    boardOwners = agents.filter((a) => !a.revoked).map((a) => String(a.id)).sort();
  } catch { boardOwners = []; }
  return boardOwners;
}

async function openAssign(card) {
  boardPopClose();
  const names = await ownerOptions();
  boardAssignCard = card;
  $("board-assign-card").textContent = `#${card.id} ${card.title ?? ""}`;
  $("board-assign-to").innerHTML = [`<option value="user">me</option>`, ...names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)].join("");
  if (card.owner && names.includes(String(card.owner))) $("board-assign-to").value = String(card.owner);
  $("board-assign").hidden = false;
  $("board-assign-to").focus();
  return false;
}

// A click opens the room when there is one (#161 — the card's room IS the
// conversation about it); otherwise the one card detail we can honestly show
// from the row itself.
function openCard(c) {
  if (c.has_thread) { boardPopClose(); location.hash = `#/rooms/work/${Number(c.id)}`; return; }
  boardPopClose();
  $("board-detail-title").textContent = `#${c.id} ${c.title ?? ""}`;
  const lease = c.claimed_by
    ? `${c.claimed_by}${c.lease_expires_at ? ` until ${dateTime(c.lease_expires_at)}` : ""}`
    : "unclaimed";
  const fields = [
    ["column", BOARD_LABEL.get(String(c.column)) ?? c.column],
    ["owner", c.owner ?? "nobody — it is in the open queue"],
    ["lease", lease],
    ["external ref", c.external_ref ?? "none"],
    ...(c.blocked_by ? [["waiting on", c.blocked_by_task ? `${c.blocked_by_task}${c.blocked_by_task_open ? "" : " (done)"}` : c.blocked_by]] : []),
    ...(c.reported ? [["report", `came back ${relTime(c.last_report_at)}`]] : []),
    ["last activity", c.updated_at ? relTime(c.updated_at) : "unknown"],
  ];
  $("board-detail-fields").innerHTML = fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("");
  const link = $("board-detail-link");
  link.hidden = !c.artifact;
  if (c.artifact) link.setAttribute("href", `#/artifacts/${encodeURIComponent(String(c.artifact))}`);
  $("board-detail").hidden = false;
  $("board-detail-close").focus();
}

// Counts come from board_projects, not from the cards: `board` caps each
// column at BOARD_LIMIT, so counting the rendered cards would quietly
// understate a busy column.
function boardTotals(rows, project) {
  const totals = new Map();
  for (const r of rows) {
    if (project && r.project !== project) continue;
    const t = totals.get(String(r.column)) ?? { cards: 0, escalations: 0 };
    t.cards += asNum(r.cards);
    t.escalations += asNum(r.escalations);
    totals.set(String(r.column), t);
  }
  return totals;
}

let boardDragging = null; // the card under the pointer mid-drag, so a column knows what it is being offered

function renderBoard(cards, totals) {
  const byColumn = new Map(BOARD_COLUMNS.map(([key]) => [key, []]));
  boardCards.clear();
  for (const c of cards) { boardCards.set(Number(c.id), c); byColumn.get(String(c.column))?.push(c); }
  $("board-columns").innerHTML = BOARD_COLUMNS.map(([key, label, why]) => {
    const list = byColumn.get(key) ?? [];
    const t = totals.get(key) ?? { cards: list.length, escalations: 0 };
    const more = t.cards > list.length ? ` <span class="muted">showing ${list.length}</span>` : "";
    return `<section class="board-col" data-column="${esc(key)}">
      <h3>${esc(label)} <span class="board-count">${asNum(t.cards)}${t.escalations ? ` <span class="failed">${asNum(t.escalations)}</span>` : ""}</span></h3>
      <p class="muted board-why">${esc(why)}${more}</p>
      <ul class="board-cards">${list.length ? list.map(boardCardHtml).join("") : `<li class="muted board-none">none</li>`}</ul>
    </section>`;
  }).join("");

  // Four handlers and no library, exactly as the note said (§6b).
  for (const el of document.querySelectorAll("#board-columns .card[data-card]")) {
    const card = boardCards.get(Number(el.dataset.card));
    if (!card) continue;
    el.ondragstart = (e) => {
      boardDragging = card;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(card.id));
      paintTargets(card, true);
    };
    el.ondragend = () => { el.classList.remove("dragging"); boardDragging = null; paintTargets(card, false); };
    el.onclick = () => openCard(card);
    el.onkeydown = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCard(card); }
      else if (e.key === "m" || e.key === "M") { e.preventDefault(); openMove(card); }
    };
  }
  for (const col of document.querySelectorAll("#board-columns .board-col")) {
    col.ondragover = (e) => {
      if (!boardDragging || !dropsFor(boardDragging)[col.dataset.column]) return; // no target drawn, no drop taken
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("drop-over");
    };
    col.ondragleave = () => col.classList.remove("drop-over");
    col.ondrop = (e) => {
      e.preventDefault();
      col.classList.remove("drop-over");
      const card = boardDragging;
      boardDragging = null;
      paintTargets(null, false);
      if (card) boardDrop(card, col.dataset.column);
    };
  }
}

async function loadBoard() {
  const project = $("board-project").value;
  const [cards, totals] = await Promise.all([
    dashQuery("board", { project, limit: BOARD_LIMIT }),
    dashQuery("board_projects", { limit: 500 }),
  ]);
  populateBoardProjects(totals.rows);
  $("board-empty").hidden = cards.rows.length > 0;
  $("board-asof").textContent = asOfText(cards.as_of);
  renderBoard(cards.rows, boardTotals(totals.rows, project));
}

// The filter's options are the projects that actually have cards — from the
// board's own counts, so it never offers a project with an empty board. Rows
// with no project (the user's default project) are counted under "all
// projects" and have no option of their own.
function populateBoardProjects(rows) {
  const sel = $("board-project");
  const current = sel.value;
  const projects = [...new Set(rows.map((r) => r.project).filter(Boolean))].sort();
  sel.innerHTML = [`<option value="">all projects</option>`, ...projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)].join("");
  sel.value = projects.includes(current) ? current : "";
}

async function loadBoardView() {
  await loadBoard();
  pollBoard();
}

// `work.changed` while the stream is up; while it is down, auto-refresh on
// the feed's cadence — a board that lags lies about who holds the lease.
// Never mid-gesture, though: re-rendering the columns under a drag or under
// an open picker would cancel the thing the user was doing.
const boardBusy = () => boardDragging !== null || ["board-move", "board-assign", "board-detail"].some((id) => !$(id).hidden);
function pollBoard(intervalMs = 10000) {
  live.poll("board", () => {
    if (!$("board").hidden && document.visibilityState === "visible" && !boardBusy()) loadBoard().catch(() => {});
  }, intervalMs);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("board").hidden && !boardBusy()) loadBoard().catch(() => {});
});

// ----- the popovers: cancel is always one key or one button away -----
$("board-move-cancel").onclick = () => boardPopClose();
$("board-detail-close").onclick = () => boardPopClose();
$("board-assign-cancel").onclick = () => boardPopClose();
$("board-assign").onsubmit = (e) => {
  e.preventDefault();
  const card = boardAssignCard;
  const owner = $("board-assign-to").value;
  boardPopClose();
  if (card) boardRun("assign", card, "assigned", { owner });
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("board").hidden) return;
  if (boardBusy()) { boardPopClose(); boardMsg(""); }
});

$("board-project").onchange = () => loadBoard().catch(() => {});

// [ and ] step the project filter — the one keyboard gesture a board with no
// drag still wants. Never while typing: a bracket belongs to the composer.
document.addEventListener("keydown", (e) => {
  if ($("board").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== "[" && e.key !== "]") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const sel = $("board-project");
  if (sel.options.length < 2) return;
  e.preventDefault();
  sel.selectedIndex = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + (e.key === "]" ? 1 : -1)));
  loadBoard().catch(() => {});
});

// presence chips on the existing agents tab list (§ agents section above
// leaves a <span id="presence-{id}"> placeholder per row for this to fill).
async function loadPresence() {
  const { rows } = await dashQuery("agent_presence", { limit: 500 });
  for (const p of rows) {
    const el = document.getElementById(`presence-${p.id}`);
    if (!el) continue; // the agent list may have re-rendered since this fetch started
    const seen = p.last_seen_at ? `seen ${dateTime(p.last_seen_at)}` : "never seen";
    el.innerHTML = `<span class="chip state-${esc(p.state)}">${esc(p.state)}</span> <span class="muted">${esc(seen)} · $${fmtUsd(p.spend_today_usd)} today</span>`;
  }
}

// ===== live changes (T7-7; design-build-plan §2.20) =====
// One `EventSource` on `GET /api/events` while signed in. An event names what
// changed; the view on screen that reads it refetches through its own route
// (ids, never bodies — the stream opens no read path). `needs_you.changed`
// carries the count, so the bell repaints without a fetch. The polls above
// are the fallback and run only while the stream is not up; the stream's
// state is on <body data-stream>, which the offline band (T7-4) follows.
const LIVE_REFRESH = {
  today: () => today.refresh(),
  chat: () => loadMessages(),
  triage: () => needsYou.load(),
  feed: () => loadFeed(),
  board: () => loadBoard(),
  rooms: () => loadRooms(),
  artifacts: () => (artOpen?.version ? loadThreads(artOpen.id, artOpen.version) : loadArtifacts()),
  agents: () => loadPresence(),
  projects: () => loadProjects(),
  usage: () => loadUsage(),
  settings: () => loadSettings(),
};

/** A text field with focus inside one of these sections: a repaint would take what is being typed. */
function typingIn(sections) {
  const el = document.activeElement;
  if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  if (el.tagName === "INPUT" && /^(checkbox|radio|button|submit|reset)$/.test(el.type)) return false;
  return sections.some((id) => $(id).contains(el));
}

const liveRefresher = createRefresher({
  refreshers: LIVE_REFRESH,
  visible: () => (signedIn ? [current, sheetView].filter(Boolean) : []),
  // chat and a room repaint their messages, never the field being typed in
  busy: (view) => (view === "board" && boardBusy()) || (view !== "chat" && view !== "rooms" && typingIn(VIEWS[view].sections)),
  hidden: () => document.visibilityState !== "visible",
});

const live = createLive({
  EventSource: typeof window.EventSource === "function" ? window.EventSource : null,
  onEvent(type, data) {
    if (type === "needs_you.changed") {
      if (Number.isFinite(data.waiting)) setNeeds(data.waiting);
      else refreshNeeds().catch(() => {});
    }
    liveRefresher.queue(viewsFor(type, data, { artifact_id: artOpen?.id }));
  },
  // `resync`, or a fresh stream after the browser gave up: what changed in between is unknown
  onReload() {
    refreshNeeds().catch(() => {});
    liveRefresher.queue(Object.keys(LIVE_REFRESH));
  },
  onState(state) { document.body.dataset.stream = state; },
});

/**
 * Signed in: the chat's and the count's fallback polls, and the stream —
 * when `GET /api/identity` says this console serves it (the `events`
 * capability). Without it, or without `EventSource`, the polls are all there is.
 */
async function goLive() {
  pollChat();
  watchNeeds();
  let events = false;
  try {
    const res = await fetch("/api/identity");
    if (res.ok) events = ((await res.json()).capabilities ?? []).includes(EVENTS_CAPABILITY);
  } catch { /* unreadable: poll */ }
  if (signedIn) live.start({ stream: events });
}

document.addEventListener("focusout", () => setTimeout(() => liveRefresher.flush(), 0)); // a deferred refetch lands once the field is left
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  liveRefresher.flush();
  live.nudge();
});
window.addEventListener("online", () => live.nudge());

// ----- boot -----
// Last, so that everything above exists before the first view loads. Booting
// from the middle of the module loaded a view into constants the module had
// not reached yet — the feed's chips were in their temporal dead zone, and the
// home tab never painted on first load.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); // push degrades absent
try {
  const probe = await fetch("/api/status");
  // a #/artifacts/… or #/rooms/work/… link (what a proposal carries) opens straight there; Today is home
  if (probe.ok) { show(artifactRoute() ? "artifacts" : roomRoute() ? "rooms" : HOME); replayDraft(); goLive(); } else showAuth();
} catch { showAuth(); }
