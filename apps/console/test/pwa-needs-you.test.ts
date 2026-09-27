// T7-3a — Needs You in the PWA (screen 18 §3; screen 3 §12–§13; design-build-plan
// §2.12, §2.17): the bell's sheet of cards with the type's own answers, Select's
// compact list where swipe right approves and swipe left declines, and questions
// one step at a time.
//
// The ticket's own test is the first block: **a card with Before and after
// cannot be swiped**. It is held twice — by the pure rule the list reads
// (`swipeAnswer`/`swipeResult`, over rows the server's own `withRequestShape`
// builds), and by mounting the view on a fake browser and dragging a finger
// across the row: nothing is sent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRequest, REQUEST_KINDS } from "@foldedspacelabs/metistry-core";
import { withRequestShape } from "../src/server.js";
import {
  answersBody,
  backStep,
  canSend,
  cardHtml,
  choose,
  choosingSends,
  groupRows,
  isAnswered,
  leftToAnswer,
  mountNeedsYou,
  nextStep,
  questionsHtml,
  questionsOf,
  receiptText,
  rowHtml,
  swipeAnswer,
  swipeResult,
  writeOther,
} from "../web/needs-you.js";
import { control, fakeBrowser, FakeEl, target } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const CSS = read("../web/style.css");
const WEB = ["app.js", "lib.js", "needs-you.js", "today.js", "index.html", "style.css"].map((f) => read(`../web/${f}`)).join("\n");

let nextId = 100;
const served = (kind: string, payload: Record<string, unknown> = {}, ts = "2026-09-27T08:00:00.000Z") =>
  withRequestShape({ id: nextId++, ts, kind, source_agent: "collator", trust: "internal", payload, decision: "pending" });

/** Every stored kind whose served reading draws Before and after — access, improvement, and a review that names the body. */
const BEFORE_AFTER = [
  served("access_request", { area: "Areas/Finance", current_tier: "index" }),
  served("grant_elevation", { area: "Areas/Health" }),
  served("improvement", { body: { kind: "before_after", before: { label: "Now", text: "a" }, after: { label: "After", text: "b" } }, edit: { path: "Me/profile.md" } }),
  served("review", { body: { kind: "before_after", before: { text: "mine" }, after: { text: "the fold's" } } }),
];

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// A card with Before and after cannot be swiped
// ---------------------------------------------------------------------------

