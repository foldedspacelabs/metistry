// Where a provider forwards to — the one question two files ask of the same
// string. `rows.ts` asks it of the RECORD (`settings.upstream`, the shared
// *proxy listener* row) and an adapter asks it of the provider's LIVE config
// (Tailscale's serve handler, X-106). A leaf module, because `rows.ts` holds
// the registry that imports every adapter, and an adapter importing `rows.ts`
// back would be a load-order cycle.

import type { RemoteContext } from "./provider.js";

/** The sentence doctor fails a misdirected provider with (§2.23, "Doctor rows"), verbatim. */
export function mainPortRemediation(provider: string): string {
  return `${provider} is forwarding to the console's main port, which accepts this Mac's owner token. Run \`metistry remote set ${provider}\`.`;
}

/**
 * Where an upstream points: the proxy listener (its port or its socket), the
 * MAIN port, somewhere else, or nowhere recorded. A URL or a bare `host:port`
 * is read for its port; a path is compared to the socket.
 */
export function classifyUpstream(upstream: string | undefined, ctx: Pick<RemoteContext, "consolePort" | "proxyPort" | "proxySocket">): "proxy" | "main" | "other" | "none" {
  if (upstream === undefined || upstream.trim() === "") return "none";
  const u = upstream.trim();
  if (u === ctx.proxySocket || u === `unix:${ctx.proxySocket}` || u === `unix://${ctx.proxySocket}`) return "proxy";
  let port: number | undefined;
  try {
    const url = new URL(u.includes("://") ? u : `http://${u}`);
    port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  } catch {
    return "other";
  }
  if (port === ctx.consolePort) return "main";
  if (port === ctx.proxyPort) return "proxy";
  return "other";
}
