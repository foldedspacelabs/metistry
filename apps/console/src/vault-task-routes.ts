// The Tick door — `POST /api/vault-tasks/:task_key/check {checked, seen_text}`
// (design-build-plan §2.11, T2-4; daily-flow-spec §2.2, owner ruling Q2).
//
// The owner ticks a task on the Today view and the console writes their note
// as `user`: exactly `[x]` and `done <date>` on that one line, or — Undo, the
// same door with `checked: false` — the box back to a space and that `done`
// removed. The route is incapable of anything else, which is what makes the
// write the owner's hand rather than a machine editing their notes:
//
//   * It takes a key and a boolean, never a patch. The only edit it can make
//     is core's `setTaskChecked`, which refuses any line it cannot prove it
//     changed by exactly those two tokens (it re-parses its own output).
//   * It judges the NOTE, not the index. The index is up to one walk behind,
//     so the line is found in the file by the same key the walk gave it
//     (`locateTaskLine`), and the text the client rendered (`seen_text`) must
//     be the text there — otherwise `409 stale` with the line as it stands.
//   * It writes with the hash of the bytes it read (`expected_sha256`), so a
//     note that moved between the read and the write is the same `409`.
//   * A key whose row is not a knowledge note — `.metistry/`, any
//     dot-directory, `Artifacts/`, the root `CLAUDE.md` — is refused before
//     anything is read. The bridge would let the console write two protected
//     files as `user` (apps/reconciler/src/paths.ts `CALLER_AUTHORITY`); this
//     door is not the way to either.
//   * No model is anywhere in it, and it is not an action: `ACTION_KINDS` is
//     untouched, so no proposal can ask for a tick at any autonomy level.
//
// The Defer door — `POST /api/vault-tasks/:task_key/schedule {do | someday,
// seen_text}` (§2.11, T2-5; owner ruling K6) — is the same door with a
// different edit: core's `setTaskScheduled` writes one `do <date>` or one
// `someday` in `formatTaskLine`'s spelling and nothing else, never a glyph.
// Everything above holds for it word for word: the key, the note judged
// rather than the index, `seen_text` → `409 stale`, the read's hash on the
// write, the refusals before any read. Deferral is one row at a time here;
// "Skip" is not a door at all (K2: Skip is bulk-only, and it is Needs You's).
//
// The Link door — `POST /api/vault-tasks/:task_key/link {ref, seen_text}`
// (§2.1, T4-25) — is the second half of *Send to Linear*: once the tracker
// door has filed the issue (`tracker-issue-route.ts`), this writes its ref on
// the line. Core's `setTaskRef` adds one `linear:<KEY>` (or `gh:<owner>/<repo>#<n>`)
// at the end of the trailing run and nothing else; a line that already
// carries a ref of that scheme is `409 stale`, as is one whose text changed —
// everything above holds for it word for word. It never calls the tracker:
// two doors, one service each.
//
// Reached only by the `user` principal: server.ts's management gate runs
// first, so an agent bearer and the capture owner token get the uniform 403
// there. `Idempotency-Key` is honoured (the PWA's offline outbox replays
// ticks and deferrals, §2.17): see `ReplayCache` for what that holds and for
// how long.

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorEnvelope, isVaultPath, locateTaskLine, parseTaskLine, replaceLine, setTaskChecked, setTaskRef, setTaskScheduled, statusFor, taskToday, TASK_KEY_RE, TASK_REF_RE, type ErrorCode, type LocatedTaskLine, type TaskDateOptions, type TaskDeferral } from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { readJson, sendJson } from "./http-util.js";

/** The named query that turns a key into the note that holds it (seed/queries/vault_task_by_key.yaml). */
export const VAULT_TASK_BY_KEY_QUERY = "vault_task_by_key";

const VAULT_TASK_ROUTE = /^POST \/api\/vault-tasks\/([^/]+)\/(check|schedule|link)$/;
/** Each door's body keys. Anything else is refused by name — a silently ignored field is a lie about what happened. */
const DOOR_FIELDS = {
  check: ["checked", "seen_text", "path"],
  schedule: ["do", "someday", "seen_text", "path"],
  link: ["ref", "seen_text", "path"],
} as const;
const DOOR_BODY = { check: "{checked, seen_text}", schedule: "{do, seen_text} or {someday: true, seen_text}", link: "{ref, seen_text}" } as const;
type Door = keyof typeof DOOR_FIELDS;
/** A task line is one line; this bounds what the door will compare, not what a note may hold. */
const SEEN_TEXT_MAX = 10_000; // limit: fixed — a checkbox line longer than this is a paragraph, and the door refuses rather than compares it
const IDEMPOTENCY_KEY_MAX = 200; // limit: fixed — the same ceiling `POST /capture` enforces (docs/ops/client-api.md)

