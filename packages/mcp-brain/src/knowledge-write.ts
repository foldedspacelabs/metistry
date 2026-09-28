// The assistant's write path — `brain-commit` (§4.7 layer 1, D5): a thin
// call to the reconciler's `POST /vault/write` with a commit intent. The
// engine still has no shell and no git (invariant 9); this is its ENTIRE
// mutating surface into the vault.
//
// Rules enforced here, not by prompting:
// - only a principal of kind `internal` may write (§4.11: sub-agents and
//   external agents never write knowledge — they `report`); anyone else
//   gets the uniform `forbidden` envelope, whatever the path;
// - the path must be a vault path (the §4.7 free zone) AND inside the
//   principal's read grant — writes never reach wider than reads;
// - the bridge's own rules stay in force behind this one (protected paths
//   are the user's hand; traversal, `.git`, symlinks, casing slips refused);
// - an existing markdown note is refused (`forbidden`, "owned by <source>;
//   propose instead") unless its frontmatter `source` is the caller's own id
//   or the fold's (§4.11: one writer, but not one owner) — new notes are
//   free. A note with NO `source:` in its frontmatter is the USER's, not
//   ownerless (2026-09-19: inverted from the original default, which let a
//   hand-written note — which never carries `source:` — be replaced whole by
//   a model turn); the one exemption is `now.md` at the vault root by exact
//   name, see USER_SOURCE / ownershipRefusal below;
// - a routine's own folder (`Journal/Plan/`, `Journal/Standup/`,
//   `Journal/Brief/` — core's `JOURNAL_ROUTINE_DIRS`) is written under that
//   routine's principal and nobody else's (owner ruling (a), W1) ONCE the
//   routine has written its file: the one thing the assistant may then do
//   there is fill the pending `prose` slots (C103) — the incoming content is
//   checked against the file on disk by `fillProseSlots`, only the slot
//   lines may differ, and the write goes out in the ROUTINE's name — never a
//   stamp, never another byte (`writeRoutineProse` below). A path with no
//   file there yet is an ordinary create, same as anywhere else in the vault
//   (ruling 9, W2 checkpoint, 2026-09-27, decisions-log.md: X-11 relaxes
//   T3-6's blanket create refusal on these three folders);
// - a markdown write is stamped with provenance (§4.15): `source` is the
//   credential's id — never an argument — and `updated` is today;
// - compare-and-swap is NOT optional (2026-09-16): an omitted
//   `expected_sha256` means CREATE ONLY — the bridge gets CAS on the empty
//   string, so an existing note comes back `conflict` instead of being
//   overwritten blind. The user edits the vault constantly (Obsidian on
//   a phone, an editor, another device), and the one rule that makes those
//   edits safe is that the assistant must have SEEN the bytes it replaces.
//   A 409 carries the current hash so the agent re-reads and redoes the
//   edit rather than clobbering it.
//
// Deletes and renames are NOT exposed: they stay the user's hand for now.

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { ErrorCode } from "@foldedspacelabs/metistry-core";
import { PROSE_SOURCES, fillProseSlots, isProtectedPath, journalRoutineOf, may, notKnowledge } from "@foldedspacelabs/metistry-core";
import { validKnowledgePath, type KnowledgeReader } from "./knowledge.js";
import { principalOf } from "./principal.js";
import type { AgentPrincipal } from "./types.js";

/**
 * The reconciler's commit intent (apps/reconciler `parseIntent`). `turn` and
 * `run` are what make one agent reply ONE commit (§2.21): the committer's act
 * is the explicit `group`, else the turn, else the run, else the write alone
 * — and they ride as `Metistry-Turn:` / `Metistry-Run:` trailers.
 */
export interface VaultWriteIntent {
  principal: string;
  message: string;
  group?: string | undefined;
  /** `runs.id` of the tool call that made this write. */
  run?: string | undefined;
  /** The reply's turn handle (turn-id.ts). */
  turn?: string | undefined;
}

/** The act a write belongs to, as the tool wrapper knows it (server.ts `wrap`). Correlation only — never identity, never auth. */
export interface WriteAct {
  turnId?: string | undefined;
  runId?: number | string | undefined;
}

