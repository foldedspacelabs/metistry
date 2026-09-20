// Misuse tests for the egress door (invariant 8: every boundary testable,
// and every request authenticates as if internet-exposed — loopback is not a
// trust boundary).
//
// These drive a REAL proxy on a real loopback port with a real client, and
// prove the four refusals the design promises:
//
//   1. a host the allowlist does not name is refused (403) — even with a
//      valid bearer
//   2. a client with no bearer, or the wrong one, is refused (407)
//   3. a client that is not on loopback is refused before anything is read
//   4. nothing a client sends can widen the allowlist
//
// …and the one thing it must still do: tunnel an allowed host, opaquely.

import net from "node:net";
import { describe, expect, it, afterEach } from "vitest";
import { EGRESS_PROXY_HOST, EGRESS_REALM, egressProxyEnv, egressProxyUrl, parseEgressEntry, type Egress } from "@foldedspacelabs/metistry-core";
import { childFor, EgressProxy, isLoopbackClient } from "../src/egress-proxy.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_R = "r".repeat(64);

function egressWith(allow: string[]): Egress {
  return { port: 0, allow, tokens: { assistant: TOKEN_A, reconciler: TOKEN_R } };
}

/** One CONNECT request, raw — no client library, so the wire is the test. */
function connectRequest(port: number, target: string, auth?: string): Promise<{ status: number; headers: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString("utf8");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.slice(0, end);
      s.removeAllListeners("data");
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), headers: head, socket: s });
    });
    s.once("error", reject);
    s.setTimeout(5_000, () => reject(new Error("timeout")));
  });
}

const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

describe("the egress proxy's allowlist and bearer", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const p of open.splice(0)) await p.close();
  });

  const start = async (allow: string[], deps: Parameters<typeof EgressProxy.prototype.constructor>[1] = {}) => {
    const proxy = new EgressProxy(egressWith(allow), { log: () => {}, ...deps });
    const port = await proxy.listen();
    open.push(proxy);
    return { proxy, port };
  };

  it("tunnels an allowed host, opaquely — the proxy sees a name and a port, never a byte of the body", async () => {
    // a stand-in upstream: what the proxy connects to is injected, so this
    // test reaches nothing off the machine
    const upstream = net.createServer((c) => c.on("data", (d) => c.write(Buffer.concat([Buffer.from("echo:"), d]))));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upPort = (upstream.address() as net.AddressInfo).port;
    const { proxy, port } = await start(["provider.test"], { connect: () => net.connect({ host: "127.0.0.1", port: upPort }) });
    const { status, socket } = await connectRequest(port, "provider.test:443", basic("assistant", TOKEN_A));
    expect(status).toBe(200);
    const echoed = await new Promise<string>((res) => {
      socket.once("data", (d) => res(d.toString("utf8")));
      socket.write("ciphertext-would-go-here");
    });
    expect(echoed).toBe("echo:ciphertext-would-go-here");
    expect(proxy.stats).toMatchObject({ allowed: 1, denied: 0 });
    socket.destroy();
    upstream.close();
  });

  it("refuses a host the allowlist does not name — with a valid bearer, which is the point", async () => {
    const { proxy, port } = await start(["provider.test"], { connect: () => { throw new Error("must not dial"); } });
    const { status, socket } = await connectRequest(port, "somewhere-else.test:443", basic("assistant", TOKEN_A));
    expect(status).toBe(403);
    socket.destroy();
    expect(proxy.stats.denied).toBe(1);
    expect(proxy.stats.lastDenial).toMatchObject({ child: "assistant", host: "somewhere-else.test", port: 443, reason: "not-allowlisted" });
  });

  it("an allowed HOST is not an allowed PORT: a bare entry means 443 and nothing else", async () => {
    const { proxy, port } = await start(["provider.test"], { connect: () => { throw new Error("must not dial"); } });
    const { status, socket } = await connectRequest(port, "provider.test:22", basic("assistant", TOKEN_A));
    expect(status).toBe(403);
    socket.destroy();
    expect(proxy.stats.lastDenial).toMatchObject({ host: "provider.test", port: 22 });
  });

  it("refuses a client with no bearer, and one with the wrong bearer, the same way", async () => {
    const { proxy, port } = await start(["provider.test"]);
    const none = await connectRequest(port, "provider.test:443");
    expect(none.status).toBe(407);
    expect(none.headers).toContain(`Proxy-Authenticate: Basic realm="${EGRESS_REALM}"`);
    none.socket.destroy();
    const wrong = await connectRequest(port, "provider.test:443", basic("assistant", "b".repeat(64)));
    expect(wrong.status).toBe(407);
    wrong.socket.destroy();
    // …and an unknown child is indistinguishable from a bad token: the
    // refusal tells a caller nothing about who exists
    const unknown = await connectRequest(port, "provider.test:443", basic("nobody", TOKEN_A));
    expect(unknown.status).toBe(407);
    unknown.socket.destroy();
    expect(proxy.stats.denied).toBe(3);
    expect(proxy.stats.allowed).toBe(0);
  });

  it("nothing the client sends can widen the allowlist", async () => {
    const allow = ["provider.test"];
    const { proxy, port } = await start(allow, { connect: () => { throw new Error("must not dial"); } });
    // headers that look like configuration are just headers
    const s = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((r) => s.once("connect", () => r()));
    s.write(
      `CONNECT evil.test:443 HTTP/1.1\r\nHost: provider.test\r\nProxy-Authorization: ${basic("assistant", TOKEN_A)}\r\nX-Metistry-Allow: evil.test\r\nX-Forwarded-Host: provider.test\r\n\r\n`,
    );
    const head = await new Promise<string>((r) => s.once("data", (d) => r(d.toString("utf8"))));
    expect(head).toContain("403");
    s.destroy();
    // the list the proxy holds is still the one it was constructed with
    expect(proxy.egress.allow).toEqual(allow);
    expect(proxy.stats.lastDenial?.host).toBe("evil.test");
  });

  it("speaks CONNECT only: a cleartext forward request is a 405, never a fetch", async () => {
    const { port } = await start(["provider.test"], { connect: () => { throw new Error("must not dial"); } });
    const body = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => s.write("GET http://provider.test/ HTTP/1.1\r\nHost: provider.test\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d.toString("utf8")));
      s.once("close", () => resolve(buf));
      s.once("error", reject);
    });
    expect(body).toContain("405");
    expect(body).toContain("CONNECT only");
  });

  it("records every refusal as a `runs` row — host, child, reason", async () => {
    const q: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      async query(text: string, values: unknown[]) {
        q.push({ text, values });
        return { rows: [{ id: 7 }] };
      },
    };
    const { port } = await start(["provider.test"], { db, connect: () => { throw new Error("must not dial"); } });
    const { socket } = await connectRequest(port, "evil.test:443", basic("reconciler", TOKEN_R));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const insert = q.find((x) => x.text.includes("INSERT INTO runs"));
    expect(insert, JSON.stringify(q)).toBeTruthy();
    expect(insert!.values[0]).toBe("egress-proxy");
    expect(insert!.values[1]).toBe("egress");
    expect(JSON.parse(String(insert!.values[6]))).toMatchObject({ host: "evil.test", port: 443, reason: "not-allowlisted", child: "reconciler" });
    expect(q.some((x) => x.text.includes("UPDATE runs"))).toBe(true);
  });

  it("a db that is down turns a refusal into a log line, never a crash", async () => {
    const lines: string[] = [];
    const db = {
      async query() {
        throw new Error("the database is not there");
      },
    };
    const { port } = await start(["provider.test"], { db, log: (l: string) => lines.push(l), connect: () => { throw new Error("must not dial"); } });
    const { status, socket } = await connectRequest(port, "evil.test:443", basic("reconciler", TOKEN_R));
    expect(status).toBe(403);
    socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.join("\n")).toContain("could not record the refusal");
  });
});

