// session-fold — what the assistant learns about the owner, as proposals
// (C79; screen-12 §2, §5.2–5.4; design-build-plan §2.5, T3-10).
//
// `Me/Working Style.md` is included word for word into prompts, and
// `Me/profile.md` gates the daily-flow routines. Both are `source: user`, both
// say "Metistry discovers these facts from you" — and this routine is the
// discovering. Invariant 2 decides its shape: a learned preference, lesson or
// profile fact arrives in Needs You, and only the owner's Approve writes it,
// as `user`, into the owner's file. The assistant never writes either file
// (`knowledge_write` refuses `Me/` for every principal — core's `may`), and
// neither does this routine: it READS them, to show a before and an after.
//
// One pass, hourly (the manifest), in two halves:
//
//   1. **Harvest.** The fold's last turn, once the assistant has answered it:
//      its ```learned block is read back and CHECKED (learned.ts) — a closed
//      set of kinds, only turns the fold showed, quotes found verbatim in what
//      the owner typed, profile values in the profile's exact shape — and
//      what survives becomes at most ONE request per file (edits.ts computes
//      the after from the file on disk). The turns it covered are then marked
//      folded. A turn that failed, or was never answered within a day, folds
//      nothing: its turns stay in the queue and the next pass tries again.
//   2. **Enqueue.** With no fold turn outstanding, the chat turns not yet
//      folded — quiet for at least SETTLE_MINUTES, before they expire — are
//      assembled into ONE assistant turn on thread `session-fold`. Turns that
//      are not the owner's chat (a routine's own turn, this fold's included,
//      or one no inbound message can be traced to) are marked folded unread:
//      the fold never reads its own output, and never mistakes a machine's
//      words for the owner's.
//
// No model runs here (invariant 4): the routine assembles and checks; the
// assistant, on its own turn, only suggests.
//
// ONE REQUEST PER FILE. Approve is compare-and-swap on the whole file (the
// owner is shown a before and an after, and a file that changed since is
// refused `stale`), so two waiting requests for one file would make the
// second unanswerable the moment the first is approved. A new harvest for a
// file that already has one waiting SUPERSEDES it: the waiting request is
// closed at its source and one request is raised with both sets of lines,
// against the file as it is now.
//
// Retention: the purge (routines/session-purge) deletes a turn at expiry
// whether or not it was folded. This routine runs hourly so a turn is folded
// within hours of going quiet — long before 30 days, and before the
// shortest retention the owner can set (1 day).
//
// Let Metis learn (screen-12 §4): the Session Fold's own Pause, under
// Scheduled (§2.3's row: "the session-fold and purge routines' settings,
// through the Scheduled doors"). Paused, nothing is enqueued or harvested,
// and the archive is kept for reading until the purge takes it.

import { ROUTINE_TIER, calendarDate, raiseMirror, resolveAtSource, type RequestSource } from "@foldedspacelabs/metistry-core";
import type { Db, RoutineCtx } from "../morning-brief/run.js";
import {
  PROFILE_PATH,
  WORKING_STYLE_HEADINGS,
  WORKING_STYLE_PATH,
  appendUnderHeading,
  currentProfileValue,
  lineKey,
  withProfileKey,
  workingStyleHas,
} from "./edits.js";
import { checkItems, parseLearnedBlock, type FoldTurn, type LearnedItem } from "./learned.js";
import { foldInstructions, turnBlock, type BriefTurn } from "./prompt.js";

export const COMPONENT = "session-fold";
/** The fold's own thread — a machine thread, never the owner's chat. */
export const THREAD = "session-fold";
/** `inbound_messages.meta.kind` — a machine turn to the drain (`isChatTurn`), and how the harvest finds its own. */
export const TURN_KIND = "session-fold";

export const SETTLE_MINUTES = 60; // limit: fixed — a turn an hour quiet is one the conversation has moved past; a later "no, actually" folds with it rather than after it
export const MAX_TURNS = 40; // limit: fixed — one fold reads a working day's chat; the rest waits for the next pass, oldest first
export const MAX_BRIEF_BYTES = 16 * 1024; // limit: fixed — the turns block's budget; the oldest turns go first, so what is closest to expiry is never the one left out
export const STALE_HOURS = 24; // limit: fixed — a fold turn unanswered for a day is abandoned, and its turns go back in the queue
export const RUN_LOOKBACK_HOURS = 24; // limit: fixed — a turn's `runs` row starts before its archive row lands; no turn runs a day

