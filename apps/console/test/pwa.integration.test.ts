// PWA-chunk integration: static serving (traversal-safe), push endpoint
// authz, message listing. Skipped without a db (CI provides one).
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

describe.skipIf(!hasDb)("console PWA chunk", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let sessionCookie: string;
  let ownerToken: string;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy: { idleDays: 30, maxDays: 365 },
      secureCookies: false,
      webRoot: fileURLToPath(new URL("../web", import.meta.url)),
      push: { publicKey: "test", privateKey: "test", subject: "mailto:test@example.com" },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `pwa-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "pwa-test" });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, { idleDays: 30, maxDays: 365 })}`;
    ownerToken = await store.mintOwnerToken(pool, "pwa-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("serves the shell unauthenticated (login page must render)", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Sign In with Passkey");
    expect(html).toContain('id="dashboard"'); // Phase 4 dashboard tab ships in the shell
    expect(html).toContain('id="feed"'); // activity feed (home) tab ships in the shell
    expect((await fetch(base + "/sw.js")).status).toBe(200);
    expect((await fetch(base + "/vendor/simplewebauthn.js")).status).toBe(200);
    // design tokens load before the stylesheet (generated from
    // docs/product/design/tokens.json); style.css uses nothing else
    expect(html).toContain('href="/tokens.css"');
    const tokens = await fetch(base + "/tokens.css");
    expect(tokens.status).toBe(200);
    expect(await tokens.text()).toContain("--mt-color-bg");
    // installed-app chrome follows the appearance
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
  });

  // design-system.md 3.6 + P9: the chat composer is one row — a <details>
  // actions menu collapsed by default, the field, and send — and the arriving
  // reply raises a pill instead of scrolling the transcript. Asserted on the
  // served markup (there is no DOM harness here): if these ids disappear,
  // app.js throws on load and the whole shell stops working.
  it("ships the collapsed composer actions menu and the new-reply pill", async () => {
    const html = await (await fetch(base + "/")).text();
    // the actions menu is a native <details>, so it works before JS and is
    // collapsed by default — no `open` attribute on it
    expect(html).toMatch(/<details id="composer-actions">/);
    expect(html).not.toMatch(/<details id="composer-actions"[^>]*\sopen/);
    expect(html).toContain('id="composer-toggle"');
    expect(html).toContain('id="composer-sheet"');
    expect(html).toContain('id="composer-agents"'); // filled from the agent registry
    // P9: the pill ships, and it ships hidden — it appears only when a reply
    // lands while the reader is scrolled away from the bottom
    expect(html).toMatch(/<p id="new-reply-row" hidden>/);
    expect(html).toContain('id="new-reply"');
    expect(html).toContain("New Reply");
    // the transcript is announced politely, never assertively (P2)
    expect(html).toContain('<ul id="messages" aria-live="polite">');
    // and nothing else is pinned above the keyboard: the composer holds
    // exactly the toggle, the form and the pill row
    expect(html).toContain('<div id="composer">');
  });

  // design-system.md 3.6: the composer completes as you type. The listbox
  // ships hidden and the field owns it — a listbox and not a menu, so the
  // caret never leaves #send-text and the reply stays in the user's hands.
  it("ships the composer suggestion listbox, owned by the field", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toMatch(/<ul id="suggest" role="listbox"[^>]*hidden>/);
    expect(html).toContain('aria-controls="suggest"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"'); // closed until a trigger is typed
    expect(html).toContain('aria-autocomplete="list"');
  });

  // P10: Title Case names things — nav labels, screen titles, section headers.
  it("navigation labels and section headers are Title Case", async () => {
    const html = await (await fetch(base + "/")).text();
    // "Needs You" is the triage tab's label since the reply-quality loop
    // (docs/ops/reply-feedback.md) made it the single list — Title Case too.
    for (const label of ["Feed", "Chat", "Board", "Dashboard", "Capture", "Needs You", "Status", "Devices", "Agents", "Artifacts", "Rooms"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain("<h3>Components</h3>");
    expect(html).toContain("<h3>Reviews Waiting on You</h3>");
    expect(html).toContain('<h1 id="title">Metistry</h1>');
  });

  // docs/ops/board.md — the board panel ships in the shell. Asserted on the
  // served markup (there is no DOM harness here): app.js wires #board-project
  // and #board-columns at module scope, so if either id disappears the whole
  // shell throws on load.
  it("ships the board panel and the three popovers the drags need", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('<section id="board" hidden>');
    expect(html).toContain('id="board-project"'); // the project filter app.js binds [ and ] to
    expect(html).toContain('id="board-columns"');
    expect(html).toContain('id="board-asof"'); // staleness is visible, never silent
    expect(html).toContain('id="board-empty"');
    const board = /<section id="board" hidden>[\s\S]*?<p id="board-empty"[^>]*>[^<]*<\/p>/.exec(html)?.[0] ?? "";
    expect(board).not.toBe("");
    // every id app.js binds at module scope — a missing one throws on load
    for (const id of [
      "board-msg", "board-move", "board-move-card", "board-move-targets", "board-move-cancel",
      "board-assign", "board-assign-card", "board-assign-to", "board-assign-cancel",
      "board-detail", "board-detail-title", "board-detail-fields", "board-detail-link", "board-detail-close",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // the refusal line is a live region: a snapped-back card must announce why
    expect(html).toMatch(/id="board-msg"[^>]*aria-live="polite"/);
  });

  // The drags (docs/ops/board.md "Drags"). There is no DOM harness here, so
  // this asserts the SHAPE of the handlers in the served app.js: every drop
  // the table names maps to exactly one route, `reported` is never a target,
  // and a closed card has no drops at all.
  // Ruled 2026-09-17: `work.owner` is a name on the card, not a lease, so the
  // column is read "Addressed to". The KEY stays `assigned` (board.yaml's
  // derived value, every route above), which is exactly what this pins apart.
  it("the `assigned` column is labelled “Addressed to”, and the key it is drawn from is unchanged", async () => {
    const js = await (await fetch(base + "/app.js")).text();
    const cols = /const BOARD_COLUMNS = \[[\s\S]*?\n\];/.exec(js)?.[0] ?? "";
    expect(cols).not.toBe("");
    expect(cols).toContain('["assigned", "Addressed to"');
    expect(cols).not.toContain('"Assigned"');
  });

  it("the board's drag handlers are present, and each drop maps to exactly one route", async () => {
    const js = await (await fetch(base + "/app.js")).text();
    for (const handler of ["ondragstart", "ondragover", "ondragleave", "ondrop", "ondragend"]) {
      expect(js, handler).toContain(handler);
    }
    // the §6c policy table, as it stands in the panel
    const drops = /function dropsFor\(c\) \{[\s\S]*?\n\}/.exec(js)?.[0] ?? "";
    expect(drops).not.toBe("");
    expect(drops).toContain('if (c.status === "closed") return d;'); // done/reported are terminal
    expect(drops).toContain('d.assigned = "assign"');
    expect(drops).toContain('d.in_progress = "claim"');
    expect(drops).toContain('d.backlog = "unassign"');
    expect(drops).toContain('d[boardHome(c)] = "release"');
    expect(drops).toContain('d[boardHome(c)] = "unblock"');
    expect(drops).toContain('d.done = "close"');
    expect(drops).not.toContain("reported"); // nothing you can drag makes a report exist
    // one op, one route — and the two POST verbs are the only POSTs
    const routes = /function boardRoute\(op, card, extra\) \{[\s\S]*?\n\}/.exec(js)?.[0] ?? "";
    expect(routes).toContain('method: "PATCH"');
    expect(routes).toContain("`/api/tasks/${id}/${op}`");
    expect(routes).toContain('return patch({ owner: extra.owner })');
    expect(routes).toContain('return patch({ owner: null })');
    expect(routes).toContain('return patch({ status: "open" })');
    expect(routes).toContain('return patch({ status: "closed" })');
    // the keyboard alternative, and the room link a card opens when it has one
    expect(js).toContain('e.key === "m"');
    expect(js).toContain("`#/rooms/work/${Number(c.id)}`");
  });

  // docs/research/2026-09-16-taskuary-review.md ADOPT 1 + 5 — the two new
  // sets of controls ship in the shell. Asserted on the served markup (there
  // is no DOM harness here): app.js wires #feed-kinds and the three
  // #triage-* buttons at module scope, so if any id disappears the whole
  // shell throws on load and every other test in this file goes with it.
  it("ships the timeline's kind chips and Needs You's batch controls", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('id="feed-kinds"'); // the chips app.js writes the closed group list into
    expect(html).toContain('aria-label="Filter by kind"');
    for (const id of ["triage-batch", "triage-selected", "triage-later", "triage-skip", "triage-clear"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // P10: the two new verbs are buttons the user reads, so Title Case
    expect(html).toContain(">Later</button>");
    expect(html).toContain(">Skip</button>");
    // the feed stays read-only: its only controls are filters, and the chips
    // themselves are written by app.js rather than shipped as markup
    const feed = /<section id="feed" hidden>[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(feed).not.toMatch(/<button/);
    expect(feed).not.toMatch(/draggable/);
  });

  // Regression: every view is a sibling <section> under <main>. An unclosed
  // one nests the following views inside it, so show() unhides a section
  // whose ancestor is still hidden and the tab renders blank (this is exactly
  // what happened to dashboard and artifacts inside agents).
  it("every view section is closed, so no view nests inside another", async () => {
    const html = await (await fetch(base + "/")).text();
    const opens = html.match(/<section\b/g)?.length ?? 0;
    const closes = html.match(/<\/section>/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThanOrEqual(10);
  });

  it("static serving refuses traversal and unknown files (falls to auth wall)", async () => {
    const t = await fetch(base + "/..%2f..%2f.env");
    expect(t.status).toBe(401); // never 200, no file content
    expect(await t.text()).not.toContain("PASSWORD");
    expect((await fetch(base + "/nope.js")).status).toBe(401);
  });

  it("push endpoints: session-only (owner token forbidden), subscribe stores on the session", async () => {
    expect((await fetch(`${base}/api/push/vapid-key`, { headers: { authorization: `Bearer ${ownerToken}` } })).status).toBe(403);
    const sub = { endpoint: `https://push.example/${Date.now()}`, keys: { p256dh: "a", auth: "b" } };
    const r = await fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    expect(r.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT push_subscription FROM auth_sessions WHERE push_subscription->>'endpoint' = $1`,
      [sub.endpoint],
    );
    expect(rows.length).toBe(1);
  });

  it("lists inbound messages for the thread view", async () => {
    const posted = await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "pwa test msg" }),
    });
    // by the id the POST returned, not by the text: other suites in this file
    // set post to the same scratch database in parallel, and a fixed `limit`
    // makes "is it listed" a race against how many messages they sent
    const { message_id } = await posted.json();
    const r = await fetch(`${base}/api/messages?limit=50`, { headers: { cookie: sessionCookie } });
    const { messages } = await r.json();
    expect(messages.some((m: any) => Number(m.id) === Number(message_id) && m.text === "pwa test msg")).toBe(true);
  });
});
