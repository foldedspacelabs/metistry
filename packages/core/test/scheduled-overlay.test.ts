// T3-2 — the overlay: what a routine or collector manifest declares for
// Scheduled (`display_name`, `config`, `needs_you`, `presents_as`), what
// `.metistry/scheduled.yaml` may name against it, and every field resolved
// over manifest ⊕ Me/profile.md ⊕ the file with the layer it came from.
import { describe, expect, it } from "vitest";
import {
  checkScheduled,
  entryProblems,
  parseScheduled,
  resolveScheduled,
  resolveUnit,
  scheduledUnitOf,
  validateManifest,
  type Manifest,
  type ResolveContext,
  type Scheduled,
  type ScheduledUnit,
} from "../src/index.js";

const NY = "America/New_York";
/** Sunday 2026-09-20, 12:00 in New York (EDT). */
const SUNDAY_NOON = new Date("2026-09-20T16:00:00Z");
const CTX: ResolveContext = { profile: { timezone: NY, working_days: ["mon", "tue", "wed", "thu", "fri"] }, fallbackTimeZone: null, now: SUNDAY_NOON };

function manifest(m: Record<string, unknown>): Manifest {
  const r = validateManifest({ schema: 1, ...m });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
}

const standup = manifest({
  name: "standup",
  type: "routine",
  display_name: "Standup",
  schedule: { days: "working_days", at: ["08:00"] },
  config: {
    template: { kind: "path", label: "Shape from", default: "Templates/Standup.md" },
    skip_without_calendar_event: { kind: "boolean", label: "Skip days with no standup on your calendar", default: false },
    tone: { kind: "choice", label: "Tone", default: "brief", options: ["brief", "full"] },
  },
});
const github = manifest({
  name: "github-state",
  type: "collector",
  display_name: "GitHub",
  schedule: { every: "15m" },
  writes: ["work"],
  needs_you: {
    review_requested: { label: "A pull request asks for your review", default: true },
    assigned: { label: "An issue is assigned to you", default: false },
  },
});
const inbox = manifest({ name: "inbox-drain", type: "collector", display_name: "Inbox Sort", presents_as: "routine", schedule: { every: "5m" }, writes: ["proposals"] });
const unit = (m: Manifest): ScheduledUnit => scheduledUnitOf(m)!;
const UNITS = [unit(standup), unit(github), unit(inbox)];

const file = (text: string): Scheduled => {
  const r = parseScheduled(text);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};

describe("manifests declare what Scheduled reads", () => {
  it("display_name, config, needs_you and presents_as validate, and each unit lands in its section", () => {
    expect(unit(standup)).toMatchObject({ section: "routines", displayName: "Standup" });
    expect(unit(github)).toMatchObject({ section: "syncs", displayName: "GitHub", raise: { review_requested: { default: true } } });
    expect(unit(inbox)).toMatchObject({ section: "routines", displayName: "Inbox Sort", config: {}, raise: {} });
    // a manifest without the new fields — an extension that predates them — still loads, and reads by its name
    expect(unit(manifest({ name: "scraper", type: "collector", schedule: "@hourly", writes: ["work"] }))).toMatchObject({ section: "syncs", displayName: "scraper", config: {}, raise: {} });
    expect(scheduledUnitOf(manifest({ name: "svc", type: "service", runs_on: "host" }))).toBeNull();
  });

  it("refuses a declaration that could not be honoured, naming the field", () => {
    const refused = (m: Record<string, unknown>): string => {
      const r = validateManifest({ schema: 1, name: "r", type: "routine", schedule: { every: "1h" }, ...m });
      expect(r.ok, JSON.stringify(m)).toBe(false);
      return r.ok ? "" : r.errors.join("; ");
    };
    expect(refused({ display_name: "" })).toMatch(/^display_name: /);
    expect(refused({ display_name: " Standup" })).toMatch(/leading or trailing space/);
    expect(refused({ display_name: "x".repeat(61) })).toMatch(/at most 60/);
    expect(refused({ config: { Template: { kind: "text", label: "T", default: "x" } } })).toMatch(/snake_case/);
    expect(refused({ config: { t: { kind: "markdown", label: "T", default: "x" } } })).toMatch(/config\.t\.kind: kind is one of text, path, number, boolean, choice/);
    expect(refused({ config: { t: { kind: "boolean", label: "T", default: "no" } } })).toMatch(/config\.t\.default: the default is true or false/);
    expect(refused({ config: { t: { kind: "path", label: "T", default: ".metistry/rules.yaml" } } })).toMatch(/config\.t\.default: .*never \.metistry/);
    expect(refused({ config: { t: { kind: "path", label: "T", default: "../x.md" } } })).toMatch(/config\.t\.default/);
    expect(refused({ config: { t: { kind: "choice", label: "T", default: "a" } } })).toMatch(/config\.t\.options: a choice lists its options/);
    expect(refused({ config: { t: { kind: "choice", label: "T", default: "c", options: ["a", "b"] } } })).toMatch(/is one of a, b/);
    expect(refused({ config: { t: { kind: "text", label: "T", default: "x", options: ["a", "b"] } } })).toMatch(/only a choice has options/);
    expect(refused({ config: { t: { kind: "text", label: "T", default: "x", secret: true } } })).toMatch(/config\.t/); // strict: a typo'd key is loud
    const collector = (m: Record<string, unknown>) => validateManifest({ schema: 1, name: "c", type: "collector", schedule: { every: "1h" }, writes: ["work"], ...m });
    expect(collector({ presents_as: "dashboard" }).ok).toBe(false);
    expect(collector({ needs_you: { assigned: { label: "Assigned", default: "yes" } } }).ok).toBe(false);
    expect(collector({ needs_you: { assigned: { label: "Assigned" } } }).ok).toBe(false); // a rule states its default
  });
});

