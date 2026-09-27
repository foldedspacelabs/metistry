// Keeping the Mac awake while the install runs — the four values, the
// power-source rule, and the state file the holder writes and `doctor` reads
// (docs/research/2026-09-19-keep-awake.md).
//
// Nothing here runs a command or touches the filesystem: core parses, core
// decides, and the process that owns a pid does the rest (the holder lives in
// apps/watchdog, the rendering in packages/cli). That split is what lets the
// rule be tested without a Mac, and it is why this file is safe to import
// from a Linux container that will never hold an assertion.
//
// THE MECHANISM, IN ONE LINE. `caffeinate -i` and
// `IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep)` are the
// same assertion; it needs no privileges, it leaves the DISPLAY free to sleep,
// and its own definition excludes lid close: "The system may still sleep for
// lid close, Apple menu, low battery, or other sleep reasons" (IOPMLib.h).
// Everything below follows from that sentence.

import { z } from "zod";

/**
 * What `deployment.yaml`'s `keep_awake` may say. Four values, in the order a
 * person is offered them:
 *
 *   never                    hold nothing; the Mac's own sleep settings decide
 *   allow_sleep_on_battery   hold on wall power, release on battery and UPS
 *   always                   hold on any power source, lid open
 *   always_lid_closed        the same, and the user has asked for lid-closed
 *                            too — which no process can deliver without an
 *                            administrator change (LID_CLOSED_NOT_AVAILABLE)
 *
 * The middle value is the owner's own phrase, kept as the YAML value, the CLI
 * argument and the app's label so there is no vocabulary to translate.
 */
export const KEEP_AWAKE_VALUES = ["never", "allow_sleep_on_battery", "always", "always_lid_closed"] as const;
export type KeepAwake = (typeof KEEP_AWAKE_VALUES)[number];

/**
 * What an install that has never answered the question does: NOTHING.
 *
 * A power assertion overrides the user's own System Settings sleep timer
 * (`pmset(1)`: "processes may dynamically override these power management
 * settings by using I/O Kit power assertions"), so holding one without being
 * asked would take a machine-level behaviour away from someone who never
 * agreed to it. Absent means `never`, on every instance that predates the key.
 */
export const KEEP_AWAKE_DEFAULT: KeepAwake = "never";

/**
 * What the onboarding question offers first. It is a recommendation the user
 * can decline, never a value anything writes on their behalf.
 */
export const KEEP_AWAKE_RECOMMENDED: KeepAwake = "allow_sleep_on_battery";

/** The environment variable the holder reads. Rendered by `metistry up` from `deployment.yaml`; not a second channel. */
export const KEEP_AWAKE_ENV = "METISTRY_KEEP_AWAKE";

/** `<instance>/.metistry/state/run/keep-awake.json` — the holder's own record, beside the control socket. */
export const KEEP_AWAKE_STATE_FILENAME = "keep-awake.json";

/**
 * The exact sentence every surface uses for the fourth value, because there is
 * no honest mechanism behind it (see `docs/research/2026-09-19-keep-awake.md`
 * §2 and this PR's finding):
 *
 *   - an idle-sleep assertion is defined not to survive lid close;
 *   - the clamshell state is an IOPMrootDomain property, not an assertion, and
 *     `kIOPMDisableClamshell` is a power-management message no user-space
 *     process sends;
 *   - the one user-space switch that does it — `pmset -a disablesleep 1` — is
 *     system-wide, persists in a root-owned plist, and `pmset(1)` says "pmset
 *     must be run as root in order to modify any settings".
 *
 * So the value is accepted, it behaves as `always`, and every surface says
 * this rather than pretending — until the owner has made that change
 * themselves: doctor reads `pmset -g` (`parseSleepDisabled`) and reports the
 * lid half as in effect once it is (ruling 3, plan §2.15).
 */
export const LID_CLOSED_NOT_AVAILABLE =
  "keeping this Mac awake with the lid closed is not available on this Mac without an administrator change: an idle-sleep assertion does not survive lid close (IOPMLib.h), and the only switch that does — `sudo pmset -a disablesleep 1` — is a system-wide setting Metistry will not make for you.";

// ---- the object form (plan §2.15, G3; ruling 3 of 2026-09-26) ---------------

