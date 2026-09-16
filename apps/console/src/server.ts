// The console API (§4.2). Every request authenticates (invariant 8); two
// credential classes, structurally distinct (CRIT-7): owner (passkey
// sessions, the LOCAL owner token, host-minted owner tokens) and per-agent
// bearer tokens (agents.ts). An agent token works on the agent surface
// only — /capture and the mcp-brain mount at /mcp — and is a uniform 403
// everywhere else.
//
// Inside the owner class there is one principal, `user`, and two ways to
// prove you are it: a passkey session (any client, anywhere) and
// METISTRY_LOCAL_OWNER_TOKEN presented over a connection from THIS machine — the
// Mac app and the CLI, which are the same package on the same filesystem
// (docs/ops/auth.md, local-owner.ts). `isUser()` below is the single
// predicate both take, so the two cannot drift apart. A host-minted owner
// token from the `owner_tokens` table (the capture Shortcut) is NOT that
// principal: it stays capture-only, from any address, exactly as before.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { runCheck, startRun, finishRun, errorEnvelope, rollSession, statusFor, type CheckResult, type Compute } from "@foldedspacelabs/metistry-core";
import { QueryError, QueryStore } from "@foldedspacelabs/metistry-queries";
import { captureToInbox, createBrainServer, dirSink, type CaptureSink, type KnowledgeLister, type KnowledgeReader, type KnowledgeVaultSearcher, type KnowledgeWriter, type QueryEmbedder } from "@foldedspacelabs/metistry-mcp-brain";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { artifactRoutes, isArtifactRoute } from "./artifacts-routes.js";
import type { Db } from "./auth-store.js";
import * as store from "./auth-store.js";
import * as agents from "./agents.js";
import type { SessionPolicy } from "./session-policy.js";
import { parseCookies, readBody, readJson, sendError, sendJson, sessionCookie } from "./http-util.js";
import * as wa from "./webauthn.js";
import { checkLocalOwner, type LocalOwnerConfig } from "./local-owner.js";
import { serveStatic } from "./static.js";
import type { PublicIdentity } from "./identity.js";
import { route as routeMessage, type Rules } from "./router.js";
import { sendToSession, storeSubscription, type PushConfig } from "./push.js";
import { dispatch, type TargetRegistry } from "./dispatch.js";
import { DEVIN_PURPOSES, isDevinPurpose } from "./devin.js";
import { listProjects, updateProject, validateProjectPatch } from "./projects.js";
import { applyImprovement } from "./prompt-overlay.js";
import { crewDispatcher, type CrewRegistry } from "./crews.js";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export interface ConsoleConfig {
  origin: string; // canonical HTTPS origin (§4.2)
  /** Every origin the passkey ceremonies accept, raw (METISTRY_ORIGIN, comma-separated). Absent = `origin` alone. */
  origins?: string | undefined;
  /** METISTRY_LOCAL_OWNER_TOKEN + the peer addresses that count as this machine (local-owner.ts). Absent = no local owner door at all. */
  localOwner?: LocalOwnerConfig | undefined;
  /** Fallback capture directory when no sink is injected (tests, and a console with no vault bridge). */
  inboxDir: string;
  /** Where captures land: `vaultSink(vault)` — `Knowledge/Inbox/` through the reconciler's bridge (docs/ops/inbox.md). Absent → `dirSink(inboxDir)`. */
  inbox?: CaptureSink | undefined;
  policy: SessionPolicy;
  secureCookies: boolean;
  webRoot?: string; // PWA shell dir; absent = API-only (tests)
  push?: PushConfig; // absent = push degrades absent
  rules?: Rules; // router rules; absent = everything routes to the model
  targets?: TargetRegistry; // compute targets (§4.18); absent = no dispatch surface
  /** `compute.yaml` in force (hot-reloaded). Absent = nothing assigned, so every agent is the same engine kind and rule 4 refuses nothing. */
  compute?: () => Compute;
  /** Note-content reader for mcp-brain's knowledge_read (the reconciler's vault bridge, D5); absent = not_available, exactly as before. */
  readKnowledge?: KnowledgeReader;
  /** Query embedder for mcp-brain's knowledge_search mode=semantic|hybrid (Phase 6); absent = every mode serves keyword. */
  embedder?: QueryEmbedder;
  /** Note writer for mcp-brain's knowledge_write — the assistant's brain-commit over the same bridge; absent = not_available. */
  writeKnowledge?: KnowledgeWriter;
  /** Vault listing for mcp-brain's knowledge_list (the reconciler's GET /vault/list); absent = not_available. */
  listKnowledge?: KnowledgeLister;
  /** Keyword-mode content search for mcp-brain's knowledge_grep candidate pre-filter (the reconciler's GET /vault/search?mode=keyword); absent = knowledge_grep falls back to listKnowledge for candidates. */
  searchVaultKeyword?: KnowledgeVaultSearcher;
  /** The vault client the artifacts module (§4.21) stores content through; absent = artifacts degrade to not_available. */
  vault?: VaultClient;
  /** Loaded crew manifests (crews.ts); absent = agents_delegate answers not_available. */
  crews?: CrewRegistry;
  /** identity.yaml's public fields for `GET /api/identity` (identity.ts); absent = 503 not_available. */
  identity?: PublicIdentity | undefined;
  /** What `GET /api/identity` reports as `version` — the console package's; absent = null. */
  version?: string | undefined;
}

