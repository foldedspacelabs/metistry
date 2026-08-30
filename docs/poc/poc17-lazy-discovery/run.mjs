#!/usr/bin/env node
// PoC-17 driver: 5 scripted tasks x {eager, lazy} against claude -p at the
// Haiku tier. Measures prompt tokens, output tokens, turns, wall time, and
// scores correctness from the server's call log.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const MODEL = process.env.POC17_MODEL ?? "haiku";

const TASKS = [
  { id: "T1", prompt: "Using the toy bridge, list my 3 most recent messages and summarize them in one line.", expect: ["messages_list_recent"] },
  { id: "T2", prompt: "Using the toy bridge, what calendar events do I have today?", expect: ["calendar_list_today"] },
  { id: "T3", prompt: "Using the toy bridge, create a reminder to buy milk tomorrow.", expect: ["reminders_create"] },
  { id: "T4", prompt: "Using the toy bridge, what is the current CPU usage?", expect: ["system_cpu_usage"] },
  { id: "T5", prompt: "Using the toy bridge, check the current weather AND today's calendar, then tell me whether I need an umbrella for any outdoor event.", expect: ["weather_current", "calendar_list_today"] },
];

const results = [];
for (const mode of ["eager", "lazy"]) {
  for (const task of TASKS) {
    const dir = mkdtempSync(join(tmpdir(), "poc17-"));
    const callLog = join(dir, "calls.jsonl");
    const mcpConfig = join(dir, "mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          toy: {
            command: "node",
            args: [join(HERE, "server.mjs")],
            env: { MODE: mode, CALL_LOG: callLog },
          },
        },
      }),
    );

    const start = Date.now();
    let out;
    try {
      out = JSON.parse(
        execFileSync(
          "claude",
          ["-p", task.prompt, "--model", MODEL, "--mcp-config", mcpConfig, "--strict-mcp-config",
           "--allowedTools", "mcp__toy__*", "--max-turns", "8", "--output-format", "json"],
          { encoding: "utf8", timeout: 180_000 },
        ),
      );
    } catch (err) {
      results.push({ mode, task: task.id, error: String(err).slice(0, 200) });
      continue;
    }
    const wallMs = Date.now() - start;

    const calls = existsSync(callLog)
      ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const invoked = calls.map((c) => c.tool);
    const correct = task.expect.every((t) => invoked.includes(t));
    const u = out.usage ?? {};
    results.push({
      mode,
      task: task.id,
      correct,
      invoked,
      num_turns: out.num_turns,
      prompt_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      uncached_input: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      wall_ms: wallMs,
      is_error: out.is_error ?? false,
    });
    console.error(`${mode} ${task.id}: correct=${correct} turns=${out.num_turns} prompt=${results.at(-1).prompt_tokens} wall=${wallMs}ms invoked=${invoked.join(",")}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify(results, null, 2));
