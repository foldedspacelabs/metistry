// `metistry connections add|set --config KEY=VALUE` (T6-13b; coordinator call
// 2026-09-30 — T4-11's flag, made the one validated flag): a known service's
// config fields, judged against its connection type's manifest BEFORE anything
// is written, driven through `main()` as the Mac's editor drives it.
//
// Bold, the door's misuse tests: **a secret field refuses a value on the
// command line** — pointing at `metistry secrets set`, never echoing it,
// writing nothing; **an unknown key, a value of the wrong kind and a required
// field left out are each exit 2** with one line naming the field; **an oauth
// field is never typed**; **a custom connection takes no field**. And what a
// valid `--config` writes: a text as it is, a URL, a choice, a variable and a
// secret as their references — every one listed for the grant check.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

const ID = "11111111-2222-4333-8444-555555555555";
const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

/** An extension connection type with a field of every kind — what a stranger's `.metistry/extensions/<name>/` may declare. */
const TRACKER_TYPE = `schema: 1
name: acme-tracker
type: connection-type
description: Acme Tracker — issues and tasks at a workspace of yours. A personal API key, sent to the workspace only.
provides: mcp
transports: [http]
fields:
  - { key: workspace, kind: text, label: Workspace, help: The workspace's short name, required: true }
  - { key: server, kind: url, label: Server, required: false, default: "https://mcp.acme.example/mcp" }
  - { key: region, kind: choice, label: Region, required: false, default: eu, options: [{ value: eu, label: Europe }, { value: us, label: United States }] }
  - { key: team, kind: variable, label: Team, required: false }
  - { key: api_key, kind: secret, label: API key, required: false }
  - key: account
    kind: oauth
    label: Acme account
    required: false
    oauth: { client_id: acme-public-client, pkce: true, redirect: loopback, authorize_url: "https://auth.acme.example/authorize", token_url: "https://auth.acme.example/token", scopes: [read] }
tools:
  list_issues: { group: reads }
`;

async function instance(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-connections-fields-${label}-`));
  await mkdir(join(dir, ".metistry", "extensions", "acme-tracker"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\ninstance_id: "${ID}"\n`);
  await writeFile(join(dir, ".metistry/extensions/acme-tracker/manifest.yaml"), TRACKER_TYPE);
  return dir;
}

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), exec: async () => ({ code: 1, stdout: "", stderr: "not faked" }), platform: "darwin", uid: 501 });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}

const file = (dir: string, name: string) => join(dir, ".metistry/connections", `${name}.yaml`);
const yamlOf = (dir: string, name: string) => parseYaml(readFileSync(file(dir, name), "utf8")) as Record<string, any>;
const BASE = (dir: string) => ["connections", "add", "acme", "--type", "mcp", "--provider", "acme-tracker", "--url", "https://mcp.acme.example/mcp", "--no-discover", "--instance", dir];

