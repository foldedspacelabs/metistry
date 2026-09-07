// The console API (§4.2). Every request authenticates (invariant 8); two
// credential classes, structurally distinct (CRIT-7): owner (passkey
// sessions + host-minted owner tokens) and per-agent bearer tokens
// (agents.ts). An agent token works on the agent surface only — /capture
// and the mcp-brain mount at /mcp — and is a uniform 403 everywhere else. Management
// endpoints require a passkey SESSION specifically: the capture Shortcut's
// owner token cannot manage devices or agents (least privilege inside the
// owner class).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCheck, startRun, finishRun, errorEnvelope, statusFor, type CheckResult } from "@foldedspacelabs/metistry-core";
import { QueryError, QueryStore } from "@foldedspacelabs/metistry-queries";
import { captureToInbox, createBrainServer, type KnowledgeReader, type KnowledgeWriter } from "@foldedspacelabs/metistry-mcp-brain";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { artifactRoutes, isArtifactRoute } from "./artifacts-routes.js";
import type { Db } from "./auth-store.js";
import * as store from "./auth-store.js";
import * as agents from "./agents.js";
import type { SessionPolicy } from "./session-policy.js";
import { parseCookies, readBody, readJson, sendError, sendJson, sessionCookie } from "./http-util.js";
import * as wa from "./webauthn.js";
import { serveStatic } from "./static.js";
import { route as routeMessage, type Rules } from "./router.js";
import { sendToSession, storeSubscription, type PushConfig } from "./push.js";
import { dispatch, type TargetRegistry } from "./dispatch.js";
import { listProjects, updateProject, validateProjectPatch } from "./projects.js";
import { crewDispatcher, type CrewRegistry } from "./crews.js";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export interface ConsoleConfig {
  origin: string; // canonical HTTPS origin (§4.2)
  inboxDir: string;
  policy: SessionPolicy;
  secureCookies: boolean;
  webRoot?: string; // PWA shell dir; absent = API-only (tests)
  push?: PushConfig; // absent = push degrades absent
  rules?: Rules; // router rules; absent = everything routes to the model
  targets?: TargetRegistry; // compute targets (§4.18); absent = no dispatch surface
  /** Note-content reader for mcp-brain's knowledge_read (the reconciler's vault bridge, D5); absent = not_available, exactly as before. */
  readKnowledge?: KnowledgeReader;
  /** Note writer for mcp-brain's knowledge_write — the assistant's brain-commit over the same bridge; absent = not_available. */
  writeKnowledge?: KnowledgeWriter;
  /** The vault client the artifacts module (§4.21) stores content through; absent = artifacts degrade to not_available. */
  vault?: VaultClient;
  /** Loaded crew manifests (crews.ts); absent = crew_dispatch answers not_available. */
  crews?: CrewRegistry;
}

type Auth =
  | { kind: "session"; sessionId: number }
  | { kind: "owner_token" }
  | { kind: "agent"; agent: agents.AgentPrincipal }
  | null;

// One shape for every per-agent verb so the management gate and the handler
// cannot drift apart. Ids are slugs; anything else falls through to 404.
const AGENT_ROUTE = /^(PUT|POST) \/api\/agents\/([a-z][a-z0-9-]{0,39})\/(grants|projects|autonomy|revoke|rotate)$/;
// Projects (§4.19 rollup, §4.21 controls): the kill switch, budget, caps. Session only — this is the user's hand.
const PROJECT_ROUTE = /^PUT \/api\/projects\/([a-z][a-z0-9-]{0,39})$/;
// Dispatch a work row to a compute target (§4.18). Body: { target, brief, sources? }.
const DISPATCH_ROUTE = /^POST \/api\/tasks\/(\d{1,12})\/dispatch$/;

