// inbox-drain: classify new captures, emit PROPOSALS (D7) — never
// auto-create (§4.12's over-extraction lesson). THREE tiers now, in this
// order, and the order is the whole design:
//
//   1. the deterministic prefilter (`classify`) — frontmatter, a bare URL, a
//      leading action verb, a mime type. Every verdict names the rule that
//      fired.
//   2. the INTENT tier (PoC-20 phase 1, `intent-tier.ts`) — one scored answer
//      token over the closed intent enum, ~150-300 ms, against the OWNER'S
//      thresholds in `rules.yaml`. Runs only on what the rules could not
//      place, and only where `compute.yaml` assigns it a model AND
//      `rules.yaml` names a threshold. Absent on either side ⇒ off, and off
//      is byte-identical to the build before it existed.
//   3. the JSON-schema tier — the on-device model `compute.yaml` names,
//      through the ordinary provider wire (`completeJson`,
//      ../compute-client.ts), for whatever tiers 1 and 2 both left alone.
//
// Both model tiers are free on-device ones and only ever that: the manifest
// pins `uses_model: applefm/foundation-model`, `assignments.intent` is
// refused at load unless its provider is `locality: on_machine`, CI refuses a
// billable provider, and the client refuses again at the call. Absent is
// normal — no such provider in `compute.yaml`, no credential, a bridge that
// is not running, an answer that is not the schema, and the deterministic
// result stands.
//
// The ordering is not only speed. A deterministic check ahead of the model is
// what protects against input the model has no competence for, because
// confidence cannot: an English classifier measured 0.000 accuracy at 0.952
// confidence on Khmer (research §2.3.1.3). Rules first is correct engineering
// before it is correct governance.

import type { CaptureSink } from "@foldedspacelabs/metistry-mcp-brain";
import type { ImapSyncOpener, SyncOpener } from "@foldedspacelabs/metistry-connections";
import {
  calendarDate,
  finishRun,
  intentStage,
  jotAnchorOf,
  meetingGroupId,
  pickMeetingEvent,
  raiseMirror,
  recordedSessionOf,
  resolveIntentTier,
  startRun,
  type IntentRules,
  type JotAnchor,
  type MeetingEvent,
  type MirrorRaise,
  type TemplateQueries,
} from "@foldedspacelabs/metistry-core";
import { completeJson, type ComputeAccess } from "../compute-client.js";
import { intentMeta, intentPlacement, scoreIntent, type IntentOutcome } from "./intent-tier.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface InboxRow {
  id: number;
  path: string;
  mime: string | null;
  note: string | null;
  source: string;
  source_agent?: string | null; // set when the capture came in on an agent token (migration 0007)
}

export interface Classification {
  kind: "todo" | "url" | "image" | "document" | "note" | "session" | "transcript" | "jot";
  reason: string; // which rule fired — auditable, not vibes
  title: string;
}

/**
 * A task this capture is *asking for*, if it is asking for one. The console
 * renders it as the extra decision **Approve as work**, which inserts the
 * `work` row on the click (docs/research/2026-09-16-taskuary-review.md ADOPT
 * 2). Nothing here creates anything — §4.12 is intact because the row is born
 * of a human's hand, not of this collector's opinion.
 */
export interface SuggestedWork {
  title: string;
  project?: string;
  kind?: "task" | "review";
}

