// What every view of the PWA shares, and nothing else: output encoding, the
// clock, and the words for an agent's access. DOM-free on purpose — a view
// module imports these, and so does a test, as they are (no lifting).
//
// app.js is the shell; each view that has its own file (today.js,
// needs-you.js — screen 18 §2–§3, split per view by T7-3a; work.js,
// knowledge.js, more.js — screen 18 §5, T7-3b) imports from here
// and receives the shell's doors (`$`, `api`, `show`, …) when it is mounted,
// so the import graph stays a tree: app.js → a view → lib.js.

/**
 * Text → HTML. Escapes exactly what a text node's serialisation does — `&`,
 * `<` and `>` — so it is safe anywhere text goes; `attr` adds `"` for a
 * double-quoted attribute value. Every server value reaches markup through
 * one of the two (CRIT-7).
 */
export function esc(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export const attr = (s) => esc(s).replaceAll('"', "&quot;");

// ----- clock times: 12-hour with AM/PM, always (design-system-amendments §8.1) -----
// Never the device locale's clock: `toLocaleString()` is 24-hour on an en-GB
// or de-DE phone, which is how one screen came to show 13:02 beside 8:47 AM
// (review 01). The date keeps the locale's order; only the clock is pinned.
export function clockTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function dateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString()}, ${clockTime(d)}`;
}

/** How long ago, in the fewest words: *now*, *12m*, *3h*, *2d*. A duration, so it cannot be misread as a time. */
export function age(ts, now = Date.now()) {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The same, as a phrase: *12m ago*, *just now* — never "now ago". Empty for a time that is not one. */
export function ago(ts, now = Date.now()) {
  const a = age(ts, now);
  return a === "now" ? "just now" : a ? `${a} ago` : "";
}

// ----- an agent's access, in the owner's words (glossary.md) -----
// The stored tiers are none|index|areas; the owner reads none / titles /
// folders. `GET /api/agents` sends the rendered scope as `view.scope`; the
// fallback is for a row written before the field existed — an old
// `access_request` in Needs You still renders, in the same words, from the two
// fields it does carry. Agents (app.js) and Needs You both print it.
export const ACCESS_LABEL = { none: "none", index: "titles", areas: "folders" };
export const accessLabel = (t) => ACCESS_LABEL[t] ?? t;
export const scopeOf = (view, tier, areas) =>
  view?.scope ?? (tier === "areas" ? `folders: ${(areas ?? []).join(", ") || "nothing"}` : accessLabel(tier ?? "none"));

// ----- numbers off the wire -----
// pg returns count()/numeric/bigint as strings, so a number passes through
// asNum() before it is compared, added or drawn — a bar's width is a number
// computed here, never server text.
export const asNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const fmtUsd = (v) => asNum(v).toFixed(2);
export const barPct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (asNum(v) / max) * 100)) : 0);
export const barHtml = (v, max) => `<span class="bar"><span style="width:${barPct(v, max).toFixed(1)}%"></span></span>`;

// Agent prose is set in the serif (C32, C35 — style.css `.agent-prose`), so it
// reads as the assistant's before a word of it is read, and it still says so
// once quoted out of the app. Only for a body an agent wrote: the owner's own
// comment stays in the interface face. Chat, a room and an artifact's thread
// all print bodies through it.
export function bodyClass(c) {
  return c?.author_kind === "agent" ? "body agent-prose" : "body";
}

/** A glyph from the sprite in index.html, in its control's ink; decorative, so hidden from VoiceOver (the control names itself). */
export const glyph = (id, cls = "glyph") => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#g-${id}"/></svg>`;
