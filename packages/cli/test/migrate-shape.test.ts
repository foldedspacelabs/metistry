// `metistry migrate-shape` — the one verb that moves a live install between
// the two deployment shapes with its data. What is asserted here is the
// ORDER (a dump that is verified before anything is stopped, a restore
// before any migration runs) and the REFUSALS (a product tree that cannot
// run the launchd shape must be caught while the old shape is still up),
// because both are the difference between a rehearsed cutover and an
// outage. `up` and `setDeploymentShape` are injected: they have their own
// suites, and what matters here is that this plan calls them, in this
// order, with these arguments.
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SetShapeOptions, SetShapeResult } from "../src/deployment-report.js";
import { formatCommand } from "../src/exec.js";
import {
  countDiff,
  migrateShape,
  parseCounts,
  stamp,
  TABLE_COUNTS_SQL,
  TCC_HELPERS,
  tocEntryCount,
  type MigrateShapeOptions,
} from "../src/migrate-shape.js";
import type { UpOptions, UpResult } from "../src/up.js";
import { checkout, fakeExec, okDoctor } from "./fixtures.js";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const NOW = () => new Date("2026-09-10T16:04:03.123Z");
const TS = "20260910T160403Z";
const PG = "/opt/homebrew/opt/postgresql@17/bin";

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
  const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
  await mkdir(join(I, "state"), { recursive: true });
  await writeFile(join(I, "state", ".env"), "METISTRY_ORIGIN=https://studio.ts.net\n");
  if (opts.release) {
    await writeFile(
      join(I, "metistry.lock"),
      'product:\n  version: "0.5.1"\n  commit: "abc"\n  source: release\nupdated_at: "2026-09-10T00:00:00.000Z"\nmigrations_applied: []\n',
    );
  }
  return I;
}

