// Routine suggestions (design-build-plan §2.5, §2.12; screen 8 §5.4 and §10.4;
// ticket T3-11).
//
// A suggestion about a routine is not a new mechanism: it is an `improvement`
// request — the kind reply-review already raises for the prompt overlay —
// pointed at one entry of `.metistry/scheduled.yaml`. The same three rules
// hold it honest:
//
//   1. **Nothing is applied by raising it.** `suggestionPayload` reads the
//      file and builds a request; it never writes. The overlay changes only
//      when the owner Approves, and Revise, Decline and Later write nothing.
//   2. **Approve writes through the Scheduled door, as `user`.** The edit is
//      `applyEdit` (scheduled-routes.ts) — the one read, validate against the
//      manifests, compare-and-swap write that every Scheduled door makes,
//      through the reconciler in the owner's name. No second writer.
//   3. **Approve writes exactly what the owner was shown.** The request
//      carries the entry before and after (`scheduled_edit`) and the words
//      drawn from them (`body.before.text`, `body.after.text`). Approve
//      re-draws the words from the entries and refuses a request whose words
//      do not match, and refuses `stale` — nothing written, the request still
//      waiting — when the entry in the file is no longer the "before".
//
// **Timing only.** A suggestion may change what the owner's phone may change
// at the Scheduled doors — a routine's schedule and pause; a sync's cadence,
// pause and raise toggles — and nothing else. What runs (a New Routine's
// actor, task and per-run grants) is `local`, the Mac's alone, and a sync's
// connection is never set by Scheduled at all, so a suggestion that would
// change either is refused before anything is read. A routine's `config` has
// no door yet, so it has no suggestion either.

import { isDeepStrictEqual } from "node:util";
import {
  SCHEDULED_NAME_RE,
  checkScheduled,
  describeSchedule,
  isAssignment,
  parseScheduled,
  scheduleSchema,
  validateScheduled,
  EVERY,
  type ManifestSchedule,
  type Scheduled,
  type ScheduledSection,
  type ScheduledUnit,
} from "@foldedspacelabs/metistry-core";
import { applyEdit, drop, prune, refuse, scheduleNode, titleOf, type EditResult, type Refusal, type ScheduledAdmin } from "./scheduled-routes.js";
import { unitOf } from "./runner.js";

/** The stored kind: a routine suggestion IS an improvement (§2.12: "improvement (+ routine suggestions)"). */
export const SUGGESTION_KIND = "improvement";

/** The fields a suggestion may change, per section — the owner-reach Scheduled doors' fields, and no others. */
export const SUGGESTION_FIELDS: Readonly<Record<ScheduledSection, readonly string[]>> = Object.freeze({
  routines: Object.freeze(["schedule", "paused"]),
  syncs: Object.freeze(["every", "paused", "raise"]),
});

export const BEFORE_LABEL = "Now";
export const AFTER_LABEL = "Suggested";

type Entry = Record<string, unknown>;

/** One entry of the overlay, before and after — null when there is no entry (the manifest's defaults). */
export interface ScheduledEdit {
  readonly section: ScheduledSection;
  readonly name: string;
  readonly before: Entry | null;
  readonly after: Entry | null;
}

/** A routine suggestion as a request carries it: the edit, and the words the owner was shown. */
export interface RoutineSuggestion {
  readonly edit: ScheduledEdit;
  readonly before: string;
  readonly after: string;
}

const isPlain = (v: unknown): v is Entry => typeof v === "object" && v !== null && !Array.isArray(v);
/** JSON's own copy — no `undefined`, no prototype, key order irrelevant to `isDeepStrictEqual`. */
const plain = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(plain(a ?? null), plain(b ?? null));
const own = (m: Record<string, unknown> | undefined, k: string): unknown => (m && Object.hasOwn(m, k) ? m[k] : undefined);

/** The entry the file has for `name` in `section`, as plain JSON; null when it has none. */
export function entryOf(file: Scheduled, section: ScheduledSection, name: string): Entry | null {
  const e = own(file[section] as Record<string, unknown> | undefined, name);
  return e === undefined ? null : plain(e as Entry);
}

