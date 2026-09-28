// The TCC helper pin (tcc-pin.ts): a release install carries no built
// Developer-ID-signed EventKit/Apple-FM helper bundles (`pack-runtime.sh`
// copies the sources, not the gitignored `.app` build output), so both
// `up` and `migrate-shape` pin the two bridge jobs at the bundles that
// already hold the TCC grant, on a sibling checkout.
//
// Moved here from migrate-shape.test.ts (which exercised the pin only
// through `migrate-shape`'s own call to it) once `up` started applying the
// SAME pin on every run — see up.ts's `installLaunchd` and the bug this
// fixes: a plain `metistry up` after `migrate-shape launchd` used to
// re-render the calendar plist and rewrite `supervisor.json` WITHOUT the
// pin, silently un-pinning both bridges.
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SetShapeOptions, SetShapeResult } from "../src/deployment-report.js";
import { migrateShape, TABLE_LIST_SQL, tableCountsSql, type MigrateShapeOptions } from "../src/migrate-shape.js";
import { buildScriptFor, TCC_HELPERS } from "../src/tcc-pin.js";
import { up, type UpOptions, type UpResult } from "../src/up.js";
import { checkout, fakeExec, okDoctor, shown } from "./fixtures.js";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const PG = "/opt/homebrew/opt/postgresql@17/bin";
const NODE = "/usr/local/bin/node";

/** A product tree carrying the real plists and the real sandbox profile — the thing preflight looks for. */
async function productTree(opts: { sandbox?: boolean } = {}): Promise<string> {
  const P = await checkout();
  await cp(join(REPO, "ops", "launchd"), join(P, "ops", "launchd"), { recursive: true });
  if (opts.sandbox !== false) await cp(join(REPO, "ops", "sandbox"), join(P, "ops", "sandbox"), { recursive: true });
  return P;
}

/**
 * A RELEASE install, which is what production is: the install root carries
 * the hand-built signed helper bundles (and `runtime/`), while `current` ->
 * `releases/<v>` is the product tree the plists are rendered against — and
 * it carries no `.app` at all, because no release pack does. This is the
 * layout the TCC pin exists for.
 */
async function releaseTree(): Promise<{ P: string; runDir: string }> {
  const P = await checkout();
  const rel = join(P, "releases", "0.5.1");
  await cp(join(REPO, "ops", "launchd"), join(rel, "ops", "launchd"), { recursive: true });
  await cp(join(REPO, "ops", "sandbox"), join(rel, "ops", "sandbox"), { recursive: true });
  await symlink(rel, join(P, "current"));
  return { P, runDir: join(P, "current") };
}

async function instance(opts: { release?: boolean } = {}): Promise<string> {
  const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
  await mkdir(join(I, ".metistry", "state"), { recursive: true });
  await mkdir(join(I, ".metistry"), { recursive: true });
    await writeFile(join(I, ".metistry", "state", ".env"), "METISTRY_ORIGIN=https://studio.ts.net\n");
  // what `up` leaves behind under the launchd shape: the supervisor's child
  // list. The apple-fm bridge is a CHILD now, so its TCC-helper override goes
  // here rather than into a plist of its own.
  await mkdir(join(I, ".metistry"), { recursive: true });
  await writeFile(
      join(I, ".metistry", "state", "supervisor.json"),
    JSON.stringify(
      {
        schema: 1,
        label: "com.foldedspacelabs.metistry",
        socket: join(I, ".metistry", "state", "run", "supervisor.sock"),
        token: "0".repeat(64),
        env: {},
        children: [
          { name: "console", argv: ["/n", "/c.js"], log: "/tmp/metistry-console.log" },
          { name: "apple-fm", argv: ["/n", "/a.js"], log: "/tmp/metistry-apple-fm.log" },
        ],
      },
      null,
      2,
    ),
  );
  if (opts.release) {
    await mkdir(join(I, ".metistry"), { recursive: true });
  await writeFile(
      join(I, ".metistry", "metistry.lock"),
      'product:\n  version: "0.5.1"\n  commit: "abc"\n  source: release\nupdated_at: "2026-09-10T00:00:00.000Z"\nmigrations_applied: []\n',
    );
  }
  return I;
}