const env = (I: string): NodeJS.ProcessEnv => ({
  METISTRY_INSTANCE_DIR: I,
  METISTRY_DB_PASSWORD: "pw",
  METISTRY_ORIGIN: "https://studio.ts.net",
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

/** The counts psql/`docker compose exec` hand back — the same both times unless a test says otherwise. */
const COUNTS = "runs=6730\nwork=66\nschema_migrations=13\n";

function run(overrides: Partial<MigrateShapeOptions> & { productDir: string; env: NodeJS.ProcessEnv }): Promise<ReturnType<typeof migrateShape>> {
  return migrateShape({
    target: "launchd",
    out: () => {},
    platform: "darwin",
    uid: 501,
    home: "/h",
    now: NOW,
    upFn: okUp,
    setShapeFn: okSetShape,
    doctorFn: okDoctor,
    ...overrides,
  }) as Promise<ReturnType<typeof migrateShape>>;
}

/** A fake that answers the two stdout-reading probes: `compose ps -q db` and the row counts. */
const liveCompose = (counts = COUNTS) =>
  fakeExec({
    docker: (args) => {
      if (args.includes("ps")) return { stdout: "abc123\n" };
      if (args.includes("psql")) return { stdout: counts };
      return {};
    },
    [`${PG}/pg_restore`]: (args) => (args[0] === "--list" ? { stdout: ";\n; Archive created\n;\n245; 1259 31365 TABLE public runs metistry\n246; 1259 31366 TABLE public work metistry\n" } : {}),
    [`${PG}/psql`]: () => ({ stdout: counts }),
  });

describe("helpers", () => {
  it("stamps a dump name that sorts and needs no quoting", () => {
    expect(stamp(NOW())).toBe(TS);
  });

  it("counts only the TOC entry lines, not the header comments", () => {
    expect(tocEntryCount(";\n; Archive created at …\n;\n2; 3079 16393 EXTENSION - vector \n245; 1259 31365 TABLE public agents metistry\n")).toBe(2);
    expect(tocEntryCount(";\n; nothing here\n")).toBe(0);
  });

  it("reports a count difference per table rather than as two walls of text", () => {
    const before = parseCounts("runs=6730\nwork=66\n");
    expect(countDiff(before, parseCounts("runs=6730\nwork=66\n"))).toEqual([]);
    expect(countDiff(before, parseCounts("runs=6729\nwork=66\n"))).toEqual(["runs: 6730 → 6729"]);
    expect(countDiff(before, parseCounts("runs=6730\n"))).toEqual(["work: 66 → (absent)"]);
  });

  it("counts rows exactly — an estimate would not prove a restore", () => {
    expect(TABLE_COUNTS_SQL).toContain("count(*)");
    expect(TABLE_COUNTS_SQL).not.toContain("n_live_tup");
  });
});

describe("metistry migrate-shape launchd --dry-run", () => {
  it("plans dump → verify → stop → shape → up → restore → compare → tcc → restart → doctor, in that order", async () => {
    const P = await productTree();
    const I = await instance();
    const exec = liveCompose();
    const r = await run({ productDir: P, env: env(I), exec, dryRun: true, exists: ready(P) });

    expect(r.code).toBe(0);
    expect(exec.calls).toEqual([]); // a dry run runs nothing at all
    const dump = `${I}/state/migrate/${TS}.dump`;
    const dc = (args: string[]) => formatCommand("docker", ["compose", "--env-file", `${I}/state/.env`, ...args], P);
    const conn = ["-h", `${I}/state/run`, "-p", "5432", "-U", "metistry", "-d", "metistry"];
    expect(r.commands).toEqual([
      dc(["ps", "-q", "db"]),
      dc(["exec", "-T", "db", "psql", "-U", "metistry", "-d", "metistry", "-tA", "--no-psqlrc", "-c", TABLE_COUNTS_SQL]),
      dc(["exec", "-T", "db", "pg_dump", "-U", "metistry", "-d", "metistry", "--format=custom", "--compress=6", "--file", `/tmp/metistry-migrate-${TS}.dump`]),
      `mkdir -p ${I}/state/migrate`,
      dc(["cp", `db:/tmp/metistry-migrate-${TS}.dump`, dump]),
      dc(["exec", "-T", "db", "rm", "-f", `/tmp/metistry-migrate-${TS}.dump`]),
      `${PG}/pg_restore --list ${dump}`,
      dc(["stop", "db", "console", "assistant"]),
      "deployment set-shape launchd (deployment.yaml written through the reconciler as user → launchd)",
      "up(launchd)",
      formatCommand(`${PG}/pg_restore`, [...conn, "--no-owner", "--no-privileges", "--exit-on-error", dump]),
      formatCommand(`${PG}/psql`, [...conn, "-tA", "--no-psqlrc", "-c", TABLE_COUNTS_SQL]),
      "launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.console",
      "launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.assistant",
      "metistry doctor",
    ]);
  });

  it("the dump is verified BEFORE the compose services are stopped", async () => {
    const P = await productTree();
    const I = await instance();
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P) });
    const verify = r.commands.findIndex((c) => c.includes("pg_restore --list"));
    const stop = r.commands.findIndex((c) => c.includes("compose --env-file") && c.includes(" stop "));
    expect(verify).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(verify);
  });

  it("the restore happens after `up` and before anything could migrate", async () => {
    const P = await productTree();
    const I = await instance();
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P) });
    expect(r.commands.indexOf("up(launchd)")).toBeLessThan(r.commands.findIndex((c) => c.includes("pg_restore -h")));
    // nothing in this plan runs a migration: the dump carries schema_migrations
    expect(r.commands.some((c) => c.includes("migrate"))).toBe(true); // the dump path only
    expect(r.commands.some((c) => /\bmetistry update\b/.test(c))).toBe(false);
  });

  it("leaves the containers and the volume alone — `stop`, never `down -v`", async () => {
    const P = await productTree();
    const I = await instance();
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P) });
    expect(r.commands.some((c) => c.includes("down"))).toBe(false);
    expect(r.commands.some((c) => c.includes("-v"))).toBe(false);
    expect(r.commands.some((c) => c.includes("docker volume"))).toBe(false);
  });

  it("never puts a password in an argv", async () => {
    const P = await productTree();
    const I = await instance();
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P) });
    expect(r.commands.join("\n")).not.toContain("pw");
  });
});

