// `metistry connections` for T4-10 — generated tools, OAuth, and a sync's
// first connection — driven through `main()` as the Mac app drives it,
// against a fake `security` (never the login Keychain), scratch instances
// under the OS temp dir, and loopback fixture servers (never a real
// provider).
//
// Bold, the ticket's own, held here from the owner's side:
//   **the loopback listener binds 127.0.0.1 only and closes after one
//   callback**, and **`state` and the PKCE verifier are checked** — the
//   `authorize` verb end to end (packages/connections/test/oauth.test.ts
//   holds the listener and the checks one by one; oauth-reach.test.ts holds
//   **the assistant cannot start an OAuth flow**).

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Exec, ExecOptions } from "../src/exec.js";
import { main } from "../src/main.js";
import { decodeSecurity } from "./fake-security.js";
import { AUTHORIZE_URL, TOKEN_URL, fakeAuthServer, type FakeAuthServer } from "../../connections/test/oauth-server.js";

const ID = "11111111-2222-4333-8444-555555555555";

/** A Keychain in a Map keyed `<account>/<service>`; `open` is the owner's browser, driven by `browser`. */
function fakeMac(browser?: (url: string) => Promise<void>) {
  const store = new Map<string, string>();
  const opened: string[] = [];
  const exec: Exec = async (cmd, argv, opts: ExecOptions = {}) => {
    if (cmd === "open") {
      opened.push(argv[0]!);
      await browser?.(argv[0]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd !== "security") return cmd === "launchctl" ? { code: 113, stdout: "", stderr: "not loaded" } : { code: 127, stdout: "", stderr: `${cmd}: not faked` };
    const { args, value } = decodeSecurity(argv, opts);
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      store.set(at, value!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, opened };
}

async function instance(label: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-connections-p3-${label}-`));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\ninstance_id: "${ID}"\n`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

async function run(argv: string[], mac = fakeMac(), dialFetch?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), exec: mac.exec, platform: "darwin", uid: 501, ...(dialFetch ? { dialFetch } : {}) });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}

const yamlOf = (dir: string, rel: string) => parseYaml(readFileSync(join(dir, rel), "utf8")) as Record<string, any>;
const conn = (dir: string, name: string) => yamlOf(dir, `.metistry/connections/${name}.yaml`);

