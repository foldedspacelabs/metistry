// `metistry connect <tool>`: one agent row per tool, one bearer per tool,
// and exactly one place each bearer goes. The assertions that matter are
// the conservative ones — an already-registered tool is never shown a
// secret, a fresh one's bearer reaches the Keychain and NOT the config
// file, another editor's servers survive the merge, and the file comes
// back 0600.
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentTokenVar,
  connect,
  connectList,
  cursorConfigFile,
  DEFAULT_GRANTS,
  opencodeConfigFile,
  opencodeServerEntry,
  parseTool,
  renderConnect,
  renderConnectList,
  serverKey,
  writeCursorConfig,
  writeOpencodeConfig,
} from "../src/connect.js";
import type { Exec, ExecOptions } from "../src/exec.js";
import { main } from "../src/main.js";

const OWNER = "local-owner-token-never-printed";
const INSTANCE_ID = "a1b2c3d4-2222-4333-8444-555555555555";

/** A login Keychain in a Map, keyed by (account, service) like the real one. Records calls so a test can prove a value never reached argv. */
function fakeSecurity(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ args, opts });
    if (cmd !== "security") return { code: 127, stdout: "", stderr: "not security" };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      const [a, b] = String(opts.stdin ?? "").split("\n");
      if (a === undefined || a !== b) return { code: 1, stdout: "", stderr: "passwords don't match" };
      store.set(at, a);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "not found" };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, calls };
}

interface Row {
  id: string;
  display_name: string;
  kind: string;
  grants: { tier: string; areas: string[] };
  projects: string[];
  revoked: boolean;
  last_seen_at: string | null;
  /** S2: enrolled --remote, and whether the owner has let it in yet */
  remote?: boolean;
  pending?: boolean;
}

