// Shared capture logic for the Claude Code plugin (plan §4.11, external
// capture). Dependency-free Node 22+: global fetch, node:os, node:fs.
//
// The server contract is POST /capture with a JSON body of
// { note, filename } (apps/console/src/server.ts). /capture has no
// metadata field, so provenance rides in the note's frontmatter — the same
// place §4.15 puts it once a proposal is accepted into Knowledge/.

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export const SOURCE = "claude-code";
export const KINDS = ["decision", "finding", "note", "session-summary"];

/** Read config from the environment only — never from files (README). */
export function config(env = process.env) {
  return {
    url: (env.METISTRY_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.METISTRY_OWNER_TOKEN ?? "").trim(),
  };
}

/** Every string the plugin prints passes through here. */
export function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

/** Name of the enclosing git checkout (walks up to the nearest .git). */
export function repoName(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) return basename(cwd) || null;
    dir = parent;
  }
}

export function provenance({ sessionId, cwd = process.cwd(), env = process.env, now = new Date() } = {}) {
  return {
    source: SOURCE,
    session_id: sessionId ?? env.CLAUDE_SESSION_ID ?? null,
    host: hostname(),
    cwd,
    repo: repoName(cwd),
    captured_at: now.toISOString(),
  };
}

// JSON string literals are valid YAML double-quoted scalars, so this yields
// well-formed frontmatter without a YAML dependency.
const yaml = (v) => (v === null || v === undefined ? "null" : JSON.stringify(String(v)));

