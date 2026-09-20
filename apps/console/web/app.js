// PWA shell — vanilla, no framework (recipes over frameworks). Auth via
// passkeys; API calls carry the session cookie. Drafts survive re-auth:
// the composer stashes to localStorage and replays after sign-in.

import { renderMarkdown } from "./md.js";

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
const views = ["feed", "chat", "board", "dashboard", "capture", "triage", "status", "devices", "agents", "artifacts", "rooms"];
const enrollCode = new URLSearchParams(location.hash.slice(1)).get("enroll");

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...opts.headers } });
  if (res.status === 401) { showAuth(); throw new Error("unauthenticated"); }
  return res;
}

function show(view) {
  $("nav").hidden = false; $("auth").hidden = true;
  for (const v of views) $(v).hidden = v !== view;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  ({ feed: loadFeedView, chat: loadMessages, board: loadBoardView, dashboard: loadDashboard, status: loadStatus, devices: loadDevices, triage: loadTriage, agents: loadAgents, artifacts: loadArtifacts, rooms: loadRooms }[view] ?? (() => {}))();
}

function showAuth() {
  $("nav").hidden = true;
  for (const v of views) $(v).hidden = true;
  $("auth").hidden = false;
  $("enroll-btn").hidden = !enrollCode;
  if (enrollCode) $("auth-msg").textContent = "enroll this device (one-time code detected)";
}

