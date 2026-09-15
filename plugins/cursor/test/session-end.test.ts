// The hook's whole contract, exercised the way Cursor exercises it: the script
// is spawned as a child process with the `sessionEnd` payload on stdin, against
// a local node:http stand-in for the console. Asserts the request shape
// `POST /capture` expects (apps/console/src/server.ts), the bearer header,
// the `kind: session` frontmatter, the stable idempotency key, token
// redaction, the local-file fallback, and that nothing here can fail a session.
//
// The payload fixtures are Cursor's documented `sessionEnd` input plus the
// fields every hook receives (cursor.com/docs/hooks, checked 2026-09-15).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSession, summarizeSessionEnd } from "../scripts/lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const HOOK = join(ROOT, "hooks/session-end.mjs");
const TOKEN = "mtk_test_secret_token_0123456789";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

/** One real Cursor `sessionEnd` payload: hook-specific fields + the common ones. */
const PAYLOAD = {
  session_id: "3f2b9c10-aaaa-bbbb-cccc-1234567890ab",
  reason: "user_close",
  duration_ms: 2_760_000,
  is_background_agent: false,
  final_status: "completed",
  conversation_id: "3f2b9c10-aaaa-bbbb-cccc-1234567890ab",
  generation_id: "gen-7",
  model: "some-model-thinking",
  model_id: "some-model",
  hook_event_name: "sessionEnd",
  cursor_version: "1.7.2",
  workspace_roots: ["/Users/example/Development/demo"],
  user_email: "someone@example.com",
  transcript_path: "/Users/example/.cursor/transcripts/3f2b9c10.txt",
};

function run(env: Record<string, string | undefined>, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env }, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function frontmatter(note: string): Record<string, string | number | null> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(note);
  if (!m) throw new Error("no frontmatter");
  const out: Record<string, string | number | null> = {};
  for (const line of m[1]!.split("\n")) {
    const [k, ...rest] = line.split(": ");
    out[k!] = JSON.parse(rest.join(": ")) as string | number | null;
  }
  return out;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: 42, path: "1-x.md", sha256: "abc" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

describe("sessionEnd hook", () => {
  it("is inert by default: no request, exit 0, silent", async () => {
    seen.length = 0;
    const r = await run({ METISTRY_URL: base, METISTRY_AGENT_TOKEN_CURSOR: TOKEN }, JSON.stringify(PAYLOAD));
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(seen).toHaveLength(0);
  });

  it("when enabled, posts a session note built from the payload alone", async () => {
    seen.length = 0;
    const r = await run({ METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: `${base}/`, METISTRY_AGENT_TOKEN_CURSOR: TOKEN }, JSON.stringify(PAYLOAD));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("metistry: session captured → inbox #42");

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/capture"); // trailing slash on METISTRY_URL normalized
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["idempotency-key"]).toMatch(/^cursor:3f2b9c10-aaaa-bbbb-cccc-1234567890ab:[0-9a-f]{16}$/);

    const body = JSON.parse(req.body) as { note: string; filename: string };
    expect(Object.keys(body).sort()).toEqual(["filename", "note"]); // exactly the server's fields
    expect(body.filename).toMatch(/^cursor-session-\d{8}T\d{6}Z-3f2b9c10\.md$/);

    const fm = frontmatter(body.note);
    expect(fm).toMatchObject({
      kind: "session",
      source: "cursor",
      session_id: PAYLOAD.session_id,
      project: "/Users/example/Development/demo",
      repo: "demo",
      host: hostname(),
      // no timestamps in the payload, so the key stays stable across invocations
      started: null,
      ended: null,
      turns: null,
      idempotency_key: req.headers["idempotency-key"],
    });
    expect(fm.title).toMatch(/^Cursor session — demo — \d{4}-\d{2}-\d{2}$/);
    expect(String(fm.captured_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The facts Cursor actually gives, and nothing invented from the transcript.
    expect(body.note).toContain("- Duration: 46m");
    expect(body.note).toContain("- Project: `/Users/example/Development/demo`");
    expect(body.note).toContain("- Models: some-model");
    expect(body.note).toContain("- Cursor: 1.7.2");
    expect(body.note).toContain("- Ended: user_close (completed)");
    expect(body.note).toContain("## Not captured");
    expect(body.note).toContain("`transcript_path` is undocumented");
    expect(body.note).not.toContain("- Turns:");
    expect(body.note).not.toContain("## Tools");
    expect(body.note).not.toContain("Claude Code");
    // the transcript path is never read and never carried
    expect(body.note).not.toContain(PAYLOAD.transcript_path);
  });

  it("computes the same key twice for one session, so a retry dedupes server-side", async () => {
    seen.length = 0;
    const env = { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: base, METISTRY_AGENT_TOKEN_CURSOR: TOKEN };
    await run(env, JSON.stringify(PAYLOAD));
    await run(env, JSON.stringify(PAYLOAD));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["idempotency-key"]).toBe(seen[1]!.headers["idempotency-key"]);
    expect(frontmatter(JSON.parse(seen[0]!.body).note).idempotency_key).toBe(frontmatter(JSON.parse(seen[1]!.body).note).idempotency_key);
  });

  it("accepts an owner token, and reports a background agent's session as one", async () => {
    seen.length = 0;
    const payload = { ...PAYLOAD, is_background_agent: true, reason: "error", error_message: "the model returned nothing" };
    const r = await run({ METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN }, JSON.stringify(payload));
    expect(r.code).toBe(0);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const note = (JSON.parse(seen[0]!.body) as { note: string }).note;
    expect(note).toContain("- Background agent: yes");
    expect(note).toContain("- Error: the model returned nothing");
  });

  it("falls back to METISTRY_CAPTURE_DIR when the console is unreachable (SHOULD-10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-cursor-fallback-"));
    const r = await run(
      { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: "http://127.0.0.1:9", METISTRY_AGENT_TOKEN_CURSOR: TOKEN, METISTRY_CAPTURE_DIR: dir },
      JSON.stringify(PAYLOAD),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("console unreachable");
    expect(r.stdout).toContain(dir);
    expect(r.stdout).not.toContain(TOKEN);

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^cursor-session-\d{8}T\d{6}Z-3f2b9c10\.md$/);
    const note = readFileSync(join(dir, files[0]!), "utf8");
    expect(frontmatter(note)).toMatchObject({ kind: "session", source: "cursor", session_id: PAYLOAD.session_id });
    expect(note).not.toContain(TOKEN);
  });

  it("never fails the session: unreachable instance, missing config, garbage stdin, no session id", async () => {
    const unreachable = await run(
      { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: "http://127.0.0.1:9", METISTRY_AGENT_TOKEN_CURSOR: TOKEN },
      JSON.stringify(PAYLOAD),
    );
    expect(unreachable.code).toBe(0);
    expect(unreachable.stderr.trim().split("\n")).toHaveLength(1);
    expect(unreachable.stderr).toMatch(/^metistry: session capture skipped: /);
    expect(unreachable.stderr).not.toContain(TOKEN);

    const noConfig = await run({ METISTRY_CAPTURE_ON_STOP: "1" }, JSON.stringify(PAYLOAD));
    expect(noConfig.code).toBe(0);
    expect(noConfig.stderr.trim().split("\n")).toHaveLength(1);
    expect(noConfig.stderr).toContain("METISTRY_URL is not set");

    seen.length = 0;
    for (const stdin of ["{{not json", "", JSON.stringify({ hook_event_name: "sessionEnd", reason: "completed" })]) {
      const r = await run({ METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: base, METISTRY_AGENT_TOKEN_CURSOR: TOKEN }, stdin);
      expect(r).toEqual({ code: 0, stdout: "", stderr: "" }); // no session id → nothing to dedupe on → silent
    }
    expect(seen).toHaveLength(0);
  });
});

