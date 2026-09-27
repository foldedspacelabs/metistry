// Resolve a conflict on the console (design-build-plan §2.11, T2-10):
// `POST /api/knowledge/conflicts/resolve {path, keep, seen_sha}` over a fake
// of the reconciler's `POST /vault/conflicts/resolve` — what is under test is
// the door's own rules. The bridge's (a path the index has in `conflict`, the
// side given up, history holding it) are apps/reconciler's
// conflict-resolve.integration.test.ts; the four credential answers over
// real sockets are console-routes.integration.test.ts; the review's
// `payload.error` (C45) is c45.integration.test.ts.
//
// Misuse first (invariant 8): no principal but the owner settles the owner's
// note, a body that is not the contract is refused before the bridge is
// asked, and a path that is not knowledge is the owner's classification. Then
// the ticket's bold line — **a path not in `conflict` is refused** — as the
// 409 `stale` with nothing to show, and the stale 409 with the conflict as it
// stands.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import type { Principal } from "@foldedspacelabs/metistry-core";
import { ConflictMoved, knowledgeRoutes, vaultBridgeConflicts, type ConflictRefusal, type ConflictState, type KnowledgeConflicts, type KnowledgeDeps } from "../src/knowledge-routes.js";

const OWNER: Principal = { id: "owner", role: "owner", scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" };
const wide = (role: Principal["role"], id: string): Principal => ({ id, role, scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" });
/** Every principal that is not the owner, at its widest. */
const OTHERS: Principal[] = [
  { id: "scout", role: "agent", scope: { tier: "areas", areas: ["Areas/Health"], queries: false, projects: [] }, source: "registry" },
  wide("agent", "everything"),
  wide("assistant", "assistant"),
  wide("crew", "crew"),
  { id: "owner_token", role: "tool", scope: { tier: "none", areas: [], queries: false, projects: [] }, source: "registry" },
];

const NOTE = "Areas/Health/sleep.md";
const COPY = "Areas/Health/sleep.sync-conflict-20260927-101500-ABCDEFG.md";
const MINE = "a".repeat(64);
const THEIRS = "b".repeat(64);
const CURRENT: ConflictState = { path: COPY, original: NOTE, sha256: THEIRS, original_sha256: MINE };

type Outcome = "ok" | "stale" | "settled" | { refuse: VaultError } | "throw";

/** A bridge that records every call — "refused" is asserted as "and the bridge was never asked". */
function fakeConflicts(outcome: Outcome = "ok"): KnowledgeConflicts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(path, keep, seenSha) {
      calls.push(`${path} ${keep} ${seenSha}`);
      if (outcome === "stale") throw new ConflictMoved(`${COPY} is not what you saw — look at both sides again before discarding one`, CURRENT);
      if (outcome === "settled") throw new ConflictMoved(`${path} is not in conflict — it was settled, or it never was`, null);
      if (outcome === "throw") throw new Error("ECONNRESET 10.0.0.9:7811 secret-ish detail");
      if (typeof outcome === "object") throw outcome.refuse;
      return { path: NOTE, copy: path, kept: keep, sha256: keep === "mine" ? MINE : THEIRS, bytes: 42, recorded: "c".repeat(40) };
    },
  };
}

function request(body: unknown): IncomingMessage {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
  return req;
}

/** A real ServerResponse over a detached socket (the harness knowledge-history.test.ts uses). */
function capture(): { res: ServerResponse; read: () => { status: number; body: any } } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
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

async function resolve(body: unknown, opts: { principal?: Principal; conflicts?: KnowledgeConflicts | null; refusals?: ConflictRefusal[]; audits?: unknown[][] } = {}) {
  const c = capture();
  const refusals = opts.refusals ?? [];
  const deps: KnowledgeDeps = {
    ...(opts.conflicts === null ? {} : { conflicts: opts.conflicts ?? fakeConflicts() }),
    conflictRefused: async (r) => {
      refusals.push(r);
    },
  };
  const key = "POST /api/knowledge/conflicts/resolve";
  await knowledgeRoutes(request(body), c.res, key, new URL("http://x/api/knowledge/conflicts/resolve"), deps, opts.principal ?? OWNER, async (...a) => {
    opts.audits?.push(a);
  });
  return c.read();
}

describe("MISUSE: settling a conflict is the owner's alone", () => {
  it("refuses every other principal the console's uniform 403, and never asks the bridge", async () => {
    for (const p of OTHERS) {
      const conflicts = fakeConflicts();
      const audits: unknown[][] = [];
      const refusals: ConflictRefusal[] = [];
      const r = await resolve({ path: COPY, keep: "mine", seen_sha: THEIRS }, { principal: p, conflicts, audits, refusals });
      expect(r.status, p.id).toBe(403);
      expect(r.body, p.id).toEqual({ error: { code: "forbidden", message: "not granted" } });
      expect(conflicts.calls, p.id).toEqual([]);
      expect(audits[0]?.[2], p.id).toBe(false); // the refusal is on the record
      expect(refusals, p.id).toEqual([]); // and it is not an answer to write on the review
    }
  });
});

describe("MISUSE: a body that is not {path, keep, seen_sha} is refused before the bridge is asked", () => {
  it("names the field, and writes nothing on the review", async () => {
    for (const [body, field] of [
      ["not json", "the body must be JSON"],
      [[], "path is required"],
      [{ keep: "mine", seen_sha: THEIRS }, "path is required"],
      [{ path: "  ", keep: "mine", seen_sha: THEIRS }, "path is required"],
      [{ path: COPY, seen_sha: THEIRS }, "keep must be one of mine | theirs"],
      [{ path: COPY, keep: "both", seen_sha: THEIRS }, "keep must be one of mine | theirs"],
      [{ path: COPY, keep: "Mine", seen_sha: THEIRS }, "keep must be one of mine | theirs"],
      [{ path: COPY, keep: "mine" }, "seen_sha must be the sha256 of the side you are giving up"],
      [{ path: COPY, keep: "mine", seen_sha: "4c1d2e3f" }, "seen_sha must be the sha256"],
      [{ path: COPY, keep: "mine", seen_sha: THEIRS.toUpperCase() }, "seen_sha must be the sha256"],
      [{ path: COPY, keep: "mine", seen_sha: null }, "seen_sha must be the sha256"],
    ] as const) {
      const conflicts = fakeConflicts();
      const refusals: ConflictRefusal[] = [];
      const r = await resolve(body, { conflicts, refusals });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.message, JSON.stringify(body)).toContain(field);
      expect(conflicts.calls, JSON.stringify(body)).toEqual([]);
      expect(refusals, JSON.stringify(body)).toEqual([]);
    }
  });

  it("classifies the machinery and the artifacts for the owner — not knowledge, so not a conflict this door settles", async () => {
    for (const [path, cls] of [
      [".metistry/compute.yaml", "machinery"],
      [".metistry/rules.sync-conflict-20260927-101500-ABCDEFG.yaml", "machinery"],
      ["CLAUDE.md", "machinery"],
      ["Artifacts/report.pdf", "an artifact"],
    ] as const) {
      const conflicts = fakeConflicts();
      const r = await resolve({ path, keep: "theirs", seen_sha: "" }, { conflicts });
      expect(r.status, path).toBe(400);
      expect(r.body, path).toMatchObject({ reason: "not_knowledge" });
      expect(r.body.error.message, path).toContain(`is ${cls}, not knowledge`);
      expect(conflicts.calls, path).toEqual([]);
    }
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config"]) {
      const conflicts = fakeConflicts();
      expect((await resolve({ path, keep: "mine", seen_sha: "" }, { conflicts })).status, path).toBe(400);
      expect(conflicts.calls, path).toEqual([]);
    }
  });
});