// ----- auth -----
$("enroll-btn").onclick = async () => {
  const start = await fetch("/auth/enroll/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode }) });
  if (!start.ok) return alert("code invalid or expired — mint a new one on the host");
  const { options } = await start.json();
  const response = await startRegistration({ optionsJSON: options });
  const label = prompt("name this device (e.g. Matt's iPhone)", "device") ?? "device";
  const fin = await fetch("/auth/enroll/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode, label, response }) });
  if (fin.ok) { history.replaceState(null, "", "/"); show("chat"); } else alert("enrollment failed");
};

$("login-btn").onclick = async () => {
  const start = await fetch("/auth/login/start", { method: "POST" });
  const { key, options } = await start.json();
  const response = await startAuthentication({ optionsJSON: options });
  const fin = await fetch("/auth/login/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, response }) });
  if (fin.ok) { show("chat"); replayDraft(); } else alert("sign-in failed");
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
    .map((m) => `<li class="${m.direction}"><div class="meta">${new Date(m.ts).toLocaleString()}${m.direction === "in" ? ` · ${m.status}` : ""}${tierChip(m)}</div>${replyParagraphs(m.text)}${m.direction === "out" ? tapbacks(m) : ""}</li>`)
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

// live updates: poll while the chat is visible; burst after a send
let pollTimer = null;
function pollChat(intervalMs = 2500) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
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
async function loadStatus() {
  const res = await api("/api/status");
  const { checks } = await res.json();
  $("checks").innerHTML = checks
    .map((c) => `<li><span>${c.name} <span class="muted">${esc(c.probe)}</span></span><span class="${c.status === "ok" ? "ok" : "failed"}">${c.status} · ${c.latency_ms}ms</span></li>`)
    .join("");
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

// ----- Needs You (D7: ONE queue for everything that needs the user). Every
// row is a REQUEST, and a request has one of seven types (glossary.md):
// note · report · review · question · access · improvement · action. The stored
// `proposals.kind` values are unchanged — this is the view layer mapping the
// eight-or-so internal kinds onto the six words the user reads, so the queue
// has one vocabulary instead of the union of everything that fills it.
// Grouped by type, oldest first; every field output-encoded, attribute values
// quote-safe too (CRIT-7). -----
const REQUEST_TYPE = {
  decision: "question",
  grant_elevation: "access",
  access_request: "access",
  improvement: "improvement",
  knowledge: "note",
  draft_settle: "note",
  action: "action",
  report: "report",
  review: "review",
};
// group headings, so Title Case (P10)
const TYPE_LABEL = {
  note: "Notes",
  report: "Reports",
  review: "Reviews",
  question: "Questions",
  access: "Access",
  improvement: "Improvements",
  action: "Actions",
};
const requestType = (kind) => REQUEST_TYPE[kind] ?? kind;
// Approve / Revise / Decline are the three answers to every request. The wire
// (and `proposals.decision`) keeps allow / accept_with_changes / deny.
//
// Later and Skip are the two that are NOT answers to the request
// (docs/ops/reply-feedback.md): Later gives the row an `until` and leaves it
// pending, Skip declines it with nothing to say. They are valid for every
// kind — including a `decision` proposal answered with its own options —
// because "I cannot deal with this right now" is true of anything.
const DECISIONS = [
  { d: "allow", label: "Approve" },
  { d: "accept_with_changes", label: "Revise" },
  { d: "deny", label: "Decline", style: ' style="background:#7a3b3b"' },
];
const DEFER = [
  { d: "later", label: "Later" },
  { d: "skip", label: "Skip" },
];
const attr = (s) => esc(s).replaceAll('"', "&quot;");

// Multi-select. Ids the user ticked, and the `ts` each row was rendered with
// — the second is what `if_unchanged` sends back, so an answer to a row that
// moved under us is refused rather than applied to a different question.
const picked = new Set();
const seenAt = new Map();
// The rows as they were painted — an answer that needs a field off the row
// (an access request's area) reads it from what the user was SHOWN.
const rendered = new Map();
const proposalById = (id) => rendered.get(String(id));

/** The one decision call. `if_unchanged` rides every single-row answer; a 409 repaints instead of alerting. */
async function decide(id, body) {
  const seen = seenAt.get(String(id));
  const res = await api(`/api/proposals/${id}`, {
    method: "POST",
    body: JSON.stringify({ ...body, ...(seen ? { if_unchanged: { seen_at: seen } } : {}) }),
  });
  if (res.status === 409) {
    const b = await res.json().catch(() => ({}));
    // `stale` means the row changed, not that someone answered it: repaint
    // and let the user read the new version before deciding again.
    if (b.reason === "stale") alert("this one changed while it was on screen — here it is again");
    return false;
  }
  const answered = await res.json().catch(() => ({}));
  // An `action` is the one verb whose allow DOES something (docs/ops/actions.md).
  // What it did is held for the next paint rather than alerted: the row leaves
  // the queue on success, and "it worked, here is what it made" belongs where
  // the row was, not in a modal. A refusal keeps the row and says why.
  lastAction = res.ok
    ? (answered.action ? { ok: true, ...answered.action } : null)
    : (answered.error ? { ok: false, message: answered.error.message ?? "refused" } : lastAction);
  return res.ok;
}

// What the last action did, rendered once above the queue and then forgotten.
let lastAction = null;
const ACTION_NOISE = ["ok", "kind", "at", "by", "on_behalf_of"];
function actionNote(a) {
  if (!a.ok) return `refused — ${a.message}`;
  const parts = Object.entries(a).filter(([k]) => !ACTION_NOISE.includes(k)).map(([k, v]) => `${k} ${v}`);
  return `${a.kind}${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

async function loadTriage() {
  const res = await api("/api/proposals");
  const { proposals } = await res.json();
  $("triage-empty").hidden = proposals.length > 0;
  const tab = document.querySelector('nav button[data-view="triage"]');
  if (tab) tab.textContent = proposals.length ? `Needs You (${proposals.length})` : "Needs You";
  const live = new Set(proposals.map((p) => String(p.id)));
  for (const id of [...picked]) if (!live.has(id)) picked.delete(id); // a row that left the queue leaves the selection
  seenAt.clear();
  rendered.clear();
  for (const p of proposals) { seenAt.set(String(p.id), p.ts); rendered.set(String(p.id), p); }
  const groups = new Map();
  for (const p of [...proposals].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    const type = requestType(p.kind);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(p);
  }
  const note = lastAction ? `<li class="muted">last action — ${esc(actionNote(lastAction))}</li>` : "";
  lastAction = null; // said once; the record keeps it (runs, and the proposal's payload.result)
  $("proposal-list").innerHTML = note + [...groups]
    .map(([type, rows]) => `<li class="muted">${esc(TYPE_LABEL[type] ?? type)} · ${rows.length}</li>` + rows.map(proposalRow).join(""))
    .join("");
  document.querySelectorAll("[data-triage]").forEach((b) => (b.onclick = async () => {
    const body = { decision: b.dataset.d };
    // Revise is the answer that carries a reason: without one the assistant
    // has nothing to change, so an empty note cancels rather than sends.
    //
    // On an `access_request` the thing to revise is the AREA — Revise is how
    // you grant a narrower prefix than the one asked for — so it asks for
    // that instead, pre-filled with the ask. The server validates it with the
    // grants validator's own rule and refuses anything else.
    if (b.dataset.d === "accept_with_changes") {
      const row = b.dataset.kind === "access_request" ? proposalById(b.dataset.triage) : null;
      if (row) {
        const area = (prompt("grant which folder instead?", row.payload?.area ?? "") ?? "").trim();
        if (!area) return;
        body.area = area;
      } else {
        const feedback = (prompt("what should change?") ?? "").trim();
        if (!feedback) return;
        body.feedback = feedback;
      }
    }
    await decide(b.dataset.triage, body);
    loadTriage();
  }));
  document.querySelectorAll("[data-pick]").forEach((c) => (c.onchange = () => {
    if (c.checked) picked.add(c.dataset.pick);
    else picked.delete(c.dataset.pick);
    renderBatchBar();
  }));
  renderBatchBar();
}

function renderBatchBar() {
  const bar = $("triage-batch");
  if (!bar) return;
  bar.hidden = picked.size === 0;
  $("triage-selected").textContent = picked.size ? `${picked.size} selected — l / s` : "";
  for (const c of document.querySelectorAll("[data-pick]")) c.checked = picked.has(c.dataset.pick);
}

/** One verb, many rows. The server answers per row; anything it refused stays in the queue and says so. */
async function batchDecide(decision) {
  if (picked.size === 0) return;
  const ids = [...picked].map(Number);
  const res = await api("/api/proposals/batch", { method: "POST", body: JSON.stringify({ ids, decision }) });
  if (res.ok) {
    const { results } = await res.json();
    const failed = results.filter((r) => !r.ok).length;
    if (failed) alert(`${results.length - failed} of ${results.length} applied — the rest were already answered elsewhere`);
  }
  picked.clear();
  loadTriage();
}

/**
 * An `action` row says what it would DO before you answer it
 * (docs/ops/actions.md): the kind, a short preview of its own arguments, and
 * the reason the agent gave. Arguments are agent-authored text, so every one
 * of them is output-encoded and clipped — the queue renders a claim, never a
 * document. `payload.result` (after an allow) and `payload.error` (after a
 * failure that left the row pending) render the same way.
 */
const ARG_PREVIEW_CHARS = 140;
function actionDetail(p) {
  if (p.kind !== "action") return "";
  const a = p.payload?.action ?? {};
  const args = Object.entries(a.args ?? {})
    .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(" ")
    .slice(0, ARG_PREVIEW_CHARS);
  const outcome = p.payload?.result
    ? `<br><span class="muted">done — ${esc(actionNote({ ok: true, kind: a.kind, ...p.payload.result }))}</span>`
    : p.payload?.error
      ? `<br><span class="muted">last try refused — ${esc(String(p.payload.error.message ?? p.payload.error.code ?? ""))}</span>`
      : "";
  return `<br><span class="muted"><b>${esc(a.kind ?? "?")}</b> ${esc(args)}</span>${p.payload?.reason ? `<br><span class="muted">why: ${esc(String(p.payload.reason).slice(0, ARG_PREVIEW_CHARS))}</span>` : ""}${outcome}`;
}

/**
 * An `access_request` row says what it is asking for before you answer it
 * (docs/ops/actions.md): the area, the reason the agent gave, and what that
 * credential holds today — agent-authored text, so output-encoded and clipped
 * like an action's arguments. The `index` → `areas` note is the consequence
 * that is easy to miss: an agent at tier `index` can be told any title in the
 * vault and read none, and granting it one folder trades that browse for the
 * read. Approving is a choice between two scopes, not a pure widening.
 */
function accessDetail(p) {
  if (p.kind !== "access_request") return "";
  const held = p.payload?.current_tier === "areas" ? `folders ${(p.payload?.current_areas ?? []).map(esc).join(", ")}` : esc(accessLabel(p.payload?.current_tier ?? "none"));
  const trade = p.payload?.current_tier === "index" ? " — approving trades its whole-vault title browse for reads inside that folder" : "";
  const done = p.payload?.granted ? `<br><span class="muted">granted — ${esc(String(p.payload.granted.area ?? ""))}</span>` : "";
  return `<br><span class="muted">wants <b>${esc(String(p.payload?.area ?? "?"))}</b> · has ${held}${esc(trade)}</span>` +
    `${p.payload?.reason ? `<br><span class="muted">why: ${esc(String(p.payload.reason).slice(0, ARG_PREVIEW_CHARS))}</span>` : ""}${done}`;
}

function proposalRow(p) {
  const c = p.payload?.classification ?? {};
  const label = c.action || c.title || p.payload?.title || p.kind; // review proposals (§4.21) carry a top-level title
  // a `decision` proposal is answered with its OWN options (the server checks them again)
  const opts = p.kind === "decision" && Array.isArray(p.payload?.options) ? p.payload.options.slice(0, 8) : null;
  // Approve as work: only where the row CARRIES a suggestion the drain or a
  // crew put there deterministically. The click is what creates the `work`
  // row (§4.12 intact — a human clicked); the server validates the payload
  // again and refuses the verb on a row that has none.
  const work = p.payload?.suggested_work;
  const answers = opts
    ? opts.map((o) => `<button data-triage="${p.id}" data-d="${attr(o)}">${esc(o)}</button>`).join(" ")
    : DECISIONS.map((x) => `<button data-triage="${p.id}" data-d="${x.d}" data-kind="${attr(p.kind)}"${x.style ?? ""}>${x.label}</button>`).join(" ");
  const asWork = work?.title
    ? ` <button data-triage="${p.id}" data-d="accept_as_work" title="${attr(`creates the task “${work.title}”, unassigned`)}">Approve as Work</button>`
    : "";
  const defer = DEFER.map((x) => `<button data-triage="${p.id}" data-d="${x.d}" class="quiet">${x.label}</button>`).join(" ");
  return `<li><span><input type="checkbox" data-pick="${p.id}" aria-label="${attr(`select ${label}`)}"> ${esc(label)} <span class="muted">${esc(requestType(p.kind))} · ${esc(c.kind ?? "")} · ${esc(p.source_agent)} · ${new Date(p.ts).toLocaleDateString()}</span>${actionDetail(p)}${accessDetail(p)}</span>
        <span>${answers}${asWork} ${defer}</span></li>`;
}

$("triage-later").onclick = () => batchDecide("later");
$("triage-skip").onclick = () => batchDecide("skip");
$("triage-clear").onclick = () => { picked.clear(); renderBatchBar(); };

// `l` and `s` over the selection. Never while typing — a shortcut that fires
// from inside a text field is a bug, not an affordance.
document.addEventListener("keydown", (e) => {
  if ($("triage").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  if (e.key === "l") { e.preventDefault(); batchDecide("later"); }
  if (e.key === "s") { e.preventDefault(); batchDecide("skip"); }
});

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

document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.view)));
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }

// ----- boot -----
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); // push degrades absent
try {
  const probe = await fetch("/api/status");
  if (probe.ok) { show(artifactRoute() ? "artifacts" : roomRoute() ? "rooms" : "feed"); replayDraft(); pollChat(); } else showAuth(); // a #/artifacts/… or #/rooms/work/… link (what a proposal carries) opens straight there; feed is the home tab
} catch { showAuth(); }

// ----- agents (external-agent registry; every agent-authored field output-encoded — CRIT-7) -----
// The token is shown exactly once, at mint/rotate; the list never carries it.
// One noun per thing (glossary.md): every agent shows a ROLE — assistant (this
// instance's own), helper (one the user defined under agents/), external —
// and an ACCESS tier read as none / titles / folders. Both are labels over
// the stored values (kind internal|external, tier none|index|areas), which do
// not change.
const ROLE_LABEL = { internal: "assistant", external: "external", crew: "helper" };
// The action vocabulary, and the same resolution the server does
// (packages/core/src/actions.ts). Duplicated here because the PWA is plain
// modules with no bundler — the SERVER re-validates every change, so this copy
// is a view, never a gate. The order is the enum's.
const ACTION_KINDS = ["dispatch", "task_update", "comment", "capture"];
const AUTONOMY_LEVELS = ["observe", "propose", "act_within_scope"];
const LEVEL_CEILING = { observe: "deny", propose: "propose", act_within_scope: "allow" };
const ACTION_DEFAULTS = {
  observe: { dispatch: "deny", task_update: "deny", comment: "deny", capture: "deny" },
  propose: { dispatch: "propose", task_update: "propose", comment: "propose", capture: "propose" },
  act_within_scope: { dispatch: "propose", task_update: "allow", comment: "allow", capture: "allow" },
};
const MODE_RANK = { deny: 0, propose: 1, allow: 2 };
const levelOf = (au) => (AUTONOMY_LEVELS.includes(au?.level) ? au.level : "observe");
function effectiveActions(au) {
  const level = levelOf(au);
  const ceiling = LEVEL_CEILING[level];
  const out = {};
  for (const k of ACTION_KINDS) {
    const asked = au?.actions?.[k] ?? ACTION_DEFAULTS[level][k];
    out[k] = MODE_RANK[asked] <= MODE_RANK[ceiling] ? asked : ceiling;
  }
  return out;
}
const ACCESS_LABEL = { none: "none", index: "titles", areas: "folders" };
const accessLabel = (t) => ACCESS_LABEL[t] ?? t;
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
      const scope = g.tier === "areas" ? `folders: ${g.areas.map(esc).join(", ")}` : esc(accessLabel(g.tier));
      const projects = (a.projects ?? []).length ? ` · projects: ${a.projects.map(esc).join(", ")}` : "";
      const au = a.autonomy ?? {};
      const narrowing = [
        au.may_dispatch_to ? `delegates to ${au.may_dispatch_to.map(esc).join(", ") || "nobody"}` : "",
        au.accept_from ? `accepts from ${au.accept_from.map(esc).join(", ") || "nobody"}` : "",
        au.max_open_bundles !== undefined ? `max ${Number(au.max_open_bundles) || 0} bundles` : "",
      ].filter(Boolean).join(" · ");
      // The action table, resolved the same way the server resolves it
      // (docs/ops/actions.md) — level as a ceiling, kinds below it. Shown for
      // every row, including `observe`, because "this one can do nothing" is
      // the fact worth being able to see at a glance.
      const table = effectiveActions(au);
      const actionLine = `level: ${esc(levelOf(au))} · ${ACTION_KINDS.map((k) => `${esc(k)} ${esc(table[k])}`).join(" · ")}`;
      const asks = (asked.get(a.id) ?? [])
        .map((r) => `asked for ${esc(r.area)} — ${esc(String(r.reason ?? "").slice(0, 120))} (answer it in Needs You, request #${Number(r.proposal_id)})`)
        .join("<br>");
      const actions = a.revoked
        ? '<span class="muted">revoked</span>'
        : `<span><button data-agent-grants="${esc(a.id)}" class="secondary">grants</button> <button data-agent-rotate="${esc(a.id)}" class="secondary">rotate</button> <button data-agent-revoke="${esc(a.id)}">revoke</button></span>`;
      return `<li class="${a.revoked ? "revoked" : ""}"><span><b>${esc(a.display_name)}</b> <span class="muted">${esc(a.id)}</span> <span class="chip">${esc(ROLE_LABEL[a.kind] ?? a.kind)}</span><br>
        <span class="muted">access: ${scope}${projects} · ${seen}</span>${narrowing ? `<br><span class="muted">autonomy: ${narrowing}</span>` : ""}<br>
        <span class="muted">actions: ${actionLine}</span><br>${asks ? `<span class="muted">${asks}</span><br>` : ""}
        <span id="presence-${esc(a.id)}" class="presence"></span></span>${actions}</li>`;
    })
    .join("");
  document.querySelectorAll("[data-agent-grants]").forEach((b) => (b.onclick = () => openGrants(b.dataset.agentGrants)));
  loadPresence().catch(() => {}); // fills the placeholder spans above from agent_presence (revoked agents get none — the query excludes them)
  document.querySelectorAll("[data-agent-rotate]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.agentRotate;
    if (!confirm(`rotate the token for ${id}? the current token stops working immediately.`)) return;
    const r = await api(`/api/agents/${encodeURIComponent(id)}/rotate`, { method: "POST" });
    if (r.ok) showAgentToken(await r.json()); else alert("rotate failed");
    loadAgents();
  }));
  document.querySelectorAll("[data-agent-revoke]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.agentRevoke;
    if (!confirm(`revoke ${id}? this cannot be undone — register a new agent to re-admit it.`)) return;
    await api(`/api/agents/${encodeURIComponent(id)}/revoke`, { method: "POST" });
    loadAgents();
  }));
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
  if (!r.ok) return alert("invalid — id is a slug (a-z, 0-9, -; max 40) and a display name is required");
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
  // the resolved value) so saving without touching it changes nothing. The
  // level's ceiling is shown beside each as the effective answer.
  $("agent-level").value = levelOf(au);
  renderActionControls(au);
  $("agent-level").onchange = () => renderActionControls(autonomyFromForm());
  $("agent-grants-msg").textContent = "";
  $("agent-grants").hidden = false;
}

