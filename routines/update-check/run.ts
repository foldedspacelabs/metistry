// update-check — the daily Update Check (design-build-plan §2.20, T2-18).
//
// Once a day: ask the release feed for the product's newest release and
// compare it with the runtime this console is (the version `metistry update`
// would replace). Three outcomes, each a fact recorded rather than a message
// sent:
//
//   * **newer** — one `routine_run` row of its own, `outcome: acted`, with
//     `meta.release_available: "<version>"`. The console's live-changes
//     mapper (apps/console/src/events.ts) reads exactly that row — this
//     component, that key, a version-shaped value — and streams
//     `release.available {version}` to every subscribed client, which
//     refetches `GET /api/identity` for the version it is running. Every day
//     the check still finds it newer it says so again: a client that was
//     closed yesterday hears it today.
//   * **not newer** — nothing of its own; the runner's row says `silent`.
//   * **could not tell** — a feed that did not answer, answered with an
//     error, has no release yet, or a runtime version this cannot read: one
//     row, `outcome: skipped:<reason>`, and NO throw. A throw would count
//     toward the runner's failure streak and raise an alert, and an offline
//     laptop is not worth a notification about updates.
//
// Model-free (invariant 4). It reads nothing of the vault and nothing of the
// database; the one thing it sends is a GET to the GitHub API naming the
// product's repository — the same request `metistry update` makes, with the
// same two overrides (`METISTRY_RELEASE_REPO`, `METISTRY_GITHUB_API`) and the
// same optional token (`METISTRY_GITHUB_TOKEN`, which lifts the anonymous
// rate limit and is the only way to see a private repository's releases).
// It installs nothing: the update is the owner's, through `metistry update`.

import type { Db, RoutineCtx } from "../morning-brief/run.js";

export const COMPONENT = "update-check";
/** The product's repository — `packages/cli/src/release.ts`'s default, which this routine does not import (routines depend on core alone). */
export const DEFAULT_RELEASE_REPO = "foldedspacelabs/metistry";
export const DEFAULT_GITHUB_API = "https://api.github.com";
const FEED_TIMEOUT_MS = 15_000; // limit: fixed — one small JSON document; a feed slower than this is "unreachable" for today, and tomorrow asks again

export interface UpdateCheckCtx extends RoutineCtx {
  /** The runtime this console is: its own package version (main.ts). Absent → the check has nothing to compare with and says so. */
  runtimeVersion?: string | undefined;
  /** `METISTRY_GITHUB_TOKEN`, as the runner already hands the github-state collector. */
  githubToken?: string | undefined;
  /** Where `METISTRY_RELEASE_REPO` / `METISTRY_GITHUB_API` are read from. Default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
}

// ---- versions ------------------------------------------------------------------------

/** `0.12.0`, `0.12.0-rc.1`; a leading `v` (a tag) is dropped. Anything else — build metadata, four parts, prose — is not a version this reads. */
const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The pre-release identifiers, or empty for a release. */
  readonly pre: readonly string[];
  /** As written, without the `v`. */
  readonly text: string;
}

export function parseVersion(v: unknown): Version | undefined {
  if (typeof v !== "string") return undefined;
  const m = VERSION.exec(v.trim());
  if (!m) return undefined;
  const pre = m[4] === undefined ? [] : m[4].split(".");
  if (pre.some((p) => p === "")) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, text: v.trim().replace(/^v/, "") };
}

/** Semver precedence: negative when `a` is older than `b`. A pre-release is older than its release; pre-release identifiers compare numerically when both are numbers, else as text, and a shorter set is older. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre.length === 0 || b.pre.length === 0) return (a.pre.length === 0 ? 1 : 0) - (b.pre.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]!;
    const y = b.pre[i]!;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

// ---- the feed ------------------------------------------------------------------------

export type Latest = { ok: true; version: Version } | { ok: false; reason: "unreachable" | "no_release" | "unreadable"; detail: string };

/** The newest release: `GET <api>/repos/<repo>/releases/latest` — GitHub's own "latest", which is never a draft or a pre-release. */
export async function latestRelease(ctx: UpdateCheckCtx): Promise<Latest> {
  const env = ctx.env ?? process.env;
  const repo = env.METISTRY_RELEASE_REPO || DEFAULT_RELEASE_REPO;
  const api = (env.METISTRY_GITHUB_API || DEFAULT_GITHUB_API).replace(/\/+$/, "");
  const url = `${api}/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "metistry-update-check" };
  if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
  let res: Response;
  try {
    res = await (ctx.fetchFn ?? fetch)(url, { headers, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 404) return { ok: false, reason: "no_release", detail: `${repo} has no release yet (${url} answered 404)` };
  if (!res.ok) {
    const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    return {
      ok: false,
      reason: "unreachable",
      detail: `${url} answered HTTP ${res.status}${limited ? " — rate limited; METISTRY_GITHUB_TOKEN lifts the anonymous limit" : res.status === 401 || res.status === 403 ? ` — ${repo} may be private; METISTRY_GITHUB_TOKEN needs Contents: read on it` : ""}`,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "unreadable", detail: `${url} did not answer JSON` };
  }
  const tag = body && typeof body === "object" ? (body as { tag_name?: unknown }).tag_name : undefined;
  const version = parseVersion(tag);
  if (!version) return { ok: false, reason: "unreadable", detail: `${url}'s tag_name ${JSON.stringify(tag ?? null)} is not a version` };
  return { ok: true, version };
}

// ---- the routine ----------------------------------------------------------------------

/** This routine's own row: finished as it is written, like plan-tomorrow's. `meta.outcome` is the vocabulary every routine shares (T1-4). */
async function record(db: Db, meta: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO runs (component, kind, ok, started_at, finished_at, meta)
     VALUES ($1, 'routine_run', true, now(), now(), $2)`,
    [COMPONENT, JSON.stringify(meta)],
  );
}

export async function run(db: Db, ctx: UpdateCheckCtx = {}): Promise<number> {
  const current = parseVersion(ctx.runtimeVersion);
  if (!current) {
    await record(db, {
      outcome: "skipped:no_version",
      why: `the runtime's version ${JSON.stringify(ctx.runtimeVersion ?? null)} is not one this check can compare — the console passes its own package version (apps/console/src/main.ts)`,
    });
    return 0;
  }
  const latest = await latestRelease(ctx);
  if (!latest.ok) {
    await record(db, { outcome: `skipped:${latest.reason}`, current: current.text, why: latest.detail });
    return 0;
  }
  if (compareVersions(latest.version, current) <= 0) return 0; // up to date: the runner's row says silent
  await record(db, { outcome: "acted", current: current.text, release_available: latest.version.text });
  return 1;
}
