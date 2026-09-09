// PWA shell — vanilla, no framework (recipes over frameworks). Auth via
// passkeys; API calls carry the session cookie. Drafts survive re-auth:
// the composer stashes to localStorage and replays after sign-in.

import { renderMarkdown } from "./md.js";

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
const views = ["feed", "chat", "dashboard", "capture", "triage", "status", "devices", "agents", "artifacts"];
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
  ({ feed: loadFeedView, chat: loadMessages, dashboard: loadDashboard, status: loadStatus, devices: loadDevices, triage: loadTriage, agents: loadAgents, artifacts: loadArtifacts }[view] ?? (() => {}))();
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

// TODO(rules.yaml endpoint): PLACEHOLDER — the single definition site for the
// command list, and the only thing to delete when the console grows a route
// over the instance's own rules.yaml (build plan §4.2 has none). §3.6 and
// ux-direction.md both require this list to be generated; a hand-maintained
// one is what they rule out, and the first instance whose rules.yaml differs
// from these defaults is misinformed by it. Agents below are already live from
// /api/agents — this is the one source still faked. Do not grow it.
const COMMANDS = [
  { id: "/status", desc: "doctor at a glance" },
  { id: "/today", desc: "what is on today" },
  { id: "/open", desc: "open work across projects" },
  { id: "/spend", desc: "spend so far" },
  { id: "/queue", desc: "the dispatch queue" },
  { id: "/runs", desc: "recent runs" },
  { id: "/note", desc: "capture without a turn" },
  { id: "/deep", desc: "pin the deep tier for this turn" },
  { id: "/new", desc: "roll to a fresh session" },
];

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
  const source = tok.text.startsWith("@") ? await refreshComposerAgents() : COMMANDS;
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
  $("composer-commands").innerHTML = COMMANDS.map(
    (c) => `<button type="button" data-insert="${esc(c.id)} " title="${esc(c.desc)}">${esc(c.id)}</button>`,
  ).join("");
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
// row is a REQUEST, and a request has one of six types (glossary.md):
// note · report · review · question · access · improvement. The stored
// `proposals.kind` values are unchanged — this is the view layer mapping the
// eight-or-so internal kinds onto the six words the user reads, so the queue
// has one vocabulary instead of the union of everything that fills it.
// Grouped by type, oldest first; every field output-encoded, attribute values
// quote-safe too (CRIT-7). -----
const REQUEST_TYPE = {
  decision: "question",
  grant_elevation: "access",
  improvement: "improvement",
  knowledge: "note",
  draft_settle: "note",
  action: "note",
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
};
const requestType = (kind) => REQUEST_TYPE[kind] ?? kind;
// Approve / Revise / Decline are the three answers to every request. The wire
// (and `proposals.decision`) keeps allow / accept_with_changes / deny.
const DECISIONS = [
  { d: "allow", label: "Approve" },
  { d: "accept_with_changes", label: "Revise" },
  { d: "deny", label: "Decline", style: ' style="background:#7a3b3b"' },
];
const attr = (s) => esc(s).replaceAll('"', "&quot;");

async function loadTriage() {
  const res = await api("/api/proposals");
  const { proposals } = await res.json();
  $("triage-empty").hidden = proposals.length > 0;
  const tab = document.querySelector('nav button[data-view="triage"]');
  if (tab) tab.textContent = proposals.length ? `Needs You (${proposals.length})` : "Needs You";
  const groups = new Map();
  for (const p of [...proposals].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    const type = requestType(p.kind);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(p);
  }
  $("proposal-list").innerHTML = [...groups]
    .map(([type, rows]) => `<li class="muted">${esc(TYPE_LABEL[type] ?? type)} · ${rows.length}</li>` + rows.map(proposalRow).join(""))
    .join("");
  document.querySelectorAll("[data-triage]").forEach((b) => (b.onclick = async () => {
    const body = { decision: b.dataset.d };
    // Revise is the answer that carries a reason: without one the assistant
    // has nothing to change, so an empty note cancels rather than sends.
    if (b.dataset.d === "accept_with_changes") {
      const feedback = (prompt("what should change?") ?? "").trim();
      if (!feedback) return;
      body.feedback = feedback;
    }
    await api(`/api/proposals/${b.dataset.triage}`, { method: "POST", body: JSON.stringify(body) });
    loadTriage();
  }));
}

function proposalRow(p) {
  const c = p.payload?.classification ?? {};
  const label = c.action || c.title || p.payload?.title || p.kind; // review proposals (§4.21) carry a top-level title
  // a `decision` proposal is answered with its OWN options (the server checks them again)
  const opts = p.kind === "decision" && Array.isArray(p.payload?.options) ? p.payload.options.slice(0, 8) : null;
  const buttons = opts
    ? opts.map((o) => `<button data-triage="${p.id}" data-d="${attr(o)}">${esc(o)}</button>`).join(" ")
    : DECISIONS.map((x) => `<button data-triage="${p.id}" data-d="${x.d}"${x.style ?? ""}>${x.label}</button>`).join(" ");
  return `<li><span>${esc(label)} <span class="muted">${esc(requestType(p.kind))} · ${esc(c.kind ?? "")} · ${esc(p.source_agent)} · ${new Date(p.ts).toLocaleDateString()}</span></span>
        <span>${buttons}</span></li>`;
}

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
  if (probe.ok) { show(artifactRoute() ? "artifacts" : "feed"); replayDraft(); pollChat(); } else showAuth(); // a #/artifacts/… link (the review link) opens straight there; feed is the home tab
} catch { showAuth(); }