export interface VaultWriteRequest {
  path: string;
  /** UTF-8 text; the bridge's `content` field. */
  content: string;
  intent: VaultWriteIntent;
  /** Hex sha256 the current content must have; "" = must not exist; undefined = unconditional. */
  expected_sha256?: string | undefined;
}

export type VaultWriteOutcome =
  | { ok: true; path: string; sha256: string; bytes: number; created: boolean }
  | { ok: false; code: ErrorCode; message?: string | undefined; /** On `conflict`: the hash now on disk, or null when the note is gone. */ current_sha256?: string | null | undefined };

/** Injected by the host — the reconciler's bridge in Metistry, a fake in tests. Absent → `knowledge_write` is `not_available`. */
export type KnowledgeWriter = (req: VaultWriteRequest) => Promise<VaultWriteOutcome>;

export interface VaultBridgeOptions {
  /** The bridge's base URL, e.g. http://host.docker.internal:7812 */
  url: string;
  /** The console's bearer for the bridge (METISTRY_BRIDGE_TOKEN_RECONCILER). Never the agent's. */
  token: string;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

const ERROR_CODES: ReadonlySet<string> = new Set(["unauthenticated", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "not_available", "internal"]);

/**
 * A `KnowledgeWriter` over the reconciler's wire contract. The bridge's
 * envelope passes through as-is except `unauthenticated`, which is a
 * deployment fault (the console's bridge token), not the agent's: it
 * surfaces as `not_available`. On 409 the current hash is fetched with one
 * read so the caller can re-read-and-retry.
 */
export function vaultBridgeWriter(opts: VaultBridgeOptions): KnowledgeWriter {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  const headers = { authorization: `Bearer ${opts.token}` };

  const parse = async (r: Response): Promise<Record<string, unknown>> => {
    try {
      const v = (await r.json()) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const codeOf = (status: number, body: Record<string, unknown>): ErrorCode => {
    const err = body.error as { code?: unknown } | undefined;
    if (err && typeof err.code === "string" && ERROR_CODES.has(err.code)) return err.code as ErrorCode;
    return status >= 500 ? "not_available" : "internal";
  };

  return async (req) => {
    const r = await doFetch(`${base}/vault/write`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ path: req.path, content: req.content, intent: req.intent, ...(req.expected_sha256 !== undefined ? { expected_sha256: req.expected_sha256 } : {}) }),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await parse(r);
    if (r.ok) {
      return { ok: true, path: String(body.path ?? req.path), sha256: String(body.sha256 ?? ""), bytes: Number(body.bytes ?? 0), created: body.created === true };
    }
    const code = codeOf(r.status, body);
    const message = typeof (body.error as { message?: unknown } | undefined)?.message === "string" ? ((body.error as { message: string }).message) : undefined;
    if (code === "unauthenticated") return { ok: false, code: "not_available", message: "the vault bridge rejected this deployment's credential (METISTRY_BRIDGE_TOKEN_RECONCILER)" };
    if (code !== "conflict") return { ok: false, code, message };
    // conflict: one read for the hash now on disk (null = the note is gone)
    let current: string | null = null;
    try {
      const rr = await doFetch(`${base}/vault/read?path=${encodeURIComponent(req.path)}`, { headers, signal: AbortSignal.timeout(timeout) });
      if (rr.ok) {
        const rb = await parse(rr);
        current = typeof rb.sha256 === "string" ? rb.sha256 : null;
      }
    } catch {
      current = null;
    }
    return { ok: false, code: "conflict", current_sha256: current };
  };
}

// --- provenance ---------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EMPTY_FRONTMATTER_RE = /^---\r?\n---(?:\r?\n|$)/;
const PROVENANCE_KEYS = ["source", "updated"] as const;

export type StampOutcome = { ok: true; content: string; source: string; updated: string } | { ok: false; message: string };

/**
 * Ensure a markdown note carries `source: <agent id>` and `updated: <date>`
 * (§4.15 provenance). No frontmatter → a block with exactly those two keys
 * is prepended. Existing frontmatter → those two keys are set (replaced if
 * present, appended if not) line by line, so every other line — fields,
 * comments, order — survives byte for byte. Nothing else is ever invented.
 * The block must be a YAML mapping; anything else is refused rather than
 * guessed at.
 */
export function stampProvenance(content: string, agentId: string, now: Date = new Date()): StampOutcome {
  const updated = now.toISOString().slice(0, 10);
  const stamp = { source: agentId, updated };
  const lineFor = (k: (typeof PROVENANCE_KEYS)[number]) => `${k}: ${stamp[k]}`;

  const empty = EMPTY_FRONTMATTER_RE.exec(content);
  const m = empty ? null : FRONTMATTER_RE.exec(content);
  if (!empty && !m) {
    return { ok: true, content: `---\n${lineFor("source")}\n${lineFor("updated")}\n---\n${content}`, ...stamp };
  }
  const block = m ? m[1]! : "";
  const body = content.slice((empty ?? m)![0].length);

  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return { ok: false, message: "frontmatter is not valid YAML" };
  }
  if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
    return { ok: false, message: "frontmatter must be a YAML mapping" };
  }

