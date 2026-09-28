// The two edits the session fold may OFFER (C79) — computed here, model-free,
// from the file as it is on disk. Nothing in this file writes anything: each
// function returns the "after" a request shows beside its "before", and only
// the owner's Approve writes it, as `user`, through the console's proposal
// path (`applyMeEdit`, apps/console/src/profile-tidy.ts) — refused if the file
// is no longer the "before" it was shown.
//
//   * `Me/Working Style.md` — preferences and lessons, each one bullet under
//     its own heading (`## Preferences`, `## Lessons`). Every other byte of
//     the file stays where it was: the lines are inserted, nothing is
//     rewritten, and a heading that is not there yet is added at the end.
//   * `Me/profile.md` — one frontmatter key, set to a value in the exact
//     shape the profile takes (daily-flow-spec §6.6). The key's own line (or
//     its commented example, as the seeded profile has) is replaced, or the
//     key is added before the closing `---`; the result must parse to exactly
//     the old frontmatter plus that one key, or it is not offered —
//     `withoutProfileKeys`'s rule (core, T3-4), the other way round.

import { PROFILE_PATH, WEEKDAYS, profileFrontmatter, profileWeekdays, validTimeZone, type Weekday } from "@foldedspacelabs/metistry-core";

/** Where preferences and lessons land (screen-12 §2). `Me/` is the owner's alone — written as `user`, or not at all. */
export const WORKING_STYLE_PATH = "Me/Working Style.md";
export { PROFILE_PATH };

export type WorkingStyleKind = "preference" | "lesson";

/** The heading each kind lands under in `Me/Working Style.md`. */
export const WORKING_STYLE_HEADINGS: Readonly<Record<WorkingStyleKind, string>> = Object.freeze({
  preference: "## Preferences",
  lesson: "## Lessons",
});

