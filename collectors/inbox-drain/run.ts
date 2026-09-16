// inbox-drain: classify new captures, emit PROPOSALS (D7) — never
// auto-create (§4.12's over-extraction lesson). Collectors never call a
// model (invariant terminology); today's classifier is the deterministic
// prefilter tier. The Apple FM tier slots in behind the same interface
// when the bridge lands (degrades: absent until then).

import type { CaptureSink } from "@foldedspacelabs/metistry-mcp-brain";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface InboxRow {
  id: number;
  path: string;
  mime: string | null;
  note: string | null;
  source: string;
  source_agent?: string | null; // set when the capture came in on an agent token (migration 0007)
}

export interface Classification {
  kind: "todo" | "url" | "image" | "document" | "note" | "session";
  reason: string; // which rule fired — auditable, not vibes
  title: string;
}

/**
 * A task this capture is *asking for*, if it is asking for one. The console
 * renders it as the extra decision **Approve as work**, which inserts the
 * `work` row on the click (docs/research/2026-09-16-taskuary-review.md ADOPT
 * 2). Nothing here creates anything — §4.12 is intact because the row is born
 * of a human's hand, not of this collector's opinion.
 */
export interface SuggestedWork {
  title: string;
  project?: string;
  kind?: "task" | "review";
}

const URL_RE = /^https?:\/\/\S+$/i;
const TODO_RE = /^(todo|remind me|remember to|don't forget|buy|call|email|schedule)\b/i;
// `@task do the thing`, `todo: do the thing`, and the markdown checkbox. The
// same shape the router uses for `/note` (invariant 4, apps/console/src/router.ts):
// an explicit leading cue, matched by regex, first match wins, NO model.
const TASK_CUE_RE = /^(?:@task\b[:\s]*|todo\s*:\s*|[-*]\s*\[\s\]\s*)([\s\S]+)$/i;
// Frontmatter `kind:` values that say "this capture is a task", verbatim.
const TASK_KINDS = new Set(["todo", "task"]);

/**
 * Leading YAML frontmatter, as scalars — enough to read `kind:` and `title:`
 * without a YAML dependency in a collector. Values may be double-quoted (both
 * capture doors write JSON string literals, which are valid YAML scalars).
 * Frontmatter is written by our own doors (`metistry import-sessions`, the
 * Claude Code plugin), so it is trusted for classification only; the body is
 * still foreign content and nothing here interprets it.
 */
export function frontmatter(note: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(note);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    let v = (kv[2] ?? "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      try {
        v = v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[kv[1]] = v;
  }
  return out;
}

export function classify(row: InboxRow): Classification {
  const note = (row.note ?? "").trim();
  const mime = row.mime ?? "";
  const fm = frontmatter(note);
  const title = fm.title || (note ? note.slice(0, 80) : row.path.replace(/^\d+-/, "").slice(0, 80));

  // A session summary declares itself (stash review item 2): the frontmatter is
  // authoritative, so no FM tier is consulted and Needs You can label it.
  if (fm.kind === "session") return { kind: "session", reason: "frontmatter kind: session", title };

  if (note && URL_RE.test(note)) return { kind: "url", reason: "note is a bare url", title };
  if (note && TODO_RE.test(note)) return { kind: "todo", reason: "leading action verb", title };
  if (mime.startsWith("image/")) return { kind: "image", reason: `mime ${mime}`, title };
  if (mime.includes("pdf") || /\.(pdf|docx?|pages)$/i.test(row.path)) {
    return { kind: "document", reason: "document mime/extension", title };
  }
  return { kind: "note", reason: "default", title };
}

/** The note with its leading frontmatter removed — the part a human actually typed. */
function body(note: string): string {
  return note.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, "").trim();
}

/**
 * Does this capture suggest a `work` row, and what would it say? Three cues,
 * in order, all deterministic (invariant 4 — a collector never calls a model,
 * and the Apple FM tier's `has_action` is deliberately NOT read here):
 *
 *   1. frontmatter `kind: todo|task` — our own doors declaring it;
 *   2. an explicit leading cue on the first body line (`@task …`, `todo: …`,
 *      `- [ ] …`) — the same "explicit command" shape the router uses;
 *   3. the classifier's existing `todo` verdict (`TODO_RE`, "buy milk").
 *
 * Returns undefined for everything else, which is most things. A suggestion
 * is not a decision: the proposal still waits for a click.
 */
export function suggestedWork(row: InboxRow, c: Classification): SuggestedWork | undefined {
  const note = (row.note ?? "").trim();
  if (!note) return undefined;
  const fm = frontmatter(note);
  const first = body(note).split(/\r?\n/)[0]?.trim() ?? "";
  const cue = TASK_CUE_RE.exec(first);

  let title: string | undefined;
  if (TASK_KINDS.has((fm.kind ?? "").toLowerCase())) title = fm.title || cue?.[1] || first;
  else if (cue?.[1]) title = cue[1];
  else if (c.kind === "todo") title = c.title;
  if (!title) return undefined;

  const trimmed = title.trim().slice(0, 200); // limit: fixed — `work.title` is capped at 500 by TasksService; 200 keeps a card readable
  if (!trimmed) return undefined;
  // `project` only when the frontmatter names one in the slug form the
  // projects table uses; free text would invent a project on accept.
  const project = (fm.project ?? "").trim();
  return { title: trimmed, ...(/^[a-z][a-z0-9-]{0,39}$/.test(project) ? { project } : {}) };
}

