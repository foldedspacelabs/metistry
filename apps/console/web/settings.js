// More ▸ Settings — design-build-plan §2.3's table as a grouped list (T7-6;
// §2.17; screen 18 §5). T7-6 split it out of app.js.
//
// **The line** (§2.3): a remote client may act inside the boundary; only the
// Mac may change the boundary itself. The PWA signs in with a passkey, and a
// passkey session is never the local owner token, so every row §2.3 marks
// Mac-only is shown here as **its reason and nothing else** — no button, no
// form, no link. The `local` routes (F-13) behind those rows refuse this
// session with `403 local_only` whatever the page does; hiding the control is
// the courtesy, the gate is the control (a test holds both: every served
// `local` route in `packages/core/src/client-api.ts` is named by one row here,
// and no module of the PWA calls one).
//
// Groups follow the Mac's panes in its order (screen 15), with §2.3's other
// settings rows — Agents, Scheduled, Vault — where they read naturally.
//
// Where it writes, each through a door the console already has:
//   - **spending limits**: `POST /api/compute/budget` — the instance's, and
//     each provider's (daily, monthly, what happens at the limit);
//   - **each project's daily budget**: `PUT /api/projects/:slug`;
//   - **devices**: `POST /api/devices/:id/revoke`, one device at a time, and
//     Sign Out Everywhere as that same door once per device, this one last.
// Each is confirmed or edited in the page — never `window.confirm` (X-33) —
// and none is offered while the console cannot be reached (T7-4).
//
// Where it reads: `/api/identity`, `/api/whoami`, `/api/status`,
// `/api/compute`, `/api/projects`, `/api/devices`, `/api/connections`,
// `/api/secrets` (names, never a value) and `/api/vault/status`. Each group
// reads on its own, so one refusal never blanks the page.
//
// Every server value goes through esc()/attr() (CRIT-7).

import { ago, asNum, attr, clockTime, dateTime, esc, fmtUsd, glyph } from "./lib.js";
import { refusalText } from "./more.js";

// ============================================================================
// The table — §2.3, the PWA's column
// ============================================================================

/**
 * One entry per group, in the order the list shows them. A row is one of:
 *
 * - `{ read }`  what the phone reads, painted from the named read;
 * - `{ write }` a door the phone writes through, from this list;
 * - `{ view }`  a push to the view where the phone does it;
 * - `{ mac }`   Mac-only: a label and **why**, never a control. `local`
 *   names the `local` routes (F-13) the row stands for.
 *
 * `part` places a group before (`head`) or after (`rest`) the Notifications
 * block in index.html, which notify.js owns.
 */
export const SETTINGS_GROUPS = [
  {
    id: "instance", title: "Instance", part: "head",
    rows: [
      { read: "identity" },
      { mac: "Path, Ports and Linked Instances", why: "the local filesystem, and trust with other origins." },
    ],
  },
  {
    id: "services", title: "Services", part: "head",
    rows: [
      { read: "health" },
      { mac: "Restart, Stop, Start, Logs and Keep Awake", why: "the machine itself — a stop from away would lock you out." },
    ],
  },
  {
    id: "compute", title: "Compute", part: "head",
    rows: [
      { read: "assignment" },
      { write: "limits" },
      { write: "project-budgets" },
      { read: "providers" },
      { mac: "Providers, Keys, Base URLs and Models", why: "where prompts and keys go, and this Mac's disk." },
    ],
  },
  {
    id: "updates", title: "Updates", part: "head",
    rows: [
      { read: "version" },
      { mac: "Update, Roll Back and Runtime Source", why: "it replaces running code." },
    ],
  },
  {
    id: "account", title: "Account", part: "head",
    rows: [
      { write: "devices" },
      { mac: "Console Sign-In and Instance Repository", why: "how this Mac signs in, and where the vault is kept." },
    ],
  },
  {
    id: "agents", title: "Agents", part: "rest",
    rows: [
      { view: "agents", label: "Grants, Projects and Autonomy", sub: "Revoke and approve there too — every widening is recorded and alerted." },
      {
        mac: "Register an Agent or Rotate Its Token", why: "a new credential changes the boundary, and a definition is how an agent behaves.",
        local: ["POST /api/agents", "POST /api/agents/:id/rotate"],
      },
    ],
  },
  {
    id: "scheduled", title: "Scheduled", part: "rest",
    rows: [
      {
        mac: "A Routine's Agent, Task and Grants; New Routine", why: "it changes what runs.",
        local: ["PUT /api/scheduled/routines/:name/assignment", "POST /api/scheduled/routines"],
      },
    ],
  },
  {
    id: "connections", title: "Connections", part: "rest",
    rows: [
      { read: "connections" },
      { mac: "Add, Configure, Tool Modes and Offer to Agents", why: "hosts, commands, credentials and what agents can reach." },
    ],
  },
  {
    id: "secrets", title: "Secrets", part: "rest",
    rows: [
      { read: "secrets" },
      { mac: "Set, Replace and Remove", why: "values live in this Mac's Keychain, and no screen ever shows one." },
    ],
  },
  {
    id: "variables", title: "Variables", part: "rest",
    rows: [{ mac: "Variables", why: "they are set on the Mac by design." }],
  },
  {
    id: "sessions", title: "Sessions", part: "rest",
    rows: [{ mac: "Purge Now", why: "it cannot be undone.", local: ["POST /api/sessions/purge"] }],
  },
  {
    id: "vault", title: "Vault", part: "rest",
    rows: [
      { read: "vault" },
      {
        mac: "Restore a File, Roll Back, Push and Pull Policy", why: "history and the remote are the boundary, and each rollback still waits for your Approve.",
        local: ["POST /api/knowledge/restore", "POST /api/vault/rollback"],
      },
    ],
  },
  {
    id: "this-mac", title: "This Mac", part: "rest",
    rows: [{ mac: "Live Capture, Keyboard and Advanced", why: "they belong to the Mac they run on." }],
  },
];