// ----- since-cursors (docs/ops/console-api.md) -----
// A cursor is an opaque string the server minted: Postgres's own text form
// of a timestamptz (it round-trips microseconds; a JS Date does not), then
// the row's tiebreakers, `|`-joined — two rows written in one transaction
// share a `now()`, so a bare timestamp would skip the second of them. The
// client never parses it; it hands it back as `?since=`. Rows come oldest
// first when a cursor is given (a reconnect replays forward), newest first
// without one (a fresh paint), and the response always carries the cursor
// for the next call — the newest row seen, or the caller's own when there
// was nothing new.
const MAX_LIST = 100;  // limit: fixed — the API's own page ceiling, documented in docs/ops/console-api.md
function listArgs(url: URL, dflt: number): { limit: number; since: string | null } {
  const raw = Number(url.searchParams.get("limit") ?? dflt);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIST) : dflt;
  const since = url.searchParams.get("since");
  return { limit, since: since && since.trim() !== "" ? since.trim() : null };
}
/** `since` must be a cursor this server could have minted; anything else is a 400, not a silent full repaint. */
const CURSOR_TS = String.raw`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2})?|Z)?`;
const MESSAGES_CURSOR_RE = new RegExp(`^(${CURSOR_TS})\\|(in|out)\\|(\\d{1,12})$`);
const PROPOSALS_CURSOR_RE = new RegExp(`^(${CURSOR_TS})\\|(\\d{1,12})$`);
function pageOf<T extends { cursor: string }>(rows: T[], limit: number, since: string | null): { page: Omit<T, "cursor">[]; cursor: string | null; more: boolean } {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const cursors = page.map((r) => r.cursor);
  const cursor = since === null ? (cursors[0] ?? null) : (cursors[cursors.length - 1] ?? since);
  return { page: page.map(({ cursor: _c, ...r }) => r), cursor, more };
}

type Auth =
  | { kind: "session"; sessionId: number }
  | { kind: "local_owner" } // METISTRY_LOCAL_OWNER_TOKEN over a connection from this machine
  | { kind: "owner_token" } // an `owner_tokens` row (the capture Shortcut): capture-only, any address
  | { kind: "agent"; agent: agents.AgentPrincipal }
  | null;

/**
 * The `user` principal: the person, however they proved it. Everything a
 * passkey session may do, the local owner token may do — that is the whole
 * point of it — so this predicate, never a `kind === "session"` comparison,
 * is what gates the owner surface. The two exceptions are the endpoints
 * that act on a device SESSION ROW (push, logout): those need a session id,
 * and say so where they stand.
 */
function isUser(auth: Auth): boolean {
  return auth?.kind === "session" || auth?.kind === "local_owner";
}

// One shape for every per-agent verb so the management gate and the handler
// cannot drift apart. Ids are slugs; anything else falls through to 404.
const AGENT_ROUTE = /^(PUT|POST) \/api\/agents\/([a-z][a-z0-9-]{0,39})\/(grants|projects|autonomy|revoke|rotate)$/;
// Projects (§4.19 rollup, §4.21 controls): the kill switch, budget, caps. Session only — this is the user's hand.
const PROJECT_ROUTE = /^PUT \/api\/projects\/([a-z][a-z0-9-]{0,39})$/;
// Dispatch a work row to a compute target (§4.18). Body: { target, brief, sources? }.
const DISPATCH_ROUTE = /^POST \/api\/tasks\/(\d{1,12})\/dispatch$/;
// A thumbs up/down on one reply (docs/ops/reply-feedback.md). Session only —
// this is the user's own judgement, not something a script speaks for.
const FEEDBACK_ROUTE = /^(POST|DELETE) \/api\/messages\/(\d{1,12})\/feedback$/;

