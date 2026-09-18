// Writing a §4.7 protected file in the instance repo — `metistry.lock`,
// `identity.yaml`. The reconciler is the instance repo's sole committer
// (D5), so when a bridge is configured the write goes through it as the
// `user` principal, which is the only principal allowed to change how the
// system behaves (invariant 2). Extracted from `update`'s writeLock so
// `secrets`/`up` can mint `instance_id` into identity.yaml the same way.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { INSTANCE_LAYOUT, resolveInstanceLayout, type InstancePathKey } from "@foldedspacelabs/metistry-core";
import { hostLocal } from "./doctor.js";
import { StepFailed, type StepRunner } from "./steps.js";

export const RECONCILER_LABEL = "com.foldedspacelabs.metistry.reconciler";

/**
 * The instance-relative path a protected write posts, spelled the way THIS
 * instance spells it.
 *
 * The readers resolve the layout (core's `resolveInstanceLayout`), so a
 * writer that posted the flat spelling onto a legacy instance would land a
 * SECOND `.metistry/identity.yaml` beside the live root one and the reader
 * would go on reading the old file: the verb would report success and change
 * nothing. Without an instance directory there is nothing to detect and the
 * flat spelling is the only answer.
 */
export function protectedRel(instanceDir: string | undefined, key: InstancePathKey): string {
  return instanceDir ? resolveInstanceLayout(instanceDir).layout[key] : INSTANCE_LAYOUT[key];
}

export interface ProtectedWriteOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
  /** default: `METISTRY_INSTANCE_DIR` */
  instanceDir?: string | undefined;
}

export interface ProtectedWrite {
  how: "bridge" | "direct" | "none";
  detail: string;
}

/**
 * Where the content goes. With a reconciler bridge configured: through it,
 * as `user`. Without one, a LOCAL instance dir is written directly only
 * when no reconciler job is running — a running reconciler would sweep the
 * edit as an out-of-band change, which is fine, but a running one with no
 * URL configured is a misconfiguration the operator should fix, not
 * something to write around.
 */
export async function writeProtected(r: StepRunner, rel: string, content: string, message: string, opts: ProtectedWriteOptions): Promise<ProtectedWrite> {
  const url = opts.env.METISTRY_RECONCILER_URL;
  const raw = opts.instanceDir ?? opts.env.METISTRY_INSTANCE_DIR;
  const dir = raw ? raw.replace(/\/+$/, "") : undefined;

  if (url) {
    const base = hostLocal(url);
    const token = opts.env.METISTRY_BRIDGE_TOKEN_RECONCILER;
    if (!token) throw new StepFailed(`METISTRY_RECONCILER_URL is set but METISTRY_BRIDGE_TOKEN_RECONCILER is not — ${rel} cannot be written through the bridge`);
    const shown = `POST ${base}/vault/write ${rel} (principal user, "${message}")`;
    if (!r.action(shown)) return { how: "bridge", detail: "the reconciler commits it on its next flush (it is the instance repo's sole committer)" };
    let res: Response;
    try {
      res = await opts.fetchFn(`${base}/vault/write`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: rel, content, intent: { principal: "user", message } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new StepFailed(`reconciler bridge at ${base} did not answer (${err instanceof Error ? err.message : String(err)}) — start it (launchctl kickstart -k gui/${opts.uid}/${RECONCILER_LABEL}) and rerun; ${rel} was NOT written`);
    }
    if (!res.ok) {
      let why = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error) why = `${body.error.code ?? res.status}: ${body.error.message ?? ""}`.trim();
      } catch {
        /* no envelope */
      }
      throw new StepFailed(`reconciler refused the ${rel} write (${why}) — ${rel} was NOT written`);
    }
    return { how: "bridge", detail: `${rel} written through the reconciler as user — committed on its next flush` };
  }

  if (dir && existsSync(dir)) {
    if (opts.platform === "darwin" && !r.dryRun) {
      const probe = await r.exec("launchctl", ["print", `gui/${opts.uid}/${RECONCILER_LABEL}`]);
      if (probe.code === 0 && /^\s*state = running/m.test(probe.stdout)) {
        throw new StepFailed(`a reconciler job is running but METISTRY_RECONCILER_URL is unset — add it (and METISTRY_BRIDGE_TOKEN_RECONCILER) to .env so this writes ${rel} through the bridge; refusing to write behind the sole committer`);
      }
    }
    const path = join(dir, rel);
    await r.write(path, content, `${message}; no reconciler bridge configured, so written directly — a reconciler, once installed, sweeps it into a user commit`);
    return { how: "direct", detail: `${path} written directly (no reconciler configured)` };
  }

  return { how: "none", detail: "no instance dir" };
}
