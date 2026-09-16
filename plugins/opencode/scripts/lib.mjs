// Shared capture logic for the OpenCode plugin (plan refresh §4b W5). Sibling
// of `plugins/cursor/scripts/lib.mjs` and `plugins/claude-code/scripts/lib.mjs`,
// and deliberately not a copy of either: OpenCode hands the plugin its SDK
// client, so the *summariser* reads a live message list where Cursor reads a
// payload and Claude Code reads a JSONL file. What must not drift is the part
// the server sees — the note's frontmatter, the body's shape, and the
// `idempotency_key` formula — so those functions are transcribed from
// `packages/core/src/session-summary.ts` with core's own defaults, and
// `test/session-parity.test.ts` renders a real core summary through both and
// fails the build the moment a byte differs.
//
// Dependency-free Node 22+ / Bun (global fetch, node:crypto, node:fs, node:os):
// the plugin is loaded straight out of a checkout, so it cannot import a built
// workspace package. The three plugins are locked to each other transitively —
// each is held to core, core is one file.
//
// The server contract is `POST /capture` with `{ note, filename }`
// (apps/console/src/server.ts); `/capture` has no metadata field, so
// provenance rides in the note's frontmatter.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const SOURCE = "opencode";
/** How the tool names itself — the title and the version fact, never a path or a table name (CLAUDE.md). */
export const LABEL = "OpenCode";
export const MAX_FILES = 40;
export const FIRST_PROMPT_CHARS = 300;
export const LAST_MESSAGE_CHARS = 500;
export const ERROR_CHARS = 500;
/** How long a session must sit idle before it counts as finished. See `pendingCapture` in ../plugin.js. */
export const DEFAULT_IDLE_MS = 90_000;
export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Read config from the environment only — never from files.
 *
 * `METISTRY_AGENT_TOKEN_OPENCODE` is the variable `metistry connect opencode`
 * already puts in the login Keychain and has you export (docs/ops/opencode.md),
 * so the plugin needs no second secret. An owner token still works for a
 * machine that has not run `connect`.
 */
