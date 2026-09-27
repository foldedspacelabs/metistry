// T7-3a — Today in the PWA (screen 18 §2; screen 5 §12–§15; design-build-plan
// §2.13, §2.17): one column in the Mac's order — the Morning Brief or its folded
// line, Next Up, the spine — and the rail last, with no Needs You line.
//
// Built first against the recorded contract (U9): `GET /api/today`'s fixture is
// the one F-7 froze for T2-7 (apps/macos/tests/kit/fixtures/get-api-today.json),
// and the Tick and Defer doors are T2-4's and T2-5's, served. The pure pieces
// are imported as they are; the writes are driven through the mounted view on a
// fake browser, so what is asserted is what would cross the wire.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clockTime, dateTime } from "../web/lib.js";
import {
  agentsHtml,
  briefHtml,
  briefLine,
  deferChoices,
  mountToday,
  nextUpHtml,
  noteHtml,
  orderedItems,
  pastLine,
  sinceHtml,
  spineHtml,
  spineOf,
  taskHtml,
  ymd,
} from "../web/today.js";
import { control, fakeBrowser, type Call } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const FIXTURE = JSON.parse(read("../../macos/tests/kit/fixtures/get-api-today.json")) as { request: { path: string }; body: Day };
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");
const TODAY_SRC = read("../web/today.js");

interface Day { date: string; tasks: Record<string, unknown>[]; work: Record<string, unknown>[]; order: string[]; events: Record<string, unknown>[]; brief: string | null; standup: string | null; plan: string | null; as_of: string }
const day = (patch: Partial<Day> = {}): Day => ({ ...structuredClone(FIXTURE.body), ...patch });
const at = (iso: string) => new Date(iso);
/** The moment the spine is drawn at: 13:05Z, twenty-five minutes before the recorded 13:30Z standup. (The recording's own `as_of` is the clock it was recorded by.) */
const AS_OF = at("2026-09-28T13:05:00.000Z");
const TASK = FIXTURE.body.tasks[0]!;

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// The day as a spine
// ---------------------------------------------------------------------------

