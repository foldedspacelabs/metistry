// standup — the morning's machine file (design-build-plan §2.13, §2.5; ticket
// T3-5).
//
// It renders `Templates/Standup.md` — a markdown file in the owner's own
// vault, which they edit in Obsidian — into `Journal/Standup/<date>.md`,
// written through the reconciler's vault bridge as `principal: standup`, so
// the file carries `source: standup`. `Journal/Standup/` is this routine's
// reserved subfolder: an OWNERSHIP fact about the routine (owner ruling (a),
// W1, decisions-log.md), not a grant — it writes there under its own
// principal, and nothing else is widened by it.
//
// The rules around that one write are mechanisms, not intentions:
//
//  1. **No model in the routine** (invariant 4). §2.13 names the fold's
//     pattern — a skeleton, and ONE assistant turn for the `prose` slots —
//     and C103 (T3-6) makes `prose` legal in a standup render: every other
//     directive is filled here, each `prose` line is left as a pending
//     marker, and when there is at least one the routine enqueues one turn
//     (`enqueueProseTurn`, routines/prose-turn.ts). The assistant fills the
//     slots through `knowledge_write`, which in this folder accepts a change
//     to a pending slot's line and nothing else (`fillProseSlots`, core) —
//     the file stays this routine's, written under its principal. The seeded
//     `Templates/Standup.md` has no `prose` line, so the default standup
//     still asks no model at all.
//  2. **One writer per file, and never a note the owner owns** (§5.1). A
//     standup file whose frontmatter `source:` is not this routine's —
//     including one with no `source:` at all, which is the owner's (#231) —
//     is never overwritten.
//  3. **One read path into state** (invariant 3). Every row the template
//     shows comes from a named query through the injected store; this file
//     holds no SQL but its own `runs` bookkeeping.
//
// SCHEDULE (§2.5): working days at 08:00, from the manifest. The console's
// runner fires it once, at its slot (T3-1), and — when `Me/profile.md` says
// nothing about working days — never fires it at all, recording
// `skipped:no_working_days` instead. The routine asks the same question
// again for a run nobody scheduled (Run Now), so "nothing is written without
// working days" holds on every path, not only the scheduled one. Which days
// it runs is the schedule's business, never this file's: an owner who set
// `days: [mon, wed]` — or whose old `standup_days` T3-4 moved there — gets
// exactly those.
//
// TODAY'S SWAP (§2.5, §2.20): Today shows *Standup at 8:00 AM* until the file
// lands. The routine's own `routine_run` row, written after the write
// returns, is what the console's event stream turns into
// `routine.status {name: "standup"}` (apps/console/src/events.ts) — so the
// event a client refreshes on arrives after the file exists, never before.
//
// A run the runner fired late (the Mac slept through 08:00) is still dated
// from its slot (`ctx.scheduledFor`, in `ctx.timeZone`).

import {
  DEFAULT_TEMPLATE_MAX_BYTES,
  PROFILE_PATH,
  TEMPLATE_MISSING,
  TEMPLATE_UNREADABLE,
  calendarDate,
  configuredTimeZone,
  intEnv,
  profileFacts,
  renderTemplate,
  templateSkip,
  type CalendarProvider,
} from "@foldedspacelabs/metistry-core";
import type { Db } from "../morning-brief/run.js";
import { NO_QUERIES, eventkitCalendar, refuseMaterialised, sourceOf, type PlanCtx, type PlanVault } from "../plan-tomorrow/run.js";
import { enqueueProseTurn } from "../prose-turn.js";
import { vaultReader } from "../vault-reader.js";

export const COMPONENT = "standup";
/** The `intent.principal` every write carries, and the `source:` the rendered file declares — the string the ownership rules read later. */
export const PRINCIPAL = COMPONENT;
/** §2.13: `Journal/Standup/<date>.md` — this routine's reserved subfolder (`JOURNAL_MACHINE_DIRS`), one writer, and this is it. */
export const STANDUP_DIR = "Journal/Standup";
export const standupPath = (date: string): string => `${STANDUP_DIR}/${date}.md`;
/** The manifest's default for `config.template` (§2.5's example). */
export const DEFAULT_TEMPLATE = "Templates/Standup.md";

