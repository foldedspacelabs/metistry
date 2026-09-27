// keep_awake: the four values, the power-source rule, and the state file the
// holder writes for doctor to read.
import { describe, expect, it } from "vitest";
import {
  KEEP_AWAKE_CHOICES,
  KEEP_AWAKE_DEFAULT,
  KEEP_AWAKE_RECOMMENDED,
  KEEP_AWAKE_VALUES,
  LID_CLOSED_COMMAND,
  LID_CLOSED_NOT_AVAILABLE,
  LID_CLOSED_UNDO,
  LID_CLOSED_WARNING,
  PMSET_READS,
  cutoffIsAFinding,
  isPmsetRead,
  keepAwakeSetting,
  keepAwakeValue,
  parseSleepDisabled,
  sameKeepAwake,
  wantsLidClosedAwake,
  describeKeepAwake,
  humanGap,
  onWallPower,
  parseKeepAwake,
  parseKeepAwakeState,
  parsePowerSource,
  shouldHold,
  type KeepAwakeSetting,
  type KeepAwakeState,
} from "../src/power.js";
import { keepAwakeOf, keepAwakeSettingOf, overlayDeployment, parseDeployment } from "../src/deployment.js";

describe("the values", () => {
  it("is four, and an install that was never asked holds nothing", () => {
    expect(KEEP_AWAKE_VALUES).toEqual(["never", "allow_sleep_on_battery", "always", "always_lid_closed"]);
    expect(KEEP_AWAKE_DEFAULT).toBe("never");
    expect(keepAwakeOf(parseDeployment({}))).toBe("never");
  });

  it("refuses a typo rather than guessing", () => {
    expect(parseKeepAwake("always")).toBe("always");
    expect(parseKeepAwake("alway")).toBeUndefined();
    expect(parseKeepAwake("true")).toBeUndefined();
    expect(parseKeepAwake(undefined)).toBeUndefined();
  });

  it("offers exactly one recommendation, and the lid-closed choice is last and marked", () => {
    const recommended = KEEP_AWAKE_CHOICES.filter((c) => c.recommended);
    expect(recommended.map((c) => c.value)).toEqual([KEEP_AWAKE_RECOMMENDED]);
    expect(KEEP_AWAKE_CHOICES.at(-1)?.value).toBe("always_lid_closed");
    expect(KEEP_AWAKE_CHOICES.at(-1)?.notRecommended).toBe(true);
    expect(KEEP_AWAKE_CHOICES.filter((c) => c.notRecommended)).toHaveLength(1);
    // informed consent is the CONSEQUENCE text, so every choice must carry one
    expect(KEEP_AWAKE_CHOICES.map((c) => c.value).sort()).toEqual([...KEEP_AWAKE_VALUES].sort());
    for (const c of KEEP_AWAKE_CHOICES) expect(c.consequence.length).toBeGreaterThan(40);
  });

  it("says out loud that the fourth value needs an administrator, and never claims to do it", () => {
    expect(LID_CLOSED_NOT_AVAILABLE).toContain("not available on this Mac without an administrator change");
    expect(LID_CLOSED_NOT_AVAILABLE).toContain("pmset -a disablesleep 1");
  });
});

describe("the deployment.yaml key", () => {
  it("parses, and is strict about the value", () => {
    expect(parseDeployment({ shape: "launchd", keep_awake: "always" }).keep_awake).toBe("always");
    expect(() => parseDeployment({ keep_awake: true })).toThrow(/keep_awake/);
    expect(() => parseDeployment({ keep_awake: "on" })).toThrow(/keep_awake/);
    expect(() => parseDeployment({ keep_wake: "always" })).toThrow(/keep_wake|Unrecognized/);
  });

  it("an instance file that predates the key inherits the seed's answer instead of overriding it with never", () => {
    const seed = parseDeployment({ shape: "compose", keep_awake: "always" });
    const old = parseDeployment({ shape: "launchd" });
    expect(overlayDeployment(seed, old).keep_awake).toBe("always");
    // and an instance that HAS answered wins
    expect(overlayDeployment(seed, parseDeployment({ shape: "launchd", keep_awake: "never" })).keep_awake).toBe("never");
  });
});