/** The file a request stands for — raised once while it waits (migration 0027's pending index), superseded by the next harvest for the same file. */
export const foldSource = (path: string): RequestSource => ({ kind: "metistry", external_ref: `${path}#${COMPONENT}` });

export interface FoldVault {
  read(path: string): Promise<{ content: Buffer; sha256: string } | null>;
}

export interface SessionFoldCtx extends RoutineCtx {
  now?: Date | undefined;
  /** The vault bridge — READ only here: the before a request shows. Absent, nothing is harvested (the turn waits for a vault). */
  vault?: FoldVault | undefined;
  /**
   * Only these sessions' turns are read this pass — what a Fold First over
   * the sessions a purge would lose names (C136), and how a test keeps to
   * its own rows. Absent: every session.
   */
  sessions?: readonly string[] | undefined;
}

/** One turn the brief carried, as the inbound row's `meta.turns` keeps it — enough to check an answer against with the archive purged. */
interface CarriedTurn {
  id: number;
  session_id: string;
  turn_id: string;
  thread: string;
  ts: string;
  /** The owner's inbound message — its text is the only source a quote may come from. */
  message_id: number;
}

const isoMinute = (d: Date, tz: string | undefined): string => {
  if (!tz) return d.toISOString().slice(0, 16).replace("T", " ");
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

// ---- enqueue ----------------------------------------------------------------------

interface QueueRow {
  id: number;
  session_id: string;
  thread: string;
  turn_id: string;
  ts: Date;
  messages: unknown;
  tool_calls: unknown;
  message_id: number | null;
  owner: string | null;
  /** The inbound row's `meta.kind`: a string = a machine turn (the drain's `isChatTurn`). */
  kind: string | null;
}

/**
 * The fold's queue: turns not yet folded, not yet expired, quiet for
 * SETTLE_MINUTES — oldest first — each with the inbound message that asked
 * for it, traced through the turn's own `runs` row (`meta.turn_id` →
 * `meta.message_id`), never through a time window.
 */
async function queue(db: Db, limit: number, sessions: readonly string[] | undefined): Promise<QueueRow[]> {
  const { rows } = await db.query(
    `SELECT a.id, a.session_id::text AS session_id, a.thread, a.turn_id, a.ts, a.messages, a.tool_calls,
            i.id AS message_id, i.text AS owner,
            CASE WHEN jsonb_typeof(i.meta->'kind') = 'string' THEN i.meta->>'kind' END AS kind
     FROM session_archive a
     LEFT JOIN LATERAL (
       SELECT r.meta FROM runs r
       WHERE r.component = 'assistant' AND r.kind = 'turn'
         AND r.ts BETWEEN a.ts - make_interval(hours => $3::int) AND a.ts
         AND r.meta->>'turn_id' = a.turn_id
       ORDER BY r.id DESC LIMIT 1
     ) r ON true
     LEFT JOIN inbound_messages i ON i.id::text = r.meta->>'message_id'
     WHERE a.folded_at IS NULL AND a.expires_at > now()
       AND a.ts <= now() - make_interval(mins => $1::int)
       AND ($4::uuid[] IS NULL OR a.session_id = ANY($4::uuid[]))
     ORDER BY a.ts, a.id
     LIMIT $2`,
    [SETTLE_MINUTES, limit, RUN_LOOKBACK_HOURS, sessions === undefined ? null : [...sessions]],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    session_id: String(r.session_id),
    thread: String(r.thread),
    turn_id: String(r.turn_id),
    ts: new Date(r.ts),
    messages: r.messages,
    tool_calls: r.tool_calls,
    message_id: r.message_id === null || r.message_id === undefined ? null : Number(r.message_id),
    owner: typeof r.owner === "string" ? r.owner : null,
    kind: typeof r.kind === "string" ? r.kind : null,
  }));
}

/** The assistant's last words in the turn — context in the brief, never a source of quotes. */
function replyOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "") return m.content;
  }
  return "";
}

