// PWA shell — vanilla, no framework (recipes over frameworks). Auth via
// passkeys; API calls carry the session cookie. Drafts survive re-auth:
// the composer stashes to localStorage and replays after sign-in.

import { renderMarkdown } from "./md.js";
// Shared, DOM-free helpers; each view that has its own file imports them too.
import { asNum, attr, barHtml, bodyClass, clockTime, dateTime, esc, fmtUsd } from "./lib.js";
// The views split out of this file (T7-3a, screen 18 §2–§3; T7-3b, §5),
// mounted below with the shell's doors: this file is the shell, and imports
// them; they never import it.
import { mountKnowledge } from "./knowledge.js";
import { mountMore } from "./more.js";
import { mountNeedsYou } from "./needs-you.js";
// Notifications and install (T7-5, screen 18 §6): the ask, the install sheet, Settings' push rows.
import { mountNotify } from "./notify.js";
import { mountToday } from "./today.js";
import { artifactRoute, mountWork, roomRoute } from "./work.js";
// The live-changes stream and the polls it stands in for (T7-7, §2.20).
import { EVENTS_CAPABILITY, createLive, createRefresher, viewsFor } from "./live.js";
// Offline: the outbox for captures and ticks, and whether the console answers (T7-4, screen 18 §4).
import { NotQueueable, READS_CACHE, bandText, createOutbox, drainedText, keptStore, readAt, unreached } from "./offline.js";

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
let enrollCode = new URLSearchParams(location.hash.slice(1)).get("enroll"); // spent once the device is enrolled

async function api(path, opts = {}) {
  const res = await net(path, { ...opts, headers: { "content-type": "application/json", ...opts.headers } });
  if (res.status === 401) { forgetReads(); showAuth(); throw new Error("unauthenticated"); }
  return res;
}

/**
 * Every request the shell makes, and what it says about the connection
 * (T7-4): a fetch that throws, a gateway's 502/504, or a read the worker
 * answered from its cache is the console not reached; anything else is the
 * console answering.
 */
async function net(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    lost();
    throw e;
  }
  if (unreached(res)) lost(readAt(res));
  else found();
  return res;
}

