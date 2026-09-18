// `metistry --version` / `metistry version` — every version number an
// install can be asked about, in one place, so the Mac app's Advanced pane
// (apps/macos/sources/kit/settings-view.swift: "There is no `metistry
// --version` to ask.") and `apps/macos/sources/kit/instance-files.swift`'s
// own `productVersion(inProductDir:)` package.json reader can both retire.
//
// Four numbers, each only as available as what resolved:
//   cli_version    this binary's own package.json (env.ts productVersion())
//                  — always known, no product dir or instance required.
//   product_version  the resolved product dir's OWN package.json (the
//                  checkout root, or a release's unpacked `current/`) — may
//                  differ from cli_version when the CLI running the command
//                  is not the one installed in that directory.
//   lock           metistry.lock's pin + channel, from the instance dir.
//   runtime_pack   metistry-runtime.json (release installs only) — version,
//                  commit and build time of the pack `metistry update`
//                  downloaded, read from wherever `current` points.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { instanceFile } from "@foldedspacelabs/metistry-core";
import { productVersion } from "./env.js";
import { readLock, type LockSource } from "./lock.js";
import { RUNTIME_PACK_MANIFEST } from "./release.js";
import { runDirFor } from "./up.js";

export interface VersionInfo {
  cli_version: string;
  product_version?: string;
  lock?: { version: string; channel: LockSource };
  runtime_pack?: { version: string; commit: string; built_at: string };
}

export interface VersionInfoOptions {
  productDir?: string | undefined;
  instanceDir?: string | undefined;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Everything reported; every field beyond `cli_version` is omitted, never guessed, when it does not resolve. */
export async function collectVersionInfo(opts: VersionInfoOptions): Promise<VersionInfo> {
  const info: VersionInfo = { cli_version: productVersion() };

  // the lock decides which dir `current` (release mode) or the checkout
  // itself (git mode) holds the product's own files — same rule `up` and
  // `service-control` use (up.ts runDirFor)
  let source: LockSource = "git";
  if (opts.instanceDir) {
    const lock = await readLock(instanceFile(opts.instanceDir, "lock")).catch(() => undefined);
    if (lock) {
      info.lock = { version: lock.product.version, channel: lock.product.source };
      source = lock.product.source;
    }
  }

  if (opts.productDir) {
    const runDir = runDirFor(opts.productDir, source);
    const pkg = await readJson(join(runDir, "package.json"));
    if (pkg && typeof pkg.version === "string" && pkg.version !== "") info.product_version = pkg.version;
    const pack = await readJson(join(runDir, RUNTIME_PACK_MANIFEST));
    if (pack && typeof pack.version === "string" && typeof pack.commit === "string" && typeof pack.built_at === "string") {
      info.runtime_pack = { version: pack.version, commit: pack.commit, built_at: pack.built_at };
    }
  }
  return info;
}

/** One line per number that resolved. */
export function renderVersionInfo(info: VersionInfo): string {
  const lines = [`cli: ${info.cli_version}`];
  if (info.product_version !== undefined) lines.push(`product: ${info.product_version}`);
  if (info.lock) lines.push(`lock: ${info.lock.version} (${info.lock.channel})`);
  if (info.runtime_pack) lines.push(`runtime pack: ${info.runtime_pack.version} (commit ${info.runtime_pack.commit.slice(0, 7)}, built ${info.runtime_pack.built_at})`);
  return lines.join("\n");
}
