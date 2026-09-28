// T7-4 — offline in the PWA (screen 18 §4; design-build-plan §2.17): the
// outbox for captures and ticks, replayed with the key and the Tick door's
// 409; the *Can't reach Metistry* band; and one rule per verb. The ticket's
// own test is held first: **answers, moves, Run Now and grants are never
// queued** — not by the outbox (a closed list of two routes), not by the
// service worker (it holds no write), and not by any view (each refuses
// while offline, and none but Today is handed the outbox).
//
// offline.js is DOM-free, so it is imported as it is; sw.js runs against a
// fake worker scope; the views mount on pwa-fake-dom.ts; the shell's wiring
// in app.js is read from the source, as pwa-shell.test.ts does.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_API } from "@foldedspacelabs/metistry-core";
import { EVENTS_PATH } from "../web/live.js";
import {
  NotQueueable,
  OFFLINE_HEADER,
  OUTBOX_ROUTES,
  READ_AT_HEADER,
  READS_CACHE,
  bandText,
  createOutbox,
  drainedText,
  keptStore,
  memoryStore,
  queueable,
  readAt,
  unreached,
} from "../web/offline.js";
import { mountToday, noteHtml, taskHtml } from "../web/today.js";
import { OFFLINE_REFUSAL, answersHtml, mountNeedsYou } from "../web/needs-you.js";
import { OFFLINE_MOVE, mountWork, moveListHtml } from "../web/work.js";
import { OFFLINE_GRANT, mountMore } from "../web/more.js";
import { withRequestShape } from "../src/server.js";
import { control, fakeBrowser, type Call } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = read("../web/app.js");
const SW = read("../web/sw.js");
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");
const CSS = read("../web/style.css");
const fixture = <T>(name: string) => JSON.parse(read(`../../macos/tests/kit/fixtures/${name}.json`)) as { body: T };

afterEach(() => vi.unstubAllGlobals());

