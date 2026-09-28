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

import { API_VERSION, API_VERSION_HEADER, AREA_PREFIX_REFUSAL, knowledgeConflictSource, runCheck, startRun, finishRun, errorEnvelope, intEnv, may, parseAction, noRouteMessage, PROJECT_SLUG_RE, rollSession, statusFor, servedRoute, isLocalRoute, localOnlyMessage, routeKey, resolveActor, SKIP_FEEDBACK, answersText, checkAnswers, describeRequest, parseSubjectFingerprint, requestSubjectOf, subjectUnchanged, validAgentAreaGrant, type QuestionAnswer, type RequestShape, type RequestSubject, type SubjectReading, type CheckResult, type Compute, type ErrorCode, type ErrorEnvelope, type Principal } from "@foldedspacelabs/metistry-core";
import { QueryError, QueryStore } from "@foldedspacelabs/metistry-queries";
import { captureToInbox, createBrainServer, dirSink, type CaptureSink, type KnowledgeLister, type KnowledgeReader, type KnowledgeVaultSearcher, type KnowledgeWriter, type QueryEmbedder } from "@foldedspacelabs/metistry-mcp-brain";
import { TasksError, TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import { artifactRoutes, isArtifactRoute } from "./artifacts-routes.js";
import { isTaskOpRoute, taskRoutes } from "./task-routes.js";
import type { Db } from "./auth-store.js";
import * as store from "./auth-store.js";
import * as agents from "./agents.js";
import * as actors from "./actors.js";
import type { AssistantDefinitionSource } from "./actors.js";
import type { SessionPolicy } from "./session-policy.js";
import { parseCookies, readBody, readJson, sendError, sendJson, sendRefusal, sendUnrouted, sessionCookie } from "./http-util.js";
import * as wa from "./webauthn.js";
import { checkLocalOwner, type LocalOwnerConfig } from "./local-owner.js";
import { serveStatic } from "./static.js";
import { capabilitiesOf, type PublicIdentity } from "./identity.js";
import { loadInstances } from "./instances.js";
import { listSecrets, SECRETS_NOT_AVAILABLE, type SecretsView } from "./secrets-route.js";
import { listVariables, VARIABLES_NOT_AVAILABLE, type VariablesView } from "./variables-route.js";
import { CONNECTION_ROUTE, CONNECTIONS_NOT_AVAILABLE, listConnections, oneConnection, validConnectionName, type ConnectionsView } from "./connections-route.js";
import { VAULT_STATUS_NOT_AVAILABLE, VaultStatusUnavailable, type VaultStatusReader } from "./vault-status.js";
import { applyRollback, carriesRollback, parseRollbackAsk, raiseRollback, rollbackOf, type VaultReverter } from "./vault-rollback.js";
import { NDJSON_CONTENT_TYPE, RUNS_EXPORT_QUERY, parseExportParams, streamRunsExport } from "./runs-export.js";
import { consultRoute, route as routeMessage, servedKindOf, threadFactsOf, type RoutePolicy, type Rules } from "./router.js";
import { sendToSession, storeSubscription, type PushConfig } from "./push.js";
import { dispatch, type TargetRegistry } from "./dispatch.js";
import { DEVIN_PURPOSES, isDevinPurpose } from "./devin.js";
import { listProjects, updateProject, validateProjectPatch } from "./projects.js";
import { applyImprovement } from "./prompt-overlay.js";
import { SCHEDULED_PATH, applyMeEdit, meEditOf } from "./profile-tidy.js";
import { applySuggestion, carriesSuggestion, suggestionOf } from "./routine-suggestions.js";
import { applyRestore, carriesRestore, restoreOf } from "./knowledge-restore.js";
import { crewDispatcher, type CrewRegistry } from "./crews.js";
import { runAction, type ActionServices } from "./actions.js";
import { computeRoutes, isComputeRoute, type ComputeAdmin } from "./compute-routes.js";
import { isKnowledgeRoute, knowledgeRoutes, type ConflictRefusal, type KnowledgeConflicts, type KnowledgeHistory, type KnowledgeSearcher } from "./knowledge-routes.js";
import { isVaultTaskRoute, ReplayCache, vaultTaskRoutes } from "./vault-task-routes.js";
import { closeDayRoute, isCloseDayRoute, type RoutineTrigger } from "./close-day.js";
import { isTodayRoute, todayRoutes } from "./today-routes.js";
import type { ConsoleVaultClient } from "./vault-client.js";
import { isScheduledRoute, scheduledRoutes, type ScheduledAdmin } from "./scheduled-routes.js";
import { isMeetingNoteRoute, meetingNoteRoute, MeetingNotes } from "./meeting-note-route.js";
import { CALENDAR_SYNC, isMeetingMoveRoute, meetingMoveRoute, type EventkitDoor } from "./meeting-move-route.js";
import { githubPullRoute, isGithubPullRoute } from "./github-pulls-route.js";
import type { GithubWriteClient } from "./github-write.js";
import { agentList, commandList } from "./commands.js";
import { purgeArchive, purgePreview } from "@metistry-apps/routines";
import type { EventHub } from "./events.js";
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
  /**
   * The local routing policy (docs/ops/dynamic-router.md; the table is T9-2's).
   * Consulted IN SHADOW only — after the 202, for the `runs` row of kind
   * `route` — so nothing it answers, throws or fails to answer can reach the
   * served route. Absent = no `policy:` block, the shipped behaviour: every
   * route row reads `policy.outcome: "absent"`.
   */
  routePolicy?: RoutePolicy | undefined;
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
  /** The vault client the artifacts module (§4.21) stores content through; absent = artifacts degrade to not_available. With `section` (the reconciler's `POST /vault/section`), Close the Day can write the daily note's section; without it that door answers not_available. */
  vault?: ConsoleVaultClient;
  /** `plan-tomorrow`, run on demand by Close the Day (close-day.ts). Absent = the close still writes the section and says the plan was not enqueued. */
  planTomorrow?: RoutineTrigger | undefined;
  /**
   * The Move-a-meeting door's way to the calendar (meeting-move-route.ts,
   * §2.11, T2-12): the eventkit bridge's URL and bearer, and the owner-door
   * token the bridge requires on a confirm that moves an event with others
   * in it. Only that door reads it. Absent = the door answers 503.
   */
  eventkit?: EventkitDoor | undefined;
  /** The owner's zone for Today's routes (T2-7): `METISTRY_TZ` (core `configuredTimeZone`), never `TZ`. Null or absent → Today counts days in UTC. */
  timeZone?: string | null | undefined;
  /** The instant Today, Close the Day and the task doors take "today" from (and Tick its `done <date>`). Absent = the wall clock; the fixture recorder pins it so recordings do not move with the date. */
  now?: (() => Date) | undefined;
  /** A note's git history for `GET /api/knowledge/history` and `GET /api/knowledge/version` — the reconciler's `/vault/log` and `/vault/show` (§2.21, T10-4); absent = both answer not_available. */
  knowledgeHistory?: KnowledgeHistory | undefined;
  /** Resolve a conflict for `POST /api/knowledge/conflicts/resolve` — the reconciler's `POST /vault/conflicts/resolve` (§2.11, T2-10); absent = not_available. */
  knowledgeConflicts?: KnowledgeConflicts | undefined;
  /** Loaded crew manifests (crews.ts); absent = agents_delegate answers not_available. */
  crews?: CrewRegistry;
  /** identity.yaml's public fields for `GET /api/identity` (identity.ts); absent = 503 not_available. */
  identity?: PublicIdentity | undefined;
  /**
   * The assistant's definition files (identity.yaml, the root CLAUDE.md,
   * assistant-prompt.md), read per request for `GET /api/agents/:id/definition`
   * and the assistant's permission lines (actors.ts). Absent = an assistant
   * with no files and the row's own label for a name.
   */
  assistantDefinition?: (() => Promise<AssistantDefinitionSource>) | undefined;
  /** What `GET /api/identity` reports as `version` — the console package's; absent = null. */
  version?: string | undefined;
  /**
   * Where `instances.yaml` is, for `GET /api/instances` (S4,
   * docs/ops/instances.md): the same colon-separated, last-existing-wins
   * overlay identity takes. Absent = the peer registry is not configured at
   * all and the route answers 503 (degrades: absent).
   */
  instancesFiles?: string | undefined;
  /**
   * `GET /api/secrets` (secrets-route.ts, plan §2.14): the instance's
   * `secrets.yaml` and a PRESENCE probe bound to its instance_id — never
   * anything that reads a value. Absent = the route answers 503.
   */
  secrets?: SecretsView | undefined;
  /**
   * `GET /api/variables` (variables-route.ts, plan §2.14): the instance's
   * `variables.yaml` and the directory walked for *used in*. Absent = the
   * route answers 503.
   */
  variables?: VariablesView | undefined;
  /**
   * `GET /api/connections(/:name)` (connections-route.ts, plan §2.6): the
   * instance's `.metistry/connections/`, read against the connection-type
   * registry, with a presence probe for secrets. Absent = both routes 503.
   */
  connections?: ConnectionsView | undefined;
  /**
   * The owner's GitHub client (github-write.ts, plan §2.11): the one holder of
   * the `github_write` secret, read by the pull request doors and nothing
   * else — never handed to the MCP mount. Absent = those doors answer 503.
   */
  githubWrite?: GithubWriteClient | undefined;
  /**
   * The live-changes hub `GET /api/events` streams from (events.ts, §2.20):
   * `main.ts` builds it and starts the one `LISTEN` that feeds it. Absent =
   * the route answers 503 (degrades: absent) and clients keep polling.
   */
  events?: EventHub | undefined;
  /**
   * `GET /api/vault/status` (vault-status.ts, plan §2.21): the reconciler's
   * `GET /vault/status`, strictly parsed. Absent = no vault bridge, and the
   * route answers 503.
   */
  vaultStatus?: VaultStatusReader | undefined;
  /**
   * The Scheduled doors (scheduled-routes.ts, §2.1/§2.5, T3-3): the runner's
   * components, `.metistry/scheduled.yaml` as the runner reads it and as the
   * reconciler writes it, and Run Now bound to the runner. Absent = every
   * `/api/scheduled*` route answers 503.
   */
  scheduled?: ScheduledAdmin | undefined;
  /**
   * `POST /api/vault/rollback` and its Approve (vault-rollback.ts, plan §2.21,
   * T10-6): the reconciler's `POST /vault/revert` with the console's bearer —
   * which the reconciler never lets change configuration. Absent = no vault
   * bridge, and the route answers 503.
   */
  vaultRevert?: VaultReverter | undefined;
}

