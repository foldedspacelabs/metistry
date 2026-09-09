#!/usr/bin/env node
// SessionEnd hook (hooks/hooks.json). Default OFF: does nothing unless
// METISTRY_CAPTURE_ON_STOP=1. Posts a deterministic session summary to
// /capture with frontmatter `kind: session` — the SAME shape
// `metistry import-sessions` sends, including `idempotency_key`, so the two
// doors dedupe against each other server-side (docs/ops/cli.md).
//
// No model is called: the summary is measured from the transcript, never
// interpreted. Only prompts and assistant text the owner already saw are
// carried, clipped; thinking blocks and tool output never are.
//
// Failure is silent by contract: this hook exits 0 on every path and writes
// at most one redacted line to stderr — a capture door must never fail the
// session it is capturing from. Also tolerates a Stop event (uses
// last_assistant_message) in case a user rebinds it.
import { readFileSync } from "node:fs";
import { captureSession, config, redact, repoNameFromPath, summarizeTranscript } from "./lib.mjs";

/** The transcript, or null when there is nothing readable to summarise. */
function readTranscript(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function buildSummary(input, read = readTranscript) {
  const cwd = input.cwd ?? process.cwd();
  const raw = input.transcript_path ? read(input.transcript_path) : null;
  const summary = raw === null ? null : summarizeTranscript(raw, { sessionId: input.session_id ?? null, project: cwd });
  if (summary) {
    // The hook knows the session id and cwd first-hand; prefer them.
    if (input.session_id) summary.sessionId = input.session_id;
    if (!summary.project) summary.project = cwd;
    summary.repo = repoNameFromPath(summary.project);
    return summary;
  }
  // A rebound Stop event, or a transcript we could not read: the event's own
  // last message is all there is. Still a session-kind summary, not nothing.
  const text = String(input.last_assistant_message ?? "").trim();
  if (!text) return null; // nothing to say — no empty proposals in the inbox
  const now = new Date().toISOString();
  return {
    sessionId: input.session_id ?? null,
    project: cwd,
    repo: repoNameFromPath(cwd),
    branch: null,
    started: now,
    ended: now,
    durationMs: null,
    turns: 0,
    assistantMessages: 1,
    firstPrompt: "",
    lastAssistant: text.slice(0, 500),
    files: [],
    filesTruncated: false,
    tools: [],
    models: [],
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    version: null,
  };
}

async function main() {
  if (process.env.METISTRY_CAPTURE_ON_STOP !== "1") return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    input = {};
  }
  const summary = buildSummary(input);
  if (!summary) return;
  const r = await captureSession({ summary, timeoutMs: 8_000 });
  console.log(`metistry: session captured → inbox #${r.id}`);
}

const { token } = config();
main()
  .catch((err) => console.error(`metistry: session capture skipped: ${redact(err?.message ?? err, token)}`))
  .finally(() => process.exit(0));
