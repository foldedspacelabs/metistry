// Policy as pure functions (§4.21): compare-and-swap, the autonomy
// boundary, the ping-pong cap, and `addressed` inference. Each is a
// decision with no I/O so it can be tested exhaustively without a
// database; the service wires them to rows. Nothing here reads a prompt.

export const PROJECT_RE = /^[a-z][a-z0-9-]{0,39}$/; // the agents/projects slug shape (console validateProjects)
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const AGENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_FILE_PATH = 300;
const MAX_SEGMENTS = 20;

/** A path inside an artifact directory: relative, POSIX, no dot-segments, no dotfiles, no control chars. */
export function validFilePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_FILE_PATH) return false;
  if (/[\x00-\x1f\x7f\\]/.test(p) || p.startsWith("/")) return false;
  const segs = p.split("/");
  if (segs.length > MAX_SEGMENTS) return false;
  return segs.every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith(".") && s === s.trim() && s.length <= 255);
}

/**
 * Compare-and-swap on the current version. `expected` undefined = "whatever
 * is current at publish time" (still serialized by the atomic update);
 * `null` = "this artifact must not exist yet"; a version id = exact.
 * `current` is null when the artifact does not exist.
 */
export function casAllows(current: string | null, expected: string | null | undefined): boolean {
  if (expected === undefined) return true;
  return current === expected;
}

export type AuthorKind = "human" | "agent";

/** Trailing run of agent-authored comments over a thread in chronological order (root first). */
export function agentTailLength(thread: ReadonlyArray<{ author_kind: string }>): number {
  let n = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i]!.author_kind !== "agent") break;
    n++;
  }
  return n;
}

export const DEFAULT_PING_PONG_CAP = 10;

/**
 * The ping-pong control: an agent reply that would make the trailing
 * agent-only run exceed the cap is not stored — the thread demotes to the
 * user instead. A human comment resets the run.
 */
export function pingPongDemotes(thread: ReadonlyArray<{ author_kind: string }>, replyAuthor: AuthorKind, cap = DEFAULT_PING_PONG_CAP): boolean {
  return replyAuthor === "agent" && agentTailLength(thread) >= cap;
}

/** A bundle is addressed when every thread in it is resolved; nothing writes this, it is always inferred. */
export function inferAddressed(threads: ReadonlyArray<{ state: string }>): boolean {
  return threads.length > 0 && threads.every((t) => t.state === "resolved");
}

export type DispatchRoute = "work" | "proposal";

/**
 * The autonomy boundary (§4.21, ratified 2026-09-06): membership is the
 * grant, the project is the boundary. The user's hand always dispatches.
 * An agent dispatches freely only when BOTH it and the target are members
 * of the artifact's project; otherwise the dispatch becomes a proposal
 * for the user — by rule, not by prompt.
 */
export function dispatchRoute(callerKind: "user" | "agent" | "system", callerIsMember: boolean, targetIsMember: boolean): DispatchRoute {
  if (callerKind === "user") return "work";
  return callerIsMember && targetIsMember ? "work" : "proposal";
}
