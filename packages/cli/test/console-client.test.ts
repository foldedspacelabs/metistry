// `metistry console whoami` — the local owner door, from the CLI side
// (docs/ops/auth.md). What matters here is where the token comes from,
// that it never leaves this process except as an Authorization header, and
// that a 401 says which of the two things went wrong.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consoleCall, consoleTarget, DEFAULT_CONSOLE_URL, isLoopbackConsoleUrl, renderConsoleCallError, renderWhoami, whoami } from "../src/console-client.js";
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

interface CallSeen {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  idempotencyKey: string | undefined;
  body: string | undefined;
}

/** A console answering arbitrary `<METHOD> <path>` routes for exactly one token — what `console call` is a client of. */
function fakeCallConsole(expected: string, routes: Record<string, { status?: number; body?: unknown; replayed?: boolean }> = {}) {
  const seen: CallSeen[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ method, path: u.pathname, authorization: headers.authorization, contentType: headers["content-type"], idempotencyKey: headers["idempotency-key"], body: init?.body as string | undefined });
    if (headers.authorization !== `Bearer ${expected}`) {
      return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "authentication required" } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    const route = routes[`${method} ${u.pathname}`];
    if (!route) return new Response("route not stubbed", { status: 404 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.replayed ? { "idempotency-replayed": "true" } : {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe("consoleTarget", () => {
  it("takes the URL from METISTRY_CONSOLE_URL, then METISTRY_URL, then loopback", async () => {
    const base = { platform: "linux" as const };
    expect((await consoleTarget({ ...base, env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN } })).url).toBe(DEFAULT_CONSOLE_URL);
    expect((await consoleTarget({ ...base, env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN, METISTRY_URL: "http://127.0.0.1:9090/" } })).url).toBe("http://127.0.0.1:9090");
    expect(
      (await consoleTarget({ ...base, env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN, METISTRY_URL: "http://127.0.0.1:9090", METISTRY_CONSOLE_URL: "http://127.0.0.1:8080" } })).url,
    ).toBe("http://127.0.0.1:8080");
  });

  it("falls back to the login Keychain under THIS instance's account, then the per-user one", async () => {
    const exec = fakeSecurity({ [`${INSTANCE_ID}/metistry:METISTRY_LOCAL_OWNER_TOKEN`]: TOKEN });
    const r = await consoleTarget({ env: {}, platform: "darwin", exec, instanceId: INSTANCE_ID });
    expect(r).toMatchObject({ token: TOKEN, tokenFrom: "keychain" });

    // an item that has not been migrated to the instance's account yet
    const legacy = fakeSecurity({ "metistry/metistry:METISTRY_LOCAL_OWNER_TOKEN": TOKEN });
    expect((await consoleTarget({ env: {}, platform: "darwin", exec: legacy, instanceId: INSTANCE_ID })).token).toBe(TOKEN);
  });

  it("says how to get one rather than inventing a token", async () => {
    await expect(consoleTarget({ env: {}, platform: "linux" })).rejects.toThrow(/METISTRY_LOCAL_OWNER_TOKEN is not set.*secrets sync --to env/s);
  });
});