/** A 401: the session is over, so the reads the worker kept for it go too. */
function forgetReads() {
  if (typeof caches === "object" && caches) caches.delete(READS_CACHE).catch(() => {});
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
// A push is named by what it shows — a card by its title — so `show()` takes
// the title (and, where a push has two ways in, the way back) with it;
// `label` is what a back button says when a Work child is the way back.
const TABS = ["today", "chat", "work", "knowledge", "more"];
const HOME = "today";
const VIEWS = {
  today: { tab: "today", title: "Today", sections: ["today"] },
  chat: { tab: "chat", title: "Chat", sections: ["chat"] },
  board: { tab: "work", title: "Work", label: "Board", sections: ["board"], segment: true },
  projects: { tab: "work", title: "Work", label: "Projects", sections: ["projects"], segment: true },
  artifacts: { tab: "work", title: "Work", label: "Artifacts", sections: ["artifacts"], segment: true },
  // Work's pushes (screen 18 §5): every tap on a card opens it (C84); its
  // room is a push from the card; a project and an artifact from their lists.
  card: { tab: "work", title: "Card", sections: ["card"], back: "board" },
  rooms: { tab: "work", title: "Room", sections: ["rooms"], back: "card" },
  project: { tab: "work", title: "Project", sections: ["project"], back: "projects" },
  artifact: { tab: "work", title: "Artifact", sections: ["artifact"], back: "artifacts" },
  knowledge: { tab: "knowledge", title: "Knowledge", sections: ["knowledge"] },
  area: { tab: "knowledge", title: "Area", sections: ["area"], back: "knowledge" },
  page: { tab: "knowledge", title: "Page", sections: ["page"], back: "knowledge" },
  more: { tab: "more", title: "More", sections: ["more"] },
  feed: { tab: "more", title: "Activity", sections: ["feed"], back: "more" },
  agents: { tab: "more", title: "Agents", sections: ["agents"], back: "more" },
  agent: { tab: "more", title: "Agent", sections: ["agent"], back: "agents" },
  settings: { tab: "more", title: "Settings", sections: ["status", "devices"], back: "more" },
  // The bell's sheet under 900px; at 900px a view, reached from its sidebar row.
  triage: { tab: null, title: "Needs You", sections: ["triage"], sheet: "narrow" },
  capture: { tab: null, title: "Capture", sections: ["capture"], sheet: "always" },
  usage: { tab: null, title: "Usage", sections: ["usage"], sheet: "always" },
  // Move to… (a card's action sheet) and an artifact's thread (screen 18 §5).
  move: { tab: null, title: "Move to…", sections: ["move"], sheet: "always" },
  thread: { tab: null, title: "Comments", sections: ["art-thread"], sheet: "always" },
  // Install on iPhone (screen 18 §6): three steps, from More or from the ask.
  install: { tab: null, title: "Install", sections: ["install"], sheet: "always" },
};
const SECTIONS = [...new Set(Object.values(VIEWS).flatMap((v) => v.sections))];

const WIDE = window.matchMedia("(min-width: 900px)");
let current = null; // the view in place; a sheet sits over it
let beneath = HOME; // the last view in place that was not Needs You
let sheetView = null; // the view the sheet has borrowed, while it is open
let lastWork = "board"; // the Work tab and row return to the child left open
let signedIn = false;
let pushed = {}; // the title and way back the view in place was shown with

/** `work` is the Work tab or row: the child last open. An unknown name is home. */
const resolveView = (view) => (view === "work" ? lastWork : Object.hasOwn(VIEWS, view) ? view : HOME);
/** Whether a view arrives in the sheet at this width. */
const inSheet = (v, wide) => v.sheet === "always" || (v.sheet === "narrow" && !wide);
/**
 * Where the back button goes, if anywhere. At 900px More is the sidebar, so
 * its rows are places of their own and nothing pushes back to it.
 */
const backFor = (v, wide) => (v.back && !(wide && v.back === "more") ? v.back : null);

/**
 * Go to a view: in place, or in the sheet. Every door in the shell calls this.
 * `title` names a push (or a sheet) by what it shows; `back` is the way back
 * for a push with two ways in.
 */
function show(view, { title = null, back = null } = {}) {
  view = resolveView(view);
  const v = VIEWS[view];
  if (inSheet(v, WIDE.matches)) return openSheet(view, title);
  closeSheet();
  signedIn = true;
  chrome(true);
  const moved = view !== current;
  current = view;
  pushed = { title, back };
  if (view !== "triage") beneath = view;
  if (v.segment) lastWork = view;
  if (moved) { shownAt = null; $("reach-receipt").textContent = ""; paintReach(); } // the stamp is the view's own
  $("auth").hidden = true;
  for (const id of SECTIONS) $(id).hidden = !v.sections.includes(id);
  dropRouteHash(view);
  paintShell();
  if (moved) window.scrollTo(0, 0);
  loadView(view);
}

function loadView(view) {
  const load = {
    today: today.load, feed: loadFeedView, chat: loadMessages, settings: loadSettings, triage: needsYou.load, usage: loadUsage,
    ...work, ...knowledge, ...more,
  }[view];
  if (typeof load === "function") Promise.resolve(load()).catch(() => {});
}

/** Name the push in place once what it shows has been read (a link opened straight from a hash). */
function retitle(title) {
  pushed = { ...pushed, title };
  paintShell();
}

// A room or an artifact link lives in the hash; leaving that view drops it, so
// the same card opens its room again the next time it is tapped.
function dropRouteHash(view) {
  const h = location.hash;
  if ((h.startsWith("#/rooms/") && view !== "rooms") || (h.startsWith("#/artifacts/") && view !== "artifact")) {
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
  const title = pushed.title ?? v.title;
  $("title").textContent = title;
  $("bar-title").textContent = title;
  const back = pushed.back ?? backFor(v, WIDE.matches);
  $("back").hidden = !back;
  if (back) {
    const to = VIEWS[back].label ?? VIEWS[back].title;
    $("back").dataset.view = back;
    $("back-label").textContent = to;
    $("back").setAttribute("aria-label", `Back to ${to}`);
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
  $("enroll-form").hidden = !enrollCode;
  $("enroll-btn").hidden = !enrollCode;
  if (enrollCode && !$("enroll-label").value) $("enroll-label").value = deviceName(navigator.userAgent);
  $("auth-msg").textContent = enrollCode ? "Enroll This Device" : "Sign In";
}

// ----- the sheet: the bell's Needs You, Capture and Usage (screen 18 §1) -----
// One native modal <dialog>, which borrows the view's own section while it is
// open and puts it back in <main> when it closes — Done, Esc or a tap on the
// scrim. The section keeps its ids and handlers wherever it sits.
function openSheet(view, title = null) {
  if (sheetView === view) return;
  restoreSheet();
  const v = VIEWS[view];
  const section = $(v.sections[0]);
  sheetView = view;
  $("sheet-title").textContent = title ?? v.title;
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
  notify.needs(n); // the notifications ask comes in context: the first time something waits
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

// ----- auth: a wall, not an alert (screen 18 §0, §7.4) -----
// Enrolment is a one-time link opened on the device (`#enroll=`), then a
// passkey. No window.alert and no window.prompt: the device's name is a field on the
// wall, and every refusal is a line under the buttons in the owner's words.
const AUTH_WORDS = {
  code: "This link has expired or was already used. Make a new one on your Mac.",
  enroll: "This device couldn't be enrolled. The link may have expired — make a new one on your Mac.",
  signin: "Sign-in didn't work. Try again.",
  cancelled: "No passkey was used. Try again when you're ready.",
  network: "Can't reach Metistry. Check the connection and try again.",
};

/** The line a failed step leaves on the wall: a cancelled passkey sheet, no network, or the step's own. */
function authFailure(step, err) {
  if (err?.name === "NotAllowedError" || err?.name === "AbortError") return AUTH_WORDS.cancelled;
  if (err instanceof TypeError) return AUTH_WORDS.network; // fetch rejects with a TypeError when it cannot connect
  return AUTH_WORDS[step];
}

/** A first guess at the device's name, which the owner can change before enrolling. */
function deviceName(ua) {
  const s = String(ua ?? "");
  if (/iPhone|iPod/.test(s)) return "iPhone";
  if (/iPad/.test(s)) return "iPad";
  if (/Android/.test(s)) return "Android";
  if (/Macintosh/.test(s)) return "Mac";
  if (/Windows/.test(s)) return "Windows";
  return "This Device";
}

function authSay(text) {
  $("auth-error").textContent = text;
}

/** Run one wall step with its buttons held, so a second tap cannot start a second ceremony. */
async function authStep(step, run) {
  authSay("");
  for (const id of ["login-btn", "enroll-btn"]) $(id).disabled = true;
  try {
    await run();
  } catch (err) {
    authSay(authFailure(step, err));
  } finally {
    for (const id of ["login-btn", "enroll-btn"]) $(id).disabled = false;
  }
}

$("enroll-btn").onclick = () => authStep("enroll", async () => {
  const label = $("enroll-label").value.trim() || deviceName(navigator.userAgent);
  const start = await fetch("/auth/enroll/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode }) });
  if (!start.ok) return authSay(AUTH_WORDS.code);
  const { options } = await start.json();
  const response = await startRegistration({ optionsJSON: options });
  const fin = await fetch("/auth/enroll/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode, label, response }) });
  if (!fin.ok) return authSay(AUTH_WORDS.enroll);
  enrollCode = null;
  history.replaceState(null, "", "/");
  show(HOME);
  goLive();
});

$("login-btn").onclick = () => authStep("signin", async () => {
  const start = await fetch("/auth/login/start", { method: "POST" });
  if (!start.ok) return authSay(AUTH_WORDS.signin);
  const { key, options } = await start.json();
  const response = await startAuthentication({ optionsJSON: options });
  const fin = await fetch("/auth/login/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, response }) });
  if (!fin.ok) return authSay(AUTH_WORDS.signin);
  show(hasDraft() ? "chat" : HOME);
  replayDraft();
  goLive();
  drainOutbox();
});

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

// Offline, a message is refused with the reason and never queued (screen 18
// §4): a reply three hours late into a moved-on thread is worse than none
// (docs/ops/client-api.md). The draft stays in the field; Try Again sends it.
function refuseSend(why) {
  $("send-refused-text").textContent = `Not sent — ${why} Your message is still here.`;
  $("send-refused").hidden = false;
}
$("send-retry").onclick = () => $("send-form").requestSubmit();

$("send-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("send-text").value.trim();
  if (!text) return;
  localStorage.setItem("draft", text); // survives a re-auth bounce
  $("send-refused").hidden = true;
  if (offline) return refuseSend("Metistry can't be reached.");
  try {
    const res = await api("/message", { method: "POST", body: JSON.stringify({ text }) });
    if (unreached(res)) return refuseSend("Metistry can't be reached.");
    localStorage.removeItem("draft");
    $("send-text").value = "";
    atBottom = true; // sending is an explicit intent to be at the end of the thread
    $("composer-actions").open = false; // 3.6: the menu never survives a send
    closeSuggest(); // nor does the suggestion list
    loadMessages();
    pollChat(1000); // burst while the reply is in flight
    setTimeout(() => pollChat(), 20000);
  } catch (err) {
    if (err?.message !== "unauthenticated") refuseSend("Metistry can't be reached.");
  }
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
// A capture carries an Idempotency-Key minted before its first attempt. When
// the console cannot be reached it waits in the outbox with that key, and
// sends when it is back (screen 18 §4); a retry of one that did arrive is the
// first answer again, never a second note (docs/ops/client-api.md).
const newKey = (verb) => `${verb}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

$("capture-form").onsubmit = async (e) => {
  e.preventDefault();
  const file = $("capture-file").files[0];
  const note = $("capture-note").value;
  const key = newKey("capture");
  const req = file
    ? { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-metistry-filename": file.name, "idempotency-key": key }, body: file }
    : { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ note }) };
  const done = () => { $("capture-note").value = ""; $("capture-file").value = ""; };
  let res = null;
  if (!offline && !outbox.size) {
    try { res = await net("/capture", req); } catch { res = null; }
  }
  if (!res || unreached(res)) {
    try {
      await outbox.add({ path: "/capture", ...req, meta: { label: file ? file.name : note.trim().split("\n")[0].slice(0, 80) } });
    } catch (err) {
      $("capture-result").textContent = `Not captured — ${err instanceof NotQueueable ? err.message : "it could not be kept on this device"}.`;
      return;
    }
    done();
    $("capture-result").textContent = "Waiting to send — it goes to your inbox when Metistry is back.";
    if (!offline) drainOutbox();
    return;
  }
  if (res.status === 401) { forgetReads(); showAuth(); return; }
  const body = await res.json().catch(() => ({}));
  $("capture-result").textContent = res.ok ? `captured → inbox #${body.id}` : "capture failed";
  if (res.ok) done();
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

// Notifications and install: their own file (T7-5; screen 18 §6). Settings'
// Enable and Test buttons are its too — every outcome is a line, never window.alert.
const notify = mountNotify({ $, api, show });

// ===== offline (T7-4; screen 18 §4; design-build-plan §2.17) =====
// One rule per verb. Reading shows the last view, stamped with when it was
// read (sw.js keeps the reads). A capture and a tick wait in the outbox and
// replay with their Idempotency-Key — the tick through the Tick door's 409.
// An answer, a move, Run Now, a mode and a grant are not offered: a control
// marked `data-needs-connection` is disabled while the console cannot be
// reached, and the views' own doors refuse too (a swipe, a drag). The outbox
// itself holds nothing else (offline.js), so no path through the PWA queues
// one. A message is refused with its reason, and its draft stays.
let offline = false;
let shownAt = null; // when the view on screen was read, while it is a kept read
let walled = false; // the app opened to the sign-in wall only because the console could not be reached
const PROBE_MS = 15000; // how often, while it cannot be reached, the shell asks again (the "reach" poll, below)
const isOffline = () => offline;

const outbox = createOutbox({
  store: keptStore(typeof indexedDB === "object" ? indexedDB : null),
  send: (e) => net(e.path, { method: e.method, headers: e.headers, body: e.body }),
  onChange: () => { paintReach(); today.outboxChanged(); },
  onResult: (r) => { if (r.entry.verb === "tick") today.replayed(r); },
});

/** The console did not answer. `at` is when a kept read was read, for the stamp. */
function lost(at = null) {
  if (at && (!shownAt || new Date(at) < new Date(shownAt))) shownAt = at;
  if (!offline) {
    offline = true;
    holdControls();
  }
  paintReach();
}

/** The console answered: send what waited, then read what is on screen again. */
function found() {
  if (!offline) return;
  if (walled) return location.reload(); // it can be reached now: open the app the way a launch does
  offline = false;
  shownAt = null;
  holdControls();
  paintReach();
  drainOutbox();
  if (signedIn) {
    liveRefresher.queue(Object.keys(LIVE_REFRESH)); // what is on screen was read while it could not be
    live.nudge();
  }
}

/** Is the console there? `/api/identity` is public and small; the worker answers it from its cache only when the network does not. */
function probe() {
  net("/api/identity", { cache: "no-store" }).catch(() => {});
}

async function drainOutbox() {
  if (!outbox.size) return;
  const r = await outbox.drain();
  const said = drainedText(r.done);
  if (said) $("reach-receipt").textContent = said;
  if (r.reason === "unauthenticated") { forgetReads(); showAuth(); }
  else if (r.reason === "later") setTimeout(() => { if (!offline) drainOutbox(); }, 30000);
}

/** The band under the header: what is wrong, and what still works (screen 18 §4). */
function paintReach() {
  document.body.dataset.reach = offline ? "offline" : "online";
  $("offline-band").hidden = !offline;
  if (!offline) return;
  const b = bandText({ shownAt, waiting: outbox.size });
  $("offline-title").textContent = b.title;
  $("offline-why").textContent = b.detail;
}

/**
 * What needs the console's answer is not offered while it cannot be reached:
 * disabled — the disabled ink — and described by the band. A view that
 * repaints while offline is held again as it lands; what was held is given
 * back when the console answers, and nothing a view disabled itself.
 */
function holdControls() {
  for (const el of document.querySelectorAll("[data-needs-connection]")) {
    if (offline && !el.disabled) {
      el.disabled = true;
      el.dataset.heldOffline = "";
      el.setAttribute("aria-describedby", "offline-title");
    } else if (!offline && el.dataset.heldOffline !== undefined) {
      el.disabled = false;
      delete el.dataset.heldOffline;
      el.removeAttribute("aria-describedby");
    }
  }
}
new MutationObserver(() => { if (offline) holdControls(); }).observe(document.body, { childList: true, subtree: true });

window.addEventListener("offline", () => lost());
window.addEventListener("online", probe);
document.addEventListener("visibilitychange", () => { if (offline && document.visibilityState === "visible") probe(); });

// ----- Today and Needs You: their own files (T7-3a; screen 18 §2–§3) -----
// Mounted with the shell's doors; `loadView` calls their `load`. Today ticks
// through the outbox when the console cannot be reached; no other view is
// handed it.
const today = mountToday({ $, api, show, outbox, offline: isOffline });
const needsYou = mountNeedsYou({ $, api, setNeeds, show, offline: isOffline });

// ----- Work, Knowledge and More ▸ Agents: their own files (T7-3b; screen 18 §5) -----
// Each returns its views' `load`s by view name, for `loadView`.
const work = mountWork({ $, api, show, closeSheet, retitle, poll: (fn, ms) => live.poll("board", fn, ms), offline: isOffline });
const knowledge = mountKnowledge({ $, api, show, retitle });
const more = mountMore({ $, api, show, offline: isOffline });

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

// ===== Usage and the review list (the Phase 4 dashboard, placed by the shell) =====
// Every server value is output-encoded via esc() before it touches the DOM
// (CRIT-7); only a https://github.com/ url may become a link. Numbers pass
// through lib.js's asNum() first — bar widths are numbers we computed, never
// server text. Work ▸ Projects is work.js's (T7-3b).
const fmtK = (v) => { const n = asNum(v); return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); };
const fmtDay = (v) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T00:00:00`) : new Date(v); // a bare date is local, not UTC
  return Number.isNaN(d.getTime()) ? String(v ?? "") : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
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

// The old dashboard, where the shell gives it: the Usage sheet the spend.
// Today is the day itself (today.js).
function loadUsage() {
  return loadPanels({
    spend: async () => renderSpend(await dashQuery("claude_usage_daily", { days: 30 })),
    aws: async () => renderAws(...(await Promise.all([dashQuery("aws_costs_daily", { days: 30 }), dashQuery("aws_costs_recent", { days: 30 })]))),
  });
}

async function loadSettings() {
  await Promise.all([loadStatus(), loadDevices(), notify.settings()]);
}

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
// `routine_run` is in: its subject is the routine's display name
// (the runner's `meta.display_name` stamp, read by `activity_feed`; Ruling 25,
// X-21) — already
// Title Case, so the identifier guard below leaves it as it is; a row from
// before that stamp existed still reads as a name, not a raw slug like
// `plan-tomorrow`, via the query's own identifier-to-title fallback.
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
  // Work, Knowledge and More ▸ Agents refetch through their modules' loads (T7-3b)
  board: () => work.refresh(),
  card: () => work.refresh(),
  rooms: () => work.rooms(),
  projects: () => work.projects(),
  project: () => work.projects(), // repaints the project pushed
  artifacts: () => work.artifacts(),
  artifact: () => work.refreshThreads(),
  thread: () => work.refreshThreadSheet(),
  knowledge: () => knowledge.knowledge(),
  area: () => knowledge.area(),
  page: () => knowledge.page(),
  agents: () => more.refresh(),
  agent: () => more.refresh(),
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
  busy: (view) => ((view === "board" || view === "card") && work.busy()) || (view !== "chat" && view !== "rooms" && typingIn(VIEWS[view].sections)),
  hidden: () => document.visibilityState !== "visible",
});

const live = createLive({
  EventSource: typeof window.EventSource === "function" ? window.EventSource : null,
  onEvent(type, data) {
    if (type === "needs_you.changed") {
      if (Number.isFinite(data.waiting)) setNeeds(data.waiting);
      else refreshNeeds().catch(() => {});
    }
    liveRefresher.queue(viewsFor(type, data, { artifact_id: work.artifactId }));
  },
  // `resync`, or a fresh stream after the browser gave up: what changed in between is unknown
  onReload() {
    refreshNeeds().catch(() => {});
    liveRefresher.queue(Object.keys(LIVE_REFRESH));
  },
  onState(state) {
    document.body.dataset.stream = state;
    if (state === "live") found();
    else if (state === "down") probe(); // the stream dropping is the first sign; the probe says whether it is the console
  },
});

// While the console cannot be reached, ask again every PROBE_MS (T7-4). The
// stream is down whenever the console is, so like every poll here this runs
// only then; and it asks only while the shell believes it offline.
live.poll("reach", () => { if (offline) probe(); }, PROBE_MS);

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

// A tapped notification, with this window already open: sw.js focuses it and names the page (T7-5).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "metistry.open" && signedIn) openLink(e.data.url);
  });
}

/** A notification's link: Needs You, or the card or room it names (work.js follows the hash); anything else is home. */
function openLink(url) {
  let hash = "";
  try { hash = new URL(String(url), location.origin).hash; } catch { /* home */ }
  if (hash.startsWith("#/needs-you")) return show("triage");
  if (artifactRoute(hash) || roomRoute(hash)) { location.hash = hash; return; }
  show(HOME);
}

// ----- boot -----
// Last, so that everything above exists before the first view loads. Booting
// from the middle of the module loaded a view into constants the module had
// not reached yet — the feed's chips were in their temporal dead zone, and the
// home tab never painted on first load.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); // push and the offline shell degrade absent
await outbox.load().catch(() => {}); // what waited when the app last closed: Today draws its ticks as waiting
if (navigator.onLine === false) lost();
try {
  // with no network the worker answers from the last read: the app opens on what it last showed, with the band
  const status = await net("/api/status");
  // a #/artifacts/… or #/rooms/work/… link (what a proposal carries) opens straight there; Today is home
  // #/needs-you (a notification's tap, sw.js) opens Needs You over home
  if (status.ok) {
    show(artifactRoute(location.hash) ? "artifact" : roomRoute(location.hash) ? "rooms" : HOME);
    if (location.hash.startsWith("#/needs-you")) { history.replaceState(null, "", location.pathname + location.search); show("triage"); }
    replayDraft();
    goLive();
    drainOutbox();
  } else { if (status.status === 401) forgetReads(); showAuth(); }
} catch { walled = offline; showAuth(); } // never read and not reachable: the sign-in wall, under the band that says why
