// A note's history on the console (design-build-plan §2.21, T10-4):
// `GET /api/knowledge/history` and `GET /api/knowledge/version`, over a fake of
// the reconciler's `/vault/log` and `/vault/show` — what is under test is the
// door's own rules, which no git and no database are needed to decide.
//
// Misuse first (invariant 8), and the ticket's bold line: a protected or
// non-vault path is refused and a bad revision is refused — here, before the
// bridge is asked (the bridge refuses both again on its own:
// apps/reconciler/test/history.test.ts). And the ruling U2 adds: no principal
// but the owner reads the history of the owner's notes. The four credential
// answers over real sockets are in console-routes.integration.test.ts.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import type { Principal } from "@foldedspacelabs/metistry-core";
import { knowledgeRoutes, vaultBridgeHistory, type KnowledgeCommit, type KnowledgeHistory } from "../src/knowledge-routes.js";

const OWNER: Principal = { id: "owner", role: "owner", scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" };
const wide = (role: Principal["role"], id: string): Principal => ({ id, role, scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" });
const NOBODY: Principal = { id: "owner_token", role: "tool", scope: { tier: "none", areas: [], queries: false, projects: [] }, source: "registry" };
/** Every principal that is not the owner, at its widest — the whole vault, `queries: true`. */
const OTHERS: Principal[] = [
  { id: "scout", role: "agent", scope: { tier: "areas", areas: ["Areas/Health"], queries: false, projects: [] }, source: "registry" },
  wide("agent", "everything"),
  wide("assistant", "assistant"),
  wide("crew", "crew"),
  NOBODY,
];

const V1 = "1111111111111111111111111111111111111111";
const V2 = "2222222222222222222222222222222222222222";
const MOVED = "3333333333333333333333333333333333333333";

/** A `KnowledgeHistory` that records every call — "refused" is asserted as "and the bridge was never asked". */
function fakeHistory(entries: KnowledgeCommit[] = [], bytes = Buffer.from("# Plan\n\nv2\n")): KnowledgeHistory & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async log(path, limit) {
      calls.push(`log ${path} ${limit}`);
      return entries;
    },
    async show(path, sha) {
      calls.push(`show ${path} ${sha}`);
      if (sha.startsWith("dead")) throw new VaultError("not_found", `no commit ${sha}`);
      return { sha: V2, author: "Metistry assistant", date: "2026-09-26T22:53:01-04:00", subject: "Fold into the plan", source: "assistant", runs: ["42"], turns: ["t_fold-1"], path, content: bytes, sha256: "c".repeat(64), bytes: bytes.length };
    },
  };
}

/** A real ServerResponse over a detached socket (the harness knowledge-routes.test.ts uses). */
function capture(): { res: ServerResponse; read: () => { status: number; body: any } } {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  (res as unknown as { _send: unknown })._send = () => true;
  res.write = ((c: string | Buffer) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return true;
  }) as ServerResponse["write"];
  res.end = ((c?: string | Buffer) => {
    if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return res;
  }) as ServerResponse["end"];
  return { res, read: () => ({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }) };
}

async function route(op: "history" | "version", qs: string, principal: Principal = OWNER, history: KnowledgeHistory | null = fakeHistory(), audits: unknown[][] = []) {
  const c = capture();
  const key = `GET /api/knowledge/${op}`;
  await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, key, new URL(`http://x/api/knowledge/${op}${qs}`), history ? { history } : {}, principal, async (...a) => {
    audits.push(a);
  });
  return c.read();
}

describe("MISUSE: a note's history is the owner's alone", () => {
  it("refuses every other principal the console's uniform 403, and never asks the bridge", async () => {
    for (const op of ["history", "version"] as const) {
      for (const p of OTHERS) {
        const history = fakeHistory();
        const audits: unknown[][] = [];
        const r = await route(op, `?path=Areas/Health/sleep.md&sha=${V1}`, p, history, audits);
        expect(r.status, `${op} ${p.id}`).toBe(403);
        expect(r.body, `${op} ${p.id}`).toEqual({ error: { code: "forbidden", message: "not granted" } });
        expect(history.calls, `${op} ${p.id}`).toEqual([]);
        expect(audits[0]?.[2], `${op} ${p.id}`).toBe(false); // the refusal is on the record
      }
    }
  });
});

