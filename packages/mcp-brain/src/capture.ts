// The capture module's one write path (§4.20 table: capture). Shared by the
// console's POST /capture and the bridge's `capture` tool so an inbox row
// is the same row whichever door it came through. Provenance
// (`source_agent`) is the SERVER-SIDE identity the adapter derived from the
// credential — this function never sees a request body.
//
// WHERE the file lands is a `CaptureSink` (2026-09-16: the inbox moved into
// the vault, so Obsidian can see and edit captures; 2026-09-17: the vault is
// the instance directory itself, so that is `Inbox/`).
// Two of them:
//
//   `vaultSink(vault)` — the one Metistry uses. Captures are ordinary vault
//     content written through the reconciler's bridge, so the reconciler
//     stays the only process holding the instance repo (D5, invariant 7)
//     and every capture is committed: git is the record (invariant 1).
//   `dirSink(dir)` — a plain directory, which is what a stranger running
//     mcp-brain standalone has, and what this package did before sinks.
//
// Both carry the same two rules: the stored `inbox.path` is REPO-RELATIVE
// (`Inbox/<file>`, as db/migrations/0001_init.sql always said) when
// the sink has a prefix, and a capture over `maxTrackedBytes` goes to
// `<prefix>/.large/`, which the instance's .gitignore excludes — git does
// not carry a 40 MB video; Obsidian still sees it (docs/ops/inbox.md).

import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { INSTANCE_LAYOUT } from "@foldedspacelabs/metistry-core";
import type { Db } from "./types.js";

/** The vault directory captures land in, at the vault root. TitleCase (CLAUDE.md casing rule). */
export const INBOX_PREFIX = INSTANCE_LAYOUT.inboxDir;
/** Gitignored spill inside the inbox for captures git should not carry. */
export const INBOX_LARGE_DIRNAME = ".large";
/** Default `METISTRY_INBOX_MAX_TRACKED_BYTES`: above this a capture goes to `.large/`. */
export const DEFAULT_MAX_TRACKED_BYTES = 5 * 1024 * 1024;

export interface SinkOptions {
  /**
   * Vault-relative directory the stored `inbox.path` is built from
   * (`Inbox`). `""` — a bare directory nobody indexes — stores the
   * filename alone, which is what this package did before the move.
   */
  prefix?: string | undefined;
  /** Above this many bytes the capture goes to `<prefix>/.large/`. 0 = never. */
  maxTrackedBytes?: number | undefined;
  /** Commit author for a vault sink's writes (the reconciler stamps it; a request can never name one). */
  principal?: string | undefined;
}

/** Where a capture's bytes go. `put` returns the value stored in `inbox.path`. */
export interface CaptureSink {
  /** One line for `check()` / `GET /api/status` — never a secret. */
  readonly describe: string;
  /** Vault-relative directory this sink writes into ("" = a bare directory). */
  readonly prefix: string;
  put(name: string, bytes: Buffer): Promise<string>;
  /** Undo a `put` whose row lost an idempotency race. Best effort; never throws. */
  remove(path: string): Promise<void>;
  /** Behavioural probe: this sink can be reached. */
  check(): Promise<void>;
}

/** The vault bridge as a sink needs it — structurally the artifacts module's `VaultClient` (no import: the arrow points one way). */
export interface CaptureVault {
  write(path: string, content: Buffer, intent: { principal: string; message: string; group?: string | undefined }, expectedSha256?: string): Promise<unknown>;
  delete(path: string, intent: { principal: string; message: string; group?: string | undefined }): Promise<unknown>;
  list(prefix: string, depth?: number): Promise<unknown>;
}

function opts(o: SinkOptions | undefined): { prefix: string; max: number; principal: string } {
  return {
    prefix: (o?.prefix ?? "").replace(/\/+$/, ""),
    max: o?.maxTrackedBytes ?? DEFAULT_MAX_TRACKED_BYTES,
    principal: o?.principal ?? "capture",
  };
}

/** Where a capture of this size is stored, relative to the sink's root: `<prefix>/[.large/]<name>`. */
export function placeCapture(name: string, size: number, o?: SinkOptions): string {
  const { prefix, max } = opts(o);
  const large = max > 0 && size > max;
  return [prefix, ...(large ? [INBOX_LARGE_DIRNAME] : []), name].filter(Boolean).join("/");
}

