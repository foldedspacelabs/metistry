// The capture module's one write path (§4.20 table: capture). Shared by the
// console's POST /capture and the bridge's `capture` tool so an inbox row
// is the same row whichever door it came through. Provenance
// (`source_agent`) is the SERVER-SIDE identity the adapter derived from the
// credential — this function never sees a request body.

import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./types.js";

export interface CaptureInput {
  bytes: Buffer;
  /** Client-suggested name; sanitized (no traversal, no odd bytes) and timestamp-prefixed. */
  filename?: string | undefined;
  mime?: string | null | undefined;
  note?: string | null | undefined;
  /** Transport the capture arrived on: http | mcp | share | ... (inbox.source). */
  source: string;
  /** Agent id from the credential, or null when the owner captured it. */
  sourceAgent: string | null;
  /**
   * Retry safety (docs/ops/console-api.md): `principal` is the SERVER-SIDE
   * credential class the adapter derived, `key` the caller's. A replay of
   * the pair returns the first row; the second file is never kept.
   */
  idempotency?: { principal: string; key: string } | undefined;
}

export interface CaptureResult {
  id: number;
  path: string;
  sha256: string;
  /** true when an earlier attempt with the same (principal, key) already landed — this is that row, not a new one. */
  replayed?: boolean;
}

/** Write the file under `inboxDir` and insert the triage row. */
export async function captureToInbox(db: Db, inboxDir: string, input: CaptureInput): Promise<CaptureResult> {
  const idem = input.idempotency;
  if (idem) {
    const prior = await findByIdempotency(db, idem);
    if (prior) return prior;
  }
  await mkdir(inboxDir, { recursive: true });
  const filename = input.filename ?? `capture-${Date.now()}.bin`;
  const safe = filename.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/\.{2,}/g, "_"); // no traversal
  const rel = `${Date.now()}-${safe}`;
  await writeFile(join(inboxDir, rel), input.bytes);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  try {
    const { rows } = await db.query(
      `INSERT INTO inbox (source, path, mime, note, sha256, source_agent, idempotency_principal, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.source, rel, input.mime ?? null, input.note ?? null, sha, input.sourceAgent, idem?.principal ?? null, idem?.key ?? null],
    );
    return { id: Number(rows[0]?.id), path: rel, sha256: sha };
  } catch (err) {
    // 23505 = unique_violation on (principal, key): two attempts raced past
    // the lookup above. The other one's row wins; this file never existed.
    if (idem && (err as { code?: string }).code === "23505") {
      await unlink(join(inboxDir, rel)).catch(() => {});
      const prior = await findByIdempotency(db, idem);
      if (prior) return prior;
    }
    throw err;
  }
}

async function findByIdempotency(db: Db, idem: { principal: string; key: string }): Promise<CaptureResult | undefined> {
  const { rows } = await db.query(
    `SELECT id, path, sha256 FROM inbox WHERE idempotency_principal = $1 AND idempotency_key = $2`,
    [idem.principal, idem.key],
  );
  const row = rows[0] as { id: number | string; path: string; sha256: string } | undefined;
  return row ? { id: Number(row.id), path: row.path, sha256: row.sha256, replayed: true } : undefined;
}
