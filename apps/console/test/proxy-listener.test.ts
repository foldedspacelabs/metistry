// The proxy listener's Host rule (plan §2.23, X-103): a request on the proxy
// listener must name a remote host METISTRY_ORIGIN configures — never a
// loopback one, never an unlisted one, never none. These drive the two pure
// functions server.ts's `route` calls, so every spelling a proxy or a prober
// can send is tested without a socket. The socket-level behaviour is
// proxy-listener.integration.test.ts.
import { describe, expect, it } from "vitest";
import { hostAllowed, PROXY_SOCKET_FILENAME, proxySocketPath, remoteHostsOf } from "../src/proxy-listener.js";

describe("remoteHostsOf — the hosts METISTRY_ORIGIN configures beyond this Mac", () => {
  it("takes every non-loopback origin's authority, default ports elided, duplicates folded", () => {
    expect(remoteHostsOf("https://studio.tail1234.ts.net,http://127.0.0.1:8080")).toEqual(["studio.tail1234.ts.net"]);
    expect(remoteHostsOf("https://Studio.Tail1234.TS.NET:443, https://studio.tail1234.ts.net")).toEqual(["studio.tail1234.ts.net"]);
    expect(remoteHostsOf("https://studio.tail1234.ts.net:8443")).toEqual(["studio.tail1234.ts.net:8443"]); // Funnel on 8443 is a different authority
    expect(remoteHostsOf("https://a.example, https://b.example:10000")).toEqual(["a.example", "b.example:10000"]);
    expect(remoteHostsOf("https://[2001:db8::1]")).toEqual(["[2001:db8::1]"]);
  });

  it("**is empty for every install's default — loopback only — so the proxy listener refuses everything until a provider is chosen**", () => {
    for (const o of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080", "http://127.0.0.1:8080,http://localhost:8460", "http://127.5.6.7"]) {
      expect(remoteHostsOf(o), o).toEqual([]);
    }
    expect(remoteHostsOf(undefined)).toEqual([]);
    expect(remoteHostsOf("")).toEqual([]);
  });

  it("skips a loopback origin beside a remote one rather than admitting it — the main listener's hosts are what the proxy listener must not answer", () => {
    expect(remoteHostsOf("http://127.0.0.1:8080,https://studio.ts.net")).toEqual(["studio.ts.net"]);
  });

  it("a malformed entry configures nothing", () => {
    expect(remoteHostsOf("not a url, https://ok.example")).toEqual(["ok.example"]);
  });
});

describe("hostAllowed — what a request on the proxy listener may name", () => {
  const allowed = ["studio.tail1234.ts.net", "funnel.example:8443"];

  it("matches the configured authority, case-insensitively, with or without its default port", () => {
    expect(hostAllowed("studio.tail1234.ts.net", allowed)).toBe(true);
    expect(hostAllowed("STUDIO.tail1234.TS.net", allowed)).toBe(true);
    expect(hostAllowed("studio.tail1234.ts.net:443", allowed)).toBe(true);
    expect(hostAllowed("studio.tail1234.ts.net:80", allowed)).toBe(true); // TLS ended at the provider; the scheme is not on the wire
    expect(hostAllowed(" studio.tail1234.ts.net ", allowed)).toBe(true);
    expect(hostAllowed("funnel.example:8443", allowed)).toBe(true);
  });

  it("**refuses a wrong Host**: another name, the right name on the wrong port, a loopback or bare address, a prefix or suffix", () => {
    for (const h of [
      "other.tail1234.ts.net",
      "studio.tail1234.ts.net:8443", // the right name, a port that is not configured
      "funnel.example", // configured with 8443 only
      "funnel.example:443",
      "127.0.0.1",
      "127.0.0.1:8081",
      "localhost",
      "[::1]",
      "studio.tail1234.ts.net.evil.example",
      "evil.studio.tail1234.ts.net",
      "studio.tail1234.ts.net/",
      "studio.tail1234.ts.net:443:443",
      "studio.tail1234.ts.net:abc",
      "user@studio.tail1234.ts.net",
      "https://studio.tail1234.ts.net",
      "",
      "   ",
    ]) {
      expect(hostAllowed(h, allowed), JSON.stringify(h)).toBe(false);
    }
  });

  it("refuses an absent or repeated Host header", () => {
    expect(hostAllowed(undefined, allowed)).toBe(false);
    expect(hostAllowed(["studio.tail1234.ts.net", "studio.tail1234.ts.net"], allowed)).toBe(false);
  });

  it("**refuses every Host when nothing remote is configured** — an empty allow list admits nothing, not everything", () => {
    expect(hostAllowed("studio.tail1234.ts.net", [])).toBe(false);
    expect(hostAllowed("127.0.0.1", [])).toBe(false);
  });
});

describe("the socket", () => {
  it("lives in the instance's state directory under its fixed name, so a provider adapter can find it without asking", () => {
    expect(PROXY_SOCKET_FILENAME).toBe("console-proxy.sock");
    expect(proxySocketPath("/Users/someone/Library/Application Support/Metistry/instance/")).toBe("/Users/someone/Library/Application Support/Metistry/instance/.metistry/state/console-proxy.sock");
  });
});
