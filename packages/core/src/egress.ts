// The egress door: one loopback HTTP CONNECT proxy, a hostname allowlist,
// and a bearer per confined child.
//
// WHY it exists. `ops/sandbox/assistant.sb` said the honest thing for a
// year: *"sandbox-exec filters outbound by PORT, not by name, so this list
// is documentation, not an enforced rule"*. SBPL cannot express
// `openrouter.ai`. It CAN express one loopback port — and a process
// listening there can name hosts all day. So the profiles now deny every
// outbound destination except the console, Postgres and THIS port, and the
// thing on this port is the only way out of the sandbox
// (docs/research/2026-09-19-agent-virtual-filesystems.md §1.A, the shape
// Anthropic's `sandbox-runtime` uses on macOS; the pattern, not the
// package — no dependency was added).
//
// Core owns the contract because three components have to agree on it:
// `metistry up` computes the allowlist, the supervisor serves it, and
// `metistry doctor` reports it. The arrow stays apps → packages.
//
// Deliberately small:
//
//   * **CONNECT only.** No TLS interception, no certificate authority, no
//     body inspection. The proxy learns a host name and a port and nothing
//     else — which is exactly the guarantee the profile could not make.
//   * **Exact host match.** No wildcards, no suffix rules, no regex. A
//     provider that moves to a new host name is a `compute.yaml` change and
//     an `up`, not a pattern that quietly admits a look-alike.
//   * **A bearer per child**, because loopback is not a trust boundary
//     (invariant 8) and because the audit row for a refusal has to be able
//     to say WHO asked. Basic proxy authentication is what both clients in
//     this product already speak: undici honours the userinfo in
//     `HTTPS_PROXY`, and git/curl answers a `407` challenge.

import { z } from "zod";

/** `metistry up` allocates the proxy this port when the instance has no namespace — after llamaserver's 7813, continuing the loopback block. */
export const EGRESS_PROXY_DEFAULT_PORT = 7814;

/** The proxy binds loopback and nothing else; a rule, not a default, so a config that says otherwise is refused. */
export const EGRESS_PROXY_HOST = "127.0.0.1";

/** What a confined child finds in its environment. `ALL_PROXY` is there for clients that read only that one. */
export const EGRESS_PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"] as const;

/**
 * Loopback destinations never go through the proxy: the console, Postgres,
 * the bridges and an on-machine model server are profile rules, not egress.
 * Both spellings plus the IPv6 literal, because undici's env agent compares
 * the URL's host textually.
 */
export const EGRESS_NO_PROXY = "localhost,127.0.0.1,::1";

/** `Proxy-Authenticate` realm and the `407` body — a fixed string, so it tells a caller nothing about the token. */
export const EGRESS_REALM = "metistry-egress";

/** The `runs.kind` every refusal lands under. Denials are a security event, so they are rows, not log lines. */
export const EGRESS_RUN_KIND = "egress";
/** `runs.component` for the proxy itself. */
export const EGRESS_COMPONENT = "egress-proxy";

/**
 * One allowlist entry: a host name, or `host:port` when the destination is
 * not 443.
 *
 * A bare entry means port 443 ONLY. That is the whole of this product's
 * off-machine traffic — an OpenAI-compatible provider over TLS and a git
 * remote over HTTPS — and admitting every port on an allowed host would
 * give a confined child a tunnel to whatever else that host runs.
 */
export const EGRESS_DEFAULT_PORT = 443;

export const egressEntrySchema = z
  .string()
  .min(1)
  .refine((s) => parseEgressEntry(s) !== undefined, { message: "must be a host name, or host:port" });

export const egressSchema = z
  .object({
    /** the loopback port the proxy binds; every confined child's profile allows exactly this one */
    port: z.number().int().positive(),
    /** host names (or `host:port`) a confined child may CONNECT to. Empty = the proxy refuses everything, which is a valid install with no off-machine provider and no remote */
    allow: z.array(egressEntrySchema).default([]),
    /** child name → bearer. The key is the identity that lands on the audit row; the value is minted once per install, like the control token */
    tokens: z.record(z.string().min(1), z.string().min(16)).default({}),
  })
  .strict();

export type Egress = z.infer<typeof egressSchema>;
export type EgressInput = z.input<typeof egressSchema>;

export interface EgressTarget {
  host: string;
  port: number;
}