export function config(env = process.env) {
  return {
    url: (env.METISTRY_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.METISTRY_AGENT_TOKEN_OPENCODE ?? env.METISTRY_OWNER_TOKEN ?? "").trim(),
    /** SHOULD-10: a capture that cannot reach the console is written here rather than dropped. */
    captureDir: (env.METISTRY_CAPTURE_DIR ?? "").trim(),
    /** The quiet window that stands in for the session-end event OpenCode does not have. */
    idleMs: intOr(env.METISTRY_OPENCODE_IDLE_MS, DEFAULT_IDLE_MS),
    timeoutMs: intOr(env.METISTRY_CAPTURE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function intOr(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
 * The dedupe key for one session summary — the same formula core uses, so an
 * OpenCode session, a Cursor session and a Claude Code session are the same
 * kind of row to the server and `inbox-drain` classifies all of them on
 * `kind: session`.
 *
 * It is derived from the session's CONTENT (id, end time, turn counts), so
 * re-capturing an unchanged session is an exact no-op server-side — which is
 * what makes the retry after the local-file fallback safe — while a session
 * that was picked up again and continued gets a new key, which is the intent:
 * it is a new summary.
 */
export function idempotencyKey(summary, source = "claude-code") {
  const material = [summary.sessionId ?? "", summary.ended ?? "", String(summary.turns), String(summary.assistantMessages)].join("\n");
  return `${source}:${summary.sessionId ?? "unknown"}:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

// The `label` and `source` defaults below are CORE's, not OpenCode's. That is
// deliberate and is the whole parity mechanism: called with nothing supplied
// these three functions must be byte-identical to core's, and the plugin always
// supplies `{ source: SOURCE, label: LABEL }`.

export function sessionTitle(summary, label = "Claude Code", nowIso = new Date().toISOString()) {
  const where = summary.repo ?? "session";
  const day = (summary.started ?? summary.ended ?? nowIso).slice(0, 10);
  return `${label} session — ${where} — ${day}`;
}

/** The markdown body. Deterministic: same summary in, same bytes out. */
export function renderSessionBody(summary, label = "Claude Code") {
  const facts = [];
  // A summary built from a transcript OpenCode would not give us carries no
  // turn counts, so the line is omitted rather than reported as zero. Core
  // always sets numbers, so core renders it as before.
  if (summary.turns !== null && summary.turns !== undefined && summary.assistantMessages !== null && summary.assistantMessages !== undefined) {
    facts.push(`- Turns: ${summary.turns} user, ${summary.assistantMessages} assistant`);
  }
  facts.push(`- Duration: ${formatDuration(summary.durationMs)}`);
  if (summary.project) facts.push(`- Project: \`${summary.project}\`${summary.branch ? ` (branch \`${summary.branch}\`)` : ""}`);
  if (summary.models.length) facts.push(`- Models: ${summary.models.join(", ")}`);
  if (summary.costUsd !== null && summary.costUsd !== undefined) facts.push(`- Cost: $${summary.costUsd.toFixed(4)}`);
  if (summary.inputTokens || summary.outputTokens) facts.push(`- Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out`);
  if (summary.version) facts.push(`- ${label}: ${summary.version}`);
  // Everything below is OpenCode-only and is appended AFTER the shared facts,
  // so a core-shaped summary (which carries none of it) renders identically.
  if (summary.agent) facts.push(`- Agent: ${summary.agent}`);
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
 * The frontmatter every door emits (docs/ops/cli.md). Keys, order and types are
 * core's — an OpenCode note is the same row to `inbox-drain` as a Claude Code
 * one. Everything OpenCode-specific is a fact in the body, never a new key.
 *
 * JSON string literals are valid YAML double-quoted scalars, so this needs no
 * YAML dependency. `turns` is interpolated raw (a number, or `null` when the
 * transcript could not be read) because core writes it raw.
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
// An OpenCode session → a summary
// ---------------------------------------------------------------------------
//
// Shapes verified against OpenCode 1.18.30's own OpenAPI document (the running
// server's `GET /doc`, read 2026-09-16) and its live tool schemas, not guessed:
//
//   session   { id, directory, title, version, time: { created, updated } }
//   message   { info, parts }, info.role "user" | "assistant"
//             user      { id, sessionID, role, time: { created }, agent, model: { providerID, modelID } }
//             assistant { id, sessionID, role, time: { created, completed }, modelID, providerID,
//                         agent, path: { cwd, root }, cost, tokens: { input, output, cache }, error }
//   part      { type: "text" | "tool" | "patch" | "step-start" | … }
//             text  { text, synthetic?, time }
//             tool  { tool, callID, state: { status, input, output, … } }
//             patch { hash, files: string[] }
//
// Times are epoch milliseconds, not ISO strings.

/** Tool inputs whose paths are worth recording. `filePath` is what read/edit/write take (OpenCode 1.18.30's own tool schemas); `path` is glob/grep's DIRECTORY argument, so it is deliberately not read. */
const PATH_KEYS = ["filePath"];

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/** The text of a message's parts, ignoring the synthetic ones OpenCode injects as context. */
export function textOf(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => !!p && typeof p === "object" && p.type === "text" && typeof p.text === "string" && p.synthetic !== true && p.ignored !== true)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * What a note does NOT contain, said in the note itself rather than only in the
 * docs — the shape `plugins/cursor` established. This is the fallback path: the
 * `session.idle` event carries only a `sessionID`, so when the SDK client will
 * not give up the messages there is nothing to summarise and the note says so
 * instead of inventing a session with zero turns.
 */
export function notCapturedBecause(reason) {
  return (
    `OpenCode's \`session.idle\` event carries only the session id, and this session's transcript could not be read ` +
    `back through the plugin's SDK client (${reason}) — so this note records the event's own fields and infers nothing: ` +
    `no turn counts, prompts, tools or files touched.`
  );
}

/** The empty shape every field of a summary starts from, so both builders below agree on the keys. */
function blank(sessionId, project) {
  return {
    sessionId,
    project,
    repo: repoNameFromPath(project),
    branch: null,
    started: null,
    ended: null,
    durationMs: null,
    turns: null,
    assistantMessages: null,
    firstPrompt: "",
    lastAssistant: "",
    files: [],
    filesTruncated: false,
    tools: [],
    models: [],
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    version: null,
    agent: null,
    errorMessage: null,
    notCaptured: null,
  };
}

/**
 * Summarise one OpenCode session from its message list. No model anywhere: a
 * transcript is foreign content, so it is measured, never interpreted.
 *
 * Every field is guarded — a capture door must never throw, and a newer
 * OpenCode may stop sending any of them.
 *
 * Returns null when there is no conversation to summarise (a session created
 * and abandoned): an empty proposal in Needs You is worse than no proposal.
 */
/** @param {unknown[] | null} messages @param {{ session?: Record<string, unknown>, directory?: string | null }} [where] */
export function summarizeSession(messages, { session = {}, directory = null } = {}) {
  const list = Array.isArray(messages) ? messages.filter((m) => !!m && typeof m === "object") : [];
  const project = str(session?.directory) ?? str(directory);
  const out = blank(str(session?.id), project);
  out.version = str(session?.version);

  let firstTime = null;
  let lastTime = null;
  let turns = 0;
  let assistantMessages = 0;
  const files = [];
  const tools = new Map();
  const models = [];

  for (const entry of list) {
    const info = entry.info ?? entry;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    if (!info || typeof info !== "object") continue;
    if (!out.sessionId) out.sessionId = str(info.sessionID);

    const created = num(info.time?.created);
    const completed = num(info.time?.completed);
    if (created > 0 && (firstTime === null || created < firstTime)) firstTime = created;
    for (const t of [created, completed]) if (t > 0 && (lastTime === null || t > lastTime)) lastTime = t;
    if (!out.agent) out.agent = str(info.agent);

    if (info.role === "user") {
      const text = textOf(parts);
      // A user message whose text is entirely synthetic is injected context
      // (`noReply` prompts, plugin-supplied context), not a turn the owner took.
      if (!text) continue;
      turns++;
      if (!out.firstPrompt) out.firstPrompt = clip(text, FIRST_PROMPT_CHARS);
      continue;
    }
    if (info.role !== "assistant") continue;

    assistantMessages++;
    const model = str(info.providerID) && str(info.modelID) ? `${info.providerID}/${info.modelID}` : str(info.modelID);
    if (model && !models.includes(model)) models.push(model);
    if (!out.project && str(info.path?.cwd)) {
      out.project = str(info.path.cwd);
      out.repo = repoNameFromPath(out.project);
    }
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) out.costUsd = (out.costUsd ?? 0) + info.cost;
    out.inputTokens += num(info.tokens?.input) + num(info.tokens?.cache?.read) + num(info.tokens?.cache?.write);
    out.outputTokens += num(info.tokens?.output);
    if (!out.errorMessage && info.error) out.errorMessage = str(info.error?.data?.message) ?? str(info.error?.name) ?? null;

    const text = textOf(parts);
    if (text) out.lastAssistant = clip(text, LAST_MESSAGE_CHARS);

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool") {
        const name = str(part.tool) ?? "(unnamed)";
        tools.set(name, (tools.get(name) ?? 0) + 1);
        const input = part.state?.input;
        if (!input || typeof input !== "object") continue;
        for (const key of PATH_KEYS) addFile(files, input[key]);
        continue;
      }
      // `apply_patch` reports what it wrote as a patch part rather than as a
      // tool input, so the files it touched are read from there too.
      if (part.type === "patch" && Array.isArray(part.files)) for (const f of part.files) addFile(files, f);
    }
  }

  if (turns === 0 && assistantMessages === 0) return null;

  out.turns = turns;
  out.assistantMessages = assistantMessages;
  out.started = iso(firstTime);
  out.ended = iso(lastTime);
  out.durationMs = firstTime !== null && lastTime !== null ? Math.max(0, lastTime - firstTime) : null;
  out.files = files.slice(0, MAX_FILES);
  out.filesTruncated = files.length > MAX_FILES;
  out.tools = [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
  out.models = models;
  return out;
}

function addFile(files, value) {
  const p = str(value);
  if (!p || files.includes(p)) return;
  if (files.length > MAX_FILES) return; // one over the cap is enough to know it was truncated
  files.push(p);
}

/**
 * The summary for a session whose transcript could not be read. `turns` stays
 * null (not zero) so `renderSessionBody` omits the line rather than reporting a
 * count nobody measured, and `ended` stays null so the key is a pure function
 * of the session id — a retry is then an exact no-op rather than a second note.
 */
/** @param {string | null | undefined} sessionId @param {{ directory?: string | null, reason?: string }} [where] */
export function unreadableSession(sessionId, { directory = null, reason = "unknown" } = {}) {
  const out = blank(str(sessionId), str(directory));
  out.notCaptured = notCapturedBecause(reason);
  return out;
}

/**
 * Ask OpenCode for a session and its messages through the SDK client the
 * plugin is handed. Tolerant of both the bare-value and `{ data }` response
 * shapes, because which one a client method returns is the SDK's business and
 * has changed between releases; anything else resolves to null and the caller
 * writes a `## Not captured` note rather than guessing.
 */
export function unwrap(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "data" in value) return value.data;
  return value;
}

export async function readSession(client, sessionId) {
  const session = unwrap(await client.session.get({ path: { id: sessionId } }));
  return session && typeof session === "object" ? session : null;
}

export async function readMessages(client, sessionId) {
  const messages = unwrap(await client.session.messages({ path: { id: sessionId } }));
  return Array.isArray(messages) ? messages : null;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** The one wire call: `POST /capture` with `{ note, filename }`, bearer auth, redacted errors. */
export async function postCapture({ note, filename, key, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch }) {
  const { url, token } = config(env);
  if (!url) throw new Error("METISTRY_URL is not set");
  if (!token) throw new Error("neither METISTRY_AGENT_TOKEN_OPENCODE nor METISTRY_OWNER_TOKEN is set");

  let res;
  try {
    res = await fetchFn(`${url}/capture`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // The console replays the first row for a repeated key instead of
        // making a second one (apps/console/src/server.ts).
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
export async function captureSession({ summary, source = SOURCE, label = LABEL, env = process.env, now = new Date(), timeoutMs = undefined, fetchFn = fetch, home = homedir() }) {
  const key = idempotencyKey(summary, source);
  const capturedAt = now.toISOString();
  const note = renderSessionNote(summary, { source, label, host: hostname(), capturedAt, key });
  const stamp = capturedAt.replaceAll(/[-:]/g, "").replace(/\.\d+Z?$/, "Z");
  const filename = `${source}-session-${stamp}-${String(summary.sessionId ?? "unknown").slice(0, 12)}.md`;

  try {
    const r = await postCapture({ note, filename, key, env, timeoutMs: timeoutMs ?? config(env).timeoutMs, fetchFn });
    return { delivered: "console", filename, key, ...r };
  } catch (err) {
    const { captureDir, token } = config(env);
    if (!captureDir) throw err;
    const path = writeCaptureFile(captureDir, filename, note, home);
    return { delivered: "file", filename, key, path, reason: redact(err?.message ?? err, token) };
  }
}
