// `metistry import-sessions`: against a temp `~/.claude/projects` tree and a
// local node:http stand-in for the console. Never the live instance.
//
// The assertions that matter: the frontmatter shape both capture doors
// promise, the bearer header, a ledger that makes a re-run a no-op, a
// `--dry-run` that reaches no network at all, and a token that cannot reach
// stdout or an error line.

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importSessions, ledgerPathFor, parseSince, readLedger, transcriptsDirFor } from "../src/import-sessions.js";
import { main } from "../src/main.js";

const TOKEN = "owner-token-must-never-be-printed";
const FIXTURE = join(import.meta.dirname, "..", "..", "core", "test", "fixtures", "claude-code-session.jsonl");
const PROJECT_DIR = "-Users-example-Development-demo";
const SESSION = "11111111-2222-3333-4444-555555555555";

interface Seen {
  authorization: string | undefined;
  body: { note: string; filename: string };
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let nextId = 41;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/capture") {
        res.writeHead(404).end("{}");
        return;
      }
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: ++nextId, path: "inbox/x.md", sha256: "deadbeef" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A temp home with one transcript in one project directory. */
async function makeHome(files: { dir?: string; id: string; body?: string; mtime?: Date }[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "metistry-sessions-"));
  for (const f of files) {
    const dir = join(transcriptsDirFor(home), f.dir ?? PROJECT_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${f.id}.jsonl`);
    await writeFile(path, f.body ?? readFileSync(FIXTURE, "utf8"));
    if (f.mtime) await utimes(path, f.mtime, f.mtime);
  }
  return home;
}

function lines(): { out: string[]; err: string[]; opts: { out: (s: string) => void; err: (s: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, opts: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

describe("import-sessions posting", () => {
  it("posts one session as kind session, with the shared frontmatter shape and a bearer header", async () => {
    seen.length = 0;
    const home = await makeHome([{ id: SESSION }]);
    const io = lines();
    const r = await importSessions({
      ...io.opts,
      home,
      host: "studio",
      env: { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN },
      now: () => new Date("2026-09-09T00:00:00.000Z"),
    });
    expect(r).toMatchObject({ code: 0, found: 1, posted: 1, skipped: 0, failed: 0, empty: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.body.filename).toBe("claude-code-session-20260908T100000Z-11111111.md");
    const note = seen[0]!.body.note;
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain(`kind: "session"`);
    expect(note).toContain(`source: "claude-code"`);
    expect(note).toContain(`session_id: "${SESSION}"`);
    expect(note).toContain(`project: "/Users/example/Development/demo"`);
    expect(note).toContain(`repo: "demo"`);
    expect(note).toContain(`started: "2026-09-08T10:00:00.000Z"`);
    expect(note).toContain(`ended: "2026-09-08T10:37:00.000Z"`);
    expect(note).toContain(`host: "studio"`);
    expect(note).toContain(`captured_at: "2026-09-09T00:00:00.000Z"`);
    expect(note).toMatch(/idempotency_key: "claude-code:11111111-2222-3333-4444-555555555555:[0-9a-f]{16}"/);
    // A summary, never a transcript: the reasoning and the tool output stay out.
    expect(note).not.toContain("secret reasoning");
    expect(note).toContain("## Files touched");
    expect(note).toContain("- Read × 1");
    expect([...io.out, ...io.err].join("\n")).not.toContain(TOKEN);
  });

  it("writes a ledger, and a second run posts nothing", async () => {
    seen.length = 0;
    const home = await makeHome([{ id: SESSION }]);
    const first = await importSessions({ ...lines().opts, home, env: { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN } });
    expect(first.posted).toBe(1);
    const ledger = await readLedger(ledgerPathFor(home));
    expect(Object.keys(ledger.sessions)).toEqual([SESSION]);
    expect(ledger.sessions[SESSION]!.idempotency_key).toMatch(/^claude-code:/);
    expect(ledger.sessions[SESSION]!.inbox_id).toBeGreaterThan(0);
    // 0600: the ledger names projects and session ids.
    expect(readFileSync(ledgerPathFor(home), "utf8")).toContain(SESSION);

    const io = lines();
    const second = await importSessions({ ...io.opts, home, env: { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN } });
    expect(second).toMatchObject({ posted: 0, skipped: 1 });
    expect(seen).toHaveLength(1); // still just the first
    expect(io.out.join("\n")).toContain("posted 0, skipped 1");
  });

  it("re-imports when the transcript grew (the mtime moved)", async () => {
    seen.length = 0;
    const home = await makeHome([{ id: SESSION, mtime: new Date("2026-09-08T10:37:00.000Z") }]);
    await importSessions({ ...lines().opts, home, env: { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN } });
    const path = join(transcriptsDirFor(home), PROJECT_DIR, `${SESSION}.jsonl`);
    await writeFile(path, `${readFileSync(path, "utf8")}${JSON.stringify({ type: "user", timestamp: "2026-09-08T11:00:00.000Z", sessionId: SESSION, message: { role: "user", content: "one more thing" } })}\n`);
    const again = await importSessions({ ...lines().opts, home, env: { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN } });
    expect(again.posted).toBe(1);
    expect(seen).toHaveLength(2);
    // A changed session is a new summary, so a new key — the server can tell them apart.
    const keyOf = (i: number) => /idempotency_key: "(.+)"/.exec(seen[i]!.body.note)![1];
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  it("honours --since, --project and --limit, and skips transcripts with nothing to say", async () => {
    seen.length = 0;
    const home = await makeHome([
      { id: SESSION },
      { id: "22222222-0000-0000-0000-000000000000", dir: "-Users-example-Development-other", body: readFileSync(FIXTURE, "utf8").replace(/Development\/demo/g, "Development/other") },
      { id: "33333333-0000-0000-0000-000000000000", body: `{"type":"mode","mode":"normal"}\n` },
    ]);
    const opts = { home, env: { METISTRY_URL: base, METISTRY_OWNER_TOKEN: TOKEN } };
    const byProject = await importSessions({ ...lines().opts, ...opts, project: "/Users/example/Development/other" });
    expect(byProject).toMatchObject({ found: 3, posted: 1, empty: 1 });
    expect(seen[0]!.body.note).toContain(`repo: "other"`);

    seen.length = 0;
    const since = await importSessions({ ...lines().opts, ...opts, since: "2026-09-09" });
    expect(since.posted).toBe(0);
    expect(seen).toHaveLength(0);

    seen.length = 0;
    const limited = await importSessions({ ...lines().opts, ...opts, limit: 1 });
    expect(limited.posted).toBe(1);
  });

  it("reports a failure without leaking the token, and exits non-zero when nothing got through", async () => {
    const home = await makeHome([{ id: SESSION }]);
    const io = lines();
    const r = await importSessions({ ...io.opts, home, env: { METISTRY_URL: `${base}/nope`, METISTRY_OWNER_TOKEN: TOKEN } });
    expect(r).toMatchObject({ code: 1, posted: 0, failed: 1 });
    const printed = [...io.out, ...io.err].join("\n");
    expect(printed).toContain("HTTP 404");
    expect(printed).not.toContain(TOKEN);
    expect(await readLedger(ledgerPathFor(home))).toEqual({ version: 1, sessions: {} });
  });

  it("needs a url and a token, and says which is missing", async () => {
    const home = await makeHome([{ id: SESSION }]);
    await expect(importSessions({ ...lines().opts, home, platform: "linux", env: {} })).rejects.toThrow(/METISTRY_URL is not set/);
    await expect(importSessions({ ...lines().opts, home, platform: "linux", env: { METISTRY_URL: base } })).rejects.toThrow(/METISTRY_OWNER_TOKEN is not set/);
  });

  it("falls back to the login Keychain, on stdin-only exec, when the environment is empty", async () => {
    seen.length = 0;
    const home = await makeHome([{ id: SESSION }]);
    const asked: string[][] = [];
    const r = await importSessions({
      ...lines().opts,
      home,
      platform: "darwin",
      env: {},
      exec: async (cmd, args) => {
        asked.push([cmd, ...args]);
        const name = args[args.indexOf("-s") + 1] ?? "";
        if (name === "metistry:METISTRY_OWNER_TOKEN") return { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
        if (name === "metistry:METISTRY_URL") return { code: 0, stdout: `${base}\n`, stderr: "" };
        return { code: 44, stdout: "", stderr: "not found" };
      },
    });
    expect(r.posted).toBe(1);
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(asked.every((a) => a[0] === "security")).toBe(true);
  });
});

describe("import-sessions --dry-run", () => {
  it("prints the note it would post and reaches no network, with no credentials required", async () => {
    seen.length = 0;
    const home = await makeHome([{ id: SESSION }]);
    const io = lines();
    const r = await importSessions({ ...io.opts, home, env: {}, platform: "linux", dryRun: true, now: () => new Date("2026-09-09T00:00:00.000Z") });
    expect(r).toMatchObject({ code: 0, found: 1, posted: 0 });
    expect(seen).toHaveLength(0);
    expect(existsSync(ledgerPathFor(home))).toBe(false);
    const printed = io.out.join("\n");
    expect(printed).toContain("(dry run — nothing is posted)");
    expect(printed).toContain("--- claude-code-session-20260908T100000Z-11111111.md");
    expect(printed).toContain("Claude Code session — demo — 2026-09-08");
    expect(printed).toContain(`kind: "session"`);
    expect(printed).toContain("idempotency_key: claude-code:");
    expect(printed).toContain("would post 1");
  });

  it("is the command `metistry import-sessions --dry-run` runs, and rejects a nonsense --limit", async () => {
    const io = lines();
    // No transcripts dir on this fake home: 0 found, exit 0 — never an error.
    const home = await mkdtemp(join(tmpdir(), "metistry-empty-home-"));
    expect(await importSessions({ ...io.opts, home, dryRun: true })).toMatchObject({ code: 0, found: 0 });
    const cli = lines();
    expect(await main(["import-sessions", "--limit", "0", "--dry-run"], { out: cli.opts.out, err: cli.opts.err })).toBe(2);
    expect(cli.err.join("\n")).toContain("--limit must be a positive integer");
  });
});

describe("parseSince", () => {
  it("takes a day or an ISO stamp, and refuses a typo rather than importing everything", () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("2026-09-01")).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(parseSince("2026-09-01T12:00:00Z")).toBe(Date.parse("2026-09-01T12:00:00Z"));
    expect(() => parseSince("last tuesday")).toThrow(/--since must be a date/);
  });
});

describe("readLedger", () => {
  it("treats a missing or corrupt ledger as empty — a capture door never throws on it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-ledger-"));
    expect(await readLedger(join(dir, "nope.json"))).toEqual({ version: 1, sessions: {} });
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    expect(await readLedger(bad)).toEqual({ version: 1, sessions: {} });
    await writeFile(bad, `["wrong shape"]`);
    expect(await readLedger(bad)).toEqual({ version: 1, sessions: {} });
  });
});
