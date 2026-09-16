// PWA-chunk integration: static serving (traversal-safe), push endpoint
// authz, message listing. Skipped without a db (CI provides one).
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

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
  // shell throws on load. The panel is READ-ONLY in this phase: no draggable
  // attribute, no drop target, no mutating form.
  it("ships the read-only board panel", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain('<section id="board" hidden>');
    expect(html).toContain('id="board-project"'); // the project filter app.js binds [ and ] to
    expect(html).toContain('id="board-columns"');
    expect(html).toContain('id="board-asof"'); // staleness is visible, never silent
    expect(html).toContain('id="board-empty"');
    const board = /<section id="board" hidden>[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(board).not.toMatch(/draggable/); // phase 3 adds the drags, with the misuse tests
    expect(board).not.toMatch(/<button/); // nothing in here mutates a task
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
    await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "pwa test msg" }),
    });
    const r = await fetch(`${base}/api/messages?limit=5`, { headers: { cookie: sessionCookie } });
    const { messages } = await r.json();
    expect(messages.some((m: any) => m.text === "pwa test msg")).toBe(true);
  });
});
