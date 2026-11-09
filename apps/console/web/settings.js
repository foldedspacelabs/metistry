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
//   - **the assistant's model and effort**: `POST /api/compute/assign`, for
//     `default` only, from the models `GET /api/compute/models` lists on the
//     providers the instance already runs (X-99) — never a provider, a key or
//     a base URL;
//   - **spending limits**: `POST /api/compute/budget` — the instance's, and
//     each provider's (daily, monthly, what happens at the limit);
//   - **each project's daily budget**: `PUT /api/projects/:slug`;
//   - **Scheduled's pause**: `POST /api/scheduled/routines/:name/pause|resume`
//     and, for a sync, `PUT /api/scheduled/syncs/:name` with `{paused}` (X-99)
//     — the Mac's own doors; a schedule, Run Now and what a routine runs are
//     not offered here;
//   - **devices**: `POST /api/devices/:id/revoke` — Remove, one device at a
//     time (its passkey and every session under it, §2.22), and Sign Out
//     Everywhere as that same door with `scope: "sessions"` once per signed-in
//     device, this one last — the sessions end, every passkey stays.
// Each is confirmed or edited in the page — never `window.confirm` (X-33) —
// and none is offered while the console cannot be reached (T7-4).
//
// Where it reads: `/api/identity`, `/api/whoami`, `/api/status`,
// `/api/compute`, `/api/scheduled`, `/api/projects`, `/api/devices`, `/api/connections`,
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
      { write: "assignment" },
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
      { write: "scheduled" },
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

/** The efforts `POST /api/compute/assign` takes (EFFORTS, packages/core), in the Mac's order. */
export const EFFORT_CHOICES = ["low", "medium", "high"];
const titleCase = (w) => `${String(w)[0]?.toUpperCase() ?? ""}${String(w).slice(1)}`;

/** The act → the group whose receipt says it (offline, or refused). */
const GROUP_OF = { "edit-model": "compute", "edit-limit": "compute", "edit-project": "compute", pause: "scheduled", resume: "scheduled" };

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

/** `<provider>/<model>` — exactly what an assignment takes. */
export const refOf = (a) => `${a.provider}/${a.model}`;

/** The assistant's `default` assignment, as the engine runs it. */
export const defaultAssignment = (compute) => (compute?.assignments ?? []).find((x) => x.target === "default");

/**
 * The assistant's model and effort: the `default` assignment, as the engine
 * runs it, and Change (X-99) — unless the console says it cannot write the file
 * (`writable: false`), when there is nothing to press and nothing to fail.
 */
export function assignmentRowHtml(compute, assistant) {
  const a = defaultAssignment(compute);
  const who = assistant ? `${assistant}'s Model` : "The Assistant's Model";
  const change = compute?.writable === false ? "" :
    ` <button type="button" class="secondary" data-act="edit-model" aria-label="${attr(`Change ${who}`)}" data-needs-connection>${a ? "Change" : "Choose"}</button>`;
  if (!a) return kv(who, `<span class="muted">not assigned</span>${change}`);
  return kv(who, `${esc(a.model)} <span class="muted">· ${esc(a.provider)}</span>${change}`, a.effort ? `${titleCase(a.effort)} effort` : "");
}

/**
 * The models to choose from: every model the providers the instance runs
 * serve (`GET /api/compute/models`), grouped by provider and skipping one that
 * is switched off or did not answer — and the current one, always, so Save
 * without a change is a no-op rather than a surprise.
 */
export function modelChoices(models, compute) {
  const off = new Set((compute?.providers ?? []).filter((p) => p.enabled === false).map((p) => p.name));
  const groups = [];
  for (const p of models?.providers ?? []) {
    if (off.has(p.name) || p.ok === false || !Array.isArray(p.models)) continue;
    const refs = p.models.map((m) => `${p.name}/${m}`);
    if (refs.length) groups.push({ provider: p.name, refs });
  }
  const now = defaultAssignment(compute);
  if (now && !groups.some((g) => g.refs.includes(refOf(now)))) {
    const own = groups.find((g) => g.provider === now.provider);
    if (own) own.refs.unshift(refOf(now));
    else groups.unshift({ provider: now.provider, refs: [refOf(now)] });
  }
  return groups;
}

