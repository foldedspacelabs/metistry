// The reconciler's stop (W3 checkpoint D1). Before this, SIGTERM took the
// node default — exit at once — and every write still in the commit queue's
// flush window was left on disk and never committed. `metistry update`
// writes the lock and secrets and restarts the supervisor seconds later, so
// that was every update.
//
// On SIGTERM or SIGINT: stop taking work (the intervals, the bridge), commit
// what is queued through the committer's own flush — the same path, the
// same identity, the same messages as any other flush — waiting at most
// `timeoutMs`, then close and exit. The supervisor SIGKILLs a child ten
// seconds after its SIGTERM (core `STOP_GRACE_MS`), so the default leaves
// two to spare. A deadline that cuts the flush short loses nothing either:
// the queue is journalled, and the next start commits it (`recover()`). A
// second signal exits at once, on the same promise.

import type { Committer, DrainResult } from "./committer.js";

/** The shutdown flush's default deadline: inside the supervisor's 10 s grace, with room for the close. */
export const SHUTDOWN_FLUSH_MS = 8_000;

/** The one thing a signal source has to be — `process`, or an EventEmitter in the tests. */
export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT", fn: () => void): unknown;
  removeListener(signal: "SIGTERM" | "SIGINT", fn: () => void): unknown;
}

export interface ShutdownDeps {
  committer: Pick<Committer, "drain">;
  /** Stop taking new work: clear the intervals, stop the sync schedule, close the bridge's listener. */
  stop(): void;
  /** Release what is left (the pool) once the flush is done. Errors are logged, never fatal. */
  close?(): Promise<void>;
  exit(code: number): void;
  log?(line: string): void;
  timeoutMs?: number;
  source?: SignalSource;
}

/** Install the handler; returns what the stop did, once it has, and a way to uninstall (the tests). */
export function installShutdown(deps: ShutdownDeps): { done: Promise<DrainResult>; uninstall(): void } {
  const source = deps.source ?? process;
  const log = deps.log ?? ((l: string) => console.log(l));
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_FLUSH_MS;
  let started = false;
  let resolveDone!: (r: DrainResult) => void;
  const done = new Promise<DrainResult>((r) => (resolveDone = r));

  const onSignal = (signal: "SIGTERM" | "SIGINT") => () => {
    if (started) {
      log(`reconciler: ${signal} again — exiting now; what is still queued is in the commit journal for the next start`);
      deps.exit(1);
      return;
    }
    started = true;
    log(`reconciler: ${signal} — committing the queue before exit (at most ${timeoutMs} ms)`);
    void (async () => {
      try {
        deps.stop();
      } catch (err) {
        log(`reconciler: stopping the intervals failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const r = await deps.committer.drain(timeoutMs);
      if (r.flush?.paused) log(`reconciler: the owner has a ${r.flush.paused} in progress — nothing committed; the next start commits what is queued once it is finished`);
      else if (r.timedOut) log(`reconciler: the shutdown flush did not finish in ${timeoutMs} ms — ${r.left} intent(s) left in the commit journal for the next start`);
      else if (r.flush) log(`reconciler: committed ${r.flush.commits.length} act(s) before exit${r.flush.failed ? `, ${r.flush.failed} failed (kept in the commit journal)` : ""}`);
      try {
        await deps.close?.();
      } catch (err) {
        log(`reconciler: close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      resolveDone(r);
      deps.exit(0);
    })();
  };
  const handlers = { SIGTERM: onSignal("SIGTERM"), SIGINT: onSignal("SIGINT") };
  // `on`, not `once`: a second signal must still find a listener, or node's default would exit mid-commit
  source.on("SIGTERM", handlers.SIGTERM);
  source.on("SIGINT", handlers.SIGINT);
  return {
    done,
    uninstall: () => {
      source.removeListener("SIGTERM", handlers.SIGTERM);
      source.removeListener("SIGINT", handlers.SIGINT);
    },
  };
}
