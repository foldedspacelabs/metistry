// keep_awake: the four values, the power-source rule, and the state file the
// holder writes for doctor to read.
import { describe, expect, it } from "vitest";
import {
  KEEP_AWAKE_CHOICES,
  KEEP_AWAKE_DEFAULT,
  KEEP_AWAKE_RECOMMENDED,
  KEEP_AWAKE_VALUES,
  LID_CLOSED_NOT_AVAILABLE,
  cutoffIsAFinding,
  describeKeepAwake,
  humanGap,
  onWallPower,
  parseKeepAwake,
  parseKeepAwakeState,
  parsePowerSource,
  shouldHold,
  type KeepAwakeState,
} from "../src/power.js";
import { keepAwakeOf, overlayDeployment, parseDeployment } from "../src/deployment.js";

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
