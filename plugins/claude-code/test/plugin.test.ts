// The plugin's whole contract, exercised the way Claude Code exercises it:
// the scripts are spawned as child processes against a local node:http
// stand-in for the console. Asserts the request shape POST /capture
// expects (apps/console/src/server.ts), the bearer header, provenance in
// the note, token redaction, and the hook's failure-is-silent behavior.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const CAPTURE = join(ROOT, "skills/metistry-capture/scripts/capture.mjs");
const HOOK = join(ROOT, "scripts/session-end.mjs");
const TOKEN = "mtk_test_secret_token_0123456789";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let respond: (req: Seen) => { status: number; body: string } = () => ({
  status: 201,
  body: JSON.stringify({ id: 42, path: "1-x.md", sha256: "abc" }),
});

function run(script: string, args: string[], env: Record<string, string | undefined>, stdin?: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, ...env },
      cwd: ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function frontmatter(note: string): Record<string, string | null> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(note);
  if (!m) throw new Error("no frontmatter");
  const out: Record<string, string | null> = {};
  for (const line of m[1]!.split("\n")) {
    const [k, ...rest] = line.split(": ");
    out[k!] = JSON.parse(rest.join(": ")) as string | null;
  }
  return out;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(rec);
      const r = respond(rec);
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

describe("metistry-capture skill script", () => {
  it("POSTs JSON to /capture with the bearer header and provenance in the note", async () => {
    seen.length = 0;
    const r = await run(
      CAPTURE,
      ["--kind", "decision", "--title", "Use SessionEnd", "--body", "Stop fires per turn; SessionEnd once."],
      { METISTRY_URL: `${base}/`, METISTRY_OWNER_TOKEN: TOKEN, CLAUDE_SESSION_ID: "sess-123" },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("captured → inbox #42 (1-x.md)");

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/capture"); // trailing slash on METISTRY_URL normalized
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body) as { note: string; filename: string };
    expect(Object.keys(body).sort()).toEqual(["filename", "note"]); // exactly the server's fields
    expect(body.filename).toMatch(/^claude-code-decision-\d{8}T\d{6}Z\.md$/);
    const fm = frontmatter(body.note);
    expect(fm).toMatchObject({
      source: "claude-code",
      kind: "decision",
      title: "Use SessionEnd",
      session_id: "sess-123",
      host: hostname(),
      cwd: ROOT.replace(/\/$/, ""),
    });
    // repo = name of the enclosing checkout (this worktree's dir), never the plugin dir itself
    expect(fm.repo).toEqual(expect.any(String));
    expect(fm.repo).not.toBe(basename(ROOT.replace(/\/$/, "")));
    expect(body.note).toContain("# Use SessionEnd\n\nStop fires per turn; SessionEnd once.");
  });

  it("reads the body from stdin and never prints the token, even when the server echoes it", async () => {
    seen.length = 0;
    respond = (req) => ({ status: 500, body: `boom auth=${req.headers.authorization}` });
    try {
      const r = await run(CAPTURE, ["--kind", "finding", "--title", "t"], { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN }, "from stdin");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("HTTP 500");
      expect(r.stderr).toContain("[redacted]");
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
      expect(JSON.parse(seen[0]!.body).note).toContain("from stdin");
    } finally {
      respond = () => ({ status: 201, body: JSON.stringify({ id: 42, path: "1-x.md", sha256: "abc" }) });
    }
  });

  it("fails clearly without config and rejects an unknown kind — no request made", async () => {
    seen.length = 0;
    const noUrl = await run(CAPTURE, ["--title", "t", "--body", "b"], { METISTRY_OWNER_TOKEN: TOKEN });
    expect(noUrl.code).toBe(1);
    expect(noUrl.stderr).toContain("METISTRY_URL is not set");
    const badKind = await run(CAPTURE, ["--kind", "rant", "--title", "t", "--body", "b"], { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN });
    expect(badKind.code).toBe(1);
    expect(badKind.stderr).toContain("kind must be one of");
    expect(seen).toHaveLength(0);
  });
});

describe("session-end hook", () => {
  const transcript = join(mkdtempSync(join(tmpdir(), "metistry-plugin-")), "t.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "fix the flaky test" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
      "not json at all",
      JSON.stringify({ type: "user", isMeta: true, message: { content: "meta noise" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: the test awaited nothing." }] } }),
    ].join("\n"),
  );
  const input = JSON.stringify({ session_id: "sess-9", cwd: ROOT, hook_event_name: "SessionEnd", reason: "other", transcript_path: transcript });

  it("is inert by default: no request, exit 0, silent", async () => {
    seen.length = 0;
    const r = await run(HOOK, [], { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN }, input);
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(seen).toHaveLength(0);
  });

  it("when enabled, posts a session summary built from the transcript", async () => {
    seen.length = 0;
    const r = await run(HOOK, [], { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN }, input);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("metistry: session captured → inbox #42");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(seen[0]!.body) as { note: string; filename: string };
    expect(body.filename).toMatch(/^claude-code-session-\d{8}T\d{6}Z-sess-9\.md$/);
    const fm = frontmatter(body.note);
    // The shape `metistry import-sessions` also sends (docs/ops/cli.md).
    expect(fm.kind).toBe("session");
    expect(fm.session_id).toBe("sess-9");
    expect(fm.source).toBe("claude-code");
    expect(fm.idempotency_key).toMatch(/^claude-code:sess-9:[0-9a-f]{16}$/);
    expect(body.note).toContain("- Turns: 1 user, 2 assistant");
    expect(body.note).toContain("- Bash × 1");
    expect(body.note).toContain("fix the flaky test");
    expect(body.note).toContain("Done: the test awaited nothing.");
    expect(body.note).not.toContain("meta noise");
  });

  it("never fails the session: unreachable instance, missing config, garbage stdin all exit 0 with at most one stderr line", async () => {
    const unreachable = await run(HOOK, [], { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: "http://127.0.0.1:9", METISTRY_OWNER_TOKEN: TOKEN }, input);
    expect(unreachable.code).toBe(0);
    expect(unreachable.stderr.trim().split("\n")).toHaveLength(1);
    expect(unreachable.stderr).toMatch(/^metistry: session capture skipped: /);
    expect(unreachable.stderr).not.toContain(TOKEN);

    const noConfig = await run(HOOK, [], { METISTRY_CAPTURE_ON_STOP: "1" }, input);
    expect(noConfig.code).toBe(0);
    expect(noConfig.stderr.trim().split("\n")).toHaveLength(1);

    const garbage = await run(HOOK, [], { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN }, "{{not json");
    expect(garbage.code).toBe(0); // no transcript → nothing to say → silent
    expect(garbage.stderr).toBe("");
  });
});
