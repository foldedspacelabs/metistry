#!/usr/bin/env node
// `metistry` — init | connect-repo | secrets | doctor | up | update (plan
// §4.16; connect-repo and secrets are the install verbs the Mac app drives,
// docs/product/desktop-app-plan.md). Hand-rolled argument parsing: a handful
// of subcommands and flags does not justify a dependency this project would
// maintain for years (CLAUDE.md).

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { doctor, renderTable, type DoctorDeps } from "./doctor.js";
import { loadInstallEnv, productVersion, resolveProductDir, resolveSeedDir, type LoadedEnv } from "./env.js";
import { realExec, type Exec } from "./exec.js";
import { AUTH_MODES, connectRepo, type AuthMode } from "./connect-repo.js";
import { importSessions } from "./import-sessions.js";
import { init } from "./init.js";
import { ensureInstanceId, instanceEnvFile, readInstanceId } from "./instance.js";
import type { LockSource } from "./lock.js";
import { listSecrets, mintSecret, purgeSecrets, renderSecretList, syncSecrets, type SyncDirection } from "./secrets.js";
import { StepRunner } from "./steps.js";
import { up } from "./up.js";
import { gitHead, update } from "./update.js";

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `metistry init --force <dir>` keeps its dir. */
export const BOOLEAN_FLAGS = new Set(["force", "json", "help", "dry-run", "no-launchd", "no-compose", "skip-build", "skip-migrate", "rollback", "yes"]);

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

/** `--auth device|token|ssh` — a typo must not silently pick a weaker path. */
export function parseAuth(v: string | undefined): AuthMode | undefined {
  if (v === undefined) return undefined;
  if (!(AUTH_MODES as string[]).includes(v)) throw new Error(`--auth must be ${AUTH_MODES.join(", ")} — not ${JSON.stringify(v)}`);
  return v as AuthMode;
}