const env = (I: string): NodeJS.ProcessEnv => ({
  METISTRY_INSTANCE_DIR: I,
  METISTRY_DB_PASSWORD: "pw",
  METISTRY_ORIGIN: "https://studio.ts.net",
  // both bridges configured: without a URL an install HAS no calendar bridge
  // and neither its helper agent nor its child is installed at all
  METISTRY_EK_URL: "http://127.0.0.1:7811",
  METISTRY_AFM_URL: "http://127.0.0.1:7810",
  HOME: "/h",
  TMPDIR: "/tmp",
});

/**
 * Everything the launchd shape needs is installed: the bundled node, the
 * Postgres toolchain, pgvector — plus whatever the synthetic product tree
 * really has on disk, so the `ops/sandbox/assistant.sb` and helper-bundle
 * probes are answered by the actual tree rather than by a second fixture
 * that could disagree with it.
 */
const ready = (P: string, extra: string[] = []) => {
  const set = new Set([join(P, "runtime", "node", "bin", "node"), join(PG, "..", "share", "extension", "vector.control"), ...extra]);
  return (p: string) => p.startsWith(PG) || set.has(p) || existsSync(p);
};

const okUp = async (o: UpOptions): Promise<UpResult> => ({ code: 0, source: "release", commands: [`up(${o.deployment?.shape})`] });
const okSetShape = async (o: SetShapeOptions): Promise<SetShapeResult> => ({
  shape: o.targetShape,
  applied: true,
  refused: false,
  detail: `deployment.yaml written through the reconciler as user → ${o.targetShape}`,
});

/** What the source database reports: three tables, and their counts. */
const TABLES = "runs\nwork\nschema_migrations\n";
const COUNTS = "runs=6730\nschema_migrations=13\nwork=66\n";
const COUNTS_SQL = tableCountsSql(["runs", "work", "schema_migrations"]);

function run(overrides: Partial<MigrateShapeOptions> & { productDir: string; env: NodeJS.ProcessEnv }): Promise<ReturnType<typeof migrateShape>> {
  return migrateShape({
    target: "launchd",
    out: () => {},
    platform: "darwin",
    uid: 501,
    home: "/h",
    now: () => new Date("2026-09-10T16:04:03.123Z"),
    upFn: okUp,
    setShapeFn: okSetShape,
    doctorFn: okDoctor,
    fetchFn: (async () => new Response("ok")) as typeof fetch,
    sleep: async () => {},
    ...overrides,
  }) as Promise<ReturnType<typeof migrateShape>>;
}

/** A fake that answers the stdout-reading probes: `compose ps -q db`, the table list, and the two count queries. */
const liveCompose = (after = COUNTS) =>
  fakeExec({
    docker: (args) => {
      if (args.includes("ps")) return { stdout: "abc123\n" };
      if (args.includes(TABLE_LIST_SQL)) return { stdout: TABLES };
      if (args.includes(COUNTS_SQL)) return { stdout: COUNTS };
      return {};
    },
    [`${PG}/pg_restore`]: (args) => (args[0] === "--list" ? { stdout: ";\n; Archive created\n;\n245; 1259 31365 TABLE public runs metistry\n246; 1259 31366 TABLE public work metistry\n" } : {}),
    [`${PG}/psql`]: () => ({ stdout: after }),
  });