const URL_RE = /^https?:\/\/\S+$/i;
const TODO_RE = /^(todo|remind me|remember to|don't forget|buy|call|email|schedule)\b/i;
// `@task do the thing`, `todo: do the thing`, and the markdown checkbox. The
// same shape the router uses for `/note` (invariant 4, apps/console/src/router.ts):
// an explicit leading cue, matched by regex, first match wins, NO model.
const TASK_CUE_RE = /^(?:@task\b[:\s]*|todo\s*:\s*|[-*]\s*\[\s\]\s*)([\s\S]+)$/i;
// Frontmatter `kind:` values that say "this capture is a task", verbatim.
const TASK_KINDS = new Set(["todo", "task"]);

/**
 * Leading YAML frontmatter, as scalars — enough to read `kind:` and `title:`
 * without a YAML dependency in a collector. Values may be double-quoted (both
 * capture doors write JSON string literals, which are valid YAML scalars).
 * Frontmatter is written by our own doors (`metistry import-sessions`, the
 * Claude Code plugin), so it is trusted for classification only; the body is
 * still foreign content and nothing here interprets it.
 */
export function frontmatter(note: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(note);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    let v = (kv[2] ?? "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      try {
        v = v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[kv[1]] = v;
  }
  return out;
}

export function classify(row: InboxRow): Classification {
  const note = (row.note ?? "").trim();
  const mime = row.mime ?? "";
  const fm = frontmatter(note);
  const title = fm.title || (note ? note.slice(0, 80) : row.path.replace(/^\d+-/, "").slice(0, 80));

  // A session summary declares itself (stash review item 2): the frontmatter is
  // authoritative, so no FM tier is consulted and Needs You can label it.
  if (fm.kind === "session") return { kind: "session", reason: "frontmatter kind: session", title };
  // A recording's transcript (packages/mcp-live-capture, daily-flow-spec
  // §8.4) declares itself the same way — and being placed here, it never
  // falls through to a model tier.
  if (fm.kind === "transcript") return { kind: "transcript", reason: "frontmatter kind: transcript", title };
  // A jot the owner made during a recording (T8-7, C77) is the owner's own
  // words, saved when typed: never a proposal, never a model's to read. Only
  // from the owner's door, and only when its anchor reads — an agent's
  // capture that says `kind: jot` is an ordinary capture, placed by the rules
  // like any other, so no agent can put words in the owner's mouth on a
  // meeting's card.
  if (fm.kind === "jot") {
    if (row.source_agent) return { kind: "note", reason: "frontmatter kind: jot from an agent credential — an ordinary capture", title };
    if (!jotAnchorOf(note)) return { kind: "note", reason: "frontmatter kind: jot without a readable anchor — an ordinary capture", title };
    return { kind: "jot", reason: "frontmatter kind: jot", title };
  }

  if (note && URL_RE.test(note)) return { kind: "url", reason: "note is a bare url", title };
  if (note && TODO_RE.test(note)) return { kind: "todo", reason: "leading action verb", title };
  if (mime.startsWith("image/")) return { kind: "image", reason: `mime ${mime}`, title };
  if (mime.includes("pdf") || /\.(pdf|docx?|pages)$/i.test(row.path)) {
    return { kind: "document", reason: "document mime/extension", title };
  }
  return { kind: "note", reason: "default", title };
}

/** The note with its leading frontmatter removed — the part a human actually typed. */
function body(note: string): string {
  return note.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, "").trim();
}

/**
 * Does this capture suggest a `work` row, and what would it say? Three cues,
 * in order, all deterministic (invariant 4 — a collector never calls a model,
 * and the Apple FM tier's `has_action` is deliberately NOT read here):
 *
 *   1. frontmatter `kind: todo|task` — our own doors declaring it;
 *   2. an explicit leading cue on the first body line (`@task …`, `todo: …`,
 *      `- [ ] …`) — the same "explicit command" shape the router uses;
 *   3. the classifier's existing `todo` verdict (`TODO_RE`, "buy milk").
 *
 * Returns undefined for everything else, which is most things. A suggestion
 * is not a decision: the proposal still waits for a click.
 */
export function suggestedWork(row: InboxRow, c: Classification): SuggestedWork | undefined {
  const note = (row.note ?? "").trim();
  if (!note) return undefined;
  const fm = frontmatter(note);
  const first = body(note).split(/\r?\n/)[0]?.trim() ?? "";
  const cue = TASK_CUE_RE.exec(first);

  let title: string | undefined;
  if (TASK_KINDS.has((fm.kind ?? "").toLowerCase())) title = fm.title || cue?.[1] || first;
  else if (cue?.[1]) title = cue[1];
  else if (c.kind === "todo") title = c.title;
  if (!title) return undefined;

  const trimmed = title.trim().slice(0, 200); // limit: fixed — `work.title` is capped at 500 by TasksService; 200 keeps a card readable
  if (!trimmed) return undefined;
  // `project` only when the frontmatter names one in the slug form the
  // projects table uses; free text would invent a project on accept.
  const project = (fm.project ?? "").trim();
  return { title: trimmed, ...(/^[a-z][a-z0-9-]{0,39}$/.test(project) ? { project } : {}) };
}

