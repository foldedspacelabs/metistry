// Postgres without Docker — the `launchd` shape's `db` service.
//
// Postgres.app and DBngin have run a user-space server this way for years:
// a data directory the user owns, a `postgresql.conf` that listens on
// loopback and a unix socket, and the server binary itself as the launchd
// job. Nothing here is privileged and nothing is installed system-wide.
//
// The binaries come from ONE of three places, in this order:
//
//   1. METISTRY_PG_BIN          an explicit bin directory. Always wins.
//   2. <product>/runtime/postgres/bin
//                               the bundled runtime the Mac app ships
//                               inside Metistry.app/Contents/Resources/
//                               (docs/product/desktop-app-plan.md).
//   3. Homebrew postgresql@17   /opt/homebrew or /usr/local.
//
// `metistry up` never installs anything: a missing toolchain is a printed
// `brew install` line the operator runs, never a command this tool runs
// unasked.
//
// Invariant 1 still holds: this data directory is derived state. It lives
// outside the vault, it is gitignored, and losing it costs trend lines.

import { join } from "node:path";
import { existsSync } from "node:fs";

/** The major version the schema is developed against (docker-compose.yml pins pgvector/pgvector:pg17). */
export const PG_MAJOR = "17";

export type PgSource = "env" | "bundled" | "homebrew";

export interface PgCandidate {
  /** a directory holding initdb/postgres/psql */
  bin: string;
  source: PgSource;
  /** for the doctor row and the dry-run plan */
  why: string;
}

/** The bundled layout the Mac app ships — documented so the app and the CLI cannot drift. */
export const BUNDLED_PG_REL = join("runtime", "postgres");

export const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local"] as const;

export function pgCandidates(env: NodeJS.ProcessEnv, productDir: string): PgCandidate[] {
  const out: PgCandidate[] = [];
  if (env.METISTRY_PG_BIN) out.push({ bin: env.METISTRY_PG_BIN.replace(/\/+$/, ""), source: "env", why: "METISTRY_PG_BIN" });
  out.push({ bin: join(productDir, BUNDLED_PG_REL, "bin"), source: "bundled", why: `bundled ${BUNDLED_PG_REL}/bin` });
  for (const p of HOMEBREW_PREFIXES) out.push({ bin: join(p, "opt", `postgresql@${PG_MAJOR}`, "bin"), source: "homebrew", why: `Homebrew postgresql@${PG_MAJOR}` });
  return out;
}

/** The binaries `up` and `doctor` actually call. All four must be present for a candidate to count. */
export const PG_BINARIES = ["postgres", "initdb", "psql", "createdb", "pg_isready"] as const;

export interface PgToolchain extends PgCandidate {
  /** whether vector.control is installed alongside — migration 0001 does CREATE EXTENSION vector */
  pgvector: boolean;
}

/** Where a Postgres install keeps its extension control files, relative to `bin/`. */
export function extensionDirs(bin: string): string[] {
  const prefix = join(bin, "..");
  return [join(prefix, "share", "extension"), join(prefix, "share", "postgresql", "extension"), join(prefix, "share", `postgresql@${PG_MAJOR}`, "extension")];
}

export function findPgToolchain(candidates: PgCandidate[], exists: (p: string) => boolean = existsSync): PgToolchain | undefined {
  for (const c of candidates) {
    if (!PG_BINARIES.every((b) => exists(join(c.bin, b)))) continue;
    return { ...c, pgvector: extensionDirs(c.bin).some((d) => exists(join(d, "vector.control"))) };
  }
  return undefined;
}

export const PG_MISSING_REMEDIATION =
  `no Postgres ${PG_MAJOR} found for the launchd shape — install one and re-run \`metistry up\`: ` +
  `brew install postgresql@${PG_MAJOR} pgvector   (or set METISTRY_PG_BIN to a bin/ directory, or ship ${BUNDLED_PG_REL}/bin). ` +
  `Nothing is installed for you.`;

export const PGVECTOR_MISSING_REMEDIATION = `pgvector is not installed next to this Postgres — db/migrations/0001_init.sql does CREATE EXTENSION vector and will fail: brew install pgvector`;

// ---- the data directory ----------------------------------------------------

/**
 * `<instance>/state/pg` — outside `Knowledge/`, gitignored, and a sibling
 * of the assistant's state dir. Falls back to the product checkout when
 * there is no instance yet (a bare checkout running `up --dry-run`).
 */
export function pgDataDir(root: string): string {
  return join(root, "state", "pg");
}

/**
 * The unix socket directory. Kept short and beside the data dir: a unix
 * socket path over ~103 bytes is silently unusable, so a deeply nested
 * instance directory is a real failure mode — `doctor` reports the length.
 */
export function pgSocketDir(root: string): string {
  return join(root, "state", "run");
}

export const SOCKET_PATH_LIMIT = 103;  // limit: fixed — sockaddr_un.sun_path on macOS; the kernel's number, not ours

