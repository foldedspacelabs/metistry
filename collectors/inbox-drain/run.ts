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

/** One drain pass. Returns how many rows were classified. */
export async function run(db: Db): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, path, mime, note, source FROM inbox WHERE status = 'new' ORDER BY ts LIMIT 50`,
  );
  for (const row of rows as InboxRow[]) {
    const c = classify(row);
    await db.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', 'inbox-drain', 'user', $1)`,
      [JSON.stringify({ inbox_id: row.id, path: row.path, classification: c, note: row.note, tier: "deterministic" })],
    );
    await db.query(`UPDATE inbox SET status = 'classified', proposal = $2, triaged_at = NULL WHERE id = $1`, [
      row.id,
      JSON.stringify(c),
    ]);
  }
  return rows.length;
}