function failedTools(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  return calls.filter((c) => (c as { is_error?: unknown })?.is_error === true).map((c) => String((c as { tool?: unknown }).tool ?? "tool").replace(/^mcp__[^_]+__/, ""));
}

async function markFolded(db: Db, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await db.query(`UPDATE session_archive SET folded_at = now() WHERE id = ANY($1::bigint[]) AND folded_at IS NULL RETURNING id`, [ids]);
  return rows.length;
}

export interface EnqueueOutcome {
  /** The inbound row, when a turn was enqueued. */
  inbound?: number;
  turns: number;
  /** Not the owner's chat — marked folded unread. */
  skipped: number;
}

async function enqueue(db: Db, ctx: SessionFoldCtx, now: Date): Promise<EnqueueOutcome> {
  // Read more than one fold holds, so a queue led by machine turns still
  // reaches the owner's; what is not taken this pass stays for the next.
  const rows = await queue(db, MAX_TURNS * 4, ctx.sessions);
  const machine = rows.filter((r) => r.kind !== null || r.message_id === null || r.owner === null || r.owner.trim() === "");
  const skipped = await markFolded(
    db,
    machine.map((r) => r.id),
  );

  const chat = rows.filter((r) => !machine.includes(r));
  const blocks: string[] = [];
  const carried: CarriedTurn[] = [];
  let bytes = 0;
  for (const r of chat) {
    if (carried.length >= MAX_TURNS) break;
    const turn: BriefTurn = { id: r.id, thread: r.thread, when: isoMinute(r.ts, ctx.timeZone), owner: r.owner!, reply: replyOf(r.messages), failed: failedTools(r.tool_calls) };
    const block = turnBlock(turn);
    const size = Buffer.byteLength(block, "utf8") + 2;
    if (carried.length > 0 && bytes + size > MAX_BRIEF_BYTES) break;
    blocks.push(block);
    bytes += size;
    carried.push({ id: r.id, session_id: r.session_id, turn_id: r.turn_id, thread: r.thread, ts: r.ts.toISOString(), message_id: r.message_id! });
  }
  if (carried.length === 0) return { turns: 0, skipped };

  const date = ctx.timeZone ? calendarDate(ctx.scheduledFor ?? now, ctx.timeZone) : now.toISOString().slice(0, 10);
  const text = [foldInstructions(date, carried.length), "", "---", "", blocks.join("\n\n")].join("\n");
  const { rows: ins } = await db.query(`INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`, [
    THREAD,
    text,
    // `tier: routine` — machine-assembled, the instance's cheap tier;
    // `fresh_session` — the fold is its own task and never continues a
    // chat's context; `kind` makes it a machine turn to the drain. `turns`
    // is what the harvest checks the answer against — kept on the row, so a
    // purge between the turn and its harvest cannot change what counts.
    JSON.stringify({ kind: TURN_KIND, tier: ROUTINE_TIER, fresh_session: true, source: COMPONENT, turns: carried }),
  ]);
  return { inbound: Number(ins[0]?.id), turns: carried.length, skipped };
}

// ---- harvest ----------------------------------------------------------------------

interface Outstanding {
  id: number;
  status: string;
  ts: Date;
  turns: CarriedTurn[];
}

/** The fold's turns not yet harvested — its own `runs` rows are the record of which were. */
async function outstanding(db: Db): Promise<Outstanding[]> {
  const { rows } = await db.query(
    `SELECT i.id, i.status, i.ts, i.meta->'turns' AS turns FROM inbound_messages i
     WHERE i.thread = $2 AND i.meta->>'kind' = $3 AND i.meta->>'source' = $1
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.component = $1 AND r.kind = 'routine_run' AND r.meta->>'harvested' = i.id::text)
     ORDER BY i.id`,
    [COMPONENT, THREAD, TURN_KIND],
  );
  return rows.map((r) => ({ id: Number(r.id), status: String(r.status), ts: new Date(r.ts), turns: Array.isArray(r.turns) ? (r.turns as CarriedTurn[]) : [] }));
}

/** An item as the request's payload keeps it, and as a later harvest reads it back. */
type StoredItem = LearnedItem;

/** What identifies an item across harvests: a Working Style line, or a profile key and value. */
const itemId = (i: Pick<StoredItem, "kind" | "path" | "line" | "key" | "value">): string =>
  i.path === PROFILE_PATH ? `${i.path}#${i.key}=${JSON.stringify(i.value)}` : `${i.path}#${lineKey(i.line)}`;

