// The CLI's side of dialling a connection: which Keychain fills a secret,
// which catalog a check reads, and the rows `metistry doctor` adds — one per
// connection, each the connection's own `check()` (packages/connections).
//
// A module of its own so doctor can import it without importing the
// connections verbs, which write through protected-write.ts (which imports
// doctor.ts): no cycle.

import { existsSync } from "node:fs";
import { InstanceSecrets, intEnv, resolveInstanceLayout, type CheckResult, type KeychainBackend, type SecretPresence, type SecretSource } from "@foldedspacelabs/metistry-core";
import {
  ConnectionPool,
  DEFAULT_CONNECTION_CALL_TIMEOUT_MS,
  DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS,
  checkConnection,
  loadInstanceCatalog,
  type ConnectionCatalog,
  type InstanceCatalog,
} from "@foldedspacelabs/metistry-connections";
import { realExec, type Exec } from "./exec.js";
import { securityKeychain } from "./keychain.js";

export interface ConnectionsOptions {
  /** the instance repo whose `.metistry/connections/` this reads and writes */
  instanceDir: string;
  /** its `instance_id` — the Keychain account its secrets are under; absent = no secret can be filled or asked about */
  instanceId: string | undefined;
  /** the product's `seed/`, for the shipped connection types */
  seedDir?: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  /** reaches the reconciler for a protected write */
  fetchFn?: typeof fetch | undefined;
  /** test seam: the Keychain. Default: the login Keychain through `security`, on darwin */
  keychain?: KeychainBackend | undefined;
  /** test seam: the base fetch an HTTP connection is dialled through (under the egress guard). Default: global fetch */
  dialFetch?: typeof fetch | undefined;
  /** how long a dial may take before `add`/`test`/doctor give up */
  timeoutMs?: number | undefined;
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

/** THIS instance's secrets — the one account its `instance_id` names — or undefined where there is no Keychain or no id. */
export function secretsStore(opts: Pick<ConnectionsOptions, "instanceId" | "keychain" | "platform" | "exec">): InstanceSecrets | undefined {
  if (!opts.instanceId) return undefined;
  const backend = opts.keychain ?? (opts.platform === "darwin" ? securityKeychain(opts.exec ?? realExec) : undefined);
  return backend ? new InstanceSecrets(backend, opts.instanceId) : undefined;
}

/** Presence only, for a listing — never a value. */
export function presenceOf(opts: ConnectionsOptions): SecretPresence | undefined {
  return secretsStore(opts)?.presence();
}

export function catalogFor(opts: Pick<ConnectionsOptions, "instanceDir" | "seedDir">): Promise<InstanceCatalog> {
  return loadInstanceCatalog({ instanceDir: opts.instanceDir, ...(opts.seedDir ? { seedDir: opts.seedDir } : {}) });
}

/** A pool for one verb's dials; the caller closes it. No Keychain here = every secret is missing, and says so. */
export function poolOver(opts: ConnectionsOptions, catalog: () => Promise<ConnectionCatalog>): ConnectionPool {
  const store = secretsStore(opts);
  const none: SecretSource = { value: async () => undefined };
  return new ConnectionPool({
    catalog,
    secrets: store ?? none,
    ...(opts.dialFetch ? { fetch: opts.dialFetch } : {}),
    connectTimeoutMs: opts.timeoutMs ?? intEnv("METISTRY_CONNECTION_CONNECT_TIMEOUT_MS", DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS, opts.env),
    callTimeoutMs: opts.timeoutMs ?? intEnv("METISTRY_CONNECTION_CALL_TIMEOUT_MS", DEFAULT_CONNECTION_CALL_TIMEOUT_MS, opts.env),
    clientInfo: { name: "metistry-cli", version: "1" },
  });
}

/**
 * One run's dials of the instance's connections, shared. `metistry doctor`
 * asks the same connection twice — its own row, and the check of the collector
 * that reads it (X-87) — and a connection is dialled ONCE: the answer is
 * memoised by name, the catalog is read once, and the pool is opened on the
 * first dial and closed by `close()`. Nothing here throws: a catalog that will
 * not load is every connection's `failed` verdict, in words.
 */
export interface ConnectionChecker {
  /** the connection's `check()` (packages/connections `checkConnection`) — memoised by name */
  check(name: string): Promise<CheckResult>;
  /** every connection in `.metistry/connections/`, by name; empty when there is no such directory */
  names(): Promise<string[]>;
  close(): Promise<void>;
}

export function connectionChecker(opts: ConnectionsOptions): ConnectionChecker {
  let catalog: Promise<InstanceCatalog | undefined> | undefined;
  let pool: ConnectionPool | undefined;
  const seen = new Map<string, Promise<CheckResult>>();
  const load = (): Promise<InstanceCatalog | undefined> => {
    catalog ??= existsSync(resolveInstanceLayout(opts.instanceDir).path("connectionsDir")) ? catalogFor(opts) : Promise.resolve(undefined);
    return catalog;
  };
  return {
    names: async () => (await load())?.entries.map((e) => e.name) ?? [],
    check(name) {
      let r = seen.get(name);
      if (!r) {
        r = (async (): Promise<CheckResult> => {
          const cat = await load();
          if (!cat) return { name, status: "absent", latency_ms: 0, probe: "read .metistry/connections/", remediation: "this instance has no .metistry/connections/ directory" };
          pool ??= poolOver(opts, async () => cat);
          return checkConnection(pool, cat, name);
        })().catch(
          (err): CheckResult => ({ name, status: "failed", latency_ms: 0, probe: "read .metistry/connections/", remediation: err instanceof Error ? err.message : String(err) }),
        );
        seen.set(name, r);
      }
      return r;
    },
    close: async () => {
      await pool?.close();
    },
  };
}

/**
 * The rows doctor adds: one per connection, checked. Never `failed` in
 * doctor's verdict — a connection is someone else's server, and its outage
 * is not the install's (like the vault's remote and the local model
 * servers); the check's own verdict rides in `meta.check_status`.
 */
export async function connectionDoctorRows(opts: ConnectionsOptions, shared?: ConnectionChecker): Promise<Array<CheckResult & { kind: "connection" }>> {
  const checker = shared ?? connectionChecker(opts);
  try {
    const names = await checker.names();
    const results = await Promise.all(names.map((name) => checker.check(name)));
    return results.map((r) =>
      r.status === "failed"
        ? {
            ...r,
            kind: "connection" as const,
            status: "degraded" as const,
            meta: { ...(r.meta ?? {}), check_status: "failed" },
            remediation: `${r.remediation ?? "it did not answer"} — a connection is its own server: doctor reports it and never fails the install for it (\`metistry connections test ${r.name}\`)`,
          }
        : { ...r, kind: "connection" as const },
    );
  } finally {
    // a checker handed in is the caller's: it closes it after the last reader
    if (!shared) await checker.close();
  }
}
