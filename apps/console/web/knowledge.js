// Knowledge — where the owner reads what the system learned (screen 18 §5;
// screen 10). T7-3b replaced the tab's "not here yet" line with it.
//
// It opens on **the fold**, then **Needs Your Eye**, then **Areas** — the Mac's
// order, as rows — with a search field above them. An area pushes its pages;
// a page pushes its note, read, with the pages it links to and the pages that
// link to it. Nothing here writes: a draft is decided in Needs You (screen 10
// §3.1), and the vault is edited in Obsidian.
//
// Where it reads: T1-6's three owner-only routes (`GET /api/knowledge/fold`,
// `drafts`, `areas`) and the vault read path (`search`, `pages`, `page`,
// `links`). A note body is the bridge's, rendered by md.js — escape first,
// whitelisted tags only (CRIT-7); every other value goes through esc()/attr().

import { ago, attr, dateTime, esc, glyph } from "./lib.js";
import { renderMarkdown } from "./md.js";

// ============================================================================
// Pure — a test drives each with the recorded fixture
// ============================================================================

/** A path's last segment without `.md`: what a row says when the index has no title. */
export const baseName = (path) => String(path ?? "").split("/").pop().replace(/\.md$/i, "");

const pageRow = (path, title, sub, { chev = true } = {}) =>
  `<li><button type="button" class="row" data-act="page" data-path="${attr(path)}"><span class="label">${esc(title || baseName(path))}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span>${chev ? glyph("chevron", "chev") : ""}</button></li>`;

/**
 * The fold: the note the knowledge fold wrote last night, in its own words
 * when opened; here its title, its date and path, and the pages it named. A
 * link to a page not written yet is shown as such — never dropped, never a
 * door to nowhere.
 */
export function foldHtml(body) {
  const f = body?.fold;
  if (!f) return `<p class="muted">No fold yet — the knowledge fold writes one each night, from what came in that day.</p>`;
  const links = (f.links ?? []).map((l) => l.resolved
    ? pageRow(l.path, l.title, l.path)
    : `<li><span class="row static"><span class="label">${esc(l.title || baseName(l.path))}<span class="sub">not written yet · ${esc(l.path)}</span></span></span></li>`).join("");
  return `<div class="fold-card agent-wash"><p class="eyebrow">The Fold · ${esc(f.date ?? "")}</p>` +
    `<p class="fold-title">${esc(f.title || baseName(f.path))}</p><p class="mono muted">${esc(f.path)}</p>` +
    `<p><button type="button" class="secondary" data-act="page" data-path="${attr(f.path)}">Open the Fold</button></p></div>` +
    (links ? `<h3>Named in It</h3><ul class="group">${links}</ul>` : "");
}

/**
 * Needs Your Eye: every draft waiting on the owner, one row each — what it is,
 * which page, why it is here. The count sits in the heading and nowhere else
 * (P2: the one badge is Needs You's, and these are already requests there).
 */
export function eyeHtml(body) {
  const drafts = body?.drafts ?? [];
  const head = `<h3>Needs Your Eye${drafts.length ? ` · ${drafts.length}` : ""}</h3>`;
  if (!drafts.length) return `${head}<p class="muted">Nothing here is waiting on you.</p>`;
  return `${head}<ul class="group">${drafts.map((d) => pageRow(d.path, `Draft · ${d.title || baseName(d.path)}`, d.description || d.area || d.path)).join("")}</ul>` +
    `<p class="muted foot">Approve or decline a draft in Needs You; open it here to read it first.</p>`;
}

/** Areas: each with its written line, or how many pages it holds until something writes one (C68). */
export function areasHtml(body) {
  const areas = body?.areas ?? [];
  if (!areas.length) return `<h3>Areas</h3><p class="muted">No areas yet — they appear as the vault fills.</p>`;
  return `<h3>Areas</h3><ul class="group">${areas.map((a) => {
    const n = Number(a.pages) || 0;
    const sub = a.description || `${n} ${n === 1 ? "page" : "pages"}${a.last_change ? ` · changed ${ago(a.last_change)}` : ""}`;
    return `<li><button type="button" class="row" data-act="area" data-area="${attr(a.area)}"><span class="label">${esc(a.area)}${a.named_by_fold ? ` <span class="chip">in the fold</span>` : ""}<span class="sub">${esc(sub)}</span></span>${glyph("chevron", "chev")}</button></li>`;
  }).join("")}</ul>`;
}

/** Search hits, or the plain sentence that nothing matched; a degraded search says so (P5). */
export function searchHtml(body) {
  const hits = body?.hits ?? [];
  const degraded = body?.degraded ? `<p class="muted degraded-note">${esc(body.degraded)}</p>` : "";
  if (!hits.length) return `${degraded}<p class="empty">Nothing matches “${esc(body?.q ?? "")}”.</p>`;
  return `${degraded}<ul class="group">${hits.map((h) => pageRow(h.path, h.title, h.snippet || h.description || h.path)).join("")}</ul>`;
}

/** An area's pages. */
export function pagesHtml(body) {
  const pages = body?.pages ?? [];
  if (!pages.length) return `<p class="muted">No settled pages here yet.</p>`;
  return `<ul class="group">${pages.map((p) => pageRow(p.path, p.title, p.description || p.path)).join("")}</ul>`;
}