  const lines = block === "" ? [] : block.split(/\r?\n/);
  for (const k of PROVENANCE_KEYS) {
    const re = new RegExp(`^${k}\\s*:`);
    const i = lines.findIndex((l) => re.test(l));
    if (i === -1) lines.push(lineFor(k));
    else lines[i] = lineFor(k);
  }
  const merged = lines.join("\n");
  // Verify the merge by re-parsing: a multi-line value under one of the
  // keys would have left orphan lines behind — refuse, never guess.
  let check: unknown;
  try {
    check = parseYaml(merged);
  } catch {
    check = null;
  }
  const c = (check ?? {}) as Record<string, unknown>;
  if (typeof check !== "object" || Array.isArray(check) || c.source !== agentId || String(c.updated instanceof Date ? c.updated.toISOString().slice(0, 10) : c.updated) !== updated) {
    return { ok: false, message: "frontmatter `source` / `updated` must be single-line scalars (they are stamped from your credential and today's date)" };
  }
  return { ok: true, content: `---\n${merged}\n---\n${body}`, ...stamp };
}

// --- ownership -------------------------------------------------------------

/** The evening fold's own source name (routines/knowledge-fold) — a note it owns is writable by the assistant. */
export const FOLD_SOURCE = "knowledge-fold";

/**
 * The implicit owner of a note whose frontmatter carries no `source:` at
 * all. A hand-written note — Obsidian, an editor, another device — never has
 * one; there is no third party who could have written it, so absence means
 * the user, not "nobody" (2026-09-19, closing the hole the daily-flow
 * research named: `knowledge_write` is a whole-file replace, and the
 * original rule read "no source" as "free to write", which let a model turn
 * silently re-emit a note you wrote by hand).
 */
export const USER_SOURCE = "user";

/**
 * `now.md` ships from `seed/vault/now.md` with `source: assistant` in its
 * frontmatter (stamped in the same change that inverted the default below),
 * so a freshly-initialized instance never hits this. It exists for
 * instances that predate that seed change: their `now.md` has no
 * frontmatter yet, and the assistant is REQUIRED to keep writing it every
 * day (the morning brief, the evening fold's "last fold" line, …) — refusing
 * it here would lock the assistant out of the one note it cannot stop
 * writing. There is no vault-file instance migration to stamp it once at
 * `metistry update` time instead: `instance-migrations/` is SQL for a local
 * extension's own Postgres tables (packages/cli/src/migrate-inbox.ts's own
 * comment: "there is no repo-layout step in `metistry update`, and inventing
 * one for a single move would be a mechanism nothing else uses"), so the
 * exemption lives here, by exact name at the vault root, instead. It only
 * ever fires once per instance: `writeKnowledge` stamps `source: assistant`
 * on every markdown write it lands, so the very first successful write
 * gives `now.md` real provenance and ordinary ownership rules apply to it
 * from then on.
 */
export const BOOTSTRAP_EXEMPT_PATH = "now.md";

/** The `source` in a note's frontmatter, or null when there is none (or it is not a scalar string). */
export function frontmatterSource(content: string): string | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1]!);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = (parsed as Record<string, unknown>).source;
  return typeof src === "string" && src.trim() ? src.trim() : null;
}

