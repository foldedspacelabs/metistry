// `metistry connections` for Google Calendar (T4-14) — add, then sign in with
// Google through the one OAuth door, driven through `main()` as the Mac app
// drives it, against a fake `security` (never the login Keychain), scratch
// instances under the OS temp dir, and the fixture Google on loopback
// (packages/connections/test/google-server.ts — never Google).
//
// The product's seed ships no client id until the maintainer's client exists
// (§3.4), so the owner here brings their own: which is also the ticket's
// **a bring-your-own client id overrides the shipped one**, from the owner's
// side (packages/connections/test/google-calendar.test.ts holds it with a
// shipped id in place).

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec, ExecOptions } from "../src/exec.js";
import { main } from "../src/main.js";
import { decodeSecurity } from "./fake-security.js";
import { fakeGoogle, type FakeGoogle } from "../../connections/test/google-server.js";

const ID = "11111111-2222-4333-8444-555555555555";
const CLIENT = "5678-own.apps.googleusercontent.com";

/** A Keychain in a Map keyed `<account>/<service>`; `open` is the owner's browser, driven by `browser`. */
function fakeMac(browser?: (url: string) => Promise<void>) {
  const store = new Map<string, string>();
  const opened: string[] = [];
  const exec: Exec = async (cmd, argv, opts: ExecOptions = {}) => {
    if (cmd === "open") {
      opened.push(argv[0]!);
      await browser?.(argv[0]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd !== "security") return cmd === "launchctl" ? { code: 113, stdout: "", stderr: "not loaded" } : { code: 127, stdout: "", stderr: `${cmd}: not faked` };
    const { args, value } = decodeSecurity(argv, opts);
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      store.set(at, value!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, opened };
}

async function instance(label: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-connections-google-${label}-`));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\ninstance_id: "${ID}"\n`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

async function run(argv: string[], mac = fakeMac(), dialFetch?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), exec: mac.exec, platform: "darwin", uid: 501, ...(dialFetch ? { dialFetch } : {}) });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}

const yamlOf = (dir: string, rel: string) => parseYaml(readFileSync(join(dir, rel), "utf8")) as Record<string, any>;

const clientPolicy = `secrets:\n  google_client_id: { hosts: [accounts.google.com, oauth2.googleapis.com], grants: { "connection:google": on } }\n`;
const add = (dir: string, url = "https://www.googleapis.com/calendar/v3/") =>
  run(["connections", "add", "google", "--type", "calendar", "--provider", "google-calendar", "--url", url, "--auth", "oauth", "--client-id-secret", "google_client_id", "--instance", dir]);

describe("`metistry connections add` — a Google Calendar connection", () => {
  it("writes the sign-in's references and the sync's first connection, dials nothing, and says to sign in next", async () => {
    const dir = await instance("add", { ".metistry/secrets.yaml": clientPolicy });
    const r = await add(dir);
    expect(r.code, r.all).toBe(0);
    expect(yamlOf(dir, ".metistry/connections/google.yaml")).toMatchObject({
      type: "calendar",
      provider: "google-calendar",
      reach: { http: { url: "https://www.googleapis.com/calendar/v3/", auth: { scheme: "oauth" } } },
      config: { google: { token: "{{ secret.google_oauth_token }}", client_id: "{{ secret.google_client_id }}" } },
      secrets: ["google_oauth_token", "google_client_id"],
    });
    expect(yamlOf(dir, ".metistry/scheduled.yaml").syncs["google-calendar"]).toMatchObject({ connection: "google" });
    expect(r.all).toMatch(/not dialled: sign in first/);
    expect(r.all).toMatch(/next: `metistry connections authorize google`/);
  });

  it("refuses one pointed anywhere but the Calendar API — nothing is written", async () => {
    const dir = await instance("add-elsewhere", { ".metistry/secrets.yaml": clientPolicy });
    const r = await add(dir, "https://calendar.example.test/calendar/v3/");
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/reached at https:\/\/www\.googleapis\.com\/calendar\/v3\/ and nowhere else/);
    expect(() => readFileSync(join(dir, ".metistry/connections/google.yaml"))).toThrow();
  });
});

describe("`metistry connections authorize google` — sign in with Google through Metistry's own door", () => {
  let g: FakeGoogle | undefined;
  afterEach(async () => {
    await g?.close();
    g = undefined;
  });

  it("the owner's own client at accounts.google.com, the refresh token kept (never printed), its policy exactly the token endpoint and the Calendar API", async () => {
    g = await fakeGoogle({ clients: [CLIENT] });
    const dir = await instance("authorize", { ".metistry/secrets.yaml": clientPolicy });
    expect((await add(dir)).code).toBe(0);
    const google = g;
    const mac = fakeMac((url) => google.browse(url).then(() => undefined));
    mac.store.set(`${ID}/metistry:secret:google_client_id`, CLIENT);
    const r = await run(["connections", "authorize", "google", "--instance", dir], mac, g.routeTo());
    expect(r.code, r.all).toBe(0);
    expect(mac.opened.map((u) => new URL(u).origin)).toEqual(["https://accounts.google.com"]);
    expect(g.auth.authorizeRequests[0]!.get("client_id")).toBe(CLIENT);
    expect(g.auth.authorizeRequests[0]!.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(r.all).toMatch(/signing in google at accounts\.google\.com with your own client/);
    // Metistry's words about its own unverified client are not said over the owner's client
    expect(r.all).not.toMatch(/before you sign in/);
    expect(mac.store.get(`${ID}/metistry:secret:google_oauth_token`)).toBe(g.auth.issuedRefresh[0]);
    expect(r.all).not.toContain(g.auth.issuedRefresh[0]!);
    expect(yamlOf(dir, ".metistry/secrets.yaml").secrets.google_oauth_token).toEqual({ hosts: ["oauth2.googleapis.com", "www.googleapis.com"], grants: { "connection:google": "on" } });
    expect(g.api).toEqual([]); // signing in reads no calendar
  });
});
