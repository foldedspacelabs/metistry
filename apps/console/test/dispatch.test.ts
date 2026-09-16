// Data-policy enforcement + dispatch against fakes (no db, no network).
// The policy tests are the misuse tests for §4.18.B: a brief that would
// carry comms-derived content or a personal vault path off the machine is
// refused by the tool, whatever a prompt said.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DataPolicy } from "@foldedspacelabs/metistry-core";
import { checkBrief, dispatch, resolveRef, returnFooter, TargetRegistry } from "../src/dispatch.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const policy: DataPolicy = {
  allow: ["Knowledge/Projects", "Knowledge/Areas/fsl"],
  deny_sources: ["comms"],
  max_brief_bytes: 200,
};

describe("data policy — enforced at the tool", () => {
  it("passes a brief that cites only allowed prefixes (plain, wikilink, backticks)", () => {
    const brief = "See Knowledge/Projects/Ios-app.md, [[Knowledge/Areas/fsl/drey/drey.md]] and `Knowledge/Projects`.";
    expect(checkBrief(policy, brief)).toEqual([]);
  });

  it("refuses a vault path outside allow, naming the offending paths", () => {
    const v = checkBrief(policy, "Context: Knowledge/Journal/Daily/2026-09-06.md plus Knowledge/Projects/x.md.");
    expect(v).toEqual([{ kind: "path_outside_allow", paths: ["Knowledge/Journal/Daily/2026-09-06.md"], allow: policy.allow }]);
  });

  it("prefix match is per path segment, and traversal never matches", () => {
    expect(checkBrief(policy, "Knowledge/Areas/fslx/secret.md")[0]?.kind).toBe("path_outside_allow");
    expect(checkBrief(policy, "Knowledge/Projects/../Me/profile.md")[0]?.kind).toBe("path_outside_allow");
    expect(checkBrief(policy, "Knowledge/Projects/./x.md")[0]?.kind).toBe("path_outside_allow");
  });

  it("an empty allow list refuses every vault reference", () => {
    expect(checkBrief({ ...policy, allow: [] }, "read Knowledge/Projects/x.md")[0]?.kind).toBe("path_outside_allow");
    expect(checkBrief({ ...policy, allow: [] }, "no vault refs here")).toEqual([]);
  });

  it("refuses a denied provenance marker: frontmatter, inline stamp, list form, or the caller's own declaration", () => {
    const denied = [{ kind: "denied_source", sources: ["comms"] }];
    expect(checkBrief(policy, "---\nsource: comms\n---\nsummarize the thread")).toEqual(denied);
    expect(checkBrief(policy, "<!-- source: comms -->\nplease do X")).toEqual(denied);
    expect(checkBrief(policy, "sources: [inbox, Comms]\nplease do X")).toEqual(denied);
    expect(checkBrief(policy, "clean text", ["comms"])).toEqual(denied);
    expect(checkBrief(policy, "source: inbox\nfine")).toEqual([]); // only DENIED classes refuse
  });

  it("refuses an oversized brief before scanning it — bytes, not characters", () => {
    expect(checkBrief(policy, "x".repeat(201))).toEqual([{ kind: "brief_too_large", bytes: 201, max_brief_bytes: 200 }]);
    expect(checkBrief(policy, "é".repeat(101))[0]?.kind).toBe("brief_too_large"); // 202 bytes
    expect(checkBrief(policy, "x".repeat(200))).toEqual([]);
  });

  it("reports every violation kind found, in a stable order", () => {
    const v = checkBrief(policy, "source: comms — see Knowledge/Me/profile.md");
    expect(v.map((x) => x.kind)).toEqual(["denied_source", "path_outside_allow"]);
  });
});

// --- dispatch against fakes ------------------------------------------------

const manifest = {
  name: "github-issues",
  type: "target",
  transport: "github",
  submit: { repo: "env:REPO" },
  result: { via: "report_queue" },
  auth: "env:TOKEN",
  cost: { per_run_estimate_usd: 0.25 },
  data_policy: policy,
};

function fakeDb(task: Record<string, unknown> | null) {
  const q: { text: string; values: unknown[] }[] = [];
  let runId = 100;
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.startsWith("SELECT id, title")) return { rows: task ? [task] : [] };
      if (text.startsWith("INSERT INTO runs")) return { rows: [{ id: ++runId }] };
      if (text.startsWith("UPDATE work")) return { rows: [{ id: task?.id }] };
      return { rows: [] };
    },
    runFinish() {
      return q.filter((x) => x.text.startsWith("UPDATE runs")).map((x) => x.values);
    },
  };
}