describe("the TCC helper bundles — a release install carries none", () => {
  it("pins both bridge jobs at the signed bundles on the host, two different ways (via migrate-shape)", async () => {
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const bundles = TCC_HELPERS.map((h) => join(P, h.bundle, h.exe));
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P, bundles), out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    const text = r.commands.join("\n");
    // the eventkit helper IS the job's root process (that is what the TCC
    // grant attaches to), so its plist is re-rendered against the tree that
    // actually holds the bundle
    expect(text).toContain(
      `write /h/Library/LaunchAgents/com.foldedspacelabs.metistry.calendar.plist  (from the plist up wrote, with ` +
        `${join(P, "current", "packages", "mcp-eventkit", "helper", "ek-helper.app")} → ${join(P, "packages", "mcp-eventkit", "helper", "ek-helper.app")}`,
    );
    // apple-fm's node bridge spawns its helper from a path relative to its
    // own dist/, so it gets the documented override variable instead — and
    // under the supervisor it is a child, so the entry goes into the config
    expect(text).toContain(`plus apple-fm's METISTRY_AFM_HELPER=${join(P, "packages", "mcp-apple-fm", "helper", "afm-helper.app", "Contents", "MacOS", "afm-helper")}`);
    expect(text).toContain("launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.calendar");
    expect(text).toContain("launchctl kickstart -k gui/501/com.foldedspacelabs.metistry");
    expect(lines.join("\n")).toMatch(/same bundle id \+ certificate chain = same designated requirement, so no re-grant/);
  });

  it("waits for the boots-out to finish before bootstrapping the pinned jobs (via migrate-shape)", async () => {
    // `bootout` is asynchronous: bootstrapping the same label straight after
    // races launchd and fails `Bootstrap failed: 5: Input/output error`
    // (#117's fourth defect — reproduced here once, by hand-rolling the three
    // commands instead of reusing `up`'s sequence)
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const bundles = TCC_HELPERS.map((h) => join(P, h.bundle, h.exe));
    const exec = liveCompose();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const r = await run({ productDir: P, env: { ...env(I), HOME: home }, exec, home, exists: ready(P, bundles) });
    expect(r.code).toBe(0);
    // only the EventKit helper is an agent now; apple-fm is a supervisor child
    for (const s of ["calendar"]) {
      const label = `com.foldedspacelabs.metistry.${s}`;
      const seq = exec.calls.filter((c) => c.cmd === "launchctl" && c.args.some((a) => a.endsWith(label) || a.endsWith(`${label}.plist`))).map(shown);
      expect(seq).toEqual([
        `launchctl bootout gui/501/${label}`,
        `launchctl print gui/501/${label}`, // the wait — not a plan step, but it must happen
        `launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/${label}.plist`,
        `launchctl kickstart -k gui/501/${label}`,
      ]);
    }
  });

  it("a missing helper is a note, not a failed migration — an install with no calendar bridge is healthy (via migrate-shape)", async () => {
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const lines: string[] = [];
    // nothing built anywhere: neither the release nor the install root has one
    const noBundles = (p: string) => (p.includes("-helper.app") ? false : ready(P)(p));
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: noBundles, out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/no signed helper at .*ek-helper\.app/);
    expect(lines.join("\n")).toMatch(/doctor reports the bridge absent until then/);
    expect(r.commands.some((c) => c.includes("calendar.plist"))).toBe(false);
  });

  it("a checkout install, whose product tree DOES hold the bundles, is not pinned at all (via migrate-shape)", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/ek-helper.*is in this release — no pin needed/);
    expect(r.commands.some((c) => c.includes("calendar.plist"))).toBe(false);
  });
});