/** The report a crashed recording raises: its subject, so one recording is one card however often it is raised. */
export const RECORDING_CRASH_SOURCE = "live-capture";

/**
 * A recording that crashed raises ONE report in Needs You (C137: "saved up to
 * the crash; one report"). The recorder cannot write a request itself — a
 * bridge talks to no database (invariant 3) — so it says `ended_reason:
 * crashed` in the transcript it delivers, and this drain, which already reads
 * every capture's frontmatter, raises the report from it.
 *
 * Only from the owner's own door: a capture that came in on an AGENT token
 * raises nothing, so no agent can put a "your recording crashed" card in
 * front of the owner. One per session: the subject is the session id, so a
 * second raise while the first waits returns the first (`raiseMirror`), and
 * the recorder's `Idempotency-Key` already makes a redelivery the same inbox
 * row. Deterministic — the words below are this file's, never the capture's
 * body.
 */
export function crashReport(row: InboxRow, c: Classification): MirrorRaise | undefined {
  if (c.kind !== "transcript" || row.source_agent) return undefined;
  const fm = frontmatter((row.note ?? "").trim());
  if (fm.ended_reason !== "crashed") return undefined;
  const session = (fm.capture_session ?? "").trim();
  if (!/^[a-z0-9-]{1,64}$/.test(session)) return undefined;
  const endedAt = Date.parse(fm.ended_at ?? "");
  const upTo = Number.isNaN(endedAt) ? "" : ` at ${new Date(endedAt).toISOString().slice(11, 16)} UTC`;
  return {
    kind: "report",
    source_agent: "inbox-drain",
    trust: "internal",
    source: { kind: RECORDING_CRASH_SOURCE, external_ref: `crash:${session}` },
    payload: {
      title: "A recording stopped unexpectedly",
      body: `The recorder stopped${upTo} without being told to. Everything it heard up to then was saved: the transcript is saved at ${row.path}. To keep recording, Record again from the capture bar.`,
      event: "recording_crashed",
      capture_session: session,
      inbox_id: Number(row.id),
      path: row.path,
      refs: [row.path],
      ...(Number.isNaN(endedAt) ? {} : { ended_at: new Date(endedAt).toISOString() }),
    },
  };
}

