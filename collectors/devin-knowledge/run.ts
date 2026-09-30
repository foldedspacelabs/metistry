// devin-knowledge: Devin (Cognition) Knowledge notes and repository wikis
// into the inbox as captures, so the evening fold organises them into the
// vault (docs/ops/knowledge-fold.md). W5 of docs/plan-refresh-2026-09-13.md
// §4b; ruled a collector, not a bridge, because the assistant mounts exactly
// one MCP server (docs/research/2026-09-15-devin-cursor-integration.md §6).
//
// Verified against docs.devin.ai on 2026-09-15:
//
//   Notes   GET /v3/organizations/{org_id}/knowledge/notes
//           Bearer `cog_…` (service-user key or PAT; legacy `apk_` is dead).
//           Cursor pagination: `first` (default 100, max 200) + `after`,
//           response `{items, has_next_page, end_cursor, total?}`.
//           KnowledgeNoteResponse: note_id, name, body, trigger, folder_id,
//           folder_path, macro, pinned_repo, is_enabled, created_at,
//           updated_at (both INTEGER epochs), access_type, org_id.
//           There is NO `updated_after` filter, so the watermark is applied
//           client-side.
//   Org id  GET /v3/self → {org_id} (nullable for account-scoped tokens).
//   Wikis   no REST route exists — see wiki.ts.
//   Limits  none published; `429 Too Many Requests` is in the status table.
//
// Two provenance notes worth stating out loud:
//
//   * This collector redacts NOTHING, deliberately. Redaction is core's job
//     at a boundary (`redactSecrets`, §4.3), and today `captureToInbox` does
//     not apply it — a capture's bytes are stored verbatim, exactly as the
//     owner's own captures are. A Devin note carrying a secret in its body
//     therefore lands verbatim in the inbox. That is the existing contract
//     for every capture door, not something this collector may quietly
//     change.
//   * `source: "devin"` is the new provenance class, and it is the field
//     `checkBrief`'s `deny_sources` scanner keys on (§4.18.B). `source_agent`
//     stays NULL because identity comes from the credential and the
//     credential here is the OWNER's Devin key — not an agent's bearer.

import { runCheck, type CheckResult } from "@foldedspacelabs/metistry-core";
import type { SyncOpener } from "@foldedspacelabs/metistry-connections";
import { captureToInbox, INBOX_PREFIX, type CaptureSink } from "@foldedspacelabs/metistry-mcp-brain";
import { DEVIN_MCP_URL, McpWikiSource, type WikiSource } from "./wiki.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface DevinCtx {
  /** `cog_…` service-user key or PAT. Absent = the whole collector degrades absent. */
  devinApiKey?: string | undefined;
  /** `org-…`; resolved from GET /v3/self when unset. Required in the REST path. */
  devinOrgId?: string | undefined;
  /** `owner/repo` list whose wikis to pull. Empty/unset = notes only (the wiki half is opt-in). */
  devinRepos?: string[] | undefined;
  /** Cap per run, so a first pass on a large knowledge base cannot run away. */
  devinMaxItems?: number | undefined;
  /** Where capture files land when no sink is injected (the console's METISTRY_INBOX_DIR). */
  inboxDir?: string | undefined;
  /** The capture sink the console built (the vault inbox over the reconciler's bridge). */
  inboxSink?: CaptureSink | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Injectable for tests; the real one is McpWikiSource. */
  wikiSource?: WikiSource | undefined;
  now?: Date | undefined;
  /**
   * The console's opener (packages/connections `instanceSyncOpener`): the
   * Devin connection this sync reads (T4-11). When one opens, it wins over
   * the `devinApiKey` fields above, which are read for one release only.
   */
  openSync?: SyncOpener | undefined;
}

/** The Devin connection type's builtin module (seed/connection-types/devin). */
export const DEVIN_MODULE = "devin";

/**
 * How one run reaches Devin (T4-11). Through the Devin connection: its door
 * — the key a `{{ secret.x }}` reference filled by the egress guard for the
 * key's listed hosts, granted to `connection:<name>`, redacted on the way
 * back — its URL, and its `org` and `repos` config. Without one, for one
 * release: the legacy `devinApiKey` and plain fetch.
 */
export interface DevinAccess {
  fetch: typeof fetch;
  /** the Authorization header: `Bearer {{ secret.x }}` through a door, the legacy key otherwise */
  authorization: string;
  /** REST base, no trailing slash */
  base: string;
  orgId?: string | undefined;
  repos: string[];
  /** the connection it reads, when it reads one */
  connection?: string | undefined;
}

