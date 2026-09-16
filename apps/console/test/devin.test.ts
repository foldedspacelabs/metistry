// The `devin-session` submit adapter against fakes (no db, no network):
// the request shape a brief turns into, the Draft-7 contract, the ACU
// budget, and the misuse tests for the shipped manifest's data policy —
// whose `allow` list is EMPTY, so the product default lets a brief cite
// nothing from the vault at all.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_MAX_ACU,
  DEVIN_ANSWER_SCHEMA,
  devinFooter,
  devinPrompt,
  devinSessionBody,
  isDevinPurpose,
  resolveMaxAcu,
  schemaIssues,
} from "../src/devin.js";
import { DEVIN_SUBMIT_KIND, dispatch, TargetRegistry } from "../src/dispatch.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const shipped = parseYaml(readFileSync(`${root}targets/devin-sessions/manifest.yaml`, "utf8")) as Record<string, unknown>;

const env = { METISTRY_DEVIN_API_KEY: "cog_x", METISTRY_DEVIN_ORG_ID: "org-abc" };
const task = { id: 7, title: "why does the deploy hang", status: "open", external_ref: null };

type Call = { url: string; init?: RequestInit };
function fakeFetch(calls: Call[], opts: { postStatus?: number; selfStatus?: number; session?: Record<string, unknown> } = {}) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "POST") {
      const status = opts.postStatus ?? 200;
      return { ok: status < 300, status, json: async () => opts.session ?? { session_id: "devin-123", url: "https://app.devin.ai/sessions/123" } };
    }
    const status = opts.selfStatus ?? 200;
    return { ok: status < 300, status, json: async () => ({ org_id: "org-abc" }), text: async () => "" };
  }) as unknown as typeof fetch;
}

function fakeDb(row: Record<string, unknown> | null = task) {
  const q: { text: string; values: unknown[] }[] = [];
  let runId = 100;
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.startsWith("SELECT id, title")) return { rows: row ? [row] : [] };
      if (text.startsWith("INSERT INTO runs")) return { rows: [{ id: ++runId }] };
      if (text.startsWith("UPDATE work")) return { rows: [{ id: row?.id }] };
      return { rows: [] };
    },
    runFinish() {
      return q.filter((x) => x.text.startsWith("UPDATE runs")).map((x) => x.values);
    },
  };
}

async function registry(calls: Call[], over: Record<string, string> = {}, opts: Parameters<typeof fakeFetch>[1] = {}) {
  const reg = new TargetRegistry({ env: { ...env, ...over }, fetchFn: fakeFetch(calls, opts) });
  reg.add(shipped, "targets/devin-sessions/manifest.yaml");
  return reg;
}

// --- the structured-output contract -------------------------------------------

describe("structured output — the Draft 7 contract Devin documents", () => {
  it("the shipped answer schema is valid Draft 7, self-contained, and under the 64 KB cap", () => {
    expect(schemaIssues(DEVIN_ANSWER_SCHEMA)).toEqual([]);
    expect(DEVIN_ANSWER_SCHEMA.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(DEVIN_ANSWER_SCHEMA.required).toEqual(["answer", "sources", "confidence", "open_questions"]);
    expect(Object.keys(DEVIN_ANSWER_SCHEMA.properties)).toEqual(["answer", "sources", "confidence", "open_questions"]);
    expect(Buffer.byteLength(JSON.stringify(DEVIN_ANSWER_SCHEMA), "utf8")).toBeLessThan(64 * 1024);
  });

  it("catches every way a schema stops being Draft 7 or stops being self-contained", () => {
    const base = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } };
    expect(schemaIssues({ ...base, properties: { a: { $ref: "https://example.com/x.json" } } })[0]).toMatch(/\$ref is not allowed/);
    expect(schemaIssues({ ...base, $defs: { a: { type: "string" } } })[0]).toMatch(/"\$defs" is not a Draft 7 keyword/);
    expect(schemaIssues({ ...base, properties: { a: { prefixItems: [] } } })[0]).toMatch(/prefixItems/);
    expect(schemaIssues({ ...base, properties: { a: { type: "int" } } })[0]).toMatch(/unknown type "int"/);
    expect(schemaIssues({ ...base, required: ["b"] })[0]).toMatch(/not in properties/);
    expect(schemaIssues({ ...base, $schema: "https://json-schema.org/draft/2020-12/schema" })[0]).toMatch(/draft-07/);
    expect(schemaIssues({ ...base, type: "array" })[0]).toMatch(/top-level type must be "object"/);
    expect(schemaIssues({ ...base, properties: { a: { type: "string", description: "x".repeat(70_000) } } }).some((i) => /documented cap/.test(i))).toBe(true);
    expect(schemaIssues("not a schema")).toEqual(["schema must be a JSON object"]);
  });
});

// --- the request a brief becomes ------------------------------------------------