/** A line as the dedup compares it: no bullet, whitespace collapsed, case folded. */
export const lineKey = (s: string): string =>
  s
    .replace(/^\s*[-*+]\s+/, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Does the file already say this, on any line? The fold never offers what the owner already wrote. */
export function workingStyleHas(text: string, line: string): boolean {
  const want = lineKey(line);
  return text.split(/\r?\n/).some((l) => lineKey(l) === want);
}

/**
 * `text` with each of `lines` appended as a bullet under `heading` — after the
 * section's last non-blank line, or under a new heading at the end of the
 * file when it has none. Pure; every existing byte is kept, in order.
 */
export function appendUnderHeading(text: string, heading: string, lines: readonly string[]): string {
  if (lines.length === 0) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bullets = lines.map((l) => `- ${l}`);
  const all = text.split(/\r?\n/);
  // a trailing newline splits into a final "" — kept aside so it is restored exactly
  const trailing = all.length > 0 && all[all.length - 1] === "";
  const body = trailing ? all.slice(0, -1) : all;

  const at = body.findIndex((l) => l.trimEnd() === heading);
  if (at === -1) {
    const lastText = body.length - 1 - [...body].reverse().findIndex((l) => l.trim() !== "");
    const kept = body.slice(0, Math.max(lastText + 1, 0));
    const out = [...kept, ...(kept.length > 0 ? [""] : []), heading, "", ...bullets];
    return out.join(eol) + eol;
  }
  // the section runs to the next heading of the same or a higher level, or the end
  let end = body.length;
  for (let i = at + 1; i < body.length; i++) {
    if (/^#{1,2}\s/.test(body[i]!)) {
      end = i;
      break;
    }
  }
  let last = at;
  for (let i = at + 1; i < end; i++) if (body[i]!.trim() !== "") last = i;
  // a heading with nothing under it gets its blank line, as the new-heading case does
  const insert = last === at ? ["", ...bullets] : bullets;
  const out = [...body.slice(0, last + 1), ...insert, ...body.slice(last + 1)];
  return out.join(eol) + (trailing ? eol : "");
}

// ---- Me/profile.md -------------------------------------------------------------

/** The facts `Me/profile.md` keeps (§2.5; daily-flow-spec §6.6). Closed: a new fact is a product change. `standup_*` moved to the Standup routine (T3-4) and is never proposed back. */
export const PROFILE_FACT_KEYS = ["timezone", "working_days", "working_hours", "daily_capacity_min", "task_size_minutes", "today_cap"] as const;
export type ProfileFactKey = (typeof PROFILE_FACT_KEYS)[number];
export const isProfileFactKey = (k: unknown): k is ProfileFactKey => typeof k === "string" && (PROFILE_FACT_KEYS as readonly string[]).includes(k);

export type ProfileValue = string | number | readonly Weekday[] | { readonly s: number; readonly m: number; readonly l: number };

const MINUTES_IN_DAY = 24 * 60; // limit: fixed — a capacity or a task size longer than a day is not one
const MAX_TODAY_CAP = 50; // limit: fixed — `today_cap` is how many things fit in a day; beyond this it is not a cap
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const wholeIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * A proposed value in the exact shape the profile takes, or why it is not.
 * Normalised where the shape allows one spelling (`["Monday"]` → `[mon]`),
 * refused where a guess would be needed — never clamped.
 */
export function profileValue(key: ProfileFactKey, value: unknown): { ok: true; value: ProfileValue } | { ok: false; why: string } {
  switch (key) {
    case "timezone":
      return typeof value === "string" && validTimeZone(value.trim()) ? { ok: true, value: value.trim() } : { ok: false, why: "timezone is an IANA zone (Europe/London)" };
    case "working_days": {
      const days = Array.isArray(value) && value.every((d) => typeof d === "string") ? profileWeekdays(value) : null;
      // every entry must be a day: ["mon", "someday"] is not "mon"
      if (days === null || days.length !== new Set((value as string[]).map((d) => d.trim().slice(0, 3).toLowerCase())).size) return { ok: false, why: "working_days is a list of weekdays (mon … sun)" };
      return { ok: true, value: WEEKDAYS.filter((d) => days.includes(d)) };
    }
    case "working_hours": {
      const m = typeof value === "string" ? /^\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/.exec(value) : null;
      if (!m || !HHMM.test(m[1]!) || !HHMM.test(m[2]!) || minutes(m[1]!) >= minutes(m[2]!)) return { ok: false, why: `working_hours is "HH:MM-HH:MM", the start before the end` };
      return { ok: true, value: `${m[1]}-${m[2]}` };
    }
    case "daily_capacity_min":
      return wholeIn(value, 1, MINUTES_IN_DAY) ? { ok: true, value } : { ok: false, why: `daily_capacity_min is a whole number of minutes, 1 to ${MINUTES_IN_DAY}` };
    case "today_cap":
      return wholeIn(value, 1, MAX_TODAY_CAP) ? { ok: true, value } : { ok: false, why: `today_cap is a whole number, 1 to ${MAX_TODAY_CAP}` };
    case "task_size_minutes": {
      const o = value as Record<string, unknown> | null;
      const keys = o !== null && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : [];
      if (keys.join(",") !== "l,m,s" || ![o!.s, o!.m, o!.l].every((n) => wholeIn(n, 1, MINUTES_IN_DAY))) return { ok: false, why: "task_size_minutes is { s, m, l }, each a whole number of minutes" };
      return { ok: true, value: { s: o!.s as number, m: o!.m as number, l: o!.l as number } };
    }
  }
}

/** The value as it is written on the key's line — the seeded profile's own spellings. */
export function profileYaml(key: ProfileFactKey, value: ProfileValue): string {
  if (key === "working_days") return `[${(value as readonly string[]).join(", ")}]`;
  if (key === "task_size_minutes") {
    const t = value as { s: number; m: number; l: number };
    return `{ s: ${t.s}, m: ${t.m}, l: ${t.l} }`;
  }
  if (key === "working_hours") return JSON.stringify(value);
  // a zone name is a plain YAML scalar (letters, `/`, `_`, `-`, `+`); quoted otherwise, so it can never read as anything else
  if (key === "timezone") return /^[A-Za-z][A-Za-z0-9/_+-]*$/.test(String(value)) ? String(value) : JSON.stringify(value);
  return String(value);
}

/** The value the profile says today, in the same normalised shape — so "already says so" is a comparison, not a guess. */
export function currentProfileValue(text: string, key: ProfileFactKey): ProfileValue | null {
  const fm = profileFrontmatter(text);
  if (fm === null || !Object.hasOwn(fm, key)) return null;
  const read = profileValue(key, fm[key]);
  return read.ok ? read.value : null;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sorted = (o: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/**
 * The profile with `key` set to `value`, and nothing else changed. The key's
 * own top-level line (with the lines that continue it) is replaced; failing
 * that, its commented example (`# timezone: …`, as the seeded profile has);
 * failing that, it is added before the closing `---`. Null when the file has
 * no frontmatter, or when the result does not parse to exactly the old
 * frontmatter with that one key set — an edit that cannot be proved is not
 * offered.
 */
export function withProfileKey(text: string, key: ProfileFactKey, value: ProfileValue): string | null {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bare = (l: string): string => l.replace(/\r?\n$/, "");
  if (lines.length === 0 || bare(lines[0]!) !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(bare(l)));
  if (close === -1) return null;
  const before = profileFrontmatter(text);
  if (before === null && close > 1 && lines.slice(1, close).some((l) => bare(l).trim() !== "" && !bare(l).trim().startsWith("#"))) return null;

  const eol = lines[0]!.endsWith("\r\n") ? "\r\n" : "\n";
  const line = `${key}: ${profileYaml(key, value)}${eol}`;
  const own = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^${key}[ \\t]*:`).test(l));
  let out: string[];
  if (own !== -1) {
    let end = own + 1;
    while (end < close && /^([ \t]+\S|-([ \t]|$))/.test(bare(lines[end]!))) end++;
    out = [...lines.slice(0, own), line, ...lines.slice(end)];
  } else {
    const example = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^#[ \\t]*${key}[ \\t]*:`).test(l));
    out = example !== -1 ? [...lines.slice(0, example), line, ...lines.slice(example + 1)] : [...lines.slice(0, close), line, ...lines.slice(close)];
  }
  const after = out.join("");

  const got = profileFrontmatter(after);
  const read = got === null ? null : profileValue(key, got[key]);
  if (got === null || read === null || !read.ok || !sameValue(read.value, value)) return null;
  const expected = { ...(before ?? {}), [key]: got[key] };
  if (sorted(got) !== sorted(expected)) return null;
  return after;
}