/**
 * The Services pane's switch and its two sub-switches, as `deployment.yaml`
 * stores them:
 *
 *   keep_awake: { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }
 *
 * It sits BESIDE the four values, never instead of them: every file written
 * before it still loads and means what it meant (`keepAwakeSetting` maps each
 * value to exactly this shape). The two sub-switches default to the safe
 * answer — sleep on battery, sleep with the lid closed — because neither is a
 * cost anything may impose on the owner's behalf: a missing key never keeps a
 * laptop awake on battery or in a bag. `enabled` has no default; an object that
 * does not say whether the switch is on is a typo, not a guess.
 */
export const keepAwakeObjectSchema = z
  .object({
    /** the switch: false holds nothing, whatever the two below say (they are remembered, not applied) */
    enabled: z.boolean(),
    /** true = released on battery and on a UPS (`allow_sleep_on_battery`); false = held on any power */
    sleep_on_battery: z.boolean().default(true),
    /**
     * true = a closed lid sleeps, which is what every Mac does. false = the
     * owner WANTS a closed Mac kept awake — stored as asked, and delivered only
     * by an administrator setting the owner makes by hand
     * (`LID_CLOSED_COMMAND`); nothing in Metistry runs it. Doctor reads
     * `pmset -g` and says whether it is in effect.
     */
    sleep_lid_closed: z.boolean().default(true),
  })
  .strict();

/** What the key may hold: one of the four values, or the object. */
export const keepAwakeConfigSchema = z.union([z.enum(KEEP_AWAKE_VALUES), keepAwakeObjectSchema]);
export type KeepAwakeConfig = z.infer<typeof keepAwakeConfigSchema>;

/** The object form with every key said — what everything below the parse reads. */
export interface KeepAwakeSetting {
  enabled: boolean;
  sleep_on_battery: boolean;
  sleep_lid_closed: boolean;
}

/**
 * Either spelling, as the one shape. Absent means the owner was never asked,
 * which is `never` (`KEEP_AWAKE_DEFAULT`), which is the switch off with both
 * sub-switches at their safe answer.
 */
export function keepAwakeSetting(config: KeepAwakeConfig | undefined): KeepAwakeSetting {
  const v = config ?? KEEP_AWAKE_DEFAULT;
  if (typeof v !== "string") return { enabled: v.enabled, sleep_on_battery: v.sleep_on_battery ?? true, sleep_lid_closed: v.sleep_lid_closed ?? true };
  switch (v) {
    case "never":
      return { enabled: false, sleep_on_battery: true, sleep_lid_closed: true };
    case "allow_sleep_on_battery":
      return { enabled: true, sleep_on_battery: true, sleep_lid_closed: true };
    case "always":
      return { enabled: true, sleep_on_battery: false, sleep_lid_closed: true };
    case "always_lid_closed":
      return { enabled: true, sleep_on_battery: false, sleep_lid_closed: false };
  }
}

/**
 * The named value a setting reads as — what the holder is told
 * (`METISTRY_KEEP_AWAKE`), what the state file records and what doctor's
 * `meta.mode` says, so neither the watchdog nor the app's reading of the row
 * changes. Exact for every setting a value names; the one setting no value
 * names (switch on, sleep on battery, lid closed wanted) reads as
 * `allow_sleep_on_battery`, which is everything a process can hold for it —
 * the lid half is the administrator's setting, reported beside the value
 * (`wantsLidClosedAwake`), never through it.
 */
export function keepAwakeValue(s: KeepAwakeSetting): KeepAwake {
  if (!s.enabled) return "never";
  if (s.sleep_on_battery) return "allow_sleep_on_battery";
  return s.sleep_lid_closed ? "always" : "always_lid_closed";
}

/** Is the lid-closed half asked for — the switch on and its lid sub-switch off? */
export function wantsLidClosedAwake(s: KeepAwakeSetting): boolean {
  return s.enabled && !s.sleep_lid_closed;
}

/** The same setting? Compared as the one shape, so `always` and its object spelling are equal. */
export function sameKeepAwake(a: KeepAwakeSetting, b: KeepAwakeSetting): boolean {
  return a.enabled === b.enabled && a.sleep_on_battery === b.sleep_on_battery && a.sleep_lid_closed === b.sleep_lid_closed;
}

// ---- the lid: the administrator setting, its dialog, and the one read ---------

/**
 * The lid dialog's words, in one place every surface reads (the CLI prints
 * them before it stores `sleep_lid_closed: false`; doctor carries them while
 * the setting is not in effect; the Mac app mirrors them — T6-11). Ruling 3:
 * the app explains how, warns, and keeps the value. NOTHING RUNS THESE
 * COMMANDS: they are text for a person to copy, and the test that no code
 * path runs `pmset` with arguments that write is what holds that.
 */
