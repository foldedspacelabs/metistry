// Roll back (design-build-plan §2.21, ticket T10-6).
//
// `POST /api/vault/rollback {commit} | {to} | {file[, to]}` never changes the
// vault. It asks the reconciler for a PREVIEW (`POST /vault/revert` with
// `dry_run`) and raises ONE Needs You request carrying it — the commits it
// undoes, the files it puts back, the configuration it leaves alone. Only the
// owner's Approve (`POST /api/proposals/:id`, `decideProposal` in server.ts)
// runs the revert, as `user`: a NEW commit, pinned to the history the preview
// was computed on, refused `stale` if the change set is no longer the one the
// owner saw. History is preserved, always, and undo is reverting the revert —
// the console holds no git to do anything else with (D5), and the reconciler's
// git.ts refuses every rewriting argv.
//
// Guards, each at the tool (U3):
//
//   * **`local`.** The route is reach `local` in core's table: the local owner
//     token alone, so a passkey session — even the owner's, on the phone — is
//     refused `local_only` before this file runs (server.ts).
//   * **Configuration is not the console's.** The console's bearer cannot
//     revert a `.metistry/` path, `CLAUDE.md` or `README.md` — the reconciler
//     leaves each as it is and says so (`skipped_config`), and refuses
//     `include_config` from it outright. A `file` naming configuration is
//     refused here before anything is asked. A request raised WITH
//     `include_config` (the CLI's `metistry vault rollback --include-config`)
//     is approved here and carried out by that CLI with the owner-class
//     bearer — Approve on this side records the answer and reverts nothing.
//   * **Only a request this console raised.** Approve rolls back only an
//     `improvement` row whose `source_agent` is this console and whose
//     `source` names the same target and history. An agent cannot raise one
//     (`source_agent` is stamped server-side), and a rollback-shaped payload
//     on any other row is refused — never read as a prompt improvement.

import { raiseMirror, describeRequest, requestSubjectOf, type ErrorCode, type MirrorExecutor, type RequestSource } from "@foldedspacelabs/metistry-core";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";

/** The stored kind: an improvement is a before and after with Approve / Revise / Decline (§2.12) — the same row a restore is (T10-5). */
export const ROLLBACK_KIND = "improvement";
/** Server-side identity of what raised it — this process, on the owner's word. Never an agent's. */
export const ROLLBACK_AGENT = "console";
export const ROLLBACK_TRUST = "user";
export const ROLLBACK_SOURCE_KIND = "metistry";

const COMMIT_ID = /^[0-9a-fA-F]{7,64}$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PREVIEW_LINES = 50; // limit: fixed — the before and after list commits and files; past this they count them

/** What a rollback undoes — as the route takes it and the reconciler reads it. */
export type RollbackTarget = { commit: string } | { to: string } | { file: string; to?: string };

export interface RollbackAsk {
  target: RollbackTarget;
  include_config: boolean;
}

/** A calendar day or an ISO 8601 moment with its offset — the reconciler's own rule, checked here first. */
export function validMoment(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const d = DAY.exec(v);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const at = new Date(Date.UTC(y, m - 1, day));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === day;
  }
  return MOMENT.test(v) && !Number.isNaN(Date.parse(v));
}

/** Configuration: everything under `.metistry/`, the root `CLAUDE.md` and `README.md` — case-folded, as the reconciler reads it. */
export function isConfigPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === ".metistry" || lower.startsWith(".metistry/") || lower === "claude.md" || lower === "readme.md";
}