describe("the power source", () => {
  it("reads pmset -g ps's three answers", () => {
    expect(parsePowerSource("Now drawing from 'AC Power'\n -Back-UPS RS 1500G…")).toBe("ac");
    expect(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 84%")).toBe("battery");
    expect(parsePowerSource("Now drawing from 'UPS Power'")).toBe("ups");
  });

  it("a Mac that did not answer counts as wall power — a desktop has no battery to name", () => {
    expect(parsePowerSource("")).toBe("unknown");
    expect(parsePowerSource("pmset: command not found")).toBe("unknown");
    expect(onWallPower("unknown")).toBe(true);
    expect(onWallPower("ups")).toBe(false);
  });
});

describe("shouldHold — the whole policy, in one place", () => {
  const cases: [Parameters<typeof shouldHold>[0], Parameters<typeof shouldHold>[1], boolean][] = [
    ["never", "ac", false],
    ["never", "battery", false],
    ["allow_sleep_on_battery", "ac", true],
    ["allow_sleep_on_battery", "unknown", true],
    ["allow_sleep_on_battery", "battery", false],
    // a UPS is a battery — an external one
    ["allow_sleep_on_battery", "ups", false],
    ["always", "battery", true],
    ["always", "ups", true],
    // the lid half is not ours to give, so it behaves exactly as `always`
    ["always_lid_closed", "battery", true],
    ["always_lid_closed", "ac", true],
  ];
  for (const [setting, source, expected] of cases) {
    it(`${setting} on ${source} → ${expected ? "hold" : "release"}`, () => {
      expect(shouldHold(setting, source)).toBe(expected);
    });
  }

  it("describes a release on battery as the setting working, not as a downgrade", () => {
    expect(describeKeepAwake("allow_sleep_on_battery", "battery")).toContain("released on purpose");
    expect(describeKeepAwake("allow_sleep_on_battery", "ac")).toContain("holding");
    expect(describeKeepAwake("never", "ac")).toContain("nothing is held");
  });
});

describe("the state file", () => {
  const good: KeepAwakeState = {
    schema: 1,
    mode: "always",
    holding: true,
    pid: 4242,
    since: "2026-09-19T12:00:00.000Z",
    power_source: "ac",
    reason: "Athena is running",
    supervisor_pid: 9007,
    heartbeat_at: "2026-09-19T12:05:00.000Z",
    interval_ms: 60_000,
    restarts: 0,
  };

  it("round-trips, and fills the restart counter in", () => {
    expect(parseKeepAwakeState(JSON.parse(JSON.stringify(good)))).toEqual(good);
    const { restarts: _dropped, ...withoutRestarts } = good;
    expect(parseKeepAwakeState(withoutRestarts)?.restarts).toBe(0);
  });

  it("a truncated or foreign file is undefined, never a throw — doctor must still report", () => {
    expect(parseKeepAwakeState(undefined)).toBeUndefined();
    expect(parseKeepAwakeState({ schema: 1 })).toBeUndefined();
    expect(parseKeepAwakeState({ ...good, mode: "sometimes" })).toBeUndefined();
    expect(parseKeepAwakeState("{")).toBeUndefined();
  });

  it("an early cutoff is a finding only for the policy that was live when it happened", () => {
    const cutoff = { at: "2026-09-19T12:41:00.000Z", from: "2026-09-19T12:00:00.000Z", gap_ms: 2_460_000, mode: "always", power_source: "ac" } as const;
    expect(cutoffIsAFinding({ ...good, last_cutoff: { ...cutoff } })?.gap_ms).toBe(2_460_000);
    // it slept while on battery under allow_sleep_on_battery: that IS the setting
    expect(cutoffIsAFinding({ ...good, last_cutoff: { ...cutoff, mode: "allow_sleep_on_battery", power_source: "battery" } })).toBeUndefined();
    expect(cutoffIsAFinding({ ...good, last_cutoff: { ...cutoff, mode: "never" } })).toBeUndefined();
    expect(cutoffIsAFinding(good)).toBeUndefined();
    expect(cutoffIsAFinding(undefined)).toBeUndefined();
  });

  it("prints a gap a person reads", () => {
    expect(humanGap(45_000)).toBe("45s");
    expect(humanGap(2_460_000)).toBe("41m");
    expect(humanGap(7_800_000)).toBe("2h 10m");
    expect(humanGap(7_200_000)).toBe("2h");
  });
});

// ---- T4-20: the object form beside the four values, and the lid ------------

describe("the object form (T4-20)", () => {
  const expected: Record<string, KeepAwakeSetting> = {
    never: { enabled: false, sleep_on_battery: true, sleep_lid_closed: true },
    allow_sleep_on_battery: { enabled: true, sleep_on_battery: true, sleep_lid_closed: true },
    always: { enabled: true, sleep_on_battery: false, sleep_lid_closed: true },
    always_lid_closed: { enabled: true, sleep_on_battery: false, sleep_lid_closed: false },
  };

  it("every old value still loads, reads as the same value, and means one exact setting", () => {
    for (const value of KEEP_AWAKE_VALUES) {
      const d = parseDeployment({ shape: "launchd", keep_awake: value });
      expect(d.keep_awake, value).toBe(value);
      expect(keepAwakeOf(d), value).toBe(value);
      expect(keepAwakeSettingOf(d), value).toEqual(expected[value]);
      // and back: the value each setting reads as is the value it came from
      expect(keepAwakeValue(keepAwakeSetting(value)), value).toBe(value);
    }
    // absent is still never — nothing held for an owner who was never asked
    expect(keepAwakeSettingOf(parseDeployment({}))).toEqual(expected.never);
  });

  it("the object loads, and a missing sub-switch takes the SAFE answer — sleep on battery, sleep with the lid shut", () => {
    const d = parseDeployment({ keep_awake: { enabled: true } });
    expect(keepAwakeSettingOf(d)).toEqual(expected.allow_sleep_on_battery);
    expect(keepAwakeOf(d)).toBe("allow_sleep_on_battery");
    expect(keepAwakeSettingOf(parseDeployment({ keep_awake: { enabled: true, sleep_on_battery: false, sleep_lid_closed: false } }))).toEqual(expected.always_lid_closed);
  });

  it("is strict: no switch, an unknown key, or a boolean for the whole key is an error, never a guess", () => {
    expect(() => parseDeployment({ keep_awake: { sleep_lid_closed: false } })).toThrow(/keep_awake/);
    expect(() => parseDeployment({ keep_awake: { enabled: true, sleep_lid: false } })).toThrow(/keep_awake/);
    expect(() => parseDeployment({ keep_awake: { enabled: "yes" } })).toThrow(/keep_awake/);
    expect(() => parseDeployment({ keep_awake: true })).toThrow(/keep_awake/);
  });

  it("the one setting no value names reads as what a process can hold for it, with the lid half reported beside it", () => {
    const s = { enabled: true, sleep_on_battery: true, sleep_lid_closed: false };
    expect(keepAwakeValue(s)).toBe("allow_sleep_on_battery");
    expect(wantsLidClosedAwake(s)).toBe(true);
    // the switch off remembers its sub-switches but asks for nothing
    expect(wantsLidClosedAwake({ enabled: false, sleep_on_battery: true, sleep_lid_closed: false })).toBe(false);
    expect(keepAwakeValue({ enabled: false, sleep_on_battery: false, sleep_lid_closed: false })).toBe("never");
  });

  it("compares as the one shape, so a value and its object spelling are the same setting", () => {
    expect(sameKeepAwake(keepAwakeSetting("always"), keepAwakeSetting({ enabled: true, sleep_on_battery: false, sleep_lid_closed: true }))).toBe(true);
    expect(sameKeepAwake(keepAwakeSetting("always"), keepAwakeSetting("always_lid_closed"))).toBe(false);
  });

  it("the overlay carries the object like a value: the instance's answer wins when it has one", () => {
    const seed = parseDeployment({ keep_awake: "allow_sleep_on_battery" });
    const obj = { enabled: true, sleep_on_battery: true, sleep_lid_closed: false };
    expect(keepAwakeSettingOf(overlayDeployment(seed, parseDeployment({ keep_awake: obj })))).toEqual(obj);
    expect(keepAwakeOf(overlayDeployment(seed, parseDeployment({})))).toBe("allow_sleep_on_battery");
  });
});

describe("the lid — the administrator setting, read and never written (ruling 3)", () => {
  it("the dialog's words: the command, how to undo it, and the warning", () => {
    expect(LID_CLOSED_COMMAND).toBe("sudo pmset -a disablesleep 1");
    expect(LID_CLOSED_UNDO).toBe("sudo pmset -a disablesleep 0");
    for (const risk of ["Not recommended", "whole Mac", "every app", "restarts", "overheat", "battery flat"]) expect(LID_CLOSED_WARNING).toContain(risk);
  });

  it("reads SleepDisabled from pmset -g, and says it could not tell rather than 'off' when pmset said nothing usable", () => {
    const on = "System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n standby              0\n sleep                0\n";
    const zero = "System-wide power settings:\n SleepDisabled\t\t0\nCurrently in use:\n sleep                1\n";
    // this Mac Studio on 2026-09-26: the line is simply absent
    const absent = "System-wide power settings:\nCurrently in use:\n standby              0\n sleep                0 (sleep prevented by powerd)\n";
    expect(parseSleepDisabled(on)).toBe(true);
    expect(parseSleepDisabled(zero)).toBe(false);
    expect(parseSleepDisabled(absent)).toBe(false);
    expect(parseSleepDisabled("")).toBeUndefined();
    expect(parseSleepDisabled("pmset: command not found")).toBeUndefined();
  });

  it("every pmset argument list the product may pass is a read; every write is refused by the same check", () => {
    for (const read of Object.values(PMSET_READS)) expect(isPmsetRead(read), read.join(" ")).toBe(true);
    expect(PMSET_READS.settings).toEqual(["-g"]);
    for (const write of [
      ["-a", "disablesleep", "1"],
      ["-a", "disablesleep", "0"],
      ["disablesleep", "1"],
      ["-b", "sleep", "0"],
      ["-c", "sleep", "0"],
      ["-u", "haltlevel", "5"],
      ["sleepnow"],
      ["schedule", "wake", "09/27/26 08:00:00"],
      ["repeat", "cancel"],
      ["-g", "assertions", "-a"],
      ["-g", "disablesleep"],
      [],
    ]) {
      expect(isPmsetRead(write), write.join(" ")).toBe(false);
    }
  });
});
