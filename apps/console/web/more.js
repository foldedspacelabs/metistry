// More ▸ Agents — read and granted from the phone; defined on the Mac (screen
// 18 §5; screen 7). T7-3b split it out of app.js.
//
// The list is two groups — Yours (the assistant and the helpers you defined)
// and Connected (someone else's agents, working through a token you minted) —
// each row its presence, its name and what it is doing. A tap pushes the
// agent: **the permissions table becomes one row per resource with Read and
// Write lines**, then its action table, then Edit Permissions — the grants
// form — and Revoke. Registering an agent and rotating its token are reach
// `local` (F-13): no passkey session can do either, so the phone offers
// neither — "New agents are defined on the Mac" is the whole of it.
//
// Where it reads: `GET /api/agents` (each row's rendered scope, permission rows
// and resolved action table — the SERVER's, printed and never recomputed,
// §2.17) and the `agent_presence` named query. Where it writes: the grants,
// projects and autonomy PUTs and revoke — the doors it had.
//
// Every agent-authored value goes through esc()/attr() (CRIT-7).

import { attr, dateTime, esc, fmtUsd, glyph, scopeOf } from "./lib.js";

// ============================================================================
// The words — pure, and held to the CLI's and the Kit's (pwa-reads.test.ts)
// ============================================================================

// One noun per thing (glossary.md): every agent shows a ROLE — assistant (this
// instance's own), helper (one the owner defined under agents/), external —
// a label over the stored kind, which does not change.
export const ROLE_LABEL = { internal: "assistant", external: "external", crew: "helper" };

// **The effective action table is the SERVER's** (§2.17). Every agent row on
// `GET /api/agents` carries `scope.autonomy` — the level, and `detailed`: each
// kind's mode with WHY (set, defaulted, or clamped to the level's ceiling),
// resolved once by core's `effectiveActionsDetailed`. This prints it and
// computes nothing. ACTION_MODE_LABEL is the CLI's MODE_LABEL
// (packages/cli/src/agents.ts), and `actionEntryText` says a row the way
// `metistry agents autonomy` does — Allow · Ask First · Never.
export const ACTION_MODE_LABEL = { allow: "Allow", propose: "Ask First", deny: "Never" };
export const modeWord = (m) => ACTION_MODE_LABEL[m] ?? String(m ?? "");
export function actionEntryText(entry, level) {
  const word = modeWord(entry.mode);
  if (entry.source === "clamped") return `${word} (asked ${modeWord(entry.asked)} — ${level}'s ceiling is ${word})`;
  if (entry.source === "defaulted") return `${word} (default for ${level})`;
  return word;
}
/** The table as rows, in the server's order. `null` when the row carries none: said as unavailable, never guessed (P5). */
export function actionTableRows(scope) {
  const au = scope?.autonomy;
  if (!au?.level || !au.detailed || typeof au.detailed !== "object") return null;
  return Object.entries(au.detailed).map(([kind, entry]) => ({ kind, source: entry?.source, text: actionEntryText(entry ?? {}, au.level) }));
}
export function actionTableHtml(scope) {
  const rows = actionTableRows(scope);
  if (!rows) return `<p class="muted">Actions: unavailable.</p>`;
  return `<ul class="group action-table" aria-label="Actions"><li class="muted perm">level: ${esc(scope.autonomy.level)}</li>` +
    rows.map((r) => `<li class="perm action-row ${attr(r.source ?? "")}"><span class="mono">${esc(r.kind)}</span> ${esc(r.text)}</li>`).join("") + `</ul>`;
}