describe("MISUSE: **a path not in `conflict` is refused**", () => {
  it("409 `stale` with `conflict: null` — settled from another device, or never a conflict — and nothing on the review", async () => {
    for (const path of [COPY, NOTE]) {
      const refusals: ConflictRefusal[] = [];
      const audits: unknown[][] = [];
      const r = await resolve({ path, keep: "mine", seen_sha: THEIRS }, { conflicts: fakeConflicts("settled"), refusals, audits });
      expect(r.status, path).toBe(409);
      expect(r.body, path).toEqual({ error: { code: "conflict", message: `${path} is not in conflict — it was settled, or it never was` }, reason: "stale", conflict: null });
      expect(refusals, path).toEqual([]); // stale is not a failed answer (C45): the owner answered a conflict that is not there
      expect(audits[0], path).toEqual(["knowledge", "resolve_conflict", false, { keep: "mine", stale: true, in_conflict: false }]);
    }
  });
});

describe("the 409 for a side that moved", () => {
  it("carries the conflict as it stands, so the client repaints rather than re-fetches", async () => {
    const refusals: ConflictRefusal[] = [];
    const r = await resolve({ path: COPY, keep: "theirs", seen_sha: MINE }, { conflicts: fakeConflicts("stale"), refusals });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: { code: "conflict", message: `${COPY} is not what you saw — look at both sides again before discarding one` }, reason: "stale", conflict: CURRENT });
    expect(refusals).toEqual([]);
  });
});

