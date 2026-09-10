// Misuse tests for the local owner door (invariant 8: misuse tests ship
// with the interface). These drive `checkLocalOwner` — the exact function
// server.ts's `authenticate()` calls — with fabricated request objects, so
// a peer address that no socket on this host could produce is still tested.
import { describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import {
  addressMatches,
  checkLocalOwner,
  defaultGatewayFrom,
  isLoopbackAddress,
  LOOPBACK_ADDRESSES,
  parseTrustedProxies,
  type PeerRequest,
} from "../src/local-owner.js";

const TOKEN = mintToken();
const cfg = { token: TOKEN, trusted: [] as string[] };

function req(remoteAddress: string | undefined, headers: Record<string, string> = {}): PeerRequest {
  return { headers: headers as PeerRequest["headers"], socket: { remoteAddress } };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("local owner token", () => {
  it("authenticates the `user` principal from every loopback address", () => {
    for (const addr of LOOPBACK_ADDRESSES) {
      expect(checkLocalOwner(req(addr, bearer(TOKEN)), cfg).verdict).toBe("ok");
    }
  });

  it("refuses THE token from a non-loopback address, and says so for the audit line", () => {
    for (const addr of ["10.0.0.4", "192.168.1.50", "203.0.113.7", "::ffff:10.0.0.4", "2001:db8::1", ""]) {
      const r = checkLocalOwner(req(addr, bearer(TOKEN)), cfg);
      expect(r.verdict).toBe("remote");
      expect(r.peer).toBe(addr);
    }
  });

  it("never reads a header to decide where a request came from", () => {
    // X-Forwarded-For, Forwarded and Host are the attacker's to write.
    const spoofs = [
      { "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-for": "127.0.0.1, 10.0.0.4" },
      { "x-real-ip": "127.0.0.1" },
      { forwarded: "for=127.0.0.1" },
      { host: "127.0.0.1:8080" },
    ];
    for (const spoof of spoofs) {
      expect(checkLocalOwner(req("203.0.113.7", { ...bearer(TOKEN), ...spoof }), cfg).verdict).toBe("remote");
    }
  });

  it("a wrong token from loopback is a plain mismatch — the local door never opens on the address alone", () => {
    expect(checkLocalOwner(req("127.0.0.1", bearer(mintToken())), cfg).verdict).toBe("mismatch");
    expect(checkLocalOwner(req("127.0.0.1", bearer("")), cfg).verdict).toBe("absent"); // not a Bearer at all
    expect(checkLocalOwner(req("127.0.0.1", {}), cfg).verdict).toBe("absent");
  });

  it("is absent, not open, when no token is configured", () => {
    expect(checkLocalOwner(req("127.0.0.1", bearer(TOKEN)), undefined).verdict).toBe("absent");
    expect(checkLocalOwner(req("127.0.0.1", bearer("")), { token: "", trusted: [] }).verdict).toBe("absent");
    // …and an empty configured token is never matched by an empty bearer
    expect(checkLocalOwner(req("127.0.0.1", bearer("anything")), { token: "", trusted: [] }).verdict).toBe("absent");
  });

  it("trusts a configured proxy address and nothing beside it", () => {
    const compose = { token: TOKEN, trusted: ["192.168.112.1"] };
    expect(checkLocalOwner(req("192.168.112.1", bearer(TOKEN)), compose).verdict).toBe("ok");
    // a sibling container on the same compose network is NOT the gateway
    expect(checkLocalOwner(req("192.168.112.9", bearer(TOKEN)), compose).verdict).toBe("remote");
    expect(checkLocalOwner(req("192.168.113.1", bearer(TOKEN)), compose).verdict).toBe("remote");
  });
});

describe("address matching", () => {
  it("knows loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    // the rest of 127/8 is not what a loopback socket reports, so it is not admitted by name
    expect(isLoopbackAddress("127.0.0.2")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });

  it("matches exact addresses and IPv4 CIDRs, and refuses 0.0.0.0/0", () => {
    expect(addressMatches("172.17.0.1", "172.17.0.1")).toBe(true);
    expect(addressMatches("::ffff:172.17.0.1", "172.17.0.1")).toBe(true);
    expect(addressMatches("172.17.0.5", "172.17.0.0/16")).toBe(true);
    expect(addressMatches("172.18.0.5", "172.17.0.0/16")).toBe(false);
    expect(addressMatches("203.0.113.1", "0.0.0.0/0")).toBe(false); // "the internet" is never a loopback proxy
    expect(addressMatches("203.0.113.1", "")).toBe(false);
    expect(addressMatches("203.0.113.1", "not-an-address")).toBe(false);
    expect(addressMatches("2001:db8::1", "172.17.0.0/16")).toBe(false);
  });
});

describe("METISTRY_TRUSTED_LOOPBACK_PROXY", () => {
  const gw = () => "172.17.0.1";

  it("is empty unless set — the fail-closed direction", () => {
    expect(parseTrustedProxies(undefined, gw)).toEqual([]);
    expect(parseTrustedProxies("", gw)).toEqual([]);
    expect(parseTrustedProxies("  ", gw)).toEqual([]);
  });

  it("resolves the docker-gateway sentinel, and drops it when there is no gateway", () => {
    expect(parseTrustedProxies("docker-gateway", gw)).toEqual(["172.17.0.1"]);
    expect(parseTrustedProxies("docker-gateway", () => null)).toEqual([]);
  });

  it("takes explicit addresses and CIDRs too", () => {
    expect(parseTrustedProxies("192.168.112.1, 10.1.0.0/16", gw)).toEqual(["192.168.112.1", "10.1.0.0/16"]);
  });

  it("reads the default route out of /proc/net/route (little-endian hex)", () => {
    const route = [
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      "eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    ].join("\n");
    expect(defaultGatewayFrom(route)).toBe("172.17.0.1");
    // the compose network this actually runs on
    expect(defaultGatewayFrom("h\neth0\t00000000\t0170A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0")).toBe("192.168.112.1");
    expect(defaultGatewayFrom("h\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0")).toBe(null);
    expect(defaultGatewayFrom("")).toBe(null);
  });
});
