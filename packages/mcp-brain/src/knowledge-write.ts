// The assistant's write path — `brain-commit` (§4.7 layer 1, D5): a thin
// call to the reconciler's `POST /vault/write` with a commit intent. The
// engine still has no shell and no git (invariant 9); this is its ENTIRE
// mutating surface into the vault.
//
// Rules enforced here, not by prompting:
// - only a principal of kind `internal` may write (§4.11: sub-agents and
//   external agents never write knowledge — they `report`); anyone else
//   gets the uniform `forbidden` envelope, whatever the path;
// - the path must be `Knowledge/...` (the §4.7 free zone) AND inside the
//   principal's read grant — writes never reach wider than reads;
// - the bridge's own rules stay in force behind this one (protected paths
//   are the user's hand; traversal, `.git`, symlinks, casing slips refused);
// - a markdown write is stamped with provenance (§4.15): `source` is the
//   credential's id — never an argument — and `updated` is today;
// - compare-and-swap passes through: a 409 comes back as `conflict`
//   carrying the current hash so the agent can re-read instead of clobber.
//
// Deletes and renames are NOT exposed: they stay the user's hand for now.

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { ErrorCode } from "@foldedspacelabs/metistry-core";
import { underAreas, validKnowledgePath } from "./knowledge.js";
import type { AgentPrincipal } from "./types.js";

/** The reconciler's commit intent (apps/reconciler `parseIntent`). */
export interface VaultWriteIntent {
  principal: string;
  message: string;
  group?: string | undefined;
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

// --- the tool body ---------------------------------------------------------

export interface KnowledgeWriteArgs {
  path: string;
  content: string;
  message: string;
  expected_sha256?: string | undefined;
}

export type KnowledgeWriteOutcome =
  | { ok: true; result: { path: string; sha256: string; bytes: number; created: boolean; queued: true; provenance: { source: string; updated: string } | null }; meta: Record<string, unknown> }
  | { ok: false; code: ErrorCode; message?: string | undefined; meta: Record<string, unknown> };

export const MAX_WRITE_BYTES = 2 * 1024 * 1024; // the bridge's default cap; it enforces its own

/** Hex sha256 of UTF-8 text — the same hash the bridge reports for the bytes it stores. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `knowledge_write` for one principal. `group` is the commit-batch key
 * (`<agent id>` — a turn/run id is not on the wire, so a flush window
 * yields one commit per agent). Returns the tool wrapper's outcome shape.
 */
export async function writeKnowledge(
  principal: AgentPrincipal,
  args: KnowledgeWriteArgs,
  writer: KnowledgeWriter | undefined,
  now: Date = new Date(),
): Promise<KnowledgeWriteOutcome> {
  const { tier, areas } = principal.grants;
  const meta: Record<string, unknown> = { kind: principal.kind ?? "external", tier, areas, path: args.path };
  if (principal.kind !== "internal") return { ok: false, code: "forbidden", meta }; // §4.11: one writer
  if (!validKnowledgePath(args.path)) return { ok: false, code: "invalid_request", message: "path must be Knowledge/... with no traversal", meta };
  if (tier !== "areas" || !underAreas(args.path, areas)) return { ok: false, code: "forbidden", meta }; // writes never exceed reads
  if (!writer) {
    return { ok: false, code: "not_available", message: "knowledge writes are not configured in this deployment (the vault bridge is absent)", meta };
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

  const out = await writer({
    path: args.path,
    content,
    intent: { principal: principal.id, message: args.message, group: principal.id },
    ...(args.expected_sha256 !== undefined ? { expected_sha256: args.expected_sha256 } : {}),
  });
  if (!out.ok) {
    if (out.code === "conflict") {
      const current = out.current_sha256 ?? null;
      return {
        ok: false,
        code: "conflict",
        message: current
          ? `the note changed since you read it (current sha256 ${current}) — knowledge_read it again and retry with expected_sha256`
          : "the note no longer exists — knowledge_read it again and retry",
        meta: { ...meta, current_sha256: current },
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