/** Every `local` route a Mac-only row stands for — what the phone is never offered. */
export const MAC_ONLY_ROUTES = SETTINGS_GROUPS.flatMap((g) => g.rows.flatMap((r) => r.local ?? []));

// ============================================================================
// The words — pure
// ============================================================================

/** What the page says when a write is tapped while the console cannot be reached (screen 18 §4): nothing waits. */
export const OFFLINE_SETTING = "Settings need the connection — nothing was saved.";

/** At the limit (BUDGET_ACTIONS, packages/core): the Mac's words (compute-facts.swift), Title Case for the control. */
export const LIMIT_ACTIONS = [
  ["stop", "Stop", "Refuse every turn until the window rolls over."],
  ["critical_only", "Critical Only", "Only turns marked critical may spend past the limit."],
  ["allow", "Allow", "Record the overrun and keep going."],
];
const actionWord = (a) => LIMIT_ACTIONS.find(([k]) => k === a)?.[1] ?? String(a ?? "");

/** Dollars, the Mac's way: whole numbers plain, anything else to the cent. */
export const money = (v) => { const n = asNum(v); return n === Math.round(n) ? String(n) : n.toFixed(2); };

/** A limit in one line: `$5/day · $60/month · Stop`, or that there is none. */
export function limitSummary(l) {
  const has = (v) => v !== null && v !== undefined;
  if (!has(l?.daily_usd) && !has(l?.monthly_usd)) return "No limit";
  return [has(l.daily_usd) ? `$${money(l.daily_usd)}/day` : "", has(l.monthly_usd) ? `$${money(l.monthly_usd)}/month` : "", l.action ? actionWord(l.action) : ""].filter(Boolean).join(" · ");
}

/** The four check states (C10): `absent` is "not configured" — a fact, not a fault — and `degraded` is neither. */
export const CHECK_STATES = ["ok", "degraded", "failed", "absent"];
export const CHECK_WORD = { ok: "ok", degraded: "degraded", failed: "failed", absent: "not configured" };
/** One check's row; a word outside the contract is shown as it came, in the neutral ink — never a guess at a colour. */
export function checkRowHtml(c) {
  const known = CHECK_STATES.includes(c.status);
  return `<li><span>${esc(c.name)} <span class="muted">${esc(c.probe)}</span></span><span class="${known ? c.status : "absent"}">${esc(known ? CHECK_WORD[c.status] : c.status)} · ${esc(String(c.latency_ms))}ms</span></li>`;
}
/** The line above the rows, so the group answers before it is read: "9 ok · 1 degraded · 2 not configured". */
export function checksSummary(checks) {
  if (checks.length === 0) return "no checks reported";
  const n = (s) => checks.filter((c) => c.status === s).length;
  if (n("ok") === checks.length) return `all ${checks.length} healthy`;
  const other = checks.length - CHECK_STATES.reduce((t, s) => t + n(s), 0);
  return [...CHECK_STATES.map((s) => [n(s), CHECK_WORD[s]]), [other, "unrecognised"]]
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(" · ");
}

