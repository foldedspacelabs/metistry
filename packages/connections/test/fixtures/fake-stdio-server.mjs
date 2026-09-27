// A stdio MCP server for the pool's tests. It writes its pid to FAKE_MARKER
// the moment it starts — so a test can prove a refused call never started
// it — and offers a few tools:
//
//   echo           returns its arguments
//   env            returns this process's whole environment (what the pool gave it)
//   secret_echo    returns FAKE_SECRET — to prove a value coming back is redacted
//   search_issues  marked read-only (a hint)
//   delete_issue   a destructive tool
//
// FAKE_TOOLS narrows the list (comma-separated), to test a dropped tool.
import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FAKE_MARKER) writeFileSync(process.env.FAKE_MARKER, String(process.pid));
if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, "");

const ALL = ["echo", "env", "secret_echo", "search_issues", "delete_issue"];
const offered = (process.env.FAKE_TOOLS ?? ALL.join(",")).split(",").filter(Boolean);
const server = new Server({ name: "fake-stdio", version: "1" }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: offered.map((name) => ({
    name,
    description: `the ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(name === "search_issues" ? { annotations: { readOnlyHint: true } } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, `${name}\n`);
  if (!offered.includes(name)) return { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
  if (name === "env") return { content: [{ type: "text", text: JSON.stringify(process.env) }] };
  if (name === "secret_echo") return { content: [{ type: "text", text: `the secret is ${process.env.FAKE_SECRET ?? "(unset)"}` }] };
  if (name === "pid") return { content: [{ type: "text", text: String(process.pid) }] };
  return { content: [{ type: "text", text: JSON.stringify({ tool: name, args, pid: process.pid }) }] };
});

process.stderr.write("fake-stdio: ready\n");
await server.connect(new StdioServerTransport());
