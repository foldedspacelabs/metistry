// knowledge_write — the assistant's brain-commit. Misuse first (invariant
// 8): the one-writer rule, the path rules, the grant fence, then the wire
// client against a bridge fake that speaks the reconciler's contract
// (status codes + envelope + CAS), and provenance stamping byte for byte.
// No database: the runs row is proven by the integration suite.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { createBrainServer, frontmatterSource, ownershipRefusal, sha256Text, stampProvenance, vaultBridgeWriter, writeKnowledge, type AgentPrincipal, type Db, type KnowledgeWriter, type VaultWriteRequest } from "../src/index.js";

const NOW = new Date("2026-09-07T15:04:05Z");
const assistant: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["Knowledge/"] }, projects: [] };
const narrow: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["Knowledge/Areas/Fsl"] }, projects: [] };
const external: AgentPrincipal = { id: "drey-dev", grants: { tier: "areas", areas: ["Knowledge/"] }, projects: [] };

function recorder(reply: (r: VaultWriteRequest) => Awaited<ReturnType<KnowledgeWriter>>): { writer: KnowledgeWriter; calls: VaultWriteRequest[] } {
  const calls: VaultWriteRequest[] = [];
  return {
    calls,
    writer: async (r) => {
      calls.push(r);
      return reply(r);
    },
  };
}
const okReply = (r: VaultWriteRequest) => ({ ok: true as const, path: r.path, sha256: sha256Text(r.content), bytes: Buffer.byteLength(r.content), created: r.expected_sha256 === "" });

describe("stampProvenance (§4.15)", () => {
  it("no frontmatter → exactly source + updated are prepended; the body is untouched", () => {
    const s = stampProvenance("# Now\n\nBusy.\n", "assistant", NOW);
    expect(s).toEqual({ ok: true, content: "---\nsource: assistant\nupdated: 2026-09-07\n---\n# Now\n\nBusy.\n", source: "assistant", updated: "2026-09-07" });
  });

  it("existing frontmatter → the two keys are set in place; every other line, comment and order survives byte for byte", () => {
    const input = "---\nid: 01J8Z3K9A2\ntitle: Drey   # the product\nsource: someone-else\narea: \"[[Drey]]\"\nupdated: 2020-01-01\npeople: [\"[[Ada]]\"]\n---\n\nBody with --- dashes\n";
    const s = stampProvenance(input, "assistant", NOW);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.content).toBe("---\nid: 01J8Z3K9A2\ntitle: Drey   # the product\nsource: assistant\narea: \"[[Drey]]\"\nupdated: 2026-09-07\npeople: [\"[[Ada]]\"]\n---\n\nBody with --- dashes\n");
    // missing keys are appended, nothing else invented
    const t = stampProvenance("---\ntitle: X\n---\nbody", "assistant", NOW);
    expect(t.ok && t.content).toBe("---\ntitle: X\nsource: assistant\nupdated: 2026-09-07\n---\nbody");
    // an empty block is a mapping too
    const e = stampProvenance("---\n---\nbody", "assistant", NOW);
    expect(e.ok && e.content).toBe("---\nsource: assistant\nupdated: 2026-09-07\n---\nbody");
    // CRLF frontmatter is normalized in the block only
    const c = stampProvenance("---\r\ntitle: X\r\n---\r\nbody\r\n", "assistant", NOW);
    expect(c.ok && c.content).toBe("---\ntitle: X\nsource: assistant\nupdated: 2026-09-07\n---\nbody\r\n");
  });

  it("source is the credential, never the argument: a self-declared source is overwritten", () => {
    const s = stampProvenance("---\nsource: user\n---\nx", "assistant", NOW);
    expect(s.ok && s.content).toContain("source: assistant");
    expect(s.ok && s.content).not.toContain("source: user");
  });

  it("refuses rather than guesses: invalid YAML, a non-mapping block, a multi-line value under a stamped key", () => {
    expect(stampProvenance("---\n: : :\n  - [\n---\nx", "assistant", NOW)).toMatchObject({ ok: false, message: /not valid YAML/ });
    expect(stampProvenance("---\n- a\n- b\n---\nx", "assistant", NOW)).toMatchObject({ ok: false, message: /mapping/ });
    expect(stampProvenance("---\nsource:\n  - a\n  - b\n---\nx", "assistant", NOW)).toMatchObject({ ok: false, message: /single-line/ });
  });
});