/** The config keys, as `routines.standup.config` in `.metistry/scheduled.yaml` spells them. */
export const TEMPLATE_KEY = "template";
export const SKIP_KEY = "skip_without_calendar_event";

/** What `skip_without_calendar_event` looks for in an event's title — case-insensitive, anywhere in it (*Standup*, *Team stand-up*, *Daily standup*). */
const STANDUP_EVENT_RE = /stand[\s-]?up/i;

/**
 * Why a pass wrote nothing. Each is a fact about the install or the day,
 * never a fault: the run is `ok`, the reason is on the row as
 * `skipped:<reason>` (D7), and Scheduled's history shows it.
 */
export const STANDUP_SKIPS = [
  "no_working_days", // §2.5 / §6.4: Me/profile.md does not say which days you work, and nothing guesses
  "no_standup_event", // `skip_without_calendar_event` is on and today's calendar has no standup
  TEMPLATE_MISSING, // §6.4: a configuration fact
  TEMPLATE_UNREADABLE, // §6.4: not text, or over the cap — one report request names the file
  "user_owned", // the file on disk is not this routine's; §5.1's ownership rule wins
  "would_materialise", // the belt behind D4 — the engine's own rule already forbids it
] as const;
export type StandupSkip = (typeof STANDUP_SKIPS)[number];

export interface StandupCtx extends PlanCtx {
  /**
   * The routine's resolved Scheduled config (manifest ⊕
   * `.metistry/scheduled.yaml`, §2.5): `template` and
   * `skip_without_calendar_event`. Absent → the manifest's defaults, which is
   * what every run gets until the runner hands config on (session-purge reads
   * its own the same way).
   */
  config?: Record<string, unknown> | undefined;
}

/** The two settings, from the resolved config or the manifest's defaults. The overlay validator has already checked each value's kind; a wrong one here is refused, never coerced. */
export function standupConfig(config?: Record<string, unknown>): { template: string; skipWithoutEvent: boolean } {
  const template = config?.[TEMPLATE_KEY] ?? DEFAULT_TEMPLATE;
  const skip = config?.[SKIP_KEY] ?? false;
  if (typeof template !== "string" || template === "") {
    throw new Error(`${COMPONENT}: config.${TEMPLATE_KEY} is ${JSON.stringify(template)} — it must be a vault path (routines.standup.config in .metistry/scheduled.yaml); nothing was written`);
  }
  if (typeof skip !== "boolean") {
    throw new Error(`${COMPONENT}: config.${SKIP_KEY} is ${JSON.stringify(skip)} — it must be true or false (routines.standup.config in .metistry/scheduled.yaml); nothing was written`);
  }
  return { template, skipWithoutEvent: skip };
}

/**
 * `skip_without_calendar_event`'s question, asked only when it is on: does
 * `date` have a standup on the calendar? `"unknown"` when the calendar cannot
 * be asked — no bridge, or it refused — and unknown is never a reason to
 * skip: §6.4's worst outcome is no file at all.
 */