export interface FileOutcome {
  path: string;
  /** The request raised for this file this pass, if any. */
  raised?: number;
  /** The waiting request it replaced. */
  superseded?: number[];
  /** Items kept out, with why. */
  dropped: { line: string; reason: string }[];
}

/** The owner's earlier answers for this file: the items of a Declined request are never proposed again. */
async function declinedIds(db: Db, path: string): Promise<Set<string>> {
  const src = foldSource(path);
  const { rows } = await db.query(
    `SELECT payload->'items' AS items FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2 AND decision = 'deny'`,
    [src.kind, src.external_ref],
  );
  const out = new Set<string>();
  for (const r of rows) if (Array.isArray(r.items)) for (const i of r.items as StoredItem[]) out.add(itemId(i));
  return out;
}

async function waiting(db: Db, path: string): Promise<{ id: number; items: StoredItem[]; base: string | null } | null> {
  const src = foldSource(path);
  const { rows } = await db.query(
    `SELECT id, payload->'items' AS items, payload->'edit'->>'base_sha256' AS base FROM proposals
     WHERE decision = 'pending' AND source->>'kind' = $1 AND source->>'external_ref' = $2 ORDER BY id DESC LIMIT 1`,
    [src.kind, src.external_ref],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), items: Array.isArray(r.items) ? (r.items as StoredItem[]) : [], base: typeof r.base === "string" ? r.base : null } : null;
}

const KIND_WORDS: Record<LearnedItem["kind"], [string, string]> = { preference: ["preference", "preferences"], lesson: ["lesson", "lessons"], profile: ["profile fact", "profile facts"] };