/** A name and its value, with an optional line under the name. */
const kv = (k, v, sub = "", cls = "") =>
  `<li class="kv${cls ? ` ${cls}` : ""}"><span class="k">${esc(k)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span><span class="v">${v}</span></li>`;

/**
 * A Mac-only row: what it is and why it stays on the Mac. **No control** —
 * not a disabled one, not a link: there is nothing on the phone to press.
 */
export function macRowHtml(row) {
  return `<li class="mac-only"><span class="k">${esc(row.mac)}</span><span class="sub">On the Mac — ${esc(row.why)}</span></li>`;
}

/** A read that failed: said in the group, in the server's words, never blank (P5). */
export function failedRowHtml(what, reason) {
  return `<li class="state failed"><span class="k">Couldn't read ${esc(what)}</span><span class="mono reason">${esc(reason)}</span></li>`;
}
const readingRowHtml = (what) => `<li class="state"><span class="k muted">Reading ${esc(what)}…</span></li>`;

/** An inline confirmation: the cost named, the act's own verb, Cancel beside it (P3; components-03 §3). */
export function confirmHtml({ id, text, verb, act }) {
  return `<li class="confirm" role="group" aria-labelledby="${attr(id)}"><p id="${attr(id)}">${esc(text)}</p>` +
    `<div class="acts"><button type="button" class="destructive" data-act="${attr(act)}" data-needs-connection>${esc(verb)}</button>` +
    `<button type="button" class="secondary" data-act="cancel" id="settings-confirm-cancel">Cancel</button></div></li>`;
}

/** An element id from a scope or a slug: letters, digits and dashes. */
export const idOf = (s) => String(s).toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");

// ----- the reads, painted -----

export function identityRowsHtml(identity) {
  const name = identity?.name ? esc(identity.name) : '<span class="muted">not set</span>';
  return kv("Name", `${identity?.icon ? `${esc(identity.icon)} ` : ""}${name}`);
}

export function healthRowsHtml(status) {
  const checks = Array.isArray(status?.checks) ? status.checks : [];
  return `<li class="kv checks-summary"><span class="k">Health</span><span class="v">${esc(checksSummary(checks))}</span></li>` + checks.map(checkRowHtml).join("");
}

/** The assistant's model and effort: the `default` assignment, as the engine runs it. */
export function assignmentRowHtml(compute, assistant) {
  const a = (compute?.assignments ?? []).find((x) => x.target === "default");
  const who = assistant ? `${assistant}'s Model` : "The Assistant's Model";
  if (!a) return kv(who, '<span class="muted">not assigned</span>');
  return kv(who, `${esc(a.model)} <span class="muted">· ${esc(a.provider)}</span>`, a.effort ? `${a.effort[0].toUpperCase()}${a.effort.slice(1)} effort` : "");
}

/** One spending limit: its summary, what is spent, and Change — or, while editing, its form. */
export function limitRowHtml(l, { label, editing = false } = {}) {
  const key = idOf(l.scope);
  const spent = l.spent ?? {};
  const sub = `Spent $${fmtUsd(spent.daily)} today · $${fmtUsd(spent.monthly)} this month`;
  if (!editing) {
    return `<li class="kv"><span class="k">${esc(label)}<span class="sub">${esc(sub)}</span></span>` +
      `<span class="v">${esc(limitSummary(l))} <button type="button" class="secondary" data-act="edit-limit" data-scope="${attr(l.scope)}" aria-label="${attr(`Change ${label}`)}" data-needs-connection>Change</button></span></li>`;
  }
  const n = (v) => (v === null || v === undefined ? "" : attr(String(v)));
  return `<li class="edit"><form class="setting-form" data-form="limit" data-scope="${attr(l.scope)}" aria-label="${attr(`${label}: spending limit`)}">` +
    `<p class="k">${esc(label)}<span class="sub">${esc(sub)}</span></p>` +
    `<label>A day, in dollars <input type="number" inputmode="decimal" min="0" step="0.01" id="lim-${key}-daily" value="${n(l.daily_usd)}"></label>` +
    `<label>A month, in dollars <input type="number" inputmode="decimal" min="0" step="0.01" id="lim-${key}-monthly" value="${n(l.monthly_usd)}"></label>` +
    `<label>At the limit <select id="lim-${key}-action">${LIMIT_ACTIONS.map(([k, w, d]) => `<option value="${k}"${(l.action ?? "stop") === k ? " selected" : ""}>${esc(w)} — ${esc(d)}</option>`).join("")}</select></label>` +
    `<p class="muted">A blank field keeps what is set.</p>` +
    `<div class="acts"><button type="submit" data-needs-connection>Save</button><button type="button" class="secondary" data-act="cancel">Cancel</button></div></form></li>`;
}