/** True when the request is for this module. Used by server.ts's management gate so a non-`user` credential gets the uniform 403. */
export function isVaultTaskRoute(key: string): boolean {
  return VAULT_TASK_ROUTE.test(key);
}

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface Answer {
  status: number;
  body: unknown;
}

/**
 * `Idempotency-Key` replays for the vault-task doors. A key maps to the FIRST
 * successful answer for 24 hours, scoped to the `user` principal (the only
 * one that reaches these routes), and a second request under a key that is
 * still in flight waits for the first rather than racing it into a `409`.
 *
 * Held in the console's memory, deliberately: git is the record and the note
 * already says whether the box is ticked, so after a console restart a replay
 * is not a second tick — it is `409 stale` carrying the line, which shows the
 * tick the first attempt made. The outbox treats both answers the same way:
 * repaint from the body. Refusals are not remembered; a refused request
 * retried is judged again against the note as it then stands.
 */
export class ReplayCache {
  private readonly done = new Map<string, { fingerprint: string; answer: Answer; at: number }>();
  private readonly inflight = new Map<string, { fingerprint: string; promise: Promise<Answer> }>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000, // limit: fixed — a day covers an offline commute; the note is the record after that
    private readonly max = 1000, // limit: fixed — ticks in a day, generously; the oldest goes first
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Run `act` once per key. `replayed` is true when the answer is an earlier
   * attempt's; a key reused for a DIFFERENT request is a caller bug and
   * answers `400` rather than replaying something the caller did not ask.
   */
  async once(key: string | undefined, fingerprint: string, act: () => Promise<Answer>): Promise<{ answer: Answer; replayed: boolean }> {
    if (key === undefined) return { answer: await act(), replayed: false };
    const now = this.clock();
    for (const [k, v] of this.done) if (now - v.at > this.ttlMs) this.done.delete(k);
    const reused = { status: statusFor("invalid_request"), body: errorEnvelope("invalid_request", "this Idempotency-Key was already used for a different request — mint a new key for each tick; reuse one only to retry the same request") };
    const hit = this.done.get(key);
    if (hit) return hit.fingerprint === fingerprint ? { answer: hit.answer, replayed: true } : { answer: reused, replayed: false };
    const running = this.inflight.get(key);
    if (running) return running.fingerprint === fingerprint ? { answer: await running.promise, replayed: true } : { answer: reused, replayed: false };
    const promise = act();
    this.inflight.set(key, { fingerprint, promise });
    try {
      const answer = await promise;
      if (answer.status >= 200 && answer.status < 300) {
        this.done.set(key, { fingerprint, answer, at: now });
        while (this.done.size > this.max) this.done.delete(this.done.keys().next().value!);
      }
      return { answer, replayed: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}

export interface VaultTaskDeps {
  queries: QueryStore;
  /** The reconciler's bridge. Absent → `503`: this door writes a note, and a deployment with no bridge cannot. */
  vault?: VaultClient | undefined;
  audit: Audit;
  replays: ReplayCache;
  /** The instant `done <date>` is taken from, in `METISTRY_TZ` (or `timeZone`). Injectable for tests. */
  now?: (() => Date) | undefined;
  timeZone?: string | undefined;
}

/** What a door says about the line it wrote (or found stale). */
export type View = (path: string, t: LocatedTaskLine) => Record<string, unknown>;

/** What the Tick door says about the line: facts about the bytes it read or wrote, never the index's derived columns — those arrive with the next walk. */
function taskView(path: string, t: LocatedTaskLine) {
  return { path, task_key: t.task_key, anchor: t.parsed.anchor, line_no: t.line_no, text: t.parsed.text, checked: t.parsed.checked, done_on: t.parsed.done_on };
}

/** The Defer door's view: the same facts, with the day it now has (and `due`, which it never moves, for the row to repaint beside it). */
function deferView(path: string, t: LocatedTaskLine) {
  return { path, task_key: t.task_key, anchor: t.parsed.anchor, line_no: t.line_no, text: t.parsed.text, checked: t.parsed.checked, due: t.parsed.due, scheduled_for: t.parsed.scheduled_for, someday: t.parsed.someday };
}

/** The Link door's view: the Tick door's facts and the refs the line carries now. */
function linkView(path: string, t: LocatedTaskLine) {
  return { ...taskView(path, t), ext_refs: t.parsed.ext_refs };
}

const fail = (code: ErrorCode, message: string): Answer => ({ status: statusFor(code), body: errorEnvelope(code, message) });
/** `409 stale`: what the client rendered is not what the note holds. The body carries the line as it stands (null when the line is gone). */
const stale = (message: string, path: string, t: LocatedTaskLine | null, view: View = taskView): Answer => ({
  status: statusFor("conflict"),
  body: { ...errorEnvelope("conflict", message), reason: "stale", line: t?.line ?? null, task: t ? view(path, t) : null },
});

export async function vaultTaskRoutes(req: IncomingMessage, res: ServerResponse, key: string, deps: VaultTaskDeps): Promise<void> {
  const m = VAULT_TASK_ROUTE.exec(key)!;
  const door = m[2] as Door;
  let taskKey: string;
  try {
    taskKey = decodeURIComponent(m[1]!);
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "the task key is not valid percent-encoding"));
  }
  if (!TASK_KEY_RE.test(taskKey)) return sendJson(res, 400, errorEnvelope("invalid_request", "a task key is an anchor (`mt-…`) or a hash key (`h:<sha256>:<n>`) exactly as GET /api/today returns it"));

  let body: Record<string, unknown>;
  try {
    const raw = await readJson(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sendJson(res, 400, errorEnvelope("invalid_request", `body must be a JSON object: ${DOOR_BODY[door]}`));
    body = raw as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "request body is not JSON"));
  }
  const fields: readonly string[] = DOOR_FIELDS[door];
  const unknown = Object.keys(body).filter((k) => !fields.includes(k));
  if (unknown.length > 0) return sendJson(res, 400, errorEnvelope("invalid_request", `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — the body is ${DOOR_BODY[door]} and, where a key names two notes, path`));