/** `owner/repo, owner/other` → the list. */
function repoList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((r) => r.trim()).filter(Boolean);
}

/**
 * The access `sync` reads Devin with, or null when there is none (the
 * collector degrades absent). A Devin connection that is there but wrong
 * throws — the run says why rather than falling back to an old key.
 */
export async function devinAccess(ctx: DevinCtx & { devinApiUrl?: string | undefined }, sync: string, alsoOrigins?: readonly string[]): Promise<DevinAccess | null> {
  if (ctx.openSync) {
    const opened = await ctx.openSync({ sync, module: DEVIN_MODULE, ...(alsoOrigins ? { alsoOrigins } : {}) });
    if (opened.ok) {
      const c = opened.sync;
      return {
        fetch: c.fetch,
        authorization: c.headers.authorization ?? "",
        base: c.url.replace(/\/+$/, ""),
        ...(c.config.org ? { orgId: c.config.org.trim() } : {}),
        repos: repoList(c.config.repos),
        connection: c.connection,
      };
    }
    if (opened.status === "failed") throw new Error(`${sync}: ${opened.why}`);
  }
  if (!ctx.devinApiKey) return null;
  return {
    fetch: ctx.fetchFn ?? fetch,
    authorization: `Bearer ${ctx.devinApiKey}`,
    base: ctx.devinApiUrl ?? DEVIN_API,
    ...(ctx.devinOrgId ? { orgId: ctx.devinOrgId } : {}),
    repos: ctx.devinRepos ?? [],
  };
}

export const COMPONENT = "devin-knowledge";
/** The idempotency principal every capture from this collector carries. */
export const PRINCIPAL = `collector:${COMPONENT}`;
export const DEVIN_API = "https://api.devin.ai";
/** The further origin this sync reaches through the Devin connection's door: the repo wikis' MCP server (wiki.ts). Named here, by the product — never by the connection file. */
const WIKI_ORIGINS = [new URL(DEVIN_MCP_URL).origin];
const DEFAULT_MAX_ITEMS = 200; // limit: fixed — the floor when ctx.devinMaxItems (METISTRY_DEVIN_MAX_ITEMS, apps/console/src/main.ts) names none
const PAGE_SIZE = 100; // the endpoint's own default; max is 200
const MAX_PAGES = 50; // limit: fixed — a bounded walk: 5000 notes is far past any real base

/** Thrown when Devin says 429. Caught by `run`, which stops without failing the run. */
export class RateLimited extends Error {
  constructor(where: string) {
    super(`devin rate limited (HTTP 429) while ${where} — stopped early; the watermark did not advance`);
    this.name = "RateLimited";
  }
}

export interface DevinNote {
  note_id: string;
  name: string;
  body: string;
  trigger?: string | null;
  folder_path?: string | null;
  pinned_repo?: string | null;
  is_enabled?: boolean;
  updated_at: number;
}

interface NotesPage {
  items: DevinNote[];
  has_next_page?: boolean;
  end_cursor?: string | null;
}

function headers(access: DevinAccess): Record<string, string> {
  return {
    authorization: access.authorization,
    accept: "application/json",
    "user-agent": "metistry-devin-knowledge",
  };
}

