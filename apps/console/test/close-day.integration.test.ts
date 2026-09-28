// Close the Day (design-build-plan §2.11, §2.13; screen-05-today §15.5.1;
// ticket T2-8): `POST /api/today/close {day, line?}` writes the daily note's
// section through the section operation as `user`, then enqueues
// `plan-tomorrow`. Over real sockets against the scratch database
// (docs/ops/testing.md). The vault is the in-memory one, given the section
// operation exactly as the bridge runs it — core's `writeNoteSection`, the
// one grammar — so every byte the door writes is visible here.
//
// The ticket's own: **markers missing → a `note` request and no write**.
// Its acceptance: closing twice re-renders tomorrow's plan (the real
// `plan-tomorrow`, not a fake). Plus U2's four, and the door's refusals.
import { createServer, type Server } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { VaultError, memoryVault, sha256Hex, type MemoryVault } from "@foldedspacelabs/metistry-artifacts";
import { PROFILE_PATH, addTaskDays, calendarDate, mintToken, scanNoteSection, writeNoteSection, type NoteSectionName } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { loadRoutines } from "@metistry-apps/routines";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { CLOSE_REQUEST_SOURCE, RoutineTrigger, closeDayRoute, closeTriggeredPass, composeSection, type CloseDayDeps } from "../src/close-day.js";
import { httpVaultClient, type NoteSectionClient } from "../src/vault-client.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-close";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const SEED = fileURLToPath(new URL("../../../seed/", import.meta.url));
const PLAN_DIR = "Journal/Plan";
const TEMPLATE_PATH = "Templates/Plan.md";

/** A day far from any other suite's `current_date`, so the day's rows are this file's alone. Each test closes its own. */
let dayN = 0;
const nextDay = (): string => addTaskDays("2031-03-01", dayN++)!;
const at = (day: string, hhmm = "17:14"): Date => new Date(`${day}T${hhmm}:00Z`);

/** The section operation, in memory, exactly as the reconciler runs it (apps/reconciler/src/vault.ts `sectionNow`). */
function withSection(vault: MemoryVault, log: { path: string; principal: string; body: string }[]): MemoryVault & NoteSectionClient & { beforeSection: (() => Promise<void>) | null } {
  const v = {
    ...vault,
    read: (p: string) => vault.read(p),
    write: vault.write.bind(vault),
    beforeSection: null as (() => Promise<void>) | null,
    async section(path: string, marker: NoteSectionName, body: string, principal: string, outer: string) {
      if (v.beforeSection) {
        const hook = v.beforeSection;
        v.beforeSection = null;
        await hook();
      }
      const cur = await vault.read(path);
      if (!cur) throw new VaultError("not_found", `${path} does not exist`);
      const out = writeNoteSection(cur.content, marker, body, outer);
      if (!out.ok) throw new VaultError(out.code, out.code === "invalid_request" ? out.message : out.code);
      await vault.write(path, out.content, { principal, message: `update the ${marker} section of ${path}` }, cur.sha256);
      log.push({ path, principal, body });
      return { path, section: marker, sha256: sha256Hex(out.content), bytes: out.content.length, outer_sha256: out.outerSha256, appended: out.appended };
    },
  };
  return v as never;
}