  // the door's own field, checked before anything they share
  let checked = false;
  let when: TaskDeferral = { someday: true };
  let ref = "";
  if (door === "link") {
    if (typeof body.ref !== "string" || !TASK_REF_RE.test(body.ref)) return sendJson(res, 400, errorEnvelope("invalid_request", "ref must be linear:<TEAM-123> or gh:<owner>/<repo>#<number> — the ref the tracker door answered"));
    ref = body.ref;
  } else if (door === "check") {
    if (typeof body.checked !== "boolean") return sendJson(res, 400, errorEnvelope("invalid_request", "checked must be true (tick) or false (Undo)"));
    checked = body.checked;
  } else {
    if ((body.do === undefined) === (body.someday === undefined)) return sendJson(res, 400, errorEnvelope("invalid_request", "send exactly one of do (a day, YYYY-MM-DD) or someday (true)"));
    if (body.do !== undefined) {
      if (typeof body.do !== "string" || !ISO_DAY_RE.test(body.do) || !isCalendarDay(body.do)) return sendJson(res, 400, errorEnvelope("invalid_request", "do must be a calendar day, YYYY-MM-DD — the client resolves `tomorrow` or `next week` before it sends"));
      when = { do: body.do };
    } else if (body.someday !== true) {
      return sendJson(res, 400, errorEnvelope("invalid_request", "someday must be true — to give the line a day, send do"));
    }
  }
  if (typeof body.seen_text !== "string" || body.seen_text.length > SEEN_TEXT_MAX) return sendJson(res, 400, errorEnvelope("invalid_request", "seen_text must be the task's text exactly as the client rendered it (the row's `text`)"));
  if (body.path !== undefined && (typeof body.path !== "string" || body.path === "")) return sendJson(res, 400, errorEnvelope("invalid_request", "path, when given, is the note's vault path as the row names it"));
  const seenText = body.seen_text;
  const wantPath = body.path as string | undefined;

  const rawKey = req.headers["idempotency-key"];
  const idemKey = typeof rawKey === "string" ? rawKey.trim() : undefined;
  if (idemKey !== undefined && (idemKey === "" || idemKey.length > IDEMPOTENCY_KEY_MAX)) return sendJson(res, 400, errorEnvelope("invalid_request", `Idempotency-Key must be 1–${IDEMPOTENCY_KEY_MAX} characters`));

