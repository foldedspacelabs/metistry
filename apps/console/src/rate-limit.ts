// Rate limits on the PROXY listener (plan §2.23, X-111) — what stands between
// the sign-in page and the internet once a remote-access provider carries
// requests to this console.
//
// Funnel, Cloudflare Tunnel, zrok, ngrok and a forwarded port all put the
// passkey ceremonies, `GET /health`, `GET /api/identity` and the PWA shell
// where any scanner can reach them. Nothing here changes WHO gets in — that
// is the credential's job, decided elsewhere and never from a header. What
// it bounds is how often a client may be answered WITHOUT a session:
//
//   * per client, keyed on the address the PROVIDER wrote into its
//     client-address header (`x-forwarded-for` by default — the LAST entry,
//     which is the one the hop nearest to us appended; a provider that
//     overwrites the header leaves one entry, and that is the same one). The
//     header is read on the proxy listener alone, and only here: no
//     credential decision ever sees it (local-owner.ts, webauthn.ts), and the
//     main listener never reads it at all, so a forwarded address can bound a
//     caller but can never raise one;
//   * in total — a global ceiling, so a scanner spreading itself over many
//     addresses (or a provider that sends no client address, which puts
//     everyone in one bucket) is still bounded by what this Mac will answer.
//
// A refusal is `429 rate_limited` with `Retry-After`, and ONE `runs` row per
// refused burst — the first refusal in a window writes it, the rest of the
// burst does not — because a row per probe would make the audit table the
// thing a scanner fills (the Host gate in server.ts says the same).
//
// The window is fixed and aligned to the clock, so a key's state is a count
// and the window it belongs to; expired keys are swept when the global
// window turns, and the map is capped so a header that varies cannot grow it
// without bound. Hand-rolled over a dependency on purpose (CLAUDE.md): a
// counter and a map are the whole mechanism.

import type { IncomingHttpHeaders } from "node:http";

/** The header the provider writes the client's address into — lowercase, as node spells header names. */
export const DEFAULT_PROXY_CLIENT_HEADER = "x-forwarded-for";
/** Unauthenticated answers one client may draw per window: a shell load is ~20 files, a ceremony two requests; a scanner is thousands. */
export const DEFAULT_PROXY_CLIENT_LIMIT = 120;
/** Unauthenticated answers the listener gives in total per window, every client together. */
export const DEFAULT_PROXY_GLOBAL_LIMIT = 1200;
/** The window, in seconds. */
export const DEFAULT_PROXY_WINDOW_S = 60;
/** Most client keys held at once; past it the longest-held key goes first. A bound on memory, not a policy. */
export const MAX_TRACKED_CLIENTS = 10_000; // limit: fixed — a memory bound against a varying header, not an operator's dial; 10k keys is a few hundred KB
/** A client key is cut here so a header can never write a kilobyte into a `runs` row. */
const MAX_KEY_LENGTH = 64; // limit: fixed — an address is at most 45 characters (IPv6); anything longer is not an address

export interface ProxyLimits {
  /** The provider's client-address header, lowercase. Read for limiting only. */
  clientHeader: string;
  /** Unauthenticated answers per client per window. */
  perClient: number;
  /** Unauthenticated answers in total per window. */
  global: number;
  /** The window, in milliseconds. */
  windowMs: number;
  /** The clock — tests pin it. Absent = `Date.now`. */
  now?: (() => number) | undefined;
}

export const DEFAULT_PROXY_LIMITS: Readonly<Omit<ProxyLimits, "now">> = {
  clientHeader: DEFAULT_PROXY_CLIENT_HEADER,
  perClient: DEFAULT_PROXY_CLIENT_LIMIT,
  global: DEFAULT_PROXY_GLOBAL_LIMIT,
  windowMs: DEFAULT_PROXY_WINDOW_S * 1000,
};

/** The scope a refusal came from: this client's own limit, or the listener's ceiling. */
export type LimitScope = "client" | "global";

export type Verdict =
  | { ok: true }
  | {
      ok: false;
      scope: LimitScope;
      /** Whole seconds until the window turns — what `Retry-After` carries. At least 1. */
      retryAfterS: number;
      /** The first refusal of this burst: the one that writes the audit row. */
      first: boolean;
      limit: number;
    };