/**
 * One writer, but not one owner (§4.11 + the fold's three rules): the
 * assistant may update a note it wrote (`source` = its own credential id) or
 * one the fold owns, and NEW notes are always fine — but a note whose
 * `source` is someone else's, INCLUDING no `source:` at all (`USER_SOURCE`:
 * that is the user's default, not an opening), is theirs, and the assistant
 * must `report` a change rather than make it. `path` is read only to apply
 * the narrow `now.md` bootstrap exemption above; ownership itself is always
 * read from `existing` — the file already on disk — never from anything the
 * caller supplies, so a crafted frontmatter in the INCOMING content can
 * never claim a note it does not already own. Enforced here rather than in
 * the prompt: "don't edit the user's notes" in a prompt is not a control
 * (CLAUDE.md).
 */
export function ownershipRefusal(existing: string, callerId: string, path?: string): string | null {
  const owner = frontmatterSource(existing);
  if (owner === null && path === BOOTSTRAP_EXEMPT_PATH) return null;
  const effectiveOwner = owner ?? USER_SOURCE;
  if (effectiveOwner === callerId || effectiveOwner === FOLD_SOURCE) return null;
  return `owned by ${effectiveOwner}; propose instead`;
}

// --- the tool body ---------------------------------------------------------

export interface KnowledgeWriteArgs {
  path: string;
  content: string;
  message: string;
  expected_sha256?: string | undefined;
}

export type KnowledgeWriteOutcome =
  | { ok: true; result: { path: string; sha256: string; bytes: number; created: boolean; queued: true; provenance: { source: string; updated: string } | null; /** A routine file's slots this write filled (C103). */ filled?: number[] }; meta: Record<string, unknown> }
  | { ok: false; code: ErrorCode; message?: string | undefined; meta: Record<string, unknown> };

export const MAX_WRITE_BYTES = 2 * 1024 * 1024; // limit: fixed — mirrors the bridge's own default cap, which enforces it; ours cannot be larger

/** Hex sha256 of UTF-8 text — the same hash the bridge reports for the bytes it stores. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `knowledge_write` for one principal. The commit is keyed by the act: the
 * reply's turn id when the call carried one (so every note one reply writes
 * is one commit, and two replies in one flush window are two), else the
 * call's own `runs` row (one write, one commit). No `group` is sent — a
 * per-agent group would fold every reply in a window into one commit.
 * Returns the tool wrapper's outcome shape.
 */