// ----- since-cursors (docs/ops/client-api.md) -----
// A cursor is an opaque string the server minted: Postgres's own text form
// of a timestamptz (it round-trips microseconds; a JS Date does not), then
// the row's tiebreakers, `|`-joined — two rows written in one transaction
// share a `now()`, so a bare timestamp would skip the second of them. The
// client never parses it; it hands it back as `?since=`. Rows come oldest
// first when a cursor is given (a reconnect replays forward), newest first
// without one (a fresh paint), and the response always carries the cursor
// for the next call — the newest row seen, or the caller's own when there
// was nothing new.
const MAX_LIST = 100;  // limit: fixed — the API's own page ceiling, documented in docs/ops/client-api.md
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
 * **The console's credential → `core`'s decision principal** (P1 of
 * docs/research/2026-09-19-grants-and-access-simplified.md §4). One mapping
 * function, called at the doors; `mcp-brain` has the other one, for an agent
 * bearer. Nothing about STORAGE moves: sessions, the local owner token,
 * `owner_tokens` and `agents` rows are all still exactly where they were.
 *
 * Three roles come out of this server, and the collapse is the same one
 * `isUser` already makes and is right to make: everything a passkey session
 * may do, the local owner token may do, so both are `owner`. The capture
 * `owner_token` is NOT one of them — it is the plan's tier 0, capture-only,
 * and the management gate excludes it by name — so it is the `tool` role, a
 * credential with no scope at all. An agent bearer is `assistant` or `agent`
 * by its row's kind, and a crew is its own role since P2 (the registry's
 * third stored kind is no longer collapsed — see `authenticateAgent`).
 *
 * A crew bearer is the fifth role and reaches nothing here: it is an agent
 * bearer, so it takes the uniform 403 above like any other. Its `uses`
 * toolset rides along anyway, because the principal is one shape and the
 * door that enforces it is `/mcp` (P2 §2.2).
 *
 * An UNAUTHENTICATED request has no principal, so there is nothing to map:
 * the four `/auth/*` ceremonies, `GET /api/identity`, `/health` and the PWA
 * shell are all decided before this point, and the doors below are reached
 * only with a credential in hand. `null` gets the `tool` role — the narrowest
 * one — so that a future caller of this function with no credential fails
 * closed rather than being handed a scope.
 */
function principalOf(auth: Auth): Principal {
  if (auth?.kind === "agent") {
    const a = auth.agent;
    const internal = a.kind === "internal";
    const crew = a.kind === "crew";
    return {
      id: a.id,
      role: internal ? "assistant" : crew ? "crew" : "agent",
      scope: {
        tier: a.grants.tier,
        areas: [...a.grants.areas],
        queries: a.grants.queries === true,
        projects: internal && a.projects.length === 0 ? null : [...a.projects],
        autonomy: a.autonomy,
      },
      source: internal ? "environment" : crew && a.manifest !== undefined ? { manifest: a.manifest } : "registry",
      ...(crew ? { uses: [...(a.uses ?? [])] } : {}),
    };
  }
  const owner = isUser(auth);
  return {
    // The person, however they proved it: their own vault is every path, and
    // `areas: null` is what says so (never an empty list, which is no grant).
    id: owner ? "owner" : "owner_token",
    role: owner ? "owner" : "tool",
    scope: { tier: owner ? "areas" : "none", areas: owner ? null : [], queries: owner, projects: owner ? null : [] },
    source: "registry",
  };
}

// One shape for every per-agent verb so the management gate and the handler
// cannot drift apart. Ids are slugs; anything else falls through to 404.
const AGENT_ROUTE = /^(PUT|POST) \/api\/agents\/([a-z][a-z0-9-]{0,39})\/(grants|projects|autonomy|revoke|rotate|approve)$/;
// An agent's definition (T4-6), read-only. Loose on the id on purpose: the
// management gate answers the whole family the same way, whatever spelling,
// and the handler owns the slug grammar (a miss is the family's 404).
const AGENT_DEFINITION_ROUTE = /^GET \/api\/agents\/([^/]+)\/definition$/;
// Projects (§4.19 rollup, §4.21 controls): the kill switch, budget, caps. Session only — this is the user's hand.
const PROJECT_ROUTE = /^PUT \/api\/projects\/([a-z][a-z0-9-]{0,39})$/;
// Dispatch a work row to a compute target (§4.18). Body: { target, brief, sources? }.
const DISPATCH_ROUTE = /^POST \/api\/tasks\/(\d{1,12})\/dispatch$/;
// A thumbs up/down on one reply (docs/ops/reply-feedback.md). Session only —
// this is the user's own judgement, not something a script speaks for.
const FEEDBACK_ROUTE = /^(POST|DELETE) \/api\/messages\/(\d{1,12})\/feedback$/;
// A thumbs up/down on any OTHER piece of generated prose — a meeting
// briefing, a plan rationale, a revision explanation (T1-12; B7 of
// `today-hub-requests.md`). `:id` is a `runs.id`: the one id already stable
// wherever prose is produced (0031_prose_feedback.sql says why). Session
// only, exactly like `FEEDBACK_ROUTE` — the owner token speaks for nothing
// here either.
const PROSE_FEEDBACK_ROUTE = /^(POST|DELETE) \/api\/prose\/(\d{1,12})\/feedback$/;
// One row of the ledger, in full — what a tap on an activity-feed `runs:<id>`
// opens (docs/product/app-ux-plan.md §6 phase B). Read-only, `user` principal,
// through the `run_detail` named query like every other read (invariant 3).
const RUN_DETAIL_ROUTE = /^GET \/api\/runs\/(\d{1,12})$/;
/** The named query `GET /api/runs/:id` is served from. Its ABSENCE is a refusal with a status, exactly as the export's is. */
const RUN_DETAIL_QUERY = "run_detail";
/** The named query `GET /api/needs-you/count` is served from (T1-7, §2.10): the same pending-and-not-snoozed filter `GET /api/proposals` applies, so the sidebar row and the Dock badge can never disagree with the queue's own length. */
const PENDING_COUNT_QUERY = "pending_count";
// Chat's working indicator (T2-17, §2.10): the tool calls one assistant turn
// has made so far, read through `turn_progress` — the same `meta.turn_id` join
// `run_detail` uses. `validTurnId`'s shape (packages/mcp-brain/src/turn-id.ts):
// a turn_id is a bookkeeping label, never itself a lookup key into anything
// secret, so an id shaped like no turn anyone ever ran is simply zero rows,
// never a refusal.
const TURN_PROGRESS_ROUTE = /^GET \/api\/turns\/([A-Za-z0-9_-]{1,64})\/progress$/;
const TURN_PROGRESS_QUERY = "turn_progress";
// One archived session, in full — Run detail's conversation (T2-17, T1-11,
// §2.10), through `session_detail`. `session_id` is `session_archive`'s own
// column, a uuid; a path segment that is not shaped like one matches no served
// route below and falls through to the uniform 404, exactly as a non-numeric
// `/api/runs/:id` does today.
const SESSION_DETAIL_ROUTE = /^GET \/api\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const SESSION_DETAIL_QUERY = "session_detail";

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
//
// Neither is on F-5's table as an answer to every type, and since T2-3 the
// table is the whole list (`describeRequest(kind, payload).decisions`, plan
// §2.12): `later` rides beside every row's answers, and `skip` is Skip, which
// is BULK-ONLY (K2) — every row the batch reaches takes it, and a single row
// takes it only where the table makes it that type's Decline (a report's
// Dismiss, a message's Not Mine).
/** What `POST /api/proposals/batch` will apply to many rows at once — see the refusal message there for why `allow` is not on it. */
const BATCH_DECISIONS = ["later", "skip", "deny"];
/** How long `later` puts something down for. Config, not a literal: "back in three hours" is an opinion about a working day. */
const SNOOZE_HOURS = intEnv("METISTRY_SNOOZE_HOURS", 3);

/**
 * The subject of a request as it stands (T2-14; core's `requestSubjectOf`
 * says which basis a type is judged by, this is where each is READ):
 *
 *   head_sha         the PR's work row `meta.head_sha` — what the GitHub sync
 *                    last saw — else the head the row was raised with
 *   line_text        the vault line `payload.task_line = {path, task_key}`
 *                    names (`vault_tasks`, the reconciler's index); NULL when
 *                    it names one that is gone. A row naming no line reads
 *                    its work row's title: a tracker item's one line.
 *   work_updated_at  the linked work row's `updated_at`, in Postgres's own
 *                    text form, so no precision is lost on the way to a hash
 *
 * Read beside the row by both the list and the decision, so the fingerprint a
 * client renders and the one its answer is judged against are the same read.
 * The `subject_*` columns never reach the wire: `servedProposal` folds them
 * into `subject`.
 */
const SUBJECT_COLUMNS = `
  w.updated_at::text AS subject_work_updated_at,
  w.title AS subject_work_title,
  nullif(coalesce(w.meta->>'head_sha', p.payload->>'head_sha'), '') AS subject_head_sha,
  coalesce(jsonb_typeof(p.payload->'task_line') = 'object', false) AS subject_line_named,
  vt.text AS subject_line_text`;
const SUBJECT_JOINS = `
  LEFT JOIN work w ON w.id = p.work_id
  LEFT JOIN vault_tasks vt ON vt.path = p.payload->'task_line'->>'path' AND vt.task_key = p.payload->'task_line'->>'task_key'`;
const SUBJECT_COLUMN_NAMES = ["subject_work_updated_at", "subject_work_title", "subject_head_sha", "subject_line_named", "subject_line_text", "own_changed_at"] as const;

/**
 * The row a decision reads, plus when it last CHANGED — which is not one
 * column, because a proposal can be moved by things that are not the
 * proposal: the work row it came from, and the room hanging on that work row
 * (`artifact_comments`, migration 0018). `greatest()` over all of them is
 * what `if_unchanged.seen_at` compares against. `own_changed_at` leaves the
 * work row out: an answer that also sends `if_unchanged.subject` has the work
 * row judged by its subject's fingerprint instead (T2-14), so a render's
 * `ts` does not go stale forever once the work row has moved since the row
 * was raised.
 */
const PROPOSAL_FOR_DECISION_SQL = `
  SELECT p.id, p.ts, p.kind, p.source_agent, p.trust, p.payload, p.source, p.decision, p.feedback, p.decided_at, p.work_id, p.snoozed_until,
         greatest(
           p.ts,
           coalesce(p.decided_at, p.ts),
           coalesce(w.updated_at, p.ts),
           coalesce((SELECT max(c.created_at) FROM artifact_comments c WHERE c.work_id = p.work_id), p.ts)
         ) AS changed_at,
         greatest(
           p.ts,
           coalesce(p.decided_at, p.ts),
           coalesce((SELECT max(c.created_at) FROM artifact_comments c WHERE c.work_id = p.work_id), p.ts)
         ) AS own_changed_at,
         ${SUBJECT_COLUMNS}
  FROM proposals p
  ${SUBJECT_JOINS}
  WHERE p.id = $1`;

/** The `subject_*` columns as core's reading: `undefined` where the row cannot supply a basis, `null` where it names one that is gone. */
function subjectReadingOf(row: Record<string, unknown>): SubjectReading {
  const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const head = text(row.subject_head_sha);
  const workAt = text(row.subject_work_updated_at);
  const workTitle = typeof row.subject_work_title === "string" ? row.subject_work_title : undefined;
  const line = row.subject_line_named === true ? (typeof row.subject_line_text === "string" ? row.subject_line_text : null) : workTitle;
  return {
    ...(head !== undefined ? { head_sha: head } : {}),
    ...(line !== undefined ? { line_text: line } : {}),
    ...(workAt !== undefined ? { work_updated_at: workAt } : {}),
  };
}

