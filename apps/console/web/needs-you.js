// Needs You — the one queue for everything that needs the owner (D7), as the
// PWA draws it: the bell's sheet on a phone, the list-then-detail of a narrow
// window, and a view in place at 900px (screen 18 §3, screen 3 §12–§13,
// design-build-plan §2.12). T7-3a split it out of app.js.
//
// Every row is a REQUEST, and a request reads as one of the types in F-5's
// table (packages/core/src/requests.ts). The PWA cannot import core, so
// GET /api/proposals serves each row's reading as `request` — the word, the
// body block and the three answers its type offers there — and this view
// draws that: it keeps no kind → word map and no answer set of its own. A row
// from a console that predates `request` gets R1's three answers and nothing
// that depends on reading its type (it cannot be swiped).
//
// The answers (C92): the type's primary verb, the one accent-filled button ·
// Revise · Decline, outlined and in the neutral surface — never red — then
// Later. Skip is bulk-only (K2): it lives on the selection bar and its `s`
// key, never on a row. An answer that goes through another system's door
// (§2.11: a PR review, an RSVP, a report's act…) is not offered here until
// that door exists; the row still shows what it is and can be put down with
// Later.
//
// Every value reaches markup through esc()/attr() (CRIT-7).

import { age, attr, esc, scopeOf } from "./lib.js";

// ============================================================================
// Reading a row — pure, so a test drives it with the server's own rows
// ============================================================================

/** The word the owner reads for a row — the table's, as the server served it. */
export const requestWord = (p) => p?.request?.word ?? "";
/** A group heading: the table's word in Title Case (P10). */
export const requestHeading = (word) => String(word ?? "").replace(/\b\w/g, (ch) => ch.toUpperCase());

/** An answer that stores `d` on the row. */
const storing = (d) => ({ decision: d });
/** R1's three answers (C92), for a row that arrives without `request`. */
const R1 = {
  primary: { label: "Approve", sends: storing("allow") },
  revise: { label: "Revise", sends: storing("accept_with_changes"), carries: "feedback" },
  decline: { label: "Decline", sends: storing("deny") },
};
/** Later is not an answer — it gives the row an `until` and leaves it pending — and every type takes it. */
export const LATER = { d: "later", label: "Later" };

/** A row's three answers as its type offers them: the served reading, or R1's. `null` is an answer the type does not have. */
export function answersOf(p) {
  const r = p?.request;
  if (!r || typeof r !== "object") return R1;
  return { primary: r.primary ?? null, revise: r.revise ?? null, decline: r.decline ?? null };
}

/** What an answer stores on the row, or null when it goes through another system's door (§2.11). */
export const decisionOf = (a) => (a && a.sends && typeof a.sends.decision === "string" ? a.sends.decision : null);

/** The one line the card is about: the classification's action or title, the payload's title, else the table's word. */
export function askOf(p) {
  const c = p?.payload?.classification ?? {};
  return String(c.action || c.title || p?.payload?.title || requestHeading(requestWord(p)) || "");
}

// ----- questions: v2's `payload.questions`, or v1's one title and its options -----

const MAX_OPTIONS = 8; // the decision block's own bound (core decision-block.ts)

/**
 * The questions a `choices` body asks, normalised: `{prompt, options, multi,
 * other, v1}`. v2 (T2-3) carries `questions[] {prompt, options[], multi,
 * allow_other}`; v1 is one question — the row's title and `payload.options` —
 * answered by the option itself. The server checks every answer against the
 * stored row again; nothing here widens what it accepts.
 */
export function questionsOf(p) {
  const pl = p?.payload ?? {};
  if (Array.isArray(pl.questions) && pl.questions.length) {
    return pl.questions
      .filter((q) => q && typeof q === "object")
      .map((q) => ({
        prompt: String(q.prompt ?? ""),
        options: (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS).map(String),
        multi: q.multi === true,
        other: q.allow_other === true,
        v1: false,
      }))
      .filter((q) => q.options.length > 0 || q.other);
  }
  if (Array.isArray(pl.options) && pl.options.length) {
    return [{ prompt: String(pl.title ?? ""), options: pl.options.slice(0, MAX_OPTIONS).map(String), multi: false, other: false, v1: true }];
  }
  return [];
}

/** Whether one question has an answer: an option chosen, or words in *Something else…* where it is offered. */
export const isAnswered = (q, a) => (a?.chosen?.length ?? 0) > 0 || (q.other === true && String(a?.other ?? "").trim() !== "");
/** How many are still to answer — the count above Send Answers. */
export const leftToAnswer = (qs, answers) => qs.filter((q, i) => !isAnswered(q, answers[i])).length;
/** Send Answers fills only when every question has an answer (screen 3 §12.3). */
export const canSend = (qs, answers) => qs.length > 0 && leftToAnswer(qs, answers) === 0;
/** Next moves on only from an answered question; the step after the last is the summary, *Your Answers*. */
export const nextStep = (qs, answers, step) => (step < qs.length && isAnswered(qs[step], answers[step]) ? step + 1 : step);
/** Back is always there, and stops at the first question. */
export const backStep = (step) => Math.max(0, step - 1);
/**
 * A single question skips the summary: choosing sends (screen 3 §13.2) —
 * when choosing is the whole answer. Pick-any and *Something else…* need the
 * owner to say they are done, so they keep a Send Answers.
 */
