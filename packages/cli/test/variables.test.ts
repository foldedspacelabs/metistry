// `metistry variables set|unset|list` — M14 (design-build-plan §2.14, T4-4),
// driven through `main()` exactly as the Mac app drives it, against a fake
// `security` (never the login Keychain) and scratch instance directories
// under the OS temp dir.
//
// Bold, the ticket's own: **a key-shaped value is refused** — nothing is
// written, and the refusal names the variable, never the value. Beside it:
// a variable can never hold one of this instance's secret values, and ruling
// 2 (K8) — no schedule or time — is refused at the tool.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVariablesFile } from "@foldedspacelabs/metistry-core";
import type { Exec } from "../src/exec.js";
import { main } from "../src/main.js";
import { variableUsage } from "../src/variables.js";

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-9999-aaaaaaaaaaaa";
/** A GitHub token's shape, built so no scanner mistakes this file for a leak. */
const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

/** A Keychain in a Map keyed `<account>/<service>`, answering `security` the way the real one does. */
function fakeSecurity(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push(args);
    if (cmd !== "security") return { code: 127, stdout: "", stderr: `${cmd}: not faked` };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, calls };
}

async function instance(label: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-variables-${label}-`));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\ninstance_id: "${ID}"\n`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

async function run(argv: string[], kc = fakeSecurity()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), exec: kc.exec, platform: "darwin", uid: 501 });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}

const variablesYaml = (dir: string) => readFileSync(join(dir, ".metistry/variables.yaml"), "utf8");

