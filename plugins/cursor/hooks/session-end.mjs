#!/usr/bin/env node
// Cursor `sessionEnd` hook (plan refresh §4b W4). Default OFF: does nothing
// unless METISTRY_CAPTURE_ON_STOP=1 — the same switch the Claude Code plugin
// uses, so one export covers whichever tool the session happened in.
//
// Posts a `kind: "session"` note to `POST /capture` with the same frontmatter
// and the same `idempotency_key` formula as the Claude Code plugin and
// `metistry import-sessions` (docs/ops/cli.md), so the three doors dedupe
// against each other server-side and `inbox-drain` classifies all of them the
// same way.
//
// No model is called and no transcript is read. Cursor's payload gives the
// session id, workspace, duration, model, version and how the session ended;
// the format of the file at `transcript_path` is undocumented, so nothing is
// inferred from it and the note says so (`NOT_CAPTURED` in scripts/lib.mjs).
//
// Failure is silent by contract: exit 0 on every path, at most one redacted
// line on stderr. `sessionEnd` is fire-and-forget in Cursor ("The response is
// logged but not used") and this hook prints no JSON, so there is nothing it
// can block. With `METISTRY_CAPTURE_DIR` set, an unreachable console means the
// note is written there instead of dropped (SHOULD-10).
import { readFileSync } from "node:fs";
import { captureSession, config, redact, summarizeSessionEnd } from "../scripts/lib.mjs";

/** Cursor sends the payload as JSON on stdin (cursor.com/docs/hooks: "JSON in both directions"). */
export function readInput(fd = 0) {
  try {
    return JSON.parse(readFileSync(fd, "utf8") || "{}");
  } catch {
    return {};
  }
}

async function main() {
  if (process.env.METISTRY_CAPTURE_ON_STOP !== "1") return;
  const summary = summarizeSessionEnd(readInput());
  if (!summary) return; // no session id → nothing that can be deduped → say nothing
  const r = await captureSession({ summary });
  if (r.delivered === "file") console.log(`metistry: console unreachable (${r.reason}) — session saved to ${r.path}`);
  else console.log(`metistry: session captured → inbox #${r.id}`);
}

const { token } = config();
main()
  .catch((err) => console.error(`metistry: session capture skipped: ${redact(err?.message ?? err, token)}`))
  .finally(() => process.exit(0));
