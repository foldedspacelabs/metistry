// `metistry console whoami` — the local owner door, from the CLI side
// (docs/ops/auth.md). What matters here is where the token comes from,
// that it never leaves this process except as an Authorization header, and
// that a 401 says which of the two things went wrong.
import { describe, expect, it } from "vitest";
import { consoleTarget, DEFAULT_CONSOLE_URL, renderWhoami, whoami } from "../src/console-client.js";
import type { Exec } from "../src/exec.js";
import { main } from "../src/main.js";

const TOKEN = "owner-token-never-printed";
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";

/** A login Keychain in a Map, keyed by (account, service) the way the real one is. */
function fakeSecurity(seed: Record<string, string> = {}): Exec {
  const store = new Map(Object.entries(seed));
  return async (cmd, args) => {
    if (cmd !== "security" || args[0] !== "find-generic-password") return { code: 1, stdout: "", stderr: "unexpected" };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (!store.has(at)) return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    return { code: 0, stdout: `${store.get(at)}\n`, stderr: "" };
  };
}

/** A console that answers /api/whoami for exactly one token. */
function fakeConsole(expected: string, body: unknown = { principal: "user", via: "local_owner_token", management: true, origin: "https://metis.example" }) {
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    seen.push({ url: String(url), authorization });
    const ok = authorization === `Bearer ${expected}`;
    return new Response(JSON.stringify(ok ? body : { error: { code: "unauthenticated", message: "authentication required" } }), {
      status: ok ? 200 : 401,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe("consoleTarget", () => {
  it("takes the URL from METISTRY_CONSOLE_URL, then METISTRY_URL, then loopback", async () => {
    const base = { platform: "linux" as const };
    expect((await consoleTarget({ ...base, env: { METISTRY_OWNER_TOKEN: TOKEN } })).url).toBe(DEFAULT_CONSOLE_URL);
    expect((await consoleTarget({ ...base, env: { METISTRY_OWNER_TOKEN: TOKEN, METISTRY_URL: "http://127.0.0.1:9090/" } })).url).toBe("http://127.0.0.1:9090");
    expect(
      (await consoleTarget({ ...base, env: { METISTRY_OWNER_TOKEN: TOKEN, METISTRY_URL: "http://127.0.0.1:9090", METISTRY_CONSOLE_URL: "http://127.0.0.1:8080" } })).url,
    ).toBe("http://127.0.0.1:8080");
  });

  it("falls back to the login Keychain under THIS instance's account, then the per-user one", async () => {
    const exec = fakeSecurity({ [`${INSTANCE_ID}/metistry:METISTRY_OWNER_TOKEN`]: TOKEN });
    const r = await consoleTarget({ env: {}, platform: "darwin", exec, instanceId: INSTANCE_ID });
    expect(r).toMatchObject({ token: TOKEN, tokenFrom: "keychain" });

    // an item that has not been migrated to the instance's account yet
    const legacy = fakeSecurity({ "metistry/metistry:METISTRY_OWNER_TOKEN": TOKEN });
    expect((await consoleTarget({ env: {}, platform: "darwin", exec: legacy, instanceId: INSTANCE_ID })).token).toBe(TOKEN);
  });

  it("says how to get one rather than inventing a token", async () => {
    await expect(consoleTarget({ env: {}, platform: "linux" })).rejects.toThrow(/METISTRY_OWNER_TOKEN is not set.*secrets sync --to env/s);
  });
});

describe("whoami", () => {
  it("sends the token as a bearer and nothing else, and reports the principal", async () => {
    const c = fakeConsole(TOKEN);
    const r = await whoami({ env: { METISTRY_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
    expect(r).toMatchObject({ principal: "user", via: "local_owner_token", management: true, url: DEFAULT_CONSOLE_URL });
    expect(c.seen[0]!.url).toBe(`${DEFAULT_CONSOLE_URL}/api/whoami`);
    expect(c.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(renderWhoami(r)).toContain("principal  user");
    expect(renderWhoami(r)).not.toContain(TOKEN);
  });

  it("turns a 401 into the two things it can actually be", async () => {
    const c = fakeConsole("a-different-token");
    await expect(whoami({ env: { METISTRY_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn })).rejects.toThrow(
      /refused the owner token.*METISTRY_TRUSTED_LOOPBACK_PROXY/s,
    );
  });

  it("redacts the token out of an unreachable-console error", async () => {
    const fetchFn = (async () => {
      throw new Error(`connect ECONNREFUSED (tried Bearer ${TOKEN})`);
    }) as unknown as typeof fetch;
    await expect(whoami({ env: { METISTRY_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn })).rejects.toThrow(/\[redacted\]/);
    await expect(whoami({ env: { METISTRY_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn })).rejects.not.toThrow(new RegExp(TOKEN));
  });
});

describe("metistry console", () => {
  it("refuses an unknown subcommand with the usage line, exit 2", async () => {
    const err: string[] = [];
    expect(await main(["console", "sign-in"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("\n")).toContain("metistry console whoami");
  });
});
