// Restore a file (design-build-plan §2.21, ticket T10-5).
//
// `POST /api/knowledge/restore {path, sha, seen_sha}` never writes. It raises
// ONE Needs You request carrying the before (the file as it is now) and the
// after (the file at `sha`), and only the owner's Approve — `POST
// /api/proposals/:id`, `decideProposal` in server.ts — writes the old bytes
// back, as `user`, as a NEW commit (*Restore <path> to <date>*). History is
// preserved, always: nothing here rewrites, resets or checks out anything,
// and the console holds no git to do it with (D5).
//
// Three guards, each at the tool (U3):
//
//   * **Notes only.** The path must be one the owner's page door serves —
//     core's `classify(path) === "knowledge"`. `.metistry/`, `Artifacts/`, a
//     dot-path and the root `CLAUDE.md`/`README.md` are refused at the route,
//     and again when Approve reads the stored request, so a row written by
//     hand cannot restore machinery either. Configuration is rolled back with
//     the CLI's owner caller class (T10-6), never from here.
//   * **The owner's alone, and only a request this console raised.** The
//     route refuses every principal but the owner before it reads a byte.
//     Approve restores only an `improvement` row whose `source_agent` is this
//     console and whose `source` names the same path and commit — an agent
//     cannot raise one (`source_agent` is stamped server-side), and a
//     restore-shaped payload on any other row is refused, never read as a
//     prompt improvement.
//   * **Nothing the owner did not see.** The raise is refused `409 stale`
//     when the file is not what the client rendered (`seen_sha`, the content
//     hash `GET /api/knowledge/page` serves; `""` for a file that is not
//     there). Approve re-reads both sides: the version's bytes must hash to
//     what the request showed, and the write is a compare-and-swap on the
//     file as the request showed it — so a file edited meanwhile is `409
//     stale`, nothing written, the request still waiting (C45).
//
// One request per (path, commit): the request is a mirror (T1-8) whose
// source is `{kind: "metistry", external_ref: "restore:<path>@<sha>"}`, so a
// double tap raises one row, and Knowledge finds the request for a page by
// its payload's `restore.path` and shows it inline — answering it there
// answers it in Needs You (screen 10 §3.1, the drafts pattern).

import {
  classify,
  describeRequest,
  raiseMirror,
  requestSubjectOf,
  resolveAtSource,
  type ErrorCode,
  type MirrorExecutor,
  type RequestSource,
} from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import type { KnowledgeHistory } from "./knowledge-routes.js";

/** The stored kind: an improvement is a before and after with Approve / Revise / Decline (§2.12). */
export const RESTORE_KIND = "improvement";
/** Server-side identity of what raised it — this process, on the owner's word. Never self-declared, and never an agent's. */
export const RESTORE_AGENT = "console";
/** The owner asked for it. */
export const RESTORE_TRUST = "user";
/** The mirror's source system: this product (as *Tidy Me/profile.md* is). */
export const RESTORE_SOURCE_KIND = "metistry";

/** A full commit id — what the request stores, so Approve names exactly one commit. */
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

const MAX_PREVIEW_CHARS = 256 * 1024; // limit: fixed — the request's before and after ride every `GET /api/proposals` a phone parses; a note past a quarter of a million characters is shown in part and restored whole, and the preview says so

/** The mirror source for one restore: one pending request per path and commit. */
export function restoreSource(path: string, sha: string): RequestSource {
  return { kind: RESTORE_SOURCE_KIND, external_ref: `restore:${path}@${sha}` };
}

/** What Approve does, exactly as the request carries it. */
export interface RestoreEdit {
  readonly path: string;
  /** The full commit id whose bytes are written back. */
  readonly sha: string;
  /** The commit's author date, as the bridge reported it. */
  readonly date: string;
  /** The file's content hash when the request was raised — `""` when there was no file. Approve's compare-and-swap. */
  readonly base_sha256: string;
  /** The version's content hash: the bytes Approve writes must still be these. */
  readonly version_sha256: string;
}

/** A note path the owner's page door serves — the same predicate every knowledge door asks. */
export function isRestorablePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 500 && !/[\0\\]/.test(path) && classify(path) === "knowledge";
}

/** True when a payload carries a restore at all — valid or not. Such a row is never read as any other kind of improvement. */
export function carriesRestore(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.hasOwn(payload, "restore");
}

