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
  countLosses,
  DRY_RUN_COUNTS,
  migrateShape,
  parseCounts,
  stamp,
  TABLE_LIST_SQL,
  tableCountsSql,
  tocEntryCount,
  type MigrateShapeOptions,
} from "../src/migrate-shape.js";
import type { UpOptions, UpResult } from "../src/up.js";
import { checkout, fakeExec, okDoctor, shown } from "./fixtures.js";

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
  // what `up` leaves behind under the launchd shape: the supervisor's child
  // list. The apple-fm bridge is a CHILD now, so its TCC-helper override goes
  // here rather than into a plist of its own.
  await writeFile(
    join(I, "state", "supervisor.json"),
    JSON.stringify(
      {
        schema: 1,
        label: "com.foldedspacelabs.metistry",
        socket: join(I, "state", "run", "supervisor.sock"),
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
/** A slice of the generated query that survives shell quoting in a printed command. */
const COUNTS_FRAGMENT = 'count(*) FROM "runs"';

/** The three SHAPE_SERVICES labels, in the fixed order the migration always uses. */
// under the supervisor the launchd shape is ONE label — db, console and
// assistant are its children (a product tree from before the supervisor
// still stops three; see shapeServices())
const LABELS = ["com.foldedspacelabs.metistry"];

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
    // never touch the network or the clock: on this Mac the production console
    // answers :8080 instantly, in CI nothing does and the readiness poll runs
    // its full 10 s — past vitest's 5 s limit
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

  it("treats a LOST row as a failure and a gained one as normal", () => {
    const before = parseCounts("runs=6730\nwork=66\n");
    expect(countLosses(before, parseCounts("runs=6732\nwork=66\n"))).toEqual([]); // the console recorded its own startup
    expect(countLosses(before, parseCounts("runs=6729\nwork=66\n"))).toEqual(["runs: 6730 → 6729"]);
    expect(countLosses(before, parseCounts("runs=6730\n"))).toEqual(["work: 66 → the table is not there"]);
  });

  it("counts rows with plain SQL — the bundled Postgres has no libxml and an estimate would prove nothing", () => {
    const sql = tableCountsSql(["runs", "work"]);
    expect(sql).toBe(`SELECT 'runs=' || count(*) FROM "runs" UNION ALL SELECT 'work=' || count(*) FROM "work" ORDER BY 1`);
    expect(sql).not.toMatch(/xpath|query_to_xml|n_live_tup/);
    // an identifier is quoted, and a quote inside one is doubled rather than escaped
    expect(tableCountsSql(['we"ird'])).toBe(`SELECT 'we"ird=' || count(*) FROM "we""ird" ORDER BY 1`);
  });
});

describe("metistry migrate-shape launchd --dry-run", () => {
  it("plans quiesce → dump → verify → stop db → shape → up → restore → compare → tcc → restart → doctor, in that order", async () => {
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
      // the writers stop BEFORE the dump, so nothing is written into the gap
      dc(["stop", "console", "assistant"]),
      dc(["exec", "-T", "db", "psql", "-U", "metistry", "-d", "metistry", "-tA", "--no-psqlrc", "-c", TABLE_LIST_SQL]),
      // a dry run never asks for the table list, so the count query cannot be
      // generated — the step is still in the plan, described
      `${DRY_RUN_COUNTS}, through the db container — the counts the restore is checked against`,
      dc(["exec", "-T", "db", "pg_dump", "-U", "metistry", "-d", "metistry", "--format=custom", "--compress=6", "--file", `/tmp/metistry-migrate-${TS}.dump`]),
      `mkdir -p ${I}/state/migrate`,
      dc(["cp", `db:/tmp/metistry-migrate-${TS}.dump`, dump]),
      dc(["exec", "-T", "db", "rm", "-f", `/tmp/metistry-migrate-${TS}.dump`]),
      `${PG}/pg_restore --list ${dump}`,
      dc(["stop", "db"]),
      "deployment set-shape launchd (deployment.yaml written through the reconciler as user → launchd)",
      "up(launchd)",
      formatCommand(`${PG}/pg_restore`, [...conn, "--no-owner", "--no-privileges", "--exit-on-error", dump]),
      `${DRY_RUN_COUNTS}, against the restored database — compared with the counts taken beside the dump, and a table that lost rows fails the migration`,
      // the console and the assistant are the supervisor's children: one
      // kickstart brings both back on the restored database
      "launchctl kickstart -k gui/501/com.foldedspacelabs.metistry",
      // doctor's verdict must not race a job kickstarted a moment ago
      "wait for console to answer — doctor's verdict must not be a race with a job kickstarted a moment ago",
      "metistry doctor",
    ]);
  });

  it("the dump is verified BEFORE the database is stopped", async () => {
    const P = await productTree();
    const I = await instance();
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P) });
    const verify = r.commands.findIndex((c) => c.includes("pg_restore --list"));
    const stopDb = r.commands.findIndex((c) => c.endsWith("stop db)"));
    expect(verify).toBeGreaterThan(-1);
    expect(stopDb).toBeGreaterThan(verify);
  });

  it("the writers are stopped before the counts and the dump are taken", async () => {
    const P = await productTree();
    const I = await instance();
    // a real run, so the generated count query is actually in the plan
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), exists: ready(P) });
    expect(r.code).toBe(0);
    const quiesce = r.commands.findIndex((c) => c.endsWith("stop console assistant)"));
    const counts = r.commands.findIndex((c) => c.includes(COUNTS_FRAGMENT));
    const dump = r.commands.findIndex((c) => c.includes("pg_dump"));
    expect(quiesce).toBeGreaterThan(-1);
    expect(counts).toBeGreaterThan(quiesce);
    expect(dump).toBeGreaterThan(counts);
    // and the same generated query runs again against the restored database
    expect(r.commands.filter((c) => c.includes(COUNTS_FRAGMENT))).toHaveLength(2);
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
    const docker = r.commands.filter((c) => c.includes("docker "));
    expect(docker.length).toBeGreaterThan(0);
    for (const c of docker) {
      expect(c).not.toMatch(/\bdown\b/);
      expect(c).not.toMatch(/\s-v(\s|$)/);
      expect(c).not.toMatch(/\bvolume\b|\brm\b\s+-f?s?v?\s*$/);
    }
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
    // the supervisor takes the suffix instead of a service component
    expect(r.commands).toContain("launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.e5dbfa9c");
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
  it("fails — and says which table — when a row does not survive the move", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({
      productDir: P,
      env: env(I),
      exec: liveCompose("runs=6729\nschema_migrations=13\nwork=66\n"),
      exists: ready(P),
      out: (l) => lines.push(l),
    });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toMatch(/missing rows the dump had — runs: 6730 → 6729/);
    // a failure here happens AFTER `docker compose stop db` — compose is
    // brought back automatically rather than left down beside a broken restore
    expect(lines.join("\n")).toMatch(/compose stack has been brought back up and deployment\.yaml is set back to compose/);
  });

  it("a table that GREW since the restore is normal — the console records its own startup", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const r = await run({
      productDir: P,
      env: env(I),
      exec: liveCompose("runs=6732\nschema_migrations=13\nwork=66\n"),
      exists: ready(P),
      out: (l) => lines.push(l),
    });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).toMatch(/came across with at least the rows the dump had \(written since the restore: runs: 6730 → 6732\)/);
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
    // the writers are already quiesced by then — but the DATABASE is not
    // stopped, so `docker compose start console assistant` puts it all back
    expect(r.commands.some((c) => c.endsWith("stop db)"))).toBe(false);
    expect(r.commands.some((c) => c.includes("set-shape"))).toBe(false);
  });
});

