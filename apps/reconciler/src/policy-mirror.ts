// The secrets policy mirror (X-7; the owner's ruling of 2026-09-30).
//
// Under the compose shape the console and assistant containers read a
// provider key's grant from `secrets.yaml`, and they must see a REVOKE on
// the next call. A single-file bind mount pins an inode that every writer
// replaces by rename, so compose mounts a directory instead —
// `<instance>/.metistry/state/policy/`, which holds nothing but a copy of
// the policy — and this loop keeps that copy current (core's
// `mirrorSecretsPolicy`). The reconciler runs it because it is the one
// long-lived host process that sees the instance under every shape; a CLI
// verb, a hand edit and a pull all reach the mirror within one interval.
//
// Never fails the reconciler: an error is logged once until it changes,
// and the next tick tries again.

import { mirrorSecretsPolicy, SECRETS_MIRROR_INTERVAL_MS, type MirrorOutcome } from "@foldedspacelabs/metistry-core";

export interface PolicyMirrorOptions {
  intervalMs?: number | undefined;
  /** test seam — core's mirror by default */
  mirror?: ((instanceDir: string) => Promise<MirrorOutcome>) | undefined;
  log?: ((line: string) => void) | undefined;
}

/** Mirror now, then every interval. Returns the stop function and the first run's promise. */
export function startPolicyMirror(instanceDir: string, opts: PolicyMirrorOptions = {}): { stop: () => void; first: Promise<void> } {
  const mirror = opts.mirror ?? mirrorSecretsPolicy;
  const log = opts.log ?? ((l: string) => console.log(l));
  let lastError: string | undefined;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // a slow disk never stacks ticks
    running = true;
    try {
      const outcome = await mirror(instanceDir);
      if (outcome === "written" || outcome === "removed") log(`reconciler: secrets policy mirror ${outcome} (.metistry/state/policy/secrets.yaml)`);
      lastError = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastError) log(`reconciler: secrets policy mirror failed — compose containers keep the last mirrored policy until it succeeds: ${msg}`);
      lastError = msg;
    } finally {
      running = false;
    }
  };
  const first = tick();
  const timer = setInterval(() => void tick(), opts.intervalMs ?? SECRETS_MIRROR_INTERVAL_MS);
  return { stop: () => clearInterval(timer), first };
}
