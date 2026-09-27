// T4-20 — the object form beside the four values, `set-keep-awake`'s three
// switches, the lid dialog the CLI prints before it stores
// `sleep_lid_closed: false`, doctor's read of `pmset -g` for the
// administrator setting — and the ticket's bold test: NO CODE PATH RUNS
// `pmset` WITH ARGUMENTS THAT WRITE.
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEEP_AWAKE_VALUES, LID_CLOSED_COMMAND, LID_CLOSED_UNDO, isPmsetRead, keepAwakeSettingOf, type KeepAwakeState } from "@foldedspacelabs/metistry-core";
import { applyKeepAwakeToYaml, loadDeployment } from "../src/deployment.js";
import { buildDeploymentReport, renderDeploymentReport, setKeepAwake, type SetKeepAwakeOptions } from "../src/deployment-report.js";
import { doctor, keepAwakeRow } from "../src/doctor.js";
import { keepAwakeFlags, main, parseArgs } from "../src/main.js";
import { checkout, fakeExec } from "./fixtures.js";

const fresh = (p: string) => mkdtemp(join(tmpdir(), p));
const noFetch = (async () => new Response("{}")) as unknown as typeof fetch;

async function instanceWith(content?: string): Promise<string> {
  const dir = await fresh("metistry-lid-");
  await mkdir(join(dir, ".metistry", "state", "run"), { recursive: true });
  await writeFile(join(dir, ".metistry", "identity.yaml"), "name: Athena\n");
  if (content !== undefined) await writeFile(join(dir, ".metistry", "deployment.yaml"), content);
  return dir;
}

async function withHolder(dir: string, over: Partial<KeepAwakeState> = {}): Promise<string> {
  const state: KeepAwakeState = {
    schema: 1,
    mode: "always_lid_closed",
    holding: true,
    pid: 4242,
    since: new Date().toISOString(),
    power_source: "ac",
    reason: "Athena is running",
    supervisor_pid: 9007,
    heartbeat_at: new Date().toISOString(),
    interval_ms: 60_000,
    restarts: 0,
    ...over,
  };
  await writeFile(join(dir, ".metistry", "state", "run", "keep-awake.json"), JSON.stringify(state));
  return dir;
}

const ASSERTIONS = `Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 4242(caffeinate): [0x0029cf7300019aea] 00:12:02 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
`;
const SETTINGS_OFF = "System-wide power settings:\nCurrently in use:\n standby              0\n sleep                0 (sleep prevented by powerd)\n";
const SETTINGS_ON = "System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n standby              0\n sleep                0\n";

/** A pmset that answers by argv, as the real one does: `-g` is the settings list, `-g assertions` the per-process block. */
const pmset = (settings: string | null = SETTINGS_OFF) =>
  fakeExec({
    pmset: (args) => {
      if (args[1] === "assertions") return { stdout: ASSERTIONS };
      if (args.length === 1 && args[0] === "-g") return settings === null ? { code: 1, stdout: "" } : { stdout: settings };
      return { code: 1, stdout: "", stderr: "pmset: unexpected arguments in a test" };
    },
  });

const launchd = { shape: "launchd" as const, services: {} };
const lidWanted = { enabled: true, sleep_on_battery: false, sleep_lid_closed: false };

// ---- the file -----------------------------------------------------------------

describe("the object form in deployment.yaml", () => {
  it("is written on one line, every key said, and reads back as exactly what was set", async () => {
    const out = applyKeepAwakeToYaml("# keep me\nshape: launchd\nkeep_awake: always\n\nservices: {}\n", { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }, "launchd");
    expect(out).toBe("# keep me\nshape: launchd\nkeep_awake: { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }\n\nservices: {}\n");
    const P = await checkout();
    const I = await instanceWith(out);
    expect(keepAwakeSettingOf((await loadDeployment(P, { METISTRY_INSTANCE_DIR: I })).deployment)).toEqual({ enabled: true, sleep_on_battery: true, sleep_lid_closed: false });
  });

  it("replaces a block-style object someone wrote by hand whole, rather than orphaning its lines", () => {
    const hand = "shape: launchd\nkeep_awake:\n  enabled: true\n  sleep_lid_closed: false\nservices: {}\n";
    expect(applyKeepAwakeToYaml(hand, "never", "launchd")).toBe("shape: launchd\nkeep_awake: never\nservices: {}\n");
  });

  it("every old value still loads through the CLI's reader, unchanged", async () => {
    const P = await checkout();
    for (const value of KEEP_AWAKE_VALUES) {
      const I = await instanceWith(`shape: launchd\nkeep_awake: ${value}\nservices: {}\n`);
      const loaded = await loadDeployment(P, { METISTRY_INSTANCE_DIR: I });
      expect(loaded.deployment.keep_awake, value).toBe(value);
      const report = await buildDeploymentReport({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, exec: fakeExec(), platform: "darwin", uid: 501 });
      expect(report.keep_awake, value).toBe(value);
    }
  });

  it("the report names the lid half beside the one setting no value names", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: { enabled: true, sleep_lid_closed: false }\nservices: {}\n");
    const report = await buildDeploymentReport({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, exec: fakeExec(), platform: "darwin", uid: 501 });
    expect(report.keep_awake).toBe("allow_sleep_on_battery");
    expect(report.keep_awake_setting).toEqual({ enabled: true, sleep_on_battery: true, sleep_lid_closed: false });
    expect(report.keep_awake_note).toContain("metistry doctor");
    expect(renderDeploymentReport(report)).toContain("allow_sleep_on_battery (and awake with the lid closed)");
  });
});

