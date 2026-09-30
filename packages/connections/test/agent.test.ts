// Targets as connections (T4-11): an agent connection dispatch sends a brief
// through, and the syncs that read one Devin or GitHub connection. The door
// is the sync's: the key is filled at the egress door for its listed hosts,
// granted to `connection:<name>`, never by the caller; one origin (and any
// the product's code names beside it); no redirect.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EgressRefused, parseScheduled } from "@foldedspacelabs/metistry-core";
import { ConnectionRefused, agentConnections, consoleSecretNames, envSecretSource, openAgentHttp, openSyncHttp, syncReaders, syncTarget, type OpenedAgent } from "../src/index.js";
import { catalogOf } from "./helpers.js";

const typeOf = (name: string) => parse(readFileSync(new URL(`../../../seed/connection-types/${name}/manifest.yaml`, import.meta.url), "utf8")) as Record<string, unknown>;
const TYPES = [typeOf("devin"), typeOf("github-issues"), typeOf("github")];
// a key's shape, built at run time so no key-shaped literal is in the tree
const KEY = ["cog", "Zq8Rk2Vt7Wm4Xp1Ys6Bn3Cd9Fg5Hj0Kl2Mn4Pq7Rs"].join("_");
const ENV = { METISTRY_SECRET_DEVIN_API_KEY: KEY };

const devinFile = (over: Record<string, unknown> = {}) => ({
  name: "devin",
  type: "agent",
  provider: "devin",
  reach: { http: { url: "https://api.devin.ai", auth: { scheme: "bearer", secret: "devin_api_key" } } },
  secrets: ["devin_api_key"],
  config: { org: "org-abc", repos: "o/a, o/b" },
  ...over,
});

const POLICY = (grant = "on", hosts = "[api.devin.ai, mcp.devin.ai]") => `
secrets:
  devin_api_key:
    hosts: ${hosts}
    grants: { "connection:devin": ${grant} }
`;

function catalog(files: Record<string, unknown>[] = [devinFile()], policy = POLICY(), scheduled?: string) {
  const c = catalogOf(files, { secrets: policy, types: TYPES });
  return { ...c, scheduled: scheduled ? parseScheduled(scheduled).value : null };
}

function recorder() {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), headers, body: typeof init.body === "string" ? init.body : "" });
    return Response.json({ session_id: "s-1", echoed: headers.authorization ?? null });
  }) as typeof fetch;
  return { sent, fetchFn };
}

const agent = (o: OpenedAgent) => {
  if (!o.ok) throw new Error(`expected an open agent, got ${o.status}: ${o.why}`);
  return o.agent;
};