/** The assistant's model, being changed: the models in a menu, the effort in another, Save and Cancel. */
export function modelFormHtml(compute, models, assistant, why = "") {
  const a = defaultAssignment(compute);
  const who = assistant ? `${assistant}'s Model` : "The Assistant's Model";
  const now = a ? refOf(a) : "";
  const groups = modelChoices(models, compute);
  const options = (a ? "" : '<option value="" selected>Choose a model</option>') + groups.map((g) =>
    `<optgroup label="${attr(g.provider)}">${g.refs.map((r) => `<option value="${attr(r)}"${r === now ? " selected" : ""}>${esc(r.slice(g.provider.length + 1))}</option>`).join("")}</optgroup>`).join("");
  const effort = a?.effort ?? "medium";
  return `<li class="edit"><form class="setting-form" data-form="model" aria-label="${attr(`${who}: model and effort`)}">` +
    `<p class="k">${esc(who)}<span class="sub">${esc(a ? `Now ${now}, ${effort} effort` : "Nothing is assigned yet")}</span></p>` +
    (why ? `<p class="muted" role="status">${esc(why)}</p>` : "") +
    `<label>Model <select id="model-ref">${options}</select></label>` +
    `<label>Effort <select id="model-effort">${EFFORT_CHOICES.map((e) => `<option value="${e}"${e === effort ? " selected" : ""}>${esc(titleCase(e))}</option>`).join("")}</select></label>` +
    `<p class="muted">The models are the ones your providers already serve. Providers and keys are set on the Mac.</p>` +
    `<div class="acts"><button type="submit" data-needs-connection>Save</button><button type="button" class="secondary" data-act="cancel">Cancel</button></div></form></li>`;
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

/**
 * Scheduled's pause (X-99): one row per routine and per sync — its name, when
 * it runs or why it does not, and Pause or Resume. Nothing else of Scheduled
 * is drawn: a schedule, Run Now and what a routine runs stay where they are.
 */
export function scheduledRowHtml(u, kind, { busy = false } = {}) {
  const paused = u?.paused?.value === true;
  const bits = [u.describe, paused ? "paused" : u.held ? `held — ${u.held}` : u.next_run ? `next ${dateTime(u.next_run)}` : ""].filter(Boolean);
  const act = paused ? "resume" : "pause";
  const title = u.title ?? u.name;
  return `<li class="kv"><span class="k">${esc(title)}<span class="sub">${esc(bits.join(" · "))}</span></span>` +
    `<span class="v"><button type="button" class="secondary" data-act="${act}" data-kind="${attr(kind)}" data-name="${attr(u.name)}" aria-label="${attr(`${paused ? "Resume" : "Pause"} ${title}`)}"${busy ? " disabled" : ""} data-needs-connection>${paused ? "Resume" : "Pause"}</button></span></li>`;
}

export function scheduledRowsHtml(body, busy = new Set()) {
  const rows = [
    ...(body?.routines ?? []).map((r) => scheduledRowHtml(r, "routine", { busy: busy.has(`routine:${r.name}`) })),
    ...(body?.syncs ?? []).map((r) => scheduledRowHtml(r, "sync", { busy: busy.has(`sync:${r.name}`) })),
  ];
  return rows.length ? rows.join("") : kv("Scheduled", '<span class="muted">nothing is scheduled</span>');
}

export function providersRowHtml(compute) {
  const ps = compute?.providers ?? [];
  const v = ps.length ? ps.map((p) => `${esc(p.name)}${p.enabled === false ? ' <span class="muted">(off)</span>' : p.tag ? ` <span class="muted">(${esc(p.tag)})</span>` : ""}`).join(", ") : '<span class="muted">none</span>';
  return kv("Providers", v);
}

export function versionRowHtml(identity) {
  return kv("Version", identity?.version ? `Metistry ${esc(identity.version)}` : '<span class="muted">unknown</span>', identity?.api_version ? `Client API ${identity.api_version}` : "");
}

/** Which session this is: the passkey session's own (`GET /api/whoami`). */
const thisSession = (who) => (who?.via === "passkey_session" && who.session_id !== undefined ? String(who.session_id) : null);

/** A device is a passkey with its sessions under it (§2.22); this one is the row the console marks, or the row holding this session. */
const isThisDevice = (d, mine) => d.this_device === true || (mine !== null && (String(d.id) === mine || (d.sessions ?? []).some((s) => String(s.id) === mine)));

/** Signed in somewhere: a live session under it. A body from before §2.22 had no `sessions`; its `revoked` says. */
const signedIn = (d) => (Array.isArray(d.sessions) ? d.sessions.some((s) => !s.revoked) : !d.revoked);

/**
 * The devices, newest seen first; this one says so. **Remove** on each — the
 * device's passkey and every session under it are gone, so it never signs in
 * again (C136: confirmed naming the device) — and **Sign Out Everywhere** when
 * more than one is signed in: sessions only, every passkey kept.
 */
export function devicesRowsHtml(devices, who, confirming = null) {
  const mine = thisSession(who);
  const live = devices.filter(signedIn);
  const rows = devices.map((d) => {
    const self = isThisDevice(d, mine);
    if (confirming === `revoke:${d.id}`) {
      const text = self
        ? `Remove ${d.label}? This is the device you are using — you are signed out here now, and it cannot sign in again until it is added as a new device.`
        : `Remove ${d.label}? It is signed out now and cannot sign in again until it is added as a new device; its notifications stop.`;
      return confirmHtml({ id: `revoke-${idOf(d.id)}-q`, text, verb: "Remove", act: "revoke" });
    }
    const seen = d.last_seen ?? d.last_seen_at;
    const parts = [d.added ? `Added ${dateTime(d.added)}` : "", signedIn(d) ? (seen ? `Last seen ${dateTime(seen)}` : "Never seen") : "Signed out"].filter(Boolean);
    const act = `<button type="button" class="destructive" data-act="ask-revoke" data-id="${attr(d.id)}" aria-label="${attr(`Remove ${d.label}${self ? ", this device" : ""}`)}" data-needs-connection>Remove</button>`;
    return `<li class="kv device${signedIn(d) ? "" : " revoked"}"><span class="k">${esc(d.label)}${self ? ' <span class="chip">This Device</span>' : ""}<span class="sub">${esc(parts.join(" · "))}</span></span><span class="v">${act}</span></li>`;
  });
  if (!devices.length) rows.push(`<li class="kv"><span class="k muted">No devices are enrolled.</span></li>`);
  if (live.length > 1) {
    if (confirming === "everywhere") {
      const names = live.map((d) => `${d.label}${isThisDevice(d, mine) ? " (this one)" : ""}`).join(", ");
      rows.push(confirmHtml({ id: "everywhere-q", text: `Sign out all ${live.length} devices — ${names}? Each needs its passkey to sign in again.`, verb: "Sign Out Everywhere", act: "everywhere" }));
    } else {
      rows.push(`<li class="kv"><span class="k">Lost a device?<span class="sub">Remove it above, or sign out of every device at once.</span></span><span class="v"><button type="button" class="destructive" data-act="ask-everywhere" data-needs-connection>Sign Out Everywhere</button></span></li>`);
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
  scheduled: "/api/scheduled",
  projects: "/api/projects",
  devices: "/api/devices",
  connections: "/api/connections",
  secrets: "/api/secrets",
  vault: "/api/vault/status",
};

/** Read only when a form needs it: the providers' live model lists are a call to each provider, so they are never part of the page's own reads or its refetch. */
const LAZY_READS = { models: "/api/compute/models" };

/**
 * Mount Settings. `offline()` is the shell's: while it says so, no write is
 * sent (T7-4). `notify.settings()` paints the Notifications block
 * (notify.js). Returns `{ settings, refresh }` for the shell's `loadView` and
 * its live refetch.
 */
export function mountSettings({ $, api, show, notify = null, offline = () => false }) {
  const data = {}; // read name → { ok: true, body } | { ok: false, reason }
  let editing = null; // "model" · "limit:<scope>" · "project:<slug>" · "revoke:<id>" · "everywhere"
  const said = {}; // group id → the last receipt in it
  const busy = new Set(); // "routine:<name>" · "sync:<name>" — a pause in flight

  async function read(name) {
    try {
      const res = await api(READS[name] ?? LAZY_READS[name]);
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
      case "assignment": return readRows("compute", "compute", (c) => editing === "model" ? modelEditHtml(c) : assignmentRowHtml(c, assistantName()));
      case "scheduled": return readRows("scheduled", "Scheduled", (b) => scheduledRowsHtml(b, busy));
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

  /** The model form, once the models have been asked for: reading while they are, the form with the reason when they could not be. */
  function modelEditHtml(compute) {
    const m = data.models;
    if (!m) return readingRowHtml("the models");
    return modelFormHtml(compute, m.ok ? m.body : null, assistantName(), m.ok ? "" : `Couldn't list the models — ${m.reason}. The effort can still change.`);
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

  async function saveModel() {
    const ref = String($("model-ref").value ?? "").trim();
    const effort = String($("model-effort").value ?? "");
    if (ref === "") return say("compute", "Not saved — choose a model.");
    if (!EFFORT_CHOICES.includes(effort)) return say("compute", "Not saved — effort is low, medium or high.");
    const res = await api("/api/compute/assign", { method: "POST", body: JSON.stringify({ tier: "default", model: ref, effort }) });
    if (!res.ok) return say("compute", await refusalText(res, `Not saved — the console answered ${res.status}.`));
    editing = null;
    await read("compute");
    say("compute", `Saved — ${assistantName() ?? "the assistant"} uses ${ref} at ${effort} effort.`);
  }

  /** Pause or resume one routine or sync, through the door the Mac uses; the list is read again either way. */
  async function setPaused(kind, name, pause) {
    const id = `${kind}:${name}`;
    if (busy.has(id)) return;
    busy.add(id);
    paint();
    const enc = encodeURIComponent(name);
    const u = (data.scheduled?.body?.[kind === "sync" ? "syncs" : "routines"] ?? []).find((x) => x.name === name);
    const label = u?.title ?? name;
    let why = null;
    try {
      const res = kind === "sync"
        ? await api(`/api/scheduled/syncs/${enc}`, { method: "PUT", body: JSON.stringify({ paused: pause }) })
        : pause
          ? await api(`/api/scheduled/routines/${enc}/pause`, { method: "POST", body: "{}" })
          : await api(`/api/scheduled/routines/${enc}/resume`, { method: "POST", body: "{}" });
      if (!res.ok) why = await refusalText(res, `the console answered ${res.status}`);
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      why = String(e?.message ?? e);
    }
    busy.delete(id);
    if (why) said.scheduled = `${label} was not ${pause ? "paused" : "resumed"} — ${why}.`;
    else said.scheduled = pause ? `${label} is paused.` : `${label} is running again.`;
    await read("scheduled");
    paint();
  }

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

  /** `scope: "device"` removes it — passkey and sessions; `scope: "sessions"` signs it out and keeps the passkey. */
  async function revoke(id, scope) {
    const res = await api(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({ scope }) });
    return res.ok ? null : await refusalText(res, `the console answered ${res.status}`);
  }

  async function revokeOne(id) {
    const d = (data.devices?.body?.devices ?? []).find((x) => String(x.id) === String(id));
    const why = await revoke(id, "device");
    editing = null;
    if (why) return say("account", `${d?.label ?? "That device"} was not removed — ${why}.`);
    said.account = `${d?.label ?? "That device"} was removed.`;
    await Promise.all([read("devices"), read("whoami")]); // removing this device ends here: the shell's 401 shows the sign-in
    paint();
  }

  async function everywhere() {
    const mine = thisSession(data.whoami?.ok ? data.whoami.body : null);
    const live = (data.devices?.body?.devices ?? []).filter(signedIn);
    // this device last, so the others are gone before this session is
    const order = [...live.filter((d) => !isThisDevice(d, mine)), ...live.filter((d) => isThisDevice(d, mine))];
    const failed = [];
    for (const d of order) {
      const why = await revoke(d.id, "sessions");
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
    if (offline()) return say(GROUP_OF[act] ?? "account", OFFLINE_SETTING); // not offered offline (T7-4)
    if (act === "pause" || act === "resume") return setPaused(el.dataset.kind === "sync" ? "sync" : "routine", el.dataset.name, act === "pause");
    // a form opens with focus in its first field; a confirmation with focus on Cancel, the default (P3)
    if (act === "edit-model") {
      editing = "model";
      delete data.models; // the providers' lists may have moved since the last time
      paint();
      await read("models");
      if (editing !== "model") return; // cancelled while the providers answered
      paint();
      return $("model-ref")?.focus?.();
    }
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
    if (form.dataset.form === "model") return saveModel();
    if (form.dataset.form === "limit") return saveLimit(form.dataset.scope);
    if (form.dataset.form === "project") return saveProject(form.dataset.slug);
  });

  return { settings, refresh };
}
