// The first test of X-133 (HS-1): does Claude Code expand `${VAR}` in a
// user-scope MCP header? If it does, `connect claude-code` writes the entry
// and the bearer never reaches disk; if it did not, the verb would print the
// `claude mcp add` line instead. This is the test that decided it (Claude Code
// 2.1.259, 2026-10-19: it does), and it re-asks the real tool on every machine
// that has one, so a release that stops expanding the variable fails here
// rather than in a user's session as a 401.
//
// It runs the real `claude` against a throwaway server that records the
// Authorization header it receives, with HOME and CLAUDE_CONFIG_DIR in a temp
// directory — nothing of the developer's own Claude Code configuration is read
// or written. Skipped where `claude` is not installed (CI).
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeConfigFile, HARNESSES } from "../src/connect.js";
import { realExec } from "../src/exec.js";

function findClaude(): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  for (const d of dirs) if (d && existsSync(join(d, "claude"))) return join(d, "claude");
  return undefined;
}
const CLAUDE = findClaude();

describe.skipIf(CLAUDE === undefined)("Claude Code expands ${VAR} in a user-scope MCP header (live)", () => {
  let server: Server | undefined;
  afterAll(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it("the entry connect writes reaches the server as `Bearer <the variable's value>`, and the file never holds the value", { timeout: 90_000 }, async () => {
    const seen: Array<string | undefined> = [];
    server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let rpc: { id?: number; method?: string } = {};
        try {
          rpc = JSON.parse(body);
        } catch {
          /* a GET (the SSE probe) carries no body */
        }
        res.setHeader("content-type", "application/json");
        if (rpc.method === "initialize") res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } } }));
        else if (rpc.method === "tools/list") res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } }));
        else {
          res.statusCode = 202;
          res.end();
        }
      });
    });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const home = await mkdtemp(join(tmpdir(), "metistry-claude-live-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
    const varName = "METISTRY_AGENT_TOKEN_CLAUDE_CODE";
    const value = "live-probe-bearer-0123456789";

    // through the registry entry, with the real tool as the exec
    const w = await HARNESSES["claude-code"].config!.write({ home, env, exec: realExec, key: "metistry", mcpUrl, varName });
    expect(w.state).toBe("written");
    const file = claudeConfigFile(home, env);
    expect(readFileSync(file, "utf8")).not.toContain(value);

    const list = await realExec(CLAUDE!, ["mcp", "list"], { env: { ...env, [varName]: value }, timeoutMs: 75_000 });
    expect(list.stdout).toContain("Connected");
    expect(seen.filter((a) => a !== undefined).every((a) => a === `Bearer ${value}`)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);

    // and the file still holds a reference, not the value, after Claude Code has used it
    expect(readFileSync(file, "utf8")).not.toContain(value);
    expect(readFileSync(file, "utf8")).toContain("Bearer ${METISTRY_AGENT_TOKEN_CLAUDE_CODE}");
  });
});
