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

import { AREA_PREFIX_REFUSAL, runCheck, startRun, finishRun, errorEnvelope, intEnv, parseAction, PROJECT_SLUG_RE, rollSession, statusFor, SKIP_FEEDBACK, validAreaPrefix, type CheckResult, type Compute, type ErrorEnvelope } from "@foldedspacelabs/metistry-core";
import { QueryError, QueryStore } from "@foldedspacelabs/metistry-queries";
import { captureToInbox, createBrainServer, dirSink, type CaptureSink, type KnowledgeLister, type KnowledgeReader, type KnowledgeVaultSearcher, type KnowledgeWriter, type QueryEmbedder } from "@foldedspacelabs/metistry-mcp-brain";
import { TasksError, TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { artifactRoutes, isArtifactRoute } from "./artifacts-routes.js";
import { isTaskOpRoute, taskRoutes } from "./task-routes.js";
import type { Db } from "./auth-store.js";
import * as store from "./auth-store.js";
import * as agents from "./agents.js";
import type { SessionPolicy } from "./session-policy.js";
import { parseCookies, readBody, readJson, sendError, sendJson, sessionCookie } from "./http-util.js";
import * as wa from "./webauthn.js";
import { checkLocalOwner, type LocalOwnerConfig } from "./local-owner.js";
import { serveStatic } from "./static.js";
import { capabilitiesOf, type PublicIdentity } from "./identity.js";
import { loadInstances } from "./instances.js";
import { NDJSON_CONTENT_TYPE, RUNS_EXPORT_QUERY, parseExportParams, streamRunsExport } from "./runs-export.js";
import { route as routeMessage, type Rules } from "./router.js";
import { sendToSession, storeSubscription, type PushConfig } from "./push.js";
import { dispatch, type TargetRegistry } from "./dispatch.js";
import { DEVIN_PURPOSES, isDevinPurpose } from "./devin.js";
import { listProjects, updateProject, validateProjectPatch } from "./projects.js";
import { applyImprovement } from "./prompt-overlay.js";
import { crewDispatcher, type CrewRegistry } from "./crews.js";
import { runAction, type ActionServices } from "./actions.js";
import { computeRoutes, isComputeRoute, type ComputeAdmin } from "./compute-routes.js";
import { grantedScope, isKnowledgeRoute, knowledgeRoutes, NO_SCOPE, OWNER_SCOPE, type KnowledgeScope, type KnowledgeSearcher } from "./knowledge-routes.js";
import { agentList, commandList } from "./commands.js";
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
  /** Where captures land: `vaultSink(vault)` — `Inbox/` through the reconciler's bridge (docs/ops/inbox.md). Absent → `dirSink(inboxDir)`. */
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
  /** Full-result vault search in a caller-chosen mode, for `GET /api/knowledge/search` (knowledge-routes.ts); absent = that route answers not_available. */
  searchKnowledge?: KnowledgeSearcher | undefined;
  /** What `/api/compute*` may edit: the instance repo whose `.metistry/compute.yaml` the verbs open. Absent = compute is not reachable from this console and every one of those routes answers not_available (compute-routes.ts). */
  computeAdmin?: ComputeAdmin | undefined;
  /** The vault client the artifacts module (§4.21) stores content through; absent = artifacts degrade to not_available. */
  vault?: VaultClient;
  /** Loaded crew manifests (crews.ts); absent = agents_delegate answers not_available. */
  crews?: CrewRegistry;
  /** identity.yaml's public fields for `GET /api/identity` (identity.ts); absent = 503 not_available. */
  identity?: PublicIdentity | undefined;
  /** What `GET /api/identity` reports as `version` — the console package's; absent = null. */
  version?: string | undefined;
  /**
   * Where `instances.yaml` is, for `GET /api/instances` (S4,
   * docs/ops/instances.md): the same colon-separated, last-existing-wins
   * overlay identity takes. Absent = the peer registry is not configured at
   * all and the route answers 503 (degrades: absent).
   */
  instancesFiles?: string | undefined;
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

/**
 * What this credential may see of the vault, for `/api/knowledge/*`.
 *
 * The `user` principal — a passkey session or the local owner token, the
 * same person either way — gets their own vault. A principal carrying
 * grants gets exactly what those grants say, through the one derivation
 * (`grantedScope`, which reproduces `mcp-brain`'s rule for the MCP mount).
 * Anything else gets nothing: a capture owner token is not the owner's read
 * path, and a scope function that falls back to "everything" when it does
 * not recognise a credential is a hole waiting for the next credential
 * class to be added.
 *
 * The agent branch is not reachable from this server today and is not a
 * stub: agent bearers stop at the uniform 403 above (CRIT-7) and reach
 * knowledge under their grants on `/mcp`. It is here because the derivation
 * is the thing that must be right — the day a narrower console principal is
 * minted, the scope it gets is this function's answer and not a new opinion
 * formed at the call site.
 */
function knowledgeScopeOf(auth: Auth): KnowledgeScope {
  if (isUser(auth)) return OWNER_SCOPE;
  if (auth?.kind === "agent") return grantedScope(auth.agent);
  return NO_SCOPE;
}

// One shape for every per-agent verb so the management gate and the handler
// cannot drift apart. Ids are slugs; anything else falls through to 404.
const AGENT_ROUTE = /^(PUT|POST) \/api\/agents\/([a-z][a-z0-9-]{0,39})\/(grants|projects|autonomy|revoke|rotate|approve)$/;
// Projects (§4.19 rollup, §4.21 controls): the kill switch, budget, caps. Session only — this is the user's hand.
const PROJECT_ROUTE = /^PUT \/api\/projects\/([a-z][a-z0-9-]{0,39})$/;
// Dispatch a work row to a compute target (§4.18). Body: { target, brief, sources? }.
const DISPATCH_ROUTE = /^POST \/api\/tasks\/(\d{1,12})\/dispatch$/;
// A thumbs up/down on one reply (docs/ops/reply-feedback.md). Session only —
// this is the user's own judgement, not something a script speaks for.
const FEEDBACK_ROUTE = /^(POST|DELETE) \/api\/messages\/(\d{1,12})\/feedback$/;
// One row of the ledger, in full — what a tap on an activity-feed `runs:<id>`
// opens (docs/product/app-ux-plan.md §6 phase B). Read-only, `user` principal,
// through the `run_detail` named query like every other read (invariant 3).
const RUN_DETAIL_ROUTE = /^GET \/api\/runs\/(\d{1,12})$/;
/** The named query `GET /api/runs/:id` is served from. Its ABSENCE is a refusal with a status, exactly as the export's is. */
const RUN_DETAIL_QUERY = "run_detail";

// ----- the two verbs that are not answers (docs/ops/reply-feedback.md) -----
//
// Needs You had Approve, Revise and Decline, and no way to say *not now*. An
// item you cannot answer and cannot put down stays at the top of the queue
// forever, and a queue you scroll past stops meaning "these need you"
// (docs/research/2026-09-16-taskuary-review.md ADOPT 5).
//
// `later` snoozes: the row stays pending, leaves the list, comes back by
// itself. `skip` answers "no, and there is nothing to learn from it" — it
// stores a `deny` whose feedback is exactly SKIP_FEEDBACK, which is how the
// paths that route a reason back to the source agent know to leave it alone,
// and it fires NONE of `deny`'s per-kind consequences.
const UNIVERSAL_DECISIONS = ["later", "skip"] as const;
/** What `POST /api/proposals/batch` will apply to many rows at once — see the refusal message there for why `allow` is not on it. */
const BATCH_DECISIONS = ["later", "skip", "deny"];
/** How long `later` puts something down for. Config, not a literal: "back in three hours" is an opinion about a working day. */
const SNOOZE_HOURS = intEnv("METISTRY_SNOOZE_HOURS", 3);

/**
 * The row a decision reads, plus when it last CHANGED — which is not one
 * column, because a proposal can be moved by things that are not the
 * proposal: the work row it came from, and the room hanging on that work row
 * (`artifact_comments`, migration 0018). `greatest()` over all of them is
 * what `if_unchanged` compares against.
 */
const PROPOSAL_FOR_DECISION_SQL = `
  SELECT p.id, p.ts, p.kind, p.source_agent, p.trust, p.payload, p.decision, p.feedback, p.decided_at, p.work_id, p.snoozed_until,
         greatest(
           p.ts,
           coalesce(p.decided_at, p.ts),
           coalesce(w.updated_at, p.ts),
           coalesce((SELECT max(c.created_at) FROM artifact_comments c WHERE c.work_id = p.work_id), p.ts)
         ) AS changed_at
  FROM proposals p
  LEFT JOIN work w ON w.id = p.work_id
  WHERE p.id = $1`;

/** What one answer to one proposal comes back as: a status and the body to send, so the batch caller gets an outcome rather than a socket. */
type DecisionOutcome = { status: number; body: ErrorEnvelope | Record<string, unknown> };

/** `seen_at`: the row's own `ts` as this server serialised it, or the list `cursor` it was rendered from. Anything else is a 400, never a silent decision. */
const SEEN_AT_RE = new RegExp(`^(${CURSOR_TS})(?:\\|\\d{1,12})?$`);
export function parseSeenAt(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = SEEN_AT_RE.exec(v.trim());
  if (!m?.[1]) return null;
  // pg's text form is `2026-09-11 02:18:47.001+00`; JS wants `T` and a
  // two-part offset. Neither substitution can change which instant it names.
  const iso = m[1].replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The ONE 409 shape for a decision that did not happen (the envelope #132
 * minted, plus `reason` and the row as it stands). A client branches on
 * `reason` and repaints from `proposal`; it never has to guess from the
 * message.
 */
function conflictBody(reason: "already_decided" | "stale", message: string, row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...errorEnvelope("conflict", message),
    reason,
    decision: row.decision ?? null,
    decided_at: row.decided_at ?? null,
    proposal: row,
  };
}

/** `{title, project?, kind?}` off a proposal payload, or undefined — the ONLY thing `accept_as_work` will build a row from, validated here rather than trusted. */
export function suggestedWorkOf(row: { kind?: unknown; payload?: unknown }): { title: string; project?: string; kind?: "task" | "review" } | undefined {
  if (row.kind !== "knowledge" && row.kind !== "report") return undefined;
  const p = row.payload as { suggested_work?: unknown } | null;
  const s = p?.suggested_work as { title?: unknown; project?: unknown; kind?: unknown } | undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  if (title === "" || title.length > 500) return undefined;
  const project = typeof s.project === "string" && PROJECT_SLUG_RE.test(s.project) ? s.project : undefined;
  const kind = s.kind === "review" ? ("review" as const) : s.kind === "task" || s.kind === undefined ? undefined : null;
  if (kind === null) return undefined; // an unknown kind is a refusal, never a silent fallback to `task`
  return { title, ...(project ? { project } : {}), ...(kind ? { kind } : {}) };
}

/**
 * `GET /api/q/<name>` — the generic door onto invariant 3's read path. Any
 * query whose manifest says `expose: generic` (the default), by name, with
 * its declared params and nothing else.
 *
 * **And it is the only door a query gets, unless the manifest says
 * otherwise.** A query marked `expose: route` is served by an endpoint of
 * its own that does something this one cannot — `knowledge_pages` filters
 * every row through the caller's scope — so answering it here would be that
 * filter undone rather than a convenience (ruled 2026-09-19: one endpoint
 * per necessary operation). The refusal is the UNKNOWN-QUERY refusal, byte
 * for byte: same code, same status, same absent message, so this door never
 * tells a caller which route-only queries exist. Which names those are is
 * read off the manifests through the store (`exposure`) and never matched
 * against a list kept here, which could drift from the files.
 */
export async function namedQueryDoor(res: ServerResponse, queries: QueryStore, name: string, params: Record<string, string>): Promise<void> {
  if (queries.exposure(name) !== "generic") return sendError(res, "not_found");
  try {
    return sendJson(res, 200, await queries.run(name, params));
  } catch (err) {
    if (err instanceof QueryError) {
      return sendError(res, err.code === "unknown_query" ? "not_found" : "invalid_request");
    }
    throw err;
  }
}

export function makeServer(db: Db, queries: QueryStore, cfg: ConsoleConfig): Server {
  const rp = wa.rpFromOrigin(cfg.origins ?? cfg.origin);
  // ONE capture sink for every door: POST /capture, the `/note` fast path,
  // the bridge's `capture` tool (docs/ops/inbox.md).
  const inbox = cfg.inbox ?? dirSink(cfg.inboxDir);
  const challenges = new wa.ChallengeStore();
  const tasks = new TasksService(db);
  // artifacts (§4.21): one service, adapted twice — the routes below for the user's session, the mcp-brain tools for agents
  const artifacts = cfg.vault ? new ArtifactsService(db, cfg.vault, { origin: cfg.origin, tasks }) : undefined;
  /** The services one action may reach. Read per call: `cfg.targets` and the vault bridge are hot-reloaded, and an action must follow the file rather than the process's startup. */
  const actionServices = (): ActionServices => ({ db, tasks, inbox, ...(cfg.targets ? { targets: cfg.targets } : {}), ...(artifacts ? { artifacts } : {}) });

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
    // propose_action at mode `allow` (docs/ops/actions.md): the bridge asks,
    // this console runs it — through the same service call the owner's own
    // click goes through, never a second implementation.
    actions: { execute: (action, actionCtx) => runAction(actionServices(), action, actionCtx) },
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
    //
    // `capabilities` (S1) is coarse tool-GROUP names derived from this
    // console's own wiring (identity.ts capabilitiesOf) — never tool names,
    // never counts. The full `tools/list` on /mcp stays token-gated.
    if (key === "GET /api/identity") {
      if (!cfg.identity) return sendError(res, "not_available", "no identity is configured in this deployment — METISTRY_IDENTITY_FILES names the files to read (default seed/identity.yaml plus the instance's own)");
      return sendJson(res, 200, {
        ...cfg.identity,
        capabilities: capabilitiesOf({
          hasKnowledge: cfg.readKnowledge !== undefined || cfg.listKnowledge !== undefined,
          hasArtifacts: artifacts !== undefined,
          queryCount: queries.names().length,
          targetCount: cfg.targets ? cfg.targets.names().length : 0,
        }),
        version: cfg.version ?? null,
        as_of: new Date().toISOString(),
      });
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
      return namedQueryDoor(res, queries, url.pathname.slice("/api/q/".length), Object.fromEntries(url.searchParams));
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
        key === "POST /api/proposals/batch" ||
        /^POST \/api\/proposals\/\d+$/.test(key) ||
        FEEDBACK_ROUTE.test(key) ||
        key === "GET /api/agents" ||
        key === "POST /api/agents" ||
        AGENT_ROUTE.test(key) ||
        key === "GET /api/projects" ||
        PROJECT_ROUTE.test(key) ||
        key === "GET /api/runs/export" ||
        RUN_DETAIL_ROUTE.test(key) ||
        key === "GET /api/instances" ||
        key === "GET /api/commands" ||
        // `/api/compute*` is owner-only CONFIGURATION, not an invariant-10
        // action: it changes how the system behaves, so it is the user's
        // hand and nothing else's (invariant 2). `/api/knowledge/*` is the
        // owner's read path into their own vault; an agent reaches knowledge
        // under its grants on the `/mcp` mount, never here.
        isComputeRoute(url.pathname) ||
        isKnowledgeRoute(url.pathname) ||
        isTaskOpRoute(key) ||
        isArtifactRoute(url.pathname)
      ) {
        return sendError(res, "forbidden");
      }
      return sendError(res, "not_found");
    }

    // ----- the peer registry (S4): instances.yaml, as the app and the phone read it -----
    // The file is the instance repo's and a §4.7 protected path — `metistry
    // instances` writes it through the reconciler as the user. This is the
    // read side only, and it degrades absent exactly as identity does.
    if (key === "GET /api/instances") {
      if (!cfg.instancesFiles) return sendError(res, "not_available");
      const r = await loadInstances(cfg.instancesFiles);
      if (!r.ok) {
        await audit("instances", "read", false, { errors: r.errors.slice(0, 10) });
        return sendJson(res, statusFor("invalid_request"), errorEnvelope("invalid_request", `instances.yaml does not validate: ${r.errors.join("; ")}`));
      }
      return sendJson(res, 200, { instances: r.value.instances, as_of: new Date().toISOString() });
    }

    // ----- the runs audit export (S5): NDJSON, streamed, through the named query -----
    if (key === "GET /api/runs/export") {
      const parsed = parseExportParams(url.searchParams);
      if (!parsed.ok) return sendJson(res, statusFor("invalid_request"), errorEnvelope("invalid_request", `${parsed.field} is not in the form this server mints`));
      // The named query is the read path (invariant 3), so its ABSENCE is a
      // refusal with a status, not a stream that dies after the headers.
      if (!queries.names().includes(RUNS_EXPORT_QUERY)) {
        return sendJson(res, statusFor("not_available"), errorEnvelope("not_available", `the named query ${RUNS_EXPORT_QUERY} is not loaded (seed/queries/${RUNS_EXPORT_QUERY}.yaml, METISTRY_QUERIES_DIRS)`));
      }
      const runId = await startRun(db, {
        component: "console",
        kind: "export",
        tool: "runs",
        meta: { since: parsed.params.since_ts || null, until: parsed.params.until || null, component: parsed.params.component || null },
      });
      res.writeHead(200, { "content-type": NDJSON_CONTENT_TYPE, "cache-control": "no-store" });
      try {
        const r = await streamRunsExport(queries, res, {
          params: parsed.params,
          limit: parsed.limit,
          ...(cfg.identity ? { instanceId: cfg.identity.instance_id } : {}),
        });
        await finishRun(db, runId, { ok: true, meta: { lines: r.lines, cursor: r.cursor } });
        res.end();
        return;
      } catch (err) {
        await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
        // headers are gone; an aborted chunked body is the only honest
        // "this is not the whole thing" left, and the CLI reports it
        res.destroy();
        return;
      }
    }

    // ----- one run, in full: the activity feed's drill-down (owner only) -----
    const runDetail = RUN_DETAIL_ROUTE.exec(key);
    if (runDetail) {
      if (!queries.names().includes(RUN_DETAIL_QUERY)) {
        return sendError(res, "not_available", `the named query ${RUN_DETAIL_QUERY} is not loaded (seed/queries/${RUN_DETAIL_QUERY}.yaml, METISTRY_QUERIES_DIRS)`);
      }
      const result = await queries.run(RUN_DETAIL_QUERY, { id: runDetail[1]! });
      const row = result.rows[0];
      if (!row) return sendError(res, "not_found", `no run ${runDetail[1]} in the ledger`);
      return sendJson(res, 200, { run: row, as_of: result.as_of.toISOString() });
    }

    // ----- the composer's command list, GENERATED (docs/ops/console-api.md) -----
    // rules.yaml's routes plus the agent registry — never a hand-maintained
    // array, which is what docs/product/ux-direction.md rules out. `tiers` is
    // the LIVE map: compute.yaml's assignments when it has any, else
    // rules.yaml's own block (main.ts keeps `rules.tiers` on the file in
    // force), so a reassignment shows in the menu without a restart.
    if (key === "GET /api/commands") {
      if (!cfg.rules) return sendError(res, "not_available", "no rules.yaml is loaded in this deployment — METISTRY_RULES_FILES names the files to read (default seed/rules.yaml plus the instance's own)");
      const described = new Map(queries.list().map((q) => [q.name, q.description]));
      return sendJson(res, 200, {
        commands: commandList(cfg.rules, (name) => described.get(name)),
        agents: agentList(await agents.listAgents(db)),
        as_of: new Date().toISOString(),
      });
    }

    // ----- compute (C1): owner-only configuration, never an action -----
    if (isComputeRoute(url.pathname)) {
      return computeRoutes(req, res, key, url, { admin: cfg.computeAdmin, queries, audit });
    }

    // ----- knowledge: the owner's read path into their own vault -----
    // The scope is DERIVED from the credential (`knowledgeScopeOf`), never a
    // constant at the call site: the routes' filter is only as honest as the
    // scope handed to it, and a literal here is a filter that cannot be
    // narrowed without editing this line. For the owner it comes to "every
    // vault path", which is not "every path" — the route still refuses
    // `.metistry/`, `Artifacts/` and the root CLAUDE.md, because the bridge
    // underneath it does not (knowledge-routes.ts). The page LIST gets the
    // SAME QueryStore every other read goes through — invariant 3 has one
    // read path into derived state, not one per surface, and no second,
    // unscoped door onto it (`knowledge_pages.yaml` is `expose: route`).
    if (isKnowledgeRoute(url.pathname)) {
      return knowledgeRoutes(
        req,
        res,
        key,
        url,
        { ...(cfg.searchKnowledge ? { search: cfg.searchKnowledge } : {}), ...(cfg.vault ? { vault: cfg.vault } : {}), queries },
        knowledgeScopeOf(auth),
        audit,
      );
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

    // ----- the board's drags (docs/ops/board.md; owner session only) -----
    // A thin adapter over TasksService and nothing else: every refusal comes
    // out of a WHERE clause in packages/tasks, never from a rule written here.
    if (isTaskOpRoute(key)) return taskRoutes(req, res, key, tasks, audit);

    // ----- artifacts + review dispatch (§4.21; owner session only) -----
    if (isArtifactRoute(url.pathname)) return artifactRoutes(req, res, url, artifacts);

    // ----- proposal triage (D7 unified table; owner session only) -----
    if (key === "GET /api/proposals") {
      const { limit, since } = listArgs(url, 200);
      const c = since === null ? null : PROPOSALS_CURSOR_RE.exec(since);
      if (since !== null && !c) return sendError(res, "invalid_request");
      // Without a cursor: the triage queue, pending only, as always — minus
      // anything `later` put down until an instant that has not arrived
      // (migration 0019). With one: everything that CHANGED since — new rows
      // and rows decided since (decided_at moves the cursor), with
      // `decision`, `decided_at` and `snoozed_until` on each, so a reconnect
      // learns what was settled while it was away instead of showing a stale
      // queue. A snooze deliberately does NOT move the cursor: it is a future
      // instant, and a cursor that jumped forward would skip live rows.
      const { rows } = await db.query(
        since === null
          ? `SELECT id, ts, kind, source_agent, trust, payload, decision, decided_at, work_id, snoozed_until, ts::text || '|' || id AS cursor FROM proposals
             WHERE decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now()) ORDER BY ts DESC, id DESC LIMIT $1`
          : `SELECT id, ts, kind, source_agent, trust, payload, decision, decided_at, work_id, snoozed_until, greatest(ts, decided_at)::text || '|' || id AS cursor FROM proposals
             WHERE (greatest(ts, decided_at), id) > ($2::timestamptz, $3::bigint) ORDER BY greatest(ts, decided_at) ASC, id ASC LIMIT $1`,
        since === null ? [limit + 1] : [limit + 1, c![1], c![2]],
      );
      const { page, cursor, more } = pageOf(rows as ({ cursor: string } & Record<string, unknown>)[], limit, since);
      return sendJson(res, 200, { proposals: page, cursor, more });
    }

    // One verb to many rows (docs/ops/reply-feedback.md). All-or-nothing PER
    // ROW — each id is its own atomic statement and its own result — because
    // the alternative is a batch that refuses everything because one item was
    // answered on the phone thirty seconds ago.
    if (key === "POST /api/proposals/batch") {
      const body = (await readJson(req)) as { ids?: unknown; decision?: unknown; feedback?: unknown };
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_LIST) {
        return sendError(res, "invalid_request", `ids must be an array of 1..${MAX_LIST} proposal ids`);
      }
      const ids = [...new Set(body.ids)];
      if (!ids.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)) return sendError(res, "invalid_request", "ids must be positive integers");
      if (typeof body.decision !== "string" || !BATCH_DECISIONS.includes(body.decision)) {
        return sendError(res, "invalid_request", `decision must be one of ${BATCH_DECISIONS.join(" | ")} — the verbs that need nothing from the individual row. allow, accept_with_changes and accept_as_work each do something per kind (a prompt overlay write, a work row), so they stay one at a time`);
      }
      if (body.feedback !== undefined && typeof body.feedback !== "string") return sendError(res, "invalid_request", "feedback must be a string");
      const results: Record<string, unknown>[] = [];
      for (const id of ids as number[]) {
        const r = await decideProposal(String(id), { decision: body.decision, ...(typeof body.feedback === "string" ? { feedback: body.feedback } : {}) });
        results.push({ id, ok: r.status === 200, ...(r.body as Record<string, unknown>) });
      }
      await audit("triage", `batch:${body.decision}`, results.every((r) => r.ok === true), { proposals: ids, applied: results.filter((r) => r.ok === true).length, of: ids.length });
      return sendJson(res, 200, { results });
    }

    const triage = /^POST \/api\/proposals\/(\d+)$/.exec(key);
    if (triage) {
      const body = (await readJson(req)) as { decision?: string; feedback?: string; area?: unknown; if_unchanged?: { seen_at?: unknown } };
      const r = await decideProposal(triage[1]!, body);
      return sendJson(res, r.status, r.body);
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
    // The registry, plus what has been ASKED for (ruled 2026-09-19): the
    // panel where a grant is edited is where the ask belongs, not only in
    // Needs You. `proposal_id` is the row to answer, so a client that wants
    // to act sends it to `POST /api/proposals/:id` — this list is a view,
    // never a second door onto granting.
    if (key === "GET /api/agents") {
      return sendJson(res, 200, { agents: await agents.listAgents(db), access_requests: await agents.pendingAccessRequests(db) });
    }

    if (key === "POST /api/agents") {
      const body = (await readJson(req)) as { id?: unknown; display_name?: unknown; kind?: unknown; remote?: unknown };
      try {
        const { id, token, pending } = await agents.createAgent(db, body);
        // S2: a remote enrolment starts pending and asks the owner, in the
        // one queue that needs the user (D7). The token is returned here
        // all the same — the console shows a token exactly once — and it
        // authenticates nothing until the answer arrives.
        const proposalId = pending ? await agents.enrollmentProposal(db, { id, display_name: String(body.display_name) }) : undefined;
        await audit("agent_admin", "mint", true, { agent: id, op: "mint", remote: pending, ...(proposalId ? { proposal: proposalId } : {}) });
        return sendJson(res, 201, { id, token, pending, ...(proposalId ? { proposal_id: proposalId } : {}) }); // the ONE time the token crosses the wire
      } catch (err) {
        if (err instanceof agents.AgentError) return sendError(res, err.code, err.message); // the validator already named the field; do not throw that away
        throw err;
      }
    }

    const agentOp = AGENT_ROUTE.exec(key);
    if (agentOp) {
      const [, method, id, op] = agentOp as unknown as [string, string, string, string];
      const verbOk = method === "PUT" ? op === "grants" || op === "projects" || op === "autonomy" : op === "revoke" || op === "rotate" || op === "approve";
      if (!verbOk) return sendError(res, "not_found");
      try {
        if (op === "grants") {
          const { ok, grants } = await writeGrants(id, await readJson(req), "console");
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
          // The §4.21 keys narrow and only narrow. `level` / `actions` (A3,
          // docs/ops/actions.md) may go the other way — and THIS route is the
          // door that permits it, because it is reached by the `user`
          // principal alone (the management gate above). The store refuses a
          // widening from anyone who does not say so, so the permission lives
          // in one call rather than in a comment.
          const autonomy = agents.validateAutonomy(await readJson(req));
          const r = await agents.setAutonomy(db, id, autonomy, { allowWidening: true });
          await audit("agent_admin", "autonomy", r.ok, { agent: id, op: "autonomy", autonomy, ...(r.widened.length ? { widened: r.widened } : {}) });
          // A raised bar is never silent: its own runs row and one alert.
          await agents.recordWidening(db, id, r.widened, "console");
          return r.ok
            ? sendJson(res, 200, { ok: true, autonomy, actions: agents.autonomyTable(autonomy), ...(r.widened.length ? { widened: r.widened } : {}) })
            : sendError(res, "not_found");
        }
        if (op === "approve") {
          // S2: the owner's hand on a pending enrolment (invariant 2 — the
          // credential surface is never an agent's to widen). Idempotent,
          // and it settles the Needs You item in the same breath so the two
          // doors onto the same answer cannot drift.
          const ok = await agents.approveAgent(db, id);
          const settled = ok ? await agents.settleEnrollment(db, id, "approve") : [];
          await audit("agent_admin", "approve", ok, { agent: id, op: "approve", ...(settled.length ? { proposals: settled } : {}) });
          return ok ? sendJson(res, 200, { approved: true, ...(settled.length ? { proposals: settled } : {}) }) : sendError(res, "not_found");
        }
        if (op === "revoke") {
          const ok = await agents.revokeAgent(db, id);
          // a revoked row is no longer a question: settle any enrolment still
          // asking about it, and any access request it raised — a token that
          // authenticates nothing cannot be granted anything, so the only
          // honest answer to its pending asks is the one revocation just gave
          // (agents.ts's `settleAccessRequests`).
          const settled = ok ? await agents.settleEnrollment(db, id, "deny") : [];
          const asks = ok ? await agents.settleAccessRequests(db, id) : [];
          await audit("agent_admin", "revoke", ok, { agent: id, op: "revoke", ...(settled.length ? { proposals: settled } : {}), ...(asks.length ? { access_requests: asks } : {}) });
          return ok ? sendJson(res, 200, { revoked: true, ...(asks.length ? { access_requests: asks } : {}) }) : sendError(res, "not_found");
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

  /**
   * **The one grants write.** `PUT /api/agents/:id/grants` (the owner's own
   * hand, below) and an approved `access_request` (the triage branch in
   * `decideProposal`) both come through here, so there is one validator, one
   * store call and one `agent_admin` audit row for a widening however it was
   * reached. That is what invariant 10 means by "a door onto an existing
   * audited service": the queue's Approve is not a second implementation of
   * granting, it is the same one with `via: triage` on the record.
   *
   * The bare vault (`/`) stays admissible for internal rows only, and the
   * rule keys on the ROW's kind rather than on anything in the request.
   */
  async function writeGrants(id: string, input: unknown, via: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; grants: agents.Grants }> {
    const row = (await agents.listAgents(db)).find((a) => a.id === id && !a.revoked);
    const grants = agents.validateGrants(input, { kind: row?.kind === "internal" ? "internal" : "external" });
    const ok = row === undefined ? false : await agents.setGrants(db, id, grants);
    await audit("agent_admin", "grant", ok, { agent: id, op: "grant", grants, via, ...extra });
    return { ok, grants };
  }

  /**
   * One answer to one proposal. Extracted so the single route and the batch
   * route cannot drift: a verb must not mean two things depending on which
   * door it came through — the same reason answering an enrolment from Needs
   * You does exactly what the registry pane's Approve does.
   *
   * Returns a status and a body rather than writing the response, because
   * the batch caller needs the outcome, not a socket.
   */
  async function decideProposal(
    id: string,
    body: { decision?: string; feedback?: string; area?: unknown; if_unchanged?: { seen_at?: unknown } },
  ): Promise<DecisionOutcome> {
    const row = (await db.query(PROPOSAL_FOR_DECISION_SQL, [id])).rows[0];
    if (!row) return { status: 404, body: errorEnvelope("not_found", "not found") };
    // Already decided — from another device, or this one before it went
    // offline. 409 with the winner, so a client that queued an answer can
    // show what actually happened rather than "failed"
    // (docs/ops/console-api.md). No re-triage, ever.
    if (row.decision !== "pending") return { status: 409, body: conflictBody("already_decided", "already decided", row) };

    // Decide-time staleness (ADOPT 3). The client sends the `ts`/cursor of the
    // row it RENDERED; if the row moved after that — its payload was
    // rewritten, a comment landed in the linked work row's room, the work row
    // itself moved — the answer was given to a different question, so it is
    // refused and the current row comes back instead. Opt-in: a caller that
    // sends nothing gets exactly the old behaviour.
    if (body.if_unchanged !== undefined) {
      if (body.if_unchanged === null || typeof body.if_unchanged !== "object") {
        return { status: 400, body: errorEnvelope("invalid_request", "if_unchanged must be an object: {seen_at}") };
      }
      const seen = parseSeenAt(body.if_unchanged.seen_at);
      if (seen === null) {
        return { status: 400, body: errorEnvelope("invalid_request", "if_unchanged.seen_at must be a timestamp this server minted — the `ts` of the row you rendered, or the list `cursor` you rendered it from") };
      }
      if (new Date(row.changed_at as string).getTime() > seen.getTime()) {
        await audit("triage", "stale", false, { proposal: row.id, kind: row.kind, seen_at: seen.toISOString() });
        return { status: 409, body: conflictBody("stale", "the proposal changed after you saw it", row) };
      }
    }

    // A `decision` proposal (the assistant asked a blocking question) is
    // answered with one of ITS OWN options; everything else takes the three
    // triage verbs. `later` and `skip` are valid for every kind, and
    // `accept_as_work` appears only where the row carries a suggestion.
    // Either way the option set comes from the stored row, never from the
    // request body.
    const suggested = suggestedWorkOf(row);
    const options: string[] = [
      ...(row.kind === "decision" && Array.isArray(row.payload?.options)
        ? [...(row.payload.options as unknown[]).filter((o): o is string => typeof o === "string"), "deny"]
        : ["allow", "deny", "accept_with_changes"]),
      ...UNIVERSAL_DECISIONS,
      ...(suggested ? ["accept_as_work"] : []),
    ];
    const verb = body.decision ?? "";
    if (!options.includes(verb)) return { status: 400, body: errorEnvelope("invalid_request", "invalid request") };

    // `later` is not an answer: the row keeps `decision = 'pending'` and gets
    // an `until`. It leaves the queue, it comes back on its own, and nothing
    // downstream ever sees a decision the user did not make.
    if (verb === "later") {
      const { rows } = await db.query(
        `UPDATE proposals SET snoozed_until = now() + make_interval(hours => $2)
         WHERE id = $1 AND decision = 'pending' RETURNING snoozed_until`,
        [id, SNOOZE_HOURS],
      );
      await audit("triage", "later", rows.length === 1, { proposal: row.id, kind: row.kind, hours: SNOOZE_HOURS });
      if (rows.length === 1) return { status: 200, body: { ok: true, snoozed_until: rows[0]!.snoozed_until } };
      return { status: 409, body: conflictBody("already_decided", "already decided", (await db.query(PROPOSAL_FOR_DECISION_SQL, [id])).rows[0] ?? row) };
    }

    // Allowing an `improvement` is the one self-modification path (§4.10):
    // the console writes the prompt overlay through the vault bridge as
    // principal `user` — a human change, in the user's name. It happens
    // BEFORE the row is decided, so a refused write leaves the proposal
    // pending instead of silently dropping the change.
    let applied: { path: string; created: boolean } | undefined;
    if (row.kind === "improvement" && verb === "allow") {
      if (!cfg.vault) return { status: statusFor("not_available"), body: errorEnvelope("not_available", "applying an improvement proposal writes assistant-prompt.md, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)") };
      try {
        const r = await applyImprovement(cfg.vault, row.payload, row.id);
        applied = { path: r.path, created: r.created };
      } catch (err) {
        if (err instanceof VaultError) {
          await audit("triage", "improvement", false, { proposal: row.id, error: err.code });
          return { status: statusFor(err.code), body: errorEnvelope(err.code, err.message) };
        }
        throw err;
      }
    }

    // Allowing an `action` is the second executable verb (ADOPT 6,
    // docs/ops/actions.md). Like the improvement path above it runs BEFORE
    // the row is decided, so a refusal leaves the proposal pending with the
    // error on it rather than settling a decision that did nothing. The
    // action itself is re-validated from the STORED payload — an `action`
    // row whose payload was written by an older build, or by hand, is a 400
    // naming the field, never a best-effort execution.
    let acted: Record<string, unknown> | undefined;
    if (row.kind === "action" && verb === "allow") {
      const parsed = parseAction((row.payload as { action?: unknown } | null)?.action);
      if (!parsed.ok) {
        await audit("triage", "action", false, { proposal: row.id, error: parsed.error });
        return { status: statusFor("invalid_request"), body: errorEnvelope("invalid_request", `this proposal does not carry a valid action — ${parsed.error}`) };
      }
      const r = await runAction(actionServices(), parsed.action, { proposalId: Number(row.id), onBehalfOf: String(row.source_agent) });
      if (!r.ok) {
        // the row stays pending, carrying why: the user still has a decision
        await db.query(
          `UPDATE proposals SET payload = payload || jsonb_build_object('error', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
          [id, JSON.stringify({ code: r.code, message: r.message, at: new Date().toISOString(), ...(r.details ?? {}) })],
        );
        await audit("triage", `action:${parsed.action.kind}`, false, { proposal: row.id, action: parsed.action.kind, on_behalf_of: row.source_agent, error: r.code });
        return { status: statusFor(r.code), body: { ...errorEnvelope(r.code, r.message), ...(r.details ?? {}) } };
      }
      acted = { kind: parsed.action.kind, ...r.result };
      await db.query(
        `UPDATE proposals SET payload = payload || jsonb_build_object('result', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
        [id, JSON.stringify({ ...r.result, at: new Date().toISOString(), by: "user", on_behalf_of: row.source_agent })],
      );
      await audit("triage", `action:${parsed.action.kind}`, true, { proposal: row.id, action: parsed.action.kind, on_behalf_of: row.source_agent });
    }

    // Approve as work (ADOPT 2). The click is what creates the row — §4.12
    // is intact because a human clicked, and this is the *only* difference
    // from `allow`: the drain still creates nothing, the crews still create
    // nothing, and a suggestion nobody accepts stays a suggestion. The row
    // is born OWNER-LESS and unclaimed: any agent may take it (collaboration
    // rule 4), because addressing it to someone would be a second decision
    // nobody made. Created before the proposal is settled, for the same
    // reason the overlay write is, and keyed on the proposal id so a
    // double-tap cannot make two.
    let created: { id: number; title: string; project: string | null } | undefined;
    if (verb === "accept_as_work") {
      try {
        const t = await tasks.create(
          {
            title: suggested!.title,
            ...(suggested!.project ? { project: suggested!.project } : {}),
            ...(suggested!.kind ? { kind: suggested!.kind } : {}),
            idempotency_key: `proposal:${row.id}`,
            note: `accepted as work from Needs You (proposal #${row.id})`,
          },
          "user",
        );
        created = { id: t.id, title: t.title, project: t.project };
      } catch (err) {
        if (err instanceof TasksError) {
          await audit("triage", "accept_as_work", false, { proposal: row.id, error: err.code });
          return { status: statusFor(err.code === "conflict" ? "conflict" : "invalid_request"), body: errorEnvelope(err.code === "conflict" ? "conflict" : "invalid_request", err.message) };
        }
        throw err;
      }
    }

    // An enrolment request (S2) answered from the queue does the same
    // thing POST /api/agents/:id/approve does — one behaviour, reached
    // two ways, so answering on the phone and answering in the registry
    // pane cannot mean different things. `deny` revokes: a token nobody
    // let in has no reason to keep existing, and revocation is the
    // permanent verb the registry already has. `skip` does not: that is
    // the whole difference between putting something down and answering it.
    let enrolled: { agent: string; approved: boolean } | undefined;
    const enrollAgent = row.kind === "decision" ? agents.enrollTarget(row.payload) : undefined;
    if (enrollAgent !== undefined && (verb === "approve" || verb === "deny")) {
      const approved = verb === "approve";
      const ok = approved ? await agents.approveAgent(db, enrollAgent) : await agents.revokeAgent(db, enrollAgent);
      await audit("agent_admin", approved ? "approve" : "revoke", ok, { agent: enrollAgent, op: approved ? "approve" : "revoke", via: "triage", proposal: row.id });
      enrolled = { agent: enrollAgent, approved };
    }

    // An `access_request` (ruled 2026-09-19) is answered with the three verbs
    // every other request takes, and Approve is a DOOR onto the grants
    // service, not a new one: `writeGrants` above is literally the call `PUT
    // /api/agents/:id/grants` makes, with the same validator and the same
    // `agent_admin` row, `via: triage` on it. Revise is the same door with
    // the owner's own prefix — usually narrower than the one asked for —
    // instead of the requested one. Decline does nothing at all, which is
    // the point: the row records a refusal and no grant moves.
    //
    // Like the improvement and action paths above it, this runs BEFORE the
    // row is settled, so a refusal leaves the request pending with the reason
    // rather than closing a decision that granted nothing.
    let granted: { agent: string; area: string; grants: agents.Grants } | undefined;
    if (row.kind === agents.ACCESS_REQUEST_KIND && (verb === "allow" || verb === "accept_with_changes")) {
      const asked = agents.accessArea(row.payload);
      if (asked === undefined) {
        await audit("triage", "access_request", false, { proposal: row.id, error: "no_area" });
        return { status: statusFor("invalid_request"), body: errorEnvelope("invalid_request", "this request does not name a vault area this console would grant — Decline it (the asking tool validates the prefix, so a row without one was not written by request_access)") };
      }
      // Revise carries the prefix the owner is granting INSTEAD. It is
      // validated here with the grant validator's own rule, so the narrowing
      // gesture cannot smuggle in a shape the form would have refused.
      const area = verb === "accept_with_changes" ? (typeof body.area === "string" ? body.area.trim() : "") : asked;
      if (verb === "accept_with_changes" && !validAreaPrefix(area)) {
        return { status: statusFor("invalid_request"), body: errorEnvelope("invalid_request", `revising an access request means granting a different area: send {"area": "…"} with it — ${AREA_PREFIX_REFUSAL}. To refuse it outright, Decline.`) };
      }
      const target = String(row.source_agent);
      const current = (await agents.listAgents(db)).find((a) => a.id === target && !a.revoked);
      // A row whose grants are CONFIGURATION cannot be widened from here: an
      // internal row is re-synced from the environment on every console start
      // and a crew row from its manifest on every crew sync, so an approval
      // would vanish at the next one — and the owner would believe they had
      // granted it. `request_access` refuses an internal principal at the tool
      // and no crew's allowlist carries it (core's CREW_NEVER_TOOLS); this is
      // the same rule at the door where the grant would actually move.
      if (current && current.kind !== "external") {
        await audit("triage", "access_request", false, { proposal: row.id, agent: target, error: "configured_scope" });
        const where = current.kind === "internal" ? "METISTRY_ASSISTANT_AREAS in your .env" : `its manifest (\`scope:\` in agents/<area>/${target}.md)`;
        return {
          status: statusFor("forbidden"),
          body: errorEnvelope("forbidden", `${target}'s scope is configuration, not a grant: it is re-synced from ${where}, so approving this would be undone at the next start. Decline this request and edit that file (docs/ops/actions.md).`),
        };
      }
      if (!current) {
        // A revoked (or vanished) agent cannot be granted anything: its token
        // authenticates nothing, so a widening would be a grant to nobody
        // that still reads as a grant in the registry. The row stays pending
        // and Decline is right there. (Revocation itself settles pending asks
        // — agents.ts's `settleAccessRequests` — so this is the row that
        // predates that, or a race with it.)
        await audit("triage", "access_request", false, { proposal: row.id, agent: target, error: "revoked" });
        return { status: statusFor("not_found"), body: errorEnvelope("not_found", `${target} is revoked or no longer registered — there is nothing to widen. Decline or Skip this request.`) };
      }
      try {
        const { ok, grants } = await writeGrants(target, agents.widenedGrants(current.grants, area), "triage", { proposal: row.id, area, ...(area === asked ? {} : { asked }) });
        if (!ok) return { status: statusFor("not_found"), body: errorEnvelope("not_found", `${target} is revoked or no longer registered — there is nothing to widen. Decline or Skip this request.`) };
        granted = { agent: target, area, grants };
      } catch (err) {
        if (err instanceof agents.AgentError) {
          await audit("triage", "access_request", false, { proposal: row.id, agent: target, error: err.code });
          return { status: statusFor(err.code), body: errorEnvelope(err.code, err.message) };
        }
        throw err;
      }
      // The outcome rides on the row, as the action path's does: what was
      // granted, to whom, by whom, and what was asked for when they differ.
      await db.query(
        `UPDATE proposals SET payload = payload || jsonb_build_object('granted', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
        [id, JSON.stringify({ area, grants: granted.grants, at: new Date().toISOString(), by: "user" })],
      );
    }

    // What lands in the row: `skip` stores a `deny` whose feedback is the
    // fixed marker (never the user's words — a skip is not a reason, and
    // SKIP_FEEDBACK is what keeps it out of the paths that route feedback
    // back to the source agent), `accept_as_work` stores an `allow` and the
    // work id it just created.
    const storedDecision = verb === "skip" ? "deny" : verb === "accept_as_work" ? "allow" : verb;
    const storedFeedback = verb === "skip" ? SKIP_FEEDBACK : (body.feedback ?? null);
    const { rows } = await db.query(
      `UPDATE proposals SET decision = $2, feedback = $3, decided_at = now(), snoozed_until = NULL,
              work_id = coalesce($4::bigint, work_id)
       WHERE id = $1 AND decision = 'pending' RETURNING id`,
      [id, storedDecision, storedFeedback, created ? created.id : null],
    );
    await audit("triage", verb, rows.length === 1, {
      proposal: row.id,
      kind: row.kind,
      ...(applied ? { overlay: applied.path } : {}),
      ...(created ? { work_id: created.id } : {}),
      ...(acted ? { action: acted.kind } : {}),
      ...(granted ? { granted: granted.area, agent: granted.agent } : {}),
    });
    if (rows.length === 1) {
      return { status: 200, body: { ok: true, ...(applied ? { applied } : {}), ...(enrolled ? { enrolled } : {}), ...(created ? { work: created } : {}), ...(acted ? { action: acted } : {}), ...(granted ? { granted } : {}) } };
    }
    // lost the race between the read above and this update: someone else decided it
    const now = (await db.query(PROPOSAL_FOR_DECISION_SQL, [id])).rows[0];
    return { status: 409, body: conflictBody("already_decided", "already decided", now ?? row) };
  }
}
