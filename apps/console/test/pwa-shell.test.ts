// T7-2 — the PWA's shell (screen 18 §1; design-build-plan §2.17): five tabs,
// + and the bell in the header, sheets, the 600–899px and 900px layouts, and
// glyphs where the emoji were. The three things the ticket names are held
// here: five tabs, no badge on a tab, and the bell carries the count.
//
// apps/console/web is a browser app with no DOM harness here (and none is
// added), so, as in pwa-reads.test.ts and composer.test.ts, the pure top-level
// declarations are lifted out of app.js by name and evaluated, and the markup
// is read from index.html itself. A rename makes a lift throw rather than
// letting a test pass vacuously.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = read("../web/app.js");
// Needs You's own file since T7-3a: it is what reads the queue and hands the shell the count
const NEEDS_YOU = read("../web/needs-you.js");
// the markup without its comments, which talk about the hooks they sit beside
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");
const CSS = read("../web/style.css");

/** Lift a top-level `const NAME = …`, `let NAME = …` or `[async] function NAME(…) {…}` out of app.js. */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:const|let) ${name}\\b|^(?:async )?function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`app.js no longer declares ${name} — update this test with the rename`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`could not find the end of ${name} in app.js`);
}

/** One element of index.html by id, open tag to its own close tag (no nesting of the same tag inside). */
function element(tag: string, id: string): string {
  const m = new RegExp(`<${tag} id="${id}"[\\s\\S]*?</${tag}>`).exec(HTML);
  if (!m) throw new Error(`index.html has no <${tag} id="${id}">`);
  return m[0];
}

const TAB_BAR = element("nav", "tabs");
const HEADER = element("header", "bar");
const SIDEBAR = element("nav", "sidebar");
const MORE = element("section", "more");

interface View { tab: string | null; title: string; sections: string[]; back?: string; segment?: boolean; sheet?: "always" | "narrow" }
const shell = new Function(
  `${["TABS", "HOME", "VIEWS", "SECTIONS", "lastWork", "resolveView", "inSheet", "backFor"].map(lift).join("\n")}
   return { TABS, HOME, VIEWS, SECTIONS, resolveView, inSheet, backFor };`,
)() as {
  TABS: string[];
  HOME: string;
  VIEWS: Record<string, View>;
  SECTIONS: string[];
  resolveView: (v: string) => string;
  inSheet: (v: View, wide: boolean) => boolean;
  backFor: (v: View, wide: boolean) => string | null;
};

const EMOJI = /\p{Extended_Pictographic}/u;
const labelOf = (button: string) => /<span class="label">([^<]*)<\/span>/.exec(button)?.[1] ?? button.replace(/<[^>]*>/g, "").trim();

// ---------------------------------------------------------------------------
// Five tabs
// ---------------------------------------------------------------------------

