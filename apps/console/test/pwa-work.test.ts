// T7-3b — Work in the PWA (screen 18 §5; screen 6 the board, 13 projects, 14 the
// card, 16 artifacts and rooms; design-build-plan §2.17): Board one column at a
// time with Move to…, every tap opening the card, Projects, and an artifact's
// threads as counts on their lines.
//
// The ticket's own test is the first block: **an illegal move is listed
// disabled with its reason**. It is held three ways — by the pure rule the
// sheet reads (`movesFor`, over the recorded `board` rows), against a model of
// the statements in packages/tasks (so the list offers no move the service
// would refuse, and refuses none it would take), and by mounting the view on a
// fake browser and pressing the disabled row: nothing is sent.
//
// Built first against the recorded contract (U9): the `board`, `/api/projects`
// and artifact fixtures F-7 froze (apps/macos/tests/kit/fixtures).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotatedMarkdownHtml,
  annotatedTextHtml,
  artifactRoute,
  boardChipsHtml,
  boardColumnsHtml,
  boardHome,
  boardRoute,
  boardTotals,
  cardHtml,
  commentCount,
  dropsFor,
  escalationLabel,
  modeChipHtml,
  mountWork,
  moveListHtml,
  movesFor,
  otherThreadsHtml,
  projectRowHtml,
  roomRoute,
  threadSheetHtml,
  threadsByLine,
} from "../web/work.js";
import { control, fakeBrowser, target, type Call } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const fixture = <T>(name: string) => JSON.parse(read(`../../macos/tests/kit/fixtures/${name}.json`)) as { request: { path: string }; body: T };

type Card = Record<string, unknown> & { id: string; column: string; status: string; owner: string | null; claimed_by: string | null };
const BOARD = fixture<{ rows: Card[]; as_of: string }>("get-api-q-board");
const PROJECTS = fixture<{ projects: Record<string, unknown>[] }>("get-api-projects");
const COMMENTS = fixture<{ threads: Record<string, unknown>[] }>("get-api-artifacts-id-comments");
const FILE = fixture<{ path: string; content: string }>("get-api-artifacts-id-versions-version-file");
// the recorded review card waiting on its owner — found by its column, not its id,
// which moves whenever the recorder seeds another task ahead of it (X-29)
const ASSIGNED = BOARD.body.rows.find((r) => r.column === "assigned")!.id;
const cardOf = (id: string, patch: Partial<Card> = {}): Card => ({ ...structuredClone(BOARD.body.rows.find((r) => r.id === id)!), ...patch });

afterEach(() => vi.unstubAllGlobals());

/** The rows of a Move to… list: its column, whether it is a door, and what it says. */
function listed(card: Card) {
  return [...moveListHtml(card).matchAll(/<li><button type="button" class="row move"( data-act="move")? data-column="([a-z_]+)"(?: data-needs-connection)?( disabled)?><span class="label">([^<]*)<\/span><span class="sub( why)?">([^<]*)<\/span><\/button><\/li>/g)]
    .map((m) => ({ column: m[2], door: Boolean(m[1]), disabled: Boolean(m[3]), label: m[4], says: m[6], why: Boolean(m[5]) }));
}

// ---------------------------------------------------------------------------
// An illegal move is listed disabled with its reason
// ---------------------------------------------------------------------------