type Call = { url: string; init?: RequestInit };
function fakeFetch(calls: Call[], opts: { postStatus?: number; getStatus?: number } = {}) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "POST") {
      const status = opts.postStatus ?? 201;
      return { ok: status < 300, status, json: async () => ({ number: 42, html_url: "https://github.com/o/r/issues/42" }) };
    }
    const status = opts.getStatus ?? 200;
    return { ok: status < 300, status, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

const task = { id: 7, title: "ship the thing", status: "open", external_ref: null };

describe("dispatch (fakes)", () => {
  it("creates the issue with brief + return footer, binds the ref, records the runs row with the target's cost", async () => {
    const calls: Call[] = [];
    const reg = new TargetRegistry({ env: { TOKEN: "t", REPO: "o/r" }, fetchFn: fakeFetch(calls) });
    reg.add(manifest);
    const db = fakeDb(task);
    const r = await dispatch(db, reg, 7, "github-issues", "Do X per Knowledge/Projects/x.md", "owner");
    expect(r).toEqual({ ok: true, ref: "gh:o/r#42", url: "https://github.com/o/r/issues/42", run_id: 101 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer t");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.title).toBe("ship the thing");
    expect(body.body).toContain("Do X per Knowledge/Projects/x.md");
    expect(body.body).toContain(returnFooter(7, "github-issues"));
    expect(body.body).toMatch(/task #7/);

    const upd = db.q.find((x) => x.text.startsWith("UPDATE work"))!;
    expect(upd.values.slice(0, 3)).toEqual([7, "gh:o/r#42", "target:github-issues"]);
    expect(JSON.parse(String(upd.values[3]))[0]).toMatchObject({ agent: "owner", op: "dispatch", note: "github-issues → gh:o/r#42" });

    const start = db.q.find((x) => x.text.startsWith("INSERT INTO runs"))!;
    expect(start.values.slice(0, 4)).toEqual(["console", "dispatch", null, "github-issues"]);
    expect(JSON.parse(String(start.values[5]))).toMatchObject({ target: "github-issues", task: 7, principal: "owner" });
    const [finish] = db.runFinish();
    expect(finish![1]).toBe(true); // ok
    expect(finish![5]).toBe(0.25); // cost_usd from the manifest's profile
    expect(JSON.parse(String(finish![6]))).toEqual({ ref: "gh:o/r#42", url: "https://github.com/o/r/issues/42" });
  });

  it("refuses a policy violation with a machine-readable reason, records the refusal, and sends NOTHING", async () => {
    const calls: Call[] = [];
    const reg = new TargetRegistry({ env: { TOKEN: "t", REPO: "o/r" }, fetchFn: fakeFetch(calls) });
    reg.add(manifest);
    const db = fakeDb(task);
    const r = await dispatch(db, reg, 7, "github-issues", "summarize Knowledge/Me/profile.md", "owner", ["comms"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_request");
    expect(r.violations?.map((v) => v.kind)).toEqual(["denied_source", "path_outside_allow"]);
    expect(calls).toHaveLength(0);
    expect(db.q.some((x) => x.text.startsWith("UPDATE work"))).toBe(false);
    const [finish] = db.runFinish();
    expect(finish![1]).toBe(false);
    expect(String(finish![2])).toMatch(/^data_policy: denied_source,path_outside_allow$/);
  });

  it("degrades absent: no write token → check() is absent with a remediation, dispatch is a conflict envelope, nothing sent", async () => {
    const calls: Call[] = [];
    const reg = new TargetRegistry({ env: { REPO: "o/r" }, fetchFn: fakeFetch(calls) });
    reg.add(manifest);
    const check = await reg.check("github-issues");
    expect(check.status).toBe("absent");
    expect(check.remediation).toMatch(/env:TOKEN/);
    const r = await dispatch(fakeDb(task), reg, 7, "github-issues", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "conflict", check: { status: "absent" } });
    expect(calls).toHaveLength(0);
  });

  it("check() probes the repo with the write token — ok on 200, failed on 404", async () => {
    const calls: Call[] = [];
    const ok = new TargetRegistry({ env: { TOKEN: "t", REPO: "o/r" }, fetchFn: fakeFetch(calls) });
    ok.add(manifest);
    expect(await ok.check("github-issues")).toMatchObject({ status: "ok", meta: { repo: "o/r" } });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r");
    const bad = new TargetRegistry({ env: { TOKEN: "t", REPO: "o/r" }, fetchFn: fakeFetch([], { getStatus: 404 }) });
    bad.add(manifest);
    expect((await bad.check("github-issues")).status).toBe("failed");
  });

  it("unknown target / unknown task → not_found; already-bound or closed task → conflict", async () => {
    const reg = new TargetRegistry({ env: { TOKEN: "t", REPO: "o/r" }, fetchFn: fakeFetch([]) });
    reg.add(manifest);
    expect(await dispatch(fakeDb(task), reg, 7, "nope", "x", "owner")).toMatchObject({ ok: false, code: "not_found" });
    expect(await dispatch(fakeDb(null), reg, 7, "github-issues", "x", "owner")).toMatchObject({ ok: false, code: "not_found" });
    expect(await dispatch(fakeDb({ ...task, external_ref: "gh:o/r#1" }), reg, 7, "github-issues", "x", "owner")).toMatchObject({ ok: false, code: "conflict" });
    expect(await dispatch(fakeDb({ ...task, status: "closed" }), reg, 7, "github-issues", "x", "owner")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("submission failure → uniform internal error; the HTTP status lives in the runs row, not on the wire", async () => {
    const reg = new TargetRegistry({ env: { TOKEN: "t", REPO: "o/r" }, fetchFn: fakeFetch([], { postStatus: 403 }) });
    reg.add(manifest);
    const db = fakeDb(task);
    const r = await dispatch(db, reg, 7, "github-issues", "fine", "owner");
    expect(r).toEqual({ ok: false, code: "internal", message: "target submission failed" });
    expect(String(db.runFinish()[0]![2])).toMatch(/HTTP 403/);
  });

  it("a transport without a dispatcher is refused, not silently no-op'd", async () => {
    const reg = new TargetRegistry({ env: {} });
    reg.add({ ...manifest, name: "cloud-worker", transport: "mcp", submit: { tool: "run_task" } });
    expect((await reg.check("cloud-worker")).status).toBe("absent");
    const r = await dispatch(fakeDb(task), reg, 7, "cloud-worker", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
  });
});

describe("target registry", () => {
  it("loads targets/* from the repo, resolves env refs, and describe() carries the check", async () => {
    const reg = new TargetRegistry({ env: {} });
    expect(await reg.loadDir(`${root}targets`)).toEqual(["devin-sessions", "github-issues", "local-crew"]); // the shipped targets; local-crew is the crews' (docs/ops/crews.md), devin-sessions is W6's (docs/ops/devin.md)
    const described = await reg.describe();
    const d = described.find((t) => t.name === "github-issues");
    const local = described.find((t) => t.name === "local-crew");
    expect(d).toMatchObject({ name: "github-issues", transport: "github", auth: "env:METISTRY_GITHUB_WRITE_TOKEN", check: { status: "absent" } });
    // the local target needs no auth and has a dispatcher (the assistant's agents_delegate) — never reported as "no dispatcher"
    expect(local).toMatchObject({ name: "local-crew", transport: "local", check: { status: "ok", meta: { via: "agents_delegate" } } });
    expect(local!.auth).toBeUndefined();
    // …but the task-dispatch route is not that dispatcher: it refuses a local target by name, pointing at the tool
    const r = await dispatch(fakeDb(task), reg, 7, "local-crew", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "invalid_request", message: expect.stringContaining("agents_delegate") });
    expect(d!.data_policy.deny_sources).toContain("comms");
    expect(resolveRef("env:X", { X: "v" })).toBe("v");
    expect(resolveRef("env:X", {})).toBeUndefined();
    expect(resolveRef("o/r", {})).toBe("o/r");
  });

  it("a missing overlay dir is fine; a later dir overrides by name; a bad manifest throws", async () => {
    const reg = new TargetRegistry({ env: {} });
    expect(await reg.loadDir(`${root}no-such-dir`)).toEqual([]);
    reg.add(manifest);
    reg.add({ ...manifest, data_policy: { ...policy, max_brief_bytes: 1 } });
    expect(reg.get("github-issues")!.data_policy.max_brief_bytes).toBe(1);
    expect(() => reg.add({ ...manifest, data_policy: "no_personal_comms" })).toThrow(/data_policy/);
    expect(() => reg.add({ name: "x", type: "service", runs_on: "host" })).toThrow(/not a target/);
  });
});
