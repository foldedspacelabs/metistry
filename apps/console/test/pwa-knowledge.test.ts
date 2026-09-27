// T7-3b — Knowledge in the PWA (screen 18 §5; screen 10; design-build-plan
// §2.10, §2.17): the tab opens on the fold, then Needs Your Eye, then Areas,
// with search above them; an area pushes its pages, a page its note and links.
// Nothing here writes.
//
// Built first against the recorded contract (U9): T1-6's fold, drafts and
// areas, and the vault read path's search, pages, page and links fixtures.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areasHtml, baseName, eyeHtml, foldHtml, isFold, linksHtml, mountKnowledge, pagesHtml, searchHtml } from "../web/knowledge.js";
import { control, fakeBrowser, type Call } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const fixture = (name: string) => JSON.parse(read(`../../macos/tests/kit/fixtures/${name}.json`)) as { request: { path: string }; body: Record<string, unknown> };
const F = {
  fold: fixture("get-api-knowledge-fold"),
  drafts: fixture("get-api-knowledge-drafts"),
  areas: fixture("get-api-knowledge-areas"),
  search: fixture("get-api-knowledge-search"),
  pages: fixture("get-api-knowledge-pages"),
  page: fixture("get-api-knowledge-page"),
  links: fixture("get-api-knowledge-links"),
};
const SRC = read("../web/knowledge.js");

afterEach(() => vi.unstubAllGlobals());

function recorded(c: Call): { status?: number; body: unknown } {
  const route = c.path.split("?")[0]!.replace("/api/knowledge/", "") as keyof typeof F;
  return F[route] ? { body: F[route].body } : { status: 404, body: { error: { code: "not_found", message: "no such page" } } };
}

