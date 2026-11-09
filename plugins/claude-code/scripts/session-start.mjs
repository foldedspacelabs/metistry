#!/usr/bin/env node
// SessionStart hook (hooks/hooks.json): hand the session its briefing — the
// project page, open tasks, recent sessions and folds for this checkout, as
// handles plus the owner's own text, under this agent's grant (X-128's
// `GET /api/briefing`). On by default; the owner's opt-out is per agent, set
// with `metistry connect claude-code --briefing off`, and lives with the
// agent's grants on the console, so an opted-out agent is simply served
// nothing. `METISTRY_BRIEFING=off` silences it for one profile.
//
// Failure is silent by contract: this hook exits 0 on every path and writes at
// most one redacted line to stderr. It never blocks the session it serves.
import { readFileSync } from "node:fs";
import { runSessionStart } from "./briefing.mjs";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    input = {};
  }
  await runSessionStart(input);
}

// Let the process end on its own so stdout drains (an `exit()` can cut a piped write); the exit code is 0 on every path.
process.exitCode = 0;
main().catch(() => {});
