// Console routes for the artifacts module (§4.21) — an adapter over the
// one service, adding nothing. Reached ONLY by a passkey session (the
// caller has already passed the management gate in server.ts), so the
// principal here is always the user's hand. The raw-file route is the one
// place bytes leave the vault for a browser: images and PDFs render
// natively under `Cache-Control: no-store`; HTML and everything else is an
// attachment — agent-authored HTML never renders on the console origin
// (decision #14; the PWA shows it in an opaque-origin sandboxed iframe).

import type { IncomingMessage, ServerResponse } from "node:http";
import { ArtifactsError, contentTypeFor, type ArtifactsService, type Principal } from "@foldedspacelabs/metistry-artifacts";
import { errorEnvelope, statusFor } from "@foldedspacelabs/metistry-core";
import { readJson, sendError, sendJson } from "./http-util.js";

const USER: Principal = { kind: "user", id: "user" };
const ID = "[0-9A-HJKMNP-TV-Z]{26}";
const ART = new RegExp(`^/api/artifacts/(art_${ID})$`);
const VERSIONS = new RegExp(`^/api/artifacts/(art_${ID})/versions$`);
const VERSION = new RegExp(`^/api/artifacts/(art_${ID})/versions/(ver_${ID})$`);
const FILE = new RegExp(`^/api/artifacts/(art_${ID})/versions/(ver_${ID})/file$`);
const DIFF = new RegExp(`^/api/artifacts/(art_${ID})/diff$`);
const COMMENTS = new RegExp(`^/api/artifacts/(art_${ID})/comments$`);
const COMMENT_STATE = new RegExp(`^/api/artifacts/(art_${ID})/comments/(cmt_${ID})/(resolve|reopen)$`);
const DISPATCH = /^\/api\/dispatches\/(\d{1,12})$/;
const TEXT_KINDS = new Set(["markdown", "text", "json", "csv", "html"]);
const MAX_INLINE_TEXT = 2 * 1024 * 1024;  // limit: fixed — the request contract for inline file content; bigger belongs in the vault, not a body

/** True when the path belongs to this adapter (the management gate uses it to answer 403, never 404, to non-sessions). */
export function isArtifactRoute(pathname: string): boolean {
  return pathname === "/api/artifacts" || pathname.startsWith("/api/artifacts/") || pathname === "/api/dispatches" || pathname.startsWith("/api/dispatches/");
}

export async function artifactRoutes(req: IncomingMessage, res: ServerResponse, url: URL, service: ArtifactsService | undefined): Promise<void> {
  if (!service) return sendError(res, "not_available", "artifacts are not configured in this deployment — the console needs a vault bridge (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER, docs/ops/reconciler.md)");
  const key = `${req.method} ${url.pathname}`;
  const q = url.searchParams;
  const p = USER;
  try {
    if (key === "GET /api/artifacts") {
      const project = q.get("project") ?? undefined;
      const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
      return sendJson(res, 200, { artifacts: await service.list({ project, limit }, p), as_of: new Date().toISOString() });
    }
    if (key === "POST /api/artifacts") {
      const body = (await readJson(req)) as Parameters<ArtifactsService["publish"]>[0];
      const r = await service.publish(body, p);
      return sendJson(res, r.deduplicated ? 200 : 201, r);
    }
    if (key === "POST /api/dispatches") {
      const body = (await readJson(req)) as Parameters<ArtifactsService["dispatchReview"]>[0];
      const r = await service.dispatchReview(body, p);
      return r ? sendJson(res, 201, r) : sendError(res, "not_found");
    }
    let m: RegExpExecArray | null;
    if (req.method === "GET" && (m = DISPATCH.exec(url.pathname))) {
      const r = await service.bundleStatus(Number(m[1]), p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "GET" && (m = ART.exec(url.pathname))) {
      const r = await service.get(m[1]!, p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "GET" && (m = VERSIONS.exec(url.pathname))) {
      const r = await service.versions(m[1]!, p);
      return r ? sendJson(res, 200, { versions: r }) : sendError(res, "not_found");
    }
    if (req.method === "GET" && (m = VERSION.exec(url.pathname))) {
      const r = await service.version(m[1]!, m[2]!, p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "GET" && (m = FILE.exec(url.pathname))) {
      const path = q.get("path");
      if (!path) return sendError(res, "invalid_request", "?path= is required: the file inside this version to read");
      const f = await service.readFile(m[1]!, m[2]!, path, p);
      if (!f) return sendError(res, "not_found");
      if (q.get("raw") === "1") {
        const ct = contentTypeFor(f.kind, f.path);
        const name = f.path.split("/").pop()!.replace(/[^\w.-]/g, "_");
        res.writeHead(200, {
          "content-type": ct.type,
          "content-length": f.content.length,
          "content-disposition": `${ct.inline ? "inline" : "attachment"}; filename="${name}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        return void res.end(f.content);
      }
      const text = TEXT_KINDS.has(f.kind) && f.content.length <= MAX_INLINE_TEXT;
      return sendJson(res, 200, { path: f.path, kind: f.kind, sha256: f.sha256, bytes: f.content.length, ...(text ? { content: f.content.toString("utf8") } : { content_base64: f.content.toString("base64") }) });
    }
    if (req.method === "GET" && (m = DIFF.exec(url.pathname))) {
      const from = q.get("from");
      if (!from) return sendError(res, "invalid_request", "?from= is required: the version to diff from (?to= defaults to the latest)");
      const r = await service.diff(m[1]!, from, q.get("to"), p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "GET" && (m = COMMENTS.exec(url.pathname))) {
      const version = q.get("version");
      if (!version) return sendError(res, "invalid_request", "?version= is required: the artifact version whose comment threads to list");
      const r = await service.commentList(m[1]!, version, p);
      return r ? sendJson(res, 200, { threads: r }) : sendError(res, "not_found");
    }
    if (req.method === "POST" && (m = COMMENTS.exec(url.pathname))) {
      const body = (await readJson(req)) as { version?: string; body?: string; path?: string; anchor?: unknown; parent?: string };
      if (typeof body.body !== "string") return sendError(res, "invalid_request", "body is required: the comment text");
      if (body.parent) {
        const r = await service.commentReply({ parent: body.parent, body: body.body }, p);
        return r ? sendJson(res, 201, r) : sendError(res, "not_found");
      }
      if (typeof body.version !== "string") return sendError(res, "invalid_request", "version is required unless parent names the comment being replied to");
      const r = await service.commentCreate({ artifact: m[1]!, version: body.version, body: body.body, path: body.path, anchor: body.anchor }, p);
      return r ? sendJson(res, 201, { comment: r }) : sendError(res, "not_found");
    }
    if (req.method === "POST" && (m = COMMENT_STATE.exec(url.pathname))) {
      const r = m[3] === "resolve" ? await service.commentResolve(m[2]!, p) : await service.commentReopen(m[2]!, p);
      return r ? sendJson(res, 200, { comment: r }) : sendError(res, "not_found");
    }
    return sendError(res, "not_found");
  } catch (err) {
    if (err instanceof ArtifactsError) return sendJson(res, statusFor(err.code), errorEnvelope(err.code, err.message));
    if (err instanceof SyntaxError) return sendError(res, "invalid_request", "request body is not JSON");
    throw err;
  }
}
