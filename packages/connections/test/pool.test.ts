// The pool's misuse tests (T4-8a). Bold, the ticket's own:
//
//   **an unlisted tool is refused before dialling** — no child is started and
//   no request is sent, for a tool the file does not name, one at Never, and
//   one at Ask First with no approval;
//   **the agent's bearer is never forwarded upstream** — not in a header, not
//   in a body, not in a stdio child's environment, and a call whose
//   arguments carry it is refused before dialling.
//
// And the rest of the door: a secret only to its listed hosts and only when
// granted, redaction on the way back, the origin pin, pooling and redial.

import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EgressRefused } from "@foldedspacelabs/metistry-core";
import { ConnectionPool, ConnectionRefused, type ConnectionCatalog, type PoolEvent } from "../src/index.js";
import { FAKE_STDIO, catalogOf, fakeHttpMcp, secretsWith, type FakeHttp } from "./helpers.js";

/** The agent's own bearer, as the console would hold it for the caller. */
const AGENT_BEARER = "agent-bearer-" + "Zq7Xw2Lp9Kd4Rt6Ym1Nv8Bc3";
/** A service token's value, built so no scanner mistakes this file for a leak. */
const SERVICE_TOKEN = "svc_" + "Hq2Jw9Lz4Xc7Vb1Nm6Kd3Rt8";
const ENV_SECRET = "env_" + "Pa5Sd8Fg1Hj4Kl7Zx2Cv9Bn6";

let scratch: string;
const pools: ConnectionPool[] = [];
function pool(catalog: ConnectionCatalog | (() => ConnectionCatalog), secrets: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof ConnectionPool>[0]> = {}): ConnectionPool {
  const store = secretsWith(secrets);
  const p = new ConnectionPool({
    // a relative cwd resolves against the catalog's baseDir: the scratch dir, so
    // markers are named relatively (an OS temp path's random segment reads as a key)
    catalog: async () => ({ baseDir: scratch, ...(typeof catalog === "function" ? catalog() : catalog) }),
    secrets: { value: async (n) => (await store).value(n) },
    connectTimeoutMs: 20_000,
    ...extra,
  });
  pools.push(p);
  return p;
}

function stdioConnection(name: string, opts: { tools?: Record<string, { group: string; mode: string }>; env?: Record<string, string>; secrets?: string[] } = {}) {
  return {
    name,
    type: "mcp",
    provider: "custom",
    reach: { command: { command: process.execPath, args: [FAKE_STDIO], cwd: ".", env: opts.env ?? {} } },
    secrets: opts.secrets ?? [],
    tools: opts.tools ?? { echo: { group: "reads", mode: "on" }, env: { group: "reads", mode: "on" }, secret_echo: { group: "reads", mode: "on" } },
  };
}

function httpConnection(name: string, url: string, opts: { tools?: Record<string, { group: string; mode: string }>; auth?: unknown; secrets?: string[]; headers?: Record<string, string> } = {}) {
  return {
    name,
    type: "mcp",
    provider: "custom",
    reach: { http: { url, ...(opts.auth ? { auth: opts.auth } : {}), ...(opts.headers ? { headers: opts.headers } : {}) } },
    secrets: opts.secrets ?? [],
    tools: opts.tools ?? { echo: { group: "reads", mode: "on" }, echo_auth: { group: "reads", mode: "on" } },
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "metistry-connections-pool-"));
});

afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});

