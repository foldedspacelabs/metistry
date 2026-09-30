// T7-6 — **the route refuses if called anyway.** Settings draws no control for
// a `local` route (pwa-settings.test.ts); this is the other half, over a real
// socket with the credential the PWA actually holds: a passkey session. Every
// route a Mac-only row stands for answers `403 local_only` naming the Mac app,
// before any handler runs — so a page that did send one (an old tab, a
// hand-typed fetch) would say the server's reason and change nothing. The
// served page itself carries no request to one either.
//
// F-13's own misuse tests (every principal, a non-loopback peer, a mixed
// credential) are reach-gate.integration.test.ts; this file holds the PWA's
// rows to that gate. Scratch database only (docs/ops/testing.md).
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { CLIENT_API, isLocalRoute, mintToken, routeKey } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import { MAC_ONLY_ROUTES } from "../web/settings.js";
import { refusalText } from "../web/more.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const MARK = "itest-pwa-settings";
const policy = { idleDays: 30, maxDays: 365 };

/** A concrete path for a route template: any id — the gate answers before a handler reads it. */
const pathOf = (key: string) => key.split(" ")[1]!.replaceAll(/:[a-z_]+/g, "probe");

describe.skipIf(!hasDb)("Settings' Mac-only rows: the route refuses a passkey session if called anyway", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  const passkeyId = `${MARK}-${mintToken(8)}`;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
      webRoot: fileURLToPath(new URL("../web", import.meta.url)),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    cookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("the rows name exactly the served `local` routes", () => {
    expect([...MAC_ONLY_ROUTES].sort()).toEqual(CLIENT_API.filter((r) => r.served && isLocalRoute(r)).map(routeKey).sort());
  });

  it("**every one refuses the PWA's passkey session from 127.0.0.1 — 403 local_only, naming the Mac app, said in the server's words**", async () => {
    for (const key of MAC_ONLY_ROUTES) {
      const [method] = key.split(" ");
      const res = await fetch(base + pathOf(key), { method, headers: { cookie, "content-type": "application/json" }, body: "{}" });
      expect(res.status, key).toBe(403);
      const said = await refusalText(res.clone(), "fallback");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code, key).toBe("local_only");
      expect(said, key).toContain(key);
      expect(said, key).toContain("Mac app");
    }
  });

  it("the same session still reaches the doors Settings does offer (U2's other side): the devices list, and the projects list its budgets live on", async () => {
    for (const path of ["/api/devices", "/api/projects", "/api/whoami"]) {
      const res = await fetch(base + path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
    }
    const who = (await (await fetch(`${base}/api/whoami`, { headers: { cookie } })).json()) as { via: string; session_id?: unknown };
    expect(who.via).toBe("passkey_session"); // what Settings reads to mark This Device
    expect(who.session_id).toBeDefined();
  });

  it("the served PWA carries no request to a `local` route: the page and settings.js as a browser gets them", async () => {
    for (const path of ["/", "/settings.js", "/app.js", "/more.js"]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      const text = (await res.text()).replace(/^\s*\/\/.*$/gm, "").replace(/local: \[[^\]]*\]/g, "");
      for (const key of MAC_ONLY_ROUTES) {
        const literal = key.split(" ")[1]!.split("/:")[0]!; // the route's leading literal, e.g. /api/sessions/purge
        const tail = key.split(" ")[1]!.split("/").pop()!;
        if (!tail.startsWith(":") && literal !== "/api/agents" && literal !== "/api/scheduled/routines") expect(text, `${path}: ${key}`).not.toContain(literal);
        if (tail === "rotate" || tail === "assignment") expect(text, `${path}: ${key}`).not.toMatch(new RegExp(`/${tail}[\`"']`));
      }
    }
  });
});