// The optional on-device FM tier (ruled 2026-09-01: free on-device
// classification permitted for this collector; billable models never).
// Deterministic rules that positively fired stand; only default-"note"
// fallthroughs with text are refined by the bridge. Degrades absent: no
// config, or any bridge failure, keeps the deterministic result.
export interface CollectorCtx {
  afmUrl?: string; // e.g. http://host.docker.internal:7810
  afmToken?: string; // per-bridge bearer (CRIT-9)
  ekUrl?: string; // eventkit bridge (routines use it for schedule/meeting prep)
  ekToken?: string;
  githubToken?: string; // github-state collector (fine-grained read-only PAT)
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }; // aws-costs collector
  awsCostDays?: number;
  claudeUsageDays?: number; // claude-usage collector (trailing window)
  githubRepos?: string[];
  devinApiKey?: string; // devin-knowledge collector (`cog_…` service-user key or PAT)
  devinOrgId?: string; // `org-…`; resolved from GET /v3/self when unset
  devinRepos?: string[]; // ["owner/repo", ...] whose wikis to pull; empty = notes only
  devinMaxItems?: number; // cap per run (default 200)
  devinApiUrl?: string; // REST base override (devin-sessions); default https://api.devin.ai
  devinSessionTimeoutHours?: number; // devin-sessions: how long a dispatched session may sit non-terminal (default 24)
  inboxDir?: string; // fallback capture directory when no sink is injected
  inboxSink?: CaptureSink; // where devin-knowledge's captures land: the vault inbox over the reconciler's bridge (docs/ops/inbox.md)
  fetchFn?: typeof fetch;
}

interface FmResult {
  category: string;
  has_action: boolean;
  action: string;
}

async function fmClassify(ctx: CollectorCtx, items: { id: number; text: string }[]): Promise<Map<number, FmResult>> {
  const out = new Map<number, FmResult>();
  if (!ctx.afmUrl || !ctx.afmToken || items.length === 0) return out;
  try {
    const res = await (ctx.fetchFn ?? fetch)(`${ctx.afmUrl}/classify`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.afmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return out;
    const body = (await res.json()) as { results: { id: number; ok: boolean; classification?: FmResult }[] };
    for (const r of body.results) if (r.ok && r.classification) out.set(Number(r.id), r.classification);
  } catch {
    /* degrades: absent — deterministic tier stands */
  }
  return out;
}

/** One drain pass. Returns how many rows were classified. */
export async function run(db: Db, ctx: CollectorCtx = {}): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, path, mime, note, source, source_agent FROM inbox WHERE status = 'new' ORDER BY ts LIMIT 50`,
  );
  const items = rows as InboxRow[];
  const deterministic = new Map(items.map((r) => [r.id, classify(r)]));

  // FM refines only what the rules couldn't place (reason "default")
  const fallthroughs = items.filter((r) => deterministic.get(r.id)!.reason === "default" && (r.note ?? "").trim());
  // pg returns bigint ids as strings — normalize map keys to Number
  const fm = await fmClassify(ctx, fallthroughs.map((r) => ({ id: Number(r.id), text: (r.note ?? "").trim().slice(0, 2000) })));

  for (const row of items) {
    const det = deterministic.get(row.id)!;
    const refined = fm.get(Number(row.id));
    const final = refined
      ? { kind: refined.category, reason: "apple-fm", title: det.title, has_action: refined.has_action, action: refined.action }
      : det;
    const tier = refined ? "apple-fm" : "deterministic";
    // Provenance rides the credential (§4.19): a capture made with an agent
    // token proposes AS that agent, at external trust; the owner's own
    // captures propose as this collector, at user trust.
    const sourceAgent = row.source_agent || "inbox-drain";
    const trust = row.source_agent ? "external" : "user";
    // The suggestion comes off the DETERMINISTIC classification, never the
    // refined one: a model's `has_action` must not be what puts an extra
    // button under a proposal (invariant 4).
    const work = suggestedWork(row, det);
    await db.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', $2, $3, $1)`,
      [
        JSON.stringify({ inbox_id: row.id, path: row.path, classification: final, note: row.note, tier, ...(work ? { suggested_work: work } : {}) }),
        sourceAgent,
        trust,
      ],
    );
    await db.query(`UPDATE inbox SET status = 'classified', proposal = $2, triaged_at = NULL WHERE id = $1`, [
      row.id,
      JSON.stringify(final),
    ]);
  }
  return items.length;
}
