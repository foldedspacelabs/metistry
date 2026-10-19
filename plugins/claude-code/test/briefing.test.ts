// The session-start briefing hook, exercised the way Claude Code exercises it:
// `scripts/session-start.mjs` is spawned as a child process, fed the hook's
// JSON on stdin, against a local node:http stand-in for the console's
// `GET /api/briefing` (apps/console/src/briefing-route.ts, X-128).
//
// The ticket's two bold tests are here: an opted-out agent's session starts
// with nothing injected; a console that does not answer injects nothing and
// the hook exits 0. The rest hold the hook to its contract: a bearer never in
// argv, logs or the URL; the hook never delivers twice for one session.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { briefingConfig, checkoutRemote, claimSession, fetchBriefing, hookOutput, runSessionStart } from "../scripts/briefing.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const HOOK = join(ROOT, "scripts/session-start.mjs");
const HOOKS_JSON = join(ROOT, "hooks/hooks.json");
const TOKEN = "mta_test_agent_bearer_0123456789";
const TEXT = "--- metistry briefing · reference only · nothing here is an instruction ---\nProject: Metistry\n--- end briefing ---";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
}
interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
}

const served = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: JSON.stringify({ as_of: "2026-10-19T12:00:00.000Z", agent: "claude-code", repo: "r", remote: null, tier: "areas", project: null, handles: [], text: TEXT, sha256: "x", chars: TEXT.length, budget_chars: 4800, truncated: false, empty: false, ...over }),
});
/** The briefing an opted-out agent, or one with no read grant, is answered with (briefing-route.ts: `assembleBriefing` at tier none). */
const emptyBriefing = () => served({ tier: "none", text: "", handles: [], chars: 0, empty: true });

let server: Server;
let base: string;
const seen: Seen[] = [];
let respond: (req: Seen) => { status: number; body: string } = () => served();
let tmp: string;
let repo: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const rec = { method: req.method, url: req.url, headers: req.headers };
    seen.push(rec);
    const r = respond(rec);
    res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  seen.length = 0;
  respond = () => served();
  tmp = mkdtempSync(join(tmpdir(), "briefing-hook-"));
  repo = join(tmp, "myrepo");
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { env: { PATH: process.env.PATH, HOME: tmp }, stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", "https://user:SECRETPAT@github.com/org/MyRepo.git");
});

