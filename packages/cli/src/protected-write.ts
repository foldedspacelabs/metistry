// Writing a §4.7 protected file in the instance repo — `metistry.lock`,
// `identity.yaml`. The reconciler is the instance repo's sole committer
// (D5), so when a bridge is configured the write goes through it as the
// `user` principal, which is the only principal allowed to change how the
// system behaves (invariant 2). Extracted from `update`'s writeLock so
// `secrets`/`up` can mint `instance_id` into identity.yaml the same way.
//
// **This file is the owner class.** Since 2026-09-20 the reconciler decides
// what a caller may write from the BEARER it presents, not from the
// `principal` in its body (apps/reconciler/src/paths.ts), and the bearer that
// carries authority over `.metistry/` is
// `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` — minted for the CLI, kept out of
// the console's environment (`consoleEnv`'s denylist in deployment.ts), and
// reachable here because the CLI runs as the person whose login Keychain and
// 0600 `.env` hold it. The console's own bearer is refused on these paths
// now, whatever principal it claims to be.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { INSTANCE_LAYOUT, mintToken, resolveInstanceLayout, type InstancePathKey } from "@foldedspacelabs/metistry-core";
import { hostLocal } from "./doctor.js";
import { withEnvLine } from "./postgres.js";
import { adoptOrMintSecret } from "./secrets.js";
import { StepFailed, type StepRunner } from "./steps.js";

export const RECONCILER_LABEL = "com.foldedspacelabs.metistry.reconciler";

/**
 * The owner-class bearer for the vault bridge: the one credential that may
 * write a §4.7 protected path (apps/reconciler/src/paths.ts's authority
 * table). Named here because the three places that care — the writer below,
 * the minting step, and `consoleEnv`'s denylist — must spell it identically.
 */
export const OWNER_BRIDGE_TOKEN = "METISTRY_BRIDGE_TOKEN_RECONCILER_USER";

export interface EnsureOwnerTokenOptions {
  /** The install's environment. Mutated on success, so the same run can use what it just minted. */
  env: NodeJS.ProcessEnv;
  /** The dotenv file this install runs from (`<instance>/.metistry/state/.env`). */
  envFile: string | undefined;
  platform: NodeJS.Platform;
  /** This instance's `instance_id`, when it is already known — the Keychain account instance-scoped secrets are filed under. */
  instanceId?: string | undefined;
  /** test seam */
  mint?: (() => string) | undefined;
}

export interface EnsureOwnerTokenResult {
  minted: boolean;
  /**
   * `.env` gained the bearer in this run — minted, or adopted from this
   * instance's Keychain item. Either way a reconciler started before this
   * run does not hold it until it is restarted.
   */
  changed: boolean;
  /** One line for the plan: what happened, and never the value. */
  detail: string;
}

/** The exact commands that finish what a failed mint could not, in the order to run them. */
export const OWNER_BRIDGE_TOKEN_FIX = [`metistry secrets mint ${OWNER_BRIDGE_TOKEN}`, "metistry restart reconciler"] as const;

/**
 * `ensureOwnerBridgeToken` could not put the bearer anywhere — the Keychain
 * refused, or `.env` could not be written. A StepFailed, so `up` stops on it
 * as before; `update` catches exactly this one and finishes its restart
 * without the bearer rather than leaving every job on the old code.
 */
export class OwnerTokenMintFailed extends StepFailed {
  constructor(
    message: string,
    /** what the Keychain (or the filesystem) said — the part worth repeating in a summary */
    readonly reason: string,
  ) {
    super(message);
  }
}

