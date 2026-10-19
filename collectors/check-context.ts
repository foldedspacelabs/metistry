// What every collector's `check()` shares (CLAUDE.md: "every bridge and
// collector exports `check()` so `metistry doctor` is generic"; X-87).
//
// A collector's `check()` is the answer to one question — *could the next
// scheduled run reach what it reads, with what it holds?* — asked CHEAPLY and
// LOCAL-FIRST. It is not a sync: it writes nothing, reads no table of its own,
// and never pulls a calendar, a mailbox or an issue list. What it may do, in
// this order:
//
//   1. look at configuration — is there an instance to read a connection from,
//      a credential, a URL (`absent` when there is not: every collector
//      degrades absent, and says what would fix it);
//   2. open the connection its sync reads (`SyncOpener` — packages/connections
//      resolves the connection, the delivered secret and the host pin; it
//      dials nothing), which is where a lapsed sign-in or a connection file
//      that points at the wrong host is found;
//   3. only then, ask the SHARED connection check (`connectionCheck`, which
//      `metistry doctor` hands in — packages/connections `checkConnection`)
//      whether that connection still answers, within `timeoutMs`. A collector
//      never dials anew, and a connection that does not answer is its own
//      server's outage, so it reads `degraded` here exactly as it does in
//      doctor's connection rows — never `failed`.
//
// The return value is core's frozen `check()` shape (`CheckResult`), the one a
// bridge's `GET /check` returns, built through core's `runCheck` so a throw is
// a `failed` row and not a crash. Doctor guards the call with a timeout of its
// own as well: a `check()` that hangs is a `failed` row, and the rest of the
// report still prints.

import { runCheck, type CheckResult } from "@foldedspacelabs/metistry-core";

/** The shared connection check for one named connection — packages/connections `checkConnection`, wired by `metistry doctor`. */
export type ConnectionCheck = (connection: string) => Promise<CheckResult>;

/** The two things only a `check()` is handed, beside the context its `run()` already takes. */
export interface CheckExtras {
  /** the shared connection check; absent = nothing is dialled (a test, or an install with no instance) */
  connectionCheck?: ConnectionCheck | undefined;
  /** how long the shared connection check may take before this one stops waiting; default `DEFAULT_CHECK_TIMEOUT_MS` */
  timeoutMs?: number | undefined;
}

/** How long a collector's `check()` waits on the shared connection check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5_000; // limit: fixed — a probe, not a sync: a connection that has not answered in five seconds is reported unreachable, and doctor's own guard is the outer bound

/** Reject if `p` has not settled in `ms`; the timer never outlives the call. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What an opener returns: a connection that is ready, or why there is none. Structural, so both `OpenedSync` and `OpenedImapSync` fit. */
export type OpenedConnection = { ok: true; sync: { connection: string } } | { ok: false; status: "absent" | "failed"; why: string };

/**
 * What the shared connection check says about `connection`, as a collector's
 * verdict: `ok`/`absent` as it answered, anything worse `degraded` (a
 * connection is someone else's server — docs/ops/connections.md), a check that
 * does not answer in time `degraded` too. With no `connectionCheck` nothing is
 * dialled, and the verdict says so (`meta.dialled: false`).
 */
export async function connectionReachability(connection: string, extras: CheckExtras): Promise<Pick<CheckResult, "status" | "remediation" | "meta">> {
  if (!extras.connectionCheck) return { status: "ok", meta: { connection, dialled: false } };
  const ms = extras.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  let seen: CheckResult;
  try {
    seen = await withTimeout(extras.connectionCheck(connection), ms, `connection ${connection}`);
  } catch (err) {
    return { status: "degraded", remediation: `${err instanceof Error ? err.message : String(err)} — the next scheduled run tries again`, meta: { connection, dialled: true } };
  }
  const meta = { connection, dialled: true, connection_status: seen.status };
  if (seen.status === "ok") return { status: "ok", meta };
  // The shared check dials MCP servers, generated-tool services and mailboxes.
  // A calendar or a tracker is read by its provider's sync and the pool refuses
  // it `not_built` — that is "not dialled here", not a fault of the connection:
  // what was verified is what this check could see locally (it opened).
  if (seen.status === "absent" && seen.meta?.["refused"] === "not_built") {
    return { status: "ok", meta: { connection, dialled: false, not_dialled: seen.remediation ?? "the shared connection check does not dial this kind of connection" } };
  }
  return {
    status: seen.status === "absent" ? "absent" : "degraded",
    remediation: `${seen.remediation ?? `connection ${connection} is ${seen.status}`} (\`metistry connections test ${connection}\`)`,
    meta,
  };
}

export interface SyncCheckOptions {
  /** the collector's name — the row's name */
  name: string;
  /** what was attempted, for the row's `probe` */
  probe: string;
  /** the remediation when this install has nothing to read a connection from at all */
  noInstance: string;
  /** the remediation's tail when no connection exists yet: the command that adds one */
  addHint: string;
  /** open the connection the sync reads — `ctx.openSync?.(…)` or `ctx.openImap?.(…)`; undefined = no opener */
  open: (() => Promise<OpenedConnection>) | undefined;
  extras: CheckExtras;
}

/**
 * The check of a sync that reads one connection (the calendar syncs, the
 * tracker, the mailbox). `absent` for no opener or no connection; `failed` for
 * a connection file the sync cannot use (the same words the run would throw);
 * then the shared connection check's verdict, a failure of which is `degraded`.
 */
export function syncConnectionCheck(o: SyncCheckOptions): Promise<CheckResult> {
  return runCheck(o.name, o.probe, async () => {
    if (!o.open) return { status: "absent" as const, remediation: o.noInstance };
    const opened = await o.open();
    if (!opened.ok) {
      return opened.status === "absent"
        ? { status: "absent" as const, remediation: `${opened.why} — ${o.addHint}; degrades absent meanwhile (nothing is read, everything else runs)` }
        : { status: "failed" as const, remediation: opened.why };
    }
    return connectionReachability(opened.sync.connection, o.extras);
  });
}