// **The permissions table is the SERVER's** (T4-6): every agent row carries
// `permissions` — Resource × Read × Write, drawn by core's
// `describePermissions`, which asks the same `may()` the doors ask. Each cell
// is said in the words core's `permissionRowText` gives the CLI and
// MetistryKit gives the Mac — a test holds the three to one table. An empty
// cell is the dash: absence is the denial.
export const PERMISSION_EMPTY_CELL = "—";
export function permissionEntryText(e) {
  const p = e?.provenance ?? {};
  const why = p.kind === "approved" ? (p.proposalId === null || p.proposalId === undefined ? "approved in Needs You" : `approved in Needs You · #${p.proposalId}`) : p.kind === "routine" ? `during ${p.routine} only` : p.kind === "project" ? `via project ${p.project}` : null;
  return `${e?.label ?? ""}${e?.asks ? " ⏱" : ""}${why === null ? "" : ` (${why})`}`;
}
export function permissionCellText(entries) {
  return Array.isArray(entries) && entries.length > 0 ? entries.map(permissionEntryText).join(", ") : PERMISSION_EMPTY_CELL;
}
export function permissionRowText(row) {
  const label = row?.resource?.kind === "connection" ? `${row.label} ⧉` : String(row?.label ?? "");
  return [label, permissionCellText(row?.read), permissionCellText(row?.write)];
}

/**
 * The one table, on a phone: one row per resource, its Read and Write lines
 * beneath it (screen 18 §5). The same three strings per row as the Mac's
 * table and `metistry agents list`; only the layout differs.
 */
export function permissionsListHtml(rows) {
  if (!Array.isArray(rows)) return `<p class="muted">Permissions: unavailable.</p>`;
  if (rows.length === 0) return `<p class="muted">Holds nothing — anything not listed is not granted.</p>`;
  return `<ul class="group perms" aria-label="What it may do">${rows.map((r) => {
    const [label, read, write] = permissionRowText(r);
    return `<li class="perm"><span class="perm-res">${esc(label)}</span><span class="perm-line"><span class="perm-k">Read</span> <span>${esc(read)}</span></span><span class="perm-line"><span class="perm-k">Write</span> <span>${esc(write)}</span></span></li>`;
  }).join("")}</ul><p class="muted foot">⏱ Ask First — it comes to you before it happens. Anything not listed is not granted.</p>`;
}

/** Yours are the assistant and the helpers you defined; Connected are everyone else's, through a token. Revoked come last. */
export function groupAgents(agents) {
  const live = (agents ?? []).filter((a) => !a.revoked);
  return [
    ["Yours", live.filter((a) => a.kind === "internal" || a.kind === "crew")],
    ["Connected", live.filter((a) => a.kind !== "internal" && a.kind !== "crew")],
    ["Revoked", (agents ?? []).filter((a) => a.revoked)],
  ].filter(([, list]) => list.length);
}

const presenceChip = (p) => (p ? `<span class="chip state-${attr(p.state)}">${esc(p.state)}</span>` : "");

/** One agent's row: presence, name, and the line that says what it is doing — or what it has asked you for. */
export function agentRowHtml(a, presence, asked = []) {
  const line = asked.length
    ? `waiting on you: ${asked.map((r) => `access to ${r.area}`).join(", ")}`
    : a.revoked ? "revoked" : presence?.last_seen_at ? `seen ${dateTime(presence.last_seen_at)}` : a.last_seen_at ? `seen ${dateTime(a.last_seen_at)}` : "never seen";
  return `<li><button type="button" class="row agent-row${a.revoked ? " revoked" : ""}" data-act="agent" data-id="${attr(a.id)}">${presenceChip(presence)}` +
    `<span class="label"><span class="mono agent-name">${esc(a.id)}</span> <span class="chip">${esc(ROLE_LABEL[a.kind] ?? a.kind)}</span><span class="sub">${esc(line)}</span></span>${glyph("chevron", "chev")}</button></li>`;
}

export function agentListHtml(agents, presence = new Map(), asked = new Map()) {
  const groups = groupAgents(agents);
  if (!groups.length) return `<p class="empty">No agents yet.</p>`;
  return groups.map(([head, list]) => `<h3>${esc(head)}</h3><ul class="group">${list.map((a) => agentRowHtml(a, presence.get(a.id), asked.get(a.id) ?? [])).join("")}</ul>`).join("");
}

