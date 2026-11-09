// The pack API an adapter uses (plan §2.23, X-112) — the whole of it:
//
//   findRemotePack(productDir, tool)   read-only; what `detect` asks
//   ensureRemotePack(ctx, tool)        fetch-if-absent; what `configure` asks
//   MANUAL_INSTALL[tool]               the sentence an adapter adds when the
//                                      pack cannot be fetched
//
// A pack is `<product>/runtime/remote/<tool>/`: bin/…, LICENSE, manifest.json
// (the tool's version, a sha256 per Mach-O, whether it was signed) and
// `.release` (the product release it came from). runtime-deps.ts owns how one
// gets there — resolve the release, checksums.txt, the pack's own manifest,
// swap in only once both held — and this file owns nothing but the two
// questions an adapter has. The adapters that consume it: X-106 (tailscale),
// X-108 (cloudflared), X-113 (zrok); X-115's relay client arrives as a fourth
// tool when its PoC lands.
//
// Nothing here runs at install or at `up`. `ensureRemotePack` is reached only
// from `metistry remote set <provider>` → the adapter's `configure`, so a
// provider the owner did not pick fetches nothing — the test for that is in
// packages/cli/test/remote-packs.test.ts, through `remoteSet` itself.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  installedRemotePackRelease,
  installRemotePack,
  readRemotePackManifest,
  remoteToolDir,
  type InstallRemotePackResult,
  type RemotePackManifest,
  type RemoteTool,
} from "../runtime-deps.js";
import { StepRunner } from "../steps.js";
import type { RemoteContext } from "./provider.js";

export type { RemoteTool } from "../runtime-deps.js";
export { REMOTE_TOOLS, isRemoteTool, remotePackAssetName, remoteToolDir } from "../runtime-deps.js";

/** A tool pack as an adapter sees it. */
export interface RemotePack {
  tool: RemoteTool;
  /** `<product>/runtime/remote/<tool>` */
  dir: string;
  /** the TOOL's version — what doctor's `tool present` row shows */
  version: string;
  /** the product release the pack came from */
  release: string | undefined;
  /** every Mach-O the pack ships, relative to `dir` — an adapter picks its binary by name here (`bin/tailscaled`, `bin/zrok` or `bin/zrok2`) */
  binaries: string[];
  signed: boolean;
  /** the absolute path of one of `binaries`, or undefined when the pack has no such file */
  bin: (relative: string) => string | undefined;
}

function toPack(tool: RemoteTool, dir: string, m: RemotePackManifest, release: string | undefined): RemotePack {
  const binaries = Object.keys(m.binaries ?? {}).sort();
  return {
    tool,
    dir,
    version: m.version ?? "?",
    release,
    binaries,
    signed: m.signed === true,
    bin: (relative) => (binaries.includes(relative) && existsSync(join(dir, relative)) ? join(dir, relative) : undefined),
  };
}

/** Read-only: the pack as it stands, or undefined when the tool's pack is not here. Never reaches the network. */
export async function findRemotePack(productDir: string, tool: RemoteTool): Promise<RemotePack | undefined> {
  const m = await readRemotePackManifest(productDir, tool);
  if (!m) return undefined;
  return toPack(tool, remoteToolDir(productDir, tool), m, await installedRemotePackRelease(productDir, tool));
}

/**
 * What an adapter says when the pack is not here and cannot be fetched — the
 * owner's own install of the tool, in the words the provider's page uses.
 * The adapter appends it to the pack's reason (`METISTRY_RUNTIME_DEPS=0 …`,
 * `release … carries no …`) so the sentence names both why and what instead.
 */
export const MANUAL_INSTALL: Record<RemoteTool, string> = {
  tailscale: "install Tailscale yourself — `brew install tailscale`, or the Tailscale app from tailscale.com/download and `metistry remote set tailscale --use-app`",
  cloudflared: "install cloudflared yourself — `brew install cloudflared`, or the darwin-arm64 release from github.com/cloudflare/cloudflared/releases",
  zrok: "install zrok yourself — the darwin_arm64 release from github.com/openziti/zrok/releases",
};

export type EnsureRemotePackResult =
  | { pack: RemotePack; fetched: boolean }
  | {
      pack: undefined;
      /** why there is no pack: `dry-run` (a preview fetches nothing), or runtime-deps.ts's reason */
      skipped: "dry-run" | NonNullable<InstallRemotePackResult["skipped"]>;
      /** the sentence, with the manual install appended where one applies */
      reason: string;
    };

/**
 * The pack, fetching it when it is absent — through the same resolve →
 * checksums.txt → unpack → manifest → swap path as every pack. Honours
 * `ctx.dryRun` (nothing is fetched; a pack already here is still reported),
 * `METISTRY_RUNTIME_DEPS=0` (nothing is fetched; the reason names the manual
 * install) and the no-downgrade rule. A corrupt download THROWS, as
 * `installRemotePack` does, so `configure` fails and the caller writes
 * nothing — `runtime/remote/` is as it was.
 */
export async function ensureRemotePack(
  ctx: Pick<RemoteContext, "productDir" | "env" | "fetchFn" | "exec" | "dryRun" | "note">,
  tool: RemoteTool,
  opts: { version?: string | undefined; target?: string | undefined; force?: boolean | undefined } = {},
): Promise<EnsureRemotePackResult> {
  const have = await findRemotePack(ctx.productDir, tool);
  if (have && !opts.force) return { pack: have, fetched: false };
  if (ctx.dryRun) {
    if (have) return { pack: have, fetched: false };
    return { pack: undefined, skipped: "dry-run", reason: `the ${tool} pack would be fetched from the release and verified (preview: nothing fetched)` };
  }
  const r = new StepRunner({ dryRun: false, out: (l) => ctx.note(l.replace(/^\s+/, "")), exec: ctx.exec, env: ctx.env });
  const res = await installRemotePack(r, { productDir: ctx.productDir, tool, fetchFn: ctx.fetchFn, env: ctx.env, version: opts.version, target: opts.target, force: opts.force });
  const now = await findRemotePack(ctx.productDir, tool);
  if (now) return { pack: now, fetched: res.installed };
  const manual = res.skipped === "off-network" || res.skipped === "no-asset" || res.skipped === "no-target" ? ` — ${MANUAL_INSTALL[tool]}` : "";
  return { pack: undefined, skipped: res.skipped ?? "no-asset", reason: `${res.reason ?? `no ${tool} pack`}${manual}` };
}
