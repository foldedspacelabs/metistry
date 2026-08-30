// Tiny hand-rolled HTTP plumbing (recipes over frameworks — CLAUDE.md).
import type { IncomingMessage, ServerResponse } from "node:http";
import { errorEnvelope, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function sendError(res: ServerResponse, code: ErrorCode): void {
  sendJson(res, statusFor(code), errorEnvelope(code));
}

const MAX_BODY = 32 * 1024 * 1024; // capture handles 25MB+ (PoC-7)

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
