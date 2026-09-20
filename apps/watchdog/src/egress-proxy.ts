// The egress door, served by the supervisor.
//
// WHY THE SUPERVISOR and not the console. Four reasons, in the order they
// decided it:
//
//   1. It is the PARENT of both confined children. The port and the
//      allowlist are computed by `metistry up`, read here before anything is
//      spawned, and handed to each child as an environment variable it can
//      use but not rewrite. A proxy hosted by a sibling would have to be
//      discovered, and a discovery mechanism is a widening mechanism.
//   2. It is the only process whose lifetime is the install's — it already
//      holds the `caffeinate` assertion for exactly that reason. Egress that
//      died with a console restart would make the engine's provider call
//      fail for reasons that have nothing to do with the engine.
//   3. It already holds a Postgres pool: invariant 3's standing exception
//      for the watchdog's liveness probes. A refusal is an audit row, and
//      putting the door here means the audit needs no new holder of the db.
//   4. The console's mutating surface is a closed, enumerated set
//      (invariant 10) and the console is itself the next candidate for
//      confinement. Adding a listener there would be a new surface on the
//      component with the strictest rule about new surfaces.
//
// WHAT IT IS. An HTTP CONNECT proxy and nothing else. No TLS interception,
// no certificate authority, no forwarding of cleartext requests — a plain
// `GET http://…` gets a 405. It learns a host name and a port; it never sees
// a byte of the tunnel. That is the whole trade the Seatbelt profile could
// not make: SBPL can say "one loopback port", and this is what listens
// there.
//
// Every refusal is a `runs` row (kind `egress`), because "the engine tried
// to reach somewhere it may not" is a security event and the run log is
// where this product keeps those.

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import {
  EGRESS_COMPONENT,
  EGRESS_PROXY_HOST,
  EGRESS_REALM,
  EGRESS_RUN_KIND,
  egressAllows,
  describeDenial,
  finishRun,
  parseConnectTarget,
  startRun,
  type Egress,
  type EgressDenial,
  type RunExecutor,
} from "@foldedspacelabs/metistry-core";

/** How long the proxy waits for the upstream TCP connect before giving up. A provider that has not answered a TCP handshake in this is down, not slow — and the client's own retry schedule is where slowness belongs. */
export const EGRESS_CONNECT_TIMEOUT_MS = 15_000;  // limit: fixed — a TCP connect budget, not a request timeout; the engine's 429/5xx backoff and git's own timeout bound the call itself

export interface EgressProxyDeps {
  /** the invariant-3 pool the watchdog half already holds; omitted in tests and on an install with no db */
  db?: RunExecutor | undefined;
  log?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
  /** test seam: the upstream dialer */
  connect?: ((host: string, port: number) => net.Socket) | undefined;
}

export interface EgressProxyStats {
  allowed: number;
  denied: number;
  lastDenial?: EgressDenial | undefined;
}

/**
 * Basic proxy credentials from the request header. Returns the child name
 * when the pair matches one this install minted, and null otherwise —
 * never the reason, because a proxy that distinguishes "no such child" from
 * "wrong token" is a proxy that enumerates children.
 */
export function childFor(header: string | string[] | undefined, tokens: Record<string, string>): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const m = /^basic\s+(\S+)$/i.exec(value.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  const child = decodeURIComponent(decoded.slice(0, sep));
  const token = decodeURIComponent(decoded.slice(sep + 1));
  const want = tokens[child];
  // length-independent enough for a loopback secret that is 256 bits of hex:
  // the comparison leaks nothing an attacker who can already time loopback
  // round trips does not have
  if (typeof want !== "string" || want.length !== token.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? child : null;
}

/** A client whose source address is not loopback is refused before anything else is read. The proxy binds 127.0.0.1, so this is belt and braces — and a test. */
export function isLoopbackClient(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/, "");
  return a === "::1" || /^127(\.\d{1,3}){3}$/.test(a);
}

export class EgressProxy {
  readonly stats: EgressProxyStats = { allowed: 0, denied: 0 };
  private readonly server: http.Server;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly dial: (host: string, port: number) => net.Socket;
  private readonly open = new Set<Duplex>();

