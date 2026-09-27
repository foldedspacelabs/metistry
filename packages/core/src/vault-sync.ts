// The vault's sync policy and status (design-build-plan §2.21, T10-2): WHEN
// the reconciler — the instance repo's sole committer (D5) — pushes to the
// remote and pulls from it, and what `GET /api/vault/status` says about it.
//
// The policy is the `vault:` block of `.metistry/deployment.yaml` (M18):
//
//   vault:
//     push: after_commit        # after_commit | manual | {every: 15m}
//     pull:
//       every: 5m               # fetch and integrate; never "never" while a remote exists
//
// `metistry vault settings` writes it (a §4.7 protected write, the owner's
// hand); the reconciler reads it and re-reads it when the file changes.
// `METISTRY_PUSH_SCHEDULE` — the variable this replaces — still overrides
// `push` for one release, so an install that set it keeps what it chose
// until the owner moves the choice into the file (and doctor says so).
//
// This module is schema and arithmetic only: no filesystem, no git. The
// reconciler owns the schedule and the git reads (apps/reconciler/src/sync.ts);
// the CLI owns the file (packages/cli/src/vault.ts).

import { z } from "zod";

/** One release's grace for the old variable (docs/ops/reconciler.md). */
export const PUSH_SCHEDULE_ENV = "METISTRY_PUSH_SCHEDULE";

/**
 * The bounds on an `every:` interval. A minute is the floor because a push or
 * a fetch is a network round trip to someone else's server — a policy that
 * asked for one every second would be a denial of service against GitHub
 * with the owner's credential on it. A day is the ceiling because a sync
 * policy slower than that is `manual` with extra steps.
 */
export const VAULT_SYNC_MIN_SEC = 60; // limit: fixed — see above
export const VAULT_SYNC_MAX_SEC = 86_400; // limit: fixed — see above

const INTERVAL_RE = /^([1-9]\d{0,5})([smh])$/;

/** `15m` → 900; undefined for anything that is not `<n>s|m|h`. Bounds are the schema's job. */
export function intervalSeconds(v: string): number | undefined {
  const m = INTERVAL_RE.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
}

export const vaultIntervalSchema = z.string().superRefine((v, ctx) => {
  const s = intervalSeconds(v);
  if (s === undefined) ctx.addIssue({ code: "custom", message: `"${v}" is not an interval — write <n>m or <n>h (e.g. 15m)` });
  else if (s < VAULT_SYNC_MIN_SEC || s > VAULT_SYNC_MAX_SEC) ctx.addIssue({ code: "custom", message: `"${v}" is outside 1m…24h` });
});

const everySchema = z.object({ every: vaultIntervalSchema }).strict();

/** `after_commit`: push once a flush has made commits. `manual`: never push on its own. `{every}`: push on an interval. */
export const vaultPushSchema = z.union([z.enum(["after_commit", "manual"]), everySchema]);
/** Pull is always on an interval: a remote the reconciler never fetches from is how an install diverges without noticing. */
export const vaultPullSchema = everySchema;

export const vaultSyncSchema = z
  .object({
    push: vaultPushSchema.optional(),
    pull: vaultPullSchema.optional(),
  })
  .strict();

export type VaultPush = z.infer<typeof vaultPushSchema>;
export type VaultPull = z.infer<typeof vaultPullSchema>;
/** The block as written: either key may be absent, and an absent key takes the default. */
export type VaultSyncBlock = z.infer<typeof vaultSyncSchema>;

/** The policy in force, every key answered. */
export interface VaultSyncPolicy {
  push: VaultPush;
  pull: VaultPull;
}

/** What an install that never chose gets: push as soon as there is something to push, look for the owner's own pushes every five minutes. */
export const VAULT_SYNC_DEFAULT: VaultSyncPolicy = { push: "after_commit", pull: { every: "5m" } };

/** The D4 overlay for the block: per key, the instance's answer, else the seed's. */
export function overlayVaultSync(seed: VaultSyncBlock | undefined, instance: VaultSyncBlock | undefined): VaultSyncBlock | undefined {
  if (!seed && !instance) return undefined;
  const push = instance?.push ?? seed?.push;
  const pull = instance?.pull ?? seed?.pull;
  return { ...(push !== undefined ? { push } : {}), ...(pull !== undefined ? { pull } : {}) };
}

/**
 * The old variable's value as a push policy, or undefined when it is unset
 * (the file decides). Its grammar is kept exactly — `@hourly`, `@daily`,
 * `never`, `<n>[s|m|h]` — and so are its bounds, which were none: it was an
 * install's own choice and this release honours it as written.
 */
export function pushFromSchedule(raw: string | undefined): { push: VaultPush; seconds: number } | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "never" || v === "0") return { push: "manual", seconds: 0 };
  if (v === "@hourly") return { push: { every: "1h" }, seconds: 3600 };
  if (v === "@daily") return { push: { every: "24h" }, seconds: 86_400 };
  const m = /^(\d+)([smh]?)$/.exec(v);
  if (!m) throw new Error(`${PUSH_SCHEDULE_ENV} must be @hourly, @daily, never, or <n>[s|m|h] — got "${raw}"`);
  const n = Number(m[1]);
  const unit = m[2] || "s";
  if (n === 0) return { push: "manual", seconds: 0 };
  return { push: { every: `${n}${unit}` }, seconds: unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n };
}