/** A read row's subject as it stands, or null — see `SUBJECT_COLUMNS`. */
function subjectOfRow(row: Record<string, unknown>): RequestSubject | null {
  return requestSubjectOf(String(row.kind ?? ""), subjectReadingOf(row));
}

/** What one answer to one proposal comes back as: a status and the body to send, so the batch caller gets an outcome rather than a socket. */
type DecisionOutcome = { status: number; body: ErrorEnvelope | Record<string, unknown> };
/** `POST /api/proposals/:id`'s body (docs/ops/client-api.md): a decision, and what that decision carries. `answers` rides only with `decision: "answers"` (T2-3). */
type DecisionBody = { decision?: unknown; feedback?: string; area?: unknown; answers?: unknown; if_unchanged?: { seen_at?: unknown; subject?: unknown } };

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
    proposal: servedProposal(row),
  };
}

/**
 * A `proposals` row as `GET /api/proposals` serves it: the stored row plus
 * `request`, its reading from F-5's type table (`describeRequest` — type,
 * word, body, answers, grouped, decisions). Additive: nothing stored is
 * renamed or dropped. A kind the table does not know reads as a report, never
 * as its stored kind.
 */
export function withRequestShape<R extends Record<string, unknown>>(row: R): R & { request: RequestShape } {
  return { ...row, request: describeRequest(String(row.kind ?? ""), row.payload) };
}

/**
 * A row read with `SUBJECT_COLUMNS` as it crosses the wire: `request` (F-5's
 * reading) and `subject` — `{basis, fingerprint}` of what the request is
 * about as it stands, or null (T2-14). A client renders the fingerprint and
 * sends it back as `if_unchanged.subject`; the columns it was built from stay
 * here.
 */
