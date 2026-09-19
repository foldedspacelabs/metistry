// keep_awake end to end through the CLI: the one-line YAML surgery, the
// protected write, doctor's row in every state the docs claim it has
// (including the owner's ruling E — the Mac slept anyway), the onboarding
// question in both its shapes, and the one variable that carries the answer
// to the holder.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEEP_AWAKE_CUTOFF_FACTOR, type KeepAwakeState } from "@foldedspacelabs/metistry-core";
import { applyKeepAwakeToYaml, loadDeployment } from "../src/deployment.js";
import { buildDeploymentReport, renderDeploymentReport, setKeepAwake } from "../src/deployment-report.js";
import { assertionHolders, keepAwakeRow } from "../src/doctor.js";
import { askKeepAwake, keepAwakeQuestion } from "../src/init.js";
import { main } from "../src/main.js";
import { checkout, fakeExec, put } from "./fixtures.js";

const seedDir = fileURLToPath(new URL("../../../seed/", import.meta.url));
const fresh = (p = "metistry-ka-") => mkdtemp(join(tmpdir(), p));

describe("applyKeepAwakeToYaml", () => {
  it("writes one line into an existing file and leaves every comment and key alone", () => {
    const existing = "# a comment nobody should lose\nshape: launchd\n\nservices:\n  db:\n    shape: compose\n";
    const out = applyKeepAwakeToYaml(existing, "always", "launchd");
    expect(out).toBe("# a comment nobody should lose\nshape: launchd\nkeep_awake: always\n\nservices:\n  db:\n    shape: compose\n");
    // and rewrites its own line rather than adding a second
    expect(applyKeepAwakeToYaml(out, "never", "launchd")).toBe(out.replace("keep_awake: always", "keep_awake: never"));
  });

  it("a fresh file carries the shape ALREADY in effect, so answering one question never answers the other", () => {
    const out = applyKeepAwakeToYaml(undefined, "allow_sleep_on_battery", "launchd");
    expect(out).toContain("shape: launchd");
    expect(out).toContain("keep_awake: allow_sleep_on_battery");
    expect(out).toContain("services: {}");
  });

  it("a file with no shape line at all still gets the key, at the top", () => {
    expect(applyKeepAwakeToYaml("services: {}\n", "always", "compose")).toBe("keep_awake: always\nservices: {}\n");
  });
});

// ---- the verb ---------------------------------------------------------------

async function instanceWith(content?: string): Promise<string> {
  const dir = await fresh("metistry-inst-");
  await mkdir(join(dir, ".metistry"), { recursive: true });
  if (content !== undefined) await writeFile(join(dir, ".metistry", "deployment.yaml"), content);
  return dir;
}