export function makeServer(db: Db, queries: QueryStore, cfg: ConsoleConfig): Server {
  const rp = wa.rpFromOrigin(cfg.origin);
  const challenges = new wa.ChallengeStore();
  const tasks = new TasksService(db);
  // artifacts (§4.21): one service, adapted twice — the routes below for the user's session, the mcp-brain tools for agents
  const artifacts = cfg.vault ? new ArtifactsService(db, cfg.vault, { origin: cfg.origin, tasks }) : undefined;
  const brain = createBrainServer({
    db,
    authenticate: (req) => agents.authenticateAgent(db, req), // the same principal source as /capture
    tasks,
    inboxDir: cfg.inboxDir,
    readKnowledge: cfg.readKnowledge,
    writeKnowledge: cfg.writeKnowledge,
    artifacts,
    // crews (Phase 5): the dispatcher reuses dispatch.ts's policy check and lands rows through the same tasks service
    crews: cfg.crews ? crewDispatcher(db, tasks, cfg.crews, cfg.targets) : undefined,
  });

  async function authenticate(req: IncomingMessage): Promise<Auth> {
    const cookie = parseCookies(req)["metistry_session"];
    if (cookie) {
      const s = await store.checkSession(db, cookie, cfg.policy);
      if (s) return { kind: "session", sessionId: s.id };
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
        const r = await captureToInbox(db, cfg.inboxDir, { bytes, filename, mime: req.headers["content-type"] ?? null, note, source: "http", sourceAgent });
        await finishRun(db, runId, { ok: true, meta: { inbox_id: r.id, bytes: bytes.length } });
        return sendJson(res, 201, r);
      } catch (err) {
        await finishRun(db, runId, { ok: false, error: String(err) });
        throw err;
      }
    }

    // ----- agent tokens stop here: uniform 403 on everything else, never 404 -----
    if (auth.kind === "agent") return sendError(res, "forbidden");

    if (key === "POST /message") {
      const body = (await readJson(req)) as { thread_id?: string; text?: string };
      if (!body.text) return sendError(res, "invalid_request");
      const thread = body.thread_id ?? "default";
      const decision = cfg.rules ? routeMessage(cfg.rules, body.text) : null;
      // Durable BEFORE the 202 (SHOULD-7). Routing decision rides in meta.
      const { rows } = await db.query(
        `INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`,
        [thread, body.text, JSON.stringify(decision ? { route: decision } : {})],
      );
      const messageId = rows[0]?.id;

      // /note: file + inbox row + instant ack — no model, no assistant (§4.1)
      if (decision?.kind === "note") {
        await mkdir(cfg.inboxDir, { recursive: true });
        const rel = `${Date.now()}-note.md`;
        await writeFile(join(cfg.inboxDir, rel), decision.text);
        const ins = await db.query(
          `INSERT INTO inbox (source, path, mime, note) VALUES ('note', $1, 'text/markdown', $2) RETURNING id`,
          [rel, decision.text],
        );
        const reply = `noted → inbox #${ins.rows[0]?.id}`;
        await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to, kind) VALUES ($1, $2, $3, 'ack')`, [
          thread, reply, messageId,
        ]);
        await db.query(`UPDATE inbound_messages SET status = 'done' WHERE id = $1`, [messageId]);
        await audit("capture", "note", true, { inbox_id: ins.rows[0]?.id, message_id: messageId });
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
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      const { rows } = await db.query(
        `SELECT * FROM (
           SELECT id, ts, thread, text, status, 'in'  AS direction FROM inbound_messages
           UNION ALL
           SELECT id, ts, thread, text, kind,  'out' AS direction FROM outbound_messages
         ) m ORDER BY ts DESC LIMIT $1`,
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

    // ----- compute targets (§4.18): passkey session ONLY — dispatch is outbound -----
    if (key === "GET /api/targets" || DISPATCH_ROUTE.test(key)) {
      if (auth.kind !== "session") return sendError(res, "forbidden");
      if (key === "GET /api/targets") {
        return sendJson(res, 200, { targets: cfg.targets ? await cfg.targets.describe() : [], as_of: new Date().toISOString() });
      }
      const body = (await readJson(req)) as { target?: unknown; brief?: unknown; sources?: unknown };
      if (typeof body.target !== "string" || typeof body.brief !== "string") return sendError(res, "invalid_request");
      const sources = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === "string") : [];
      if (!cfg.targets) return sendError(res, "not_found");
      const taskId = Number(DISPATCH_ROUTE.exec(key)![1]);
      // principal is the credential class, never the body (§4.19); the data
      // policy and the runs row are dispatch()'s — nothing is decided here
      const r = await dispatch(db, cfg.targets, taskId, body.target, body.brief, "owner", sources);
      if (r.ok) return sendJson(res, 201, { ok: true, ref: r.ref, url: r.url, run_id: r.run_id });
      return sendJson(res, statusFor(r.code), {
        ...errorEnvelope(r.code, r.message),
        ...(r.violations ? { violations: r.violations } : {}),
        ...(r.check ? { check: r.check } : {}),
      });
    }

    // ----- management: passkey session ONLY (owner tokens excluded) -----
    if (auth.kind !== "session") {
      if (
        key === "GET /api/devices" ||
        /^POST \/api\/devices\/\d+\/revoke$/.test(key) ||
        key === "POST /auth/logout" ||
        key === "GET /api/proposals" ||
        /^POST \/api\/proposals\/\d+$/.test(key) ||
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
        if (err instanceof agents.AgentError) return sendError(res, err.code);
        if (err instanceof SyntaxError) return sendError(res, "invalid_request");
        throw err;
      }
    }

    // ----- artifacts + review dispatch (§4.21; owner session only) -----
    if (isArtifactRoute(url.pathname)) return artifactRoutes(req, res, url, artifacts);

    // ----- proposal triage (D7 unified table; owner session only) -----
    if (key === "GET /api/proposals") {
      const { rows } = await db.query(
        `SELECT id, ts, kind, source_agent, trust, payload FROM proposals
         WHERE decision = 'pending' ORDER BY ts DESC LIMIT 200`,
      );
      return sendJson(res, 200, { proposals: rows });
    }

    const triage = /^POST \/api\/proposals\/(\d+)$/.exec(key);
    if (triage) {
      const body = (await readJson(req)) as { decision?: string; feedback?: string };
      if (!["allow", "deny", "accept_with_changes"].includes(body.decision ?? "")) {
        return sendError(res, "invalid_request");
      }
      const { rows } = await db.query(
        `UPDATE proposals SET decision = $2, feedback = $3, decided_at = now()
         WHERE id = $1 AND decision = 'pending' RETURNING id`,
        [triage[1], body.decision, body.feedback ?? null],
      );
      await audit("triage", body.decision!, rows.length === 1, { proposal: triage[1] });
      return rows.length === 1 ? sendJson(res, 200, { ok: true }) : sendError(res, "not_found");
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
        if (err instanceof agents.AgentError) return sendError(res, err.code);
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
        if (err instanceof agents.AgentError) return sendError(res, err.code);
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