export const LID_CLOSED_DIALOG_TITLE = "Keeping a closed Mac awake needs an administrator setting Metistry will not change for you";
/** What the owner runs, in Terminal, as an administrator — the Copy button's text. */
export const LID_CLOSED_COMMAND = "sudo pmset -a disablesleep 1";
/** How to undo it. */
export const LID_CLOSED_UNDO = "sudo pmset -a disablesleep 0";
/** The warning, said every time the command is. */
export const LID_CLOSED_WARNING =
  "Not recommended: it applies to the whole Mac and every app, not only Metistry; it persists across restarts; and it can overheat a laptop in a bag and run the battery flat.";

/**
 * Every `pmset` argument list anything in Metistry may pass — reads, all of
 * them. `pmset(1)`: "pmset must be run as root in order to modify any
 * settings", and a setting is only ever changed with `-a`/`-b`/`-c`/`-u`, a
 * subcommand such as `sleepnow`, or a schedule; `-g` is the only read. A
 * caller names one of these rather than writing its own argv, so there is no
 * argument list to get wrong.
 */
export const PMSET_READS = Object.freeze({
  /** the live settings — `SleepDisabled` is here when an administrator set it */
  settings: Object.freeze(["-g"] as const),
  /** who holds which assertion, per process */
  assertions: Object.freeze(["-g", "assertions"] as const),
  /** which power source the Mac is drawing from */
  power_source: Object.freeze(["-g", "ps"] as const),
});

/** True only for an argument list `PMSET_READS` names. Anything else — a write, a schedule, a typo — is false. */
export function isPmsetRead(args: readonly string[]): boolean {
  return Object.values(PMSET_READS).some((read) => read.length === args.length && read.every((a, i) => a === args[i]));
}

/**
 * Is the administrator setting in effect, from `pmset -g`'s output?
 *
 * `pmset -a disablesleep 1` shows as a `SleepDisabled 1` line in the
 * "System-wide power settings:" block; undone, the line reads 0 or is absent
 * (this Mac Studio, 2026-09-26: absent). Output that is not `pmset -g`'s at all
 * — empty, an error — is `undefined`: doctor then says it could not tell,
 * never that the setting is off.
 */
export function parseSleepDisabled(pmsetSettings: string): boolean | undefined {
  const m = /^\s*SleepDisabled\s+(\d+)/m.exec(pmsetSettings);
  if (m) return m[1] !== "0";
  return /power settings:/i.test(pmsetSettings) ? false : undefined;
}

export interface KeepAwakeChoice {
  value: KeepAwake;
  /** Title Case, the way the app's radio and the CLI's question name it. */
  label: string;
  /** What this choice COSTS, in plain language — the informed half of informed consent. */
  consequence: string;
  /** Offered as the default answer. Exactly one choice is. */
  recommended: boolean;
  /** Offered last and marked: it is never a default, and it cannot be delivered in full. */
  notRecommended: boolean;
}

/**
 * The question, as one table every surface reads from — the CLI's onboarding
 * prompt, `docs/ops/deployment-shapes.md`, and (mirrored, because Swift cannot
 * import TypeScript) the Mac app's `keep-awake.swift`. One list means one
 * wording, and a wording that says the cost of each answer rather than only
 * its name.
 */
export const KEEP_AWAKE_CHOICES: readonly KeepAwakeChoice[] = Object.freeze([
  {
    value: "allow_sleep_on_battery",
    label: "Keep this Mac awake on power",
    consequence:
      "Held while this Mac is on wall power; released on battery and on a UPS, so a laptop away from a charger sleeps normally and the install pauses with it.",
    recommended: true,
    notRecommended: false,
  },
  {
    value: "always",
    label: "Keep this Mac awake on power and on battery",
    consequence:
      "Held whichever way this Mac is powered. On a laptop away from a charger that drains the battery faster; a Mac still sleeps at low battery and when you close the lid.",
    recommended: false,
    notRecommended: false,
  },
  {
    value: "never",
    label: "Never keep this Mac awake",
    consequence:
      "Nothing is held and your own sleep settings decide. Metistry pauses whenever the Mac sleeps: remote captures, scheduled collectors and the assistant's queue wait until it wakes.",
    recommended: false,
    notRecommended: false,
  },
  {
    value: "always_lid_closed",
    label: "Keep this Mac awake even with the lid closed",
    consequence:
      "Not recommended, and this one is not ours to give: Metistry holds it awake exactly as the option above, and the lid-closed half needs an administrator change you make yourself. A closed laptop drains its battery.",
    recommended: false,
    notRecommended: true,
  },
] as const satisfies readonly KeepAwakeChoice[]);

