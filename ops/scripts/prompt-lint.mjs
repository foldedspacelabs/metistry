#!/usr/bin/env node
// Prompt hygiene lint (cost-optimisation doc, decision 1: "a deterministic
// prompt lint ... flagging the known anti-pattern phrases; runs in CI —
// enforce at the tool, never by prompting"). No dependencies: plain fs
// recursion + regex, matching this repo's other ops/scripts/*.sh checks.
//
// Scans seed/assistant-prompt.md, seed/agents/**/*.md, skills/**/SKILL.md,
// plugins/**/SKILL.md, and the Claude Code assets in .claude/skills/**/SKILL.md
// (plus their references/) and .claude/agents/*.md for:
//   - known anti-pattern phrases (case-insensitive): padding a prompt with
//     "verify twice", "double-check", "be maximally thorough",
//     "think step by step", "use a scratchpad", "never forget" costs 14-36%
//     per task for no accuracy gain (the doc's "prompt audit" line) and,
//     worse, is not a control — CLAUDE.md's own rule: "enforce at the tool".
//   - "ALWAYS" (all caps) used more than twice in one file — shouting does
//     not make an instruction more likely to be followed and reads as
//     habitual filler.
//   - {{date}}/{{now}}-style placeholders — a volatile value templated into
//     a system prompt breaks Anthropic's prompt cache on every turn (a
//     50x-the-read-price rewrite each time on Fable/Mythos 5.1).
//
// Exits 1 with `file:line: message` per hit; 0 (silent) when clean.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const PHRASES = [
  "verify twice",
  "double-check",
  "double check",
  "be maximally thorough",
  "think step by step",
  "use a scratchpad",
  "never forget",
];

const VOLATILE_PLACEHOLDER = /\{\{\s*(date|now|today|time|timestamp)\s*\}\}/i;

/** Every file under `dir` (relative to ROOT), or [] if `dir` doesn't exist. */
function walk(dir) {
  const abs = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs, { recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .map((e) => join(dir, e))
    .filter((p) => {
      try {
        return statSync(join(ROOT, p)).isFile();
      } catch {
        return false;
      }
    });
}

function targets() {
  const files = new Set();
  const seedPrompt = "seed/assistant-prompt.md";
  try {
    statSync(join(ROOT, seedPrompt));
    files.add(seedPrompt);
  } catch {}
  for (const f of walk("seed/agents")) if (f.endsWith(".md")) files.add(f);
  for (const root of ["skills", "plugins"]) {
    for (const f of walk(root)) if (f.endsWith("/SKILL.md") || f === `${root}/SKILL.md`) files.add(f);
  }
  // .claude/ holds this repo's own Claude Code skills and subagent definitions
  // (docs/ops/claude-assets.md). They are prompts like any other: a skill's
  // SKILL.md, the reference files it tells the model to read, and each agent's
  // system prompt.
  for (const f of walk(".claude/skills")) if (f.endsWith(".md")) files.add(f);
  for (const f of walk(".claude/agents")) if (f.endsWith(".md")) files.add(f);
  return [...files].sort();
}

let hits = 0;

for (const relPath of targets()) {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const phrase of PHRASES) {
      if (lower.includes(phrase)) {
        console.error(`${relPath}:${i + 1}: anti-pattern phrase "${phrase}" — cut it, it costs tokens for no accuracy gain (docs/research/2026-09-cost-optimization.md)`);
        hits++;
      }
    }
    if (VOLATILE_PLACEHOLDER.test(line)) {
      console.error(`${relPath}:${i + 1}: volatile placeholder in a system-prompt file — move it into the first user message of the turn, never the system prompt (breaks prompt caching)`);
      hits++;
    }
  });

  const allCapsAlways = text.match(/\bALWAYS\b/g) ?? [];
  if (allCapsAlways.length > 2) {
    console.error(`${relPath}: "ALWAYS" in caps used ${allCapsAlways.length} times — shouting is not a control; say it once or enforce it at the tool`);
    hits++;
  }
}

if (hits > 0) {
  console.error(`\nprompt-lint: ${hits} hit(s)`);
  process.exit(1);
}
