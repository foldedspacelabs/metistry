// Policy as pure functions (§4.21): compare-and-swap, the autonomy
// boundary, the ping-pong cap, and `addressed` inference. Each is a
// decision with no I/O so it can be tested exhaustively without a
// database; the service wires them to rows. Nothing here reads a prompt.

export const PROJECT_RE = /^[a-z][a-z0-9-]{0,39}$/; // the agents/projects slug shape (console validateProjects)
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const AGENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_FILE_PATH = 300;  // limit: fixed — the artifact path contract, mirrored by the reconciler's own bound
const MAX_SEGMENTS = 20;  // limit: fixed — an artifact is a small directory; deeper is a mistake, not a preference

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

export const DEFAULT_PING_PONG_CAP = 10;  // limit: fixed — the default a project's own autonomy payload overrides

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

// --- §4.21 controls on top of the boundary --------------------------------------

/**
 * Optional narrowing below the project default, from the agent's manifest
 * (`agents.autonomy`). Absent keys mean "project members" and the default
 * cap; a key can only narrow, never widen — nothing here lets an agent
 * reach past the boundary above.
 */
export interface Autonomy {
  /** Agent ids this agent may send bundles to. Absent = every member. */
  may_dispatch_to?: string[] | undefined;
  /** Who may send this agent bundles: agent ids and/or the literal "user". Absent = every member (and the user). */
  accept_from?: string[] | undefined;
  /** This agent's own bundles in flight at once. Absent = DEFAULT_AGENT_BUNDLE_CAP. */
  max_open_bundles?: number | undefined;
}

export const DEFAULT_AGENT_BUNDLE_CAP = 3;  // limit: fixed — the default an agent's own max_open_bundles overrides
export const DEFAULT_PROJECT_BUNDLE_CAP = 20;  // limit: fixed — the default a project row's max_open_bundles overrides
export const MAX_BUNDLE_CAP = 1000;  // limit: fixed — the ceiling on what either of those may be set to

/** Tolerant reader for the jsonb column: unknown keys and malformed values are ignored, never widened. */
export function parseAutonomy(raw: unknown): Autonomy {
  const out: Autonomy = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown, allowUser: boolean): string[] | undefined =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && (AGENT_RE.test(x) || (allowUser && x === "user"))))] : undefined;
  const to = ids(r.may_dispatch_to, false);
  if (to !== undefined) out.may_dispatch_to = to;
  const from = ids(r.accept_from, true);
  if (from !== undefined) out.accept_from = from;
  if (typeof r.max_open_bundles === "number" && Number.isInteger(r.max_open_bundles) && r.max_open_bundles >= 0 && r.max_open_bundles <= MAX_BUNDLE_CAP) out.max_open_bundles = r.max_open_bundles;
  return out;
}

export type DispatchProposalReason = "outside_project" | "review_mode" | "may_dispatch_to" | "accept_from";
export type DispatchDecision = { route: "work" } | { route: "proposal"; reason: DispatchProposalReason };

/**
 * The whole routing decision for one bundle, in order of authority:
 * the user's hand always dispatches; the boundary (membership) first;
 * then the project's kill switch (`review` routes EVERY agent-to-agent
 * bundle to the user); then the two narrowing keys. Each miss is a
 * demotion to a proposal — by rule, with its reason on the row.
 */
export function dispatchDecision(input: {
  callerKind: "user" | "agent" | "system";
  callerId: string;
  callerIsMember: boolean;
  targetId: string;
  targetIsMember: boolean;
  mode: "autonomous" | "review";
  callerAutonomy?: Autonomy | undefined;
  targetAutonomy?: Autonomy | undefined;
}): DispatchDecision {
  if (input.callerKind === "user") return { route: "work" };
  if (dispatchRoute(input.callerKind, input.callerIsMember, input.targetIsMember) === "proposal") return { route: "proposal", reason: "outside_project" };
  if (input.mode === "review") return { route: "proposal", reason: "review_mode" };
  const to = input.callerAutonomy?.may_dispatch_to;
  if (to !== undefined && !to.includes(input.targetId)) return { route: "proposal", reason: "may_dispatch_to" };
  const from = input.targetAutonomy?.accept_from;
  if (from !== undefined && !from.includes(input.callerId)) return { route: "proposal", reason: "accept_from" };
  return { route: "work" };
}

export type CapReason = "agent_cap" | "project_cap";

/** The bundle caps: the first one exceeded wins (`open` is bundles in flight BEFORE this one). Null = room for one more. */
export function capExceeded(agentOpen: number, agentCap: number, projectOpen: number, projectCap: number): { reason: CapReason; cap: number; open: number } | null {
  if (agentOpen >= agentCap) return { reason: "agent_cap", cap: agentCap, open: agentOpen };
  if (projectOpen >= projectCap) return { reason: "project_cap", cap: projectCap, open: projectOpen };
  return null;
}

/** The soft budget: exceeded strictly — a project AT its budget still runs. */
export function budgetExceeded(spendUsd: number, budgetUsd: number | null): boolean {
  return budgetUsd !== null && Number.isFinite(budgetUsd) && spendUsd > budgetUsd;
}