describe("MISUSE: a protected or non-vault path is refused before the bridge is asked", () => {
  it("classifies the machinery and the artifacts for the owner, and serves none of their history", async () => {
    for (const op of ["history", "version"] as const) {
      for (const [path, cls] of [
        [".metistry/compute.yaml", "machinery"],
        [".metistry/state/.env", "machinery"],
        [".metistry/rules.yaml", "machinery"],
        ["CLAUDE.md", "machinery"],
        ["Artifacts/report.pdf", "an artifact"],
      ] as const) {
        const history = fakeHistory();
        const r = await route(op, `?path=${encodeURIComponent(path)}&sha=${V1}`, OWNER, history);
        expect(r.status, `${op} ${path}`).toBe(400);
        expect(r.body, `${op} ${path}`).toMatchObject({ reason: "not_knowledge" });
        expect(r.body.error.message, `${op} ${path}`).toContain(`is ${cls}, not knowledge`);
        expect(history.calls, `${op} ${path}`).toEqual([]);
      }
      for (const path of ["../etc/passwd", "/etc/passwd", ".git/config", ".obsidian/app.json"]) {
        const history = fakeHistory();
        const r = await route(op, `?path=${encodeURIComponent(path)}&sha=${V1}`, OWNER, history);
        expect(r.status, `${op} ${path}`).toBe(400);
        expect(history.calls, `${op} ${path}`).toEqual([]);
      }
    }
  });

  it("requires the path by name", async () => {
    for (const op of ["history", "version"] as const) {
      const r = await route(op, `?sha=${V1}`);
      expect(r.status, op).toBe(400);
      expect(r.body.error.message, op).toContain("path is required");
    }
  });
});

describe("MISUSE: a bad revision is refused before the bridge is asked", () => {
  it("takes a commit id and nothing else — no ref, no `HEAD~1`, no option", async () => {
    for (const sha of ["", "HEAD", "HEAD~1", "main", "abc12", "--output=/tmp/x", "-p", `${V1}^`, `${V1}:Areas/Plan.md`, "g".repeat(40), "a".repeat(65), `${V1.slice(0, 10)} ${V1.slice(10)}`]) {
      const history = fakeHistory();
      const r = await route("version", `?path=Areas/Plan.md&sha=${encodeURIComponent(sha)}`, OWNER, history);
      expect(r.status, sha).toBe(400);
      expect(r.body.error.message, sha).toContain("sha must be a commit id");
      expect(history.calls, sha).toEqual([]);
    }
  });

  it("passes the bridge's not_found through — no such commit, not on this branch, or no such file then", async () => {
    const r = await route("version", "?path=Areas/Plan.md&sha=deadbeefdeadbeef");
    expect(r.status).toBe(404);
    expect(r.body.error).toEqual({ code: "not_found", message: "no commit deadbeefdeadbeef" });
  });
});

describe("GET /api/knowledge/history", () => {
  const ENTRIES: KnowledgeCommit[] = [
    { sha: MOVED, author: "Metistry user", date: "2026-09-26T23:00:00-04:00", subject: "Rename the plan", source: "user", runs: [], turns: [], path: "Areas/Roadmap.md", change: "renamed" },
    { sha: V2, author: "Metistry assistant", date: "2026-09-26T22:53:01-04:00", subject: "Fold into the plan", source: "assistant", runs: ["42"], turns: ["t_fold-1"], path: "Areas/Plan.md", change: "modified" },
    // a name that was never a note: the file was moved in from the machinery
    { sha: V1, author: "Owner", date: "2026-09-25T09:00:00+00:00", subject: "Move it out", source: null, runs: [], turns: [], path: ".metistry/plan.md", change: "added" },
  ];

  it("lists the file's commits newest first, named as the file was called then, with UTC times and the committer's provenance", async () => {
    const history = fakeHistory(ENTRIES);
    const audits: unknown[][] = [];
    const r = await route("history", "?path=Areas/Roadmap.md", OWNER, history, audits);
    expect(r.status).toBe(200);
    expect(history.calls).toEqual(["log Areas/Roadmap.md 50"]);
    expect(r.body).toMatchObject({ path: "Areas/Roadmap.md", limit: 50 });
    expect(r.body.commits).toEqual([
      { sha: MOVED, path: "Areas/Roadmap.md", change: "renamed", subject: "Rename the plan", author: "Metistry user", source: "user", runs: [], turns: [], at: "2026-09-27T03:00:00.000Z" },
      { sha: V2, path: "Areas/Plan.md", change: "modified", subject: "Fold into the plan", author: "Metistry assistant", source: "assistant", runs: ["42"], turns: ["t_fold-1"], at: "2026-09-27T02:53:01.000Z" },
    ]);
    expect(JSON.stringify(r.body)).not.toContain(".metistry");
    expect(audits[0]).toEqual(["knowledge", "history", true, { commits: 2, filtered: 1 }]);
  });

  it("an older bridge's entry — no trailers, no per-file fields — still reads", async () => {
    const r = await route("history", "?path=Areas/Plan.md", OWNER, fakeHistory([{ sha: V1, author: "Metistry user", date: "2026-09-25T09:00:00+00:00", subject: "Start" }]));
    expect(r.body.commits).toEqual([{ sha: V1, path: "Areas/Plan.md", change: null, subject: "Start", author: "Metistry user", source: null, runs: [], turns: [], at: "2026-09-25T09:00:00.000Z" }]);
  });

  it("refuses a limit out of range by name, and passes one in range to the bridge", async () => {
    for (const limit of ["0", "201", "1.5", "x"]) {
      const history = fakeHistory();
      expect((await route("history", `?path=Areas/Plan.md&limit=${limit}`, OWNER, history)).status, limit).toBe(400);
      expect(history.calls, limit).toEqual([]);
    }
    const history = fakeHistory();
    await route("history", "?path=Areas/Plan.md&limit=200", OWNER, history);
    expect(history.calls).toEqual(["log Areas/Plan.md 200"]);
  });

  it("answers 503 naming the variables when no vault bridge is configured", async () => {
    for (const op of ["history", "version"] as const) {
      const r = await route(op, `?path=Areas/Plan.md&sha=${V1}`, OWNER, null);
      expect(r.status, op).toBe(503);
      expect(r.body.error.message, op).toContain("METISTRY_RECONCILER_URL");
    }
  });
});