describe("scheduled.yaml names only what a manifest declares", () => {
  it("an entry that applies as written has no problems", () => {
    const f = file(`routines:
  standup:
    schedule: { days: [tue, thu], at: ["09:00"] }
    config: { template: Templates/Standup Notes.md, skip_without_calendar_event: true, tone: full }
  inbox-drain:
    paused: true
syncs:
  github-state:
    connection: github
    every: 1h
    raise: { assigned: true }
`);
    expect(checkScheduled(f, UNITS)).toEqual([]);
  });

  it("a config key the routine does not declare, or a value of the wrong kind, holds the routine — named by its field", () => {
    const f = file(`routines:
  standup:
    config: { template: .metistry/rules.yaml, skip_without_calendar_event: "no", voice: dry }
  inbox-drain:
    config: { batch: 10 }
`);
    const problems = checkScheduled(f, UNITS);
    expect(problems.map((p) => [p.field, p.holds])).toEqual([
      ["routines.standup.config.template", true],
      ["routines.standup.config.skip_without_calendar_event", true],
      ["routines.standup.config.voice", true],
      ["routines.inbox-drain.config.batch", true],
    ]);
    expect(problems[2]!.message).toBe("routines.standup.config.voice: Standup takes no voice — it declares template, skip_without_calendar_event, tone");
    expect(problems[3]!.message).toContain("it declares no config");
    expect(problems[1]!.message).toContain("is true or false");
  });

  it("a Needs You rule the sync does not declare holds it", () => {
    const [p] = entryProblems(unit(github), file(`syncs:\n  github-state:\n    connection: github\n    raise: { merged: true }\n`));
    expect(p).toEqual({
      name: "github-state",
      field: "syncs.github-state.raise.merged",
      message: "syncs.github-state.raise.merged: GitHub raises no merged — it declares review_requested, assigned",
      holds: true,
    });
  });

  it("each component's changes live in its section — the other section, or both, holds it", () => {
    expect(entryProblems(unit(github), file(`routines:\n  github-state:\n    paused: true\n`))[0]?.message).toBe("routines.github-state: github-state is a sync — its changes live under syncs.github-state");
    // a collector that presents as a routine is a routine here
    expect(entryProblems(unit(inbox), file(`syncs:\n  inbox-drain:\n    connection: inbox\n`))[0]?.message).toBe("syncs.inbox-drain names a routine — a routine's changes live under routines.inbox-drain");
    expect(entryProblems(unit(inbox), file(`routines:\n  inbox-drain:\n    paused: true\nsyncs:\n  inbox-drain:\n    connection: inbox\n`))[0]?.message).toContain("both routines: and syncs:");
    expect(entryProblems(unit(standup), file(`routines:\n  standup:\n    actor: a\n    task: t\n    schedule: { every: 1h }\n`))[0]?.message).toContain("is a New Routine");
  });

  it("an entry naming nothing scheduled here holds nothing, and says so; a New Routine under its own name is no problem", () => {
    const f = file(`routines:
  gone-extension:
    paused: true
  vendor-sweep:
    actor: vendor-research
    task: Summarise Areas/Finance
    schedule: { every: 6h }
syncs:
  linear-state:
    connection: linear
`);
    expect(checkScheduled(f, UNITS)).toEqual([
      { name: "gone-extension", field: "routines.gone-extension", message: expect.stringContaining("applies to nothing"), holds: false },
      { name: "linear-state", field: "syncs.linear-state", message: expect.stringContaining("applies to nothing"), holds: false },
    ]);
    // prototype names are data, not lookups
    expect(checkScheduled(file(`routines:\n  constructor:\n    paused: true\n`), UNITS).map((p) => p.holds)).toEqual([false]);
  });
});

