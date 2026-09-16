// `metistry runs export` (S5). Misuse first: an audit export that is
// quietly incomplete is worse than one that failed, so the assertions that
// matter are about truncation, credentials and what reaches stdout.
import { describe, expect, it } from "vitest";
import { runsExport, renderRunsExport } from "../src/runs.js";

const OWNER = "local-owner-token-never-printed";

/** A console serving NDJSON at /api/runs/export, and the usual refusals everywhere else. */
function fakeConsole(opts: { lines?: string[]; status?: number; body?: unknown; truncate?: boolean; requireToken?: string }) {
  const urls: string[] = [];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u));
    urls.push(url.pathname + url.search);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (token !== `Bearer ${opts.requireToken ?? OWNER}`) {
      return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "authentication required" } }), { status: 401 });
    }
    if (opts.status !== undefined) {
      return new Response(JSON.stringify(opts.body ?? { error: { code: "invalid_request", message: "since is not in the form this server mints" } }), {
        status: opts.status,
        headers: { "content-type": "application/json" },
      });
    }
    const text = (opts.lines ?? []).map((l) => `${l}\n`).join("");
    const payload = opts.truncate ? text.slice(0, Math.max(1, text.length - 12)) : text;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // deliberately chopped mid-line between chunks: the reader must reassemble
        const bytes = new TextEncoder().encode(payload);
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

const line = (id: number, cursor: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ instance_id: "11111111-2222-4333-8444-555555555555", id, component: "console", kind: "tool", ...extra, cursor });

function base(fetchFn: typeof fetch) {
  const chunks: string[] = [];
  return {
    opts: {
      env: { METISTRY_LOCAL_OWNER_TOKEN: OWNER } as NodeJS.ProcessEnv,
      platform: "linux" as const,
      fetchFn,
      write: (c: string) => chunks.push(c),
    },
    chunks,
  };
}

describe("runs export (misuse)", () => {
  it("a stream that stops mid-line is an ERROR, with the cursor to resume from", async () => {
    const c = fakeConsole({ lines: [line(1, "t1|1"), line(2, "t2|2"), line(3, "t3|3")], truncate: true });
    const { opts } = base(c.fetchFn);
    await expect(runsExport(opts)).rejects.toThrow(/NOT a complete export.*--since t2\|2/s);
  });

  it("401 and 403 name the door rather than the symptom, and never print the token", async () => {
    const wrong = fakeConsole({ requireToken: "someone-else" });
    await expect(runsExport(base(wrong.fetchFn).opts)).rejects.toThrow(/refused the owner token \(401\)/);

    const forbidden = fakeConsole({ status: 403, body: { error: { code: "forbidden", message: "not granted" } } });
    const err = await runsExport(base(forbidden.fetchFn).opts).catch((e: Error) => e);
    expect(String(err)).toMatch(/403/);
    expect(String(err)).not.toContain(OWNER);
  });

  it("a 400 from a bad cursor is reported with the server's own reason", async () => {
    const c = fakeConsole({ status: 400 });
    await expect(runsExport({ ...base(c.fetchFn).opts, since: "yesterday" })).rejects.toThrow(/invalid_request/);
  });

  it("an unreachable console is named, and the message is redacted", async () => {
    const fetchFn = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { message: `connect ECONNREFUSED (${OWNER})` } });
    }) as unknown as typeof fetch;
    const err = await runsExport(base(fetchFn).opts).catch((e: Error) => e);
    expect(String(err)).toMatch(/console unreachable/);
    expect(String(err)).not.toContain(OWNER);
  });
});

describe("runs export", () => {
  it("writes every line through, reassembling chunks that split mid-line, and reports the resume cursor", async () => {
    const lines = [line(1, "t1|1"), line(2, "t2|2"), line(3, "t3|3", { tool: "knowledge_read" })];
    const c = fakeConsole({ lines });
    const { opts, chunks } = base(c.fetchFn);
    const r = await runsExport(opts);

    expect(r.lines).toBe(3);
    expect(r.cursor).toBe("t3|3");
    const written = chunks.join("");
    expect(written.trimEnd().split("\n")).toEqual(lines); // byte-identical passthrough, not a re-serialization
    expect(renderRunsExport(r)).toContain("--since t3|3");
  });

  it("nothing matching is zero lines and a plain sentence, not an error", async () => {
    const c = fakeConsole({ lines: [] });
    const { opts, chunks } = base(c.fetchFn);
    const r = await runsExport(opts);
    expect(r).toMatchObject({ lines: 0, cursor: null });
    expect(chunks.join("")).toBe("");
    expect(renderRunsExport(r)).toMatch(/no runs matched/);
  });

  it("every filter reaches the console as a query parameter, and nothing else does", async () => {
    const c = fakeConsole({ lines: [line(1, "t1|1")] });
    await runsExport({ ...base(c.fetchFn).opts, since: "2026-09-11T02:18:47Z|4", until: "2026-09-16T00:00:00Z", component: "reconciler", limit: 10 });
    const url = new URL(`http://x${c.urls[0]}`);
    expect(url.pathname).toBe("/api/runs/export");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      since: "2026-09-11T02:18:47Z|4",
      until: "2026-09-16T00:00:00Z",
      component: "reconciler",
      limit: "10",
    });

    const bare = fakeConsole({ lines: [] });
    await runsExport(base(bare.fetchFn).opts);
    expect(bare.urls[0]).toBe("/api/runs/export"); // no empty parameters invented
  });
});
