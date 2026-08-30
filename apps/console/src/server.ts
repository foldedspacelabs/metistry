// The console API (§4.2). Every request authenticates (invariant 8); two
// credential classes: passkey sessions + host-minted owner tokens (owner),
// and — Phase 4/5 — agent tokens. Management endpoints require a passkey
// SESSION specifically: the capture Shortcut's owner token cannot manage
// devices (least privilege inside the owner class).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCheck, startRun, finishRun, type CheckResult } from "@foldedspacelabs/metistry-core";
import { QueryError, QueryStore } from "@foldedspacelabs/metistry-queries";
import type { Db } from "./auth-store.js";
import * as store from "./auth-store.js";
import type { SessionPolicy } from "./session-policy.js";
import { parseCookies, readBody, readJson, sendError, sendJson, sessionCookie } from "./http-util.js";
import * as wa from "./webauthn.js";
import { serveStatic } from "./static.js";
import { sendToSession, storeSubscription, type PushConfig } from "./push.js";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export interface ConsoleConfig {
  origin: string; // canonical HTTPS origin (§4.2)
  inboxDir: string;
  policy: SessionPolicy;
  secureCookies: boolean;
  webRoot?: string; // PWA shell dir; absent = API-only (tests)
  push?: PushConfig; // absent = push degrades absent
}

type Auth = { kind: "session"; sessionId: number } | { kind: "owner_token" } | null;

