// The `metistry` CLI shim — a stranger's PATH has no `metistry` on it (this
// product is neither a Homebrew formula nor an npm global), so `up` (and
// `update`, for the same reason — see its own call site) writes a tiny POSIX
// script that already knows the two absolute paths THIS install resolved:
// its product dir and, when there is one, its instance dir. Nothing else is
// baked in — which of `current/` (a release) or the bare product dir holds
// the CLI, and which node runs it, are re-checked on every invocation, so a
// release's `current` flip or a freshly bundled runtime need no re-write
// (invariant 7: no absolute paths baked in beyond what this install already
// knows).
//
// `up` never puts it on PATH itself (invariant 2 — that is the user's own
// hand): it only notes the one line that would (doctor.ts's `cli on PATH`
// row carries the same line as its remediation).
//
// `.metistry/state/cli/`, not `state/bin/`: under the launchd shape,
// `state/bin/Metistry` (capital M) is THIS SAME install's supervisor — a
// symlink to node, so System Settings shows "Metistry" rather than "node"
// (supervisor.ts's `supervisorBinPath`). macOS's default volume format is
// case-insensitive, so `bin/metistry` and `bin/Metistry` would be the SAME
// directory entry there — a real collision, caught by an early version of
// this file that put the shim in `state/bin/` too and, on that shape, simply
// never wrote it. A sibling directory removes the collision outright rather
// than working around it. `writeCliShim` still checks what is actually
// sitting at the path before writing — a symlink, or a file that does not
// look like a shim this module wrote — and leaves it alone: defence in
// depth, not the load-bearing fix.

import { existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { instanceStatePath } from "@foldedspacelabs/metistry-core";
import { CURRENT_LINK } from "./release.js";
import { RUNTIME_DIRNAME } from "./runtime-deps.js";
import type { StepRunner } from "./steps.js";

/** `<instanceDir-or-productDir>/.metistry/state/cli/metistry` (legacy layout: `state/cli/metistry`). */
export function cliShimPath(productDir: string, instanceDir: string | undefined): string {
  return instanceStatePath(instanceDir || productDir, "cli", "metistry");
}

/** `ln -s <shim> ~/.local/bin/metistry` — the one line `up` and doctor.ts both point at; never run for the operator (invariant 2). */
export function cliShimLinkHint(shimPath: string): string {
  return `ln -s ${shimPath} ~/.local/bin/metistry`;
}

const SHELL_UNSAFE = /["'`$\n]/;

/** The one line every version of this shim has always carried, second — the marker `writeCliShim` uses to tell "an old (or foreign) file" from "ours to refresh". */
const SHIM_MARKER = "# metistry — written by `metistry up`/`metistry update`;";

/** Does `content` look like a shim this module wrote (any version of it), rather than something else that happens to sit at the same path? */
function looksLikeOurShim(content: string): boolean {
  return content.startsWith("#!/bin/sh\n") && content.split("\n")[1] === SHIM_MARKER + " do not edit by hand,";
}

/**
 * The shim's content. `productDir` and `instanceDir` are embedded as the
 * `${VAR:-default}` fallback — an operator's own `METISTRY_PRODUCT_DIR` (or
 * `METISTRY_INSTANCE_DIR`) still wins, exactly as the hand-written reference
 * shim (`~/.local/bin/metistry`, written 2026-09-19) already does.
 *
 * Throws when either path contains a character the script cannot safely
 * embed — a refusal, not a mangled script; `writeCliShim` turns it into a
 * note rather than letting it fail the whole `up`/`update` run.
 */
export function renderCliShim(productDir: string, instanceDir: string | undefined): string {
  const paths: Array<[string, string]> = [["product dir", productDir]];
  if (instanceDir) paths.push(["instance dir", instanceDir]);
  for (const [what, value] of paths) {
    if (SHELL_UNSAFE.test(value)) {
      throw new Error(`refusing to write a cli shim: the ${what} ${JSON.stringify(value)} has a shell-unsafe character (" ' \` $ or a newline) the shim's script cannot safely embed`);
    }
  }
  const lines = [
    "#!/bin/sh",
    `${SHIM_MARKER} do not edit by hand,`,
    "# it is regenerated (and left alone when unchanged) on every run. Never put",
    "# on PATH for you (invariant 2 — that is the user's own hand):",
    `#   ${cliShimLinkHint("$0")}`,
    `export METISTRY_PRODUCT_DIR="\${METISTRY_PRODUCT_DIR:-${productDir}}"`,
  ];
  if (instanceDir) lines.push(`export METISTRY_INSTANCE_DIR="\${METISTRY_INSTANCE_DIR:-${instanceDir}}"`);
  lines.push(
    `NODE="$METISTRY_PRODUCT_DIR/${RUNTIME_DIRNAME}/node/bin/node"`,
    `[ -x "$NODE" ] || NODE="$(command -v node)" || { echo "metistry: no node found ($METISTRY_PRODUCT_DIR/${RUNTIME_DIRNAME}/node/bin/node, and none on PATH)" >&2; exit 1; }`,
    `MAIN="$METISTRY_PRODUCT_DIR/${CURRENT_LINK}/packages/cli/dist/main.js"`,
    `[ -f "$MAIN" ] || MAIN="$METISTRY_PRODUCT_DIR/packages/cli/dist/main.js"`,
    `[ -f "$MAIN" ] || { echo "metistry: CLI not found under $METISTRY_PRODUCT_DIR (looked in ${CURRENT_LINK}/packages/cli/dist and packages/cli/dist)" >&2; exit 1; }`,
    `exec "$NODE" "$MAIN" "$@"`,
    "",
  );
  return lines.join("\n");
}

/**
 * Write (or refresh) the shim, idempotently: unchanged content is left
 * alone (no write, no chmod). Two things already sitting at the path are
 * ALSO left alone, noted rather than clobbered: a symlink (nothing this
 * module ever writes is one), and a plain file that does not look like a
 * shim this module wrote (`looksLikeOurShim`) — either way, something else
 * put it there and it is not this verb's place to guess what. Runs
 * regardless of whether the rest of `up`/`update` succeeded: it costs
 * nothing, and it is what lets the operator run the next `metistry` BY NAME
 * even after a failed step.
 */
export async function writeCliShim(r: StepRunner, productDir: string, instanceDir: string | undefined): Promise<void> {
  const path = cliShimPath(productDir, instanceDir);
  // lstat, not existsSync: a symlink whose TARGET does not exist is exactly
  // the case that matters here — existsSync follows the link and would
  // report "nothing here", walking straight into whatever it points at on
  // the write below.
  try {
    const st = lstatSync(path);
    if (!st.isFile()) {
      r.note(`cli: ${path} already exists and is not a plain file (a symlink, most likely) — left alone; \`metistry doctor\` says whether \`metistry\` is reachable another way`);
      return;
    }
  } catch {
    /* nothing at all sitting there yet — fine, about to write it */
  }

  let content: string;
  try {
    content = renderCliShim(productDir, instanceDir);
  } catch (err) {
    r.note(`cli: not written — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const before = existsSync(path) ? await readFile(path, "utf8").catch(() => undefined) : undefined;
  if (before !== undefined && !looksLikeOurShim(before)) {
    r.note(`cli: ${path} already exists and is not a shim this install wrote — left alone rather than overwritten`);
    return;
  }
  if (before === content) {
    r.note(`cli: ${path} unchanged — \`${cliShimLinkHint(path)}\` (or add its directory to PATH) runs \`metistry\` by name`);
    return;
  }
  await r.write(path, content, "metistry up/update — a shim onto this install's own node and cli");
  await r.run("chmod", ["755", path], { comment: "the cli shim" });
  r.note(`cli: ${path} — \`${cliShimLinkHint(path)}\` (or add its directory to PATH) runs \`metistry\` by name`);
}