/** Lift a top-level `function NAME(…) {…}` out of app.js. */
function lift(name: string): string {
  const lines = SRC.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:async )?function ${name}\\(`).test(l));
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

const sample = (path: string) => path.replace(/:[a-z_]+/g, "x").replace("/*", "/x");
const key = (n = 1) => ({ "content-type": "application/json", "idempotency-key": `tick-${n}` });
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

// ---------------------------------------------------------------------------
// The ticket's test: answers, moves, Run Now and grants are never queued
// ---------------------------------------------------------------------------

/** The acts screen 18 §4 says are not offered offline, as the routes they write. */
const NEVER = {
  answers: [["POST", "/api/proposals/42"], ["POST", "/api/proposals/batch"]],
  moves: [["PATCH", "/api/tasks/7"], ["POST", "/api/tasks/7/claim"], ["POST", "/api/tasks/7/release"]],
  "Run Now": [["POST", "/api/scheduled/routines/plan-tomorrow/run"], ["POST", "/api/scheduled/syncs/github-state/run"]],
  grants: [["PUT", "/api/agents/cursor/grants"], ["PUT", "/api/agents/cursor/projects"], ["PUT", "/api/agents/cursor/autonomy"]],
  "a mode": [["PUT", "/api/projects/metistry"]],
  "a message": [["POST", "/message"]],
} as const;

describe("answers, moves, Run Now and grants are never queued", () => {
  for (const [act, routes] of Object.entries(NEVER)) {
    it(`${act}: the outbox refuses it before storing anything, whatever key it carries`, async () => {
      const store = memoryStore();
      const box = createOutbox({ store, send: vi.fn() });
      for (const [method, path] of routes) {
        expect(queueable(method, path), `${method} ${path}`).toBeNull();
        await expect(box.add({ method, path, headers: key(), body: "{}" })).rejects.toBeInstanceOf(NotQueueable);
      }
      expect(await store.all()).toEqual([]);
      expect(box.size).toBe(0);
    });
  }

  it("the outbox holds only routes the route table marks `key` — and only two of them: capture and the Tick door", () => {
    const held = CLIENT_API.filter((r) => r.method !== "*" && queueable(r.method, sample(r.path)));
    expect(held.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /capture", "POST /api/vault-tasks/:task_key/check"]);
    for (const r of held) expect(r.idempotent, r.path).toBe("key");
    // every route a replay would make a second act, or a 409 — never held
    for (const r of CLIENT_API.filter((x) => x.idempotent !== "key" && x.method !== "*")) expect(queueable(r.method, sample(r.path)), `${r.method} ${r.path}`).toBeNull();
    expect(OUTBOX_ROUTES.map((r) => r.verb)).toEqual(["capture", "tick"]);
  });

  it("Defer honours the key too, and still never waits: the outbox is captures and ticks (§2.17)", () => {
    expect(CLIENT_API.find((r) => r.path === "/api/vault-tasks/:task_key/schedule")!.idempotent).toBe("key");
    expect(queueable("POST", "/api/vault-tasks/mt-7f3k2a/schedule")).toBeNull();
  });

  it("the service worker holds no write: every one reaches the network untouched", async () => {
    const w = worker();
    for (const [method, path] of [...Object.values(NEVER).flat(), ["POST", "/capture"], ["POST", "/api/vault-tasks/mt-7f3k2a/check"]]) {
      expect(await w.dispatch(path, { method }), `${method} ${path}`).toBeNull();
    }
  });

  it("only Today is handed the outbox; the views that answer, move and grant are handed `offline()` instead", () => {
    expect(SRC.match(/\boutbox\b[,}]/g)?.length).toBe(1);
    expect(SRC).toContain("mountToday({ $, api, show, outbox, offline: isOffline })");
    expect(SRC).toContain("mountNeedsYou({ $, api, setNeeds, show, offline: isOffline })");
    expect(SRC).toContain('mountWork({ $, api, show, closeSheet, retitle, poll: (fn, ms) => live.poll("board", fn, ms), offline: isOffline })');
    expect(SRC).toContain("mountMore({ $, api, show, offline: isOffline })");
    for (const m of ["needs-you.js", "work.js", "more.js", "knowledge.js"]) {
      expect(read(`../web/${m}`), m).not.toMatch(/offline\.js|outbox/);
    }
  });

  it("Needs You offline: no answer is sent by a button, a key or the batch bar — and it says why", async () => {
    const p = withRequestShape({ id: 7, ts: "2026-09-27T08:00:00.000Z", kind: "action", source_agent: "collator", trust: "internal", payload: { action: { kind: "comment", args: { ref: "gh:o/r#4", body: "LGTM" } } }, decision: "pending" });
    let offline = true;
    const b = fakeBrowser({ respond: (c) => (c.method === "GET" ? { body: { proposals: [p] } } : { body: { ok: true } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {}, offline: () => offline });
    await view.load();
    for (const act of ["primary", "decline", "later"]) await b.$("triage").fire("click", { target: control({ act, id: "7" }) });
    expect(b.writes()).toEqual([]);
    expect(b.$("proposal-list").innerHTML).toContain(`<p class="card-error" role="status">${OFFLINE_REFUSAL}</p>`);
    // the batch bar, by tap and by its key
    await b.$("triage-select").onclick!();
    const pick = control({}, { checked: true });
    pick.dataset = { pick: "7" };
    await b.$("triage").fire("change", { target: pick });
    await b.$("triage-later").onclick!();
    expect(b.writes()).toEqual([]);
    expect(b.$("triage-receipt").textContent).toBe(OFFLINE_REFUSAL);
    await b.$("triage-select").onclick!();
    offline = false; // back: the same button answers
    await b.$("triage").fire("click", { target: control({ act: "primary", id: "7" }) });
    expect(b.writes()).toHaveLength(1);
  });

  it("Work offline: no move is sent — a row, a drag, Try Again — and no mode", async () => {
    const BOARD = fixture<{ rows: Record<string, unknown>[]; as_of: string }>("get-api-q-board");
    const b = fakeBrowser({
      respond: (c) => (c.path.startsWith("/api/q/board") ? { body: { rows: structuredClone(BOARD.body.rows), as_of: BOARD.body.as_of } } : { body: { ok: true } }),
    });
    const view = mountWork({ $: b.$, api: b.api, show: () => {}, closeSheet: () => {}, offline: () => true });
    await view.board();
    view.openMove(BOARD.body.rows.find((r) => r.id === "41"));
    await view.move();
    await b.$("move").fire("click", { target: control({ act: "move", column: "backlog" }) });
    expect(b.writes()).toEqual([]);
    expect(b.$("board-msg").innerHTML).toContain(OFFLINE_MOVE);
    vi.stubGlobal("confirm", () => true);
    await b.$("project").fire("click", { target: control({ act: "mode", to: "review" }) });
    expect(b.writes()).toEqual([]);
  });

  it("More offline: a grant and a revoke are not sent", async () => {
    const AGENTS = fixture<{ agents: unknown[] }>("get-api-agents");
    const b = fakeBrowser({ respond: (c) => (c.path === "/api/agents" ? { body: AGENTS.body } : { body: { rows: [] } }) });
    vi.stubGlobal("confirm", () => true);
    const view = mountMore({ $: b.$, api: b.api, show: () => {}, offline: () => true });
    await view.agents();
    await b.$("agents").fire("click", { target: control({ act: "agent", id: "cursor" }) });
    await view.agent();
    await b.$("agent").fire("click", { target: control({ act: "edit" }) });
    await b.$("agent-grants").fire("submit", { preventDefault() {} });
    await b.$("agent").fire("click", { target: control({ act: "revoke" }) });
    expect(b.writes()).toEqual([]);
    expect(b.$("agent-grants-msg").textContent).toBe(OFFLINE_GRANT);
  });

  it("the controls themselves are not offered: each carries `data-needs-connection`, which the shell holds", () => {
    const p = withRequestShape({ id: 7, ts: "2026-09-27T08:00:00.000Z", kind: "action", source_agent: "collator", trust: "internal", payload: { action: { kind: "comment", args: {} } }, decision: "pending" });
    for (const m of answersHtml(p).matchAll(/<button\b[^>]*data-act="(primary|decline|later)"[^>]*>/g)) expect(m[0], m[1]).toContain("data-needs-connection");
    const BOARD = fixture<{ rows: Record<string, unknown>[] }>("get-api-q-board");
    for (const m of moveListHtml(BOARD.body.rows.find((r) => r.id === "41")).matchAll(/<button\b[^>]*data-act="move"[^>]*>/g)) expect(m[0]).toContain("data-needs-connection");
    for (const [tag, id] of [["button", "card-move"], ["button", "card-release"], ["button", "triage-later"], ["button", "triage-skip"]]) {
      expect(HTML).toMatch(new RegExp(`<${tag}[^>]*id="${id}"[^>]*data-needs-connection`));
    }
    expect(HTML).toMatch(/<button type="button" class="destructive" data-act="revoke" data-needs-connection>Revoke<\/button>/);
    expect(HTML).toMatch(/<button type="submit" data-needs-connection>Save<\/button>/);
  });
});

// ---------------------------------------------------------------------------
// The outbox: replayed with the key, the tick through the 409
// ---------------------------------------------------------------------------

describe("the outbox", () => {
  const tick = (n: number, meta: Record<string, unknown> = {}) => ({
    method: "POST",
    path: `/api/vault-tasks/mt-${n}/check`,
    headers: key(n),
    body: JSON.stringify({ checked: true, seen_text: `line ${n}` }),
    meta: { task_key: `mt-${n}`, checked: true, seen_text: `line ${n}`, ...meta },
  });

  it("a write waits only with the key its first attempt carried", async () => {
    const box = createOutbox({ store: memoryStore(), send: vi.fn() });
    await expect(box.add({ method: "POST", path: "/capture", headers: {}, body: "{}" })).rejects.toThrow(/Idempotency-Key/);
    await expect(box.add({ method: "POST", path: "/capture", headers: { "idempotency-key": "x".repeat(201) }, body: "{}" })).rejects.toBeInstanceOf(NotQueueable);
    const e = await box.add({ method: "POST", path: "/capture", headers: { "idempotency-key": "capture-1" }, body: '{"note":"milk"}' });
    expect(e).toMatchObject({ id: "capture-1", verb: "capture" });
    await box.add({ method: "POST", path: "/capture", headers: { "idempotency-key": "capture-1" }, body: '{"note":"milk"}' }); // the same write twice is one
    expect(box.size).toBe(1);
  });

  it("drains head first, sending each with the SAME key and body it was stored with", async () => {
    const sent: { path: string; key: string; body: string }[] = [];
    const store = memoryStore();
    const box = createOutbox({ store, send: async (e) => { sent.push({ path: e.path, key: e.headers["idempotency-key"], body: e.body }); return res(e.verb === "capture" ? 201 : 200, { ok: true }); } });
    await box.add({ method: "POST", path: "/capture", headers: { "content-type": "application/json", "idempotency-key": "capture-a" }, body: '{"note":"a"}' });
    await box.add(tick(1));
    await box.add(tick(2));
    const r = await box.drain();
    expect(sent).toEqual([
      { path: "/capture", key: "capture-a", body: '{"note":"a"}' },
      { path: "/api/vault-tasks/mt-1/check", key: "tick-1", body: '{"checked":true,"seen_text":"line 1"}' },
      { path: "/api/vault-tasks/mt-2/check", key: "tick-2", body: '{"checked":true,"seen_text":"line 2"}' },
    ]);
    expect(r).toMatchObject({ held: 0, reason: null });
    expect(r.done.map((d) => d.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(await store.all()).toEqual([]);
  });

  it("a replay the console already answered is its first answer again (Idempotency-Replayed)", async () => {
    const box = createOutbox({ store: memoryStore(), send: async () => res(201, { id: 42 }, { "idempotency-replayed": "true" }) });
    await box.add({ method: "POST", path: "/capture", headers: { "idempotency-key": "capture-a" }, body: "{}" });
    const { done } = await box.drain();
    expect(done[0]).toMatchObject({ outcome: "sent", replayed: true, body: { id: 42 } });
  });

  it("a tick replays through the Tick door's 409: the line changed while it waited, so nothing was written and it says so", async () => {
    const heard: unknown[] = [];
    const STALE = { error: { code: "conflict" }, reason: "stale", line: "- [ ] line 1, reworded ^mt-1", task: { checked: false, text: "line 1, reworded" } };
    const box = createOutbox({ store: memoryStore(), send: async () => res(409, STALE), onResult: (r) => heard.push(r) });
    await box.add(tick(1));
    const { done } = await box.drain();
    expect(done[0]).toMatchObject({ outcome: "stale", status: 409, body: { line: STALE.line } });
    expect(heard).toHaveLength(1);
    expect(box.size).toBe(0); // a 409 is an answer: it is not sent again
  });

  it("a tick whose line already says what it asked is done — the first attempt landed before a console restart", async () => {
    const box = createOutbox({ store: memoryStore(), send: async () => res(409, { reason: "stale", line: "- [x] line 1 done 2026-09-28 ^mt-1", task: { checked: true, text: "line 1" } }) });
    await box.add(tick(1));
    expect((await box.drain()).done[0]!.outcome).toBe("sent");
  });

  it("the console not answering holds everything, in order: a thrown fetch, a gateway 502/504, 429, 5xx", async () => {
    for (const answer of [() => { throw new TypeError("Failed to fetch"); }, () => res(502), () => res(504), () => res(429), () => res(503)]) {
      const box = createOutbox({ store: memoryStore(), send: async () => answer() });
      await box.add(tick(1));
      await box.add(tick(2));
      const r = await box.drain();
      expect(r.held).toBe(2);
      expect(box.waiting().map((e) => e.id)).toEqual(["tick-1", "tick-2"]);
    }
  });

  it("a 401 holds the queue for the next sign-in; any other refusal is said and taken off", async () => {
    const auth = createOutbox({ store: memoryStore(), send: async () => res(401) });
    await auth.add(tick(1));
    expect(await auth.drain()).toMatchObject({ held: 1, reason: "unauthenticated" });
    const refused = createOutbox({ store: memoryStore(), send: async () => res(403, { error: { code: "forbidden", message: "not a knowledge note" } }) });
    await refused.add(tick(1));
    const { done } = await refused.drain();
    expect(done[0]).toMatchObject({ outcome: "refused", body: { error: { message: "not a knowledge note" } } });
    expect(refused.size).toBe(0);
  });

  it("one drain at a time; Don't Send takes a waiting write back, never the one in flight", async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<Response>((r) => { release = () => r(res(200, { ok: true })); }));
    const box = createOutbox({ store: memoryStore(), send });
    await box.add(tick(1));
    await box.add(tick(2));
    await box.add(tick(3));
    const a = box.drain();
    const b = box.drain();
    await Promise.resolve();
    expect(await box.cancel("tick-1")).toBe(false); // in flight
    expect(await box.cancel("tick-3")).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await a).toBe(await b);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("survives a reload through its store, oldest first", async () => {
    const store = memoryStore();
    const one = createOutbox({ store, send: vi.fn() });
    await one.add(tick(1));
    await one.add(tick(2));
    const two = createOutbox({ store, send: vi.fn() });
    expect(await two.load()).toBe(2);
    expect(two.waiting("tick").map((e) => e.meta.task_key)).toEqual(["mt-1", "mt-2"]);
  });

  it("a browser that refuses IndexedDB keeps it in memory instead of losing the write", async () => {
    const idb = { open: () => { throw new Error("private window"); } };
    const store = keptStore(idb);
    await store.put({ id: "a", seq: 1 });
    expect(await store.all()).toEqual([{ id: "a", seq: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Whether the console answered, and the band
// ---------------------------------------------------------------------------

describe("the console not reached, and the band that says so", () => {
  it("a gateway's 502/504 or a read the worker served from its cache is not the console answering", () => {
    expect(unreached(res(502))).toBe(true);
    expect(unreached(res(504))).toBe(true);
    expect(unreached(res(200, {}, { [OFFLINE_HEADER]: "1", [READ_AT_HEADER]: "2026-09-28T13:04:00.000Z" }))).toBe(true);
    expect(readAt(res(200, {}, { [READ_AT_HEADER]: "2026-09-28T13:04:00.000Z" }))).toBe("2026-09-28T13:04:00.000Z");
    for (const s of [200, 400, 401, 409, 500, 503]) expect(unreached(res(s)), String(s)).toBe(false);
  });

  it("the band: Can't reach Metistry, when the view was read, and what still works", () => {
    const at = new Date(2026, 8, 28, 9, 4).toISOString();
    expect(bandText({ shownAt: at, waiting: 2 })).toEqual({ title: "Can't reach Metistry", detail: "Showing 9:04 AM · Captures and ticks wait and send when it's back · 2 waiting" });
    expect(bandText()).toEqual({ title: "Can't reach Metistry", detail: "Captures and ticks wait and send when it's back" });
  });

  it("what a drain did is said once", () => {
    const d = (outcome: string) => ({ outcome }) as never;
    expect(drainedText([d("sent"), d("sent"), d("stale")])).toBe("Sent 2 that were waiting. 1 tick was not written: the line changed while it waited.");
    expect(drainedText([])).toBe("");
  });

  it("the band sits under the header, marked up once, and neutral — never failed's red", () => {
    expect(HTML).toMatch(/<div id="offline-band" class="offline-band" role="status" hidden>\s*<p id="offline-title" class="band-title">Can't reach Metistry<\/p>\s*<p id="offline-why" class="band-detail"><\/p>/);
    const band = /\.offline-band \{[^}]*\}/.exec(CSS)![0];
    expect(band).toContain("var(--mt-color-sunken)");
    expect(band).not.toMatch(/failed|degraded/);
    expect(HTML).toMatch(/<p class="offline-only offline-note">Decisions need the connection\.<\/p>/);
    expect(CSS).toContain('body:not([data-reach="offline"]) .offline-only { display: none; }');
  });

  it("the shell learns it from every request, from the stream, and from the browser — and asks again only while it cannot reach it", () => {
    expect(lift("api")).toContain("await net(path,");
    expect(lift("net")).toMatch(/catch \(e\) \{\s*lost\(\);\s*throw e;/);
    expect(SRC).toContain('if (state === "live") found();');
    expect(SRC).toContain('window.addEventListener("offline", () => lost());');
    expect(SRC).toContain('live.poll("reach", () => { if (offline) probe(); }, PROBE_MS);');
    expect(lift("found")).toContain("drainOutbox();");
    // an app that could only open to the sign-in wall opens properly once the console answers
    expect(lift("found")).toContain("if (walled) return location.reload();");
    expect(SRC).toContain("} catch { walled = offline; showAuth(); }");
  });

  it("a 401 forgets the reads the worker kept", () => {
    expect(lift("api")).toContain("forgetReads(); showAuth();");
    expect(lift("forgetReads")).toContain("caches.delete(READS_CACHE)");
  });
});

describe("holding what is not offered", () => {
  function shell(els: Record<string, unknown>[]) {
    const state = { offline: false };
    const hold = new Function("document", "state", `let offline; ${lift("holdControls")}\nreturn () => { offline = state.offline; holdControls(); };`)(
      { querySelectorAll: () => els },
      state,
    ) as () => void;
    return { state, hold };
  }
  const el = (disabled = false) => {
    const attrs: Record<string, string> = {};
    return { disabled, dataset: {} as Record<string, string>, attrs, setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; } };
  };

  it("offline, each is disabled and pointed at the band's reason; back, only what the shell held is given back", () => {
    const answer = el();
    const alreadyOff = el(true); // a view disabled it for its own reason (a row being answered)
    const { state, hold } = shell([answer, alreadyOff]);
    state.offline = true;
    hold();
    expect(answer).toMatchObject({ disabled: true, attrs: { "aria-describedby": "offline-title" } });
    expect(alreadyOff.disabled).toBe(true);
    state.offline = false;
    hold();
    expect(answer.disabled).toBe(false);
    expect(answer.attrs).toEqual({});
    expect(alreadyOff.disabled).toBe(true);
  });

  it("a view that repaints while offline is held again as it lands", () => {
    expect(SRC).toContain("new MutationObserver(() => { if (offline) holdControls(); }).observe(document.body, { childList: true, subtree: true });");
  });
});

// ---------------------------------------------------------------------------
// Today: a tick waits with the line it saw
// ---------------------------------------------------------------------------

describe("Today offline: a tick waits", () => {
  const FIXTURE = fixture<Record<string, unknown>>("get-api-today");
  function mount({ offline = true, write }: { offline?: boolean; write?: (c: Call) => { status?: number; body: unknown } } = {}) {
    const b = fakeBrowser({
      respond: (c) => {
        if (c.method !== "GET") return write ? write(c) : { body: { ok: true } };
        if (c.path === "/api/today") return { body: structuredClone(FIXTURE.body) };
        if (c.path.startsWith("/api/knowledge/page")) return { status: 404, body: {} };
        return { body: { rows: [] } };
      },
    });
    const replay = { answer: (): Response => res(200, { ok: true }) };
    let view: ReturnType<typeof mountToday> | null = null;
    const box = createOutbox({ store: memoryStore(), send: async () => replay.answer(), onResult: (r) => view!.replayed(r) });
    const off = offline;
    view = mountToday({ $: b.$, api: b.api, show: () => {}, outbox: box, offline: () => off });
    return { b, box, view, replay };
  }
  const tick = (b: ReturnType<typeof fakeBrowser>, checked = true) => b.$("today").fire("change", { target: control({ act: "tick", key: "mt-7f3k2a" }, { checked }) });

  it("offline, nothing is sent; the tick waits with its key and the line it saw, and the row says so", async () => {
    const { b, box, view } = mount();
    await view.load();
    await tick(b);
    expect(b.writes()).toEqual([]);
    const [e] = box.waiting("tick");
    expect(e).toMatchObject({ path: "/api/vault-tasks/mt-7f3k2a/check", meta: { task_key: "mt-7f3k2a", checked: true, seen_text: "Send Dana the fixture format" } });
    expect(e!.headers["idempotency-key"]).toMatch(/^tick-.{8,}/);
    expect(JSON.parse(e!.body as string)).toEqual({ checked: true, seen_text: "Send Dana the fixture format" });
    const html = b.$("today-spine").innerHTML;
    expect(html).toContain("Waiting to send — ticked here, written to your note when Metistry is back.");
    expect(html).toMatch(/data-act="tick" data-key="mt-7f3k2a" checked disabled>/); // holds what it will write, and cannot be ticked twice
  });

  it("a tick whose fetch fails waits with the key that attempt already carried", async () => {
    const { b, box, view } = mount({ offline: false, write: () => { throw new TypeError("Failed to fetch"); } });
    await view.load();
    await tick(b);
    const attempt = b.writes()[0]!;
    expect(box.waiting("tick")[0]!.headers["idempotency-key"]).toBe(attempt.headers["idempotency-key"]);
  });

  it("Don't Send takes it back, and the box is as the note has it", async () => {
    const { b, box, view } = mount();
    await view.load();
    await tick(b);
    await b.$("today").fire("click", { target: control({ act: "unqueue", id: box.waiting()[0]!.id }) });
    expect(box.size).toBe(0);
    expect(b.$("today-spine").innerHTML).not.toContain("Waiting to send");
  });

  it("replayed: sent is the live tick's receipt; a 409 shows the line as it stands", async () => {
    const { b, box, view, replay } = mount();
    await view.load();
    await tick(b);
    await box.drain();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.$("today-spine").innerHTML).toContain('Ticked in <span class="mono">Journal/2026-09-28.md</span>');
    await view.load(); // a new look
    await tick(b);
    replay.answer = () => res(409, { reason: "stale", line: "- [ ] Send Dana the new format ^mt-7f3k2a", task: { checked: false, text: "Send Dana the new format" } });
    await box.drain();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.$("today-spine").innerHTML).toContain("This line changed in your note since it was shown. Nothing was written.");
    expect(b.$("today-spine").innerHTML).toContain("Send Dana the new format ^mt-7f3k2a");
  });

  it("Defer is not offered offline: nothing is sent, and it never waits", async () => {
    const { b, box, view } = mount();
    await view.load();
    await b.$("today").fire("click", { target: control({ act: "defer-to", key: "mt-7f3k2a", when: "tomorrow" }) });
    expect(b.writes()).toEqual([]);
    expect(box.size).toBe(0);
    expect(taskHtml({ type: "task", key: "k", row: { text: "x" } }, { n: 0, deferring: true })).toMatch(/data-act="defer-to"[^>]*data-needs-connection/);
  });

  it("the waiting note names what it will do and offers Don't Send", () => {
    expect(noteHtml("mt-1", { kind: "waiting", checked: false, id: "undo-1" })).toBe(
      '<p class="receipt waiting" role="status">Waiting to send — reopened here, written to your note when Metistry is back. <button type="button" class="link" data-act="unqueue" data-id="undo-1">Don\'t Send</button></p>',
    );
  });
});

// ---------------------------------------------------------------------------
// Capture and Chat, in the shell
// ---------------------------------------------------------------------------

describe("Capture waits; Chat is refused", () => {
  it("a capture mints its key before the first attempt and waits with it when the console does not answer", () => {
    const form = /\$\("capture-form"\)\.onsubmit = async[\s\S]*?\n\};/.exec(SRC)![0];
    expect(form.indexOf('newKey("capture")')).toBeLessThan(form.indexOf("net(\"/capture\""));
    expect(form).toContain('"idempotency-key": key');
    expect(form).toContain('outbox.add({ path: "/capture", ...req,');
    expect(form).toContain("Waiting to send — it goes to your inbox when Metistry is back.");
  });

  it("a message offline is refused with the reason, never queued, and the draft stays with Try Again", () => {
    const send = /\$\("send-form"\)\.onsubmit = async[\s\S]*?\n\};/.exec(SRC)![0];
    expect(send).toContain('if (offline) return refuseSend("Metistry can\'t be reached.");');
    expect(send).not.toMatch(/outbox/);
    expect(lift("refuseSend")).toContain("Your message is still here.");
    expect(lift("refuseSend")).not.toMatch(/send-text"\)\.value = ""/);
    expect(HTML).toMatch(/<p id="send-refused" class="offline-note" role="status" hidden><span id="send-refused-text"><\/span> <button type="button" id="send-retry" class="secondary">Try Again<\/button><\/p>/);
  });
});

// ---------------------------------------------------------------------------
// The service worker: the offline shell and the last reads
// ---------------------------------------------------------------------------

const ORIGIN = "https://metistry.test";
interface Req { method: string; url: string; mode?: string }

/** sw.js in a fake worker scope: caches in memory, a network that is up or down. */
function worker({ net = (r: Req) => new Response(`network ${r.url}`, { status: 200 }) as Response } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (r: Req | string) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const cache = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      add: async (u: string) => { m.set(keyOf(u), new Response(`installed ${u}`)); },
      put: async (r: Req, res: Response) => { m.set(keyOf(r), res); },
      match: async (r: Req | string) => m.get(keyOf(r))?.clone(),
    };
  };
  const state = { online: true };
  const fakeCaches = {
    open: async (n: string) => cache(n),
    match: async (r: Req | string, o: { cacheName: string }) => cache(o.cacheName).match(r),
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const scope = { addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; }, location: { origin: ORIGIN }, skipWaiting() {}, clients: { claim() {} } };
  const fetch = async (r: Req) => {
    if (!state.online) throw new TypeError("Failed to fetch");
    return net(r);
  };
  new Function("self", "caches", "fetch", "clients", SW)(scope, fakeCaches, fetch, {});
  return {
    state,
    stores,
    listeners,
    async dispatch(path: string, { method = "GET", mode = "cors", origin = ORIGIN } = {}): Promise<Response | null> {
      let answered: Promise<Response> | null = null;
      listeners.fetch!({ request: { method, url: new URL(path, origin).href, mode }, respondWith: (p: Promise<Response>) => { answered = p; } });
      return answered ? await answered : null;
    },
    async install() {
      let done: Promise<unknown> = Promise.resolve();
      listeners.install!({ waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    },
  };
}

describe("the service worker", () => {
  it("never stands in front of the stream, nor sign-in, nor another origin", async () => {
    const w = worker();
    expect(await w.dispatch(EVENTS_PATH)).toBeNull();
    expect(await w.dispatch("/auth/login/start")).toBeNull();
    expect(await w.dispatch("/api/today", { origin: "https://elsewhere.test" })).toBeNull();
  });

  it("shares its names with offline.js and live.js", () => {
    expect(SW).toContain(`const READS_CACHE = "${READS_CACHE}";`);
    expect(SW).toContain(`const OFFLINE_HEADER = "${OFFLINE_HEADER}";`);
    expect(SW).toContain(`const READ_AT_HEADER = "${READ_AT_HEADER}";`);
    expect(SW).toContain(`const EVENTS_PATH = "${EVENTS_PATH}";`);
  });

  it("a read goes to the network and is kept, stamped; with no network the kept one answers, marked — the last view", async () => {
    const w = worker({ net: () => new Response(JSON.stringify({ date: "2026-09-28" }), { status: 200, headers: { "content-type": "application/json" } }) });
    const live = (await w.dispatch("/api/today"))!;
    expect(live.headers.get(OFFLINE_HEADER)).toBeNull();
    expect(await live.json()).toEqual({ date: "2026-09-28" });
    w.state.online = false;
    const kept = (await w.dispatch("/api/today"))!;
    expect(kept.headers.get(OFFLINE_HEADER)).toBe("1");
    expect(readAt(kept)).not.toBeNull();
    expect(unreached(kept)).toBe(true);
    expect(await kept.json()).toEqual({ date: "2026-09-28" });
  });

  it("never read and not reachable is a network error, not a made-up answer", async () => {
    const w = worker();
    w.state.online = false;
    expect((await w.dispatch("/api/today"))!.type).toBe("error");
  });

  it("keeps no refusal and nothing the console marks no-store", async () => {
    const w = worker({ net: (r) => (r.url.endsWith("raw") ? new Response("x", { status: 200, headers: { "cache-control": "no-store" } }) : new Response("{}", { status: 401 })) });
    await w.dispatch("/api/artifacts/1/versions/2/file?raw");
    await w.dispatch("/api/today");
    expect([...(w.stores.get(READS_CACHE)?.keys() ?? [])]).toEqual([]);
  });

  it("the shell opens with no network: installed at install, the page for any navigation", async () => {
    const w = worker();
    await w.install();
    w.state.online = false;
    expect(await (await w.dispatch("/app.js"))!.text()).toBe("installed /app.js");
    expect(await (await w.dispatch("/offline.js"))!.text()).toBe("installed /offline.js");
    expect(await (await w.dispatch("/anything", { mode: "navigate" }))!.text()).toBe("installed /");
  });

  it("installs every file the page loads, so none is missing offline", () => {
    const shell = /const SHELL = \[([\s\S]*?)\];/.exec(SW)![1]!;
    for (const src of [...read("../web/index.html").matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]!)) expect(shell, src).toContain(`"${src}"`);
    for (const m of [...SRC.matchAll(/from "\.\/([a-z-]+\.js)"/g)].map((x) => x[1]!)) expect(shell, m).toContain(`"/${m}"`);
  });

  it("push and a notification's tap are as they were", () => {
    const w = worker();
    expect(Object.keys(w.listeners).sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
  });
});
