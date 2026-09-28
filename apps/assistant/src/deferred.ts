// Defer and report (C59; T4-22): what an unattended run skipped, read back
// from the rows that recorded it — never from what the model says it did.
//
// *Ask* means pause for an agent the owner is talking to and defer for a run
// nobody is watching. The run tells the bridge which it is (the interactive
// bit in each call's `_meta`, beside the turn handle — tools.ts); the bridge
// answers a deferred Ask First call with `skipped` and records it on its own
// `runs` row (`kind = connection_call`, `meta.outcome = "deferred"`, the
// run's `turn_id`), with its request already in Needs You.
//
// So the run's report is a QUERY, not a sentence the model was asked to
// write. The drain reads the deferred rows of its own turn after the turn
// and puts them on the turn's `runs` row (`meta.skipped`) and at the foot of
// the run's output. The model is also told, in the tool's answer, to say it
// skipped the step; this is what makes the report true when it forgets.
//
// Scoped three ways so no other caller can put a line in this run's report:
// the run's own principal (`component`), rows written since the run began
// (the database's clock on both sides), and the run's own turn handle.

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** One Ask First call an unattended run deferred: what it would have done, and the Needs You request that holds it. */
export interface SkippedCall {
  connection: string;
  tool: string;
  /** The `connection_call` request in Needs You — the owner's Approve runs it. */
  proposal_id: number | null;
  /** The `runs` row that recorded the deferral (and holds the confirm record the Approve redeems). */
  run_id: number;
}

// limit: fixed — a run that deferred more than this is reported by count past it; the rows are all in Needs You and in runs
export const MAX_SKIPPED_REPORTED = 20;

/**
 * The Ask First calls one run deferred: rows of `component`'s, since the run
 * row `runId` began, carrying `turnId`, that the bridge marked deferred.
 */
export async function deferredCalls(db: Db, q: { component: string; runId: number; turnId: string }): Promise<SkippedCall[]> {
  const { rows } = await db.query(
    `SELECT id, meta ->> 'connection' AS connection, meta ->> 'connection_tool' AS tool, meta ->> 'proposal_id' AS proposal_id
       FROM runs
      WHERE kind = 'connection_call' AND component = $1
        AND ts >= (SELECT started_at FROM runs WHERE id = $2)
        AND meta ->> 'turn_id' = $3
        AND meta ->> 'outcome' = 'deferred'
        AND ok IS TRUE
      ORDER BY id`,
    [q.component, q.runId, q.turnId],
  );
  return rows.map((r) => ({
    connection: String(r.connection ?? ""),
    tool: String(r.tool ?? ""),
    proposal_id: r.proposal_id === null || r.proposal_id === undefined ? null : Number(r.proposal_id),
    run_id: Number(r.id),
  }));
}

/**
 * The line the run's output ends with when it skipped something. Plain and
 * name-free (the assistant's name lives in identity.yaml alone); each step
 * names the request that holds it, so the owner can find it in Needs You.
 */
export function skippedReport(skipped: readonly SkippedCall[]): string {
  if (skipped.length === 0) return "";
  const shown = skipped.slice(0, MAX_SKIPPED_REPORTED).map((s) => `- ${s.tool} on ${s.connection}${s.proposal_id !== null ? ` (request #${s.proposal_id})` : ""}`);
  const more = skipped.length > MAX_SKIPPED_REPORTED ? [`- and ${skipped.length - MAX_SKIPPED_REPORTED} more`] : [];
  const n = skipped.length;
  return [`Skipped ${n} step${n === 1 ? "" : "s"} that wait${n === 1 ? "s" : ""} for your approval in Needs You — nothing ran:`, ...shown, ...more].join("\n");
}

/** What the run's `runs` row keeps of it: the list, bounded the same way. */
export function skippedMeta(skipped: readonly SkippedCall[]): Record<string, unknown> {
  if (skipped.length === 0) return {};
  return { skipped: skipped.slice(0, MAX_SKIPPED_REPORTED), skipped_count: skipped.length };
}