export const choosingSends = (qs) => qs.length === 1 && !qs[0].multi && !qs[0].other;

/** One question's answer after a choice: pick one replaces (and clears the words); pick any toggles. */
export function choose(q, a, option) {
  const chosen = a?.chosen ?? [];
  if (!q.multi) return { chosen: [option], other: "" };
  return { chosen: chosen.includes(option) ? chosen.filter((o) => o !== option) : [...chosen, option], other: a?.other ?? "" };
}
/** Words in *Something else…*: on a pick-one question they are the answer, so they clear the choice. */
export function writeOther(q, a, text) {
  return { chosen: q.multi ? (a?.chosen ?? []) : [], other: text };
}

/**
 * The body an answer to a `choices` row sends. A single pick-one question
 * answers with the option itself — the v1 wire, which T2-3's server still
 * takes for any row that is exactly one pick-one question. Otherwise it
 * sends the decision `answers` (§2.12: Send Answers → per-question answers)
 * with one entry per question, in order: `{choices, other?}` — T2-3's own
 * frozen shape (`checkAnswers`, packages/core/src/decision-block.ts), checked
 * again there against the stored row. Built here and nowhere else, so
 * matching it is this one function.
 */
export const SEND_ANSWERS = "answers"; // the decision a v2 question's Send Answers stores (core REQUEST_DECISIONS)
export function answersBody(qs, answers) {
  if (qs.length === 1 && qs[0].v1) return { decision: answers[0]?.chosen?.[0] ?? "" };
  return {
    decision: SEND_ANSWERS,
    answers: qs.map((q, i) => {
      const a = answers[i] ?? {};
      const out = { choices: [...(a.chosen ?? [])] };
      const other = String(a.other ?? "").trim();
      if (q.other && other) out.other = other;
      return out;
    }),
  };
}

const answerText = (q, a) => [...(a?.chosen ?? []), ...(q.other && String(a?.other ?? "").trim() ? [String(a.other).trim()] : [])].join(", ");

// ----- swipe (screen 18 §3) -----

/**
 * The answer a swipe gives, or null when this row cannot be swiped that way.
 * Right approves and left declines — only where that answer is a decision on
 * the row itself. **A card with Before and after opens instead of swiping,
 * because its consequence needs reading**; so does a question (it is
 * answered by choosing), a grouped card, any answer that goes through another
 * system's door, and a row whose type the server did not read.
 */
export function swipeAnswer(p, dir) {
  const r = p?.request;
  if (!r || typeof r !== "object") return null;
  if (r.body === "before_after" || r.body === "choices" || r.grouped === true) return null;
  const a = dir === "right" ? r.primary : dir === "left" ? r.decline : null;
  const d = decisionOf(a);
  if (dir === "right" ? d !== "allow" && d !== "accept_as_work" : d !== "deny" && d !== "skip") return null;
  return a;
}

export const SWIPE_MIN_PX = 88;
export const SWIPE_FRACTION = 0.35;
/** A released swipe: the answer it commits, or null — too short, or a way this row does not swipe. */
export function swipeResult(p, dx, width) {
  if (!Number.isFinite(dx) || dx === 0) return null;
  const dir = dx > 0 ? "right" : "left";
  const answer = swipeAnswer(p, dir);
  if (!answer) return null;
  return Math.abs(dx) >= Math.max(SWIPE_MIN_PX, (Number(width) || 0) * SWIPE_FRACTION) ? { dir, answer } : null;
}

/** The queue as the sheet groups it: by the table's word, oldest first within and between groups. */
export function groupRows(rows) {
  const groups = new Map();
  for (const p of [...rows].sort((a, b) => new Date(a.ts) - new Date(b.ts) || Number(a.id) - Number(b.id))) {
    const word = requestWord(p);
    if (!groups.has(word)) groups.set(word, []);
    groups.get(word).push(p);
  }
  return [...groups];
}

// ============================================================================
// Drawing — pure HTML from a row and its view state
// ============================================================================

const CLIP = 140; // an agent's argument, a reason: a claim, never a document
const EXCERPT = 320;
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const text = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const glyph = (id) => `<svg class="glyph" aria-hidden="true" focusable="false"><use href="#g-${id}"/></svg>`;
const ANSWER_GLYPH = { primary: "check", revise: "pencil", decline: "x" };