function countWords(items: readonly StoredItem[]): string {
  const parts: string[] = [];
  for (const k of ["preference", "lesson", "profile"] as const) {
    const n = items.filter((i) => i.kind === k).length;
    if (n > 0) parts.push(`${n === 1 ? "a" : n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`);
  }
  return parts.length <= 1 ? (parts[0] ?? "nothing") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The request's payload: the lines, where they came from, and the whole-file before and after Approve writes — nothing else. */
export function foldPayload(path: string, file: { text: string; sha256: string }, after: string, items: readonly StoredItem[], inbound: number): Record<string, unknown> {
  return {
    title: `Learned from your sessions: ${path}`,
    summary:
      `From your sessions: ${countWords(items)} for ${path}, in your words. ` +
      `Approve writes ${items.length === 1 ? "it" : "them"} into ${path}, as you; Decline writes nothing, and ${items.length === 1 ? "it is" : "they are"} not proposed again.`,
    body: {
      kind: "before_after",
      heading: "What Approve Does",
      before: { label: `${path} now`, text: file.text },
      after: { label: `${path} after`, text: after },
    },
    edit: { path, base_sha256: file.sha256 },
    items,
    fold: { inbound_id: inbound },
  };
}

/**
 * The after for this file, from the file as it is, with the items that are
 * still news — or why each is not. Working Style gets each line under its
 * kind's heading; the profile gets each key set, one proven edit at a time.
 */
function planFile(path: string, text: string, items: readonly StoredItem[]): { after: string; kept: StoredItem[]; dropped: { line: string; reason: string }[] } {
  const dropped: { line: string; reason: string }[] = [];
  const kept: StoredItem[] = [];
  let after = text;
  if (path === WORKING_STYLE_PATH) {
    for (const kind of ["preference", "lesson"] as const) {
      const lines: string[] = [];
      for (const i of items.filter((x) => x.kind === kind)) {
        if (workingStyleHas(text, i.line)) dropped.push({ line: i.line, reason: "already_there" });
        else {
          lines.push(i.line);
          kept.push(i);
        }
      }
      after = appendUnderHeading(after, WORKING_STYLE_HEADINGS[kind], lines);
    }
  } else {
    for (const i of items) {
      if (i.key === undefined || i.value === undefined) continue;
      if (JSON.stringify(currentProfileValue(after, i.key)) === JSON.stringify(i.value)) {
        dropped.push({ line: i.line, reason: "already_there" });
        continue;
      }
      const next = withProfileKey(after, i.key, i.value);
      if (next === null) {
        dropped.push({ line: i.line, reason: `unprovable_edit: ${PROFILE_PATH} cannot take ${i.key} without touching anything else` });
        continue;
      }
      after = next;
      kept.push(i);
    }
  }
  return { after, kept, dropped };
}

/** Raise — or supersede — the one request for `path`. Reads the file; writes only the queue. */
async function raiseFor(db: Db, vault: FoldVault, path: string, fresh: readonly StoredItem[], inbound: number): Promise<FileOutcome> {
  const out: FileOutcome = { path, dropped: [] };
  const prior = await waiting(db, path);
  if (fresh.length === 0) return out; // nothing new: a waiting request stays exactly as the owner may be reading it
  const file = await vault.read(path);
  if (file === null) {
    out.dropped.push(...fresh.map((i) => ({ line: i.line, reason: `no_file: there is no ${path} — the owner's to create` })));
    return out;
  }
  const text = file.content.toString("utf8");
  const declined = await declinedIds(db, path);

  // the waiting request's lines first (they were proposed first), then this
  // harvest's; for the profile the newest value of a key wins
  const merged = new Map<string, StoredItem>();
  for (const i of [...(prior?.items ?? []), ...fresh]) {
    if (declined.has(itemId(i))) {
      out.dropped.push({ line: i.line, reason: "declined_before" });
      continue;
    }
    const slot = path === PROFILE_PATH ? `${i.key}` : itemId(i);
    if (path === PROFILE_PATH) merged.delete(slot);
    if (!merged.has(slot)) merged.set(slot, i);
  }
  const plan = planFile(path, text, [...merged.values()]);
  out.dropped.push(...plan.dropped);

  // Nothing new against the same file (a harvest retried after a failure
  // part-way): the waiting request already says exactly this — leave it be.
  const same = (a: readonly StoredItem[], b: readonly StoredItem[]): boolean => a.map(itemId).sort().join("\n") === b.map(itemId).sort().join("\n");
  if (prior !== null && prior.base === file.sha256 && same(prior.items, plan.kept)) return out;

  const source = foldSource(path);
  if (prior !== null) out.superseded = await resolveAtSource(db, source);
  if (plan.kept.length === 0) return out;
  const raised = await raiseMirror(db, {
    kind: "improvement",
    source_agent: COMPONENT,
    trust: "internal",
    payload: foldPayload(path, { text, sha256: file.sha256 }, plan.after, plan.kept, inbound),
    source,
  });
  out.raised = raised.id;
  return out;
}

export interface HarvestOutcome {
  inbound: number;
  state: "raised" | "nothing" | "no_block" | "invalid_block" | "turn_failed" | "abandoned";
  raised: number[];
  folded: number;
}

async function recordHarvest(db: Db, o: HarvestOutcome, meta: Record<string, unknown>): Promise<void> {
  // The harvest's own row: what makes this inbound turn "harvested", and the
  // counts Activity shows. A turn that failed or was abandoned is a visible
  // skip; a harvest that raised nothing is silent.
  const outcome = o.raised.length > 0 ? "acted" : o.state === "turn_failed" || o.state === "abandoned" ? `skipped:${o.state}` : "silent";
  await db.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ($1, 'routine_run', true, now(), now(), $2)`, [
    COMPONENT,
    JSON.stringify({ outcome, harvested: o.inbound, state: o.state, raised: o.raised, folded: o.folded, ...meta }),
  ]);
}

async function harvest(db: Db, vault: FoldVault, turn: Outstanding): Promise<HarvestOutcome> {
  const ids = turn.turns.map((t) => t.id);
  if (turn.status === "failed") {
    const o: HarvestOutcome = { inbound: turn.id, state: "turn_failed", raised: [], folded: 0 };
    await recordHarvest(db, o, { turns: ids.length });
    return o;
  }
  const { rows } = await db.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1 ORDER BY id DESC LIMIT 1`, [turn.id]);
  const block = parseLearnedBlock(String(rows[0]?.text ?? ""));

  // the owner's words for each turn the fold showed: their inbound messages, which outlive the archive
  const messageIds = turn.turns.map((t) => t.message_id);
  const owner = new Map<number, string>();
  if (messageIds.length > 0) {
    const q = await db.query(`SELECT id, text FROM inbound_messages WHERE id = ANY($1::bigint[])`, [messageIds]);
    for (const r of q.rows) owner.set(Number(r.id), String(r.text ?? ""));
  }
  const turns = new Map<number, FoldTurn>(
    turn.turns.filter((t) => owner.has(t.message_id)).map((t) => [t.id, { id: t.id, session_id: t.session_id, turn_id: t.turn_id, thread: t.thread, ts: t.ts, owner: owner.get(t.message_id)! }]),
  );

  const checked = block.state === "list" ? checkItems(block.items, turns) : { items: [], dropped: [] };
  const files: FileOutcome[] = [];
  for (const path of [WORKING_STYLE_PATH, PROFILE_PATH] as const) {
    const items = checked.items.filter((i) => i.path === path);
    if (items.length > 0) files.push(await raiseFor(db, vault, path, items, turn.id));
  }
  // Read is read: the turns the fold showed are folded whether or not
  // anything came of them — a turn with nothing to learn is not a turn to
  // show again.
  const folded = await markFolded(db, ids);
  const raised = files.flatMap((f) => (f.raised !== undefined ? [f.raised] : []));
  const state: HarvestOutcome["state"] = block.state === "none" ? "no_block" : block.state === "invalid" ? "invalid_block" : raised.length > 0 ? "raised" : "nothing";
  const o: HarvestOutcome = { inbound: turn.id, state, raised, folded };
  await recordHarvest(db, o, {
    turns: ids.length,
    items: checked.items.length,
    ...(checked.dropped.length > 0 ? { dropped: checked.dropped } : {}),
    ...(block.state === "invalid" ? { invalid: block.why } : {}),
    files: files.map((f) => ({ path: f.path, ...(f.raised !== undefined ? { raised: f.raised } : {}), ...(f.superseded?.length ? { superseded: f.superseded } : {}), ...(f.dropped.length ? { dropped: f.dropped } : {}) })),
  });
  return o;
}