describe("composeSection — facts only, deterministic", () => {
  const rows = [
    { act: "done" as const, task_key: "mt-a", to_day: null, path: "Journal/2031-03-01.md", anchor: "mt-a", text: "Send Dana the fixture" },
    { act: "moved" as const, task_key: "mt-b", to_day: "2031-03-02", path: "Areas/Home/Chores.md", anchor: "mt-b", text: "Book the room" },
    { act: "moved" as const, task_key: "mt-c", to_day: "someday", path: "Journal/2031-03-01.md", anchor: null, text: "Read <!-- metistry:day --> the paper" },
  ];
  it("says when, what was done, what moved and to when, and leads with the owner's line — no checkbox, no marker", () => {
    const { body, counts } = composeSection(rows, "Recorder next.", at("2031-03-01"), "UTC");
    expect(body).toBe(
      [
        "Closed at 5:14 PM · 1 done · 2 moved",
        "",
        "**For tomorrow:** Recorder next.",
        "",
        "### Done",
        "- Send Dana the fixture · [[Journal/2031-03-01]]",
        "",
        "### Moved",
        "- Book the room → 2031-03-02 · [[Areas/Home/Chores]]",
        "- Read &lt;!-- metistry:day --> the paper → someday · [[Journal/2031-03-01]]",
        "",
      ].join("\n"),
    );
    expect(counts).toEqual({ done: 1, moved: { "2031-03-02": 1, someday: 1 } });
    expect(body).not.toMatch(/^- \[/m);
    expect(writeNoteSection(Buffer.from("# d\n"), "day", body, sha256Hex(Buffer.from("# d\n"))).ok).toBe(true);
  });
  it("an empty day says so, and the same inputs give the same bytes", () => {
    const a = composeSection([], null, at("2031-03-01", "09:05"), "UTC");
    expect(a.body).toBe("Closed at 9:05 AM · 0 done\n\nNothing was ticked or moved today.\n");
    expect(composeSection(rows, "x", at("2031-03-01"), "UTC")).toEqual(composeSection(rows, "x", at("2031-03-01"), "UTC"));
  });
});

describe("the console's vault client: the section operation over HTTP", () => {
  let bridge: Server;
  let url: string;
  const seen: unknown[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  beforeAll(async () => {
    bridge = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "null") });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => bridge.close(() => r())));

  it("posts {path, marker, body, principal, expected_outer_sha} with its bearer, and returns what the bridge wrote", async () => {
    answer = { status: 200, body: { path: "Journal/2031-03-01.md", section: "day", sha256: "a".repeat(64), bytes: 12, outer_sha256: "b".repeat(64), appended: true, queued: true } };
    const client = httpVaultClient({ url, token: "t0k" });
    const out = await client.section("Journal/2031-03-01.md", "day", "hi\n", "user", "c".repeat(64));
    expect(out).toEqual({ path: "Journal/2031-03-01.md", section: "day", sha256: "a".repeat(64), bytes: 12, outer_sha256: "b".repeat(64), appended: true });
    expect(seen.at(-1)).toEqual({ method: "POST", url: "/vault/section", auth: "Bearer t0k", body: { path: "Journal/2031-03-01.md", marker: "day", body: "hi\n", principal: "user", expected_outer_sha: "c".repeat(64) } });
  });

  it("maps 409 section_missing to section_missing — never the not_available an unknown code falls back to", async () => {
    answer = { status: 409, body: { error: { code: "section_missing", message: "the markers are broken" } } };
    const err = await httpVaultClient({ url, token: "t" }).section("Journal/2031-03-01.md", "day", "x", "user", "c".repeat(64)).catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.code).toBe("section_missing");
    expect(err.message).toBe("the markers are broken");
  });
});