/** What an action did or would do, in one line: its kind and its own fields. */
const ACTION_NOISE = ["ok", "kind", "at", "by", "on_behalf_of"];
export function actionNote(a) {
  if (!a.ok) return `refused — ${a.message}`;
  const parts = Object.entries(a).filter(([k]) => !ACTION_NOISE.includes(k)).map(([k, v]) => `${k} ${v}`);
  return `${a.kind}${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

/** Header — type · who asked · provenance · age (screen 3 §12.2, part 1). The agent chip is the one tinted pill. */
function headerHtml(p, now) {
  const external = p.trust && p.trust !== "internal" ? ` <span class="chip">external</span>` : "";
  return `<div class="card-head"><span class="card-type">${esc(requestHeading(requestWord(p)))}</span>` +
    `<span class="chip asker">${esc(p.source_agent ?? "")}</span>${external}` +
    `<span class="card-age">${esc(age(p.ts, now))}</span></div>`;
}

/** Context — the agent's own words, on the agent wash, clipped (part 3). */
function contextHtml(p) {
  const words = p.payload?.context?.prose ?? p.payload?.reason;
  return words ? `<p class="card-context agent-prose">${esc(clip(text(words), CLIP * 2))}</p>` : "";
}

/** The before and after of an access request: what the credential holds now, and what Approve changes (components-01 §2.3). */
function accessBody(p) {
  const pl = p.payload ?? {};
  const held = scopeOf(pl.current_scope, pl.current_tier, pl.current_areas);
  const trade = pl.current_tier === "index" ? " — and gives up its whole-vault title browse" : "";
  const again = pl.escalated ? `<p class="muted">Asked again after a decline — you answered #${esc(String(pl.prior_proposal ?? "?"))}</p>` : "";
  return `<div class="ba"><div class="ba-side"><span class="ba-label">Now</span><p>${esc(held)}</p></div>` +
    `<div class="ba-side"><span class="ba-label">What Approve Does</span><p>Adds <b>${esc(String(pl.area ?? "?"))}</b>${esc(trade)}</p></div></div>${again}`;
}

/** A before and after the payload names (`payload.body`, screen 3 §12.6): two labelled texts, the whole of each. */
function beforeAfterBody(p) {
  const b = p.payload?.body;
  if (b && typeof b === "object" && (b.before || b.after)) {
    const side = (s, fallback) => `<div class="ba-side"><span class="ba-label">${esc(s?.label ?? fallback)}</span><pre class="ba-text">${esc(text(s?.text))}</pre></div>`;
    return `${b.heading ? `<p class="ba-heading">${esc(b.heading)}</p>` : ""}<div class="ba">${side(b.before, "Before")}${side(b.after, "After")}</div>`;
  }
  if (p.payload?.area !== undefined || p.payload?.current_tier !== undefined) return accessBody(p);
  return excerptBody(p);
}

/** An action's preview: the kind and a short preview of its own arguments (docs/ops/actions.md) — approving something unseen is not a decision. */
function previewBody(p, answers) {
  const pl = p.payload ?? {};
  const parts = [];
  if (pl.action && typeof pl.action === "object") {
    const args = Object.entries(pl.action.args ?? {})
      .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
      .join(" ");
    parts.push(`<p class="preview"><b>${esc(pl.action.kind ?? "?")}</b> ${esc(clip(args, CLIP))}</p>`);
    if (pl.result) parts.push(`<p class="muted">Done — ${esc(actionNote({ ok: true, kind: pl.action.kind, ...pl.result }))}</p>`);
  } else {
    const shown = pl.summary ?? pl.preview ?? (typeof pl.body === "string" ? pl.body : null);
    if (shown) parts.push(`<p class="preview">${esc(clip(text(shown), EXCERPT))}</p>`);
    if (pl.path) parts.push(`<p class="muted mono">${esc(pl.path)}</p>`);
  }
  if (decisionOf(answers.primary) === "accept_as_work" && pl.suggested_work?.title) {
    parts.push(`<p class="muted">Approving adds the task “${esc(pl.suggested_work.title)}” to the board, unassigned.</p>`);
  }
  return parts.join("");
}

/** An excerpt: the row's own summary or text, clipped — a report, a message, a task from a tracker. */
function excerptBody(p) {
  const pl = p.payload ?? {};
  const shown = pl.summary ?? pl.excerpt ?? (typeof pl.body === "string" ? pl.body : null) ?? pl.message;
  return shown ? `<p class="preview">${esc(clip(text(shown), EXCERPT))}</p>` : "";
}

/** A pull request: what it is, and the way to it. Its answers post to GitHub through a door this build does not open from the phone. */
function pullRequestBody(p) {
  const pl = p.payload ?? {};
  const ref = pl.repo && pl.number ? `${pl.repo}#${pl.number}` : "";
  const url = /^https:\/\/github\.com\//.test(String(pl.url ?? "")) ? pl.url : null; // only a github.com url becomes a link
  return `${ref ? `<p class="mono">${esc(ref)}</p>` : ""}${excerptBody(p)}` +
    (url ? `<p><a href="${attr(url)}" target="_blank" rel="noopener">Open on GitHub</a></p>` : "");
}