/**
 * The key a request is limited under: the LAST entry of the LAST value of the
 * provider's client-address header — the address the provider itself wrote,
 * whatever the client put before it — lowercased and bounded. With no such
 * header the peer address stands in, which on the proxy listener is the
 * provider's own loopback dial (or nothing, on the socket): every request
 * through that provider then shares one bucket, which is the fail-closed
 * direction, and the global ceiling is what bounds it.
 *
 * Never an identity. Nothing but the limiter reads this.
 */
export function clientKeyOf(headers: IncomingHttpHeaders, headerName: string, peer: string | undefined): string {
  const raw = headers[headerName.toLowerCase()];
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const last = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  const key = (last ?? peer ?? "").toLowerCase().slice(0, MAX_KEY_LENGTH);
  return key === "" ? "peer" : key;
}

interface Bucket {
  /** `Math.floor(now / windowMs)` of the window this count belongs to. */
  window: number;
  count: number;
  /** Whether this window's first refusal has already been written. */
  refused: boolean;
}

/**
 * Fixed-window counters, one per client key and one for the whole listener.
 * `take(key)` is "this request is about to be answered without a session":
 * it charges the key and, if the key had room, the ceiling, and says whether
 * there was room. A refused request still counts against its own key — a
 * client past its limit stays past it until the window turns, however it
 * keeps asking — but never against the ceiling.
 */
export class RateLimiter {
  private readonly clients = new Map<string, Bucket>();
  private readonly global: Bucket = { window: -1, count: 0, refused: false };
  private readonly now: () => number;

  constructor(
    readonly limits: Readonly<Omit<ProxyLimits, "now">>,
    now?: (() => number) | undefined,
  ) {
    this.now = now ?? Date.now;
  }

  take(key: string): Verdict {
    const t = this.now();
    const window = Math.floor(t / this.limits.windowMs);
    const retryAfterS = Math.max(1, Math.ceil(((window + 1) * this.limits.windowMs - t) / 1000));

    if (this.global.window !== window) {
      // the ceiling's window turned: start it over, and let go of every client whose window has too
      this.global.window = window;
      this.global.count = 0;
      this.global.refused = false;
      for (const [k, b] of this.clients) if (b.window !== window) this.clients.delete(k);
    }
    let client = this.clients.get(key);
    if (!client || client.window !== window) {
      if (!client && this.clients.size >= MAX_TRACKED_CLIENTS) {
        // the oldest key — a Map iterates in insertion order — makes room; a swept key simply starts a fresh count
        const oldest = this.clients.keys().next().value;
        if (oldest !== undefined) this.clients.delete(oldest);
      }
      client = { window, count: 0, refused: false };
      this.clients.set(key, client);
    }

    // The client's own limit first, and a client past it charges the ceiling
    // nothing: a refusal is not an answer, so one exhausted scanner cannot
    // spend the whole listener's allowance for everyone else.
    client.count++;
    if (client.count > this.limits.perClient) {
      const first = !client.refused;
      client.refused = true;
      return { ok: false, scope: "client", retryAfterS, first, limit: this.limits.perClient };
    }
    this.global.count++;
    if (this.global.count > this.limits.global) {
      const first = !this.global.refused;
      this.global.refused = true;
      return { ok: false, scope: "global", retryAfterS, first, limit: this.limits.global };
    }
    return { ok: true };
  }

  /** Whether `take(key)` would refuse right now, without charging anything. */
  exhausted(key: string): boolean {
    const window = Math.floor(this.now() / this.limits.windowMs);
    const client = this.clients.get(key);
    if (client && client.window === window && client.count >= this.limits.perClient) return true;
    return this.global.window === window && this.global.count >= this.limits.global;
  }

  /** How many client keys are held — for tests of the bound. */
  get size(): number {
    return this.clients.size;
  }
}

/**
 * One request's toll: at most ONE charge however many places ask — the Host
 * gate, the shell, a public route, the 401 that ends an unauthenticated
 * request — so a request that falls from the shell to the API's 401 is one
 * answer, not two. `take()` returns the same verdict on every call after the
 * first.
 */
export class Toll {
  private verdict: Verdict | undefined;

  constructor(
    private readonly limiter: RateLimiter,
    readonly key: string,
  ) {}

  take(): Verdict {
    this.verdict ??= this.limiter.take(this.key);
    return this.verdict;
  }

  /** Whether a charge would be refused, without making one. */
  exhausted(): boolean {
    return this.verdict ? !this.verdict.ok : this.limiter.exhausted(this.key);
  }

  get charged(): boolean {
    return this.verdict !== undefined;
  }
}
