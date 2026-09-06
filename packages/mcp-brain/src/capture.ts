// The capture module's one write path (§4.20 table: capture). Shared by the
// console's POST /capture and the bridge's `capture` tool so an inbox row
// is the same row whichever door it came through. Provenance
// (`source_agent`) is the SERVER-SIDE identity the adapter derived from the
// credential — this function never sees a request body.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
}

export interface CaptureResult {
  id: number;
  path: string;
  sha256: string;
}

/** Write the file under `inboxDir` and insert the triage row. */
export async function captureToInbox(db: Db, inboxDir: string, input: CaptureInput): Promise<CaptureResult> {
  await mkdir(inboxDir, { recursive: true });
  const filename = input.filename ?? `capture-${Date.now()}.bin`;
  const safe = filename.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/\.{2,}/g, "_"); // no traversal
  const rel = `${Date.now()}-${safe}`;
  await writeFile(join(inboxDir, rel), input.bytes);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const { rows } = await db.query(
    `INSERT INTO inbox (source, path, mime, note, sha256, source_agent) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.source, rel, input.mime ?? null, input.note ?? null, sha, input.sourceAgent],
  );
  return { id: Number(rows[0]?.id), path: rel, sha256: sha };
}
