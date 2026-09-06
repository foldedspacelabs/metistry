// inbox-drain: classify new captures, emit PROPOSALS (D7) — never
// auto-create (§4.12's over-extraction lesson). Collectors never call a
// model (invariant terminology); today's classifier is the deterministic
// prefilter tier. The Apple FM tier slots in behind the same interface
// when the bridge lands (degrades: absent until then).

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
  kind: "todo" | "url" | "image" | "document" | "note";
  reason: string; // which rule fired — auditable, not vibes
  title: string;
}

const URL_RE = /^https?:\/\/\S+$/i;
const TODO_RE = /^(todo|remind me|remember to|don't forget|buy|call|email|schedule)\b/i;

export function classify(row: InboxRow): Classification {
  const note = (row.note ?? "").trim();
  const mime = row.mime ?? "";
  const title = note ? note.slice(0, 80) : row.path.replace(/^\d+-/, "").slice(0, 80);

  if (note && URL_RE.test(note)) return { kind: "url", reason: "note is a bare url", title };
  if (note && TODO_RE.test(note)) return { kind: "todo", reason: "leading action verb", title };
  if (mime.startsWith("image/")) return { kind: "image", reason: `mime ${mime}`, title };
  if (mime.includes("pdf") || /\.(pdf|docx?|pages)$/i.test(row.path)) {
    return { kind: "document", reason: "document mime/extension", title };
  }
  return { kind: "note", reason: "default", title };
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
    await db.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', $2, $3, $1)`,
      [JSON.stringify({ inbox_id: row.id, path: row.path, classification: final, note: row.note, tier }), sourceAgent, trust],
    );
    await db.query(`UPDATE inbox SET status = 'classified', proposal = $2, triaged_at = NULL WHERE id = $1`, [
      row.id,
      JSON.stringify(final),
    ]);
  }
  return items.length;
}
