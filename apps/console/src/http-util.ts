// Tiny hand-rolled HTTP plumbing (recipes over frameworks — CLAUDE.md).
import type { IncomingMessage, ServerResponse } from "node:http";
import { errorEnvelope, formatRefusal, intEnv, statusFor, type ErrorCode, type Refusal } from "@foldedspacelabs/metistry-core";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * A refusal names the config field, the parameter or the grant that would
 * permit it (R3) — EXCEPT on the door: `unauthenticated` takes no detail, and
 * an agent-facing `forbidden` stays the canonical "not granted", because a
 * message that distinguishes "not granted" from "not found" is an oracle
 * (invariant 8). Everything below those two is the owner's own surface, where
 * a caller who cannot act on the answer is just a caller left guessing.
 */
export function sendError(res: ServerResponse, code: ErrorCode, detail?: string): void {
  sendJson(res, statusFor(code), errorEnvelope(code, code === "unauthenticated" ? undefined : detail));
}

/**
 * The responses that were "no such route" — as opposed to a route that
 * answered 404 for a row it could not find. Held in-process and never put on
 * the wire: `sendUnrouted` sends exactly what `sendError(res, "not_found",
 * detail)` would, so the mark changes nothing a caller can see. What it buys
 * is a test that can tell the two 404s apart (the client API conformance
 * test, docs/ops/client-api.md), which is how CI knows a route in the table
 * is really served.
 */
const UNROUTED = new WeakSet<ServerResponse>();

/** The one "no such route" answer. Every dispatcher's fallthrough calls this, never a bare `sendError(res, "not_found")`. */
export function sendUnrouted(res: ServerResponse, detail?: string): void {
  UNROUTED.add(res);
  sendError(res, "not_found", detail);
}

/** Whether this response was `sendUnrouted`'s. For tests; the server never branches on it. */
export function wasUnrouted(res: ServerResponse): boolean {
  return UNROUTED.has(res);
}

/**
 * A `may()` refusal onto the wire, through core's ONE renderer
 * (`formatRefusal` — §3.2 of
 * docs/research/2026-09-19-grants-and-access-simplified.md). Never
 * `sendError` with a message assembled at the call site: the envelope, the
 * canonical fallback for a refusal that says nothing, and the rule that a
 * `hide` refusal carries no `reason` are all decided in one place, for every
 * door.
 */
export function sendRefusal(res: ServerResponse, refusal: Refusal): void {
  sendJson(res, statusFor(refusal.code), formatRefusal(refusal) ?? {});
}

/**
 * The headers every answer on the PROXY listener carries (plan §2.23, X-111)
 * — set before anything else looks at the request, so a `421`, a `429`, a
 * `500` and the shell all carry them. The main listener sets none of them:
 * it speaks plain HTTP on loopback to the Mac app and the CLI, where HSTS
 * would be a lie and nothing frames anything.
 *
 *   * HSTS, a year, subdomains included, **no preload**: the owner's name is
 *     the provider's or their own, and a preload-list entry is permanent in a
 *     way a Settings change is not.
 *   * CSP for the shell as it is: scripts and connections from this origin
 *     alone; style attributes allowed because the shell writes them
 *     (`lib.js`'s bars); `data:`/`blob:` images and fonts for the artifact
 *     viewer, whose opaque-origin `srcdoc` frame inherits this policy and
 *     then narrows it further with its own; no plugins, no `<base>`, forms
 *     to this origin only, and no one may frame the console.
 *   * `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
 *     (nothing here needs to be told where a visitor came from, and no
 *     outside page needs to learn this console's paths), and
 *     `X-Frame-Options: DENY` beside the CSP's `frame-ancestors` for the
 *     browsers that read only the older header.
 */
export const PROXY_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export function setProxySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(PROXY_SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * The `429 rate_limited` answer (rate-limit.ts): the envelope, `Retry-After`
 * in whole seconds, and a message that names the window and — R3 — what
 * would permit more: signing in, since a session is never limited.
 */
export function sendRateLimited(res: ServerResponse, retryAfterS: number, scope: "client" | "global"): void {
  res.setHeader("retry-after", String(retryAfterS));
  const who = scope === "client" ? "this address has asked" : "this console has answered";
  sendJson(res, statusFor("rate_limited"), errorEnvelope("rate_limited", `${who} too often without signing in — try again in ${retryAfterS}s; a signed-in session is not limited (docs/ops/auth.md, "The proxy listener")`));
}

/** Largest request body the console will read. The default clears `capture`'s 25MB+ (PoC-7); an instance that captures bigger raises METISTRY_MAX_BODY_BYTES. */
const MAX_BODY = intEnv("METISTRY_MAX_BODY_BYTES", 32 * 1024 * 1024);

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  return JSON.parse(buf.toString("utf8"));
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return [
    `metistry_session=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
