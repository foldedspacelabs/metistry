// Reading connection files: the three verdicts, the rules this package adds
// to F-3's schema, and that a file which breaks a rule never repeats what it
// holds.

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRegistry, manifestKind } from "@foldedspacelabs/metistry-core";
import { judgeConnection, planDial, readConnections, ConnectionRefused } from "../src/index.js";

const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

const mcp = (over: Record<string, unknown> = {}) => ({
  name: "github",
  type: "mcp",
  provider: "custom",
  reach: { command: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{ secret.github_read }}" } } },
  secrets: ["github_read"],
  tools: { search_issues: { group: "reads", mode: "on" } },
  ...over,
});

const linearType = {
  schema: 1,
  name: "linear",
  type: "connection-type",
  provides: "mcp",
  transports: ["http"],
  tools: { list_issues: { group: "reads" }, create_issue: { group: "changes" } },
};
const types = buildRegistry(manifestKind("connection-type"), [{ path: "/seed/connection-types/linear/manifest.yaml", origin: "product", dirName: "linear", input: linearType }]);

describe("judgeConnection", () => {
  it("a valid custom MCP connection is ok", () => {
    const e = judgeConnection("github", "/x/github.yaml", mcp(), types);
    expect(e.status).toBe("ok");
    expect(e.issues).toEqual([]);
    expect(e.connection?.tools.search_issues).toEqual({ group: "reads", mode: "on" });
  });

  it("a tool with no mode defaults to Ask First, never On (CLAUDE.md, K4)", () => {
    const e = judgeConnection("github", "/x/github.yaml", mcp({ tools: { search_issues: { group: "reads" } } }), types);
    expect(e.connection?.tools.search_issues?.mode).toBe("ask");
  });

  it("a file named for another connection is failed", () => {
    const e = judgeConnection("gh", "/x/gh.yaml", mcp(), types);
    expect(e.status).toBe("failed");
    expect(e.issues[0]).toMatch(/gh\.yaml but says name: github/);
  });

  it("a provider no registry unit provides is absent, naming it — nothing is deleted", () => {
    const e = judgeConnection("github", "/x/github.yaml", mcp({ provider: "github-official" }), types);
    expect(e.status).toBe("absent");
    expect(e.issues[0]).toMatch(/provider "github-official" is not installed/);
  });

  it("a connection whose provider relabels a Changes tool as Reads is failed", () => {
    const e = judgeConnection(
      "linear",
      "/x/linear.yaml",
      { name: "linear", type: "mcp", provider: "linear", reach: { http: { url: "https://mcp.linear.app/mcp" } }, tools: { create_issue: { group: "reads", mode: "on" } } },
      types,
    );
    expect(e.status).toBe("failed");
    expect(e.issues.join()).toMatch(/declares it changes — a connection cannot relabel it reads/);
  });

  it("**a key pasted where a name belongs** is failed, and the issue never repeats it", () => {
    for (const over of [
      { reach: { http: { url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${KEY}` } } } },
      { reach: { command: { command: "npx", args: ["server", "--token", KEY] } } },
      { reach: { command: { command: "npx", env: { TOKEN: KEY } } } },
      { description: `uses ${KEY}` },
    ]) {
      const e = judgeConnection("github", "/x/github.yaml", mcp({ ...("reach" in over ? { secrets: [] } : {}), ...over }), types);
      expect(e.status).toBe("failed");
      expect(e.issues.join()).toMatch(/looks like a key — a connection file holds names, never values/);
      expect(JSON.stringify(e.issues)).not.toContain(KEY);
    }
  });

  it("a secret in a URL, its query, a command line or a working directory is failed — env and headers only", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ reach: { http: { url: "https://x.example.com/{{ secret.github_read }}" } } }, /reach\.http\.url: a secret goes in a header, never the URL/],
      [{ reach: { http: { url: "https://x.example.com/mcp", query: { key: "{{ secret.github_read }}" } } } }, /reach\.http\.query\.key: a secret goes in a header/],
      [{ reach: { command: { command: "npx", args: ["--token={{ secret.github_read }}"] } } }, /reach\.command\.args\.0: a secret on a command line is readable by every process/],
      [{ reach: { command: { command: "npx", cwd: "{{ secret.github_read }}" } } }, /reach\.command\.cwd: a working directory carries no secret/],
    ];
    for (const [over, re] of cases) {
      const e = judgeConnection("github", "/x/github.yaml", mcp(over), types);
      expect(e.status, JSON.stringify(over)).toBe("failed");
      expect(e.issues.join("\n")).toMatch(re);
    }
  });

  it("an Authorization header beside an auth shortcut that writes one is failed", () => {
    const e = judgeConnection(
      "github",
      "/x/github.yaml",
      mcp({ reach: { http: { url: "https://x.example.com/mcp", auth: { scheme: "bearer", secret: "github_read" }, headers: { authorization: "Bearer {{ secret.github_read }}" } } } }),
      types,
    );
    expect(e.status).toBe("failed");
    expect(e.issues.join()).toMatch(/writes the authorization header itself/);
  });

  it("a file the schema refuses is failed with the schema's own words", () => {
    const e = judgeConnection("github", "/x/github.yaml", mcp({ reach: { http: { url: "https://x" }, command: { command: "npx" } } }), types);
    expect(e.status).toBe("failed");
    expect(e.issues.join()).toMatch(/reach is exactly one of http, command, path/);
  });
});

describe("readConnections", () => {
  it("reads every <name>.yaml, judges each, and a bad file is one failed entry — never fatal, never its text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-connections-read-"));
    await writeFile(join(dir, "github.yaml"), "name: github\ntype: mcp\nprovider: custom\nreach: { command: { command: npx } }\n");
    await writeFile(join(dir, "broken.yaml"), `name: broken\ntype: mcp\n  token: ${KEY}\n  : :\n`);
    await writeFile(join(dir, "twice.yaml"), "name: twice\n");
    await writeFile(join(dir, "twice.yml"), "name: twice\n");
    await writeFile(join(dir, "Bad Name.yaml"), "name: x\n");
    await writeFile(join(dir, "README.md"), "not a connection\n");
    await mkdir(join(dir, "elsewhere"));
    await writeFile(join(dir, "elsewhere", "real.yaml"), "name: linked\n");
    await symlink(join(dir, "elsewhere", "real.yaml"), join(dir, "linked.yaml"));

    const entries = await readConnections(dir, types);
    const by = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(entries.map((e) => e.name)).toEqual(["Bad Name", "broken", "github", "linked", "twice"]);
    expect(by.github?.status).toBe("ok");
    expect(by.broken?.status).toBe("failed");
    expect(by.broken?.issues[0]).toMatch(/^not valid YAML — [A-Z_]+ at line \d+$/);
    expect(JSON.stringify(entries)).not.toContain(KEY);
    expect(by.twice?.issues[0]).toMatch(/two files for one connection \(twice\.yaml and twice\.yml\)/);
    expect(by.linked?.issues[0]).toMatch(/symbolic link is not followed/);
    expect(by["Bad Name"]?.issues[0]).toMatch(/named <name>\.yaml/);
  });

  it("no directory is no connections", async () => {
    expect(await readConnections(join(tmpdir(), "metistry-no-such-dir-xyz"), types)).toEqual([]);
  });
});

describe("planDial", () => {
  const vars = { ok: true as const, file: { variables: { team_name: "Platform", org: "acme" } } };

  it("fills variables, writes the auth shortcut as a reference, and never a value", () => {
    const e = judgeConnection(
      "remote",
      "/x/remote.yaml",
      {
        name: "remote",
        type: "mcp",
        provider: "custom",
        reach: { http: { url: "https://mcp.{{ variable.org }}.example.com/mcp", auth: { scheme: "bearer", secret: "svc" }, query: { team: "{{ variable.team_name }}" }, headers: { "X-Org": "{{ variable.org }}" }, timeout_s: 5 } },
        secrets: ["svc"],
        variables: ["org", "team_name"],
      },
      types,
    );
    const plan = planDial(e, vars);
    expect(plan).toEqual({
      kind: "http",
      url: "https://mcp.acme.example.com/mcp?team=Platform",
      origin: "https://mcp.acme.example.com",
      headers: { "x-org": "acme", authorization: "Bearer {{ secret.svc }}" },
      timeoutMs: 5000,
    });
  });

  it("an api_key shortcut writes the service's own header", () => {
    const e = judgeConnection("lin", "/x/lin.yaml", { name: "lin", type: "mcp", provider: "custom", reach: { http: { url: "https://api.example.com/mcp", auth: { scheme: "api_key", header: "Authorization", secret: "svc" } } }, secrets: ["svc"] }, types);
    const plan = planDial(e, vars);
    expect(plan.kind === "http" && plan.headers).toEqual({ authorization: "{{ secret.svc }}" });
  });

  it("a missing variable refuses, naming it", () => {
    const e = judgeConnection("remote", "/x/remote.yaml", { name: "remote", type: "mcp", provider: "custom", reach: { command: { command: "npx", env: { ORG: "{{ variable.nope }}" } } }, variables: ["nope"] }, types);
    expect(() => planDial(e, vars)).toThrow(ConnectionRefused);
    expect(() => planDial(e, vars)).toThrow(/reach\.command\.env\.ORG: no variable \{\{ variable\.nope \}\}/);
  });

  it("basic and OAuth sign-in, and the types this release does not dial, refuse as not built — naming where they arrive", () => {
    const basic = judgeConnection("r", "/x/r.yaml", { name: "r", type: "mcp", provider: "custom", reach: { http: { url: "https://x.example.com/mcp", auth: { scheme: "basic", username: "me", secret: "pw" } } }, secrets: ["pw"] }, types);
    expect(() => planDial(basic, vars)).toThrow(/basic sign-in arrives with T4-10/);
    const feed = judgeConnection("f", "/x/f.yaml", { name: "f", type: "feed", provider: "custom", reach: { http: { url: "https://x.example.com/feed.xml" } } }, types);
    expect(() => planDial(feed, vars)).toThrow(/feed: tools generated for a feed arrive with T4-10/);
  });

  it("a relative working directory resolves against the instance", () => {
    const e = judgeConnection("c", "/x/c.yaml", { name: "c", type: "mcp", provider: "custom", reach: { command: { command: "node", cwd: "tools/mcp" } } }, types);
    const plan = planDial(e, vars, "/instances/home");
    expect(plan.kind === "command" && plan.cwd).toBe("/instances/home/tools/mcp");
  });
});
