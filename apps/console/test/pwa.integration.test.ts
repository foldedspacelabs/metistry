// PWA-chunk integration: static serving (traversal-safe), push endpoint
// authz, message listing. Skipped without a db (CI provides one).
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { REQUEST_KINDS, describeRequest, mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

// the source of truth for the manifest/meta colours (F-9): `bg`, light scheme
const designTokens = JSON.parse(readFileSync(new URL("../../../docs/product/design/tokens.json", import.meta.url), "utf8"));
const BG_LIGHT = designTokens.color.bg.light;
const BG_DARK = designTokens.color.bg.dark;

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

describe.skipIf(!hasDb)("console PWA chunk", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let sessionCookie: string;
  let ownerToken: string;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
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
    expect(html).toContain('id="today"'); // the home tab ships in the shell (T7-2)
    expect(html).toContain('id="feed"'); // Activity (More ▸ Activity) ships in the shell
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

  // F-9: the manifest and icons carry the current brand — decision 15
  // (Metistry, proper case), the current tokens (not the pre-#263 `#f6f7f9`
  // ground), and a PNG apple-touch-icon (C13 — iOS does not honour SVG).
  it("the manifest and touch icon match the current brand — name, colours, PNG", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).not.toContain("#f6f7f9"); // the pre-#263 ground, purged
    expect(html).toContain(`content="${BG_LIGHT}"`);
    expect(html).toContain(`content="${BG_DARK}"`);
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');

    const mr = await fetch(base + "/manifest.webmanifest");
    expect(mr.status).toBe(200);
    expect(mr.headers.get("content-type")).toContain("application/manifest+json");
    const manifestText = await mr.text();
    expect(manifestText).not.toContain("#f6f7f9");
    const manifest = JSON.parse(manifestText);
    expect(manifest.name).toBe("Metistry");
    expect(manifest.short_name).toBe("Metistry");
    expect(manifest.background_color).toBe(BG_LIGHT);
    expect(manifest.theme_color).toBe(BG_LIGHT);
    const pngIcons = manifest.icons.filter((i: { type: string }) => i.type === "image/png");
    expect(pngIcons.length).toBeGreaterThanOrEqual(1);

    for (const icon of pngIcons) {
      const ir = await fetch(base + icon.src);
      expect(ir.status).toBe(200);
      expect(ir.headers.get("content-type")).toBe("image/png");
    }

    const touch = await fetch(base + "/apple-touch-icon.png");
    expect(touch.status).toBe(200);
    expect(touch.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await touch.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  });

  // X-4: brand-kit.md "What the build needs" #5 — a maskable icon (so
  // Android does not crop the mark against its own shape) and a dark
  // counterpart for background_color/theme_color (so an installed dark-mode
  // PWA does not flash light on launch, C12's manifest half).
  it("ships a maskable icon and a dark manifest colour scheme", async () => {
    const manifest = await (await fetch(base + "/manifest.webmanifest")).json();

    const maskable = manifest.icons.find((i: { purpose?: string }) => i.purpose === "maskable");
    expect(maskable).toBeDefined();
    expect(maskable.type).toBe("image/png");
    expect(maskable.sizes).toBe("512x512");
    const mr = await fetch(base + maskable.src);
    expect(mr.status).toBe(200);
    expect(mr.headers.get("content-type")).toBe("image/png");

    // manifest.json has no top-level media query, so the dark counterpart
    // rides the "user preference media features" member browsers read
    // (color_scheme_dark) rather than a second static manifest.
    expect(manifest.user_preferences.color_scheme_dark.theme_color).toBe(BG_DARK);
    expect(manifest.user_preferences.color_scheme_dark.background_color).toBe(BG_DARK);
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
  // The shell (T7-2, screen 18 §1): five tabs, the sidebar's rows at 900px,
  // Work's segments and More's rows; the glyph-only header controls speak
  // their names. apps/console/test/pwa-shell.test.ts holds the shell itself.
  it("navigation labels and section headers are Title Case", async () => {
    const html = await (await fetch(base + "/")).text();
    for (const label of ["Today", "Chat", "Work", "Knowledge", "More", "Needs You", "Activity", "Agents", "Settings", "Usage"]) {
      expect(html).toContain(`<span class="label">${label}</span>`);
    }
    for (const label of ["Board", "Projects", "Artifacts"]) expect(html).toContain(`>${label}</button>`);
    for (const label of ["Capture", "Needs You", "Usage"]) expect(html).toContain(`aria-label="${label}"`);
    // Settings' group titles are drawn by settings.js (T7-6, pwa-settings.test.ts); these two are the page's own
    expect(html).toContain("<h3>Notifications</h3>");
    expect(html).toContain("<h3>Reviews Waiting on You</h3>");
    expect(html).toContain('<h1 id="title" class="large-title">Metistry</h1>');
  });

  // docs/ops/board.md — the board panel ships in the shell. Asserted on the
  // served markup: work.js binds its ids when the shell mounts it, so if one
  // disappears the whole shell throws on load. Since T7-3b (screen 18 §5) the
  // three popovers are gone: a tap opens the card (C84), and a move is the
  // Move to… sheet — both views of their own.
  it("ships the board panel, the card and the Move to… sheet", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('<section id="board" hidden>');
    expect(html).toContain('id="board-project"'); // the project filter work.js binds [ and ] to
    expect(html).toContain('id="board-columns"');
    expect(html).toContain('id="board-asof"'); // staleness is visible, never silent
    expect(html).toContain('id="board-chips"'); // one column at a time on a phone
    for (const id of ["board-state", "board-msg", "card", "card-body", "card-msg", "card-move", "card-release", "move", "move-for", "move-list"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    for (const id of ["board-move", "board-assign", "board-detail", "board-empty"]) expect(html, id).not.toContain(`id="${id}"`);
    // the refusal line is a live region: a move that is undone must announce why
    expect(html).toMatch(/id="board-msg"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="card-msg"[^>]*aria-live="polite"/);
    // and the module that draws it is served
    const js = await fetch(base + "/work.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
  });

  // T1-2 (C2, C38, C39): five columns, and every label is the word its key
  // says — `assigned` is Assigned, `blocked` is Blocked. "Addressed To"
  // reverted (C38), "Needs You" is the request queue's name and not a
  // column's (C2), and Reported is a flag on Done rather than a column (C39).
  it("the board draws five columns, each labelled with the word its key says", async () => {
    const js = await (await fetch(base + "/work.js")).text();
    const cols = /const BOARD_COLUMNS = \[[\s\S]*?\n\];/.exec(js)?.[0] ?? "";
    expect(cols).not.toBe("");
    const pairs = [...cols.matchAll(/\["([a-z_]+)", "([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual([
      ["backlog", "Backlog"],
      ["assigned", "Assigned"],
      ["in_progress", "In Progress"],
      ["blocked", "Blocked"],
      ["done", "Done"],
    ]);
    // the accept line: no "Addressed to" anywhere the owner reads
    const html = await (await fetch(base + "/")).text();
    for (const [name, src] of [["work.js", js], ["index.html", html]] as const) expect(src, name).not.toMatch(/addressed to/i);
    expect(cols).not.toContain("Needs You");
  });

  // The drags (docs/ops/board.md "Drags"), as served. The rule itself —
  // which move is legal, and the reason for one that is not — is driven with
  // the recorded board in pwa-work.test.ts; this holds the served module to
  // the same routes: every move maps to exactly one, and the drags are wired.
  it("the board's drag handlers are present, and each move maps to exactly one route", async () => {
    const js = await (await fetch(base + "/work.js")).text();
    for (const ev of ["dragstart", "dragover", "dragleave", "drop", "dragend"]) expect(js, ev).toContain(`addEventListener("${ev}"`);
    // one op, one route — and the two POST verbs are the only POSTs
    const routes = /export function boardRoute\(op, card, extra\) \{[\s\S]*?\n\}/.exec(js)?.[0] ?? "";
    expect(routes).toContain('method: "PATCH"');
    expect(routes).toContain("`/api/tasks/${id}/${op}`");
    expect(routes).toContain("return patch({ owner: extra.owner })");
    expect(routes).toContain("return patch({ owner: null })");
    expect(routes).toContain('return patch({ status: "open" })');
    expect(routes).toContain('return patch({ status: "closed" })');
    // the keyboard alternative, and the room — a push from the card
    expect(js).toContain('e.key === "m"');
    expect(js).toContain("`#/rooms/work/${room.work_id}`");
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

  // X-5: the PWA cannot import core, so the queue serves each row's reading
  // from F-5's table beside the stored row, and the view draws that word.
  it("the queue serves every row's reading from F-5's table — a kind it does not know as a report", async () => {
    const kinds = [...REQUEST_KINDS, "sync_conflict"];
    const source = `x5-${mintToken(6)}`;
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload)
       SELECT k, $1, 'internal', jsonb_build_object('title', 'x5 ' || k) FROM unnest($2::text[]) AS k RETURNING id, kind`,
      [source, kinds],
    );
    const r = await fetch(`${base}/api/proposals?limit=200`, { headers: { cookie: sessionCookie } });
    expect(r.status).toBe(200);
    const { proposals } = await r.json();
    const mine = new Map(proposals.filter((p: any) => p.source_agent === source).map((p: any) => [p.kind, p]));
    expect([...mine.keys()].sort()).toEqual([...kinds].sort());
    for (const k of kinds) {
      const p = mine.get(k) as any;
      expect(p.kind, k).toBe(k); // the stored row is unchanged — `request` is additive
      expect(p.request, k).toEqual(JSON.parse(JSON.stringify(describeRequest(k, p.payload))));
    }
    expect((mine.get("sync_conflict") as any).request).toMatchObject({ type: "report", word: "report" });
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::bigint[])`, [rows.map((x: { id: string }) => x.id)]);
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
