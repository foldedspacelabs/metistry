// `metistry vault rollback` (M18, §2.21, T10-6): every rollback waits for
// Approve in Needs You. Without --include-config the verb raises the request
// and stops; with it, the verb waits for the answer and carries out an
// approved configuration rollback with the owner-class bearer — and nothing
// else, ever. Fetch is faked; no console, reconciler or instance is touched.
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/main.js";
import { momentArg, rollbackVault, type VaultRollbackOptions } from "../src/vault.js";

const CONSOLE = "http://127.0.0.1:9";
const RECONCILER = "http://127.0.0.1:10";
const LOCAL_TOKEN = "local-owner-token-for-tests";
const OWNER_BEARER = "owner-bridge-token-for-tests";
const HEAD = "a".repeat(40);
const ROLLED = "e".repeat(40);

const PREVIEW = {
  reverts: ["b".repeat(40)],
  files: ["Areas/Plan.md", ".metistry/compute.yaml"],
  skipped_config: [],
  config: [".metistry/compute.yaml"],
  include_config: true,
  head: HEAD,
  base: null,
  revert_count: 1,
  commits: [{ sha: "b".repeat(40), subject: "Compute: assign", author: "user", date: "2026-09-27T08:00:00-04:00" }],
  changes: [
    { path: "Areas/Plan.md", change: "modified" },
    { path: ".metistry/compute.yaml", change: "modified" },
  ],
};