describe("a settle", () => {
  it("answers {ok, path, kept, sha} — the note as it now stands — and passes the body through untouched", async () => {
    for (const [keep, seen, sha] of [
      ["mine", THEIRS, MINE],
      ["theirs", MINE, THEIRS],
      ["theirs", "", THEIRS], // no note beside the copy: nothing is given up
    ] as const) {
      const conflicts = fakeConflicts();
      const audits: unknown[][] = [];
      const r = await resolve({ path: ` ${COPY} `, keep, seen_sha: seen }, { conflicts, audits });
      expect(r.status, keep).toBe(200);
      expect(r.body, keep).toEqual({ ok: true, path: NOTE, kept: keep, sha });
      expect(conflicts.calls, keep).toEqual([`${COPY} ${keep} ${seen}`]);
      expect(audits.at(-1), keep).toEqual(["knowledge", "resolve_conflict", true, { keep, path: NOTE, copy: COPY, recorded: "c".repeat(40) }]);
    }
  });

  it("a bridge refusal passes through, and is written on the review (C45)", async () => {
    for (const err of [new VaultError("not_available", "the vault is mid-merge — finish it, then settle the conflict; nothing was discarded"), new VaultError("forbidden", "not granted"), new VaultError("invalid_request", `there is no ${NOTE} to keep — take the other, or settle it in Obsidian`)]) {
      const refusals: ConflictRefusal[] = [];
      const r = await resolve({ path: COPY, keep: "mine", seen_sha: THEIRS }, { conflicts: fakeConflicts({ refuse: err }), refusals });
      expect(r.body.error.code, err.code).toBe(err.code);
      expect(refusals, err.code).toEqual([{ path: COPY, keep: "mine", code: err.code, message: err.message }]);
    }
  });

  it("no bridge is 503 naming the two variables — and the review says it could not", async () => {
    const refusals: ConflictRefusal[] = [];
    const r = await resolve({ path: COPY, keep: "theirs", seen_sha: MINE }, { conflicts: null, refusals });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toContain("METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER");
    expect(refusals).toEqual([{ path: COPY, keep: "theirs", code: "not_available", message: r.body.error.message }]);
  });

  it("a bridge that threw: the review says `internal` with no detail, and the throw reaches the route's uniform 500", async () => {
    const refusals: ConflictRefusal[] = [];
    await expect(resolve({ path: COPY, keep: "mine", seen_sha: THEIRS }, { conflicts: fakeConflicts("throw"), refusals })).rejects.toThrow("ECONNRESET");
    expect(refusals).toEqual([{ path: COPY, keep: "mine", code: "internal", message: "the conflict could not be settled; the detail is in the console log" }]);
  });
});

describe("vaultBridgeConflicts — the client of the reconciler's POST /vault/conflicts/resolve", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const bridge = (status: number, body: unknown) =>
    vaultBridgeConflicts({
      url: "http://reconciler.test:7811/",
      token: "bridge-token",
      fetch: (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch,
    });

  it("sends {path, keep, expected_sha256} with the console's bearer, and reads the settle back", async () => {
    const settled = { path: NOTE, copy: COPY, kept: "mine", sha256: MINE, bytes: 42, recorded: null, queued: true };
    expect(await bridge(200, settled).resolve(COPY, "mine", THEIRS)).toEqual(settled);
    const last = calls.at(-1)!;
    expect(last.url).toBe("http://reconciler.test:7811/vault/conflicts/resolve");
    expect(last.init.method).toBe("POST");
    expect((last.init.headers as Record<string, string>).authorization).toBe("Bearer bridge-token");
    expect(JSON.parse(String(last.init.body))).toEqual({ path: COPY, keep: "mine", expected_sha256: THEIRS });
  });

  it("a 409 carrying `current` is ConflictMoved, with the conflict as it stands or null", async () => {
    for (const current of [CURRENT, null]) {
      const err = await bridge(409, { error: { code: "conflict", message: "moved" }, current })
        .resolve(COPY, "theirs", MINE)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictMoved);
      expect((err as ConflictMoved).current).toEqual(current);
      expect((err as ConflictMoved).message).toBe("moved");
    }
  });

  it("any other refusal is a VaultError with the bridge's code; an unknown code is the dependency being down", async () => {
    for (const [status, body, code] of [
      [403, { error: { code: "forbidden", message: "not granted" } }, "forbidden"],
      [400, { error: { code: "invalid_request", message: "keep must be one of: mine, theirs" } }, "invalid_request"],
      [503, { error: { code: "not_available", message: "no database" } }, "not_available"],
      [409, { error: { code: "conflict", message: "a 409 with no `current` is not a stale settle" } }, "conflict"],
      [502, { error: { code: "teapot" } }, "not_available"],
    ] as const) {
      const err = await bridge(status, body)
        .resolve(COPY, "mine", THEIRS)
        .catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(VaultError);
      expect((err as VaultError).code, String(status)).toBe(code);
    }
  });
});