/** The agent, pushed: who it is, what it may do (the one table, as a list), its actions, and what it has asked for. */
export function agentHtml(a, presence, asked = []) {
  const g = a.grants ?? { tier: "none", areas: [] };
  const seen = presence ? `${presence.last_seen_at ? `seen ${dateTime(presence.last_seen_at)}` : "never seen"} · $${fmtUsd(presence.spend_today_usd)} today` : "";
  const au = a.autonomy ?? {};
  const narrowing = [
    au.may_dispatch_to ? `delegates to ${au.may_dispatch_to.join(", ") || "nobody"}` : "",
    au.accept_from ? `accepts from ${au.accept_from.join(", ") || "nobody"}` : "",
    au.max_open_bundles !== undefined ? `max ${Number(au.max_open_bundles) || 0} bundles` : "",
  ].filter(Boolean).join(" · ");
  const asks = asked.map((r) => `<li class="perm">Asked for ${esc(r.area)} — ${esc(String(r.reason ?? "").slice(0, 160))} <span class="muted">(answer it in Needs You, request #${esc(String(Number(r.proposal_id)))})</span></li>`).join("");
  return `<p class="agent-head">${presenceChip(presence)} <span class="chip">${esc(ROLE_LABEL[a.kind] ?? a.kind)}</span> ${esc(a.display_name ?? "")}</p>` +
    (seen ? `<p class="muted">${esc(seen)}</p>` : "") +
    `<p class="muted">Access: ${esc(scopeOf(a.scope, g.tier, g.areas))}${a.scope?.from ? ` · scope from ${esc(a.scope.from)}` : ""}</p>` +
    (narrowing ? `<p class="muted">Autonomy: ${esc(narrowing)}</p>` : "") +
    (asks ? `<h3>Asked For</h3><ul class="group">${asks}</ul>` : "") +
    `<h3>What It May Do</h3>${a.revoked ? `<p class="muted">Revoked — it holds nothing.</p>` : permissionsListHtml(a.permissions)}` +
    `<h3>Actions</h3>${actionTableHtml(a.scope)}`;
}

// A refusal in the server's own words (F-13) — shown as it came, never replaced by a guess at why.
export async function refusalText(res, fallback) {
  const body = await res.json().catch(() => ({}));
  return body?.error?.message || fallback;
}

// ============================================================================
// The view — wired to the DOM when app.js mounts it
// ============================================================================

/** What a grant says while the console cannot be reached (screen 18 §4): it is not offered, and never waits. */
export const OFFLINE_GRANT = "Permissions need the connection — nothing was saved.";

/**
 * Mount More ▸ Agents. `offline()` is the shell's: while it says so, neither
 * a grant nor a revoke is sent (T7-4).
 */