describe("metistry deployment set-keep-awake", () => {
  it("previews without writing, and says what the choice costs before it is taken", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const r = await setKeepAwake({
      productDir: P,
      instanceDir: I,
      keepAwake: "always",
      env: { METISTRY_INSTANCE_DIR: I },
      platform: "darwin",
      uid: 501,
      fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
      exec: fakeExec(),
      out: (l) => lines.push(l),
    });
    expect(r.applied).toBe(false);
    expect(lines.join("\n")).toContain("drains the battery faster");
    expect(lines.join("\n")).toContain("[dry-run] write");
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toBe("shape: launchd\nservices: {}\n");
  });

  it("--yes writes it, through the direct path when no reconciler is configured", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nservices: {}\n");
    const r = await setKeepAwake({
      productDir: P,
      instanceDir: I,
      keepAwake: "allow_sleep_on_battery",
      yes: true,
      env: { METISTRY_INSTANCE_DIR: I },
      platform: "linux", // no launchctl probe for a running reconciler
      uid: 501,
      fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
      exec: fakeExec(),
      out: () => {},
    });
    expect(r.applied).toBe(true);
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toContain("keep_awake: allow_sleep_on_battery");
    const loaded = await loadDeployment(P, { METISTRY_INSTANCE_DIR: I });
    expect(loaded.deployment.keep_awake).toBe("allow_sleep_on_battery");
  });

  it("goes through the reconciler as the user principal when one is configured (invariant 2)", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nservices: {}\n");
    const posted: { url: string; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      posted.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await setKeepAwake({
      productDir: P,
      instanceDir: I,
      keepAwake: "always",
      yes: true,
      env: { METISTRY_INSTANCE_DIR: I, METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "t" },
      platform: "darwin",
      uid: 501,
      fetchFn,
      exec: fakeExec(),
      out: () => {},
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toContain("/vault/write");
    expect(posted[0]!.body.path).toBe(".metistry/deployment.yaml");
    expect(posted[0]!.body.intent.principal).toBe("user");
    expect(posted[0]!.body.content).toContain("keep_awake: always");
  });

  it("says nothing to change when the answer is already the one on file", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: always\nservices: {}\n");
    const lines: string[] = [];
    const r = await setKeepAwake({
      productDir: P,
      instanceDir: I,
      keepAwake: "always",
      yes: true,
      env: { METISTRY_INSTANCE_DIR: I },
      platform: "linux",
      uid: 501,
      fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
      exec: fakeExec(),
      out: (l) => lines.push(l),
    });
    expect(r.applied).toBe(false);
    expect(lines.join("\n")).toContain("already keep_awake: always");
  });

  it("a typo is a usage error, never a guess", async () => {
    const P = await checkout();
    const errs: string[] = [];
    const code = await main(["deployment", "set-keep-awake", "alway", "--product-dir", P], { err: (l) => errs.push(l), out: () => {} });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("usage: metistry deployment set-keep-awake");
  });

  it("the report names the policy, and the compose shape's honest caveat", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: compose\nkeep_awake: always\nservices: {}\n");
    const report = await buildDeploymentReport({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, exec: fakeExec(), platform: "darwin", uid: 501 });
    expect(report.keep_awake).toBe("always");
    expect(report.keep_awake_note).toContain("no supervisor");
    expect(renderDeploymentReport(report)).toContain("keep_awake: always —");
  });
});

// ---- doctor's row -----------------------------------------------------------

const PMSET_ASSERTIONS = `Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 353(powerd): [0x0029cacb00019951] 02:03:38 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
   pid 4242(caffeinate): [0x0029cf7300019aea] 00:12:02 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
   pid 82265(Safari): [0x0029e3c00005a1c8] 00:17:09 PreventUserIdleDisplaySleep named: "com.apple.WebCore: HTMLMediaElement playback"
`;

const pmset = (stdout = PMSET_ASSERTIONS) => fakeExec({ pmset: () => ({ stdout }) });

async function withState(state: Partial<KeepAwakeState> | undefined, over: Partial<KeepAwakeState> = {}): Promise<string> {
  const dir = await fresh("metistry-ka-state-");
  await mkdir(join(dir, ".metistry", "state", "run"), { recursive: true });
  // a minimal instance directory, so the layout resolves to the flat one
  await writeFile(join(dir, ".metistry", "identity.yaml"), "name: Athena\n");
  if (state === undefined) return dir;
  const full: KeepAwakeState = {
    schema: 1,
    mode: "always",
    holding: true,
    pid: 4242,
    since: new Date().toISOString(),
    power_source: "ac",
    reason: "Athena is running",
    supervisor_pid: 9007,
    heartbeat_at: new Date().toISOString(),
    interval_ms: 60_000,
    restarts: 0,
    ...state,
    ...over,
  };
  await writeFile(join(dir, ".metistry", "state", "run", "keep-awake.json"), JSON.stringify(full, null, 2));
  return dir;
}

const launchd = { shape: "launchd" as const, services: {} };