export async function writeKnowledge(
  principal: AgentPrincipal,
  args: KnowledgeWriteArgs,
  writer: KnowledgeWriter | undefined,
  now: Date = new Date(),
  /** Vault read path (`cfg.readKnowledge`). Present → the ownership rule is enforced; a read that FAILS refuses the write (never waved through). Absent (no read path in this deployment) → only the vault's own protected-path rules apply. */
  reader?: KnowledgeReader | undefined,
  /** The call's turn and run (server.ts `wrap`); absent → the write is its own commit. */
  act: WriteAct = {},
): Promise<KnowledgeWriteOutcome> {
  const { tier, areas } = principal.grants;
  const meta: Record<string, unknown> = { kind: principal.kind ?? "external", tier, areas, path: args.path };
  const p = principalOf(principal);
  // §4.11: one writer. The role gate first, because a principal that may not
  // write at all should not be told which of its paths were the problem.
  const admitted = may(p, "act", { kind: "tool", name: "knowledge_write" });
  if (!admitted.ok) return { ok: false, code: admitted.code, meta };
  // Not vault content: the CLASSIFICATION answer, in the same words every
  // other knowledge door gives it (core's `notKnowledge` — §3.3). A statement
  // about the path, not about this principal's grant, which is why it is
  // `invalid_request` and why the writer gets the same sentence a reader does.
  if (!validKnowledgePath(args.path)) {
    const nk = notKnowledge(args.path);
    return { ok: false, code: nk.code, message: nk.message, meta };
  }
  // A §4.7 protected path is the user's hand (invariant 2). The reconciler
  // refuses it too — this is the same rule stated at the tool the assistant
  // actually holds, so the refusal never depends on the bridge being reached.
  // `.metistry/**` is already out by shape; the root CLAUDE.md and README.md
  // are ordinary-looking vault paths and would not be.
  if (isProtectedPath(args.path)) return { ok: false, code: "invalid_request", message: "that path defines how the system behaves — it is the user's hand alone (§4.7)", meta };
  // Writes never exceed reads. Asked AFTER the two shape refusals above, so
  // a path that is not vault content keeps its `invalid_request` rather than
  // becoming a scope refusal. Most of this door's refusals HIDE (message
  // `""`, the canonical "not granted"), but `Me/` and the user's own journal
  // SPEAK (`isUserOwnedPath`, core) — no grant will ever unlock them, so the
  // one useful thing to say is "propose it instead" — and a refusal that
  // speaks is worth nothing if the sentence is dropped on the way out
  // (mirrors mcp-brain's own `refuse()` in outcome.ts).
  const scoped = may(p, "write", { kind: "knowledge", door: "write", path: args.path });
  if (!scoped.ok) return { ok: false, code: scoped.code, message: scoped.message === "" ? undefined : scoped.message, meta };
  if (!writer) {
    return { ok: false, code: "not_available", message: "knowledge writes are not configured in this deployment (the vault bridge is absent)", meta };
  }

  // A routine's own folder: an existing file there is the routine's, and the
  // assistant's one turn may only fill its pending prose slots (or be
  // refused) — never touch anything else about it. A path with no file
  // there YET is an ordinary create (ruling 9 above), so it falls through to
  // the general path below exactly like any other new note; the read here
  // is what tells the two cases apart, and it is done once, whichever path
  // it feeds.
  const routine = journalRoutineOf(args.path);
  let existing: string | null = null;
  if (routine !== null || /\.md$/i.test(args.path)) {
    if (!reader) {
      if (routine !== null) return { ok: false, code: "not_available", message: "the vault read path is absent, so a routine's folder cannot be checked — nothing was written", meta };
    } else {
      try {
        existing = await reader(args.path);
      } catch {
        return { ok: false, code: "not_available", message: "could not read the note to check who owns it — try again", meta };
      }
    }
  }
  if (routine !== null && existing !== null) return writeRoutineProse(args, routine, writer, existing, act, meta);

  // Ownership (see ownershipRefusal): new notes are free; an existing note
  // belongs to whoever's `source` it carries, and no `source:` at all means
  // the user (USER_SOURCE) — never the caller.
  if (reader && /\.md$/i.test(args.path)) {
    const refusal = existing === null ? null : ownershipRefusal(existing, principal.id, args.path);
    if (refusal) return { ok: false, code: "forbidden", message: refusal, meta: { ...meta, owned_by: frontmatterSource(existing!) ?? USER_SOURCE } };
  }

  let content = args.content;
  let provenance: { source: string; updated: string } | null = null;
  if (/\.md$/i.test(args.path)) {
    const s = stampProvenance(content, principal.id, now);
    if (!s.ok) return { ok: false, code: "invalid_request", message: s.message, meta };
    content = s.content;
    provenance = { source: s.source, updated: s.updated };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) return { ok: false, code: "invalid_request", message: `content exceeds ${MAX_WRITE_BYTES} bytes`, meta };

  // Omitted = create only. There is no unconditional write: whatever is on
  // disk was put there by someone, and "whatever is there" is not something
  // an agent can consent to on the user's behalf.
  const createOnly = args.expected_sha256 === undefined;
  const out = await writer({
    path: args.path,
    content,
    intent: {
      principal: principal.id,
      message: args.message,
      ...(act.runId !== undefined ? { run: String(act.runId) } : {}),
      ...(act.turnId !== undefined ? { turn: act.turnId } : {}),
    },
    expected_sha256: args.expected_sha256 ?? "",
  });
  if (!out.ok) {
    if (out.code === "conflict") {
      const current = out.current_sha256 ?? null;
      return {
        ok: false,
        code: "conflict",
        message: current
          ? createOnly
            ? `that note already exists (current sha256 ${current}) — knowledge_read it, fold your change into what is there, and write it back with expected_sha256. Omitting expected_sha256 means "create only", so nobody's edit is ever overwritten unseen`
            : `the note changed since you read it (current sha256 ${current}) — knowledge_read it again and retry with expected_sha256`
          : "the note no longer exists — knowledge_read it again and retry",
        meta: { ...meta, current_sha256: current, ...(createOnly ? { create_only: true } : {}) },
      };
    }
    return { ok: false, code: out.code, message: out.message, meta };
  }
  return {
    ok: true,
    result: { path: out.path, sha256: out.sha256, bytes: out.bytes, created: out.created, queued: true, provenance },
    meta: { ...meta, sha256: out.sha256, bytes: out.bytes, created: out.created, ...(provenance ? { provenance } : {}) },
  };
}

