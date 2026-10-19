#!/usr/bin/env node
// PreToolUse hook (matcher Bash): a REMINDER, not a control. It matches the text
// of the command an agent is about to run and refuses the things the agent brief
// forbids outright:
//   - `security`  against the login Keychain (no explicit non-login keychain file)
//   - `launchctl`, `caffeinate`, `pmset`
//   - anything naming the live ports: 5432 (Postgres), 8080 (console),
//     7810-7815 (the instance's services) — as host:port, `-p`/`--port`, or a
//     PORT=… assignment
// A text match is evaded by `sh -c "$(…)"`, a script, `osascript`, a variable. The
// real boundary is the OS (the Keychain ACL, a separate user, a sandbox profile);
// this hook only stops the honest mistake and leaves a trace in the transcript.
//
// Reads the hook JSON on stdin; exit 0 allows, exit 2 refuses (stderr goes to the
// model). METISTRY_GUARD_ALLOW=1 in the session's environment (not in the command)
// turns it off for the owner's own sessions.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORTS = "(?:5432|8080|781[0-5])";
const WORD = String.raw`[\w.\]-]`;

/** Drop here-document bodies so prose in a commit message or PR body is not "run". */
export function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (m) => m.slice(0, m.indexOf("\n")));
}

// A command word: at the start, after ; & | ( ` $( or a newline, optionally behind
// sudo/env/command/exec/nohup/time/xargs (and their flags) or `sh -c "`.
const LEAD = String.raw`(?:^|[;&|(\n\`]|\$\()\s*(?:\w+=\S*\s+|(?:sudo|env|command|exec|nohup|time|xargs|builtin)\s+(?:-\S+\s+|\w+=\S*\s+)*|(?:ba|z|da)?sh\s+-\w*c\s+['"]\s*)*(?:\S*/)?`;
const word = (name) => new RegExp(`${LEAD}${name}(?=\\s|$|;|&|\\|)`, "m");

const ALWAYS = ["launchctl", "caffeinate", "pmset"].map((n) => ({ name: n, re: word(n), why: `\`${n}\` is forbidden for agents (it changes the owner's machine).` }));
const SECURITY = word("security");

const KEYCHAIN_FILE = /(?:^|[\s='"])(\S*\.keychain(?:-db)?)(?=$|[\s'"])/g;

function securityRefused(cmd) {
  if (!SECURITY.test(cmd)) return false;
  // `security … /path/to/other.keychain-db` names a keychain that is not the login one.
  const named = [...cmd.matchAll(KEYCHAIN_FILE)].map((m) => m[1]);
  const nonLogin = named.length > 0 && named.every((p) => !/(^|\/)login\.keychain(-db)?$/i.test(p));
  return !nonLogin;
}

const PORT_FORMS = [
  new RegExp(String.raw`${WORD}:${PORTS}(?![\d])`), // host:port, [::1]:port, a URL
  new RegExp(String.raw`(?:^|\s)(?:-p|--port)(?:\s+|=)?${PORTS}(?![\d])`), // psql -p 5432, --port=8080
  new RegExp(String.raw`(?:^|[\s;&|"'])(?:\w*PORT)=["']?${PORTS}(?![\d])`, "i"), // PGPORT=5432, METISTRY_DB_PORT=…
  new RegExp(String.raw`\bport\s*=\s*${PORTS}(?![\d])`, "i"), // a libpq string: host=… port=5432
];

/** @returns {{ok: true} | {ok: false, why: string}} */
export function check(input, env = process.env) {
  if (env.METISTRY_GUARD_ALLOW === "1") return { ok: true };
  if (!input || typeof input !== "object") return { ok: false, why: "the hook input is not a JSON object" };
  if (typeof input.tool_name !== "string") return { ok: false, why: "the hook input has no tool_name" };
  if (input.tool_name !== "Bash") return { ok: true };
  const raw = input.tool_input?.command;
  if (typeof raw !== "string") return { ok: false, why: "the Bash call has no command" };
  const cmd = stripHeredocs(raw);
  for (const r of ALWAYS) if (r.re.test(cmd)) return { ok: false, why: r.why };
  if (securityRefused(cmd)) {
    return { ok: false, why: "`security` runs against the login Keychain unless the command names another keychain file. Agents never touch the login Keychain." };
  }
  for (const re of PORT_FORMS) {
    if (re.test(cmd)) return { ok: false, why: "the command names a live service port (5432 Postgres, 8080 console, 7810-7815 instance services). Use your own throwaway server on a free high port." };
  }
  return { ok: true };
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
  process.stderr.write(`guard-bash: refused — ${r.why}\n(A text match, a reminder rather than a control — ops/claude/README.md.)\n`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