/** `openrouter.ai` → `{host, 443}`; `example.test:8443` → `{host, 8443}`; anything else → undefined. */
export function parseEgressEntry(entry: string): EgressTarget | undefined {
  const s = entry.trim();
  if (s === "") return undefined;
  const colon = s.lastIndexOf(":");
  if (colon === -1) return isHostish(s) ? { host: s.toLowerCase(), port: EGRESS_DEFAULT_PORT } : undefined;
  const host = s.slice(0, colon);
  const port = Number(s.slice(colon + 1));
  if (!isHostish(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: host.toLowerCase(), port };
}

/**
 * A host name, an IPv4 literal, or a bracketed IPv6 literal — no scheme, no
 * path, no `*`. The wildcard is refused on purpose: `*.example.com` is the
 * rule that quietly admits `evil.example.com` the day a provider's DNS is
 * someone else's.
 */
function isHostish(s: string): boolean {
  if (s.startsWith("[") && s.endsWith("]")) return /^[0-9a-fA-F:]+$/.test(s.slice(1, -1));
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes("..") && !s.startsWith(".") && !s.endsWith(".");
}

/** The allowlist entry a URL contributes: its host, plus its port when that is not 443. `undefined` for loopback and for anything that is not a URL. */
export function egressEntryFor(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return undefined;
  const port = u.port === "" ? (u.protocol === "http:" ? 80 : EGRESS_DEFAULT_PORT) : Number(u.port);
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return port === EGRESS_DEFAULT_PORT ? bracketed.toLowerCase() : `${bracketed.toLowerCase()}:${port}`;
}

/** Loopback is the profile's business, never the proxy's — a confined child reaches the console and Postgres directly or not at all. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Is this CONNECT target allowed? Exact host match, case-insensitive, and
 * the port must match too.
 *
 * The child cannot widen this: the list is read from `supervisor.json`
 * BEFORE any child is spawned, lives in the supervisor's memory, and the
 * proxy takes nothing from the request but the target and the bearer.
 */
export function egressAllows(allow: readonly string[], target: EgressTarget): boolean {
  for (const entry of allow) {
    const t = parseEgressEntry(entry);
    if (t && t.host === target.host.toLowerCase() && t.port === target.port) return true;
  }
  return false;
}

/** `example.com:443` from a CONNECT request line. Undefined when it is not one — a proxy that guesses is a proxy that can be talked past. */
export function parseConnectTarget(requestUrl: string | undefined): EgressTarget | undefined {
  if (!requestUrl) return undefined;
  return parseEgressEntry(requestUrl.trim());
}

/**
 * `http://<child>:<token>@127.0.0.1:<port>` — the value both clients read.
 *
 * The bearer is in the URL because that is where undici's `EnvHttpProxyAgent`
 * and libcurl both look for it, and because it keeps the whole thing one
 * environment variable per child rather than a second file for a second
 * secret.
 */
export function egressProxyUrl(child: string, token: string, port: number, host: string = EGRESS_PROXY_HOST): string {
  return `http://${encodeURIComponent(child)}:${encodeURIComponent(token)}@${host}:${port}`;
}

/**
 * The environment a confined child needs to USE the door.
 *
 * `NODE_USE_ENV_PROXY=1` is the load-bearing one and is easy to miss: Node's
 * global `fetch` ignores `HTTPS_PROXY` unless it is asked to honour it
 * (undici's `EnvHttpProxyAgent`, behind `--use-env-proxy` since Node 22.15).
 * Verified on this install's Node 22.23.1: without it a `fetch` goes direct
 * and the profile — not the allowlist — is what refuses it, which is a worse
 * error message and a worse guarantee.
 */
export function egressProxyEnv(child: string, egress: { port: number; tokens: Record<string, string> }, host: string = EGRESS_PROXY_HOST): Record<string, string> {
  const token = egress.tokens[child];
  if (!token) return {};
  const url = egressProxyUrl(child, token, egress.port, host);
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: EGRESS_NO_PROXY,
    NODE_USE_ENV_PROXY: "1",
  };
}

/** What a refusal records. `at` is the proxy's clock; `runs.ts` stamps the row's own `ts`. */
export interface EgressDenial {
  child: string | null;
  host: string;
  port: number;
  reason: "unauthenticated" | "not-allowlisted" | "not-loopback" | "malformed";
  at: string;
}

/** One line for the supervisor's log, and the `meta` for the `runs` row — the same words in both places. */
export function describeDenial(d: EgressDenial): string {
  return `[egress] refused ${d.child ?? "an unauthenticated client"} → ${d.host}:${d.port} (${d.reason})`;
}
