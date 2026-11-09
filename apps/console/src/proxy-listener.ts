// The console's PROXY listener (plan §2.23, X-103) — the second place the
// console answers, for remote-access providers only.
//
// Every provider's agent — `tailscaled`, `cloudflared`, zrok, ngrok, a TLS
// terminator for a forwarded port — connects to the console from this
// machine, so on the main listener a request that crossed a tunnel is
// indistinguishable from the Mac app's: both arrive with a loopback peer, and
// the loopback-only `METISTRY_LOCAL_OWNER_TOKEN` (local-owner.ts) would be
// honoured for either — including on the `local` routes that mint agent
// bearers. The fix is not a smarter address rule (a proxy's peer address says
// nothing about where its request began) but a second listener whose every
// request is REMOTE BY CONSTRUCTION:
//
//   * a Unix socket, `<instance>/.metistry/state/console-proxy.sock`, mode
//     0600, for agents that can dial one;
//   * a loopback TCP port, `METISTRY_CONSOLE_PROXY_PORT` (default the console
//     port + 1), for the rest — Tailscale Serve documents only `http://…`
//     targets and zrok's proxy backend takes an HTTP URL.
//
// Three things hold on either, decided from the LISTENER and never from a
// header or an address (server.ts, `route`):
//
//   1. the local owner token is never honoured — `checkLocalOwner` answers
//      `remote` for it from every peer, and the refusal is audited;
//   2. no `local` route answers — `403 local_only`, whoever asks;
//   3. the request's `Host` must be a remote host `METISTRY_ORIGIN` names
//      (`remoteHostsOf`, `hostAllowed`) — anything else is `421 misdirected`.
//
// The main listener is unchanged. This module holds what is specific to the
// proxy listener: the socket's path and mode, and the Host rule.

import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { statePath } from "@foldedspacelabs/metistry-core";

export type { Listener } from "./local-owner.js";

/** `<instance>/.metistry/state/console-proxy.sock` — the socket's name, fixed so a provider adapter (X-105…) can find it without asking. */
export const PROXY_SOCKET_FILENAME = "console-proxy.sock";

/** The socket's mode: the logged-in user's processes alone may dial it. Not a cap — a permission, and the spec names it. */
export const PROXY_SOCKET_MODE = 0o600; // limit: fixed — plan §2.23 names the mode; the socket is the owner's processes' alone

export function proxySocketPath(instanceDir: string): string {
  return statePath(instanceDir, PROXY_SOCKET_FILENAME);
}

/** The host names that mean this machine — the origins `init` writes, which no proxy legitimately carries. */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "::1" || h === "[::ffff:127.0.0.1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * `host[:port]` as one comparable string: lowercase, and a default port — 80
 * or 443 — elided. Both are elided because at the proxy listener TLS has
 * already ended at the provider, so a request for `https://name` arrives as
 * plain HTTP with `Host: name` or `Host: name:443`, and neither says which
 * scheme the phone used. Any other port is part of the identity: Funnel on
 * 8443 is `name:8443`, and `name` alone does not match it.
 */
function authorityOf(hostname: string, port: string): string {
  const h = hostname.toLowerCase();
  if (port === "" || port === "80" || port === "443") return h;
  return `${h}:${port}`;
}

/**
 * The remote hosts `METISTRY_ORIGIN` configures — every entry whose host is
 * not this machine — as authorities a `Host` header can be compared to.
 * Loopback origins are skipped rather than admitted: a request for
 * `127.0.0.1` arriving through a tunnel is a misconfigured proxy, and a Host
 * the main listener would answer is exactly what the proxy listener must not.
 * Empty when the install is loopback-only (every install's default), which
 * makes the proxy listener refuse everything until a provider is chosen
 * (X-105).
 */
export function remoteHostsOf(origins: string | undefined): string[] {
  const out = new Set<string>();
  for (const raw of (origins ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue; // webauthn.ts refuses a malformed origin at startup; here it simply configures nothing
    }
    if (u.hostname === "" || isLoopbackHostname(u.hostname)) continue;
    out.add(authorityOf(u.hostname, u.port));
  }
  return [...out];
}

/** `Host` as the client sent it: a name or an IPv6 literal in brackets, with an optional port. Anything else is not a host. */
const HOST_HEADER_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._~%-]+)(?::(\d{1,5}))?$/i;

/**
 * Whether a request's `Host` names a configured remote host. Absent (an
 * HTTP/1.0 client), malformed, loopback or unlisted — refused. The comparison
 * is on the normalised authority, so `Name.ts.net:443` matches the origin
 * `https://name.ts.net` and `name.ts.net:8443` does not.
 */
export function hostAllowed(hostHeader: string | string[] | undefined, allowed: readonly string[]): boolean {
  if (typeof hostHeader !== "string" || allowed.length === 0) return false;
  const m = HOST_HEADER_RE.exec(hostHeader.trim());
  if (!m?.[1]) return false;
  const authority = authorityOf(m[1], m[2] ?? "");
  return allowed.includes(authority);
}

/**
 * Listen on the Unix socket, mode 0600 from the first instant it exists.
 *
 * The mode is set two ways on purpose. `umask` is narrowed around the bind so
 * the socket is never created wider than 0600 — `listen` binds synchronously
 * in a non-clustered process, so the window the mask covers is exactly the
 * creation — and `chmod` after `listening` is the belt to that brace, and
 * what a test reads back. A stale socket file from a console that did not
 * exit cleanly is removed first; a non-socket file at that path is refused
 * rather than deleted, because it is not ours.
 */
export function listenProxySocket(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (existsSync(path)) {
      if (!statSync(path).isSocket()) return reject(new Error(`${path} exists and is not a socket — not removing it`));
      unlinkSync(path);
    }
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    const previous = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off("error", onError);
        try {
          chmodSync(path, PROXY_SOCKET_MODE);
        } catch (err) {
          return reject(err instanceof Error ? err : new Error(String(err)));
        }
        resolve();
      });
    } finally {
      process.umask(previous);
    }
  });
}
