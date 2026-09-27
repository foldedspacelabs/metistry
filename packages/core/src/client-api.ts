// The client API as data (design-build-plan §2.1, F-1). ONE API for every
// client: the console's routes are what the Mac app (through `metistry
// console session --stdio`), the PWA and a future phone all speak — same
// routes, same bodies, same errors. `docs/ops/client-api.md` is the same
// contract in words, and a test holds the two line for line; a conformance
// test in `apps/console` fails CI when the console serves a route this table
// does not list, or lists a route nothing serves. The console also reads it
// before it dispatches anything to the owner (`servedRoute`), so a handler
// without a served row here is unreachable rather than undocumented.
//
// Each row is `{method, path, reach, principals, idempotent, conflict,
// cursor}` (the plan's shape), plus `served` and `ticket` — because the table
// is frozen ahead of the tickets that build it, and a row nobody serves yet
// must say so and say who will — and a one-line `summary`.
//
// **Reach** is the class the gate enforces, never the client (§2.1):
//
//   public  anyone — the bootstrap: health, identity, the passkey ceremony
//   agent   agent bearers and the capture owner token — /mcp, POST /capture
//   owner   the owner from any client — a passkey session or the local owner token
//   local   the owner on THIS Mac — the local owner token only, from a loopback peer
//
// The console's gate reads `local` off this table (`isLocalRoute`, F-13): a
// served `local` row refuses every owner credential but the local owner token
// with `403 local_only` (`localOnlyMessage`), before any handler runs — so a
// row turned `local` here is enforced with no second list in the server.
//
// **Principals** are the credential kinds that actually get through, spelled
// as the console's own `Auth` kinds (`apps/console/src/server.ts`) so a gate
// can compare them directly. They are recorded, not aspired to: where an
// existing route admits more or less than its reach class — the capture
// token on five `owner` routes, a passkey session alone on push — the row says
// what the server does today, and the conformance test holds it to that.
//
// Nothing here imports the console, Postgres or the vault: a stranger's client
// can read this table, and the Mac app's store protocols are written against
// it, one method per route (F-7).

/** The contract's version (§2.1): in `GET /api/identity`, `GET /health` and every response's header. Additive changes keep it; removing or changing the meaning of anything is version 2, served beside 1 for at least one release. */
export const API_VERSION = 1 as const;

/** The response header every console answer carries — the version without parsing a body. */
export const API_VERSION_HEADER = "Metistry-API-Version";

/** The four reach classes, enforced at the gate (§2.1). */
export const REACHES = ["public", "agent", "owner", "local"] as const;
export type ClientReach = (typeof REACHES)[number];

/**
 * The credential kinds a request can arrive with. `anyone` stands for "no
 * credential needed" and appears only on `public` rows; the other four are
 * the console's `Auth` kinds, one for one.
 */
export const CLIENT_PRINCIPALS = ["anyone", "session", "local_owner", "owner_token", "agent"] as const;
export type ClientPrincipal = (typeof CLIENT_PRINCIPALS)[number];

/** Which credential kinds each reach class stands for. A row's `principals` is the truth; this is the class it is filed under. */
export const REACH_PRINCIPALS: Readonly<Record<ClientReach, readonly ClientPrincipal[]>> = {
  public: ["anyone"],
  agent: ["agent", "owner_token"],
  owner: ["session", "local_owner"],
  local: ["local_owner"],
};

/** `*` is the MCP transport's own door: it answers every method itself. */
export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "*"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

/**
 * How a retry behaves.
 *
 *   key      the route honours `Idempotency-Key`: the same key replays the first response
 *   natural  the route is idempotent by its own identity (a read, a replace, an upsert) — no key needed
 *   no       a replay is a second act, or a 409: never replay one blindly
 */
export const IDEMPOTENCY = ["key", "natural", "no"] as const;
export type Idempotency = (typeof IDEMPOTENCY)[number];