async function abandon(db: Db, turn: Outstanding): Promise<HarvestOutcome> {
  const o: HarvestOutcome = { inbound: turn.id, state: "abandoned", raised: [], folded: 0 };
  await recordHarvest(db, o, { turns: turn.turns.length, status: turn.status });
  return o;
}

// ---- the pass -----------------------------------------------------------------------

export interface FoldPass {
  harvested: HarvestOutcome[];
  /** A fold turn still waiting on the assistant — nothing new is enqueued behind it. */
  waiting?: number;
  /** No vault bridge: an answered turn waits for one. */
  no_vault?: boolean;
  enqueued: EnqueueOutcome;
}

/** One pass, for callers that want the whole story (tests, a Run Now that reports). */
export async function foldPass(db: Db, ctx: SessionFoldCtx = {}): Promise<FoldPass> {
  const now = ctx.now ?? new Date();
  const harvested: HarvestOutcome[] = [];
  for (const turn of await outstanding(db)) {
    const answered = turn.status === "done" || turn.status === "failed";
    if (!answered) {
      if (now.getTime() - turn.ts.getTime() >= STALE_HOURS * 3_600_000) {
        harvested.push(await abandon(db, turn));
        continue;
      }
      return { harvested, waiting: turn.id, enqueued: { turns: 0, skipped: 0 } };
    }
    if (turn.status === "done" && !ctx.vault) {
      // a before needs the file: the answer keeps until a vault is wired
      console.warn(`${COMPONENT}: fold turn #${turn.id} is answered, and no vault bridge is wired to read ${WORKING_STYLE_PATH} or ${PROFILE_PATH} — it waits`);
      return { harvested, waiting: turn.id, no_vault: true, enqueued: { turns: 0, skipped: 0 } };
    }
    harvested.push(await harvest(db, ctx.vault ?? { read: async () => null }, turn));
  }
  return { harvested, enqueued: await enqueue(db, ctx, now) };
}

/** The scheduled run: requests raised plus fold turns enqueued (0 = silent). */
export async function run(db: Db, ctx: SessionFoldCtx = {}): Promise<number> {
  const pass = await foldPass(db, ctx);
  return pass.harvested.reduce((n, h) => n + h.raised.length, 0) + (pass.enqueued.inbound !== undefined ? 1 : 0);
}