describe("Knowledge opens on the fold, then Needs Your Eye, then Areas (screen 18 §5)", () => {
  it("reads T1-6's three owner-only routes and the vault read path — the fixtures are their contract", () => {
    for (const [name, f] of Object.entries(F)) expect(f.request.path, name).toMatch(new RegExp(`^/api/knowledge/${name}`));
    for (const path of ['read("/api/knowledge/fold")', 'read("/api/knowledge/drafts?limit=20")', 'read("/api/knowledge/areas")']) expect(SRC).toContain(path);
    // nothing on this tab writes
    expect(SRC).not.toMatch(/method: "(POST|PUT|PATCH|DELETE)"/);
  });

  it("the tab is three parts in that order, below search", () => {
    const html = read("../web/index.html");
    const section = /<section id="knowledge" hidden>[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    const order = ["kn-search", "kn-results", "kn-fold", "kn-eye", "kn-areas"].map((id) => section.indexOf(`id="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("Knowledge isn’t in this app yet"); // T7-2's placeholder is gone
  });

  it("mounted: each part paints from its own route", async () => {
    const b = fakeBrowser({ respond: recorded });
    const view = mountKnowledge({ $: b.$, api: b.api, show: () => {} });
    await view.knowledge();
    expect(b.$("kn-fold").innerHTML).toContain("Fold — 28 September");
    expect(b.$("kn-eye").innerHTML).toContain("<h3>Needs Your Eye · 1</h3>");
    expect(b.$("kn-areas").innerHTML).toContain("Sleep, labs, and the protein blend");
    expect(b.writes()).toEqual([]);
  });

  it("one route failing never blanks the others", async () => {
    const b = fakeBrowser({ respond: (c) => (c.path.startsWith("/api/knowledge/drafts") ? { status: 503, body: { error: { code: "unavailable", message: "the named query knowledge_drafts is not loaded" } } } : recorded(c)) });
    const view = mountKnowledge({ $: b.$, api: b.api, show: () => {} });
    await view.knowledge();
    expect(b.$("kn-eye").innerHTML).toContain("Couldn't read the drafts");
    expect(b.$("kn-eye").innerHTML).toContain("knowledge_drafts is not loaded");
    expect(b.$("kn-fold").innerHTML).toContain("Open the Fold");
    expect(b.$("kn-areas").innerHTML).toContain("Areas/Health");
  });
});

describe("the fold", () => {
  it("title, date and path, Open the Fold, and the pages it named", () => {
    const html = foldHtml(F.fold.body);
    expect(html).toContain('<p class="eyebrow">The Fold · 2026-09-28</p>');
    expect(html).toContain('data-act="page" data-path="Journal/Fold/2026-09-28.md">Open the Fold</button>');
    expect(html).toContain('data-path="Projects/Metistry/Roadmap.md"');
  });

  it("before the first fold, says so", () => {
    expect(foldHtml({ fold: null, date: null })).toContain("No fold yet");
  });

  it("a link to a page not written yet is shown as one — never a door to nowhere", () => {
    const html = foldHtml({ fold: { ...(F.fold.body.fold as object), links: [{ path: "Areas/Health/Labs.md", title: "Labs", kind: "wikilink", resolved: false }] } });
    expect(html).toContain("not written yet");
    expect(html).not.toContain('data-path="Areas/Health/Labs.md"');
  });

  it("the fold is the assistant's prose: read on the agent wash, in the serif", () => {
    expect(isFold("Journal/Fold/2026-09-28.md")).toBe(true);
    expect(isFold("Areas/Health/Sleep.md")).toBe(false);
    expect(SRC).toContain('isFold(path) ? " agent-prose agent-wash" : ""');
  });
});

describe("Needs Your Eye and Areas", () => {
  it("each draft is a row: what it is, which page, why it is here — the count in the heading, never a badge (P2)", () => {
    const html = eyeHtml(F.drafts.body);
    expect(html).toContain('data-path="Areas/Health/Sleep.md"><span class="label">Draft · Sleep<span class="sub">the taper</span>');
    expect(html).not.toContain("badge");
    expect(eyeHtml({ drafts: [] })).toContain("Nothing here is waiting on you.");
  });

  it("an area says its written line, or how many pages until something writes one", () => {
    const html = areasHtml(F.areas.body);
    expect(html).toContain("Sleep, labs, and the protein blend");
    expect(html).toMatch(/Journal<span class="sub">1 page · changed (\d+[mhd] ago|just now)/);
    expect(html).toContain('data-act="area" data-area="Projects"');
    expect(html).toContain('<span class="chip">in the fold</span>'); // provenance, never a score (P5)
  });

  it("an area pushes its pages; a page pushes its note, with the way back it came", async () => {
    const b = fakeBrowser({ respond: recorded });
    const shown: unknown[] = [];
    const view = mountKnowledge({ $: b.$, api: b.api, show: (v: string, o: unknown) => { shown.push([v, o]); }, retitle: (t: string) => { shown.push(["retitle", t]); } });
    await view.knowledge();
    await b.$("knowledge").fire("click", { target: control({ act: "area", area: "Projects" }) });
    expect(shown.at(-1)).toEqual(["area", { title: "Projects" }]);
    await view.area();
    expect(b.calls.at(-1)!.path).toBe("/api/knowledge/pages?area=Projects&limit=200");
    expect(b.$("area-pages").innerHTML).toContain('data-path="Projects/Metistry/Roadmap.md"');
    await b.$("area").fire("click", { target: control({ act: "page", path: "Projects/Metistry/Roadmap.md" }) });
    expect(shown.at(-1)).toEqual(["page", { title: "Roadmap", back: "area" }]);
    await view.page();
    expect(b.$("page-body").innerHTML).toContain("<h1>Roadmap</h1>");
    expect(b.$("page-body").innerHTML).toContain('<span class="wikilink" title="Projects/Metistry/Design">Projects/Metistry/Design</span>');
    expect(shown).toContainEqual(["retitle", "Roadmap"]);
    // a page opened from the tab goes back to the tab
    await b.$("knowledge").fire("click", { target: control({ act: "page", path: "Areas/Health/Sleep.md" }) });
    expect(shown.at(-1)).toEqual(["page", { title: "Sleep", back: "knowledge" }]);
  });

  it("a page's links, both ways; a missing page is said plainly", async () => {
    expect(pagesHtml({ pages: [] })).toContain("No settled pages here yet.");
    const links = linksHtml(F.links.body);
    expect(links).toMatch(/<h3>Links (From )?Here<\/h3>/);
    const b = fakeBrowser({ respond: (c) => (c.path.startsWith("/api/knowledge/page?") ? { status: 404, body: { error: { code: "not_found", message: "no such page" } } } : recorded(c)) });
    const view = mountKnowledge({ $: b.$, api: b.api, show: () => {} });
    await b.$("knowledge").fire("click", { target: control({ act: "page", path: "Areas/Gone.md" }) });
    await view.page();
    expect(b.$("page-body").innerHTML).toContain("This page isn't there any more.");
  });
});

describe("search", () => {
  it("hits as rows; a degraded search says so (P5); no hit is the plain sentence", () => {
    const html = searchHtml(F.search.body);
    expect(html).toContain("keyword only — the embedder is down");
    expect(html).toContain("…Ship the store interface, then the stores…");
    expect(searchHtml({ q: "zebra", hits: [] })).toContain("Nothing matches “zebra”.");
    expect(searchHtml({ q: "<b>", hits: [] })).not.toContain("<b>");
  });

  it("mounted: a query replaces the three parts until it is cleared", async () => {
    const b = fakeBrowser({ respond: recorded });
    const view = mountKnowledge({ $: b.$, api: b.api, show: () => {} });
    b.$("kn-q").value = "store";
    await b.$("kn-search").fire("submit", { preventDefault() {} });
    expect(b.calls.at(-1)!.path).toBe("/api/knowledge/search?q=store");
    expect(b.$("kn-results").hidden).toBe(false);
    expect(b.$("kn-fold").hidden).toBe(true);
    await b.$("kn-clear").fire("click", {});
    expect(b.$("kn-results").hidden).toBe(true);
    expect(b.$("kn-fold").hidden).toBe(false);
    expect(view.search).toBeTypeOf("function");
  });

  it("a note's markup is md.js's — escaped first; a basename is the fallback title", () => {
    expect(SRC).toContain("renderMarkdown(note.value.content");
    expect(baseName("Areas/Health/Sleep.md")).toBe("Sleep");
    expect(pagesHtml({ pages: [{ path: "a/<x>.md", title: null }] })).not.toContain("<x>");
  });
});