/** The questions, one at a time (screen 3 §13.2; C109): a segmented bar, *Question 2 of 3*, Next and Back, then *Your Answers*. */
export function questionsHtml(p, st = {}) {
  const qs = questionsOf(p);
  if (!qs.length) return excerptBody(p);
  const id = attr(p.id);
  const answers = st.answers ?? [];
  const busy = st.busy ? " disabled" : "";
  const step = Math.min(Math.max(0, st.step ?? 0), qs.length);
  const many = qs.length > 1;

  if (many && step === qs.length) {
    const rows = qs.map((q, i) => `<li><span class="q-prompt">${esc(q.prompt)}</span><span class="q-answer">${esc(answerText(q, answers[i])) || "—"}</span>` +
      `<button type="button" class="link" data-act="edit" data-id="${id}" data-q="${i}">Edit</button></li>`).join("");
    const left = leftToAnswer(qs, answers);
    return `<div class="q-steps" data-step="summary"><p class="q-count">Your Answers</p><ol class="q-summary">${rows}</ol>` +
      `${left ? `<p class="muted">${left} left to answer</p>` : ""}` +
      `<button type="button" class="answer primary" data-act="send-answers" data-id="${id}" data-needs-connection${left || st.busy ? " disabled" : ""}>${glyph("check")}Send Answers</button></div>`;
  }

  const q = qs[step];
  const a = answers[step] ?? {};
  const name = `q-${id}-${step}`;
  const progress = many
    ? `<div class="q-bar" aria-hidden="true">${qs.map((_, i) => `<span class="${i < step ? "done" : i === step ? "on" : ""}"></span>`).join("")}</div>` +
      `<p class="q-count">Question ${step + 1} of ${qs.length}</p>`
    : "";
  // One question whose choice is its whole answer: each option is a button that sends.
  const sends = choosingSends(qs);
  const options = q.options.map((o, j) => sends
    ? `<button type="button" class="q-option" data-act="choose" data-id="${id}" data-q="${step}" data-o="${j}" data-needs-connection${busy}>${esc(o)}</button>`
    : `<label class="q-option"><input type="${q.multi ? "checkbox" : "radio"}" name="${name}" data-act="pick" data-id="${id}" data-q="${step}" data-o="${j}"${(a.chosen ?? []).includes(o) ? " checked" : ""}${busy}> ${esc(o)}</label>`).join("");
  const other = q.other
    ? `<label class="q-other">Something else…<input type="text" data-act="other" data-id="${id}" data-q="${step}" value="${attr(a.other ?? "")}" autocomplete="off"${busy}></label>`
    : "";
  const answered = isAnswered(q, a);
  const nav = many
    ? `<div class="q-nav">${step > 0 ? `<button type="button" class="secondary" data-act="back" data-id="${id}">Back</button>` : ""}` +
      `<button type="button" data-act="next" data-id="${id}"${answered ? "" : " disabled"}>Next</button></div>`
    : sends
      ? ""
      : `<div class="q-nav"><button type="button" class="answer primary" data-act="send-answers" data-id="${id}" data-needs-connection${answered && !st.busy ? "" : " disabled"}>${glyph("check")}Send Answers</button></div>`;
  // a v1 question's prompt IS the card's ask: said once on screen, still the group's name to VoiceOver
  const legend = !q.prompt || q.prompt === askOf(p) ? ` class="visually-hidden"` : "";
  return `<div class="q-steps" data-step="${step}">${progress}<fieldset class="q"><legend${legend}>${esc(q.prompt || askOf(p))}</legend>${options}${other}</fieldset>${nav}</div>`;
}

/** The body block, exactly one from the closed set (screen 3 §12.2, part 4). */
export function bodyHtml(p, st = {}) {
  const answers = answersOf(p);
  switch (p?.request?.body) {
    case "choices": return questionsHtml(p, st);
    case "before_after": return beforeAfterBody(p);
    case "preview": return previewBody(p, answers);
    case "diff":
    case "thread": return pullRequestBody(p);
    default: return p?.request ? excerptBody(p) : previewBody(p, answers) || excerptBody(p);
  }
}

/** One answer button, or nothing: an answer the type lacks, or one through a door this build does not open. */
function answerButton(p, which, a, busy) {
  const d = decisionOf(a);
  if (!d || !a.label) return "";
  const cls = which === "primary" ? "answer primary" : `answer ${which}`;
  return `<button type="button" class="${cls}" data-act="${which}" data-id="${attr(p.id)}" data-d="${attr(d)}" data-needs-connection${busy ? " disabled" : ""}>${glyph(ANSWER_GLYPH[which])}${esc(a.label)}</button>`;
}

