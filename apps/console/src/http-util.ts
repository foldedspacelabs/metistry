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
