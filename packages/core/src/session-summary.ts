// Deterministic summaries of a Claude Code transcript (stash review item 2).
// No model anywhere: `metistry import-sessions` and the plugin's SessionEnd
// hook both run in places a model call is forbidden (collectors/CLI), and a
// transcript is foreign content — it is measured, never interpreted.
//
// The transcript layout this reads, confirmed on macOS 2026-09-09 against
// Claude Code 2.1.251's own files (documented in docs/ops/cli.md):
//
//   ~/.claude/projects/<cwd with every `/` and `.` replaced by `-`>/<session uuid>.jsonl
//
// One JSON object per line, appended as the session runs. Fields relied on,
// all of them optional — every one is guarded, because a newer Claude Code may
// stop writing any of them and a capture door must never throw (invariant:
// capture never drops):
//
//   type        "user" | "assistant" | anything else (attachment, system,
//               queue-operation, last-prompt, mode, … — all ignored)
//   timestamp   ISO 8601; first/last seen give started/ended
//   cwd         absolute path of the session's directory
//   gitBranch   branch name at the time of the record
//   version     Claude Code version
//   sessionId   the uuid, also the file's basename
//   isSidechain true for subagent turns (excluded from the turn count)
//   isMeta      true for injected/system-authored user records (ignored)
//   message     { role, model?, content: string | block[], usage? }
//   block       { type: "text", text } | { type: "thinking" }
//               | { type: "tool_use", name, input }
//
// Cost: these files carry no cost field (checked across every transcript on
// the author's machine — no `costUSD`, no `totalCostUsd`), so `costUsd` is
// null unless a future transcript grows one. Token totals are summed instead.

import { createHash } from "node:crypto";

/** Tool inputs whose paths are worth recording, and the key each keeps them under. */
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

export const MAX_FILES = 40;
export const FIRST_PROMPT_CHARS = 300;
export const LAST_MESSAGE_CHARS = 500;

export interface SessionSummary {
  sessionId: string | null;
  /** The session's working directory (`cwd` from the transcript). */
  project: string | null;
  /** Basename of the enclosing checkout, when the cwd looks like one. */
  repo: string | null;
  branch: string | null;
  started: string | null;
  ended: string | null;
  durationMs: number | null;
  /** User turns, excluding sidechain (subagent) and meta records. */
  turns: number;
  assistantMessages: number;
  firstPrompt: string;
  lastAssistant: string;
  /** Deduped, in first-seen order, capped at MAX_FILES. */
  files: string[];
  /** Whether `files` was truncated by the cap. */
  filesTruncated: boolean;
  /** Tool name → call count, most-used first. */
  tools: { name: string; count: number }[];
  models: string[];
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  version: string | null;
}

export function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Text of a message's content, tolerant of both the string and block forms. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Name of the enclosing git checkout, guessed from the path (no filesystem access). */
export function repoNameFromPath(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  // A worktree lives at <repo>/.claude/worktrees/<name>: the checkout is the repo above it.
  const dot = parts.indexOf(".claude");
  if (dot > 0) return parts[dot - 1]!;
  return parts[parts.length - 1]!;
}

/** The absolute cwd a project directory name encodes. Lossy (`-` for both `/` and `.`), so only a fallback. */
export function decodeProjectDir(name: string): string {
  return name.startsWith("-") ? name.replace(/-/g, "/") : name;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Summarise one transcript. Returns null when the file holds no conversation
 * (a router SDK probe with no user text, a truncated write): an empty
 * proposal in Needs You is worse than no proposal.
 */
export function summarizeTranscript(raw: string, fallback: { sessionId?: string | null; project?: string | null } = {}): SessionSummary | null {
  let sessionId = fallback.sessionId ?? null;
  let project = fallback.project ?? null;
  let branch: string | null = null;
  let version: string | null = null;
  let started: string | null = null;
  let ended: string | null = null;
  let turns = 0;
  let assistantMessages = 0;
  let firstPrompt = "";
  let lastAssistant = "";
  let costUsd: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const files: string[] = [];
  let filesTruncated = false;
  const tools = new Map<string, number>();
  const models: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a half-written last line is normal while a session runs
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
      if (rec.isSidechain) continue; // subagent traffic is not a turn the owner took
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
        const p = (input as Record<string, unknown>)[key];
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

export function formatDuration(ms: number | null): string {
  if (ms === null) return "unknown";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * The dedupe key for one session summary. Derived from the transcript's
 * content, not from its mtime, so the CLI importer and the plugin's
 * SessionEnd hook produce the SAME key for the same session state — the
 * server can dedupe across both doors. A session that continues and is
 * re-imported gets a new key, which is the intent: it is a new summary.
 */
export function idempotencyKey(summary: SessionSummary, source = "claude-code"): string {
  const material = [summary.sessionId ?? "", summary.ended ?? "", String(summary.turns), String(summary.assistantMessages)].join("\n");
  return `${source}:${summary.sessionId ?? "unknown"}:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export function sessionTitle(summary: SessionSummary): string {
  const where = summary.repo ?? "session";
  const day = (summary.started ?? summary.ended ?? new Date().toISOString()).slice(0, 10);
  return `Claude Code session — ${where} — ${day}`;
}

/** The markdown body. Deterministic: same transcript in, same bytes out. */
export function renderSessionBody(summary: SessionSummary): string {
  const facts: string[] = [
    `- Turns: ${summary.turns} user, ${summary.assistantMessages} assistant`,
    `- Duration: ${formatDuration(summary.durationMs)}`,
  ];
  if (summary.project) facts.push(`- Project: \`${summary.project}\`${summary.branch ? ` (branch \`${summary.branch}\`)` : ""}`);
  if (summary.models.length) facts.push(`- Models: ${summary.models.join(", ")}`);
  if (summary.costUsd !== null) facts.push(`- Cost: $${summary.costUsd.toFixed(4)}`);
  if (summary.inputTokens || summary.outputTokens) facts.push(`- Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out`);
  if (summary.version) facts.push(`- Claude Code: ${summary.version}`);

  const parts = ["## Session", "", ...facts, ""];
  if (summary.tools.length) {
    parts.push("## Tools", "", summary.tools.map((t) => `- ${t.name} × ${t.count}`).join("\n"), "");
  }
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

/**
 * The frontmatter both doors emit (docs/ops/cli.md). JSON string literals are
 * valid YAML double-quoted scalars, so this needs no YAML dependency — the
 * same trick the plugin's lib.mjs uses.
 */
export function renderSessionNote(summary: SessionSummary, extra: { source?: string; host?: string | null; capturedAt?: string; key?: string } = {}): string {
  const source = extra.source ?? "claude-code";
  const y = (v: unknown) => (v === null || v === undefined || v === "" ? "null" : JSON.stringify(String(v)));
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
