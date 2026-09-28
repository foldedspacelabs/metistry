// The `linear` provider (plan §2.6, §4 Q22; T4-24): a `tracker` connection
// type whose implementation is this module. GraphQL at
// `https://api.linear.app/graphql`, authenticated with a personal API key
// sent as `Authorization: <API_KEY>` — no `Bearer`, which OAuth tokens take
// (Linear, *GraphQL*). The key is a secret of the connection: the connection
// file's `reach.http.auth` is `{scheme: api_key, header: Authorization,
// secret: <name>}`, so the header this client sends holds a reference and the
// egress door fills it for `api.linear.app` or not at all (`sync.ts`).
//
// **Read-only, by construction.** The sync's client below has fixed query
// documents and no way to send another — `linearQuery` refuses any document
// that is not a `query` operation, so a mutation cannot leave through it even
// by a later edit that forgets. Creating an issue (`create`, T4-25) is its
// own module and its own fixed document (`linear-issue.ts`), sent through the
// same transport (`sendLinearDocument`), which no index export reaches.
//
// Pure over a `fetch`: no Postgres, no vault (the dependency arrow). The
// sync that writes `work` and raises requests is `collectors/linear/`.

import type { SyncHttp } from "./sync.js";

/** The only origin a Linear connection reaches. */
export const LINEAR_ORIGIN = "https://api.linear.app";
/** Linear's GraphQL endpoint. */
export const LINEAR_GRAPHQL_URL = `${LINEAR_ORIGIN}/graphql`;
/** The builtin module name a `linear` connection type's `implementation` names. */
export const LINEAR_MODULE = "linear";
/** The sync (collector unit) that reads Linear connections. */
export const LINEAR_SYNC = "linear";

/** An issue's key as Linear spells it: a team key, a dash, a number (`ENG-123`). What a task line's `linear:<KEY>` carries. */
export const LINEAR_KEY_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;

/** `linear:ENG-123` — the `work.external_ref`, the task line's ref and the mirror's subject, spelled once. */
export function linearRef(key: string): string {
  if (!LINEAR_KEY_RE.test(key)) throw new TypeError(`${JSON.stringify(key)} is not a Linear issue key (TEAM-123)`);
  return `linear:${key}`;
}

/** Linear's workflow state types. `completed` and `canceled` are closed; the rest are open. */
export const LINEAR_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export const LINEAR_CLOSED_STATE_TYPES: readonly string[] = ["completed", "canceled"];

/** One issue, as this module reads it. */
export interface LinearIssue {
  /** Linear's id (a UUID) */
  id: string;
  /** `ENG-123` */
  key: string;
  title: string;
  url: string;
  /** 0 none · 1 urgent · 2 high · 3 medium · 4 low (Linear's scale) */
  priority: number;
  priorityLabel: string;
  state: { name: string; type: string };
  team: { key: string; name: string };
  /** `YYYY-MM-DD` or null */
  dueDate: string | null;
  updatedAt: string;
  description: string | null;
  /** who opened it — the person the source names */
  creator: string | null;
  /** its assignee's name, or null when nobody is */
  assignee: string | null;
  /** whether the key's own user is its assignee */
  assignedToMe: boolean;
}

/** Why a Linear call failed. Messages carry no value: responses are redacted by the door before they are read. */
export const LINEAR_ERROR_CODES = ["http", "unauthorized", "rate_limited", "graphql", "bad_response", "not_a_query"] as const;
export type LinearErrorCode = (typeof LINEAR_ERROR_CODES)[number];

export class LinearError extends Error {
  override readonly name = "LinearError";
  constructor(
    readonly code: LinearErrorCode,
    message: string,
  ) {
    super(`linear (${code}): ${message}`);
  }
}

/** The fields every issue document asks for — what `readIssue` reads. */
export const ISSUE_FIELDS = `id identifier title url priority priorityLabel dueDate updatedAt description
  state { name type } team { key name } creator { name } assignee { name isMe }`;