/** Devin sends epoch integers without documenting the unit; both read correctly. */
export function epochToIso(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return new Date(0).toISOString();
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

async function getJson<T>(access: DevinAccess, url: string, where: string): Promise<T> {
  const res = await access.fetch(url, { headers: headers(access), signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new RateLimited(where);
  if (!res.ok) throw new Error(`devin ${where}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** The org the credential resolves to. Org-scoped service-user keys answer here; account-scoped ones return null. */
export async function fetchOrgId(access: DevinAccess): Promise<string | null> {
  if (access.orgId) return access.orgId;
  const self = await getJson<{ org_id?: string | null }>(access, `${access.base}/v3/self`, "GET /v3/self");
  return self.org_id ?? null;
}

/** Every note, following `end_cursor` until the server says there is no next page. */
export async function listNotes(access: DevinAccess, orgId: string): Promise<DevinNote[]> {
  const out: DevinNote[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ first: String(PAGE_SIZE) });
    if (after) qs.set("after", after);
    const body = await getJson<NotesPage>(
      access,
      `${access.base}/v3/organizations/${encodeURIComponent(orgId)}/knowledge/notes?${qs.toString()}`,
      "listing knowledge notes",
    );
    out.push(...(body.items ?? []));
    if (!body.has_next_page || !body.end_cursor) break;
    after = body.end_cursor;
  }
  return out;
}

function yaml(v: string): string {
  return JSON.stringify(v); // a JSON string literal is a valid YAML scalar (inbox-drain's `frontmatter` reads them)
}

/**
 * The capture file: frontmatter the fold reads for provenance, then the
 * source text unchanged. `kind` is `knowledge` or `wiki` so the fold can
 * tell an authored note from generated repo documentation.
 */
export function captureBody(fm: Record<string, string | undefined>, body: string): string {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${yaml(v as string)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trimEnd()}\n`;
}

function slug(s: string): string {
  return (s.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "note").slice(0, 60);
}

/** Digest used as a wiki page's version marker: the wiki tools expose no timestamp. */
export async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

// ---- watermark ---------------------------------------------------------------
//
// `meta.since` on this collector's own `runs` row (the runner opens it with
// `startRun` before calling us and closes it with `finishRun`, whose
// `meta = meta || …` preserves whatever we wrote). `since` is Devin's raw
// `updated_at` integer so the comparison needs no unit guess; `since_iso` is
// there so an operator reading the row can tell what it means.

export async function readWatermark(db: Db, component = COMPONENT): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT (meta->>'since')::numeric AS since FROM runs
     WHERE component = $1 AND kind = 'collector_run' AND ok AND meta ? 'since'
     ORDER BY ts DESC LIMIT 1`,
    [component],
  );
  const since = rows[0]?.since;
  return since === undefined || since === null ? null : Number(since);
}

/**
 * Write the new watermark onto this run's in-flight row. Called outside the
 * runner (a direct invocation, or a unit test) there is no in-flight row and
 * nothing is stored — the next run then starts from the previous watermark
 * and re-lists, which costs one listing and no duplicate captures, because
 * every capture is idempotent. Returns whether it landed.
 */
export async function writeWatermark(db: Db, since: number, component = COMPONENT): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE runs SET meta = meta || $2::jsonb
     WHERE id = (SELECT id FROM runs WHERE component = $1 AND kind = 'collector_run' AND ok IS NULL ORDER BY id DESC LIMIT 1)
     RETURNING id`,
    [component, JSON.stringify({ since, since_iso: epochToIso(since) })],
  );
  return rows.length > 0;
}

// ---- check() ----------------------------------------------------------------

/**
 * Behavioral probe (Phase 0 hard requirement 3): actually call Devin with
 * the key and see whether an organization resolves. No key = `absent`, which
 * is a supported shape, not a fault.
 */
export async function check(ctx: DevinCtx = {}): Promise<CheckResult> {
  return runCheck(COMPONENT, "GET /v3/self with the Devin key resolves an organization", async () => {
    const access = await devinAccess(ctx, COMPONENT, WIKI_ORIGINS);
    if (!access) {
      return {
        status: "absent" as const,
        remediation:
          "no Devin connection — `metistry connections add devin --type agent --provider devin …` (docs/ops/connections.md, Agent connections); for one release METISTRY_DEVIN_API_KEY still works (`metistry secrets sync --to env`); degrades absent meanwhile (no Devin knowledge reaches the inbox, everything else runs)",
      };
    }
    let orgId: string | null;
    try {
      orgId = await fetchOrgId(access);
    } catch (err) {
      if (err instanceof RateLimited) {
        return { status: "degraded" as const, remediation: "Devin answered 429 — the key works but the API is rate limiting; the next scheduled run retries" };
      }
      throw err;
    }
    if (!orgId) {
      return {
        status: "degraded" as const,
        remediation:
          "the key authenticated but resolves no organization (an enterprise service-user key or a PAT is account-scoped) — set METISTRY_DEVIN_ORG_ID to a child organization id from Settings → Service users",
      };
    }
    return { status: "ok" as const, meta: { org_id: orgId, repos: access.repos.length, ...(access.connection ? { connection: access.connection } : {}) } };
  });
}

// ---- run() ------------------------------------------------------------------

/**
 * One pass. Returns captures written (a replay of an unchanged item counts
 * for nothing, so a steady state returns 0).
 */
export async function run(db: Db, ctx: DevinCtx = {}): Promise<number> {
  const access = await devinAccess(ctx, COMPONENT, WIKI_ORIGINS);
  if (!access) return 0; // degrades absent
  const sink = ctx.inboxSink ?? ctx.inboxDir ?? `./${INBOX_PREFIX}`;
  const max = ctx.devinMaxItems ?? DEFAULT_MAX_ITEMS;
  const capturedAt = (ctx.now ?? new Date()).toISOString();
  let written = 0;
  let limited = false;

  // --- knowledge notes (REST v3) ---
  const since = await readWatermark(db);
  let highWater = since ?? 0;
  let complete = false;
  let notes: DevinNote[] = [];
  try {
    const orgId = await fetchOrgId(access);
    if (!orgId) throw new Error("devin: no organization for this credential — set the Devin connection's org (`metistry connections set devin --config org=org-…`; metistry doctor explains)");
    notes = await listNotes(access, orgId);
    complete = true;
  } catch (err) {
    if (!(err instanceof RateLimited)) throw err;
    limited = true; // backoff-and-stop: not a failed run, and the watermark stays put
  }

  // oldest-first, so the cap and the watermark agree: whatever is processed
  // is a prefix in `updated_at` order and the next run resumes after it.
  const changed = notes
    .filter((n) => Number(n.updated_at) > (since ?? 0))
    .sort((a, b) => Number(a.updated_at) - Number(b.updated_at));
  const batch = changed.slice(0, max);

  for (const note of batch) {
    const updated = Number(note.updated_at);
    const body = captureBody(
      {
        source: "devin",
        kind: "knowledge",
        devin_id: note.note_id,
        title: note.name,
        folder: note.folder_path ?? undefined,
        repo: note.pinned_repo ?? undefined,
        trigger: note.trigger ?? undefined,
        updated_at: epochToIso(updated),
        captured_at: capturedAt,
      },
      note.body ?? "",
    );
    const r = await captureToInbox(db, sink, {
      bytes: Buffer.from(body, "utf8"),
      filename: `devin-${slug(note.name)}.md`,
      mime: "text/markdown",
      note: body,
      source: "devin",
      sourceAgent: null,
      idempotency: { principal: PRINCIPAL, key: `knowledge:${note.note_id}:${updated}` },
    });
    if (!r.replayed) written++;
    if (updated > highWater) highWater = updated;
  }

  // Only a complete listing lets the watermark move. A 429 discards the
  // partial listing (`listNotes` throws): a partial page set is a prefix in
  // CURSOR order, which says nothing about `updated_at` order, so neither
  // capturing from it nor advancing past it would be sound. Nothing is lost —
  // the next run re-lists from the same watermark.
  if (complete && highWater > (since ?? 0)) await writeWatermark(db, highWater);

  // --- repository wikis (MCP; no REST route) ---
  const repos = access.repos;
  if (repos.length > 0 && !limited) {
    const wiki =
      ctx.wikiSource ??
      new McpWikiSource({
        authorization: access.authorization,
        ...(access.orgId ? { orgId: access.orgId } : {}),
        // through a connection: its door, which reaches mcp.devin.ai because this code names it (WIKI_ORIGINS)
        ...(access.connection ? { fetchFn: access.fetch } : ctx.fetchFn ? { fetchFn: ctx.fetchFn } : {}),
      });
    try {
      for (const repo of repos) {
        if (written >= max) break; // the cap is per RUN, not per repo
        let pages: Awaited<ReturnType<WikiSource["pages"]>>;
        try {
          pages = await wiki.pages(repo);
        } catch (err) {
          // A repo the key cannot see, or one with no wiki, must not take the
          // whole run down with it — notes already landed.
          console.warn(`devin-knowledge: ${repo} wiki unavailable (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        for (const [i, page] of pages.entries()) {
          if (written >= max) break;
          const digest = await sha256Hex(page.body);
          const body = captureBody(
            {
              source: "devin",
              kind: "wiki",
              // The wiki tools return no page id, so the repo + ordinal IS the
              // identity; the digest is the version (they return no timestamp
              // either, which is why there is no `updated_at` here).
              devin_id: `${repo}#${i + 1}`,
              title: page.title,
              repo,
              content_sha256: digest,
              captured_at: capturedAt,
            },
            page.body,
          );
          const r = await captureToInbox(db, sink, {
            bytes: Buffer.from(body, "utf8"),
            filename: `devin-wiki-${slug(repo)}-${slug(page.title)}.md`,
            mime: "text/markdown",
            note: body,
            source: "devin",
            sourceAgent: null,
            idempotency: { principal: PRINCIPAL, key: `wiki:${repo}#${i + 1}:${digest.slice(0, 16)}` },
          });
          if (!r.replayed) written++;
        }
      }
    } finally {
      if (!ctx.wikiSource) await wiki.close();
    }
  }

  if (limited) console.warn(`devin-knowledge: ${new RateLimited("listing knowledge notes").message}`);
  return written;
}