// The optional on-device model tier (ruled 2026-09-01: free on-device
// classification permitted for this collector; billable models never).
// Deterministic rules that positively fired stand; only default-"note"
// fallthroughs with text are refined by the model. Degrades absent: no
// provider, or any failure of it, keeps the deterministic result.
export interface CollectorCtx extends ComputeAccess {
  /**
   * `rules.yaml`'s `intent:` block, handed down by the runner — the DECISION
   * half of the intent tier (§3.2 P2).
   *
   * It is a separate field from `compute` on purpose, because the two are
   * different kinds of statement made by different means. `compute.yaml`
   * names the MODEL and is an ordinary config file; `.metistry/rules.yaml` is
   * a §4.7 protected path — the user's own hand — and is where the THRESHOLD
   * lives. Absent here means the tier does not run however `compute.yaml` is
   * configured: a model with no threshold is a classifier nobody decided to
   * act on.
   */
  intentRules?: IntentRules;
  /**
   * A sync's Needs You switches, resolved by the runner: each rule its
   * manifest's `needs_you` declares, the owner's `syncs.<name>.raise` in
   * `.metistry/scheduled.yaml` over the manifest's default (§2.5). Absent for
   * a component that declares none, or one run outside the runner (a test) —
   * the sync then applies its manifest's defaults itself.
   */
  raise?: Readonly<Record<string, boolean>>;
  ekUrl?: string; // eventkit bridge (routines use it for schedule/meeting prep)
  ekToken?: string;
  githubToken?: string; // github-state collector (fine-grained read-only PAT)
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }; // aws-costs collector
  awsCostDays?: number;
  claudeUsageDays?: number; // claude-usage collector (trailing window)
  githubRepos?: string[];
  devinApiKey?: string; // devin-knowledge collector (`cog_…` service-user key or PAT)
  devinOrgId?: string; // `org-…`; resolved from GET /v3/self when unset
  devinRepos?: string[]; // ["owner/repo", ...] whose wikis to pull; empty = notes only
  devinMaxItems?: number; // cap per run (default 200)
  devinApiUrl?: string; // REST base override (devin-sessions); default https://api.devin.ai
  devinSessionTimeoutHours?: number; // devin-sessions: how long a dispatched session may sit non-terminal (default 24)
  inboxDir?: string; // fallback capture directory when no sink is injected
  inboxSink?: CaptureSink; // where devin-knowledge's captures land: the vault inbox over the reconciler's bridge (docs/ops/inbox.md)
  fetchFn?: typeof fetch;
  /**
   * How a sync opens the connection it reads (packages/connections
   * `instanceSyncOpener`): the console builds one from the instance, and it
   * hands back a `fetch` pinned to the provider's host with secrets filled at
   * the egress door. The `linear` collector reads its connection through it.
   */
  openSync?: SyncOpener;
  /**
   * How the mail sync opens the mailbox it reads (packages/connections
   * `instanceImapOpener`, T4-17): the instance's catalog afresh per run, and
   * a session whose host guard sends the app password to the connection's
   * host:port over TLS or nowhere. Headers only; it cannot send.
   */
  openImap?: ImapSyncOpener;
  /**
   * The owner's zone (`METISTRY_TZ`, core `configuredTimeZone`), for a sync
   * that must say which DAY something is on: the ICS sync reads an all-day
   * date as the owner's midnight to midnight, and its window starts at the
   * owner's midnight. Absent: UTC. Not `timeZone`, which is a routine's
   * scheduled slot's zone.
   */
  ownerTimeZone?: string;
  /**
   * The named-query store (`packages/queries`, invariant 3) — the runner
   * hands every component the same one. The inbox drain reads the owner's
   * calendar through `day_events` to name a recording's meeting (T8-7).
   * Absent: a meeting keeps the recorder's own title.
   */
  queries?: TemplateQueries | undefined;
}

export interface FmResult {
  category: string;
  has_action: boolean;
  action: string;
}

/**
 * The schema the model is held to. It was a compiled `@Generable` struct in
 * the bridge's Swift helper; it is a JSON Schema here, which is what moving
 * to the provider wire buys — the shape and the wording belong to the
 * collector that needs them, not to the bridge, and changing either is a
 * TypeScript edit rather than a Swift rebuild and a re-sign.
 *
 * Three fields, all required. PoC-19 measured roughly 32 tokens per
 * described field against a 4096-token window, so this is nowhere near the
 * ceiling; a schema that got near it would be refused with a 400 naming the
 * field rather than failing mid-generation.
 */
export const FM_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["todo", "event", "idea", "link", "note"], description: "The single best category for this inbox item." },
    has_action: { type: "boolean", description: "true ONLY if the item states a concrete task the user personally must do. Pure information, musings, and links with no stated intent are false." },
    action: { type: "string", description: "If has_action is true, a short imperative action phrase of at most 8 words. If has_action is false, the empty string." },
  },
  required: ["category", "has_action", "action"],
  additionalProperties: false,
} as const;

const FM_CATEGORIES = new Set(FM_SCHEMA.properties.category.enum as readonly string[]);

export const FM_INSTRUCTIONS = [
  "You classify short personal-inbox capture items for a productivity assistant.",
  "Choose exactly one category: todo (user must do), event (dated calendar item),",
  "idea (thought or speculation), link (primarily a URL), note (fact, nothing to do).",
  "Set has_action true ONLY for a concrete task the user must personally perform.",
  "Be conservative: precision matters more than recall. Do not invent tasks.",
].join("\n");

/** How many items one pass may send to the model. */
const FM_MAX_ITEMS = 25; // limit: fixed — the select above takes 50 rows; on-device generation is serial and ~0.5s each, so half a pass is the most worth spending inside a 5-minute window

/** How much of a capture the model sees. */
const FM_MAX_CHARS = 2000; // limit: fixed — the model's context is 4096 tokens and the schema is charged to it; 2000 characters leaves room for both