/** The keys a change touches that a suggestion may not — empty when it stays inside the timing fields. */
export function outsideFields(section: ScheduledSection, before: Entry | null, after: Entry | null): string[] {
  const allowed = SUGGESTION_FIELDS[section];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => !allowed.includes(k) && !same(before?.[k], after?.[k])).sort();
}

// ---- the words the owner reads ----------------------------------------------------------

const yesNo = (v: unknown): string => (v === true ? "yes" : "no");

/**
 * One side of the before and after, in words — drawn from the entry and the
 * manifest's defaults alone, so the same entry always reads the same and
 * Approve can draw it again to check what the owner was shown.
 */
export function sideText(unit: ScheduledUnit | undefined, section: ScheduledSection, entry: Entry | null): string {
  const lines: string[] = [];
  const mark = (mine: boolean): string => (mine ? "" : " (default)");
  if (section === "routines") {
    const mine = entry?.schedule !== undefined;
    const schedule = (mine ? entry!.schedule : unit?.schedule) as ManifestSchedule | undefined;
    lines.push(`Schedule: ${schedule === undefined ? "none" : describeSchedule(schedule)}${mark(mine)}`);
  } else {
    const mine = entry?.every !== undefined;
    lines.push(`Checked: ${mine ? `every ${String(entry!.every)}` : unit ? describeSchedule(unit.schedule) : "none"}${mark(mine)}`);
  }
  lines.push(`Paused: ${yesNo(entry?.paused)}${mark(entry?.paused !== undefined)}`);
  if (section === "syncs") {
    const raise = isPlain(entry?.raise) ? (entry!.raise as Record<string, unknown>) : {};
    const rules = [...new Set([...Object.keys(unit?.raise ?? {}), ...Object.keys(raise)])].sort();
    for (const rule of rules) {
      const mine = Object.hasOwn(raise, rule);
      const on = mine ? raise[rule] === true : unit?.raise[rule]?.default === true;
      lines.push(`Raises ${rule.replaceAll("_", " ")}: ${on ? "on" : "off"}${mark(mine)}`);
    }
  }
  return lines.join("\n");
}

// ---- raising one --------------------------------------------------------------------------

export interface SuggestionInput {
  /** The routine's or sync's name — the manifest's, or a New Routine's. */
  readonly name: string;
  /**
   * What to change: each field its suggested value, or null to return it to
   * the default — the doors' own convention. `raise` is a map of rules,
   * each true, false or null.
   */
  readonly change: Readonly<Record<string, unknown>>;
  /** The ask, as the owner reads it: *Draft standup at 8:30 instead of 6:00?* */
  readonly title: string;
  /** Why — the context on the wash. */
  readonly context?: string | undefined;
}

export type SuggestionBuilt = { ok: true; payload: Record<string, unknown>; edit: ScheduledEdit } | { ok: false; refusal: Refusal };

/**
 * The request a suggestion raises, from the file as it stands — or why none
 * can be. Pure: it reads what it is handed and writes nothing, anywhere.
 * The "after" must validate and fit its manifest exactly as the Scheduled
 * door would require, so a request is never raised that Approve would refuse.
 */