export function makeServer(db: Db, queries: QueryStore, cfg: ConsoleConfig): Server {
  const rp = wa.rpFromOrigin(cfg.origins ?? cfg.origin);
  // ONE capture sink for every door: POST /capture, the `/note` fast path,
  // the bridge's `capture` tool (docs/ops/inbox.md).
  const inbox = cfg.inbox ?? dirSink(cfg.inboxDir);
  const challenges = new wa.ChallengeStore();
  const tasks = new TasksService(db);
  // artifacts (§4.21): one service, adapted twice — the routes below for the user's session, the mcp-brain tools for agents
  const artifacts = cfg.vault ? new ArtifactsService(db, cfg.vault, { origin: cfg.origin, tasks }) : undefined;
  const brain = createBrainServer({
    db,
    authenticate: (req) => agents.authenticateAgent(db, req), // the same principal source as /capture
    tasks,
    inboxDir: cfg.inboxDir,
    inbox,
    readKnowledge: cfg.readKnowledge,
    embedder: cfg.embedder,
    writeKnowledge: cfg.writeKnowledge,
    listKnowledge: cfg.listKnowledge,
    searchVaultKeyword: cfg.searchVaultKeyword,
    artifacts,
    // crews (Phase 5): the dispatcher reuses dispatch.ts's policy check and lands rows through the same tasks service
    crews: cfg.crews ? crewDispatcher(db, tasks, cfg.crews, cfg.targets, cfg.compute) : undefined,
    // queries_list/queries_run: the SAME QueryStore the dashboard reads through (invariant 3, one read path)
    queries,
  });

  async function authenticate(req: IncomingMessage): Promise<Auth> {
    const cookie = parseCookies(req)["metistry_session"];
    if (cookie) {
      const s = await store.checkSession(db, cookie, cfg.policy);
      if (s) return { kind: "session", sessionId: s.id };
    }
    // The local owner token, before the database: it is a value in this
    // process's environment, so it costs no query, and its refusal from a
    // non-local address must be recorded even though the caller is told
    // nothing (the response below is the same 401 an unknown token gets).
    const local = checkLocalOwner(req, cfg.localOwner);
    if (local.verdict === "ok") return { kind: "local_owner" };
    if (local.verdict === "remote") {
      await audit("auth", "owner_token_remote", false, { remote: local.peer, reason: "the local owner token is loopback-only" });
    }
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
    if (m?.[1] && (await store.checkOwnerToken(db, m[1]))) return { kind: "owner_token" };
    const agent = await agents.authenticateAgent(db, req); // principal from the credential, never the body
    if (agent) return { kind: "agent", agent };
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
    // Who this instance is, before sign-in: the phone's picker renders a
    // name from it and recognises an origin it already has by instance_id
    // (research 2026-09-11). Public on purpose and nothing more than the
    // login page already shows — no origin, no counts, no state.
    if (key === "GET /api/identity") {
      if (!cfg.identity) return sendError(res, "not_available", "no identity is configured in this deployment — METISTRY_IDENTITY_FILES names the files to read (default seed/identity.yaml plus the instance's own)");
      return sendJson(res, 200, { ...cfg.identity, version: cfg.version ?? null, as_of: new Date().toISOString() });
    }
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
      let cred: Awaited<ReturnType<typeof wa.verifyRegistration>>;
      try {
        cred = await wa.verifyRegistration(rp, body.response, challenge);
      } catch (err) {
        // An origin mismatch is a misconfigured install, not a broken
        // console: 401 with the reason, never the 500 the library's throw
        // used to become.
        if (!(err instanceof wa.WebAuthnError)) throw err;
        await audit("auth", "enroll", false, { refused: err.reason });
        return sendJson(res, 401, errorEnvelope("unauthenticated", err.reason));
      }
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
      let v: Awaited<ReturnType<typeof wa.verifyAuthentication>>;
      try {
        v = await wa.verifyAuthentication(rp, body.response, challenge, passkey);
      } catch (err) {
        if (!(err instanceof wa.WebAuthnError)) throw err;
        await audit("auth", "login", false, { refused: err.reason });
        return sendJson(res, 401, errorEnvelope("unauthenticated", err.reason));
      }
      if (!v) return sendError(res, "unauthenticated");
      await store.touchPasskey(db, credId, v.newCounter);
      const token = await store.issueSession(db, credId, cfg.policy);
      await audit("auth", "login", true, { passkey: credId });
      res.setHeader("set-cookie", sessionCookie(token, cfg.policy.maxDays * 86400, cfg.secureCookies));
      return sendJson(res, 200, { ok: true });
    }

    // ----- mcp-brain: the one MCP surface for external agents (§4.11) -----
    // Agent bearer only; the bridge does its own 401 envelope and owns the
    // body (the MCP transport reads it), so this sits before the console's
    // authenticate/readJson. Owner credentials are not agent principals.
    if (url.pathname === "/mcp") return brain.handle(req, res);

    // ----- everything below authenticates -----
    const auth = await authenticate(req);
    if (!auth) return sendError(res, "unauthenticated");

    if (key === "POST /capture") {
      // Tier 0 (§4.11): a capture-only agent needs nothing more than this
      // endpoint. Provenance is stamped from the credential (§4.19).
      const sourceAgent = auth.kind === "agent" ? auth.agent.id : null;
      // Idempotency-Key (docs/ops/console-api.md): scoped to the credential
      // CLASS the server derived, never to anything in the request. Owner
      // tokens share one scope — they are all the owner's hand.
      const rawKey = req.headers["idempotency-key"];
      const idemKey = typeof rawKey === "string" ? rawKey.trim() : undefined;
      if (idemKey !== undefined && (idemKey === "" || idemKey.length > 200)) return sendError(res, "invalid_request");
      const idempotency = idemKey ? { principal: sourceAgent ? `agent:${sourceAgent}` : isUser(auth) ? "user" : "owner_token", key: idemKey } : undefined;
      const runId = await startRun(db, { component: "console", kind: "capture", meta: sourceAgent ? { agent: sourceAgent } : {} });
      try {
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
        // one write path for every capture door (the brain bridge's `capture` tool uses the same function)
        const r = await captureToInbox(db, inbox, { bytes, filename, mime: req.headers["content-type"] ?? null, note, source: "http", sourceAgent, idempotency });
        await finishRun(db, runId, { ok: true, meta: { inbox_id: r.id, bytes: bytes.length, ...(r.replayed ? { replayed: true } : {}) } });
        // a replay is the ORIGINAL response — same status, same id — with one header saying so
        if (r.replayed) res.setHeader("idempotency-replayed", "true");
        return sendJson(res, 201, { id: r.id, path: r.path, sha256: r.sha256 });
      } catch (err) {
        await finishRun(db, runId, { ok: false, error: String(err) });
        throw err;
      }
    }

    // ----- agent tokens stop here: uniform 403 on everything else, never 404 -----
    if (auth.kind === "agent") return sendError(res, "forbidden");

    // Who the console thinks you are. The Mac app calls this to render
    // "signed in as owner" without a passkey ceremony; it is also what
    // `metistry console whoami` and `metistry doctor` read. It says nothing
    // an authenticated caller does not already know about itself.
    if (key === "GET /api/whoami") {
      const via = auth.kind === "session" ? "passkey_session" : auth.kind === "local_owner" ? "local_owner_token" : "owner_token";
      return sendJson(res, 200, {
        principal: isUser(auth) ? "user" : "owner_token",
        via,
        management: isUser(auth),
        ...(auth.kind === "session" ? { session_id: auth.sessionId } : {}),
        origin: cfg.origin,
        as_of: new Date().toISOString(),
      });
    }

    if (key === "POST /message") {
      // `tier` is the composer's picker (a tier name from the instance's
      // `tiers:` block): an explicit choice for this message only. It applies
      // where the message would otherwise take the default tier — a command or
      // a fast path still wins, so picking "deep" never turns `/note` into a
      // model turn. An unknown name is ignored, not invented.
      const body = (await readJson(req)) as { thread_id?: string; text?: string; tier?: string };
      if (!body.text) return sendError(res, "invalid_request");
      const thread = body.thread_id ?? "default";
      const decision = cfg.rules ? routeMessage(cfg.rules, body.text, body.tier) : null;
      // Durable BEFORE the 202 (SHOULD-7). Routing decision rides in meta.
      const { rows } = await db.query(
        `INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`,
        [thread, body.text, JSON.stringify(decision ? { route: decision } : {})],
      );
      const messageId = rows[0]?.id;

      // A question the assistant is blocked on is a `decision` proposal (one
      // queue, D7): answering it in chat settles it, exactly as answering from
      // triage or a notification does. The answer text routes back to the
      // source agent as feedback (§4.19).
      const answered = await db.query(
        `UPDATE proposals SET decision = 'answered', feedback = $2, decided_at = now()
         WHERE kind = 'decision' AND decision = 'pending' AND payload->>'thread' = $1 RETURNING id`,
        [thread, body.text.slice(0, 500)],
      );
      if (answered.rows.length > 0) {
        // A settled decision is a task boundary (cost research decision 3):
        // roll the thread's session so THIS answer starts a fresh SDK session
        // rather than carrying the blocked task's context forward. The roll
        // lands before the assistant claims the row below, so the ordering is
        // the boundary, not a race.
        const roll = await rollSession(db, thread, "decision_answered");
        await audit("triage", "answered", true, {
          proposals: answered.rows.map((r: { id: number }) => r.id),
          thread,
          message_id: messageId,
          ...(roll.rolled.length > 0 ? { rolled_sessions: roll.rolled, session_turns: roll.turns } : {}),
        });
      }

      // /note: file + inbox row + instant ack — no model, no assistant (§4.1)
      if (decision?.kind === "note") {
        // the same sink as every other door, so a /note lands in the vault
        // inbox, is committed, and is visible in Obsidian like any capture
        const r = await captureToInbox(db, inbox, {
          bytes: Buffer.from(decision.text, "utf8"),
          filename: "note.md",
          mime: "text/markdown",
          note: decision.text,
          source: "note",
          sourceAgent: null,
        });
        const reply = `noted → inbox #${r.id}`;
        await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to, kind) VALUES ($1, $2, $3, 'ack')`, [
          thread, reply, messageId,
        ]);
        await db.query(`UPDATE inbound_messages SET status = 'done' WHERE id = $1`, [messageId]);
        await audit("capture", "note", true, { inbox_id: r.id, path: r.path, message_id: messageId });
        return sendJson(res, 202, { message_id: messageId, reply });
      }

      // Fast path answers here — no model, no assistant (invariant 4, PoC-8).
      if (decision?.kind === "fast_path") {
        const runId = await startRun(db, {
          component: "console",
          kind: "turn",
          tool: decision.query,
          meta: { routed_by: decision.routed_by, tier: "fast_path", message_id: messageId },
        });
        try {
          const result = await queries.run(decision.query);
          const reply = formatFastPath(decision.query, result.rows, result.as_of);
          await db.query(
            `INSERT INTO outbound_messages (thread, text, in_reply_to) VALUES ($1, $2, $3)`,
            [thread, reply, messageId],
          );
          await db.query(`UPDATE inbound_messages SET status = 'done' WHERE id = $1`, [messageId]);
          await finishRun(db, runId, { ok: true });
          return sendJson(res, 202, { message_id: messageId, reply });
        } catch (err) {
          await finishRun(db, runId, { ok: false, error: String(err) });
          // fall through: leave for the assistant rather than dropping the turn
        }
      }
      await audit("message", "inbound", true, { message_id: messageId });
      return sendJson(res, 202, { message_id: messageId });
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
      const { limit, since } = listArgs(url, 20);
      const c = since === null ? null : MESSAGES_CURSOR_RE.exec(since);
      if (since !== null && !c) return sendError(res, "invalid_request");
      // `tier` is the name the router (or a routine) put on the row — what
      // the composer chips show, so a turn's tier is visible in the thread
      // rather than only in `runs`. `changed_at` is the cursor column: an
      // outbound row moves when its feedback does, so a rating given from
      // the Mac resurfaces on the phone's next `since` pull.
      const { rows } = await db.query(
        `SELECT id, ts, thread, text, status, direction, feedback, tier, changed_at::text || '|' || direction || '|' || id AS cursor FROM (
           SELECT id, ts, thread, text, status, 'in'  AS direction, NULL::jsonb AS feedback,
                  coalesce(meta->'route'->>'tier', meta->>'tier') AS tier, ts AS changed_at
           FROM inbound_messages
           UNION ALL
           SELECT o.id, o.ts, o.thread, o.text, o.kind, 'out' AS direction,
                  CASE WHEN f.id IS NULL THEN NULL
                       ELSE jsonb_build_object('rating', f.rating, 'note', f.note, 'ts', f.ts) END,
                  NULL::text, greatest(o.ts, f.ts)
           FROM outbound_messages o LEFT JOIN reply_feedback f ON f.outbound_message_id = o.id
         ) m
         WHERE $2::text IS NULL OR (changed_at, direction, id) > ($2::timestamptz, $3::text, $4::bigint)
         ORDER BY changed_at ${since === null ? "DESC" : "ASC"}, direction ${since === null ? "DESC" : "ASC"}, id ${since === null ? "DESC" : "ASC"} LIMIT $1`,
        [limit + 1, c?.[1] ?? null, c?.[2] ?? "", c?.[3] ?? 0],
      );
      const { page, cursor, more } = pageOf(rows as ({ cursor: string } & Record<string, unknown>)[], limit, since);
      return sendJson(res, 200, { messages: page, cursor, more });
    }

    // ----- push: bound to the device session specifically -----
    if (url.pathname.startsWith("/api/push/")) {
      if (auth.kind !== "session") return sendError(res, "forbidden", "push subscriptions belong to a device session; this credential is the local owner token, which has no device to push to (docs/ops/auth.md)");
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
          title: "Metistry",
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
        await runCheck("inbox", `reach the capture sink (${inbox.describe})`, async () => {
          await inbox.check();
        }),
      ];
      return sendJson(res, 200, { checks, as_of: new Date().toISOString() });
    }

    // ----- compute targets (§4.18): the `user` principal ONLY — dispatch is outbound -----
    if (key === "GET /api/targets" || DISPATCH_ROUTE.test(key)) {
      if (!isUser(auth)) return sendError(res, "forbidden");
      if (key === "GET /api/targets") {
        return sendJson(res, 200, { targets: cfg.targets ? await cfg.targets.describe() : [], as_of: new Date().toISOString() });
      }
      const body = (await readJson(req)) as { target?: unknown; brief?: unknown; sources?: unknown; purpose?: unknown; max_acu?: unknown };
      if (typeof body.target !== "string" || typeof body.brief !== "string") return sendError(res, "invalid_request", "target and brief are required: target is a name from GET /api/targets, brief is the instruction sent to it (docs/ops/targets.md)");
      const sources = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === "string") : [];
      // `purpose` is the W6 knowledge-research brief kind (apps/console/src/devin.ts):
      // an unknown one is a refusal, not a silent fallback to `work`.
      if (body.purpose !== undefined && !isDevinPurpose(body.purpose)) return sendError(res, "invalid_request", `purpose must be one of ${DEVIN_PURPOSES.join(" | ")} — an unknown one is refused, never a silent fallback to work`);
      if (body.max_acu !== undefined && !(Number.isInteger(body.max_acu) && (body.max_acu as number) > 0)) return sendError(res, "invalid_request", "max_acu must be a positive integer — the ACU ceiling for this dispatch; omit it to take the target manifest's");
      if (!cfg.targets) return sendError(res, "not_found", "no compute targets are registered in this deployment — METISTRY_TARGETS_DIRS names the directories to load (default targets/, docs/ops/targets.md)");
      const taskId = Number(DISPATCH_ROUTE.exec(key)![1]);
      // principal is the credential class, never the body (§4.19); the data
      // policy and the runs row are dispatch()'s — nothing is decided here
      const r = await dispatch(db, cfg.targets, taskId, body.target, body.brief, "owner", sources, {
        ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
        ...(body.max_acu !== undefined ? { max_acu: body.max_acu as number } : {}),
      });
      if (r.ok) return sendJson(res, 201, { ok: true, ref: r.ref, url: r.url, run_id: r.run_id });
      return sendJson(res, statusFor(r.code), {
        ...errorEnvelope(r.code, r.message),
        ...(r.violations ? { violations: r.violations } : {}),
        ...(r.check ? { check: r.check } : {}),
      });
    }

    // ----- management: the `user` principal ONLY (capture owner tokens excluded) -----
    if (!isUser(auth)) {
      if (
        key === "GET /api/devices" ||
        /^POST \/api\/devices\/\d+\/revoke$/.test(key) ||
        key === "POST /auth/logout" ||
        key === "GET /api/proposals" ||
        /^POST \/api\/proposals\/\d+$/.test(key) ||
        FEEDBACK_ROUTE.test(key) ||
        key === "GET /api/agents" ||
        key === "POST /api/agents" ||
        AGENT_ROUTE.test(key) ||
        key === "GET /api/projects" ||
        PROJECT_ROUTE.test(key) ||
        isArtifactRoute(url.pathname)
      ) {
        return sendError(res, "forbidden");
      }
      return sendError(res, "not_found");
    }

    // ----- projects (§4.19 panel, §4.21 controls; owner session only) -----
    if (key === "GET /api/projects") {
      const { projects, as_of } = await listProjects(db, queries);
      return sendJson(res, 200, { projects, as_of });
    }
    const projectOp = PROJECT_ROUTE.exec(key);
    if (projectOp) {
      try {
        const patch = validateProjectPatch(await readJson(req));
        const project = await updateProject(db, projectOp[1]!, patch, "user"); // records runs kind project_admin itself
        return sendJson(res, 200, { ok: true, project });
      } catch (err) {
        if (err instanceof agents.AgentError) return sendError(res, err.code, err.message); // the validator already named the field; do not throw that away
        if (err instanceof SyntaxError) return sendError(res, "invalid_request", "request body is not JSON");
        throw err;
      }
    }

    // ----- artifacts + review dispatch (§4.21; owner session only) -----
    if (isArtifactRoute(url.pathname)) return artifactRoutes(req, res, url, artifacts);

    // ----- proposal triage (D7 unified table; owner session only) -----
    if (key === "GET /api/proposals") {
      const { limit, since } = listArgs(url, 200);
      const c = since === null ? null : PROPOSALS_CURSOR_RE.exec(since);
      if (since !== null && !c) return sendError(res, "invalid_request");
      // Without a cursor: the triage queue, pending only, as always. With
      // one: everything that CHANGED since — new rows and rows decided since
      // (decided_at moves the cursor), with `decision` and `decided_at` on
      // each, so a reconnect learns what was settled while it was away
      // instead of showing a stale queue.
      const { rows } = await db.query(
        since === null
          ? `SELECT id, ts, kind, source_agent, trust, payload, decision, decided_at, ts::text || '|' || id AS cursor FROM proposals
             WHERE decision = 'pending' ORDER BY ts DESC, id DESC LIMIT $1`
          : `SELECT id, ts, kind, source_agent, trust, payload, decision, decided_at, greatest(ts, decided_at)::text || '|' || id AS cursor FROM proposals
             WHERE (greatest(ts, decided_at), id) > ($2::timestamptz, $3::bigint) ORDER BY greatest(ts, decided_at) ASC, id ASC LIMIT $1`,
        since === null ? [limit + 1] : [limit + 1, c![1], c![2]],
      );
      const { page, cursor, more } = pageOf(rows as ({ cursor: string } & Record<string, unknown>)[], limit, since);
      return sendJson(res, 200, { proposals: page, cursor, more });
    }

    const triage = /^POST \/api\/proposals\/(\d+)$/.exec(key);
    if (triage) {
      const body = (await readJson(req)) as { decision?: string; feedback?: string };
      const row = (await db.query(`SELECT id, kind, payload, decision, decided_at FROM proposals WHERE id = $1`, [triage[1]])).rows[0];
      if (!row) return sendError(res, "not_found");
      // Already decided — from another device, or this one before it went
      // offline. 409 with the winner, so a client that queued an answer can
      // show what actually happened rather than "failed"
      // (docs/ops/console-api.md). No re-triage, ever.
      if (row.decision !== "pending") {
        return sendJson(res, 409, { ...errorEnvelope("conflict", "already decided"), decision: row.decision, decided_at: row.decided_at });
      }
      // A `decision` proposal (the assistant asked a blocking question) is
      // answered with one of ITS OWN options; everything else takes the three
      // triage verbs. Either way the option set comes from the stored row,
      // never from the request body.
      const options: string[] =
        row.kind === "decision" && Array.isArray(row.payload?.options)
          ? [...(row.payload.options as unknown[]).filter((o): o is string => typeof o === "string"), "deny"]
          : ["allow", "deny", "accept_with_changes"];
      if (!options.includes(body.decision ?? "")) return sendError(res, "invalid_request");

      // Allowing an `improvement` is the one self-modification path (§4.10):
      // the console writes the prompt overlay through the vault bridge as
      // principal `user` — a human change, in the user's name. It happens
      // BEFORE the row is decided, so a refused write leaves the proposal
      // pending instead of silently dropping the change.
      let applied: { path: string; created: boolean } | undefined;
      if (row.kind === "improvement" && body.decision === "allow") {
        if (!cfg.vault) return sendError(res, "not_available", "applying an improvement proposal writes assistant-prompt.md, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)");
        try {
          const r = await applyImprovement(cfg.vault, row.payload, row.id);
          applied = { path: r.path, created: r.created };
        } catch (err) {
          if (err instanceof VaultError) {
            await audit("triage", "improvement", false, { proposal: row.id, error: err.code });
            return sendJson(res, statusFor(err.code), errorEnvelope(err.code, err.message));
          }
          throw err;
        }
      }

      const { rows } = await db.query(
        `UPDATE proposals SET decision = $2, feedback = $3, decided_at = now()
         WHERE id = $1 AND decision = 'pending' RETURNING id`,
        [triage[1], body.decision, body.feedback ?? null],
      );
      await audit("triage", body.decision!, rows.length === 1, { proposal: triage[1], kind: row.kind, ...(applied ? { overlay: applied.path } : {}) });
      if (rows.length === 1) return sendJson(res, 200, { ok: true, ...(applied ? { applied } : {}) });
      // lost the race between the read above and this update: someone else decided it
      const now = (await db.query(`SELECT decision, decided_at FROM proposals WHERE id = $1`, [triage[1]])).rows[0];
      return sendJson(res, 409, { ...errorEnvelope("conflict", "already decided"), decision: now?.decision ?? null, decided_at: now?.decided_at ?? null });
    }

    // ----- reply quality: 👍/👎 on one outbound message (docs/ops/reply-feedback.md) -----
    const fb = FEEDBACK_ROUTE.exec(key);
    if (fb) {
      const id = Number(fb[2]);
      const exists = await db.query(`SELECT id FROM outbound_messages WHERE id = $1`, [id]);
      if (exists.rows.length === 0) return sendError(res, "not_found");
      if (fb[1] === "DELETE") {
        await db.query(`DELETE FROM reply_feedback WHERE outbound_message_id = $1`, [id]);
        await audit("feedback", "clear", true, { message_id: id });
        return sendJson(res, 200, { ok: true, feedback: null });
      }
      const body = (await readJson(req)) as { rating?: unknown; note?: unknown };
      if (body.rating !== 1 && body.rating !== -1) return sendError(res, "invalid_request");
      if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return sendError(res, "invalid_request");
      const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 500) : null;
      // upsert: the message row stays immutable, the judgement is revisable
      const { rows } = await db.query(
        `INSERT INTO reply_feedback (outbound_message_id, rating, note) VALUES ($1, $2, $3)
         ON CONFLICT (outbound_message_id) DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note, ts = now()
         RETURNING rating, note, ts`,
        [id, body.rating, note],
      );
      await audit("feedback", body.rating === 1 ? "up" : "down", true, { message_id: id, rating: body.rating, has_note: note !== null });
      return sendJson(res, 200, { ok: true, feedback: rows[0] });
    }

    if (key === "GET /api/devices") return sendJson(res, 200, { devices: await store.listDevices(db) });

    // ----- external-agent registry (§4.2 management surface; owner session only) -----
    if (key === "GET /api/agents") return sendJson(res, 200, { agents: await agents.listAgents(db) });

    if (key === "POST /api/agents") {
      const body = (await readJson(req)) as { id?: unknown; display_name?: unknown; kind?: unknown };
      try {
        const { id, token } = await agents.createAgent(db, body);
        await audit("agent_admin", "mint", true, { agent: id, op: "mint" });
        return sendJson(res, 201, { id, token }); // the ONE time the token crosses the wire
      } catch (err) {
        if (err instanceof agents.AgentError) return sendError(res, err.code, err.message); // the validator already named the field; do not throw that away
        throw err;
      }
    }

    const agentOp = AGENT_ROUTE.exec(key);
    if (agentOp) {
      const [, method, id, op] = agentOp as unknown as [string, string, string, string];
      const verbOk = method === "PUT" ? op === "grants" || op === "projects" || op === "autonomy" : op === "revoke" || op === "rotate";
      if (!verbOk) return sendError(res, "not_found");
      try {
        if (op === "grants") {
          // the bare vault (`Knowledge/`) is admitted for internal rows only: the rule keys on the ROW's kind, never on the request
          const row = (await agents.listAgents(db)).find((a) => a.id === id && !a.revoked);
          const grants = agents.validateGrants(await readJson(req), { kind: row?.kind === "internal" ? "internal" : "external" });
          const ok = await agents.setGrants(db, id, grants);
          await audit("agent_admin", "grant", ok, { agent: id, op: "grant", grants });
          return ok ? sendJson(res, 200, { ok: true, grants }) : sendError(res, "not_found");
        }
        if (op === "projects") {
          const body = (await readJson(req)) as { projects?: unknown };
          const projects = agents.validateProjects(body.projects);
          const ok = await agents.setProjects(db, id, projects);
          await audit("agent_admin", "projects", ok, { agent: id, op: "projects", projects });
          return ok ? sendJson(res, 200, { ok: true, projects }) : sendError(res, "not_found");
        }
        if (op === "autonomy") {
          // §4.21 narrowing, never widening: the keys can only restrict below "project members"
          const autonomy = agents.validateAutonomy(await readJson(req));
          const ok = await agents.setAutonomy(db, id, autonomy);
          await audit("agent_admin", "autonomy", ok, { agent: id, op: "autonomy", autonomy });
          return ok ? sendJson(res, 200, { ok: true, autonomy }) : sendError(res, "not_found");
        }
        if (op === "revoke") {
          const ok = await agents.revokeAgent(db, id);
          await audit("agent_admin", "revoke", ok, { agent: id, op: "revoke" });
          return ok ? sendJson(res, 200, { revoked: true }) : sendError(res, "not_found");
        }
        const token = await agents.rotateAgent(db, id);
        await audit("agent_admin", "rotate", token !== null, { agent: id, op: "rotate" });
        return token ? sendJson(res, 200, { id, token }) : sendError(res, "not_found");
      } catch (err) {
        if (err instanceof agents.AgentError) return sendError(res, err.code, err.message); // the validator already named the field; do not throw that away
        throw err;
      }
    }

    const revoke = /^POST \/api\/devices\/(\d+)\/revoke$/.exec(key);
    if (revoke) {
      const ok = await store.revokeSession(db, Number(revoke[1]));
      await audit("auth", "revoke", ok, { session: revoke[1] });
      return ok ? sendJson(res, 200, { revoked: true }) : sendError(res, "not_found");
    }

    if (key === "POST /auth/logout") {
      // Acts on the caller's own session ROW, so it needs one. The local
      // owner token has no session to end — its lifetime is the secret's.
      if (auth.kind !== "session") return sendError(res, "forbidden", "logout ends a device session row and the local owner token has none — its lifetime is the secret's (docs/ops/auth.md)");
      await store.revokeSession(db, auth.sessionId);
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, "not_found");
  }

  function formatFastPath(query: string, rows: Record<string, unknown>[], asOf: Date): string {
    const age = Math.round((Date.now() - asOf.getTime()) / 60000);
    const stamp = age < 1 ? "as of now" : `as of ${age} min ago`; // freshness stamp (§4.1)
    if (rows.length === 0) return `nothing open (${stamp})`;
    const lines = rows.slice(0, 10).map((r) => `• ${r.title ?? JSON.stringify(r)}${r.status ? ` — ${r.status}` : ""}`);
    return `${query.replaceAll("_", " ")} (${stamp}):\n${lines.join("\n")}`;
  }

  async function audit(kind: string, tool: string, ok: boolean, meta: Record<string, unknown>): Promise<void> {
    const id = await startRun(db, { component: "console", kind, tool, meta });
    await finishRun(db, id, { ok });
  }
}
