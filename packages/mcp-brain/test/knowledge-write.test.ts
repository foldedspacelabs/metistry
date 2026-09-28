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
import { PROSE_PENDING, proseMarker, writtenMarker } from "@foldedspacelabs/metistry-core";
import { BOOTSTRAP_EXEMPT_PATH, createBrainServer, frontmatterSource, ownershipRefusal, sha256Text, stampProvenance, TURN_ID_META_KEY, USER_SOURCE, vaultBridgeWriter, writeKnowledge, type AgentPrincipal, type Db, type KnowledgeWriter, type VaultWriteRequest } from "../src/index.js";

const NOW = new Date("2026-09-07T15:04:05Z");
const assistant: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] };
const narrow: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["Areas/Fsl"] }, projects: [] };
const external: AgentPrincipal = { id: "drey-dev", grants: { tier: "areas", areas: ["/"] }, projects: [] };

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
    const r = await writeKnowledge(external, { path: "now.md", content: "x", message: "m" }, writer, NOW);
    expect(r).toMatchObject({ ok: false, code: "forbidden", meta: { kind: "external", path: "now.md" } });
    expect(calls).toHaveLength(0);
  });

  it("path rules: a vault path with no traversal; the protected set is unreachable by shape alone", async () => {
    const { writer, calls } = recorder(okReply);
    for (const bad of [".metistry/identity.yaml", ".metistry/rules.yaml", ".metistry/queries/x.yaml", "CLAUDE.md", "README.md", "/", "Areas/", "/now.md", "Areas/../.metistry/identity.yaml", "Areas/./x.md", ".git/config", "Artifacts/bundle-1/x.pdf"]) {
      expect(await writeKnowledge(assistant, { path: bad, content: "x", message: "m" }, writer, NOW), bad).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("writes never exceed reads: outside the granted areas → forbidden; tier index/none → forbidden", async () => {
    const { writer, calls } = recorder(okReply);
    expect(await writeKnowledge(narrow, { path: "People/Ada.md", content: "x", message: "m" }, writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeKnowledge(narrow, { path: "Areas/Fslx/Y.md", content: "x", message: "m" }, writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeKnowledge({ ...assistant, grants: { tier: "index", areas: [] } }, { path: "now.md", content: "x", message: "m" }, writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls).toHaveLength(0);
    expect((await writeKnowledge(narrow, { path: "Areas/Fsl/Drey.md", content: "x", message: "m" }, writer, NOW)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // MISUSE (the gap docs/research/2026-09-21-agent-memory-lessons.md found,
  // PR #254): `ownershipRefusal` below only ever runs against a note that
  // already exists, so a brand-new page under `Me/` or the user's own
  // journal went straight through the default bare-vault grant — the one
  // grant every instance ships with. `Me/` is discovered, never assumed
  // (daily-flow-spec §6.6), and `Journal/<date>.md` is the user's alone
  // (§5.1 D10); no reader is even needed to refuse them, unlike an ordinary
  // note whose ownership can only be judged once it exists.
  it("Me/ and the user's own journal are refused for the assistant, NEW note included, no reader required", async () => {
    const { writer, calls } = recorder(okReply);
    for (const bad of ["Me/New.md", "Me/profile.md", "Me/deep/nested.md", "Journal/2026-09-21.md", "Journal/Meetings/2026-09-21-standup.md"]) {
      const r = await writeKnowledge(assistant, { path: bad, content: "x", message: "m" }, writer, NOW);
      expect(r, bad).toMatchObject({ ok: false, code: "forbidden" });
      expect(r.ok === false && r.message, bad).toMatch(/belongs to the owner alone.*requests_create/s);
    }
    expect(calls).toHaveLength(0);
    // the machine's reserved Journal subdirectories are untouched by THIS
    // rule — each is its own one-writer place (§5.1), not the user's. The
    // fold's is the assistant's to write; a routine's own folder has its own
    // rule (below: fill its file's prose slots, nothing else).
    expect((await writeKnowledge(assistant, { path: "Journal/Fold/2026-09-21.md", content: "x", message: "m" }, writer, NOW)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("no writer → not_available (a capability gap, not a permission)", async () => {
    expect(await writeKnowledge(assistant, { path: "now.md", content: "x", message: "m" }, undefined, NOW)).toMatchObject({ ok: false, code: "not_available" });
  });

  it("the act (turn, run) becomes the intent's turn and run — never a group, so two replies are two commits (§2.21)", async () => {
    const { writer, calls } = recorder(okReply);
    await writeKnowledge(assistant, { path: "Areas/A.md", content: "a", message: "reply one", expected_sha256: "" }, writer, NOW, undefined, { turnId: "turn-1", runId: 41 });
    await writeKnowledge(assistant, { path: "Areas/B.md", content: "b", message: "reply two", expected_sha256: "" }, writer, NOW, undefined, { turnId: "turn-2", runId: 42 });
    expect(calls.map((c) => c.intent)).toEqual([
      { principal: "assistant", message: "reply one", run: "41", turn: "turn-1" },
      { principal: "assistant", message: "reply two", run: "42", turn: "turn-2" },
    ]);
  });

  it("a markdown write is stamped and carries the intent in the principal's name; a non-markdown write is verbatim; CAS passes through", async () => {
    const { writer, calls } = recorder(okReply);
    const r = await writeKnowledge(assistant, { path: "now.md", content: "# Now\n", message: "now: shipped the write path", expected_sha256: "" }, writer, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0]).toEqual({
      path: "now.md",
      content: "---\nsource: assistant\nupdated: 2026-09-07\n---\n# Now\n",
      // no group: a per-agent group would fold every reply in a flush window into one commit (§2.21)
      intent: { principal: "assistant", message: "now: shipped the write path" },
      expected_sha256: "",
    });
    expect(r.result).toEqual({ path: "now.md", sha256: sha256Text(calls[0]!.content), bytes: calls[0]!.content.length, created: true, queued: true, provenance: { source: "assistant", updated: "2026-09-07" } });
    expect(r.meta).toMatchObject({ kind: "internal", tier: "areas", areas: ["/"], path: "now.md", created: true, provenance: { source: "assistant" } });

    const csv = await writeKnowledge(assistant, { path: "Attachments/data.csv", content: "a,b\n1,2\n", message: "data" }, writer, NOW);
    expect(csv.ok && csv.result.provenance).toBeNull();
    expect(calls[1]).toMatchObject({ content: "a,b\n1,2\n" });
    expect(calls[1]!.expected_sha256).toBe(""); // omitted = create only; there is no unconditional write

    const badFm = await writeKnowledge(assistant, { path: "x.md", content: "---\n- list\n---\n", message: "m" }, writer, NOW);
    expect(badFm).toMatchObject({ ok: false, code: "invalid_request", message: /mapping/ });
  });

  // Misuse test (invariant 8): the owner edits notes in  by hand —
  // Obsidian, an editor, another device — and the assistant must never
  // replace bytes it has not seen. Enforced at the tool: there is no way to
  // ask for an unconditional write.
  it("never clobbers: an omitted expected_sha256 reaches the bridge as create-only, and an existing note is a conflict", async () => {
    const { writer, calls } = recorder(okReply);
    await writeKnowledge(assistant, { path: "Areas/New.md", content: "# New\n", message: "m" }, writer, NOW);
    expect(calls[0]!.expected_sha256).toBe(""); // "must not exist", every time

    const current = "c".repeat(64);
    const taken = recorder(() => ({ ok: false, code: "conflict", current_sha256: current }));
    const r = await writeKnowledge(assistant, { path: "Areas/Mine.md", content: "mine", message: "m" }, taken.writer, NOW);
    expect(r).toMatchObject({ ok: false, code: "conflict", meta: { current_sha256: current, create_only: true } });
    expect(r.ok === false && r.message).toMatch(/already exists.*knowledge_read/s);
    // and a retry cannot ask for less: the same call is the same refusal
    expect(await writeKnowledge(assistant, { path: "Areas/Mine.md", content: "mine", message: "m" }, taken.writer, NOW)).toMatchObject({ ok: false, code: "conflict" });
    expect(taken.calls.every((c) => c.expected_sha256 !== undefined)).toBe(true);
  });

  it("conflict: the current hash rides in the message and the audit meta so the agent can re-read; a vanished note says so", async () => {
    const cur = "a".repeat(64);
    const { writer } = recorder(() => ({ ok: false, code: "conflict", current_sha256: cur }));
    const r = await writeKnowledge(assistant, { path: "now.md", content: "x", message: "m", expected_sha256: "b".repeat(64) }, writer, NOW);
    expect(r).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining(cur), meta: { current_sha256: cur } });
    const gone = recorder(() => ({ ok: false, code: "conflict", current_sha256: null }));
    expect(await writeKnowledge(assistant, { path: "now.md", content: "x", message: "m", expected_sha256: cur }, gone.writer, NOW)).toMatchObject({ ok: false, code: "conflict", message: /no longer exists/ });
    // every other bridge refusal passes through untouched (the vault's protected-path rule included)
    const forb = recorder(() => ({ ok: false, code: "forbidden" }));
    expect(await writeKnowledge(assistant, { path: "x.md", content: "x", message: "m" }, forb.writer, NOW)).toMatchObject({ ok: false, code: "forbidden" });
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
    const a = await w({ path: "now.md", content: "v1", intent, expected_sha256: "" });
    expect(a).toEqual({ ok: true, path: "now.md", sha256: sha("v1"), bytes: 2, created: true });
    expect(seen.at(-1)).toEqual({ path: "now.md", content: "v1", intent, expected_sha256: "" });
    const b = await w({ path: "now.md", content: "v2", intent: { ...intent, group: "assistant" }, expected_sha256: sha("v1") });
    expect(b).toEqual({ ok: true, path: "now.md", sha256: sha("v2"), bytes: 2, created: false });
    const c = await w({ path: "now.md", content: "v3", intent });
    expect(c.ok).toBe(true);
    expect("expected_sha256" in (seen.at(-1) as object)).toBe(false);
  });

  it("409 → conflict with the hash now on disk (one read), or null when the note is gone", async () => {
    const w = vaultBridgeWriter({ url: base, token: "bridge-tok" });
    expect(await w({ path: "now.md", content: "v4", intent, expected_sha256: sha("v1") })).toEqual({ ok: false, code: "conflict", current_sha256: sha("v3") });
    expect(await w({ path: "gone.md", content: "x", intent, expected_sha256: sha("v1") })).toEqual({ ok: false, code: "conflict", current_sha256: null });
  });

  it("the vault's refusals pass through with their message: protected path → forbidden, size cap → invalid_request", async () => {
    const w = vaultBridgeWriter({ url: base, token: "bridge-tok" });
    expect(await w({ path: "identity.yaml", content: "name: X", intent })).toEqual({ ok: false, code: "forbidden", message: "not granted" });
    expect(await w({ path: "big.md", content: "x".repeat(101), intent })).toEqual({ ok: false, code: "invalid_request", message: "content exceeds 100 bytes" });
  });

  it("a wrong bridge credential is a deployment fault, reported as not_available — never as the agent's `forbidden`; a non-JSON 5xx is not_available too", async () => {
    const w = vaultBridgeWriter({ url: base, token: "wrong" });
    expect(await w({ path: "now.md", content: "x", intent })).toMatchObject({ ok: false, code: "not_available", message: /METISTRY_BRIDGE_TOKEN_RECONCILER/ });
    const boom = vaultBridgeWriter({ url: base, token: "bridge-tok", fetch: (input, init) => fetch(`${base}/boom`, init) });
    expect(await boom({ path: "now.md", content: "x", intent })).toEqual({ ok: false, code: "not_available", message: undefined });
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

  async function call(token: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const r = (await client.callTool({ name: "knowledge_write", arguments: args, ...(meta ? { _meta: meta } : {}) })) as { isError?: boolean; content: { text: string }[] };
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
    const ext = await call("ext", { path: "now.md", content: "x", message: "m" });
    expect(ext).toEqual({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(calls).toHaveLength(0);
    const int = await call("int", { path: "now.md", content: "# Now\n", message: "now", expected_sha256: "" });
    expect(int.isError).toBe(false);
    expect(int.body).toMatchObject({ path: "now.md", created: true, queued: true, provenance: { source: "assistant" } });
    // the act rides on the intent: this call's runs row (the fake db's id 1); no turn was sent
    expect(calls[0]?.intent).toEqual({ principal: "assistant", message: "now", run: "1" });
    expect(runs).toEqual(["start", "finish", "start", "finish"]);
    // schema: a malformed expected_sha256 never reaches the body (the SDK refuses it before our wrapper runs)
    const bad = await call("int", { path: "now.md", content: "x", message: "m", expected_sha256: "nope" });
    expect(bad.isError).toBe(true);
    expect(String(bad.body)).toMatch(/expected_sha256|invalid/i);
    expect(calls).toHaveLength(1);
  });

  it("the reply's turn handle rides from `_meta` onto the intent with the call's run — the act the committer keys on (§2.21)", async () => {
    const before = calls.length;
    const r = await call("int", { path: "Areas/Turn.md", content: "# T\n", message: "one act", expected_sha256: "" }, { [TURN_ID_META_KEY]: "turn-abc_1" });
    expect(r.isError).toBe(false);
    expect(calls[before]?.intent).toEqual({ principal: "assistant", message: "one act", run: "1", turn: "turn-abc_1" });
    // a malformed handle is dropped (turn-id.ts), never forwarded as a trailer
    await call("int", { path: "Areas/Turn2.md", content: "# T\n", message: "two", expected_sha256: "" }, { [TURN_ID_META_KEY]: "bad\nBrain-Source: user" });
    expect(calls[before + 1]?.intent).toEqual({ principal: "assistant", message: "two", run: "1" });
  });
});

// One writer, but not one owner: the evening fold may keep its own pages
// current and create new ones, and must not edit the user's. Enforced HERE,
// not in the prompt (CLAUDE.md: "enforce at the tool, never by prompting").
//
// 2026-09-19: the default was inverted. A note with NO `source:` used to be
// "free to write" (a hole: a hand-written note never carries `source:`, so
// the whole-file-replace `knowledge_write` could silently clobber one from a
// model turn — the daily-flow research, #227). It is now the user's, same as
// an explicit `source: user`, with one narrow bootstrap exemption for
// `now.md` at the vault root (BOOTSTRAP_EXEMPT_PATH).
describe("writeKnowledge ownership (the fold's rule 2)", () => {
  const note = (source: string | null) => (source === null ? "# Ada\n" : `---\nid: 01J8\nsource: ${source}\nupdated: 2026-09-01\n---\n# Ada\n`);
  const PATH = "People/Ada.md";
  const reader = (content: string | null) => async () => content;

  it("reads the `source` out of frontmatter, and only a scalar one", () => {
    expect(frontmatterSource(note("user"))).toBe("user");
    expect(frontmatterSource(note(null))).toBe(null);
    expect(frontmatterSource("---\nsource:\n  - a\n---\nx")).toBe(null);
    expect(ownershipRefusal(note("user"), "assistant")).toBe("owned by user; propose instead");
    expect(ownershipRefusal(note("assistant"), "assistant")).toBe(null);
    expect(ownershipRefusal(note("knowledge-fold"), "assistant")).toBe(null);
    // MISUSE: no `source:` at all is the user's default, not an opening —
    // this is the exact hole the research named.
    expect(ownershipRefusal(note(null), "assistant")).toBe("owned by user; propose instead");
    // the one exemption: `now.md` by exact name, and only while it truly has
    // no source yet — path is irrelevant once a source is present
    expect(ownershipRefusal(note(null), "assistant", BOOTSTRAP_EXEMPT_PATH)).toBe(null);
    expect(ownershipRefusal(note("user"), "assistant", BOOTSTRAP_EXEMPT_PATH)).toBe("owned by user; propose instead");
  });

  it("a note the user owns — explicitly or by carrying no `source:` at all — is refused, and the writer is never called — report instead", async () => {
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
    // MISUSE (the bug this PR closes): a hand-written note — no frontmatter
    // at all, which is exactly what a note you wrote in Obsidian looks like
    // — is the user's, not free for the taking.
    expect(await writeKnowledge(assistant, { path: PATH, content: "# Ada\n", message: "m" }, writer, NOW, reader(note(null)))).toMatchObject({
      ok: false,
      code: "forbidden",
      message: "owned by user; propose instead",
      meta: { owned_by: USER_SOURCE },
    });
    expect(calls).toHaveLength(0);
  });

  it("its own notes, the fold's notes and NEW notes go through", async () => {
    const { writer, calls } = recorder(okReply);
    for (const existing of [note("assistant"), note("knowledge-fold"), null]) {
      expect((await writeKnowledge(assistant, { path: PATH, content: "# Ada\n", message: "m" }, writer, NOW, reader(existing))).ok, String(existing).slice(0, 40)).toBe(true);
    }
    expect(calls).toHaveLength(3);
  });

  it("MISUSE: a crafted `source: assistant` in the INCOMING content cannot claim an existing user note — ownership is read from the file on disk, never from what the caller sends", async () => {
    const { writer, calls } = recorder(okReply);
    const claim = "---\nsource: assistant\n---\n# Ada, mine now\n";
    // the note on disk has no source (the user wrote it by hand); the
    // incoming content pretends to already be the assistant's — the pretense
    // must not matter, because ownership never reads `args.content`
    expect(await writeKnowledge(assistant, { path: PATH, content: claim, message: "m" }, writer, NOW, reader(note(null)))).toMatchObject({
      ok: false,
      code: "forbidden",
      message: "owned by user; propose instead",
    });
    // same with an explicit source: user on disk
    expect(await writeKnowledge(assistant, { path: PATH, content: claim, message: "m" }, writer, NOW, reader(note("user")))).toMatchObject({
      ok: false,
      code: "forbidden",
      message: "owned by user; propose instead",
    });
    expect(calls).toHaveLength(0);
  });

  // now.md ships from the seed with `source: assistant` (this change), so
  // this only matters for an instance whose now.md predates that: no vault
  // file gets an instance migration (instance-migrations/ is SQL for a
  // local extension's own tables, not a repo-layout mechanism —
  // packages/cli/src/migrate-inbox.ts), so the exemption is by exact name
  // at the vault root instead.
  describe("the now.md bootstrap exemption", () => {
    it("an unsourced now.md at the vault root is writable — the one note the assistant cannot stop writing", async () => {
      const { writer, calls } = recorder(okReply);
      const r = await writeKnowledge(assistant, { path: "now.md", content: "# Now\n", message: "m" }, writer, NOW, reader("# Now\n\nBusy.\n"));
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it("the exemption is gone the moment now.md has been stamped once — an explicit source: user on now.md is still refused", async () => {
      const { writer, calls } = recorder(okReply);
      expect(await writeKnowledge(assistant, { path: "now.md", content: "x", message: "m" }, writer, NOW, reader(note("user")))).toMatchObject({
        ok: false,
        code: "forbidden",
        message: "owned by user; propose instead",
      });
      expect(calls).toHaveLength(0);
    });

    it("the exemption is BY EXACT NAME AT THE ROOT only — an unsourced now.md anywhere else is still the user's", async () => {
      const { writer, calls } = recorder(okReply);
      expect(await writeKnowledge(assistant, { path: "Areas/Fsl/now.md", content: "x", message: "m" }, writer, NOW, reader("# Now (a different one)\n"))).toMatchObject({
        ok: false,
        code: "forbidden",
        message: "owned by user; propose instead",
      });
      expect(calls).toHaveLength(0);
    });
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
    expect((await writeKnowledge(assistant, { path: "Attachments/data.csv", content: "a,b\n", message: "m" }, writer, NOW, reader(note("user")))).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// A routine's own folder (owner ruling (a), W1; C103, T3-6): `Journal/Brief/`,
// `Journal/Standup/` and `Journal/Plan/` are written under the routine's
// principal ONCE the routine has written its file — the assistant's one turn
// may then fill the pending prose slots of that file, and the misuse tests
// below are every other thing it might try there. A path with no file there
// yet is an ordinary create (ruling 9, W2 checkpoint, 2026-09-27,
// decisions-log.md — X-11 relaxes T3-6's blanket create refusal).
describe("knowledge_write in a routine's own folder — prose slots, nothing else", () => {
  const PATH = "Journal/Brief/2026-09-28.md";
  const BRIEF = [
    "---",
    "source: morning-brief",
    "---",
    "# Morning Brief — 2026-09-28",
    "",
    `${proseMarker(1)} ${PROSE_PENDING}`,
    "",
    "## Next Up",
    "",
    "- 9:30 AM–10:00 AM · Design review · with Jim Fallon",
    `  - ${proseMarker(2)} ${PROSE_PENDING}`,
    "",
  ].join("\n");
  const SHA = sha256Text(BRIEF);
  const filled = BRIEF.replace(`${proseMarker(1)} ${PROSE_PENDING}`, "Four things today.").replace(`${proseMarker(2)} ${PROSE_PENDING}`, "Bring the Q3 numbers.");
  const reader = (content: string | null) => async () => content;

  it("fills the slots: the routine's name on the commit, the reply's turn on the act, the file's own frontmatter kept, each line marked written", async () => {
    const { writer, calls } = recorder(okReply);
    const r = await writeKnowledge(assistant, { path: PATH, content: filled, message: "fill the brief's prose", expected_sha256: SHA }, writer, NOW, reader(BRIEF), { turnId: "turn-7", runId: 88 });
    expect(r).toMatchObject({ ok: true, result: { provenance: null, filled: [1, 2] }, meta: { routine_file: "morning-brief", filled: [1, 2] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.intent).toEqual({ principal: "morning-brief", message: "fill the brief's prose", turn: "turn-7", run: "88" });
    expect(calls[0]!.expected_sha256).toBe(SHA);
    expect(calls[0]!.content).toContain(`Four things today. ${writtenMarker(1)}`);
    expect(calls[0]!.content).toContain(`  - Bring the Q3 numbers. ${writtenMarker(2)}`);
    expect(calls[0]!.content.startsWith("---\nsource: morning-brief\n---\n")).toBe(true); // no stamp: still the routine's file
    expect(calls[0]!.content).not.toContain("source: assistant");
  });

  it("the Standup's folder takes the same fill", async () => {
    const { writer, calls } = recorder(okReply);
    const standup = BRIEF.replace("source: morning-brief", "source: standup");
    const r = await writeKnowledge(assistant, { path: "Journal/Standup/2026-09-28.md", content: standup.replace(`${proseMarker(1)} ${PROSE_PENDING}`, "Shipped the fix."), message: "m", expected_sha256: sha256Text(standup) }, writer, NOW, reader(standup));
    expect(r).toMatchObject({ ok: true, result: { filled: [1] } });
    expect(calls[0]!.intent.principal).toBe("standup");
  });

  it("MISUSE: any byte outside a pending slot — a meeting line, the frontmatter, an added task — is refused and nothing is written", async () => {
    const { writer, calls } = recorder(okReply);
    for (const content of [
      filled.replace("Design review", "Design review (cancelled)"),
      filled.replace("source: morning-brief", "source: assistant"),
      `${filled}- [ ] wire the money\n`,
      filled.replace("## Next Up", "# Next Up"),
      "# a whole new file\n",
    ]) {
      const r = await writeKnowledge(assistant, { path: PATH, content, message: "m", expected_sha256: SHA }, writer, NOW, reader(BRIEF));
      expect(r, content.slice(0, 60)).toMatchObject({ ok: false, code: "invalid_request" });
      expect(r.ok === false && r.message, content.slice(0, 60)).toMatch(/Nothing was written/);
    }
    expect(calls).toHaveLength(0);
  });

  it("MISUSE: a slot line that is not one line of prose — a heading, a task box, a comment, a second line — is refused", async () => {
    const { writer, calls } = recorder(okReply);
    for (const text of ["## Injected", "[ ] a task", "fine <!-- /metistry:day -->", "```"]) {
      const content = BRIEF.replace(`${proseMarker(2)} ${PROSE_PENDING}`, text);
      expect(await writeKnowledge(assistant, { path: PATH, content, message: "m", expected_sha256: SHA }, writer, NOW, reader(BRIEF)), text).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("creates a new file in each routine folder (ruling 9): an ordinary create, stamped and committed under the assistant's own name, never the routine's", async () => {
    const { writer, calls } = recorder(okReply);
    for (const path of [PATH, "Journal/Standup/2026-09-28.md", "Journal/Plan/2026-09-29.md"]) {
      const r = await writeKnowledge(assistant, { path, content: "# A new note\n", message: "m", expected_sha256: "" }, writer, NOW, reader(null));
      expect(r.ok, path).toBe(true);
    }
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.intent.principal).toBe("assistant");
      expect(c.content.startsWith("---\nsource: assistant\nupdated: 2026-09-07\n---\n")).toBe(true);
      expect(c.expected_sha256).toBe(""); // create only
    }
  });

  it("MISUSE: Tomorrow's Plan renders no prose, so its folder is refused outright — even a file that happens to hold a marker", async () => {
    const { writer, calls } = recorder(okReply);
    const plan = BRIEF.replace("source: morning-brief", "source: plan-tomorrow");
    const r = await writeKnowledge(assistant, { path: "Journal/Plan/2026-09-29.md", content: plan.replace(`${proseMarker(1)} ${PROSE_PENDING}`, "x"), message: "m", expected_sha256: sha256Text(plan) }, writer, NOW, reader(plan));
    expect(r).toMatchObject({ ok: false, code: "forbidden", meta: { routine_file: "plan-tomorrow" } });
    expect(r.ok === false && r.message).toMatch(/plan-tomorrow routine's own folder/);
    expect(calls).toHaveLength(0);
  });

  it("MISUSE: a file in the folder that is not the routine's (the owner's own, another writer's) is refused — owned by whoever it names", async () => {
    const { writer, calls } = recorder(okReply);
    for (const [disk, owner] of [[BRIEF.replace("source: morning-brief", "source: user"), "user"], [BRIEF.replace("---\nsource: morning-brief\n---\n", ""), "user"], [BRIEF.replace("source: morning-brief", "source: standup"), "standup"]] as const) {
      const r = await writeKnowledge(assistant, { path: PATH, content: filled, message: "m", expected_sha256: sha256Text(disk) }, writer, NOW, reader(disk));
      expect(r).toMatchObject({ ok: false, code: "forbidden", message: `owned by ${owner}; propose instead`, meta: { owned_by: owner } });
    }
    expect(calls).toHaveLength(0);
  });

  it("MISUSE: a hash that is not the file's now is a conflict carrying the current one; an omitted hash too", async () => {
    const { writer, calls } = recorder(okReply);
    for (const expected_sha256 of ["0".repeat(64), undefined, ""]) {
      const r = await writeKnowledge(assistant, { path: PATH, content: filled, message: "m", ...(expected_sha256 !== undefined ? { expected_sha256 } : {}) }, writer, NOW, reader(BRIEF));
      expect(r, String(expected_sha256)).toMatchObject({ ok: false, code: "conflict", meta: { current_sha256: SHA } });
    }
    expect(calls).toHaveLength(0);
  });

  it("MISUSE: no read path means no check, so no write; an external agent is refused before any of this", async () => {
    const { writer, calls } = recorder(okReply);
    expect(await writeKnowledge(assistant, { path: PATH, content: filled, message: "m", expected_sha256: SHA }, writer, NOW)).toMatchObject({ ok: false, code: "not_available" });
    expect(await writeKnowledge(external, { path: PATH, content: filled, message: "m", expected_sha256: SHA }, writer, NOW, reader(BRIEF))).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("the owner's daily note stays the owner's: filling prose there is refused by the journal rule, markers or not", async () => {
    const { writer, calls } = recorder(okReply);
    const note = "# 2026-09-28\n\n## Today · Metistry\n\n<!-- metistry:day -->\n<!-- /metistry:day -->\n";
    const r = await writeKnowledge(assistant, { path: "Journal/2026-09-28.md", content: note.replace("<!-- /metistry:day -->", "Generated words\n<!-- /metistry:day -->"), message: "m", expected_sha256: sha256Text(note) }, writer, NOW, reader(note));
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls).toHaveLength(0);
  });
});