/** Every `reason` a `409` may carry, across the whole API. A client branches on these, never on a message. */
export const CONFLICT_REASONS = ["already_decided", "stale"] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export interface ClientRoute {
  readonly method: RouteMethod;
  /** A template: literal segments and `:name` parameters, one path segment each. */
  readonly path: string;
  /** Non-empty. More than one only where a route is a door for two classes (`POST /capture`). */
  readonly reach: readonly ClientReach[];
  readonly principals: readonly ClientPrincipal[];
  readonly idempotent: Idempotency;
  /** `null`: this route never answers 409. An array: it may, and these are the `reason`s the 409 carries — empty where it carries none yet (the message names what would permit it). */
  readonly conflict: readonly ConflictReason[] | null;
  /** The route takes a `since` cursor and answers with the next one. */
  readonly cursor: boolean;
  /** Something serves it today. `false` rows are frozen ahead of the ticket named in `ticket`. */
  readonly served: boolean;
  /** Unserved: the ticket that adds it. Served: the ticket that changes it next, if any. */
  readonly ticket: string | null;
  /** One line; the document's route table repeats it. */
  readonly summary: string;
}

type Options = Partial<Omit<ClientRoute, "method" | "path" | "summary">>;

const OWNER: readonly ClientPrincipal[] = REACH_PRINCIPALS.owner;
/** The five `owner` routes the host-minted capture token has always reached — they sit after the agent gate and before the management gate, and docs/ops/auth.md lists most of them as its reach. Recorded here, and pinned by a test so widening it is a decision. */
const OWNER_AND_CAPTURE_TOKEN: readonly ClientPrincipal[] = ["session", "local_owner", "owner_token"];
/** Push and logout act on a device SESSION row; the local owner token has none. */
const SESSION_ONLY: readonly ClientPrincipal[] = ["session"];

/** One row, with the defaults most rows share: `owner`, served, a GET is `natural` and anything else `no`. */
function route(method: RouteMethod, path: string, summary: string, o: Options = {}): ClientRoute {
  const reach = o.reach ?? ["owner"];
  return {
    method,
    path,
    reach,
    principals: o.principals ?? (reach.length === 1 && reach[0] === "local" ? REACH_PRINCIPALS.local : reach.length === 1 && reach[0] === "public" ? REACH_PRINCIPALS.public : OWNER),
    idempotent: o.idempotent ?? (method === "GET" ? "natural" : "no"),
    conflict: o.conflict ?? null,
    cursor: o.cursor ?? false,
    served: o.served ?? true,
    ticket: o.ticket ?? null,
    summary,
  };
}

/** A row frozen ahead of the ticket that builds it. */
function planned(method: RouteMethod, path: string, ticket: string, summary: string, o: Options = {}): ClientRoute {
  return route(method, path, summary, { ...o, served: false, ticket });
}

const PUBLIC: Options = { reach: ["public"] };

/**
 * The table. Order is the document's order, family by family; the doc test
 * compares the two row for row, so a new route is one line here and one line
 * there.
 */
