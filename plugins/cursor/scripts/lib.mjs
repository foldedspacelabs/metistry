// Shared capture logic for the Cursor plugin (plan refresh §4b W4). Sibling of
// `plugins/claude-code/scripts/lib.mjs`, and deliberately not a copy of it:
// Cursor's `sessionEnd` payload is not a Claude Code transcript, so the
// *summariser* has nothing in common. What must not drift is the part the
// server sees — the note's frontmatter, the body's shape, and the
// `idempotency_key` formula — so those functions are transcribed from
// `packages/core/src/session-summary.ts` with core's own defaults, and
// `test/session-parity.test.ts` renders a real core summary through both and
// fails the build the moment a byte differs.
//
// Dependency-free Node 22+ (global fetch, node:crypto, node:fs, node:os): a
// hook runs straight out of a checkout, so it cannot import a built workspace
// package. The two plugins are locked to each other transitively — each is
// held to core, core is one file.
//
// The server contract is `POST /capture` with `{ note, filename }`
// (apps/console/src/server.ts); `/capture` has no metadata field, so
// provenance rides in the note's frontmatter.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const SOURCE = "cursor";
/** How the tool names itself — the title and the version fact, never a path or a table name (CLAUDE.md). */
export const LABEL = "Cursor";
export const MAX_FILES = 40;
export const ERROR_CHARS = 500;

/**
 * Read config from the environment only — never from files.
 *
 * `METISTRY_AGENT_TOKEN_CURSOR` is the variable `metistry connect cursor`
 * already puts in the login Keychain and has you export (docs/ops/cursor.md),
 * so the hook needs no second secret. An owner token still works for a machine
 * that has not run `connect`.
 */
export function config(env = process.env) {
  return {
    url: (env.METISTRY_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.METISTRY_AGENT_TOKEN_CURSOR ?? env.METISTRY_OWNER_TOKEN ?? "").trim(),
    /** SHOULD-10: a capture that cannot reach the console is written here rather than dropped. */
    captureDir: (env.METISTRY_CAPTURE_DIR ?? "").trim(),
  };
}

/** Every string this plugin prints passes through here. */
export function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

export function clip(s, n) {
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Transcribed from packages/core/src/session-summary.ts. */
export function repoNameFromPath(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const dot = parts.indexOf(".claude");
  if (dot > 0) return parts[dot - 1];
  return parts[parts.length - 1];
}

/** Transcribed from packages/core/src/session-summary.ts. */
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "unknown";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * The dedupe key for one session summary — the same formula core uses, so a
 * Cursor session and a Claude Code session are the same kind of row to the
 * server and `inbox-drain` classifies both on `kind: session`.
 *
 * For a Cursor session every field but the id is constant (see
 * `summarizeSessionEnd`: the payload carries no timestamps and no turn
 * counts), so the key is a pure function of `session_id` — which is what makes
 * a retry after the local-file fallback an exact no-op rather than a second
 * note.
 */
export function idempotencyKey(summary, source = "claude-code") {
  const material = [summary.sessionId ?? "", summary.ended ?? "", String(summary.turns), String(summary.assistantMessages)].join("\n");
  return `${source}:${summary.sessionId ?? "unknown"}:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

// The `label` and `source` defaults below are CORE's, not Cursor's. That is
// deliberate and is the whole parity mechanism: called with nothing supplied
// these three functions must be byte-identical to core's, and the hook always
// supplies `{ source: SOURCE, label: LABEL }`.

export function sessionTitle(summary, label = "Claude Code", nowIso = new Date().toISOString()) {
  const where = summary.repo ?? "session";
  const day = (summary.started ?? summary.ended ?? nowIso).slice(0, 10);
  return `${label} session — ${where} — ${day}`;
}

/** The markdown body. Deterministic: same summary in, same bytes out. */
export function renderSessionBody(summary, label = "Claude Code") {
  const facts = [];
  // Cursor's payload has no turn counts, so the line is omitted rather than
  // reported as zero. Core always sets numbers, so core renders it as before.
  if (summary.turns !== null && summary.turns !== undefined && summary.assistantMessages !== null && summary.assistantMessages !== undefined) {
    facts.push(`- Turns: ${summary.turns} user, ${summary.assistantMessages} assistant`);
  }
  facts.push(`- Duration: ${formatDuration(summary.durationMs)}`);
  if (summary.project) facts.push(`- Project: \`${summary.project}\`${summary.branch ? ` (branch \`${summary.branch}\`)` : ""}`);
  if (summary.models.length) facts.push(`- Models: ${summary.models.join(", ")}`);
  if (summary.costUsd !== null && summary.costUsd !== undefined) facts.push(`- Cost: $${summary.costUsd.toFixed(4)}`);
  if (summary.inputTokens || summary.outputTokens) facts.push(`- Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out`);
  if (summary.version) facts.push(`- ${label}: ${summary.version}`);
  // Everything below is Cursor-only and is appended AFTER the shared facts, so
  // a core-shaped summary (which carries none of it) renders identically.
  if (summary.reason) facts.push(`- Ended: ${summary.reason}${summary.finalStatus ? ` (${summary.finalStatus})` : ""}`);
  if (summary.backgroundAgent) facts.push("- Background agent: yes");
  if (summary.errorMessage) facts.push(`- Error: ${clip(summary.errorMessage, ERROR_CHARS)}`);

  const parts = ["## Session", "", ...facts, ""];
  if (summary.tools.length) parts.push("## Tools", "", summary.tools.map((t) => `- ${t.name} × ${t.count}`).join("\n"), "");
  if (summary.files.length) {
    parts.push(
      "## Files touched",
      "",
      summary.files.map((f) => `- \`${f}\``).join("\n") + (summary.filesTruncated ? `\n- …more (capped at ${MAX_FILES})` : ""),
      "",
    );
  }
  if (summary.firstPrompt) parts.push("## First prompt", "", summary.firstPrompt, "");
  if (summary.lastAssistant) parts.push("## Last response", "", summary.lastAssistant, "");
  if (summary.notCaptured) parts.push("## Not captured", "", summary.notCaptured, "");
  return parts.join("\n").trimEnd();
}

