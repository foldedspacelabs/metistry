// The listing every surface renders, `check()`'s four verdicts, and the
// catalog read from a real (scratch) instance directory.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionPool, checkConnection, describeConnectionDetail, describeConnections, loadInstanceCatalog, type ConnectionCatalog, type PoolEvent } from "../src/index.js";
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
        used_by: [{ kind: "sync", name: "github-state" }],
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
    await writeFile(join(instance, ".metistry", "extensions", "jira", "manifest.yaml"), "schema: 1\nname: jira\ntype: connection-type\nprovides: mcp\ntransports: [http]\n");
    await mkdir(join(instance, ".metistry", "connections"), { recursive: true });
    await writeFile(join(instance, ".metistry", "connections", "linear.yaml"), "name: linear\ntype: mcp\nprovider: linear\nreach: { http: { url: \"https://mcp.linear.app/mcp\" } }\ntools:\n  list_issues: { group: reads, mode: on }\n");
    await writeFile(join(instance, ".metistry", "connections", "jira.yaml"), "name: jira\ntype: mcp\nprovider: jira\nreach: { http: { url: \"https://{{ variable.site }}/mcp\" } }\nvariables: [site]\n");
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
  });
});