  constructor(
    public readonly egress: Egress,
    private readonly deps: EgressProxyDeps = {},
  ) {
    this.log = deps.log ?? ((l) => console.log(l));
    this.now = deps.now ?? (() => new Date());
    this.dial = deps.connect ?? ((host, port) => net.connect({ host, port }));
    // A non-CONNECT request is not a mistake to be helpful about: this proxy
    // forwards nothing in the clear, so there is no method that could work.
    this.server = http.createServer((_req, res) => {
      res.writeHead(405, { "content-type": "text/plain", connection: "close" });
      res.end("this proxy speaks CONNECT only (no cleartext forwarding, no TLS interception)\n");
    });
    this.server.on("connect", (req, socket, head) => this.onConnect(req, socket, head));
    // a client that hangs up mid-handshake must not take the supervisor with it
    this.server.on("clientError", (_err, socket) => socket.destroy());
  }

  /** Binds loopback only. Resolves with the port actually bound (the configured one; `0` is for tests). */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.egress.port, EGRESS_PROXY_HOST, () => {
        const addr = this.server.address();
        const port = typeof addr === "object" && addr ? addr.port : this.egress.port;
        this.log(`[egress] CONNECT proxy on ${EGRESS_PROXY_HOST}:${port} — ${this.egress.allow.length} allowed host(s): ${this.egress.allow.join(", ") || "none"}`);
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.open) s.destroy();
    this.open.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): void {
    this.open.add(client);
    client.once("close", () => this.open.delete(client));
    const target = parseConnectTarget(req.url);
    let child: string | null = null;
    const deny = (reason: EgressDenial["reason"], status: number, extra = "") => {
      const denial: EgressDenial = { child, host: target?.host ?? String(req.url ?? "?"), port: target?.port ?? 0, reason, at: this.now().toISOString() };
      this.stats.denied += 1;
      this.stats.lastDenial = denial;
      this.log(describeDenial(denial));
      void this.record(denial);
      client.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Refused"}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    };

    if (!isLoopbackClient((client as net.Socket).remoteAddress)) {
      // no `child`: nothing off this machine is allowed to authenticate at all
      const denial: EgressDenial = { child: null, host: target?.host ?? "?", port: target?.port ?? 0, reason: "not-loopback", at: this.now().toISOString() };
      this.stats.denied += 1;
      this.stats.lastDenial = denial;
      this.log(describeDenial(denial));
      void this.record(denial);
      client.destroy();
      return;
    }

    child = childFor(req.headers["proxy-authorization"], this.egress.tokens);
    if (!child) {
      deny("unauthenticated", 407, `Proxy-Authenticate: Basic realm="${EGRESS_REALM}"\r\n`);
      return;
    }
    if (!target) {
      deny("malformed", 400);
      return;
    }
    if (!egressAllows(this.egress.allow, target)) {
      deny("not-allowlisted", 403);
      return;
    }

    const upstream = this.dial(target.host, target.port);
    const fail = () => {
      upstream.destroy();
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    upstream.setTimeout(EGRESS_CONNECT_TIMEOUT_MS, fail);
    upstream.once("error", fail);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      this.stats.allowed += 1;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      // from here the proxy is a pipe and sees ciphertext: no interception,
      // by construction rather than by policy
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.once("error", () => upstream.destroy());
  }

  /** One `runs` row per refusal. Never throws: a db that is down must not turn a refusal into a crash. */
  private async record(d: EgressDenial): Promise<void> {
    const db = this.deps.db;
    if (!db) return;
    try {
      const id = await startRun(db, {
        component: EGRESS_COMPONENT,
        kind: EGRESS_RUN_KIND,
        ...(d.child ? { tool: d.child } : {}),
        meta: { host: d.host, port: d.port, reason: d.reason, child: d.child, at: d.at },
      });
      await finishRun(db, id, { ok: false, error: describeDenial(d) });
    } catch (err) {
      this.log(`[egress] could not record the refusal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