export function renderNote({ kind, title, body, prov }) {
  return [
    "---",
    `source: ${yaml(prov.source)}`,
    `kind: ${yaml(kind)}`,
    `title: ${yaml(title)}`,
    `session_id: ${yaml(prov.session_id)}`,
    `host: ${yaml(prov.host)}`,
    `repo: ${yaml(prov.repo)}`,
    `cwd: ${yaml(prov.cwd)}`,
    `captured_at: ${yaml(prov.captured_at)}`,
    "---",
    "",
    `# ${title}`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

/**
 * POST one capture. Resolves to the server's { id, path, sha256 }; throws
 * with an already-redacted message on any failure.
 */
export async function capture({ kind, title, body, sessionId, cwd = process.cwd(), env = process.env, timeoutMs = 15_000 }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join("|")}`);
  if (!title?.trim()) throw new Error("title is required");
  const prov = provenance({ sessionId, cwd, env });
  const note = renderNote({ kind, title: title.trim(), body: body ?? "", prov });
  const stamp = prov.captured_at.replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return await postCapture({ note, filename: `${SOURCE}-${kind}-${stamp}.md`, env, timeoutMs });
}

/** The one wire call: `POST /capture` with `{ note, filename }`, bearer auth, redacted errors. */
export async function postCapture({ note, filename, env = process.env, timeoutMs = 15_000 }) {
  const { url, token } = config(env);
  if (!url) throw new Error("METISTRY_URL is not set");
  if (!token) throw new Error("METISTRY_OWNER_TOKEN is not set");

  let res;
  try {
    res = await fetch(`${url}/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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

// ---------------------------------------------------------------------------
// Session summaries (stash review item 2, 2026-09-09).
//
// This is a deliberate, tested duplicate of
// `packages/core/src/session-summary.ts`. The plugin ships as dependency-free
// `.mjs` that a stranger runs straight out of `~/.claude/plugins` — it cannot
// import a built workspace package — so the logic lives twice and
// `test/session-parity.test.ts` fails the build if the two ever disagree on
// the shared fixture. `metistry import-sessions` uses core's copy; this hook
// uses this one; both emit the same frontmatter and the same
// idempotency_key, so the server can dedupe across the two doors.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

const PATH_KEYS = ["file_path", "notebook_path", "path"];
export const MAX_FILES = 40;
export const FIRST_PROMPT_CHARS = 300;
export const LAST_MESSAGE_CHARS = 500;

export function clip(s, n) {
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

export function repoNameFromPath(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const dot = parts.indexOf(".claude");
  if (dot > 0) return parts[dot - 1];
  return parts[parts.length - 1];
}

export function decodeProjectDir(name) {
  return name.startsWith("-") ? name.replace(/-/g, "/") : name;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function summarizeTranscript(raw, fallback = {}) {
  let sessionId = fallback.sessionId ?? null;
  let project = fallback.project ?? null;
  let branch = null;
  let version = null;
  let started = null;
  let ended = null;
  let turns = 0;
  let assistantMessages = 0;
  let firstPrompt = "";
  let lastAssistant = "";
  let costUsd = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const files = [];
  let filesTruncated = false;
  const tools = new Map();
  const models = [];

  for (const line of String(raw).split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (typeof rec.sessionId === "string" && !sessionId) sessionId = rec.sessionId;
    if (typeof rec.cwd === "string" && rec.cwd) project = rec.cwd;
    if (typeof rec.gitBranch === "string" && rec.gitBranch) branch = rec.gitBranch;
    if (typeof rec.version === "string" && rec.version) version = rec.version;
    if (typeof rec.timestamp === "string" && rec.timestamp) {
      if (!started) started = rec.timestamp;
      ended = rec.timestamp;
    }
    for (const k of ["costUSD", "totalCostUsd", "total_cost_usd"]) {
      if (typeof rec[k] === "number" && Number.isFinite(rec[k])) costUsd = (costUsd ?? 0) + rec[k];
    }

    if (rec.isMeta) continue;
    const msg = rec.message;
    if (!msg || typeof msg !== "object") continue;

    if (rec.type === "user") {
      if (rec.isSidechain) continue;
      turns++;
      if (!firstPrompt) firstPrompt = textOf(msg.content).trim();
      continue;
    }
    if (rec.type !== "assistant") continue;

    assistantMessages++;
    if (typeof msg.model === "string" && msg.model && !msg.model.startsWith("<") && !models.includes(msg.model)) models.push(msg.model);
    inputTokens += num(msg.usage?.input_tokens) + num(msg.usage?.cache_creation_input_tokens) + num(msg.usage?.cache_read_input_tokens);
    outputTokens += num(msg.usage?.output_tokens);
    const text = textOf(msg.content).trim();
    if (text && !rec.isSidechain) lastAssistant = text;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "(unnamed)";
      tools.set(name, (tools.get(name) ?? 0) + 1);
      const input = block.input;
      if (!input || typeof input !== "object") continue;
      for (const key of PATH_KEYS) {
        const p = input[key];
        if (typeof p !== "string" || !p.trim()) continue;
        if (files.includes(p)) continue;
        if (files.length >= MAX_FILES) {
          filesTruncated = true;
          continue;
        }
        files.push(p);
      }
    }
  }

  if (!firstPrompt && !lastAssistant && turns === 0) return null;

  const durationMs = started && ended ? Math.max(0, Date.parse(ended) - Date.parse(started)) : null;
  return {
    sessionId,
    project,
    repo: repoNameFromPath(project),
    branch,
    started,
    ended,
    durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    turns,
    assistantMessages,
    firstPrompt: clip(firstPrompt, FIRST_PROMPT_CHARS),
    lastAssistant: clip(lastAssistant, LAST_MESSAGE_CHARS),
    files,
    filesTruncated,
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    models,
    costUsd,
    inputTokens,
    outputTokens,
    version,
  };
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "unknown";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function idempotencyKey(summary, source = SOURCE) {
  const material = [summary.sessionId ?? "", summary.ended ?? "", String(summary.turns), String(summary.assistantMessages)].join("\n");
  return `${source}:${summary.sessionId ?? "unknown"}:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export function sessionTitle(summary) {
  const where = summary.repo ?? "session";
  const day = (summary.started ?? summary.ended ?? new Date().toISOString()).slice(0, 10);
  return `Claude Code session — ${where} — ${day}`;
}

export function renderSessionBody(summary) {
  const facts = [`- Turns: ${summary.turns} user, ${summary.assistantMessages} assistant`, `- Duration: ${formatDuration(summary.durationMs)}`];
  if (summary.project) facts.push(`- Project: \`${summary.project}\`${summary.branch ? ` (branch \`${summary.branch}\`)` : ""}`);
  if (summary.models.length) facts.push(`- Models: ${summary.models.join(", ")}`);
  if (summary.costUsd !== null && summary.costUsd !== undefined) facts.push(`- Cost: $${summary.costUsd.toFixed(4)}`);
  if (summary.inputTokens || summary.outputTokens) facts.push(`- Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out`);
  if (summary.version) facts.push(`- Claude Code: ${summary.version}`);

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
  return parts.join("\n").trimEnd();
}

export function renderSessionNote(summary, extra = {}) {
  const source = extra.source ?? SOURCE;
  const y = (v) => (v === null || v === undefined || v === "" ? "null" : JSON.stringify(String(v)));
  const title = sessionTitle(summary);
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
    `captured_at: ${y(extra.capturedAt ?? new Date().toISOString())}`,
    `idempotency_key: ${y(extra.key ?? idempotencyKey(summary, source))}`,
    "---",
    "",
    `# ${title}`,
    "",
    renderSessionBody(summary),
    "",
  ].join("\n");
}

/**
 * POST one session summary. Same wire contract as `capture()`, but the note is
 * rendered by `renderSessionNote` so the frontmatter matches what
 * `metistry import-sessions` sends (docs/ops/cli.md).
 */
export async function captureSession({ summary, env = process.env, now = new Date(), timeoutMs = 8_000 }) {
  const key = idempotencyKey(summary);
  const note = renderSessionNote(summary, { host: hostname(), capturedAt: now.toISOString(), key });
  const stamp = (summary.started ?? now.toISOString()).replaceAll(/[-:]/g, "").replace(/\.\d+Z?$/, "Z");
  const filename = `${SOURCE}-session-${stamp}-${String(summary.sessionId ?? "unknown").slice(0, 8)}.md`;
  return await postCapture({ note, filename, env, timeoutMs });
}
