// The console's connections proxy (plan §2.6, C115; T4-10 — ruled
// 2026-09-30, Q10: open since #374, when the pool existed but no live console
// built one, so `connections_list` and `connections_call` answered
// `not_available` everywhere but in tests).
//
// ONE pooled client over the instance's catalog, read afresh on every call —
// an edit to a connection, `variables.yaml` or `secrets.yaml` lands without a
// restart — handed to `/mcp` and to the Approve path that runs an Ask First
// call (server.ts, `connectionsProxy`). Its values come from the environment
// `metistry secrets sync --to env` wrote (`METISTRY_SECRET_<NAME>`, core's
// `secretDeliveryVar`; packages/connections `consoleSecretNames` says which),
// filled at the egress door for each secret's listed hosts only: the console
// never reads the Keychain. An OAuth connection's access token is minted
// here, from the delivered refresh token, and held in memory.
//
// What it cannot do is sign in: the proxy has three doors — list, tools,
// call — and an OAuth flow is the owner's CLI verb alone (packages/connections
// oauth.ts; `oauth-reach.test.ts` holds this file to it).

import {
  ConnectionPool,
  DEFAULT_CONNECTION_CALL_TIMEOUT_MS,
  DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS,
  DEFAULT_CONNECTION_IDLE_MS,
  envSecretSource,
  loadInstanceCatalog,
  poolProxy,
  type CatalogRoots,
  type PoolProxy,
} from "@foldedspacelabs/metistry-connections";
import { intEnv } from "@foldedspacelabs/metistry-core";

export interface ConsoleConnections {
  pool: ConnectionPool;
  proxy: PoolProxy;
}

/** The pool and the proxy over one instance. `fetch` is a test's loopback fixture; a live console passes none. */
export function consoleConnections(roots: CatalogRoots, opts: { env: NodeJS.ProcessEnv; version: string; fetch?: typeof fetch | undefined }): ConsoleConnections {
  const catalog = () => loadInstanceCatalog(roots);
  const pool = new ConnectionPool({
    catalog,
    secrets: envSecretSource(opts.env),
    idleMs: intEnv("METISTRY_CONNECTION_IDLE_MS", DEFAULT_CONNECTION_IDLE_MS, opts.env),
    connectTimeoutMs: intEnv("METISTRY_CONNECTION_CONNECT_TIMEOUT_MS", DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS, opts.env),
    callTimeoutMs: intEnv("METISTRY_CONNECTION_CALL_TIMEOUT_MS", DEFAULT_CONNECTION_CALL_TIMEOUT_MS, opts.env),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    // the client's name on the wire — never the assistant's (CLAUDE.md)
    clientInfo: { name: "metistry-console", version: opts.version },
  });
  return { pool, proxy: poolProxy({ pool, catalog }) };
}