export function mountMore({ $, api, show, offline = () => false }) {
  let agents = [];
  let asked = new Map();
  let presence = new Map();
  let open = null; // the agent pushed

  async function load() {
    const res = await api("/api/agents");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message ?? `the console answered ${res.status}`);
    agents = body.agents ?? [];
    // What each agent has ASKED for, beside what it holds (ruled 2026-09-19).
    // The answer is still given in Needs You — this is the list telling you
    // there is a question, not a second door onto granting.
    asked = new Map();
    for (const r of body.access_requests ?? []) asked.set(r.agent, [...(asked.get(r.agent) ?? []), r]);
    try {
      const { rows } = await (await api("/api/q/agent_presence?limit=500")).json();
      presence = new Map((rows ?? []).map((p) => [p.id, p]));
    } catch { presence = new Map(); }
  }

  async function loadAgents() {
    try {
      await load();
      $("agent-list").innerHTML = agentListHtml(agents, presence, asked);
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      $("agent-list").innerHTML = `<div class="panel-state failed"><p class="state-title">Couldn't read the agents</p><p class="mono reason">${esc(e?.message ?? e)}</p></div>`;
    }
  }

  function paintAgent() {
    const a = agents.find((x) => x.id === open);
    if (!a) { $("agent-body").innerHTML = `<p class="muted">There is no agent ${esc(open ?? "")}.</p>`; $("agent-acts").hidden = true; return; }
    $("agent-body").innerHTML = agentHtml(a, presence.get(a.id), asked.get(a.id) ?? []);
    $("agent-acts").hidden = Boolean(a.revoked);
  }

  async function loadAgent() {
    if (!open) return show("agents");
    $("agent-grants").hidden = true;
    $("agent-msg").textContent = "";
    await load().catch(() => {});
    paintAgent();
  }

  $("agents").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.dataset.act !== "agent") return;
    open = el.dataset.id;
    show("agent", { title: open });
  });

  $("agent").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled || !open) return;
    if (el.dataset.act === "edit") return openGrants(open);
    if (el.dataset.act === "revoke") {
      if (offline()) return; // not offered offline (T7-4)
      if (!confirm(`Revoke ${open}? Its token stops working now, and this cannot be undone — a new agent has to be registered on the Mac to let it back in.`)) return;
      const r = await api(`/api/agents/${encodeURIComponent(open)}/revoke`, { method: "POST" });
      $("agent-msg").textContent = r.ok ? `${open} is revoked.` : await refusalText(r, `Not revoked — the console answered ${r.status}.`);
      await load().catch(() => {});
      paintAgent();
    }
  });

  function openGrants(id) {
    const a = agents.find((x) => x.id === id);
    if (!a) return;
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
   * is now — the saved table, never a preview of this draft. The kinds are the
   * server's too; with no table they fall back to the record's own entries, so
   * a Save can never drop one.
   */
  function renderActionControls(a) {
    const stored = a.autonomy?.actions ?? {};
    const rows = actionTableRows(a.scope);
    const kinds = rows ? rows.map((r) => [r.kind, r.text]) : Object.keys(stored).map((k) => [k, "unavailable"]);
    $("agent-actions").innerHTML = kinds.map(([k, saved]) => `<label>${esc(k)} <span class="muted">saved: ${esc(saved)}</span>
      <select data-action-kind="${attr(k)}">
        <option value="">default for the level</option>
        <option value="deny">Never — refuse it at the tool</option>
        <option value="propose">Ask First — it asks, you answer in Needs You</option>
        <option value="allow">Allow — run it (act within scope only)</option>
      </select></label>`).join("");
    for (const sel of $("agent-actions").querySelectorAll("[data-action-kind]")) sel.value = stored[sel.dataset.actionKind] ?? "";
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
    for (const sel of $("agent-actions").querySelectorAll("[data-action-kind]")) if (sel.value) actions[sel.dataset.actionKind] = sel.value;
    if (Object.keys(actions).length) out.actions = actions;
    return out;
  }

  $("agent-grants-cancel").addEventListener("click", () => { $("agent-grants").hidden = true; });

  $("agent-grants").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = open;
    if (!id) return;
    if (offline()) { $("agent-grants-msg").textContent = OFFLINE_GRANT; return; } // a grant never waits (T7-4)
    const tier = $("agent-tier").value;
    const areas = tier === "areas" ? $("agent-areas").value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    const queries = $("agent-queries").checked;
    const projects = $("agent-projects").value.split(",").map((s) => s.trim()).filter(Boolean);
    const say = (t) => { $("agent-grants-msg").textContent = t; };
    const g = await api(`/api/agents/${encodeURIComponent(id)}/grants`, { method: "PUT", body: JSON.stringify({ tier, areas, queries }) });
    if (!g.ok) return say(await refusalText(g, "Access not saved — folders are TitleCase vault prefixes (Areas/Health), one per line, and only for Access: folders."));
    const p = await api(`/api/agents/${encodeURIComponent(id)}/projects`, { method: "PUT", body: JSON.stringify({ projects }) });
    if (!p.ok) return say(await refusalText(p, "Projects not saved — comma-separated slugs (a-z, 0-9, -)."));
    const au = await api(`/api/agents/${encodeURIComponent(id)}/autonomy`, { method: "PUT", body: JSON.stringify(autonomyFromForm()) });
    if (!au.ok) return say(await refusalText(au, "Autonomy not saved — agent ids (and `user` for accept-from), comma-separated; max open bundles 0–1000."));
    $("agent-grants").hidden = true;
    $("agent-msg").textContent = "Saved.";
    await load().catch(() => {});
    paintAgent();
  });

  // A live refetch (T7-7): the list and the open agent again, leaving an open grants editor where it is.
  async function refresh() {
    if (!$("agents").hidden) return loadAgents();
    if (open && !$("agent").hidden) { await load().catch(() => {}); paintAgent(); }
  }

  return { agents: loadAgents, agent: loadAgent, refresh };
}