export function servedProposal(row: Record<string, unknown>): Record<string, unknown> & { request: RequestShape; subject: RequestSubject | null } {
  const subject = subjectOfRow(row);
  const out: Record<string, unknown> = { ...row };
  for (const c of SUBJECT_COLUMN_NAMES) delete out[c];
  return { ...withRequestShape(out), subject };
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
 * otherwise — for anyone but the owner.** A query marked `expose: route` is
 * served by an endpoint of its own that does something this one cannot
 * (`knowledge_pages` filters every row through the caller's scope), so
 * answering it to an AGENT here would be that filter undone rather than a
 * convenience (ruled 2026-09-19: one endpoint per necessary operation). The
 * refusal is the UNKNOWN-QUERY refusal, byte for byte: same code, same
 * status, same absent message, so this door never tells such a caller which
 * route-only queries exist. Which names those are is read off the manifests
 * through the store (`exposure`) and never matched against a list kept here,
 * which could drift from the files.
 *
 * **The owner is served** (P4, and the owner's ruling "the owner should
 * always have access to everything"). The scope filter that rule protects
 * is a filter on what an agent may see of the VAULT; the owner's scope is
 * the whole vault, so the filtered route and this one return the same rows
 * to them and the refusal was only ever a second door to remember (§2.6).
 * The capture `owner_token` is NOT the owner — it is the plan's tier 0 — and
 * is still refused, byte for byte.
 */
export async function namedQueryDoor(res: ServerResponse, queries: QueryStore, name: string, params: Record<string, string>, auth: Auth = null): Promise<void> {
  // `expose`, read off the manifest through the store, decided by `may` — the
  // same rule, in the same words, `queries_run` applies on /mcp. The caller
  // decides it now: `may` admits the owner for every query this door serves,
  // and refuses everyone else a route-only one with the unknown-query answer.
  const exposed = may(principalOf(auth), "read", { kind: "query", door: "console_query", name, exposure: queries.exposure(name) === "generic" ? "generic" : "route" });
  if (!exposed.ok) return sendRefusal(res, exposed);
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
  /** `Idempotency-Key` replays for the vault-task doors — per server, in memory (vault-task-routes.ts says why that is enough). */
  const vaultTaskReplays = new ReplayCache();
  /** The meeting-note door's per-event queue and the notes it wrote ahead of the walk — per server, in memory (meeting-note-route.ts says why that is enough). */
  const meetingNotes = new MeetingNotes();
  /** The services one action may reach. Read per call: `cfg.targets` and the vault bridge are hot-reloaded, and an action must follow the file rather than the process's startup. */
  const actionServices = (): ActionServices => ({ db, tasks, inbox, ...(cfg.targets ? { targets: cfg.targets } : {}), ...(artifacts ? { artifacts } : {}) });

  /**
   * **One agent-principal source for both doors** (the `/mcp` mount and this
   * server's own `authenticate`): the registry row, plus — for a crew — the
   * `uses` toolset and manifest path from the crews this console loaded.
   * Never from the request: a body cannot make a bearer a crew, and a crew
   * cannot name a tool group it was not given (§4.19).
   */
  const agentPrincipal = (req: IncomingMessage) => agents.authenticateAgent(db, req, (id) => cfg.crews?.toolset(id));

  const brain = createBrainServer({
    db,
    authenticate: (req) => agentPrincipal(req), // the same principal source as /capture
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
    const agent = await agentPrincipal(req); // principal from the credential, never the body
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
    // Every answer says which contract it speaks (docs/ops/client-api.md
    // "Versioning"), refusals included: a client reads the version off a 401
    // as easily as off a 200, and refuses a console below its minimum with a
    // sentence rather than a decode failure.
    res.setHeader(API_VERSION_HEADER, String(API_VERSION));

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
          // `events` while the table says the stream is served AND this
          // console has a hub to stream from — never a capability the route
          // would then answer 503 for. The conformance test holds both halves.
          hasEvents: cfg.events !== undefined && servedRoute("GET", "/api/events") !== undefined,
        }),
        version: cfg.version ?? null,
        api_version: API_VERSION,
        as_of: new Date().toISOString(),
      });
    }
    if (key === "GET /health") {
      try {
        await db.query("SELECT 1");
        return sendJson(res, 200, { ok: true, api_version: API_VERSION });
      } catch {
        return sendJson(res, 503, { ok: false, api_version: API_VERSION });
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
      // Idempotency-Key (docs/ops/client-api.md): scoped to the credential
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
        // one write path for every capture door (the brain bridge's `capture` tool uses the same function).
        // An owner credential (a passkey session or the local owner token — the Mac app and the PWA) is
        // captured "from the apps" (T2-1); the Shortcut's owner_token and an agent bearer are unchanged.
        const source = isUser(auth) ? "app" : "http";
        const r = await captureToInbox(db, inbox, { bytes, filename, mime: req.headers["content-type"] ?? null, note, source, sourceAgent, idempotency });
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
    const onConsole = may(principalOf(auth), "act", { kind: "console", door: "console_agent", route: key });
    if (!onConsole.ok) return sendRefusal(res, onConsole);

    // ----- the contract: the owner is served what the client API table lists, and nothing else -----
    // `packages/core/src/client-api.ts` is the route table every client is
    // written against (docs/ops/client-api.md). Asked here, before anything
    // below dispatches, so a handler added without its row is unreachable
    // rather than an undocumented door — and a row frozen ahead of its
    // ticket stays unserved until that ticket marks it served. Owner only,
    // and deliberately: the capture token and agent bearers keep their
    // uniform answers below (a 403 across a whole family, never a 403 here
    // and a 404 there). For the owner an unlisted route was already a 404;
    // it now names the routes that do exist beside it, off the same table.
    const row = isUser(auth) ? servedRoute(req.method ?? "", url.pathname) : undefined;
    if (isUser(auth) && row === undefined) return sendUnrouted(res, noRouteMessage(req.method ?? "", url.pathname));

    // ----- reach `local`: the owner on THIS Mac, by the local owner token alone (§2.1, F-13) -----
    // Read off the same row, before any handler: a route the table files
    // under `local` (minting a bearer, today) refuses a passkey session —
    // even one from 127.0.0.1 — with `403 local_only` naming the Mac app.
    // The local owner token got here only from a loopback peer
    // (`checkLocalOwner`); from anywhere else it was already the uniform 401.
    // Owner credentials only, deliberately: the capture token and agent
    // bearers keep the uniform `forbidden` of the gates they meet, so this
    // answer tells no one but the owner which routes are served. Audited,
    // because a passkey session reaching for a credential mint is exactly
    // what a stolen session would do.
    if (row && isLocalRoute(row) && auth.kind !== "local_owner") {
      await audit("auth", "local_only", false, { route: routeKey(row), via: auth.kind, reason: "a `local` route admits the local owner token alone" });
      return sendError(res, "local_only", localOnlyMessage(row));
    }

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
      const decidedAt = new Date();
      // Durable BEFORE the 202 (SHOULD-7). Routing decision rides in meta.
      const { rows } = await db.query(
        `INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`,
        [thread, body.text, JSON.stringify(decision ? { route: decision } : {})],
      );
      const messageId = rows[0]?.id;
      // The route record (docs/ops/dynamic-router.md §6, T9-1): one `runs` row
      // of kind `route` per message the rules routed. IN SHADOW it is called
      // only after the 202 has been sent — "shadow does not wait" — so the
      // served route, the 202 body and the reply are what they were before
      // the record existed, whatever the policy does. A record that fails to
      // write is logged and lost; it never fails a message already answered.
      const recordRoute = (): void => {
        if (!decision || !cfg.rules) return;
        const rules = cfg.rules;
        void (async () => {
          const runId = await startRun(db, {
            component: "console",
            kind: "route",
            tool: servedKindOf(decision),
            meta: { v: 1, message_id: Number(messageId), thread, phase: "shadow" },
          });
          const rec = await consultRoute({
            rules,
            route: decision,
            text: body.text!,
            attachments: 0, // POST /message takes none today (§2: the feature is defined so adding them is one line)
            thread,
            messageId: Number(messageId),
            policy: cfg.routePolicy,
            loadFacts: async () => threadFactsOf((await queries.run("route_features", { thread, exclude_id: Number(messageId) })).rows[0]),
            at: decidedAt,
          });
          await finishRun(db, runId, { ok: rec.ok, ...(rec.error !== undefined ? { error: rec.error } : {}), meta: rec.meta });
        })().catch((err: unknown) => console.error(`route record for message ${String(messageId)} not written: ${err instanceof Error ? err.message : String(err)}`));
      };

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
        sendJson(res, 202, { message_id: messageId, reply });
        return recordRoute();
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
          sendJson(res, 202, { message_id: messageId, reply });
          return recordRoute();
        } catch (err) {
          await finishRun(db, runId, { ok: false, error: String(err) });
          // fall through: leave for the assistant rather than dropping the turn
        }
      }
      await audit("message", "inbound", true, { message_id: messageId });
      sendJson(res, 202, { message_id: messageId });
      return recordRoute();
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/q/")) {
      return namedQueryDoor(res, queries, url.pathname.slice("/api/q/".length), Object.fromEntries(url.searchParams), auth);
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
      const d = may(principalOf(auth), "act", { kind: "console", door: "console_management", route: key });
      if (!d.ok) return sendRefusal(res, d);
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
    //
    // Two questions, and only the first is a permission: `may` decides
    // WHETHER this credential may reach the management surface, and the
    // enumeration below decides WHICH routes that surface is — so a
    // credential outside it gets the canonical 403 on the whole family
    // rather than a 403 on some paths and a 404 on others, a difference that
    // would say which spellings this build knows.
    const management = may(principalOf(auth), "act", { kind: "console", door: "console_management", route: key });
    if (!management.ok) {
      if (
        key === "GET /api/devices" ||
        /^POST \/api\/devices\/\d+\/revoke$/.test(key) ||
        key === "POST /auth/logout" ||
        key === "GET /api/proposals" ||
        key === "POST /api/proposals/batch" ||
        /^POST \/api\/proposals\/\d+$/.test(key) ||
        key === "GET /api/needs-you/count" ||
        FEEDBACK_ROUTE.test(key) ||
        PROSE_FEEDBACK_ROUTE.test(key) ||
        key === "GET /api/agents" ||
        key === "POST /api/agents" ||
        AGENT_ROUTE.test(key) ||
        AGENT_DEFINITION_ROUTE.test(key) ||
        key === "GET /api/projects" ||
        PROJECT_ROUTE.test(key) ||
        key === "GET /api/runs/export" ||
        RUN_DETAIL_ROUTE.test(key) ||
        TURN_PROGRESS_ROUTE.test(key) ||
        SESSION_DETAIL_ROUTE.test(key) ||
        key === "POST /api/sessions/purge" ||
        key === "GET /api/instances" ||
        key === "GET /api/secrets" ||
        key === "GET /api/variables" ||
        key === "GET /api/connections" ||
        CONNECTION_ROUTE.test(key) ||
        key === "GET /api/vault/status" ||
        // a rollback of the vault's history: the local owner's hand alone (T10-6)
        key === "POST /api/vault/rollback" ||
        key === "GET /api/commands" ||
        // the live-changes stream is the owner's alone: an agent learns what
        // changed through its own tools, and the capture token captures (§2.20)
        key === "GET /api/events" ||
        // `/api/compute*` is owner-only CONFIGURATION, not an invariant-10
        // action: it changes how the system behaves, so it is the user's
        // hand and nothing else's (invariant 2). `/api/knowledge/*` is the
        // owner's read path into their own vault; an agent reaches knowledge
        // under its grants on the `/mcp` mount, never here.
        isComputeRoute(url.pathname) ||
        // Scheduled changes when things run and what runs — the owner's hand (§2.5)
        isScheduledRoute(url.pathname) ||
        isKnowledgeRoute(url.pathname) ||
        isTaskOpRoute(key) ||
        isArtifactRoute(url.pathname) ||
        // the Tick door writes the owner's own note as `user`: the owner's hand, no one else's
        isVaultTaskRoute(key) ||
        // so does Close the Day, into the note's section
        isCloseDayRoute(key) ||
        // …and so does the meeting-note door (T2-11)
        isMeetingNoteRoute(key) ||
        // moving a meeting re-times other people's day: the owner's hand, and the bridge holds the rule (T2-12)
        isMeetingMoveRoute(key) ||
        // the PR doors post to GitHub AS the owner, with the owner's own secret (T2-13)
        isGithubPullRoute(key) ||
        // Today reads the owner's own day — their notes' task lines, their calendar — and stores their order
        isTodayRoute(key)
      ) {
        return sendRefusal(res, management);
      }
      return sendUnrouted(res);
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

    // ----- the Secrets list (§2.14): names and policy, NEVER a value -----
    // The file, a presence probe and a named query; nothing handed to this
    // door can read a Keychain item's data (secrets-route.ts). Every write is
    // `metistry secrets` on the Mac (M7).
    if (key === "GET /api/secrets") {
      if (!cfg.secrets) return sendError(res, "not_available", SECRETS_NOT_AVAILABLE);
      const r = await listSecrets(cfg.secrets, queries);
      if (!r.ok) {
        // the ledger records THAT it failed, not the parser's words: a
        // pasted value in the wrong place could be quoted in them
        await audit("secrets", "read", false, { reason: "secrets.yaml does not validate" });
        return sendJson(res, statusFor("invalid_request"), errorEnvelope("invalid_request", r.message));
      }
      return sendJson(res, 200, { secrets: r.secrets, as_of: new Date().toISOString() });
    }

    // ----- the Variables list (§2.14): plain values agents read, never a secret -----
    // core's parse refuses a key-shaped value, so a file carrying one is a
    // 400 naming the variable — never the value. Every write is `metistry
    // variables` on the Mac (M14).
    if (key === "GET /api/variables") {
      if (!cfg.variables) return sendError(res, "not_available", VARIABLES_NOT_AVAILABLE);
      const r = await listVariables(cfg.variables);
      if (!r.ok) {
        await audit("variables", "read", false, { reason: "variables.yaml does not validate" });
        return sendJson(res, statusFor("invalid_request"), errorEnvelope("invalid_request", r.message));
      }
      return sendJson(res, 200, { variables: r.variables, as_of: new Date().toISOString() });
    }

    // ----- the Connections list (§2.6): names, reach, tools and modes — never a value -----
    // Read-only and dial-free: every write is `metistry connections` on the
    // Mac (M13), and whether a server answers is `metistry connections test`
    // (connections-route.ts).
    if (key === "GET /api/connections") {
      if (!cfg.connections) return sendError(res, "not_available", CONNECTIONS_NOT_AVAILABLE);
      return sendJson(res, 200, { connections: await listConnections(cfg.connections), as_of: new Date().toISOString() });
    }
    const connectionOf = CONNECTION_ROUTE.exec(key);
    if (connectionOf) {
      if (!cfg.connections) return sendError(res, "not_available", CONNECTIONS_NOT_AVAILABLE);
      const name = connectionOf[1]!; // a kebab name has nothing to percent-decode; anything else is not a connection
      if (!validConnectionName(name)) return sendError(res, "not_found", "no such connection");
      const connection = await oneConnection(cfg.connections, name);
      if (!connection) return sendError(res, "not_found", "no such connection");
      return sendJson(res, 200, { connection, as_of: new Date().toISOString() });
    }

    // ----- the vault's git (§2.21): where sync stands, read from the reconciler -----
    // Read-only, owner-only. The policy itself is `metistry vault settings`
    // on the Mac (M18) — history and the remote are not a route's to change.
    if (key === "GET /api/vault/status") {
      if (!cfg.vaultStatus) return sendError(res, "not_available", VAULT_STATUS_NOT_AVAILABLE);
      try {
        return sendJson(res, 200, await cfg.vaultStatus());
      } catch (err) {
        if (err instanceof VaultStatusUnavailable) return sendError(res, "not_available", err.message);
        throw err;
      }
    }

    // ----- roll back (§2.21, T10-6; reach `local`): a Needs You request, never a revert -----
    // The `local` gate above has already refused a passkey session, the
    // capture token and every agent bearer. This asks the reconciler for a
    // preview and raises the request; only Approve reverts (decideProposal).
    if (key === "POST /api/vault/rollback") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return sendError(res, "invalid_request", "the body must be JSON: {commit} | {to} | {file[, to]}");
      }
      const ask = parseRollbackAsk(body);
      if (!ask.ok) {
        if (ask.code === "forbidden") await audit("vault", "rollback", false, { refused: "configuration", body });
        return sendError(res, ask.code, ask.message);
      }
      if (!cfg.vaultRevert) return sendError(res, "not_available", "rolling back runs through the reconciler, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)");
      const out = await raiseRollback({ revert: cfg.vaultRevert, db }, ask.value);
      if (!out.ok) {
        await audit("vault", "rollback", false, { error: out.code, target: ask.value.target });
        return sendError(res, out.code, out.message);
      }
      await audit("vault", "rollback", true, { proposal: out.id, raised: out.raised, target: ask.value.target, include_config: ask.value.include_config });
      return sendJson(res, 202, { ok: true, proposal_id: String(out.id), raised: out.raised, preview: out.preview, proposal: out.proposal });
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

    // ----- Purge Now: the session archive, on demand (T3-9; reach `local`) -----
    // The scheduled `session-purge` routine's own delete, reached by the
    // owner's hand on this Mac (the `local` gate above has already refused a
    // passkey session). Irreversible, so it is two steps on one door, and the
    // first is the default: a body without `confirm: true` deletes NOTHING
    // and answers what a purge would cost — every session and turn, and by
    // name the sessions the fold has not read yet, so the confirm can offer
    // Fold First (C136). `confirm: true` deletes; with the preview's `as_of`
    // it deletes exactly what was counted, and a turn archived since is kept.
    // The archive is a cache (invariant 1), so nothing durable is lost — the
    // audit row says what went, and how much of it was never folded.
    if (key === "POST /api/sessions/purge") {
      const body = (await readJson(req)) as { confirm?: unknown; as_of?: unknown };
      if (body.confirm !== undefined && typeof body.confirm !== "boolean") return sendError(res, "invalid_request", "confirm is true or false");
      let asOf: Date | undefined;
      if (body.as_of !== undefined) {
        asOf = typeof body.as_of === "string" ? new Date(body.as_of) : undefined;
        if (!asOf || Number.isNaN(asOf.getTime())) return sendError(res, "invalid_request", "as_of is the ISO timestamp a preview answered with");
      }
      if (body.confirm !== true) return sendJson(res, 200, { purged: false, ...(await purgePreview(db)) });
      const gone = await purgeArchive(db, asOf);
      await audit("sessions", "purge", true, { ...gone, ...(asOf ? { as_of: asOf.toISOString() } : {}), via: auth.kind });
      return sendJson(res, 200, { purged: true, ...gone, as_of: new Date().toISOString() });
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

    // ----- a turn's tool calls so far: Chat's working indicator (T2-17) -----
    // No "still working" verdict is computed here (seed/queries/turn_progress.yaml):
    // `finished_at IS NULL` on a row IS the running call, and the count and
    // elapsed seconds are cheap enough on the client that the wire does not
    // carry a second, redundant shape of the same answer. An unknown or blank
    // turn_id is not a lookup failure — it is simply a turn with no calls yet.
    const turnProgress = TURN_PROGRESS_ROUTE.exec(key);
    if (turnProgress) {
      if (!queries.names().includes(TURN_PROGRESS_QUERY)) {
        return sendError(res, "not_available", `the named query ${TURN_PROGRESS_QUERY} is not loaded (seed/queries/${TURN_PROGRESS_QUERY}.yaml, METISTRY_QUERIES_DIRS)`);
      }
      const result = await queries.run(TURN_PROGRESS_QUERY, { turn_id: turnProgress[1]! });
      return sendJson(res, 200, { turn_id: turnProgress[1], calls: result.rows, as_of: result.as_of.toISOString() });
    }

    // ----- one archived session, in full: Run detail's conversation (T2-17, T1-11) -----
    // `session_detail` already enforces expiry (a purged or expired session
    // reads as no rows, never a stale one slipping out from under the T3-9
    // purge routine), so an empty result here means the same thing a missing
    // run does: `404 not_found`. `?turn_id=` narrows to one turn's full
    // record, as the query itself supports; blank (the default) is every turn.
    const sessionDetail = SESSION_DETAIL_ROUTE.exec(key);
    if (sessionDetail) {
      if (!queries.names().includes(SESSION_DETAIL_QUERY)) {
        return sendError(res, "not_available", `the named query ${SESSION_DETAIL_QUERY} is not loaded (seed/queries/${SESSION_DETAIL_QUERY}.yaml, METISTRY_QUERIES_DIRS)`);
      }
      const turnId = url.searchParams.get("turn_id") ?? "";
      const result = await queries.run(SESSION_DETAIL_QUERY, { session_id: sessionDetail[1]!, turn_id: turnId });
      if (result.rows.length === 0) return sendError(res, "not_found", `no session ${sessionDetail[1]} in the archive (expired, purged, or never existed)`);
      return sendJson(res, 200, { session_id: sessionDetail[1], turns: result.rows, as_of: result.as_of.toISOString() });
    }

    // ----- live changes (§2.20, T2-18): what changed, as ids — the owner's, and nobody else's -----
    // Past the management gate, so an agent bearer and the capture token have
    // already had their uniform 403. The stream carries ids and counts only
    // (events.ts refuses anything else at `publish`), and the client
    // refetches through the route that decides who may read the thing — so
    // it opens no read path the routes do not. A stream outlives the request
    // that opened it, so the credential is asked again at every heartbeat:
    // a revoked session stops hearing within one.
    if (key === "GET /api/events") {
      if (!cfg.events) return sendError(res, "not_available", "this console streams no live changes — the events hub is not wired in this deployment; poll with since cursors (docs/ops/client-api.md \"Live changes\")");
      const lastEventId = req.headers["last-event-id"];
      return cfg.events.serve(req, res, {
        lastEventId: typeof lastEventId === "string" ? lastEventId : undefined,
        stillAllowed: async () => isUser(await authenticate(req)),
      });
    }

    // ----- the composer's command list, GENERATED (docs/ops/client-api.md) -----
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

    // ----- Scheduled (§2.5, T3-3): the owner's timing, and — reach `local`, gated above — what runs -----
    if (isScheduledRoute(url.pathname)) {
      return scheduledRoutes(req, res, key, { admin: cfg.scheduled, queries, audit });
    }

    // ----- compute (C1): owner-only configuration, never an action -----
    if (isComputeRoute(url.pathname)) {
      return computeRoutes(req, res, key, url, { admin: cfg.computeAdmin, queries, audit });
    }

    // ----- knowledge: the owner's read path into their own vault -----
    // The PRINCIPAL goes in, derived from the credential (`principalOf`),
    // never a constant at the call site: the routes' filter is only as
    // honest as the scope handed to it, and a literal here is a filter that
    // cannot be narrowed without editing this line. It is the principal
    // rather than a scope since P4 — `may()` decides the refusal, and what
    // it decides for the OWNER is not a narrower scope but a CLASSIFICATION:
    // their own `.metistry/` and `Artifacts/` are not pages this door has,
    // and it says so and names the door that does, rather than refusing
    // (docs/research/2026-09-19-grants-and-access-simplified.md §3.3). The
    // page LIST gets the SAME QueryStore every other read goes through —
    // invariant 3 has one read path into derived state, not one per surface,
    // and no second, unscoped door onto it (`knowledge_pages.yaml` is
    // `expose: route`).
    if (isKnowledgeRoute(url.pathname)) {
      return knowledgeRoutes(
        req,
        res,
        key,
        url,
        {
          ...(cfg.searchKnowledge ? { search: cfg.searchKnowledge } : {}),
          ...(cfg.vault ? { vault: cfg.vault } : {}),
          ...(cfg.knowledgeHistory ? { history: cfg.knowledgeHistory } : {}),
          requests: db,
          ...(cfg.knowledgeConflicts ? { conflicts: cfg.knowledgeConflicts } : {}),
          conflictRefused: recordConflictRefusal,
          queries,
        },
        principalOf(auth),
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

    // ----- the vault's tasks: the Tick door (design-build-plan §2.11, T2-4; owner only) -----
    // Exactly `[x]` and `done <date>` on one line of the owner's note, or the
    // reverse, written as `user` with the note's hash — never a patch, never
    // an action a proposal can reach (vault-task-routes.ts).
    if (isVaultTaskRoute(key)) return vaultTaskRoutes(req, res, key, { queries, vault: cfg.vault, audit, replays: vaultTaskReplays, now: cfg.now });
    // ----- the meeting-note door: one note per event, from the owner's template, as `user` (T2-11) -----
    if (isMeetingNoteRoute(key)) return meetingNoteRoute(req, res, key, { queries, vault: cfg.vault, audit, notes: meetingNotes });
    // ----- Move a meeting: preview → confirm through the eventkit bridge, which gates events with others in them (T2-12) -----
    if (isMeetingMoveRoute(key)) {
      const runNow = cfg.scheduled?.runNow;
      return meetingMoveRoute(req, res, key, {
        queries,
        eventkit: cfg.eventkit,
        audit,
        ...(runNow ? { refresh: async () => (await runNow(CALENDAR_SYNC)).started } : {}),
      });
    }
    // ----- the pull request doors: a review, a thread reply or resolve, posted as the owner through the github_write client — the head SHA shown must match (§2.11, T2-13) -----
    if (isGithubPullRoute(key)) return githubPullRoute(req, res, key, { db, github: cfg.githubWrite, audit }, principalOf(auth));

    // ----- Close the Day (§2.11, §2.13; T2-8) -----
    // The daily note's section through the reconciler's section operation as
    // `user`, then `plan-tomorrow` enqueued; broken markers are a `note`
    // request and no write (close-day.ts).
    if (isCloseDayRoute(key)) return closeDayRoute(req, res, { db, queries, vault: cfg.vault, audit, plan: cfg.planTomorrow, now: cfg.now });

    // ----- Today (§2.1, §2.10; T2-7): the day composed, any filter, the owner's order -----
    // Every row through a route-only named query; both task reads compile
    // their filter with core's `compileTaskFilter`; an order key outside the
    // day is refused (today-routes.ts).
    if (isTodayRoute(key)) return todayRoutes(req, res, key, url, { db, queries, vault: cfg.vault, audit, timeZone: cfg.timeZone, now: cfg.now });

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
      // Each row is read beside its subject as it stands (T2-14,
      // `SUBJECT_COLUMNS`), so the fingerprint served is the one an answer is
      // judged against.
      const { rows } = await db.query(
        since === null
          ? `SELECT p.id, p.ts, p.kind, p.source_agent, p.trust, p.payload, p.decision, p.decided_at, p.work_id, p.snoozed_until, ${SUBJECT_COLUMNS},
                    p.ts::text || '|' || p.id AS cursor
             FROM proposals p ${SUBJECT_JOINS}
             WHERE p.decision = 'pending' AND (p.snoozed_until IS NULL OR p.snoozed_until <= now()) ORDER BY p.ts DESC, p.id DESC LIMIT $1`
          : `SELECT p.id, p.ts, p.kind, p.source_agent, p.trust, p.payload, p.decision, p.decided_at, p.work_id, p.snoozed_until, ${SUBJECT_COLUMNS},
                    greatest(p.ts, p.decided_at)::text || '|' || p.id AS cursor
             FROM proposals p ${SUBJECT_JOINS}
             WHERE (greatest(p.ts, p.decided_at), p.id) > ($2::timestamptz, $3::bigint) ORDER BY greatest(p.ts, p.decided_at) ASC, p.id ASC LIMIT $1`,
        since === null ? [limit + 1] : [limit + 1, c![1], c![2]],
      );
      const { page, cursor, more } = pageOf(rows as ({ cursor: string } & Record<string, unknown>)[], limit, since);
      // Each row carries its reading from F-5's table (core's `describeRequest`):
      // the word the owner reads, the body, and the answers its type offers.
      // A client draws that and holds no kind → word map of its own — the
      // PWA cannot import core, so this is how it reads the one table. And
      // `subject`, the fingerprint an answer sends back (T2-14).
      return sendJson(res, 200, { proposals: page.map(servedProposal), cursor, more });
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
        const r = await decideProposal(String(id), { decision: body.decision, ...(typeof body.feedback === "string" ? { feedback: body.feedback } : {}) }, { bulk: true });
        results.push({ id, ok: r.status === 200, ...(r.body as Record<string, unknown>) });
      }
      await audit("triage", `batch:${body.decision}`, results.every((r) => r.ok === true), { proposals: ids, applied: results.filter((r) => r.ok === true).length, of: ids.length });
      return sendJson(res, 200, { results });
    }

    const triage = /^POST \/api\/proposals\/(\d+)$/.exec(key);
    if (triage) {
      const body = (await readJson(req)) as DecisionBody;
      const r = await decideProposal(triage[1]!, body);
      return sendJson(res, r.status, r.body);
    }

    // ----- the sidebar row and the Dock badge (§2.10, §2.12; T1-7) -----
    // The named query is the read path (invariant 3): its absence is a
    // refusal with a status, exactly as the export's and the run detail's
    // are, never a silent zero. It always answers one row — `waiting: 0,
    // oldest_ts: null` counts as "nothing needs you" — so there is no
    // not-found case here.
    if (key === "GET /api/needs-you/count") {
      if (!queries.names().includes(PENDING_COUNT_QUERY)) {
        return sendError(res, "not_available", `the named query ${PENDING_COUNT_QUERY} is not loaded (seed/queries/${PENDING_COUNT_QUERY}.yaml, METISTRY_QUERIES_DIRS)`);
      }
      const result = await queries.run(PENDING_COUNT_QUERY);
      const row = result.rows[0] as { waiting?: unknown; oldest_ts?: unknown } | undefined;
      return sendJson(res, 200, {
        waiting: typeof row?.waiting === "number" ? row.waiting : 0,
        oldest_ts: row?.oldest_ts ?? null,
        as_of: result.as_of.toISOString(),
      });
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

    // ----- prose feedback: 👍/👎 on any other generated prose (docs/ops/client-api.md § Prose feedback; T1-12) -----
    // `:id` is a `runs.id` — the one id already stable wherever prose is
    // produced, so "unknown id" is exactly `reply_feedback`'s check, one
    // table over (0031_prose_feedback.sql says why).
    const pf = PROSE_FEEDBACK_ROUTE.exec(key);
    if (pf) {
      const id = Number(pf[2]);
      const exists = await db.query(`SELECT id FROM runs WHERE id = $1`, [id]);
      if (exists.rows.length === 0) return sendError(res, "not_found");
      if (pf[1] === "DELETE") {
        await db.query(`DELETE FROM prose_feedback WHERE prose_id = $1`, [id]);
        await audit("feedback", "clear", true, { prose_id: id });
        return sendJson(res, 200, { ok: true, feedback: null });
      }
      const body = (await readJson(req)) as { rating?: unknown; note?: unknown };
      if (body.rating !== 1 && body.rating !== -1) return sendError(res, "invalid_request");
      if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return sendError(res, "invalid_request");
      const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 500) : null;
      // upsert: the runs row stays immutable, the judgement is revisable
      const { rows } = await db.query(
        `INSERT INTO prose_feedback (prose_id, rating, note) VALUES ($1, $2, $3)
         ON CONFLICT (prose_id) DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note, ts = now()
         RETURNING rating, note, ts`,
        [id, body.rating, note],
      );
      await audit("feedback", body.rating === 1 ? "up" : "down", true, { prose_id: id, rating: body.rating, has_note: note !== null });
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
      // Each row carries its rendered `scope` (core's `describeScope`), so
      // the panel prints the words it is given rather than inventing them —
      // and, since T4-6, its `permissions`: the actor's Resource × Read ×
      // Write rows (core's `describePermissions`, which asks `may()`). The
      // CLI, the console's panel and MetistryKit print these rows and
      // nothing of their own, so the three cannot draw three tables.
      // `access_ceilings` (C42): the (agent, area) pairs whose third ask
      // `request_access` refused after two declines — a refusal that writes
      // no proposal, so this panel is where the owner learns of it.
      const rows = await agents.listAgents(db, (id) => cfg.crews?.toolset(id));
      const sources = await actorSourcesFor(rows);
      return sendJson(res, 200, {
        agents: rows.map((r) => ({ ...r, permissions: actors.permissionLines(r.id, sources) })),
        access_requests: await agents.pendingAccessRequests(db),
        access_ceilings: await agents.accessCeilings(db, rows),
      });
    }

    const definitionOf = AGENT_DEFINITION_ROUTE.exec(key);
    if (definitionOf) {
      // Read-only: the write is `metistry agents define` (M12, §2.2) — the
      // definition says how an actor behaves, so it is the owner's hand on a
      // protected path, never an API call (invariant 2). No row, a revoked
      // row, a crew whose manifest is gone: the family's 404. An external
      // agent answers 200 with `definition: null` — it is someone else's code.
      const id = definitionOf[1]!; // a slug has nothing to percent-decode; anything else is not an id
      if (!agents.AGENT_ID_RE.test(id)) return sendError(res, "not_found", "no such agent, or it is revoked");
      const actor = resolveActor(id, await actorSourcesFor(await agents.listAgents(db)));
      if (!actor) return sendError(res, "not_found", "no such agent, or it is revoked");
      return sendJson(res, 200, actors.definitionBody(actor));
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
      if (!verbOk) return sendUnrouted(res);
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

    return sendUnrouted(res);
  }

  function formatFastPath(query: string, rows: Record<string, unknown>[], asOf: Date): string {
    const age = Math.round((Date.now() - asOf.getTime()) / 60000);
    const stamp = age < 1 ? "as of now" : `as of ${age} min ago`; // freshness stamp (§4.1)
    if (rows.length === 0) return `nothing open (${stamp})`;
    const lines = rows.slice(0, 10).map((r) => `• ${r.title ?? JSON.stringify(r)}${r.status ? ` — ${r.status}` : ""}`);
    return `${query.replaceAll("_", " ")} (${stamp}):\n${lines.join("\n")}`;
  }

  /** What `resolveActor` reads, loaded for this request (actors.ts). */
  async function actorSourcesFor(rows: readonly agents.AgentRow[]) {
    return actors.consoleActorSources(db, {
      rows,
      crews: cfg.crews,
      assistant: cfg.assistantDefinition ? await cfg.assistantDefinition() : { identity: undefined, files: [] },
      compute: cfg.compute?.(),
    });
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
   * **C45** (design-system amendments §2.4): an answer whose consequence
   * fails leaves the request PENDING and says why on the row itself —
   * `payload.error = {code, message, decision, at, …details}` — before the
   * refusal goes back. Every device that draws the row then shows a failure
   * rather than a decision, and the owner still has one to make; there is
   * deliberately no retry. Guarded on `decision = 'pending'` so a failure can
   * never annotate a row somebody else settled in the meantime, and it does
   * not move `changed_at` (a payload write is not a change to the question),
   * so answering again with the same `if_unchanged` is not refused as stale.
   *
   * Every consequential branch of `decideProposal` refuses through here, and
   * apps/console/test/c45.integration.test.ts holds each one to it.
   */
  async function refuseAnswer(id: string, verb: string, code: ErrorCode, message: string, details: Record<string, unknown> = {}): Promise<DecisionOutcome> {
    await db.query(
      `UPDATE proposals SET payload = payload || jsonb_build_object('error', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
      [id, JSON.stringify({ code, message, decision: verb, at: new Date().toISOString(), ...details })],
    );
    return { status: statusFor(code), body: { ...errorEnvelope(code, message), ...details } };
  }

  /**
   * C45 for the Resolve a conflict door (T2-10): the conflict's waiting
   * review — the reconciler's mirror of the copy — carries why a Keep Mine or
   * a Take the Other did not happen, exactly as `refuseAnswer` records a
   * refused answer: `decision` is the verb the button stands for (§2.12:
   * Keep Mine is the review's `allow`, Take the Other its Revise), `door` the
   * door it went through. Pending rows only, and `changed_at` untouched.
   */
  async function recordConflictRefusal(r: ConflictRefusal): Promise<void> {
    const source = knowledgeConflictSource(r.path);
    const error = { code: r.code, message: r.message, decision: r.keep === "mine" ? "allow" : "accept_with_changes", door: "resolve_conflict", keep: r.keep, at: new Date().toISOString() };
    await db.query(
      `UPDATE proposals SET payload = payload || jsonb_build_object('error', $3::jsonb)
       WHERE decision = 'pending' AND source IS NOT NULL AND source->>'kind' = $1 AND source->>'external_ref' = $2`,
      [source.kind, source.external_ref, JSON.stringify(error)],
    );
  }

  /**
   * A consequence that THREW rather than refused: the same C45 record, but
   * `internal` and with no detail — `payload.error` crosses the wire on
   * `GET /api/proposals`, and an internal error's detail goes to the log and
   * `runs` only (core's errors.ts). The throw continues to the route's own
   * uniform 500.
   */
  async function failedAnswer(id: string, verb: string, err: unknown): Promise<never> {
    await refuseAnswer(id, verb, "internal", "the answer could not be carried out; the detail is in the console log").catch(() => {});
    throw err;
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
  async function decideProposal(id: string, body: DecisionBody, opts: { bulk?: boolean } = {}): Promise<DecisionOutcome> {
    const row = (await db.query(PROPOSAL_FOR_DECISION_SQL, [id])).rows[0];
    if (!row) return { status: 404, body: errorEnvelope("not_found", "not found") };
    // Already decided — from another device, or this one before it went
    // offline. 409 with the winner, so a client that queued an answer can
    // show what actually happened rather than "failed"
    // (docs/ops/client-api.md). No re-triage, ever.
    if (row.decision !== "pending") return { status: 409, body: conflictBody("already_decided", "already decided", row) };

    // Decide-time staleness (ADOPT 3). The client sends the `ts`/cursor of the
    // row it RENDERED; if the row moved after that — its payload was
    // rewritten, a comment landed in the linked work row's room, the work row
    // itself moved — the answer was given to a different question, so it is
    // refused and the current row comes back instead. Opt-in: a caller that
    // sends nothing gets exactly the old behaviour.
    //
    // …and its SUBJECT (T2-14, plan §2.12 *Stale*): a card never acts on
    // something the owner didn't see. `subject` is the fingerprint the row was
    // served with (`servedProposal`) — the PR's head, the task's line, the
    // work row — and if what the request is about is not that any more, the
    // answer is refused HERE, before any consequence below runs: nothing is
    // sent, nothing is settled, nothing is written on the row (not even C45's
    // `payload.error` — the question was not answered, so nothing failed). The
    // 409 carries the row with its subject as it stands, to repaint and
    // answer again.
    if (body.if_unchanged !== undefined) {
      const seenBy = body.if_unchanged;
      if (seenBy === null || typeof seenBy !== "object" || Array.isArray(seenBy)) {
        return { status: 400, body: errorEnvelope("invalid_request", "if_unchanged must be an object: {seen_at?, subject?}") };
      }
      const sentSubject = Object.hasOwn(seenBy, "subject");
      if (seenBy.seen_at === undefined && !sentSubject) {
        return { status: 400, body: errorEnvelope("invalid_request", "if_unchanged names what you rendered: seen_at, subject, or both") };
      }
      const seen = seenBy.seen_at === undefined ? undefined : parseSeenAt(seenBy.seen_at);
      if (seen === null) {
        return { status: 400, body: errorEnvelope("invalid_request", "if_unchanged.seen_at must be a timestamp this server minted — the `ts` of the row you rendered, or the list `cursor` you rendered it from") };
      }
      const seenSubject = sentSubject ? parseSubjectFingerprint(seenBy.subject) : null;
      if (seenSubject === undefined) {
        return { status: 400, body: errorEnvelope("invalid_request", "if_unchanged.subject must be the `subject.fingerprint` this server served on the row you rendered, or null for a row served with no subject") };
      }
      if (sentSubject) {
        const now = subjectOfRow(row);
        if (!subjectUnchanged(seenSubject, now)) {
          await audit("triage", "stale", false, { proposal: row.id, kind: row.kind, subject: now?.basis ?? null });
          return { status: 409, body: conflictBody("stale", "what this request is about changed after you saw it", row) };
        }
      }
      if (seen !== undefined && new Date((sentSubject ? row.own_changed_at : row.changed_at) as string).getTime() > seen.getTime()) {
        await audit("triage", "stale", false, { proposal: row.id, kind: row.kind, seen_at: seen.toISOString() });
        return { status: 409, body: conflictBody("stale", "the proposal changed after you saw it", row) };
      }
    }

    // What this row may record is F-5's table, read for this kind and THIS
    // stored payload (`describeRequest(...).decisions`, plan §2.12; T2-3) —
    // never a list built here, and never the request's. A report is Dismissed
    // (`skip`) or acted on at its own door, so it cannot be approved; `later`
    // is not an answer and every row takes it; Skip is bulk-only (K2, above).
    const shape = describeRequest(String(row.kind), row.payload);
    const verbs = new Set<string>([...shape.decisions, "later", ...(opts.bulk === true ? ["skip"] : [])]);
    const verb = typeof body.decision === "string" ? body.decision : "";
    const questions = shape.questions ?? [];

    // A question's answer (T2-3, C105): one entry per question, each one of
    // that question's OWN options or — where it allows it — the owner's words
    // as `other`, checked against the questions as STORED (core's
    // `checkAnswers`). Nothing in an answer is ever executed. The v1 wire, the
    // option itself as `decision`, is still one answer to a row that asks
    // exactly one pick-one question: every client sent that before v2, and
    // removing it would be API version 2 (client-api.md).
    let answered: QuestionAnswer[] | undefined;
    if (body.answers !== undefined && verb !== "answers") {
      return { status: 400, body: errorEnvelope("invalid_request", "answers ride only with decision: answers") };
    }
    const v1Option = shape.type === "question" && !verbs.has(verb) && questions.length === 1 && !questions[0]!.multi && questions[0]!.options.includes(verb);
    if ((verb === "answers" && verbs.has(verb)) || v1Option) {
      if (body.feedback !== undefined) {
        return { status: 400, body: errorEnvelope("invalid_request", "an answer in your own words goes in its question's `other`; feedback belongs to Revise and Decline") };
      }
      const checked = v1Option ? checkAnswers(questions, [{ choices: [verb] }]) : checkAnswers(questions, body.answers);
      if (!checked.ok) return { status: 400, body: errorEnvelope("invalid_request", checked.error) };
      answered = checked.answers;
    } else if (!verbs.has(verb)) {
      const takes = `${[...verbs].join(" | ")}${shape.type === "question" && questions.length === 1 && !questions[0]!.multi ? ", or one of its options" : ""}`;
      const why = verb === "skip" ? `Skip is bulk-only (K2) — POST /api/proposals/batch. ` : "";
      return { status: 400, body: errorEnvelope("invalid_request", `${why}this ${shape.word} takes ${takes}`) };
    }
    // Approve as Work builds a row only from a suggestion this server
    // validates itself — never merely because the payload has the key.
    const suggested = suggestedWorkOf(row);
    if (verb === "accept_as_work" && suggested === undefined) {
      return { status: 400, body: errorEnvelope("invalid_request", "this request carries no suggested_work this console would build a task from — Approve it instead") };
    }
    // An enrolment is a question the CONSOLE asked (agents.ts), and its one
    // consequence is its option `approve` letting the agent in — or Decline,
    // or its option `deny`, revoking it. Never free text: its question takes
    // only its own options, and `other` on any question is words, not a verb.
    // Revise has nothing to change on it, so it is refused, as it always was.
    const enrollAgent = row.kind === "decision" ? agents.enrollTarget(row.payload) : undefined;
    if (enrollAgent !== undefined && verb === "accept_with_changes") {
      return { status: 400, body: errorEnvelope("invalid_request", "an enrolment is answered approve or deny — Revise has nothing to change on it") };
    }
    const only = answered?.length === 1 && answered[0]!.other === undefined && answered[0]!.choices.length === 1 ? answered[0]!.choices[0] : undefined;
    const enrolment: "approve" | "deny" | undefined = enrollAgent === undefined ? undefined : verb === "deny" ? "deny" : only === "approve" || only === "deny" ? only : undefined;

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
    //
    // An improvement that carries a `Me/` edit — *Tidy Me/profile.md* (T3-4,
    // profile-tidy.ts), and the session fold's profile facts after it — is
    // the owner's hand on the owner's own file: Approve writes exactly the
    // "after" they were shown, as `user`, and is refused `stale` (nothing
    // written, the request still waiting) if the file is no longer the
    // "before". Revise and Decline write nothing.
    let applied: { path: string; created: boolean } | undefined;
    // A rollback (T10-6, vault-rollback.ts) is an improvement THIS console
    // raised on the owner's word: Approve runs the reconciler's revert as
    // `user` — a new commit, pinned to the previewed history and refused
    // `stale` (nothing changed, the request still waiting) if the change set
    // moved. One that includes configuration is carried out by the waiting
    // `metistry vault rollback --include-config`, never by this bearer. A row
    // carrying a rollback this console did not raise rolls back nothing and
    // is never read as a prompt improvement. Revise and Decline change nothing.
    const rollingBack = row.kind === "improvement" && carriesRollback(row.payload);
    let rolledBack: Awaited<ReturnType<typeof applyRollback>> | undefined;
    if (rollingBack && verb === "allow") {
      const edit = rollbackOf(row);
      if (edit === null) {
        await audit("triage", "rollback", false, { proposal: row.id, error: "not_ours" });
        return refuseAnswer(id, verb, "invalid_request", "this request carries a rollback this console did not raise, so Approve rolls back nothing — Decline it, and ask again from the Mac");
      }
      if (!edit.include_config && !cfg.vaultRevert) return refuseAnswer(id, verb, "not_available", "approving this rolls the vault back, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)");
      try {
        rolledBack = await applyRollback(cfg.vaultRevert!, edit, row.id);
      } catch (err) {
        if (err instanceof VaultError) {
          await audit("triage", "rollback", false, { proposal: row.id, error: err.code });
          const refused = await refuseAnswer(id, verb, err.code, err.message);
          return err.code === "conflict" ? { status: 409, body: conflictBody("stale", err.message, row) } : refused;
        }
        return failedAnswer(id, verb, err);
      }
      await db.query(`UPDATE proposals SET payload = payload || jsonb_build_object('rolled_back', $2::jsonb) WHERE id = $1 AND decision = 'pending'`, [
        id,
        JSON.stringify({ ...rolledBack, at: new Date().toISOString(), by: "user" }),
      ]);
    }
    // A restore (T10-5, knowledge-restore.ts) is an improvement THIS console
    // raised on the owner's word: Approve writes the note's bytes at the
    // request's commit back as `user`, a new commit, refused `stale`
    // (nothing written, the request still waiting) if the file is no longer
    // the "before" it showed. A row that carries a restore this console did
    // not raise — an agent's, a hand-written one — restores nothing, and is
    // never read as a prompt improvement either. Revise and Decline write nothing.
    const restoring = row.kind === "improvement" && carriesRestore(row.payload);
    let restored: { path: string; sha: string; sha256: string } | undefined;
    // A routine suggestion (T3-11, routine-suggestions.ts) is an improvement
    // pointed at one entry of `.metistry/scheduled.yaml`: Approve writes
    // exactly the "after" the owner was shown, through the Scheduled door
    // (`applyEdit`) as `user`, refused `stale` (nothing written, the request
    // still waiting) if the entry is no longer the "before". A row that
    // carries one is never read as a `Me/` edit or a prompt improvement, and
    // an agent's (`trust: external`) changes nothing. Revise, Decline and
    // Later write nothing.
    const suggesting = row.kind === "improvement" && !restoring && !rollingBack && carriesSuggestion(row.payload);
    let scheduledApplied: { section: string; name: string; path: string } | undefined;
    const meEdit = row.kind === "improvement" && !restoring && !rollingBack && !suggesting ? meEditOf(row.payload) : null;
    if (rollingBack) {
      // handled above
    } else if (suggesting) {
      if (verb === "allow") {
        const suggestion = suggestionOf(row.payload);
        if (suggestion === null || row.trust === "external") {
          await audit("triage", "scheduled_suggestion", false, { proposal: row.id, error: suggestion === null ? "malformed" : "external" });
          return refuseAnswer(
            id,
            verb,
            "invalid_request",
            suggestion === null
              ? "this request's routine change is not one Approve can carry out as shown — Decline it"
              : "an agent's request cannot change a routine — Decline it, and change the routine in Scheduled if you want to",
          );
        }
        if (!cfg.scheduled) return refuseAnswer(id, verb, "not_available", "approving this changes .metistry/scheduled.yaml, and this console has no Scheduled wired in (docs/ops/scheduled.md)");
        let r: Awaited<ReturnType<typeof applySuggestion>>;
        try {
          r = await applySuggestion(cfg.scheduled, suggestion, row.id);
        } catch (err) {
          return failedAnswer(id, verb, err);
        }
        const { section, name } = suggestion.edit;
        if (!r.ok) {
          await audit("triage", "scheduled_suggestion", false, { proposal: row.id, name, error: r.refusal.code });
          const refused = await refuseAnswer(id, verb, r.refusal.code, r.refusal.message);
          // the entry moved under the owner: F-1's `stale`, as every other door's 409 says
          return r.refusal.code === "conflict" ? { status: 409, body: conflictBody("stale", r.refusal.message, row) } : refused;
        }
        // the Scheduled door's own audit row — the change is recorded where every Scheduled change is
        await audit("scheduled", "suggestion", true, { name, section, proposal: row.id });
        scheduledApplied = { section, name, path: SCHEDULED_PATH };
        await db.query(`UPDATE proposals SET payload = payload || jsonb_build_object('scheduled_applied', $2::jsonb) WHERE id = $1 AND decision = 'pending'`, [
          id,
          JSON.stringify({ section, name, at: new Date().toISOString(), by: "user" }),
        ]);
      }
    } else if (restoring) {
      if (verb === "allow") {
        const restore = restoreOf(row);
        if (restore === null) {
          await audit("triage", "restore", false, { proposal: row.id, error: "not_ours" });
          return refuseAnswer(id, verb, "invalid_request", "this request carries a restore this console did not raise, so Approve restores nothing — Decline it, and restore from the note's history in Knowledge");
        }
        if (!cfg.vault || !cfg.knowledgeHistory) return refuseAnswer(id, verb, "not_available", `approving this restores ${restore.path}, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)`);
        try {
          const r = await applyRestore(cfg.vault, cfg.knowledgeHistory, restore, row.id);
          applied = { path: r.path, created: r.created };
          restored = { path: r.path, sha: restore.sha, sha256: r.sha256 };
        } catch (err) {
          if (err instanceof VaultError) {
            await audit("triage", "restore", false, { proposal: row.id, path: restore.path, error: err.code });
            const refused = await refuseAnswer(id, verb, err.code, err.message);
            // the file moved under the owner: F-1's `stale`, as every other door's 409 says
            return err.code === "conflict" ? { status: 409, body: conflictBody("stale", err.message, row) } : refused;
          }
          return failedAnswer(id, verb, err);
        }
        await db.query(
          `UPDATE proposals SET payload = payload || jsonb_build_object('restored', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
          [id, JSON.stringify({ path: restored.path, sha: restored.sha, sha256: restored.sha256, at: new Date().toISOString(), by: "user" })],
        );
      }
    } else if (meEdit !== null && verb === "allow") {
      if (!cfg.vault) return refuseAnswer(id, verb, "not_available", `approving this writes ${meEdit.path}, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)`);
      try {
        const r = await applyMeEdit(cfg.vault, meEdit, row.id);
        applied = { path: r.path, created: false };
      } catch (err) {
        if (err instanceof VaultError) {
          await audit("triage", "me_edit", false, { proposal: row.id, path: meEdit.path, error: err.code });
          const refused = await refuseAnswer(id, verb, err.code, err.message);
          // the file moved under the owner: the same `stale` every other door's 409 says (F-1)
          return err.code === "conflict" ? { status: 409, body: conflictBody("stale", err.message, row) } : refused;
        }
        return failedAnswer(id, verb, err);
      }
    } else if (row.kind === "improvement" && verb === "allow") {
      if (!cfg.vault) return refuseAnswer(id, verb, "not_available", "applying an improvement proposal writes assistant-prompt.md, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)");
      try {
        const r = await applyImprovement(cfg.vault, row.payload, row.id);
        applied = { path: r.path, created: r.created };
      } catch (err) {
        if (err instanceof VaultError) {
          await audit("triage", "improvement", false, { proposal: row.id, error: err.code });
          return refuseAnswer(id, verb, err.code, err.message);
        }
        return failedAnswer(id, verb, err);
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
        return refuseAnswer(id, verb, "invalid_request", `this proposal does not carry a valid action — ${parsed.error}`);
      }
      const r = await runAction(actionServices(), parsed.action, { proposalId: Number(row.id), onBehalfOf: String(row.source_agent) }).catch((err: unknown) => failedAnswer(id, verb, err));
      if (!r.ok) {
        // the row stays pending, carrying why: the user still has a decision
        await audit("triage", `action:${parsed.action.kind}`, false, { proposal: row.id, action: parsed.action.kind, on_behalf_of: row.source_agent, error: r.code });
        return refuseAnswer(id, verb, r.code, r.message, r.details ?? {});
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
          return refuseAnswer(id, verb, err.code === "conflict" ? "conflict" : "invalid_request", err.message);
        }
        return failedAnswer(id, verb, err);
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
    if (enrollAgent !== undefined && enrolment !== undefined) {
      const approved = enrolment === "approve";
      const ok = approved ? await agents.approveAgent(db, enrollAgent) : await agents.revokeAgent(db, enrollAgent);
      await audit("agent_admin", approved ? "approve" : "revoke", ok, { agent: enrollAgent, op: approved ? "approve" : "revoke", via: "triage", proposal: row.id });
      // An approval that let nobody in (the agent was revoked, or is gone,
      // since it asked) is a failed consequence, not an answer: C45 keeps the
      // row pending with the reason. A `deny` that finds the agent already
      // revoked is different — its consequence, nobody gets in, already holds.
      if (approved && !ok) {
        return refuseAnswer(id, verb, "not_found", `${enrollAgent} is revoked or no longer registered — there is nothing to let in. Decline or Skip this request.`);
      }
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
    let granted: { agent: string; area: string; grants: agents.Grants; prior_tier: agents.Grants["tier"] } | undefined;
    if (row.kind === agents.ACCESS_REQUEST_KIND && (verb === "allow" || verb === "accept_with_changes")) {
      const asked = agents.accessArea(row.payload);
      if (asked === undefined) {
        await audit("triage", "access_request", false, { proposal: row.id, error: "no_area" });
        return refuseAnswer(id, verb, "invalid_request", "this request does not name a vault area this console would grant — Decline it (the asking tool validates the prefix, so a row without one was not written by request_access)");
      }
      // Revise carries the prefix the owner is granting INSTEAD. It is
      // validated here with the grant validator's own rule, so the narrowing
      // gesture cannot smuggle in a shape the form would have refused.
      const area = verb === "accept_with_changes" ? (typeof body.area === "string" ? body.area.trim() : "") : asked;
      if (verb === "accept_with_changes" && !validAgentAreaGrant(area)) {
        return refuseAnswer(id, verb, "invalid_request", `revising an access request means granting a different area: send {"area": "…"} with it — ${AREA_PREFIX_REFUSAL}. To refuse it outright, Decline.`);
      }
      // …and it can only grant LESS (C40, ruled 2026-09-20): the asked prefix
      // is the ceiling, and a revision must be it or a folder under it. A
      // wider or sibling area is refused here, before anything reads the
      // registry, and NOTHING is written — not the grant, not an override,
      // not the row's `payload.error`: this is the request being malformed
      // (the control cannot express it), not a consequence that failed
      // (C45), so the card stays exactly as the owner last saw it. The
      // refusal is audited like its siblings below.
      if (verb === "accept_with_changes" && !agents.revisionWithin(asked, area)) {
        await audit("triage", "access_request", false, { proposal: row.id, agent: String(row.source_agent), error: "wider_than_asked", asked, area });
        return { status: 400, body: { ...errorEnvelope("invalid_request", agents.revisionRefusal(asked, area)), asked } };
      }
      const target = String(row.source_agent);
      const current = (await agents.listAgents(db)).find((a) => a.id === target && !a.revoked);
      // A CREW's scope is its manifest, re-read on every crew sync, so an
      // approval here would vanish at the next one and the owner would
      // believe they had granted it. No crew's allowlist carries the tool
      // (core's CREW_NEVER_TOOLS); this is the same rule at the door where
      // the grant would actually move.
      //
      // An INTERNAL row is no longer in that set (ruled 2026-09-19 B: "the
      // assistant should be able to ask"). Its configured grants are still
      // replaced at every start — but an approval is now RECORDED beside them
      // (`recordGrantOverride`, migration 0023) and merged back on the way in,
      // so the widening survives the re-sync instead of being quietly undone.
      //
      // Written as "anything that is neither external nor internal" rather
      // than "crew" so a kind added later is refused until somebody decides
      // where ITS scope comes from.
      if (current && current.kind !== "external" && current.kind !== "internal") {
        await audit("triage", "access_request", false, { proposal: row.id, agent: target, error: "configured_scope" });
        return refuseAnswer(
          id,
          verb,
          "forbidden",
          `${target}'s scope is configuration, not a grant: it is re-synced from its manifest (\`scope:\` in agents/<area>/${target}.md), so approving this would be undone at the next crew sync. Decline this request and edit that file (docs/ops/actions.md).`,
        );
      }
      if (!current) {
        // A revoked (or vanished) agent cannot be granted anything: its token
        // authenticates nothing, so a widening would be a grant to nobody
        // that still reads as a grant in the registry. The row stays pending
        // and Decline is right there. (Revocation itself settles pending asks
        // — agents.ts's `settleAccessRequests` — so this is the row that
        // predates that, or a race with it.)
        await audit("triage", "access_request", false, { proposal: row.id, agent: target, error: "revoked" });
        return refuseAnswer(id, verb, "not_found", `${target} is revoked or no longer registered — there is nothing to widen. Decline or Skip this request.`);
      }
      try {
        const widened = agents.widenedGrants(current.grants, area);
        const { ok, grants } = await writeGrants(target, widened, "triage", { proposal: row.id, area, ...(area === asked ? {} : { asked }) });
        if (!ok) return refuseAnswer(id, verb, "not_found", `${target} is revoked or no longer registered — there is nothing to widen. Decline or Skip this request.`);
        // For a row whose grants come back from configuration at every start,
        // the write above holds until the next restart and no further: the
        // approval itself is the durable record (0023), merged on top of the
        // configured areas by `ensureInternalAgent`. Recorded only when it
        // actually widened — an area a configured prefix already covers is
        // not an approval to carry forward, it is a no-op.
        const added = widened.areas.length > (current.grants.tier === "areas" ? current.grants.areas.length : 0);
        if (current.kind === "internal" && added) await agents.recordGrantOverride(db, target, area, Number(row.id));
        // `prior_tier` (C41): what the credential held before this answer.
        // An area grant IS tier `areas`, so for a row at `index` Approve is
        // also a loss — vault-wide titles for titles inside its folders — and
        // the answer says so in data, from the registry as it stood, rather
        // than leaving each client to derive the trade from a payload
        // snapshot that may be older than the row.
        granted = { agent: target, area, grants, prior_tier: current.grants.tier };
      } catch (err) {
        if (err instanceof agents.AgentError) {
          await audit("triage", "access_request", false, { proposal: row.id, agent: target, error: err.code });
          return refuseAnswer(id, verb, err.code, err.message);
        }
        return failedAnswer(id, verb, err);
      }
      // The outcome rides on the row, as the action path's does: what was
      // granted, to whom, by whom, and what was asked for when they differ.
      await db.query(
        `UPDATE proposals SET payload = payload || jsonb_build_object('granted', $2::jsonb) WHERE id = $1 AND decision = 'pending'`,
        [id, JSON.stringify({ area, grants: granted.grants, prior_tier: granted.prior_tier, at: new Date().toISOString(), by: "user" })],
      );
    }

    // What lands in the row: `skip` stores a `deny` whose feedback is the
    // fixed marker (never the user's words — a skip is not a reason, and
    // SKIP_FEEDBACK is what keeps it out of the paths that route feedback
    // back to the source agent), `accept_as_work` stores an `allow` and the
    // work id it just created.
    //
    // A question's answers store `answered` — what answering it in chat has
    // always stored — with the per-question record in `payload.answers` and
    // its words in `feedback`, written in the same statement that settles the
    // row so an answer is never recorded on a question someone else settled.
    // An enrolment keeps storing its own `approve | deny`, which is what the
    // registry pane's settling writes too (`settleEnrollment`) — and no words:
    // its option is a verb there, and `deny` + feedback is what the weekly
    // review reads as a reason the owner gave.
    const storedDecision = verb === "skip" ? "deny" : verb === "accept_as_work" ? "allow" : (enrolment ?? (answered ? "answered" : verb));
    const storedFeedback = verb === "skip" ? SKIP_FEEDBACK : answered && enrolment === undefined ? answersText(questions, answered) : (body.feedback ?? null);
    const { rows } = await db.query(
      `UPDATE proposals SET decision = $2, feedback = $3, decided_at = now(), snoozed_until = NULL,
              work_id = coalesce($4::bigint, work_id),
              payload = CASE WHEN $5::jsonb IS NULL THEN payload ELSE payload || jsonb_build_object('answers', $5::jsonb) END
       WHERE id = $1 AND decision = 'pending' RETURNING id`,
      [id, storedDecision, storedFeedback, created ? created.id : null, answered ? JSON.stringify(answered) : null],
    );
    await audit("triage", answered ? "answers" : verb, rows.length === 1, {
      proposal: row.id,
      kind: row.kind,
      ...(answered ? { questions: answered.length, ...(verb !== "answers" ? { v1_option: true } : {}) } : {}),
      ...(applied ? (restored ? { restored: applied.path, from: restored.sha } : meEdit !== null ? { wrote: applied.path } : { overlay: applied.path }) : {}),
      ...(created ? { work_id: created.id } : {}),
      ...(acted ? { action: acted.kind } : {}),
      ...(granted ? { granted: granted.area, agent: granted.agent } : {}),
      ...(rolledBack ? { rolled_back: rolledBack.runs_in === "console" ? rolledBack.sha : "runs_in_cli" } : {}),
    });
    if (rows.length === 1) {
      return { status: 200, body: { ok: true, ...(applied ? { applied } : {}), ...(restored ? { restored } : {}), ...(rolledBack ? { rolled_back: rolledBack } : {}), ...(scheduledApplied ? { scheduled: scheduledApplied } : {}), ...(enrolled ? { enrolled } : {}), ...(created ? { work: created } : {}), ...(acted ? { action: acted } : {}), ...(granted ? { granted } : {}) } };
    }
    // lost the race between the read above and this update: someone else decided it
    const now = (await db.query(PROPOSAL_FOR_DECISION_SQL, [id])).rows[0];
    return { status: 409, body: conflictBody("already_decided", "already decided", now ?? row) };
  }
}
