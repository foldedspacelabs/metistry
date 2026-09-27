// The standup move (design-build-plan §2.5, §4 Q13; ticket T3-4).
//
// `standup_days` and `standup_time` were facts in `Me/profile.md`; the owner
// ruled that when a routine runs is the routine's (ruling 2, K8/K13), so they
// move to the Standup routine's entry in `.metistry/scheduled.yaml`, ONCE,
// and the profile is tidied only if the owner says so.
//
// Two writers, two principals' worth of care:
//
//   * `.metistry/scheduled.yaml` is a §4.7 protected path. The console writes
//     it through the reconciler as `user`, which the bridge allows only for
//     the paths `CALLER_AUTHORITY.console` lists — `scheduled.yaml` joins that
//     list with T3-2. Until it does the write is refused `forbidden`, and the
//     move stops there: nothing moved, nothing proposed, one log line.
//   * `Me/profile.md` is the owner's alone (#255): nothing edits it
//     mechanically. The move raises ONE request — *Tidy Me/profile.md* — with
//     the before and after, and only the owner's Approve writes it, as `user`,
//     through the proposal path (`applyMeEdit`, called from `decideProposal`),
//     refused if the file changed since. Decline leaves the lines; nothing
//     reads them, and `metistry doctor` names them in one info line.
//
// The order is the safety: the overlay is written FIRST, and the request is
// raised only once that has landed, so no answer to it can lose what the
// profile said. "Once" is the request's own record — `lastMirror` over its
// `source` — so a request that was answered either way is never raised again.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  INSTANCE_LAYOUT,
  PROFILE_PATH,
  SCHEDULED_FILENAME,
  USER_OWNED_ROOTS,
  lastMirror,
  planStandupMove,
  raiseMirror,
  readStandupKeys,
  resolveAtSource,
  type MirrorExecutor,
  type RequestSource,
  type StandupProfileKey,
} from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";

/** The overlay, instance-relative — the path the reconciler writes. */
export const SCHEDULED_PATH = `${INSTANCE_LAYOUT.metistryDir}/${SCHEDULED_FILENAME}`;

/** The request's subject: the profile's standup lines. Its `source` is what makes it raised once, ever — and what clears it if the owner deletes the lines by hand. */
export const TIDY_SOURCE: RequestSource = Object.freeze({ kind: "metistry", external_ref: `${PROFILE_PATH}#standup` });
/** An improvement (§2.12): a before and after, Approve / Revise / Decline. */
export const TIDY_KIND = "improvement";
/** Server-side identity of what raised it — this process, not an agent. */
export const TIDY_AGENT = "console";
export const TIDY_TITLE = `Tidy ${PROFILE_PATH}`;

/** How long the move waits before asking again, while the vault, Postgres or `scheduled.yaml` says "not yet". */
export const STANDUP_MOVE_RETRY_MS = 60 * 60 * 1000; // limit: fixed — a one-time move that is waiting on the owner or a restart; an hour is soon enough and quiet enough

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Where the move stopped, and whether trying again could change anything before the console restarts. */
export type TidyState =
  | "no_profile" // no Me/profile.md at all
  | "none" // no standup keys: nothing to move
  | "resolved" // the owner deleted the lines by hand; a waiting request was cleared at its source
  | "already_raised" // raised before — pending, or answered either way
  | "unreadable" // a key that cannot be read moves nothing
  | "overlay_unseen" // this console cannot see the instance directory, so it cannot read scheduled.yaml
  | "overlay_invalid" // scheduled.yaml does not validate: never rewritten, so the move waits
  | "forbidden" // the reconciler refused the overlay write (the console's authority over scheduled.yaml is T3-2's)
  | "conflict" // scheduled.yaml changed between the read and the write
  | "untidy" // moved, but the lines cannot be removed provably — no request, doctor names them
  | "raised"; // moved, and the request is waiting

export interface TidyOutcome {
  readonly state: TidyState;
  /** True when nothing will change before a restart — the caller stops retrying. */
  readonly done: boolean;
  readonly detail: string;
  /** The overlay write landed in this pass. */
  readonly moved?: boolean;
  readonly proposal?: number;
}

export interface TidyDeps {
  /** The vault bridge, as the console holds it. */
  vault: Pick<VaultClient, "read" | "write">;
  db: MirrorExecutor;
  /**
   * `scheduled.yaml`'s bytes as they are on disk: null when there is no file
   * yet, undefined when this console cannot see the instance directory. The
   * bridge serves the vault, not `.metistry/`, so the read is the
   * filesystem's — the same file the scheduler reads (`fileOverlay`).
   */
  readOverlay: () => Promise<Buffer | null | undefined>;
}