export interface ResolvedVaultSync extends VaultSyncPolicy {
  /** Seconds between pushes; 0 = not on an interval (`after_commit` or `manual`). The override's own value, unbounded, when it applies. */
  push_every_sec: number;
  pull_every_sec: number;
  /** Set while `METISTRY_PUSH_SCHEDULE` decides `push` instead of the file — its raw value. */
  push_override?: string;
}

/**
 * The policy in force: the block's answers over the defaults, then the old
 * variable over `push` for this release. Throws on an unparseable variable,
 * exactly as the reconciler always has — a typo in `.env` is loud.
 */
export function resolveVaultSync(block: VaultSyncBlock | undefined, env: { [k: string]: string | undefined } = {}): ResolvedVaultSync {
  const push = block?.push ?? VAULT_SYNC_DEFAULT.push;
  const pull = block?.pull ?? VAULT_SYNC_DEFAULT.pull;
  const pullSec = intervalSeconds(pull.every) ?? intervalSeconds(VAULT_SYNC_DEFAULT.pull.every)!;
  const override = pushFromSchedule(env[PUSH_SCHEDULE_ENV]);
  if (override) {
    return { push: override.push, pull, push_every_sec: override.seconds, pull_every_sec: pullSec, push_override: env[PUSH_SCHEDULE_ENV]!.trim() };
  }
  const pushSec = typeof push === "object" ? (intervalSeconds(push.every) ?? 0) : 0;
  return { push, pull, push_every_sec: pushSec, pull_every_sec: pullSec };
}

/** The policy in words, for a log line, a doctor row, a preview. */
export function describeVaultSync(p: Pick<ResolvedVaultSync, "push" | "pull" | "push_override">): string {
  const push = typeof p.push === "object" ? `every ${p.push.every}` : p.push;
  return `push ${push}${p.push_override !== undefined ? ` (${PUSH_SCHEDULE_ENV}=${p.push_override})` : ""}, pull every ${p.pull.every}`;
}

/**
 * A `--push` value as a person types it: `after_commit`, `manual`, or an
 * interval with or without `every` (`15m`, `every:15m`, `every 15m`).
 * Validated by the schema, so the CLI and the file cannot disagree.
 */
export function parsePushArg(raw: string): VaultPush {
  const v = raw.trim().replace(/^every[:\s]\s*/, "");
  const candidate = v === "after_commit" || v === "manual" ? v : { every: v };
  const r = vaultPushSchema.safeParse(candidate);
  if (!r.success) throw new Error(`--push must be after_commit, manual, or an interval 1m…24h such as 15m — got "${raw}"`);
  return r.data;
}

/** A `--pull` value: an interval, with or without `every`. There is no `never` (see `vaultPullSchema`). */
export function parsePullArg(raw: string): VaultPull {
  const v = raw.trim().replace(/^every[:\s]\s*/, "");
  const r = vaultPullSchema.safeParse({ every: v });
  if (!r.success) throw new Error(`--pull must be an interval 1m…24h such as 5m (there is no "never": a remote the reconciler never fetches from diverges unnoticed) — got "${raw}"`);
  return r.data;
}

// ---- `GET /api/vault/status` ------------------------------------------------

const iso = z.string().min(1);

/** One push or pull attempt, as the reconciler last saw it. */
export const vaultSyncAttemptSchema = z
  .object({
    at: iso,
    ok: z.boolean(),
    remote: z.string().nullable(),
    error: z.string().optional(),
  })
  .strict();

/**
 * The body the reconciler's `GET /vault/status` and the console's
 * `GET /api/vault/status` both answer. Strict, and parsed on the console's
 * side of the wire, so the route can only ever carry these fields.
 */
export const vaultStatusSchema = z
  .object({
    /** The checked-out branch; null on a detached HEAD. */
    branch: z.string().nullable(),
    /** The remote pushes go to (`origin` when there is one); null = no remote, and ahead/behind are null with it. */
    remote: z.string().nullable(),
    /** Commits here the remote has not got; null with no remote. With a remote that has never received this branch, every commit. */
    ahead: z.number().int().nonnegative().nullable(),
    /** Commits on the remote not yet here, as of the last fetch. */
    behind: z.number().int().nonnegative().nullable(),
    last_commit: z.object({ sha: z.string(), subject: z.string(), author: z.string(), at: iso }).strict().nullable(),
    last_push: vaultSyncAttemptSchema.nullable(),
    last_pull: vaultSyncAttemptSchema.nullable(),
    /** A pull that could not integrate: the paths both sides changed. Null when there is none. */
    conflict: z.object({ paths: z.array(z.string()) }).strict().nullable(),
    policy: z
      .object({
        push: vaultPushSchema,
        pull: vaultPullSchema,
        /** `METISTRY_PUSH_SCHEDULE`'s value while it overrides `push` (this release only). */
        push_override: z.string().optional(),
        /** Why deployment.yaml's block is not the one in force — the file does not validate, and the last good policy (or the default) runs. */
        error: z.string().optional(),
      })
      .strict(),
    as_of: iso,
  })
  .strict();

export type VaultSyncAttempt = z.infer<typeof vaultSyncAttemptSchema>;
export type VaultStatus = z.infer<typeof vaultStatusSchema>;

/**
 * The `runs.kind` a sync act is recorded under. The console's event mapper
 * turns one row into `vault.sync {state: meta.state}` (§2.20, T2-18), so
 * `meta.state` is written with exactly one of `VAULT_SYNC_STATES`.
 */
export const VAULT_SYNC_RUN_KIND = "vault_sync";