// ----- agents (external-agent registry; every agent-authored field output-encoded — CRIT-7) -----
// The token is shown exactly once, at mint/rotate; the list never carries it.
// One noun per thing (glossary.md): every agent shows a ROLE — assistant (this
// instance's own), helper (one the user defined under agents/), external —
// and an ACCESS tier read as none / titles / folders. Both are labels over
// the stored values (kind internal|external, tier none|index|areas), which do
// not change.
const ROLE_LABEL = { internal: "assistant", external: "external", crew: "helper" };
const ACCESS_LABEL = { none: "none", index: "titles", areas: "folders" };
const accessLabel = (t) => ACCESS_LABEL[t] ?? t;
let agentsCache = [];
async function loadAgents() {
  const res = await api("/api/agents");
  const { agents } = await res.json();
  agentsCache = agents;
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
      const actions = a.revoked
        ? '<span class="muted">revoked</span>'
        : `<span><button data-agent-grants="${esc(a.id)}" class="secondary">grants</button> <button data-agent-rotate="${esc(a.id)}" class="secondary">rotate</button> <button data-agent-revoke="${esc(a.id)}">revoke</button></span>`;
      return `<li class="${a.revoked ? "revoked" : ""}"><span><b>${esc(a.display_name)}</b> <span class="muted">${esc(a.id)}</span> <span class="chip">${esc(ROLE_LABEL[a.kind] ?? a.kind)}</span><br>
        <span class="muted">access: ${scope}${projects} · ${seen}</span>${narrowing ? `<br><span class="muted">autonomy: ${narrowing}</span>` : ""}<br>
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
  $("agent-grants-msg").textContent = "";
  $("agent-grants").hidden = false;
}

// Blank = the key is absent = "project members" (never widening: a key can only narrow).
function autonomyFromForm() {
  const list = (id) => $(id).value.split(",").map((s) => s.trim()).filter(Boolean);
  const out = {};
  if ($("agent-may-dispatch-to").value.trim()) out.may_dispatch_to = list("agent-may-dispatch-to");
  if ($("agent-accept-from").value.trim()) out.accept_from = list("agent-accept-from");
  if ($("agent-max-bundles").value.trim()) out.max_open_bundles = Number($("agent-max-bundles").value);
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
  if (!g.ok) { $("agent-grants-msg").textContent = "grants rejected — areas must be TitleCase Knowledge/… prefixes, one per line, and only for tier areas (bare Knowledge/ is for the internal assistant only)"; return; }
  const p = await api(`/api/agents/${encodeURIComponent(id)}/projects`, { method: "PUT", body: JSON.stringify({ projects }) });
  if (!p.ok) { $("agent-grants-msg").textContent = "projects rejected — comma-separated slugs (a-z, 0-9, -)"; return; }
  const au = await api(`/api/agents/${encodeURIComponent(id)}/autonomy`, { method: "PUT", body: JSON.stringify(autonomyFromForm()) });
  if (!au.ok) { $("agent-grants-msg").textContent = "autonomy rejected — agent ids (and `user` for accept-from), comma-separated; max open bundles 0..1000"; return; }
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
const dashStamp = (id, as_of) => { $(`dash-${id}-asof`).textContent = as_of ? `as of ${new Date(as_of).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""; };

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

// ===== feed (home) + agent presence =====
// docs/product/desktop-app-plan.md "The window": the activity_feed and
// agent_presence seed queries, surfaced as the PWA's first tab and as
// presence chips on the existing agents list. Every server value is
// output-encoded via esc() before it touches the DOM (CRIT-7).
const FEED_ICONS = {
  tool: "🔧", turn: "💬", crew_run: "🧑‍🤝‍🧑", dispatch: "📨", task_op: "🗂️",
  agent_admin: "🛡️", project_mode: "🎛️", collector_run: "⚠️",
  proposal_created: "📝", proposal_decided: "✅", work_history: "🧾",
  brief: "📰", review: "🔍", alert: "🚨",
};
const feedIcon = (kind) => FEED_ICONS[kind] ?? "•";

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

async function loadFeed() {
  const agent = $("feed-agent").value;
  const project = $("feed-project").value;
  const { rows } = await dashQuery("activity_feed", { hours: 24, limit: 100, agent, project });
  populateFeedAgents(rows);
  $("feed-empty").hidden = rows.length > 0;
  $("feed-list").innerHTML = rows.map(feedRowHtml).join("");
}

async function loadFeedView() {
  await populateFeedProjects();
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

$("feed-agent").onchange = () => loadFeed().catch(() => {});
$("feed-project").onchange = () => loadFeed().catch(() => {});

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