/**
 * `scheduled.yaml` read from the instance directory — the file the runner
 * reads, and the one the bridge writes at `SCHEDULED_PATH`. Undefined (the
 * move stays put) when there is no instance directory, or when the runner
 * was pointed at another file (`METISTRY_SCHEDULED_FILE`): moving the
 * standup into a file the runner does not read would move it nowhere.
 */
export function fileOverlay(path: string | undefined): () => Promise<Buffer | null | undefined> {
  return async () => {
    if (!path) return undefined;
    try {
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
}

const lines = (keys: readonly StandupProfileKey[]): string => (keys.length === 1 ? "this line" : `these ${keys.length} lines`);

/** The request's payload: the owner's words, the before and after they will see, and the edit Approve makes — nothing else. */
export function tidyPayload(profile: { text: string; sha256: string }, tidied: string, keys: readonly StandupProfileKey[]): Record<string, unknown> {
  return {
    title: TIDY_TITLE,
    summary:
      `${TIDY_TITLE}: ${lines(keys)} (${keys.join(", ")}) now live on the Standup routine, under Scheduled. ` +
      `Approve removes ${keys.length === 1 ? "it" : "them"} from ${PROFILE_PATH}, as you; Decline leaves ${keys.length === 1 ? "it" : "them"}, and nothing reads ${keys.length === 1 ? "it" : "them"}.`,
    body: {
      kind: "before_after",
      heading: "What Approve Does",
      before: { label: `${PROFILE_PATH} now`, text: profile.text },
      after: { label: `${PROFILE_PATH} after`, text: tidied },
    },
    edit: { path: PROFILE_PATH, base_sha256: profile.sha256, removes: [...keys] },
  };
}

/**
 * One pass of the move. Safe to run any number of times: every state it
 * leaves is one the next pass reads back (the overlay entry, the request's
 * row), so a pass that crashed half-way resumes rather than repeats.
 * Throws only when the vault or Postgres cannot be reached — the caller
 * tries again later.
 */
export async function moveStandupFacts(deps: TidyDeps): Promise<TidyOutcome> {
  const profile = await deps.vault.read(PROFILE_PATH);
  if (!profile) return { state: "no_profile", done: true, detail: `no ${PROFILE_PATH} — nothing to move` };
  const text = profile.content.toString("utf8");

  const keys = readStandupKeys(text);
  if (keys.state === "none") {
    // The lines are gone — Approved, or deleted by hand. A request still
    // waiting for them has nothing left to ask.
    const cleared = await resolveAtSource(deps.db, TIDY_SOURCE);
    return cleared.length > 0
      ? { state: "resolved", done: true, detail: `${PROFILE_PATH} no longer has the standup lines — request #${cleared.join(", #")} cleared at its source` }
      : { state: "none", done: true, detail: `${PROFILE_PATH} has no standup_days or standup_time — nothing to move` };
  }

  const prior = await lastMirror(deps.db, TIDY_SOURCE);
  if (prior) return { state: "already_raised", done: true, detail: `${TIDY_TITLE} was raised as request #${prior.id} (${prior.decision}) — never again` };

  const overlay = await deps.readOverlay();
  if (overlay === undefined) {
    return { state: "overlay_unseen", done: true, detail: `this console cannot read the instance's ${SCHEDULED_PATH} (METISTRY_INSTANCE_DIR unset, or METISTRY_SCHEDULED_FILE names another file) — the standup lines stay where they are` };
  }
  const plan = planStandupMove(text, overlay === null ? null : overlay.toString("utf8"));
  switch (plan.state) {
    case "none":
      return { state: "none", done: true, detail: "nothing to move" };
    case "unreadable":
      return { state: "unreadable", done: true, detail: `${PROFILE_PATH}: ${plan.why} — nothing moved (metistry doctor names the lines)` };
    case "overlay_invalid":
      return { state: "overlay_invalid", done: false, detail: `${SCHEDULED_PATH} does not validate (${plan.errors[0]}) — it is never rewritten, so the move waits for it to be fixed` };
  }

  let moved = false;
  if (plan.overlay !== null) {
    try {
      await deps.vault.write(
        SCHEDULED_PATH,
        Buffer.from(plan.overlay, "utf8"),
        { principal: "user", message: `scheduled: the Standup routine's schedule, read once from ${PROFILE_PATH} (${plan.keys.join(", ")})` },
        overlay === null ? "" : sha256(overlay),
      );
      moved = true;
    } catch (err) {
      if (err instanceof VaultError && err.code === "forbidden") {
        return { state: "forbidden", done: true, detail: `the reconciler refused the console's write to ${SCHEDULED_PATH} — the console's authority over it is CALLER_AUTHORITY.console's (T3-2); nothing moved, nothing proposed` };
      }
      if (err instanceof VaultError && err.code === "conflict") {
        return { state: "conflict", done: false, detail: `${SCHEDULED_PATH} changed while the move was writing it — tried again later` };
      }
      throw err;
    }
  }

  if (plan.tidied === null) {
    return { state: "untidy", done: true, moved, detail: `the standup lines in ${PROFILE_PATH} cannot be removed without touching anything else — no request; delete them by hand when you like` };
  }
  const raised = await raiseMirror(deps.db, {
    kind: TIDY_KIND,
    source_agent: TIDY_AGENT,
    trust: "internal",
    payload: tidyPayload({ text, sha256: profile.sha256 }, plan.tidied, plan.keys),
    source: TIDY_SOURCE,
  });
  return { state: "raised", done: true, moved, proposal: raised.id, detail: `${plan.keys.join(", ")} ${moved ? "moved to the Standup routine" : "left to the Standup routine's own schedule"}; ${TIDY_TITLE} raised as request #${raised.id}` };
}

/**
 * Run the move until it reaches a state only a restart could change — at
 * start, then every `retryMs` while the vault, Postgres or the overlay says
 * "not yet". Logs each outcome once.
 */
export function startStandupMove(deps: TidyDeps, opts: { retryMs: number; log?: (line: string) => void }): { stop(): void } {
  const log = opts.log ?? ((l: string) => console.log(l));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let last = "";
  const pass = async (): Promise<void> => {
    let again = true;
    try {
      const out = await moveStandupFacts(deps);
      again = !out.done;
      const line = `standup move: ${out.state} — ${out.detail}`;
      if (line !== last) log(line);
      last = line;
    } catch (err) {
      const line = `standup move: waiting — ${err instanceof Error ? err.message : String(err)}`;
      if (line !== last) log(line);
      last = line;
    }
    if (again && !stopped) timer = setTimeout(() => void pass(), opts.retryMs).unref();
  };
  void pass();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ---- Approve: the owner's hand on Me/ ------------------------------------------------

/** An edit to a file under `Me/` that a request carries, exactly as the owner was shown it. */
export interface MeEdit {
  readonly path: string;
  readonly base_sha256: string;
  readonly before: string;
  readonly after: string;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * The `Me/` edit a request's payload carries, or null when it carries none.
 * Only a path under `Me/` (`USER_OWNED_ROOTS`) — the one place an approval
 * is the only writer — and only the text the owner was shown: Approve writes
 * `body.after.text`, and nothing else in the payload.
 */
export function meEditOf(payload: unknown): MeEdit | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { edit?: unknown; body?: unknown };
  const edit = p.edit as { path?: unknown; base_sha256?: unknown } | undefined;
  const body = p.body as { kind?: unknown; before?: { text?: unknown }; after?: { text?: unknown } } | undefined;
  if (typeof edit !== "object" || edit === null || typeof body !== "object" || body === null) return null;
  const { path, base_sha256 } = edit;
  if (typeof path !== "string" || typeof base_sha256 !== "string" || !SHA_RE.test(base_sha256)) return null;
  const segments = path.split("/");
  if (segments.length < 2 || !(USER_OWNED_ROOTS as readonly string[]).includes(segments[0]!) || segments.some((s) => s === "" || s === "." || s === "..") || !path.endsWith(".md")) return null;
  if (body.kind !== "before_after" || typeof body.before?.text !== "string" || typeof body.after?.text !== "string") return null;
  return { path, base_sha256, before: body.before.text, after: body.after.text };
}

/**
 * Approve: write the edit as `user`, in the owner's name — refused, and
 * nothing written, if the file is not byte for byte what the owner was shown
 * as "before". The compare-and-swap on the write closes the gap between that
 * check and the commit. Throws VaultError: `conflict` when the file changed,
 * or whatever the bridge refused.
 */
export async function applyMeEdit(vault: Pick<VaultClient, "read" | "write">, edit: MeEdit, proposalId: number | string): Promise<{ path: string; sha256: string }> {
  const current = await vault.read(edit.path);
  if (!current || current.sha256 !== edit.base_sha256 || current.content.toString("utf8") !== edit.before) {
    throw new VaultError("conflict", `${edit.path} changed after this was proposed, so nothing was written — Decline it, and edit the file yourself if you still want the change`);
  }
  const r = await vault.write(edit.path, Buffer.from(edit.after, "utf8"), { principal: "user", message: `${edit.path}: approved request #${proposalId}` }, edit.base_sha256);
  return { path: r.path, sha256: r.sha256 };
}