describe("refusals — every one of them while the old shape is still up", () => {
  it("refuses a release whose pack has no ops/sandbox: the assistant job could not start", async () => {
    const P = await productTree({ sandbox: false });
    const I = await instance();
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/predates the launchd-shape fixes \(PR #117\)/);
    expect(lines.join("\n")).toMatch(/up to and including v0\.5\.0/);
    expect(r.commands).toEqual([]); // nothing ran
  });

  it("refuses an install with no bundled runtime rather than downloading one mid-migration", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: (p) => p.startsWith(PG), out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/has no node .* no bundled runtime/s);
    expect(r.commands).toEqual([]);
  });

  it("refuses when the toolchain has no pg_dump/pg_restore", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const missing = new Set([join(PG, "pg_dump"), join(PG, "pg_restore")]);
    const r = await run({
      productDir: P,
      env: env(I),
      exec: liveCompose(),
      dryRun: true,
      exists: (p) => (missing.has(p) ? false : ready(P)(p)),
      out: (l) => lines.push(l),
    });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/has no pg_dump, pg_restore/);
  });

  it("refuses on a platform that has no launchd", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P), platform: "linux", out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/macOS only/);
  });

  it("refuses without an instance directory — deployment.yaml and state/ both live there", async () => {
    const P = await productTree();
    const lines: string[] = [];
    const r = await run({ productDir: P, env: { HOME: "/h" }, exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/needs the instance repo/);
  });

  it("refuses to migrate to the shape it is already in", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(join(P, "seed", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/already shape: launchd/);
  });

  it("refuses a namespaced instance whose compose project is not namespaced — it would stop another install's containers", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(
      join(I, "state", "ports.yaml"),
      'schema: 1\ninstance_id: "e5dbfa9c-0000-4000-8000-000000000000"\nlabel_suffix: "e5dbfa9c"\nbase: 8460\nports:\n  console: 8460\n  db: 8461\n  reconciler: 8462\n  eventkit: 8463\n  apple-fm: 8464\n',
    );
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/would stop ANOTHER install's containers/);
    expect(lines.join("\n")).toMatch(/Set COMPOSE_PROJECT_NAME/);
    expect(r.commands).toEqual([]);
  });

  it("a namespaced instance WITH its own compose project passes -p on every docker call", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(
      join(I, "state", "ports.yaml"),
      'schema: 1\ninstance_id: "e5dbfa9c-0000-4000-8000-000000000000"\nlabel_suffix: "e5dbfa9c"\nbase: 8460\nports:\n  console: 8460\n  db: 8461\n  reconciler: 8462\n  eventkit: 8463\n  apple-fm: 8464\n',
    );
    const r = await run({
      productDir: P,
      env: { ...env(I), COMPOSE_PROJECT_NAME: "metistry-rehearsal" },
      exec: liveCompose(),
      dryRun: true,
      exists: ready(P),
    });
    expect(r.code).toBe(0);
    const docker = r.commands.filter((c) => c.includes("docker compose"));
    expect(docker.length).toBeGreaterThan(0);
    for (const c of docker) expect(c).toContain("docker compose -p metistry-rehearsal");
    // and the launchd side stays in the instance's own namespace
    expect(r.commands).toContain("launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.e5dbfa9c.console");
  });

  it("refuses when there is no running db container to dump from", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({
      productDir: P,
      env: env(I),
      exec: fakeExec({ docker: (args) => (args.includes("ps") ? { stdout: "" } : {}) }),
      exists: ready(P),
      out: (l) => lines.push(l),
    });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/no running compose `db` container/);
    // it stopped at the probe: nothing was dumped and nothing was stopped
    expect(r.commands.some((c) => c.includes("pg_dump"))).toBe(false);
    expect(r.commands.some((c) => c.includes(" stop "))).toBe(false);
  });
});