/**
 * The restore a request row carries, or null. Only a row THIS console raised
 * (`source_agent`, stamped server-side), whose `source` names the same path
 * and commit as its payload, for a path that is a note. Everything else about
 * the write — the bytes — is read again at Approve, never taken from the row.
 */
export function restoreOf(row: { kind?: unknown; source_agent?: unknown; source?: unknown; payload?: unknown }): RestoreEdit | null {
  if (row.kind !== RESTORE_KIND || row.source_agent !== RESTORE_AGENT) return null;
  if (!carriesRestore(row.payload)) return null;
  const r = (row.payload as { restore?: unknown }).restore as Partial<Record<keyof RestoreEdit, unknown>> | null;
  if (typeof r !== "object" || r === null) return null;
  const { path, sha, date, base_sha256, version_sha256 } = r;
  if (!isRestorablePath(path)) return null;
  if (typeof sha !== "string" || !FULL_COMMIT.test(sha)) return null;
  if (typeof date !== "string" || date === "") return null;
  if (typeof base_sha256 !== "string" || (base_sha256 !== "" && !SHA256.test(base_sha256))) return null;
  if (typeof version_sha256 !== "string" || !SHA256.test(version_sha256)) return null;
  const want = restoreSource(path, sha);
  const source = row.source as { kind?: unknown; external_ref?: unknown } | null | undefined;
  if (typeof source !== "object" || source === null || source.kind !== want.kind || source.external_ref !== want.external_ref) return null;
  return { path, sha, date, base_sha256, version_sha256 };
}

/** The calendar day of a git date, as its author wrote it (`2026-09-26T22:53:01-04:00` → `2026-09-26`). */
export function dayOf(date: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date;
}

/** The commit subject Approve writes: the plan's words (§2.21). */
export function restoreMessage(edit: Pick<RestoreEdit, "path" | "sha" | "date">, proposalId: number | string): string {
  return `Restore ${edit.path} to ${dayOf(edit.date)}\n\nThe version at ${edit.sha.slice(0, 12)}, approved in Needs You (request #${proposalId}).`;
}