export function socketPathTooLong(socketDir: string, port: number): boolean {
  return join(socketDir, `.s.PGSQL.${port}`).length > SOCKET_PATH_LIMIT;
}

// ---- postgresql.conf --------------------------------------------------------

export const CONF_BEGIN = "# --- metistry (managed: metistry up rewrites this block) ---";
export const CONF_END = "# --- end metistry ---";

/**
 * Loopback listen + a unix socket, and nothing else: every other setting
 * stays whatever initdb chose, so a Postgres upgrade's new defaults are not
 * frozen into this file.
 */
export function managedConfBlock(opts: { port: number; socketDir: string }): string {
  return [
    CONF_BEGIN,
    "# reachability beyond this machine is the user's routing layer (invariant 8)",
    "listen_addresses = '127.0.0.1'",
    `port = ${opts.port}`,
    `unix_socket_directories = '${opts.socketDir}'`,
    CONF_END,
  ].join("\n");
}

/** Idempotent: replace the managed block if it is there, append it if it is not. Everything outside the markers is untouched. */
export function applyManagedBlock(conf: string, block: string): string {
  const start = conf.indexOf(CONF_BEGIN);
  const end = conf.indexOf(CONF_END);
  if (start !== -1 && end !== -1 && end > start) return `${conf.slice(0, start)}${block}${conf.slice(end + CONF_END.length)}`;
  return `${conf.replace(/\n*$/, "\n")}\n${block}\n`;
}

// ---- the bootstrap plan ------------------------------------------------------

export type PgStep =
  | { kind: "run"; cmd: string; args: string[]; tolerateFailure?: boolean; comment?: string }
  | { kind: "write"; path: string; content: string; from: string }
  | { kind: "conf"; path: string; block: string; from: string };

export interface PgPlanInput {
  toolchain: PgToolchain;
  dataDir: string;
  socketDir: string;
  port: number;
  user: string;
  database: string;
  password: string;
  /** true when <dataDir>/PG_VERSION already exists — initdb runs once, ever */
  initialised: boolean;
}

/** Where the password is handed to initdb: written, read once, deleted in the next step. Never on a command line. */
export function pwFilePath(dataDir: string): string {
  return `${dataDir}.pwfile`;
}

/**
 * Everything that must happen before the db plist is bootstrapped. Pure:
 * the caller executes the steps through the CLI's one exec seam, and the
 * tests read the argument arrays without running Postgres.
 */
export function planPostgresBootstrap(i: PgPlanInput): PgStep[] {
  const bin = (b: string) => join(i.toolchain.bin, b);
  const steps: PgStep[] = [];
  if (!i.initialised) {
    const pwfile = pwFilePath(i.dataDir);
    steps.push({ kind: "write", path: pwfile, content: `${i.password}\n`, from: "generated superuser password (deleted in the next step)" });
    steps.push({
      kind: "run",
      cmd: bin("initdb"),
      args: [
        "-D",
        i.dataDir,
        "-U",
        i.user,
        `--pwfile=${pwfile}`,
        "--encoding=UTF8",
        "--locale=C",
        // local socket connections are the operator's own account; TCP
        // always authenticates, even on loopback (invariant 8: the network
        // is not a boundary)
        "--auth-local=trust",
        "--auth-host=scram-sha-256",
      ],
      comment: "once, ever — an existing data directory is never re-initialised",
    });
    steps.push({ kind: "run", cmd: "/bin/rm", args: ["-f", pwfile] });
  }
  steps.push({
    kind: "conf",
    path: join(i.dataDir, "postgresql.conf"),
    block: managedConfBlock({ port: i.port, socketDir: i.socketDir }),
    from: "metistry managed block: loopback listen + unix socket",
  });
  return steps;
}

/** After the server is up: the one thing compose got from POSTGRES_DB. */
export function planPostgresDatabase(i: PgPlanInput): PgStep[] {
  const bin = (b: string) => join(i.toolchain.bin, b);
  const conn = ["-h", i.socketDir, "-p", String(i.port), "-U", i.user];
  return [
    { kind: "run", cmd: bin("createdb"), args: [...conn, i.database], tolerateFailure: true, comment: "already exists is the normal case" },
  ];
}

/**
 * Append `KEY=value` to a `.env` body when the key is not already set
 * there. Returns undefined when the file already has it — the generated
 * Postgres password is written once and then belongs to the operator.
 */
export function withEnvLine(text: string, key: string, value: string): string | undefined {
  const re = new RegExp(`^(?:export\\s+)?${key}=`, "m");
  if (re.test(text)) return undefined;
  const body = text === "" ? "" : text.replace(/\n*$/, "\n");
  return `${body}\n# generated by \`metistry up\` for the launchd shape's Postgres (docs/ops/deployment-shapes.md)\n${key}=${value}\n`;
}

export function pgIsReady(i: PgPlanInput): { cmd: string; args: string[] } {
  return { cmd: join(i.toolchain.bin, "pg_isready"), args: ["-h", i.socketDir, "-p", String(i.port), "-U", i.user, "-d", i.database] };
}
