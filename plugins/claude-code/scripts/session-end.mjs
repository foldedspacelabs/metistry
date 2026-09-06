#!/usr/bin/env node
// SessionEnd hook (hooks/hooks.json). Default OFF: does nothing unless
// METISTRY_CAPTURE_ON_STOP=1. Posts a short session summary to /capture.
//
// Failure is silent by contract: this hook exits 0 on every path and writes
// at most one redacted line to stderr — a capture door must never fail the
// session it is capturing from. Also tolerates a Stop event (uses
// last_assistant_message) in case a user rebinds it.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { capture, config, redact, repoName } from "./lib.mjs";

const MAX_BODY = 2000;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/** Tolerant JSONL read: first user prompt, last assistant text, turn count. */
function summarizeTranscript(path) {
  let first = "";
  let last = "";
  let turns = 0;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.isMeta) continue;
    const text = textOf(rec?.message?.content).trim();
    if (!text) continue;
    if (rec.type === "user") {
      turns++;
      if (!first) first = text;
    } else if (rec.type === "assistant") {
      last = text;
    }
  }
  if (!first && !last) return null;
  return { first, last, turns };
}

function buildSummary(input) {
  const cwd = input.cwd ?? process.cwd();
  const repo = repoName(cwd) ?? basename(cwd);
  const parts = [];
  if (input.hook_event_name === "Stop" && input.last_assistant_message) {
    parts.push(clip(String(input.last_assistant_message), MAX_BODY));
  } else {
    const t = input.transcript_path ? summarizeTranscript(input.transcript_path) : null;
    if (!t) return null; // nothing to say — no empty proposals in the inbox
    parts.push(`Turns: ${t.turns}${input.reason ? ` · ended: ${input.reason}` : ""}`, "");
    if (t.first) parts.push("## First prompt", "", clip(t.first, 600), "");
    if (t.last) parts.push("## Last response", "", clip(t.last, MAX_BODY));
  }
  const day = new Date().toISOString().slice(0, 10);
  return { cwd, title: `Claude Code session — ${repo} — ${day}`, body: parts.join("\n") };
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
  const r = await capture({
    kind: "session-summary",
    title: summary.title,
    body: summary.body,
    sessionId: input.session_id,
    cwd: summary.cwd,
    timeoutMs: 8_000,
  });
  console.log(`metistry: session captured → inbox #${r.id}`);
}

const { token } = config();
main()
  .catch((err) => console.error(`metistry: session capture skipped: ${redact(err?.message ?? err, token)}`))
  .finally(() => process.exit(0));
