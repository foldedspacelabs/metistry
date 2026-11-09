// `metistry connections add|set --config` (T4-11): an agent connection — a
// target a task is dispatched to — and a GitHub tracker take their
// connection type's fields from the command line. Driven through `main()`
// against scratch instance directories under the OS temp dir and a fake
// `security` (never the login Keychain); nothing is dialled.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/exec.js";
import { main } from "../src/main.js";
import { realExec } from "../src/exec.js";

const ID = "11111111-2222-4333-8444-555555555555";
const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

const exec: Exec = async (cmd, args, opts) => {
  if (cmd === "security") return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
  return cmd === "launchctl" ? { code: 113, stdout: "", stderr: "not loaded" } : realExec(cmd, args, opts);
};

async function instance(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-connections-agent-${label}-`));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\ninstance_id: "${ID}"\n`);
  return dir;
}

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), exec, platform: "darwin", uid: 501 });
  return { code, all: [...out, ...err].join("\n") };
}

const file = (dir: string, name: string) => join(dir, ".metistry/connections", `${name}.yaml`);
const yamlOf = (dir: string, name: string) => parseYaml(readFileSync(file(dir, name), "utf8")) as Record<string, any>;
const addDevin = (dir: string, ...config: string[]) =>
  run(["connections", "add", "devin", "--type", "agent", "--provider", "devin", "--url", "https://api.devin.ai", "--auth", "bearer", "--secret", "devin_api_key", ...config.flatMap((c) => ["--config", c]), "--no-discover", "--instance", dir]);

describe("metistry connections add --config", () => {
  it("writes an agent connection with its type's fields, and points its first sync at it", async () => {
    const dir = await instance("add");
    const r = await addDevin(dir, "org=org-abc", "repos=o/a,o/b");
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, "devin")).toMatchObject({ type: "agent", provider: "devin", config: { org: "org-abc", repos: "o/a,o/b" }, secrets: ["devin_api_key"] });
    const scheduled = parseYaml(readFileSync(join(dir, ".metistry/scheduled.yaml"), "utf8")) as Record<string, any>;
    expect(scheduled.syncs["devin-sessions"]).toEqual({ connection: "devin" });
  });

  it("refuses, writing nothing: a required field missing, a field the type does not have, a key pasted as a value, a field given twice", async () => {
    const dir = await instance("refuse");
    expect((await addDevin(dir)).all).toMatch(/config\.org: required by devin/);
    expect((await addDevin(dir, "org=org-abc", "team=x")).all).toMatch(/config\.team: devin has no field "team"/);
    const pasted = await addDevin(dir, `org=${KEY}`);
    expect(pasted.code).not.toBe(0);
    expect(pasted.all).not.toContain(KEY);
    expect((await addDevin(dir, "org=a", "org=b")).all).toMatch(/--config org is given twice/);
    expect(existsSync(file(dir, "devin"))).toBe(false);
  });

  it("a custom connection has no fields to set", async () => {
    const dir = await instance("custom");
    const r = await run(["connections", "add", "x", "--type", "api", "--url", "https://api.example.com", "--config", "a=b", "--no-discover", "--instance", dir]);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/a custom connection has none/);
  });
});

describe("metistry connections set --config / --unset-config", () => {
  it("changes and removes a field, and refuses removing a required one", async () => {
    const dir = await instance("set");
    expect((await addDevin(dir, "org=org-abc", "repos=o/a")).code).toBe(0);
    const set = await run(["connections", "set", "devin", "--config", "org=org-new", "--unset-config", "repos", "--instance", dir]);
    expect(set.code, set.all).toBe(0);
    expect(yamlOf(dir, "devin").config).toEqual({ org: "org-new" });
    const bad = await run(["connections", "set", "devin", "--unset-config", "org", "--instance", dir]);
    expect(bad.code).not.toBe(0);
    expect(bad.all).toMatch(/config\.org: required by devin/);
    expect(yamlOf(dir, "devin").config).toEqual({ org: "org-new" });
  });
});