/** The owner's open assigned issues, a page at a time. */
export const ASSIGNED_ISSUES_QUERY = `query MetistryAssignedIssues($after: String) {
  viewer {
    assignedIssues(first: 100, after: $after, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Issues by id — what became of the ones that left the assigned list (closed, or given to someone else). */
export const ISSUES_BY_ID_QUERY = `query MetistryIssuesById($ids: [ID!]) {
  issues(first: 100, filter: { id: { in: $ids } }, includeArchived: true) {
    nodes { ${ISSUE_FIELDS} }
  }
}`;

const MAX_PAGES = 10; // limit: fixed — 1000 assigned open issues is past any one person's queue; the walk stops rather than paging forever
const TIMEOUT_MS = 30_000; // limit: fixed — github-state's per-request bound

/** The one way a document leaves: a `query` operation and nothing else (module header). */
export async function linearQuery<T>(sync: Pick<SyncHttp, "fetch" | "headers">, document: string, variables: Record<string, unknown> = {}): Promise<T> {
  // strip comments and leading whitespace; the operation keyword is the first token
  const first = document.replace(/#[^\n]*/g, "").trimStart();
  if (!/^query\b/.test(first) || /\bmutation\b|\bsubscription\b/.test(first)) {
    throw new LinearError("not_a_query", "this client sends read queries only — creating or changing an issue is its own door (T4-25, T4-26)");
  }
  return sendLinearDocument<T>(sync, document, variables);
}

/**
 * The transport under every Linear document: POST to the one endpoint with
 * the connection's headers (a reference the door fills), every failure a
 * code. Not exported from the package: `linearQuery` is the read door, and
 * each mutation is a fixed document in its own module (`linear-issue.ts`).
 */
export async function sendLinearDocument<T>(sync: Pick<SyncHttp, "fetch" | "headers">, document: string, variables: Record<string, unknown>): Promise<T> {
  const res = await sync.fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { ...sync.headers, "content-type": "application/json", accept: "application/json", "user-agent": "metistry-linear" },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    void res.body?.cancel().catch(() => undefined); // not awaited: nothing here waits on a body it will not read
    throw new LinearError("unauthorized", `HTTP ${res.status} — Linear refused the key (\`metistry secrets set <name>\` replaces it)`);
  }
  if (res.status === 429) {
    void res.body?.cancel().catch(() => undefined); // not awaited: nothing here waits on a body it will not read
    throw new LinearError("rate_limited", "HTTP 429 — Linear's rate limit; the next run tries again");
  }
  let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new LinearError(res.ok ? "bad_response" : "http", `HTTP ${res.status} with a body that is not JSON`);
  }
  if (body.errors?.length) {
    const codes = body.errors.map((e) => e.extensions?.code ?? "").filter(Boolean);
    if (codes.includes("RATELIMITED")) throw new LinearError("rate_limited", "RATELIMITED — Linear's rate limit; the next run tries again");
    if (codes.includes("AUTHENTICATION_ERROR")) throw new LinearError("unauthorized", "AUTHENTICATION_ERROR — Linear refused the key");
    throw new LinearError("graphql", body.errors.map((e) => (e.message ?? "error").slice(0, 200)).join("; "));
  }
  if (!res.ok) throw new LinearError("http", `HTTP ${res.status}`);
  if (body.data === undefined || body.data === null) throw new LinearError("bad_response", "no data in the response");
  return body.data;
}

interface RawIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  url?: unknown;
  priority?: unknown;
  priorityLabel?: unknown;
  dueDate?: unknown;
  updatedAt?: unknown;
  description?: unknown;
  state?: { name?: unknown; type?: unknown } | null;
  team?: { key?: unknown; name?: unknown } | null;
  creator?: { name?: unknown } | null;
  assignee?: { name?: unknown; isMe?: unknown } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One node, read strictly: an issue without an id, a key Linear would not spell, a URL off Linear's web host, or a missing title is refused, never guessed. */
export function readIssue(raw: RawIssue): LinearIssue {
  const id = str(raw.id);
  const key = str(raw.identifier);
  const title = str(raw.title);
  const url = str(raw.url);
  if (!id || !key || !LINEAR_KEY_RE.test(key) || title === null || !url) throw new LinearError("bad_response", `an issue without an id, a key, a title or a url${key ? ` (${key.slice(0, 20)})` : ""}`);
  let web: URL;
  try {
    web = new URL(url);
  } catch {
    throw new LinearError("bad_response", `${key}: its url is not a URL`);
  }
  if (web.protocol !== "https:" || web.hostname !== "linear.app") throw new LinearError("bad_response", `${key}: its url is not on https://linear.app`);
  const due = str(raw.dueDate);
  return {
    id,
    key,
    title,
    url: web.href,
    priority: typeof raw.priority === "number" && Number.isInteger(raw.priority) && raw.priority >= 0 && raw.priority <= 4 ? raw.priority : 0,
    priorityLabel: str(raw.priorityLabel) ?? "",
    state: { name: str(raw.state?.name) ?? "", type: str(raw.state?.type) ?? "" },
    team: { key: str(raw.team?.key) ?? key.slice(0, key.indexOf("-")), name: str(raw.team?.name) ?? "" },
    dueDate: due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    updatedAt: str(raw.updatedAt) ?? new Date(0).toISOString(),
    description: str(raw.description),
    creator: str(raw.creator?.name),
    assignee: str(raw.assignee?.name),
    assignedToMe: raw.assignee?.isMe === true,
  };
}

/** Every open issue assigned to the key's own user, following Linear's cursor to the end (bounded). */
export async function assignedOpenIssues(sync: Pick<SyncHttp, "fetch" | "headers">): Promise<LinearIssue[]> {
  const out: LinearIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { viewer?: { assignedIssues?: { nodes?: RawIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } } = await linearQuery(sync, ASSIGNED_ISSUES_QUERY, { after });
    const conn = data.viewer?.assignedIssues;
    if (!conn || !Array.isArray(conn.nodes)) throw new LinearError("bad_response", "viewer.assignedIssues is missing");
    // the filter asks for open ones; a closed one that comes back anyway is not the owner's to do
    for (const n of conn.nodes) {
      const issue = readIssue(n);
      if (!LINEAR_CLOSED_STATE_TYPES.includes(issue.state.type)) out.push({ ...issue, assignedToMe: true });
    }
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new LinearError("bad_response", `more than ${MAX_PAGES * 100} assigned open issues — the walk stopped rather than reconcile a partial list`);
}

/** The issues with these ids, as Linear has them now. An id Linear no longer returns (deleted, or out of reach) is simply absent. */
export async function issuesById(sync: Pick<SyncHttp, "fetch" | "headers">, ids: readonly string[]): Promise<LinearIssue[]> {
  const out: LinearIssue[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data: { issues?: { nodes?: RawIssue[] } } = await linearQuery(sync, ISSUES_BY_ID_QUERY, { ids: ids.slice(i, i + 100) });
    if (!data.issues || !Array.isArray(data.issues.nodes)) throw new LinearError("bad_response", "issues is missing");
    for (const n of data.issues.nodes) out.push(readIssue(n));
  }
  return out;
}