export function suggestionPayload(units: readonly ScheduledUnit[], file: Scheduled, input: SuggestionInput): SuggestionBuilt {
  const { name } = input;
  if (!SCHEDULED_NAME_RE.test(name)) return { ok: false, refusal: refuse("invalid_request", `name: ${JSON.stringify(name)} is not a routine or sync name`) };
  const title = input.title.trim();
  if (title === "") return { ok: false, refusal: refuse("invalid_request", "title: a suggestion asks something — it cannot be empty") };
  const unit = units.find((u) => u.name === name);
  const assignment = !unit ? own(file.routines as Record<string, unknown> | undefined, name) : undefined;
  if (!unit && !(assignment !== undefined && isAssignment(assignment as never))) {
    return { ok: false, refusal: refuse("not_found", `no routine or sync named ${name} is scheduled here`) };
  }
  const section: ScheduledSection = unit?.section ?? "routines";
  const allowed = SUGGESTION_FIELDS[section];
  for (const k of Object.keys(input.change)) {
    if (!allowed.includes(k)) {
      return { ok: false, refusal: refuse("invalid_request", `${k}: a suggestion changes only when a ${section === "routines" ? "routine" : "sync"} runs (${allowed.join(", ")}) — nothing was raised`) };
    }
  }

  const before = entryOf(file, section, name);
  const next: Entry = { ...(before ?? {}) };
  for (const [k, v] of Object.entries(input.change)) {
    if (v === undefined) continue;
    if (k === "raise" && v !== null) {
      if (!isPlain(v) || Object.values(v).some((r) => r !== null && typeof r !== "boolean")) {
        return { ok: false, refusal: refuse("invalid_request", "raise: a map of the sync's Needs You rules, each true, false, or null for the default") };
      }
      const raise: Entry = { ...(isPlain(next.raise) ? next.raise : {}) };
      for (const [rule, on] of Object.entries(v)) {
        if (on === null) delete raise[rule];
        else raise[rule] = on;
      }
      if (Object.keys(raise).length === 0) delete next.raise;
      else next.raise = raise;
    } else if (v === null) delete next[k];
    else if (k === "schedule") {
      const s = scheduleSchema.safeParse(v);
      if (!s.success) return { ok: false, refusal: refuse("invalid_request", `schedule: ${s.error.issues.map((i) => i.message).join("; ")}`) };
      next[k] = plain(s.data);
    } else if (k === "every" && !(EVERY as readonly unknown[]).includes(v)) {
      return { ok: false, refusal: refuse("invalid_request", `every: one of ${EVERY.join(", ")}`) };
    } else next[k] = plain(v);
  }
  const after: Entry | null = Object.keys(next).length === 0 ? null : next;
  if (same(before, after)) return { ok: false, refusal: refuse("invalid_request", `${name}: that is what it already is — nothing to suggest`) };

  const refusal = checkAfter(units, file, { section, name, before, after }, !unit);
  if (refusal) return { ok: false, refusal };

  const edit: ScheduledEdit = { section, name, before, after };
  const label = unit?.displayName ?? titleOf(name);
  const payload = {
    title,
    summary: input.context?.trim() || title,
    subject: { kind: section === "routines" ? "routine" : "sync", name, title: label },
    body: {
      kind: "before_after",
      heading: label,
      before: { label: BEFORE_LABEL, text: sideText(unit, section, before) },
      after: { label: AFTER_LABEL, text: sideText(unit, section, after) },
    },
    scheduled_edit: edit,
  };
  return { ok: true, payload, edit };
}

/** The file with `edit` applied must validate and must not hold its component — the door's own two checks. */
function checkAfter(units: readonly ScheduledUnit[], file: Scheduled, edit: ScheduledEdit, isNewRoutine: boolean): Refusal | null {
  const outside = outsideFields(edit.section, edit.before, edit.after);
  if (outside.length > 0) {
    return refuse("invalid_request", `${outside.join(", ")}: a suggestion changes only when it runs — what runs, and a sync's connection, are never suggested`);
  }
  if (isNewRoutine && edit.after === null) return refuse("invalid_request", `${edit.name} is a New Routine — it has no default to return to`);
  const section = { ...((file[edit.section] as Record<string, unknown> | undefined) ?? {}) };
  if (edit.after === null) delete section[edit.name];
  else section[edit.name] = edit.after;
  const whole: Record<string, unknown> = { ...plain(file) };
  if (Object.keys(section).length === 0) delete whole[edit.section];
  else whole[edit.section] = section;
  const parsed = validateScheduled(whole);
  if (!parsed.ok) return refuse("invalid_request", `nothing was raised — ${parsed.errors.join("; ")}`);
  const holds = checkScheduled(parsed.value, units).filter((p) => p.name === edit.name && p.holds);
  if (holds.length > 0) return refuse("invalid_request", `nothing was raised — ${holds.map((p) => p.message).join("; ")}`);
  return null;
}

// ---- reading one back --------------------------------------------------------------------

/** True when a payload carries a routine suggestion at all — valid or not. Such a row is never read as any other kind of improvement. */
export function carriesSuggestion(payload: unknown): boolean {
  return isPlain(payload) && Object.hasOwn(payload, "scheduled_edit");
}

