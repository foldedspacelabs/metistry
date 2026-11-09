// `METISTRY_ORIGIN` — the origins this console is configured for, and the
// three questions every verb asks of them (plan §2.22, §2.23):
//
//   * which entry is the canonical one passkeys bind to (the first);
//   * whether a phone could possibly reach it (loopback, `http:`, an IP
//     literal are refused by name; then `GET <origin>/health` from this Mac);
//   * what the list IS, given the remote-access record (`renderOrigins`):
//     the provider's origin first, the loopback origin `init` wrote second —
//     and with None, the loopback origin alone.
//
// A leaf module on purpose: `enroll.ts` (the refusals), `deployment.ts` (the
// environment renderer) and `remote/` (the doctor rows) all read it, and none
// of them may import each other for it.

import { isIP } from "node:net";
import type { RemoteRecord } from "@foldedspacelabs/metistry-core";

/** How long `GET <origin>/health` has to answer from this Mac. */
export const ENROLL_HEALTH_TIMEOUT_MS = 5000; // limit: fixed — §2.22's own number ("within 5 s"); a refusal rule, not a tunable

export type EnrollRefusalCase = "origin_unset" | "origin_invalid" | "loopback" | "http" | "ip_literal" | "unreachable" | "other_instance";

export interface EnrollRefusal {
  case: EnrollRefusalCase;
  /** the refusal's own words — §2.22's table, verbatim where it has a row */
  message: string;
  /** the first METISTRY_ORIGIN entry as read, or null when there was none */
  origin: string | null;
  /** the pointer every refusal ends with */
  fix: string;
  /** what was observed, when a message alone would hide it (the failing probe) */
  detail?: string;
}

/** Every refusal ends here (§2.22): Settings ▸ Remote Access on the Mac, `metistry remote` in a terminal, and the guide. */
export const ENROLL_FIX =
  "Choose how your phone reaches this Mac in Settings ▸ Remote Access (`metistry remote` in a terminal); docs/ops/phone.md says what METISTRY_ORIGIN has to be and what each refusal means.";

/** `METISTRY_ORIGIN` as a list: comma-separated, each entry trimmed and without a trailing slash, blanks dropped. */
export function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s !== "");
}

/** The first `METISTRY_ORIGIN` entry — the canonical one passkeys bind to (docs/ops/auth.md) — trimmed, without a trailing slash; undefined when unset or blank. */
export function firstOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const first = (env.METISTRY_ORIGIN ?? "").split(",")[0]?.trim().replace(/\/+$/, "") ?? "";
  return first === "" ? undefined : first;
}

/** `[::1]` → `::1`; a URL's hostname keeps the brackets, `net.isIP` does not want them. */
function bareHost(url: URL): string {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** `127.0.0.0/8`, `::1`, its IPv4-mapped form, and `localhost` — every install's default (`init` writes `http://127.0.0.1:<port>`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/** Whether an origin string names this machine. A string that is not a URL is not loopback — it is not anything. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(bareHost(new URL(origin)));
  } catch {
    return false;
  }
}

export type OriginShape = { ok: true; url: URL } | { ok: false; refusal: EnrollRefusal };

/**
 * The three refusals that need no network, in §2.22's order: loopback first —
 * so the default `http://127.0.0.1:8080` gets the refusal that names the
 * actual problem (nothing but this Mac can reach it), not the `http:` one.
 */
