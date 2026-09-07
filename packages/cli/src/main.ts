#!/usr/bin/env node
// `metistry` — init | doctor | up | update (plan §4.16). Hand-rolled
// argument parsing: four subcommands and a handful of flags do not justify
// a dependency this project would maintain for years (CLAUDE.md).

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { doctor, renderTable, type DoctorDeps } from "./doctor.js";
import { loadDotEnv, productVersion, resolveProductDir, resolveSeedDir } from "./env.js";
import { init } from "./init.js";

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

/** `--flag`, `--flag value`, `--flag=value`; everything else positional; `--` ends flag parsing. */
export function parseArgs(argv: string[]): ParsedArgs {
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
      if (next !== undefined && !next.startsWith("--")) {
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

  metistry init <dir> [--name <assistant name>] [--force] [--product-dir <checkout>]
      Create a private instance repo at <dir> from the product's seed/ (git init,
      Knowledge/, identity.yaml, rules.yaml, config dirs, metistry.lock, one commit).
      Prints the .env lines to add to the product checkout next — never writes them.

  metistry doctor [--json] [--product-dir <checkout>]
      Validate every manifest in the checkout and probe every bridge, service,
      container and launchd job. Exit 0 when nothing is failed.

  metistry up       (stub) bring the stack up from the pinned release
  metistry update   (stub) move metistry.lock to a newer release and migrate

Product checkout resolution: --product-dir, METISTRY_PRODUCT_DIR, the checkout
this package is installed in, the current directory's enclosing checkout.
`;

export interface MainIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** test seam: fakes for doctor's fetch/db/exec */
  doctorDeps?: Partial<DoctorDeps>;
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
      });
      out(`instance created at ${result.dir} (commit ${result.commit.slice(0, 7)}; assistant named "${result.assistantName}" in identity.yaml)`);
      out("");
      out("Next — add these to the PRODUCT checkout's .env (the token below is minted once and shown only here):");
      out("");
      for (const l of result.envLines) out(`  ${l}`);
      out("");
      out("Then: pnpm -r build; install the reconciler launchd job (docs/ops/reconciler.md); docker compose up -d console; metistry doctor.");
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
    case "up":
      out("metistry up is not built yet. It will: read metistry.lock, pull the pinned container images and npm packages, run db migrations idempotently, and start compose plus the host launchd jobs. Today: pnpm -r build && docker compose up -d && the launchd steps in docs/ops/reconciler.md.");
      return 0;
    case "update":
      out("metistry update is not built yet. It will: move metistry.lock to the requested release, pull the pinned artifacts, apply db/migrations under an advisory lock, and copy new seed defaults the instance does not already override (D4). Today: git pull && pnpm -r build && pnpm db:migrate.");
      return 0;
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