describe("the spine, from the recorded Today", () => {
  it("the fixture is T2-7's contract for the route this view reads", () => {
    expect(FIXTURE.request.path).toMatch(/^\/api\/today/);
    expect(TODAY_SRC).toContain('api("/api/today")');
  });

  it("the tasks and work in the owner's order; anything unordered after, as served", () => {
    // recorded: the owner dragged the task, then the Blocked card waiting on it; the due card is unordered
    expect(orderedItems(day()).map((i) => i.key)).toEqual(["mt-7f3k2a", "work:41", "work:1"]);
    expect(orderedItems(day({ order: ["work:1"] })).map((i) => i.key)).toEqual(["work:1", "mt-7f3k2a", "work:41"]);
    expect(orderedItems(day({ order: [] })).map((i) => i.key)).toEqual(["mt-7f3k2a", "work:41", "work:1"]);
  });

  it("at 13:05Z: nothing behind, the day's work in the gap, the standup next — and in Next Up", () => {
    const s = spineOf(day(), AS_OF);
    expect(s.past).toEqual([]);
    expect(s.open.map((i) => i.key)).toEqual(["mt-7f3k2a", "work:41", "work:1"]);
    expect(s.later.map((e) => e.key)).toEqual(["event:evt-standup-0928"]);
    expect(s.nextUp?.key).toBe("event:evt-standup-0928");
  });

  it("Next Up only from 30 minutes before; with every meeting behind, it says so", () => {
    expect(spineOf(day(), at("2026-09-28T12:55:00.000Z")).nextUp).toBeNull();
    expect(spineOf(day(), at("2026-09-28T13:00:00.000Z")).nextUp?.key).toBe("event:evt-standup-0928");
    const after = spineOf(day(), at("2026-09-28T14:00:00.000Z"));
    expect(after.past.map((i) => i.key)).toEqual(["event:evt-standup-0928"]);
    expect(nextUpHtml(after, at("2026-09-28T14:00:00.000Z"))).toBe('<p class="muted">Nothing else on your calendar today.</p>');
    expect(nextUpHtml(spineOf(day({ events: [] }), AS_OF), AS_OF)).toBe(""); // no calendar: nothing to say
  });

  it("Next Up is the retrieved half: title, time, who is in it", () => {
    const s = spineOf(day(), AS_OF);
    const html = nextUpHtml(s, AS_OF);
    expect(html).toContain("Next Up · in 25 min");
    expect(html).toContain('<p class="next-title">Standup</p>');
    expect(html).toContain(`${clockTime("2026-09-28T13:30:00.000Z")} – ${clockTime("2026-09-28T13:45:00.000Z")}`);
    expect(html).toContain("With Dana");
  });

  it("draws Now, the gap's line, the day's work, then the meeting at its time — which points up to Next Up", () => {
    const html = spineHtml(spineOf(day(), AS_OF), day(), { now: AS_OF });
    const order = [...html.matchAll(/<li class="(spine-[a-z]+)[^"]*"[^>]*>/g)].map((m) => m[1]);
    expect(order).toEqual(["spine-now", "spine-line", "spine-item", "spine-item", "spine-item", "spine-line", "spine-item"]);
    expect(html).toContain(`Now · ${clockTime(AS_OF)}`);
    expect(html).toContain(`Until ${clockTime("2026-09-28T13:30:00.000Z")}`);
    expect(html).toContain("in Next Up ↑");
  });

  it("with no meetings it is the plain list: no Now rule, no time lines (screen 5 §12.4)", () => {
    const html = spineHtml(spineOf(day({ events: [] }), AS_OF), day({ events: [] }), { now: AS_OF });
    expect(html).not.toContain("spine-now");
    expect(html).not.toContain("spine-line");
    expect((html.match(/class="spine-item/g) ?? []).length).toBe(3);
  });

  it("the past folds itself into one line; a line ticked a moment ago stays where it was", () => {
    const done = day({ tasks: [{ ...TASK, checked: true }] });
    const later = at("2026-09-28T14:00:00.000Z");
    expect(pastLine(spineOf(done, later).past)).toBe("2 earlier today · 1 done · 1 meeting");
    expect(spineHtml(spineOf(done, later), done, { now: later })).toMatch(/<details><summary>2 earlier today · 1 done · 1 meeting<\/summary>/);
    const kept = spineOf(done, later, new Set(["mt-7f3k2a"]));
    expect(kept.open.map((i) => i.key)).toContain("mt-7f3k2a");
    expect(taskHtml(kept.open[0]!, { n: 0, today: done.date })).toContain('class="spine-item task done"');
  });
});

// ---------------------------------------------------------------------------
// The row: a checkbox you tick, the reason line, Defer
// ---------------------------------------------------------------------------

describe("a task row", () => {
  const it0 = { type: "task", key: "mt-7f3k2a", row: TASK };

  it("leads with a checkbox named by the line itself, and says why it is here", () => {
    const html = taskHtml(it0, { n: 3, today: "2026-09-28" });
    expect(html).toMatch(/<input type="checkbox" id="tick-3" data-act="tick" data-key="mt-7f3k2a">/);
    expect(html).toContain('<label class="item-title" for="tick-3">Send Dana the fixture format</label>');
    expect(html).toContain("due today · P2 · S · metistry");
    expect(html).toMatch(/data-act="defer" data-key="mt-7f3k2a" aria-expanded="false">Defer</);
  });

  it("a work row has no checkbox — it is finished on the Board", () => {
    const html = spineHtml(spineOf(day(), AS_OF), day(), { now: AS_OF });
    const work = /<li class="spine-item work"[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(work).not.toContain('type="checkbox"');
    expect(work).toContain("Open on the Board");
    expect(work).toContain("Pick the fixture redaction");
    expect(work).toContain("blocked · metistry");
  });

  it("priority is weight, never colour; at most two chips above it", () => {
    const loud = { ...TASK, priority_effective: 1, due: "2026-09-20", waiting: true, carried_days: 6 };
    const html = taskHtml({ ...it0, row: loud }, { n: 0, today: "2026-09-28" });
    expect(html).toContain('class="spine-item task p1"');
    expect(html).toContain('<span class="chip degraded-chip">overdue</span><span class="chip">waiting</span><span class="chip">+1</span>');
    expect(html).not.toMatch(/failed/);
  });

  it("the owner's words are output-encoded like everything else (CRIT-7)", () => {
    const html = taskHtml({ ...it0, row: { ...TASK, text: "<img src=x onerror=alert(1)>", project: "<b>" } }, { n: 0, today: "2026-09-28" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  it("Defer's choices wrap under the row: Tomorrow, This Week while it is still ahead, Someday", () => {
    const wed = new Date(2026, 8, 30, 10); // Wednesday, local
    expect(deferChoices(wed).map((c) => [c.label, c.body])).toEqual([
      ["Tomorrow", { do: "2026-10-01" }], ["This Week", { do: "2026-10-02" }], ["Someday", { someday: true }],
    ]);
    expect(deferChoices(new Date(2026, 9, 1, 10)).map((c) => c.label)).toEqual(["Tomorrow", "Someday"]); // Thursday: Friday is tomorrow
    expect(deferChoices(new Date(2026, 9, 2, 10)).map((c) => c.label)).toEqual(["Tomorrow", "Someday"]); // Friday
    expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05");
    const open = taskHtml(it0, { n: 0, today: "2026-09-28", deferring: true, now: wed });
    expect(open).toMatch(/<div class="defer-choices" role="group" aria-label="Defer to">.*Tomorrow.*This Week.*Someday/);
  });

  it("what a write leaves: the receipt names the file, with Undo; a stale refusal shows the line as it stands", () => {
    expect(noteHtml("mt-7f3k2a", { kind: "ticked", path: "Journal/2026-09-28.md" })).toContain('Ticked in <span class="mono">Journal/2026-09-28.md</span> <button type="button" class="link" data-act="undo" data-key="mt-7f3k2a">Undo</button>');
    const stale = noteHtml("mt-7f3k2a", { kind: "stale", line: "- [ ] Send Dana the <new> format" });
    expect(stale).toContain("This line changed in your note since it was shown. Nothing was written.");
    expect(stale).toContain("Send Dana the &lt;new&gt; format");
    expect(noteHtml("k", { kind: "stale", line: null })).toContain("The line is gone from the note.");
  });
});

// ---------------------------------------------------------------------------
// The Morning Brief, and the rail
// ---------------------------------------------------------------------------

describe("the Morning Brief", () => {
  const md = "# Brief — Monday\n\nFour things today; the lease comparables are the one that moved. Then more.\n\n- one\n";

  it("folds to its first sentence once read, and opens again on a tap", () => {
    expect(briefLine(md)).toBe("Morning Brief — Four things today; the lease comparables are the one that moved.");
    expect(briefHtml({ brief: md, open: false })).toBe('<button type="button" class="brief-fold" data-act="brief-open" aria-expanded="false">Morning Brief — Four things today; the lease comparables are the one that moved.</button>');
  });

  it("open: one wash in the serif, the Standup collapsed with Copy — never a send — and a foot that names the file", () => {
    const html = briefHtml({ date: "2026-09-28", brief: md, standup: "Yesterday: x", open: true, planned: 7, carried: 2, path: "Journal/Brief/2026-09-28.md" });
    expect(html).toContain('<div class="brief-body agent-prose">');
    expect(html).not.toContain("Brief — Monday"); // its title is the header's to say
    expect(html).toMatch(/<details class="standup"><summary>Standup<\/summary>[\s\S]*Metistry doesn't post this\.[\s\S]*Copy Standup/);
    expect(html).not.toMatch(/\b(Send|Post|Share)\b/);
    expect(html).toContain("The plan is the day below · 7 tasks, 2 carried");
    expect(html).toContain("Journal/Brief/2026-09-28.md");
  });

  it("generated prose goes through md.js: escaped first, whitelisted tags only", () => {
    const html = briefHtml({ brief: "Hi <img src=x onerror=alert(1)> [x](javascript:alert(1))", open: true, planned: 0, carried: 0, path: "p" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
  });

  it("absent and failed both end: the day below is still complete", () => {
    expect(briefHtml({ brief: null })).toContain("No Morning Brief yet today — the day below is still complete.");
    expect(briefHtml({ failed: "forbidden <x>" })).toContain("Couldn't read the Morning Brief — the day below is still complete.");
    expect(briefHtml({ failed: "forbidden <x>" })).toContain("forbidden &lt;x&gt;");
  });
});

describe("the rail — Agents, Since You Last Looked; no Needs You line", () => {
  it("Agents: the ones doing something, in words; idle is not news", () => {
    const html = agentsHtml([
      { id: "cursor", display_name: "Cursor", state: "working", current_claims: [{ title: "Freeze the store interface" }] },
      { id: "devin", display_name: "Devin", state: "idle" },
      { id: "x", display_name: "<b>X</b>", state: 'over-cap" onmouseover="x' },
    ]);
    expect(html).toContain('<b>Cursor</b> <span class="chip state-working">working</span> <span class="muted">Freeze the store interface</span>');
    expect(html).not.toContain("Devin");
    expect(html).not.toMatch(/<[^>]*onmouseover/); // the words are text, never an attribute
    expect(html).toContain('class="chip state-idle"'); // a state outside the six draws no class of its own
    expect(agentsHtml([{ id: "d", state: "idle" }])).toBe('<li class="muted">No agent is working right now.</li>');
  });

  it("Since You Last Looked: how many, and the newest few", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ ts: "2026-09-27T00:36:49.811Z", kind: "task_op", subject: `work:${i}`, detail: "create" }));
    const since = "2026-09-26T20:00:00.000Z";
    const html = sinceHtml(rows, since, new Date(Date.parse(since) + 60_000));
    expect(html).toContain(`7 things since ${clockTime(since)}</li>`);
    expect((html.match(/<li><span>/g) ?? []).length).toBe(5);
    expect(html).toContain('<span class="muted when">');
    expect(sinceHtml([], since, new Date(Date.parse(since) + 60_000))).toContain("Nothing new since");
    // a look from another day says which day
    expect(sinceHtml(rows, since, new Date(Date.parse(since) + 3 * 86_400_000))).toContain(`since ${dateTime(since)}`);
  });

  it("the markup: brief, Next Up, the spine, then the rail — and no Needs You line on Today", () => {
    const today = /<section id="today" hidden>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
    const ids = [...today.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.indexOf("today-brief")).toBeLessThan(ids.indexOf("today-next"));
    expect(ids.indexOf("today-next")).toBeLessThan(ids.indexOf("today-spine"));
    expect(ids.indexOf("today-spine")).toBeLessThan(ids.indexOf("today-rail"));
    expect(today).not.toMatch(/Needs You|data-needs-count|data-view="triage"/);
  });
});

// ---------------------------------------------------------------------------
// The writes: Tick and Defer, and nothing else
// ---------------------------------------------------------------------------

describe("the mounted view writes through the Tick and Defer doors, and nothing else", () => {
  const respond = (write: (c: Call) => { status?: number; body: unknown }) => (c: Call) => {
    if (c.method !== "GET") return write(c);
    if (c.path === "/api/today") return { body: day() };
    if (c.path.startsWith("/api/knowledge/page")) return { status: 404, body: { error: { code: "not_found", message: "not found" } } };
    return { body: { rows: [], as_of: FIXTURE.body.as_of } };
  };
  const mount = (write: (c: Call) => { status?: number; body: unknown } = () => ({ body: { ok: true } })) => {
    const b = fakeBrowser({ respond: respond(write) });
    const shown: string[] = [];
    const view = mountToday({ $: b.$, api: b.api, show: (v: string) => { shown.push(v); } });
    return { b, view, shown };
  };
  const tick = (b: ReturnType<typeof fakeBrowser>, checked: boolean) =>
    b.$("today").fire("change", { target: control({ act: "tick", key: "mt-7f3k2a" }, { checked }) });

  it("reads the day, the notes it names, and the rail — and writes nothing on its own", async () => {
    const { b, view } = mount();
    await view.load();
    expect(b.calls.map((c) => c.path.split("?")[0])).toEqual(expect.arrayContaining(["/api/today", "/api/knowledge/page", "/api/q/agent_presence", "/api/q/activity_feed"]));
    expect(b.writes()).toEqual([]);
    expect(b.$("today-spine").innerHTML).toContain("Send Dana the fixture format");
    expect(b.$("today-brief").innerHTML).toContain("No Morning Brief yet today"); // the path is named before the routine writes it
  });

  it("Tick: the line's text as seen and an Idempotency-Key; the receipt names the file, with Undo, which is the same door back", async () => {
    const { b, view } = mount(() => ({ body: { ok: true, line: "- [x] Send Dana the fixture format", task: {} } }));
    await view.load();
    await tick(b, true);
    const [w] = b.writes();
    expect(w).toMatchObject({ path: "/api/vault-tasks/mt-7f3k2a/check", method: "POST", body: { checked: true, seen_text: "Send Dana the fixture format" } });
    expect(w!.headers["idempotency-key"]).toMatch(/^tick-.{8,}/);
    expect(b.$("today-spine").innerHTML).toContain("Ticked in <span class=\"mono\">Journal/2026-09-28.md</span>");
    await b.$("today").fire("click", { target: control({ act: "undo", key: "mt-7f3k2a" }) });
    expect(b.writes()[1]).toMatchObject({ path: "/api/vault-tasks/mt-7f3k2a/check", body: { checked: false, seen_text: "Send Dana the fixture format" } });
    expect(b.writes()[1]!.headers["idempotency-key"]).not.toBe(w!.headers["idempotency-key"]);
  });

  it("409 stale: nothing was written, and the line as it stands is shown beside it", async () => {
    const { b, view } = mount(() => ({ status: 409, body: { error: { code: "conflict" }, reason: "stale", line: "- [ ] Send Dana the new format ^mt-7f3k2a", task: null } }));
    await view.load();
    await tick(b, true);
    const html = b.$("today-spine").innerHTML;
    expect(html).toContain("This line changed in your note since it was shown. Nothing was written.");
    expect(html).toContain("Send Dana the new format ^mt-7f3k2a");
    expect(html).not.toMatch(/data-act="tick"[^>]* checked/); // the box is as the note has it
  });

  it("Defer: the choices open under the row; Tomorrow sends a `do` day and the text as seen", async () => {
    const { b, view } = mount(() => ({ body: { ok: true, line: "…", task: {} } }));
    await view.load();
    await b.$("today").fire("click", { target: control({ act: "defer", key: "mt-7f3k2a" }) });
    expect(b.$("today-spine").innerHTML).toContain('aria-label="Defer to"');
    await b.$("today").fire("click", { target: control({ act: "defer-to", key: "mt-7f3k2a", when: "tomorrow" }) });
    const [w] = b.writes();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(w).toMatchObject({ path: "/api/vault-tasks/mt-7f3k2a/schedule", method: "POST", body: { do: ymd(tomorrow), seen_text: "Send Dana the fixture format" } });
    expect(w!.headers["idempotency-key"]).toMatch(/^defer-/);
    expect(b.$("today-receipt").textContent).toMatch(/^Deferred to .+ — Send Dana the fixture format$/);
  });

  it("every write it can make is one of the two doors", () => {
    const writes = [...TODAY_SRC.matchAll(/api\(`([^`]+)`,\s*\{\s*method: "([A-Z]+)"/g)].map((m) => `${m[2]} ${m[1]}`);
    expect(writes).toEqual([
      "POST /api/vault-tasks/${encodeURIComponent(key)}/check",
      "POST /api/vault-tasks/${encodeURIComponent(key)}/schedule",
    ]);
    expect(TODAY_SRC).not.toMatch(/method: "(PUT|PATCH|DELETE)"/);
  });

  it("a console without the day says so in its own words; the rail still loads", async () => {
    const b = fakeBrowser({
      respond: (c) => (c.path === "/api/today" ? { status: 404, body: { error: { code: "not_found", message: "not found" } } } : { body: { rows: [], as_of: "x" } }),
    });
    await mountToday({ $: b.$, api: b.api, show: () => {} }).load();
    expect(b.$("today-state").hidden).toBe(false);
    expect(b.$("today-state").innerHTML).toContain("Couldn't read today");
    expect(b.$("today-state").innerHTML).toContain('<p class="mono reason">not found</p>');
    expect(b.$("today-agents").innerHTML).toContain("No agent is working right now.");
  });

  it("an empty day is not a finished one (screen 5 §7)", async () => {
    const b = fakeBrowser({ respond: (c) => (c.path === "/api/today" ? { body: day({ tasks: [], work: [], events: [], brief: null }) } : { body: { rows: [] } }) });
    await mountToday({ $: b.$, api: b.api, show: () => {} }).load();
    expect(b.$("today-state").innerHTML).toContain("Nothing scheduled for today.");
    expect(b.$("today-state").innerHTML).toContain("not that you're finished");
  });

  it("Open on the Board and Open Activity are the shell's navigation", async () => {
    const { b, view, shown } = mount();
    await view.load();
    await b.$("today").fire("click", { target: control({ act: "board" }) });
    await b.$("today").fire("click", { target: control({ act: "feed" }) });
    expect(shown).toEqual(["board", "feed"]);
  });

  it("the brief folds on the next open once read — never under the reader, not even after a tick", async () => {
    const b = fakeBrowser({
      respond: (c) => {
        if (c.method !== "GET") return { body: { ok: true } };
        if (c.path === "/api/today") return { body: day() };
        if (c.path.startsWith("/api/knowledge/page")) return { body: { path: "x", content: "# Brief\n\nFour things today. More.\n" } };
        return { body: { rows: [] } };
      },
    });
    const view = mountToday({ $: b.$, api: b.api, show: () => {} });
    await view.load();
    expect(b.$("today-brief").innerHTML).toContain('<div class="brief-body agent-prose">');
    b.stored.set("metistry.brief-read", FIXTURE.body.date); // scrolled past
    await b.$("today").fire("change", { target: control({ act: "tick", key: "mt-7f3k2a" }, { checked: true }) });
    expect(b.$("today-brief").innerHTML).toContain('<div class="brief-body agent-prose">'); // still open: nothing moves mid-look
    await view.load(); // the next open
    expect(b.$("today-brief").innerHTML).toContain('<button type="button" class="brief-fold" data-act="brief-open" aria-expanded="false">Morning Brief — Four things today.</button>');
    await b.$("today").fire("click", { target: control({ act: "brief-open" }) });
    expect(b.$("today-brief").innerHTML).toContain('<div class="brief-body agent-prose">');
  });

  it("Since You Last Looked asks from the last look, and remembers this one", async () => {
    const { b, view } = mount();
    b.stored.set("metistry.today-looked", "2026-09-28T09:00:00.000Z");
    await view.load();
    const feed = b.calls.find((c) => c.path.startsWith("/api/q/activity_feed"))!;
    expect(new URL(feed.path, "http://x").searchParams.get("since")).toBe("2026-09-28T09:00:00.000Z");
    expect(b.stored.get("metistry.today-looked")).not.toBe("2026-09-28T09:00:00.000Z");
  });
  it("a live event's refresh (T7-7) reads the day and the rail again under the reader — the same look, not a new one", async () => {
    let fail = false;
    const b = fakeBrowser({
      respond: (c) => {
        if (c.method !== "GET") return { body: { ok: true, line: "- [x] Send Dana the fixture format", task: {} } };
        if (c.path === "/api/today") return fail ? { status: 503, body: { error: { code: "not_available", message: "down" } } } : { body: day() };
        if (c.path.startsWith("/api/knowledge/page")) return { status: 404, body: {} };
        return { body: { rows: [] } };
      },
    });
    const view = mountToday({ $: b.$, api: b.api, show: () => {} });
    b.stored.set("metistry.today-looked", "2026-09-28T09:00:00.000Z");
    await view.load();
    const looked = b.stored.get("metistry.today-looked");
    await b.$("today").fire("change", { target: control({ act: "tick", key: "mt-7f3k2a" }, { checked: true }) });
    expect(b.$("today-spine").innerHTML).toContain("Ticked in");
    b.calls.length = 0;
    await view.refresh();
    expect(b.calls.map((c) => c.path.split("?")[0])).toEqual(expect.arrayContaining(["/api/today", "/api/q/agent_presence", "/api/q/activity_feed"]));
    const feed = b.calls.find((c) => c.path.startsWith("/api/q/activity_feed"))!;
    expect(new URL(feed.path, "http://x").searchParams.get("since")).toBe("2026-09-28T09:00:00.000Z"); // this look's boundary
    expect(b.stored.get("metistry.today-looked")).toBe(looked); // not re-stamped
    expect(b.$("today-spine").innerHTML).toContain("Ticked in"); // what the write left stays
    expect(b.writes()).toEqual([]);
    fail = true;
    await view.refresh();
    expect(b.$("today-spine").innerHTML).toContain("Send Dana the fixture format"); // a failed refetch keeps the day
  });
});