/** The body, checked for shape: exactly one of commit, to or file — or file with to — and `include_config` a boolean. */
export function parseRollbackAsk(body: unknown): { ok: true; value: RollbackAsk } | { ok: false; code: ErrorCode; message: string } {
  const usage = "name what to roll back: {commit} | {to: <YYYY-MM-DD or ISO timestamp>} | {file} | {file, to}";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, code: "invalid_request", message: usage };
  const b = body as Record<string, unknown>;
  const has = (k: string) => b[k] !== undefined && b[k] !== null;
  if (has("include_config") && typeof b.include_config !== "boolean") return { ok: false, code: "invalid_request", message: "include_config is true or false" };
  const include_config = b.include_config === true;
  if (has("to") && !validMoment(b.to)) return { ok: false, code: "invalid_request", message: "to must be a calendar day (YYYY-MM-DD) or an ISO 8601 timestamp with its offset" };
  let target: RollbackTarget;
  if (has("commit")) {
    if (has("to") || has("file")) return { ok: false, code: "invalid_request", message: usage };
    if (typeof b.commit !== "string" || !COMMIT_ID.test(b.commit)) return { ok: false, code: "invalid_request", message: "commit must be a commit id — 7 to 64 hex characters" };
    target = { commit: b.commit.toLowerCase() };
  } else if (has("file")) {
    if (typeof b.file !== "string" || b.file.trim() === "" || b.file.length > 500 || /[\0\\]/.test(b.file)) return { ok: false, code: "invalid_request", message: "file must be a vault-relative path" };
    const file = b.file.trim();
    // Configuration is never the console's to put back — refused before the reconciler is asked anything.
    if (isConfigPath(file) && !include_config) {
      return { ok: false, code: "forbidden", message: `${file} is configuration — it is rolled back only on the Mac, by your own hand: metistry vault rollback --file ${file} --include-config` };
    }
    target = has("to") ? { file, to: b.to as string } : { file };
  } else if (has("to")) {
    target = { to: b.to as string };
  } else return { ok: false, code: "invalid_request", message: usage };
  return { ok: true, value: { target, include_config } };
}

// ---- the reconciler's POST /vault/revert ------------------------------------------

export interface RevertCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

/** The reconciler's answer: a preview, or the rollback it made. */
export interface RevertAnswer {
  dry_run: boolean;
  target: RollbackTarget;
  head: string;
  base: RevertCommit | null;
  reverts: RevertCommit[];
  revert_count: number;
  files: Array<{ path: string; change: "added" | "modified" | "deleted" }>;
  config: string[];
  skipped_config: string[];
  message: string;
  sha?: string;
}

export interface RevertAsk {
  target: RollbackTarget;
  /** One line for the commit message (*Approved in Needs You, request #62*). */
  note: string;
  dry_run?: boolean;
  /** A preview of configuration too — a DRY RUN only: the reconciler refuses it on a real revert from this bearer. */
  include_config?: boolean;
  head?: string;
  expect?: { files: string[]; reverts: string[]; skipped_config: string[] };
}

/** The console's door onto `POST /vault/revert`. Throws `VaultError` with the bridge's code. */
export type VaultReverter = (ask: RevertAsk) => Promise<RevertAnswer>;

const CODES = new Set<ErrorCode>(["unauthenticated", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "not_available", "internal"]);