export const CLIENT_API: readonly ClientRoute[] = [
  // ----- bootstrap: public, and nothing the login page does not already show -----
  route("GET", "/health", "liveness, and `api_version`", PUBLIC),
  route("GET", "/api/identity", "who this instance is before sign-in: name, icon, capabilities, `api_version`", PUBLIC),
  route("POST", "/auth/enroll/start", "begin enrolling a passkey with a one-time code", PUBLIC),
  route("POST", "/auth/enroll/finish", "finish enrolling; sets the session cookie", PUBLIC),
  route("POST", "/auth/login/start", "begin a passkey sign-in", PUBLIC),
  route("POST", "/auth/login/finish", "finish a passkey sign-in; sets the session cookie", PUBLIC),

  // ----- the agent surface -----
  route("*", "/mcp", "the MCP bridge: the tools an agent bearer's grants allow", { reach: ["agent"], principals: ["agent"] }),
  route("POST", "/capture", "a note or a file into `Inbox/`; `source: \"app\"` for an owner credential (T2-1)", {
    reach: ["agent", "owner"],
    principals: ["session", "local_owner", "owner_token", "agent"],
    idempotent: "key",
  }),

  // ----- who you are, and your devices -----
  route("GET", "/api/whoami", "which credential this is and whether it reaches management", { principals: OWNER_AND_CAPTURE_TOKEN }),
  route("POST", "/auth/logout", "end this device's session", { principals: SESSION_ONLY }),
  route("GET", "/api/devices", "the enrolled passkeys and their sessions"),
  route("POST", "/api/devices/:id/revoke", "end one device session"),

  // ----- chat -----
  route("POST", "/message", "send a message; `tier` picks the model tier for this one", { principals: OWNER_AND_CAPTURE_TOKEN }),
  route("GET", "/api/messages", "the conversation, inbound and outbound", { principals: OWNER_AND_CAPTURE_TOKEN, cursor: true }),
  route("POST", "/api/messages/:id/feedback", "rate one reply, with an optional note", { idempotent: "natural" }),
  route("DELETE", "/api/messages/:id/feedback", "clear a reply's rating", { idempotent: "natural" }),

  // ----- push: bound to a device session -----
  route("GET", "/api/push/vapid-key", "the VAPID public key to subscribe with", { principals: SESSION_ONLY }),
  route("POST", "/api/push/subscribe", "store this session's push subscription", { principals: SESSION_ONLY, idempotent: "natural" }),
  route("POST", "/api/push/test", "send one test notification to this session", { principals: SESSION_ONLY }),

  // ----- status -----
  route("GET", "/api/status", "the console's own checks: the database and the capture sink", { principals: OWNER_AND_CAPTURE_TOKEN }),

  // ----- Needs You -----
  route("GET", "/api/proposals", "the queue; with `since`, everything that changed", { cursor: true }),
  route("POST", "/api/proposals/batch", "one verb (`later`, `skip`, `deny`) to many requests; per-row results"),
  route("POST", "/api/proposals/:id", "answer one request; `if_unchanged` refuses a stale answer", { conflict: ["already_decided", "stale"], ticket: "T2-3" }),
  route("GET", "/api/needs-you/count", "how many requests wait: the sidebar row and the Dock badge"),

  // ----- agents -----
  route("GET", "/api/agents", "the registry, each row's rendered scope and permission rows, and the unanswered access requests"),
  // minting a bearer is a boundary change: the owner on this Mac, never a passkey session (F-13)
  route("POST", "/api/agents", "register an agent and mint its bearer (shown once)", { reach: ["local"], conflict: [] }),
  route("PUT", "/api/agents/:id/grants", "replace an agent's knowledge grant", { idempotent: "natural" }),
  route("PUT", "/api/agents/:id/projects", "replace the projects an agent may work in", { idempotent: "natural" }),
  route("PUT", "/api/agents/:id/autonomy", "replace an agent's autonomy; the one route that may widen it", { idempotent: "natural", conflict: [] }),
  route("POST", "/api/agents/:id/revoke", "revoke an agent's bearer"),
  route("POST", "/api/agents/:id/rotate", "mint a new bearer for an agent (shown once)", { reach: ["local"] }),
  route("POST", "/api/agents/:id/approve", "let a pending remote enrolment in", { idempotent: "natural" }),
  route("GET", "/api/agents/:id/definition", "an agent's definition, compute and limits, read-only — the write is `metistry agents define`"),

  // ----- projects -----
  route("GET", "/api/projects", "every project with its mode, budget and rollup"),
  route("PUT", "/api/projects/:slug", "set a project's mode, daily budget and caps", { idempotent: "natural" }),

  // ----- work: the board, dispatch -----
  route("GET", "/api/targets", "the compute targets a task may be dispatched to", { ticket: "T4-11" }),
  route("POST", "/api/tasks/:id/dispatch", "dispatch a task to a compute target", { conflict: [], ticket: "T4-11" }),
  route("PATCH", "/api/tasks/:id", "edit a task: status, owner, project, title, description", { conflict: [], ticket: "T1-1" }),
  route("POST", "/api/tasks/:id/claim", "claim a task, with a lease", { conflict: [] }),
  route("POST", "/api/tasks/:id/release", "release a claimed task", { conflict: [] }),
  route("POST", "/api/tasks/:id/renew", "renew a claim's lease", { conflict: [] }),

  // ----- artifacts, reviews and rooms -----
  route("GET", "/api/artifacts", "the artifacts, newest first"),
  route("POST", "/api/artifacts", "publish an artifact version; idempotent on its `idempotency_key`", { idempotent: "natural", conflict: [] }),
  route("GET", "/api/artifacts/:id", "one artifact"),
  route("GET", "/api/artifacts/:id/versions", "an artifact's versions"),
  route("GET", "/api/artifacts/:id/versions/:version", "one version and its files"),
  route("GET", "/api/artifacts/:id/versions/:version/file", "one file of a version, inline or raw"),
  route("GET", "/api/artifacts/:id/diff", "the diff between two versions"),
  route("GET", "/api/artifacts/:id/comments", "a version's comment threads"),
  route("POST", "/api/artifacts/:id/comments", "comment on a version, or reply to a comment"),
  route("POST", "/api/artifacts/:id/comments/:comment/resolve", "resolve a comment thread"),
  route("POST", "/api/artifacts/:id/comments/:comment/reopen", "reopen a comment thread"),
  route("POST", "/api/dispatches", "dispatch an artifact for review"),
  route("GET", "/api/dispatches/:id", "a review dispatch's status"),
  route("GET", "/api/work/:id/thread", "a task's room"),
  route("POST", "/api/work/:id/comments", "a message into a task's room"),
  route("POST", "/api/work/:id/thread/resolve", "resolve a task's room"),
  route("POST", "/api/work/:id/thread/reopen", "reopen a task's room"),

  // ----- the ledger -----
  route("GET", "/api/runs/export", "the audit ledger as NDJSON, oldest first", { cursor: true }),
  route("GET", "/api/runs/:id", "one run in full, with the tool calls of its turn"),
  route("GET", "/api/turns/:turn_id/progress", "a turn's tool calls so far: the working indicator"),
  route("GET", "/api/sessions/:id", "one archived session"),
  route("POST", "/api/sessions/purge", "purge the session archive now; the confirm names unfolded sessions", { reach: ["local"] }),

  // ----- registries the clients read -----
  route("GET", "/api/instances", "the linked instances (`instances.yaml`)"),
  route("GET", "/api/commands", "the composer's commands and agents, generated from the rules and the registry"),

  // ----- compute -----
  route("GET", "/api/compute", "providers, assignments, budgets and spend"),
  route("GET", "/api/compute/models", "the models each provider serves"),
  route("POST", "/api/compute/assign", "assign a model and effort to a tier or a crew", { idempotent: "natural" }),
  route("POST", "/api/compute/budget", "set a spending limit and what happens at it", { idempotent: "natural" }),
  route("POST", "/api/compute/providers/test", "test a configured provider's credential"),

  // ----- knowledge -----
  route("GET", "/api/knowledge/search", "search the vault: keyword, semantic or hybrid"),
  route("GET", "/api/knowledge/page", "one page's content"),
  route("GET", "/api/knowledge/pages", "the page index, filtered by area or prefix"),
  route("GET", "/api/knowledge/links", "a page's links, both directions"),
  route("GET", "/api/knowledge/fold", "the latest knowledge fold"),
  route("GET", "/api/knowledge/drafts", "the drafts waiting on the owner"),
  route("GET", "/api/knowledge/areas", "the per-area rollup"),
  planned("POST", "/api/knowledge/conflicts/resolve", "T2-10", "settle a conflicted file: keep one side", { conflict: ["stale"] }),
  route("GET", "/api/knowledge/history", "a file's commits"),
  route("GET", "/api/knowledge/version", "one file at one commit"),
  planned("POST", "/api/knowledge/restore", "T10-5", "raise a Needs You request to restore a file; Approve restores as `user`", { conflict: ["stale"] }),

  // ----- the named queries -----
  route("GET", "/api/q/:name", "run a named query exposed `generic`", { principals: OWNER_AND_CAPTURE_TOKEN }),

  // ----- Today and the vault's tasks -----
  planned("GET", "/api/today", "T2-7", "the day: tasks, work, order, events, brief, standup and plan"),
  planned("GET", "/api/vault-tasks", "T2-7", "vault tasks by filter: Slipping, Owed, Waiting on Others"),
  planned("PUT", "/api/today/order", "T2-7", "the owner's order for the day", { idempotent: "natural" }),
  route("POST", "/api/vault-tasks/:task_key/check", "tick or untick one task line", { idempotent: "key", conflict: ["stale"] }),
  route("POST", "/api/vault-tasks/:task_key/schedule", "defer one task line: a `do` date or someday", { idempotent: "key", conflict: ["stale"] }),
  planned("POST", "/api/vault-tasks/:task_key/link", "T4-25", "add one tracker ref to one task line", { conflict: ["stale"] }),
  planned("POST", "/api/today/close", "T2-8", "Close the Day: write the section, then plan tomorrow"),

  // ----- calendar and mail -----
  planned("POST", "/api/meetings/:event_id/note", "T2-11", "the meeting note for one event; a second call returns the first", { idempotent: "natural" }),
  planned("POST", "/api/calendar/events/:id/move", "T2-12", "move an event: preview, then confirm with a single-use token"),
  planned("POST", "/api/calendar/invitations/:id/respond", "T4-17", "answer an invitation through the connection that can"),
  planned("POST", "/api/mail/messages/:id/draft", "T4-17", "draft a reply through the connection that can; never sends"),

  // ----- Scheduled -----
  planned("GET", "/api/scheduled", "T3-3", "every routine and sync with its schedule and last run"),
  planned("GET", "/api/scheduled/routines/:name", "T3-3", "one routine"),
  planned("GET", "/api/scheduled/syncs/:name", "T3-3", "one sync"),
  planned("PUT", "/api/scheduled/routines/:name/schedule", "T3-3", "set a routine's schedule", { idempotent: "natural" }),
  planned("POST", "/api/scheduled/routines/:name/pause", "T3-3", "pause a routine", { idempotent: "natural" }),
  planned("POST", "/api/scheduled/routines/:name/resume", "T3-3", "resume a routine", { idempotent: "natural" }),
  planned("POST", "/api/scheduled/routines/:name/run", "T3-3", "Run Now, under the budget preflight"),
  planned("DELETE", "/api/scheduled/routines/:name", "T3-3", "Reset to Default: delete the owner's entry", { idempotent: "natural" }),
  planned("PUT", "/api/scheduled/routines/:name/assignment", "T3-3", "a routine's actor, task and per-run grants", { reach: ["local"], idempotent: "natural" }),
  planned("POST", "/api/scheduled/routines", "T3-8", "New Routine: an actor, a task and per-run grants", { reach: ["local"] }),
  planned("PUT", "/api/scheduled/syncs/:name", "T3-3", "a sync's cadence, pause and raise toggles", { idempotent: "natural" }),
  planned("POST", "/api/scheduled/syncs/:name/run", "T3-3", "run a sync now"),

  // ----- connections, secrets, variables, recordings: read-only here, every write is the CLI -----
  planned("GET", "/api/connections", "T4-8a", "the connections: status, tools, used by"),
  planned("GET", "/api/connections/:name", "T4-8a", "one connection"),
  route("GET", "/api/secrets", "secret names, hosts, grants, last used — never a value"),
  route("GET", "/api/variables", "the variables agents read — name, value, read by, used in"),
  planned("GET", "/api/recordings/:id", "T8-4", "one recording's retention state"),

  // ----- outbound doors through a connection -----
  planned("POST", "/api/github/pulls/:owner/:repo/:number/review", "T2-13", "post a review; the head SHA must match the one shown", { conflict: ["stale"] }),
  planned("POST", "/api/github/pulls/:owner/:repo/:number/threads/:id/reply", "T2-13", "reply to a review thread; the head SHA must match", { conflict: ["stale"] }),
  planned("POST", "/api/github/pulls/:owner/:repo/:number/threads/:id/resolve", "T2-13", "resolve a review thread; the head SHA must match", { conflict: ["stale"] }),
  planned("POST", "/api/trackers/:connection/issues", "T4-25", "create an issue from a task; idempotent by task key", { idempotent: "natural" }),
  planned("POST", "/api/trackers/:connection/issues/:key/complete", "T4-26", "close an issue", { idempotent: "natural" }),

  // ----- prose feedback (T1-12) -----
  route("POST", "/api/prose/:id/feedback", "rate one piece of generated prose", { idempotent: "natural" }),
  route("DELETE", "/api/prose/:id/feedback", "clear a prose rating", { idempotent: "natural" }),

  // ----- live changes -----
  route("GET", "/api/events", "Server-Sent Events: what changed, as ids; `Last-Event-ID` resumes"),

  // ----- the vault's git -----
  route("GET", "/api/vault/status", "branch, ahead and behind, last commit, last push, conflict"),
  planned("POST", "/api/vault/rollback", "T10-6", "raise a Needs You request to roll back, with the preview", { reach: ["local"] }),
];

