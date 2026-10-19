// Data-policy enforcement + dispatch against fakes (no db, no network). Since
// X-85 a target other than the crews' `local-crew` is an agent connection (a
// scratch instance directory, ./agent-registry.ts): there is no `targets/`
// manifest or environment key to dispatch with.
// The policy tests are the misuse tests for §4.18.B: a brief that would
// carry comms-derived content or a personal vault path off the machine is
// refused by the tool, whatever a prompt said.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataPolicy } from "@foldedspacelabs/metistry-core";
import { envSecretSource, loadInstanceCatalog } from "@foldedspacelabs/metistry-connections";
import { CONNECTION_HINT, checkBrief, dispatch, returnFooter, TargetRegistry } from "../src/dispatch.js";
import { agentRegistry, authorizationOf, root, type AgentRegistry } from "./agent-registry.js";

const policy: DataPolicy = {
  allow: ["Projects", "Areas/fsl"],
  deny_sources: ["comms"],
  max_brief_bytes: 200,
};

describe("data policy — enforced at the tool", () => {
  it("passes a brief that cites only allowed prefixes (plain, wikilink, backticks)", () => {
    const brief = "See Projects/Ios-app.md, [[Areas/fsl/drey/drey.md]] and `Projects`.";
    expect(checkBrief(policy, brief)).toEqual([]);
  });

  it("refuses a vault path outside allow, naming the offending paths", () => {
    const v = checkBrief(policy, "Context: Journal/Daily/2026-09-06.md plus Projects/x.md.");
    expect(v).toEqual([{ kind: "path_outside_allow", paths: ["Journal/Daily/2026-09-06.md"], allow: policy.allow }]);
  });

  it("prefix match is per path segment, and traversal never matches", () => {
    expect(checkBrief(policy, "Areas/fslx/secret.md")[0]?.kind).toBe("path_outside_allow");
    expect(checkBrief(policy, "Projects/../Me/profile.md")[0]?.kind).toBe("path_outside_allow");
    expect(checkBrief(policy, "Projects/./x.md")[0]?.kind).toBe("path_outside_allow");
  });

  it("an empty allow list refuses every vault reference", () => {
    expect(checkBrief({ ...policy, allow: [] }, "read Projects/x.md")[0]?.kind).toBe("path_outside_allow");
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
    const v = checkBrief(policy, "source: comms — see Me/profile.md");
    expect(v.map((x) => x.kind)).toEqual(["denied_source", "path_outside_allow"]);
  });
});

// --- dispatch against fakes ------------------------------------------------

const GH_KEY = ["gh" + "p", "unitTestWriteToken0123456789"].join("_");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});
async function githubRegistry(fetchFn: typeof fetch, over: { key?: string | undefined; repo?: string | undefined } = { key: GH_KEY, repo: "o/r" }): Promise<TargetRegistry> {
  const r: AgentRegistry = await agentRegistry({ fetchFn, github: over });
  cleanups.push(r.cleanup);
  return r.registry;
}

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
      return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/o/r/issues/42" }), { status });
    }
    return new Response("{}", { status: opts.getStatus ?? 200 });
  }) as unknown as typeof fetch;
}

const task = { id: 7, title: "ship the thing", status: "open", external_ref: null };