/** The bridge, with the console's bearer and the principal `user` — the only one the reconciler reverts as. */
export function httpVaultReverter(cfg: { url: string; token: string; timeoutMs?: number }): VaultReverter {
  const base = cfg.url.replace(/\/+$/, "");
  return async (ask) => {
    let r: Response;
    try {
      r = await fetch(`${base}/vault/revert`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          intent: { principal: "user", message: ask.note },
          ...ask.target,
          ...(ask.dry_run ? { dry_run: true } : {}),
          ...(ask.include_config ? { include_config: true } : {}),
          ...(ask.head ? { head: ask.head } : {}),
          ...(ask.expect ? { expect: ask.expect } : {}),
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new VaultError("not_available", `the reconciler did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
    const body = (await r.json().catch(() => null)) as (RevertAnswer & { error?: { code?: string; message?: string } }) | null;
    if (!r.ok) {
      const code = body?.error?.code && CODES.has(body.error.code as ErrorCode) ? (body.error.code as ErrorCode) : "not_available";
      throw new VaultError(code, body?.error?.message ?? `the reconciler answered HTTP ${r.status} — a reconciler older than this console has no /vault/revert; \`metistry restart reconciler\` after an update`);
    }
    const answer = parseRevertAnswer(body);
    if (!answer) throw new VaultError("not_available", "the reconciler's /vault/revert answered something that is not a rollback");
    return answer;
  };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
function commitOf(v: unknown): RevertCommit | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  return typeof c.sha === "string" && typeof c.subject === "string" && typeof c.author === "string" && typeof c.date === "string" ? { sha: c.sha, subject: c.subject, author: c.author, date: c.date } : null;
}

/** The bridge's answer, parsed strictly on this side of the wire: only these fields travel on. */
export function parseRevertAnswer(v: unknown): RevertAnswer | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  const target = parseRollbackAsk({ ...(a.target as object), include_config: true });
  if (!target.ok || typeof a.head !== "string" || !FULL_COMMIT.test(a.head) || typeof a.dry_run !== "boolean") return null;
  const reverts = Array.isArray(a.reverts) ? a.reverts.map(commitOf) : null;
  if (!reverts || reverts.some((c) => c === null)) return null;
  const base = a.base === null ? null : commitOf(a.base);
  if (a.base !== null && base === null) return null;
  const files = Array.isArray(a.files) ? a.files : null;
  if (!files || !files.every((f) => typeof f?.path === "string" && ["added", "modified", "deleted"].includes(f?.change))) return null;
  if (!strings(a.config) || !strings(a.skipped_config) || typeof a.message !== "string" || typeof a.revert_count !== "number") return null;
  if (a.sha !== undefined && (typeof a.sha !== "string" || !FULL_COMMIT.test(a.sha))) return null;
  return {
    dry_run: a.dry_run,
    target: target.value.target,
    head: a.head,
    base,
    reverts: reverts as RevertCommit[],
    revert_count: a.revert_count,
    files: files.map((f: { path: string; change: RevertAnswer["files"][number]["change"] }) => ({ path: f.path, change: f.change })),
    config: a.config,
    skipped_config: a.skipped_config,
    message: a.message,
    ...(typeof a.sha === "string" ? { sha: a.sha } : {}),
  };
}

// ---- the request ---------------------------------------------------------------------

/** What Approve does, exactly as the request carries it. */
export interface RollbackEdit {
  readonly target: RollbackTarget;
  /** The history the preview was computed on — Approve reverts exactly this change, on top of whatever landed since. */
  readonly head: string;
  readonly reverts: readonly string[];
  readonly files: readonly string[];
  readonly skipped_config: readonly string[];
  /** Configuration too: approved here, carried out by `metistry vault rollback --include-config` with the owner's bearer. */
  readonly include_config: boolean;
  readonly config: readonly string[];
}

/** One pending request per target, history and configuration choice. */
export function rollbackSource(target: RollbackTarget, head: string, includeConfig: boolean): RequestSource {
  const what = "commit" in target ? `commit=${target.commit}` : "file" in target ? `file=${target.file}${target.to ? `,to=${target.to}` : ""}` : `to=${target.to}`;
  return { kind: ROLLBACK_SOURCE_KIND, external_ref: `rollback:${what}@${head}${includeConfig ? "+config" : ""}` };
}

/** True when a payload carries a rollback at all — valid or not. Such a row is never read as any other kind of improvement. */
export function carriesRollback(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.hasOwn(payload, "rollback");
}

/**
 * The rollback a request row carries, or null: only a row THIS console raised
 * (`source_agent`, stamped server-side), whose `source` names the same target
 * and history as its payload. What it changes is decided again by the
 * reconciler at Approve, held to `expect` — never taken from the row alone.
 */