describe("doctor's keep-awake row", () => {
  it("is not emitted off macOS at all — there is no assertion to hold", async () => {
    expect(await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: await withState({}), exec: pmset(), platform: "linux" })).toBeUndefined();
  });

  it("never: absent, with the verb that turns it on", async () => {
    const row = (await keepAwakeRow({ deployment: launchd, instanceDir: await withState(undefined), exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("absent");
    expect(row.remediation).toContain("set-keep-awake allow_sleep_on_battery");
    expect(row.meta).toEqual({ mode: "never" });
  });

  it("compose: absent, because there is no supervisor to hold it", async () => {
    const row = (await keepAwakeRow({
      deployment: { shape: "compose", services: {}, keep_awake: "always" },
      instanceDir: await withState({}),
      exec: pmset(),
      platform: "darwin",
    }))!;
    expect(row.status).toBe("absent");
    expect(row.remediation).toContain("installs no supervisor");
  });

  it("held: ok, with our pid cross-checked against the per-process block (never the summary, never a name)", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: await withState({}), exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("ok");
    expect(row.meta).toMatchObject({ mode: "always", holding: true, pid: 4242, power_source: "ac" });
    // powerd also holds one: informational, never a finding
    expect(row.meta!.other_holders).toBe(1);
  });

  it("held by us according to the file, but pmset does not list that pid: degraded, not ok", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: await withState({ pid: 5151 }), exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("does not list it holding PreventUserIdleSystemSleep");
  });

  it("released on battery under allow_sleep_on_battery: OK — that is the setting working", async () => {
    const row = (await keepAwakeRow({
      deployment: { ...launchd, keep_awake: "allow_sleep_on_battery" },
      instanceDir: await withState({ mode: "allow_sleep_on_battery", holding: false, pid: undefined, power_source: "battery" }),
      exec: pmset(),
      platform: "darwin",
    }))!;
    expect(row.status).toBe("ok");
    expect(row.meta).toMatchObject({ holding: false, power_source: "battery" });
  });

  it("configured but nothing has written the file: degraded", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: await withState(undefined), exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("nothing has written");
  });

  it("the fourth value: degraded, with the exact administrator sentence — offered, not faked", async () => {
    const row = (await keepAwakeRow({
      deployment: { ...launchd, keep_awake: "always_lid_closed" },
      instanceDir: await withState({ mode: "always_lid_closed" }),
      exec: pmset(),
      platform: "darwin",
    }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("not available on this Mac without an administrator change");
    expect(row.remediation).toContain("pmset -a disablesleep 1");
    expect(row.meta!.holding).toBe(true); // it still holds everything it can
  });

  it("ruling E: the Mac slept anyway — degraded, with when, for how long, and the repair", async () => {
    const dir = await withState({
      last_cutoff: { at: "2026-09-19T02:41:00.000Z", from: "2026-09-19T02:00:00.000Z", gap_ms: 2_460_000, mode: "always", power_source: "ac" },
    });
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: dir, exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("slept at 2026-09-19T02:41:00.000Z");
    expect(row.remediation).toContain("about 41m");
    expect(row.remediation).toContain("set-keep-awake always --yes");
    expect(row.remediation).toContain("costs battery");
  });

  it("a stale heartbeat is the supervisor being gone, and says so", async () => {
    const dir = await withState({ heartbeat_at: new Date(Date.now() - 60_000 * (KEEP_AWAKE_CUTOFF_FACTOR + 2)).toISOString() });
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: dir, exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("the supervisor is not running");
  });

  it("a clean stop is reported as one, not as a sleep", async () => {
    const dir = await withState({ holding: false, pid: undefined, stopped_at: new Date().toISOString() });
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: dir, exec: pmset(), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("when the supervisor stopped");
  });

  it("never `failed` — a promise about the machine is not a broken install", async () => {
    for (const mode of ["never", "allow_sleep_on_battery", "always", "always_lid_closed"] as const) {
      const row = await keepAwakeRow({ deployment: { ...launchd, keep_awake: mode }, instanceDir: await withState({ mode }), exec: pmset(""), platform: "darwin" });
      expect(row?.status, mode).not.toBe("failed");
    }
  });

  it("reads the per-process block, not the system-wide level, and ignores the display assertion", () => {
    expect(assertionHolders(PMSET_ASSERTIONS)).toEqual([353, 4242]);
    expect(assertionHolders("")).toEqual([]);
  });
});

// ---- the onboarding question -------------------------------------------------