describe("dispatch (fakes)", () => {
  it("creates the issue with brief + return footer, binds the ref, records the runs row with the type's cost", async () => {
    const calls: Call[] = [];
    const reg = await githubRegistry(fakeFetch(calls));
    const db = fakeDb(task);
    const r = await dispatch(db, reg, 7, "github-issues", "Do X per Projects/x.md", "owner");
    expect(r).toEqual({ ok: true, ref: "gh:o/r#42", url: "https://github.com/o/r/issues/42", run_id: 101 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues");
    expect(authorizationOf(calls[0]!.init)).toBe(`Bearer ${GH_KEY}`); // filled at the connection's door
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.title).toBe("ship the thing");
    expect(body.body).toContain("Do X per Projects/x.md");
    expect(body.body).toContain(returnFooter(7, "github-issues"));
    expect(body.body).toMatch(/task #7/);

    const upd = db.q.find((x) => x.text.startsWith("UPDATE work"))!;
    expect(upd.values.slice(0, 3)).toEqual([7, "gh:o/r#42", "target:github-issues"]);
    expect(JSON.parse(String(upd.values[3]))[0]).toMatchObject({ agent: "owner", op: "dispatch", note: "github-issues → gh:o/r#42" });

    const start = db.q.find((x) => x.text.startsWith("INSERT INTO runs"))!;
    expect(start.values.slice(0, 4)).toEqual(["console", "dispatch", null, "github-issues"]);
    expect(JSON.parse(String(start.values[6]))).toMatchObject({ target: "github-issues", task: 7, principal: "owner", connection: "github-issues" });
    const [finish] = db.runFinish();
    expect(finish![1]).toBe(true); // ok
    expect(finish![5]).toBe(0); // cost_usd from the type's profile: the issue is free
    expect(JSON.parse(String(finish![6]))).toEqual({ ref: "gh:o/r#42", url: "https://github.com/o/r/issues/42", secrets: ["github_write_token"] });
  });

  it("refuses a policy violation with a machine-readable reason, records the refusal, and sends NOTHING", async () => {
    const calls: Call[] = [];
    const reg = await githubRegistry(fakeFetch(calls));
    const db = fakeDb(task);
    const r = await dispatch(db, reg, 7, "github-issues", "summarize Me/profile.md", "owner", ["comms"]);
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

  it("degrades absent: no write token delivered → check() is absent, dispatch is a conflict naming the secret, nothing sent", async () => {
    const calls: Call[] = [];
    const reg = await githubRegistry(fakeFetch(calls), { repo: "o/r" });
    await reg.refresh();
    const check = await reg.check("github-issues");
    expect(check.status).toBe("absent");
    const r = await dispatch(fakeDb(task), reg, 7, "github-issues", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "conflict", message: expect.stringMatching(/missing_secret.*github_write_token/) }); // refused at the door, which sent nothing
    expect(calls).toHaveLength(0);
  });

  it("check() probes the repo with the write token — ok on 200, failed on 404", async () => {
    const calls: Call[] = [];
    const ok = await githubRegistry(fakeFetch(calls));
    await ok.refresh();
    expect(await ok.check("github-issues")).toMatchObject({ status: "ok", meta: { repo: "o/r" } });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r");
    const bad = await githubRegistry(fakeFetch([], { getStatus: 404 }));
    await bad.refresh();
    expect((await bad.check("github-issues")).status).toBe("failed");
  });

  it("unknown target / unknown task → not_found; already-bound or closed task → conflict", async () => {
    const reg = await githubRegistry(fakeFetch([]));
    expect(await dispatch(fakeDb(task), reg, 7, "nope", "x", "owner")).toMatchObject({ ok: false, code: "not_found" });
    expect(await dispatch(fakeDb(null), reg, 7, "github-issues", "x", "owner")).toMatchObject({ ok: false, code: "not_found" });
    expect(await dispatch(fakeDb({ ...task, external_ref: "gh:o/r#1" }), reg, 7, "github-issues", "x", "owner")).toMatchObject({ ok: false, code: "conflict" });
    expect(await dispatch(fakeDb({ ...task, status: "closed" }), reg, 7, "github-issues", "x", "owner")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("submission failure → uniform internal error; the HTTP status lives in the runs row, not on the wire", async () => {
    const reg = await githubRegistry(fakeFetch([], { postStatus: 403 }));
    const db = fakeDb(task);
    const r = await dispatch(db, reg, 7, "github-issues", "fine", "owner");
    expect(r).toEqual({ ok: false, code: "internal", message: "target submission failed" });
    expect(String(db.runFinish()[0]![2])).toMatch(/HTTP 403/);
  });
});

// --- X-85: the shim is gone -----------------------------------------------------

async function targetsDir(...manifests: Array<[dir: string, yaml: string]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-targets-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [name, yaml] of manifests) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "manifest.yaml"), yaml);
  }
  return dir;
}
const targetYaml = (name: string, transport: string, extra = "") =>
  [`schema: 1`, `name: ${name}`, `type: target`, `transport: ${transport}`, `submit: { repo: "env:REPO" }`, `result: { via: report_queue }`, extra, `data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 100 }`, ""].join("\n");

describe("the targets shim is removed (X-85)", () => {
  it("the product's targets/ is the crews' local-crew and nothing else", async () => {
    const reg = new TargetRegistry();
    expect(await reg.loadDir(`${root}targets`)).toEqual(["local-crew"]);
    expect(reg.skipped).toEqual([]);
  });

  it("a targets/ manifest other than local-crew is refused at load — skipped with the verb that replaces it, never registered", async () => {
    const dir = await targetsDir(["github-issues", targetYaml("github-issues", "github", "auth: env:TOKEN")], ["local-crew", targetYaml("local-crew", "local")], ["cloud-worker", targetYaml("cloud-worker", "mcp")]);
    const reg = new TargetRegistry();
    expect(await reg.loadDir(dir)).toEqual(["local-crew"]);
    expect(reg.names()).toEqual(["local-crew"]);
    expect(reg.get("github-issues")).toBeUndefined();
    expect(reg.skipped.map((s) => s.name).sort()).toEqual(["cloud-worker", "github-issues"]);
    for (const s of reg.skipped) expect(s.reason).toContain("connections add");
  });

  it("an owner's overlay or extension of a retired target is refused the same way; their local-crew still overlays", async () => {
    const product = await targetsDir(["local-crew", targetYaml("local-crew", "local")]);
    const mine = await targetsDir(["devin-sessions", targetYaml("devin-sessions", "http")], ["local-crew", targetYaml("local-crew", "local").replace("max_brief_bytes: 100", "max_brief_bytes: 7")]);
    const reg = new TargetRegistry();
    await reg.load([
      { dir: product, origin: "product" },
      { dir: mine, origin: "extension" },
    ]);
    expect(reg.names()).toEqual(["local-crew"]);
    expect(reg.get("local-crew")!.data_policy.max_brief_bytes).toBe(7);
    expect(reg.skipped.map((s) => s.name)).toEqual(["devin-sessions"]);
  });

  it("add() refuses a target but local-crew, naming the verb", () => {
    const reg = new TargetRegistry();
    expect(() => reg.add({ schema: 1, name: "github-issues", type: "target", transport: "github", submit: { repo: "o/r" }, result: { via: "report_queue" }, auth: "env:TOKEN", data_policy: policy })).toThrow(/connections add/);
    expect(reg.add({ schema: 1, name: "local-crew", type: "target", transport: "local", submit: {}, result: { via: "report_queue" }, data_policy: policy }).name).toBe("local-crew");
  });

  it("an environment key alone dispatches nothing: with the old keys set and no connection, the target is unknown and nothing is sent", async () => {
    const saved = { gh: process.env.METISTRY_GITHUB_TOKEN, wr: process.env.METISTRY_GITHUB_WRITE_TOKEN, repo: process.env.METISTRY_GITHUB_DISPATCH_REPO, dv: process.env.METISTRY_DEVIN_API_KEY, org: process.env.METISTRY_DEVIN_ORG_ID };
    Object.assign(process.env, { METISTRY_GITHUB_TOKEN: "t", METISTRY_GITHUB_WRITE_TOKEN: "t", METISTRY_GITHUB_DISPATCH_REPO: "o/r", METISTRY_DEVIN_API_KEY: "cog_x", METISTRY_DEVIN_ORG_ID: "org-abc" });
    try {
      const calls: Call[] = [];
      const reg = new TargetRegistry({ fetchFn: fakeFetch(calls) });
      await reg.loadDir(`${root}targets`);
      expect(reg.names()).toEqual(["local-crew"]);
      for (const name of ["github-issues", "devin-sessions", "devin"]) {
        expect(await dispatch(fakeDb(task), reg, 7, name, "fine", "owner")).toMatchObject({ ok: false, code: "not_found" });
      }
      // …and a connection-less install is not rescued by the manifest's own shape either: nothing resolves a key from the environment
      expect((await reg.describe()).map((t) => t.name)).toEqual(["local-crew"]);
      expect(calls).toHaveLength(0);
    } finally {
      for (const [k, v] of Object.entries({ METISTRY_GITHUB_TOKEN: saved.gh, METISTRY_GITHUB_WRITE_TOKEN: saved.wr, METISTRY_GITHUB_DISPATCH_REPO: saved.repo, METISTRY_DEVIN_API_KEY: saved.dv, METISTRY_DEVIN_ORG_ID: saved.org })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a connection with its key delivered is what dispatches — the same task, through the door", async () => {
    const calls: Call[] = [];
    const reg = await githubRegistry(fakeFetch(calls));
    expect(await dispatch(fakeDb(task), reg, 7, "github-issues", "fine", "owner")).toMatchObject({ ok: true });
    expect(authorizationOf(calls[0]!.init)).toBe(`Bearer ${GH_KEY}`);
  });

  it("the hint every refusal carries names the verb and the release", () => {
    expect(CONNECTION_HINT).toMatch(/metistry connections add/);
    expect(CONNECTION_HINT).toMatch(/0\.17\.0/);
  });
});

describe("target registry", () => {
  it("loads targets/* from the repo, and describe() carries the check", async () => {
    const reg = new TargetRegistry();
    expect(await reg.loadDir(`${root}targets`)).toEqual(["local-crew"]); // the crews' target (docs/ops/crews.md); GitHub Issues and Devin are agent connections
    const described = await reg.describe();
    const local = described.find((t) => t.name === "local-crew");
    // the local target needs no auth and has a dispatcher (the assistant's agents_delegate) — never reported as "no dispatcher"
    expect(local).toMatchObject({ name: "local-crew", transport: "local", check: { status: "ok", meta: { via: "agents_delegate" } } });
    expect(local!.auth).toBeUndefined();
    expect(local!.connection).toBeUndefined();
    // …but the task-dispatch route is not that dispatcher: it refuses a local target by name, pointing at the tool
    const r = await dispatch(fakeDb(task), reg, 7, "local-crew", "fine", "owner");
    expect(r).toMatchObject({ ok: false, code: "invalid_request", message: expect.stringContaining("agents_delegate") });
    expect(local!.data_policy.deny_sources).toContain("comms");
  });

  it("a missing overlay dir is fine; a later dir overrides by name; a bad manifest throws", async () => {
    const reg = new TargetRegistry();
    expect(await reg.loadDir(`${root}no-such-dir`)).toEqual([]);
    const crew = { schema: 1, name: "local-crew", type: "target", transport: "local", submit: {}, result: { via: "report_queue" }, data_policy: policy };
    reg.add(crew);
    reg.add({ ...crew, data_policy: { ...policy, max_brief_bytes: 1 } });
    expect(reg.get("local-crew")!.data_policy.max_brief_bytes).toBe(1);
    expect(() => reg.add({ ...crew, data_policy: "no_personal_comms" })).toThrow(/data_policy/);
    expect(() => reg.add({ name: "x", type: "service", runs_on: "host" })).toThrow(/not a target/);
  });
});

// X-92: `config.repo` of a github-issue connection goes into a URL path
// (`/repos/<repo>/issues`), so `REPO_RE` is what keeps a connection file from
// steering the write token at another path. The pattern is private, so the
// test drives it where it acts: a real scratch instance catalog, presented by
// the registry's `refresh()` — a refused repo leaves its connection unbound
// (never dispatchable) with the reason; an accepted one is a target.
describe("a github-issue connection's config.repo (REPO_RE) — enforced at the tool", () => {
  const refused: [string, string][] = [
    ["../x", "parent traversal in front"],
    ["x/..", "parent traversal behind"],
    ["../..", "traversal in both parts"],
    ["./x", "current-directory prefix"],
    ["x/.", "current directory behind"],
    ["/etc/passwd", "an absolute path"],
    ["/o/r", "a leading slash"],
    ["o/r/extra", "a third segment"],
    ["o/r/", "a trailing slash"],
    ["o/r/..", "traversal as a third segment"],
    ["o//r", "an empty middle segment"],
    ["o", "no repository part"],
    ["o/", "an empty repository"],
    ["/r", "an empty owner"],
    ["..", "bare traversal"],
    [".", "a bare dot"],
    ["o/r?x=1", "a query"],
    ["o/r#frag", "a fragment"],
    ["o/r%2e%2e", "a percent escape"],
    ["o r/x", "whitespace inside"],
    ["o\\r", "a backslash separator"],
    ["o/r\\..", "a backslash traversal"],
    ["o:r/x", "a character outside GitHub's set"],
    ["", "empty"],
    ["  ", "only whitespace"],
  ];
  const accepted = ["o/r", "foldedspacelabs/metistry", "a.b/c-d_e", "o/.github", "o/a..b", "o/r..", "..x/r", " o/padded "];

  const name = (i: number, kind: "bad" | "ok") => `gh-${kind}-${i}`;
  const conn = (n: string, repo: string) =>
    [
      `name: ${n}`,
      "type: agent",
      "provider: github-issues",
      "reach:",
      "  http:",
      "    url: https://api.github.com",
      "    auth: { scheme: bearer, secret: github_write_token }",
      "secrets: [github_write_token]",
      "config:",
      `  repo: ${JSON.stringify(repo)}`,
      "",
    ].join("\n");

  async function presented(repos: { name: string; repo: string }[]): Promise<TargetRegistry> {
    const dir = await mkdtemp(join(tmpdir(), "metistry-repo-re-"));
    try {
      await mkdir(join(dir, ".metistry/connections"), { recursive: true });
      for (const r of repos) await writeFile(join(dir, ".metistry/connections", `${r.name}.yaml`), conn(r.name, r.repo));
      await writeFile(
        join(dir, ".metistry/secrets.yaml"),
        ["secrets:", "  github_write_token:", "    hosts: [api.github.com]", `    grants: { ${repos.map((r) => `"connection:${r.name}": on`).join(", ")} }`, ""].join("\n"),
      );
      const reg = new TargetRegistry({ fetchFn: (async () => Response.json({})) as typeof fetch });
      reg.bindConnections({
        catalog: () => loadInstanceCatalog({ instanceDir: dir, seedDir: `${root}seed` }),
        secrets: envSecretSource({ METISTRY_SECRET_GITHUB_WRITE_TOKEN: "x".repeat(40) }),
      });
      await reg.refresh();
      return reg;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("`../x` is refused, with the repository named in the reason and nothing bound to dispatch to", async () => {
    const reg = await presented([{ name: "gh-traversal", repo: "../x" }]);
    expect(reg.get("gh-traversal")).toBeUndefined();
    expect(reg.names()).not.toContain("gh-traversal");
    expect(reg.unavailableConnection("gh-traversal")).toEqual({
      status: "failed",
      why: 'connection gh-traversal: config.repo must be owner/repo — got "../x"',
    });
  });

  it("refuses every shape that is not exactly owner/repo — traversal, `./`, an absolute path, a third segment", async () => {
    const reg = await presented(refused.map(([repo], i) => ({ name: name(i, "bad"), repo })));
    for (const [i, [repo, why]] of refused.entries()) {
      const n = name(i, "bad");
      expect(reg.get(n), `${JSON.stringify(repo)} (${why}) must not become a target`).toBeUndefined();
      expect(reg.unavailableConnection(n), `${JSON.stringify(repo)} (${why})`).toMatchObject({ status: "failed", why: expect.stringContaining("config.repo must be owner/repo") });
    }
  });

  it("accepts a plain owner/repo, GitHub's own characters, and a part that merely contains dots; the repo goes in the target as trimmed", async () => {
    const reg = await presented(accepted.map((repo, i) => ({ name: name(i, "ok"), repo })));
    for (const [i, repo] of accepted.entries()) {
      const n = name(i, "ok");
      expect(reg.unavailableConnection(n), JSON.stringify(repo)).toBeUndefined();
      expect(reg.get(n), JSON.stringify(repo)).toMatchObject({ transport: "github", submit: { repo: repo.trim() } });
    }
  });
});