export function rollbackOf(row: { kind?: unknown; source_agent?: unknown; source?: unknown; payload?: unknown }): RollbackEdit | null {
  if (row.kind !== ROLLBACK_KIND || row.source_agent !== ROLLBACK_AGENT || !carriesRollback(row.payload)) return null;
  const r = (row.payload as { rollback?: unknown }).rollback as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) return null;
  if (typeof r.include_config !== "boolean") return null;
  const t = parseRollbackAsk({ ...(typeof r.target === "object" && r.target !== null ? r.target : {}), include_config: r.include_config });
  if (!t.ok) return null;
  if (typeof r.head !== "string" || !FULL_COMMIT.test(r.head)) return null;
  if (!strings(r.reverts) || !strings(r.files) || !strings(r.skipped_config) || !strings(r.config)) return null;
  if (!r.include_config && (r.config.length > 0 || r.files.some(isConfigPath))) return null;
  const want = rollbackSource(t.value.target, r.head, r.include_config);
  const source = row.source as { kind?: unknown; external_ref?: unknown } | null | undefined;
  if (typeof source !== "object" || source === null || source.kind !== want.kind || source.external_ref !== want.external_ref) return null;
  return { target: t.value.target, head: r.head, reverts: r.reverts, files: r.files, skipped_config: r.skipped_config, include_config: r.include_config, config: r.config };
}

/** How the owner reads the target. */
export function describeTarget(t: RollbackTarget, first?: RevertCommit): string {
  if ("commit" in t) return `“${first?.subject ?? t.commit}” (${t.commit.slice(0, 7)})`;
  if ("file" in t) return t.to ? `${t.file} to ${t.to}` : `${t.file} to before its last change`;
  return `the vault to ${t.to}`;
}

function lines<T>(xs: readonly T[], total: number, each: (x: T) => string): string {
  const shown = xs.slice(0, MAX_PREVIEW_LINES).map(each);
  if (total > shown.length) shown.push(`… and ${total - shown.length} more`);
  return shown.join("\n");
}

/** The request's payload: the owner's words, the before and after they will see, and the rollback Approve makes. */
export function rollbackPayload(preview: RevertAnswer, includeConfig: boolean): Record<string, unknown> {
  // With include_config the preview was asked for configuration too (a dry
  // run changes nothing, so the console's bearer may ask): `config` is what
  // the owner's own hand will change, and `files` already lists it.
  const config = includeConfig ? preview.config : [];
  const skipped = preview.skipped_config;
  const n = preview.revert_count;
  const what = describeTarget(preview.target, preview.reverts[0]);
  const title = "commit" in preview.target ? `Undo ${what}` : `Roll back ${what}`;
  const changed = preview.files.map((f) => `${f.path} — ${f.change === "added" ? "comes back" : f.change === "deleted" ? "goes away" : "goes back"}${config.includes(f.path) ? " (configuration)" : ""}`);
  const after = [lines(changed, changed.length, (l) => l)];
  if (skipped.length) after.push("", `Left as they are (configuration): ${skipped.join(", ")}`);
  return {
    title,
    summary:
      `${title} — ${n} commit${n === 1 ? "" : "s"} undone, ${changed.length} file${changed.length === 1 ? "" : "s"} put back. ` +
      (includeConfig
        ? "This includes configuration: Approve lets `metistry vault rollback` in your terminal make the change, as your own hand. "
        : "Approve makes one new commit, as you; the history keeps every commit it undoes, and undoing it is rolling back that commit. ") +
      (skipped.length ? `Configuration is left as it is (${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}). ` : "") +
      "Revise and Decline change nothing.",
    body: {
      kind: "before_after",
      heading: "What Approve Undoes",
      before: { label: n === 1 ? "The commit it undoes" : `The ${n} commits it undoes`, text: lines(preview.reverts, n, (c) => `${c.sha.slice(0, 7)} ${c.subject} — ${c.author}, ${c.date.slice(0, 10)}`) },
      after: { label: preview.base ? `Put back as of ${preview.base.date.slice(0, 10)}` : "Put back", text: after.join("\n") },
    },
    rollback: {
      target: preview.target,
      head: preview.head,
      reverts: preview.reverts.map((c) => c.sha),
      files: preview.files.map((f) => f.path),
      skipped_config: skipped,
      include_config: includeConfig,
      config,
    } satisfies RollbackEdit,
  };
}