/** The answers row: primary · Revise · Decline, then Later (C92). A question's primary is Send Answers, inside its steps. */
export function answersHtml(p, st = {}) {
  const a = answersOf(p);
  const busy = Boolean(st.busy);
  const question = p?.request?.body === "choices" && questionsOf(p).length > 0;
  const primary = question ? "" : answerButton(p, "primary", a.primary, busy);
  const later = `<button type="button" class="answer later" data-act="later" data-id="${attr(p.id)}" data-d="${LATER.d}" data-needs-connection${busy ? " disabled" : ""}>${LATER.label}</button>`;
  return `<div class="answers">${primary}${answerButton(p, "revise", a.revise, busy)}${answerButton(p, "decline", a.decline, busy)}<span class="spacer"></span>${later}</div>`;
}

/** Revise's words: what should change — or, on an access request, the narrower folder (C40). An empty reason cancels rather than sends. */
function reviseFormHtml(p) {
  const a = answersOf(p).revise;
  const area = a?.carries === "area";
  const field = area
    ? `<input type="text" name="text" value="${attr(p.payload?.area ?? "")}" autocomplete="off" autocapitalize="none">`
    : `<textarea name="text"></textarea>`;
  return `<form class="revise-form" data-id="${attr(p.id)}"><label>${area ? "Grant which folder instead?" : "What should change?"}${field}</label>` +
    `<span><button type="submit" data-needs-connection>Send</button><button type="button" class="secondary" data-act="revise-cancel" data-id="${attr(p.id)}">Cancel</button></span></form>`;
}

/**
 * One card: header · the ask · context · body · answers (screen 3 §12.2).
 * `st` is the card's view state: `stale` (a 409 repainted it), `refusal` (the
 * last answer was refused), `revising`, `busy` (deciding: the row is disabled,
 * nothing spins), and a question's `step` and `answers`.
 */
export function cardHtml(p, st = {}, now = Date.now()) {
  const stale = st.stale ? `<p class="card-stale" role="status">This moved while the card was open, so nothing was sent. The card below is the current version.</p>` : "";
  // C45: an answer whose consequence was refused leaves the row pending and says why, quoting the envelope.
  const err = p.payload?.error;
  const failed = err ? `<p class="card-error">Last try refused — ${esc(String(err.message ?? err.code ?? ""))}</p>` : "";
  const refusal = st.refusal ? `<p class="card-error" role="status">${esc(st.refusal)}</p>` : "";
  return `<article class="card${st.stale ? " stale" : ""}" data-card="${attr(p.id)}" aria-labelledby="ask-${attr(p.id)}">` +
    `${headerHtml(p, now)}${stale}<h3 class="card-ask" id="ask-${attr(p.id)}" tabindex="-1">${esc(askOf(p))}</h3>${contextHtml(p)}${failed}${refusal}` +
    `<div class="card-body">${bodyHtml(p, st)}</div>${st.revising ? reviseFormHtml(p) : answersHtml(p, st)}</article>`;
}

/**
 * One line of the compact list: type, title, who is asking, age. The line is
 * a button that opens the card; `data-swipe` names the ways it swipes, and a
 * card with Before and after names none.
 */
export function rowHtml(p, { selecting = false, picked = false, now = Date.now() } = {}) {
  const right = swipeAnswer(p, "right");
  const left = swipeAnswer(p, "left");
  const ways = [right ? "right" : "", left ? "left" : ""].filter(Boolean).join(" ");
  const ask = askOf(p);
  const pick = selecting
    ? `<input type="checkbox" data-pick="${attr(p.id)}" aria-label="${attr(`Select ${ask}`)}"${picked ? " checked" : ""}>`
    : "";
  const under = `<div class="swipe-under" aria-hidden="true"><span class="under-right">${esc(right?.label ?? "")}</span><span class="under-left">${esc(left?.label ?? "")}</span></div>`;
  return `<li class="req-row" data-id="${attr(p.id)}" data-swipe="${ways}">${under}<div class="req-slide">${pick}` +
    `<button type="button" class="req-open" data-act="open" data-id="${attr(p.id)}">` +
    `<span class="req-type">${esc(requestHeading(requestWord(p)))}</span><span class="req-title">${esc(ask)}</span>` +
    `<span class="req-meta">${esc(p.source_agent ?? "")} · ${esc(age(p.ts, now))}</span></button></div></li>`;
}

// ----- the receipt: what an answer did, said once where the card was (components-01 §2.5) -----

const PAST = { Approve: "Approved", Revise: "Revised", Decline: "Declined", Dismiss: "Dismissed", "Send Answers": "Answers sent", "Decline All": "Declined", "Accept All": "Accepted" };
/** The one line an answer leaves behind. Later leaves none: it settled nothing. */
export function receiptText(label, ask, action) {
  if (label === LATER.label) return "";
  const did = PAST[label] ?? `Answered “${label}”`;
  return `${did} — ${ask}${action ? ` · ${actionNote({ ok: true, ...action })}` : ""}`;
}

// ============================================================================
// The view — wired to the DOM when app.js mounts it
// ============================================================================

/** What an answer says while the console cannot be reached (screen 18 §4): it is not offered, and never waits. */
export const OFFLINE_REFUSAL = "Decisions need the connection — nothing was sent.";