/** Bytes as the owner reads them in a before and after: the text, or a sentence saying it is not text. Never the bytes Approve writes. */
export function previewOf(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `(${bytes.length} bytes that are not text — Approve restores them exactly)`;
  }
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_PREVIEW_CHARS)}\n\n… ${text.length - MAX_PREVIEW_CHARS} more characters not shown — Approve restores the whole file`;
}

/** The request's payload: the owner's words, the before and after they will see, and the restore Approve makes. */
export function restorePayload(
  version: { path: string; sha: string; date: string; subject: string; content: Buffer; sha256: string },
  current: { content: Buffer; sha256: string } | null,
): Record<string, unknown> {
  const day = dayOf(version.date);
  const title = `Restore ${version.path}`;
  return {
    title,
    summary:
      `${title} to ${day} — the version from “${version.subject}” (${version.sha.slice(0, 7)}). ` +
      `Approve writes it back as a new commit, as you; the history keeps every version, including the one it replaces. Revise and Decline change nothing.`,
    body: {
      kind: "before_after",
      heading: "What Approve Does",
      before: { label: current ? `${version.path} now` : `${version.path} — not in the vault now`, text: current ? previewOf(current.content) : "" },
      after: { label: `${version.path} as of ${day}`, text: previewOf(version.content) },
    },
    restore: {
      path: version.path,
      sha: version.sha,
      date: version.date,
      base_sha256: current?.sha256 ?? "",
      version_sha256: version.sha256,
    } satisfies RestoreEdit,
  };
}

export interface RestoreDeps {
  /** The working tree, through the vault bridge: the file as it is now. */
  vault: Pick<VaultClient, "read">;
  /** The file at one commit (`GET /vault/show`, T10-4). */
  history: Pick<KnowledgeHistory, "show">;
  db: MirrorExecutor;
}

export type RaiseOutcome =
  | { ok: true; id: number; raised: boolean; path: string; sha: string; date: string; proposal: Record<string, unknown> | null }
  | { ok: false; code: ErrorCode; message: string; stale?: { path: string; sha256: string; bytes: number } | null };

/** The row as `GET /api/proposals` serves it — so Knowledge draws the request inline from the answer, and answers it at `POST /api/proposals/:id` with its `ts`. */
const PROPOSAL_ROW_SQL = `SELECT id, ts, kind, source_agent, trust, payload, decision, decided_at, work_id, snoozed_until, group_id FROM proposals WHERE id = $1`;

/**
 * Raise the request, or find the one already waiting for this path and
 * commit. The route has already refused every principal but the owner, and
 * checked the shape of `path`, `sha` and `seen_sha`.
 */
export async function raiseRestore(deps: RestoreDeps, ask: { path: string; sha: string; seen_sha: string }): Promise<RaiseOutcome> {
  const current = await deps.vault.read(ask.path);
  const now = current?.sha256 ?? "";
  if (ask.seen_sha !== now) {
    return {
      ok: false,
      code: "conflict",
      message: current
        ? `${ask.path} changed after you saw it — here is its hash as it stands; look again and restore from there`
        : `${ask.path} is not in the vault now — it was moved or deleted after you saw it; send seen_sha "" to restore it where it was`,
      stale: current ? { path: ask.path, sha256: current.sha256, bytes: current.bytes } : null,
    };
  }
  const version = await deps.history.show(ask.path, ask.sha); // VaultError: not_found for no such commit, not on the branch, or no such file then
  if (current && version.sha256 === current.sha256) {
    return { ok: false, code: "invalid_request", message: `${ask.path} is already byte for byte the version at ${version.sha.slice(0, 12)} — there is nothing to restore` };
  }
  const payload = restorePayload(version, current);
  const source = restoreSource(ask.path, version.sha);
  const raise = () => raiseMirror(deps.db, { kind: RESTORE_KIND, source_agent: RESTORE_AGENT, trust: RESTORE_TRUST, payload, source });

  let raised = await raise();
  if (!raised.raised) {
    // One is already waiting for this commit. If it was raised against a file
    // that has changed since, it can never be approved (its compare-and-swap
    // would refuse), so it leaves the queue as resolved at its source and
    // this one takes its place — otherwise a stale request would hold the
    // subject and every new ask would hand it back.
    const existing = (await deps.db.query(`SELECT payload FROM proposals WHERE id = $1`, [raised.id])).rows[0];
    const base = (existing?.payload as { restore?: { base_sha256?: unknown } } | undefined)?.restore?.base_sha256;
    if (base !== now) {
      await resolveAtSource(deps.db, source, `${ask.path} changed since it was asked — the new request asks about it now`);
      raised = await raise();
    }
  }
  const row = (await deps.db.query(PROPOSAL_ROW_SQL, [raised.id])).rows[0];
  return {
    ok: true,
    id: raised.id,
    raised: raised.raised,
    path: ask.path,
    sha: version.sha,
    date: version.date,
    // as GET /api/proposals serves it (server.ts's `servedProposal`): the
    // reading, and the subject (T2-14) — none, for a row with no work row
    // behind it; the same shape rollback's 202 answers with
    proposal: row ? { ...row, request: describeRequest(String(row.kind), row.payload), subject: requestSubjectOf(String(row.kind), {}) } : null,
  };
}

/**
 * Approve: write the version's bytes back as `user` — a new commit, never a
 * rewrite. Throws VaultError: `conflict` when the file is no longer what the
 * request showed as "before" (or the version no longer hashes to what it
 * showed as "after"); otherwise whatever the bridge refused.
 */
export async function applyRestore(
  vault: Pick<VaultClient, "read" | "write" | "flush">,
  history: Pick<KnowledgeHistory, "show">,
  edit: RestoreEdit,
  proposalId: number | string,
): Promise<{ path: string; sha256: string; created: boolean }> {
  const version = await history.show(edit.path, edit.sha);
  if (version.sha256 !== edit.version_sha256) {
    throw new VaultError("conflict", `${edit.path} at ${edit.sha.slice(0, 12)} is not the version this request showed, so nothing was written — Decline it and restore again from the history`);
  }
  const current = await vault.read(edit.path);
  if ((current?.sha256 ?? "") !== edit.base_sha256) {
    throw new VaultError("conflict", `${edit.path} changed after this was asked, so nothing was written — Decline it, and restore again from the file as it is now`);
  }
  // The compare-and-swap closes the gap between that read and the write.
  const r = await vault.write(edit.path, version.content, { principal: "user", message: restoreMessage(edit, proposalId) }, edit.base_sha256);
  await vault.flush?.().catch(() => {});
  return { path: r.path, sha256: r.sha256, created: r.created };
}
