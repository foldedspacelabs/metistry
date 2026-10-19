// The listing every surface renders, `check()`'s four verdicts, and the
// catalog read from a real (scratch) instance directory.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_STAMPS_FILE,
  ConnectionPool,
  checkConnection,
  connectionTypeTitle,
  describeConnectionDetail,
  describeConnectionTypes,
  describeConnections,
  forgetCheck,
  loadInstanceCatalog,
  readCheckStamps,
  type ConnectionCatalog,
  type ConnectionUser,
  type PoolEvent,
} from "../src/index.js";
import { FAKE_STDIO, catalogOf, fakeHttpMcp, secretsWith } from "./helpers.js";

const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

const pools: ConnectionPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});

function poolFor(catalog: ConnectionCatalog, secrets: Record<string, string> = {}, events: PoolEvent[] = []): ConnectionPool {
  const store = secretsWith(secrets);
  const p = new ConnectionPool({ catalog: async () => catalog, secrets: { value: async (n) => (await store).value(n) }, onEvent: (e) => void events.push(e), connectTimeoutMs: 20_000 });
  pools.push(p);
  return p;
}

const stdio = (name: string, tools: Record<string, { group: string; mode: string }>, env: Record<string, string> = {}, secrets: string[] = []) => ({
  name,
  type: "mcp",
  provider: "custom",
  reach: { command: { command: process.execPath, args: [FAKE_STDIO], env } },
  secrets,
  tools,
});

describe("checkConnection — ok, degraded, absent, failed", () => {
  it("ok: it answered and every listed tool is on offer; the facts ride in meta, and the host hears a connection_check", async () => {
    const events: PoolEvent[] = [];
    const catalog = catalogOf([stdio("fake", { echo: { group: "reads", mode: "on" } })]);
    const r = await checkConnection(poolFor(catalog, {}, events), catalog, "fake");
    expect(r.status).toBe("ok");
    expect(r.probe).toMatch(/initialize \+ tools\/list over stdio .*: 5 tools offered, 1 listed/);
    expect(r.meta).toMatchObject({ tools_seen: 5, listed: 1, missing: [], read_only_hint: ["search_issues"] });
    expect((r.meta as { unlisted: string[] }).unlisted).toEqual(["delete_issue", "env", "search_issues", "secret_echo"]);
    expect(events).toEqual([expect.objectContaining({ kind: "connection_check", connection: "fake", ok: true })]);
  });

  it("degraded: a listed tool is no longer offered", async () => {
    const catalog = catalogOf([stdio("fake", { echo: { group: "reads", mode: "on" }, delete_issue: { group: "changes", mode: "ask" } }, { FAKE_TOOLS: "echo,env" })]);
    const r = await checkConnection(poolFor(catalog), catalog, "fake");
    expect(r.status).toBe("degraded");
    expect(r.remediation).toMatch(/no longer offers delete_issue/);
    expect((r.meta as { missing: string[] }).missing).toEqual(["delete_issue"]);
  });

  it("absent: the command is not here, a secret has no item, the provider is not installed", async () => {
    const noCmd = catalogOf([{ ...stdio("fake", {}), reach: { command: { command: "metistry-test-no-such-command" } } }]);
    expect((await checkConnection(poolFor(noCmd), noCmd, "fake")).status).toBe("absent");

    const noItem = catalogOf([stdio("fake", {}, { FAKE_SECRET: "{{ secret.env_key }}" }, ["env_key"])], { secrets: `secrets:\n  env_key:\n    grants: { "connection:fake": on }\n` });
    const r = await checkConnection(poolFor(noItem), noItem, "fake");
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/env_key/);

    const noType = catalogOf([{ ...stdio("fake", {}), provider: "github-official" }]);
    expect((await checkConnection(poolFor(noType), noType, "fake")).status).toBe("absent");
  });

  it("failed: a grant the owner did not give, a server that cannot be reached, a file that does not validate", async () => {
    const notGranted = catalogOf([stdio("fake", {}, { FAKE_SECRET: "{{ secret.env_key }}" }, ["env_key"])]);
    const r = await checkConnection(poolFor(notGranted, { env_key: "x".repeat(12) }), notGranted, "fake");
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/metistry secrets grant env_key connection:fake on/);

    const fake = await fakeHttpMcp();
    await fake.close();
    const gone = catalogOf([{ name: "remote", type: "mcp", provider: "custom", reach: { http: { url: fake.url } } }]);
    expect((await checkConnection(poolFor(gone), gone, "remote")).status).toBe("failed");

    const bad = catalogOf([{ name: "bad", type: "mcp" }]);
    expect((await checkConnection(poolFor(bad), bad, "bad")).status).toBe("failed");
    expect((await checkConnection(poolFor(bad), bad, "nope")).status).toBe("failed");
  });
});