describe("the TCC helper bundles — `up` re-pins on every run, not just migrate-shape", () => {
  /** `up`'s own env: a launchd-shape install with both bridges configured. */
  const upEnv = (I: string): NodeJS.ProcessEnv => ({
    METISTRY_INSTANCE_DIR: I,
    METISTRY_DB_PASSWORD: "pw",
    METISTRY_ORIGIN: "https://studio.ts.net",
    METISTRY_EK_URL: "http://127.0.0.1:7811",
    METISTRY_AFM_URL: "http://127.0.0.1:7810",
    HOME: "/h",
    TMPDIR: "/tmp",
  });
  const pgReady = (P: string, extra: string[] = []) => {
    const set = new Set([join(P, "runtime", "node", "bin", "node"), join(PG, "..", "share", "extension", "vector.control"), ...extra]);
    return (p: string) => p.startsWith(PG) || set.has(p) || existsSync(p);
  };
  const launchd = { shape: "launchd" as const, services: {} };

  it("a plain `up` on a release tree with no bundled helper pins the calendar plist and supervisor.json's apple-fm child, without a second kickstart", async () => {
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const bundles = TCC_HELPERS.map((h) => join(P, h.bundle, h.exe));
    const exec = fakeExec();
    const r = await up({
      productDir: P,
      env: { ...upEnv(I), HOME: home },
      exec,
      out: () => {},
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: launchd,
      exists: pgReady(P, bundles),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);

    // the calendar plist points at the SIBLING checkout's bundle, not the
    // release's (which has none)
    const calendar = await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.calendar.plist"), "utf8");
    expect(calendar).toContain(`<string>${join(P, "packages", "mcp-eventkit", "helper", "ek-helper.app", "Contents", "MacOS", "ek-helper")}</string>`);
    expect(calendar).not.toContain(join(P, "current", "packages", "mcp-eventkit"));

    // apple-fm is a supervisor child; its override lives in supervisor.json
    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    const child = config.children.find((c: { name: string }) => c.name === "apple-fm");
    expect(child.env.METISTRY_AFM_HELPER).toBe(join(P, "packages", "mcp-apple-fm", "helper", "afm-helper.app", "Contents", "MacOS", "afm-helper"));

    // ONE bootstrap sequence per agent, not two: the pin ran before either
    // job was loaded, so there is no extra kickstart correcting a wrong value
    const calls = exec.calls.map(shown);
    const supKickstarts = calls.filter((c) => c === "launchctl kickstart -k gui/501/com.foldedspacelabs.metistry");
    const calKickstarts = calls.filter((c) => c === "launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.calendar");
    expect(supKickstarts.length).toBe(1);
    expect(calKickstarts.length).toBe(1);
  });

  it("the recorder (T8-2b) is pinned like the calendar — its own agent, its root process the signed lc-helper — once live capture is configured", async () => {
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const bundles = TCC_HELPERS.map((h) => join(P, h.bundle, h.exe));
    const exec = fakeExec();
    const r = await up({
      productDir: P,
      env: { ...upEnv(I), METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815", HOME: home },
      exec,
      out: () => {},
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: launchd,
      exists: pgReady(P, bundles),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    const recorder = await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.recorder.plist"), "utf8");
    const helper = join(P, "packages", "mcp-live-capture", "helper", "lc-helper.app", "Contents", "MacOS", "lc-helper");
    // the ONE program argument is the signed helper in the tree that holds it — nothing in front of it
    expect(recorder).toMatch(new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*<string>${helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>\\s*</array>`));
    expect(recorder).not.toContain(join(P, "current", "packages", "mcp-live-capture"));
    // where it writes sessions comes from the instance `up` knows, not a path of its own
    expect(recorder).toContain(`<key>METISTRY_INSTANCE_DIR</key><string>${I}</string>`);
    expect(recorder).toContain("<key>METISTRY_LC_SOCKET</key><string>/tmp/metistry-live-capture.sock</string>");
    // and its bridge is a supervisor child beside the other bridges
    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    expect(config.children.map((c: { name: string }) => c.name)).toContain("live-capture");
    const calls = exec.calls.map(shown);
    expect(calls.filter((c) => c === "launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.recorder")).toHaveLength(1);
  });

  it("without METISTRY_LIVE_CAPTURE_URL there is no recorder and no live-capture child — an install that never asked for a microphone gets none", async () => {
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const exec = fakeExec();
    const r = await up({ productDir: P, env: { ...upEnv(I), HOME: home }, exec, out: () => {}, platform: "darwin", uid: 501, home, node: NODE, deployment: launchd, exists: pgReady(P, TCC_HELPERS.map((h) => join(P, h.bundle, h.exe))), mintPassword: () => "generated", doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.recorder.plist"))).toBe(false);
    expect(exec.calls.map(shown).some((c) => c.includes("metistry.recorder"))).toBe(false);
    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    expect(config.children.map((c: { name: string }) => c.name)).not.toContain("live-capture");
  });

  it("a missing recorder bundle names ITS build script, not another helper's", () => {
    expect(TCC_HELPERS.map((h) => [h.service, buildScriptFor(h)])).toEqual([
      ["calendar", "packages/mcp-eventkit/scripts/build-helper.sh"],
      ["apple-fm", "packages/mcp-apple-fm/scripts/build-helper.sh"],
      ["recorder", "packages/mcp-live-capture/scripts/build-helper.sh"],
    ]);
  });

  it("a plain `up` on a tree that DOES ship the helper leaves it alone", async () => {
    const P = await productTree();
    const I = await instance();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const lines: string[] = [];
    const exec = fakeExec();
    const r = await up({
      productDir: P,
      env: { ...upEnv(I), HOME: home },
      exec,
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: launchd,
      exists: pgReady(P),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/ek-helper.*is in this release — no pin needed/);

    const calendar = await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.calendar.plist"), "utf8");
    // rendered from the template as `up` always renders it — __REPO__ is the
    // tree itself, not patched to point anywhere else
    expect(calendar).toContain(`<string>${join(P, "packages", "mcp-eventkit", "helper", "ek-helper.app", "Contents", "MacOS", "ek-helper")}</string>`);
  });
});