export function keepAwakeChoice(value: KeepAwake): KeepAwakeChoice {
  return KEEP_AWAKE_CHOICES.find((c) => c.value === value)!;
}

/** `keep-awake` spelled as a CLI/doctor identifier — one place, so the row name, the verb and the docs cannot drift. */
export const KEEP_AWAKE_KIND = "keep-awake";

/**
 * `IOPMAssertionCreateWithName`'s `AssertionName` "may be no longer than 128
 * characters" (IOPMLib.h). Nothing passes a name to `caffeinate` — under it the
 * assertion's name is Apple's, and no trick changes that — but the reason
 * string is written where the swap to a native holder would read it, so it is
 * held to the limit that holder will have.
 */
export const KEEP_AWAKE_REASON_MAX = 128; // limit: fixed — IOPMLib.h's documented AssertionName ceiling, not ours to choose

/**
 * Why this Mac is being held awake, in the assistant's own name — templated
 * from `identity.yaml`, which is the only place that name lives (CLAUDE.md).
 * An instance whose identity cannot be read says "the assistant" rather than
 * inventing one.
 */
export function keepAwakeReason(assistantName: string | undefined): string {
  const who = assistantName?.trim() || "the assistant";
  return `${who} is running — Metistry holds PreventUserIdleSystemSleep while this install is up`.slice(0, KEEP_AWAKE_REASON_MAX);
}

/** A typo is an error, never a guess — the same rule `deployment.yaml`'s strict parse follows. */
export function parseKeepAwake(v: string | undefined): KeepAwake | undefined {
  return v !== undefined && (KEEP_AWAKE_VALUES as readonly string[]).includes(v) ? (v as KeepAwake) : undefined;
}

// ---- the power source -----------------------------------------------------

/**
 * `IOPowerSources.h`'s three answers, plus the one this repo needs and Apple
 * does not have a string for: a Mac that did not say. `IOPSGetProvidingPowerSourceType`
 * returns exactly "AC Power", "Battery Power" or "UPS Power".
 */
export const POWER_SOURCES = ["ac", "battery", "ups", "unknown"] as const;
export type PowerSource = (typeof POWER_SOURCES)[number];

/**
 * `pmset -g ps`'s first line, which is one of:
 *
 *   Now drawing from 'AC Power'
 *   Now drawing from 'Battery Power'
 *   Now drawing from 'UPS Power'
 *
 * A UPS is a battery — an external one — so it is NOT wall power: during an
 * outage a desktop on a UPS is burning the runtime that exists to shut it down
 * cleanly, and `allow_sleep_on_battery` releases then, which is what the label
 * says.
 */
export function parsePowerSource(pmsetOutput: string): PowerSource {
  const m = /Now drawing from '([^']+)'/.exec(pmsetOutput);
  const name = m?.[1]?.toLowerCase();
  if (name === undefined) return "unknown";
  if (name.startsWith("ac")) return "ac";
  if (name.startsWith("ups")) return "ups";
  if (name.startsWith("battery")) return "battery";
  return "unknown";
}

/** `AC Power` / `Battery Power` / `UPS Power` — the string a person recognises, for a doctor row. */
export function powerSourceLabel(source: PowerSource): string {
  switch (source) {
    case "ac":
      return "AC Power";
    case "battery":
      return "Battery Power";
    case "ups":
      return "UPS Power";
    default:
      return "an unnamed power source";
  }
}

/**
 * Wall power? A Mac that did not answer counts as wall power, because the
 * machine that cannot name a source is the one with no battery to name — a
 * Mac Studio has no `Battery Power` profile at all — and refusing to hold on a
 * desktop would be the wrong failure.
 */
export function onWallPower(source: PowerSource): boolean {
  return source === "ac" || source === "unknown";
}

/**
 * The whole policy, in one function both the holder and doctor call, so
 * "should it be holding?" has exactly one answer in the codebase.
 *
 * `PreventUserIdleSystemSleep` IS honoured on battery — nothing in IOPMLib.h
 * conditions it on wall power — so releasing on battery is policy, not a
 * technical limit, and `always` is a real choice rather than a lie.
 */
