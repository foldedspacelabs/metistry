// The connections proxy a host hands to `/mcp` and to the Approve path (plan
// §2.6, C115): `list` is the listing every surface renders, read without
// dialling; `tools` and `call` are the pooled client's. Structurally
// mcp-brain's `ConnectionsProxy` — this package does not import the bridge
// (the arrow points from apps to packages, and between packages only
// downward), and the bridge does not import this one.
//
// It has three doors and no fourth: nothing here signs in, stores a token or
// writes a file. An OAuth flow is the owner's hand (`metistry connections
// authorize`, oauth.ts); a connection that is not signed in answers
// `sign_in` through `call`, and the owner reads why in Connections.

import type { ConnectionCatalog } from "./catalog.js";
import { describeConnections, type ConnectionRow, type DescribeOptions } from "./describe.js";
import type { CallOutcome, CallRequest, ConnectionPool, ListedTool } from "./pool.js";

export interface PoolProxy {
  /** Every connection, with the owner's per-tool policy. Never dials. */
  list(): Promise<ConnectionRow[]>;
  /** One connection's listed, not-Never tools, with their definitions — an MCP server's fetched on demand, a generated type's Metistry's own. */
  tools(connection: string): Promise<ListedTool[]>;
  /** One call, through the pool: every refusal before anything is dialled, the answer redacted. */
  call(req: CallRequest): Promise<CallOutcome>;
}

/** The proxy over one pool and the catalog it reads. `describe` is the listing's presence probe, when the host has one. */
export function poolProxy(opts: { pool: ConnectionPool; catalog: () => Promise<ConnectionCatalog>; describe?: DescribeOptions | undefined }): PoolProxy {
  return {
    list: async () => describeConnections(await opts.catalog(), opts.describe ?? {}),
    tools: (connection) => opts.pool.tools(connection),
    call: (req) => opts.pool.call(req),
  };
}