describe("devin session request shape", () => {
  it("a knowledge-research brief becomes a prompt that asks for the structured answer and forbids changing anything", () => {
    const body = devinSessionBody({ brief: "What deploys the payments service?", taskId: 7, target: "devin-sessions", purpose: "knowledge_research", title: "how deploys work", maxAcu: 3 });
    const prompt = String(body.prompt);
    expect(prompt).toContain("**Knowledge research.**");
    expect(prompt).toContain("Do not open a pull request");
    expect(prompt).toContain("provide_structured_output");
    expect(prompt).toContain("is_final=true");
    expect(prompt).toContain("What deploys the payments service?");
    expect(prompt).toContain(devinFooter(7, "devin-sessions"));
    expect(prompt).toMatch(/task #7/);
    expect(body.title).toBe("metistry task #7: how deploys work");
    expect(body.tags).toEqual(["metistry:task:7", "metistry:purpose:knowledge_research"]);
    expect(body.max_acu_limit).toBe(3);
    expect(body.structured_output_schema).toBe(DEVIN_ANSWER_SCHEMA);
    expect(body.structured_output_required).toBe(true);
  });

  it("a work brief gets the other preamble and its own tag; both ask for the same structured answer", () => {
    const work = devinPrompt({ brief: "Fix the flake in test X.", taskId: 9, target: "devin-sessions", purpose: "work" });
    expect(work).toContain("**Work brief.**");
    expect(work).not.toContain("Do not open a pull request");
    expect(work).toContain("provide_structured_output");
    expect(String(devinSessionBody({ brief: "b", taskId: 9, target: "t", purpose: "work", title: "t", maxAcu: 1 }).tags)).toContain("metistry:purpose:work");
  });

  it("the ACU cap is the dispatch call, else the manifest, else the small default", () => {
    expect(resolveMaxAcu(3, 20)).toBe(3);
    expect(resolveMaxAcu(undefined, 20)).toBe(20);
    expect(resolveMaxAcu(undefined, undefined)).toBe(DEFAULT_MAX_ACU);
    expect(resolveMaxAcu(0, "nonsense")).toBe(DEFAULT_MAX_ACU); // a zero ceiling is not a budget
    expect(resolveMaxAcu(-1, undefined)).toBe(DEFAULT_MAX_ACU);
    expect(isDevinPurpose("knowledge_research")).toBe(true);
    expect(isDevinPurpose("anything-else")).toBe(false);
  });
});

// --- dispatch -------------------------------------------------------------------

describe("dispatch to devin-sessions (fakes)", () => {
  it("creates the session, binds devin:<id>, freezes what the poller needs on the row, and records the ACU cap", async () => {
    const calls: Call[] = [];
    const reg = await registry(calls);
    const db = fakeDb();
    const r = await dispatch(db, reg, 7, "devin-sessions", "Answer the question.", "owner", [], { purpose: "knowledge_research", max_acu: 3 });
    expect(r).toEqual({ ok: true, ref: "devin:devin-123", url: "https://app.devin.ai/sessions/123", run_id: 101 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.devin.ai/v3/organizations/org-abc/sessions");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer cog_x");
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent.prompt).toContain("Answer the question.");
    expect(sent.max_acu_limit).toBe(3);
    expect(sent.structured_output_required).toBe(true);

    const upd = db.q.find((x) => x.text.startsWith("UPDATE work"))!;
    expect(upd.values.slice(0, 3)).toEqual([7, "devin:devin-123", "target:devin-sessions"]);
    expect(JSON.parse(String(upd.values[4]))).toEqual({
      devin: { session_id: "devin-123", org: "org-abc", url: "https://app.devin.ai/sessions/123", max_acu: 3, purpose: "knowledge_research", target: "devin-sessions", dispatch_run_id: 101 },
    });

    const start = db.q.find((x) => x.text.startsWith("INSERT INTO runs"))!;
    expect(JSON.parse(String(start.values[6]))).toMatchObject({ target: "devin-sessions", task: 7, principal: "owner", purpose: "knowledge_research" });
    const [finish] = db.runFinish();
    expect(finish![1]).toBe(true);
    expect(JSON.parse(String(finish![6]))).toEqual({ ref: "devin:devin-123", url: "https://app.devin.ai/sessions/123", session_id: "devin-123", org: "org-abc", max_acu: 3 });
  });

  it("the purpose defaults to `work` and the ACU cap falls back to the manifest's", async () => {
    const calls: Call[] = [];
    const db = fakeDb();
    await dispatch(db, await registry(calls), 7, "devin-sessions", "Do the thing.", "owner");
    expect(JSON.parse(String(calls[0]!.init!.body)).max_acu_limit).toBe(shipped.submit ? (shipped.submit as { max_acu: number }).max_acu : -1);
    expect(JSON.parse(String(db.q.find((x) => x.text.startsWith("UPDATE work"))!.values[4])).devin.purpose).toBe("work");
  });

  it("the shipped policy refuses EVERY vault citation — allow is empty on purpose — and sends nothing", async () => {
    const calls: Call[] = [];
    const db = fakeDb();
    const r = await dispatch(db, await registry(calls), 7, "devin-sessions", "See Knowledge/Projects/x.md", "owner");
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
    if (r.ok) return;
    expect(r.violations).toEqual([{ kind: "path_outside_allow", paths: ["Knowledge/Projects/x.md"], allow: [] }]);
    expect(calls).toHaveLength(0);
    expect(db.q.some((x) => x.text.startsWith("UPDATE work"))).toBe(false);
    expect(String(db.runFinish()[0]![2])).toBe("data_policy: path_outside_allow");
  });

  it("refuses comms-derived AND devin-derived briefs — Devin's own knowledge is not silently re-exported", async () => {
    const calls: Call[] = [];
    const r = await dispatch(fakeDb(), await registry(calls), 7, "devin-sessions", "---\nsource: devin\n---\nsummarize", "owner");
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
    if (!r.ok) expect(r.violations).toEqual([{ kind: "denied_source", sources: ["devin"] }]);
    const c2 = await dispatch(fakeDb(), await registry(calls), 7, "devin-sessions", "clean", "owner", ["comms"]);
    if (!c2.ok) expect(c2.violations).toEqual([{ kind: "denied_source", sources: ["comms"] }]);
    expect(calls).toHaveLength(0);
  });

  it("degrades absent without an organization: check() names the variable, dispatch is a conflict, nothing sent", async () => {
    const calls: Call[] = [];
    const reg = new TargetRegistry({ env: { METISTRY_DEVIN_API_KEY: "cog_x" }, fetchFn: fakeFetch(calls) });
    reg.add(shipped);
    const check = await reg.check("devin-sessions");
    expect(check.status).toBe("absent");
    expect(check.remediation).toMatch(/METISTRY_DEVIN_ORG_ID/);
    expect(await dispatch(fakeDb(), reg, 7, "devin-sessions", "fine", "owner")).toMatchObject({ ok: false, code: "conflict", check: { status: "absent" } });
    expect(calls).toHaveLength(0);
  });

  it("check() probes /v3/self and never creates a session; 429 is degraded, a bad key is failed", async () => {
    const calls: Call[] = [];
    expect(await (await registry(calls)).check("devin-sessions")).toMatchObject({ status: "ok", meta: { org: "org-abc", base: "https://api.devin.ai" } });
    expect(calls.map((c) => c.url)).toEqual(["https://api.devin.ai/v3/self"]);
    expect(calls.every((c) => c.init?.method === undefined)).toBe(true);
    expect((await (await registry([], {}, { selfStatus: 429 })).check("devin-sessions")).status).toBe("degraded");
    expect((await (await registry([], {}, { selfStatus: 401 })).check("devin-sessions")).status).toBe("failed");
  });

  it("a submission failure is a uniform internal error; the HTTP status lives in the runs row", async () => {
    const db = fakeDb();
    const r = await dispatch(db, await registry([], {}, { postStatus: 402 }), 7, "devin-sessions", "fine", "owner");
    expect(r).toEqual({ ok: false, code: "internal", message: "target submission failed" });
    expect(String(db.runFinish()[0]![2])).toMatch(/HTTP 402/);
  });

  it("a response without a session_id is a failure, not a row bound to `devin:undefined`", async () => {
    const db = fakeDb();
    const r = await dispatch(db, await registry([], {}, { session: { url: "u" } }), 7, "devin-sessions", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "internal" });
    expect(db.q.some((x) => x.text.startsWith("UPDATE work"))).toBe(false);
  });

  it("an http target with an unimplemented submit.kind is refused by name, not silently no-op'd", async () => {
    const reg = new TargetRegistry({ env, fetchFn: fakeFetch([]) });
    reg.add({ ...shipped, name: "cloud-worker", submit: { kind: "some-other-api", url: "https://example.com" } });
    expect((await reg.check("cloud-worker")).status).toBe("absent");
    const r = await dispatch(fakeDb(), reg, 7, "cloud-worker", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "invalid_request", message: expect.stringContaining("some-other-api") });
  });

  it("the shipped manifest loads through the registry with the transport and return path W6 specifies", async () => {
    const reg = new TargetRegistry({ env: {} });
    expect(await reg.loadDir(`${root}targets`)).toEqual(["devin-sessions", "github-issues", "local-crew"]);
    const m = reg.get("devin-sessions")!;
    expect(m.transport).toBe("http");
    expect(m.submit.kind).toBe(DEVIN_SUBMIT_KIND);
    expect(m.result).toMatchObject({ via: "report_queue", status_via: "devin-sessions" });
    expect(m.auth).toBe("env:METISTRY_DEVIN_API_KEY");
    expect(m.data_policy.allow).toEqual([]); // the instance overlays this; the product default cites nothing
    expect(m.data_policy.deny_sources).toEqual(["comms", "devin"]);
  });
});