describe("GET /api/knowledge/version", () => {
  it("serves one note at one commit: its text, its hash and the commit it came from", async () => {
    const history = fakeHistory();
    const r = await route("version", `?path=Areas/Plan.md&sha=${V2.slice(0, 12)}`, OWNER, history);
    expect(r.status).toBe(200);
    expect(history.calls).toEqual([`show Areas/Plan.md ${V2.slice(0, 12)}`]);
    const { as_of, ...rest } = r.body;
    expect(typeof as_of).toBe("string");
    expect(rest).toEqual({
      path: "Areas/Plan.md",
      sha: V2,
      subject: "Fold into the plan",
      author: "Metistry assistant",
      source: "assistant",
      runs: ["42"],
      turns: ["t_fold-1"],
      at: "2026-09-27T02:53:01.000Z",
      content: "# Plan\n\nv2\n",
      sha256: "c".repeat(64),
      bytes: 11,
    });
  });
});

describe("vaultBridgeHistory: the bridge client", () => {
  it("asks /vault/log and /vault/show with the bearer and the parameters, and decodes the bytes", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: (init?.headers as Record<string, string>).authorization });
      if (url.includes("/vault/log")) return new Response(JSON.stringify({ path: "Areas/Plan.md", entries: [{ sha: V1, author: "a", date: "d", subject: "s" }] }));
      return new Response(JSON.stringify({ path: "Areas/Plan.md", sha: V1, author: "a", date: "d", subject: "s", content_base64: Buffer.from([0xff, 0x00, 0x41]).toString("base64"), sha256: "x", bytes: 3 }));
    }) as unknown as typeof fetch;
    const h = vaultBridgeHistory({ url: "http://127.0.0.1:7811/", token: "t", fetch: fetchFn });
    expect(await h.log("Areas/Plan.md", 7)).toEqual([{ sha: V1, author: "a", date: "d", subject: "s" }]);
    const v = await h.show("Areas/Plan.md", V1);
    expect(v.content.equals(Buffer.from([0xff, 0x00, 0x41]))).toBe(true);
    expect((v as unknown as Record<string, unknown>).content_base64).toBeUndefined();
    expect(seen).toEqual([
      { url: "http://127.0.0.1:7811/vault/log?path=Areas%2FPlan.md&limit=7", auth: "Bearer t" },
      { url: `http://127.0.0.1:7811/vault/show?path=Areas%2FPlan.md&sha=${V1}`, auth: "Bearer t" },
    ]);
  });

  it("maps the bridge's envelope onto a VaultError carrying its code and words", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { code: "forbidden", message: ".metistry/rules.yaml is not a vault note" } }), { status: 403 })) as unknown as typeof fetch;
    const h = vaultBridgeHistory({ url: "http://127.0.0.1:7811", token: "t", fetch: fetchFn });
    await expect(h.show(".metistry/rules.yaml", V1)).rejects.toMatchObject({ code: "forbidden", message: ".metistry/rules.yaml is not a vault note" });
    const down = vaultBridgeHistory({ url: "http://127.0.0.1:7811", token: "t", fetch: (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch });
    await expect(down.log("Areas/Plan.md", 5)).rejects.toMatchObject({ code: "not_available" });
  });
});
