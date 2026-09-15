#!/usr/bin/env node
// Install this plugin's `sessionEnd` hook into Cursor's user hooks file.
//
// The schema is Cursor's, verified against cursor.com/docs/hooks (fetched
// 2026-09-15): `~/.cursor/hooks.json`, `"version": 1` ("Config schema version.
// Must be a positive integer (use 1)"), and `hooks` mapping a hook name to an
// ARRAY of definitions — `"sessionEnd": [{ "command": "./audit.sh" }]` — with
// per-script `timeout` (seconds), `failClosed`, `matcher` and `type`. Note the
// shape is flatter than Claude Code's, which nests a `hooks` array inside each
// matcher group; Cursor maps `SessionEnd` → `sessionEnd` when it loads
// `~/.claude/settings.json`, but a native entry needs the native shape.
//
// Every other hook in the file belongs to another tool: merge, never rewrite.
// Re-running is a no-op, and an entry left behind by an older checkout is
// replaced rather than duplicated.
//
// This lives here, not in `packages/cli/src/connect.ts`, because the plugin
// owns its own installation — `metistry connect cursor` only has to call it:
//
//   node <plugin dir>/install.mjs --json      # { file, state, command, … }
//
// which is the seam W3's verb picks up (docs/ops/cursor.md, "Session capture").

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_EVENT = "sessionEnd";
export const CONFIG_REL = [".cursor", "hooks.json"];
/** Cursor's `sessionEnd` is fire-and-forget; the cap matches the hook's own 8 s request budget plus start-up. */
export const TIMEOUT_SECONDS = 10;
/** What identifies a previous install, from any checkout path. */
export const HOOK_MARKER = "plugins/cursor/hooks/session-end.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function configFile(home = homedir()) {
  return join(home, ...CONFIG_REL);
}

/** The absolute path Cursor runs. The script carries a `#!/usr/bin/env node` shebang and the mode bit, so it needs no interpreter prefix. */
export function hookScript(root = HERE) {
  return join(root, "hooks", "session-end.mjs");
}

export function isOurs(entry) {
  return !!entry && typeof entry === "object" && typeof entry.command === "string" && entry.command.includes(HOOK_MARKER);
}

/**
 * Merge (or remove) our one entry, preserving everything else and its order.
 * Returns the next document; pure, so the tests assert on it directly.
 */
export function mergeHook(doc, command, { remove = false, timeout = TIMEOUT_SECONDS } = {}) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("hooks.json does not hold a JSON object");
  const hooks = doc.hooks ?? {};
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error(`hooks.json's "hooks" is not an object — refusing to replace it`);
  const existing = hooks[HOOK_EVENT] ?? [];
  if (!Array.isArray(existing)) throw new Error(`hooks.json's "hooks.${HOOK_EVENT}" is not an array — refusing to replace it`);

  const ours = { command, timeout };
  const others = existing.filter((e) => !isOurs(e));
  let next;
  if (remove) {
    next = others;
  } else {
    // Keep our slot where a previous install put it, so re-running does not
    // reorder another tool's hooks.
    const at = existing.findIndex(isOurs);
    next = at === -1 ? [...others, ours] : [...others.slice(0, at), ours, ...others.slice(at)];
  }

  const nextHooks = { ...hooks };
  if (next.length === 0) delete nextHooks[HOOK_EVENT];
  else nextHooks[HOOK_EVENT] = next;
  // Cursor requires `version`; an existing value is left alone (a future
  // schema is Cursor's business, not this installer's).
  return { ...doc, version: typeof doc.version === "number" && Number.isInteger(doc.version) && doc.version > 0 ? doc.version : 1, hooks: nextHooks };
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  const before = readFileSync(file, "utf8");
  if (before.trim() === "") return {};
  try {
    return JSON.parse(before);
  } catch (err) {
    throw new Error(`${file} is not JSON this installer can merge into (${err instanceof Error ? err.message : String(err)}) — fix it, or add the entry by hand`);
  }
}

/** Write the merged file. Returns `{ file, state, command, entry }`; `state` is "written" or "unchanged". */
export function installHook({ file = configFile(), command = hookScript(), remove = false, timeout = TIMEOUT_SECONDS } = {}) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = mergeHook(readConfig(file), command, { remove, timeout });
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === before) return { file, state: "unchanged", command, entry: { command, timeout } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  return { file, state: "written", command, entry: { command, timeout } };
}

// ---- cli ---------------------------------------------------------------------

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node install.mjs [--remove] [--json] [--home <dir>]\n\nMerges (or removes) the metistry sessionEnd hook in ~/.cursor/hooks.json.");
    return 0;
  }
  const home = arg(argv, "--home");
  const remove = argv.includes("--remove");
  const file = home ? configFile(home) : configFile();
  const r = installHook({ file, remove });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...r, event: HOOK_EVENT, enabled_by: "METISTRY_CAPTURE_ON_STOP=1", removed: remove }, null, 2));
    return 0;
  }
  const what = remove ? "removed from" : `${r.state === "written" ? "installed in" : "already in"}`;
  console.log(`metistry: ${HOOK_EVENT} hook ${what} ${r.file}`);
  if (!remove) {
    // Cursor's own docs describe `command` as "a shell string, an absolute
    // path, or a relative path". A bare absolute path works under either
    // reading; one with a space in it may not, and this installer will not
    // guess which quoting Cursor applies.
    if (/[\s"'$`\\]/.test(r.command)) console.log(`metistry: warning — this checkout's path contains a character a shell would need quoted:\n  ${r.command}\n  If the hook does not fire, check Cursor's Hooks output channel and set the command by hand.`);
    console.log("metistry: it stays inert until METISTRY_CAPTURE_ON_STOP=1 is in Cursor's environment. Restart Cursor to pick up the config.");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`metistry: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
