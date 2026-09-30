// `metistry connections list|show|add|set|policy|remove|test` — M13
// (design-build-plan §2.2, §2.6; T4-8a), driven through `main()` exactly as
// the Mac app drives it, against a fake `security` (never the login
// Keychain), scratch instance directories under the OS temp dir, and a fake
// MCP server run as a real child process.
//
// What the verbs refuse — each before anything is written, and never
// repeating a value: a key pasted where a name belongs, a secret in a URL, a
// name already taken, a server that does not answer. What they default to —
// the owner's Q15 answer: Reads Allow, Changes things Ask First, Starts an
// agent Ask First, offer to agents off; a custom server's tools are filed
// under Changes things, because its read-only hint is a hint.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { connectionRows } from "../src/doctor.js";
import type { Exec } from "../src/exec.js";
import { main } from "../src/main.js";
import { realExec } from "../src/exec.js";
import { fakeImap, fixtureMailboxes } from "../../connections/test/imap-server.js";

const ID = "11111111-2222-4333-8444-555555555555";
const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";
const FAKE = fileURLToPath(new URL("../../connections/test/fixtures/fake-stdio-server.mjs", import.meta.url));
const NODE = process.execPath;

/** A Keychain in a Map keyed `<account>/<service>`, answering `security` the way the real one does. */
function fakeSecurity(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd !== "security") return cmd === "launchctl" ? { code: 113, stdout: "", stderr: "not loaded" } : realExec(cmd, args, opts);
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store };
}

