#!/usr/bin/env node
// CLI for the metistry-capture skill. Usage:
//   node capture.mjs --kind decision|finding|note --title "<title>" [--body "<text>" | --body-file <path>]
// Body falls back to stdin when neither flag is given. Prints one line;
// exit 1 on failure. The token never appears in output.
import { readFileSync } from "node:fs";
import { capture, config, redact } from "../../../scripts/lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "help") return { help: true };
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    out[key] = val;
  }
  return out;
}

const usage = `usage: capture.mjs --kind decision|finding|note --title "<title>" [--body "<text>" | --body-file <path>]
  env: METISTRY_URL, METISTRY_OWNER_TOKEN (required); body read from stdin when no --body/--body-file`;

const { token } = config();
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    process.exit(0);
  }
  let body = args.body;
  if (body === undefined && args["body-file"]) body = readFileSync(args["body-file"], "utf8");
  if (body === undefined && !process.stdin.isTTY) body = readFileSync(0, "utf8");
  const result = await capture({ kind: args.kind ?? "note", title: args.title ?? "", body: body ?? "" });
  console.log(`captured → inbox #${result.id} (${result.path})`);
} catch (err) {
  console.error(`metistry-capture: ${redact(err?.message ?? err, token)}`);
  console.error(usage);
  process.exit(1);
}