describe("metistry migrate-shape compose — the rollback", () => {
  it("boots out the one supervisor job, flips the shape and brings the containers back", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(join(P, "seed", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const r = await run({ productDir: P, env: env(I), target: "compose", exec: liveCompose(), dryRun: true, exists: ready(P), out: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(r.commands).toEqual([
      "launchctl bootout gui/501/com.foldedspacelabs.metistry",
      "deployment set-shape compose (deployment.yaml written through the reconciler as user → compose)",
      "up(compose)",
      "wait for console to answer — doctor's verdict must not be a race with a job kickstarted a moment ago",
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

  it("waits for each launchd bootout to finish, and for the bundled Postgres to release its port, before calling `up`", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(join(P, "seed", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const printsSeen: Record<string, number> = {};
    let pgTries = 0;
    const exec = fakeExec({
      launchctl: (args) => {
        if (args[0] !== "print") return undefined;
        const label = args[1]!;
        printsSeen[label] = (printsSeen[label] ?? 0) + 1;
        // still loaded for the first two polls of EVERY label, then gone
        return printsSeen[label]! <= 2 ? { code: 0 } : { code: 1 };
      },
      [`${PG}/pg_isready`]: () => {
        pgTries++;
        // still accepting connections for the first two polls, then down
        return pgTries <= 2 ? { code: 0 } : { code: 1 };
      },
    });
    // `up` is injected and never touches this fake exec on its own — the
    // marker call stands in for the real `docker compose up -d` `up` would
    // issue, so its position relative to the polls above is what is asserted
    const upFn = async (o: UpOptions): Promise<UpResult> => {
      await exec("docker", ["compose", "up", "-d"], {});
      return { code: 0, source: "release", commands: [`up(${o.deployment?.shape})`] };
    };
    const r = await run({ productDir: P, env: env(I), target: "compose", exec, exists: ready(P), upFn });
    expect(r.code).toBe(0);
    const upIdx = exec.calls.findIndex((c) => c.cmd === "docker" && c.args.join(" ") === "compose up -d");
    expect(upIdx).toBeGreaterThan(-1);
    const printIdxs = exec.calls.map((c, i) => (c.cmd === "launchctl" && c.args[0] === "print" ? i : -1)).filter((i) => i >= 0);
    const isreadyIdxs = exec.calls.map((c, i) => (c.cmd === `${PG}/pg_isready` ? i : -1)).filter((i) => i >= 0);
    expect(printIdxs.length).toBeGreaterThan(0);
    expect(isreadyIdxs).toHaveLength(3); // 2 "still accepting" + the one that reports it gone
    expect(Math.max(...printIdxs)).toBeLessThan(upIdx);
    expect(Math.max(...isreadyIdxs)).toBeLessThan(upIdx);
    // every label really was polled more than once — the wait happened, not a no-op
    expect(LABELS.every((l) => printsSeen[`gui/501/${l}`] === 3)).toBe(true);
  });
});

describe("both directions compensate a failed `up` so the install is never left with nothing running", () => {
  it("rollback: a failed `up (compose)` restores the launchd jobs from disk and flips the shape back", async () => {
    const P = await productTree();
    const I = await instance();
    await writeFile(join(P, "seed", "deployment.yaml"), "shape: launchd\nservices: {}\n");
    const lines: string[] = [];
    const failingUp = async (o: UpOptions): Promise<UpResult> => ({ code: 1, source: "release", commands: [`up(${o.deployment?.shape}) FAILED`] });
    const r = await run({
      productDir: P,
      env: env(I),
      target: "compose",
      exec: liveCompose(),
      exists: ready(P),
      home: "/h",
      upFn: failingUp,
      out: (l) => lines.push(l),
    });
    expect(r.code).toBe(1);
    expect(r.commands).toEqual([
      `launchctl bootout gui/501/${LABELS[0]}`,
      "deployment set-shape compose (deployment.yaml written through the reconciler as user → compose)",
      "up(compose) FAILED",
      `launchctl bootstrap gui/501 /h/Library/LaunchAgents/${LABELS[0]}.plist`,
      `launchctl kickstart -k gui/501/${LABELS[0]}`,
      "deployment set-shape launchd (deployment.yaml written through the reconciler as user → launchd)",
    ]);
    expect(lines.join("\n")).toMatch(/launchd jobs have been restored and deployment\.yaml is set back to launchd — nothing is down/);
  });

  it("forward: a failed `up (launchd)` after `docker compose stop db` brings the compose stack back and flips the shape back", async () => {
    const P = await productTree();
    const I = await instance();
    const lines: string[] = [];
    const failingUp = async (o: UpOptions): Promise<UpResult> => ({ code: 1, source: "release", commands: [`up(${o.deployment?.shape}) FAILED`] });
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), exists: ready(P), upFn: failingUp, out: (l) => lines.push(l) });
    expect(r.code).toBe(1);
    const dc = (args: string[]) => formatCommand("docker", ["compose", "--env-file", `${I}/state/.env`, ...args], P);
    const dump = `${I}/state/migrate/${TS}.dump`;
    expect(r.commands).toEqual([
      dc(["ps", "-q", "db"]),
      dc(["stop", "console", "assistant"]),
      dc(["exec", "-T", "db", "psql", "-U", "metistry", "-d", "metistry", "-tA", "--no-psqlrc", "-c", TABLE_LIST_SQL]),
      dc(["exec", "-T", "db", "psql", "-U", "metistry", "-d", "metistry", "-tA", "--no-psqlrc", "-c", COUNTS_SQL]),
      dc(["exec", "-T", "db", "pg_dump", "-U", "metistry", "-d", "metistry", "--format=custom", "--compress=6", "--file", `/tmp/metistry-migrate-${TS}.dump`]),
      `mkdir -p ${I}/state/migrate`,
      dc(["cp", `db:/tmp/metistry-migrate-${TS}.dump`, dump]),
      dc(["exec", "-T", "db", "rm", "-f", `/tmp/metistry-migrate-${TS}.dump`]),
      `${PG}/pg_restore --list ${dump}`,
      dc(["stop", "db"]),
      "deployment set-shape launchd (deployment.yaml written through the reconciler as user → launchd)",
      "up(launchd) FAILED",
      dc(["up", "-d"]),
      "deployment set-shape compose (deployment.yaml written through the reconciler as user → compose)",
    ]);
    expect(lines.join("\n")).toMatch(/compose stack has been brought back up and deployment\.yaml is set back to compose — nothing is down/);
  });
});

describe("a second forward run — a leftover launchd data directory from a rollback", () => {
  it("moves state/pg aside, never deleting it, before `up` initdbs a fresh one", async () => {
    const P = await productTree();
    const I = await instance();
    const pgDir = join(I, "state", "pg");
    const r = await run({
      productDir: P,
      env: env(I),
      exec: liveCompose(),
      dryRun: true,
      exists: (p) => p === join(pgDir, "PG_VERSION") || ready(P)(p),
    });
    expect(r.code).toBe(0);
    const mv = `mv ${pgDir} ${pgDir}.${TS}.stale`;
    expect(r.commands).toContain(mv);
    // it happens before `up`, so the fresh initdb lands in a directory that no longer exists
    expect(r.commands.indexOf(mv)).toBeLessThan(r.commands.indexOf("up(launchd)"));
  });

  it("a fresh install with no state/pg yet is unaffected — nothing is moved", async () => {
    const P = await productTree();
    const I = await instance();
    const r = await run({ productDir: P, env: env(I), exec: liveCompose(), dryRun: true, exists: ready(P) });
    expect(r.code).toBe(0);
    expect(r.commands.some((c) => c.startsWith("mv "))).toBe(false);
  });
});