/** One select per action kind, plus what the level's ceiling makes of it. Rebuilt whenever the level changes, so the consequence is visible before Save. */
function renderActionControls(au) {
  const stored = au?.actions ?? {};
  const table = effectiveActions(au);
  $("agent-actions").innerHTML = ACTION_KINDS.map((k) => `<label>${esc(k)}
      <select data-action-kind="${esc(k)}">
        <option value="">default for this level (${esc(table[k])})</option>
        <option value="deny">deny — refuse it at the tool</option>
        <option value="propose">propose — ask me</option>
        <option value="allow">allow — run it (act within scope only)</option>
      </select></label>`).join("");
  for (const sel of document.querySelectorAll("[data-action-kind]")) sel.value = stored[sel.dataset.actionKind] ?? "";
  for (const sel of document.querySelectorAll("[data-action-kind]")) sel.onchange = () => renderActionControlsKeepingValues();
}

// Re-render after a kind changes so every "default for this level (…)" label
// stays honest, without losing what the user just picked.
function renderActionControlsKeepingValues() {
  renderActionControls(autonomyFromForm());
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
  if (AUTONOMY_LEVELS.includes(level)) out.level = level;
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
// ===== dashboard (Phase 4 visibility: one place instead of four) =====
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
const asOfText = (as_of) => (as_of ? `as of ${new Date(as_of).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "");
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

function renderRuns({ rows, as_of }) {
  const s = rows[0] ?? {};
  const failed = asNum(s.failures);
  const tiles = [
    ["runs ok", asNum(s.runs_ok), "ok"],
    ["failed", failed, failed > 0 ? "failed" : ""],
    ["turns", asNum(s.turns), ""],
    ["captures", asNum(s.captures), ""],
    ["spend", `$${fmtUsd(s.spend_usd)}`, ""],
  ];
  $("dash-runs").innerHTML = tiles.map(([label, v, cls]) => `<li class="tile"><b class="${cls}">${esc(String(v))}</b><span class="muted">${label}</span></li>`).join("");
  $("dash-runs-note").textContent = s.last_run_at
    ? `${failed > 0 ? "check the status page — " : ""}last activity ${new Date(s.last_run_at).toLocaleString()}`
    : "nothing ran in the last 24h";
  dashStamp("runs", as_of);
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
    loadDashboard();
  }));
  dashStamp("projects", as_of);
}

function renderProjects({ rows, as_of }) {
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

async function loadDashboard() {
  // panels load independently: one absent collector never blanks the page
  const panels = {
    runs: async () => renderRuns(await dashQuery("runs_summary", { hours: 24 })),
    reviews: async () => { const r = await dashQuery("prs_for_review"); $("dash-reviews").innerHTML = reviewListHtml(r.rows); dashStamp("reviews", r.as_of); },
    projects: async () => { renderProjectRows(await (await api("/api/projects")).json()); renderProjects(await dashQuery("projects_overview")); },
    spend: async () => renderSpend(await dashQuery("claude_usage_daily", { days: 30 })),
    aws: async () => renderAws(...(await Promise.all([dashQuery("aws_costs_daily", { days: 30 }), dashQuery("aws_costs_recent", { days: 30 })]))),
  };
  await Promise.all(Object.entries(panels).map(async ([id, load]) => {
    try { await load(); } catch { $(`dash-${id}-asof`).textContent = "unavailable"; }
  }));
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
      <span class="muted">${esc(a.kind ?? "")} · ${esc(a.created_by ?? "")} · ${new Date(a.updated_at).toLocaleString()}</span></li>`)
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
    ? `${version.author_kind === "agent" ? "agent" : "you"}: ${version.author_principal} · ${version.message} · ${new Date(version.created_at).toLocaleString()} · ${version.commit ? `rev ${version.commit.slice(0, 10)}` : "not committed yet"}${version.id === artifact.current_version ? " · current" : ""}`
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
      <div class="row"><label><input type="checkbox" data-thread="${esc(t.id)}" ${t.state === "resolved" ? "disabled" : ""}> ${who(t)} <span class="muted">${t.path ? esc(t.path) + " · " : ""}${new Date(t.created_at).toLocaleString()} · ${esc(t.state)}</span></label>
        <button class="secondary" data-state="${esc(t.id)}" data-op="${t.state === "open" ? "resolve" : "reopen"}">${t.state === "open" ? "resolve" : "reopen"}</button></div>
      <div class="body">${esc(t.body)}</div>
      ${t.replies.map((r) => `<div class="reply"><span class="muted">${who(r)} · ${new Date(r.created_at).toLocaleString()}</span><div class="body">${esc(r.body)}</div></div>`).join("")}
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
    <div class="muted">${who || "—"}${r.last_at ? ` · last ${new Date(r.last_at).toLocaleString()}` : ""}</div>
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
    ? t.comments.map((c) => `<li class="reply"><span class="muted">${who(c)} · ${new Date(c.created_at).toLocaleString()}</span><div class="body">${esc(c.body)}</div></li>`).join("")
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
  agent_admin: "🛡️", project_mode: "🎛️", collector_run: "⚠️",
  proposal_created: "📝", proposal_decided: "✅", work_history: "🧾",
  brief: "📰", review: "🔍", alert: "🚨",
};
const feedIcon = (kind) => FEED_ICONS[kind] ?? "•";

