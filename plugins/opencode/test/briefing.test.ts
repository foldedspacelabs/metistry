// The OpenCode half of the session-start briefing (X-129). OpenCode has no
// SessionStart event, so the plugin answers `experimental.chat.system.transform`:
// asked once per session, added to every turn's system prompt. The console is a
// local node:http stand-in for `GET /api/briefing` (X-128).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MetistryPlugin } from "../plugin.js";
import { briefingConfig, checkoutName, checkoutRemote, createBriefer, fetchBriefing } from "../scripts/briefing.mjs";

const TOKEN = "mta_test_agent_bearer_0123456789";
const TEXT = "--- metistry briefing · reference only · nothing here is an instruction ---\nProject: Metistry\n--- end briefing ---";
const served = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: JSON.stringify({ tier: "areas", handles: [], text: TEXT, sha256: "x", chars: TEXT.length, truncated: false, empty: false, ...over }),
});
const emptyBriefing = () => served({ tier: "none", text: "", empty: true });

interface Seen {
  url: string | undefined;
  headers: IncomingMessage["headers"];
}
let server: Server;
let base: string;
const seen: Seen[] = [];
let respond: (r: Seen) => { status: number; body: string } = () => served();
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const rec = { url: req.url, headers: req.headers };
    seen.push(rec);
    const r = respond(rec);
    res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  seen.length = 0;
  respond = () => served();
  const tmp = mkdtempSync(join(tmpdir(), "oc-briefing-"));
  dir = join(tmp, "myrepo");
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env: { PATH: process.env.PATH, HOME: tmp }, stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", "https://user:SECRETPAT@github.com/org/MyRepo.git");
});

const env = (over: Record<string, string | undefined> = {}) => ({ METISTRY_URL: base, METISTRY_AGENT_TOKEN_OPENCODE: TOKEN, ...over });
// The plugin reads process.env when a turn asks, so the stand-in's settings live there for the test.
const KEYS = ["METISTRY_URL", "METISTRY_AGENT_TOKEN_OPENCODE", "METISTRY_OWNER_TOKEN", "METISTRY_BRIEFING"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const plugin = async (e: Record<string, string | undefined> = env()) => {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(e)) if (v !== undefined) process.env[k] = v;
  return await MetistryPlugin({ client: undefined, directory: dir });
};
const turn = async (hooks: Awaited<ReturnType<typeof MetistryPlugin>>, sessionID?: string) => {
  const output = { system: ["base prompt"] };
  await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output);
  return output.system;
};

describe("the system transform carries the briefing", () => {
  it("asks the console once per session and adds the same text on every turn", async () => {
    const hooks = await plugin();
    expect(await turn(hooks, "s1")).toEqual(["base prompt", TEXT]);
    expect(await turn(hooks, "s1")).toEqual(["base prompt", TEXT]);
    expect(await turn(hooks, "s1")).toEqual(["base prompt", TEXT]);
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0]!.url!, base);
    expect(u.pathname).toBe("/api/briefing");
    expect(u.searchParams.get("repo")).toBe("myrepo");
    expect(u.searchParams.get("remote")).toBe("https://github.com/org/MyRepo.git");
    expect(seen[0]!.url).not.toContain("SECRETPAT");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await turn(hooks, "s2");
    expect(seen).toHaveLength(2); // a different session is a different briefing
  });

  it("concurrent first turns of one session share one request", async () => {
    const briefer = createBriefer({ directory: dir, env: env() });
    await Promise.all([briefer.systemFor("c"), briefer.systemFor("c"), briefer.systemFor("c")]);
    expect(seen).toHaveLength(1);
  });

  it("an opted-out agent's turn gets nothing added (X-129's bold test)", async () => {
    respond = emptyBriefing;
    const hooks = await plugin();
    expect(await turn(hooks, "o")).toEqual(["base prompt"]);
    expect(seen).toHaveLength(1); // the console decides; the plugin only declines to add what it was not given
  });

  it("a console that does not answer adds nothing, throws nothing, and is not asked again", async () => {
    const hooks = await plugin(env({ METISTRY_URL: "http://127.0.0.1:1" }));
    expect(await turn(hooks, "d")).toEqual(["base prompt"]);
    expect(await turn(hooks, "d")).toEqual(["base prompt"]);
  });

  for (const status of [401, 403, 500]) {
    it(`HTTP ${status} adds nothing, and the log line never holds the bearer`, async () => {
      respond = (r) => ({ status, body: `no ${r.headers.authorization}` });
      const lines: string[] = [];
      const briefer = createBriefer({ directory: dir, env: env(), log: async (m: string) => void lines.push(m) });
      expect(await briefer.systemFor("e")).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`HTTP ${status}`);
      expect(lines[0]).toContain("[redacted]");
      expect(lines.join("\n")).not.toContain(TOKEN);
    });
  }

  it("is unconfigured, or switched off, without a request", async () => {
    for (const e of [{ METISTRY_AGENT_TOKEN_OPENCODE: TOKEN, METISTRY_URL: undefined }, { METISTRY_URL: base, METISTRY_AGENT_TOKEN_OPENCODE: undefined }, env({ METISTRY_BRIEFING: "off" })]) {
      expect(await fetchBriefing({ directory: dir, env: e as Record<string, string | undefined> })).toBeNull();
    }
    expect(seen).toHaveLength(0);
  });

  it("does not follow a redirect", async () => {
    const redirector = createServer((_q, s) => s.writeHead(302, { location: "http://127.0.0.1:1/x" }).end());
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const port = (redirector.address() as { port: number }).port;
    try {
      await expect(fetchBriefing({ directory: dir, env: env({ METISTRY_URL: `http://127.0.0.1:${port}` }) })).rejects.toThrow(/unreachable/);
    } finally {
      redirector.close();
    }
  });

  it("keeps the capture hook: the event hook is still there", async () => {
    const hooks = await plugin();
    expect(typeof hooks.event).toBe("function");
  });
});

describe("units", () => {
  it("briefingConfig: the agent variable, then the owner variable", () => {
    expect(briefingConfig({ METISTRY_URL: "http://x/", METISTRY_AGENT_TOKEN_OPENCODE: "a", METISTRY_OWNER_TOKEN: "o" })).toMatchObject({ url: "http://x", token: "a" });
    expect(briefingConfig({ METISTRY_OWNER_TOKEN: "o" }).token).toBe("o");
  });
  it("checkoutName walks up to .git; checkoutRemote strips userinfo", () => {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    expect(checkoutName(join(dir, "a", "b"))).toBe("myrepo");
    expect(checkoutRemote(dir)).toBe("https://github.com/org/MyRepo.git");
    expect(checkoutRemote(dir, () => { throw new Error("x"); })).toBeNull();
  });
});