  const fingerprint = JSON.stringify([taskKey, door === "check" ? checked : door === "schedule" ? when : ref, seenText, wantPath ?? null]);
  const act = door === "check" ? () => check(taskKey, checked, seenText, wantPath, deps) : door === "schedule" ? () => schedule(taskKey, when, seenText, wantPath, deps) : () => link(taskKey, ref, seenText, wantPath, deps);
  const { answer, replayed } = await deps.replays.once(idemKey === undefined ? undefined : `user:${door}:${idemKey}`, fingerprint, act);
  if (replayed) res.setHeader("idempotency-replayed", "true");
  return sendJson(res, answer.status, answer.body);
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `2026-02-30` has the shape and is no day: round-trip it through the UTC calendar, which has no zone to disagree with. */
function isCalendarDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type Audited = (ok: boolean, outcome: string, answer: Answer) => Promise<Answer>;

/** The line a door acts on, found in the note — or the answer that says why not. */
export type Found =
  | { ok: true; vault: VaultClient; path: string; sha256: string; content: string; line: LocatedTaskLine; opts: TaskDateOptions; today: string }
  | { ok: false; answer: Answer };

/**
 * Every door's first half: the key to its one note, the refusals before any
 * read, the read, the line found in the note by the walk's own key, and the
 * text judged against what the client rendered. Stops with an answer at the
 * first thing that is not so. `seenText: null` is Send to Linear's read
 * (`tracker-issue-route.ts`), which writes nothing and takes the line's text
 * as it stands.
 */
export async function findLine(taskKey: string, seenText: string | null, wantPath: string | undefined, deps: Pick<VaultTaskDeps, "queries" | "vault" | "now" | "timeZone">, audited: Audited, view: View, act: string): Promise<Found> {
  const no = (answer: Answer): Found => ({ ok: false, answer });
  if (!deps.vault) return no(fail("not_available", `${act} a task needs its note, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)`));
  const vault = deps.vault;

  const { rows } = await deps.queries.run(VAULT_TASK_BY_KEY_QUERY, { task_key: taskKey });
  const candidates = rows.filter((r) => wantPath === undefined || r.path === wantPath);
  if (candidates.length === 0) return no(fail("not_found", wantPath === undefined ? `no task has the key ${taskKey} — the index may not have walked the note yet; refresh Today` : `no task has the key ${taskKey} in ${wantPath}`));
  if (candidates.length > 1) {
    const paths = candidates.map((r) => String(r.path));
    return no(fail("invalid_request", `the key ${taskKey} names a line in ${paths.length} notes (${paths.join(", ")}) — send path to say which`));
  }
  const path = String(candidates[0]!.path);

  // Refused before anything is read: these doors write knowledge notes and
  // nothing else (`isVaultPath`: no dot-directory — `.metistry/` above all —
  // no `Artifacts/`, not the root CLAUDE.md or README.md), and markdown only.
  if (!isVaultPath(path) || !path.endsWith(".md")) return no(await audited(false, "forbidden_path", fail("forbidden", "that task's note is not in the vault this door writes — only knowledge notes (never `.metistry/`, a dot-directory or `Artifacts/`) are written here")));

  const opts = { now: (deps.now ?? (() => new Date()))(), timeZone: deps.timeZone };
  const today = taskToday(opts);

  let file;
  try {
    file = await vault.read(path);
  } catch (err) {
    if (err instanceof VaultError) return no(fail(err.code, `the vault bridge refused to read the note: ${err.message}`));
    throw err;
  }
  if (!file) return no(await audited(false, "stale", stale("the note that held this task is gone — refresh Today", path, null, view)));
  const content = file.content.toString("utf8");
  const line = locateTaskLine(content, taskKey, opts);
  if (!line) return no(await audited(false, "stale", stale("the line is no longer in the note — it was edited or removed since Today was drawn", path, null, view)));
  if (seenText !== null && line.parsed.text !== seenText) return no(await audited(false, "stale", stale("the line's text changed since Today was drawn — here it is as it stands", path, line, view)));
  return { ok: true, vault, path, sha256: file.sha256, content, line, opts, today };
}

/** Both doors' second half: the one line replaced, written as `user` with the read's hash; a note that moved meanwhile is `409 stale` with the line as it now stands. */
async function writeLine(f: Extract<Found, { ok: true }>, taskKey: string, edited: string, message: string, audited: Audited, view: View, outcome: string): Promise<Answer> {
  const next = replaceLine(f.content, f.line.line_no, edited);
  try {
    await f.vault.write(f.path, Buffer.from(next, "utf8"), { principal: "user", message }, f.sha256);
  } catch (err) {
    if (err instanceof VaultError && err.code === "conflict") {
      // the note moved between the read and the write: say what it holds now
      const now = await f.vault.read(f.path).catch(() => null);
      const current = now ? locateTaskLine(now.content.toString("utf8"), taskKey, f.opts) : null;
      return audited(false, "stale", stale("the note changed while the edit was being written — here is the line as it stands", f.path, current, view));
    }
    if (err instanceof VaultError) return audited(false, err.code, fail(err.code, `the vault bridge refused the write: ${err.message}`));
    throw err;
  }
  const written: LocatedTaskLine = { ...f.line, line: edited, parsed: parseTaskLine(edited, f.opts)! }; // the edit proved it parses
  return audited(true, outcome, { status: 200, body: { ok: true, task: view(f.path, written), line: edited } });
}

async function check(taskKey: string, checked: boolean, seenText: string, wantPath: string | undefined, deps: VaultTaskDeps): Promise<Answer> {
  const verb = checked ? "tick" : "untick";
  const audited: Audited = async (ok, outcome, answer) => {
    // the key and the outcome, never the path or the text: `runs` is read by
    // surfaces broader than this door, and the line is the owner's own words
    await deps.audit("vault_task", "check", ok, { task_key: taskKey, checked, outcome });
    return answer;
  };
  const f = await findLine(taskKey, seenText, wantPath, deps, audited, taskView, "ticking");
  if (!f.ok) return f.answer;
  const { path, line } = f;
  if (line.parsed.checked === checked) return audited(false, "stale", stale(checked ? "the line is already ticked" : "the line is not ticked", path, line));

  const edit = setTaskChecked(line.line, checked, f.today, f.opts);
  if (!edit.ok) {
    // the box moved under the client (ticked, or dropped `[-]`, in the note): stale, with the line
    if (edit.reason === "already" || edit.reason === "dropped") return audited(false, "stale", stale(edit.message, path, line));
    return audited(false, edit.reason, fail("invalid_request", `${edit.message} (${path}, line ${line.line_no})`));
  }
  return writeLine(f, taskKey, edit.line, `${checked ? "complete" : "reopen"} "${line.parsed.text.slice(0, 120)}"`, audited, taskView, verb);
}

async function schedule(taskKey: string, when: TaskDeferral, seenText: string, wantPath: string | undefined, deps: VaultTaskDeps): Promise<Answer> {
  const deferral = "do" in when ? "do" : "someday";
  const audited: Audited = async (ok, outcome, answer) => {
    // as Tick: the key, what was asked and the outcome — never the path or the text.
    // `to` is where the line was sent: Close the Day's "what moved and to
    // when" reads it back (seed/queries/day_close.yaml), because the index
    // only ever knows where a line's day is NOW
    await deps.audit("vault_task", "schedule", ok, { task_key: taskKey, deferral, to: "do" in when ? when.do : "someday", outcome });
    return answer;
  };
  const f = await findLine(taskKey, seenText, wantPath, deps, audited, deferView, "deferring");
  if (!f.ok) return f.answer;
  const { path, line } = f;

  const edit = setTaskScheduled(line.line, when, f.opts);
  if (!edit.ok) {
    // the line moved under the client — ticked, dropped, or already deferred so, in the note: stale, with the line
    if (edit.reason === "done" || edit.reason === "dropped" || edit.reason === "already") return audited(false, "stale", stale(edit.message, path, line, deferView));
    return audited(false, edit.reason, fail("invalid_request", `${edit.message} (${path}, line ${line.line_no})`));
  }
  const text = line.parsed.text.slice(0, 120);
  return writeLine(f, taskKey, edit.line, "do" in when ? `defer "${text}" to ${when.do}` : `defer "${text}" to someday`, audited, deferView, deferral);
}

async function link(taskKey: string, ref: string, seenText: string, wantPath: string | undefined, deps: VaultTaskDeps): Promise<Answer> {
  const audited: Audited = async (ok, outcome, answer) => {
    // as Tick: the key, the ref and the outcome — never the path or the text
    await deps.audit("vault_task", "link", ok, { task_key: taskKey, ref, outcome });
    return answer;
  };
  const f = await findLine(taskKey, seenText, wantPath, deps, audited, linkView, "linking");
  if (!f.ok) return f.answer;
  const { path, line } = f;

  const edit = setTaskRef(line.line, ref, f.opts);
  if (!edit.ok) {
    // the ref (or another of its scheme) is on the line already, in the note: stale, with the line
    if (edit.reason === "already" || edit.reason === "linked") return audited(false, "stale", stale(edit.message, path, line, linkView));
    return audited(false, edit.reason, fail("invalid_request", `${edit.message} (${path}, line ${line.line_no})`));
  }
  return writeLine(f, taskKey, edit.line, `link "${line.parsed.text.slice(0, 120)}" to ${ref}`, audited, linkView, "linked");
}