export async function standupOnCalendar(calendar: CalendarProvider | null, date: string): Promise<"yes" | "no" | "unknown"> {
  if (calendar === null) return "unknown";
  try {
    const events = await calendar.events(date);
    return events.some((e) => typeof e.title === "string" && STANDUP_EVENT_RE.test(e.title)) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

// --- bookkeeping ---------------------------------------------------------------

/**
 * Has a pass already written this date's standup? Only a WRITE settles a
 * date: a skip (no working days yet, no template yet) is recorded and the
 * next run — Run Now once the owner fixes it — tries again. The runner fires
 * a slot once, so this guards a late run and its Run Now twin, nothing more.
 * `meta.standup_for` is the discriminator: the runner's own `routine_run`
 * row deliberately carries none.
 */
async function written(db: Db, date: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM runs
     WHERE component = $1 AND kind = 'routine_run' AND ok AND meta->>'standup_for' = $2 AND meta->>'outcome' = 'acted'
     LIMIT 1`,
    [COMPONENT, date],
  );
  return rows.length > 0;
}

/**
 * This routine's own row: `"wrote"` becomes `acted`, every skip
 * `skipped:<reason>` (T1-4's shared vocabulary). Inserted finished, so the
 * event stream says `routine.status {name: "standup"}` the moment it lands —
 * after the file does.
 */
async function record(db: Db, date: string, reason: "wrote" | StandupSkip, meta: Record<string, unknown> = {}): Promise<void> {
  const outcome = reason === "wrote" ? "acted" : `skipped:${reason}`;
  await db.query(
    `INSERT INTO runs (component, kind, ok, started_at, finished_at, meta)
     VALUES ($1, 'routine_run', true, now(), now(), $2)`,
    [COMPONENT, JSON.stringify({ standup_for: date, outcome, ...meta })],
  );
}

/** §6.4's one `report` request for a template that is not readable text or is over the cap — the file is named, because a silent non-render is the failure the owner cannot see. */
async function reportUnreadable(db: Db, template: string, date: string, maxBytes: number): Promise<void> {
  await db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', $2)`, [
    COMPONENT,
    JSON.stringify({
      title: `${template} could not be read — no standup for ${date}`,
      summary: `The template is not readable text, or is larger than METISTRY_TEMPLATE_MAX_BYTES (${maxBytes} bytes). Nothing was written. Open it in Obsidian, or run \`metistry templates check\`.`,
      refs: [template],
    }),
  ]);
}

async function readText(vault: PlanVault, path: string): Promise<string | null> {
  const file = await vault.read(path);
  return file === null ? null : file.content.toString("utf8");
}

// --- the pass ------------------------------------------------------------------

/** A zone `Intl` knows, or undefined — a profile's `timezone` the scheduler would refuse `unknown_timezone` is not one to date a file in. */
function knownZone(tz: string | undefined): string | undefined {
  if (tz === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** One pass. Returns 1 when today's standup was written, 0 otherwise — every 0 is a fact recorded or a date already written. */
export async function run(db: Db, ctx: StandupCtx = {}): Promise<number> {
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? new Date();
  const { template, skipWithoutEvent } = standupConfig(ctx.config);

  const vault = ctx.vault;
  if (!vault) {
    // Not a row: with no bridge there is no vault, and the runner's preflight
    // has already named the variables on this window (manifest `requires.env`).
    console.log(`${COMPONENT}: no vault bridge — nothing to read ${template} from and nowhere to write ${STANDUP_DIR}/`);
    return 0;
  }
  const facts = profileFacts(await readText(vault, PROFILE_PATH));

  // The morning this standup is FOR: the slot, in the zone the runner read it
  // in. A run nobody scheduled (Run Now) dates from now, in the profile's
  // zone, then METISTRY_TZ — never TZ, which both deployment shapes pin to
  // UTC (T3-1) — and UTC only when nothing says otherwise.
  const timeZone = ctx.timeZone ?? knownZone(facts.timezone) ?? configuredTimeZone(env) ?? "UTC";
  const morning = ctx.scheduledFor ?? now;
  const date = calendarDate(morning, timeZone);

  if (await written(db, date)) {
    console.log(`${COMPONENT}: ${standupPath(date)} is already written`);
    return 0;
  }

  // Nothing is written without working days (§2.5, §6.4's absent state) —
  // the runner already refuses the schedule; this is the same answer for a
  // run nobody scheduled.
  if (facts.working_days === undefined) {
    const why = `${PROFILE_PATH} does not say which days you work (\`working_days: [mon, tue, wed, thu, fri]\`) — Metistry discovers that from you and never assumes it, so no standup was written`;
    console.log(`${COMPONENT}: ${why}`);
    await record(db, date, "no_working_days", { why });
    return 0;
  }

  // undefined = build one from the environment; null = the caller says there is none
  const calendar = ctx.calendar === undefined ? eventkitCalendar(ctx, timeZone, now) : ctx.calendar;
  let onCalendar: "yes" | "no" | "unknown" | undefined;
  if (skipWithoutEvent) {
    onCalendar = await standupOnCalendar(calendar, date);
    if (onCalendar === "no") {
      const why = `${SKIP_KEY} is on and ${date} has no standup on your calendar`;
      console.log(`${COMPONENT}: ${why}`);
      await record(db, date, "no_standup_event", { why });
      return 0;
    }
  }

  const maxBytes = intEnv("METISTRY_TEMPLATE_MAX_BYTES", DEFAULT_TEMPLATE_MAX_BYTES, env);
  const templateText = await readText(vault, template);
  const skip = templateSkip(templateText, maxBytes);
  if (skip !== null || templateText === null) {
    const reason = skip ?? TEMPLATE_MISSING;
    console.log(`${COMPONENT}: ${template} — ${reason}; nothing written for ${date}`);
    if (reason === TEMPLATE_UNREADABLE) await reportUnreadable(db, template, date, maxBytes);
    await record(db, date, reason, { template, max_bytes: maxBytes });
    return 0;
  }

  // Ownership before rendering (§5.1): a file that is not ours costs one read
  // and no work. `existing.sha256` is the compare-and-swap value the rewrite
  // carries, so a Run Now after a skip replaces the same file, never races it.
  const path = standupPath(date);
  const existing = await vault.read(path);
  const owner = existing === null ? null : sourceOf(existing.content.toString("utf8"));
  if (existing !== null && owner !== PRINCIPAL) {
    const why = `${path} says \`source: ${owner ?? "(none — yours)"}\`, not \`${PRINCIPAL}\` — one writer per file, and this one is not mine`;
    console.log(`${COMPONENT}: ${why}`);
    await record(db, date, "user_owned", { path, source: owner, why });
    return 0;
  }

  const render = await renderTemplate(templateText, {
    templatePath: template,
    source: PRINCIPAL,
    queries: ctx.queries ?? NO_QUERIES,
    calendar,
    reader: vaultReader(vault),
    ...(ctx.me !== undefined ? { me: ctx.me } : {}),
    // the template's "today" and "yesterday" are the slot's: a late run still writes `date`
    now: morning,
    timeZone,
    env,
    renderedAt: now,
    maxBytes,
  });
  if (render.skipped !== undefined) {
    // Unreachable — `templateSkip` asked the same question of the same bytes.
    await record(db, date, render.skipped, { template });
    return 0;
  }
  if (refuseMaterialised(render.markdown)) {
    const why = `the render produced a task line with a minted \`^mt-\` anchor, which no routine may write (D4) — refusing to write ${path}`;
    console.warn(`${COMPONENT}: ${why}`);
    await record(db, date, "would_materialise", { path, why });
    return 0;
  }

  const out = await vault.write(
    path,
    Buffer.from(render.markdown, "utf8"),
    { principal: PRINCIPAL, message: `standup for ${date}` },
    existing?.sha256 ?? "", // "" = must not exist; otherwise compare-and-swap on what we just read
  );
  // ONE turn for the file's prose slots (C103); none, and no model is asked.
  const inboundId = render.proseRequests.length > 0 ? await enqueueProseTurn(db, { component: COMPONENT, path, date, requests: render.proseRequests }) : undefined;
  await record(db, date, "wrote", {
    path,
    bytes: out.bytes,
    created: out.created,
    template,
    prose_slots: render.proseRequests.length,
    ...(inboundId !== undefined ? { inbound_id: inboundId } : {}),
    ...(onCalendar !== undefined ? { on_calendar: onCalendar } : {}),
    template_warnings: render.warnings.length,
    ...(render.warnings.length > 0 ? { warnings: render.warnings.map((w) => `${template}:${w.line} ${w.message}`) } : {}),
    truncated: render.truncated,
  });
  console.log(`${COMPONENT}: wrote ${path} (${out.bytes} bytes${render.warnings.length > 0 ? `, ${render.warnings.length} template warning(s)` : ""}${render.truncated ? ", truncated" : ""})`);
  return 1;
}
