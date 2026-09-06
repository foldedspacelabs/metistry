// PWA shell — vanilla, no framework (recipes over frameworks). Auth via
// passkeys; API calls carry the session cookie. Drafts survive re-auth:
// the composer stashes to localStorage and replays after sign-in.

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
const views = ["chat", "capture", "triage", "status", "devices", "agents"];
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
  ({ chat: loadMessages, status: loadStatus, devices: loadDevices, triage: loadTriage, agents: loadAgents }[view] ?? (() => {}))();
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
  $("reviews").innerHTML = rows.length
    ? rows.map((r) => {
        const url = /^https:\/\/github\.com\//.test(r.url ?? "") ? r.url : null; // agent/source text is output-encoded; only a github.com url becomes a link
        const ref = esc(String(r.external_ref).replace(/^gh:/, ""));
        return `<li><span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${ref}</a>` : ref} ${esc(r.title)}</span><span class="muted">${esc(r.author ?? "")}</span></li>`;
      }).join("")
    : `<li class="muted">none</li>`;
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
      const label = c.action || c.title || p.kind;
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
  if (probe.ok) { show("chat"); replayDraft(); pollChat(); } else showAuth();
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
