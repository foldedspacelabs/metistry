#!/usr/bin/env node
// PreToolUse hook (matcher Edit|Write|MultiEdit|NotebookEdit): an agent writes
// only inside a ticket worktree. Reads the hook JSON on stdin; exit 0 allows,
// exit 2 blocks and sends stderr to the model. The check is exact — `file_path`
// is structured input, not command text — but it is a guard for an agent that
// follows the brief, not a sandbox: a Bash `sed -i` goes around it (the Bash
// hook only reminds). See ops/claude/README.md.
//
// Allowed: a path inside a sibling of the main checkout named metistry-*
// (git worktrees: ../metistry-<ticket>), or inside the session scratch tree
// (<tmp>/claude-<uid>/…). Everything else is refused — the main checkout
// itself above all. Symlinks and `..` are resolved before comparing, and the
// comparison is case-insensitive (macOS volumes are).
//
// The owner's own sessions: METISTRY_GUARD_ALLOW=1 in the *session's*
// environment (set it in .claude/settings.local.json "env"; that file is
// gitignored and is read from the main checkout, which this very hook protects
// from agents). Command text cannot set it: a hook sees the harness's env.
//
// Exit codes: 0 allow · 2 refuse. A malformed input is refused too — a guard
// that fails open on garbage is not one.

import { realpathSync } from "node:fs";
import { dirname, basename, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PATH_TOOLS = new Map([
  ["Edit", "file_path"],
  ["Write", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);

/** realpath of the nearest existing ancestor, with the unresolved tail re-joined. */
export function canonical(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

const lower = (p) => p.toLowerCase();
const within = (child, root) => lower(child) === lower(root) || lower(child).startsWith(lower(root) + sep);

/** The main checkout: the parent of the shared git dir. */
export function mainCheckout(fromDir, env = process.env) {
  if (env.METISTRY_MAIN_CHECKOUT) return canonical(resolve(env.METISTRY_MAIN_CHECKOUT));
  for (const dir of [fromDir, dirname(fileURLToPath(import.meta.url))]) {
    try {
      const common = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (common) return canonical(dirname(common));
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** Where scratch files may go: <tmp>/claude-<uid>, for the tmp roots a session can see. */
export function scratchRoots(env = process.env) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "0";
  const roots = new Set();
  for (const base of ["/tmp", tmpdir(), env.TMPDIR].filter(Boolean)) roots.add(canonical(join(base, `claude-${uid}`)));
  return [...roots];
}

/** @returns {{ok: true} | {ok: false, why: string}} */
export function check(input, env = process.env) {
  if (env.METISTRY_GUARD_ALLOW === "1") return { ok: true };
  if (!input || typeof input !== "object") return { ok: false, why: "the hook input is not a JSON object" };
  if (typeof input.tool_name !== "string") return { ok: false, why: "the hook input has no tool_name" };
  const key = PATH_TOOLS.get(input.tool_name);
  if (!key) return { ok: true }; // not a file-writing tool: the matcher should not send it
  const raw = input.tool_input?.[key];
  if (typeof raw !== "string" || raw === "") return { ok: false, why: `the ${input.tool_name} call has no ${key}` };
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const target = canonical(resolve(cwd, raw));
  const main = mainCheckout(cwd, env);
  if (!main) return { ok: false, why: "cannot tell where the main checkout is (not in a git repository?)" };
  if (within(target, main)) {
    return { ok: false, why: `${target} is inside the main checkout (${main}). Work in your ticket worktree (../metistry-<id>), never the shared checkout.` };
  }
  const parent = dirname(main);
  if (lower(dirname(target)) !== lower(parent) && within(target, parent)) {
    const first = target.slice(parent.length + 1).split(sep)[0];
    if (lower(first).startsWith("metistry-")) return { ok: true };
  }
  for (const root of scratchRoots(env)) if (within(target, root)) return { ok: true };
  return { ok: false, why: `${target} is outside every ticket worktree (${parent}${sep}metistry-*) and the session scratch directory.` };
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    input = null;
  }
  const r = check(input);
  if (r.ok) process.exit(0);
  process.stderr.write(`guard-path: refused — ${r.why}\n(ops/claude/README.md; the owner's own sessions set METISTRY_GUARD_ALLOW=1.)\n`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