/** A project's daily budget: what is spent today against it, and Change — or its form. */
export function projectBudgetRowHtml(p, { editing = false } = {}) {
  const has = p.daily_budget_usd !== null && p.daily_budget_usd !== undefined;
  const sub = `Spent $${fmtUsd(p.spend_today_usd)} today · reaching it turns on Review`;
  if (!editing) {
    return `<li class="kv"><span class="k">${esc(p.title ?? p.id)}<span class="sub">${esc(sub)}</span></span>` +
      `<span class="v">${has ? `$${esc(money(p.daily_budget_usd))}/day` : "No daily budget"} <button type="button" class="secondary" data-act="edit-project" data-slug="${attr(p.id)}" aria-label="${attr(`Change ${p.title ?? p.id}'s daily budget`)}" data-needs-connection>Change</button></span></li>`;
  }
  return `<li class="edit"><form class="setting-form" data-form="project" data-slug="${attr(p.id)}" aria-label="${attr(`${p.title ?? p.id}: daily budget`)}">` +
    `<p class="k">${esc(p.title ?? p.id)}<span class="sub">${esc(sub)}</span></p>` +
    `<label>A day, in dollars <input type="number" inputmode="decimal" min="0" step="0.01" id="proj-${idOf(p.id)}-daily" value="${has ? attr(String(p.daily_budget_usd)) : ""}"></label>` +
    `<p class="muted">Blank is no daily budget.</p>` +
    `<div class="acts"><button type="submit" data-needs-connection>Save</button><button type="button" class="secondary" data-act="cancel">Cancel</button></div></form></li>`;
}

export function providersRowHtml(compute) {
  const ps = compute?.providers ?? [];
  const v = ps.length ? ps.map((p) => `${esc(p.name)}${p.enabled === false ? ' <span class="muted">(off)</span>' : p.tag ? ` <span class="muted">(${esc(p.tag)})</span>` : ""}`).join(", ") : '<span class="muted">none</span>';
  return kv("Providers", v);
}

export function versionRowHtml(identity) {
  return kv("Version", identity?.version ? `Metistry ${esc(identity.version)}` : '<span class="muted">unknown</span>', identity?.api_version ? `Client API ${identity.api_version}` : "");
}

/** Which device this is: the passkey session's own row (`GET /api/whoami`). */
const thisDevice = (who) => (who?.via === "passkey_session" && who.session_id !== undefined ? String(who.session_id) : null);

/** The devices, newest seen first; this one says so. Revoke on each live one; Sign Out Everywhere when more than one is live. */
export function devicesRowsHtml(devices, who, confirming = null) {
  const mine = thisDevice(who);
  const live = devices.filter((d) => !d.revoked);
  const rows = devices.map((d) => {
    const self = String(d.id) === mine;
    if (confirming === `revoke:${d.id}`) {
      const text = self
        ? `Revoke ${d.label}? This is the device you are using — you are signed out here now, and signing in again takes its passkey.`
        : `Revoke ${d.label}? It is signed out now, and signing in again takes its passkey.`;
      return confirmHtml({ id: `revoke-${idOf(d.id)}-q`, text, verb: "Revoke", act: "revoke" });
    }
    const sub = d.revoked ? "Signed out" : d.last_seen_at ? `Last seen ${dateTime(d.last_seen_at)}` : "Never seen";
    const act = d.revoked ? "" : `<button type="button" class="destructive" data-act="ask-revoke" data-id="${attr(d.id)}" aria-label="${attr(`Revoke ${d.label}${self ? ", this device" : ""}`)}" data-needs-connection>Revoke</button>`;
    return `<li class="kv device${d.revoked ? " revoked" : ""}"><span class="k">${esc(d.label)}${self ? ' <span class="chip">This Device</span>' : ""}<span class="sub">${esc(sub)}</span></span><span class="v">${act}</span></li>`;
  });
  if (!devices.length) rows.push(`<li class="kv"><span class="k muted">No devices are enrolled.</span></li>`);
  if (live.length > 1) {
    if (confirming === "everywhere") {
      const names = live.map((d) => `${d.label}${String(d.id) === mine ? " (this one)" : ""}`).join(", ");
      rows.push(confirmHtml({ id: "everywhere-q", text: `Sign out all ${live.length} devices — ${names}? Each needs its passkey to sign in again.`, verb: "Sign Out Everywhere", act: "everywhere" }));
    } else {
      rows.push(`<li class="kv"><span class="k">Lost a device?<span class="sub">Revoke it above, or sign out of every device at once.</span></span><span class="v"><button type="button" class="destructive" data-act="ask-everywhere" data-needs-connection>Sign Out Everywhere</button></span></li>`);
    }
  }
  return rows.join("");
}

