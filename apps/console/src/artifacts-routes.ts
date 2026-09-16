// Console routes for the artifacts module (§4.21) — an adapter over the
// one service, adding nothing. That includes the rooms on `work` rows
// (0016, docs/ops/threads.md): same service, same table, and the one
// place a room is resolved, because the user's hand is the only principal
// allowed to. Reached ONLY by a passkey session (the
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
// Rooms on `work` rows (0016). The console is the USER's hand — the only
// principal that may resolve one — and the only surface that sees every
// room at once; agents reach the same threads through tasks_comment /
// tasks_thread, which have no resolve and no addressee.
const WORK_THREAD = /^\/api\/work\/(\d{1,12})\/thread$/;
const WORK_COMMENTS = /^\/api\/work\/(\d{1,12})\/comments$/;
const WORK_THREAD_STATE = /^\/api\/work\/(\d{1,12})\/thread\/(resolve|reopen)$/;
const TEXT_KINDS = new Set(["markdown", "text", "json", "csv", "html"]);
const MAX_INLINE_TEXT = 2 * 1024 * 1024;

/** True when the path belongs to this adapter — artifacts, review dispatches, and rooms on work rows (the management gate uses it to answer 403, never 404, to non-sessions). */
export function isArtifactRoute(pathname: string): boolean {
  return (
    pathname === "/api/artifacts" ||
    pathname.startsWith("/api/artifacts/") ||
    pathname === "/api/dispatches" ||
    pathname.startsWith("/api/dispatches/") ||
    pathname.startsWith("/api/work/")
  );
}

export async function artifactRoutes(req: IncomingMessage, res: ServerResponse, url: URL, service: ArtifactsService | undefined): Promise<void> {
  if (!service) return sendError(res, "not_available");
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
      if (!path) return sendError(res, "invalid_request");
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
      if (!from) return sendError(res, "invalid_request");
      const r = await service.diff(m[1]!, from, q.get("to"), p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "GET" && (m = COMMENTS.exec(url.pathname))) {
      const version = q.get("version");
      if (!version) return sendError(res, "invalid_request");
      const r = await service.commentList(m[1]!, version, p);
      return r ? sendJson(res, 200, { threads: r }) : sendError(res, "not_found");
    }
    if (req.method === "POST" && (m = COMMENTS.exec(url.pathname))) {
      const body = (await readJson(req)) as { version?: string; body?: string; path?: string; anchor?: unknown; parent?: string };
      if (typeof body.body !== "string") return sendError(res, "invalid_request");
      if (body.parent) {
        const r = await service.commentReply({ parent: body.parent, body: body.body }, p);
        return r ? sendJson(res, 201, r) : sendError(res, "not_found");
      }
      if (typeof body.version !== "string") return sendError(res, "invalid_request");
      const r = await service.commentCreate({ artifact: m[1]!, version: body.version, body: body.body, path: body.path, anchor: body.anchor }, p);
      return r ? sendJson(res, 201, { comment: r }) : sendError(res, "not_found");
    }
    // ----- rooms on work rows (0016) -----
    if (req.method === "GET" && (m = WORK_THREAD.exec(url.pathname))) {
      const r = await service.workThread(Number(m[1]), p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "POST" && (m = WORK_COMMENTS.exec(url.pathname))) {
      const body = (await readJson(req)) as { body?: string };
      if (typeof body.body !== "string") return sendError(res, "invalid_request");
      const r = await service.workComment({ work: Number(m[1]), body: body.body }, p);
      return r ? sendJson(res, 201, r) : sendError(res, "not_found");
    }
    // Resolve is here and nowhere else: no tool, no sweep, no timer. The
    // service refuses any principal but the user, so this route being the
    // only door is a property of the code rather than a convention.
    if (req.method === "POST" && (m = WORK_THREAD_STATE.exec(url.pathname))) {
      const r = m[2] === "resolve" ? await service.workThreadResolve(Number(m[1]), p) : await service.workThreadReopen(Number(m[1]), p);
      return r ? sendJson(res, 200, r) : sendError(res, "not_found");
    }
    if (req.method === "POST" && (m = COMMENT_STATE.exec(url.pathname))) {
      const r = m[3] === "resolve" ? await service.commentResolve(m[2]!, p) : await service.commentReopen(m[2]!, p);
      return r ? sendJson(res, 200, { comment: r }) : sendError(res, "not_found");
    }
    return sendError(res, "not_found");
  } catch (err) {
    if (err instanceof ArtifactsError) return sendJson(res, statusFor(err.code), errorEnvelope(err.code, err.message));
    if (err instanceof SyntaxError) return sendError(res, "invalid_request"); // malformed JSON body
    throw err;
  }
}