/** A plain directory. `prefix` is what the row records; the bytes always land under `dir` itself. */
export function dirSink(dir: string, o?: SinkOptions): CaptureSink {
  const { prefix } = opts(o);
  const sub = (rel: string) => (prefix && rel.startsWith(`${prefix}/`) ? rel.slice(prefix.length + 1) : rel);
  return {
    describe: `directory ${dir}${prefix ? ` (paths recorded as ${prefix}/…)` : ""}`,
    prefix,
    async put(name, bytes) {
      const rel = placeCapture(name, bytes.length, o);
      const within = sub(rel);
      const target = join(dir, within);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return rel;
    },
    async remove(path) {
      await rm(join(dir, sub(path)), { force: true }).catch(() => {});
    },
    async check() {
      await mkdir(dir, { recursive: true });
      await readdir(dir);
    },
  };
}

/**
 * The reconciler's vault bridge. Every write is compare-and-swap on the
 * empty string — "must not exist" — so a capture can never land on top of a
 * file already in the vault, whoever wrote it (invariant 2: a human edit in
 * the vault is never overwritten by the assistant's side of the house).
 */
export function vaultSink(vault: CaptureVault, o?: SinkOptions): CaptureSink {
  const { prefix, principal } = opts({ prefix: INBOX_PREFIX, ...o });
  return {
    describe: `vault bridge ${prefix}/`,
    prefix,
    async put(name, bytes) {
      const rel = placeCapture(name, bytes.length, { ...o, prefix });
      await vault.write(rel, bytes, { principal, message: `capture ${name}`, group: "capture" }, "");
      return rel;
    },
    async remove(path) {
      await vault.delete(path, { principal, message: `capture withdrawn ${path}`, group: "capture" }).catch(() => {});
    },
    async check() {
      await vault.list(prefix, 1);
    },
  };
}

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

/** The partial unique index of migration 0021 — one `inbox` row per vault path, whoever wrote the file. Must match the index's predicate exactly: Postgres infers the conflict target from it. */
const VAULT_PATH_PREDICATE = `path LIKE '${INBOX_PREFIX}/%'`;

/** Write the capture through `sink` (a directory path is the bare `dirSink`) and insert the triage row. */
export async function captureToInbox(db: Db, sink: CaptureSink | string, input: CaptureInput): Promise<CaptureResult> {
  const dest = typeof sink === "string" ? dirSink(sink) : sink;
  const idem = input.idempotency;
  if (idem) {
    const prior = await findByIdempotency(db, idem);
    if (prior) return prior;
  }
  const filename = input.filename ?? `capture-${Date.now()}.bin`;
  const safe = filename.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/\.{2,}/g, "_"); // no traversal
  const rel = await dest.put(`${Date.now()}-${safe}`, input.bytes);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  // A file in the vault may already have an `inbox` row: the reconciler's
  // scan indexes anything that appears under `Inbox/` (a human's
  // note, a `git pull`) and could have seen this one in the millisecond
  // between the write and this insert. Whoever writes second refines the
  // row — the capture knows more (source, mime, the credential) than a scan.
  const conflict = rel.startsWith(`${INBOX_PREFIX}/`)
    ? `ON CONFLICT (path) WHERE ${VAULT_PATH_PREDICATE} DO UPDATE SET
         source = EXCLUDED.source, mime = EXCLUDED.mime, note = EXCLUDED.note, sha256 = EXCLUDED.sha256,
         source_agent = EXCLUDED.source_agent, idempotency_principal = EXCLUDED.idempotency_principal,
         idempotency_key = EXCLUDED.idempotency_key, status = 'new', proposal = NULL, triaged_at = NULL`
    : "";
  try {
    const { rows } = await db.query(
      `INSERT INTO inbox (source, path, mime, note, sha256, source_agent, idempotency_principal, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ${conflict} RETURNING id`,
      [input.source, rel, input.mime ?? null, input.note ?? null, sha, input.sourceAgent, idem?.principal ?? null, idem?.key ?? null],
    );
    return { id: Number(rows[0]?.id), path: rel, sha256: sha };
  } catch (err) {
    // 23505 = unique_violation on (principal, key): two attempts raced past
    // the lookup above. The other one's row wins; this file never existed.
    if (idem && (err as { code?: string }).code === "23505") {
      await dest.remove(rel);
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