let feedServer: ReturnType<typeof createServer>;
let feedUrl: string;
beforeAll(async () => {
  feedServer = createServer((req, res) => {
    if (req.url === "/feed.xml") return void res.writeHead(200, { "content-type": "application/rss+xml" }).end(`<rss version="2.0"><channel><item><guid>1</guid><title>One</title></item></channel></rss>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => feedServer.listen(0, "127.0.0.1", r));
  feedUrl = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/feed.xml`;
});
afterAll(async () => {
  await new Promise<void>((r) => feedServer.close(() => r()));
});

describe("adding an API, feed or files connection — the tools Metistry generates, at Ask First", () => {
  it("a feed: reached once, written with list_items, get_item and search_items, every one Ask First", async () => {
    const dir = await instance("feed");
    const r = await run(["connections", "add", "news", "--type", "feed", "--url", feedUrl, "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    expect(conn(dir, "news").tools).toEqual({
      get_item: { group: "reads", mode: "ask" },
      list_items: { group: "reads", mode: "ask" },
      search_items: { group: "reads", mode: "ask" },
    });
    expect(r.all).toMatch(/3 tools the tools Metistry generates for a feed connection \(it answered\)/);
    expect(r.all).toMatch(/every generated tool starts at Ask First/);
  });

  it("an API: get is Reads, request is Changes things — both Ask First; a feed that does not answer writes nothing", async () => {
    const dir = await instance("api");
    const r = await run(["connections", "add", "svc", "--type", "api", "--url", "https://api.example.test/v1", "--auth", "bearer", "--secret", "svc_token", "--no-discover", "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    expect(conn(dir, "svc").tools).toEqual({ get: { group: "reads", mode: "ask" }, request: { group: "changes", mode: "ask" } });
    const dead = await run(["connections", "add", "dead", "--type", "feed", "--url", feedUrl.replace("feed.xml", "gone.xml"), "--instance", dir]);
    expect(dead.code).toBe(1);
    expect(dead.all).toMatch(/dead did not answer, so nothing was written — .*HTTP 404/);
  });

  it("files by path, with include and skip patterns", async () => {
    const dir = await instance("files", { "notes/a.md": "# a\n" });
    const r = await run(["connections", "add", "notes", "--type", "files", "--path", "notes", "--include", "*.md", "--skip", "drafts/**", "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    expect(conn(dir, "notes")).toMatchObject({ reach: { path: { path: "notes", include: ["*.md"], skip: ["drafts/**"] } }, tools: { list_files: { group: "reads", mode: "ask" }, read_file: { group: "reads", mode: "ask" }, search_files: { group: "reads", mode: "ask" } } });
    const refused = await run(["connections", "add", "x", "--type", "files", "--path", "notes", "--url", "https://x.example.test/", "--instance", dir]);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/say how it is reached — one of/);
  });
});

describe("--auth oauth", () => {
  it("a custom connection names its client, and brings its own client id — each a secret's NAME", async () => {
    const dir = await instance("oauth-custom");
    const missing = await run(["connections", "add", "cx", "--type", "mcp", "--url", "https://mcp.example.test/mcp", "--auth", "oauth", "--instance", dir]);
    expect(missing.code).toBe(1);
    expect(missing.all).toMatch(/a custom OAuth connection names its client — no connection type supplies one \(C118\): --authorize-url, --token-url, --scope, --client-id-secret/);
    const r = await run([
      "connections", "add", "cx", "--type", "mcp", "--url", "https://mcp.example.test/mcp", "--auth", "oauth",
      "--authorize-url", AUTHORIZE_URL, "--token-url", TOKEN_URL, "--scope", "read", "--scope", "offline_access", "--client-id-secret", "cx_client", "--instance", dir,
    ]);
    expect(r.code, r.all).toBe(0);
    expect(conn(dir, "cx")).toMatchObject({
      reach: { http: { auth: { scheme: "oauth", client: { authorize_url: AUTHORIZE_URL, token_url: TOKEN_URL, scopes: ["read", "offline_access"], pkce: true, redirect: "loopback" }, token: "{{ secret.cx_oauth_token }}", client_id: "{{ secret.cx_client }}" } } },
      secrets: ["cx_oauth_token", "cx_client"],
      tools: {},
    });
    expect(r.all).toMatch(/not dialled: sign in first/);
    expect(r.all).toMatch(/next: `metistry connections authorize cx`/);
    const value = await run(["connections", "set", "cx", "--client-id-secret", "1234.apps.example", "--instance", dir]);
    expect(value.code).toBe(1);
    expect(value.all).toMatch(/--client-id-secret takes the NAME of a secret/);
  });
});

describe("`metistry connections authorize` — **one callback on 127.0.0.1; the state and the PKCE verifier checked**", () => {
  let as: FakeAuthServer;
  afterEach(async () => {
    await as?.close();
  });

  async function added(dir: string) {
    return run([
      "connections", "add", "cx", "--type", "api", "--url", "https://api.example.test/v1", "--auth", "oauth",
      "--authorize-url", AUTHORIZE_URL, "--token-url", TOKEN_URL, "--scope", "read", "--client-id-secret", "cx_client", "--no-discover", "--instance", dir,
    ]);
  }
  const clientPolicy = `secrets:\n  cx_client: { hosts: [auth.example.test], grants: { "connection:cx": on } }\n`;

  it("signs in through the browser, keeps the refresh token in this instance's Keychain — never printed — and writes its policy", async () => {
    as = await fakeAuthServer({ clients: ["owners-client"] });
    const dir = await instance("authorize", { ".metistry/secrets.yaml": clientPolicy });
    expect((await added(dir)).code).toBe(0);
    const mac = fakeMac((url) => as.browse(url).then(() => undefined));
    mac.store.set(`${ID}/metistry:secret:cx_client`, "owners-client");
    const r = await run(["connections", "authorize", "cx", "--instance", dir], mac, as.routeTo());
    expect(r.code, r.all).toBe(0);
    // the browser was sent to the provider; the answer came back to 127.0.0.1
    expect(mac.opened.length).toBe(1);
    expect(new URL(mac.opened[0]!).origin).toBe("https://auth.example.test");
    const redirect = new URL(as.authorizeRequests[0]!.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(r.all).toMatch(/listening for the answer on http:\/\/127\.0\.0\.1:\d+\/callback \(127\.0\.0\.1 only, one callback/);
    // the verifier the exchange sent is the one the challenge was made from — the fixture checked it
    expect(as.tokenRequests[0]!.grant_type).toBe("authorization_code");
    expect(as.issuedRefresh.length).toBe(1);
    // kept, and never printed
    expect(mac.store.get(`${ID}/metistry:secret:cx_oauth_token`)).toBe(as.issuedRefresh[0]);
    expect(r.all).not.toContain(as.issuedRefresh[0]!);
    expect(r.all).not.toContain(as.issuedAccess[0]!);
    // the listener is gone: a second callback finds nothing
    await expect(fetch(`${redirect.href}?code=x&state=y`)).rejects.toThrow();
    // the first sign-in wrote the token secret's policy: the token endpoint and the service, this connection only
    expect(yamlOf(dir, ".metistry/secrets.yaml").secrets.cx_oauth_token).toEqual({ hosts: ["auth.example.test", "api.example.test"], grants: { "connection:cx": "on" } });
    expect(r.all).toMatch(/next: `metistry secrets sync --to env`/);
  });

  it("a callback carrying another state is refused: nothing is exchanged and nothing is kept", async () => {
    as = await fakeAuthServer({ clients: ["owners-client"] });
    const dir = await instance("authorize-state", { ".metistry/secrets.yaml": clientPolicy });
    expect((await added(dir)).code).toBe(0);
    const mac = fakeMac((url) => as.browse(url, (back) => back.searchParams.set("state", "forged")).then(() => undefined));
    mac.store.set(`${ID}/metistry:secret:cx_client`, "owners-client");
    const r = await run(["connections", "authorize", "cx", "--instance", dir], mac, as.routeTo());
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/state_mismatch/);
    expect(as.tokenRequests).toEqual([]);
    expect(mac.store.has(`${ID}/metistry:secret:cx_oauth_token`)).toBe(false);
  });

  it("--no-browser prints the address instead; a connection that does not sign in with OAuth is refused", async () => {
    const dir = await instance("authorize-plain");
    await run(["connections", "add", "plain", "--type", "api", "--url", "https://api.example.test/v1", "--no-discover", "--instance", dir]);
    const r = await run(["connections", "authorize", "plain", "--instance", dir]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/plain does not sign in with OAuth/);
  });
});

describe("a sync's first connection (§2.5, ruled 2026-09-27)", () => {
  const linear = (dir: string, name: string) =>
    run([
      "connections", "add", name, "--type", "tracker", "--provider", "linear", "--url", "https://api.linear.app/graphql",
      "--auth", "api_key", "--auth-header", "Authorization", "--secret", "linear_api_key", "--no-discover", "--instance", dir,
    ]);

  it("add writes syncs.<sync>.connection when nothing names one — the owner's comments and entries kept", async () => {
    const dir = await instance("sync-first", { ".metistry/scheduled.yaml": "# the owner's own comment\nroutines:\n  standup: { paused: true }\n" });
    const r = await linear(dir, "work-linear");
    expect(r.code, r.all).toBe(0);
    const text = readFileSync(join(dir, ".metistry/scheduled.yaml"), "utf8");
    expect(text).toMatch(/^# the owner's own comment/);
    expect(parseYaml(text)).toEqual({ routines: { standup: { paused: true } }, syncs: { linear: { connection: "work-linear" } } });
    expect(r.all).toMatch(/linear reads work-linear: \.metistry\/scheduled\.yaml syncs\.linear\.connection \(its first connection/);
  });

  it("an entry that already names one is left as it is; a provider no sync reads writes nothing", async () => {
    const dir = await instance("sync-kept", { ".metistry/scheduled.yaml": "syncs:\n  linear: { connection: first, every: 1h }\n" });
    const r = await linear(dir, "second");
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, ".metistry/scheduled.yaml")).toEqual({ syncs: { linear: { connection: "first", every: "1h" } } });
    expect(r.all).toMatch(/linear already reads first .* left as it is/);
    const none = await instance("sync-none");
    await run(["connections", "add", "svc", "--type", "api", "--url", "https://api.example.test/v1", "--no-discover", "--instance", none]);
    expect(() => readFileSync(join(none, ".metistry/scheduled.yaml"))).toThrow();
  });
});