const STATUS_CLASS = (s) => (CHECK_STATES.includes(s) ? s : "absent");

export function connectionsRowsHtml(list) {
  if (!list.length) return kv("Connections", '<span class="muted">none</span>');
  return list.map((c) => {
    const tools = Array.isArray(c.tools) ? c.tools.length : 0;
    const used = (c.used_by ?? []).map((u) => u.name).filter(Boolean);
    const sub = `${tools} tool${tools === 1 ? "" : "s"}${used.length ? ` · used by ${used.join(", ")}` : ""}`;
    return kv(c.name, `<span class="${STATUS_CLASS(c.status)}">${esc(CHECK_WORD[c.status] ?? c.status ?? "unknown")}</span>`, sub);
  }).join("");
}

/** A secret's name, where it may go and when it was last used — the route never carries a value, and neither does this. */
export function secretsRowsHtml(list) {
  if (!list.length) return kv("Secrets", '<span class="muted">none</span>');
  return list.map((s) => {
    const hosts = (s.hosts ?? []).join(", ");
    const sub = [hosts ? `sent only to ${hosts}` : "", s.last_used ? `last used ${ago(s.last_used)}` : "never used"].filter(Boolean).join(" · ");
    return kv(s.name, s.present === false ? '<span class="failed">missing</span>' : "set", sub);
  }).join("");
}

export function vaultRowsHtml(v) {
  // with no remote, `remote`, `ahead` and `behind` are null: nothing to be ahead of
  const sync = v?.remote ? `${asNum(v.ahead)} ahead · ${asNum(v.behind)} behind` : "No remote";
  const push = v?.last_push;
  const sub = push ? (push.ok ? `Last pushed ${clockTime(push.at)}` : `The last push failed at ${clockTime(push.at)}`) : "Never pushed";
  const rows = [kv("Sync", esc(sync), sub, push && !push.ok ? "degraded" : "")];
  // `{paths}` while a conflict stops the sync (§2.21 rule 3): nothing pushes until it is settled
  if (v?.conflict) rows.push(kv("Conflict", '<span class="failed">sync stopped</span>', (v.conflict.paths ?? []).join(", ")));
  if (v?.last_commit) rows.push(kv("Last Change", esc(v.last_commit.subject ?? ""), v.last_commit.at ? dateTime(v.last_commit.at) : ""));
  return rows.join("");
}

// ============================================================================
// The view — wired to the DOM when app.js mounts it
// ============================================================================

/** The reads, by name: each group paints from its own, so one refusal never blanks another. */
const READS = {
  identity: "/api/identity",
  whoami: "/api/whoami",
  status: "/api/status",
  compute: "/api/compute",
  projects: "/api/projects",
  devices: "/api/devices",
  connections: "/api/connections",
  secrets: "/api/secrets",
  vault: "/api/vault/status",
};

/**
 * Mount Settings. `offline()` is the shell's: while it says so, no write is
 * sent (T7-4). `notify.settings()` paints the Notifications block
 * (notify.js). Returns `{ settings, refresh }` for the shell's `loadView` and
 * its live refetch.
 */