// ---- the verb -----------------------------------------------------------------

function opts(P: string, I: string, over: Partial<SetKeepAwakeOptions>, lines: string[] = []): SetKeepAwakeOptions {
  return { productDir: P, instanceDir: I, env: { METISTRY_INSTANCE_DIR: I }, platform: "darwin", uid: 501, fetchFn: noFetch, exec: fakeExec(), out: (l) => lines.push(l), ...over };
}

describe("set-keep-awake's switches", () => {
  it("--sleep-lid-closed false prints the dialog — command, undo, warning — before it stores anything, and runs no pmset", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: always\nservices: {}\n");
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await setKeepAwake(opts(P, I, { set: { sleep_lid_closed: false }, exec }, lines));
    const text = lines.join("\n");
    expect(r.applied).toBe(false);
    expect(text).toContain("needs an administrator setting Metistry will not change for you");
    expect(text).toContain(LID_CLOSED_COMMAND);
    expect(text).toContain(LID_CLOSED_UNDO);
    expect(text).toContain("Not recommended");
    expect(text).toContain("never runs either command");
    expect(exec.calls.filter((c) => c.cmd.endsWith("pmset"))).toEqual([]);
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toContain("keep_awake: always\n");
  });

  it("--yes stores the value as asked (ruling 3), over the setting already in effect", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: always\nservices: {}\n");
    const r = await setKeepAwake(opts(P, I, { set: { sleep_lid_closed: false }, yes: true, platform: "linux" }));
    expect(r.applied).toBe(true);
    expect(r.keep_awake).toBe("always_lid_closed");
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toContain("keep_awake: { enabled: true, sleep_on_battery: false, sleep_lid_closed: false }");
  });

  it("a flag changes only the switch it names: turning the switch off remembers both sub-switches", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }\nservices: {}\n");
    const r = await setKeepAwake(opts(P, I, { set: { enabled: false }, yes: true, platform: "linux" }));
    expect(r.keep_awake).toBe("never");
    expect(r.keep_awake_setting).toEqual({ enabled: false, sleep_on_battery: true, sleep_lid_closed: false });
  });

  it("a value with flags: the flags apply over the value, not over what is on file", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: never\nservices: {}\n");
    const r = await setKeepAwake(opts(P, I, { keepAwake: "always", set: { sleep_lid_closed: false }, yes: true, platform: "linux" }));
    expect(r.keep_awake_setting).toEqual(lidWanted);
  });

  it("the same setting in the other spelling is nothing to change", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: always_lid_closed\nservices: {}\n");
    const lines: string[] = [];
    const r = await setKeepAwake(opts(P, I, { set: { enabled: true, sleep_on_battery: false, sleep_lid_closed: false }, yes: true }, lines));
    expect(r.applied).toBe(false);
    expect(lines.join("\n")).toContain("nothing to change");
  });

  it("the Mac sleeps on battery anyway under the administrator setting, and the dialog says so when the battery sub-switch says otherwise", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: allow_sleep_on_battery\nservices: {}\n");
    const lines: string[] = [];
    await setKeepAwake(opts(P, I, { set: { sleep_lid_closed: false } }, lines));
    expect(lines.join("\n")).toContain("does not sleep on battery either");
  });

  it("naming nothing is refused by the function as well as the verb", async () => {
    const P = await checkout();
    const I = await instanceWith();
    await expect(setKeepAwake(opts(P, I, {}))).rejects.toThrow(/name a value or at least one of/);
  });
});