describe.skipIf(!hasDb)("Close the Day: POST /api/today/close", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let base: MemoryVault;
  let vault: ReturnType<typeof withSection>;
  const sections: { path: string; principal: string; body: string }[] = [];
  const audits: { kind: string; tool: string; ok: boolean; meta: Record<string, unknown> }[] = [];
  let enqueued = 0;
  const plan = new RoutineTrigger("plan-tomorrow", async () => {
    enqueued++;
  });
  let direct: Server;
  let directBase: string;
  let directDeps: Partial<CloseDayDeps> = {};
  let server: ReturnType<typeof makeServer>;
  let consoleBase: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `${MARK}-${suffix}`;
  const passkeyIds: string[] = [];
  const inboxDirs: string[] = [];
  const paths: string[] = [];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    base = memoryVault();
    vault = withSection(base, sections);
    // the door itself, with its clock and zone in the test's hands
    direct = createServer((req, res) => {
      void closeDayRoute(req, res, {
        db: pool,
        queries,
        vault,
        plan,
        timeZone: "UTC",
        audit: async (kind, tool, ok, meta) => {
          audits.push({ kind, tool, ok, meta });
        },
        ...directDeps,
      } as CloseDayDeps);
    });
    await new Promise<void>((r) => direct.listen(0, "127.0.0.1", r));
    directBase = `http://127.0.0.1:${(direct.address() as AddressInfo).port}`;
    // and the console, for who may reach it
    const inboxDir = await mkdtemp(join(tmpdir(), "metistry-close-"));
    inboxDirs.push(inboxDir);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      vault,
      planTomorrow: plan,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    consoleBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest close" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`%${MARK}-${suffix}%`]);
    await pool.query(`DELETE FROM runs WHERE kind = 'vault_task' AND meta->>'task_key' LIKE $1`, [`mt-${suffix}%`]);
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'today'`).catch(() => undefined);
    await pool.query(`DELETE FROM runs WHERE component = 'plan-tomorrow' AND meta->>'planned_for' LIKE '2031-%'`).catch(() => undefined);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1 AND payload->'close_day'->>'path' = ANY($2)`, [CLOSE_REQUEST_SOURCE, paths]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => direct.close(() => r()));
    await pool.end();
    for (const dir of inboxDirs) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    directDeps = {};
    audits.length = 0;
    vault.beforeSection = null;
  });

  /** A daily note for `day` — but under a path of this run's own? No: the section lives only at `Journal/<day>.md`, so the day is what isolates a test. */
  async function note(day: string, content: string): Promise<string> {
    const path = `Journal/${day}.md`;
    paths.push(path);
    const cur = await base.read(path);
    await base.write(path, Buffer.from(content), { principal: "user", message: "seed" }, cur?.sha256 ?? "");
    return path;
  }
  const bytes = async (path: string) => (await base.read(path))?.content.toString("utf8") ?? null;

  async function close(day: string, body: Record<string, unknown>, opts: { now?: Date; to?: "direct" | "console"; headers?: Record<string, string> } = {}) {
    if (opts.now) directDeps = { ...directDeps, now: () => opts.now! };
    const url = opts.to === "console" ? `${consoleBase}/api/today/close` : `${directBase}/api/today/close`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.to === "console" ? { authorization: `Bearer ${localOwnerToken}` } : {}), ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  }

  /** The walk's row for a line, as the index would hold it. */
  async function indexed(path: string, key: string, text: string, fields: { checked?: boolean; done_on?: string } = {}) {
    await pool.query(
      `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, done_on, parsed_on, first_seen_on, last_seen_at)
       VALUES ($1, $2, $2, 3, $3, lower($3), $4, $5::date, current_date, current_date, now())`,
      [path, key, text, fields.checked ?? false, fields.done_on ?? null],
    );
  }
  /** One of the doors' own audit rows, at an instant of the test's choosing. */
  async function act(tool: "check" | "schedule", when: Date, meta: Record<string, unknown>) {
    await pool.query(`INSERT INTO runs (ts, component, kind, tool, ok, started_at, finished_at, meta) VALUES ($1, 'console', 'vault_task', $2, true, $1, $1, $3)`, [when, tool, JSON.stringify(meta)]);
  }

  // ---- U2: the four --------------------------------------------------------------------------

  describe("who may close the day (U2)", () => {
    const today = () => calendarDate(new Date(), "UTC");

    it("no credential is the uniform 401, and nothing is written", async () => {
      const path = await note(today(), "# today\n");
      const r = await close(today(), { day: today() }, { to: "console", headers: { authorization: "" } });
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      expect(await bytes(path)).toBe("# today\n");
    });

    it("an agent bearer is refused 403 with the canonical answer, and nothing is written", async () => {
      const path = await note(today(), "# today\n");
      const r = await close(today(), { day: today() }, { to: "console", headers: { authorization: `Bearer ${agentToken}` } });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(await bytes(path)).toBe("# today\n");
    });

    it("the capture owner token is refused 403 — capture is its whole reach — and nothing is written", async () => {
      const path = await note(today(), "# today\n");
      const r = await close(today(), { day: today() }, { to: "console", headers: { authorization: `Bearer ${ownerToken}` } });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(await bytes(path)).toBe("# today\n");
    });

    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      const path = await note(today(), "# today\n");
      const before = enqueued;
      const a = await close(today(), { day: today(), line: "Recorder next." }, { to: "console" });
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ ok: true, day: today(), path, appended: true, line: "Recorder next.", plan: { enqueued: true, routine: "plan-tomorrow" } });
      expect(await bytes(path)).toContain("**For tomorrow:** Recorder next.");
      const b = await close(today(), { day: today() }, { to: "console", headers: { authorization: "", cookie: sessionCookie } });
      expect(b.status).toBe(200);
      expect(b.body.appended).toBe(false);
      await plan.idle();
      expect(enqueued).toBeGreaterThanOrEqual(before + 1);
    });
  });

  // ---- the ticket's own ---------------------------------------------------------------------

  describe("**markers missing → a `note` request and no write**", () => {
    for (const [name, content, reason] of [
      ["one marker", "# d\n\n## Today · Metistry\n\n<!-- metistry:day -->\nold\n", "unpaired"],
      ["two pairs", "# d\n<!-- metistry:day -->\na\n<!-- /metistry:day -->\n<!-- metistry:day -->\nb\n<!-- /metistry:day -->\n", "more_than_one_pair"],
      ["markers inside a code block", "# d\n```\n<!-- metistry:day -->\n<!-- /metistry:day -->\n```\n", "in_code_block"],
      ["the heading without its markers", "# d\n\n## Today · Metistry\n\nthe owner's words\n", "heading_without_markers"],
    ] as const) {
      it(`${name}: 409 section_missing naming why, the note byte-identical, one request raised, the plan still made`, async () => {
        const day = nextDay();
        const path = await note(day, content);
        const writesBefore = sections.length;
        const before = enqueued;
        const r = await close(day, { day, line: "Tomorrow: the recorder." }, { now: at(day) });
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe("section_missing");
        expect(r.body).toMatchObject({ reason, day, path, plan: { enqueued: true, routine: "plan-tomorrow" } });
        expect(typeof r.body.request_id).toBe("number");
        // no write: not through the section operation, not any other way
        expect(await bytes(path)).toBe(content);
        expect(sections.length).toBe(writesBefore);
        // the request: a `note` (stored kind `knowledge`), pending, naming the note
        const { rows } = await pool.query(`SELECT kind, source_agent, decision, payload FROM proposals WHERE id = $1`, [r.body.request_id]);
        expect(rows[0]).toMatchObject({ kind: "knowledge", source_agent: CLOSE_REQUEST_SOURCE, decision: "pending" });
        expect(rows[0].payload.refs).toEqual([path]);
        expect(rows[0].payload.close_day).toMatchObject({ day, path, reason });
        expect(rows[0].payload.preview).toContain("**For tomorrow:** Tomorrow: the recorder.");
        const shape = await fetch(`${consoleBase}/api/proposals`, { headers: { authorization: `Bearer ${localOwnerToken}` } }).then((x) => x.json() as Promise<Record<string, any>>);
        const listed = (shape.proposals ?? shape.rows ?? shape).find?.((p: Record<string, any>) => Number(p.id) === r.body.request_id);
        if (listed) expect(listed.request.type).toBe("note");
        await plan.idle();
        expect(enqueued).toBe(before + 1);
        expect(audits.at(-1)).toMatchObject({ kind: "today", tool: "close", ok: false, meta: expect.objectContaining({ outcome: "section_missing", reason }) });
        expect(JSON.stringify(audits.at(-1))).not.toContain("recorder");
      });
    }

    it("closing again with the markers still broken points at the same request, not a second card", async () => {
      const day = nextDay();
      const content = "# d\n<!-- /metistry:day -->\n";
      await note(day, content);
      const a = await close(day, { day }, { now: at(day) });
      const b = await close(day, { day }, { now: at(day, "17:20") });
      expect(a.status).toBe(409);
      expect(b.body.request_id).toBe(a.body.request_id);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1 AND payload->'close_day'->>'path' = $2`, [CLOSE_REQUEST_SOURCE, `Journal/${day}.md`]);
      expect(rows[0].n).toBe(1);
    });

    it("markers that break between the scan and the write are the same answer — the bridge's refusal, nothing written", async () => {
      const day = nextDay();
      const path = await note(day, "# d\n");
      vault.beforeSection = async () => {
        const cur = (await base.read(path))!;
        await base.write(path, Buffer.from("# d\n<!-- metistry:day -->\n"), { principal: "user", message: "owner" }, cur.sha256);
      };
      const r = await close(day, { day }, { now: at(day) });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: { code: "section_missing" }, reason: "unpaired" });
      expect(await bytes(path)).toBe("# d\n<!-- metistry:day -->\n");
    });
  });

  describe("the section written", () => {
    it("the first close appends the heading and the markers; the owner's bytes are an untouched prefix; written as `user`", async () => {
      const day = nextDay();
      const owner = "---\nsource: user\n---\n# 2031\n\nSome prose  with double spaces \n- [ ] a task of the owner's\n";
      const path = await note(day, owner);
      const r = await close(day, { day, line: "  Recorder next.  " }, { now: at(day) });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, day, path, appended: true, closed_at: at(day).toISOString(), done: 0, moved: {}, line: "Recorder next.", plan: { enqueued: true, routine: "plan-tomorrow" } });
      const after = (await bytes(path))!;
      expect(after.startsWith(owner)).toBe(true);
      expect(after.slice(owner.length)).toBe("\n## Today · Metistry\n\n<!-- metistry:day -->\nClosed at 5:14 PM · 0 done\n\n**For tomorrow:** Recorder next.\n\nNothing was ticked or moved today.\n<!-- /metistry:day -->\n");
      expect(sections.at(-1)).toMatchObject({ path, principal: "user" });
    });

    it("says what was done — the index's and the Tick door's own record — and what moved and to when; a tick undone is not done", async () => {
      const day = nextDay();
      const path = await note(day, `# d\n\n## Today · Metistry\n\n<!-- metistry:day -->\nthe morning's version\n<!-- /metistry:day -->\n\nThe owner's notes after.\n`);
      const src = `Areas/${MARK}-${suffix}/Tasks.md`;
      const k = (s: string) => `mt-${suffix}${s}`;
      await indexed(src, k("a"), "Ticked in Obsidian", { checked: true, done_on: day });
      await indexed(src, k("b"), "Ticked on Today a moment ago"); // the walk has not seen the tick yet
      await indexed(src, k("c"), "Ticked then undone");
      await indexed(src, k("d"), "Sent to tomorrow");
      await indexed(src, k("e"), "Sent to someday");
      await indexed(src, k("f"), "Deferred yesterday, not today");
      await indexed(src, k("g"), "Moved then done", { checked: true, done_on: day });
      const noon = at(day, "12:00");
      await act("check", noon, { task_key: k("b"), checked: true, outcome: "tick" });
      await act("check", noon, { task_key: k("c"), checked: true, outcome: "tick" });
      await act("check", at(day, "12:05"), { task_key: k("c"), checked: false, outcome: "untick" });
      await act("schedule", noon, { task_key: k("d"), deferral: "do", to: "2031-06-02", outcome: "do" });
      await act("schedule", noon, { task_key: k("e"), deferral: "someday", to: "someday", outcome: "someday" });
      await act("schedule", at(addTaskDays(day, -1)!, "12:00"), { task_key: k("f"), deferral: "do", to: "2031-06-09", outcome: "do" });
      await act("schedule", noon, { task_key: k("g"), deferral: "do", to: "2031-06-03", outcome: "do" });

      const r = await close(day, { day }, { now: at(day) });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ appended: false, done: 3, moved: { "2031-06-02": 1, someday: 1 } });
      const link = `[[Areas/${MARK}-${suffix}/Tasks]]`;
      expect(await bytes(path)).toBe(
        [
          "# d",
          "",
          "## Today · Metistry",
          "",
          "<!-- metistry:day -->",
          "Closed at 5:14 PM · 3 done · 2 moved",
          "",
          "### Done",
          `- Moved then done · ${link}`,
          `- Ticked in Obsidian · ${link}`,
          `- Ticked on Today a moment ago · ${link}`,
          "",
          "### Moved",
          `- Sent to tomorrow → 2031-06-02 · ${link}`,
          `- Sent to someday → someday · ${link}`,
          "<!-- /metistry:day -->",
          "",
          "The owner's notes after.",
          "",
        ].join("\n"),
      );
    });

    it("closing again replaces the section whole — and everything outside it is the owner's, byte for byte", async () => {
      const day = nextDay();
      const path = await note(day, "# d\n");
      await close(day, { day, line: "first" }, { now: at(day) });
      // the owner writes above and below the section, and inside it
      const mid = (await bytes(path))!.replace("# d\n", "# d\nabove\n").replace("first", "the owner scribbled here") + "below\n";
      const cur = (await base.read(path))!;
      await base.write(path, Buffer.from(mid), { principal: "user", message: "owner" }, cur.sha256);
      const outer = (scanNoteSection(Buffer.from(mid), "day") as { outerSha256: string }).outerSha256;
      const r = await close(day, { day, line: "second" }, { now: at(day, "18:00") });
      expect(r.status).toBe(200);
      const after = (await bytes(path))!;
      expect((scanNoteSection(Buffer.from(after), "day") as { outerSha256: string }).outerSha256).toBe(outer);
      expect(after).toContain("**For tomorrow:** second");
      expect(after).not.toContain("scribbled");
      expect(after).toMatch(/^# d\nabove\n/);
      expect(after.endsWith("<!-- /metistry:day -->\nbelow\n")).toBe(true);
    });

    it("an owner's edit outside the section mid-close is read again, never overwritten", async () => {
      const day = nextDay();
      const path = await note(day, "# d\n");
      vault.beforeSection = async () => {
        const cur = (await base.read(path))!;
        await base.write(path, Buffer.from("# d\nthe owner, typing\n"), { principal: "user", message: "owner" }, cur.sha256);
      };
      const r = await close(day, { day }, { now: at(day) });
      expect(r.status).toBe(200);
      expect((await bytes(path))!.startsWith("# d\nthe owner, typing\n\n## Today · Metistry\n")).toBe(true);
    });
  });

  describe("refusals", () => {
    it("a day that is not today is 409 stale, and nothing is written or enqueued", async () => {
      const day = nextDay();
      const path = await note(day, "# d\n");
      const before = enqueued;
      const r = await close(day, { day }, { now: at(addTaskDays(day, 1)!, "00:10") });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: { code: "conflict" }, reason: "stale", today: addTaskDays(day, 1) });
      expect(await bytes(path)).toBe("# d\n");
      await plan.idle();
      expect(enqueued).toBe(before);
    });

    it("no daily note is 404 — the door never creates the owner's note — and the plan is still made", async () => {
      const day = nextDay();
      const before = enqueued;
      const r = await close(day, { day }, { now: at(day) });
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ error: { code: "not_found" }, path: `Journal/${day}.md`, plan: { enqueued: true } });
      expect(await base.read(`Journal/${day}.md`)).toBeNull();
      await plan.idle();
      expect(enqueued).toBe(before + 1);
    });

    it("a body it does not take is 400 by name, and nothing is written", async () => {
      const day = nextDay();
      const path = await note(day, "# d\n");
      const now = at(day);
      for (const [body, says] of [
        [{}, "day must be"],
        [{ day: "2031-02-30" }, "day must be"],
        [{ day: "tomorrow" }, "day must be"],
        [{ day, line: "two\nlines" }, "one line"],
        [{ day, line: 7 }, "line, when given"],
        [{ day, line: "x".repeat(501) }, "at most 500"],
        [{ day, body: "a section of my own" }, "unknown field body"],
      ] as const) {
        const r = await close(day, body as Record<string, unknown>, { now });
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.error.message).toContain(says);
      }
      expect(await bytes(path)).toBe("# d\n");
    });

    it("no vault bridge — or one without the section operation — is 503 naming what would fix it", async () => {
      const day = nextDay();
      for (const v of [undefined, base]) {
        directDeps = { vault: v };
        const r = await close(day, { day }, { now: at(day) });
        expect(r.status).toBe(503);
        expect(r.body.error.message).toContain("METISTRY_RECONCILER_URL");
      }
    });

    it("with no plan-tomorrow loaded the section is still written, and the answer says the plan was not enqueued", async () => {
      const day = nextDay();
      await note(day, "# d\n");
      directDeps = { plan: undefined };
      const r = await close(day, { day }, { now: at(day) });
      expect(r.status).toBe(200);
      expect(r.body.plan).toMatchObject({ enqueued: false, routine: "plan-tomorrow" });
    });
  });

  // ---- the acceptance --------------------------------------------------------------------------

  it("accept: closing twice re-renders tomorrow's plan (the real plan-tomorrow, handed the day closed)", async () => {
    const day = nextDay();
    const tomorrow = addTaskDays(day, 1)!;
    const planPath = `${PLAN_DIR}/${tomorrow}.md`;
    await note(day, "# d\n");
    await base.write(TEMPLATE_PATH, Buffer.from(readFileSync(`${SEED}vault/Templates/Plan.md`, "utf8")), { principal: "user", message: "seed" }, (await base.read(TEMPLATE_PATH))?.sha256 ?? "");
    await base.write(PROFILE_PATH, Buffer.from("---\nsource: user\nworking_days: [mon, tue, wed, thu, fri, sat, sun]\n---\n"), { principal: "user", message: "seed" }, (await base.read(PROFILE_PATH))?.sha256 ?? "");
    const planWrites: string[] = [];
    let clockAt = at(day);
    const planVault = {
      read: (p: string) => base.read(p),
      write: async (p: string, c: Buffer, i: { principal: string; message: string }, sha?: string) => {
        if (p === planPath) planWrites.push(c.toString("utf8"));
        return base.write(p, c, i, sha);
      },
    };
    const { routines } = await loadRoutines({ home: fileURLToPath(new URL("../../../routines", import.meta.url)) });
    const planRoutine = routines.find((r) => r.name === "plan-tomorrow")!;
    const trigger = new RoutineTrigger(
      "plan-tomorrow",
      closeTriggeredPass(pool, planRoutine as never, { queries, vault: planVault, calendar: null, env: { METISTRY_TZ: "UTC" }, get now() { return clockAt; } }, planRoutine.manifest.display_name ?? planRoutine.name),
    );
    directDeps = { plan: trigger };

    const first = await close(day, { day, line: "one" }, { now: clockAt });
    expect(first.status).toBe(200);
    await trigger.idle();
    clockAt = at(day, "18:30");
    const second = await close(day, { day, line: "two" }, { now: clockAt });
    expect(second.status).toBe(200);
    await trigger.idle();

    expect(planWrites.length).toBe(2);
    expect((await bytes(planPath))!).toContain("source: plan-tomorrow");
    const { rows } = await pool.query(
      `SELECT meta FROM runs WHERE component = 'plan-tomorrow' AND kind = 'routine_run' AND meta->>'planned_for' = $1 ORDER BY id`,
      [tomorrow],
    );
    expect(rows.map((r) => [r.meta.outcome, r.meta.trigger])).toEqual([["acted", "close"], ["acted", "close"]]);
    const { rows: passes } = await pool.query(
      `SELECT ok, meta FROM runs WHERE component = 'plan-tomorrow' AND kind = 'routine_run' AND meta->>'trigger' = 'close' AND meta ? 'processed' AND ts > now() - interval '1 minute' ORDER BY id DESC LIMIT 2`,
    );
    expect(passes.map((p) => [p.ok, p.meta.outcome])).toEqual([[true, "acted"], [true, "acted"]]);
  });
});