async function instance(label: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-connections-${label}-`));
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

const file = (dir: string, name: string) => join(dir, ".metistry/connections", `${name}.yaml`);
const yamlOf = (dir: string, name: string) => parseYaml(readFileSync(file(dir, name), "utf8")) as Record<string, any>;

describe("metistry connections add", () => {
  it("dials once, files a custom server's tools under Changes things at Ask First, offer off — and shows the read-only hint", async () => {
    const dir = await instance("add");
    const r = await run(["connections", "add", "fake", "--type", "mcp", "--env", "FAKE_MODE=plain", "--instance", dir, "--", NODE, FAKE]);
    expect(r.code, r.all).toBe(0);
    const c = yamlOf(dir, "fake");
    expect(c).toMatchObject({ name: "fake", type: "mcp", provider: "custom", offer_to_agents: false, reach: { command: { command: NODE, args: [FAKE], env: { FAKE_MODE: "plain" } } } });
    expect(Object.keys(c.tools).sort()).toEqual(["delete_issue", "echo", "env", "search_issues", "secret_echo"]);
    for (const t of Object.values(c.tools)) expect(t).toEqual({ group: "changes", mode: "ask" });
    expect(r.all).toMatch(/search_issues .*Changes things .*Ask First .*\(the server says read-only\)/);
    expect(r.all).toMatch(/a hint, not a control; `metistry connections policy fake <tool> allow --group reads`/);
    expect(readFileSync(file(dir, "fake"), "utf8")).toMatch(/^# A connection \(docs\/ops\/connections\.md\)/);
  });

  it("a tool its connection type declares keeps the type's group, at Q15's default for that group", async () => {
    const dir = await instance("typed", {
      ".metistry/extensions/fake-tracker/manifest.yaml": "schema: 1\nname: fake-tracker\ntype: connection-type\nprovides: mcp\ntransports: [command]\ntools:\n  search_issues: { group: reads }\n  delete_issue: { group: changes }\n",
    });
    const r = await run(["connections", "add", "fake", "--type", "mcp", "--provider", "fake-tracker", "--instance", dir, "--", NODE, FAKE]);
    expect(r.code, r.all).toBe(0);
    const t = yamlOf(dir, "fake").tools;
    expect(t.search_issues).toEqual({ group: "reads", mode: "on" });
    expect(t.delete_issue).toEqual({ group: "changes", mode: "ask" });
    expect(t.echo).toEqual({ group: "changes", mode: "ask" });
  });

  it("the Linear recipe (docs/ops/connections.md) writes an ok tracker connection the linear sync reads, with no dial (T4-24)", async () => {
    const dir = await instance("linear");
    const r = await run([
      "connections", "add", "linear", "--type", "tracker", "--provider", "linear", "--url", "https://api.linear.app/graphql",
      "--auth", "api_key", "--auth-header", "Authorization", "--secret", "linear_api_key", "--no-discover", "--instance", dir,
    ]);
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, "linear")).toMatchObject({
      type: "tracker",
      provider: "linear",
      reach: { http: { url: "https://api.linear.app/graphql", auth: { scheme: "api_key", header: "Authorization", secret: "linear_api_key" } } },
      secrets: ["linear_api_key"],
    });
    const show = await run(["connections", "show", "linear", "--json", "--instance", dir]);
    expect(show.code, show.all).toBe(0);
    const shown = JSON.parse(show.out).connection;
    expect(shown).toMatchObject({ provider_unit: { provides: "tracker", implementation: "builtin", sync: "linear" }, used_by: [{ kind: "sync", name: "linear" }] });
    // not granted yet: the listing says what the egress door would refuse, before any request
    expect(shown.issues.join(" ")).toContain("does not grant linear_api_key to connection:linear");
  });

  it("the ICS recipe (docs/ops/connections.md) writes an ok calendar connection the ics-calendar sync reads, with no dial (T4-12)", async () => {
    const dir = await instance("ics");
    const r = await run(["connections", "add", "holidays", "--type", "calendar", "--provider", "ics", "--url", "https://example.com/holidays.ics", "--no-discover", "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, "holidays")).toMatchObject({ type: "calendar", provider: "ics", reach: { http: { url: "https://example.com/holidays.ics" } }, secrets: [] });
    const show = await run(["connections", "show", "holidays", "--json", "--instance", dir]);
    expect(show.code, show.all).toBe(0);
    expect(JSON.parse(show.out).connection).toMatchObject({ status: "ok", provider_unit: { provides: "calendar", implementation: "builtin", sync: "ics-calendar" }, used_by: [{ kind: "sync", name: "ics-calendar" }] });
  });

  it("**a feed address that carries a token is a secret**: refused — nothing written, the address never echoed (T4-12)", async () => {
    const dir = await instance("ics-token");
    const url = `https://calendar.google.com/calendar/ical/owner%40gmail.com/private-${["3f9a1c0b", "7e2d4a6f", "8b1c3e5d", "7f9a0b2c"].join("")}/basic.ics`;
    const r = await run(["connections", "add", "gcal", "--type", "calendar", "--provider", "ics", "--url", url, "--no-discover", "--instance", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/reach\.http\.url: this looks like a key/);
    expect(r.all).not.toContain(url.split("private-")[1]);
    expect(existsSync(file(dir, "gcal"))).toBe(false);
  });

  it("**a key pasted where a name belongs** is refused — nothing written, nothing dialled, the value never echoed", async () => {
    const dir = await instance("key");
    const r = await run(["connections", "add", "gh", "--type", "mcp", "--env", `GITHUB_TOKEN=${KEY}`, "--instance", dir, "--", "npx", "-y", "@modelcontextprotocol/server-github"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/reach\.command\.env\.GITHUB_TOKEN: this looks like a key/);
    expect(r.all).not.toContain(KEY);
    expect(existsSync(file(dir, "gh"))).toBe(false);
  });

  it("a secret in a URL is refused; a secret by name in a header is listed for the grant check", async () => {
    const dir = await instance("url");
    const bad = await run(["connections", "add", "remote", "--type", "mcp", "--url", "https://mcp.example.com/{{ secret.svc }}", "--no-discover", "--instance", dir]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/a secret goes in a header, never the URL/);
    expect(existsSync(file(dir, "remote"))).toBe(false);

    const good = await run(["connections", "add", "remote", "--type", "mcp", "--url", "https://mcp.example.com/mcp", "--auth", "bearer", "--secret", "svc", "--no-discover", "--instance", dir]);
    expect(good.code, good.all).toBe(0);
    expect(yamlOf(dir, "remote")).toMatchObject({ reach: { http: { auth: { scheme: "bearer", secret: "svc" } } }, secrets: ["svc"], tools: {} });
    expect(good.all).toMatch(/secrets it uses: svc — each must be granted to connection:remote/);
  });

  it("a server that does not answer writes nothing; a name already taken is refused", async () => {
    const dir = await instance("fail");
    const r = await run(["connections", "add", "gone", "--type", "mcp", "--instance", dir, "--", "metistry-test-no-such-command"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/gone did not answer, so nothing was written .*--no-discover/);
    expect(existsSync(file(dir, "gone"))).toBe(false);

    expect((await run(["connections", "add", "fake", "--type", "mcp", "--no-discover", "--instance", dir, "--", NODE, FAKE])).code).toBe(0);
    const again = await run(["connections", "add", "fake", "--type", "mcp", "--no-discover", "--instance", dir, "--", NODE, FAKE]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already a connection named fake/);
  });

  it("OAuth sign-in on a custom connection needs its client — nothing supplies one (T4-10, C118; connections-p3.test.ts has the rest)", async () => {
    const dir = await instance("oauth");
    const r = await run(["connections", "add", "remote", "--type", "mcp", "--url", "https://x.example.com/mcp", "--auth", "oauth", "--no-discover", "--instance", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a custom OAuth connection names its client/);
  });

  it("the iCloud recipe (docs/ops/connections.md) writes an ok CalDAV connection: basic sign-in, the username written, the app password by name only (T4-13)", async () => {
    const dir = await instance("icloud");
    const r = await run([
      "connections", "add", "icloud", "--type", "calendar", "--provider", "icloud-calendar", "--url", "https://caldav.icloud.com/",
      "--auth", "basic", "--username", "you@icloud.com", "--secret", "icloud_app_password", "--no-discover", "--instance", dir,
    ]);
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, "icloud")).toMatchObject({
      type: "calendar",
      provider: "icloud-calendar",
      reach: { http: { url: "https://caldav.icloud.com/", auth: { scheme: "basic", username: "you@icloud.com", secret: "icloud_app_password" } } },
      secrets: ["icloud_app_password"],
    });
    const show = await run(["connections", "show", "icloud", "--json", "--instance", dir]);
    expect(show.code, show.all).toBe(0);
    expect(JSON.parse(show.out).connection).toMatchObject({ provider_unit: { provides: "calendar", implementation: "builtin", sync: "caldav-calendar" }, used_by: [{ kind: "sync", name: "caldav-calendar" }] });
    // --auth basic needs both halves; a colon in the username is refused
    expect((await run(["connections", "add", "x", "--type", "calendar", "--provider", "caldav", "--url", "https://dav.example.com/", "--auth", "basic", "--secret", "pw", "--no-discover", "--instance", dir])).err).toMatch(/--auth basic needs --username/);
    expect((await run(["connections", "add", "x", "--type", "calendar", "--provider", "caldav", "--url", "https://dav.example.com/", "--auth", "basic", "--username", "a:b", "--secret", "pw", "--no-discover", "--instance", dir])).err).toMatch(/colon/);
  });

  it("**--auth basic is refused for a connection type that does not declare it** — a tracker, a custom MCP server — and nothing is written (T4-13)", async () => {
    const dir = await instance("basic-scope");
    const tracker = await run(["connections", "add", "linear", "--type", "tracker", "--provider", "linear", "--url", "https://api.linear.app/graphql", "--auth", "basic", "--username", "me", "--secret", "pw", "--no-discover", "--instance", dir]);
    expect(tracker.code).toBe(1);
    expect(tracker.err).toMatch(/--auth basic is accepted only by a connection type that declares it .* linear does not/);
    expect(existsSync(file(dir, "linear"))).toBe(false);
    const mcp = await run(["connections", "add", "remote", "--type", "mcp", "--url", "https://x.example.com/mcp", "--auth", "basic", "--username", "me", "--secret", "pw", "--no-discover", "--instance", dir]);
    expect(mcp.code).toBe(1);
    expect(mcp.err).toMatch(/a custom connection does not/);
    expect(existsSync(file(dir, "remote"))).toBe(false);
    // and set cannot put it on one either
    expect((await run(["connections", "add", "remote", "--type", "mcp", "--url", "https://x.example.com/mcp", "--no-discover", "--instance", dir])).code).toBe(0);
    const set = await run(["connections", "set", "remote", "--auth", "basic", "--username", "me", "--secret", "pw", "--instance", dir]);
    expect(set.code).toBe(1);
    expect(set.err).toMatch(/a custom connection does not/);
    expect(yamlOf(dir, "remote")).not.toHaveProperty("reach.http.auth");
  });

  it("**a Google CalDAV address is refused — Google needs sign-in with Google** — and nothing is written (T4-13)", async () => {
    const dir = await instance("google-caldav");
    const r = await run([
      "connections", "add", "gcal", "--type", "calendar", "--provider", "caldav", "--url", "https://apidata.googleusercontent.com/caldav/v2/you%40gmail.com/events",
      "--auth", "basic", "--username", "you@gmail.com", "--secret", "google_app_password", "--no-discover", "--instance", dir,
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Google needs sign-in with Google/);
    expect(existsSync(file(dir, "gcal"))).toBe(false);
  });
});