/**
 * `knowledge_write` into a routine's own folder (`JOURNAL_ROUTINE_DIRS`), for
 * a path where the routine has already written a file — the caller
 * (`writeKnowledge`) has read it and it is not null; a path with no file yet
 * never reaches here (ruling 9: that is an ordinary create, handled by the
 * general path instead). The file is the routine's — written under its
 * principal, `source:` its name (owner ruling (a), W1) — and the
 * assistant's one turn may fill each pending `prose` slot's line in it
 * (C103) and change nothing else. Refused:
 *
 *   - a folder whose routine renders no prose (`Journal/Plan/` —
 *     Tomorrow's Plan is model-free): `forbidden`;
 *   - a file whose `source` is not the folder's routine (the owner's own
 *     note, say): `forbidden`, owned by whoever it names;
 *   - a hash that is not the file's as it is now: `conflict`, with the hash;
 *   - content that differs from the file anywhere but a pending slot's line,
 *     or a slot line that is not one line of prose (`fillProseSlots`):
 *     `invalid_request`, saying which line and why.
 *
 * What is written is `fillProseSlots`' output — the file on disk with the
 * checked lines in place — never the incoming content as sent; so there is
 * no provenance stamp to add and `source` cannot change. The commit is the
 * routine's, carrying this reply's turn.
 */
async function writeRoutineProse(
  args: KnowledgeWriteArgs,
  routine: string,
  writer: KnowledgeWriter,
  existing: string,
  act: WriteAct,
  meta: Record<string, unknown>,
): Promise<KnowledgeWriteOutcome> {
  const folder = args.path.split("/").slice(0, 2).join("/");
  const m = { ...meta, routine_file: routine };
  if (!PROSE_SOURCES.includes(routine)) {
    return { ok: false, code: "forbidden", message: `${folder}/ is the ${routine} routine's own folder, and nothing else writes it — report instead`, meta: m };
  }
  const owner = frontmatterSource(existing) ?? USER_SOURCE;
  if (owner !== routine) return { ok: false, code: "forbidden", message: `owned by ${owner}; propose instead`, meta: { ...m, owned_by: owner } };
  const current = sha256Text(existing);
  if (args.expected_sha256 !== current) {
    return { ok: false, code: "conflict", message: `knowledge_read ${args.path} and fill its slots in what is there now (current sha256 ${current}), passing that sha256 back as expected_sha256`, meta: { ...m, current_sha256: current } };
  }
  const fill = fillProseSlots(existing, args.content);
  if (!fill.ok) return { ok: false, code: "invalid_request", message: `${fill.message}. Nothing was written.`, meta: m };
  if (Buffer.byteLength(fill.content, "utf8") > MAX_WRITE_BYTES) return { ok: false, code: "invalid_request", message: `content exceeds ${MAX_WRITE_BYTES} bytes`, meta: m };

  const out = await writer({
    path: args.path,
    content: fill.content,
    // The routine's name, not the caller's: the folder is the routine's
    // (ruling (a)); the turn trailer says which reply wrote the words.
    intent: {
      principal: routine,
      message: args.message,
      ...(act.runId !== undefined ? { run: String(act.runId) } : {}),
      ...(act.turnId !== undefined ? { turn: act.turnId } : {}),
    },
    expected_sha256: current,
  });
  if (!out.ok) {
    if (out.code === "conflict") {
      const now = out.current_sha256 ?? null;
      return { ok: false, code: "conflict", message: now ? `the file changed since you read it (current sha256 ${now}) — knowledge_read it again and redo the slots` : "the file no longer exists", meta: { ...m, current_sha256: now } };
    }
    return { ok: false, code: out.code, message: out.message, meta: m };
  }
  return {
    ok: true,
    result: { path: out.path, sha256: out.sha256, bytes: out.bytes, created: out.created, queued: true, provenance: null, filled: fill.filled },
    meta: { ...m, sha256: out.sha256, bytes: out.bytes, filled: fill.filled },
  };
}