describe("metistry connections add --config (validated)", () => {
  it("writes a text as it is, a URL, a choice, and a variable and a secret as their references — each listed for the grant check", async () => {
    const dir = await instance("ok");
    const r = await run([...BASE(dir), "--config", "workspace=platform", "--config", "server=https://eu.acme.example/mcp", "--config", "region=us", "--config", "team=team_name", "--config", "api_key=acme_key"]);
    expect(r.code, r.all).toBe(0);
    const c = yamlOf(dir, "acme");
    expect(c.config).toEqual({ workspace: "platform", server: "https://eu.acme.example/mcp", region: "us", team: "{{ variable.team_name }}", api_key: "{{ secret.acme_key }}" });
    expect(c.secrets).toEqual(["acme_key"]);
    expect(c.variables).toEqual(["team_name"]);
    // the references may also be written out in full
    const dir2 = await instance("refs");
    const r2 = await run([...BASE(dir2), "--config", "workspace=platform", "--config", "team={{ variable.team_name }}", "--config", "api_key={{ secret.acme_key }}"]);
    expect(r2.code, r2.all).toBe(0);
    expect(yamlOf(dir2, "acme").config).toEqual({ workspace: "platform", team: "{{ variable.team_name }}", api_key: "{{ secret.acme_key }}" });
    // list --json carries the installed types — the extension's, with its fields by kind and nothing of the oauth client
    const listed = await run(["connections", "list", "--json", "--instance", dir]);
    const body = JSON.parse(listed.out) as { types: Array<{ name: string; origin: string; title: string; fields: Array<{ key: string; kind: string }> }> };
    const acme = body.types.find((t) => t.name === "acme-tracker")!;
    expect(acme.origin).toBe("extension");
    expect(acme.title).toBe("Acme Tracker");
    expect(acme.fields.map((f) => [f.key, f.kind])).toEqual([["workspace", "text"], ["server", "url"], ["region", "choice"], ["team", "variable"], ["api_key", "secret"], ["account", "oauth"]]);
    expect(listed.out).not.toContain("acme-public-client");
    expect(listed.out).not.toContain("authorize_url");
  });

  it("**a secret field refuses a value on the command line** — pointing at secrets set, echoing nothing, writing nothing", async () => {
    const dir = await instance("secret");
    for (const value of [KEY, "hunter2!", "not a name"]) {
      const r = await run([...BASE(dir), "--config", "workspace=platform", "--config", `api_key=${value}`]);
      expect(r.code, r.all).toBe(2);
      expect(r.err).toMatch(/--config api_key: a secret never goes on a command line .* `metistry secrets set <name>`/);
      expect(r.all).not.toContain(value);
      expect(existsSync(file(dir, "acme"))).toBe(false);
    }
    // a text field is held to the same heuristic: a key pasted there is refused and not echoed
    const text = await run([...BASE(dir), "--config", `workspace=${KEY}`]);
    expect(text.code).toBe(2);
    expect(text.err).toMatch(/--config workspace: this looks like a key/);
    expect(text.all).not.toContain(KEY);
    expect(existsSync(file(dir, "acme"))).toBe(false);
  });

  it("**an unknown key, a value of the wrong kind and a required field left out are each exit 2**, naming the field", async () => {
    const dir = await instance("usage");
    const cases: Array<[string[], RegExp]> = [
      [["--config", "workspace=platform", "--config", "colour=blue"], /config\.colour: acme-tracker has no field "colour" — its fields: workspace, server, region, team, api_key, account/],
      [["--config", "workspace=platform", "--config", "region=asia"], /--config region: Region is one of eu, us/],
      [["--config", "workspace=platform", "--config", "server=mcp.acme.example"], /--config server: Server is an http\(s\) URL/],
      [["--config", "workspace=platform", "--config", "server=https://mcp.acme.example/?k={{ secret.acme_key }}"], /--config server: a URL never carries a secret/],
      [["--config", "workspace=platform", "--config", "team=the platform team"], /--config team: a variable field names a variable/],
      [["--config", "workspace=platform", "--config", "workspace=other"], /--config workspace is given twice/],
      [["--config", "workspace"], /--config takes KEY=VALUE/],
      [[], /config\.workspace: required by acme-tracker — --config workspace=… \(Workspace — The workspace's short name\)/],
    ];
    for (const [flags, why] of cases) {
      const r = await run([...BASE(dir), ...flags]);
      expect(r.code, `${flags.join(" ")}: ${r.all}`).toBe(2);
      expect(r.err, flags.join(" ")).toMatch(why);
      expect(existsSync(file(dir, "acme"))).toBe(false);
    }
  });

  it("**an oauth field is never typed** — --auth oauth writes it and authorize signs in; **a custom connection takes no field**", async () => {
    const dir = await instance("oauth");
    const typed = await run([...BASE(dir), "--config", "workspace=platform", "--config", "account=me@acme.example"]);
    expect(typed.code).toBe(2);
    expect(typed.err).toMatch(/--config account: an oauth field is signed in, not typed — `--auth oauth` writes it and `metistry connections authorize <name>` signs in/);
    expect(typed.all).not.toContain("me@acme.example");
    // and --auth oauth alongside a --config: the oauth field's references and the typed fields both land in config
    const signIn = await run([...BASE(dir), "--auth", "oauth", "--config", "workspace=platform"]);
    expect(signIn.code, signIn.all).toBe(0);
    expect(yamlOf(dir, "acme").config).toEqual({ workspace: "platform", account: { token: "{{ secret.acme_oauth_token }}" } });

    const custom = await run(["connections", "add", "plain", "--type", "mcp", "--url", "https://mcp.example.com/mcp", "--no-discover", "--config", "workspace=x", "--instance", dir]);
    expect(custom.code).toBe(2);
    expect(custom.err).toMatch(/--config sets a connection type's fields — a custom connection has none/);
    expect(existsSync(file(dir, "plain"))).toBe(false);
    const missing = await run(["connections", "add", "gone", "--type", "mcp", "--provider", "nowhere", "--url", "https://mcp.example.com/mcp", "--no-discover", "--config", "a=b", "--instance", dir]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/no connection type named nowhere is installed/);
  });
});

describe("metistry connections set --config / --unset-config (validated)", () => {
  it("changes a field, judged the same way; a required field cannot be unset by omission, and an unknown one is exit 2", async () => {
    const dir = await instance("set");
    expect((await run([...BASE(dir), "--config", "workspace=platform"])).code).toBe(0);
    const r = await run(["connections", "set", "acme", "--config", "region=us", "--config", "api_key=acme_key", "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/set acme: config region, config api_key/);
    const c = yamlOf(dir, "acme");
    expect(c.config).toEqual({ workspace: "platform", region: "us", api_key: "{{ secret.acme_key }}" });
    expect(c.secrets).toEqual(["acme_key"]);
    const unknown = await run(["connections", "set", "acme", "--config", "colour=blue", "--instance", dir]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/config\.colour: acme-tracker has no field "colour"/);
    const leak = await run(["connections", "set", "acme", "--config", `api_key=${KEY}`, "--instance", dir]);
    expect(leak.code).toBe(2);
    expect(leak.all).not.toContain(KEY);
    expect(readFileSync(file(dir, "acme"), "utf8")).not.toContain(KEY);
    expect(yamlOf(dir, "acme").config.api_key).toBe("{{ secret.acme_key }}");
    // --unset-config removes a field; a required one is refused by the file's judge, and nothing changes
    const unset = await run(["connections", "set", "acme", "--unset-config", "region", "--instance", dir]);
    expect(unset.code, unset.all).toBe(0);
    expect(yamlOf(dir, "acme").config).toEqual({ workspace: "platform", api_key: "{{ secret.acme_key }}" });
    const required = await run(["connections", "set", "acme", "--unset-config", "workspace", "--instance", dir]);
    expect(required.code).not.toBe(0);
    expect(required.err).toMatch(/config\.workspace: required by acme-tracker/);
    expect(yamlOf(dir, "acme").config.workspace).toBe("platform");
    expect((await run(["connections", "set", "acme", "--unset-config", "colour", "--instance", dir])).code).toBe(2);
  });
});
