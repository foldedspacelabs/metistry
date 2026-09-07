// PWA shell — vanilla, no framework (recipes over frameworks). Auth via
// passkeys; API calls carry the session cookie. Drafts survive re-auth:
// the composer stashes to localStorage and replays after sign-in.

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
const views = ["chat", "dashboard", "capture", "triage", "status", "devices", "agents", "artifacts"];
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
  ({ chat: loadMessages, dashboard: loadDashboard, status: loadStatus, devices: loadDevices, triage: loadTriage, agents: loadAgents, artifacts: loadArtifacts }[view] ?? (() => {}))();
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
let lastRender = "";
async function loadMessages() {
  const res = await api("/api/messages?limit=30");
  const { messages } = await res.json();
  const chrono = messages.reverse();
  const fingerprint = JSON.stringify(chrono.map((m) => [m.direction, m.id, m.status]));
  if (fingerprint === lastRender) return; // no flicker on idle polls
  lastRender = fingerprint;
  $("messages").innerHTML = chrono
    .map((m) => `<li class="${m.direction}"><div class="meta">${new Date(m.ts).toLocaleString()}${m.direction === "in" ? ` · ${m.status}` : ""}</div>${esc(m.text)}</li>`)
    .join("");
  const list = $("messages");
  list.scrollTop = list.scrollHeight; // latest message always in view
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
    loadMessages();
    pollChat(1000); // burst while the reply is in flight
    setTimeout(() => pollChat(), 20000);
  } catch {}
};

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

// ----- triage (D7 proposals; every field output-encoded — CRIT-7) -----
async function loadTriage() {
  const res = await api("/api/proposals");
  const { proposals } = await res.json();
  $("triage-empty").hidden = proposals.length > 0;
  $("proposal-list").innerHTML = proposals
    .map((p) => {
      const c = p.payload?.classification ?? {};
      const label = c.action || c.title || p.payload?.title || p.kind; // review proposals (§4.21) carry a top-level title
      return `<li><span>${esc(label)} <span class="muted">${esc(p.kind)} · ${esc(c.kind ?? "")} · ${esc(p.source_agent)} · ${new Date(p.ts).toLocaleDateString()}</span></span>
        <span><button data-triage="${p.id}" data-d="allow">allow</button> <button data-triage="${p.id}" data-d="deny" style="background:#7a3b3b">deny</button></span></li>`;
    })
    .join("");
  document.querySelectorAll("[data-triage]").forEach((b) => (b.onclick = async () => {
    await api(`/api/proposals/${b.dataset.triage}`, { method: "POST", body: JSON.stringify({ decision: b.dataset.d }) });
    loadTriage();
  }));
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
  if (probe.ok) { show(artifactRoute() ? "artifacts" : "chat"); replayDraft(); pollChat(); } else showAuth(); // a #/artifacts/… link (the review link) opens straight there
} catch { showAuth(); }

// ----- agents (external-agent registry; every agent-authored field output-encoded — CRIT-7) -----
// The token is shown exactly once, at mint/rotate; the list never carries it.
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
      const scope = g.tier === "areas" ? g.areas.map(esc).join(", ") : esc(g.tier);
      const projects = (a.projects ?? []).length ? ` · projects: ${a.projects.map(esc).join(", ")}` : "";
      const actions = a.revoked
        ? '<span class="muted">revoked</span>'
        : `<span><button data-agent-grants="${esc(a.id)}" class="secondary">grants</button> <button data-agent-rotate="${esc(a.id)}" class="secondary">rotate</button> <button data-agent-revoke="${esc(a.id)}" style="background:#7a3b3b">revoke</button></span>`;
      return `<li class="${a.revoked ? "revoked" : ""}"><span><b>${esc(a.display_name)}</b> <span class="muted">${esc(a.id)} · ${esc(a.kind)}</span><br>
        <span class="muted">tier: ${scope}${projects} · ${seen}</span></span>${actions}</li>`;
    })
    .join("");
  document.querySelectorAll("[data-agent-grants]").forEach((b) => (b.onclick = () => openGrants(b.dataset.agentGrants)));
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
  $("agent-projects").value = (a.projects ?? []).join(", ");
  $("agent-grants-msg").textContent = "";
  $("agent-grants").hidden = false;
}

$("agent-grants-cancel").onclick = () => { $("agent-grants").hidden = true; };

$("agent-grants").onsubmit = async (e) => {
  e.preventDefault();
  const id = $("agent-grants").dataset.agent;
  const tier = $("agent-tier").value;
  const areas = tier === "areas" ? $("agent-areas").value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const projects = $("agent-projects").value.split(",").map((s) => s.trim()).filter(Boolean);
  const g = await api(`/api/agents/${encodeURIComponent(id)}/grants`, { method: "PUT", body: JSON.stringify({ tier, areas }) });
  if (!g.ok) { $("agent-grants-msg").textContent = "grants rejected — areas must be TitleCase Knowledge/… prefixes, one per line, and only for tier areas"; return; }
  const p = await api(`/api/agents/${encodeURIComponent(id)}/projects`, { method: "PUT", body: JSON.stringify({ projects }) });
  if (!p.ok) { $("agent-grants-msg").textContent = "projects rejected — comma-separated slugs (a-z, 0-9, -)"; return; }
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
    const t = tiers.get(r.model) ?? { cost: 0, tin: 0, tout: 0, turns: 0 };
    t.cost += asNum(r.cost_usd); t.tin += asNum(r.tokens_in); t.tout += asNum(r.tokens_out); t.turns += asNum(r.turns);
    tiers.set(r.model, t);
  }
  const sorted = [...tiers].sort((a, b) => b[1].cost - a[1].cost);
  const max = Math.max(0, ...sorted.map(([, t]) => t.cost));
  const total = sorted.reduce((s, [, t]) => s + t.cost, 0);
  $("dash-spend-total").textContent = sorted.length ? `$${fmtUsd(total)} API-equivalent across ${sorted.length} tier(s)` : "";
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
    projects: async () => renderProjects(await dashQuery("projects_overview")),
    spend: async () => renderSpend(await dashQuery("claude_usage_daily", { days: 30 })),
    aws: async () => renderAws(...(await Promise.all([dashQuery("aws_costs_daily", { days: 30 }), dashQuery("aws_costs_recent", { days: 30 })]))),
  };
  await Promise.all(Object.entries(panels).map(async ([id, load]) => {
    try { await load(); } catch { $(`dash-${id}-asof`).textContent = "unavailable"; }
  }));
}

// ===== artifacts (§4.21) =====
// Every server value is output-encoded via esc()/textContent before it
// touches the DOM (CRIT-7). Text kinds render as escaped text in a <pre> (a
// renderer is a later UX pass); images come from the raw route as <img>;
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
    ? body.route === "work" ? `review task #${body.work.id} created for ${to_agent}` : `queued as proposal #${body.proposal_id} (outside the project)`
    : `dispatch failed: ${body.error?.message ?? r.status}`;
};
