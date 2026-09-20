// What this bridge ADVERTISES, as a function anything can call.
//
// The same instinct as `check()` (CLAUDE.md: "every bridge and collector
// exports `check()` so `metistry doctor` is generic"): a bridge that can hand
// back its own tool definitions lets the definition-token budget be checked
// generically, by `ops/scripts/check-tool-surface.mjs`, instead of by a test
// each bridge has to remember to write. The manifest schema states the rule
// (>20 tools / >5k definition tokens, `packages/core/src/manifest.ts`); this
// is how a bridge lets CI measure it.
//
// It returns the EAGER surface — what a principal the owner has given no room
// sees — because that is the budget every agent pays. `propose_action` rides
// on a credential (docs/ops/actions.md) and is deliberately not counted here.
//
// Production's definitions, not a snapshot: the real server, a real
// `tools/list`, a `Db` that answers no rows. Listing tools does not run them,
// so nothing here needs Postgres.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { createBrainServer } from "./server.js";
import type { AgentPrincipal, Db } from "./types.js";

/** One advertised tool, exactly as `tools/list` returns it. */
export interface ToolDefinition {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

/** The principal the budget is measured for: a grant wide enough to see every eager tool, no autonomy record. */
const EAGER_PRINCIPAL: AgentPrincipal = { id: "surface", kind: "internal", grants: { tier: "areas", areas: [], queries: true }, projects: [] };

/** This bridge's eager `tools/list`, from the bridge itself. */
export async function toolSurface(): Promise<ToolDefinition[]> {
  const db: Db = { query: async () => ({ rows: [] }) };
  const brain = createBrainServer({ db, authenticate: async () => EAGER_PRINCIPAL, tasks: new TasksService(db), inboxDir: "/nonexistent-surface-inbox" });
  const http = createServer((req, res) => void brain.handle(req, res).catch(() => res.destroy()));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const port = (http.address() as AddressInfo).port;
    const client = new Client({ name: "metistry-tool-surface", version: "1" }, { capabilities: {} });
    // The cast is the SDK's `sessionId?: string` against this repo's exactOptionalPropertyTypes; same shape at runtime.
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}`), { requestInit: { headers: { authorization: "Bearer surface" } } }) as unknown as Transport);
    try {
      const { tools } = await client.listTools();
      return tools as ToolDefinition[];
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