describe("the verb's flags", () => {
  it("each takes true or false and nothing else — a bare --sleep-lid-closed is refused, never read as true", () => {
    expect(keepAwakeFlags(parseArgs(["--enabled", "true", "--sleep-on-battery", "false"]).flags)).toEqual({ enabled: true, sleep_on_battery: false });
    expect(keepAwakeFlags(parseArgs(["--sleep-lid-closed=false"]).flags)).toEqual({ sleep_lid_closed: false });
    expect(() => keepAwakeFlags(parseArgs(["--sleep-lid-closed", "--yes"]).flags)).toThrow(/takes true or false, not nothing/);
    expect(() => keepAwakeFlags(parseArgs(["--enabled", "yes"]).flags)).toThrow(/takes true or false/);
  });

  it.each([
    [["deployment", "set-keep-awake"]],
    [["deployment", "set-keep-awake", "--sleep-lid-closed"]],
    [["deployment", "set-keep-awake", "--enabled", "on"]],
    [["deployment", "set-keep-awake", "always", "extra"]],
    [["deployment", "set-keep-awake", "alway", "--enabled", "true"]],
  ])("%j is a usage error (exit 2)", async (argv) => {
    const P = await checkout();
    const errs: string[] = [];
    expect(await main([...argv, "--product-dir", P], { err: (l) => errs.push(l), out: () => {} })).toBe(2);
    expect(errs.join("\n")).toContain("usage: metistry deployment set-keep-awake [<");
  });

  it("the verb end to end: flags alone write the object form", async () => {
    const P = await checkout();
    const I = await instanceWith("shape: launchd\nkeep_awake: allow_sleep_on_battery\nservices: {}\n");
    const out: string[] = [];
    const code = await main(["deployment", "set-keep-awake", "--sleep-on-battery", "false", "--instance", I, "--product-dir", P, "--yes"], {
      err: (l) => out.push(l),
      out: (l) => out.push(l),
      platform: "linux",
      exec: fakeExec(),
    });
    expect(code, out.join("\n")).toBe(0);
    expect(await readFile(join(I, ".metistry", "deployment.yaml"), "utf8")).toContain("keep_awake: { enabled: true, sleep_on_battery: false, sleep_lid_closed: true }");
  });
});

// ---- doctor ---------------------------------------------------------------------

describe("doctor reads pmset -g for the administrator setting (P5)", () => {
  it("not in effect: degraded, carrying the command, how to undo it and the warning", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: lidWanted }, instanceDir: await withHolder(await instanceWith()), exec: pmset(SETTINGS_OFF), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain(LID_CLOSED_COMMAND);
    expect(row.remediation).toContain(LID_CLOSED_UNDO);
    expect(row.remediation).toContain("Not recommended");
    expect(row.meta).toMatchObject({ mode: "always_lid_closed", holding: true, lid_closed: "not in effect", sleep_lid_closed: false });
  });

  it("the lid's facts ride every state, including 'nothing has written the state file'", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: lidWanted }, instanceDir: await instanceWith(), exec: pmset(SETTINGS_OFF), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("nothing has written");
    expect(row.remediation).toContain(LID_CLOSED_UNDO);
    expect(row.meta).toMatchObject({ lid_closed: "not in effect" });
  });

  it("in effect: ok — the switch stops saying 'not in effect' once the owner has made the change", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always_lid_closed" }, instanceDir: await withHolder(await instanceWith()), exec: pmset(SETTINGS_ON), platform: "darwin" }))!;
    expect(row.status).toBe("ok");
    expect(row.remediation).toBeUndefined();
    expect(row.meta).toMatchObject({ lid_closed: "in effect" });
  });

  it("pmset did not answer: 'unknown', never 'off'", async () => {
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: lidWanted }, instanceDir: await withHolder(await instanceWith()), exec: pmset(null), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("did not answer, so whether it is in effect is unknown");
    expect(row.meta).toMatchObject({ lid_closed: "unknown" });
  });

  it("the lid is not asked for: pmset -g is not even read", async () => {
    const exec = pmset(SETTINGS_ON);
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: "always" }, instanceDir: await withHolder(await instanceWith(), { mode: "always" }), exec, platform: "darwin" }))!;
    expect(row.status).toBe("ok");
    expect(row.meta!.lid_closed).toBeUndefined();
    expect(exec.calls.map((c) => c.args.join(" "))).toEqual(["-g assertions"]);
  });

  it("the early-cutoff repair keeps the lid answer: the flag, never `always`, which would reset it", async () => {
    const dir = await withHolder(await instanceWith(), {
      mode: "allow_sleep_on_battery",
      last_cutoff: { at: "2026-09-26T02:41:00.000Z", from: "2026-09-26T02:00:00.000Z", gap_ms: 2_460_000, mode: "allow_sleep_on_battery", power_source: "ac" },
    });
    const row = (await keepAwakeRow({ deployment: { ...launchd, keep_awake: { enabled: true, sleep_on_battery: true, sleep_lid_closed: false } }, instanceDir: dir, exec: pmset(SETTINGS_ON), platform: "darwin" }))!;
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("set-keep-awake --sleep-on-battery false --yes");
    expect(row.remediation).not.toContain("set-keep-awake always --yes");
  });
});