describe("the door's own edges", () => {
  it("binds loopback and nothing else — a non-loopback client cannot reach it to be refused", async () => {
    const proxy = new EgressProxy({ port: 0, allow: [], tokens: {} }, { log: () => {} });
    await proxy.listen();
    // the address family check is the belt; `isLoopbackClient` below is the
    // braces, for the case where something else binds the socket for us
    expect((proxy as unknown as { server: { address(): net.AddressInfo } }).server.address().address).toBe("127.0.0.1");
    await proxy.close();
  });

  it("only loopback clients are clients at all", () => {
    expect(isLoopbackClient("127.0.0.1")).toBe(true);
    expect(isLoopbackClient("::1")).toBe(true);
    expect(isLoopbackClient("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackClient("192.168.1.10")).toBe(false);
    expect(isLoopbackClient("10.0.0.1")).toBe(false);
    expect(isLoopbackClient(undefined)).toBe(false);
  });

  it("the bearer identifies the child, and a mismatch identifies nobody", () => {
    const tokens = { assistant: TOKEN_A, reconciler: TOKEN_R };
    expect(childFor(basic("assistant", TOKEN_A), tokens)).toBe("assistant");
    expect(childFor(basic("reconciler", TOKEN_R), tokens)).toBe("reconciler");
    expect(childFor(basic("assistant", TOKEN_R), tokens)).toBeNull();
    expect(childFor(basic("nobody", TOKEN_A), tokens)).toBeNull();
    expect(childFor(undefined, tokens)).toBeNull();
    expect(childFor("Bearer " + TOKEN_A, tokens)).toBeNull();
    expect(childFor("Basic not-base64-%%%", tokens)).toBeNull();
    // a token that is a PREFIX of the real one is not the real one
    expect(childFor(basic("assistant", TOKEN_A.slice(0, 32)), tokens)).toBeNull();
  });

  it("an entry is a host, or host:port — never a wildcard, never a URL", () => {
    expect(parseEgressEntry("openrouter.ai")).toEqual({ host: "openrouter.ai", port: 443 });
    expect(parseEgressEntry("Example.Test:8443")).toEqual({ host: "example.test", port: 8443 });
    expect(parseEgressEntry("[::1]:8443")).toEqual({ host: "[::1]", port: 8443 });
    for (const bad of ["*.example.com", "https://example.com", "example.com/path", "", "  ", "example.com:0", "example.com:70000", "..x"]) {
      expect(parseEgressEntry(bad), bad).toBeUndefined();
    }
  });

  it("the child's environment names the door, and exempts loopback from it", () => {
    const env = egressProxyEnv("assistant", { port: 7814, tokens: { assistant: TOKEN_A } });
    expect(env.HTTPS_PROXY).toBe(egressProxyUrl("assistant", TOKEN_A, 7814));
    expect(env.HTTPS_PROXY).toBe(`http://assistant:${TOKEN_A}@${EGRESS_PROXY_HOST}:7814`);
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.ALL_PROXY).toBe(env.HTTPS_PROXY);
    // the console, Postgres and an on-machine model server are profile
    // rules, never egress — and undici would otherwise proxy them
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    // without this Node's global fetch ignores every variable above
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    // a child with no bearer gets no variables rather than a broken one
    expect(egressProxyEnv("someone-else", { port: 7814, tokens: { assistant: TOKEN_A } })).toEqual({});
  });
});