describe("summarizeSessionEnd", () => {
  it("takes the workspace root, or CURSOR_PROJECT_DIR when the payload omits it", () => {
    expect(summarizeSessionEnd(PAYLOAD, { env: {} })!.project).toBe("/Users/example/Development/demo");
    const noRoots = summarizeSessionEnd({ ...PAYLOAD, workspace_roots: [] }, { env: { CURSOR_PROJECT_DIR: "/tmp/work" } })!;
    expect([noRoots.project, noRoots.repo]).toEqual(["/tmp/work", "work"]);
    expect(summarizeSessionEnd({ ...PAYLOAD, workspace_roots: undefined }, { env: {} })!.project).toBeNull();
  });

  it("guards every field a newer Cursor might stop sending", () => {
    const bare = summarizeSessionEnd({ session_id: "s1" }, { env: {} })!;
    expect(bare).toMatchObject({ sessionId: "s1", durationMs: null, models: [], version: null, reason: null, backgroundAgent: false });
    expect(summarizeSessionEnd({ session_id: "s1", duration_ms: "45s" }, { env: {} })!.durationMs).toBeNull();
    expect(summarizeSessionEnd({ session_id: "s1", duration_ms: -1 }, { env: {} })!.durationMs).toBeNull();
    expect(summarizeSessionEnd({ conversation_id: "c1" }, { env: {} })!.sessionId).toBe("c1");
    for (const bad of [null, undefined, "nope", {}, { session_id: "   " }]) expect(summarizeSessionEnd(bad, { env: {} })).toBeNull();
  });
});

describe("captureSession's fallback, unit", () => {
  it("writes the note to the capture dir when fetch throws, and rethrows when there is nowhere to put it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-cursor-unit-"));
    const summary = summarizeSessionEnd(PAYLOAD, { env: {} })!;
    const boom = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8080"));
    const env = { METISTRY_URL: "http://127.0.0.1:8080", METISTRY_AGENT_TOKEN_CURSOR: TOKEN, METISTRY_CAPTURE_DIR: dir };

    const r = await captureSession({ summary, env, fetchFn: boom, now: new Date("2026-09-15T12:00:00.000Z") });
    expect(r.delivered).toBe("file");
    expect(r.path).toBe(join(dir, "cursor-session-20260915T120000Z-3f2b9c10.md"));
    expect(r.reason).toContain("capture unreachable");
    expect(readFileSync(r.path, "utf8")).toContain(`source: "cursor"`);

    // Same call, no capture dir: the error surfaces (the hook turns it into one
    // redacted stderr line and still exits 0).
    await expect(captureSession({ summary, env: { ...env, METISTRY_CAPTURE_DIR: "" }, fetchFn: boom })).rejects.toThrow("capture unreachable");
  });

  it("expands a leading ~/ in METISTRY_CAPTURE_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "metistry-cursor-home-"));
    const summary = summarizeSessionEnd(PAYLOAD, { env: {} })!;
    const r = await captureSession({
      summary,
      env: { METISTRY_URL: "http://127.0.0.1:8080", METISTRY_AGENT_TOKEN_CURSOR: TOKEN, METISTRY_CAPTURE_DIR: "~/Metistry Inbox" },
      fetchFn: () => Promise.reject(new Error("down")),
      home,
    });
    expect(r.path.startsWith(join(home, "Metistry Inbox"))).toBe(true);
  });
});