// The chips. Each value is passed straight through as the query's `kind`
// param, which matches an exact row kind OR the `group` column
// activity_feed.yaml derives — so this list names groups and the SQL owns
// what is in each one. Adding a kind to the feed does not mean editing here.
const FEED_CHIPS = [
  ["", "All"],
  ["capture", "Captures"],
  ["proposal", "Proposals"],
  ["decision", "Decisions"],
  ["work", "Work"],
  ["run", "Runs"],
  ["message", "Messages"],
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
// absent on purpose — their subjects can carry agent- or user-authored text.
const TITLE_CASE_KINDS = new Set([
  "collector_run", "proposal_created", "proposal_decided", "project_mode",
  "agent_admin", "brief", "review", "alert", "task_op", "crew_run", "work_history",
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

function feedRowHtml(r) {
  return `<li class="feed-row"><span class="feed-icon" title="${esc(r.kind)}">${feedIcon(r.kind)}</span>
    <span class="feed-body">
      <span class="chip feed-actor">${esc(r.actor ?? "system")}</span>
      <span class="feed-subject">${esc(titleCaseSubject(r.kind, r.subject))}</span>
      ${r.detail ? `<span class="muted feed-detail">${esc(r.detail)}</span>` : ""}
    </span>
    <span class="muted feed-time" title="${esc(new Date(r.ts).toLocaleString())}">${esc(relTime(r.ts))}</span></li>`;
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

// auto-refresh every 10s while the tab is visible, like chat's poll
let feedTimer = null;
function pollFeed(intervalMs = 10000) {
  if (feedTimer) clearInterval(feedTimer);
  feedTimer = setInterval(() => {
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

// The six columns in board order, each with the sentence its predicate means
// (P10: Title Case names things). The order here must match board.yaml's.
//
// "Addressed to" is the label ruled 2026-09-17, in the owner's own words:
// `work.owner` is informational — a name on the card, not a lease — and
// "Assigned" read like a claim the row had not made. The KEY stays `assigned`
// (board.yaml's derived value, every drop's route, the `runs` ledger): this is
// a rename of what the user reads, not of what the service stores.
const BOARD_COLUMNS = [
  ["backlog", "Backlog", "open, addressed to no one"],
  ["assigned", "Addressed to", "someone's name on it, not started"],
  ["in_progress", "In Progress", "an agent holds the lease"],
  ["needs_you", "Needs You", "blocked — nothing but your hand moves it"],
  ["done", "Done", "closed, no report came back"],
  ["reported", "Reported", "closed, and a report landed"],
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
  if (c.last_report_at) bits.push(`reported ${relTime(c.last_report_at)}`);
  // A closed card has nowhere to go — `update()` refuses a row that is
  // already closed — so it gets no grab affordance rather than a dead one.
  const movable = Object.keys(dropsFor(c)).length > 0;
  const label = `${c.title} — ${BOARD_LABEL.get(String(c.column)) ?? c.column}${movable ? ", press m to move it" : ""}`;
  return `<li class="card${c.escalated ? " escalated" : ""}${c.has_thread ? " linked" : ""}" data-card="${esc(c.id)}"${movable ? ` draggable="true"` : ""} tabindex="0" role="button" aria-label="${esc(label)}">
    <div class="row"><span class="card-title">${esc(c.title)}</span><span class="muted">#${esc(c.id)}</span></div>
    <div class="muted">${esc(bits.join(" · "))}${c.has_thread ? ` <span class="chip">room</span>` : ""}${c.escalated ? ` <span class="chip failed">${esc(escalationLabel(c))}</span>` : ""}</div></li>`;
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
 * the service would refuse. `reported` never appears — nothing you can drag
 * makes a report exist — and a closed card has no drops at all.
 */
function dropsFor(c) {
  const d = {};
  if (c.status === "closed") return d;
  if (c.column === "backlog") { d.assigned = "assign"; d.in_progress = "claim"; }
  else if (c.column === "assigned") { d.backlog = "unassign"; d.in_progress = "claim"; }
  else if (c.column === "in_progress") { d[boardHome(c)] = "release"; }   // never orphaned — Hermes's `reclaimed`, which we already had
  else if (c.column === "needs_you") { d[boardHome(c)] = "unblock"; }     // the one route back to `open`
  d.done = "close"; // offered from every open column; the SERVICE decides from the current status and a refusal is shown
  return d;
}

// One op, one route. Anything that needs two calls is not a drop.
const DROP_WHAT = {
  assign: "address it to a crew",
  unassign: "clear the addressee",
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
    ? `${c.claimed_by}${c.lease_expires_at ? ` until ${new Date(c.lease_expires_at).toLocaleString()}` : ""}`
    : "unclaimed";
  const fields = [
    ["column", BOARD_LABEL.get(String(c.column)) ?? c.column],
    ["owner", c.owner ?? "nobody — it is in the open queue"],
    ["lease", lease],
    ["external ref", c.external_ref ?? "none"],
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

// auto-refresh on the feed's cadence — a board that lags lies about who holds
// the lease. Never mid-gesture, though: re-rendering the columns under a drag
// or under an open picker would cancel the thing the user was doing.
let boardTimer = null;
const boardBusy = () => boardDragging !== null || ["board-move", "board-assign", "board-detail"].some((id) => !$(id).hidden);
function pollBoard(intervalMs = 10000) {
  if (boardTimer) clearInterval(boardTimer);
  boardTimer = setInterval(() => {
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
    const seen = p.last_seen_at ? `seen ${new Date(p.last_seen_at).toLocaleString()}` : "never seen";
    el.innerHTML = `<span class="chip state-${esc(p.state)}">${esc(p.state)}</span> <span class="muted">${esc(seen)} · $${fmtUsd(p.spend_today_usd)} today</span>`;
  }
}