/**
 * Give this install `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` if it has none.
 *
 * It is the migration, and it is why an existing install does not have to be
 * told anything: `metistry up` and `metistry update` both call this BEFORE
 * they restart the reconciler and before they write a protected path, so the
 * job that comes back up is the one holding the new bearer. `metistry secrets
 * sync --to env` mints it too (`GENERATED_SECRETS`) for an install that runs
 * neither.
 *
 * On macOS the login Keychain is the canonical store, so it is READ first:
 * when this instance's item already exists, that value is written into
 * `.env` and nothing is minted (`adoptOrMintSecret`). Only when the Keychain
 * has none is one minted into both — so a later `secrets sync --to env`
 * regenerates the same value rather than rotating it behind the reconciler's
 * back. Elsewhere `.env` IS the store (`metistry secrets` says so), and the
 * line is appended exactly as `up` appends the generated Postgres password.
 */
export async function ensureOwnerBridgeToken(r: StepRunner, opts: EnsureOwnerTokenOptions): Promise<EnsureOwnerTokenResult> {
  if (opts.env[OWNER_BRIDGE_TOKEN]) return { minted: false, changed: false, detail: `${OWNER_BRIDGE_TOKEN}: already set — the owner class is this install's CLI` };
  if (!opts.envFile) return { minted: false, changed: false, detail: `${OWNER_BRIDGE_TOKEN} is unset and there is no .env to mint it into — protected paths stay unwritable (docs/ops/auth.md)` };
  const darwin = opts.platform === "darwin";
  const shown = darwin
    ? `mint ${OWNER_BRIDGE_TOKEN} into the login Keychain and ${opts.envFile} — or, when this instance's Keychain item already exists, copy that one into ${opts.envFile} (the bearer that may write .metistry/; never shown)`
    : `mint ${OWNER_BRIDGE_TOKEN} into ${opts.envFile} (the bearer that may write .metistry/; never shown)`;
  // A dry run reaches nothing and mints nothing — and must not mutate the
  // environment it was handed, which is `process.env` when the CLI is the
  // caller (the test-isolation guard catches exactly that).
  if (!r.action(shown)) return { minted: false, changed: false, detail: `${OWNER_BRIDGE_TOKEN} would be ${darwin ? "copied from the Keychain, or minted" : "minted"}` };
  let value: string;
  let how: "adopted" | "minted";
  try {
    if (darwin) {
      ({ value, how } = await adoptOrMintSecret(OWNER_BRIDGE_TOKEN, {
        envFile: opts.envFile,
        ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
        exec: r.exec,
        out: (l) => r.note(l),
        platform: opts.platform,
        env: opts.env,
        ...(opts.mint ? { mint: opts.mint } : {}),
      }));
    } else {
      value = (opts.mint ?? mintToken)();
      how = "minted";
      const current = existsSync(opts.envFile) ? await readFile(opts.envFile, "utf8") : "";
      const next = withEnvLine(current, OWNER_BRIDGE_TOKEN, value, "the vault bridge's OWNER bearer: the one credential that may write .metistry/ (docs/ops/auth.md). Minted by `metistry up`; never printed.");
      if (next) await r.write(opts.envFile, next, "the owner-class bridge bearer", 0o600);
    }
  } catch (err) {
    // A Keychain that will not answer is a step failure with a remediation,
    // not a stack trace out of `metistry update`.
    const reason = err instanceof Error ? err.message : String(err);
    throw new OwnerTokenMintFailed(
      `could not mint ${OWNER_BRIDGE_TOKEN} (${reason}) — without it no caller may write a §4.7 protected path; run ${OWNER_BRIDGE_TOKEN_FIX.map((c) => `\`${c}\``).join(", then ")} (docs/ops/auth.md)`,
      reason,
    );
  }
  opts.env[OWNER_BRIDGE_TOKEN] = value;
  return {
    minted: how === "minted",
    changed: true,
    detail:
      how === "adopted"
        ? `${OWNER_BRIDGE_TOKEN} copied from this instance's Keychain item into .env — restart the reconciler for it to take effect (it reads .env at start)`
        : `${OWNER_BRIDGE_TOKEN} minted — restart the reconciler for it to take effect (it reads .env at start)`,
  };
}

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
  /**
   * Create the file only if it is absent — never replace one that is there.
   * Through the bridge this is the reconciler's own compare-and-swap
   * (`expected_sha256: ""`, refused as `conflict` when a file exists), so a
   * file that appears between the caller's look and the write is still kept;
   * directly, the same check on disk. A kept file comes back `kept: true`.
   */
  createOnly?: boolean | undefined;
}