// ---- the bold test: no code path runs pmset with arguments that write -------------

const repo = fileURLToPath(new URL("../../../", import.meta.url));

async function sources(dir: string, ext: RegExp): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".build" || e.name === "test" || e.name === "tests") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p, ext)));
    else if (ext.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("no code path runs pmset with arguments that write", () => {
  it("every pmset doctor, the report and the verb run — in every setting — is a read", async () => {
    const P = await checkout();
    const settings = [...KEEP_AWAKE_VALUES, lidWanted, { enabled: true, sleep_on_battery: true, sleep_lid_closed: false }, { enabled: false, sleep_on_battery: false, sleep_lid_closed: false }];
    const seen: string[][] = [];
    for (const keep_awake of settings) {
      const exec = pmset(SETTINGS_OFF);
      const I = await withHolder(await instanceWith());
      await keepAwakeRow({ deployment: { ...launchd, keep_awake }, instanceDir: I, exec, platform: "darwin" });
      await buildDeploymentReport({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, exec, platform: "darwin", uid: 501 });
      await setKeepAwake(opts(P, I, { keepAwake: "always", set: { sleep_lid_closed: false }, exec, yes: true, platform: "linux" }));
      seen.push(...exec.calls.filter((c) => c.cmd.endsWith("pmset")).map((c) => c.args));
    }
    // and the whole doctor, once, with the lid asked for
    const I = await withHolder(await instanceWith(`shape: launchd\nkeep_awake: always_lid_closed\nservices: {}\n`));
    const exec = pmset(SETTINGS_OFF);
    // db: null, namespace: null and appPath: null — this test opens no database, reads no ports file and looks at no /Applications
    await doctor({ productDir: P, env: { METISTRY_INSTANCE_DIR: I }, exec, platform: "darwin", uid: 501, fetchFn: noFetch, db: null, namespace: null, appPath: null, timeoutMs: 50 });
    seen.push(...exec.calls.filter((c) => c.cmd.endsWith("pmset")).map((c) => c.args));

    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) expect(isPmsetRead(args), `pmset ${args.join(" ")}`).toBe(true);
  });

  it("every place the source can start pmset passes a read — a static sweep of every package, app and the Mac app", async () => {
    const files = [
      ...(await sources(join(repo, "packages"), /\.(ts|mts|mjs|js)$/)),
      ...(await sources(join(repo, "apps"), /\.(ts|mts|mjs|js|swift)$/)),
      ...(await sources(join(repo, "ops"), /\.(ts|mts|mjs|js|sh)$/)),
    ];
    expect(files.length).toBeGreaterThan(50);
    // pmset NAMED AS A PROGRAM — a quoted "pmset", its path, or the constant
    // that holds it. Prose that mentions the command (the dialog's own text)
    // is a sentence for a person, not an argv, and does not match.
    const asProgram = /(["'`])(?:\/usr\/bin\/)?pmset\1|\bPMSET_BIN\b/;
    const allowedCall = /\(\s*(?:["']pmset["']|PMSET_BIN)\s*,\s*(?:\[\.\.\.PMSET_READS\.\w+\]|\[\s*["']-g["']\s*(?:,\s*["'](?:assertions|ps)["']\s*)?\])/;
    const offenders: string[] = [];
    for (const f of files) {
      const lines = (await readFile(f, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (!asProgram.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return; // a comment
        if (/export const PMSET_BIN = "\/usr\/bin\/pmset";/.test(line)) return; // the constant itself
        if (allowedCall.test(line)) return;
        offenders.push(`${f.slice(repo.length)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