export function shouldHold(setting: KeepAwake, source: PowerSource): boolean {
  switch (setting) {
    case "never":
      return false;
    case "allow_sleep_on_battery":
      return onWallPower(source);
    case "always":
    case "always_lid_closed":
      return true;
  }
}

/** Why it is (or is not) holding, in the words a doctor row and a log line both use. */
export function describeKeepAwake(setting: KeepAwake, source: PowerSource): string {
  if (setting === "never") return "keep_awake: never — nothing is held and this Mac's own sleep settings decide";
  if (shouldHold(setting, source)) return `keep_awake: ${setting}, drawing from '${powerSourceLabel(source)}' — holding PreventUserIdleSystemSleep`;
  return `keep_awake: ${setting}, drawing from '${powerSourceLabel(source)}' — released on purpose, which is what this setting asks for`;
}

// ---- the state file -------------------------------------------------------

/**
 * How late a tick has to be before it is evidence that the Mac slept under us.
 *
 * The holder compares wall clocks between its own ticks: a process that was
 * running the whole time and finds `Date.now()` has jumped by minutes was
 * suspended, and on a Mac that means the machine slept. Three ticks is the
 * threshold because one late tick is ordinary scheduling and two is a busy
 * machine; at the 60s default that is a three-minute jump, which nothing but
 * sleep produces on an idle Mac.
 */
export const KEEP_AWAKE_CUTOFF_FACTOR = 3; // limit: fixed — the ratio IS the detection rule, and the interval it multiplies is the configurable half

export const keepAwakeCutoffSchema = z
  .object({
    /** when the Mac came back — the first tick after the gap */
    at: z.string(),
    /** the last tick before it: the Mac slept somewhere between these two */
    from: z.string(),
    gap_ms: z.number().nonnegative(),
    /** what `keep_awake` said at the time, so a setting changed since does not rewrite history */
    mode: z.enum(KEEP_AWAKE_VALUES),
    power_source: z.enum(POWER_SOURCES),
  })
  .strict();

export type KeepAwakeCutoff = z.infer<typeof keepAwakeCutoffSchema>;

/**
 * `<instance>/.metistry/state/run/keep-awake.json` — written by the holder every
 * tick, read by `metistry doctor`.
 *
 * It exists because doctor must not have to ask the supervisor: under a
 * namespaced install, a stopped supervisor, or a shape with no control socket
 * at all there is still a file with the last honest word in it. Every field is
 * a fact the holder observed, never a plan.
 */
export const keepAwakeStateSchema = z
  .object({
    schema: z.literal(1),
    mode: z.enum(KEEP_AWAKE_VALUES),
    holding: z.boolean(),
    /** the `caffeinate` pid, when one is running */
    pid: z.number().int().positive().optional(),
    /** ISO, when THIS hold started — reset when the holder is released and taken again */
    since: z.string().optional(),
    power_source: z.enum(POWER_SOURCES),
    /** templated from identity.yaml's assistant name; the only place that name appears here */
    reason: z.string(),
    /** the pid `caffeinate -w` watches: the supervisor's own */
    supervisor_pid: z.number().int().positive(),
    heartbeat_at: z.string(),
    interval_ms: z.number().int().positive(),
    /** how many times the child had to be respawned this run */
    restarts: z.number().int().nonnegative().default(0),
    /** set by a clean SIGTERM, so a gap after an orderly stop is never read as a sleep */
    stopped_at: z.string().optional(),
    last_cutoff: keepAwakeCutoffSchema.optional(),
  })
  .strict();

export type KeepAwakeState = z.infer<typeof keepAwakeStateSchema>;

/**
 * Tolerant on purpose: a state file that does not parse is `undefined`, and
 * doctor says "configured but nothing is holding" rather than crashing the
 * whole report over a truncated write.
 */
export function parseKeepAwakeState(raw: unknown): KeepAwakeState | undefined {
  const parsed = keepAwakeStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Was the Mac asleep while this setting said it should not have been?
 *
 * The cutoff is recorded with the mode that was live when it happened, so a
 * user who has since answered the question differently is not shown a finding
 * about a policy they no longer have. `never` can never produce one.
 */
export function cutoffIsAFinding(state: KeepAwakeState | undefined): KeepAwakeCutoff | undefined {
  const cutoff = state?.last_cutoff;
  if (!cutoff) return undefined;
  return shouldHold(cutoff.mode, cutoff.power_source) ? cutoff : undefined;
}

/** "41m" / "2h 10m" — a gap a person reads, not 7_412_000. */
export function humanGap(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