describe("the onboarding question", () => {
  it("prints all four with what each costs, the recommendation named and the last one marked", () => {
    const text = keepAwakeQuestion().join("\n");
    expect(text).toContain("Keep this Mac awake while Metistry runs?");
    for (const value of ["never", "allow_sleep_on_battery", "always", "always_lid_closed"]) expect(text).toContain(`keep_awake: ${value}`);
    expect(text).toContain("(recommended)");
    expect(text).toContain("(not recommended)");
    expect(text.indexOf("always_lid_closed")).toBeGreaterThan(text.indexOf("keep_awake: never"));
  });

  it("takes the number, the value's own name, or Enter for the recommendation", async () => {
    const answers = ["2", "always_lid_closed", "", "  1 "];
    const ask = async () => answers.shift()!;
    expect(await askKeepAwake(ask, () => {})).toBe("always");
    expect(await askKeepAwake(ask, () => {})).toBe("always_lid_closed");
    expect(await askKeepAwake(ask, () => {})).toBe("allow_sleep_on_battery");
    expect(await askKeepAwake(ask, () => {})).toBe("allow_sleep_on_battery");
  });

  it("three unreadable answers is an error, not a silent default — this one changes the machine", async () => {
    const out: string[] = [];
    await expect(askKeepAwake(async () => "yes please", (l) => out.push(l))).rejects.toThrow(/--keep-awake/);
    expect(out.filter((l) => l.includes("is not one of them"))).toHaveLength(3);
  });
});

describe("metistry init", () => {
  const initArgs = (dir: string, P: string) => ["init", dir, "--name", "Athena", "--product-dir", P];

  /** A synthetic checkout carrying the product's REAL seed/ — `init` stamps from it. */
  async function seeded(shape = "launchd"): Promise<string> {
    const P = await checkout();
    await cp(seedDir, join(P, "seed"), { recursive: true });
    await put(P, "seed/deployment.yaml", `shape: ${shape}\nservices: {}\n`);
    return P;
  }

  it("--keep-awake writes the answer, and an interactive answer writes it the same way", async () => {
    const P = await seeded("launchd");
    const byFlag = join(await fresh(), "i1");
    expect(await main([...initArgs(byFlag, P), "--keep-awake", "always"], { out: () => {}, err: () => {} })).toBe(0);
    const written = await readFile(join(byFlag, ".metistry", "deployment.yaml"), "utf8");
    expect(written).toContain("keep_awake: always");
    // the shape it carries is the one this install ALREADY had — never a new decision
    expect(written).toContain("shape: launchd");

    const asked = join(await fresh(), "i2");
    const out: string[] = [];
    expect(await main(initArgs(asked, P), { out: (l) => out.push(l), err: () => {}, ask: async () => "1" })).toBe(0);
    expect(await readFile(join(asked, ".metistry", "deployment.yaml"), "utf8")).toContain("keep_awake: allow_sleep_on_battery");
    expect(out.join("\n")).toContain("Keep this Mac awake while Metistry runs?");
    expect(out.join("\n")).toContain("keep-awake: allow_sleep_on_battery");
  });

  it("no flag and nobody to ask (a pipe, a script, the Mac app): no question, no file, nothing held", async () => {
    const P = await seeded();
    const dir = join(await fresh(), "i3");
    const out: string[] = [];
    expect(await main(initArgs(dir, P), { out: (l) => out.push(l), err: () => {} })).toBe(0);
    await expect(readFile(join(dir, ".metistry", "deployment.yaml"), "utf8")).rejects.toThrow();
    expect(out.join("\n")).toContain("keep-awake: not configured");
  });

  it("a typo in --keep-awake stops init rather than stamping an instance with a guess", async () => {
    const P = await seeded();
    const errs: string[] = [];
    const code = await main([...initArgs(join(await fresh(), "i4"), P), "--keep-awake", "yes"], { out: () => {}, err: (l) => errs.push(l) });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--keep-awake must be one of");
  });
});

describe("the seed", () => {
  it("does not set keep_awake: nothing holds a Mac awake that was never asked", async () => {
    expect(await readFile(join(seedDir, "deployment.yaml"), "utf8")).not.toMatch(/^keep_awake:/m);
  });
});