describe("every field resolved, with where it came from", () => {
  it("no entry: every field is the manifest's (default), the days behind working_days are the profile's", () => {
    const r = resolveUnit(unit(standup), {}, CTX);
    expect(r).toMatchObject({
      name: "standup",
      section: "routines",
      displayName: "Standup",
      isDefault: true,
      schedule: { value: { days: "working_days", at: ["08:00"] }, origin: "default" },
      describe: "working days at 08:00",
      days: { value: ["mon", "tue", "wed", "thu", "fri"], origin: "profile" },
      timeZone: { value: NY, origin: "profile" },
      paused: { value: false, origin: "default" },
      config: {
        template: { value: "Templates/Standup.md", origin: "default" },
        skip_without_calendar_event: { value: false, origin: "default" },
        tone: { value: "brief", origin: "default" },
      },
      raise: {},
      connection: null,
      held: null,
    });
    expect(r.next).toEqual({ ok: true, at: new Date("2026-09-21T12:00:00Z"), timeZone: NY }); // Monday 08:00 EDT
  });

  it("the owner's entry: each field it sets is yours, and only those", () => {
    const f = file(`routines:\n  standup:\n    schedule: { days: [tue, thu], at: ["09:30"], tz: Europe/London }\n    config: { tone: full }\n`);
    const r = resolveUnit(unit(standup), f, CTX);
    expect(r.isDefault).toBe(false);
    expect(r.schedule.origin).toBe("yours");
    expect(r.days).toEqual({ value: ["tue", "thu"], origin: "yours" });
    expect(r.timeZone).toEqual({ value: "Europe/London", origin: "yours" });
    expect(r.config["tone"]).toEqual({ value: "full", origin: "yours" });
    expect(r.config["template"]).toEqual({ value: "Templates/Standup.md", origin: "default" });
    expect(r.paused).toEqual({ value: false, origin: "default" });
    expect(r.next).toEqual({ ok: true, at: new Date("2026-09-22T08:30:00Z"), timeZone: "Europe/London" }); // Tuesday 09:30 BST
  });

  it("a sync: its cadence and raise toggles, the connection the entry names; an interval counts from its last run", () => {
    const f = file(`syncs:\n  github-state:\n    connection: github\n    every: 1h\n    raise: { review_requested: false }\n`);
    const r = resolveUnit(unit(github), f, { ...CTX, lastRuns: { "github-state": new Date("2026-09-20T15:30:00Z") } });
    expect(r).toMatchObject({
      section: "syncs",
      schedule: { value: { every: "1h" }, origin: "yours" },
      describe: "every 1h",
      days: null,
      timeZone: null,
      connection: "github",
      raise: { review_requested: { value: false, origin: "yours" }, assigned: { value: false, origin: "default" } },
    });
    expect(r.next).toEqual({ ok: true, at: new Date("2026-09-20T16:30:00Z"), timeZone: null });
    // never run: due now; overdue: due now, not in the past
    expect(resolveUnit(unit(github), f, CTX).next).toEqual({ ok: true, at: SUNDAY_NOON, timeZone: null });
    expect(resolveUnit(unit(github), f, { ...CTX, lastRuns: { "github-state": new Date("2026-09-19T00:00:00Z") } }).next).toEqual({ ok: true, at: SUNDAY_NOON, timeZone: null });
  });

  it("paused: no next run; held: the manifest's values, why, and no next run", () => {
    expect(resolveUnit(unit(inbox), file(`routines:\n  inbox-drain:\n    paused: true\n`), CTX)).toMatchObject({ paused: { value: true, origin: "yours" }, next: null, held: null });
    const held = resolveUnit(unit(standup), file(`routines:\n  standup:\n    schedule: { every: 5m }\n    config: { voice: dry }\n`), CTX);
    expect(held.held).toContain("Standup takes no voice");
    expect(held.schedule).toEqual({ value: { days: "working_days", at: ["08:00"] }, origin: "default" }); // nothing of the entry applies
    expect(held.next).toBeNull();
  });

  it("a day set with no working days, or no zone at all, resolves to the refusal the runner records", () => {
    const r = resolveUnit(unit(standup), {}, { ...CTX, profile: {} });
    expect(r.days).toBeNull();
    expect(r.timeZone).toBeNull();
    expect(r.next).toMatchObject({ ok: false, reason: "no_timezone" });
    const z = resolveUnit(unit(standup), {}, { ...CTX, profile: {}, fallbackTimeZone: "Etc/UTC" });
    expect(z.timeZone).toEqual({ value: "Etc/UTC", origin: "default" }); // METISTRY_TZ — configuration, not the profile
    expect(z.next).toMatchObject({ ok: false, reason: "no_working_days" });
  });

  it("the listing: routines and syncs by name, with the file's problems", () => {
    const listing = resolveScheduled(UNITS, file(`syncs:\n  linear-state:\n    connection: linear\n`), CTX);
    expect(listing.routines.map((r) => r.name)).toEqual(["inbox-drain", "standup"]);
    expect(listing.syncs.map((r) => r.name)).toEqual(["github-state"]);
    expect(listing.problems.map((p) => p.field)).toEqual(["syncs.linear-state"]);
  });
});