describe("metistry connections add --imap (T4-15)", () => {
  it("the Gmail recipe (docs/ops/connections.md) writes an ok mail connection: imap.gmail.com:993, the username written, the app password by name only — and dials nothing", async () => {
    const dir = await instance("gmail");
    const r = await run([
      "connections", "add", "gmail", "--type", "mail", "--provider", "gmail-mail", "--imap", "imap.gmail.com:993",
      "--username", "you@gmail.com", "--secret", "gmail_app_password", "--instance", dir,
    ]);
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, "gmail")).toMatchObject({
      type: "mail",
      provider: "gmail-mail",
      reach: { imap: { host: "imap.gmail.com", username: "you@gmail.com", secret: "gmail_app_password" } },
      secrets: ["gmail_app_password"],
      tools: {},
    });
    expect(yamlOf(dir, "gmail").reach.imap).not.toHaveProperty("port");
    expect(r.all).toMatch(/a mailbox — `metistry connections test gmail` signs in/);
    expect(r.all).toMatch(/list imap\.gmail\.com:993 \(`metistry secrets hosts <name> imap\.gmail\.com:993`\)/);
    const list = await run(["connections", "list", "--instance", dir]);
    expect(list.out).toMatch(/imaps:\/\/imap\.gmail\.com:993/);
    expect(list.out).not.toContain("you@gmail.com");
  });

  it("**refused before anything is written**: Gmail anywhere else, a submission port, plain off this Mac, a type that is not reached by imap, a missing half", async () => {
    const dir = await instance("imap-refusals");
    const add = (name: string, ...rest: string[]) => run(["connections", "add", name, "--type", "mail", "--username", "you@gmail.com", "--secret", "pw", "--instance", dir, ...rest]);
    expect((await add("a", "--provider", "gmail-mail", "--imap", "imap.example.com")).err).toMatch(/Gmail is imap\.gmail\.com:993 over TLS and nowhere else/);
    expect((await add("b", "--provider", "imap", "--imap", "mail.example.com:587")).err).toMatch(/mail submission port/);
    expect((await add("c", "--provider", "imap", "--imap", "mail.example.com:143", "--plain")).err).toMatch(/plain is for a server on this Mac only/);
    expect((await add("d", "--provider", "imap", "--imap", "imaps://mail.example.com")).err).toMatch(/--imap takes host or host:port/);
    expect((await add("e", "--provider", "imap", "--imap", "mail.example.com", "--auth", "bearer")).err).toMatch(/--auth takes nothing else/);
    expect((await run(["connections", "add", "f", "--type", "mail", "--provider", "imap", "--imap", "mail.example.com", "--secret", "pw", "--instance", dir])).err).toMatch(/--imap needs --username/);
    expect((await run(["connections", "add", "g", "--type", "calendar", "--provider", "caldav", "--imap", "mail.example.com", "--username", "u", "--secret", "pw", "--instance", dir])).err).toMatch(/caldav is reached by http, not imap/);
    expect((await add("h", "--provider", "imap", "--url", "https://mail.example.com/", "--imap", "mail.example.com")).err).toMatch(/say how it is reached/);
    expect((await add("i", "--provider", "imap", "--url", "https://mail.example.com/", "--plain")).err).toMatch(/--plain is for a connection reached by --imap/);
    for (const n of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) expect(existsSync(file(dir, n)), n).toBe(false);
  });

  it("test signs in to the mailbox with the app password from this instance's Keychain, lists folders and finds Drafts — reading no message", async () => {
    const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join("");
    const s = await fakeImap({ username: "me@example.com", password: PASSWORD, mailboxes: fixtureMailboxes() });
    try {
      const dir = await instance("imap-test");
      const kc = fakeSecurity({ [`${ID}/metistry:secret:mail_password`]: PASSWORD });
      expect((await run(["connections", "add", "mail", "--type", "mail", "--provider", "imap", "--imap", `127.0.0.1:${s.port}`, "--plain", "--username", "me@example.com", "--secret", "mail_password", "--instance", dir], kc)).code).toBe(0);
      // not yet on the secret's Sent only to list: refused before anything is dialled
      await writeFile(join(dir, ".metistry/secrets.yaml"), `secrets:\n  mail_password:\n    grants: { "connection:mail": on }\n`);
      const refused = await run(["connections", "test", "mail", "--json", "--instance", dir], kc);
      expect(JSON.parse(refused.out)).toMatchObject({ status: "failed" });
      expect(refused.out).toMatch(/host_not_listed/);
      expect(s.connections).toBe(0);
      await writeFile(join(dir, ".metistry/secrets.yaml"), `secrets:\n  mail_password:\n    hosts: ["127.0.0.1:${s.port}"]\n    grants: { "connection:mail": on }\n`);
      const ok = await run(["connections", "test", "mail", "--json", "--instance", dir], kc);
      expect(ok.code, ok.all).toBe(0);
      expect(JSON.parse(ok.out)).toMatchObject({ status: "ok", meta: { mailboxes: 5, drafts: "[Gmail]/Drafts", inbox_messages: 3 } });
      expect(ok.all).not.toContain(PASSWORD);
      expect(s.commands.map((l) => l.split(" ")[1])).toEqual(["LOGIN", "LIST", "EXAMINE", "LOGOUT"]);
    } finally {
      await s.close();
    }
  });
});

