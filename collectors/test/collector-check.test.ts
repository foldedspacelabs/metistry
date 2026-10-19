// Every collector exports `check()` (CLAUDE.md: "every bridge and collector
// exports `check()` so `metistry doctor` is generic"; X-87).
//
// ONE strict CI check holds the convention: every `collectors/*/manifest.yaml`
// names a collector whose entry (`run.ts`, `run.js` once built) exports a
// `check` function. There is no allowlist — a collector without one fails this
// file, and the fix is to write the check, not to list the collector.
//
// Below it, each collector's `check()` against stubs: no database, no
// instance, no network. The shared connection check is a function the test
// hands in, as `metistry doctor` hands in the real one.
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkResultSchema, parseCompute, type CheckResult, type Compute } from "@foldedspacelabs/metistry-core";
import type { OpenedImapSync, OpenedSync } from "@foldedspacelabs/metistry-connections";
import { check as awsCosts } from "../aws-costs/run.js";
import { check as caldav } from "../caldav-calendar/run.js";
import { check as claudeUsage } from "../claude-usage/run.js";
import { check as eventkit } from "../eventkit-calendar/run.js";
import { check as githubState } from "../github-state/run.js";
import { check as google } from "../google-calendar/run.js";
import { check as ics } from "../ics-calendar/run.js";
import { check as inboxDrain } from "../inbox-drain/run.js";
import { check as linear } from "../linear/run.js";
import { check as mail } from "../mail-messages/run.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("every collector manifest's entry exports check()", () => {
  const names = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${ROOT}${e.name}/manifest.yaml`))
    .map((e) => e.name)
    .sort();

  it("finds the collectors (a scan that finds none is not a check)", () => {
    expect(names.length).toBeGreaterThanOrEqual(12);
  });

  for (const name of names) {
    it(`${name}`, async () => {
      const mod = (await import(`../${name}/run.ts`)) as { check?: unknown; run?: unknown };
      expect(typeof mod.run, `${name} exports run()`).toBe("function");
      expect(typeof mod.check, `${name} exports check() — CLAUDE.md: every collector does; write it, do not allowlist it`).toBe("function");
    });
  }
});

const shape = (r: CheckResult, name: string) => {
  expect(checkResultSchema.parse(r)).toEqual(r); // core's frozen shape, exactly
  expect(r.name).toBe(name);
  expect(r.probe.length).toBeGreaterThan(0);
  expect(r.latency_ms).toBeGreaterThanOrEqual(0);
};

const okSync = (connection: string): OpenedSync => ({ ok: true, sync: { connection } as never });
const okImap = (connection: string): OpenedImapSync => ({ ok: true, sync: { connection } as never });
const connOk = (name: string): CheckResult => ({ name, status: "ok", latency_ms: 3, probe: "p" });

// The six that read one connection through an opener share one shape.
const syncs: Array<{ name: string; check: (ctx: any) => Promise<CheckResult>; opener: "openSync" | "openImap" }> = [
  { name: "google-calendar", check: google, opener: "openSync" },
  { name: "ics-calendar", check: ics, opener: "openSync" },
  { name: "caldav-calendar", check: caldav, opener: "openSync" },
  { name: "linear", check: linear, opener: "openSync" },
  { name: "mail-messages", check: mail, opener: "openImap" },
];

describe.each(syncs)("$name check() — a sync that reads one connection", ({ name, check, opener }) => {
  const open = (r: unknown) => ({ [opener]: async () => r });
  const good = opener === "openImap" ? okImap("home") : okSync("home");

  it("is absent with no opener (no instance), and says what is missing", async () => {
    const r = await check({});
    shape(r, name);
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/METISTRY_INSTANCE_DIR/);
  });

  it("is absent when no connection exists yet, naming the command that adds one", async () => {
    const r = await check(open({ ok: false, status: "absent", why: `no connection is read by ${name} yet` }));
    shape(r, name);
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/metistry connections add/);
  });

  it("is failed when the connection is there but cannot be used — the run's own words", async () => {
    const r = await check(open({ ok: false, status: "failed", why: "connection home: reach.http.auth: the sign-in is refused" }));
    expect(r.status).toBe("failed");
    expect(r.remediation).toBe("connection home: reach.http.auth: the sign-in is refused");
  });

  it("is ok when it opens and nothing is handed to dial (local-first: nothing was dialled)", async () => {
    const r = await check(open(good));
    shape(r, name);
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ connection: "home", dialled: false });
    expect(r.probe).toMatch(/reachability not checked/);
  });

  it("asks the SHARED connection check for the connection it opened, and is ok when that is", async () => {
    const asked: string[] = [];
    const r = await check({ ...open(good), connectionCheck: async (c: string) => (asked.push(c), connOk(c)) });
    expect(asked).toEqual(["home"]);
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ connection: "home", dialled: true, connection_status: "ok" });
    expect(r.probe).not.toMatch(/reachability not checked/);
  });

  it("a calendar/tracker the shared check does not dial (refused not_built) is ok on what the check could see — and says it was not dialled", async () => {
    const r = await check({ ...open(good), connectionCheck: async (c: string) => ({ ...connOk(c), status: "absent", remediation: "a calendar is read by its provider's sync, not dialled as MCP", meta: { refused: "not_built" } }) });
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ connection: "home", dialled: false });
    expect(String(r.meta?.not_dialled)).toMatch(/not dialled as MCP/);
    expect(r.probe).toMatch(/reachability not checked/); // an ok that dialled nothing must not read as if it answered
  });

  it("an absent connection for any other reason stays absent (the secret is not delivered, the sign-in not made)", async () => {
    const r = await check({ ...open(good), connectionCheck: async (c: string) => ({ ...connOk(c), status: "absent", remediation: "secret x has no item in this instance's Keychain", meta: { refused: "secret" } }) });
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/no item in this instance's Keychain/);
  });

  it("a connection that does not answer is degraded, never failed — it is someone else's server", async () => {
    const r = await check({ ...open(good), connectionCheck: async (c: string) => ({ ...connOk(c), status: "failed", remediation: "HTTP 401 from the server" }) });
    expect(r.status).toBe("degraded");
    expect(r.remediation).toMatch(/HTTP 401 from the server/);
    expect(r.remediation).toMatch(/metistry connections test home/);
    expect(r.meta).toMatchObject({ connection_status: "failed" });
  });

  it("a connection check that hangs is degraded after timeoutMs, and the timer does not outlive the call", async () => {
    const t0 = Date.now();
    const r = await check({ ...open(good), timeoutMs: 25, connectionCheck: () => new Promise<CheckResult>(() => {}) });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.status).toBe("degraded");
    expect(r.remediation).toMatch(/did not answer within 25 ms/);
  });

  it("an opener that throws is a failed row, not an exception", async () => {
    const r = await check({ [opener]: async () => { throw new Error("catalog unreadable"); } });
    expect(r.status).toBe("failed");
    expect(r.remediation).toBe("catalog unreadable");
  });
});

describe("eventkit-calendar check()", () => {
  const bridge = (status: number, body: unknown, seen: Array<{ url: string; auth: string | null }> = []): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  const okBody = { name: "eventkit", status: "ok", latency_ms: 4, probe: "real 7-day event read" };

  it("is absent without a URL and token, and dials nothing", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const r = await eventkit({ fetchFn: bridge(200, okBody, seen) });
    shape(r, "eventkit-calendar");
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/METISTRY_EK_URL.*METISTRY_BRIDGE_TOKEN_EVENTKIT/);
    expect(seen).toEqual([]);
  });

  it("asks the bridge's own GET /check with the bearer, and is ok when it is", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const r = await eventkit({ ekUrl: "http://127.0.0.1:7811/", ekToken: "tok", fetchFn: bridge(200, okBody, seen) });
    expect(r.status).toBe("ok");
    expect(seen).toEqual([{ url: "http://127.0.0.1:7811/check", auth: "Bearer tok" }]);
  });

  it("carries the bridge's own verdict and remediation through (a missing Calendar grant)", async () => {
    const r = await eventkit({ ekUrl: "http://x", ekToken: "t", fetchFn: bridge(503, { ...okBody, status: "failed", remediation: "TCC grant missing" }) });
    expect(r.status).toBe("failed");
    expect(r.remediation).toBe("TCC grant missing");
  });

  it("is failed when the token is refused, when nothing answers, and when the body is not a check() result", async () => {
    expect((await eventkit({ ekUrl: "http://x", ekToken: "t", fetchFn: bridge(401, { error: "no" }) })).remediation).toMatch(/refused METISTRY_BRIDGE_TOKEN_EVENTKIT \(HTTP 401\)/);
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await eventkit({ ekUrl: "http://x", ekToken: "t", fetchFn: down });
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/did not answer GET \/check.*ECONNREFUSED/);
    expect((await eventkit({ ekUrl: "http://x", ekToken: "t", fetchFn: bridge(200, { hello: 1 }) })).remediation).toMatch(/without a check\(\) body/);
  });
});

describe("github-state check()", () => {
  it("is absent with no connection and no legacy pair", async () => {
    const r = await githubState({});
    shape(r, "github-state");
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/metistry connections add.*METISTRY_GITHUB_TOKEN/s);
  });

  it("is ok on the legacy token and repo list, dialling nothing", async () => {
    const fetchFn = (async () => { throw new Error("no network in a check of a token"); }) as unknown as typeof fetch;
    const r = await githubState({ githubToken: "t", githubRepos: ["a/b", "c/d"], fetchFn });
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ source: "legacy token", repos: 2 });
  });

  it("checks the connection it resolved through the shared check", async () => {
    const opened = { ok: true, sync: { connection: "gh", config: { repos: "a/b" }, headers: { authorization: "Bearer {{ secret.gh }}" }, fetch } };
    const r = await githubState({ openSync: async () => opened, connectionCheck: async (c: string) => ({ ...connOk(c), status: "degraded", remediation: "rate limited" }) });
    expect(r.status).toBe("degraded");
    expect(r.meta).toMatchObject({ connection: "gh", source: "connection", repos: 1 });
  });

  it("a connection with a repo that is not owner/repo is failed — the run would throw the same", async () => {
    const opened = { ok: true, sync: { connection: "gh", config: { repos: "../etc" }, headers: {}, fetch } };
    const r = await githubState({ openSync: async () => opened });
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/config\.repos must be owner\/repo/);
  });
});

describe("aws-costs check()", () => {
  it("is absent without the key pair", async () => {
    const r = await awsCosts({});
    shape(r, "aws-costs");
    expect(r.status).toBe("absent");
    expect(r.remediation).toMatch(/METISTRY_AWS_ACCESS_KEY_ID and METISTRY_AWS_SECRET_ACCESS_KEY/);
    expect((await awsCosts({ aws: { accessKeyId: "a", secretAccessKey: "" } })).status).toBe("absent");
  });

  it("is ok with the pair, and NEVER calls Cost Explorer — it bills per request", async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await awsCosts({ aws: { accessKeyId: "AKIDEXAMPLE1", secretAccessKey: "SECRETEXAMPLE9" }, fetchFn });
    expect(r.status).toBe("ok");
    expect(called).toBe(0);
    expect(JSON.stringify(r)).not.toMatch(/EXAMPLE/); // names and booleans only — never a value
  });
});

describe("claude-usage check()", () => {
  it("is ok with nothing to configure and no database to ask", async () => {
    const r = await claudeUsage({});
    shape(r, "claude-usage");
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ read: false });
  });

  it("reads the runs it rolls up when handed a database, and fails when that read fails", async () => {
    const db = { query: async () => ({ rows: [{ turns: "7" }] }) };
    expect((await claudeUsage({ db })).meta).toMatchObject({ read: true, turns: 7 });
    const broken = { query: async () => { throw new Error('relation "runs" does not exist'); } };
    const r = await claudeUsage({ db: broken });
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/relation "runs" does not exist/);
  });
});

describe("inbox-drain check()", () => {
  const onMachine: Compute = parseCompute(`
providers:
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
`);
  const offMachine: Compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
`);

  it("is ok with no model tier — the deterministic rules need no credential", async () => {
    const r = await inboxDrain({});
    shape(r, "inbox-drain");
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ model_tier: "off" });
  });

  it("is ok and says the tier is off when uses_model names a provider compute.yaml does not declare", async () => {
    const r = await inboxDrain({ usesModel: "applefm/foundation-model", compute: () => parseCompute("providers: {}\n") });
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ model_tier: "off" });
    expect(String(r.meta?.why)).toMatch(/declares no provider applefm/);
  });

  it("says the tier is on when the on-machine provider resolves, and calls no model", async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await inboxDrain({ usesModel: "applefm/foundation-model", compute: () => onMachine, fetchFn });
    expect(r.meta).toMatchObject({ model_tier: "on", provider: "applefm" });
    expect(called).toBe(0);
  });

  it("is FAILED when uses_model names an off-machine provider — the money rule, found before the unattended job spends", async () => {
    const r = await inboxDrain({ usesModel: "openrouter/anthropic/claude-sonnet-5", compute: () => offMachine });
    expect(r.status).toBe("failed");
    expect(r.remediation).toMatch(/off_machine/);
  });
});