function row(decision: string, over: Record<string, unknown> = {}) {
  return {
    id: "62",
    ts: "2026-09-27T12:00:00.000Z",
    kind: "improvement",
    source_agent: "console",
    decision,
    payload: { rollback: { target: { to: "2026-09-26T23:59:59-04:00" }, head: HEAD, files: PREVIEW.files, reverts: PREVIEW.reverts, skipped_config: [], include_config: true, config: PREVIEW.config } },
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: any;
}

/** The console and the reconciler, answering from a script of request states. */
function fakeWorld(states: string[], opts: { rowOver?: Record<string, unknown>; revertStatus?: number } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
    if (url === `${CONSOLE}/api/vault/rollback`) {
      return new Response(JSON.stringify({ ok: true, proposal_id: "62", raised: true, preview: { ...PREVIEW, include_config: body.include_config === true }, proposal: { id: "62", ts: "2026-09-27T12:00:00.000Z" } }), { status: 202 });
    }
    if (url.startsWith(`${CONSOLE}/api/proposals?since=`)) {
      const state = states[Math.min(polls++, states.length - 1)]!;
      return new Response(JSON.stringify({ proposals: [row(state, opts.rowOver)], cursor: "x", more: false }), { status: 200 });
    }
    if (url === `${RECONCILER}/vault/revert`) {
      return new Response(JSON.stringify(opts.revertStatus && opts.revertStatus !== 201 ? { error: { code: "conflict", message: "stale: the rollback would now change something other than what was approved" } } : { dry_run: false, sha: ROLLED, config: PREVIEW.config }), { status: opts.revertStatus ?? 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function options(world: ReturnType<typeof fakeWorld>, over: Partial<VaultRollbackOptions> = {}): VaultRollbackOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    target: { to: "2026-09-26" },
    includeConfig: false,
    env: { METISTRY_CONSOLE_URL: CONSOLE, METISTRY_LOCAL_OWNER_TOKEN: LOCAL_TOKEN, METISTRY_RECONCILER_URL: RECONCILER, METISTRY_BRIDGE_TOKEN_RECONCILER_USER: OWNER_BEARER },
    platform: "linux",
    fetchFn: world.fetchFn,
    out: (l) => lines.push(l),
    sleep: async () => {},
    pollMs: 1,
    lines,
    ...over,
  };
}

describe("metistry vault rollback", () => {
  it("raises the request through the console's local door and stops — nothing is reverted, the reconciler is never asked", async () => {
    const w = fakeWorld(["pending"]);
    const o = options(w, { target: { commit: "4c1d2e3f" } });
    const r = await rollbackVault(o);
    expect(r).toMatchObject({ proposal_id: "62", state: "waiting" });
    expect(w.calls).toEqual([{ url: `${CONSOLE}/api/vault/rollback`, method: "POST", auth: `Bearer ${LOCAL_TOKEN}`, body: { commit: "4c1d2e3f" } }]);
    expect(o.lines.join("\n")).toContain("raised in Needs You as request #62");
    expect(o.lines.join("\n")).toContain("Approve it in Needs You");
  });

  it("a day is the end of that day on this Mac's clock; a timestamp is sent as given", () => {
    expect(momentArg("2026-09-26")).toMatch(/^2026-09-26T23:59:59[+-]\d{2}:\d{2}$/);
    expect(momentArg("2026-09-26T08:00:00Z")).toBe("2026-09-26T08:00:00Z");
    expect(momentArg("2026-02-30")).toBe("2026-02-30");
  });

  it("--include-config waits for Approve, then reverts as the owner class — pinned to the preview, held to its change set", async () => {
    const w = fakeWorld(["pending", "pending", "allow"]);
    const o = options(w, { includeConfig: true });
    const r = await rollbackVault(o);
    expect(r).toEqual({ proposal_id: "62", state: "rolled_back", sha: ROLLED });
    expect(w.calls[0]!.body).toMatchObject({ include_config: true, to: expect.stringMatching(/^2026-09-26T23:59:59/) });
    const reverts = w.calls.filter((c) => c.url.endsWith("/vault/revert"));
    expect(reverts).toEqual([
      {
        url: `${RECONCILER}/vault/revert`,
        method: "POST",
        auth: `Bearer ${OWNER_BEARER}`,
        body: {
          intent: { principal: "user", message: "Approved in Needs You (request #62), made by metistry vault rollback --include-config." },
          to: "2026-09-26T23:59:59-04:00",
          include_config: true,
          head: HEAD,
          expect: { files: PREVIEW.files, reverts: PREVIEW.reverts, skipped_config: [] },
        },
      },
    ]);
    // each credential went only to its own door
    expect(w.calls.filter((c) => c.url.startsWith(CONSOLE)).every((c) => c.auth === `Bearer ${LOCAL_TOKEN}`)).toBe(true);
    expect(o.lines.join("\n")).toContain(`rolled back as you: ${ROLLED.slice(0, 12)}`);
  });

  it("declined, or answered otherwise: nothing is reverted", async () => {
    for (const state of ["deny", "accept_with_changes", "resolved_at_source"]) {
      const w = fakeWorld(["pending", state]);
      const r = await rollbackVault(options(w, { includeConfig: true }));
      expect(r.state, state).toBe(state === "deny" ? "declined" : "answered");
      expect(w.calls.filter((c) => c.url.endsWith("/vault/revert")), state).toEqual([]);
    }
  });

  it("a wait that runs out changes nothing and says how to resume; --request resumes it", async () => {
    const w = fakeWorld(["pending"]);
    const o = options(w, { includeConfig: true, waitMs: 0 });
    expect(await rollbackVault(o)).toMatchObject({ state: "timed_out" });
    expect(o.lines.join("\n")).toContain("metistry vault rollback --request 62");
    const later = fakeWorld(["allow"]);
    expect(await rollbackVault(options(later, { target: undefined, request: "62", includeConfig: true }))).toMatchObject({ state: "rolled_back" });
    expect(later.calls.some((c) => c.url.endsWith("/api/vault/rollback"))).toBe(false);
  });

  it("an approved row this console did not raise, or one without include_config, is never carried out", async () => {
    for (const over of [{ source_agent: "scout" }, { kind: "action" }, { payload: { rollback: { ...row("allow").payload.rollback, include_config: false } } }]) {
      const w = fakeWorld(["allow"], { rowOver: over });
      await expect(rollbackVault(options(w, { target: undefined, request: "62", includeConfig: true }))).rejects.toThrow(/not a configuration rollback/);
      expect(w.calls.filter((c) => c.url.endsWith("/vault/revert"))).toEqual([]);
    }
  });

  it("without the owner-class bearer it refuses before waiting, and the request stays in Needs You", async () => {
    const w = fakeWorld(["allow"]);
    const o = options(w, { includeConfig: true });
    delete o.env.METISTRY_BRIDGE_TOKEN_RECONCILER_USER;
    await expect(rollbackVault(o)).rejects.toThrow(/METISTRY_BRIDGE_TOKEN_RECONCILER_USER/);
    expect(w.calls.filter((c) => c.url.endsWith("/vault/revert"))).toEqual([]);
  });

  it("the reconciler's stale refusal is reported and nothing changed", async () => {
    const w = fakeWorld(["allow"], { revertStatus: 409 });
    await expect(rollbackVault(options(w, { includeConfig: true }))).rejects.toThrow(/stale.*nothing changed/);
  });

  it("through main: exactly one target", async () => {
    const errs: string[] = [];
    const run = (argv: string[]) => main(argv, { out: () => {}, err: (l: string) => errs.push(l), fetchFn: fakeWorld(["pending"]).fetchFn, platform: "linux" } as never);
    expect(await run(["vault", "rollback"])).toBe(2);
    expect(await run(["vault", "rollback", "4c1d2e3f", "--to", "2026-09-26"])).toBe(2);
    expect(await run(["vault", "rollback", "--file", "Areas/x.md", "--request", "62"])).toBe(2);
    expect(await run(["vault", "rollback", "--to"])).toBe(2);
    expect(errs.join("\n")).toContain("name exactly one thing to roll back");
    // --include-config takes no value: the commit after it is still the commit
    expect(parseArgs(["vault", "rollback", "--include-config", "4c1d2e3f"])).toMatchObject({ command: "vault", positional: ["rollback", "4c1d2e3f"], flags: { "include-config": true } });
  });
});
