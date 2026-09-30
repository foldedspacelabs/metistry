// `metistry agents autonomy` (docs/ops/actions.md). One of exactly two doors a
// WIDENING may come through, so what it refuses and what it preserves matter
// more than what it prints: an unknown kind never reaches the console, and
// setting one kind never erases the §4.21 narrowing sitting beside it.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCrewDefinition, type PermissionRow } from "@foldedspacelabs/metistry-core";
import { agentAutonomy, agentsDefine, agentsList, isEmptyChange, mergeAutonomy, parseAutonomyFlags, renderAgents, renderAutonomy, renderDefine, renderPermissions } from "../src/agents.js";
import { main } from "../src/main.js";
import { createUi } from "../src/ui.js";

const env = { METISTRY_LOCAL_OWNER_TOKEN: "owner-token-value", METISTRY_CONSOLE_URL: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;

describe("parseAutonomyFlags", () => {
  it("reads repeated and comma-separated kinds — the shared parser keeps only the last of a repeated flag", () => {
    expect(parseAutonomyFlags(["agents", "autonomy", "r", "--allow", "comment", "--allow", "capture"])).toEqual({
      actions: { comment: "allow", capture: "allow" },
    });
    expect(parseAutonomyFlags(["--allow", "comment,capture", "--deny", "dispatch", "--level", "act_within_scope"])).toEqual({
      level: "act_within_scope",
      actions: { comment: "allow", capture: "allow", dispatch: "deny" },
    });
    expect(parseAutonomyFlags(["--level=propose", "--propose=task_update"])).toEqual({ level: "propose", actions: { task_update: "propose" } });
    // last mention of one kind wins, which is the only sane reading of `--allow x --deny x`
    expect(parseAutonomyFlags(["--allow", "comment", "--deny", "comment"]).actions).toEqual({ comment: "deny" });
  });

  it("refuses an unknown kind or level with the closed list, and never falls back silently", () => {
    expect(() => parseAutonomyFlags(["--allow", "send_email"])).toThrow(/unknown action kind "send_email"/);
    expect(() => parseAutonomyFlags(["--level", "autonomous"])).toThrow(/--level must be one of/);
    expect(() => parseAutonomyFlags(["--allow"])).toThrow(/--allow needs a value/);
    expect(() => parseAutonomyFlags(["--allow", "--json"])).toThrow(/--allow needs a value/);
  });

  it("no flags is a read", () => {
    expect(isEmptyChange(parseAutonomyFlags(["agents", "autonomy", "researcher", "--json"]))).toBe(true);
    expect(isEmptyChange(parseAutonomyFlags(["--deny", "dispatch"]))).toBe(false);
  });
});

describe("mergeAutonomy", () => {
  it("keeps every key this command does not own — a kind change must not drop a narrowing", () => {
    const stored = { may_dispatch_to: ["helper"], max_open_bundles: 2, level: "propose" as const, actions: { dispatch: "deny" as const } };
    expect(mergeAutonomy(stored, { actions: { comment: "allow" } })).toEqual({
      may_dispatch_to: ["helper"],
      max_open_bundles: 2,
      level: "propose",
      actions: { dispatch: "deny", comment: "allow" },
    });
  });

  it("adds nothing when nothing was asked for", () => {
    expect(mergeAutonomy({ max_open_bundles: 1 }, { actions: {} })).toEqual({ max_open_bundles: 1 });
  });
});

describe("agentAutonomy", () => {
  /** A console that answers the two calls this command makes, and records what it was sent. */
  function fakeConsole(stored: Record<string, unknown>) {
    const sent: { path: string; body: unknown; auth: string | undefined }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("http://127.0.0.1:9", "");
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth });
      if (path === "/api/agents") {
        return new Response(JSON.stringify({ agents: [{ id: "researcher", display_name: "Researcher", autonomy: stored }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, widened: ["level observe → propose"] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, sent };
  }

  it("shows the RESOLVED table without writing anything", async () => {
    const { fetchFn, sent } = fakeConsole({ level: "act_within_scope" });
    const v = await agentAutonomy("researcher", { actions: {} }, { env, fetchFn });
    expect(sent.map((s) => s.path)).toEqual(["/api/agents"]); // a read is a read
    expect(v.actions).toEqual({ dispatch: "propose", task_update: "allow", comment: "allow", capture: "allow", connection_call: "propose" });
    expect(v.widened).toEqual([]);
    // "propose" is now said as "Ask First" (C46/C47's designer wording), and
    // this row is defaulted — nothing in the record named `dispatch` — so it
    // says that too, not just colour (docs/ops/cli-style.md rule 1).
    expect(renderAutonomy(v)).toContain("dispatch        Ask First (default for act_within_scope)");
  });

  it("carries WHY beside the table (C46/C47): set, defaulted, or clamped — the one place downstream reads it, rather than recomputing", async () => {
    const { fetchFn } = fakeConsole({ level: "propose", actions: { comment: "allow", task_update: "propose" } });
    const v = await agentAutonomy("researcher", { actions: {} }, { env, fetchFn });
    // nothing named it: the level's own default
    expect(v.actionsDetailed.dispatch).toEqual({ mode: "propose", source: "defaulted", ceiling: "propose" });
    // named, and it survives the ceiling unchanged
    expect(v.actionsDetailed.task_update).toEqual({ mode: "propose", source: "set", ceiling: "propose", asked: "propose" });
    // named ABOVE the ceiling — the only case where the owner's own setting is overridden
    expect(v.actionsDetailed.comment).toEqual({ mode: "propose", source: "clamped", ceiling: "propose", asked: "allow" });
    const text = renderAutonomy(v);
    expect(text).toContain("dispatch        Ask First (default for propose)");
    expect(text).toContain("task_update     Ask First");
    expect(text).not.toContain("task_update     Ask First ("); // `set` is plain — no parenthetical
    expect(text).toContain("comment         Ask First (asked Allow — propose's ceiling is Ask First)");
  });

  it("merges onto the stored record and PUTs the whole thing, with the owner token in the header and nowhere else", async () => {
    const { fetchFn, sent } = fakeConsole({ max_open_bundles: 2 });
    const v = await agentAutonomy("researcher", parseAutonomyFlags(["--level", "propose", "--deny", "dispatch"]), { env, fetchFn });
    const put = sent.find((s) => s.path.endsWith("/autonomy"))!;
    expect(put.body).toEqual({ max_open_bundles: 2, level: "propose", actions: { dispatch: "deny" } });
    expect(put.auth).toBe("Bearer owner-token-value");
    expect(JSON.stringify(sent.map((s) => s.path))).not.toContain("owner-token-value");
    expect(v.widened).toEqual(["level observe → propose"]);
    expect(renderAutonomy(v)).toContain("widened");
  });

  it("surfaces the console's own refusal rather than writing a second sentence", async () => {
    const fetchFn = (async (url: string | URL) =>
      String(url).endsWith("/api/agents")
        ? new Response(JSON.stringify({ agents: [{ id: "researcher", display_name: "R", autonomy: {} }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "conflict", message: "researcher's autonomy changed while this change was being checked" } }), { status: 409 })) as unknown as typeof fetch;
    await expect(agentAutonomy("researcher", { level: "propose", actions: {} }, { env, fetchFn })).rejects.toThrow(/changed while this change was being checked/);
  });

  it("refuses an agent that is not registered, or is revoked, before it sends anything", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ agents: [{ id: "gone", display_name: "G", revoked: true }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(agentAutonomy("researcher", { level: "propose", actions: {} }, { env, fetchFn })).rejects.toThrow(/no agent "researcher"/);
    await expect(agentAutonomy("gone", { level: "propose", actions: {} }, { env, fetchFn })).rejects.toThrow(/revoked/);
  });
});

// ---------------------------------------------------------------------------
// `metistry agents list` (P3 §2.10). The point of the verb is that it renders
// NOTHING of its own: the console sends each row's scope already rendered
// (core's `describeScope`), and the CLI prints it. So what is worth holding
// here is that it prints the server's words, not that it composes good ones.
describe("agents list", () => {
  const SCOPE = {
    id: "researcher",
    role: "agent",
    who: "an agent",
    tier: "areas",
    access: "folders",
    areas: ["Areas/Health"],
    scope: "folders: Areas/Health",
    queries: false,
    projects: ["alpha"],
    uses: null,
    autonomy: { level: "propose", actions: { dispatch: "propose", task_update: "propose", comment: "propose", capture: "propose" } },
    source: "registry",
    from: "the registry — the owner's own hand, durable",
    extras: ["projects: alpha", "autonomy: propose"],
    line: "an agent · folders: Areas/Health · projects: alpha, autonomy: propose",
  };

  const listing = (agents: unknown[], access_requests: unknown[] = []) =>
    (async (url: string | URL, init?: RequestInit) => {
      sent.push({ path: String(url), auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "") });
      return new Response(JSON.stringify({ agents, access_requests }), { status: 200 });
    }) as unknown as typeof fetch;
  let sent: { path: string; auth: string }[] = [];

  it("reads the registry over the console, with the owner token in the header and nowhere else", async () => {
    sent = [];
    const rows = await agentsList({
      env,
      fetchFn: listing([{ id: "researcher", display_name: "Researcher", kind: "external", revoked: false, pending: false, last_seen_at: "2026-09-20T10:00:00Z", scope: SCOPE }]),
    });
    expect(sent.map((s) => s.path)).toEqual(["http://127.0.0.1:9/api/agents"]);
    expect(sent[0]!.auth).toBe("Bearer owner-token-value");
    expect(JSON.stringify(sent.map((s) => s.path))).not.toContain("owner-token-value");
    expect(rows).toEqual([expect.objectContaining({ id: "researcher", asked: [] })]);
  });

  it("prints the server's line, verbatim — a second renderer here would be a fifth vocabulary", async () => {
    sent = [];
    const rows = await agentsList({
      env,
      fetchFn: listing(
        [{ id: "researcher", display_name: "Researcher", kind: "external", revoked: false, pending: false, last_seen_at: "2026-09-20T10:00:00Z", scope: SCOPE }],
        [{ agent: "researcher", area: "Areas/Finance", proposal_id: 42 }],
      ),
    });
    const text = renderAgents(rows, createUi({ env: { NO_COLOR: "1" } }));
    expect(text).toContain(SCOPE.line);
    expect(text).toContain("the registry — the owner's own hand, durable");
    expect(text).toContain("seen 2026-09-20");
    expect(text).toContain("asked"); // the ask is visible where the grant is read
    expect(text).toContain("request #42");
  });

  it("says revoked and pending in the closed status vocabulary, and says so when there is nothing", async () => {
    sent = [];
    const rows = await agentsList({
      env,
      fetchFn: listing([
        { id: "gone", display_name: "Gone", kind: "external", revoked: true, pending: false, last_seen_at: null, scope: SCOPE },
        { id: "waiting", display_name: "Waiting", kind: "external", revoked: false, pending: true, last_seen_at: null, scope: SCOPE },
      ]),
    });
    const ui = createUi({ env: { NO_COLOR: "1" } });
    expect(renderAgents(rows, ui)).toContain("revoked");
    expect(renderAgents(rows, ui)).toContain("pending");
    expect(renderAgents([], ui)).toContain("no agents are registered");
  });

  it("says which console refused it rather than printing an empty list", async () => {
    const refused = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(agentsList({ env, fetchFn: refused })).rejects.toThrow(/refused the owner token \(401\)/);
    const down = (async () => {
      throw new Error("ECONNREFUSED owner-token-value");
    }) as unknown as typeof fetch;
    // …and the token never rides out in the error, the way every other verb
    // in this file redacts it.
    await expect(agentsList({ env, fetchFn: down })).rejects.toThrow(/\[redacted\]/);
  });
});

describe("agents list — the permissions table (T4-6)", () => {
  const base = { kind: "external", revoked: false, pending: false, last_seen_at: null };
  const entry = (key: string, label = key, extra: Record<string, unknown> = {}) => ({ key, label, asks: false, provenance: { kind: "base", source: "registry" }, ...extra });
  const permissions: PermissionRow[] = [
    { resource: { kind: "knowledge" }, label: "Knowledge", read: [entry("Areas/Health"), entry("Areas/Finance", "Areas/Finance", { provenance: { kind: "approved", proposalId: 311 } })], write: [] },
    { resource: { kind: "work" }, label: "Work", read: [], write: [entry("dispatch", "Dispatch", { asks: true })] },
  ] as PermissionRow[];

  it("prints Resource × Read × Write in core's words, with the dash for an empty cell", () => {
    const ui = createUi({ env: { NO_COLOR: "1" } });
    const text = renderAgents([{ id: "researcher", display_name: "Researcher", ...base, permissions, asked: [] }], ui);
    const lines = text.split("\n");
    expect(lines.some((l) => /^ {4}\s*Read\s+Write$/.test(l))).toBe(true);
    expect(lines).toContain("    Knowledge  Areas/Health, Areas/Finance (approved in Needs You · #311)  —");
    expect(lines).toContain("    Work       —                                                           Dispatch ⏱");
  });

  it("says an actor that holds nothing holds nothing — and draws no table for a revoked row", () => {
    const ui = createUi({ env: { NO_COLOR: "1" } });
    expect(renderPermissions([], ui)).toContain("holds nothing — anything not listed is not granted");
    // a connection row: the relay glyph's words, once (T4-10 — Through Metistry)
    const conn = [{ resource: { kind: "connection" as const, name: "gh" }, label: "gh", read: [{ key: "list", label: "list", asks: false, provenance: { kind: "proxy" as const } }], write: [] }];
    expect(renderPermissions(conn, ui)).toMatch(/gh ⧉ +list +—\n⧉ reached through Metistry — its tools are called by Metistry with your credential$/);
    expect(renderPermissions([{ resource: { kind: "inbox" as const }, label: "Inbox", read: [], write: [] }], ui)).not.toContain("reached through Metistry");
    const revoked = renderAgents([{ id: "gone", display_name: "Gone", ...base, revoked: true, permissions, asked: [] }], ui);
    expect(revoked).not.toContain("Knowledge");
  });
});

describe("agents define — a crew's definition, in the owner's hand (M12)", () => {
  let instance: string;
  let seed: string;
  const out: string[] = [];
  const SHIPPED = "---\n# shipped\nname: researcher\ntype: agent\nmodel: haiku   # haiku | sonnet | opus\nuses: [knowledge]\nscope: [Projects]\n---\n\nYou research.\n";
  const OWN = "---\nname: scout\ntype: agent\narea: research\nmodel: haiku # a comment the owner wrote\neffort: low\nuses: [knowledge, requests]\nscope: [Projects]\n---\n\nYou scout.\n";
  const opts = (id: string, change: Parameters<typeof agentsDefine>[0]["change"], extra: Partial<Parameters<typeof agentsDefine>[0]> = {}) => ({
    id,
    change,
    instanceDir: instance,
    seedDir: seed,
    // no reconciler: written directly (protected-write.ts), and never a launchd probe off macOS
    env: {} as NodeJS.ProcessEnv,
    platform: "linux" as const,
    uid: 501,
    out: (l: string) => out.push(l),
    ...extra,
  });
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const own = () => join(instance, ".metistry", "agents", "research", "scout.md");

  beforeEach(async () => {
    out.length = 0;
    instance = mkdtempSync(join(tmpdir(), "metistry-define-inst-"));
    seed = mkdtempSync(join(tmpdir(), "metistry-define-seed-"));
    await mkdir(join(instance, ".metistry", "agents", "research"), { recursive: true });
    await writeFile(join(instance, ".metistry", "identity.yaml"), "name: Aide\n");
    await writeFile(own(), OWN);
    await mkdir(join(seed, "agents", "example"), { recursive: true });
    await writeFile(join(seed, "agents", "example", "researcher.md"), SHIPPED);
  });
  afterEach(async () => {
    await rm(instance, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
  });

  it("edits the model, effort and prompt, keeping every other line — comments included", async () => {
    const r = await agentsDefine(opts("scout", { model: "lmstudio/gemma", effort: "medium", prompt: "You scout carefully.\n" }));
    const text = readFileSync(own(), "utf8");
    expect(text).toBe("---\nname: scout\ntype: agent\narea: research\nmodel: lmstudio/gemma # a comment the owner wrote\neffort: medium\nuses: [knowledge, requests]\nscope: [Projects]\n---\n\nYou scout carefully.\n");
    expect(r).toMatchObject({ id: "scout", area: "research", path: ".metistry/agents/research/scout.md", from: "instance", sha256_before: sha(OWN), sha256: sha(text), model: "lmstudio/gemma", effort: "medium", changed: true });
    expect(parseCrewDefinition(text, "x", { name: "scout", area: "research" }).manifest.uses).toEqual(["knowledge", "requests"]);
  });

  it("a shipped crew becomes the instance's own copy, which then wins by name", async () => {
    const r = await agentsDefine(opts("researcher", { model: "same_as_assistant" }));
    expect(r).toMatchObject({ from: "product", path: ".metistry/agents/example/researcher.md", sha256_before: sha(SHIPPED), model: "same_as_assistant", changed: true });
    const text = readFileSync(join(instance, ".metistry", "agents", "example", "researcher.md"), "utf8");
    expect(text).toContain("# shipped");
    expect(text).toContain("model: same_as_assistant");
    expect(readFileSync(join(seed, "agents", "example", "researcher.md"), "utf8")).toBe(SHIPPED); // the release is never written
  });

  it("a new crew needs an area, a model and a prompt — and reaches nothing until the owner names its tools by hand", async () => {
    await expect(agentsDefine(opts("fresh", { model: "lmstudio/gemma", prompt: "x" }))).rejects.toThrow(/needs --area/);
    await expect(agentsDefine(opts("fresh", { area: "ops", prompt: "x" }))).rejects.toThrow(/needs --model/);
    const r = await agentsDefine(opts("fresh", { area: "ops", model: "lmstudio/gemma", description: "Triage", prompt: "You triage.\n" }));
    expect(r).toMatchObject({ from: "new", path: ".metistry/agents/ops/fresh.md", sha256_before: null, changed: true });
    const parsed = parseCrewDefinition(readFileSync(join(instance, ".metistry", "agents", "ops", "fresh.md"), "utf8"), "x", { name: "fresh", area: "ops" });
    expect(parsed.manifest).toMatchObject({ name: "fresh", area: "ops", model: "lmstudio/gemma", effort: "low", description: "Triage", uses: [], scope: [] });
    expect(parsed.prompt).toBe("You triage.");
  });

  it("stale: --if-sha256 that is not the file's refuses the edit, and nothing is written", async () => {
    await expect(agentsDefine({ ...opts("scout", { model: "lmstudio/gemma" }), ifSha256: "0".repeat(64) })).rejects.toThrow(/^stale: .*nothing was written/);
    expect(readFileSync(own(), "utf8")).toBe(OWN);
    // the hash it was read at is accepted
    await expect(agentsDefine({ ...opts("scout", { model: "lmstudio/gemma" }), ifSha256: sha(OWN) })).resolves.toMatchObject({ changed: true });
  });

  it("refuses what the console would refuse, before writing: an empty prompt, a model that is not one, a bad id, the assistant", async () => {
    await expect(agentsDefine(opts("scout", { prompt: "   " }))).rejects.toThrow(/refusing to write .*operating prompt and may not be empty/);
    await expect(agentsDefine(opts("scout", { model: "gpt-5" }))).rejects.toThrow(/--model "gpt-5" is not `<provider>\/<model-id>`/);
    await expect(agentsDefine(opts("scout", { effort: "extreme" as never }))).rejects.toThrow(/--effort must be one of/);
    await expect(agentsDefine(opts("Scout", { model: "lmstudio/gemma" }))).rejects.toThrow(/is not an agent id/);
    await expect(agentsDefine(opts("assistant", { model: "lmstudio/gemma" }))).rejects.toThrow(/assistant's definition is not a crew file/);
    await expect(agentsDefine(opts("scout", { area: "ops", model: "lmstudio/gemma" }))).rejects.toThrow(/lives in research\/, not ops\//);
    expect(readFileSync(own(), "utf8")).toBe(OWN);
  });

  it("no edit flags is a read; --dry-run plans and writes nothing", async () => {
    const shown = await agentsDefine(opts("scout", {}));
    expect(shown).toMatchObject({ changed: false, sha256: sha(OWN), model: "haiku" });
    expect(renderDefine(shown, createUi({ env: { NO_COLOR: "1" } }))).toContain("nothing changed");
    await agentsDefine({ ...opts("scout", { model: "lmstudio/gemma" }), dryRun: true });
    expect(readFileSync(own(), "utf8")).toBe(OWN);
  });

  it("two files with one name is refused rather than guessed at", async () => {
    await mkdir(join(instance, ".metistry", "agents", "ops"), { recursive: true });
    await writeFile(join(instance, ".metistry", "agents", "ops", "scout.md"), OWN.replace("area: research", "area: ops"));
    await expect(agentsDefine(opts("scout", { model: "lmstudio/gemma" }))).rejects.toThrow(/defined twice/);
  });

  it("main(): the verb is wired, reads the prompt from stdin with -, and prints JSON", async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await main(["agents", "define", "scout", "--instance", instance, "--prompt-file", "-", "--json"], {
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
      readStdin: async () => "From stdin.\n",
      platform: "linux",
    });
    expect(errs.filter((e) => !/written directly/.test(e))).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ id: "scout", changed: true });
    expect(readFileSync(own(), "utf8")).toContain("From stdin.");
    expect(existsSync(own())).toBe(true);
    expect(await main(["agents", "define"], { out: () => {}, err: (l) => errs.push(l) })).toBe(2);
  });
});