export interface ProtectedWrite {
  how: "bridge" | "direct" | "none";
  detail: string;
  /** `createOnly` found a file already there and left it exactly as it was — nothing was written */
  kept?: true;
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
    const shown = `POST ${base}/vault/write ${rel} (principal user, "${message}")`;
    // The plan first: a dry run reaches nothing, so it must not depend on a
    // credential either — `up --dry-run` on an install that has not minted
    // the owner bearer yet still prints the plan that would mint it.
    if (!r.action(shown)) return { how: "bridge", detail: "the reconciler commits it on its next flush (it is the instance repo's sole committer)" };
    // Whichever bearer THIS process holds, and the bridge decides what it may
    // write (docs/ops/auth.md). The CLI holds the owner one; the console —
    // which calls this same function for its two enumerated compute writes —
    // holds only the shared one and is refused on everything else. Choosing
    // here rather than enforcing here is the point: a caller cannot widen
    // itself by picking a different variable name.
    const owner = opts.env[OWNER_BRIDGE_TOKEN];
    const token = owner ?? opts.env.METISTRY_BRIDGE_TOKEN_RECONCILER;
    if (!token) {
      throw new StepFailed(
        `METISTRY_RECONCILER_URL is set but neither ${OWNER_BRIDGE_TOKEN} nor METISTRY_BRIDGE_TOKEN_RECONCILER is — ${rel} cannot be written through the bridge`,
      );
    }
    let res: Response;
    try {
      res = await opts.fetchFn(`${base}/vault/write`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: rel, content, intent: { principal: "user", message }, ...(opts.createOnly ? { expected_sha256: "" } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new StepFailed(`reconciler bridge at ${base} did not answer (${err instanceof Error ? err.message : String(err)}) — start it (launchctl kickstart -k gui/${opts.uid}/${RECONCILER_LABEL}) and rerun; ${rel} was NOT written`);
    }
    // create-only: the reconciler's compare-and-swap found a file there — it is kept, byte for byte
    if (opts.createOnly && res.status === 409) return { how: "bridge", kept: true, detail: `${rel} is already in the vault — kept as it is` };
    if (!res.ok) {
      let why = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error) why = `${body.error.code ?? res.status}: ${body.error.message ?? ""}`.trim();
      } catch {
        /* no envelope */
      }
      // Two refusals have a specific cause worth naming, because both are
      // the credential split rather than anything about the content.
      const hint =
        res.status === 401
          ? ` — the reconciler was started before ${OWNER_BRIDGE_TOKEN} reached its environment; \`metistry restart reconciler\` and rerun`
          : res.status === 403 && !owner
            ? ` — this process holds only the console's shared bearer, and ${rel} is a §4.7 protected path the owner class alone may write; mint ${OWNER_BRIDGE_TOKEN} with \`metistry secrets sync --to env\` and restart the reconciler (docs/ops/auth.md)`
            : "";
      throw new StepFailed(`reconciler refused the ${rel} write (${why})${hint} — ${rel} was NOT written`);
    }
    return { how: "bridge", detail: `${rel} written through the reconciler as user — committed on its next flush` };
  }

  if (dir && existsSync(dir)) {
    if (opts.platform === "darwin" && !r.dryRun) {
      const probe = await r.exec("launchctl", ["print", `gui/${opts.uid}/${RECONCILER_LABEL}`]);
      if (probe.code === 0 && /^\s*state = running/m.test(probe.stdout)) {
        throw new StepFailed(`a reconciler job is running but METISTRY_RECONCILER_URL is unset — add it (and ${OWNER_BRIDGE_TOKEN}) to .env so this writes ${rel} through the bridge; refusing to write behind the sole committer`);
      }
    }
    const path = join(dir, rel);
    if (opts.createOnly && existsSync(path)) return { how: "direct", kept: true, detail: `${path} is already there — kept as it is` };
    await r.write(path, content, `${message}; no reconciler bridge configured, so written directly — a reconciler, once installed, sweeps it into a user commit`);
    return { how: "direct", detail: `${path} written directly (no reconciler configured)` };
  }

  return { how: "none", detail: "no instance dir" };
}

