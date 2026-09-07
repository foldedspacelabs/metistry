// Bridge liveness for the bridge-degraded probe. Every host bridge speaks
// core's wire contract, so one caller covers them all: GET /check with the
// per-bridge bearer (CRIT-9 — the watchdog authenticates like any other
// caller), parse the frozen check() shape. Two failure classes are kept
// distinct because they have different fixes: DOWN (nothing answering the
// contract at that URL — restart the launchd job / fix the port) versus
// DEGRADED (the bridge answers and its own behavioral probe says no —
// helper crashed, TCC grant dropped; the bridge's remediation says what).

import { checkResultSchema, type CheckResult } from "@foldedspacelabs/metistry-core";

export interface BridgeTarget {
  name: string;
  url: string;
  token?: string;
  /** launchd label, when the bridge ships a plist — drives the restart hint. */
  launchdLabel?: string;
}

export type BridgeState = "ok" | "degraded" | "down" | "unauthorized";

export interface BridgeOutcome {
  name: string;
  state: BridgeState;
  message: string; // the bridge's own words where it had any
  result?: CheckResult;
}

/** The env is written for the console CONTAINER (host.docker.internal); the watchdog is ON the host. */
export function hostLocal(url: string): string {
  const u = new URL(url);
  if (u.hostname === "host.docker.internal") u.hostname = "127.0.0.1";
  return u.toString().replace(/\/$/, "");
}

/** Configured = a URL is set. A missing token is deliberately not a skip — the bridge's 401 surfaces the misconfig. */
export function bridgesFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeTarget[] {
  const out: BridgeTarget[] = [];
  const add = (name: string, urlVar: string, tokenVar: string, launchdLabel?: string) => {
    const url = env[urlVar];
    if (!url) return;
    const token = env[tokenVar];
    out.push({ name, url: hostLocal(url), ...(token ? { token } : {}), ...(launchdLabel ? { launchdLabel } : {}) });
  };
  add("apple-fm", "METISTRY_AFM_URL", "METISTRY_BRIDGE_TOKEN_APPLE_FM", "com.foldedspacelabs.metistry.apple-fm");
  add("eventkit", "METISTRY_EK_URL", "METISTRY_BRIDGE_TOKEN_EVENTKIT", "com.foldedspacelabs.metistry.eventkit");
  add("reconciler", "METISTRY_RECONCILER_URL", "METISTRY_BRIDGE_TOKEN_RECONCILER");
  return out;
}

function restartHint(b: BridgeTarget): string {
  return b.launchdLabel
    ? `launchctl kickstart -k gui/$(id -u)/${b.launchdLabel}`
    : `restart the ${b.name} service and check its URL (${b.url})`;
}

export async function checkBridge(b: BridgeTarget, fetchFn: typeof fetch = fetch, timeoutMs = 5000): Promise<BridgeOutcome> {
  let res: Response;
  try {
    res = await fetchFn(`${b.url}/check`, {
      headers: b.token ? { authorization: `Bearer ${b.token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { name: b.name, state: "down", message: `${b.name} down (${why}) — ${restartHint(b)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      name: b.name,
      state: "unauthorized",
      message: `${b.name} rejected the watchdog's token (HTTP ${res.status}) — METISTRY_BRIDGE_TOKEN_* in .env differs from the bridge's launchd env`,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = checkResultSchema.safeParse(body);
  if (!parsed.success) {
    // something answers, but not the wire contract — wrong port, or a bridge mid-crash
    return { name: b.name, state: "down", message: `${b.name} answered HTTP ${res.status} without a check() body (${b.url}) — ${restartHint(b)}` };
  }
  const result = parsed.data;
  if (result.status === "ok") return { name: b.name, state: "ok", message: `${b.name} ok`, result };
  return {
    name: b.name,
    state: "degraded",
    message: `${b.name} ${result.status}: ${result.remediation ?? result.probe}`,
    result,
  };
}

/** Decision: down/unauthorized anywhere = failed; otherwise any degraded = degraded; nothing configured = absent. */
export function summarizeBridges(outcomes: BridgeOutcome[]): Pick<CheckResult, "status" | "remediation" | "meta"> {
  if (outcomes.length === 0) return { status: "absent", meta: { bridges: {} } };
  const meta = { bridges: Object.fromEntries(outcomes.map((o) => [o.name, o.state])) };
  const bad = outcomes.filter((o) => o.state !== "ok");
  if (bad.length === 0) return { status: "ok", meta };
  const status = bad.some((o) => o.state === "down" || o.state === "unauthorized") ? "failed" : "degraded";
  return { status, remediation: bad.map((o) => o.message).join("; "), meta };
}
