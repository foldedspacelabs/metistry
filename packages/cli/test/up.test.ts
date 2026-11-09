// `metistry up` against fakes: the exact --dry-run command list, the real
// run's call order (compose, then every plist rendered + bootstrapped, then
// doctor as the verdict), the failure path, the flags, release mode from
// the instance lock, and the Linux branch that prints systemd units instead
// of touching launchd.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeLock } from "../src/lock.js";
import { main } from "../src/main.js";
import { up } from "../src/up.js";
import { tokenHash } from "@foldedspacelabs/metistry-core";
import { decodeSecurity, fakeKeychain } from "./fake-security.js";
import { checkout, failDoctor, fakeExec, HELPER, JOBS, okDoctor, RECONCILER, retired, retiredCalls, shown, WATCHDOG } from "./fixtures.js";

const NODE = "/usr/local/bin/node";
// cli-shim.test.ts covers the shim itself; disabled here so the rest of this
// file's exact command lists are not about a feature they are not testing.
// The owner-class bridge bearer is already set in these fixtures so the
// command lists below stay about plists and compose: an install that has
// none gets one minted, which is its own test at the end of this file.
const base = (P: string) => ({
  productDir: P,
  env: { METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer" } as NodeJS.ProcessEnv,
  platform: "darwin" as const,
  uid: 501,
  node: NODE,
  cliShim: false,
});

describe("metistry up", () => {
  it("--dry-run prints the exact command list and runs nothing (not even doctor)", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const lines: string[] = [];
    let doctorRan = false;
    const r = await up({ ...base(P), exec, out: (l) => lines.push(l), dryRun: true, home: "/h", doctorFn: async (d) => ((doctorRan = true), failDoctor(d)) });

    expect(exec.calls).toEqual([]);
    expect(doctorRan).toBe(false);
    expect(r.code).toBe(0);
    expect(r.source).toBe("git");
    const LA = "/h/Library/LaunchAgents";
    // every plist is written before any of them is bootstrapped — the TCC
    // pin (tcc-pin.ts) runs in between, on whatever `up` just wrote, and
    // before any of it is loaded by launchd
    // …and every one of them is told where the product's seed is, so an
    // overlay default never resolves against a job's working directory
    const write = (label: string) => `write ${LA}/${label}.plist  (from ops/launchd/${label}.plist, __REPO__=${P}, __NODE__=${NODE}, __ENV_FILE__=${join(P, ".env")}, +METISTRY_SEED_DIR)`;
    const bootstrap = (label: string) => [`launchctl bootout gui/501/${label}`, `launchctl bootstrap gui/501 ${LA}/${label}.plist`, `launchctl kickstart -k gui/501/${label}`];
    expect(r.commands).toEqual([`(cd ${P} && docker compose up -d --build)`, ...retired("/h"), ...JOBS.map(write), ...JOBS.flatMap(bootstrap), "metistry doctor"]);
    expect(lines.filter((l) => !l.startsWith("[dry-run]") && !l.startsWith("   "))).toEqual([]);
    expect(existsSync(`${LA}`)).toBe(false);
  });

  it("runs compose, renders + bootstraps every plist with no placeholder left, then doctor decides the exit code", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const exec = fakeExec();
    const r = await up({ ...base(P), exec, out: () => {}, home, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(exec.calls.map(shown)).toEqual([
      "docker compose up -d --build",
      ...retiredCalls(home),
      ...JOBS.flatMap((label) => [
        `launchctl bootout gui/501/${label}`,
        // bootout is asynchronous; bootstrapping before launchd is done gives
        // `Bootstrap failed: 5: Input/output error`
        `launchctl print gui/501/${label}`,
        `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/${label}.plist`,
        `launchctl kickstart -k gui/501/${label}`,
      ]),
    ]);
    expect(exec.calls[0]!.cwd).toBe(P);
    for (const label of JOBS) {
      const text = readFileSync(join(home, "Library", "LaunchAgents", `${label}.plist`), "utf8");
      expect(text, label).not.toMatch(/__[A-Z]+__/);
      expect(text).toContain(`<string>${label}</string>`);
    }
    expect(readFileSync(join(home, "Library", "LaunchAgents", `${WATCHDOG}.plist`), "utf8")).toContain(`set -a; . ${P}/.env; set +a; exec ${NODE} ${P}/apps/watchdog/dist/main.js`);
    expect(readFileSync(join(home, "Library", "LaunchAgents", `${HELPER}.plist`), "utf8")).toContain(`<string>${P}/packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper</string>`);

    // the closing doctor is the verdict
    const r2 = await up({ ...base(P), exec: fakeExec(), out: () => {}, home, doctorFn: failDoctor });
    expect(r2.code).toBe(1);
  });

  it("a failing step stops the plan, still runs doctor for the diagnosis, and keeps the failure's exit code", async () => {
    const P = await checkout();
    const exec = fakeExec({ docker: () => ({ code: 17, stderr: "Cannot connect to the Docker daemon" }) });
    const lines: string[] = [];
    let doctorRan = false;
    const r = await up({ ...base(P), exec, out: (l) => lines.push(l), home: "/h", doctorFn: async (d) => ((doctorRan = true), okDoctor(d)) });
    expect(r.code).toBe(17);
    expect(doctorRan).toBe(true);
    expect(exec.calls.map(shown)).toEqual(["docker compose up -d --build"]); // nothing after the failure
    expect(lines.join("\n")).toContain("metistry up: docker compose exited 17: Cannot connect to the Docker daemon");
  });

  it("a bootout of a job that is not loaded is tolerated; a failed bootstrap is not", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const tolerated = fakeExec({ launchctl: (args) => (args[0] === "bootout" ? { code: 3, stderr: "Boot-out failed: 3: No such process" } : undefined) });
    expect((await up({ ...base(P), exec: tolerated, out: () => {}, home, doctorFn: okDoctor })).code).toBe(0);
    const broken = fakeExec({ launchctl: (args) => (args[0] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : undefined) });
    const r = await up({ ...base(P), exec: broken, out: () => {}, home, doctorFn: okDoctor });
    expect(r.code).toBe(5);
    expect(broken.calls.map(shown)).toEqual([
      "docker compose up -d --build",
      ...retiredCalls(home),
      `launchctl bootout gui/501/${HELPER}`,
      // the poll that waits out launchd's asynchronous teardown
      `launchctl print gui/501/${HELPER}`,
      `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/${HELPER}.plist`,
    ]);
  });

  it("--no-compose and --no-launchd skip their phases", async () => {
    const P = await checkout();
    const a = await up({ ...base(P), exec: fakeExec(), out: () => {}, dryRun: true, home: "/h", compose: false });
    expect(a.commands).toEqual([
      ...retired("/h"),
      ...JOBS.map((l) => expect.stringContaining(`write /h/Library/LaunchAgents/${l}.plist`)),
      ...JOBS.flatMap((l) => [`launchctl bootout gui/501/${l}`, `launchctl bootstrap gui/501 /h/Library/LaunchAgents/${l}.plist`, `launchctl kickstart -k gui/501/${l}`]),
      "metistry doctor",
    ]);
    const b = await up({ ...base(P), exec: fakeExec(), out: () => {}, dryRun: true, home: "/h", launchd: false });
    expect(b.commands).toEqual([`(cd ${P} && docker compose up -d --build)`, "metistry doctor"]);
  });

  it("release mode (the instance lock says source: release) pulls the pinned images and never builds", async () => {
    const P = await checkout();
    const inst = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
    await mkdir(join(inst, ".metistry"), { recursive: true });
    await writeFile(join(inst, ".metistry", "metistry.lock"), serializeLock({ product: { version: "1.0.0", commit: "abc", source: "release" }, updated_at: "2026-09-07T00:00:00.000Z", migrations_applied: [] }));
    const r = await up({ ...base(P), env: { METISTRY_INSTANCE_DIR: inst, METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer" }, exec: fakeExec(), out: () => {}, dryRun: true, home: "/h", launchd: false });
    expect(r.source).toBe("release");
    // compose is told where the instance's .env is: its own `./.env` is not this install's environment
    const ef = join(inst, ".metistry", "state", ".env");
    // …and the secrets policy mirror compose mounts is written first (X-7)
    const mirror = `mirror ${join(inst, ".metistry", "secrets.yaml")} → ${join(inst, ".metistry", "state", "policy", "secrets.yaml")}`;
    // …after the instance's .env is derived (X-124), which a dry run plans and does not write
    expect(r.commands).toEqual([
      expect.stringContaining(`derive ${ef} from .metistry/*.yaml and the login Keychain`),
      mirror,
      `(cd ${P} && docker compose --env-file ${ef} pull)`,
      `(cd ${P} && docker compose --env-file ${ef} up -d --no-build)`,
      "metistry doctor",
    ]);
  });

  it("on Linux prints the systemd user units instead of touching launchd, and writes nothing", async () => {
    const P = await checkout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await up({ ...base(P), platform: "linux", exec, out: (l) => lines.push(l), home, compose: false, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("NOT written");
    expect(text).toContain(`# ~/.config/systemd/user/${WATCHDOG}.service`);
    expect(text).toContain(`EnvironmentFile=${P}/.env`);
    expect(text).toContain(`WorkingDirectory=${P}`);
    expect(text).toContain(`ExecStart=${NODE} ${P}/apps/watchdog/dist/main.js`);
    expect(text).toContain(`ExecStart=${NODE} ${P}/apps/reconciler/dist/main.js`);
    expect(text).toContain("Environment=METISTRY_EK_SOCKET=/tmp/x.sock");
    expect(text).toContain(`ExecStart=${P}/packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper`);
    expect(text).not.toMatch(/__[A-Z]+__/);
    expect(text).toContain(`Description=Metistry reconciler`);
    expect(r.commands).toEqual(["metistry doctor"]);
  });

  it("main: `up --dry-run` wires the flags and exits 0 without executing anything", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const lines: string[] = [];
    expect(await main(["up", "--dry-run", "--no-launchd", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec })).toBe(0);
    expect(exec.calls).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain(`docker compose up -d --build`);
    expect(text).not.toContain("launchctl");
    expect(text).toContain("[dry-run] metistry doctor");
  });

  // The migration, at the verb an existing install actually runs. Without the
  // owner bearer no caller may write a §4.7 protected path at all — including
  // `up`'s own `ensureInstanceId` — so `up` mints one rather than leaving an
  // install to discover the refusal (docs/ops/auth.md).
  it("mints the vault bridge's owner bearer when this install has none, into the Keychain and .env", async () => {
    const P = await checkout();
    const stored: Array<{ service: string; account: string }> = [];
    const exec = fakeExec({
      security: (argv, opts) => {
        const { args } = decodeSecurity(argv, opts);
        const s = args[args.indexOf("-s") + 1]!;
        const a = args[args.indexOf("-a") + 1]!;
        if (args[0] === "add-generic-password") stored.push({ service: s, account: a });
        // `find-generic-password` for an item nothing filed yet
        return args[0] === "find-generic-password" ? { code: 44, stdout: "", stderr: "not found" } : undefined;
      },
    });
    const lines: string[] = [];
    const r = await up({ ...base(P), env: {}, exec, out: (l) => lines.push(l), home: "/h", launchd: false, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    // filed under the Keychain account this install's secrets belong to
    // (secrets.ts's scope table — the person's here, since this fixture has
    // no instance directory and therefore no instance_id yet)
    expect(stored).toEqual([{ service: "metistry:METISTRY_BRIDGE_TOKEN_RECONCILER_USER", account: "metistry" }]);
    // the value is never printed, by this step or any other
    const text = lines.join("\n");
    expect(text).toContain("mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER");
    expect(text).toContain("the bearer that may write .metistry/; never shown");
    expect(readFileSync(join(P, ".env"), "utf8")).toMatch(/^METISTRY_BRIDGE_TOKEN_RECONCILER_USER=\S+$/m);

    // …and an install that already has one spends nothing
    const again = fakeExec();
    await up({ ...base(P), env: { METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "already" }, exec: again, out: () => {}, home: "/h", launchd: false, doctorFn: okDoctor });
    expect(again.calls.map(shown).filter((c) => c.startsWith("security"))).toEqual([]);
  });

  // X-80 (owner ruling 2026-10-04): an install that configures the recorder
  // has its three tokens made by `up`, not by an owner-hand `secrets mint`.
  describe("the recorder's three tokens", () => {
    const RECORDER = ["METISTRY_LIVE_CAPTURE_CONTROL_TOKEN", "METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE", "METISTRY_LIVE_CAPTURE_INBOX_TOKEN"];
    const withKeychain = () => {
      const kc = fakeKeychain();
      return { kc, exec: fakeExec({ security: (argv, opts) => kc.exec("security", argv, opts) }) };
    };
    const ownerTokens = () => {
      const rows: Array<{ token_hash: string; label: string }> = [];
      let opened = 0;
      const openSession = async () => {
        opened++;
        return {
          query: async (text: string, values: unknown[] = []) => {
            if (text.startsWith("SELECT")) return { rows: rows.filter((r) => r.token_hash === values[0]) };
            rows.push({ token_hash: values[0] as string, label: values[1] as string });
            return { rows: [] };
          },
          end: async () => {},
        };
      };
      return { rows, openSession, opened: () => opened };
    };
    const run = (P: string, exec: ReturnType<typeof fakeExec>, env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) =>
      up({ ...base(P), env, exec, out: () => {}, home: "/h", compose: false, launchd: false, doctorFn: okDoctor, ...extra });

    it("**with the recorder configured and no token, mints all three; a second `up` keeps them**", async () => {
      const P = await checkout();
      const { kc, exec } = withKeychain();
      const db = ownerTokens();
      const env = { METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer", METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815" };
      const lines: string[] = [];
      const first = await up({ ...base(P), env: { ...env }, exec, out: (l) => lines.push(l), home: "/h", compose: false, launchd: false, doctorFn: okDoctor, openSession: db.openSession });
      expect(first.code).toBe(0);

      // the Keychain item the bar reads, and the .env the bridge is started with
      const held = RECORDER.map((n) => kc.store.get(`metistry/metistry:${n}`));
      for (const v of held) expect(v).toBeTruthy();
      expect(new Set(held).size).toBe(3);
      const dotenv = readFileSync(join(P, ".env"), "utf8");
      RECORDER.forEach((n, i) => expect(dotenv).toContain(`${n}=${held[i]}`));
      // the inbox token is a capture owner token labelled live-capture, by hash
      expect(db.rows).toEqual([{ token_hash: tokenHash(held[2]!), label: "live-capture" }]);
      // names only
      for (const v of held) {
        expect(lines.join("\n")).not.toContain(v!);
        for (const c of kc.calls) for (const a of c.argv) expect(a).not.toContain(v!);
      }
      expect(lines.join("\n")).toContain("recorder tokens minted: METISTRY_LIVE_CAPTURE_CONTROL_TOKEN, METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE, METISTRY_LIVE_CAPTURE_INBOX_TOKEN");

      // a second `up` — the CLI would load the .env it just wrote — keeps all three
      const before = new Map(kc.store);
      kc.calls.length = 0;
      const second = await up({ ...base(P), env: { ...env }, exec, out: () => {}, home: "/h", compose: false, launchd: false, doctorFn: okDoctor, openSession: db.openSession, mintRecorderToken: () => "MUST-NOT-BE-USED" });
      expect(second.code).toBe(0);
      expect(kc.calls.filter((c) => c.args[0] === "add-generic-password")).toEqual([]);
      expect(kc.store).toEqual(before);
      expect(readFileSync(join(P, ".env"), "utf8")).toBe(dotenv);
      expect(db.rows).toHaveLength(1); // recorded once; the second `up` finds the row
    });

    it("**without the recorder configured, mints nothing — no Keychain call, no .env line, no database**", async () => {
      const P = await checkout();
      const { kc, exec } = withKeychain();
      const db = ownerTokens();
      const r = await up({ ...base(P), exec, out: () => {}, home: "/h", compose: false, launchd: false, doctorFn: okDoctor, openSession: db.openSession });
      expect(r.code).toBe(0);
      expect(kc.calls).toEqual([]);
      expect(db.opened()).toBe(0);
      const dotenv = existsSync(join(P, ".env")) ? readFileSync(join(P, ".env"), "utf8") : "";
      for (const n of RECORDER) expect(dotenv).not.toContain(n);
    });

    it("--dry-run makes and records nothing, and says what it would do", async () => {
      const P = await checkout();
      const { kc, exec } = withKeychain();
      const db = ownerTokens();
      const lines: string[] = [];
      const r = await up({ ...base(P), env: { METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer", METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815" }, exec, out: (l) => lines.push(l), home: "/h", compose: false, launchd: false, dryRun: true, openSession: db.openSession });
      expect(r.code).toBe(0);
      expect(kc.calls).toEqual([]);
      expect(db.opened()).toBe(0);
      expect(lines.join("\n")).toContain("recorder's control, bridge and inbox tokens");
    });

    it("an owner-pasted bridge token is adopted, not replaced", async () => {
      const P = await checkout();
      await writeFile(join(P, ".env"), "METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE=owner-pasted\n");
      const { kc, exec } = withKeychain();
      const r = await run(P, exec, { METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer", METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815", METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE: "owner-pasted" }, { openSession: ownerTokens().openSession });
      expect(r.code).toBe(0);
      expect(kc.store.get("metistry/metistry:METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE")).toBe("owner-pasted");
      expect(readFileSync(join(P, ".env"), "utf8")).toContain("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE=owner-pasted\n");
    });

    it("a database that is not up yet leaves the inbox token minted and says `up` records it", async () => {
      const P = await checkout();
      const { exec } = withKeychain();
      const lines: string[] = [];
      const r = await up({ ...base(P), env: { METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer", METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815" }, exec, out: (l) => lines.push(l), home: "/h", compose: false, launchd: false, doctorFn: okDoctor, openSession: async () => null });
      expect(r.code).toBe(0);
      expect(lines.join("\n")).toContain("not yet recorded as an owner token");
      expect(readFileSync(join(P, ".env"), "utf8")).toContain("METISTRY_LIVE_CAPTURE_INBOX_TOKEN=");
    });
  });

  it("the closing doctor gets the same env and exec the plan ran with", async () => {
    const P = await checkout();
    const exec = fakeExec();
    const env = { METISTRY_CONSOLE_URL: "http://127.0.0.1:9999" };
    let seen: { env?: NodeJS.ProcessEnv; exec?: unknown } = {};
    const r = await up({ ...base(P), env, exec, out: () => {}, home: "/h", compose: false, launchd: false, doctorFn: async (d) => ((seen = { env: d.env, exec: d.exec }), okDoctor(d)) });
    expect(r.code).toBe(0);
    expect(seen.env).toBe(env);
    expect(seen.exec).toBe(exec);
    expect(RECONCILER.startsWith("com.foldedspacelabs.metistry.")).toBe(true);
  });
});