/** `GET /api/agents/:id` — the row's identity, and how the document spells it. */
export function routeKey(r: Pick<ClientRoute, "method" | "path">): string {
  return `${r.method} ${r.path}`;
}

/** A path's segments: `/api/q/x` → `["api", "q", "x"]`. A trailing slash is an empty last segment, which no template matches. */
function segmentsOf(path: string): string[] {
  return path.split("/").slice(1);
}

/** The template's segments, compiled once per row: a string is a literal, `null` a parameter. */
const compiled = new WeakMap<ClientRoute, { names: (string | null)[]; literals: number }>();
function templateOf(r: ClientRoute): { names: (string | null)[]; literals: number } {
  let t = compiled.get(r);
  if (!t) {
    const names = segmentsOf(r.path).map((s) => (s.startsWith(":") ? null : s));
    t = { names, literals: names.filter((s) => s !== null).length };
    compiled.set(r, t);
  }
  return t;
}

export interface RouteMatch {
  readonly route: ClientRoute;
  /** Each `:name` → the raw (still percent-encoded) segment it matched. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The row a request is for: the method matches (or the row is `*`), and every
 * segment matches — a literal exactly, a parameter any non-empty segment.
 * Where two rows match (`POST /api/proposals/batch` and `…/:id`), the one
 * with more literal segments wins. Parameters are deliberately loose: a
 * route's own handler still owns its grammar (`\d{1,12}`, a slug, a ULID).
 */
export function matchRoute(method: string, pathname: string, routes: readonly ClientRoute[] = CLIENT_API): RouteMatch | undefined {
  const segs = segmentsOf(pathname);
  let best: { route: ClientRoute; literals: number } | undefined;
  for (const r of routes) {
    if (r.method !== "*" && r.method !== method) continue;
    const t = templateOf(r);
    if (t.names.length !== segs.length) continue;
    if (!t.names.every((name, i) => (name === null ? segs[i] !== "" : name === segs[i]))) continue;
    if (!best || t.literals > best.literals) best = { route: r, literals: t.literals };
  }
  if (!best) return undefined;
  const params: Record<string, string> = {};
  segmentsOf(best.route.path).forEach((s, i) => {
    if (s.startsWith(":")) params[s.slice(1)] = segs[i] ?? "";
  });
  return { route: best.route, params };
}

const SERVED: readonly ClientRoute[] = CLIENT_API.filter((r) => r.served);

/**
 * A `local` row: the owner on THIS Mac, proved by the local owner token alone
 * (§2.1). The table never mixes `local` with another class (a core test holds
 * that), so "includes" and "is" are the same question — asked as "includes"
 * so a row that ever did mix them would fail closed.
 */
export function isLocalRoute(r: Pick<ClientRoute, "reach">): boolean {
  return r.reach.includes("local");
}

/**
 * The `403 local_only` answer's message: which route, why it is refused, and
 * what would permit it (R3) — the Mac app, on the Mac this console runs on.
 * Sent only to an owner credential (a passkey session), after the owner gate,
 * so it names nothing the published table does not.
 */
export function localOnlyMessage(r: Pick<ClientRoute, "method" | "path">): string {
  return `${routeKey(r)} is reach \`local\`: only the Metistry Mac app (or the \`metistry\` command line) on the Mac this console runs on can do it — a passkey session cannot, even from that Mac. Open the Mac app there (docs/ops/client-api.md)`;
}

/** The served row a request is for, or undefined — what the console's gate asks before it dispatches anything to the owner. */
export function servedRoute(method: string, pathname: string): ClientRoute | undefined {
  return matchRoute(method, pathname, SERVED)?.route;
}

/**
 * The owner's 404 for a route this console does not serve, naming the ones it
 * does nearby (R3: a refusal names what would permit it). "Nearby" is the
 * served rows that share the longest leading run of segments with the request
 * — at least two, so `/api/<family>` — which turns a misspelt verb into its
 * family's list, read off this table rather than a list kept by a handler.
 * A route the table freezes ahead of its ticket is named as not served yet.
 * Owner-only: the console sends it after the owner gate, where naming routes
 * tells the caller nothing the published table does not.
 */
export function noRouteMessage(method: string, pathname: string): string {
  // A route the contract has but this console does not serve yet: say so, so
  // a newer client talking to an older console reads "not yet", not "never".
  const frozen = matchRoute(method, pathname);
  if (frozen && !frozen.route.served) return `${routeKey(frozen.route)} is in the client API but this console does not serve it yet (docs/ops/client-api.md)`;
  const segs = segmentsOf(pathname);
  const head = `no route ${method} ${pathname}`;
  for (let depth = segs.length; depth >= 2; depth--) {
    const near = SERVED.filter((r) => {
      const t = templateOf(r).names;
      return t.length >= depth && t.slice(0, depth).every((name, i) => (name === null ? segs[i] !== "" : name === segs[i]));
    });
    if (near.length > 0) return `${head} — this console serves ${near.map(routeKey).join(", ")} (docs/ops/client-api.md)`;
  }
  return `${head} — docs/ops/client-api.md lists every route this console serves`;
}