/**
 * Delete a §4.7 protected file — the other half of `writeProtected`, on the
 * same rules: through the reconciler as `user` when a bridge is configured
 * (`POST /vault/delete`, the owner-class bearer), directly only when no
 * reconciler job is running. A path that is already gone is not an error on
 * the direct path; the bridge answers for its own.
 */
export async function deleteProtected(r: StepRunner, rel: string, message: string, opts: ProtectedWriteOptions): Promise<ProtectedWrite> {
  const url = opts.env.METISTRY_RECONCILER_URL;
  const raw = opts.instanceDir ?? opts.env.METISTRY_INSTANCE_DIR;
  const dir = raw ? raw.replace(/\/+$/, "") : undefined;

  if (url) {
    const base = hostLocal(url);
    if (!r.action(`POST ${base}/vault/delete ${rel} (principal user, "${message}")`)) return { how: "bridge", detail: "the reconciler commits it on its next flush (it is the instance repo's sole committer)" };
    const owner = opts.env[OWNER_BRIDGE_TOKEN];
    const token = owner ?? opts.env.METISTRY_BRIDGE_TOKEN_RECONCILER;
    if (!token) throw new StepFailed(`METISTRY_RECONCILER_URL is set but neither ${OWNER_BRIDGE_TOKEN} nor METISTRY_BRIDGE_TOKEN_RECONCILER is — ${rel} cannot be deleted through the bridge`);
    let res: Response;
    try {
      res = await opts.fetchFn(`${base}/vault/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: rel, intent: { principal: "user", message } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new StepFailed(`reconciler bridge at ${base} did not answer (${err instanceof Error ? err.message : String(err)}) — start it (launchctl kickstart -k gui/${opts.uid}/${RECONCILER_LABEL}) and rerun; ${rel} was NOT deleted`);
    }
    if (!res.ok) {
      let why = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error) why = `${body.error.code ?? res.status}: ${body.error.message ?? ""}`.trim();
      } catch {
        /* no envelope */
      }
      const hint = res.status === 403 && !owner ? ` — ${rel} is a §4.7 protected path the owner class alone may change; mint ${OWNER_BRIDGE_TOKEN} with \`metistry secrets sync --to env\` and restart the reconciler (docs/ops/auth.md)` : "";
      throw new StepFailed(`reconciler refused to delete ${rel} (${why})${hint} — ${rel} was NOT deleted`);
    }
    return { how: "bridge", detail: `${rel} deleted through the reconciler as user — committed on its next flush` };
  }

  if (dir && existsSync(dir)) {
    if (opts.platform === "darwin" && !r.dryRun) {
      const probe = await r.exec("launchctl", ["print", `gui/${opts.uid}/${RECONCILER_LABEL}`]);
      if (probe.code === 0 && /^\s*state = running/m.test(probe.stdout)) {
        throw new StepFailed(`a reconciler job is running but METISTRY_RECONCILER_URL is unset — add it (and ${OWNER_BRIDGE_TOKEN}) to .env so this deletes ${rel} through the bridge; refusing to change files behind the sole committer`);
      }
    }
    const path = join(dir, rel);
    if (r.action(`delete ${path}  (${message}; no reconciler bridge configured, so deleted directly — a reconciler, once installed, sweeps it into a user commit)`)) await rm(path, { force: true });
    return { how: "direct", detail: `${path} deleted directly (no reconciler configured)` };
  }

  return { how: "none", detail: "no instance dir" };
}