/**
 * One capture through the on-device tier, or undefined. Serial on purpose:
 * the Apple FM helper answers one generation at a time by design, so
 * firing these in parallel would only move the queue.
 */
async function fmClassify(ctx: CollectorCtx, text: string): Promise<FmResult | undefined> {
  const r = await completeJson<Partial<FmResult>>(ctx, {
    collector: "inbox-drain",
    schemaName: "classification",
    schema: FM_SCHEMA as unknown as Record<string, unknown>,
    messages: [
      { role: "system", content: FM_INSTRUCTIONS },
      { role: "user", content: text.slice(0, FM_MAX_CHARS) },
    ],
  });
  if (!r.ok) return undefined;
  // PARSE, NEVER MATCH (PoC-19 result 3: key order out of Apple's
  // structured output is not stable between identical runs). And validate:
  // `strict: true` is the provider's promise, not this collector's
  // assumption — a category outside the enum would otherwise become a
  // proposal `kind` nothing in the console can render.
  const v = r.value;
  if (typeof v.category !== "string" || !FM_CATEGORIES.has(v.category)) return undefined;
  if (typeof v.has_action !== "boolean") return undefined;
  return { category: v.category, has_action: v.has_action, action: typeof v.action === "string" ? v.action : "" };
}

/**
 * The intent tier's configuration, or undefined — and undefined is the
 * shipped default.
 *
 * TWO files have to agree before a verdict can move anything: `compute.yaml`
 * names the model (`assignments.intent`, refused at load unless it is
 * on-machine) and `.metistry/rules.yaml` names the threshold (a §4.7
 * protected path, the user's own hand). Either one alone is not enough, and
 * that is the point — the model is a compute choice and the risk tolerance is
 * the owner's, and neither is the other.
 */
function intentTierOf(ctx: CollectorCtx): { modelRef: string; rules: IntentRules } | undefined {
  const rules = ctx.intentRules;
  if (!rules) return undefined;
  const cfg = ctx.compute?.();
  const assigned = cfg ? resolveIntentTier(cfg) : undefined;
  if (!assigned) return undefined;
  return { modelRef: assigned.ref, rules };
}

/**
 * One verdict into the audit (§4.3): a `runs` row, always, INCLUDING the
 * discarded ones — "a verdict below threshold is the most interesting row in
 * the table: it is the training set for phase 3 and the evidence for moving a
 * threshold".
 *
 * `ok` is "the tier ran as designed", never "the classifier was right"
 * (§4.3 property 2 — conflating them makes the watchdog's error rate
 * meaningless). A guard refusal and a below-threshold verdict are both
 * successes of this tier; only a server that could not answer is `false`.
 */
async function recordIntent(db: Db, inboxId: number | string, outcome: IntentOutcome, modelRef: string): Promise<void> {
  const [provider, ...rest] = modelRef.split("/");
  const meta = intentMeta(outcome);
  let id: number;
  try {
    id = await startRun(db as never, {
      component: "inbox-drain",
      kind: "classify",
      tool: "intent",
      provider: provider ?? "",
      model: rest.join("/"),
      meta: { inbox_id: inboxId, ...meta },
    });
  } catch {
    return; // the audit must never be what fails a drain pass
  }
  if (!Number.isFinite(id)) return;
  await finishRun(db as never, id, {
    ok: outcome.outcome !== "unavailable",
    ...(outcome.outcome === "unavailable" ? { error: outcome.why } : {}),
  }).catch(() => undefined);
}

/** The named query a recording's meeting is found through: one day of the owner's calendar, every source (seed/queries/day_events.yaml). */
export const DAY_EVENTS_QUERY = "day_events";

/** How many jots one meeting's card lists. */
const MAX_LISTED_JOTS = 50; // limit: fixed — a card lists the owner's jots by id; past fifty in one meeting the count still says how many, and the anchors are promoted by session, never from this list

/**
 * The calendar event a recording was of, read through `day_events` for each
 * day the recording touches in the owner's zone. Undefined when the store is
 * not wired, the query is not loaded, or it fails — a meeting keeps the
 * recorder's own title rather than failing the pass.
 */