describe("whoami", () => {
  it("sends the token as a bearer and nothing else, and reports the principal", async () => {
    const c = fakeConsole(TOKEN);
    const r = await whoami({ env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
    expect(r).toMatchObject({ principal: "user", via: "local_owner_token", management: true, url: DEFAULT_CONSOLE_URL });
    expect(c.seen[0]!.url).toBe(`${DEFAULT_CONSOLE_URL}/api/whoami`);
    expect(c.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(renderWhoami(r)).toContain("principal  user");
    expect(renderWhoami(r)).not.toContain(TOKEN);
  });

  it("turns a 401 into the two things it can actually be", async () => {
    const c = fakeConsole("a-different-token");
    await expect(whoami({ env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn })).rejects.toThrow(
      /refused the owner token.*METISTRY_TRUSTED_LOOPBACK_PROXY/s,
    );
  });

  it("redacts the token out of an unreachable-console error", async () => {
    const fetchFn = (async () => {
      throw new Error(`connect ECONNREFUSED (tried Bearer ${TOKEN})`);
    }) as unknown as typeof fetch;
    await expect(whoami({ env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn })).rejects.toThrow(/\[redacted\]/);
    await expect(whoami({ env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn })).rejects.not.toThrow(new RegExp(TOKEN));
  });
});

describe("metistry console", () => {
  it("refuses an unknown subcommand with the usage line, exit 2", async () => {
    const err: string[] = [];
    expect(await main(["console", "sign-in"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("\n")).toContain("metistry console whoami");
  });
});

describe("isLoopbackConsoleUrl", () => {
  it("is true for the addresses the local owner token is actually good for", () => {
    for (const u of ["http://127.0.0.1:8080", "http://localhost:8080", "https://localhost", "http://[::1]:8080"]) expect(isLoopbackConsoleUrl(u), u).toBe(true);
  });

  it("is false for anything else, including a malformed URL", () => {
    for (const u of ["https://metis.example.com", "http://192.168.1.5:8080", "not a url"]) expect(isLoopbackConsoleUrl(u), u).toBe(false);
  });
});

describe("consoleCall (module)", () => {
  it("refuses a non-loopback console before ever sending the token", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await expect(
      consoleCall({ method: "GET", path: "/api/whoami", env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN, METISTRY_CONSOLE_URL: "https://metis.example.com" }, platform: "linux", fetchFn }),
    ).rejects.toThrow(/is not loopback.*refuses to send it anywhere else/s);
    expect(called).toBe(false);
  });

  it("GET: the bearer, the method, the path, and a parsed JSON body", async () => {
    const c = fakeCallConsole(TOKEN, { "GET /api/whoami": { body: { principal: "user" } } });
    const r = await consoleCall({ method: "GET", path: "/api/whoami", env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
    expect(r).toMatchObject({ status: 200, body: { principal: "user" } });
    expect(c.seen[0]).toMatchObject({ method: "GET", path: "/api/whoami", authorization: `Bearer ${TOKEN}`, body: undefined });
  });

  it("POST: the body goes as-is, with a content-type, and never a GET's silence", async () => {
    const c = fakeCallConsole(TOKEN, { "POST /api/instances": { status: 201, body: { ok: true } } });
    const r = await consoleCall({ method: "POST", path: "/api/instances", body: '{"origin":"https://peer.example"}', env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
    expect(r.status).toBe(201);
    expect(c.seen[0]).toMatchObject({ method: "POST", contentType: "application/json", body: '{"origin":"https://peer.example"}' });
  });

  it("a non-JSON or empty response is not swallowed", async () => {
    const c = fakeCallConsole(TOKEN, { "GET /api/text": { body: undefined } });
    const empty = await consoleCall({ method: "GET", path: "/api/text", env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
    expect(empty).toMatchObject({ status: 200, body: null, raw: "" });
  });

  it("every response carries replayed: false when the console never said otherwise", async () => {
    const c = fakeCallConsole(TOKEN, { "GET /api/whoami": { body: { principal: "user" } } });
    const r = await consoleCall({ method: "GET", path: "/api/whoami", env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
    expect(r.replayed).toBe(false);
  });

  describe("Idempotency-Key", () => {
    it("sends the trimmed key as a header, and reports a reply header of idempotency-replayed", async () => {
      const c = fakeCallConsole(TOKEN, { "POST /capture": { status: 201, body: { id: 42 }, replayed: true } });
      const r = await consoleCall({
        method: "POST",
        path: "/capture",
        body: "{}",
        idempotencyKey: "  a-key-with-padding  ",
        env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN },
        platform: "linux",
        fetchFn: c.fetchFn,
      });
      expect(c.seen[0]?.idempotencyKey).toBe("a-key-with-padding");
      expect(r.replayed).toBe(true);
    });

    it("sends no Idempotency-Key header at all when none was given", async () => {
      const c = fakeCallConsole(TOKEN, { "POST /capture": { status: 201, body: { id: 42 } } });
      await consoleCall({ method: "POST", path: "/capture", body: "{}", env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn });
      expect(c.seen[0]?.idempotencyKey).toBeUndefined();
    });

    it("refuses an empty or all-whitespace key before ever sending the token", async () => {
      let called = false;
      const fetchFn = (async () => {
        called = true;
        throw new Error("must not be called");
      }) as unknown as typeof fetch;
      for (const bad of ["", "   "]) {
        await expect(
          consoleCall({ method: "POST", path: "/capture", idempotencyKey: bad, env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn }),
        ).rejects.toThrow(/--idempotency-key must be non-empty and at most 200 characters/);
      }
      expect(called).toBe(false);
    });

    it("refuses a key over 200 characters, trimmed", async () => {
      const fetchFn = (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch;
      await expect(
        consoleCall({ method: "POST", path: "/capture", idempotencyKey: "x".repeat(201), env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn }),
      ).rejects.toThrow(/at most 200 characters/);
      // exactly 200 after trimming is fine — padding around it does not count against the limit
      const c = fakeCallConsole(TOKEN, { "POST /capture": { status: 201, body: { id: 42 } } });
      await expect(
        consoleCall({ method: "POST", path: "/capture", idempotencyKey: `  ${"x".repeat(200)}  `, env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", fetchFn: c.fetchFn }),
      ).resolves.toMatchObject({ status: 201 });
    });
  });
});

describe("renderConsoleCallError", () => {
  it("names the code, the message, and the field when the envelope carries one", () => {
    expect(renderConsoleCallError({ status: 400, body: { error: { code: "invalid_request", message: "since is not in the form this server mints", field: "since" } }, raw: "" })).toBe(
      "HTTP 400 — invalid_request — since is not in the form this server mints — (field: since)",
    );
  });

  it("falls back to the bare status when the body carries no envelope", () => {
    expect(renderConsoleCallError({ status: 502, body: "bad gateway", raw: "bad gateway" })).toBe("HTTP 502");
  });
});

describe("metistry console call (CLI)", () => {
  afterEach(() => {
    delete process.env.METISTRY_LOCAL_OWNER_TOKEN;
    delete process.env.METISTRY_CONSOLE_URL;
  });

  it("usage errors — no method, no path, or a path that is not absolute — exit 2", async () => {
    const err: string[] = [];
    const run = (args: string[]) => main(["console", "call", ...args], { out: () => {}, err: (s) => err.push(s) });
    expect(await run([])).toBe(2);
    expect(await run(["GET"])).toBe(2);
    expect(await run(["GET", "api/whoami"])).toBe(2);
    expect(err.join("\n")).toContain("metistry console call <METHOD> <path>");
  });

  it("--json prints exactly the console's own bytes; without it, the same body pretty-printed", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const c = fakeCallConsole(TOKEN, { "GET /api/whoami": { body: { principal: "user" } } });

    const jsonOut: string[] = [];
    expect(await main(["console", "call", "GET", "/api/whoami", "--json"], { out: (s) => jsonOut.push(s), err: () => {}, fetchFn: c.fetchFn })).toBe(0);
    expect(jsonOut).toHaveLength(1);
    expect(jsonOut[0]).toBe('{"principal":"user"}');

    const plainOut: string[] = [];
    expect(await main(["console", "call", "GET", "/api/whoami"], { out: (s) => plainOut.push(s), err: () => {}, fetchFn: c.fetchFn })).toBe(0);
    expect(plainOut[0]).toBe(JSON.stringify({ principal: "user" }, null, 2));
  });

  it("--body @<file>: the file's exact bytes go as the request body", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const dir = await mkdtemp(join(tmpdir(), "metistry-console-call-"));
    const file = join(dir, "body.json");
    await writeFile(file, '{"origin":"https://peer.example"}');
    const c = fakeCallConsole(TOKEN, { "POST /api/instances": { status: 201, body: { action: "added" } } });

    const out: string[] = [];
    const code = await main(["console", "call", "POST", "/api/instances", "--body", `@${file}`, "--json"], { out: (s) => out.push(s), err: () => {}, fetchFn: c.fetchFn });
    expect(code).toBe(0);
    expect(c.seen[0]?.body).toBe('{"origin":"https://peer.example"}');
    expect(JSON.parse(out.join("\n"))).toEqual({ action: "added" });
  });

  it("--body -: reads the injected stdin, not a file", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const c = fakeCallConsole(TOKEN, { "POST /api/instances": { status: 201, body: { action: "added" } } });
    const code = await main(["console", "call", "POST", "/api/instances", "--body", "-", "--json"], {
      out: () => {},
      err: () => {},
      fetchFn: c.fetchFn,
      readStdin: async () => '{"origin":"https://stdin.example"}',
    });
    expect(code).toBe(0);
    expect(c.seen[0]?.body).toBe('{"origin":"https://stdin.example"}');
  });

  it("a >=400 answer exits non-zero and names the envelope's code and message on stderr, nothing on stdout", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const c = fakeCallConsole(TOKEN, { "GET /api/instances/nonesuch": { status: 404, body: { error: { code: "not_found", message: "not found" } } } });
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["console", "call", "GET", "/api/instances/nonesuch"], { out: (s) => out.push(s), err: (s) => err.push(s), fetchFn: c.fetchFn });
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("not_found");
    expect(err.join("\n")).toContain("not found");
  });

  it("refuses a non-loopback console before sending the token, and prints why", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    process.env.METISTRY_CONSOLE_URL = "https://metis.example.com";
    let called = false;
    const fetchFn = (async () => {
      called = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const err: string[] = [];
    const code = await main(["console", "call", "GET", "/api/whoami"], { out: () => {}, err: (s) => err.push(s), fetchFn });
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(err.join("\n")).toMatch(/is not loopback.*refuses to send it anywhere else/s);
  });

  it("--idempotency-key sends the header", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const c = fakeCallConsole(TOKEN, { "POST /capture": { status: 201, body: { id: 42 } } });
    const code = await main(["console", "call", "POST", "/capture", "--body", "-", "--idempotency-key", "a-fixed-key", "--json"], {
      out: () => {},
      err: () => {},
      fetchFn: c.fetchFn,
      readStdin: async () => "{}",
    });
    expect(code).toBe(0);
    expect(c.seen[0]?.idempotencyKey).toBe("a-fixed-key");
  });

  it("refuses an empty or over-long --idempotency-key, exit 1, before sending the token", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    let called = false;
    const fetchFn = (async () => {
      called = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    for (const bad of ["", " ", "x".repeat(201)]) {
      const err: string[] = [];
      const code = await main(["console", "call", "POST", "/capture", "--idempotency-key", bad], { out: () => {}, err: (s) => err.push(s), fetchFn });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("--idempotency-key must be non-empty and at most 200 characters");
    }
    expect(called).toBe(false);
  });

  it("a replayed response folds replayed: true into --json output, verbatim otherwise", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const c = fakeCallConsole(TOKEN, { "POST /capture": { status: 201, body: { id: 42, path: "Inbox/note.md" }, replayed: true } });

    const jsonOut: string[] = [];
    const jsonErr: string[] = [];
    const jsonCode = await main(["console", "call", "POST", "/capture", "--body", "-", "--idempotency-key", "same-key", "--json"], {
      out: (s) => jsonOut.push(s),
      err: (s) => jsonErr.push(s),
      fetchFn: c.fetchFn,
      readStdin: async () => "{}",
    });
    expect(jsonCode).toBe(0);
    expect(JSON.parse(jsonOut.join(""))).toEqual({ id: 42, path: "Inbox/note.md", replayed: true });

    const plainOut: string[] = [];
    const plainErr: string[] = [];
    const plainCode = await main(["console", "call", "POST", "/capture", "--body", "-", "--idempotency-key", "same-key"], {
      out: (s) => plainOut.push(s),
      err: (s) => plainErr.push(s),
      fetchFn: c.fetchFn,
      readStdin: async () => "{}",
    });
    expect(plainCode).toBe(0);
    // the body prints exactly as it always did — the note is on stderr, not folded in
    expect(JSON.parse(plainOut.join(""))).toEqual({ id: 42, path: "Inbox/note.md" });
    expect(plainErr.join("\n")).toContain("idempotency-replayed");
  });

  it("a non-replayed response carries no note and no extra field", async () => {
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    const c = fakeCallConsole(TOKEN, { "POST /capture": { status: 201, body: { id: 43 } } });
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["console", "call", "POST", "/capture", "--body", "-", "--idempotency-key", "another-key", "--json"], {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      fetchFn: c.fetchFn,
      readStdin: async () => "{}",
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ id: 43 });
    expect(err).toHaveLength(0);
  });
});