describe("writeKnowledge rules", () => {
  it("one writer (§4.11): an external principal is `forbidden` whatever the path, and the writer is never called", async () => {
    const { writer, calls } = recorder(okReply);
    const r = await writeKnowledge(external, { path: "Knowledge/now.md", content: "x", message: "m" }, writer, NOW);
    expect(r).toMatchObject({ ok: false, code: "forbidden", meta: { kind: "external", path: "Knowledge/now.md" } });
    expect(calls).toHaveLength(0);
  });

  it("path rules: only Knowledge/... with no traversal; the vault's protected files are unreachable by shape alone", async () => {
    const { writer, calls } = recorder(okReply);
    for (const bad of ["identity.yaml", "rules.yaml", "queries/x.yaml", "CLAUDE.md", "knowledge/now.md", "Knowledge", "Knowledge/", "/Knowledge/now.md", "Knowledge/../identity.yaml", "Knowledge/./x.md", ".git/config"]) {
      expect(await writeKnowledge(assistant, { path: bad, content: "x", message: "m" }, writer, NOW), bad).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("writes never exceed reads: outside the granted areas → forbidden; tier index/none → forbidden", async () => {
    const { writer, calls } = recorder(okReply);
    expect(await writeKnowledge(narrow, { path: "Knowledge/People/Ada.md", content: "x", message: "m" }, writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeKnowledge(narrow, { path: "Knowledge/Areas/Fslx/Y.md", content: "x", message: "m" }, writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeKnowledge({ ...assistant, grants: { tier: "index", areas: [] } }, { path: "Knowledge/now.md", content: "x", message: "m" }, writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls).toHaveLength(0);
    expect((await writeKnowledge(narrow, { path: "Knowledge/Areas/Fsl/Drey.md", content: "x", message: "m" }, writer, NOW)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("no writer → not_available (a capability gap, not a permission)", async () => {
    expect(await writeKnowledge(assistant, { path: "Knowledge/now.md", content: "x", message: "m" }, undefined, NOW)).toMatchObject({ ok: false, code: "not_available" });
  });

  it("a markdown write is stamped and carries the intent in the principal's name; a non-markdown write is verbatim; CAS passes through", async () => {
    const { writer, calls } = recorder(okReply);
    const r = await writeKnowledge(assistant, { path: "Knowledge/now.md", content: "# Now\n", message: "now: shipped the write path", expected_sha256: "" }, writer, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0]).toEqual({
      path: "Knowledge/now.md",
      content: "---\nsource: assistant\nupdated: 2026-09-07\n---\n# Now\n",
      intent: { principal: "assistant", message: "now: shipped the write path", group: "assistant" },
      expected_sha256: "",
    });
    expect(r.result).toEqual({ path: "Knowledge/now.md", sha256: sha256Text(calls[0]!.content), bytes: calls[0]!.content.length, created: true, queued: true, provenance: { source: "assistant", updated: "2026-09-07" } });
    expect(r.meta).toMatchObject({ kind: "internal", tier: "areas", areas: ["Knowledge/"], path: "Knowledge/now.md", created: true, provenance: { source: "assistant" } });

    const csv = await writeKnowledge(assistant, { path: "Knowledge/Attachments/data.csv", content: "a,b\n1,2\n", message: "data" }, writer, NOW);
    expect(csv.ok && csv.result.provenance).toBeNull();
    expect(calls[1]).toMatchObject({ content: "a,b\n1,2\n" });
    expect(calls[1]!.expected_sha256).toBe(""); // omitted = create only; there is no unconditional write

    const badFm = await writeKnowledge(assistant, { path: "Knowledge/x.md", content: "---\n- list\n---\n", message: "m" }, writer, NOW);
    expect(badFm).toMatchObject({ ok: false, code: "invalid_request", message: /mapping/ });
  });

  // Misuse test (invariant 8): the owner edits notes in Knowledge/ by hand —
  // Obsidian, an editor, another device — and the assistant must never
  // replace bytes it has not seen. Enforced at the tool: there is no way to
  // ask for an unconditional write.
  it("never clobbers: an omitted expected_sha256 reaches the bridge as create-only, and an existing note is a conflict", async () => {
    const { writer, calls } = recorder(okReply);
    await writeKnowledge(assistant, { path: "Knowledge/Areas/New.md", content: "# New\n", message: "m" }, writer, NOW);
    expect(calls[0]!.expected_sha256).toBe(""); // "must not exist", every time

    const current = "c".repeat(64);
    const taken = recorder(() => ({ ok: false, code: "conflict", current_sha256: current }));
    const r = await writeKnowledge(assistant, { path: "Knowledge/Areas/Mine.md", content: "mine", message: "m" }, taken.writer, NOW);
    expect(r).toMatchObject({ ok: false, code: "conflict", meta: { current_sha256: current, create_only: true } });
    expect(r.ok === false && r.message).toMatch(/already exists.*knowledge_read/s);
    // and a retry cannot ask for less: the same call is the same refusal
    expect(await writeKnowledge(assistant, { path: "Knowledge/Areas/Mine.md", content: "mine", message: "m" }, taken.writer, NOW)).toMatchObject({ ok: false, code: "conflict" });
    expect(taken.calls.every((c) => c.expected_sha256 !== undefined)).toBe(true);
  });

  it("conflict: the current hash rides in the message and the audit meta so the agent can re-read; a vanished note says so", async () => {
    const cur = "a".repeat(64);
    const { writer } = recorder(() => ({ ok: false, code: "conflict", current_sha256: cur }));
    const r = await writeKnowledge(assistant, { path: "Knowledge/now.md", content: "x", message: "m", expected_sha256: "b".repeat(64) }, writer, NOW);
    expect(r).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining(cur), meta: { current_sha256: cur } });
    const gone = recorder(() => ({ ok: false, code: "conflict", current_sha256: null }));
    expect(await writeKnowledge(assistant, { path: "Knowledge/now.md", content: "x", message: "m", expected_sha256: cur }, gone.writer, NOW)).toMatchObject({ ok: false, code: "conflict", message: /no longer exists/ });
    // every other bridge refusal passes through untouched (the vault's protected-path rule included)
    const forb = recorder(() => ({ ok: false, code: "forbidden" }));
    expect(await writeKnowledge(assistant, { path: "Knowledge/x.md", content: "x", message: "m" }, forb.writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

// A bridge fake speaking the reconciler's contract: bearer, CAS on the
// content hash, protected paths for non-user principals, the envelope.
describe("vaultBridgeWriter (wire contract)", () => {
  let server: Server;
  let base: string;
  const files = new Map<string, string>();
  const seen: unknown[] = [];
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== "Bearer bridge-tok") return send(401, { error: { code: "unauthenticated", message: "authentication required" } });
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/vault/read") {
        const p = url.searchParams.get("path") ?? "";
        const c = files.get(p);
        return c === undefined ? send(404, { error: { code: "not_found", message: "not found" } }) : send(200, { path: p, content: c, sha256: sha(c), bytes: c.length });
      }
      if (req.method === "POST" && url.pathname === "/vault/write") {
        let raw = "";
        for await (const ch of req) raw += ch;
        const b = JSON.parse(raw);
        seen.push(b);
        if (!b.intent?.principal || !b.intent?.message) return send(400, { error: { code: "invalid_request", message: "intent required" } });
        if (/^(identity\.yaml|rules\.yaml|queries\/)/.test(b.path) && b.intent.principal !== "user") return send(403, { error: { code: "forbidden", message: "not granted" } });
        if (b.content.length > 100) return send(400, { error: { code: "invalid_request", message: "content exceeds 100 bytes" } });
        const cur = files.get(b.path);
        if (b.expected_sha256 !== undefined && (cur === undefined ? "" : sha(cur)) !== b.expected_sha256) return send(409, { error: { code: "conflict", message: "conflict" } });
        files.set(b.path, b.content);
        return send(cur === undefined ? 201 : 200, { path: b.path, sha256: sha(b.content), bytes: b.content.length, created: cur === undefined, queued: true });
      }
      if (url.pathname === "/boom") return send(500, "not json");
      send(404, { error: { code: "not_found", message: "not found" } });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const intent = { principal: "assistant", message: "m" };

  it("create (201) and update (200) map to the outcome; the request carries path, content, intent and only a given expected_sha256", async () => {
    const w = vaultBridgeWriter({ url: `${base}/`, token: "bridge-tok" });
    const a = await w({ path: "Knowledge/now.md", content: "v1", intent, expected_sha256: "" });
    expect(a).toEqual({ ok: true, path: "Knowledge/now.md", sha256: sha("v1"), bytes: 2, created: true });
    expect(seen.at(-1)).toEqual({ path: "Knowledge/now.md", content: "v1", intent, expected_sha256: "" });
    const b = await w({ path: "Knowledge/now.md", content: "v2", intent: { ...intent, group: "assistant" }, expected_sha256: sha("v1") });
    expect(b).toEqual({ ok: true, path: "Knowledge/now.md", sha256: sha("v2"), bytes: 2, created: false });
    const c = await w({ path: "Knowledge/now.md", content: "v3", intent });
    expect(c.ok).toBe(true);
    expect("expected_sha256" in (seen.at(-1) as object)).toBe(false);
  });

  it("409 → conflict with the hash now on disk (one read), or null when the note is gone", async () => {
    const w = vaultBridgeWriter({ url: base, token: "bridge-tok" });
    expect(await w({ path: "Knowledge/now.md", content: "v4", intent, expected_sha256: sha("v1") })).toEqual({ ok: false, code: "conflict", current_sha256: sha("v3") });
    expect(await w({ path: "Knowledge/gone.md", content: "x", intent, expected_sha256: sha("v1") })).toEqual({ ok: false, code: "conflict", current_sha256: null });
  });

  it("the vault's refusals pass through with their message: protected path → forbidden, size cap → invalid_request", async () => {
    const w = vaultBridgeWriter({ url: base, token: "bridge-tok" });
    expect(await w({ path: "identity.yaml", content: "name: X", intent })).toEqual({ ok: false, code: "forbidden", message: "not granted" });
    expect(await w({ path: "Knowledge/big.md", content: "x".repeat(101), intent })).toEqual({ ok: false, code: "invalid_request", message: "content exceeds 100 bytes" });
  });

  it("a wrong bridge credential is a deployment fault, reported as not_available — never as the agent's `forbidden`; a non-JSON 5xx is not_available too", async () => {
    const w = vaultBridgeWriter({ url: base, token: "wrong" });
    expect(await w({ path: "Knowledge/now.md", content: "x", intent })).toMatchObject({ ok: false, code: "not_available", message: /METISTRY_BRIDGE_TOKEN_RECONCILER/ });
    const boom = vaultBridgeWriter({ url: base, token: "bridge-tok", fetch: (input, init) => fetch(`${base}/boom`, init) });
    expect(await boom({ path: "Knowledge/now.md", content: "x", intent })).toEqual({ ok: false, code: "not_available", message: undefined });
  });
});

describe("the tool over MCP (fake db)", () => {
  let server: Server;
  let base: string;
  const runs: string[] = [];
  const db: Db = {
    async query(text) {
      if (text.startsWith("INSERT INTO runs")) {
        runs.push("start");
        return { rows: [{ id: 1 }] };
      }
      if (text.startsWith("UPDATE runs")) runs.push("finish");
      return { rows: [] };
    },
  };
  const { writer, calls } = recorder(okReply);
  beforeAll(async () => {
    const brain = createBrainServer({
      db,
      authenticate: async (req) => (req.headers.authorization === "Bearer int" ? assistant : req.headers.authorization === "Bearer ext" ? external : null),
      tasks: new TasksService(db),
      inboxDir: "/tmp/unused",
      writeKnowledge: writer,
    });
    server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function call(token: string, args: Record<string, unknown>) {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const r = (await client.callTool({ name: "knowledge_write", arguments: args })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    const text = r.content[0]!.text.split("\n")[0]!;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text; // the SDK's own schema refusal ("MCP error -32602 ...") is not an envelope
    }
    return { isError: !!r.isError, body };
  }

  it("knowledge_write is listed for everyone, refused for the external agent with the uniform envelope, and a runs row either way", async () => {
    const ext = await call("ext", { path: "Knowledge/now.md", content: "x", message: "m" });
    expect(ext).toEqual({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(calls).toHaveLength(0);
    const int = await call("int", { path: "Knowledge/now.md", content: "# Now\n", message: "now", expected_sha256: "" });
    expect(int.isError).toBe(false);
    expect(int.body).toMatchObject({ path: "Knowledge/now.md", created: true, queued: true, provenance: { source: "assistant" } });
    expect(calls[0]?.intent).toEqual({ principal: "assistant", message: "now", group: "assistant" });
    expect(runs).toEqual(["start", "finish", "start", "finish"]);
    // schema: a malformed expected_sha256 never reaches the body (the SDK refuses it before our wrapper runs)
    const bad = await call("int", { path: "Knowledge/now.md", content: "x", message: "m", expected_sha256: "nope" });
    expect(bad.isError).toBe(true);
    expect(String(bad.body)).toMatch(/expected_sha256|invalid/i);
    expect(calls).toHaveLength(1);
  });
});

// One writer, but not one owner: the evening fold may keep its own pages
// current and create new ones, and must not edit the user's. Enforced HERE,
// not in the prompt (CLAUDE.md: "enforce at the tool, never by prompting").
describe("writeKnowledge ownership (the fold's rule 2)", () => {
  const note = (source: string | null) => (source === null ? "# Ada\n" : `---\nid: 01J8\nsource: ${source}\nupdated: 2026-09-01\n---\n# Ada\n`);
  const PATH = "Knowledge/People/Ada.md";
  const reader = (content: string | null) => async () => content;

  it("reads the `source` out of frontmatter, and only a scalar one", () => {
    expect(frontmatterSource(note("user"))).toBe("user");
    expect(frontmatterSource(note(null))).toBe(null);
    expect(frontmatterSource("---\nsource:\n  - a\n---\nx")).toBe(null);
    expect(ownershipRefusal(note("user"), "assistant")).toBe("owned by user; propose instead");
    expect(ownershipRefusal(note("assistant"), "assistant")).toBe(null);
    expect(ownershipRefusal(note("knowledge-fold"), "assistant")).toBe(null);
    expect(ownershipRefusal(note(null), "assistant")).toBe(null);
  });

  it("a note the user owns is refused, and the writer is never called — report instead", async () => {
    const { writer, calls } = recorder(okReply);
    const r = await writeKnowledge(assistant, { path: PATH, content: "# Ada\n", message: "m" }, writer, NOW, reader(note("user")));
    expect(r).toMatchObject({ ok: false, code: "forbidden", message: "owned by user; propose instead", meta: { owned_by: "user" } });
    expect(calls).toHaveLength(0);
    // another agent's note is just as much not the assistant's
    expect(await writeKnowledge(assistant, { path: PATH, content: "x", message: "m" }, writer, NOW, reader(note("drey-dev")))).toMatchObject({
      ok: false,
      code: "forbidden",
      message: "owned by drey-dev; propose instead",
    });
    expect(calls).toHaveLength(0);
  });

  it("its own notes, the fold's notes, unsourced notes and NEW notes all go through", async () => {
    const { writer, calls } = recorder(okReply);
    for (const existing of [note("assistant"), note("knowledge-fold"), note(null), null]) {
      expect((await writeKnowledge(assistant, { path: PATH, content: "# Ada\n", message: "m" }, writer, NOW, reader(existing))).ok, String(existing).slice(0, 40)).toBe(true);
    }
    expect(calls).toHaveLength(4);
  });

  it("a read that fails refuses the write rather than waving it through", async () => {
    const { writer, calls } = recorder(okReply);
    const dead = async () => {
      throw new Error("bridge down");
    };
    expect(await writeKnowledge(assistant, { path: PATH, content: "x", message: "m" }, writer, NOW, dead)).toMatchObject({ ok: false, code: "not_available", message: /who owns it/ });
    expect(calls).toHaveLength(0);
  });

  it("non-markdown paths carry no frontmatter, so there is nothing to own", async () => {
    const { writer, calls } = recorder(okReply);
    expect((await writeKnowledge(assistant, { path: "Knowledge/Attachments/data.csv", content: "a,b\n", message: "m" }, writer, NOW, reader(note("user")))).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