async function meetingEventOf(ctx: CollectorCtx, startedAt: Date, endedAt: Date | null): Promise<MeetingEvent | undefined> {
  const queries = ctx.queries;
  if (!queries) return undefined;
  const tz = ctx.ownerTimeZone || "UTC";
  const days = [...new Set([calendarDate(startedAt, tz), calendarDate(endedAt ?? startedAt, tz)])];
  const rows: Record<string, unknown>[] = [];
  try {
    for (const day of days) rows.push(...(await queries.run(DAY_EVENTS_QUERY, { day, tz })).rows);
  } catch {
    return undefined;
  }
  return pickMeetingEvent(rows, startedAt, endedAt);
}

/**
 * The meeting a recording's transcript opens: one group per session (C81),
 * named from the calendar (`day_events`) and the recorder's own record (the
 * transcript's frontmatter), carrying the owner's jots made during it as
 * handles — ids and offsets, never their words and never the transcript's.
 * Only from the owner's door: an agent's capture that claims to be a
 * transcript opens no meeting.
 */
export async function meetingOf(db: Db, ctx: CollectorCtx, row: InboxRow, c: Classification): Promise<{ groupId: string; meeting: Record<string, unknown> } | undefined> {
  if (c.kind !== "transcript" || row.source_agent) return undefined;
  const rec = recordedSessionOf(row.note);
  if (!rec) return undefined;
  const event = await meetingEventOf(ctx, rec.startedAt, rec.endedAt);
  const jots = (
    await db.query(
      `SELECT id, proposal FROM inbox
       WHERE proposal->>'kind' = 'jot' AND proposal->>'capture_session' = $1 AND source_agent IS NULL AND status <> 'archived'
       ORDER BY (proposal->>'offset_s')::int, id LIMIT $2`,
      [rec.session, MAX_LISTED_JOTS],
    )
  ).rows as { id: number | string; proposal: { jot?: string; offset_s?: number } }[];
  return {
    groupId: meetingGroupId(rec.session),
    meeting: {
      session_id: rec.session,
      session_title: event?.title || rec.title || "Recording",
      started_at: rec.startedAt.toISOString(),
      ended_at: rec.endedAt?.toISOString() ?? null,
      event_id: event?.event_id ?? null,
      event: event ?? null,
      transcript_path: row.path,
      jots: jots.map((j) => ({ inbox_id: Number(j.id), jot: j.proposal.jot, offset_s: j.proposal.offset_s })),
    },
  };
}

/** A jot's inbox classification: what the console's Approve finds it by (the session) and what the card counts it as. */
function jotClassification(c: Classification, anchor: JotAnchor): Record<string, unknown> {
  return {
    ...c,
    jot: anchor.jot,
    offset_s: anchor.offsetS,
    ...(anchor.state === "session" ? { capture_session: anchor.session } : { source: `meeting:${anchor.path}` }),
  };
}