/** The route's `preview`: the ids and paths (the Mac's frozen shape), and the detail beside them. */
export function previewBody(p: RevertAnswer, edit: RollbackEdit): Record<string, unknown> {
  return {
    reverts: [...edit.reverts],
    files: [...edit.files],
    skipped_config: [...edit.skipped_config],
    config: [...edit.config],
    include_config: edit.include_config,
    head: p.head,
    base: p.base,
    revert_count: p.revert_count,
    commits: p.reverts,
    changes: p.files,
  };
}

const PROPOSAL_ROW_SQL = `SELECT id, ts, kind, source_agent, trust, payload, decision, decided_at, work_id, snoozed_until FROM proposals WHERE id = $1`;

export type RaiseOutcome = { ok: true; id: number; raised: boolean; preview: Record<string, unknown>; proposal: Record<string, unknown> | null } | { ok: false; code: ErrorCode; message: string };

/**
 * Preview, then raise the request — or find the one already waiting for this
 * target and history. The route has already checked the body's shape; the
 * `local` gate has already refused everything but the local owner token.
 */
export async function raiseRollback(deps: { revert: VaultReverter; db: MirrorExecutor }, ask: RollbackAsk): Promise<RaiseOutcome> {
  let preview: RevertAnswer;
  try {
    preview = await deps.revert({ target: ask.target, note: "Preview for Needs You", dry_run: true, include_config: ask.include_config });
  } catch (err) {
    if (err instanceof VaultError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
  const payload = rollbackPayload(preview, ask.include_config);
  const edit = payload.rollback as RollbackEdit;
  const source = rollbackSource(preview.target, preview.head, ask.include_config);
  const raised = await raiseMirror(deps.db, { kind: ROLLBACK_KIND, source_agent: ROLLBACK_AGENT, trust: ROLLBACK_TRUST, payload, source });
  const row = (await deps.db.query(PROPOSAL_ROW_SQL, [raised.id])).rows[0];
  return { ok: true, id: raised.id, raised: raised.raised, preview: previewBody(preview, edit), // as GET /api/proposals serves it: the reading, and the subject (T2-14) — none, for a row with no work row behind it
    proposal: row ? { ...row, request: describeRequest(String(row.kind), row.payload), subject: requestSubjectOf(String(row.kind), {}) } : null };
}

/** The commit message's note: which request approved it. */
export function approvedNote(proposalId: number | string): string {
  return `Approved in Needs You (request #${proposalId}).`;
}

/**
 * Approve: run the revert as `user`, pinned to the previewed history and held
 * to the previewed change set. Throws VaultError — `conflict` when it is no
 * longer the change the owner saw (stale), whatever else the bridge refused.
 * A request that includes configuration is not this console's to carry out:
 * it returns `{runs_in: "cli"}` and reverts nothing.
 */
export async function applyRollback(revert: VaultReverter, edit: RollbackEdit, proposalId: number | string): Promise<{ runs_in: "console"; sha: string; files: string[] } | { runs_in: "cli" }> {
  if (edit.include_config) return { runs_in: "cli" };
  const done = await revert({
    target: edit.target,
    note: approvedNote(proposalId),
    head: edit.head,
    expect: { files: [...edit.files], reverts: [...edit.reverts], skipped_config: [...edit.skipped_config] },
  });
  if (!done.sha) throw new VaultError("internal", "the reconciler answered a rollback with no commit");
  return { runs_in: "console", sha: done.sha, files: done.files.map((f) => f.path) };
}
