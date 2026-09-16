#!/usr/bin/env node
// Install this plugin into OpenCode's global plugin directory.
//
// The shape is OpenCode's, verified against opencode.ai/docs/plugins (fetched
// 2026-09-16) and against a running OpenCode 1.18.30 on the same day:
//
//   * plugins are loaded from `~/.config/opencode/plugins/` (global) and
//     `.opencode/plugins/` (project). The config directory follows
//     XDG_CONFIG_HOME when it is set (`opencode debug paths` confirms it).
//   * the loader picks up `.js` and `.ts` files. A `.mjs` in the same
//     directory is NOT loaded — checked both ways — which is why what gets
//     linked is `plugin.js`.
//   * a SYMLINK is fine: Bun resolves it to the real path before importing, so
//     the plugin's own `./scripts/lib.mjs` import resolves inside the checkout.
//     That is what makes this an install rather than a copy — `git pull` is
//     then the update, with nothing to re-run.
//
// The directory is shared with every other plugin the owner has: this touches
// exactly one entry, refuses to overwrite a file it did not create, and
// `--remove` takes it back out.
//
// `metistry connect opencode` writes the `mcp:` block and leaves this alone;
// the two halves are independent on purpose (the MCP server is how OpenCode
// reads the vault, this is how a finished session gets written down).
//
//   node <plugin dir>/install.mjs --json   → { file, state, target, … }

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The name this plugin takes in a directory full of other people's plugins. */
export const PLUGIN_FILENAME = "metistry.js";
/** The documented plugin directory, relative to the OpenCode config directory. */
export const PLUGIN_DIR = "plugins";
/** What identifies an install of ours, from any checkout path. */
export const PLUGIN_MARKER = "plugins/opencode/plugin.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** OpenCode's config directory: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function configDir(home = homedir(), env = process.env) {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  return xdg ? join(xdg, "opencode") : join(home, ".config", "opencode");
}

export function pluginDir(home = homedir(), env = process.env) {
  return join(configDir(home, env), PLUGIN_DIR);
}

/** The file in the checkout that OpenCode ends up importing. */
export function pluginModule(root = HERE) {
  return join(root, "plugin.js");
}

/** Is this path a link of ours (this checkout's, or one a moved checkout left behind)? */
export function isOurs(file) {
  try {
    if (!lstatSync(file).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  try {
    return readlinkSync(file).endsWith(PLUGIN_MARKER);
  } catch {
    return false;
  }
}

/**
 * Link (or unlink) this plugin. Returns `{ file, state, target }`; `state` is
 * "linked", "unchanged" or "removed". Anything at that path which is not one of
 * our links is an error, never a clobber.
 */
export function installPlugin({ dir = pluginDir(), target = pluginModule(), remove = false } = {}) {
  const file = join(dir, PLUGIN_FILENAME);
  const there = existsSync(file) || isOurs(file); // isOurs also catches a dangling link
  if (there && !isOurs(file)) {
    throw new Error(`${file} already exists and was not put there by this installer — move it aside, or install by hand into ${dir}`);
  }
  if (remove) {
    if (!there) return { file, state: "unchanged", target, removed: true };
    unlinkSync(file);
    return { file, state: "removed", target, removed: true };
  }
  if (there && readlinkSync(file) === target) return { file, state: "unchanged", target, removed: false };
  if (there) unlinkSync(file); // a checkout that has since moved: repoint it
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, file);
  return { file, state: "linked", target, removed: false };
}

// ---- cli ---------------------------------------------------------------------

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "usage: node install.mjs [--remove] [--json] [--home <dir>] [--dir <plugin dir>]",
        "",
        `Links ${PLUGIN_FILENAME} into OpenCode's global plugin directory (~/.config/opencode/${PLUGIN_DIR}/,`,
        "or $XDG_CONFIG_HOME/opencode/plugins). --remove takes it back out.",
      ].join("\n"),
    );
    return 0;
  }
  // An explicit --home is exactly that: XDG_CONFIG_HOME does not get to
  // redirect it, which is what makes it usable as a test seam.
  const home = arg(argv, "--home");
  const dir = arg(argv, "--dir") ?? (home ? pluginDir(home, {}) : pluginDir());
  const remove = argv.includes("--remove");
  const r = installPlugin({ dir, remove });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...r, event: "session.idle", enabled_by: "METISTRY_CAPTURE_ON_STOP=1" }, null, 2));
    return 0;
  }
  console.log(`metistry: plugin ${remove ? (r.state === "removed" ? "removed from" : "was not in") : r.state === "linked" ? "linked into" : "already in"} ${dirname(r.file)}`);
  if (!remove) {
    console.log(`metistry:   ${r.file} → ${r.target}`);
    console.log("metistry: it stays inert until METISTRY_CAPTURE_ON_STOP=1 is in OpenCode's environment. A running OpenCode picks it up on its next start.");
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