export function mountSettings({ $, api, show, notify = null, offline = () => false }) {
  const data = {}; // read name → { ok: true, body } | { ok: false, reason }
  let editing = null; // "limit:<scope>" · "project:<slug>" · "revoke:<id>" · "everywhere"
  const said = {}; // group id → the last receipt in it

  async function read(name) {
    try {
      const res = await api(READS[name]);
      const body = await res.json().catch(() => ({}));
      data[name] = res.ok ? { ok: true, body } : { ok: false, reason: body?.error?.message ?? `the console answered ${res.status}` };
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      data[name] = { ok: false, reason: String(e?.message ?? e) };
    }
  }

  /** Paint one row's read, or its state: reading, or failed in the server's words. */
  function readRows(name, what, paint) {
    const r = data[name];
    if (!r) return readingRowHtml(what);
    if (!r.ok) return failedRowHtml(what, r.reason);
    return paint(r.body);
  }

  const assistantName = () => (data.identity?.ok ? data.identity.body.name : null);

  function rowHtml(row) {
    if (row.mac) return macRowHtml(row);
    if (row.view) {
      return `<li class="nav"><button type="button" class="row" data-act="view" data-view="${attr(row.view)}"><span class="label">${esc(row.label)}<span class="sub">${esc(row.sub ?? "")}</span></span>${glyph("chevron", "chev")}</button></li>`;
    }
    switch (row.read ?? row.write) {
      case "identity": return readRows("identity", "the instance", identityRowsHtml);
      case "version": return readRows("identity", "the version", versionRowHtml);
      case "health": return readRows("status", "the checks", healthRowsHtml);
      case "assignment": return readRows("compute", "compute", (c) => assignmentRowHtml(c, assistantName()));
      case "providers": return data.compute?.ok ? providersRowHtml(data.compute.body) : ""; // compute's state is said once, above
      case "limits": return data.compute?.ok ? limitsRowsHtml(data.compute.body.limits) : "";
      case "project-budgets": return readRows("projects", "the projects", (b) => (b.projects ?? []).map((p) => projectBudgetRowHtml(p, { editing: editing === `project:${p.id}` })).join(""));
      case "devices": return readRows("devices", "the devices", (b) => devicesRowsHtml(b.devices ?? [], data.whoami?.ok ? data.whoami.body : null, editing));
      case "connections": return readRows("connections", "the connections", (b) => connectionsRowsHtml(b.connections ?? []));
      case "secrets": return readRows("secrets", "the secrets", (b) => secretsRowsHtml(b.secrets ?? []));
      case "vault": return readRows("vault", "the vault's status", vaultRowsHtml);
      default: return "";
    }
  }

  function limitsRowsHtml(limits) {
    if (!limits?.instance) return "";
    const rows = [limitRowHtml(limits.instance, { label: "Spending Limit", editing: editing === `limit:${limits.instance.scope}` })];
    for (const p of limits.providers ?? []) rows.push(limitRowHtml(p, { label: `${p.name} Limit`, editing: editing === `limit:${p.scope}` }));
    return rows.join("");
  }

  function groupHtml(g) {
    const msg = said[g.id] ?? "";
    return `<h3>${esc(g.title)}</h3><ul class="group settings-group" id="set-${attr(g.id)}" aria-label="${attr(g.title)}">${g.rows.map(rowHtml).join("")}</ul>` +
      `<p class="receipt" role="status" id="set-${attr(g.id)}-msg">${esc(msg)}</p>`;
  }

  function paint() {
    $("settings-head").innerHTML = SETTINGS_GROUPS.filter((g) => g.part === "head").map(groupHtml).join("");
    $("settings-rest").innerHTML = SETTINGS_GROUPS.filter((g) => g.part === "rest").map(groupHtml).join("");
  }

  async function settings() {
    editing = null;
    for (const k of Object.keys(said)) delete said[k];
    for (const k of Object.keys(data)) delete data[k];
    paint();
    await Promise.all([...Object.keys(READS).map((n) => read(n).then(paint)), notify ? notify.settings().catch(() => {}) : null]);
    paint();
  }

  /** A live refetch (T7-7): the reads again, leaving an open form or confirmation where it is. */
  async function refresh() {
    if (editing) return;
    await Promise.all(Object.keys(READS).map(read));
    if (!editing) paint();
  }

  function say(group, text) {
    said[group] = text;
    paint();
  }

  // ----- the doors -----

  async function saveLimit(scope) {
    const key = idOf(scope);
    const num = (id) => {
      const raw = String($(id).value ?? "").trim();
      if (raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : NaN;
    };
    const daily = num(`lim-${key}-daily`);
    const monthly = num(`lim-${key}-monthly`);
    const action = $(`lim-${key}-action`).value;
    if (Number.isNaN(daily) || Number.isNaN(monthly)) return say("compute", "Not saved — a limit is a number of dollars, 0 or more.");
    const limit = [data.compute?.body?.limits?.instance, ...(data.compute?.body?.limits?.providers ?? [])].find((l) => l?.scope === scope);
    const hasNow = limit && (limit.daily_usd !== null || limit.monthly_usd !== null);
    if (daily === undefined && monthly === undefined && !hasNow) return say("compute", "Not saved — give a daily or a monthly limit; what happens at a limit needs a limit.");
    const body = { scope, action, ...(daily === undefined ? {} : { daily }), ...(monthly === undefined ? {} : { monthly }) };
    const res = await api("/api/compute/budget", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) return say("compute", await refusalText(res, `Not saved — the console answered ${res.status}.`));
    editing = null;
    await read("compute");
    say("compute", "Saved. The engine holds every turn to it, before the call.");
  }

  async function saveProject(slug) {
    const raw = String($(`proj-${idOf(slug)}-daily`).value ?? "").trim();
    const n = raw === "" ? null : Number(raw);
    if (n !== null && !(Number.isFinite(n) && n >= 0)) return say("compute", "Not saved — a budget is a number of dollars, 0 or more.");
    const res = await api(`/api/projects/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify({ daily_budget_usd: n }) });
    if (!res.ok) return say("compute", await refusalText(res, `Not saved — the console answered ${res.status}.`));
    editing = null;
    await read("projects");
    say("compute", n === null ? "Saved — no daily budget." : `Saved — $${money(n)} a day.`);
  }

  async function revoke(id) {
    const res = await api(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
    return res.ok ? null : await refusalText(res, `the console answered ${res.status}`);
  }

  async function revokeOne(id) {
    const d = (data.devices?.body?.devices ?? []).find((x) => String(x.id) === String(id));
    const why = await revoke(id);
    editing = null;
    if (why) return say("account", `${d?.label ?? "That device"} was not revoked — ${why}.`);
    said.account = `${d?.label ?? "That device"} is signed out.`;
    await Promise.all([read("devices"), read("whoami")]); // revoking this device ends here: the shell's 401 shows the sign-in
    paint();
  }

  async function everywhere() {
    const mine = thisDevice(data.whoami?.ok ? data.whoami.body : null);
    const live = (data.devices?.body?.devices ?? []).filter((d) => !d.revoked);
    // this device last, so the others are gone before this session is
    const order = [...live.filter((d) => String(d.id) !== mine), ...live.filter((d) => String(d.id) === mine)];
    const failed = [];
    for (const d of order) {
      const why = await revoke(d.id);
      if (why) failed.push(`${d.label}: ${why}`);
    }
    editing = null;
    said.account = failed.length ? `Signed out ${order.length - failed.length} of ${order.length} — ${failed.join("; ")}.` : `Signed out of all ${order.length} devices.`;
    await Promise.all([read("devices"), read("whoami")]);
    paint();
  }

  $("settings").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "view") return show(el.dataset.view);
    if (act === "cancel") { editing = null; return paint(); }
    if (offline()) return say(act.includes("limit") || act.includes("project") ? "compute" : "account", OFFLINE_SETTING); // not offered offline (T7-4)
    // a form opens with focus in its first field; a confirmation with focus on Cancel, the default (P3)
    if (act === "edit-limit") { editing = `limit:${el.dataset.scope}`; paint(); return $(`lim-${idOf(el.dataset.scope)}-daily`)?.focus?.(); }
    if (act === "edit-project") { editing = `project:${el.dataset.slug}`; paint(); return $(`proj-${idOf(el.dataset.slug)}-daily`)?.focus?.(); }
    if (act === "ask-revoke") { editing = `revoke:${el.dataset.id}`; paint(); return $("settings-confirm-cancel")?.focus?.(); }
    if (act === "ask-everywhere") { editing = "everywhere"; paint(); return $("settings-confirm-cancel")?.focus?.(); }
    if (act === "revoke" && editing?.startsWith("revoke:")) return revokeOne(editing.slice("revoke:".length));
    if (act === "everywhere" && editing === "everywhere") return everywhere();
  });

  $("settings").addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    if (offline()) return say("compute", OFFLINE_SETTING); // a setting never waits (T7-4)
    if (form.dataset.form === "limit") return saveLimit(form.dataset.scope);
    if (form.dataset.form === "project") return saveProject(form.dataset.slug);
  });

  return { settings, refresh };
}
