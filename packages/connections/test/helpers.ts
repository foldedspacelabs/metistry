// Fakes for the pool's tests: an in-process Streamable HTTP MCP server that
// records every request it is sent, headers and body included, and builders
// for catalogs, so no test touches a real instance, the Keychain or the
// network (loopback only).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InstanceSecrets, buildRegistry, manifestKind, memoryKeychain, parseSecretsFile, type SecretsFile } from "@foldedspacelabs/metistry-core";
import { judgeConnection, type ConnectionCatalog } from "../src/index.js";

export const FAKE_STDIO = fileURLToPath(new URL("./fixtures/fake-stdio-server.mjs", import.meta.url));
export const INSTANCE_ID = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeHttp {
  url: string;
  origin: string;
  host: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/**
 * A Streamable HTTP MCP server, stateless: every POST gets a fresh server.
 * `echo_auth` returns the Authorization header it was sent, so a test can
 * prove what came back is redacted. `redirectTo` answers every request with
 * a 307 to another origin instead.
 */
export async function fakeHttpMcp(opts: { tools?: string[]; redirectTo?: string } = {}): Promise<FakeHttp> {
  const requests: Recorded[] = [];
  const tools = opts.tools ?? ["echo", "echo_auth", "search_issues"];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers }, body });
    if (opts.redirectTo) {
      res.writeHead(307, { location: opts.redirectTo }).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const auth = req.headers.authorization ?? "(none)";
    const server = new Server({ name: "fake-http", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object", properties: {} } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      if (r.params.name === "echo_auth") return { content: [{ type: "text", text: `you sent ${auth}` }] };
      return { content: [{ type: "text", text: JSON.stringify({ tool: r.params.name, args: r.params.arguments }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as never);
    await transport.handleRequest(req as never, res, body === "" ? undefined : JSON.parse(body));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

/** A catalog from connection files given as objects — judged exactly as files on disk are. */
export function catalogOf(files: Record<string, unknown>[], extra: { secrets?: string; variables?: Record<string, string>; types?: Record<string, unknown>[] } = {}): ConnectionCatalog {
  const registry = buildRegistry(
    manifestKind("connection-type"),
    (extra.types ?? []).map((m) => ({ path: `/seed/connection-types/${String((m as { name: string }).name)}/manifest.yaml`, origin: "product" as const, dirName: String((m as { name: string }).name), input: m })),
  );
  let secrets: ConnectionCatalog["secrets"];
  try {
    secrets = { ok: true, file: parseSecretsFile(extra.secrets ?? "") };
  } catch (err) {
    secrets = { ok: false, message: (err as Error).message };
  }
  return {
    entries: files.map((f) => judgeConnection(String((f as { name: string }).name), `/i/.metistry/connections/${String((f as { name: string }).name)}.yaml`, f, registry)),
    variables: { ok: true, file: { variables: extra.variables ?? {} } },
    secrets,
  };
}

/** One instance's secrets over an in-memory Keychain. */
export async function secretsWith(values: Record<string, string>): Promise<InstanceSecrets> {
  const s = new InstanceSecrets(memoryKeychain(), INSTANCE_ID);
  for (const [k, v] of Object.entries(values)) await s.set(k, v);
  return s;
}

export type { SecretsFile };