export function checkOriginShape(origin: string | undefined): OriginShape {
  const refuse = (c: EnrollRefusalCase, message: string): OriginShape => ({ ok: false, refusal: { case: c, message, origin: origin ?? null, fix: ENROLL_FIX } });
  if (origin === undefined) {
    return refuse("origin_unset", "METISTRY_ORIGIN is not set, so there is no address for your phone to open. Set it to the https:// hostname your phone will open, then run metistry enroll again.");
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return refuse("origin_invalid", `METISTRY_ORIGIN is ${origin}, which is not a URL. Set it to the https:// address your phone will open.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse("origin_invalid", `METISTRY_ORIGIN is ${origin}, which is not a web address. Set it to the https:// address your phone will open.`);
  }
  const host = bareHost(url);
  if (isLoopbackHost(host)) {
    return refuse("loopback", "Your phone can't reach this Mac yet: Metistry only answers on this Mac. Choose how your phone reaches it in Settings ▸ Remote Access (`metistry remote set`).");
  }
  if (url.protocol === "http:") {
    return refuse("http", `A passkey needs HTTPS. METISTRY_ORIGIN is ${origin}; set it to the https:// address your phone will open.`);
  }
  if (isIP(host) !== 0) {
    return refuse("ip_literal", `A passkey needs a name, not an IP address. METISTRY_ORIGIN is ${origin}; set it to a hostname your phone can open.`);
  }
  return { ok: true, url };
}

export interface ReachabilityOptions {
  fetchFn?: typeof fetch | undefined;
  /** this instance's `instance_id`; absent = the identity comparison is skipped (there is nothing to compare against) */
  instanceId?: string | undefined;
  /** what `metistry remote` recorded (`deployment.yaml` `remote.provider`), for the refusal's wording */
  provider?: string | undefined;
  timeoutMs?: number | undefined;
}

/** The provider the refusal names: what `deployment.yaml` records (§2.23), or a generic phrase until one is chosen. */
export function providerPhrase(provider: string | undefined): string {
  return provider && provider !== "none" ? provider : "your remote-access provider";
}

/**
 * The fourth refusal (§2.22) — and §2.23's *answers from this Mac* check,
 * which is the same probe: `GET <origin>/health` does not answer from this
 * Mac within 5 s, or `GET <origin>/api/identity` names another instance's
 * `instance_id`. Any HTTP answer to /health counts as answering — a 503 is a
 * console that is unwell, not one the phone cannot reach. It is said as
 * "answers from this Mac", never "reachable from your phone": a Mac on the
 * provider's own network may reach a name the internet cannot.
 */
export async function checkOriginReachable(url: URL, opts: ReachabilityOptions = {}): Promise<EnrollRefusal | undefined> {
  const origin = url.origin;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeout = opts.timeoutMs ?? ENROLL_HEALTH_TIMEOUT_MS;
  const unreachable = (detail: string, c: EnrollRefusalCase = "unreachable"): EnrollRefusal => ({
    case: c,
    message: `${origin} doesn't answer from this Mac, so your phone won't reach it either. Settings ▸ Remote Access shows what ${providerPhrase(opts.provider)} reports.`,
    origin,
    fix: ENROLL_FIX,
    detail,
  });
  try {
    await fetchFn(`${origin}/health`, { method: "GET", signal: AbortSignal.timeout(timeout), redirect: "manual" });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `no answer within ${timeout / 1000} s` : e instanceof Error ? e.message : String(e);
    return unreachable(`GET ${origin}/health: ${why}`);
  }
  if (!opts.instanceId) return undefined;
  let body: unknown;
  try {
    const res = await fetchFn(`${origin}/api/identity`, { method: "GET", signal: AbortSignal.timeout(timeout), redirect: "manual" });
    if (!res.ok) return undefined; // 503 not_available: an instance `init` has not stamped is not another instance
    body = await res.json();
  } catch {
    return undefined; // /health answered; an identity that cannot be read proves nothing about whose it is
  }
  const theirs = body !== null && typeof body === "object" ? (body as { instance_id?: unknown }).instance_id : undefined;
  if (typeof theirs === "string" && theirs !== "" && theirs !== opts.instanceId) {
    return unreachable(`GET ${origin}/api/identity names instance ${theirs}, not this one (${opts.instanceId}) — that address reaches a different Metistry`, "other_instance");
  }
  return undefined;
}

// ---- the list, derived from the record ---------------------------------------

export interface RenderedOrigins {
  /** the `METISTRY_ORIGIN` value to run the console with; undefined when there is nothing to say (no record origin and no `.env` value — the console's own startup refusal names the variable) */
  value: string | undefined;
  /** `.env` entries that are neither loopback nor the record's origin — not carried, and worth one line in `up`'s plan */
  dropped: string[];
}

/**
 * How the origin flows (plan §2.23): the environment renderer derives
 * `METISTRY_ORIGIN` from the record rather than trusting whatever `.env`
 * holds. **The remote origin first** — so `metistry enroll` and the Add a
 * Phone QR, which mint for the first entry, use it with no change to their
 * spec — **the loopback origin `init` wrote second**, so the Mac app and the
 * PWA opened on this Mac keep working. **With None the list is the loopback
 * origin alone.**
 *
 * A non-loopback entry in `.env` that the record does not name is DROPPED,
 * and named in `dropped` so `up` can say so. That is the point, not a
 * side effect: a hand-written remote origin beside `remote: none` is exactly
 * the configuration X-103 found unsafe — a proxy at the main port, honouring
 * this Mac's owner token for anything a tunnel carries. The record is the
 * one way a remote origin is configured (`metistry remote set`).
 */
export function renderOrigins(remote: RemoteRecord | undefined, env: NodeJS.ProcessEnv, consolePort: number): RenderedOrigins {
  const entries = splitOrigins(env.METISTRY_ORIGIN);
  const remoteOrigin = remote !== undefined && remote.provider !== "none" && remote.origin !== undefined ? remote.origin.replace(/\/+$/, "") : undefined;
  const loopback = entries.filter(isLoopbackOrigin);
  const dropped = entries.filter((e) => !isLoopbackOrigin(e) && e !== remoteOrigin);
  if (remoteOrigin === undefined && entries.length === 0) return { value: undefined, dropped };
  // the loopback origin `init` wrote; its default when `.env` kept none,
  // because the Mac's own PWA and the enrolment ceremonies on this Mac need
  // one, and a remote origin alone would strand them
  const local = loopback.length > 0 ? loopback : [`http://127.0.0.1:${consolePort}`];
  const list = remoteOrigin === undefined ? local : [remoteOrigin, ...local.filter((l) => l !== remoteOrigin)];
  return { value: [...new Set(list)].join(","), dropped };
}
