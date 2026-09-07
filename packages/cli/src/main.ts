#!/usr/bin/env node
// `metistry` — init | doctor | up | update (plan §4.16). Hand-rolled
// argument parsing: four subcommands and a handful of flags do not justify
// a dependency this project would maintain for years (CLAUDE.md).

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { doctor, renderTable, type DoctorDeps } from "./doctor.js";
import { loadDotEnv, productVersion, resolveProductDir, resolveSeedDir } from "./env.js";
import { realExec, type Exec } from "./exec.js";
import { init } from "./init.js";
import type { LockSource } from "./lock.js";
import { up } from "./up.js";
import { gitHead, update } from "./update.js";

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `metistry init --force <dir>` keeps its dir. */
export const BOOLEAN_FLAGS = new Set(["force", "json", "help", "dry-run", "no-launchd", "no-compose", "skip-build", "skip-migrate", "rollback"]);

/** `--channel git|release` — anything else is a typo, not a guess (the lock parser is strict for the same reason). */
export function parseChannel(v: string | undefined): LockSource | undefined {
  if (v === undefined) return undefined;
  if (v !== "git" && v !== "release") throw new Error(`--channel must be git or release, not ${JSON.stringify(v)}`);
  return v;
}

/** `--flag`, `--flag value`, `--flag=value`; everything else positional; `--` ends flag parsing. */
export function parseArgs(argv: string[], booleans = BOOLEAN_FLAGS): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (!booleans.has(a.slice(2)) && next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
      continue;
    }
    positional.push(a);
  }
  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}

function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

const USAGE = `metistry — Metistry command line

  metistry init <dir> [--name <assistant name>] [--channel git|release] [--force]
                      [--product-dir <checkout>]
      Create a private instance repo at <dir> from the product's seed/ (git init,
      Knowledge/, identity.yaml, rules.yaml, config dirs, metistry.lock, one commit).
      Prints the .env lines to add to the product checkout next — never writes them.
      --channel writes metistry.lock's product.source: git (this install is a
      checkout update fast-forwards; the default) or release (it consumes
      published artifacts — docs/ops/releases.md).

  metistry doctor [--json] [--product-dir <checkout>]
      Validate every manifest in the checkout and probe every bridge, service,
      container and launchd job. Exit 0 when nothing is failed.

  metistry up [--no-compose] [--no-launchd] [--dry-run] [--product-dir <checkout>]
      Bring an install to running from a checkout + .env: docker compose up (built
      from source, or pulled when metistry.lock pins a release), every launchd job
      in ops/launchd rendered into ~/Library/LaunchAgents and (re)bootstrapped
      (macOS; Linux prints systemd units), then doctor — its verdict is the exit code.

  metistry update [--skip-build] [--skip-migrate] [--dry-run] [--product-dir <dir>]
                  [--channel git|release] [--version <x.y.z>] [--rollback]
      Move an install forward: git fetch + pull --ff-only, pnpm install + build,
      db/migrations under a Postgres advisory lock, rebuild containers and
      kickstart the host jobs whose code changed, write metistry.lock into the
      instance repo (through the reconciler), doctor.
      In release mode (metistry.lock says source: release, or --channel release)
      the product step instead downloads the release's runtime pack, verifies its
      sha256, unpacks it to <dir>/releases/<version>/ and points <dir>/current at
      it; the pinned container images are pulled, never built. --version installs
      a specific release instead of the latest; --rollback flips current back to
      the previous one (migrations are additive and are not reverted).

  --dry-run prints every command and runs nothing.

Product checkout resolution: --product-dir, METISTRY_PRODUCT_DIR, the checkout
this package is installed in, the current directory's enclosing checkout.
`;

export interface MainIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** test seam: fakes for doctor's fetch/db/exec */
  doctorDeps?: Partial<DoctorDeps>;
  /** test seam: every subprocess up/update/init run */
  exec?: Exec;
}

export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const out = io.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = io.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const { command, positional, flags } = parseArgs(argv);
  if (command === undefined || command === "help" || flags.help) {
    out(USAGE);
    return command === undefined && !flags.help ? 2 : 0;
  }
  const productDir = resolveProductDir(str(flags, "product-dir"));
  let channel: LockSource | undefined;
  try {
    channel = parseChannel(str(flags, "channel"));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }

  switch (command) {
    case "init": {
      const dir = positional[0];
      if (!dir) {
        err("usage: metistry init <dir> [--name <assistant name>] [--force]");
        return 2;
      }
      const result = await init({
        dir,
        name: str(flags, "name"),
        force: flags.force === true,
        seedDir: resolveSeedDir(productDir),
        version: productVersion(),
        productSource: channel ?? "git",
        productCommit: productDir ? await gitHead(productDir, io.exec ?? realExec) : undefined,
        exec: io.exec,
      });
      out(`instance created at ${result.dir} (commit ${result.commit.slice(0, 7)}; assistant named "${result.assistantName}" in identity.yaml)`);
      out("");
      out("Next — add these to the PRODUCT checkout's .env (the token below is minted once and shown only here):");
      out("");
      for (const l of result.envLines) out(`  ${l}`);
      out("");
      out("Then: pnpm -r build && metistry up   (containers, every launchd job, doctor — docs/ops/cli.md).");
      out("Optional: git -C " + result.dir + " remote add origin <your private remote> — the reconciler pushes on its schedule.");
      return 0;
    }
    case "doctor": {
      if (!productDir) {
        err("doctor needs a Metistry checkout to walk: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      loadDotEnv(productDir);
      const report = await doctor({ productDir, ...io.doctorDeps });
      out(flags.json === true ? JSON.stringify(report, null, 2) : renderTable(report));
      return report.ok ? 0 : 1;
    }
    case "up": {
      if (!productDir) {
        err("up needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      loadDotEnv(productDir);
      const r = await up({
        productDir,
        out,
        exec: io.exec,
        dryRun: flags["dry-run"] === true,
        compose: flags["no-compose"] !== true,
        launchd: flags["no-launchd"] !== true,
        doctorDeps: io.doctorDeps,
      });
      return r.code;
    }
    case "update": {
      if (!productDir) {
        err("update needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      loadDotEnv(productDir);
      const r = await update({
        productDir,
        out,
        exec: io.exec,
        dryRun: flags["dry-run"] === true,
        skipBuild: flags["skip-build"] === true,
        skipMigrate: flags["skip-migrate"] === true,
        channel,
        releaseVersion: str(flags, "version"),
        rollback: flags.rollback === true,
        doctorDeps: io.doctorDeps,
      });
      return r.code;
    }
    default:
      err(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// bin entry: only when executed directly, so tests can import main(). The
// bin is a symlink under npx/pnpm; compare real paths.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`metistry: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