describe("the restore is checked, not assumed", () => {
  it("fails — and says which table — when a row count does not survive the move", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    let call = 0;
    const exec = fakeExec({
      docker: (args) => {
        if (args.includes("ps")) return { stdout: "abc123\n" };
        if (args.includes("psql")) return { stdout: COUNTS };
        return {};
      },
      [`${PG}/pg_restore`]: (args) => (args[0] === "--list" ? { stdout: "245; 1259 31365 TABLE public runs metistry\n" } : {}),
      [`${PG}/psql`]: () => {
        call++;
        return { stdout: "runs=6729\nwork=66\nschema_migrations=13\n" };
      },
    });
    const r = await run({ productDir: P, env: env(I), exec, exists: ready(P), out: (l) => lines.push(l) });
    expect(call).toBe(1);
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/runs: 6730 → 6729/);
    expect(lines.join("\n")).toMatch(/roll back with `metistry migrate-shape compose`/);
  });

  it("refuses to stop a healthy install behind a dump pg_restore cannot read", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const exec = fakeExec({
      docker: (args) => (args.includes("ps") ? { stdout: "abc123\n" } : args.includes("psql") ? { stdout: COUNTS } : {}),
      [`${PG}/pg_restore`]: () => ({ stdout: ";\n; not an archive\n" }),
    });
    const r = await run({ productDir: P, env: env(I), exec, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/no restorable entries/);
    expect(r.commands.some((c) => c.includes(" stop "))).toBe(false);
  });
});

describe("the TCC helper bundles — a release install carries none", () => {
  it("pins both bridge jobs at the signed bundles on the host, two different ways", async () => {
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
    expect(text).toContain(`write /h/Library/LaunchAgents/com.foldedspacelabs.metistry.eventkit-helper.plist  (from ops/launchd/com.foldedspacelabs.metistry.eventkit-helper.plist, __REPO__=${P}`);
    // apple-fm's node bridge spawns its helper from a path relative to its
    // own dist/, so it gets the documented override variable instead
    expect(text).toContain(`METISTRY_AFM_HELPER=${join(P, "packages", "mcp-apple-fm", "helper", "afm-helper.app", "Contents", "MacOS", "afm-helper")}`);
    expect(text).toContain("launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.eventkit-helper");
    expect(text).toContain("launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.apple-fm");
    expect(lines.join("\n")).toMatch(/same bundle id \+ certificate chain = same designated requirement, so no re-grant/);
  });

  it("a missing helper is a note, not a failed migration — an install with no calendar bridge is healthy", async () => {
    const { P } = await releaseTree();
    const I = await instance({ release: true });
    const lines: string[] = [];
    // nothing built anywhere: neither the release nor the install root has one
    const noBundles = (p: string) => (p.includes("-helper.app") ? false : ready(P)(p));
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: noBundles, out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/no signed helper at .*ek-helper\.app/);
    expect(lines.join("\n")).toMatch(/doctor reports the bridge absent until then/);
    expect(r.commands.some((c) => c.includes("eventkit-helper.plist"))).toBe(false);
  });

  it("a checkout install, whose product tree DOES hold the bundles, is not pinned at all", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/ek-helper.*is in this release — no pin needed/);
    expect(r.commands.some((c) => c.includes("eventkit-helper.plist"))).toBe(false);
  });
});

describe("metistry migrate-shape compose — the rollback", () => {
  it("boots out the three launchd jobs, flips the shape and brings the containers back", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(join(P, "seed", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), target: "compose", exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(r.commands).toEqual([
      "launchctl bootout gui/501/com.foldedspacelabs.metistry.db",
      "launchctl bootout gui/501/com.foldedspacelabs.metistry.console",
      "launchctl bootout gui/501/com.foldedspacelabs.metistry.assistant",
      "deployment set-shape compose (deployment.yaml written through the reconciler as user → compose)",
      "up(compose)",
      "metistry doctor",
    ]);
  });

  it("says out loud that the data does not come back with it", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(join(P, "seed", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), target: "compose", exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/THE DATA DOES NOT COME BACK WITH YOU/);
    expect(lines.join("\n")).toMatch(/pg_dump .* -Fc -f <somewhere>/);
  });
});