describe("**an unlisted tool is refused before dialling**", () => {
  it("stdio: a tool the file does not name, one at Never and one at Ask First — the command is never started", async () => {
    const marker = `marker-${Date.now()}`;
    const conn = stdioConnection("fake", {
      env: { FAKE_MARKER: marker },
      tools: { echo: { group: "reads", mode: "on" }, delete_issue: { group: "changes", mode: "off" }, search_issues: { group: "reads", mode: "ask" } },
    });
    const p = pool(catalogOf([conn]));
    for (const [tool, code] of [
      ["env", "tool_not_listed"],
      ["delete_issue", "tool_off"],
      ["search_issues", "needs_approval"],
    ] as const) {
      const err = await p.call({ connection: "fake", tool, args: {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectionRefused);
      expect((err as ConnectionRefused).code).toBe(code);
    }
    expect(existsSync(join(scratch, marker))).toBe(false);
    expect(p.size).toBe(0);
    // the control: a listed tool does start it, so the marker is what it claims to be
    await p.call({ connection: "fake", tool: "echo", args: {} });
    expect(existsSync(join(scratch, marker))).toBe(true);
  });

  it("http: the upstream is sent nothing — not even initialize", async () => {
    const fake = await fakeHttpMcp();
    try {
      const conn = httpConnection("remote", fake.url, { tools: { echo: { group: "reads", mode: "on" }, echo_auth: { group: "changes", mode: "ask" } } });
      const p = pool(catalogOf([conn]));
      await expect(p.call({ connection: "remote", tool: "search_issues", args: {} })).rejects.toMatchObject({ code: "tool_not_listed" });
      await expect(p.call({ connection: "remote", tool: "echo_auth", args: {} })).rejects.toMatchObject({ code: "needs_approval" });
      await expect(p.call({ connection: "remote", tool: "__proto__", args: {} })).rejects.toMatchObject({ code: "tool_not_listed" });
      expect(fake.requests).toEqual([]);
      // and the listed one does reach it
      const ok = await p.call({ connection: "remote", tool: "echo", args: { q: 1 } });
      expect(ok.isError).toBe(false);
      expect(fake.requests.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  });

  it("an Ask First tool runs once the caller holds the owner's approval of the call", async () => {
    const p = pool(catalogOf([stdioConnection("fake", { tools: { echo: { group: "changes", mode: "ask" } } })]));
    const r = await p.call({ connection: "fake", tool: "echo", args: { x: 1 }, approved: true });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ tool: "echo", args: { x: 1 } });
  });

  it("a connection that is not ready, or is not known, is refused before dialling", async () => {
    const p = pool(catalogOf([{ ...stdioConnection("fake"), provider: "not-installed" }]));
    await expect(p.call({ connection: "fake", tool: "echo", args: {} })).rejects.toMatchObject({ code: "not_ready" });
    await expect(p.call({ connection: "nope", tool: "echo", args: {} })).rejects.toMatchObject({ code: "unknown_connection" });
    expect(p.size).toBe(0);
  });
});

describe("**the agent's bearer is never forwarded upstream**", () => {
  let fake: FakeHttp;
  beforeAll(async () => {
    fake = await fakeHttpMcp();
  });
  afterAll(async () => {
    await fake.close();
  });

  it("http: no request carries it — only the connection's own credential, filled at egress", async () => {
    const conn = httpConnection("remote", fake.url, { auth: { scheme: "bearer", secret: "svc_token" }, secrets: ["svc_token"] });
    const secrets = `secrets:\n  svc_token:\n    hosts: ["${fake.host}"]\n    grants: { "connection:remote": on }\n`;
    const p = pool(catalogOf([conn], { secrets }), { svc_token: SERVICE_TOKEN });
    const before = fake.requests.length;
    const r = await p.call({ connection: "remote", tool: "echo", args: { q: "issues" }, caller: { bearer: AGENT_BEARER } });
    expect(r.isError).toBe(false);
    expect(r.secrets).toEqual(["svc_token"]);
    const sent = fake.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(JSON.stringify(req)).not.toContain(AGENT_BEARER);
      expect(req.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    }
  });

  it("a call whose arguments carry the caller's bearer is refused before dialling", async () => {
    const before = fake.requests.length;
    const p = pool(catalogOf([httpConnection("remote", fake.url)]));
    const err = await p.call({ connection: "remote", tool: "echo", args: { note: `use ${AGENT_BEARER}` }, caller: { bearer: AGENT_BEARER } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "caller_credential" });
    expect(String((err as Error).message)).not.toContain(AGENT_BEARER);
    expect(fake.requests.length).toBe(before);
  });

  it("stdio: the child's environment is the file's and the SDK's safe six — nothing of this process's, no bearer, no install token", async () => {
    const planted = {
      METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-class-" + "Tk3Lm8Np1Qr6",
      METISTRY_CONSOLE_TOKEN: "console-" + "Wx4Yz9Ab2Cd7",
      METISTRY_DB_PASSWORD: "db-" + "Ef5Gh0Ij3Kl8",
      AGENT_BEARER,
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(planted)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const p = pool(catalogOf([stdioConnection("fake", { env: { FAKE_MODE: "plain" } })]));
      const r = await p.call({ connection: "fake", tool: "env", args: {}, caller: { bearer: AGENT_BEARER } });
      const text = (r.content[0] as { text: string }).text;
      const childEnv = JSON.parse(text) as Record<string, string>;
      for (const [k, v] of Object.entries(planted)) {
        expect(childEnv[k]).toBeUndefined();
        expect(text).not.toContain(v);
      }
      expect(Object.keys(childEnv).filter((k) => k.startsWith("METISTRY_"))).toEqual([]);
      expect(childEnv.FAKE_MODE).toBe("plain");
      const allowed = new Set(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "FAKE_MODE", "__CF_USER_TEXT_ENCODING"]);
      expect(Object.keys(childEnv).filter((k) => !allowed.has(k))).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("secrets: only to listed hosts, only when granted, redacted on the way back", () => {
  it("http: a secret whose Sent-only-to list lacks the host is refused at the door — nothing is sent", async () => {
    const fake = await fakeHttpMcp();
    try {
      const conn = httpConnection("remote", fake.url, { auth: { scheme: "bearer", secret: "svc_token" }, secrets: ["svc_token"] });
      const secrets = `secrets:\n  svc_token:\n    hosts: [api.github.com]\n    grants: { "connection:remote": on }\n`;
      const p = pool(catalogOf([conn], { secrets }), { svc_token: SERVICE_TOKEN });
      const err = await p.call({ connection: "remote", tool: "echo", args: {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EgressRefused);
      expect((err as EgressRefused).code).toBe("host_not_listed");
      expect(String((err as Error).message)).not.toContain(SERVICE_TOKEN);
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("http: a secret not granted to the connection is refused at the door", async () => {
    const fake = await fakeHttpMcp();
    try {
      const conn = httpConnection("remote", fake.url, { auth: { scheme: "api_key", header: "X-Api-Key", secret: "svc_token" }, secrets: ["svc_token"] });
      const secrets = `secrets:\n  svc_token:\n    hosts: ["${fake.host}"]\n    grants: { "connection:other": on }\n`;
      const p = pool(catalogOf([conn], { secrets }), { svc_token: SERVICE_TOKEN });
      await expect(p.call({ connection: "remote", tool: "echo", args: {} })).rejects.toMatchObject({ code: "not_granted" });
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("http: a value the server echoes back is redacted before the caller sees it", async () => {
    const fake = await fakeHttpMcp();
    try {
      const conn = httpConnection("remote", fake.url, { auth: { scheme: "bearer", secret: "svc_token" }, secrets: ["svc_token"] });
      const secrets = `secrets:\n  svc_token:\n    hosts: ["${fake.host}"]\n    grants: { "connection:remote": on }\n`;
      const p = pool(catalogOf([conn], { secrets }), { svc_token: SERVICE_TOKEN });
      const r = await p.call({ connection: "remote", tool: "echo_auth", args: {} });
      const text = JSON.stringify(r.content);
      expect(text).not.toContain(SERVICE_TOKEN);
      expect(text).toContain("***REDACTED secret.svc_token***");
    } finally {
      await fake.close();
    }
  });

  it("stdio: a granted secret is given to the command's environment, and redacted when it comes back", async () => {
    const conn = stdioConnection("fake", { env: { FAKE_SECRET: "{{ secret.env_key }}" }, secrets: ["env_key"] });
    const secrets = `secrets:\n  env_key:\n    grants: { "connection:fake": on }\n`;
    const p = pool(catalogOf([conn], { secrets }), { env_key: ENV_SECRET });
    const r = await p.call({ connection: "fake", tool: "secret_echo", args: {} });
    expect(JSON.stringify(r.content)).not.toContain(ENV_SECRET);
    expect(JSON.stringify(r.content)).toContain("***REDACTED secret.env_key***");
    expect(r.secrets).toEqual(["env_key"]);
  });

  it("stdio: a secret not granted, or granted Ask First, never reaches a spawned command", async () => {
    for (const mode of ["off", "ask"]) {
      const marker = `marker-grant-${mode}-${Date.now()}`;
      const conn = stdioConnection("fake", { env: { FAKE_SECRET: "{{ secret.env_key }}", FAKE_MARKER: marker }, secrets: ["env_key"] });
      const secrets = `secrets:\n  env_key:\n    grants: { "connection:fake": ${mode} }\n`;
      const p = pool(catalogOf([conn], { secrets }), { env_key: ENV_SECRET });
      await expect(p.call({ connection: "fake", tool: "echo", args: {} })).rejects.toMatchObject({ code: "secret" });
      expect(existsSync(join(scratch, marker))).toBe(false);
    }
  });

  it("stdio: a secret with no item in this instance is refused naming it, and nothing starts", async () => {
    const marker = `marker-missing-${Date.now()}`;
    const conn = stdioConnection("fake", { env: { FAKE_SECRET: "{{ secret.env_key }}", FAKE_MARKER: marker }, secrets: ["env_key"] });
    const p = pool(catalogOf([conn], { secrets: `secrets:\n  env_key:\n    grants: { "connection:fake": on }\n` }));
    const err = await p.call({ connection: "fake", tool: "echo", args: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "secret" });
    expect(String((err as Error).message)).toMatch(/no item in this instance for \{\{ secret\.env_key \}\}/);
    expect(existsSync(join(scratch, marker))).toBe(false);
  });
});

describe("somewhere else: the origin pin", () => {
  it("a redirect is not followed — the connection goes to its own URL and nowhere else", async () => {
    const elsewhere = await fakeHttpMcp();
    const fake = await fakeHttpMcp({ redirectTo: elsewhere.url });
    try {
      const p = pool(catalogOf([httpConnection("remote", fake.url)]));
      await expect(p.call({ connection: "remote", tool: "echo", args: {} })).rejects.toMatchObject({ code: "other_host" });
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await fake.close();
      await elsewhere.close();
    }
  });

  it("a runs_on that names the other place is refused before anything starts", async () => {
    const conn = stdioConnection("fake");
    (conn.reach.command as Record<string, unknown>).runs_on = "container";
    const p = pool(catalogOf([conn]));
    await expect(p.call({ connection: "fake", tool: "echo", args: {} })).rejects.toMatchObject({ code: "runs_elsewhere" });
  });
});

describe("the pool", () => {
  it("one child serves many calls; an edit to the file redials; close() ends it", async () => {
    let catalog = catalogOf([stdioConnection("fake", { env: { FAKE_MODE: "a" } })]);
    const events: PoolEvent[] = [];
    const p = pool(() => catalog, {}, { onEvent: (e) => void events.push(e) });
    const pidOf = async () => JSON.parse(((await p.call({ connection: "fake", tool: "echo", args: {} })).content[0] as { text: string }).text).pid as number;
    const first = await pidOf();
    expect(await pidOf()).toBe(first);
    expect(p.size).toBe(1);
    catalog = catalogOf([stdioConnection("fake", { env: { FAKE_MODE: "b" } })]);
    const second = await pidOf();
    expect(second).not.toBe(first);
    expect(alive(first)).toBe(false);
    await p.close();
    expect(alive(second)).toBe(false);
    expect(events.filter((e) => e.kind === "connection_call").every((e) => e.ok && e.connection === "fake" && e.tool === "echo")).toBe(true);
  });

  it("concurrent first calls share one child; an idle connection is closed", async () => {
    const p = pool(catalogOf([stdioConnection("fake")]), {}, { idleMs: 150 });
    const pids = await Promise.all(
      [1, 2, 3, 4].map(async () => JSON.parse(((await p.call({ connection: "fake", tool: "echo", args: {} })).content[0] as { text: string }).text).pid as number),
    );
    expect(new Set(pids).size).toBe(1);
    expect(p.size).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(p.size).toBe(0);
    expect(alive(pids[0]!)).toBe(false);
  });

  it("tools() offers only what is listed and not Never, with the upstream's schema", async () => {
    const p = pool(catalogOf([stdioConnection("fake", { tools: { echo: { group: "reads", mode: "on" }, delete_issue: { group: "changes", mode: "off" }, search_issues: { group: "reads", mode: "ask" }, gone: { group: "reads", mode: "on" } } })]));
    const tools = await p.tools("fake");
    expect(tools.map((t) => [t.name, t.group, t.mode])).toEqual([
      ["echo", "reads", "on"],
      ["search_issues", "reads", "ask"],
    ]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object" });
  });

  it("a variable fills the plan; a missing one refuses before dialling", async () => {
    const marker = `marker-var-${Date.now()}`;
    const conn = stdioConnection("fake", { env: { FAKE_MODE: "{{ variable.team_name }}", FAKE_MARKER: marker } });
    const withVar = { ...catalogOf([{ ...conn, variables: ["team_name"] }]), variables: { ok: true as const, file: { variables: { team_name: "Platform" } } } };
    const p = pool(withVar);
    const r = await p.call({ connection: "fake", tool: "env", args: {} });
    expect(JSON.parse((r.content[0] as { text: string }).text).FAKE_MODE).toBe("Platform");

    const marker2 = `marker-var2-${Date.now()}`;
    const q = pool(catalogOf([{ ...stdioConnection("other", { env: { FAKE_MODE: "{{ variable.team_name }}", FAKE_MARKER: marker2 } }), variables: ["team_name"] }]));
    await expect(q.call({ connection: "other", tool: "echo", args: {} })).rejects.toMatchObject({ code: "variable" });
    expect(existsSync(join(scratch, marker2))).toBe(false);
  });

  it("a command that is not there fails with ENOENT, and the pool holds nothing", async () => {
    const conn = { ...stdioConnection("fake"), reach: { command: { command: "metistry-test-no-such-command" } } };
    const p = pool(catalogOf([conn]));
    const err = await p.call({ connection: "fake", tool: "echo", args: {} }).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(p.size).toBe(0);
  });

  it("a closed pool refuses", async () => {
    const p = pool(catalogOf([stdioConnection("fake")]));
    await p.close();
    await expect(p.call({ connection: "fake", tool: "echo", args: {} })).rejects.toThrow(/closed/);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