/**
 * Mount Needs You on #triage. `ctx` is the shell's: `$`, `api`, `setNeeds`
 * (the bell and the sidebar row — never a tab, P2), `show` (for *Back to
 * Today*) and `offline()` — while it says so, no answer is sent by any way in:
 * a button, a swipe or a key (T7-4). Returns `{ load }`, which the shell calls
 * each time the view or the sheet opens.
 */
export function mountNeedsYou({ $, api, setNeeds, show, offline = () => false }) {
  // From 600px the narrow window shows the list, then pushes the detail (C109); under it the sheet holds the cards.
  const LIST_WIDTH = window.matchMedia("(min-width: 600px)");
  // At 900px it is the Mac's list and detail, side by side, with a request always open.
  const SIDE_BY_SIDE = window.matchMedia("(min-width: 900px)");
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");

  const rows = new Map(); // the rows as painted — an answer reads what the owner was SHOWN
  const seenAt = new Map(); // the `ts` each row was painted with: `if_unchanged` sends it back
  const picked = new Set();
  const stale = new Set();
  const refusals = new Map();
  const busy = new Set();
  const steps = new Map();
  const answers = new Map();
  let revising = null;
  let selecting = false;
  let detail = null;
  let receipt = "";

  const stateOf = (id) => ({
    stale: stale.has(id), refusal: refusals.get(id), busy: busy.has(id), revising: revising === id,
    step: steps.get(id) ?? 0, answers: answers.get(id) ?? [],
  });

  async function load() {
    const res = await api("/api/proposals");
    const { proposals } = await res.json();
    setNeeds(proposals.length); // the bell and the Needs You row — never a tab (P2)
    rows.clear();
    seenAt.clear();
    for (const p of proposals) { rows.set(String(p.id), p); seenAt.set(String(p.id), p.ts); }
    for (const id of [...picked]) if (!rows.has(id)) picked.delete(id); // a row that left the queue leaves the selection
    for (const m of [steps, answers, refusals]) for (const id of [...m.keys()]) if (!rows.has(id)) m.delete(id);
    for (const id of [...stale]) if (!rows.has(id)) stale.delete(id);
    if (detail !== null && !rows.has(detail)) detail = null;
    if (detail === null && SIDE_BY_SIDE.matches && rows.size) detail = groupRows([...rows.values()])[0][1][0].id.toString();
    if (revising !== null && !rows.has(revising)) revising = null;
    paint();
  }

  function paint() {
    const list = [...rows.values()];
    const listMode = selecting || LIST_WIDTH.matches;
    $("triage").dataset.mode = listMode ? "list" : "cards";
    $("triage").classList.toggle("has-detail", detail !== null);
    $("triage-empty").hidden = list.length > 0;
    $("triage-tools").hidden = list.length === 0;
    $("triage-select").textContent = selecting ? "Cancel" : "Select"; // the sheet already has its own Done
    $("triage-select").setAttribute("aria-pressed", String(selecting));
    $("triage-receipt").textContent = receipt;
    receipt = ""; // said once; the record keeps it (runs, and the row's payload.result)
    const now = Date.now();
    $("proposal-list").innerHTML = groupRows(list)
      .map(([word, group]) => `<li class="group-head">${esc(requestHeading(word))} · ${group.length}</li>` +
        group.map((p) => (listMode
          ? rowHtml(p, { selecting, picked: picked.has(String(p.id)), now })
          : `<li class="card-item">${cardHtml(p, stateOf(String(p.id)), now)}</li>`)).join(""))
      .join("");
    const open = detail !== null ? rows.get(detail) : null;
    $("triage-detail").hidden = !open;
    $("triage-detail").innerHTML = open
      ? `<button type="button" class="bar-back detail-back" data-act="close-detail"><svg class="glyph" aria-hidden="true" focusable="false"><use href="#g-back"/></svg>Needs You</button>${cardHtml(open, stateOf(detail), now)}`
      : "";
    renderBatchBar();
  }

  function renderBatchBar() {
    $("triage-batch").hidden = picked.size === 0;
    $("triage-selected").textContent = picked.size ? `${picked.size} selected` : "";
  }

  /**
   * The one decision call. `if_unchanged` rides every single-row answer: the
   * row's `ts` and its subject's fingerprint as painted (T2-14 — the PR's
   * head, the task's line, the work row), so an answer to something that
   * moved while it was on screen is refused and nothing is sent; a 409
   * repaints instead of alerting.
   */
  async function decide(id, body, label) {
    const p = rows.get(id);
    if (!p || busy.has(id)) return;
    if (offline()) { refusals.set(id, OFFLINE_REFUSAL); return paint(); }
    busy.add(id);
    refusals.delete(id);
    stale.delete(id);
    paint();
    let res;
    let out = {};
    try {
      const seen = seenAt.get(id);
      const ifUnchanged = {
        ...(seen ? { seen_at: seen } : {}),
        ...("subject" in p ? { subject: p.subject ? p.subject.fingerprint : null } : {}),
      };
      res = await api(`/api/proposals/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ ...body, ...(Object.keys(ifUnchanged).length ? { if_unchanged: ifUnchanged } : {}) }),
      });
      out = await res.json().catch(() => ({}));
    } catch (e) {
      busy.delete(id);
      refusals.set(id, `Couldn't reach Metistry — nothing was sent (${e?.message ?? e})`);
      return paint();
    }
    busy.delete(id);
    if (res.ok) {
      receipt = receiptText(label, askOf(p), out.action);
      steps.delete(id);
      answers.delete(id);
      if (revising === id) revising = null;
      if (detail === id) detail = null;
    } else if (res.status === 409 && out.reason === "stale") {
      // the row changed, not that someone answered it: repaint, and let the owner read the new version
      stale.add(id);
      revising = null;
    } else if (res.status === 409 && out.reason === "already_decided") {
      receipt = `Already answered elsewhere — ${askOf(p)}`;
    } else {
      refusals.set(id, `Not sent — ${out.error?.message ?? `the console answered ${res.status}`}`);
    }
    await load().catch(() => paint());
  }

  /** One verb, many rows. The server answers per row; anything it refused stays in the queue and says so. */
  async function batchDecide(decision) {
    if (picked.size === 0) return;
    if (offline()) { receipt = OFFLINE_REFUSAL; return paint(); }
    const ids = [...picked].map(Number);
    const res = await api("/api/proposals/batch", { method: "POST", body: JSON.stringify({ ids, decision }) });
    if (res.ok) {
      const { results } = await res.json();
      const failed = results.filter((r) => !r.ok).length;
      if (failed) receipt = `${results.length - failed} of ${results.length} applied — the rest were already answered elsewhere`;
    }
    picked.clear();
    await load();
  }

  const qsOf = (id) => questionsOf(rows.get(id));
  const setAnswer = (id, q, a) => {
    const list = [...(answers.get(id) ?? [])];
    list[q] = a;
    answers.set(id, list);
  };
  /** Focus follows the push: the card's ask when it opens, the step's first control when a question moves. */
  const focusCard = (id, within = ".card-ask") => {
    const card = document.querySelector(`[data-card="${CSS.escape(id)}"]`);
    card?.querySelector(within === ".card-ask" ? within : `${within} input, ${within} button:not([disabled])`)?.focus();
  };

  // ----- one delegated listener for every control the view writes -----
  $("triage").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const id = el.dataset.id;
    const p = id ? rows.get(id) : null;
    const act = el.dataset.act;
    if (act === "today") return show("today");
    if (act === "close-detail") { detail = null; return paint(); }
    if (!p) return;
    const a = answersOf(p);
    if (act === "open") {
      if (Date.now() - swiped < 400) return; // the lift at the end of a swipe is not a tap
      detail = id;
      paint();
      return focusCard(id);
    }
    if (act === "primary") return decide(id, { decision: decisionOf(a.primary) }, a.primary.label);
    if (act === "decline") return decide(id, { decision: decisionOf(a.decline) }, a.decline.label);
    if (act === "later") return decide(id, { decision: LATER.d }, LATER.label);
    if (act === "revise") { revising = id; paint(); return document.querySelector(`.revise-form[data-id="${CSS.escape(id)}"] [name="text"]`)?.focus(); }
    if (act === "revise-cancel") { revising = null; return paint(); }
    const qs = qsOf(id);
    const step = steps.get(id) ?? 0;
    if (act === "choose") {
      // one question, choosing is its answer: it sends
      const option = qs[0]?.options[Number(el.dataset.o)];
      if (option === undefined) return;
      setAnswer(id, 0, choose(qs[0], undefined, option));
      return decide(id, answersBody(qs, answers.get(id)), option);
    }
    if (act === "next") { steps.set(id, nextStep(qs, answers.get(id) ?? [], step)); paint(); return focusCard(id, ".q-steps"); }
    if (act === "back") { steps.set(id, backStep(step)); paint(); return focusCard(id, ".q-steps"); }
    if (act === "edit") { steps.set(id, Number(el.dataset.q)); paint(); return focusCard(id, ".q-steps"); }
    if (act === "send-answers") {
      const given = answers.get(id) ?? [];
      if (!canSend(qs, given)) return;
      return decide(id, answersBody(qs, given), "Send Answers");
    }
  });

  // A choice among inputs changes the answer without repainting under the finger.
  $("triage").addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.pick !== undefined) {
      if (el.checked) picked.add(el.dataset.pick);
      else picked.delete(el.dataset.pick);
      return renderBatchBar();
    }
    if (el.dataset.act !== "pick") return;
    const id = el.dataset.id;
    const qs = qsOf(id);
    const q = qs[Number(el.dataset.q)];
    if (!q) return;
    const current = (answers.get(id) ?? [])[Number(el.dataset.q)];
    setAnswer(id, Number(el.dataset.q), choose(q, current, q.options[Number(el.dataset.o)]));
    if (!q.multi) { const other = el.closest("fieldset")?.querySelector('[data-act="other"]'); if (other) other.value = ""; }
    syncNav(id);
  });

  $("triage").addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.act !== "other") return;
    const id = el.dataset.id;
    const q = qsOf(id)[Number(el.dataset.q)];
    if (!q) return;
    const current = (answers.get(id) ?? [])[Number(el.dataset.q)];
    setAnswer(id, Number(el.dataset.q), writeOther(q, current, el.value));
    if (!q.multi) for (const r of el.closest("fieldset")?.querySelectorAll('input[type="radio"]') ?? []) r.checked = false;
    syncNav(id);
  });

  /** Next and Send Answers follow the answer as it is typed, without a repaint that would take the field away. */
  function syncNav(id) {
    const qs = qsOf(id);
    const given = answers.get(id) ?? [];
    const step = steps.get(id) ?? 0;
    for (const b of document.querySelectorAll(`[data-card="${CSS.escape(id)}"] [data-act="next"], [data-card="${CSS.escape(id)}"] .q-nav [data-act="send-answers"]`)) {
      if (b.dataset.heldOffline !== undefined) continue; // held by the shell while offline (T7-4)
      b.disabled = !isAnswered(qs[step], given[step]);
    }
  }

  $("triage").addEventListener("submit", (e) => {
    const form = e.target.closest(".revise-form");
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.id;
    const p = rows.get(id);
    const a = p && answersOf(p).revise;
    const words = String(form.elements.text?.value ?? "").trim();
    if (!p || !a) return;
    if (!words) { revising = null; return paint(); } // an empty reason cancels rather than sends
    decide(id, { decision: decisionOf(a), ...(a.carries === "area" ? { area: words } : { feedback: words }) }, a.label);
  });

  $("triage-select").onclick = () => {
    selecting = !selecting;
    if (!selecting) picked.clear();
    paint();
  };
  $("triage-later").onclick = () => batchDecide("later");
  $("triage-skip").onclick = () => batchDecide("skip");
  $("triage-clear").onclick = () => { picked.clear(); paint(); };
  LIST_WIDTH.addEventListener("change", () => { if (rows.size) paint(); });

  // `l` and `s` over the selection. Never while typing — a shortcut that fires
  // from inside a text field is a bug, not an affordance.
  document.addEventListener("keydown", (e) => {
    if ($("triage").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
    if (e.key === "l") { e.preventDefault(); batchDecide("later"); }
    if (e.key === "s") { e.preventDefault(); batchDecide("skip"); }
  });

  // ----- swipe: right approves, left declines, on the compact list (screen 18 §3) -----
  // Touch and pen only — a pointer has the buttons, and a drag that answers a
  // request by accident is the one mistake this view exists to prevent. The
  // row follows the finger; a swipe a row does not take barely moves; Reduce
  // Motion releases without the slide (plan §2.18).
  let drag = null;
  let swiped = 0; // when the last swipe let go: the click that follows it is not a tap
  $("proposal-list").addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    const li = e.target.closest(".req-row");
    if (!li || e.target.closest('input[type="checkbox"]')) return;
    drag = { li, id: li.dataset.id, x: e.clientX, y: e.clientY, dx: 0, pointer: e.pointerId, moved: false };
  });
  $("proposal-list").addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y) > Math.abs(dx)) { drag = null; return; } // a scroll, not a swipe
      if (Math.abs(dx) < 8) return;
      drag.moved = true;
      drag.li.setPointerCapture?.(drag.pointer);
    }
    const p = rows.get(drag.id);
    const way = dx > 0 ? "right" : "left";
    drag.dx = swipeAnswer(p, way) ? dx : Math.sign(dx) * Math.min(Math.abs(dx), 16); // resists a way it does not go
    drag.li.dataset.dir = swipeAnswer(p, way) ? way : "";
    drag.li.querySelector(".req-slide").style.transform = `translateX(${drag.dx}px)`;
  });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const { li, id, dx, moved } = drag;
    drag = null;
    if (!moved) return; // a tap: the button's click opens the card
    swiped = Date.now();
    const slide = li.querySelector(".req-slide");
    const got = swipeResult(rows.get(id), dx, li.clientWidth);
    if (!got) {
      slide.style.transform = "";
      li.dataset.dir = "";
      return;
    }
    if (!REDUCED.matches) slide.style.transform = `translateX(${got.dir === "right" ? "" : "-"}100%)`;
    decide(id, { decision: decisionOf(got.answer) }, got.answer.label);
  };
  $("proposal-list").addEventListener("pointerup", release);
  $("proposal-list").addEventListener("pointercancel", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.li.querySelector(".req-slide").style.transform = "";
    drag.li.dataset.dir = "";
    drag = null;
  });

  return { load };
}
