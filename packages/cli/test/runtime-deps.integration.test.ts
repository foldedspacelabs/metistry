// The real bundled runtime, when this checkout has one: `runtime/` is
// gitignored and only exists after `ops/release/build-runtime-deps.sh`, so
// this whole file skips when it is absent (CI's Linux jobs, and any machine
// that has not built it). When it IS there, it proves the claim the Mac app
// rests on — a Postgres that boots and does `CREATE EXTENSION vector` from a
// tree that is not where it was compiled, driven through the same
// `findPgToolchain` / `planPostgresBootstrap` code `metistry up` uses.
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findPgToolchain, pgCandidates, planPostgresBootstrap, pgIsReady } from "../src/postgres.js";
import { readRuntimeManifest, runtimeGitBin, RUNTIME_DIRNAME } from "../src/runtime-deps.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const RUNTIME = join(REPO, RUNTIME_DIRNAME);
const have = process.platform === "darwin" && existsSync(join(RUNTIME, "postgres", "bin", "initdb"));

const run = promisify(execFile);

describe.skipIf(!have)(`the built ${RUNTIME_DIRNAME}/ (skipped when it has not been built)`, () => {
  it("declares what it is: a manifest with versions and a sha256 per Mach-O", async () => {
    const m = await readRuntimeManifest(REPO);
    expect(m?.target).toBe("darwin-arm64");
    expect(m?.components?.postgres?.version).toMatch(/^17\./);
    expect(m?.components?.pgvector?.version).toBeTruthy();
    expect(m?.components?.node?.version).toMatch(/^\d+\./);
    expect(m?.components?.git?.version).toMatch(/^\d+\./);
    // the flags the source builds gave up are on the record, not in someone's memory
    expect(m?.components?.postgres?.disabled).toContain("readline");
    expect(m?.components?.git?.disabled).toContain("gettext");
    expect(Object.keys(m?.binaries ?? {}).length).toBeGreaterThan(20);
    for (const digest of Object.values(m?.binaries ?? {})) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is what `metistry up` resolves as the bundled toolchain, pgvector included", () => {
    const t = findPgToolchain(pgCandidates({}, REPO));
    expect(t?.source).toBe("bundled");
    expect(t?.bin).toBe(join(RUNTIME, "postgres", "bin"));
    expect(t?.pgvector).toBe(true);
    expect(existsSync(join(runtimeGitBin(REPO), "git"))).toBe(true);
  });

  it("boots Postgres and creates the vector extension from a MOVED copy of the tree", { timeout: 180_000 }, async () => {
      // moved, because that is the whole claim: the Mac app unpacks this
      // anywhere and the server still finds its own share/ and lib/
      const work = await mkdtemp(join(tmpdir(), "metistry-rt-boot-"));
      const sock = await mkdtemp(join(tmpdir(), "mrt."));
      try {
        await cp(join(RUNTIME, "postgres"), join(work, "postgres"), { recursive: true, verbatimSymlinks: true });
        const bin = join(work, "postgres", "bin");
        const toolchain = findPgToolchain(pgCandidates({ METISTRY_PG_BIN: bin }, work))!;
        expect(toolchain.source).toBe("env");

        const data = join(work, "pg");
        // the same plan `up` executes, minus the launchd job
        const steps = planPostgresBootstrap({ toolchain, dataDir: data, socketDir: sock, port: 5432, user: "metistry", database: "metistry", password: "not-used-over-a-socket", initialised: false });
        expect(steps.map((s) => s.kind)).toContain("run");
        await run(join(bin, "initdb"), ["-D", data, "-U", "metistry", "--auth-local=trust", "--encoding=UTF8", "--locale=C", "-N"]);
        // -l detaches the server's stdout: without it pg_ctl's own pipe never closes
        await run(join(bin, "pg_ctl"), ["-D", data, "-l", join(work, "pg.log"), "-w", "-t", "60", "-o", `-c listen_addresses='' -c unix_socket_directories=${sock}`, "start"]);
        try {
          const ready = pgIsReady({ toolchain, dataDir: data, socketDir: sock, port: 5432, user: "metistry", database: "postgres", password: "", initialised: true });
          expect((await run(ready.cmd, ready.args)).stdout).toContain("accepting connections");
          await run(join(bin, "psql"), ["-h", sock, "-U", "metistry", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION vector"]);
          const { stdout } = await run(join(bin, "psql"), ["-h", sock, "-U", "metistry", "-d", "postgres", "-tAc", "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"]);
          expect(stdout.trim()).toMatch(/^vector\|\d+\.\d+\.\d+$/);
        } finally {
          await run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]).catch(() => {});
        }
      } finally {
        await rm(work, { recursive: true, force: true });
        await rm(sock, { recursive: true, force: true });
      }
  });

  it("commits with the bundled git from a moved copy — a clean Mac has none until Xcode CLT is installed", { timeout: 120_000 }, async () => {
      const work = await mkdtemp(join(tmpdir(), "metistry-rt-scm-"));
      try {
        await cp(join(RUNTIME, "git"), join(work, "git"), { recursive: true, verbatimSymlinks: true });
        const exe = join(work, "git", "bin", "git");
        const repo = join(work, "repo");
        await run("/bin/mkdir", ["-p", repo]);
        await run(exe, ["init", "-q", repo]);
        await run(exe, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first"]);
        const { stdout } = await run(exe, ["-C", repo, "rev-list", "--count", "HEAD"]);
        expect(stdout.trim()).toBe("1");
      } finally {
        await rm(work, { recursive: true, force: true });
      }
  });
});