/** One drain pass. Returns how many rows were classified. */
export async function run(db: Db, ctx: CollectorCtx = {}): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, path, mime, note, source, source_agent FROM inbox WHERE status = 'new' ORDER BY ts LIMIT 50`,
  );
  const deterministic = new Map((rows as InboxRow[]).map((r) => [r.id, classify(r)]));
  // Jots first, so a meeting whose transcript arrives in the same pass as its
  // last jots lists them all. Otherwise the order the rows arrived in.
  const items = [...(rows as InboxRow[])].sort((a, b) => Number(deterministic.get(b.id)!.kind === "jot") - Number(deterministic.get(a.id)!.kind === "jot"));

  // The model tiers refine only what the rules couldn't place (reason "default")
  const fallthroughs = items.filter((r) => deterministic.get(r.id)!.reason === "default" && (r.note ?? "").trim()).slice(0, FM_MAX_ITEMS);

  // pg returns bigint ids as strings, so every map below is keyed by Number.
  const intentTier = intentTierOf(ctx);
  const intents = new Map<number, IntentOutcome>();
  const placed = new Map<number, { kind: string; provider: string; reason: string }>();
  if (intentTier) {
    const stage = intentStage();
    for (const r of fallthroughs) {
      const outcome = await scoreIntent(ctx, (r.note ?? "").trim(), {
        modelRef: intentTier.modelRef,
        rules: intentTier.rules,
        stage,
        ...(r.mime !== undefined ? { mime: r.mime } : {}),
      });
      intents.set(Number(r.id), outcome);
      await recordIntent(db, r.id, outcome, intentTier.modelRef);
      // THE RULES DECIDE, and they decide in `intent-tier.ts`. This file asks
      // what they concluded and never looks at the verdict itself: a verdict
      // that does not clear the owner's threshold, or that names an intent the
      // table maps to nothing, simply produces no placement and falls through
      // to the tier below exactly as if it had never run.
      const p = intentPlacement(outcome);
      if (p) placed.set(Number(r.id), p);
    }
  }

  const fm = new Map<number, FmResult>();
  for (const r of fallthroughs) {
    if (placed.has(Number(r.id))) continue; // the intent tier placed it; the slower schema tier has nothing to add
    const got = await fmClassify(ctx, (r.note ?? "").trim());
    if (got) fm.set(Number(r.id), got);
  }
  // The tier's name in the proposal row IS the provider's, so "which model
  // said this" is answerable from the row rather than from the calendar.
  const tierName = ctx.usesModel?.split("/")[0] ?? "model";

  for (const row of items) {
    const det = deterministic.get(row.id)!;
    // The owner's jot (T8-7, C77): saved when typed, so it asks nothing — no
    // proposal. It is settled here with its anchor on the row, which is how
    // the meeting's card counts it and how Approve finds it to promote.
    const anchor = det.kind === "jot" ? jotAnchorOf(row.note) : undefined;
    if (anchor) {
      await db.query(`UPDATE inbox SET status = 'classified', proposal = $2, triaged_at = now() WHERE id = $1`, [row.id, JSON.stringify(jotClassification(det, anchor))]);
      continue;
    }
    const byIntent = placed.get(Number(row.id));
    const refined = fm.get(Number(row.id));
    const intentOutcome = intents.get(Number(row.id));
    const final = byIntent
      ? { kind: byIntent.kind, reason: byIntent.reason, title: det.title }
      : refined
        ? { kind: refined.category, reason: tierName, title: det.title, has_action: refined.has_action, action: refined.action }
        : det;
    const tier = byIntent ? byIntent.provider : refined ? tierName : "deterministic";
    // Provenance rides the credential (§4.19): a capture made with an agent
    // token proposes AS that agent, at external trust; the owner's own
    // captures propose as this collector, at user trust.
    const sourceAgent = row.source_agent || "inbox-drain";
    const trust = row.source_agent ? "external" : "user";
    // The suggestion comes off the DETERMINISTIC classification, never the
    // refined one: a model's `has_action` must not be what puts an extra
    // button under a proposal (invariant 4). The intent verdict is no
    // different — `suggestedWork` has never read a model and does not start
    // here.
    const work = suggestedWork(row, det);
    // A recording's transcript opens its meeting's card (T8-7, C81).
    const meeting = await meetingOf(db, ctx, row, det);
    await db.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, group_id) VALUES ('knowledge', $2, $3, $1, $4)`,
      [
        JSON.stringify({
          inbox_id: row.id,
          path: row.path,
          classification: final,
          note: row.note,
          tier,
          ...(work ? { suggested_work: work } : {}),
          // Every verdict rides the proposal, including the discarded ones
          // (§4.3): a card the owner corrects is only reviewable if what the
          // classifier said is on it.
          ...(intentOutcome ? { intent: intentMeta(intentOutcome) } : {}),
          ...(meeting ? { meeting: meeting.meeting } : {}),
        }),
        sourceAgent,
        trust,
        meeting?.groupId ?? null,
      ],
    );
    const crash = crashReport(row, det);
    if (crash) await raiseMirror(db as Parameters<typeof raiseMirror>[0], crash);
    await db.query(`UPDATE inbox SET status = 'classified', proposal = $2, triaged_at = NULL WHERE id = $1`, [
      row.id,
      JSON.stringify(final),
    ]);
  }
  return items.length;
}