/** `secrets sync` direction: `--to` names it outright, `--from` names the other end. Never guessed. */
export function syncDirection(from: string | undefined, to: string | undefined): SyncDirection {
  const ok = (v: string | undefined, flag: string): SyncDirection | undefined => {
    if (v === undefined) return undefined;
    if (v !== "env" && v !== "keychain") throw new Error(`${flag} must be env or keychain, not ${JSON.stringify(v)}`);
    return v;
  };
  const t = ok(to, "--to");
  const f = ok(from, "--from");
  if (t && f && t === f) throw new Error(`--from ${f} --to ${t} is a no-op`);
  if (t) return t;
  if (f) return f === "env" ? "keychain" : "env";
  throw new Error("say which way: `metistry secrets sync --to keychain` (import .env) or `--to env` (regenerate .env)");
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

  metistry connect-repo <url> [--instance <dir>] [--auth device|token|ssh] [--force]
      Point the instance repo at a private remote and leave credentials the
      reconciler can push with unattended: set origin (refusing to repoint one
      without --force), configure credential.helper=osxkeychain for an https
      remote, get a token (--auth device runs GitHub's device-authorization
      flow against METISTRY_GITHUB_OAUTH_CLIENT_ID; --auth token reads a PAT
      from stdin; --auth ssh trusts your key) into the login Keychain, verify
      with git ls-remote, flush the reconciler's queue, and push once.
      The token is never printed, never written to .env, never in .git/config.

  metistry secrets sync [--from keychain|env] [--to env|keychain] [--env-file <path>]
  metistry secrets mint <VAR> [--env-file <path>]
  metistry secrets list [--env-file <path>]
      The macOS login Keychain (service metistry:<VAR>) is the canonical store;
      .env is generated from it. --to keychain imports .env's secret-shaped
      variables (names ending _TOKEN _PASSWORD _PRIVATE _SECRET _KEY, plus
      CLAUDE_CODE_OAUTH_TOKEN); --to env rewrites just those lines of .env in
      place (0600; every comment and non-secret line preserved). mint makes a
      new random token in both. list prints names only, never values.

  metistry import-sessions [--since <date>] [--project <path>] [--limit N] [--dry-run]
      Summarise this machine's Claude Code sessions (~/.claude/projects/*/*.jsonl)
      and POST each one to /capture as kind "session". Host only — the console
      container has no home directory — and deterministic: no model is called,
      and what is sent is a summary (turns, files touched, tools, models, first
      prompt, last response), never a transcript. A ledger at
      ~/.metistry/imported-sessions.json keyed by session id + transcript mtime
      makes a re-run a no-op; the note also carries an idempotency_key so the
      server can dedupe across this verb and the Claude Code plugin's hook.
      METISTRY_URL and METISTRY_OWNER_TOKEN come from the environment (.env in
      the checkout) or the login Keychain; neither is ever printed.

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
  /**
   * This install's environment, from the instance's own `state/.env` and
   * then the product checkout's deprecated one. Deprecation notices go to
   * STDERR so `doctor --json` stays machine-readable.
   */
  const loadEnv = (): LoadedEnv => {
    const loaded = loadInstallEnv({ productDir, instanceDir: str(flags, "instance"), envFile: str(flags, "env-file") });
    for (const n of loaded.notices) err(n);
    return loaded;
  };
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
      out(`instance created at ${result.dir} (commit ${result.commit.slice(0, 7)}; assistant named "${result.assistantName}" in identity.yaml; instance_id ${result.instanceId})`);
      out("");
      out(`Next — put these in this instance's environment, ${instanceEnvFile(result.dir)} (the token below is minted once and shown only here):`);
      out("");
      for (const l of result.envLines) out(`  ${l}`);
      out("");
      out("That file is the install's environment: gitignored, 0600, and never in the product checkout (an instance directory is self-contained — docs/ops/cli.md).");
      out("");
      out("Then: pnpm -r build && metistry up   (containers, every launchd job, doctor — docs/ops/cli.md).");
      out(`Then, to version it off this machine: metistry connect-repo <your private remote> --instance ${result.dir} (docs/ops/cli.md).`);
      return 0;
    }
    case "connect-repo": {
      const url = positional[0];
      if (!url) {
        err("usage: metistry connect-repo <url> [--instance <dir>] [--auth device|token|ssh] [--force]");
        return 2;
      }
      loadEnv();
      const instanceDir = str(flags, "instance") ?? process.env.METISTRY_INSTANCE_DIR;
      if (!instanceDir) {
        err("connect-repo needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR (docs/ops/cli.md)");
        return 2;
      }
      try {
        const r = await connectRepo({
          url,
          instanceDir,
          auth: parseAuth(str(flags, "auth")),
          force: flags.force === true,
          out,
          ...(io.exec ? { exec: io.exec } : {}),
        });
        out(`connected: ${instanceDir} → ${url} (branch ${r.branch}, credential ${r.credential})`);
        return 0;
      } catch (e) {
        err(`metistry connect-repo: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "secrets": {
      const sub = positional[0];
      const loaded = loadEnv();
      const paths = loaded.paths;
      if (!paths) {
        err("secrets needs a .env to read or generate: pass --env-file, --instance <dir>, or run inside a checkout (--product-dir / METISTRY_PRODUCT_DIR)");
        return 2;
      }
      // read the highest-precedence file that exists (the product checkout's
      // while an install predates the move); write where it now belongs
      const envFile = paths.read[0] ?? paths.write;
      let instanceId = loaded.instanceDir ? await readInstanceId(loaded.instanceDir) : undefined;
      // `sync` is where an instance created before instance_id existed gets
      // one — it has to, because that id is the account it files under. A
      // read-only verb (`list`) and a destructive one (`purge`) never mint.
      if (!instanceId && loaded.instanceDir && positional[0] === "sync") {
        const runner = new StepRunner({ dryRun: false, out, ...(io.exec ? { exec: io.exec } : {}) });
        const minted = await ensureInstanceId(runner, {
          instanceDir: loaded.instanceDir,
          env: process.env,
          platform: process.platform,
          uid: typeof process.getuid === "function" ? process.getuid() : 0,
          fetchFn: fetch,
        });
        out(minted.detail);
        if (minted.id) instanceId = minted.id;
      }
      const secretsOpts = {
        envFile,
        envTarget: paths.write,
        exampleFile: productDir ? join(productDir, ".env.example") : undefined,
        instanceId,
        out,
        ...(io.exec ? { exec: io.exec } : {}),
      };
      try {
        switch (sub) {
          case "sync":
            await syncSecrets(syncDirection(str(flags, "from"), str(flags, "to")), secretsOpts);
            return 0;
          case "mint": {
            const name = positional[1];
            if (!name) {
              err("usage: metistry secrets mint <VAR>");
              return 2;
            }
            await mintSecret(name, secretsOpts);
            return 0;
          }
          case "list":
            out(renderSecretList(await listSecrets(secretsOpts)));
            return 0;
          case "purge": {
            const dir = str(flags, "instance") ?? loaded.instanceDir;
            if (!dir) {
              err("usage: metistry secrets purge --instance <dir> [--yes]   (which instance's Keychain items to delete)");
              return 2;
            }
            const r = await purgeSecrets({ ...secretsOpts, instanceDir: dir, yes: flags.yes === true });
            return r.found.length > 0 && r.deleted.length !== r.found.length && flags.yes === true ? 1 : 0;
          }
          default:
            err("usage: metistry secrets sync --to env|keychain | metistry secrets mint <VAR> | metistry secrets list | metistry secrets purge --instance <dir> [--yes]");
            return 2;
        }
      } catch (e) {
        err(`metistry secrets: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "import-sessions": {
      loadEnv();
      const limitRaw = str(flags, "limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        err(`--limit must be a positive integer, not ${JSON.stringify(limitRaw)}`);
        return 2;
      }
      try {
        const r = await importSessions({
          out,
          err,
          since: str(flags, "since"),
          project: str(flags, "project"),
          limit,
          dryRun: flags["dry-run"] === true,
          ...(io.exec ? { exec: io.exec } : {}),
        });
        return r.code;
      } catch (e) {
        err(`metistry import-sessions: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "doctor": {
      if (!productDir) {
        err("doctor needs a Metistry checkout to walk: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      loadEnv();
      const report = await doctor({ productDir, ...io.doctorDeps });
      out(flags.json === true ? JSON.stringify(report, null, 2) : renderTable(report));
      return report.ok ? 0 : 1;
    }
    case "up": {
      if (!productDir) {
        err("up needs a Metistry checkout: pass --product-dir or set METISTRY_PRODUCT_DIR");
        return 2;
      }
      loadEnv();
      const r = await up({
        productDir,
        out,
        exec: io.exec,
        envFile: str(flags, "env-file"),
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
      loadEnv();
      const r = await update({
        productDir,
        out,
        exec: io.exec,
        envFile: str(flags, "env-file"),
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