describe("metistry connections policy, set, list, show, test, remove", () => {
  async function withFake(label: string): Promise<string> {
    const dir = await instance(label);
    const r = await run(["connections", "add", "fake", "--type", "mcp", "--instance", dir, "--", NODE, FAKE]);
    expect(r.code, r.all).toBe(0);
    return dir;
  }

  it("policy sets a tool in the owner's words, lists a new one only with its group, and turns the offer on", async () => {
    const dir = await withFake("policy");
    expect((await run(["connections", "policy", "fake", "search_issues", "allow", "--group", "reads", "--instance", dir])).code).toBe(0);
    expect((await run(["connections", "policy", "fake", "delete_issue", "never", "--instance", dir])).code).toBe(0);
    const unlisted = await run(["connections", "policy", "fake", "brand_new", "ask", "--instance", dir]);
    expect(unlisted.code).toBe(1);
    expect(unlisted.err).toMatch(/brand_new is not listed yet — name its group: --group reads\|changes\|starts_agent/);
    const bad = await run(["connections", "policy", "fake", "echo", "sometimes", "--instance", dir]);
    expect(bad.code).toBe(1);
    expect((await run(["connections", "policy", "fake", "--offer", "on", "--instance", dir])).code).toBe(0);
    const c = yamlOf(dir, "fake");
    expect(c.tools.search_issues).toEqual({ group: "reads", mode: "on" });
    expect(c.tools.delete_issue).toEqual({ group: "changes", mode: "off" });
    expect(c.offer_to_agents).toBe(true);

    const shown = await run(["connections", "policy", "fake", "--instance", dir]);
    expect(shown.out).toMatch(/Reads\n\s+search_issues\s+Allow/);
    expect(shown.out).toMatch(/delete_issue\s+Never/);
    expect(shown.out).toMatch(/echo\s+Ask First/);
  });

  it("set adds an environment variable, and a secret it names joins the list the grant check reads", async () => {
    const dir = await withFake("set");
    const r = await run(["connections", "set", "fake", "--env", "FAKE_SECRET={{ secret.env_key }}", "--description", "the test server", "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    const c = yamlOf(dir, "fake");
    expect(c.reach.command.env.FAKE_SECRET).toBe("{{ secret.env_key }}");
    expect(c.secrets).toEqual(["env_key"]);
    expect(c.description).toBe("the test server");
    const leak = await run(["connections", "set", "fake", "--env", `TOKEN=${KEY}`, "--instance", dir]);
    expect(leak.code).toBe(1);
    expect(leak.all).not.toContain(KEY);
    expect(readFileSync(file(dir, "fake"), "utf8")).not.toContain(KEY);
  });

  it("list and show say what GET /api/connections says — and what the door would refuse", async () => {
    const dir = await withFake("list");
    await run(["connections", "set", "fake", "--env", "FAKE_SECRET={{ secret.env_key }}", "--instance", dir]);
    const listed = await run(["connections", "list", "--json", "--instance", dir]);
    expect(listed.code).toBe(0);
    const { connections } = JSON.parse(listed.out);
    // not granted is what the door would refuse first (failed); no item is said too (absent)
    expect(connections[0]).toMatchObject({ name: "fake", status: "failed", secrets: ["env_key"], reach: { class: "command", env: ["FAKE_SECRET"] } });
    expect(connections[0].issues.join("\n")).toMatch(/does not grant env_key to connection:fake — `metistry secrets grant env_key connection:fake on`/);
    expect(connections[0].issues.join("\n")).toMatch(/secret env_key has no item in this instance's Keychain/);

    const shown = await run(["connections", "show", "fake", "--instance", dir]);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/env\s+FAKE_SECRET \(given to this command only; never written to disk\)/);
    expect(shown.out).toMatch(/file\s+\.metistry\/connections\/fake\.yaml/);
  });

  it("test dials and compares: ok, then degraded once a listed tool is gone; a granted secret reaches the command", async () => {
    const dir = await withFake("test");
    const kc = fakeSecurity({ [`${ID}/metistry:secret:env_key`]: "a-plain-test-value" });
    await writeFile(join(dir, ".metistry/secrets.yaml"), `secrets:\n  env_key:\n    grants: { "connection:fake": on }\n`);
    await run(["connections", "set", "fake", "--env", "FAKE_SECRET={{ secret.env_key }}", "--instance", dir]);
    const ok = await run(["connections", "test", "fake", "--json", "--instance", dir], kc);
    expect(ok.code, ok.all).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ name: "fake", status: "ok", meta: { tools_seen: 5, listed: 5, missing: [] } });

    await run(["connections", "set", "fake", "--env", "FAKE_TOOLS=echo,env", "--instance", dir]);
    const degraded = await run(["connections", "test", "fake", "--instance", dir], kc);
    expect(degraded.code).toBe(0);
    expect(degraded.out).toMatch(/fake {2}degraded/);
    expect(degraded.out).toMatch(/no longer offers delete_issue, search_issues, secret_echo/);
  });

  it("remove deletes the file and names what still refers to it, touching none of it", async () => {
    const dir = await withFake("remove");
    await writeFile(join(dir, ".metistry/scheduled.yaml"), "syncs:\n  fake-sync:\n    connection: fake\n");
    await writeFile(join(dir, ".metistry/secrets.yaml"), `secrets:\n  env_key:\n    grants: { "connection:fake": on }\n`);
    const r = await run(["connections", "remove", "fake", "--instance", dir]);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(file(dir, "fake"))).toBe(false);
    expect(r.all).toMatch(/sync fake-sync \(scheduled\.yaml\), secret env_key's grant to connection:fake/);
    expect(readFileSync(join(dir, ".metistry/scheduled.yaml"), "utf8")).toContain("connection: fake");
  });
});

describe("metistry doctor's connection rows", () => {
  it("one row per connection, its own check — and a connection that cannot be reached is degraded, never failed", async () => {
    const dir = await instance("doctor", {
      ".metistry/connections/fake.yaml": `name: fake\ntype: mcp\nprovider: custom\nreach:\n  command:\n    command: ${JSON.stringify(NODE)}\n    args: [${JSON.stringify(FAKE)}]\ntools:\n  echo: { group: reads, mode: on }\n`,
      ".metistry/connections/gone.yaml": "name: gone\ntype: mcp\nprovider: custom\nreach: { http: { url: \"http://127.0.0.1:9/mcp\" } }\n",
    });
    const rows = await connectionRows({ instanceDir: dir, productDir: dir, env: {}, platform: "linux", uid: 501, exec: fakeSecurity().exec });
    expect(rows.map((r) => [r.kind, r.name, r.status])).toEqual([
      ["connection", "fake", "ok"],
      ["connection", "gone", "degraded"],
    ]);
    expect(rows[1]!.meta).toMatchObject({ check_status: "failed" });
    expect(rows[1]!.remediation).toMatch(/never fails the install for it/);
  });
});