/** A page's links, both ways; an unresolved one is a note not written yet — shown, the way Obsidian shows it. */
export function linksHtml(body) {
  const links = body?.links ?? [];
  const part = (dir, head) => {
    const ls = links.filter((l) => l.direction === dir);
    if (!ls.length) return "";
    return `<h3>${head}</h3><ul class="group">${ls.map((l) => l.resolved
      ? pageRow(l.path, l.title, l.description || l.path)
      : `<li><span class="row static"><span class="label">${esc(l.title || baseName(l.path))}<span class="sub">not written yet</span></span></span></li>`).join("")}</ul>`;
  };
  return part("outgoing", "Links From Here") + part("incoming", "Links Here");
}

/** Whether a page is the assistant's own prose — the fold — which reads on the agent wash, in the serif (screen 10 §2). */
export const isFold = (path) => /^Journal\/Fold\//.test(String(path ?? ""));

// ============================================================================
// The view — wired to the DOM when app.js mounts it
// ============================================================================

export function mountKnowledge({ $, api, show, retitle = () => {} }) {
  const read = async (path) => {
    const res = await api(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `the console answered ${res.status}`), { status: res.status });
    return body;
  };
  const failedHtml = (what, e) => `<div class="panel-state failed"><p class="state-title">Couldn't read ${esc(what)}</p><p class="mono reason">${esc(e?.message ?? e)}</p></div>`;

  let area = null;
  let page = null; // { path, from: "knowledge" | "area" }

  /** The tab: the fold, then Needs Your Eye, then Areas — each on its own, so one missing never blanks the others. */
  async function load() {
    for (const id of ["kn-fold", "kn-eye", "kn-areas"]) if (!$(id).innerHTML) $(id).innerHTML = `<p class="muted">Reading your vault…</p>`;
    await Promise.all([
      read("/api/knowledge/fold").then((b) => { $("kn-fold").innerHTML = foldHtml(b); }, (e) => { $("kn-fold").innerHTML = failedHtml("the fold", e); }),
      read("/api/knowledge/drafts?limit=20").then((b) => { $("kn-eye").innerHTML = eyeHtml(b); }, (e) => { $("kn-eye").innerHTML = failedHtml("the drafts", e); }),
      read("/api/knowledge/areas").then((b) => { $("kn-areas").innerHTML = areasHtml(b); }, (e) => { $("kn-areas").innerHTML = failedHtml("the areas", e); }),
    ]);
  }

  async function search(q) {
    const on = q.length > 0;
    $("kn-results").hidden = !on;
    $("kn-clear").hidden = !on;
    for (const id of ["kn-fold", "kn-eye", "kn-areas"]) $(id).hidden = on;
    if (!on) return;
    $("kn-results").innerHTML = `<p class="muted">Searching…</p>`;
    try {
      $("kn-results").innerHTML = searchHtml(await read(`/api/knowledge/search?${new URLSearchParams({ q })}`));
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      $("kn-results").innerHTML = failedHtml("the vault", e);
    }
  }

  $("kn-search").addEventListener("submit", (e) => { e.preventDefault(); search(String($("kn-q").value ?? "").trim()); });
  $("kn-clear").addEventListener("click", () => { $("kn-q").value = ""; search(""); });

  function openPage(path, from) {
    page = { path, from };
    show("page", { title: baseName(path), back: from });
  }

  for (const id of ["knowledge", "area", "page"]) {
    $(id).addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el || el.disabled) return;
      // a page opened from a page goes back where that one would: its area, or the tab
      if (el.dataset.act === "page") return openPage(el.dataset.path, id === "knowledge" ? "knowledge" : id === "area" ? "area" : page?.from ?? "knowledge");
      if (el.dataset.act === "area") { area = el.dataset.area; return show("area", { title: area }); }
    });
  }

  async function loadArea() {
    if (!area) return show("knowledge");
    retitle(area); // back from a page, the area is still named
    $("area-pages").innerHTML = `<p class="muted">Reading your vault…</p>`;
    try {
      $("area-pages").innerHTML = pagesHtml(await read(`/api/knowledge/pages?${new URLSearchParams({ area, limit: "200" })}`));
    } catch (e) {
      if (e?.message === "unauthenticated") throw e;
      $("area-pages").innerHTML = failedHtml(area, e);
    }
  }

  async function loadPage() {
    if (!page) return show("knowledge");
    const { path } = page;
    retitle(baseName(path));
    $("page-meta").textContent = path;
    $("page-body").className = `page-body art-md${isFold(path) ? " agent-prose agent-wash" : ""}`;
    $("page-body").innerHTML = `<p class="muted">Opening ${esc(baseName(path))}…</p>`;
    $("page-links").innerHTML = "";
    const [note, links] = await Promise.allSettled([
      read(`/api/knowledge/page?${new URLSearchParams({ path })}`),
      read(`/api/knowledge/links?${new URLSearchParams({ path })}`),
    ]);
    if (note.status === "fulfilled") {
      $("page-body").innerHTML = renderMarkdown(note.value.content ?? ""); // md.js escapes FIRST; only its own tags come out
      const h1 = /^#\s+(.+)$/m.exec(note.value.content ?? "");
      if (h1) retitle(h1[1].trim());
      $("page-meta").textContent = `${path}${note.value.as_of ? ` · read ${dateTime(note.value.as_of)}` : ""}`;
    } else {
      $("page-body").innerHTML = note.reason?.status === 404 ? `<p class="empty">This page isn't there any more.</p>` : failedHtml("this page", note.reason);
    }
    $("page-links").innerHTML = links.status === "fulfilled" ? linksHtml(links.value) : "";
  }

  return { knowledge: load, area: loadArea, page: loadPage, search };
}