/**
 * The suggestion a request's payload carries, or null when it is malformed:
 * a section and name, an entry or null on each side (not both null, not
 * equal), a change inside the timing fields, and the before and after words.
 */
export function suggestionOf(payload: unknown): RoutineSuggestion | null {
  if (!isPlain(payload)) return null;
  const e = payload.scheduled_edit;
  const body = payload.body as { kind?: unknown; before?: { text?: unknown }; after?: { text?: unknown } } | undefined;
  if (!isPlain(e) || !isPlain(body)) return null;
  const { section, name, before, after } = e as Record<string, unknown>;
  if (section !== "routines" && section !== "syncs") return null;
  if (typeof name !== "string" || !SCHEDULED_NAME_RE.test(name)) return null;
  if ((before !== null && !isPlain(before)) || (after !== null && !isPlain(after))) return null;
  if (same(before, after)) return null;
  if (outsideFields(section, before as Entry | null, after as Entry | null).length > 0) return null;
  if (body.kind !== "before_after" || typeof body.before?.text !== "string" || typeof body.after?.text !== "string") return null;
  return { edit: { section, name, before: plain(before as Entry | null), after: plain(after as Entry | null) }, before: body.before.text, after: body.after.text };
}

// ---- Approve --------------------------------------------------------------------------------

/**
 * Approve: the edit, through the Scheduled door, as `user`. Refused — and
 * nothing written — when the words the owner read are not the words these
 * entries draw today (`invalid_request`), when the file's entry is no longer
 * the "before" (`conflict`: the caller answers 409 stale), or on anything
 * the door itself refuses (an invalid file, an "after" that would hold the
 * component, a console that cannot write the overlay).
 */
export async function applySuggestion(admin: ScheduledAdmin, s: RoutineSuggestion, proposalId: number | string): Promise<EditResult> {
  const units = admin.components.map(unitOf);
  const { section, name, before, after } = s.edit;
  const unit = units.find((u) => u.name === name);
  if (unit && unit.section !== section) return { ok: false, refusal: refuse("invalid_request", `${name} is not a ${section === "routines" ? "routine" : "sync"} here — nothing was written`) };
  if (!unit && section !== "routines") return { ok: false, refusal: refuse("not_found", `no sync named ${name} is scheduled here — nothing was written`) };
  if (sideText(unit, section, before) !== s.before || sideText(unit, section, after) !== s.after) {
    return {
      ok: false,
      refusal: refuse("conflict", `${unit?.displayName ?? titleOf(name)}'s defaults changed since this was suggested, so what it shows is no longer what Approve would do — nothing was written; Decline it`),
    };
  }
  const label = unit?.displayName ?? titleOf(name);
  return applyEdit(admin, units, name, `${label}, approved suggestion #${proposalId}`, (doc, file) => {
    const current = entryOf(file, section, name);
    if (!same(current, before)) {
      return refuse("conflict", `${label} changed in .metistry/scheduled.yaml after this was suggested — nothing was written; Decline it, and change the routine in Scheduled if you still want to`);
    }
    if (!unit && (current === null || !isAssignment(current as never) || after === null)) {
      return refuse("invalid_request", `${name} is not a routine this suggestion can change — nothing was written`);
    }
    const refusal = checkAfter(units, file, s.edit, !unit);
    if (refusal) return refusal;
    for (const field of SUGGESTION_FIELDS[section]) {
      const v = after?.[field];
      if (v === undefined) drop(doc, [section, name, field]);
      else if (field === "schedule") doc.setIn([section, name, field], scheduleNode(doc, v as never));
      else if (field === "raise") doc.setIn([section, name, field], doc.createNode(v));
      else doc.setIn([section, name, field], v);
    }
    prune(doc, section, name);
    // exactly the "after" the owner was shown, or nothing at all
    const written = parseScheduled(doc.toString());
    if (!written.ok || !same(entryOf(written.value, section, name), after)) {
      return refuse("invalid_request", `the file would not say what the suggestion shows — nothing was written`);
    }
  });
}