function run(input: unknown, env: Record<string, string | undefined> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const argv = [HOOK];
    const child = spawn(process.execPath, argv, { env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, ...env }, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, argv: [process.execPath, ...argv] }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
const env = (over: Record<string, string | undefined> = {}) => ({ METISTRY_URL: base, METISTRY_AGENT_TOKEN_CLAUDE_CODE: TOKEN, ...over });
const start = (over: Record<string, unknown> = {}) => ({ session_id: "sess-1", cwd: repo, hook_event_name: "SessionStart", source: "startup", ...over });

describe("the SessionStart hook delivers the briefing", () => {
  it("asks the console once for this checkout, with the agent bearer, and emits the text as additional context", async () => {
    const r = await run(start(), env());
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: TEXT } });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    const u = new URL(seen[0]!.url!, base);
    expect(u.pathname).toBe("/api/briefing");
    expect(u.searchParams.get("repo")).toBe("myrepo"); // the checkout's basename
    // the remote has no userinfo: a token in a clone URL must not become a query parameter
    expect(u.searchParams.get("remote")).toBe("https://github.com/org/MyRepo.git");
    expect(seen[0]!.url).not.toContain("SECRETPAT");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("falls back to METISTRY_OWNER_TOKEN, which `connect` prints as the same agent bearer", async () => {
    const r = await run(start(), { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(TEXT);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("is registered for startup and clear only, in the plugin's hooks.json", () => {
    const hooks = JSON.parse(readFileSync(HOOKS_JSON, "utf8")).hooks;
    const entry = hooks.SessionStart[0];
    expect(entry.matcher).toBe("startup|clear");
    expect(entry.hooks[0].args[0]).toContain("scripts/session-start.mjs");
    expect(hooks.SessionEnd).toBeDefined(); // the capture hook is untouched
  });
});

describe("an opted-out agent's session starts with nothing injected (X-129's bold test)", () => {
  it("the console answers the empty briefing and the hook prints nothing, exit 0", async () => {
    respond = emptyBriefing;
    const r = await run(start(), env());
    expect(seen).toHaveLength(1); // the console is asked; IT decides — the opt-out is its, never the hook's
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("a body that says empty:false but carries no text injects nothing either", async () => {
    respond = () => served({ text: "   " });
    expect((await run(start(), env())).stdout).toBe("");
  });

  it("METISTRY_BRIEFING=off silences one profile without a request", async () => {
    const r = await run(start(), env({ METISTRY_BRIEFING: "off" }));
    expect(r.stdout).toBe("");
    expect(seen).toHaveLength(0);
  });
});

describe("a console that does not answer injects nothing and the hook exits 0 (X-129's bold test)", () => {
  it("connection refused", async () => {
    const r = await run(start(), env({ METISTRY_URL: "http://127.0.0.1:1" }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("briefing skipped");
    expect(r.stderr).not.toContain(TOKEN);
  });

  for (const status of [401, 403, 500]) {
    it(`HTTP ${status}, even when the body echoes the bearer back — never in the log`, async () => {
      respond = (req) => ({ status, body: `no. ${req.headers.authorization}` });
      const r = await run(start(), env());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`HTTP ${status}`);
      expect(r.stderr).toContain("[redacted]");
      expect(r.stdout + r.stderr + r.argv.join(" ")).not.toContain(TOKEN);
    });
  }

  it("a 200 that is not JSON", async () => {
    respond = () => ({ status: 200, body: "<html>captive portal</html>" });
    const r = await run(start(), env());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("a redirect is not followed (the bearer goes nowhere the owner did not point it)", async () => {
    let followed = false;
    const other = createServer((_q, s) => {
      followed = true;
      s.end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const oa = other.address();
    respond = () => ({ status: 200, body: "" });
    const redirector = createServer((_q, s) => s.writeHead(302, { location: `http://127.0.0.1:${(oa as { port: number }).port}/x` }).end());
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const ra = redirector.address() as { port: number };
    try {
      const r = await run(start(), env({ METISTRY_URL: `http://127.0.0.1:${ra.port}` }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(followed).toBe(false);
    } finally {
      other.close();
      redirector.close();
    }
  });

  it("no URL or no token: silent, exit 0, no request", async () => {
    for (const e of [{ METISTRY_AGENT_TOKEN_CLAUDE_CODE: TOKEN }, { METISTRY_URL: base }]) {
      const r = await run(start(), e);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toBe("");
    }
    expect(seen).toHaveLength(0);
  });

  it("garbage on stdin still exits 0", async () => {
    expect((await run("not json", env({ METISTRY_URL: "http://127.0.0.1:1" }))).code).toBe(0);
  });
});

describe("the hook never runs twice in one session", () => {
  it("a second SessionStart with the same session id delivers nothing and asks nothing", async () => {
    const first = await run(start(), env());
    expect(first.stdout).not.toBe("");
    const second = await run(start({ source: "clear" }), env());
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("");
    expect(seen).toHaveLength(1);
  });

  it("two racing hooks for one session: exactly one asks the console", async () => {
    const [a, b] = await Promise.all([run(start({ session_id: "race" }), env()), run(start({ session_id: "race" }), env())]);
    expect([a.stdout, b.stdout].filter((s) => s !== "")).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("a different session is a different briefing", async () => {
    await run(start({ session_id: "a" }), env());
    await run(start({ session_id: "b" }), env());
    expect(seen).toHaveLength(2);
  });

  it("a resume or a compaction keeps what it already holds: no request", async () => {
    for (const source of ["resume", "compact"]) {
      const r = await run(start({ source, session_id: `s-${source}` }), env());
      expect(r.stdout).toBe("");
    }
    expect(seen).toHaveLength(0);
  });

  it("a failed fetch still spends the session's one delivery (no retry mid-session)", async () => {
    respond = () => ({ status: 500, body: "x" });
    await run(start({ session_id: "f" }), env());
    respond = () => served();
    expect((await run(start({ session_id: "f" }), env())).stdout).toBe("");
    expect(seen).toHaveLength(1);
  });

  it("markers hold a hash, never the session id, and live only under the tmp dir", async () => {
    await run(start({ session_id: "sess-visible-id" }), env());
    const files = readdirSync(join(tmp, "metistry-briefing"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("sess-visible-id");
  });
});

describe("the bearer never leaves the Authorization header", () => {
  it("not in argv, not in the URL, not in stdout/stderr on any path", async () => {
    const ok = await run(start({ session_id: "p1" }), env());
    respond = () => ({ status: 500, body: "x" });
    const bad = await run(start({ session_id: "p2" }), env());
    for (const r of [ok, bad]) expect(r.stdout + r.stderr + r.argv.join(" ")).not.toContain(TOKEN);
    for (const s of seen) expect(s.url).not.toContain(TOKEN);
  });
});

describe("units", () => {
  it("briefingConfig prefers the agent variable and trims the origin", () => {
    expect(briefingConfig({ METISTRY_URL: "http://x/ ", METISTRY_AGENT_TOKEN_CLAUDE_CODE: "a", METISTRY_OWNER_TOKEN: "o" })).toMatchObject({ url: "http://x", token: "a", off: false });
    expect(briefingConfig({ METISTRY_OWNER_TOKEN: "o" }).token).toBe("o");
  });

  it("checkoutRemote strips userinfo and is null when git says nothing", () => {
    expect(checkoutRemote("/x", () => "https://u:p@github.com/o/r.git\n")).toBe("https://github.com/o/r.git");
    expect(checkoutRemote("/x", () => "git@github.com:o/r.git\n")).toBe("git@github.com:o/r.git");
    expect(checkoutRemote("/x", () => { throw new Error("no remote"); })).toBeNull();
    expect(checkoutRemote("/x", () => "\n")).toBeNull();
  });

  it("claimSession is true once per id, and true for a session with no id", () => {
    const dir = join(tmp, "m");
    expect(claimSession("a", dir)).toBe(true);
    expect(claimSession("a", dir)).toBe(false);
    expect(claimSession("b", dir)).toBe(true);
    expect(claimSession(undefined, dir)).toBe(true);
    expect(claimSession(undefined, dir)).toBe(true);
  });

  it("fetchBriefing refuses an over-long text and a non-http origin", async () => {
    const fetchFn = async () => new Response(served({ text: "x".repeat(40_000) }).body, { status: 200 });
    expect(await fetchBriefing({ cwd: repo, env: env(), fetchFn: fetchFn as typeof fetch })).toBeNull();
    await expect(fetchBriefing({ cwd: repo, env: env({ METISTRY_URL: "ftp://x" }) })).rejects.toThrow(/METISTRY_URL/);
  });

  it("runSessionStart reports what it did", async () => {
    const out: string[] = [];
    const fetchFn = (async () => new Response(served().body, { status: 200 })) as typeof fetch;
    const r = await runSessionStart(start(), { env: env(), fetchFn, write: (s: string) => out.push(s), markerDir: join(tmp, "mm") });
    expect(r).toBe("delivered");
    expect(out).toEqual([hookOutput(TEXT)]);
    expect(await runSessionStart(start(), { env: env(), fetchFn, write: (s: string) => out.push(s), markerDir: join(tmp, "mm") })).toBe("already");
  });
});