describe("describeConnections — names, never values", () => {
  const presence = (held: string[]) => ({ has: async (n: string) => held.includes(n) });

  describe("who uses it, and when it was last checked (X-96)", () => {
    const granted = new Map<string, ConnectionUser[]>([
      [
        "fake",
        [
          { kind: "crew", name: "scribe" },
          { kind: "agent", name: "devin" },
        ],
      ],
    ]);
    const file = (offer: boolean) => ({ ...stdio("fake", { echo: { group: "reads", mode: "on" } }), offer_to_agents: offer });

    it("an agent or crew granted a connection appears in used_by beside its syncs, once it is offered to agents", async () => {
      const [row] = await describeConnections(catalogOf([file(true)]), { granted, scheduled: { syncs: { mirror: { connection: "fake" } } } });
      expect(row!.used_by).toEqual([
        { kind: "sync", name: "mirror" },
        { kind: "agent", name: "devin" },
        { kind: "crew", name: "scribe" },
      ]);
      // the detail serves the same list
      const detail = await describeConnectionDetail("fake", catalogOf([file(true)]), ".metistry/connections/fake.yaml", { granted });
      expect(detail!.used_by.map((u) => u.name)).toEqual(["devin", "scribe"]);
    });

    it("a grant on a connection the owner has not offered reaches nothing, so it is not 'use'; no registry given, no agents are listed", async () => {
      const [off] = await describeConnections(catalogOf([file(false)]), { granted });
      expect(off!.used_by).toEqual([]);
      const [unknown] = await describeConnections(catalogOf([file(true)]));
      expect(unknown!.used_by).toEqual([]);
    });

    it("a check stamps last_checked with its time and verdict — and only a check does", async () => {
      const instance = await mkdtemp(join(tmpdir(), "metistry-checks-"));
      const catalog = { ...catalogOf([stdio("fake", { echo: { group: "reads", mode: "on" }, gone: { group: "reads", mode: "on" } }, { FAKE_TOOLS: "echo" })]), baseDir: instance };
      expect((await describeConnections(catalog))[0]!.last_checked).toBeNull();
      const before = Date.now();
      const r = await checkConnection(poolFor(catalog), catalog, "fake");
      expect(r.status).toBe("degraded");
      const [row] = await describeConnections(catalog);
      expect(row!.last_checked).toEqual({ at: expect.any(String), status: "degraded" });
      expect(Date.parse(row!.last_checked!.at)).toBeGreaterThanOrEqual(before - 1000);
      // a verdict and a time: never the check's remediation text
      expect(await readFile(join(instance, ".metistry", "state", CHECK_STAMPS_FILE), "utf8")).not.toMatch(/no longer offers/);
      // the newest check wins, and one stamp never loses another
      const other = { ...catalogOf([stdio("fake", {}), stdio("second", {})]), baseDir: instance };
      await Promise.all([checkConnection(poolFor(other), other, "fake"), checkConnection(poolFor(other), other, "second")]);
      const stamps = await readCheckStamps(instance);
      expect([...stamps.keys()].sort()).toEqual(["fake", "second"]);
      expect(stamps.get("fake")!.status).toBe("ok");
      // a connection that is gone leaves no stamp behind for a same-named one to inherit
      const onlyFake = { ...catalogOf([stdio("fake", {})]), baseDir: instance };
      await checkConnection(poolFor(onlyFake), onlyFake, "fake");
      expect([...(await readCheckStamps(instance)).keys()]).toEqual(["fake"]);
      await forgetCheck(instance, "fake");
      expect((await readCheckStamps(instance)).size).toBe(0);
    });

    it("a check of a name that is no connection stamps nothing; a garbled stamp file reads as never checked", async () => {
      const instance = await mkdtemp(join(tmpdir(), "metistry-checks-"));
      const catalog = { ...catalogOf([stdio("fake", {})]), baseDir: instance };
      await checkConnection(poolFor(catalog), catalog, "nope");
      expect((await readCheckStamps(instance)).size).toBe(0);
      await mkdir(join(instance, ".metistry", "state"), { recursive: true });
      await writeFile(join(instance, ".metistry", "state", CHECK_STAMPS_FILE), '{"fake":{"at":"not a time","status":"ok"},"x":7,"y":{"at":"2026-10-01T00:00:00Z","status":"fine"}}');
      expect((await readCheckStamps(instance)).size).toBe(0);
      await writeFile(join(instance, ".metistry", "state", CHECK_STAMPS_FILE), "{not json");
      expect((await describeConnections(catalog))[0]!.last_checked).toBeNull();
    });

    it("two headers list two secret names — each header with the secrets its value names, never the value", async () => {
      const http = {
        name: "remote",
        type: "mcp",
        provider: "custom",
        reach: { http: { url: "https://mcp.example.com/mcp", headers: { "X-Org": "acme", "X-Api-Key": "{{ secret.api_key }}", Authorization: "Bearer {{ secret.org_token }}" } } },
        secrets: ["api_key", "org_token"],
      };
      const [row] = await describeConnections(catalogOf([http]));
      expect(row!.reach).toMatchObject({
        class: "http",
        headers: ["Authorization", "X-Api-Key", "X-Org"],
        header_secrets: [
          { header: "Authorization", secrets: ["org_token"] },
          { header: "X-Api-Key", secrets: ["api_key"] },
          { header: "X-Org", secrets: [] },
        ],
      });
      expect(JSON.stringify(row)).not.toContain("Bearer");
      expect(JSON.stringify(row)).not.toContain("{{");
    });
  });

  it("a row says how it is reached with names only, its tools and modes, and who reads it", async () => {
    const catalog = catalogOf(
      [
        {
          name: "github",
          type: "mcp",
          provider: "custom",
          description: "GitHub's MCP server",
          reach: { command: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{ secret.github_read }}", LOG: "warn" } } },
          secrets: ["github_read"],
          tools: { search_issues: { group: "reads", mode: "on" }, create_issue: { group: "changes" } },
        },
      ],
      { secrets: `secrets:\n  github_read:\n    grants: { "connection:github": on }\n` },
    );
    const rows = await describeConnections(catalog, { presence: presence(["github_read"]), scheduled: { syncs: { "github-state": { connection: "github" }, other: { connection: "linear" } } } });
    expect(rows).toEqual([
      {
        name: "github",
        type: "mcp",
        provider: "custom",
        description: "GitHub's MCP server",
        status: "ok",
        issues: [],
        reach: { class: "command", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], cwd: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN", "LOG"], runs_on: "host" },
        secrets: ["github_read"],
        variables: [],
        tools: [
          { name: "create_issue", group: "changes", mode: "ask" },
          { name: "search_issues", group: "reads", mode: "on" },
        ],
        offer_to_agents: false,
        fold: true,
        used_by: [{ kind: "sync", name: "github-state" }],
        last_checked: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("{{ secret");
    expect(JSON.stringify(rows)).not.toContain("warn");
  });

  it("a file that broke a rule shows its name, status and why — nothing it holds", async () => {
    const catalog = catalogOf([{ name: "leaky", type: "mcp", provider: "custom", reach: { http: { url: "https://x.example.com/mcp", headers: { Authorization: `Bearer ${KEY}` } } } }]);
    const [row] = await describeConnections(catalog);
    expect(row).toMatchObject({ name: "leaky", status: "failed", reach: null, tools: [], type: null });
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it("what the door would refuse is said ahead of time: no item (absent), not granted, a host not listed (failed)", async () => {
    const http = { name: "remote", type: "mcp", provider: "custom", reach: { http: { url: "https://mcp.example.com/mcp", auth: { scheme: "bearer", secret: "svc" } } }, secrets: ["svc"] };
    const listed = `secrets:\n  svc:\n    hosts: [mcp.example.com]\n    grants: { "connection:remote": on }\n`;

    const absent = await describeConnections(catalogOf([http], { secrets: listed }), { presence: presence([]) });
    expect(absent[0]).toMatchObject({ status: "absent", issues: [expect.stringMatching(/secret svc has no item in this instance's Keychain — `metistry secrets set svc`/)] });

    const off = await describeConnections(catalogOf([http], { secrets: `secrets:\n  svc:\n    hosts: [mcp.example.com]\n` }), { presence: presence(["svc"]) });
    expect(off[0]).toMatchObject({ status: "failed", issues: [expect.stringMatching(/does not grant svc to connection:remote — `metistry secrets grant svc connection:remote on`/)] });

    const host = await describeConnections(catalogOf([http], { secrets: `secrets:\n  svc:\n    hosts: [api.github.com]\n    grants: { "connection:remote": on }\n` }), { presence: presence(["svc"]) });
    expect(host[0]).toMatchObject({ status: "failed", issues: [expect.stringMatching(/svc may not be sent to mcp\.example\.com .*`metistry secrets hosts svc api\.github\.com mcp\.example\.com`/)] });

    const fine = await describeConnections(catalogOf([http], { secrets: listed }), { presence: presence(["svc"]) });
    expect(fine[0]).toMatchObject({ status: "ok", issues: [] });
  });

  it("a variable that is not set makes it absent, naming the verb", async () => {
    const rows = await describeConnections(catalogOf([{ name: "c", type: "mcp", provider: "custom", reach: { command: { command: "npx", env: { ORG: "{{ variable.org }}" } } }, variables: ["org"] }]));
    expect(rows[0]).toMatchObject({ status: "absent", issues: ["variable org is not set — `metistry variables set org <value>`"] });
  });
});

describe("loadInstanceCatalog — one instance, its registry and its files", () => {
  it("reads .metistry/connections/, the seed's connection types and the owner's extensions, variables, secrets and scheduled.yaml", async () => {
    const instance = await mkdtemp(join(tmpdir(), "metistry-connections-instance-"));
    const seed = await mkdtemp(join(tmpdir(), "metistry-connections-seed-"));
    await mkdir(join(seed, "connection-types", "linear"), { recursive: true });
    await writeFile(join(seed, "connection-types", "linear", "manifest.yaml"), "schema: 1\nname: linear\ntype: connection-type\nprovides: mcp\ntransports: [http]\ntools:\n  list_issues: { group: reads }\n");
    await mkdir(join(instance, ".metistry", "extensions", "jira"), { recursive: true });
    await writeFile(
      join(instance, ".metistry", "extensions", "jira", "manifest.yaml"),
      [
        "schema: 1",
        "name: jira",
        "type: connection-type",
        "description: Jira — issues at a site of yours. An API token, sent to the site only.",
        "provides: mcp",
        "transports: [http]",
        "auth: [none, bearer, oauth]",
        "fields:",
        "  - { key: site, kind: url, label: Site, help: Your Atlassian site, required: true }",
        "  - { key: project, kind: text, label: Project, required: false, default: OPS }",
        "  - { key: view, kind: choice, label: View, required: false, default: board, options: [{ value: board, label: Board }, { value: list, label: List }] }",
        "  - { key: team, kind: variable, label: Team, required: false }",
        "  - { key: token, kind: secret, label: API token, required: false }",
        "  - key: account",
        "    kind: oauth",
        "    label: Atlassian account",
        "    required: false",
        "    oauth: { client_id: jira-public, pkce: true, redirect: loopback, authorize_url: \"https://auth.atlassian.com/authorize\", token_url: \"https://auth.atlassian.com/oauth/token\", scopes: [read:jira-work] }",
        "",
      ].join("\n"),
    );
    await mkdir(join(instance, ".metistry", "connections"), { recursive: true });
    await writeFile(join(instance, ".metistry", "connections", "linear.yaml"), "name: linear\ntype: mcp\nprovider: linear\nreach: { http: { url: \"https://mcp.linear.app/mcp\" } }\ntools:\n  list_issues: { group: reads, mode: on }\n");
    await writeFile(join(instance, ".metistry", "connections", "jira.yaml"), "name: jira\ntype: mcp\nprovider: jira\nreach: { http: { url: \"https://{{ variable.site }}/mcp\" } }\nvariables: [site]\nconfig: { site: \"https://jira.example.com/\" }\n");
    await writeFile(join(instance, ".metistry", "variables.yaml"), "variables:\n  site: jira.example.com\n");
    await writeFile(join(instance, ".metistry", "scheduled.yaml"), "syncs:\n  linear:\n    connection: linear\n");

    const catalog = await loadInstanceCatalog({ instanceDir: instance, seedDir: seed });
    expect(catalog.types.names()).toEqual(["jira", "linear"]);
    expect(catalog.entries.map((e) => [e.name, e.status])).toEqual([
      ["jira", "ok"],
      ["linear", "ok"],
    ]);
    const detail = await describeConnectionDetail("linear", catalog, ".metistry/connections/linear.yaml");
    expect(detail).toMatchObject({
      name: "linear",
      file: ".metistry/connections/linear.yaml",
      used_by: [{ kind: "sync", name: "linear" }],
      provider_unit: { name: "linear", origin: "product", provides: "mcp", implementation: "native", tools: [{ name: "list_issues", group: "reads" }] },
    });
    expect(await describeConnectionDetail("nope", catalog, "x")).toBeUndefined();

    const noExt = await loadInstanceCatalog({ instanceDir: instance, seedDir: seed, extensions: false });
    expect(noExt.entries.find((e) => e.name === "jira")?.status).toBe("absent");

    // the installed types (T6-13b): seed and extension through one registry, each field by KIND — nothing of an oauth client, no place for a value
    const types = describeConnectionTypes(catalog.types);
    expect(types.map((t) => [t.name, t.origin, t.title, t.provides])).toEqual([
      ["jira", "extension", "Jira", "mcp"],
      ["linear", "product", "linear", "mcp"],
    ]);
    const jira = types[0]!;
    expect(jira).toMatchObject({ description: expect.stringContaining("Jira — issues"), transports: ["http"], auth: ["none", "bearer", "oauth"], capabilities: [], tools: [] });
    expect(jira.fields).toEqual([
      { key: "site", kind: "url", label: "Site", help: "Your Atlassian site", required: true },
      { key: "project", kind: "text", label: "Project", help: null, required: false, default: "OPS" },
      { key: "view", kind: "choice", label: "View", help: null, required: false, default: "board", choices: [{ value: "board", label: "Board" }, { value: "list", label: "List" }] },
      { key: "team", kind: "variable", label: "Team", help: null, required: false },
      { key: "token", kind: "secret", label: "API token", help: null, required: false },
      { key: "account", kind: "oauth", label: "Atlassian account", help: null, required: false },
    ]);
    expect(JSON.stringify(types)).not.toContain("jira-public");
    expect(JSON.stringify(types)).not.toContain("authorize_url");
    expect(types[1]).toMatchObject({ auth: null, fields: [], tools: [{ name: "list_issues", group: "reads" }] });
    // the detail's provider_unit carries the same unit
    const jiraDetail = await describeConnectionDetail("jira", catalog, ".metistry/connections/jira.yaml");
    expect(jiraDetail?.provider_unit?.type).toEqual(jira);
    expect(noExt.types.names()).toEqual(["linear"]);
    expect(describeConnectionTypes(noExt.types).map((t) => t.name)).toEqual(["linear"]);
  });

  it("a type's title is its description up to the first dash or full stop, or its name", () => {
    expect(connectionTypeTitle({ name: "linear", description: "Linear — the issues assigned to you, on the Board as work." })).toBe("Linear");
    expect(connectionTypeTitle({ name: "caldav", description: "A CalDAV calendar (RFC 6638) with an app password. For iCloud, use its own entry." })).toBe("A CalDAV calendar (RFC 6638) with an app password");
    expect(connectionTypeTitle({ name: "gmail-mail", description: "Gmail over IMAP with an app password (2-Step Verification on) — headers, never bodies." })).toBe("Gmail over IMAP with an app password (2-Step Verification on)");
    expect(connectionTypeTitle({ name: "ics", description: undefined })).toBe("ics");
    expect(connectionTypeTitle({ name: "x", description: "y".repeat(81) })).toBe("x");
  });
});