describe("an illegal move is listed disabled with its reason (screen 18 §5)", () => {
  it("the fixture is the recorded `board` this view reads, one card in every column", () => {
    expect(BOARD.request.path).toMatch(/^\/api\/q\/board/);
    expect(new Set(BOARD.body.rows.map((r) => r.column))).toEqual(new Set(["backlog", "assigned", "in_progress", "blocked", "done"]));
    expect(read("../web/work.js")).toContain('q("board", { project, limit: BOARD_LIMIT })');
  });

  it("every other column is listed — the legal ones as doors, the rest disabled, never missing", () => {
    for (const card of BOARD.body.rows) {
      const rows = listed(card);
      expect(rows.map((r) => r.column), card.id).toEqual(["backlog", "assigned", "in_progress", "blocked", "done"].filter((c) => c !== card.column));
      for (const r of rows) {
        expect(r.door, `${card.id} → ${r.column}`).toBe(!r.disabled); // a disabled row carries no data-act: it is not a door
        expect(r.why, `${card.id} → ${r.column}`).toBe(r.disabled); // and it says why, in words
        expect(r.says.length).toBeGreaterThan(8);
      }
    }
  });

  it("Backlog: assign it or claim it; Blocked and Done say why not", () => {
    expect(listed(cardOf("1"))).toEqual([
      { column: "assigned", door: true, disabled: false, label: "Assigned to…", says: "pick who it is for", why: false },
      { column: "in_progress", door: true, disabled: false, label: "In Progress", says: "you claim it", why: false },
      { column: "blocked", door: false, disabled: true, label: "Blocked", says: "a card is marked blocked from its work, never moved there", why: true },
      { column: "done", door: false, disabled: true, label: "Done", says: "only the one holding a card closes it — claim it first", why: true },
    ]);
  });

  it("Assigned: clear the name or claim it", () => {
    const rows = listed(cardOf(ASSIGNED));
    expect(rows.find((r) => r.column === "backlog")).toMatchObject({ door: true, says: "clears cursor's name" });
    expect(rows.find((r) => r.column === "in_progress")).toMatchObject({ door: true, says: "you claim it" });
    expect(rows.filter((r) => r.disabled).map((r) => r.column)).toEqual(["blocked", "done"]);
  });

  it("In Progress under someone else's lease: nothing — nobody moves a card off another's claim", () => {
    const rows = listed(cardOf("2"));
    expect(rows.every((r) => r.disabled)).toBe(true);
    expect(rows.find((r) => r.column === "backlog")!.says).toBe("target:github-issues holds it — only the holder hands a card back");
    expect(rows.find((r) => r.column === "done")!.says).toBe("target:github-issues holds it — only the one holding a card closes it");
  });

  it("In Progress under your own claim: hand it back to where it lands, or close it — and the other column says where it would land", () => {
    const rows = listed(cardOf("2", { claimed_by: "user", owner: null }));
    expect(rows.find((r) => r.column === "backlog")).toMatchObject({ door: true, says: "hands it back — releases your claim" });
    expect(rows.find((r) => r.column === "assigned")).toMatchObject({ disabled: true, says: "released, nobody's name is on it, so it goes back to Backlog" });
    expect(rows.find((r) => r.column === "done")).toMatchObject({ door: true, says: "closes it" });
    const named = listed(cardOf("2", { claimed_by: "user", owner: "cursor" }));
    expect(named.find((r) => r.column === "assigned")).toMatchObject({ door: true });
    expect(named.find((r) => r.column === "backlog")).toMatchObject({ disabled: true, says: "released, it has cursor's name on it, so it goes back to Assigned" });
  });

  it("Blocked: the unblock, to its home column only; nothing claims it", () => {
    const rows = listed(cardOf("41"));
    expect(rows.find((r) => r.column === "backlog")).toMatchObject({ door: true, says: "unblocks it" });
    expect(rows.find((r) => r.column === "assigned")).toMatchObject({ disabled: true, says: "unblocked, nobody's name is on it, so it goes back to Backlog" });
    expect(rows.find((r) => r.column === "in_progress")).toMatchObject({ disabled: true, says: "nothing claims a blocked card — unblock it first" });
    // a stuck crew's claim comes free with the unblock, and the row says so
    expect(listed(cardOf("41", { claimed_by: "drey-dev" })).find((r) => r.column === "backlog")!.says).toBe("unblocks it — releases drey-dev's claim");
  });

  it("Done: every column disabled — a closed card takes no more changes", () => {
    const rows = listed(cardOf("42"));
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ disabled: true, says: "it is closed — a closed card takes no more changes; make a follow-up instead" });
  });

  it("a card's reasons are escaped: a holder's name is data", () => {
    const html = moveListHtml(cardOf("2", { claimed_by: "<img src=x onerror=alert(1)>" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; holds it");
  });
});

// ---------------------------------------------------------------------------
// The list against the statements: offers no move the service would refuse
// ---------------------------------------------------------------------------

/**
 * What packages/tasks' statements accept, as the owner (`user`), read off
 * their WHERE clauses — claim: unclaimed (or lapsed), open or in progress;
 * release / close: the holder, not closed; the board arm (owner, the unblock):
 * not closed, the unblock from blocked only — and where each lands, by
 * board.yaml's CASE.
 */
function serviceAccepts(c: Card, op: string, now = new Date()): string | null {
  const closed = c.status === "closed";
  const lapsed = typeof c.lease_expires_at === "string" && new Date(c.lease_expires_at) <= now;
  const holder = c.claimed_by;
  const column = (status: string, owner: string | null) => (status === "closed" ? "done" : status === "blocked" ? "blocked" : status === "in_progress" ? "in_progress" : owner ? "assigned" : "backlog");
  if (closed) return null;
  switch (op) {
    case "claim": return ["open", "in_progress"].includes(c.status) && (holder === null || lapsed) ? "in_progress" : null;
    case "release": return holder === "user" ? column("open", c.owner) : null;
    case "close": return holder === "user" ? "done" : null;
    case "unblock": return c.status === "blocked" ? column("open", c.owner) : null;
    case "assign": return column(c.status, "someone");
    case "unassign": return column(c.status, null);
  }
  return null;
}

describe("Move to… offers exactly the moves the service accepts", () => {
  const variants: Card[] = [];
  for (const base of BOARD.body.rows) {
    for (const owner of [null, "cursor", "user"]) {
      for (const holder of [null, "user", "drey-dev"]) {
        if (base.status === "open" && holder) continue; // claim() sets in_progress in the same statement: an open row is never held
        variants.push({ ...structuredClone(base), owner, claimed_by: holder, column: base.status === "open" ? (owner ? "assigned" : "backlog") : base.column });
      }
    }
  }

  it(`across ${variants.length} cards: every door is a statement that succeeds and lands the card in that column`, () => {
    for (const c of variants) {
      for (const m of movesFor(c).filter((x) => x.op)) {
        expect(serviceAccepts(c, m.op!), `${c.column}/${c.owner}/${c.claimed_by} → ${m.column} by ${m.op}`).toBe(m.column);
      }
    }
  });

  it("and every disabled row is a column no single statement would land it in", () => {
    const ops = ["claim", "release", "close", "unblock", "assign", "unassign"];
    for (const c of variants) {
      for (const m of movesFor(c).filter((x) => !x.op)) {
        const reach = ops.filter((op) => serviceAccepts(c, op) === m.column);
        expect(reach, `${c.column}/${c.owner}/${c.claimed_by} → ${m.column}: ${m.why}`).toEqual([]);
      }
    }
  });

  it("a drag draws a target on the same columns, and every move is one route", () => {
    for (const c of variants) expect(Object.keys(dropsFor(c)).sort()).toEqual(movesFor(c).filter((m) => m.op).map((m) => m.column).sort());
    const card = cardOf("1");
    expect(boardRoute("assign", card, { owner: "cursor" })).toEqual(["/api/tasks/1", { method: "PATCH", body: '{"owner":"cursor"}' }]);
    expect(boardRoute("unassign", card, {})).toEqual(["/api/tasks/1", { method: "PATCH", body: '{"owner":null}' }]);
    expect(boardRoute("unblock", card, {})).toEqual(["/api/tasks/1", { method: "PATCH", body: '{"status":"open"}' }]);
    expect(boardRoute("close", card, {})).toEqual(["/api/tasks/1", { method: "PATCH", body: '{"status":"closed"}' }]);
    expect(boardRoute("claim", card, {})).toEqual(["/api/tasks/1/claim", { method: "POST", body: "{}" }]);
    expect(boardRoute("release", card, {})).toEqual(["/api/tasks/1/release", { method: "POST", body: "{}" }]);
    expect(boardHome(cardOf(ASSIGNED))).toBe("assigned");
    expect(boardHome(cardOf("1"))).toBe("backlog");
  });
});

// ---------------------------------------------------------------------------
// Mounted: the sheet, the card, the chips
// ---------------------------------------------------------------------------

const COUNTS = [
  { project: "metistry", column: "backlog", cards: "12", escalations: "0" },
  { project: "metistry", column: "assigned", cards: "5", escalations: "0" },
  { project: "metistry", column: "in_progress", cards: "4", escalations: "1" },
  { project: "metistry", column: "blocked", cards: "2", escalations: "2" },
  { project: "metistry", column: "done", cards: "40", escalations: "0" },
];

function mounted({ respond, wide = false }: { respond?: (c: Call) => { status?: number; body: unknown } | undefined; wide?: boolean } = {}) {
  const rows = structuredClone(BOARD.body.rows);
  const b = fakeBrowser({
    wide,
    respond: (c) => {
      const own = respond?.(c);
      if (own) return own;
      if (c.path.startsWith("/api/q/board_projects")) return { body: { rows: COUNTS, as_of: BOARD.body.as_of } };
      if (c.path.startsWith("/api/q/board")) return { body: { rows, as_of: BOARD.body.as_of } };
      if (c.path === "/api/agents") return { body: { agents: [{ id: "cursor", revoked: false }, { id: "old", revoked: true }] } };
      return { body: { ok: true } };
    },
  });
  const shown: { view: string; opts?: Record<string, unknown> }[] = [];
  const closeSheet = vi.fn();
  const view = mountWork({ $: b.$, api: b.api, show: (v: string, opts?: Record<string, unknown>) => { shown.push({ view: v, opts }); }, closeSheet });
  return { b, view, shown, closeSheet, rows };
}

describe("Move to…, mounted", () => {
  it("pressing a disabled row sends nothing — and neither does a forged press on an illegal column", async () => {
    const { b, view, closeSheet } = mounted();
    await view.board();
    view.openMove(cardOf("41"));
    await view.move();
    expect(b.$("move-list").innerHTML).toContain('data-column="in_progress" disabled');
    expect(b.$("move-list").innerHTML).toContain("nothing claims a blocked card — unblock it first");
    // the disabled row, as a finger reaches it
    await b.$("move").fire("click", { target: target({ "[data-act]": control({ act: "move", column: "in_progress" }, { disabled: true }) }) });
    // a row with a data-act that the rule does not allow (a tampered page): still nothing
    await b.$("move").fire("click", { target: control({ act: "move", column: "in_progress" }) });
    expect(b.writes()).toEqual([]);
    expect(closeSheet).not.toHaveBeenCalled();
  });

  it("a legal row runs its one route, closes the sheet and reads the board again", async () => {
    const { b, view, closeSheet } = mounted();
    await view.board();
    view.openMove(cardOf("41"));
    await view.move();
    const reads = b.calls.length;
    await b.$("move").fire("click", { target: control({ act: "move", column: "backlog" }) });
    expect(closeSheet).toHaveBeenCalledOnce();
    expect(b.writes()).toEqual([{ path: "/api/tasks/41", method: "PATCH", headers: {}, body: { status: "open" } }]);
    expect(b.calls.slice(reads).some((c) => c.path.startsWith("/api/q/board?"))).toBe(true);
  });

  it("Assigned to… asks who, from the registry — me first, no revoked agent — and assigns", async () => {
    const { b, view } = mounted();
    await view.board();
    view.openMove(cardOf("1"));
    await view.move();
    await b.$("move").fire("click", { target: control({ act: "move", column: "assigned" }) });
    const list = b.$("move-list").innerHTML;
    expect(list).toContain('data-owner="user"');
    expect(list).toContain('data-owner="cursor"');
    expect(list).not.toContain('data-owner="old"');
    expect(b.writes()).toEqual([]);
    await b.$("move").fire("click", { target: control({ act: "assign-to", owner: "cursor" }) });
    expect(b.writes()).toEqual([{ path: "/api/tasks/1", method: "PATCH", headers: {}, body: { owner: "cursor" } }]);
  });

  it("a refusal puts the card back and says the server's sentence", async () => {
    const REFUSAL = "task 1 waits on depends_on [7] — close those rows first; a dangling id blocks on purpose";
    const { b, view } = mounted({ respond: (c) => (c.method === "POST" ? { status: 409, body: { error: { code: "conflict", message: REFUSAL } } } : undefined) });
    await view.board();
    view.openMove(cardOf("1"));
    await b.$("move").fire("click", { target: control({ act: "move", column: "in_progress" }) });
    expect(b.writes()).toEqual([{ path: "/api/tasks/1/claim", method: "POST", headers: {}, body: {} }]);
    expect(b.$("board-msg").hidden).toBe(false);
    expect(b.$("board-msg").innerHTML).toContain(REFUSAL);
    expect(view.rows!.find((r: Card) => r.id === "1")!.column).toBe("backlog");
    expect(b.$("board-msg").innerHTML).not.toContain('data-act="retry"'); // a refusal is an answer, not a failure to retry
  });

  it("a move the console never answered is undone, and Try Again runs it again (components-03 §2: move reverts, Try Again)", async () => {
    let offline = true;
    const { b, view } = mounted({ respond: (c) => { if (c.method === "POST" && offline) throw new Error("offline"); return undefined; } });
    await view.board();
    view.openMove(cardOf("1"));
    await b.$("move").fire("click", { target: control({ act: "move", column: "in_progress" }) });
    expect(b.$("board-msg").innerHTML).toContain("The console did not answer — nothing moved.");
    expect(b.$("board-msg").innerHTML).toContain('data-act="retry"');
    expect(view.rows!.find((r: Card) => r.id === "1")!.column).toBe("backlog");
    offline = false;
    await b.$("board").fire("click", { target: control({ act: "retry" }) });
    expect(b.writes().map((w) => w.path)).toEqual(["/api/tasks/1/claim", "/api/tasks/1/claim"]);
    expect(b.$("board-msg").hidden).toBe(true);
  });
});

describe("the board on a phone: one column, picked by chips with counts", () => {
  it("chips carry every column's count from board_projects — not the capped cards", () => {
    const totals = boardTotals(COUNTS, "");
    const html = boardChipsHtml(totals, "in_progress");
    expect([...html.matchAll(/data-column="([a-z_]+)" aria-pressed="(true|false)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]])).toEqual([
      ["backlog", "false", "Backlog, 12"],
      ["assigned", "false", "Assigned, 5"],
      ["in_progress", "true", "In Progress, 4"],
      ["blocked", "false", "Blocked, 2"],
      ["done", "false", "Done, 40"],
    ]);
  });

  it("a chip picks the column shown, and is remembered", async () => {
    const { b, view } = mounted();
    await view.board();
    expect(b.$("board-columns").dataset.show).toBe("in_progress");
    await b.$("board").fire("click", { target: control({ act: "column", column: "blocked" }) });
    expect(b.$("board-columns").dataset.show).toBe("blocked");
    expect(b.stored.get("metistry.board.column")).toBe("blocked");
    expect(b.$("board-chips").innerHTML).toContain('data-column="blocked" aria-pressed="true"');
  });

  it("the CSS shows one column under 600px and all of them from 600px", () => {
    const css = read("../web/style.css");
    expect(css).toMatch(/@media \(max-width: 599px\) \{\s*\.board-col \{ display: none; \}/);
    for (const k of ["backlog", "assigned", "in_progress", "blocked", "done"]) expect(css).toContain(`.board[data-show="${k}"] .board-col[data-column="${k}"]`);
    expect(css).toMatch(/@media \(min-width: 600px\) \{\s*\.board-chips \{ display: none; \}/);
  });

  it("the first look is placeholder rows; an empty board says so and offers Capture a Task", async () => {
    expect(boardColumnsHtml(null, boardTotals([], ""))).toContain('class="card placeholder" aria-hidden="true"');
    const b = fakeBrowser({ respond: () => ({ body: { rows: [], as_of: BOARD.body.as_of } }) });
    const shows: string[] = [];
    const view = mountWork({ $: b.$, api: b.api, show: (v: string) => { shows.push(v); }, closeSheet: () => {} });
    await view.board();
    expect(b.$("board-state").hidden).toBe(false);
    expect(b.$("board-state").innerHTML).toContain("Nothing on the board.");
    await b.$("board").fire("click", { target: control({ act: "capture" }) });
    expect(shows).toEqual(["capture"]);
  });

  it("escalation is named, in degraded — never red (screen 6 §5)", () => {
    const html = boardColumnsHtml(BOARD.body.rows, boardTotals(COUNTS, ""));
    expect(html).toContain('<span class="chip degraded-chip">');
    expect(html).not.toMatch(/class="[^"]*\bfailed\b/);
    expect(escalationLabel(cardOf("41", { blocked_by_task_open: false }))).toBe("Blocked");
    expect(escalationLabel(cardOf("41", { blocked_by_task_open: true }))).toBe("Waiting on You"); // the owner's own todo line holds it
    expect(escalationLabel(cardOf("2", { lease_expires_at: "2020-01-01T00:00:00Z" }))).toBe("Lease Lapsed");
  });
});

describe("every tap opens the card (C84); the room is a push from it", () => {
  it("a tap on a card pushes it, named by its title", async () => {
    const { b, view, shown } = mounted();
    await view.board();
    await b.$("board").fire("click", { target: control({ act: "card", id: "3" }) });
    expect(shown.at(-1)).toEqual({ view: "card", opts: { title: "Decide the fixture format" } });
    view.card();
    expect(b.$("card-body").innerHTML).toContain("One JSON per route, recorded from a scratch console"); // T1-1's description
    expect(b.$("card-body").innerHTML).toContain('data-act="room"');
    // m on a focused card opens Move to…
    await b.$("board").fire("keydown", { key: "m", target: control({ act: "card", id: "3" }), preventDefault() {} });
    expect(shown.at(-1)!.view).toBe("move");
  });

  it("Open Room pushes the task's room, named by its number", async () => {
    const { b, view, shown } = mounted();
    await view.board();
    view.openCard(cardOf("3"));
    view.card();
    await b.$("card").fire("click", { target: control({ act: "room" }) });
    expect(shown.at(-1)).toEqual({ view: "rooms", opts: { title: "#3" } });
    expect(b.loc.hash).toBe("#/rooms/work/3");
  });

  it("a card moved while the owner was away says where it went, and opens that column", async () => {
    const { b, view, rows, shown } = mounted();
    await view.board();
    view.openCard(cardOf("1"));
    view.card();
    expect(b.$("card-note").hidden).toBe(true);
    rows.find((r) => r.id === "1")!.column = "done";
    await view.board();
    view.card();
    expect(b.$("card-note").hidden).toBe(false);
    expect(b.$("card-note").innerHTML).toContain("Moved to Done while you were away.");
    await b.$("card").fire("click", { target: control({ act: "open-column", column: "done" }) });
    expect(view.shown).toBe("done");
    expect(shown.at(-1)!.view).toBe("board");
  });

  it("Release sits on the card only when the card is yours to hand back", async () => {
    const { b, view, rows } = mounted();
    await view.board();
    view.openCard(cardOf("2"));
    view.card();
    expect(b.$("card-release").hidden).toBe(true);
    rows.find((r) => r.id === "2")!.claimed_by = "user"; // the board is what the card reads
    await view.board();
    view.card();
    expect(b.$("card-release").hidden).toBe(false);
    expect(b.$("card-release").dataset.column).toBe("backlog");
    await b.$("card").fire("click", { target: control({ act: "release", column: "backlog" }) });
    expect(b.writes()).toEqual([{ path: "/api/tasks/2/release", method: "POST", headers: {}, body: {} }]);
  });

  it("the card escapes what an agent wrote", () => {
    const html = cardHtml(cardOf("3", { description: "<script>x</script>", claimed_by: "<b>x</b>" }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x</b>");
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe("Projects: the mode chip and the spend bar carry the row", () => {
  const p = PROJECTS.body.projects[0]!;

  it("one row from the recorded project, in the glossary's words", () => {
    const html = projectRowHtml(p, 1);
    expect(html).toContain("<b>Metistry</b>");
    expect(html).toContain('<span class="chip review">Review</span>');
    expect(html).toContain("4 open · 1 blocked · 2 agents");
    expect(html).toContain("$0.00 today · no budget");
    expect(html).toContain('data-act="project" data-id="metistry"');
    expect(html).not.toMatch(/Supervised|>Auto</); // the old words (glossary.md: Autonomous · Review)
  });

  it("a project the budget put in Review says so; the bar turns degraded at the budget", () => {
    const over = { ...p, daily_budget_usd: 5, spend_today_usd: 5.2, last_mode_change: { ts: "2026-09-27T14:40:00Z", by: "budget", reason: "budget", to: "review" } };
    expect(modeChipHtml(over)).toBe('<span class="chip review over">Review · over budget</span>');
    expect(projectRowHtml(over)).toContain('<span class="spend over"><span class="muted">$5.20 of $5.00 today</span>');
    expect(modeChipHtml({ ...p, mode: "autonomous" })).toBe('<span class="chip autonomous">Autonomous</span>');
    expect(modeChipHtml({ ...over, last_mode_change: { ...over.last_mode_change, by: "user", reason: "toggle" } })).toBe('<span class="chip review">Review</span>');
  });

  it("the switch is on the pushed project, confirmed with its consequence, one PUT", async () => {
    const b = fakeBrowser({ respond: (c) => (c.path === "/api/projects" ? { body: PROJECTS.body } : { body: { rows: [] } }) });
    const asked: string[] = [];
    vi.stubGlobal("confirm", (m: string) => { asked.push(m); return true; });
    const shown: unknown[] = [];
    const view = mountWork({ $: b.$, api: b.api, show: (v: string, o: unknown) => { shown.push([v, o]); }, closeSheet: () => {} });
    await view.projects();
    await b.$("projects").fire("click", { target: control({ act: "project", id: "metistry" }) });
    expect(shown).toEqual([["project", { title: "Metistry" }]]);
    view.project();
    expect(b.$("project-body").innerHTML).toContain('data-act="mode" data-to="autonomous"');
    await b.$("project").fire("click", { target: control({ act: "mode", to: "autonomous" }) });
    expect(asked[0]).toContain("Set metistry back to Autonomous?");
    expect(b.writes()).toEqual([{ path: "/api/projects/metistry", method: "PUT", headers: {}, body: { mode: "autonomous" } }]);
  });
});

// ---------------------------------------------------------------------------
// Artifacts: threads become counts on their lines
// ---------------------------------------------------------------------------

describe("an artifact's threads become counts on their lines, opening a sheet", () => {
  const threads = COMMENTS.body.threads;

  it("the recorded thread sits on line 3 of notes.md", () => {
    const by = threadsByLine(threads, "notes.md");
    expect([...by.keys()]).toEqual([3]);
    expect(threadsByLine(threads, "other.md").size).toBe(0);
  });

  it("markdown: the paragraph holding line 3 is highlighted and wears the count; the rest do not", () => {
    const html = annotatedMarkdownHtml(FILE.body.content, threadsByLine(threads, "notes.md"));
    expect(html).toContain('<div class="art-block"><h1>Store interface</h1></div>');
    expect(html).toContain('<div class="art-block has-thread"><p>One protocol per domain, one method per route.</p><button type="button" class="thread-count" data-act="thread" data-lines="3" aria-label="Line 3, 1 comment">');
  });

  it("a thread on a blank line belongs to the block after it; text files carry it on the line itself", () => {
    const t = { ...threads[0]!, anchor: { line: 2 } };
    const html = annotatedMarkdownHtml(FILE.body.content, threadsByLine([t], "notes.md"));
    expect(html).toContain('<div class="art-block has-thread"><p>One protocol');
    const text = annotatedTextHtml("a\n<b>two</b>\nc", threadsByLine([{ ...t, anchor: { line: 2 } }], "notes.md"));
    expect(text).toContain('<span class="art-ln has-thread">&lt;b&gt;two&lt;/b&gt;<button type="button" class="thread-count"');
    expect(text).not.toContain("<b>two");
  });

  it("the count is every comment on the line, replies included; the sheet escapes them and offers Resolve", () => {
    const t = { ...threads[0]!, body: "<img src=x onerror=alert(1)>", replies: [{ author_principal: "drey-dev", author_kind: "agent", body: "done", created_at: "2026-09-27T01:00:00Z" }] };
    expect(commentCount([t])).toBe(2);
    const sheet = threadSheetHtml([t]);
    expect(sheet).not.toContain("<img");
    expect(sheet).toContain('data-act="resolve"');
    expect(sheet).toContain('<div class="body agent-prose">done</div>'); // an agent's reply in the serif (C32)
    expect(sheet).toContain(`data-reply="${String(threads[0]!.id)}"`);
  });

  it("a thread on no line of this file is listed under the file, never lost", () => {
    const loose = { ...threads[0]!, id: "cmt_loose", anchor: null, path: null };
    const html = otherThreadsHtml([threads[0]!, loose], "notes.md", threadsByLine([threads[0]!, loose], "notes.md"));
    expect(html).toContain('data-thread="cmt_loose"');
    expect(html).not.toContain(`data-thread="${String(threads[0]!.id)}"`);
  });

  it("the links a proposal carries still open the artifact and the room", () => {
    expect(artifactRoute("#/artifacts/art_01M3FYT8N8HRG4S2W4Q0GN28F1/ver_01M3FYT8NB0W22G5J1H3A71PTY")).toEqual({ id: "art_01M3FYT8N8HRG4S2W4Q0GN28F1", version: "ver_01M3FYT8NB0W22G5J1H3A71PTY", review: false });
    expect(artifactRoute("#/artifacts/../x")).toBeNull();
    expect(roomRoute("#/rooms/work/418")).toEqual({ work_id: 418 });
    expect(roomRoute("#/rooms/work/abc")).toBeNull();
  });

  it("mounted: a count opens the sheet named by its line, holding that line's thread", async () => {
    const A = fixture<Record<string, unknown>>("get-api-artifacts-id");
    const V = fixture<Record<string, unknown>>("get-api-artifacts-id-versions");
    const b = fakeBrowser({
      respond: (c) => {
        if (c.path.includes("/comments")) return { body: COMMENTS.body };
        if (c.path.includes("/file?")) return { body: FILE.body };
        if (c.path.endsWith("/versions")) return { body: V.body };
        if (c.path.startsWith("/api/artifacts/")) return { body: A.body };
        return { body: {} };
      },
    });
    const shown: unknown[] = [];
    const view = mountWork({ $: b.$, api: b.api, show: (v: string, o: unknown) => { shown.push([v, o]); }, closeSheet: () => {}, retitle: (t: string) => { shown.push(["retitle", t]); } });
    b.loc.hash = "#/artifacts/art_01M3FYT8N8HRG4S2W4Q0GN28F1";
    await view.artifact();
    expect(shown).toContainEqual(["retitle", "metistry/store-interface"]);
    expect(b.$("art-viewer").innerHTML).toContain('data-lines="3"');
    await b.$("artifact").fire("click", { target: control({ act: "thread", lines: "3" }) });
    expect(shown.at(-1)).toEqual(["thread", { title: "Line 3 · 1 comment" }]);
    view.thread();
    expect(b.$("art-thread-list").innerHTML).toContain("Name the owning ticket beside each placeholder.");
  });
});
