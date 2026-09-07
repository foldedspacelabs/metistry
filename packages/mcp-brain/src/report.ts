// report.submit (§4.19): a `proposals` row of kind `report`, source_agent
// from the credential, external trust. Idempotent on a caller-supplied
// key (the partial unique index from migration 0009 makes the retry safe
// under concurrency) and near-duplicate-suppressed: the same agent
// re-reporting the same title within 24h gets the existing id back
// instead of a second row for the user to triage.

import { redactSecrets } from "@foldedspacelabs/metistry-core";
import type { Db } from "./types.js";

export const REPORT_KINDS = ["finding", "decision", "gotcha", "progress"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportInput {
  title: string;
  body: string;
  kind?: ReportKind | undefined;
  /** Handles, never payloads (§4.19): issue urls, task ids, note paths. */
  refs?: string[] | undefined;
  idempotency_key?: string | undefined;
}

export interface ReportResult {
  id: number;
  /** false = a new row; otherwise which rule matched an existing one. */
  deduplicated: false | "idempotency_key" | "title";
}

const NEAR_DUP_WINDOW = "24 hours";

export async function submitReport(db: Db, agentId: string, input: ReportInput): Promise<ReportResult> {
  const key = input.idempotency_key ?? null;
  if (key !== null) {
    const hit = await byKey(db, agentId, key);
    if (hit !== null) return { id: hit, deduplicated: "idempotency_key" };
  }
  const dup = await db.query(
    `SELECT id FROM proposals
     WHERE kind = 'report' AND source_agent = $1 AND payload->>'title' = $2 AND ts > now() - interval '${NEAR_DUP_WINDOW}'
     ORDER BY ts DESC LIMIT 1`,
    [agentId, input.title],
  );
  if (dup.rows[0]) return { id: Number(dup.rows[0].id), deduplicated: "title" };

  // Secret-named fields never land in the queue (§4.3 default 3).
  const payload = redactSecrets({
    title: input.title,
    body: input.body,
    kind: input.kind ?? "finding",
    refs: input.refs ?? [],
    ...(key !== null ? { idempotency_key: key } : {}),
    provenance: { agent: agentId, via: "mcp-brain", submitted_at: new Date().toISOString() },
  });
  const ins = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'external', $2::jsonb)
     ON CONFLICT (source_agent, (payload->>'idempotency_key')) WHERE kind = 'report' AND payload->>'idempotency_key' IS NOT NULL DO NOTHING
     RETURNING id`,
    [agentId, JSON.stringify(payload)],
  );
  if (ins.rows[0]) return { id: Number(ins.rows[0].id), deduplicated: false };
  // Lost the race on the key: the earlier insert wins.
  const again = key !== null ? await byKey(db, agentId, key) : null;
  if (again === null) throw new Error("report insert returned no row and no key match"); // unreachable unless the row vanished mid-flight
  return { id: again, deduplicated: "idempotency_key" };
}

async function byKey(db: Db, agentId: string, key: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM proposals WHERE kind = 'report' AND source_agent = $1 AND payload->>'idempotency_key' = $2 LIMIT 1`,
    [agentId, key],
  );
  return rows[0] ? Number(rows[0].id) : null;
}