describe("a card with Before and after cannot be swiped (screen 18 §3)", () => {
  it("every kind the table draws as Before and after is covered here", () => {
    const drawn = REQUEST_KINDS.filter((k) => describeRequest(k, {}).body === "before_after");
    expect(drawn.sort()).toEqual(["access_request", "grant_elevation", "improvement"]);
    for (const p of BEFORE_AFTER) expect(p.request.body, p.kind).toBe("before_after");
  });

  for (const p of BEFORE_AFTER) {
    it(`${p.kind}: neither way, at any distance — its consequence needs reading`, () => {
      expect(swipeAnswer(p, "right")).toBeNull();
      expect(swipeAnswer(p, "left")).toBeNull();
      for (const dx of [40, 200, 5000, -40, -200, -5000]) expect(swipeResult(p, dx, 390), String(dx)).toBeNull();
      // its line names no way to swipe, and a tap on it opens the card instead
      const row = rowHtml(p, { selecting: true });
      expect(row).toMatch(/<li class="req-row" data-id="\d+" data-swipe="">/);
      expect(row).toMatch(/<button type="button" class="req-open" data-act="open" data-id="\d+">/);
    });
  }

  it("a finger dragged across one, all the way, sends nothing; the same drag on an action approves it", async () => {
    const ba = BEFORE_AFTER[0]!;
    const action = served("action", { action: { kind: "comment", args: { ref: "gh:o/r#4", body: "LGTM" } } });
    const b = fakeBrowser({ wide: true, respond: (c) => (c.method === "GET" ? { body: { proposals: [ba, action] } } : { body: { ok: true } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    await view.load();
    const list = b.$("proposal-list");

    const drag = async (p: { id: number }, dx: number, pointerType = "touch") => {
      const slide = new FakeEl();
      const li = new FakeEl();
      li.dataset = { id: String(p.id) };
      li.querySelector = (() => slide) as FakeEl["querySelector"];
      const on = target({ ".req-row": li });
      await list.fire("pointerdown", { pointerType, target: on, clientX: 20, clientY: 300, pointerId: 7 });
      for (const x of [30, 20 + dx / 2, 20 + dx]) await list.fire("pointermove", { pointerId: 7, clientX: x, clientY: 302 });
      const during = slide.style.transform;
      await list.fire("pointerup", { pointerId: 7 });
      return { during, after: slide.style.transform, li };
    };

    const right = await drag(ba, 360);
    expect(right.during).toBe("translateX(16px)"); // it resists, and barely moves
    expect(right.after).toBe("");
    expect(right.li.dataset.dir).toBe("");
    await drag(ba, -360);
    expect(b.writes()).toEqual([]);

    await drag(action, 360);
    expect(b.writes()).toHaveLength(1);
    expect(b.writes()[0]).toMatchObject({ path: `/api/proposals/${action.id}`, method: "POST", body: { decision: "allow", if_unchanged: { seen_at: action.ts } } });
  });
});

// ---------------------------------------------------------------------------
// Swipe right approves, swipe left declines — only where that is a decision on the row
// ---------------------------------------------------------------------------

describe("swipe: right approves, left declines", () => {
  it("an action, a note: right is Approve, left is Decline", () => {
    for (const p of [served("action", { action: { kind: "capture", args: {} } }), served("knowledge", { summary: "x" })]) {
      expect(swipeAnswer(p, "right")).toMatchObject({ label: "Approve", sends: { decision: "allow" } });
      expect(swipeAnswer(p, "left")).toMatchObject({ label: "Decline", sends: { decision: "deny" } });
    }
  });

  it("a suggestion's Approve makes the task, so the swipe sends what Approve sends", () => {
    const p = served("knowledge", { suggested_work: { title: "Write it up" } });
    expect(swipeResult(p, 300, 390)).toMatchObject({ dir: "right", answer: { sends: { decision: "accept_as_work" } } });
  });

  it("a report has no Approve to swipe to; left is its own Dismiss", () => {
    const p = served("report", { summary: "the fold finished" });
    expect(swipeAnswer(p, "right")).toBeNull();
    expect(swipeAnswer(p, "left")).toMatchObject({ label: "Dismiss", sends: { decision: "skip" } });
  });

  it("a question is answered by choosing, never by a swipe; a pull request's answers post to GitHub", () => {
    for (const p of [served("decision", { title: "Which?", options: ["a", "b"] }), served("pull_request", { repo: "o/r", number: 4 })]) {
      expect(swipeAnswer(p, "right"), p.kind).toBeNull();
      expect(swipeAnswer(p, "left"), p.kind).toBeNull();
    }
  });

  it("a row the server did not read cannot be swiped at all", () => {
    const p = { id: 1, ts: "2026-09-27T08:00:00.000Z", kind: "knowledge", payload: {} };
    expect(swipeAnswer(p, "right")).toBeNull();
    expect(swipeAnswer(p, "left")).toBeNull();
  });

  it("a short swipe is not a swipe", () => {
    const p = served("knowledge", {});
    expect(swipeResult(p, 60, 390)).toBeNull(); // under 88px
    expect(swipeResult(p, 120, 390)).toBeNull(); // under 35% of the row
    expect(swipeResult(p, 140, 390)).toMatchObject({ dir: "right" });
    expect(swipeResult(p, -140, 390)).toMatchObject({ dir: "left" });
    expect(swipeResult(p, 0, 390)).toBeNull();
  });

  it("a pointer drag never answers — touch and pen only", async () => {
    const p = served("knowledge", {});
    const b = fakeBrowser({ wide: true, respond: (c) => (c.method === "GET" ? { body: { proposals: [p] } } : { body: { ok: true } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    await view.load();
    const li = new FakeEl();
    li.dataset = { id: String(p.id) };
    li.querySelector = (() => new FakeEl()) as FakeEl["querySelector"];
    const list = b.$("proposal-list");
    await list.fire("pointerdown", { pointerType: "mouse", target: target({ ".req-row": li }), clientX: 0, clientY: 0, pointerId: 1 });
    await list.fire("pointermove", { pointerId: 1, clientX: 380, clientY: 0 });
    await list.fire("pointerup", { pointerId: 1 });
    expect(b.writes()).toEqual([]);
  });

  it("a vertical drag is a scroll, and answers nothing", async () => {
    const p = served("knowledge", {});
    const b = fakeBrowser({ wide: true, respond: (c) => (c.method === "GET" ? { body: { proposals: [p] } } : { body: { ok: true } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    await view.load();
    const li = new FakeEl();
    li.dataset = { id: String(p.id) };
    li.querySelector = (() => new FakeEl()) as FakeEl["querySelector"];
    const list = b.$("proposal-list");
    await list.fire("pointerdown", { pointerType: "touch", target: target({ ".req-row": li }), clientX: 0, clientY: 0, pointerId: 2 });
    await list.fire("pointermove", { pointerId: 2, clientX: 30, clientY: 200 });
    await list.fire("pointermove", { pointerId: 2, clientX: 380, clientY: 210 });
    await list.fire("pointerup", { pointerId: 2 });
    expect(b.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The card: the type's answers, in C92's order, Decline never red
// ---------------------------------------------------------------------------

describe("the card answers with its type's own verbs (C92, §2.12)", () => {
  const buttons = (html: string) => [...html.matchAll(/<button type="button" class="answer ([a-z ]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)</g)].map((m) => [m[1], m[2]]);

  it("the primary · Revise · Decline, then Later — Approve the one accent fill", () => {
    expect(buttons(cardHtml(served("knowledge", { summary: "x" })))).toEqual([
      ["primary", "Approve"], ["revise", "Revise"], ["decline", "Decline"], ["later", "Later"],
    ]);
  });

  it("a report offers what its type offers: Dismiss, then Later — no Approve it never had", () => {
    expect(buttons(cardHtml(served("report", { summary: "x" })))).toEqual([["decline", "Dismiss"], ["later", "Later"]]);
  });

  it("an answer through another system's door is not offered from the phone yet — the card still says what it is", () => {
    const html = cardHtml(served("pull_request", { repo: "o/r", number: 41, url: "https://github.com/o/r/pull/41", summary: "tidy" }));
    expect(buttons(html)).toEqual([["later", "Later"]]);
    expect(html).toContain("o/r#41");
    expect(html).toContain('<a href="https://github.com/o/r/pull/41" target="_blank" rel="noopener">Open on GitHub</a>');
    // only a github.com url becomes a link
    expect(cardHtml(served("pull_request", { url: "javascript:alert(1)" }))).not.toContain("<a ");
  });

  it("an access request's Before and after: what it holds now, and what Approve adds", () => {
    const html = cardHtml(BEFORE_AFTER[0]!);
    expect(html).toMatch(/<span class="ba-label">Now<\/span><p>titles<\/p>/);
    expect(html).toMatch(/What Approve Does<\/span><p>Adds <b>Areas\/Finance<\/b>/);
  });

  it("Decline is outlined in the neutral surface, never red — and no red literal is left anywhere", () => {
    const rule = /\.answer\.revise, \.answer\.decline \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toContain("var(--mt-color-surface)");
    expect(rule).toContain("var(--mt-color-border-strong)");
    expect(rule).toContain("var(--mt-color-text-primary)");
    expect(CSS).not.toMatch(/\[data-d="deny"\]/);
    for (const m of CSS.matchAll(/\.answer[^{]*\{([^}]*)\}/g)) expect(m[1], m[0]).not.toMatch(/failed|destructive/);
    expect(WEB).not.toMatch(/#7a3b3b/i);
    expect(WEB).not.toMatch(/style="background:/);
  });

  it("C45: a refused consequence is on the card, in the envelope's own words", () => {
    const html = cardHtml(served("action", { action: { kind: "dispatch", args: {} }, error: { code: "conflict", message: "task 6 is held by nobody" } }));
    expect(html).toContain('<p class="card-error">Last try refused — task 6 is held by nobody</p>');
  });

  it("every agent-authored field is output-encoded (CRIT-7)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = cardHtml(withRequestShape({ id: 9, ts: "2026-09-27T08:00:00.000Z", kind: "action", source_agent: evil, trust: "external",
      payload: { title: evil, reason: evil, action: { kind: evil, args: { a: evil } } }, decision: "pending" }));
    expect(html).not.toContain("<img");
    expect(html).toContain('<span class="chip">external</span>');
  });

  it("the queue groups by the table's word, oldest first", () => {
    const later = served("knowledge", {}, "2026-09-27T09:00:00.000Z");
    const earlier = served("knowledge", {}, "2026-09-27T07:00:00.000Z");
    const q = served("decision", { options: ["a", "b"] }, "2026-09-27T08:00:00.000Z");
    expect(groupRows([later, q, earlier]).map(([w, rows]) => [w, rows.map((r) => r.id)])).toEqual([
      ["note", [earlier.id, later.id]], ["question", [q.id]],
    ]);
  });

  it("the receipt says what happened once; Later leaves none", () => {
    expect(receiptText("Approve", "Add the store list")).toBe("Approved — Add the store list");
    expect(receiptText("Dismiss", "Nightly fold")).toBe("Dismissed — Nightly fold");
    expect(receiptText("one file per route", "Which format?")).toBe("Answered “one file per route” — Which format?");
    expect(receiptText("Later", "anything")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Questions, one step at a time (screen 3 §13.2; C109)
// ---------------------------------------------------------------------------

const V2 = {
  title: "Three choices for the fixtures",
  questions: [
    { prompt: "Which format?", options: ["one file per route", "one file per store"] },
    { prompt: "Which stores first?", options: ["Today", "Needs You", "Board"], multi: true },
    { prompt: "Anything else?", options: ["no"], allow_other: true },
  ],
};

describe("questions come one at a time", () => {
  it("v1 is one question: the title and its options, answered by the option itself", () => {
    const qs = questionsOf(served("decision", { title: "Which?", options: ["a", "b"] }));
    expect(qs).toEqual([{ prompt: "Which?", options: ["a", "b"], multi: false, other: false, v1: true }]);
    expect(choosingSends(qs)).toBe(true);
    expect(answersBody(qs, [{ chosen: ["b"] }])).toEqual({ decision: "b" });
  });

  it("three questions step: Next only from an answered one, Back always, then Your Answers", () => {
    const qs = questionsOf(served("decision", V2));
    expect(qs.map((q) => [q.multi, q.other])).toEqual([[false, false], [true, false], [false, true]]);
    let answers: { chosen?: string[]; other?: string }[] = [];
    expect(nextStep(qs, answers, 0)).toBe(0);
    answers[0] = choose(qs[0]!, undefined, "one file per store");
    expect(nextStep(qs, answers, 0)).toBe(1);
    answers[1] = choose(qs[1]!, undefined, "Today");
    answers[1] = choose(qs[1]!, answers[1], "Board");
    answers[1] = choose(qs[1]!, answers[1], "Today"); // pick any toggles
    expect(answers[1]!.chosen).toEqual(["Board"]);
    expect(leftToAnswer(qs, answers)).toBe(1);
    expect(canSend(qs, answers)).toBe(false);
    answers[2] = writeOther(qs[2]!, choose(qs[2]!, undefined, "no"), "  ship Friday  ");
    expect(answers[2]!.chosen).toEqual([]); // on a pick-one question the words ARE the answer
    expect(isAnswered(qs[2]!, answers[2])).toBe(true);
    expect(nextStep(qs, answers, 2)).toBe(3); // the summary
    expect(backStep(0)).toBe(0);
    expect(canSend(qs, answers)).toBe(true);
    expect(answersBody(qs, answers)).toEqual({
      decision: "answers",
      answers: [{ choices: ["one file per store"] }, { choices: ["Board"] }, { choices: [], other: "ship Friday" }],
    });
    answers = [];
    expect(answersBody(qs, answers).answers).toHaveLength(3);
  });

  it("draws Question 2 of 3 with its bar, the summary with Edit, and Revise and Decline under every step", () => {
    const p = served("decision", V2);
    const step2 = questionsHtml(p, { step: 1, answers: [{ chosen: ["one file per route"] }] });
    expect(step2).toContain("Question 2 of 3");
    expect(step2).toMatch(/<div class="q-bar" aria-hidden="true"><span class="done"><\/span><span class="on"><\/span><span class=""><\/span><\/div>/);
    expect(step2).toMatch(/<legend>Which stores first\?<\/legend>/);
    expect(step2).toMatch(/type="checkbox" name="q-\d+-1"/);
    expect(step2).toMatch(/data-act="next"[^>]* disabled>Next/);
    const summary = questionsHtml(p, { step: 3, answers: [{ chosen: ["a"] }, { chosen: ["b"] }] });
    expect(summary).toContain("Your Answers");
    expect(summary).toContain("1 left to answer");
    expect(summary).toMatch(/data-act="send-answers"[^>]* disabled>/);
    expect((summary.match(/data-act="edit"/g) ?? []).length).toBe(3);
    const card = cardHtml(p, { step: 1 });
    expect(card).toMatch(/class="answer revise"[\s\S]*class="answer decline"/);
    expect(card).not.toMatch(/class="answer primary"[^>]*data-act="primary"/); // Send Answers lives in the steps
  });

  it("a three-question request round-trips through the mounted view", async () => {
    const p = served("decision", V2);
    const b = fakeBrowser({ respond: (c) => (c.method === "GET" ? { body: { proposals: [p] } } : { body: { ok: true } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    await view.load();
    const triage = b.$("triage");
    const id = String(p.id);
    const pick = (q: number, o: number) => triage.fire("change", { target: control({ act: "pick", id, q: String(q), o: String(o) }) });
    const click = (act: string, more: Record<string, string> = {}) => triage.fire("click", { target: control({ act, id, ...more }) });
    await pick(0, 1);
    await click("next");
    expect(b.$("proposal-list").innerHTML).toContain("Question 2 of 3");
    await pick(1, 0);
    await pick(1, 2);
    await click("next");
    await triage.fire("input", { target: control({ act: "other", id, q: "2" }, { value: "and the Board after" }) });
    await click("next");
    expect(b.$("proposal-list").innerHTML).toContain("Your Answers");
    await click("send-answers");
    expect(b.writes()).toEqual([{
      path: `/api/proposals/${p.id}`, method: "POST", headers: {},
      body: {
        decision: "answers",
        answers: [{ choices: ["one file per store"] }, { choices: ["Today", "Board"] }, { choices: [], other: "and the Board after" }],
        if_unchanged: { seen_at: p.ts },
      },
    }]);
  });

  it("a single v1 question: choosing sends the option", async () => {
    const p = served("decision", { title: "Which fixture format?", options: ["one file per route", "one file per store"] });
    const b = fakeBrowser({ respond: (c) => (c.method === "GET" ? { body: { proposals: [p] } } : { body: { ok: true } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    await view.load();
    expect(b.$("proposal-list").innerHTML).toMatch(/<button type="button" class="q-option" data-act="choose"[^>]*>one file per store<\/button>/);
    await b.$("triage").fire("click", { target: control({ act: "choose", id: String(p.id), q: "0", o: "1" }) });
    expect(b.writes()[0]).toMatchObject({ body: { decision: "one file per store" } });
    expect(b.$("triage-receipt").textContent).toBe("Answered “one file per store” — Which fixture format?");
  });
});

// ---------------------------------------------------------------------------
// Revise, stale, and the empty state
// ---------------------------------------------------------------------------

describe("answering from the mounted view", () => {
  const mount = (rows: unknown[], answer: (c: { path: string; body: unknown }) => { status?: number; body: unknown } = () => ({ body: { ok: true } })) => {
    const b = fakeBrowser({ respond: (c) => (c.method === "GET" ? { body: { proposals: rows } } : answer(c)) });
    return { b, view: mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} }) };
  };
  const reviseForm = (id: number, value: string) => {
    const form = new FakeEl();
    form.dataset = { id: String(id) };
    Object.assign(form, { elements: { text: { value } } });
    form.closest = ((sel: string) => (sel === ".revise-form" ? form : null)) as FakeEl["closest"];
    return form;
  };

  it("Revise carries the owner's words; an empty reason cancels rather than sends", async () => {
    const p = served("knowledge", { summary: "x" });
    const { b, view } = mount([p]);
    await view.load();
    await b.$("triage").fire("click", { target: control({ act: "revise", id: String(p.id) }) });
    expect(b.$("proposal-list").innerHTML).toContain("What should change?");
    await b.$("triage").fire("submit", { target: reviseForm(p.id, "   "), preventDefault() {} });
    expect(b.writes()).toEqual([]);
    await b.$("triage").fire("click", { target: control({ act: "revise", id: String(p.id) }) });
    await b.$("triage").fire("submit", { target: reviseForm(p.id, "shorter, please"), preventDefault() {} });
    expect(b.writes()[0]).toMatchObject({ body: { decision: "accept_with_changes", feedback: "shorter, please" } });
  });

  it("on an access request, Revise asks for the narrower folder, pre-filled with the ask (C40)", async () => {
    const p = BEFORE_AFTER[0]!;
    const { b, view } = mount([p]);
    await view.load();
    await b.$("triage").fire("click", { target: control({ act: "revise", id: String(p.id) }) });
    expect(b.$("proposal-list").innerHTML).toMatch(/Grant which folder instead\?<input type="text" name="text" value="Areas\/Finance"/);
    await b.$("triage").fire("submit", { target: reviseForm(p.id, "Areas/Finance/Taxes"), preventDefault() {} });
    expect(b.writes()[0]).toMatchObject({ body: { decision: "accept_with_changes", area: "Areas/Finance/Taxes" } });
  });

  it("stale: nothing was sent, and the card below is the current version", async () => {
    const p = served("action", { action: { kind: "capture", args: {} } });
    const { b, view } = mount([p], () => ({ status: 409, body: { error: { code: "conflict" }, reason: "stale", proposal: p } }));
    await view.load();
    await b.$("triage").fire("click", { target: control({ act: "primary", id: String(p.id) }) });
    const html = b.$("proposal-list").innerHTML;
    expect(html).toContain('<article class="card stale"');
    expect(html).toContain("This moved while the card was open, so nothing was sent.");
  });

  it("a refusal stays on its card in the envelope's words", async () => {
    const p = served("knowledge", {});
    const { b, view } = mount([p], () => ({ status: 400, body: { error: { code: "invalid_request", message: "decision not offered" } } }));
    await view.load();
    await b.$("triage").fire("click", { target: control({ act: "decline", id: String(p.id) }) });
    expect(b.$("proposal-list").innerHTML).toContain("Not sent — decision not offered");
  });

  it("nothing waiting: Nothing needs you, with Back to Today; the count goes to the bell", async () => {
    let count: unknown;
    const shown: string[] = [];
    const b = fakeBrowser({ respond: () => ({ body: { proposals: [] } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: (n: unknown) => { count = n; }, show: (v: string) => { shown.push(v); } });
    await view.load();
    expect(count).toBe(0);
    expect(b.$("triage-empty").hidden).toBe(false);
    expect(b.$("triage-tools").hidden).toBe(true);
    await b.$("triage").fire("click", { target: control({ act: "today" }) });
    expect(shown).toEqual(["today"]);
  });

  it("from 600px the list comes first and a tap pushes the card; under it the sheet holds the cards", async () => {
    const p = served("knowledge", { summary: "x" });
    const narrow = mount([p]);
    await narrow.view.load();
    expect(narrow.b.$("triage").dataset.mode).toBe("cards");
    const b = fakeBrowser({ wide: true, respond: () => ({ body: { proposals: [p] } }) });
    const view = mountNeedsYou({ $: b.$, api: b.api, setNeeds: () => {}, show: () => {} });
    await view.load();
    expect(b.$("triage").dataset.mode).toBe("list");
    expect(b.$("proposal-list").innerHTML).toContain('class="req-row"');
    // at 900px (every min-width matches here) a request is always open beside the list
    expect(b.$("triage-detail").hidden).toBe(false);
    expect(b.$("triage-detail").innerHTML).toContain(`data-card="${p.id}"`);
  });
});