export function makeServer(db: Db, queries: QueryStore, cfg: ConsoleConfig): Server {
  const rp = wa.rpFromOrigin(cfg.origin);
  const challenges = new wa.ChallengeStore();

  async function authenticate(req: IncomingMessage): Promise<Auth> {
    const cookie = parseCookies(req)["metistry_session"];
    if (cookie) {
      const s = await store.checkSession(db, cookie, cfg.policy);
      if (s) return { kind: "session", sessionId: s.id };
    }
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
    if (m?.[1] && (await store.checkOwnerToken(db, m[1]))) return { kind: "owner_token" };
    return null;
  }

  return createServer((req, res) => {
    route(req, res).catch((err) => {
      // uniform internal error; detail stays server-side (runs/log)
      console.error(err);
      if (!res.headersSent) sendError(res, "internal");
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", cfg.origin);
    const key = `${req.method} ${url.pathname}`;

    // ----- public: the PWA shell (login page must render unauthenticated) -----
    if (req.method === "GET" && cfg.webRoot && !url.pathname.startsWith("/api/") && url.pathname !== "/health") {
      if (url.pathname === "/vendor/simplewebauthn.js") {
        // exports map hides subpaths; resolve the entry, walk to the UMD bundle
        const entry = require_.resolve("@simplewebauthn/browser");
        const bundleDir = join(entry, "..", "..", "dist", "bundle");
        if (await serveStatic(res, bundleDir, "/index.umd.min.js")) return;
      }
      if (await serveStatic(res, cfg.webRoot, url.pathname)) return;
      // fall through to API 404 handling for non-file paths
    }

    // ----- public -----
    if (key === "GET /health") {
      try {
        await db.query("SELECT 1");
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 503, { ok: false });
      }
    }

    if (key === "POST /auth/enroll/start") {
      const body = (await readJson(req)) as { code?: string };
      if (!body.code || !(await store.peekEnrollmentCode(db, body.code))) return sendError(res, "unauthenticated");
      const options = await wa.registrationOptions(rp);
      challenges.put(`enroll:${body.code}`, options.challenge);
      return sendJson(res, 200, { options });
    }

    if (key === "POST /auth/enroll/finish") {
      const body = (await readJson(req)) as { code?: string; label?: string; response?: unknown };
      const challenge = body.code ? challenges.take(`enroll:${body.code}`) : null;
      if (!body.code || !challenge) return sendError(res, "unauthenticated");
      const cred = await wa.verifyRegistration(rp, body.response, challenge);
      if (!cred || !(await store.consumeEnrollmentCode(db, body.code))) return sendError(res, "unauthenticated");
      await store.storePasskey(db, {
        id: cred.id,
        publicKey: cred.publicKey,
        signCount: cred.signCount,
        transports: cred.transports,
        origin: cfg.origin,
        label: (body.label ?? "device").slice(0, 80),
      });
      const token = await store.issueSession(db, cred.id, cfg.policy);
      await audit("auth", "enroll", true, { passkey: cred.id });
      res.setHeader("set-cookie", sessionCookie(token, cfg.policy.maxDays * 86400, cfg.secureCookies));
      return sendJson(res, 200, { ok: true });
    }

    if (key === "POST /auth/login/start") {
      const options = await wa.authenticationOptions(rp);
      const k = randomUUID();
      challenges.put(`login:${k}`, options.challenge);
      return sendJson(res, 200, { key: k, options });
    }

    if (key === "POST /auth/login/finish") {
      const body = (await readJson(req)) as { key?: string; response?: { id?: string } };
      const challenge = body.key ? challenges.take(`login:${body.key}`) : null;
      const credId = body.response?.id;
      if (!challenge || !credId) return sendError(res, "unauthenticated");
      const passkey = await store.getPasskey(db, credId);
      if (!passkey) return sendError(res, "unauthenticated"); // uniform: no existence leak
      const v = await wa.verifyAuthentication(rp, body.response, challenge, passkey);
      if (!v) return sendError(res, "unauthenticated");
      await store.touchPasskey(db, credId, v.newCounter);
      const token = await store.issueSession(db, credId, cfg.policy);
      await audit("auth", "login", true, { passkey: credId });
      res.setHeader("set-cookie", sessionCookie(token, cfg.policy.maxDays * 86400, cfg.secureCookies));
      return sendJson(res, 200, { ok: true });
    }

    // ----- everything below authenticates -----
    const auth = await authenticate(req);
    if (!auth) return sendError(res, "unauthenticated");

    if (key === "POST /capture") {
      const runId = await startRun(db, { component: "console", kind: "capture" });
      try {
        await mkdir(cfg.inboxDir, { recursive: true });
        let filename: string;
        let bytes: Buffer;
        let note: string | null = null;
        if ((req.headers["content-type"] ?? "").includes("application/json")) {
          const body = (await readJson(req)) as { note?: string; filename?: string; content_base64?: string };
          note = body.note ?? null;
          bytes = body.content_base64 ? Buffer.from(body.content_base64, "base64") : Buffer.from(note ?? "", "utf8");
          filename = body.filename ?? `note-${Date.now()}.md`;
        } else {
          bytes = await readBody(req);
          filename = String(req.headers["x-metistry-filename"] ?? `capture-${Date.now()}.bin`);
        }
        const safe = filename.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/\.{2,}/g, "_"); // no traversal
        const rel = `${Date.now()}-${safe}`;
        await writeFile(join(cfg.inboxDir, rel), bytes);
        const sha = createHash("sha256").update(bytes).digest("hex");
        const { rows } = await db.query(
          `INSERT INTO inbox (source, path, mime, note, sha256) VALUES ('http', $1, $2, $3, $4) RETURNING id`,
          [rel, req.headers["content-type"] ?? null, note, sha],
        );
        await finishRun(db, runId, { ok: true, meta: { inbox_id: rows[0]?.id, bytes: bytes.length } });
        return sendJson(res, 201, { id: rows[0]?.id, path: rel, sha256: sha });
      } catch (err) {
        await finishRun(db, runId, { ok: false, error: String(err) });
        throw err;
      }
    }

    if (key === "POST /message") {
      const body = (await readJson(req)) as { thread_id?: string; text?: string };
      if (!body.text) return sendError(res, "invalid_request");
      // Durable BEFORE the 202 (SHOULD-7)
      const { rows } = await db.query(
        `INSERT INTO inbound_messages (thread, text) VALUES ($1, $2) RETURNING id`,
        [body.thread_id ?? "default", body.text],
      );
      await audit("message", "inbound", true, { message_id: rows[0]?.id });
      return sendJson(res, 202, { message_id: rows[0]?.id });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/q/")) {
      const name = url.pathname.slice("/api/q/".length);
      try {
        const result = await queries.run(name, Object.fromEntries(url.searchParams));
        return sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof QueryError) {
          return sendError(res, err.code === "unknown_query" ? "not_found" : "invalid_request");
        }
        throw err;
      }
    }

    if (key === "GET /api/messages") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      const { rows } = await db.query(
        `SELECT id, ts, thread, text, status FROM inbound_messages ORDER BY ts DESC LIMIT $1`,
        [limit],
      );
      return sendJson(res, 200, { messages: rows });
    }

    // ----- push: bound to the device session specifically -----
    if (url.pathname.startsWith("/api/push/")) {
      if (auth.kind !== "session") return sendError(res, "forbidden");
      if (!cfg.push) return sendJson(res, 200, { push: "absent" }); // degrades: absent
      if (key === "GET /api/push/vapid-key") return sendJson(res, 200, { key: cfg.push.publicKey });
      if (key === "POST /api/push/subscribe") {
        const body = (await readJson(req)) as { subscription?: unknown };
        if (!body.subscription) return sendError(res, "invalid_request");
        await storeSubscription(db, auth.sessionId, body.subscription);
        return sendJson(res, 200, { ok: true });
      }
      if (key === "POST /api/push/test") {
        const result = await sendToSession(db, cfg.push, auth.sessionId, {
          title: "metistry",
          body: "push works — this device is reachable",
          url: "/",
        });
        return sendJson(res, 200, { result });
      }
    }

    if (key === "GET /api/status") {
      const checks: CheckResult[] = [
        await runCheck("db", "SELECT 1 round-trip", async () => {
          await db.query("SELECT 1");
        }),
        await runCheck("inbox-dir", "mkdir -p inbox dir", async () => {
          await mkdir(cfg.inboxDir, { recursive: true });
        }),
      ];
      return sendJson(res, 200, { checks, as_of: new Date().toISOString() });
    }

    // ----- management: passkey session ONLY (owner tokens excluded) -----
    if (auth.kind !== "session") {
      if (key === "GET /api/devices" || /^POST \/api\/devices\/\d+\/revoke$/.test(key) || key === "POST /auth/logout") {
        return sendError(res, "forbidden");
      }
      return sendError(res, "not_found");
    }

    if (key === "GET /api/devices") return sendJson(res, 200, { devices: await store.listDevices(db) });

    const revoke = /^POST \/api\/devices\/(\d+)\/revoke$/.exec(key);
    if (revoke) {
      const ok = await store.revokeSession(db, Number(revoke[1]));
      await audit("auth", "revoke", ok, { session: revoke[1] });
      return ok ? sendJson(res, 200, { revoked: true }) : sendError(res, "not_found");
    }

    if (key === "POST /auth/logout") {
      await store.revokeSession(db, auth.sessionId);
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, "not_found");
  }

  async function audit(kind: string, tool: string, ok: boolean, meta: Record<string, unknown>): Promise<void> {
    const id = await startRun(db, { component: "console", kind, tool, meta });
    await finishRun(db, id, { ok });
  }
}