describe("five tabs — Today · Chat · Work · Knowledge · More (ruled 2026-09-24)", () => {
  const buttons = [...TAB_BAR.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

  it("the tab bar holds exactly five, in that order, and nothing else", () => {
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => /data-tab="([^"]+)"/.exec(b)?.[1])).toEqual(["today", "chat", "work", "knowledge", "more"]);
    expect(buttons.map(labelOf)).toEqual(["Today", "Chat", "Work", "Knowledge", "More"]);
    expect(shell.TABS).toEqual(["today", "chat", "work", "knowledge", "more"]);
  });

  it("each tab opens a view of its own tab — Work returns to the child left open, Board first", () => {
    for (const tab of shell.TABS) expect(shell.VIEWS[shell.resolveView(tab)]!.tab, tab).toBe(tab);
    expect(shell.resolveView("work")).toBe("board");
    expect(shell.HOME).toBe("today");
  });

  it("every view belongs to one of the five, or arrives in the sheet", () => {
    for (const [name, v] of Object.entries(shell.VIEWS)) {
      if (v.tab === null) expect(v.sheet, `${name} has no tab and is not a sheet`).toBeDefined();
      else expect(shell.TABS, name).toContain(v.tab);
    }
  });

  it("Work's children are Board · Projects · Artifacts, and there is no Rooms to go to (C89)", () => {
    const seg = element("div", "work-seg");
    expect([...seg.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1])).toEqual(["board", "projects", "artifacts"]);
    expect(HTML).not.toContain('data-view="rooms"');
    // a room is still a push — from its card, which is a push from the Board (C84, T7-3b)
    expect(shell.VIEWS.rooms).toMatchObject({ tab: "work", back: "card" });
    expect(shell.VIEWS.card).toMatchObject({ tab: "work", back: "board" });
  });

  it("More holds Activity and Agents, then Usage and Settings, in the Mac's order", () => {
    expect([...MORE.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1])).toEqual(["feed", "agents", "usage", "settings"]);
    // …and, last, the install row (T7-5, screen 18 §6) — no view of its own: the iPhone sheet or the browser's prompt
    expect([...MORE.matchAll(/<span class="label"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Activity", "Agents", "Usage", "Settings", "Install Metistry"]);
    expect(MORE).toMatch(/<ul id="install-group" class="group" hidden>/);
    // every More row is a push back to More — except Usage, which is a sheet
    for (const v of ["feed", "agents", "settings"]) expect(shell.VIEWS[v]!.back, v).toBe("more");
    expect(shell.VIEWS.usage!.sheet).toBe("always");
  });

  it("the feed is called Activity (N1); its hooks keep the id `feed`", () => {
    expect(shell.VIEWS.feed!.title).toBe("Activity");
    expect(HTML).not.toMatch(/>Feed</);
  });

  it("every door in the markup opens a view that exists, onto sections that exist", () => {
    for (const m of HTML.matchAll(/data-view="([^"]+)"/g)) {
      expect(m[1] === "work" || Object.hasOwn(shell.VIEWS, m[1]!), m[1]).toBe(true);
    }
    for (const id of shell.SECTIONS) expect(HTML, id).toContain(`<section id="${id}" hidden>`);
  });
});

// ---------------------------------------------------------------------------
// No badge on a tab; the bell carries the count
// ---------------------------------------------------------------------------

/** Where each [data-needs-count] in index.html lives: the id of the button around it. */
const COUNT_HOMES = [...HTML.matchAll(/data-needs-count/g)].map((m) => {
  const before = HTML.slice(0, m.index);
  const button = before.slice(before.lastIndexOf("<button"));
  return {
    button: /id="([^"]+)"/.exec(button)?.[1] ?? "(no id)",
    inTabs: before.lastIndexOf('<nav id="tabs"') > before.lastIndexOf("</nav>"),
  };
});

interface FakeEl { id: string; textContent: string; hidden: boolean; attrs: Record<string, string>; setAttribute(k: string, v: string): void }
const fakeEl = (id: string, hidden = false): FakeEl => ({
  id, textContent: "", hidden, attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; },
});

/** paintNeeds / setNeeds against a document made of index.html's own count elements. */
function counter() {
  const badges = COUNT_HOMES.map((h) => fakeEl(h.button, true));
  const byId: Record<string, FakeEl> = { bell: fakeEl("bell"), "side-needs": fakeEl("side-needs", true), "needs-announce": fakeEl("needs-announce") };
  const document = { querySelectorAll: (sel: string) => (sel === "[data-needs-count]" ? badges : []) };
  const $ = (id: string) => byId[id] ?? (() => { throw new Error(`no fake for #${id}`); })();
  const api = new Function(
    "document",
    "$",
    `let current = "today"; let sheetView = null;
     const notify = { needs() {} }; // the notifications ask (notify.js, T7-5) — pwa-notify.test.ts holds it
     ${["needsCount", "needsBadge", "paintNeeds", "setNeeds"].map(lift).join("\n")}
     return { setNeeds, paintNeeds, needsBadge, at(v) { current = v; }, sheet(v) { sheetView = v; } };`,
  )(document, $) as {
    setNeeds: (n: unknown) => void;
    paintNeeds: (navigating?: boolean) => void;
    needsBadge: (n: unknown) => { n: number; text: string; label: string };
    at: (v: string) => void;
    sheet: (v: string | null) => void;
  };
  const badgeOn = (home: string) => badges.find((b) => b.id === home)!;
  return { ...api, badges, badgeOn, byId };
}

