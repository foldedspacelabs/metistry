// The vault bridge — §4.3 wire contract over node:http: per-caller bearer
// (CRIT-9; loopback is not a trust boundary), uniform error envelope,
// behavioral check(). Reads come from the working tree; every mutation
// carries a commit intent and is queued for the sole committer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorized, errorEnvelope, runCheck, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { Vault, Outcome } from "./vault.js";
import { parseIntent } from "./vault.js";
import type { Committer } from "./committer.js";
import type { Indexer } from "./indexer.js";

export interface BridgeConfig {
  token: string;
  maxBodyBytes: number;
}

export interface BridgeDeps {
  vault: Vault;
  committer: Committer;
  /** Absent in tests that have no db: `POST /reconcile` answers not_available. */
  indexer?: Indexer | undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
function fail(res: ServerResponse, code: ErrorCode, message?: string): void {
  send(res, statusFor(code), errorEnvelope(code, message));
}
function reply<T>(res: ServerResponse, out: Outcome<T>, status = 200, shape: (v: T) => unknown = (v) => v): void {
  if (out.ok) return send(res, status, shape(out.value));
  fail(res, out.code, out.message);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function clampInt(v: string | null, fallback: number, min: number, max: number): number {
  const n = v === null || v === "" ? fallback : Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Decode the request body's content: utf8 `content` or `content_base64`, never both. */
function bodyContent(body: Record<string, unknown>): Buffer | null {
  const hasText = typeof body.content === "string";
  const hasB64 = typeof body.content_base64 === "string";
  if (hasText === hasB64) return null;
  if (hasText) return Buffer.from(body.content as string, "utf8");
  const b64 = body.content_base64 as string;
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) return null;
  return Buffer.from(b64, "base64");
}

function expectedSha(body: Record<string, unknown>): { ok: true; sha: string | undefined } | { ok: false } {
  const v = body.expected_sha256;
  if (v === undefined || v === null) return { ok: true, sha: undefined };
  if (typeof v !== "string" || !(v === "" || /^[0-9a-f]{64}$/.test(v))) return { ok: false };
  return { ok: true, sha: v };
}

export function makeBridge(deps: BridgeDeps, cfg: BridgeConfig): Server {
  const { vault, committer } = deps;
  return createServer(async (req, res) => {
    try {
      if (!authorized(req.headers.authorization, cfg.token)) return fail(res, "unauthenticated");
      const url = new URL(req.url ?? "/", "http://x");
      const key = `${req.method} ${url.pathname}`;
      const q = url.searchParams;

      if (key === "GET /check") {
        const result = await runCheck("reconciler", "instance repo present, git runs, HEAD readable, Knowledge/ listable, queue depth reported", async () => {
          if (!(await vault.git.isRepo())) throw new Error(`no git repository at ${vault.root} — set METISTRY_INSTANCE_DIR to the instance repo (docs/ops/reconciler.md)`);
          const head = await vault.git.head();
          const listed = await vault.list("Knowledge", 1);
          const meta = {
            head,
            queue_depth: committer.depth,
            last_flush: committer.lastFlush ? { at: new Date(committer.lastFlush.at).toISOString(), ...committer.lastFlush.result } : null,
            last_push: committer.lastPush ? { at: new Date(committer.lastPush.at).toISOString(), ...committer.lastPush.result } : null,
            last_reconcile: deps.indexer?.last ?? null,
          };
          if (!listed.ok) return { status: "degraded" as const, remediation: "Knowledge/ is missing from the instance repo — create it (docs/ops/reconciler.md)", meta };
          if (head === null) return { status: "degraded" as const, remediation: "repository has no commits yet — the first flushed write creates one", meta };
          if (committer.lastPush && !committer.lastPush.result.ok) {
            return { status: "degraded" as const, remediation: `last push failed: ${committer.lastPush.result.error ?? "unknown"} — check the remote/credentials; commits are safe locally`, meta };
          }
          return { meta };
        });
        return send(res, result.status === "failed" ? 503 : 200, result);
      }

      if (key === "GET /vault/read") return reply(res, await vault.read(q.get("path")));

      if (key === "GET /vault/list") {
        const depth = clampInt(q.get("depth"), 1, 1, 20);
        return reply(res, await vault.list(q.get("prefix") ?? "", depth), 200, (entries) => ({ prefix: q.get("prefix") ?? "", depth, entries }));
      }

      if (key === "GET /vault/search") {
        const term = (q.get("q") ?? "").trim();
        if (!term || term.length > 200) return fail(res, "invalid_request", "q required (≤200 chars)");
        const limit = clampInt(q.get("limit"), 20, 1, 100);
        return send(res, 200, { q: term, hits: await vault.search(term, limit) });
      }

      if (key === "GET /vault/log") {
        const limit = clampInt(q.get("limit"), 20, 1, 200);
        return reply(res, await vault.log(q.get("path"), limit), 200, (entries) => ({ path: q.get("path") ?? null, entries }));
      }

      if (key === "GET /vault/diff") return reply(res, await vault.diff(q.get("path"), q.get("from"), q.get("to")));

      if (key === "POST /vault/write" || key === "POST /vault/delete" || key === "POST /vault/rename") {
        const body = await readJson(req, cfg.maxBodyBytes);
        if (!body) return fail(res, "invalid_request", "JSON object body required (within the size cap)");
        const intent = parseIntent(body.intent);
        if (!intent.ok) return fail(res, intent.code, intent.message);
        const exp = expectedSha(body);
        if (!exp.ok) return fail(res, "invalid_request", "expected_sha256 must be 64 hex chars or empty");

        if (key === "POST /vault/write") {
          const content = bodyContent(body);
          if (!content) return fail(res, "invalid_request", "exactly one of content (utf8) or content_base64");
          const out = await vault.write(body.path, content, intent.value, exp.sha);
          return reply(res, out, out.ok && out.value.created ? 201 : 200, (v) => ({ ...v, queued: true }));
        }
        if (key === "POST /vault/delete") {
          return reply(res, await vault.delete(body.path, intent.value, exp.sha), 200, (v) => ({ ...v, deleted: true, queued: true }));
        }
        return reply(res, await vault.rename(body.from, body.to, intent.value), 200, (v) => ({ ...v, queued: true }));
      }

      if (key === "POST /flush") {
        const r = await committer.flush();
        return send(res, 200, r);
      }

      if (key === "POST /reconcile") {
        if (!deps.indexer) return fail(res, "not_available");
        return send(res, 200, await deps.indexer.reconcile("on_demand"));
      }

      return fail(res, "not_found");
    } catch (err) {
      console.error("reconciler: request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) fail(res, "internal");
    }
  });
}
