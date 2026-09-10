// The LOCAL owner token (docs/ops/auth.md) — how the Mac app, the CLI and
// anything else running as the logged-in user authenticates to a console on
// this machine without a passkey ceremony.
//
// Possession of `METISTRY_OWNER_TOKEN` means "I can read this user's login
// Keychain (or the 0600 .env generated from it)", which is exactly what a
// passkey on this Mac means: the person who is logged in. What it must NOT
// mean is "I hold a bearer that works from anywhere", so the token is
// accepted only when the CONNECTION came from this machine.
//
// That decision is made from the socket's peer address and nothing else.
// `X-Forwarded-For`, `Forwarded`, `Host` and every other header are written
// by the caller — reading any of them here would hand the loopback rule to
// the attacker. There is deliberately no configuration that can turn one of
// them on.
//
// The one wrinkle is the compose shape: the console runs in a container, the
// port is published as `127.0.0.1:<port>:8080`, and Docker SNATs the
// host-loopback connection to the bridge gateway — so the peer address the
// container sees is `172.17.0.1`/`192.168.112.1`, never `127.0.0.1`.
// `METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is TOLD about that,
// and docker-compose.yml is the only place that sets it. Unset (the launchd
// shape, and any console this file did not configure) = plain loopback,
// which is the fail-closed direction.

import { parseBearer, tokenEquals } from "@foldedspacelabs/metistry-core";

/** Every peer address that means "this machine" over a real loopback socket. */
export const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"] as const;

/**
 * The sentinel `METISTRY_TRUSTED_LOOPBACK_PROXY` value docker-compose.yml
 * sets: "my own default gateway", resolved once at startup from
 * /proc/net/route. It is deliberately not a CIDR — the gateway is the only
 * address the published-port NAT can present, so trusting it is much
 * narrower than trusting the compose subnet (a sibling container has an
 * address in that subnet but is never the gateway).
 */
export const DOCKER_GATEWAY = "docker-gateway";

export interface LocalOwnerConfig {
  /** METISTRY_OWNER_TOKEN — the instance-scoped secret `metistry init` mints. */
  token: string;
  /** Peer addresses that count as local BESIDES loopback: the compose gateway, resolved. Empty on the launchd shape. */
  trusted: readonly string[];
}

/** What the credential was, said plainly enough to audit — never to the caller. */
export type LocalOwnerVerdict =
  | "absent" // no bearer, or no local owner token configured at all
  | "mismatch" // a bearer that is not this token (may still be an agent/owner token — keep looking)
  | "remote" // THE token, from an address that is not this machine: refused, and audited
  | "ok";

export interface PeerRequest {
  headers: { authorization?: string | undefined };
  socket: { remoteAddress?: string | undefined };
}

/** The peer of the TCP connection. The only address input this module has. */
export function peerAddressOf(req: PeerRequest): string {
  return req.socket.remoteAddress ?? "";
}

export function isLoopbackAddress(addr: string): boolean {
  return (LOOPBACK_ADDRESSES as readonly string[]).includes(addr);
}

/** IPv4 dotted quad → 32-bit int; null when it is not one (an IPv6 peer never matches a v4 CIDR). */
function ipv4ToInt(addr: string): number | null {
  const plain = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  const parts = plain.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

/** `addr` inside `entry`, where entry is an exact address or an IPv4 CIDR. */
export function addressMatches(addr: string, entry: string): boolean {
  if (entry === "") return false;
  const slash = entry.indexOf("/");
  if (slash === -1) return addr === entry || (ipv4ToInt(addr) !== null && ipv4ToInt(addr) === ipv4ToInt(entry));
  const bits = Number(entry.slice(slash + 1));
  const net = ipv4ToInt(entry.slice(0, slash));
  const ip = ipv4ToInt(addr);
  if (net === null || ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return false; // 0.0.0.0/0 is "the internet", never a loopback proxy — refused, not honoured
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((net & mask) >>> 0);
}

/** The default gateway a Linux container sees, from /proc/net/route (little-endian hex). Null when there is none. */
export function defaultGatewayFrom(procNetRoute: string): string | null {
  for (const line of procNetRoute.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== "00000000") continue;
    const hex = f[2]!;
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
    // the hex is little-endian, so the LAST byte pair is the first octet: 010011AC → 172.17.0.1
    const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map((h) => Number.parseInt(h, 16));
    if (bytes.every((b) => b === 0)) continue;
    return bytes.join(".");
  }
  return null;
}

/**
 * `METISTRY_TRUSTED_LOOPBACK_PROXY` → the extra peer addresses that count as
 * local. Unset/empty = none (loopback only). `docker-gateway` resolves
 * through `gateway()`; anything else is taken as addresses/CIDRs verbatim.
 */
export function parseTrustedProxies(spec: string | undefined, gateway: () => string | null): string[] {
  const out: string[] = [];
  for (const raw of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === DOCKER_GATEWAY) {
      const gw = gateway();
      if (gw) out.push(gw);
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * The whole rule, in one function, so there is exactly one place that
 * decides. Order matters: the token is compared FIRST (constant-time) so a
 * refusal from a remote address can be audited as "the owner token, from
 * $addr" — a mismatch is indistinguishable from any other stray bearer and
 * is left to fall through to the other credential classes.
 */
export function checkLocalOwner(req: PeerRequest, cfg: LocalOwnerConfig | undefined): { verdict: LocalOwnerVerdict; peer: string } {
  const peer = peerAddressOf(req);
  const presented = parseBearer(req.headers.authorization);
  if (!cfg || cfg.token === "" || presented === null) return { verdict: "absent", peer };
  if (!tokenEquals(presented, cfg.token)) return { verdict: "mismatch", peer };
  const local = isLoopbackAddress(peer) || cfg.trusted.some((t) => addressMatches(peer, t));
  return { verdict: local ? "ok" : "remote", peer };
}
