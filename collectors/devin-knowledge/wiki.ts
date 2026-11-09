// The repo-wiki half of devin-knowledge, behind one seam.
//
// Why MCP and not `fetch`: Devin's v3 REST surface has no wiki route at all.
// `/v3/organizations/{org}/repositories/*` covers indexing status and
// nothing else (verified against docs.devin.ai's sitemap, 2026-09-15), and
// DeepWiki pages for PRIVATE repos are documented only as tools on the
// authenticated MCP server:
//
//   "The Devin MCP server is an authenticated service that provides access
//    to both public and private repositories" — /work-with-devin/devin-mcp
//   Base URL https://mcp.devin.ai/mcp (Streamable HTTP; the /sse endpoint is
//   deprecated), Authorization: Bearer cog_…, plus X-Org-Id for enterprise
//   service-user keys and PATs.
//
// A collector is not the assistant, so the one-MCP-server rule
// (`brainOptions`' `strictMcpConfig`, invariant 9) does not apply here: this
// is an ordinary HTTP client that happens to speak MCP, and it is the only
// place in the repo that mounts a foreign server.
//
// `ask_question` is deliberately never called: it is AI-powered synthesis
// that spends, and a collector never calls a model. Structure and contents
// are reads.
//
// The tools' INPUT SCHEMAS are not documented — the pages list tool names
// and prose only. So the argument name is read from `tools/list` at runtime
// rather than guessed; a guess that silently mismatches would look like "the
// repo has no wiki".

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const DEVIN_MCP_URL = "https://mcp.devin.ai/mcp";

export interface WikiPage {
  /** Best available page title — the block's first markdown heading, else a positional name. */
  title: string;
  body: string;
}

/**
 * One repo's wiki, as pages. Implementations resolve "no wiki / not
 * indexed / not permitted" to an empty array rather than throwing: a repo
 * the key cannot see must degrade, not fail the run.
 */
export interface WikiSource {
  pages(repo: string): Promise<WikiPage[]>;
  close(): Promise<void>;
}

interface McpTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] } | undefined;
}

/**
 * The property a wiki tool wants the repo in. Prefers a required string
 * property whose name mentions a repo, then any required property, then the
 * first declared one. Undefined when the schema declares nothing — the
 * caller then skips the tool rather than sending a body it invented.
 */
export function repoArgOf(tool: McpTool): string | undefined {
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  if (props.length === 0) return undefined;
  const required = tool.inputSchema?.required ?? [];
  const byName = props.find((p) => /repo/i.test(p) && (required.length === 0 || required.includes(p)));
  return byName ?? required.find((r) => props.includes(r)) ?? props[0];
}

/** Every text block in a tool result, in order. Non-text content is ignored. */
export function textBlocks(result: unknown): string[] {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    const text = (c as { type?: string; text?: unknown }).text;
    if ((c as { type?: string }).type === "text" && typeof text === "string" && text.trim() !== "") out.push(text);
  }
  return out;
}

/** The block's own first markdown heading, so a page keeps the name Devin gave it. */
export function headingOf(block: string, fallback: string): string {
  const m = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(block);
  const h = m?.[1]?.trim();
  return h && h.length > 0 ? h.slice(0, 200) : fallback;
}

export interface McpWikiOptions {
  /** the Authorization header — `Bearer {{ secret.x }}` when `fetchFn` is a connection's door, which fills it; the legacy key otherwise */
  authorization: string;
  /** Required for enterprise service-user keys and PATs; org-scoped keys resolve automatically. */
  orgId?: string | undefined;
  url?: string | undefined;
  /** Injectable for tests — the SDK transport takes a fetch implementation. */
  fetchFn?: typeof fetch | undefined;
}

/**
 * `read_wiki_contents` per repo over Streamable HTTP, split into one page
 * per text block (the server returns the wiki as a sequence of documents;
 * a server that returns one block yields one page, which is also correct).
 * `read_wiki_structure` is called only when contents came back empty — it
 * is the cheaper probe and its topic list is still worth capturing.
 */
export class McpWikiSource implements WikiSource {
  private client: Client | undefined;
  private tools: McpTool[] = [];

  constructor(private readonly opts: McpWikiOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "metistry-devin-knowledge", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url ?? DEVIN_MCP_URL), {
      requestInit: {
        headers: {
          authorization: this.opts.authorization,
          ...(this.opts.orgId ? { "x-org-id": this.opts.orgId } : {}),
        },
      },
      ...(this.opts.fetchFn ? { fetch: this.opts.fetchFn } : {}),
    });
    // `as unknown as Transport`: the SDK declares `sessionId` non-optional on
    // the interface and optional on the class, which exactOptionalPropertyTypes
    // refuses. Same cast, same reason, as mcp-brain's server transport.
    await client.connect(transport as unknown as Transport);
    this.client = client;
    this.tools = (await client.listTools()).tools as McpTool[];
    return client;
  }

  private async read(tool: string, repo: string): Promise<string[]> {
    const client = await this.connect();
    const t = this.tools.find((x) => x.name === tool);
    if (!t) return []; // the server does not expose it — degrade, do not guess
    const arg = repoArgOf(t);
    if (!arg) return [];
    return textBlocks(await client.callTool({ name: tool, arguments: { [arg]: repo } }));
  }

  async pages(repo: string): Promise<WikiPage[]> {
    const blocks = await this.read("read_wiki_contents", repo);
    const from = blocks.length > 0 ? blocks : await this.read("read_wiki_structure", repo);
    return from.map((body, i) => ({ title: headingOf(body, `${repo} wiki ${i + 1}`), body }));
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = undefined;
  }
}