/**
 * The frontmatter both doors emit (docs/ops/cli.md). Keys, order and types are
 * core's — a Cursor note is the same row to `inbox-drain` as a Claude Code
 * one. Everything Cursor-specific is a fact in the body, never a new key.
 *
 * JSON string literals are valid YAML double-quoted scalars, so this needs no
 * YAML dependency. `turns` is interpolated raw (a number, or `null` when
 * Cursor did not say) because core writes it raw.
 */
export function renderSessionNote(summary, extra = {}) {
  const source = extra.source ?? "claude-code";
  const label = extra.label ?? "Claude Code";
  const capturedAt = extra.capturedAt ?? new Date().toISOString();
  const y = (v) => (v === null || v === undefined || v === "" ? "null" : JSON.stringify(String(v)));
  const title = sessionTitle(summary, label, capturedAt);
  return [
    "---",
    `kind: "session"`,
    `source: ${y(source)}`,
    `title: ${y(title)}`,
    `session_id: ${y(summary.sessionId)}`,
    `project: ${y(summary.project)}`,
    `repo: ${y(summary.repo)}`,
    `branch: ${y(summary.branch)}`,
    `started: ${y(summary.started)}`,
    `ended: ${y(summary.ended)}`,
    `turns: ${summary.turns}`,
    `host: ${y(extra.host ?? null)}`,
    `captured_at: ${y(capturedAt)}`,
    `idempotency_key: ${y(extra.key ?? idempotencyKey(summary, source))}`,
    "---",
    "",
    `# ${title}`,
    "",
    renderSessionBody(summary, label),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cursor's sessionEnd payload → a summary
// ---------------------------------------------------------------------------

/**
 * What this note does NOT contain, said in the note itself rather than only in
 * the docs. Verified against cursor.com/docs/hooks (fetched 2026-09-15): the
 * `sessionEnd` input is `session_id`, `reason`, `duration_ms`,
 * `is_background_agent`, `final_status`, `error_message` plus the common
 * fields, and `transcript_path` is documented only as "Path to the main
 * conversation transcript file" — the file's FORMAT is undocumented. A format
 * is never guessed here, so nothing is read from it.
 */
export const NOT_CAPTURED =
  "Cursor's `sessionEnd` payload carries no conversation content, and the format of the file at " +
  "`transcript_path` is undocumented (cursor.com/docs/hooks, checked 2026-09-15), so this note records " +
  "the event's own fields and infers nothing: no turn counts, prompts, tools or files touched.";

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * Build a session summary from one `sessionEnd` payload. Every field is
 * guarded — a capture door must never throw, and a newer Cursor may stop
 * sending any of these.
 *
 * `started`/`ended` stay null on purpose: the payload carries a `duration_ms`
 * and no timestamps, and putting the wall clock in `ended` would make
 * `idempotencyKey` different on every invocation. The wall clock is in
 * `captured_at`, which is within a second of the end; the duration is a fact
 * in the body.
 */
export function summarizeSessionEnd(input, { env = process.env } = {}) {
  if (!input || typeof input !== "object") return null;
  // `session_id` is documented as "same as conversation_id"; take either, and
  // capture nothing without one — a note with no stable key is a duplicate
  // waiting to happen.
  const sessionId = str(input.session_id) ?? str(input.conversation_id);
  if (!sessionId) return null;

  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots.filter((r) => typeof r === "string" && r.trim() !== "") : [];
  // `sessionEnd` sends no `cwd`; `workspace_roots[0]` is the workspace, and
  // CURSOR_PROJECT_DIR is the same value in the environment (docs/hooks).
  const project = roots[0] ?? str(env.CURSOR_PROJECT_DIR);
  const durationMs = typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms) && input.duration_ms >= 0 ? input.duration_ms : null;
  const model = str(input.model_id) ?? str(input.model);

  return {
    sessionId,
    project,
    repo: repoNameFromPath(project),
    branch: null,
    started: null,
    ended: null,
    durationMs,
    turns: null,
    assistantMessages: null,
    firstPrompt: "",
    lastAssistant: "",
    files: [],
    filesTruncated: false,
    tools: [],
    models: model ? [model] : [],
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    version: str(input.cursor_version) ?? str(env.CURSOR_VERSION),
    reason: str(input.reason),
    finalStatus: str(input.final_status),
    backgroundAgent: input.is_background_agent === true,
    errorMessage: str(input.error_message),
    notCaptured: NOT_CAPTURED,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** The one wire call: `POST /capture` with `{ note, filename }`, bearer auth, redacted errors. */
export async function postCapture({ note, filename, key, env = process.env, timeoutMs = 8_000, fetchFn = fetch }) {
  const { url, token } = config(env);
  if (!url) throw new Error("METISTRY_URL is not set");
  if (!token) throw new Error("neither METISTRY_AGENT_TOKEN_CURSOR nor METISTRY_OWNER_TOKEN is set");

  let res;
  try {
    res = await fetchFn(`${url}/capture`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // The console replays the first row for a repeated key instead of
        // making a second one (apps/console/src/server.ts). Ours is stable per
        // session, so the retry after a local-file fallback is a no-op.
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify({ note, filename }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(redact(`capture unreachable: ${err?.cause?.message ?? err?.message ?? err}`, token));
  }
  const text = await res.text();
  if (res.status !== 201) throw new Error(redact(`capture failed: HTTP ${res.status} ${text.slice(0, 200)}`, token));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(redact(`capture failed: unparseable response ${text.slice(0, 200)}`, token));
  }
}

/**
 * SHOULD-10's local-file fallback: one silent drop ends the trust. A leading
 * `~/` is expanded because this variable is usually set in a shell profile
 * that has already expanded nothing.
 */
export function writeCaptureFile(dir, filename, note, home = homedir()) {
  const base = dir.startsWith("~/") || dir === "~" ? join(home, dir.slice(1)) : dir;
  const target = resolve(isAbsolute(base) ? base : resolve(base), filename);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, note, { mode: 0o600 });
  return target;
}

/**
 * Post one session summary, or write it to `METISTRY_CAPTURE_DIR` when the
 * console cannot be reached. Resolves `{ delivered: "console" | "file", … }`
 * and throws only when there is nowhere at all to put it.
 */
export async function captureSession({ summary, source = SOURCE, label = LABEL, env = process.env, now = new Date(), timeoutMs = 8_000, fetchFn = fetch, home = homedir() }) {
  const key = idempotencyKey(summary, source);
  const capturedAt = now.toISOString();
  const note = renderSessionNote(summary, { source, label, host: hostname(), capturedAt, key });
  const stamp = capturedAt.replaceAll(/[-:]/g, "").replace(/\.\d+Z?$/, "Z");
  const filename = `${source}-session-${stamp}-${String(summary.sessionId ?? "unknown").slice(0, 8)}.md`;

  try {
    const r = await postCapture({ note, filename, key, env, timeoutMs, fetchFn });
    return { delivered: "console", filename, ...r };
  } catch (err) {
    const { captureDir, token } = config(env);
    if (!captureDir) throw err;
    const path = writeCaptureFile(captureDir, filename, note, home);
    return { delivered: "file", filename, path, reason: redact(err?.message ?? err, token) };
  }
}