describe("an agent connection, opened for dispatch", () => {
  it("carries its type's dispatch, its text config, and a sign-in written as a reference — never a value", () => {
    const a = agent(openAgentHttp({ catalog: catalog(), connection: "devin", secrets: envSecretSource(ENV) }));
    expect(a.dispatch.dispatcher).toBe("devin-session");
    expect(Object.keys(a.dispatch.purposes).sort()).toEqual(["knowledge_research", "work"]);
    expect(a.config).toEqual({ org: "org-abc", repos: "o/a, o/b" });
    expect(a.headers).toEqual({ authorization: "Bearer {{ secret.devin_api_key }}" });
    expect(JSON.stringify(a)).not.toContain(KEY);
  });

  it("the key is filled at the door for its listed host, and what comes back is redacted", async () => {
    const r = recorder();
    const a = agent(openAgentHttp({ catalog: catalog(), connection: "devin", secrets: envSecretSource(ENV), fetch: r.fetchFn }));
    const res = await a.fetch(`${a.origin}/v3/self`, { headers: a.headers });
    expect(r.sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.sent[0]!.url).not.toContain(KEY);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
    expect(a.secretsUsed()).toEqual(["devin_api_key"]);
  });

  it("a key not granted to the connection is refused, and nothing is sent", async () => {
    const r = recorder();
    const a = agent(openAgentHttp({ catalog: catalog([devinFile()], POLICY("off")), connection: "devin", secrets: envSecretSource(ENV), fetch: r.fetchFn }));
    await expect(a.fetch(`${a.origin}/v3/self`, { headers: a.headers })).rejects.toBeInstanceOf(EgressRefused);
    expect(r.sent).toEqual([]);
  });

  it("a key bound for a host its list does not name is refused, and nothing is sent", async () => {
    const r = recorder();
    const a = agent(openAgentHttp({ catalog: catalog([devinFile()], POLICY("on", "[mcp.devin.ai]")), connection: "devin", secrets: envSecretSource(ENV), fetch: r.fetchFn }));
    await expect(a.fetch(`${a.origin}/v3/self`, { headers: a.headers })).rejects.toBeInstanceOf(EgressRefused);
    expect(r.sent).toEqual([]);
  });

  it("reaches its own origin and nowhere else, and a pinned provider refuses a file that points elsewhere", async () => {
    const r = recorder();
    const a = agent(openAgentHttp({ catalog: catalog(), connection: "devin", secrets: envSecretSource(ENV), fetch: r.fetchFn }));
    await expect(a.fetch("https://evil.example/v3/self", { headers: a.headers })).rejects.toMatchObject({ code: "other_host" });
    expect(r.sent).toEqual([]);
    const gh = openAgentHttp({
      catalog: catalog([{ name: "gh", type: "agent", provider: "github-issues", reach: { http: { url: "https://evil.example", auth: { scheme: "bearer", secret: "w" } } }, secrets: ["w"], config: { repo: "o/r" } }]),
      connection: "gh",
      origin: "https://api.github.com",
      secrets: envSecretSource({}),
    });
    expect(gh).toMatchObject({ ok: false, status: "failed", why: expect.stringMatching(/reached at https:\/\/api\.github\.com and nowhere else/) });
  });

  it("refuses what is not an agent connection, or not one dispatch knows", () => {
    expect(openAgentHttp({ catalog: catalog(), connection: "nope", secrets: envSecretSource({}) })).toMatchObject({ ok: false, status: "absent" });
    const tracker = catalog([{ name: "github", type: "tracker", provider: "github", reach: { http: { url: "https://api.github.com", auth: { scheme: "bearer", secret: "t" } } }, secrets: ["t"], config: { repos: "o/r" } }]);
    expect(openAgentHttp({ catalog: tracker, connection: "github", secrets: envSecretSource({}) })).toMatchObject({ ok: false, status: "failed", why: expect.stringMatching(/only an agent connection is dispatched to/) });
    const noOrg = catalog([devinFile({ config: {} })]);
    expect(openAgentHttp({ catalog: noOrg, connection: "devin", secrets: envSecretSource({}) })).toMatchObject({ ok: false, status: "failed", why: expect.stringMatching(/config\.org: required by devin/) });
  });

  it("an agent connection is listed for dispatch; its secrets are the console's to fill", () => {
    const c = catalog();
    expect(agentConnections(c).map((e) => e.name)).toEqual(["devin"]);
    expect(consoleSecretNames(c)).toEqual(["devin_api_key"]);
  });
});

describe("one connection read by several syncs (also_read_by)", () => {
  it("the sessions poller and the knowledge sync both find the one Devin connection", () => {
    const c = catalog();
    expect(syncTarget(c, "devin-sessions")).toMatchObject({ ok: true, entry: { name: "devin" } });
    expect(syncTarget(c, "devin-knowledge")).toMatchObject({ ok: true, entry: { name: "devin" } });
    expect(syncReaders(c).get("devin")).toEqual(["devin-knowledge", "devin-sessions"]);
  });

  it("a scheduled.yaml entry naming a connection its type is not read by is refused, naming what reads it", () => {
    const c = catalog([devinFile()], POLICY(), "syncs:\n  github-state:\n    connection: devin\n");
    expect(syncTarget(c, "github-state")).toMatchObject({ ok: false, status: "failed", why: expect.stringMatching(/read by devin-sessions, devin-knowledge/) });
  });

  it("a sync reaches a further origin only when the product's code names it — never because the file does", async () => {
    const r = recorder();
    const open = (alsoOrigins?: string[]) => openSyncHttp({ catalog: catalog(), sync: "devin-knowledge", module: "devin", secrets: envSecretSource(ENV), fetch: r.fetchFn, ...(alsoOrigins ? { alsoOrigins } : {}) });
    const plain = open();
    if (!plain.ok) throw new Error(plain.why);
    await expect(plain.sync.fetch("https://mcp.devin.ai/mcp", { headers: plain.sync.headers })).rejects.toBeInstanceOf(ConnectionRefused);
    const wiki = open(["https://mcp.devin.ai"]);
    if (!wiki.ok) throw new Error(wiki.why);
    await wiki.sync.fetch("https://mcp.devin.ai/mcp", { headers: wiki.sync.headers });
    expect(r.sent.map((s) => [s.url, s.headers.authorization])).toEqual([["https://mcp.devin.ai/mcp", `Bearer ${KEY}`]]);
    expect(wiki.sync.config.org).toBe("org-abc");
  });
});