/** The console's agent registry, in memory, behind the same routes and codes apps/console/src/server.ts serves. */
function fakeConsole(seed: Partial<Row>[] = []) {
  const rows = new Map<string, Row>();
  for (const r of seed) {
    rows.set(r.id!, { display_name: r.id!, kind: "external", grants: { tier: "none", areas: [] }, projects: [], revoked: false, last_seen_at: null, ...r } as Row);
  }
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let minted = 0;
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path: url.pathname, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if ((init?.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${OWNER}`) {
      return json(401, { error: { code: "unauthenticated", message: "authentication required" } });
    }
    if (method === "GET" && url.pathname === "/api/agents") return json(200, { agents: [...rows.values()] });
    if (method === "POST" && url.pathname === "/api/agents") {
      const id = String((body as { id?: string }).id);
      if (rows.has(id)) return json(409, { error: { code: "conflict", message: "agent id already registered" } });
      const remote = (body as { remote?: boolean }).remote === true;
      rows.set(id, { id, display_name: String((body as { display_name?: string }).display_name), kind: "external", grants: { tier: "none", areas: [] }, projects: [], revoked: false, last_seen_at: null, remote, pending: remote });
      return json(201, { id, token: `minted-${++minted}`, pending: remote, ...(remote ? { proposal_id: 7 } : {}) });
    }
    const op = /^\/api\/agents\/([a-z][a-z0-9-]*)\/(rotate|grants|projects)$/.exec(url.pathname);
    if (op) {
      const row = rows.get(op[1]!);
      if (!row || row.revoked) return json(404, { error: { code: "not_found", message: "not found" } });
      if (op[2] === "rotate") return json(200, { id: row.id, token: `rotated-${++minted}` });
      if (op[2] === "grants") {
        const g = body as { tier: string; areas: string[] };
        if (g.tier === "areas" && (g.areas ?? []).length === 0) return json(400, { error: { code: "invalid_request", message: "tier=areas needs at least one area" } });
        // the same casing rule validateGrants enforces (CLAUDE.md: the vault is TitleCase)
        if ((g.areas ?? []).some((a) => !/^[A-Z][A-Za-z0-9 _.'-]*(\/[A-Z][A-Za-z0-9 _.'-]*)*$/.test(a))) {
          return json(400, { error: { code: "invalid_request", message: "area must be a TitleCase vault prefix (e.g. Areas/Fsl)" } });
        }
        row.grants = { tier: g.tier, areas: g.areas ?? [] };
        return json(200, { ok: true, grants: row.grants });
      }
      row.projects = (body as { projects: string[] }).projects;
      return json(200, { ok: true, projects: row.projects });
    }
    return json(404, { error: { code: "not_found", message: "not found" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, rows };
}

async function scratch(): Promise<{ home: string; instanceDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-connect-"));
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(join(dir, "instance", ".metistry", "state"), { recursive: true });
  return { home: join(dir, "home"), instanceDir: join(dir, "instance") };
}

function base(home: string, instanceDir: string, exec: Exec, fetchFn: typeof fetch) {
  return {
    home,
    instanceDir,
    instanceId: INSTANCE_ID,
    env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER } as NodeJS.ProcessEnv,
    platform: "darwin" as const,
    exec,
    fetchFn,
  };
}

describe("connect: the agent row", () => {
  it("registers a missing tool once, keeps the console's default-deny grants, and files the bearer under this instance's account", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });

    expect(r).toMatchObject({ agent_id: "cursor", created: true, rotated: false, token: "keychain", grants: DEFAULT_GRANTS, mcp_url: "http://127.0.0.1:8080/mcp" });
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /api/agents", "POST /api/agents"]);
    expect(c.calls[1]!.body).toEqual({ id: "cursor", display_name: "Cursor", kind: "external" });
    // instance-scoped: the account is the instance_id, not the shared per-user one
    expect(kc.store.get(`${INSTANCE_ID}/metistry:METISTRY_AGENT_TOKEN_CURSOR`)).toBe("minted-1");
    // and it travelled on stdin, never in argv
    expect(kc.calls.some((call) => call.args.some((a) => a.includes("minted-1")))).toBe(false);
  });

  it("is idempotent: an existing row is not re-created, and nothing secret is printed without --rotate", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "cursor", display_name: "Cursor" }]);
    const r = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });

    expect(r).toMatchObject({ created: false, rotated: false, token: "unchanged" });
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /api/agents"]);
    expect([...kc.store.keys()]).toEqual([]);
    expect(renderConnect(r)).toContain("--rotate");
  });

  it("--rotate mints a replacement and stores it", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "cursor", display_name: "Cursor" }]);
    const r = await connect({ tool: "cursor", rotate: true, ...base(home, instanceDir, kc.exec, c.fetchFn) });

    expect(r).toMatchObject({ created: false, rotated: true, token: "keychain" });
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /api/agents", "POST /api/agents/cursor/rotate"]);
    expect(kc.store.get(`${INSTANCE_ID}/metistry:METISTRY_AGENT_TOKEN_CURSOR`)).toBe("rotated-1");
  });

  it("applies --areas as a tier-areas grant and --project as membership, and leaves both alone when neither is given", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({
      tool: "cursor",
      areas: ["Areas/Engineering", "Projects"],
      projects: ["second-instance"],
      ...base(home, instanceDir, kc.exec, c.fetchFn),
    });
    expect(r.grants).toEqual({ tier: "areas", areas: ["Areas/Engineering", "Projects"] });
    expect(r.projects).toEqual(["second-instance"]);
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /api/agents", "POST /api/agents", "PUT /api/agents/cursor/grants", "PUT /api/agents/cursor/projects"]);
    expect(c.calls[2]!.body).toEqual({ tier: "areas", areas: ["Areas/Engineering", "Projects"] });

    const again = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(again.grants).toEqual({ tier: "areas", areas: ["Areas/Engineering", "Projects"] });
    expect(c.calls.filter((x) => x.path.endsWith("/grants"))).toHaveLength(1);
  });

  it("surfaces the console's own refusal instead of inventing one", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    await expect(connect({ tool: "cursor", areas: ["knowledge/lowercase"], ...base(home, instanceDir, kc.exec, c.fetchFn) })).rejects.toThrow(/invalid_request/);
  });

  it("refuses a revoked row rather than pretending to reconnect it", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "devin", revoked: true }]);
    await expect(connect({ tool: "devin", ...base(home, instanceDir, kc.exec, c.fetchFn) })).rejects.toThrow(/revoked/);
  });

  // S2: approve-before-enroll (docs/research/2026-09-13-google-sam-review.md ADOPT 2)
  it("--remote enrols PENDING: the flag reaches the console, and the operator is told the bearer authenticates nothing yet", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "devin", remote: true, ...base(home, instanceDir, kc.exec, c.fetchFn) });

    expect(c.calls[1]!.body).toEqual({ id: "devin", display_name: "Devin", kind: "external", remote: true });
    expect(r.pending).toBe(true);
    const text = renderConnect(r);
    expect(text).toMatch(/authenticates NOTHING until you let it in/);
    expect(text).toContain("/api/agents/devin/approve");
  });

  it("without --remote nothing changes: a loopback tool is immediate and the body carries no flag", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(c.calls[1]!.body).toEqual({ id: "cursor", display_name: "Cursor", kind: "external" });
    expect(r.pending).toBe(false);
    expect(renderConnect(r)).not.toMatch(/authenticates NOTHING/);
  });

  it("--remote is decided at enrolment: it is refused on a row that already exists, rather than widening it", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "cursor", display_name: "Cursor", remote: false }]);
    await expect(connect({ tool: "cursor", remote: true, ...base(home, instanceDir, kc.exec, c.fetchFn) })).rejects.toThrow(/decided at enrolment, not after it/);
    expect(c.calls.map((x) => x.method)).toEqual(["GET"]); // nothing was minted or changed
  });

  it("--list shows a pending row as pending, not as registered", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "devin", display_name: "Devin", remote: true, pending: true }]);
    const r = await connectList(base(home, instanceDir, kc.exec, c.fetchFn));
    expect(r.tools.find((t) => t.tool === "devin")?.agent).toBe("pending");
    expect(renderConnectList(r)).toContain("awaiting your approval");
  });

  it("mints nothing on a host with no Keychain to put the bearer in", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    await expect(connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn), platform: "linux" })).rejects.toThrow(/login Keychain.*nothing was minted/s);
    expect(c.calls).toEqual([]);
  });
});

describe("connect cursor: ~/.cursor/mcp.json", () => {
  it("merges, preserves every other server, and writes 0600 with the bearer NOT in the file", async () => {
    const { home, instanceDir } = await scratch();
    const file = cursorConfigFile(home);
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } }, someOtherSetting: true }, null, 2));

    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(r).toMatchObject({ config_file: file, config_key: "metistry", config_state: "written" });

    const text = readFileSync(file, "utf8");
    const doc = JSON.parse(text) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }>; someOtherSetting: boolean };
    expect(doc.mcpServers.linear).toEqual({ url: "https://mcp.linear.app/mcp" });
    expect(doc.someOtherSetting).toBe(true);
    expect(doc.mcpServers.metistry).toEqual({ url: "http://127.0.0.1:8080/mcp", headers: { Authorization: "Bearer ${env:METISTRY_AGENT_TOKEN_CURSOR}" } });
    expect(text).not.toContain("minted-1");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(renderConnect(r)).not.toContain("minted-1");
  });

  it("creates the file when there is none, and a re-run changes nothing", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const first = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(first.config_state).toBe("written");
    const text = readFileSync(cursorConfigFile(home), "utf8");

    const second = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(second.config_state).toBe("unchanged");
    expect(readFileSync(cursorConfigFile(home), "utf8")).toBe(text);
  });

  it("refuses a file it cannot parse, and says what to add by hand", async () => {
    const { home } = await scratch();
    const file = cursorConfigFile(home);
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(file, "// a comment Cursor may tolerate and JSON.parse does not\n{}\n");
    await expect(writeCursorConfig(file, "metistry", "http://127.0.0.1:8080/mcp", "METISTRY_AGENT_TOKEN_CURSOR")).rejects.toThrow(/not JSON.*mcpServers/s);
    expect(readFileSync(file, "utf8")).toContain("// a comment");
  });

  it("namespaces the server key, the token variable and the port for a second instance on one Mac", async () => {
    const { home, instanceDir } = await scratch();
    await writeFile(
      join(instanceDir, ".metistry", "state", "ports.yaml"),
      ["schema: 1", `instance_id: "${INSTANCE_ID}"`, 'label_suffix: "a1b2c3d4"', "base: 8304", "ports:", "  console: 8304", "  db: 8305", "  reconciler: 8306", "  eventkit: 8307", "  apple-fm: 8308", ""].join("\n"),
    );
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(r).toMatchObject({ mcp_url: "http://127.0.0.1:8304/mcp", config_key: "metistry-a1b2c3d4", token_var: "METISTRY_AGENT_TOKEN_CURSOR_A1B2C3D4" });
    expect(serverKey("a1b2c3d4")).toBe("metistry-a1b2c3d4");
    expect(agentTokenVar("claude-code")).toBe("METISTRY_AGENT_TOKEN_CLAUDE_CODE");
    const doc = JSON.parse(readFileSync(cursorConfigFile(home), "utf8")) as { mcpServers: Record<string, { headers: Record<string, string> }> };
    expect(doc.mcpServers["metistry-a1b2c3d4"]!.headers.Authorization).toBe("Bearer ${env:METISTRY_AGENT_TOKEN_CURSOR_A1B2C3D4}");
  });
});

describe("connect opencode: ~/.config/opencode/opencode.json", () => {
  it("merges an mcp entry, preserves every other server and setting, and writes 0600 with the bearer NOT in the file", async () => {
    const { home, instanceDir } = await scratch();
    const file = opencodeConfigFile(home, {});
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/some-model", mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } }, null, 2),
    );

    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "opencode", ...base(home, instanceDir, kc.exec, c.fetchFn), env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER, HOME: home } });
    expect(r).toMatchObject({ display_name: "OpenCode", config_file: file, config_key: "metistry", config_state: "written", token_var: "METISTRY_AGENT_TOKEN_OPENCODE" });

    const text = readFileSync(file, "utf8");
    const doc = JSON.parse(text) as { model: string; mcp: Record<string, Record<string, unknown>> };
    expect(doc.model).toBe("anthropic/some-model");
    expect(doc.mcp.jira).toEqual({ type: "remote", url: "https://jira.example.com/mcp", enabled: true });
    // the shape OpenCode documents for a remote server, with its own {env:…} interpolation
    expect(doc.mcp.metistry).toEqual({ type: "remote", url: "http://127.0.0.1:8080/mcp", enabled: true, headers: { Authorization: "Bearer {env:METISTRY_AGENT_TOKEN_OPENCODE}" } });
    expect(doc.mcp.metistry).toEqual(opencodeServerEntry("http://127.0.0.1:8080/mcp", "METISTRY_AGENT_TOKEN_OPENCODE"));
    expect(text).not.toContain("minted-1");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // the bearer went to the Keychain instead, on stdin
    expect(kc.store.get(`${INSTANCE_ID}/metistry:METISTRY_AGENT_TOKEN_OPENCODE`)).toBe("minted-1");
    const printed = renderConnect(r);
    expect(printed).not.toContain("minted-1");
    expect(printed).toContain("{env:METISTRY_AGENT_TOKEN_OPENCODE}");
    expect(printed).toContain("plugins/opencode/install.mjs");
  });

  it("creates the file (with the schema line) when there is none, and a re-run changes nothing", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const first = await connect({ tool: "opencode", ...base(home, instanceDir, kc.exec, c.fetchFn), env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER, HOME: home } });
    expect(first.config_state).toBe("written");
    const text = readFileSync(opencodeConfigFile(home, {}), "utf8");
    expect(JSON.parse(text).$schema).toBe("https://opencode.ai/config.json");

    const second = await connect({ tool: "opencode", ...base(home, instanceDir, kc.exec, c.fetchFn), env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER, HOME: home } });
    expect(second.config_state).toBe("unchanged");
    expect(readFileSync(opencodeConfigFile(home, {}), "utf8")).toBe(text);
  });

  it("writes the file OpenCode loads last: an existing opencode.jsonc, not a new opencode.json beside it", async () => {
    const { home } = await scratch();
    const dir = join(home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "opencode.jsonc"), JSON.stringify({ plugin: ["opencode-something"] }, null, 2));
    const file = opencodeConfigFile(home, {});
    expect(file).toBe(join(dir, "opencode.jsonc"));
    expect(await writeOpencodeConfig(file, "metistry", "http://127.0.0.1:8080/mcp", "METISTRY_AGENT_TOKEN_OPENCODE")).toBe("written");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { plugin: string[]; mcp: Record<string, unknown> };
    expect(doc.plugin).toEqual(["opencode-something"]);
    expect(doc.mcp.metistry).toBeDefined();
    expect(existsSync(join(dir, "opencode.json"))).toBe(false);
  });

  it("follows XDG_CONFIG_HOME, which is where OpenCode looks when it is set", async () => {
    const { home } = await scratch();
    const xdg = join(home, "xdg");
    expect(opencodeConfigFile(home, { XDG_CONFIG_HOME: xdg })).toBe(join(xdg, "opencode", "opencode.json"));
  });

  it("refuses a file it cannot parse — a .jsonc with real comments included — and says what to add by hand", async () => {
    const { home } = await scratch();
    const dir = join(home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "opencode.jsonc");
    await writeFile(file, "// a comment OpenCode tolerates and JSON.parse does not\n{}\n");
    await expect(writeOpencodeConfig(file, "metistry", "http://127.0.0.1:8080/mcp", "METISTRY_AGENT_TOKEN_OPENCODE")).rejects.toThrow(/not JSON.*"mcp"/s);
    expect(readFileSync(file, "utf8")).toContain("// a comment");

    await writeFile(file, JSON.stringify({ mcp: [] }));
    await expect(writeOpencodeConfig(file, "metistry", "http://127.0.0.1:8080/mcp", "METISTRY_AGENT_TOKEN_OPENCODE")).rejects.toThrow(/"mcp" is not an object/);
  });

  it("namespaces the entry and the variable for a second instance on one Mac", async () => {
    const { home, instanceDir } = await scratch();
    await writeFile(
      join(instanceDir, ".metistry", "state", "ports.yaml"),
      ["schema: 1", `instance_id: "${INSTANCE_ID}"`, 'label_suffix: "a1b2c3d4"', "base: 8304", "ports:", "  console: 8304", "  db: 8305", "  reconciler: 8306", "  eventkit: 8307", "  apple-fm: 8308", ""].join("\n"),
    );
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "opencode", ...base(home, instanceDir, kc.exec, c.fetchFn), env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER, HOME: home } });
    expect(r).toMatchObject({ config_key: "metistry-a1b2c3d4", token_var: "METISTRY_AGENT_TOKEN_OPENCODE_A1B2C3D4" });
    const doc = JSON.parse(readFileSync(opencodeConfigFile(home, {}), "utf8")) as { mcp: Record<string, { headers: Record<string, string> }> };
    expect(doc.mcp["metistry-a1b2c3d4"]!.headers.Authorization).toBe("Bearer {env:METISTRY_AGENT_TOKEN_OPENCODE_A1B2C3D4}");
    expect(doc.mcp.metistry).toBeUndefined();
  });

  it("shows up in --list with its file and its entry", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const common = { ...base(home, instanceDir, kc.exec, c.fetchFn), env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER, HOME: home } };
    const before = await connectList(common);
    expect(before.tools.find((t) => t.tool === "opencode")).toMatchObject({ agent: "absent", token: "absent", config: `${opencodeConfigFile(home, {})}: no metistry entry` });
    await connect({ tool: "opencode", ...common });
    const after = await connectList(common);
    expect(after.tools.find((t) => t.tool === "opencode")).toMatchObject({ agent: "registered", token: "keychain", config: `${opencodeConfigFile(home, {})} → mcp.metistry` });
  });
});

describe("connect devin: the three fields to paste", () => {
  it("prints (and --json carries) name, URL and Authorization value, with the loopback warning", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "devin", ...base(home, instanceDir, kc.exec, c.fetchFn) });

    expect(r.token).toBe("printed");
    expect(r.paste).toEqual({ name: "metistry", transport: "HTTP (Streamable HTTP)", url: "http://127.0.0.1:8080/mcp", header: "Authorization", bearer: "Bearer minted-1" });
    expect(r.loopback).toBe(true);
    expect(r.config_file).toBeUndefined();
    // no file exists to write, so nothing is stored either
    expect([...kc.store.keys()]).toEqual([]);
    const text = renderConnect(r);
    expect(text).toContain("Customize");
    expect(text).toContain("Bearer minted-1");
    expect(text).toMatch(/loopback/);
  });

  it("has no bearer to show for an already-registered Devin", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "devin", display_name: "Devin" }]);
    const r = await connect({ tool: "devin", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(r.paste?.bearer).toBeUndefined();
    expect(renderConnect(r)).toContain("--rotate");
  });

  it("drops the loopback warning once the console has a real origin", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({
      tool: "devin",
      ...base(home, instanceDir, kc.exec, c.fetchFn),
      env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER, METISTRY_CONSOLE_URL: "https://studio.example.ts.net" },
    });
    expect(r.loopback).toBe(false);
    expect(r.mcp_url).toBe("https://studio.example.ts.net/mcp");
    expect(renderConnect(r)).not.toMatch(/loopback/);
  });
});

describe("connect claude-code", () => {
  it("mints the token the plugin docs mint by hand and prints the plugin's own variables", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    const r = await connect({ tool: "claude-code", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(r).toMatchObject({ display_name: "Claude Code", token: "keychain", token_var: "METISTRY_AGENT_TOKEN_CLAUDE_CODE" });
    expect(r.config_file).toBeUndefined();
    const text = renderConnect(r);
    expect(text).toContain("METISTRY_URL=http://127.0.0.1:8080");
    expect(text).toContain("METISTRY_OWNER_TOKEN=");
    expect(text).toContain("METISTRY_CAPTURE_ON_STOP=1");
    expect(text).toContain("/plugin install metistry@metistry");
    expect(text).not.toContain("minted-1");
  });
});

describe("connect --list", () => {
  it("reports each tool's row, bearer and config", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole();
    await connect({ tool: "cursor", ...base(home, instanceDir, kc.exec, c.fetchFn) });
    const listed = await connectList({ ...base(home, instanceDir, kc.exec, c.fetchFn) });

    expect(listed.console_url).toBe("http://127.0.0.1:8080");
    expect(listed.tools.map((t) => t.tool)).toEqual(["claude-code", "cursor", "devin", "opencode"]);
    expect(listed.tools.find((t) => t.tool === "cursor")).toMatchObject({ agent: "registered", token: "keychain", config: `${cursorConfigFile(home)} → mcpServers.metistry` });
    expect(listed.tools.find((t) => t.tool === "claude-code")).toMatchObject({ agent: "absent", token: "absent" });
    expect(listed.tools.find((t) => t.tool === "devin")).toMatchObject({ agent: "absent", token: "n/a" });

    const table = renderConnectList(listed);
    expect(table).toContain("console  http://127.0.0.1:8080");
    expect(table).toContain("cursor");
    expect(table).not.toContain("minted-1");
  });

  it("shows a revoked row as revoked, not as absent", async () => {
    const { home, instanceDir } = await scratch();
    const kc = fakeSecurity();
    const c = fakeConsole([{ id: "devin", revoked: true }]);
    const listed = await connectList({ ...base(home, instanceDir, kc.exec, c.fetchFn) });
    expect(listed.tools.find((t) => t.tool === "devin")).toMatchObject({ agent: "revoked" });
  });
});

describe("metistry connect (argv)", () => {
  it("names the tools it knows rather than guessing, exit 2", async () => {
    const err: string[] = [];
    expect(await main(["connect", "windsurf"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("\n")).toContain("metistry connect <claude-code|cursor|devin|opencode>");
    expect(parseTool("windsurf")).toBeUndefined();
    expect(parseTool("cursor")).toBe("cursor");
  });

  it("is in the help text with its tools and its default-deny grants", async () => {
    const out: string[] = [];
    expect(await main(["help"], { out: (s) => out.push(s), err: () => {} })).toBe(0);
    const usage = out.join("\n");
    expect(usage).toContain("metistry connect <cursor|opencode|devin|claude-code>");
    expect(usage).toContain("~/.cursor/mcp.json");
    expect(usage).toContain("~/.config/opencode/opencode.json");
    expect(usage).toContain('{tier: "none", areas: []}');
    expect(usage).toContain("--rotate");
  });

  it("--list --json: exactly one JSON document on stdout (connect.ts hands main() no progress channel to leak)", async () => {
    const { home, instanceDir } = await scratch();
    // a permissive Keychain: this test is about the stdout/stderr split, not
    // about which account the owner token is filed under (console-client.test.ts covers that)
    const permissiveKeychain: Exec = async (cmd, args) =>
      cmd === "security" && args[0] === "find-generic-password" ? { code: 0, stdout: `${OWNER}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" };
    const c = fakeConsole();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["connect", "--list", "--json", "--instance", instanceDir], {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      platform: "darwin",
      home,
      exec: permissiveKeychain,
      fetchFn: c.fetchFn,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).console_url).toBe("http://127.0.0.1:8080");
  });
});