describe("**a key-shaped value is refused**", () => {
  it("nothing is written, the refusal says Store as Secret, and the value is not echoed", async () => {
    const dir = await instance("key");
    const r = await run(["variables", "set", "deploy_token_note", KEY, "--instance", dir]);
    expect(r.code).toBe(1);
    // a secret's NAME is refused before the value is even looked at
    expect(r.err).toMatch(/secret's name/);

    const shaped = await run(["variables", "set", "deploy", KEY, "--instance", dir]);
    expect(shaped.code).toBe(1);
    expect(shaped.err).toContain("This looks like a key. Variables can be read by agents — Store as Secret: `metistry secrets set deploy`");
    expect(shaped.all).not.toContain(KEY);
    expect(existsSync(join(dir, ".metistry/variables.yaml"))).toBe(false);
  });

  it("an existing file keeps what it had: a refused set changes nothing", async () => {
    const dir = await instance("keep");
    expect((await run(["variables", "set", "team_name", "Platform", "--instance", dir])).code).toBe(0);
    const before = variablesYaml(dir);
    expect((await run(["variables", "set", "team_name", KEY, "--instance", dir])).code).toBe(1);
    expect(variablesYaml(dir)).toBe(before);
  });
});

describe("a variable never holds this instance's secret", () => {
  it("a value equal to one of this instance's secrets is refused naming the SECRET — even one no heuristic would catch", async () => {
    const dir = await instance("collide", {
      ".metistry/secrets.yaml": "secrets:\n  door_code:\n    hosts: []\n  wifi:\n    hosts: []\n",
    });
    const kc = fakeSecurity({
      [`${ID}/metistry:secret:door_code`]: "4711",
      [`${ID}/metistry:secret:wifi`]: "correct horse battery staple",
      // another instance's item with the same name is not this instance's secret
      [`${OTHER}/metistry:secret:office`]: "Platform",
    });
    const pin = await run(["variables", "set", "office_code", "4711", "--instance", dir], kc);
    expect(pin.code).toBe(1);
    expect(pin.err).toContain("this instance's secret door_code");
    expect(pin.err).toContain("{{ secret.door_code }}");
    expect(pin.all).not.toContain("4711");

    const phrase = await run(["variables", "set", "guest_note", "wifi: correct horse battery staple", "--instance", dir], kc);
    expect(phrase.code).toBe(1);
    expect(phrase.err).toContain("this instance's secret wifi");
    expect(phrase.all).not.toContain("correct horse");
    expect(existsSync(join(dir, ".metistry/variables.yaml"))).toBe(false);

    // and the comparison only ever asked for THIS instance's items
    for (const c of kc.calls.filter((a) => a[0] === "find-generic-password")) expect(c[c.indexOf("-a") + 1]).toBe(ID);

    expect((await run(["variables", "set", "team_name", "Platform", "--instance", dir], kc)).code).toBe(0);
  });
});

describe("no schedule or time lives in a variable (ruling 2, K8)", () => {
  it("standup_time and timezone are refused by name, 09:15 and a zone by value", async () => {
    const dir = await instance("sched");
    for (const argv of [
      ["standup_time", "Platform"],
      ["timezone", "Platform"],
      ["team_name", "09:15"],
      ["team_name", "America/New_York"],
      ["team_name", "0 8 * * 1-5"],
    ]) {
      const r = await run(["variables", "set", ...argv, "--instance", dir]);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toMatch(/no schedule or time lives in a variable.*Me\/profile\.md/);
    }
    expect(existsSync(join(dir, ".metistry/variables.yaml"))).toBe(false);
  });
});

describe("metistry variables set | unset | list", () => {
  it("set writes .metistry/variables.yaml as the owner — keeping hand-written comments — and list shows where each is used", async () => {
    const dir = await instance("set", {
      ".metistry/variables.yaml": "# mine: the org's shared names\nvariables:\n  company: Acme # the legal name\n",
      ".metistry/agents/example/researcher.md": "---\nname: researcher\n---\nYou work for {{ variable.company }} on {{ variable.team_name }}.\n",
      ".metistry/connections/github.yaml": "name: github\nvariables: [team_name]\nreach: { http: { url: \"https://api.github.com/orgs/{{ variable.team_name }}\" } }\n",
      ".metistry/state/cache.yaml": "ignored: {{ variable.team_name }}\n",
    });
    const set = await run(["variables", "set", "team_name", "Platform", "--instance", dir]);
    expect(set.code, set.err).toBe(0);
    expect(set.out).toContain("set team_name");
    const text = variablesYaml(dir);
    expect(text).toContain("# mine: the org's shared names");
    expect(text).toContain("# the legal name");
    expect(parseVariablesFile(text).variables).toEqual({ company: "Acme", team_name: "Platform" });

    const listed = await run(["variables", "list", "--json", "--instance", dir]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out)).toEqual({
      variables: [
        { name: "company", value: "Acme", read_by: ["agent:researcher"], used_in: [".metistry/agents/example/researcher.md"] },
        {
          name: "team_name",
          value: "Platform",
          read_by: ["agent:researcher", "connection:github"],
          used_in: [".metistry/agents/example/researcher.md", ".metistry/connections/github.yaml"],
        },
      ],
    });
    const human = await run(["variables", "list", "--instance", dir]);
    expect(human.out).toMatch(/team_name\s+Platform\s+\.metistry\/agents\/example\/researcher\.md, \.metistry\/connections\/github\.yaml/);

    // change, then unset — which names what still references it
    expect((await run(["variables", "set", "team_name", "Infra", "--instance", dir])).out).toContain("changed team_name");
    const unset = await run(["variables", "unset", "team_name", "--instance", dir]);
    expect(unset.code).toBe(0);
    expect(unset.out).toContain("will not fill in: .metistry/agents/example/researcher.md, .metistry/connections/github.yaml");
    expect(parseVariablesFile(variablesYaml(dir)).variables).toEqual({ company: "Acme" });
  });

  it("--dry-run writes nothing; unset of an unknown name and a bad verb are refusals", async () => {
    const dir = await instance("dry");
    expect((await run(["variables", "set", "team_name", "Platform", "--dry-run", "--instance", dir])).code).toBe(0);
    expect(existsSync(join(dir, ".metistry/variables.yaml"))).toBe(false);
    const unknown = await run(["variables", "unset", "nope", "--instance", dir]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no variable named nope");
    expect((await run(["variables", "frobnicate", "--instance", dir])).code).toBe(2);
    expect((await run(["variables", "set", "team_name", "--instance", dir])).code).toBe(1);
  });

  it("a hand-edited file that carries a key is not edited further, and the error does not echo it", async () => {
    const dir = await instance("hand", { ".metistry/variables.yaml": `variables:\n  deploy: "${KEY}"\n` });
    const r = await run(["variables", "set", "team_name", "Platform", "--instance", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refusing to edit it/);
    expect(r.all).not.toContain(KEY);
    const l = await run(["variables", "list", "--instance", dir]);
    expect(l.code).toBe(1);
    expect(l.all).not.toContain(KEY);
  });

  it("variableUsage walks .metistry/ but not state/ and not variables.yaml itself", async () => {
    const dir = await instance("walk", {
      ".metistry/variables.yaml": "# {{ variable.company }} in a comment\nvariables:\n  company: Acme\n",
      ".metistry/state/x.yaml": "{{ variable.company }}",
      ".metistry/routines/brief/manifest.yaml": "note: {{ variable.company }}\n",
    });
    expect(Object.fromEntries(await variableUsage(dir))).toEqual({ company: [".metistry/routines/brief/manifest.yaml"] });
  });
});