describe("no badge on a tab (P2)", () => {
  it("the tab bar has no count, no badge and no number in it", () => {
    expect(TAB_BAR).not.toContain("data-needs-count");
    expect(TAB_BAR).not.toMatch(/class="[^"]*badge/);
    expect(TAB_BAR.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]*>/g, "")).not.toMatch(/\d/);
    expect(COUNT_HOMES.some((h) => h.inTabs)).toBe(false);
  });

  it("the count has exactly two homes: the bell, and the Needs You row the Mac layout shows instead", () => {
    expect(COUNT_HOMES.map((h) => h.button).sort()).toEqual(["bell", "side-needs"]);
  });

  it("a count arriving touches only those two — never a tab's label", () => {
    const c = counter();
    c.setNeeds(4);
    for (const b of c.badges) expect(["bell", "side-needs"]).toContain(b.id);
    expect(c.badges.every((b) => b.textContent === "4" && !b.hidden)).toBe(true);
    // the old strip wrote "Needs You (4)" into its triage button; nothing writes into a tab now
    for (const src of [SRC, NEEDS_YOU]) {
      expect(src).not.toMatch(/Needs You \(\$\{/);
      expect(src).not.toMatch(/#tabs[^\n]*(textContent|innerHTML)/);
    }
    expect(NEEDS_YOU).toContain("setNeeds(proposals.length); // the bell and the Needs You row — never a tab (P2)");
    expect(SRC).toContain("mountNeedsYou({ $, api, setNeeds, show, offline: isOffline })");
  });

  it("no stylesheet draws one either", () => {
    expect(CSS).not.toMatch(/#tabs[^{]*::(before|after)/);
    expect(CSS).not.toMatch(/\[data-tab[^{]*::(before|after)/);
  });
});

describe("the bell carries the count", () => {
  it("the bell is in the header, with the count inside it", () => {
    const bell = /<button id="bell"[\s\S]*?<\/button>/.exec(HEADER)?.[0] ?? "";
    expect(bell).toContain("data-needs-count");
    expect(bell).toContain('aria-label="Needs You"');
    expect(bell).toContain('href="#g-bell"');
  });

  it("says the number, and says it in words to VoiceOver (components-02 §3)", () => {
    const { needsBadge } = counter();
    expect(needsBadge(0)).toEqual({ n: 0, text: "", label: "Needs You" });
    expect(needsBadge(3)).toEqual({ n: 3, text: "3", label: "Needs You, 3 waiting" });
    expect(needsBadge("12")).toMatchObject({ n: 12, text: "12" });
    for (const junk of [undefined, null, "x", -2, Number.NaN]) expect(needsBadge(junk).n).toBe(0);
  });

  it("paints the count on the bell, and takes it away at zero", () => {
    const c = counter();
    c.setNeeds(3);
    expect(c.badgeOn("bell")).toMatchObject({ textContent: "3", hidden: false });
    expect(c.byId.bell!.attrs["aria-label"]).toBe("Needs You, 3 waiting");
    c.setNeeds(0);
    expect(c.badgeOn("bell")).toMatchObject({ textContent: "", hidden: true });
    expect(c.byId.bell!.attrs["aria-label"]).toBe("Needs You");
  });

  it("the count comes from T1-7's own route, not a fetch of the whole queue", async () => {
    let got: unknown;
    const api = async (path: string) => {
      expect(path).toBe("/api/needs-you/count");
      return { json: async () => ({ waiting: 3, oldest_ts: "2026-09-27T00:00:00.000Z", as_of: "2026-09-27T00:00:05.000Z" }) };
    };
    const refreshNeeds = new Function("api", "setNeeds", `${lift("refreshNeeds")}\nreturn refreshNeeds;`)(api, (n: unknown) => { got = n; });
    await refreshNeeds();
    expect(got).toBe(3);
  });

  it("at 900px the Needs You row carries it instead: there while something waits, gone on the next navigation after zero, never while the owner is on it (C110)", () => {
    const c = counter();
    const row = c.byId["side-needs"]!;
    expect(row.hidden).toBe(true); // nothing has arrived: the sidebar is its own rows
    c.setNeeds(2);
    expect(row.hidden).toBe(false);
    expect(c.badgeOn("side-needs").textContent).toBe("2");
    expect(row.attrs["aria-label"]).toBe("Needs You, 2 waiting");
    c.at("triage");
    c.setNeeds(0);
    c.paintNeeds(true); // a navigation while still on it
    expect(row.hidden).toBe(false);
    c.at("today");
    c.setNeeds(0); // a count alone does not pull it out from under the pointer
    expect(row.hidden).toBe(false);
    c.paintNeeds(true); // the next navigation does
    expect(row.hidden).toBe(true);
  });

  it("announces a change once, and not while the owner is on it", () => {
    const c = counter();
    const said = c.byId["needs-announce"]!;
    c.setNeeds(2);
    expect(said.textContent).toBe(""); // the first answer is the state, not a change
    c.setNeeds(3);
    expect(said.textContent).toBe("Needs You, 3 waiting");
    said.textContent = "";
    c.setNeeds(3);
    expect(said.textContent).toBe(""); // the same count is not news
    c.sheet("triage");
    c.setNeeds(4);
    expect(said.textContent).toBe(""); // the owner is looking at it
    c.sheet(null);
    c.at("triage");
    c.setNeeds(5);
    expect(said.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The header, the sheets and the three widths
// ---------------------------------------------------------------------------

describe("the header: + and the bell, and the gauge from 600px", () => {
  it("every glyph-only control speaks its name", () => {
    for (const [id, name] of [["capture-btn", "Capture"], ["bell", "Needs You"], ["usage-btn", "Usage"]]) {
      expect(HEADER).toMatch(new RegExp(`<button id="${id}"[^>]*aria-label="${name}"`));
    }
    // and every other control in the chrome has a visible word
    for (const b of [...TAB_BAR.matchAll(/<button\b[\s\S]*?<\/button>/g), ...SIDEBAR.matchAll(/<button\b[\s\S]*?<\/button>/g)]) {
      expect(labelOf(b[0]), b[0]).toMatch(/^[A-Z][A-Za-z ]+$/); // Title Case (P10)
    }
  });

  it("+ opens Capture and the gauge opens Usage, as sheets at every width", () => {
    expect(SRC).toContain('$("capture-btn").onclick = () => show("capture");');
    expect(SRC).toContain('$("bell").onclick = () => show("triage");');
    expect(SRC).toContain('$("usage-btn").onclick = () => show("usage");');
    for (const v of ["capture", "usage"]) {
      expect(shell.inSheet(shell.VIEWS[v]!, false), v).toBe(true);
      expect(shell.inSheet(shell.VIEWS[v]!, true), v).toBe(true);
    }
  });
});

describe("sheets for the bell, Capture and Usage", () => {
  it("Needs You is the bell's sheet under 900px and a view in place at 900px", () => {
    expect(shell.inSheet(shell.VIEWS.triage!, false)).toBe(true);
    expect(shell.inSheet(shell.VIEWS.triage!, true)).toBe(false);
    for (const v of ["today", "chat", "board", "feed", "agents", "settings", "rooms"]) {
      expect(shell.inSheet(shell.VIEWS[v]!, false), v).toBe(false);
    }
  });

  it("the sheet is a native modal dialog with a heading and a way out", () => {
    const sheet = element("dialog", "sheet");
    expect(sheet).toContain('aria-labelledby="sheet-title"');
    expect(sheet).toContain('<h2 id="sheet-title">');
    expect(sheet).toMatch(/<button id="sheet-done" type="button">Done<\/button>/);
    expect(SRC).toContain('$("sheet").showModal()');
  });

  it("pushes go back to where they came from; at 900px More is the sidebar, so its rows are places of their own", () => {
    expect(shell.backFor(shell.VIEWS.agents!, false)).toBe("more");
    expect(shell.backFor(shell.VIEWS.agents!, true)).toBeNull();
    expect(shell.backFor(shell.VIEWS.rooms!, true)).toBe("card");
    expect(shell.backFor(shell.VIEWS.card!, true)).toBe("board");
    expect(shell.backFor(shell.VIEWS.today!, false)).toBeNull();
  });
});

/** The body of every `@media (…)` block with this exact prelude. */
function media(prelude: string): string {
  const out: string[] = [];
  let at = CSS.indexOf(`@media ${prelude} {`);
  while (at !== -1) {
    let depth = 0;
    let i = CSS.indexOf("{", at);
    const start = i + 1;
    for (; i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}" && --depth === 0) break;
    }
    out.push(CSS.slice(start, i));
    at = CSS.indexOf(`@media ${prelude} {`, i);
  }
  return out.join("\n");
}

describe("the 600–899px and 900px layouts", () => {
  const narrow = media("(min-width: 600px)");
  const wide = media("(min-width: 900px)");

  it("from 600px: the gauge joins the header, content is capped at the reading measure, sheets are centred, the board snaps sideways", () => {
    expect(CSS).toMatch(/^#usage-btn \{ display: none; \}/m);
    expect(narrow).toContain("#usage-btn { display: inline-flex; }");
    expect(narrow).toContain("main { max-width: calc(var(--mt-size-reading-measure) + 2 * var(--shell-gutter)); margin-inline: auto; }");
    expect(narrow).toContain("#sheet[open] { justify-content: center; align-items: center; }");
    expect(narrow).toContain("scroll-snap-type: x mandatory");
  });

  it("at 900px it is the Mac layout: the sidebar, no tab bar, and no bell", () => {
    expect(wide).toContain("grid-template-areas: \"bar bar\" \"side main\"");
    expect(wide).toContain("#bell, #tabs { display: none; }");
    expect(wide).toMatch(/#sidebar \{\s*grid-area: side;\s*display: flex;/);
    expect(wide).toContain(".segmented { display: none; }");
  });

  it("the sidebar is the Mac's order: Needs You while something waits, Today, Chat, Activity, Work, Knowledge, Agents", () => {
    const rows = [...SIDEBAR.replace(/<div id="side-work"[\s\S]*?<\/div>/, "").replace(/<div class="side-foot">[\s\S]*?<\/div>/, "")
      .matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["triage", "today", "chat", "feed", "work", "knowledge", "agents"]);
    expect(SIDEBAR).toMatch(/<button type="button" id="side-needs" data-view="triage" aria-label="Needs You" hidden>/);
  });
});

describe("glyphs, not emoji", () => {
  it("no emoji anywhere in the chrome, and none drawn by the stylesheet", () => {
    for (const [name, part] of [["tab bar", TAB_BAR], ["header", HEADER], ["sidebar", SIDEBAR], ["More", MORE]] as const) {
      expect(part, name).not.toMatch(EMOJI);
    }
    for (const m of CSS.matchAll(/content:\s*"([^"]*)"/g)) expect(m[1], m[0]).not.toMatch(EMOJI);
  });

  it("every glyph the chrome draws is a symbol in the sprite", () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
    const used = [...(TAB_BAR + HEADER + SIDEBAR + MORE).matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(10);
    for (const g of used) expect(symbols, g).toContain(g);
    // each tab wears one
    for (const b of TAB_BAR.matchAll(/<button\b[\s\S]*?<\/button>/g)) expect(b[0]).toMatch(/<svg class="glyph" aria-hidden="true" focusable="false"><use href="#g-/);
  });
});

describe("the views split out of app.js (T7-3a)", () => {
  it("every element a module binds by id ships in index.html — a missing one throws on load and stops the shell", () => {
    for (const m of ["app.js", "today.js", "needs-you.js", "work.js", "knowledge.js", "more.js", "notify.js"]) {
      const src = read(`../web/${m}`);
      const ids = [...new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((x) => x[1]!))];
      expect(ids.length, m).toBeGreaterThan(5);
      for (const id of ids) expect(HTML, `${m} binds #${id}`).toContain(`id="${id}"`);
    }
  });

  it("the shell imports the views; a view never imports the shell", () => {
    expect(SRC).toContain('import { mountNeedsYou } from "./needs-you.js";');
    expect(SRC).toContain('import { mountToday } from "./today.js";');
    expect(SRC).toContain('import { artifactRoute, mountWork, roomRoute } from "./work.js";');
    expect(SRC).toContain('import { mountKnowledge } from "./knowledge.js";');
    expect(SRC).toContain('import { mountMore } from "./more.js";');
    expect(SRC).toContain('import { mountNotify } from "./notify.js";');
    for (const m of ["today.js", "needs-you.js", "work.js", "knowledge.js", "more.js", "notify.js", "lib.js"]) expect(read(`../web/${m}`), m).not.toMatch(/from "\.\/app\.js"/);
    expect(read("../web/lib.js")).not.toMatch(/\bdocument\.|\bwindow\./); // DOM-free: a test imports it as it is
  });
});

describe("boot", () => {
  it("runs last, after every declaration a first view reads", () => {
    const boot = SRC.lastIndexOf("// ----- boot -----");
    expect(boot).toBeGreaterThan(SRC.lastIndexOf("\nconst "));
    expect(boot).toBeGreaterThan(SRC.lastIndexOf("\nfunction "));
    expect(SRC.slice(boot)).toContain('show(artifactRoute(location.hash) ? "artifact" : roomRoute(location.hash) ? "rooms" : HOME)');
  });
});
