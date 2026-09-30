// **The assistant cannot start an OAuth flow** (T4-10). Enforced at the tool,
// not by a sentence in a prompt: the flow — the loopback listener, the code
// exchange, the store write — is `authorizeConnection` in oauth.ts, and the
// only thing that calls it is the owner's CLI verb (`metistry connections
// authorize`, M13). The assistant reaches connections through the proxy's
// two tools on `/mcp`, and the proxy has exactly three doors — list, tools,
// call — none of which signs in. So this file holds, structurally:
//
//   1. nothing the assistant runs in, or reaches, imports the flow: the
//      console (which mounts `/mcp` and the Approve path), the bridge, the
//      engine, the reconciler and the supervisor;
//   2. inside this package, the flow is oauth.ts's alone — the pool and the
//      proxy import the refresh (minting an access token from a stored
//      sign-in), never the flow;
//   3. the proxy's surface is the three doors, and a call to an OAuth
//      connection that is not signed in is refused `sign_in` (or its missing
//      token named) — it never opens a listener or a browser.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EgressRefused } from "@foldedspacelabs/metistry-core";
import { ConnectionPool, ConnectionRefused, poolProxy } from "../src/index.js";
import { catalogOf, secretsWith } from "./helpers.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** The flow's own names — what starting one would have to import. */
const FLOW = /\b(authorizeConnection|openLoopback|exchangeCode|authorizationUrl|pkcePair|newState)\b/;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

describe("**the assistant cannot start an OAuth flow**", () => {
  it("nothing the assistant runs in or reaches imports the flow — the console, the bridge, the engine, the reconciler, the supervisor", async () => {
    const dirs = ["apps/console/src", "apps/console/web", "apps/assistant/src", "apps/reconciler/src", "apps/watchdog/src", "packages/mcp-brain/src"];
    const offenders: string[] = [];
    let scanned = 0;
    for (const d of dirs) {
      for (const f of await sources(join(REPO, d))) {
        scanned++;
        if (FLOW.test(await readFile(f, "utf8"))) offenders.push(f.slice(REPO.length));
      }
    }
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("inside this package the flow is oauth.ts's alone: the pool and the proxy import the refresh, never the flow", async () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const users: string[] = [];
    for (const f of await sources(dir)) {
      const name = f.slice(dir.length);
      if (name === "oauth.ts" || name === "index.ts") continue;
      if (FLOW.test(await readFile(f, "utf8"))) users.push(name);
    }
    expect(users).toEqual([]);
  });

  describe("through the proxy", () => {
    const pools: ConnectionPool[] = [];
    afterEach(async () => {
      for (const p of pools.splice(0)) await p.close();
    });

    const file = {
      name: "cx",
      type: "api",
      provider: "custom",
      reach: {
        http: {
          url: "https://api.example.test/v1",
          auth: {
            scheme: "oauth",
            client: { authorize_url: "https://auth.example.test/authorize", token_url: "https://auth.example.test/token", scopes: ["read"], pkce: true, redirect: "loopback" },
            token: "{{ secret.cx_token }}",
            client_id: "{{ secret.cx_client }}",
          },
        },
      },
      secrets: ["cx_token", "cx_client"],
      tools: { get: { group: "reads", mode: "on" } },
    };
    const secrets = `secrets:
  cx_token: { hosts: [auth.example.test, api.example.test], grants: { "connection:cx": on } }
  cx_client: { hosts: [auth.example.test], grants: { "connection:cx": on } }
`;

    it("has three doors — list, tools, call — and none of them signs in", async () => {
      const cat = catalogOf([file], { secrets });
      const pool = new ConnectionPool({ catalog: async () => cat, secrets: { value: async () => undefined } });
      pools.push(pool);
      expect(Object.keys(poolProxy({ pool, catalog: async () => cat })).sort()).toEqual(["call", "list", "tools"]);
    });

    it("a call to a connection with no sign-in is refused before anything leaves — no listener, no browser, nothing sent", async () => {
      const sent: string[] = [];
      const cat = catalogOf([file], { secrets });
      const pool = new ConnectionPool({
        catalog: async () => cat,
        secrets: await secretsWith({ cx_client: "owners-client" }),
        fetch: (async (input: Parameters<typeof fetch>[0]) => {
          sent.push(String(input));
          return new Response("{}");
        }) as typeof fetch,
      });
      pools.push(pool);
      const proxy = poolProxy({ pool, catalog: async () => cat });
      const err = await proxy.call({ connection: "cx", tool: "get", args: {} }).catch((e: unknown) => e);
      // the stored sign-in is missing: named, and nothing was sent anywhere
      expect(err instanceof EgressRefused || err instanceof ConnectionRefused).toBe(true);
      expect((err as Error).message).toMatch(/cx_token/);
      expect(sent).toEqual([]);
      // and a tool named for a sign-in is no tool at all
      await expect(proxy.call({ connection: "cx", tool: "authorize", args: {} })).rejects.toMatchObject({ code: "tool_not_listed" });
    });
  });
});
